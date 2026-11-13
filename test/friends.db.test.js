// Friends between existing hunters (friendService.js), against a real
// Postgres: pair keys, unique rows, upserts and cascades are the point.
//
// Runs only when TEST_DATABASE_URL is set (CI sets it), and refuses any
// database whose name doesn't contain "test" — every test wipes the tables.
//   TEST_DATABASE_URL=postgresql://…/hunterx_test npx prisma migrate deploy
//   TEST_DATABASE_URL=… npm test
import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const dbName = url ? new URL(url).pathname.slice(1) : '';
const skip = !url ? 'TEST_DATABASE_URL not set' : !/test/i.test(dbName) ? `refusing "${dbName}" (name must contain "test")` : false;

describe('friends (Postgres)', { skip }, () => {
  let prisma;
  let pool;
  let friends;
  let referrals;

  const DAY = 86_400_000;
  const pushes = (userId, type) => prisma.notifications.findMany({
    where:   { user_id: BigInt(userId), ...(type ? { type } : {}) },
    orderBy: { id: 'asc' },
  });
  const pair = (a, b) => prisma.friendships.findUnique({ where: { user_low_user_high: friends.pairKey(a, b) } });

  async function hunter(id, extra = {}) {
    await prisma.users.create({
      data: {
        id: BigInt(id), hunter_id: `HX${String(id).padStart(4, '0')}`, name: `Hunter${id}`,
        referral_code: `CODE${String(id).padStart(2, '0')}`, onboarding_done: true, role: 'USER', ...extra,
      },
    });
    await prisma.user_progression.create({ data: { user_id: BigInt(id), total_xp: id * 10, daily_streak: 3, longest_streak: 9 } });
  }

  before(async () => {
    process.env.DATABASE_URL = url;
    delete process.env.REDIS_URL;
    ({ default: prisma, pool } = await import('../src/config/prisma.js'));
    friends = await import('../src/services/friendService.js');
    referrals = await import('../src/services/referralService.js');
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE users RESTART IDENTITY CASCADE');
    await prisma.$executeRawUnsafe(`INSERT INTO dragon_stages (id, stage_number, name, rank_name, lore, unlock_message, level_range_start, level_range_end, primary_color, glow_color)
      VALUES (1,1,'Egg','DORMANT','x','x',1,10,'#000000','#000000') ON CONFLICT DO NOTHING`);
    for (const id of [1, 2, 3, 4]) await hunter(id);
  });

  after(async () => {
    await prisma?.$disconnect();
    // $disconnect leaves our own pg pool's idle connections open, which kept
    // this file alive ~30s — past --test-timeout on Node 22 (CI), failing it.
    await pool?.end();
  });

  test('request → pending both ways, push to the receiver, listed in their requests', async () => {
    assert.deepEqual(await friends.sendRequest(1, 2), { relationship: 'requested' });
    assert.equal((await friends.getCard(1, { userId: '2' })).relationship, 'requested');
    assert.equal((await friends.getCard(2, { userId: '1' })).relationship, 'incoming');

    const [push] = await pushes(2, 'FRIEND_REQUEST');
    assert.equal(push.title, '⚔️ Hunter Hunter1 seeks an alliance');
    assert.match(push.body, /join your party/);
    assert.equal(push.data.url, '/invite-friends');
    assert.equal((await pushes(1)).length, 0, 'nothing to the sender');

    const { requests, count } = await friends.listIncomingRequests(2);
    assert.equal(count, 1);
    assert.equal(requests[0].userId, '1');
    assert.equal(requests[0].relationship, 'incoming');
    assert.equal((await friends.listIncomingRequests(1)).count, 0, 'not in the sender\'s list');
  });

  test('accept → friends both ways, push back to the sender, on each other\'s Friends leaderboard', async () => {
    await friends.sendRequest(1, 2);
    assert.deepEqual(await friends.acceptRequest(2, 1), { relationship: 'friends' });

    const card = await friends.getCard(1, { userId: '2' });
    assert.equal(card.relationship, 'friends');
    assert.ok(card.friendsSince);
    const [push] = await pushes(1, 'FRIEND_ACCEPTED');
    assert.equal(push.title, '⚔️ Hunter Hunter2 joined your party');
    assert.equal(push.data.url, '/(tabs)/leaderboard?tab=friends');
    assert.deepEqual((await friends.getFriendIds(1)).map(String), ['2']);
    assert.deepEqual((await friends.getFriendIds(2)).map(String), ['1']);
    assert.equal((await friends.listIncomingRequests(2)).count, 0);
  });

  test('Friends leaderboard: accepted friends ranked, pending requests and strangers left out', async () => {
    const { getLeaderboard } = await import('../src/services/leaderboardService.js');
    const page = () => getLeaderboard({ meId: 1n, meSnapshot: {}, scope: 'friends', cursorStr: null, limit: 20 });

    let { entries, emptyState } = await page();
    assert.equal(emptyState, 'no_friends');
    assert.deepEqual(entries.map((e) => e.userId), ['1']);

    await friends.sendRequest(1, 2);
    await friends.sendRequest(1, 3);
    await friends.acceptRequest(3, 1);
    ({ entries, emptyState } = await page());
    assert.equal(emptyState, null);
    // XP is id × 10, so 3 ranks above 1; 2 (pending) and 4 (stranger) aren't there.
    assert.deepEqual(entries.map((e) => [e.userId, e.rank, e.isMe]), [['3', 1, false], ['1', 2, true]]);
  });

  test('a pending request is not a friendship', async () => {
    await friends.sendRequest(1, 2);
    assert.deepEqual(await friends.getFriendIds(1), []);
    assert.deepEqual(await friends.getFriendIds(2), []);
  });

  test('the sender cannot accept their own request', async () => {
    await friends.sendRequest(1, 2);
    await assert.rejects(friends.acceptRequest(1, 2), /NO_PENDING_REQUEST/);
  });

  test('decline is silent; asking again waits for the cooldown', async () => {
    await friends.sendRequest(1, 2);
    assert.deepEqual(await friends.declineRequest(2, 1), { relationship: 'none' });
    assert.equal((await pushes(1)).length, 0, 'no push for a decline');
    assert.equal((await friends.getCard(1, { userId: '2' })).relationship, 'none');

    await assert.rejects(friends.sendRequest(1, 2), /REQUEST_COOLDOWN/);
    await prisma.friendships.updateMany({ data: { updated_at: new Date(Date.now() - 8 * DAY) } });
    assert.deepEqual(await friends.sendRequest(1, 2), { relationship: 'requested' });
    assert.equal((await pair(1, 2)).status, 'PENDING');
  });

  test('the one who declined can still ask later', async () => {
    await friends.sendRequest(1, 2);
    await friends.declineRequest(2, 1);
    assert.deepEqual(await friends.sendRequest(2, 1), { relationship: 'requested' });
    assert.equal((await friends.getCard(1, { userId: '2' })).relationship, 'incoming');
  });

  test('asking someone who already asked you makes you friends', async () => {
    await friends.sendRequest(1, 2);
    assert.deepEqual(await friends.sendRequest(2, 1), { relationship: 'friends' });
    assert.equal((await pair(1, 2)).status, 'ACCEPTED');
    assert.equal((await pushes(1, 'FRIEND_ACCEPTED')).length, 1);
  });

  test('asking twice is idempotent: one row, one push', async () => {
    await friends.sendRequest(1, 2);
    assert.deepEqual(await friends.sendRequest(1, 2), { relationship: 'requested' });
    assert.equal(await prisma.friendships.count(), 1);
    assert.equal((await pushes(2)).length, 1);
  });

  test('cancel withdraws silently; cancel-and-resend the same day sends no second push', async () => {
    await friends.sendRequest(1, 2);
    assert.deepEqual(await friends.cancelRequest(1, 2), { relationship: 'none' });
    assert.equal(await pair(1, 2), null);
    assert.equal((await friends.listIncomingRequests(2)).count, 0);

    await friends.sendRequest(1, 2);
    assert.equal((await friends.listIncomingRequests(2)).count, 1, 'the request is back');
    assert.equal((await pushes(2, 'FRIEND_REQUEST')).length, 1, 'but only one push today');
  });

  test('friends again after a removal: the owner is told again (not swallowed by an old push)', async () => {
    await friends.sendRequest(1, 2);
    await friends.acceptRequest(2, 1);           // "Hunter2 accepted" → to 1
    await friends.removeFriend(1, 2);
    await friends.addByInviteLink(2, 'CODE01');  // "Hunter2 added you" → to 1
    assert.deepEqual((await pushes(1, 'FRIEND_ACCEPTED')).map((n) => n.title),
      ['⚔️ Hunter Hunter2 joined your party', '⚔️ Hunter Hunter2 answered your summons']);
  });

  test('remove friend is silent and either side can do it', async () => {
    await friends.sendRequest(1, 2);
    await friends.acceptRequest(2, 1);
    const before = (await pushes(1)).length + (await pushes(2)).length;
    assert.deepEqual(await friends.removeFriend(2, 1), { relationship: 'none' });
    assert.deepEqual(await friends.getFriendIds(1), []);
    assert.equal((await pushes(1)).length + (await pushes(2)).length, before);
  });

  test('block: ends the friendship, hides the blocker, stops requests both ways; unblock restores', async () => {
    await friends.sendRequest(1, 2);
    await friends.acceptRequest(2, 1);
    assert.deepEqual(await friends.blockUser(1, 2), { relationship: 'blocked' });

    assert.deepEqual(await friends.getFriendIds(1), []);
    assert.equal((await friends.getCard(1, { userId: '2' })).relationship, 'blocked');
    await assert.rejects(friends.getCard(2, { userId: '1' }), /USER_NOT_FOUND/, 'blocked hunter can\'t see the blocker');
    await assert.rejects(friends.getCard(2, { code: 'CODE01' }), /USER_NOT_FOUND/, 'not even by code');
    await assert.rejects(friends.sendRequest(2, 1), /USER_NOT_FOUND/);
    await assert.rejects(friends.sendRequest(1, 2), /USER_BLOCKED/);

    assert.deepEqual(await friends.unblockUser(1, 2), { relationship: 'none' });
    assert.equal((await friends.getCard(2, { userId: '1' })).relationship, 'none');
  });

  test('a blocked sender\'s old request disappears from the list', async () => {
    await friends.sendRequest(1, 2);
    await prisma.user_blocks.create({ data: { blocker_id: 2n, blocked_id: 1n } }); // bypass the cleanup
    assert.equal((await friends.listIncomingRequests(2)).count, 0);
  });

  test('hidden from the leaderboard: strangers can\'t open the card by id, but the shared code works', async () => {
    await prisma.user_settings.create({ data: { user_id: 3n, leaderboard_visible: false } });
    await assert.rejects(friends.getCard(1, { userId: '3' }), /USER_NOT_FOUND/);
    const byCode = await friends.getCard(1, { code: 'code03' });
    assert.equal(byCode.userId, '3');
    assert.equal(byCode.relationship, 'none');
    await friends.sendRequest(1, 3);
    assert.equal((await friends.getCard(1, { userId: '3' })).relationship, 'requested', 'by id once there\'s a request');
  });

  test('banned, pending-deletion, admin and unfinished accounts can\'t be found or asked', async () => {
    await prisma.users.update({ where: { id: 2n }, data: { is_banned: true } });
    await prisma.users.update({ where: { id: 3n }, data: { delete_at: new Date(Date.now() + 10 * DAY) } });
    await prisma.users.update({ where: { id: 4n }, data: { onboarding_done: false } });
    for (const id of ['2', '3', '4', '999']) {
      await assert.rejects(friends.getCard(1, { userId: id }), /USER_NOT_FOUND/, `card ${id}`);
      await assert.rejects(friends.sendRequest(1, id), /USER_NOT_FOUND/, `request ${id}`);
    }
    await prisma.users.update({ where: { id: 2n }, data: { is_banned: false, role: 'ADMIN' } });
    await assert.rejects(friends.sendRequest(1, 2), /USER_NOT_FOUND/);
  });

  test('a request from someone later scheduled for deletion drops out of the list', async () => {
    await friends.sendRequest(1, 2);
    await prisma.users.update({ where: { id: 1n }, data: { delete_at: new Date(Date.now() + DAY) } });
    assert.equal((await friends.listIncomingRequests(2)).count, 0);
  });

  test('yourself: own card reads "self", asking yourself is refused', async () => {
    assert.equal((await friends.getCard(1, { userId: '1' })).relationship, 'self');
    assert.equal((await friends.getCard(1, { code: 'CODE01' })).relationship, 'self');
    await assert.rejects(friends.sendRequest(1, 1), /CANNOT_FRIEND_SELF/);
    await assert.rejects(friends.removeFriend(1, 1), /CANNOT_FRIEND_SELF/);
    await assert.rejects(friends.addByInviteLink(1, 'CODE01'), /CANNOT_FRIEND_SELF/);
  });

  test('pasted code: card by code, then a request that needs accepting', async () => {
    // Last active 10 days ago with 1 life: the leaderboard reads that streak as broken.
    await prisma.user_progression.update({
      where: { user_id: 2n },
      data:  { last_active_date: new Date(Date.now() - 10 * DAY), streak_lives: 1 },
    });
    const card = await friends.getCard(1, { code: ' code02 ' });
    assert.equal(card.userId, '2');
    assert.equal(card.name, 'Hunter2');
    assert.equal(card.streak, 0, 'a gap longer than the lives reads as broken, like the leaderboard');
    assert.equal((await friends.getCard(1, { userId: '3' })).streak, 3, 'no gap → the stored streak');
    assert.equal(card.longestStreak, 9);
    assert.ok(card.joinedAt);
    await assert.rejects(friends.getCard(1, { code: 'NOPE!!' }), /INVALID_CODE|USER_NOT_FOUND/);
    await assert.rejects(friends.getCard(1, { code: 'ZZZZ99' }), /USER_NOT_FOUND/);

    await friends.sendRequest(1, card.userId);
    assert.equal((await friends.getCard(2, { userId: '1' })).relationship, 'incoming');
  });

  test('invite link opened by an existing hunter: friends straight away, owner told', async () => {
    assert.deepEqual(await friends.addByInviteLink(1, 'CODE02'), { relationship: 'friends', userId: '2' });
    const row = await pair(1, 2);
    assert.equal(row.status, 'ACCEPTED');
    assert.equal(row.source, 'LINK');
    const [push] = await pushes(2, 'FRIEND_ACCEPTED');
    assert.equal(push.title, '⚔️ Hunter Hunter1 answered your summons');
    assert.deepEqual(await friends.addByInviteLink(1, 'CODE02'), { relationship: 'friends', userId: '2' }, 'again is fine');
    assert.equal((await pushes(2, 'FRIEND_ACCEPTED')).length, 1);
  });

  test('invite link also settles a pending request either way', async () => {
    await friends.sendRequest(2, 1);
    await friends.addByInviteLink(1, 'CODE02');
    assert.equal((await pair(1, 2)).status, 'ACCEPTED');
    assert.equal(await prisma.friendships.count(), 1);
  });

  test('signing up with an invite code makes inviter and invitee friends (late referral path)', async () => {
    await prisma.users.update({ where: { id: 4n }, data: { onboarding_done: false } });
    assert.equal(await referrals.attachLateReferral(4, 'CODE01'), true);
    const row = await pair(1, 4);
    assert.equal(row.status, 'ACCEPTED');
    assert.equal(row.source, 'INVITE');
    assert.equal(row.requested_by, 1n);
  });

  test('daily request limit', async () => {
    for (let id = 10; id < 10 + friends.DAILY_REQUEST_LIMIT + 1; id++) await hunter(id);
    for (let i = 0; i < friends.DAILY_REQUEST_LIMIT; i++) await friends.sendRequest(1, 10 + i);
    await assert.rejects(friends.sendRequest(1, 10 + friends.DAILY_REQUEST_LIMIT), /REQUEST_LIMIT/);
  });

  test('two hunters asking each other at the same moment end up as one friendship', async () => {
    await Promise.all([friends.sendRequest(1, 2), friends.sendRequest(2, 1)]);
    assert.equal(await prisma.friendships.count(), 1);
    const row = await pair(1, 2);
    assert.ok(['PENDING', 'ACCEPTED'].includes(row.status));
  });

  test('deleting an account removes its friendships, requests and blocks', async () => {
    await friends.sendRequest(1, 2);
    await friends.acceptRequest(2, 1);
    await friends.sendRequest(3, 1);
    await friends.blockUser(4, 1);
    await prisma.users.delete({ where: { id: 1n } });
    assert.equal(await prisma.friendships.count(), 0);
    assert.equal(await prisma.user_blocks.count(), 0);
  });
});
