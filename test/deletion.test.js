// Scheduled account deletion (accountDeletionService.js): the app's
// one-time website link, the website's emailed codes, and cancelling.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma } from './support/fakePrisma.js';

process.env.WEBSITE_URL = 'https://www.example.com/';
delete process.env.REDIS_URL;

const fake = createFakePrisma();
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });
const sent = [];
mock.module(new URL('../src/utils/mailer.js', import.meta.url).href, {
  namedExports: { sendMail: async (msg) => { sent.push(msg); return {}; }, mailTransporter: {} },
});

// No uploads in these tests (Cloudinary cleanup is covered by mediaCleanup.test.js).
const noMedia = async () => ({ partial: false, resources: [] });
mock.module(new URL('../src/config/cloudinary.js', import.meta.url).href, {
  defaultExport: { api: { delete_resources_by_prefix: noMedia, resources: noMedia, delete_folder: noMedia }, uploader: {}, utils: {} },
});

const deletion = await import('../src/services/accountDeletionService.js');

beforeEach(() => {
  for (const m of Object.values(fake.models)) m.rows.length = 0;
  sent.length = 0;
  fake.models.users.rows.push({ id: 1n, email: 'hunter@example.com', role: 'USER', delete_at: null });
});

test('the one-time link schedules deletion 30 days out and works once', async () => {
  const { url } = await deletion.createDeletionLink(1n);
  assert.match(url, /^https:\/\/www\.example\.com\/delete-account\?t=[a-f0-9]{64}$/);
  const token = new URL(url).searchParams.get('t');
  const deleteAt = await deletion.confirmDeletionByToken(token);
  const days = (deleteAt.getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30);
  assert.equal(fake.models.users.rows[0].deletion_token_hash, null);
  await assert.rejects(deletion.confirmDeletionByToken(token), /INVALID_TOKEN/);
});

test('an expired link is refused', async () => {
  const { url } = await deletion.createDeletionLink(1n);
  fake.models.users.rows[0].deletion_token_expiry = new Date(Date.now() - 1000);
  await assert.rejects(deletion.confirmDeletionByToken(new URL(url).searchParams.get('t')), /EXPIRED_TOKEN/);
});

test('website code flow: request, confirm, then cancel with a second code', async () => {
  await deletion.requestDeletionCode('Hunter@Example.com', 'delete');
  const code = sent[0].html.match(/>(\d{6})</)[1];
  await assert.rejects(deletion.confirmDeletionByCode('hunter@example.com', '000000'), /OTP_INVALID/);
  await deletion.confirmDeletionByCode('hunter@example.com', code);
  assert.ok(fake.models.users.rows[0].delete_at);

  sent.length = 0;
  await deletion.requestDeletionCode('hunter@example.com', 'cancel');
  const cancelCode = sent[0].html.match(/>(\d{6})</)[1];
  await deletion.cancelDeletionByCode('hunter@example.com', cancelCode);
  assert.equal(fake.models.users.rows[0].delete_at, null);
});

test('unknown emails get no code and the same silent success', async () => {
  await deletion.requestDeletionCode('nobody@example.com', 'delete');
  assert.equal(sent.length, 0);
});

test('Keep my account fails cleanly when nothing is scheduled', async () => {
  await assert.rejects(deletion.cancelDeletion(1n), /NO_PENDING_DELETION/);
});

// ── Deletion notifications ─────────────────────────────────

const DAY = 86_400_000;
const pushes = (type) => fake.models.notifications.rows.filter((n) => !type || n.type === type);

async function scheduleViaLink() {
  const { url } = await deletion.createDeletionLink(1n);
  return deletion.confirmDeletionByToken(new URL(url).searchParams.get('t'));
}

test('scheduling queues an ACCOUNT_DELETION push to Profile and an email', async () => {
  const deleteAt = await scheduleViaLink();
  const [push] = pushes('ACCOUNT_DELETION');
  assert.equal(pushes().length, 1);
  assert.equal(push.title, '⚠️ Account deletion scheduled');
  assert.ok(push.body.includes(deletion.formatDeletionDate(deleteAt)));
  assert.equal(push.data.url, '/(tabs)/profile');
  assert.equal(push.push_status, 'PENDING');
  assert.ok(push.deliver_after.getTime() <= Date.now(), 'sent straight away, even in quiet hours');
  assert.equal(sent.at(-1).subject, 'Your HunterX account will be deleted');
});

test('pushes go out even with every notification setting switched off', async () => {
  fake.models.user_settings.rows.push({ user_id: 1n, notify_all: false, notify_announcements: false, timezone: 'Asia/Kolkata' });
  await scheduleViaLink();
  assert.equal(pushes('ACCOUNT_DELETION').length, 1);
});

test('Keep my account in the app emails a confirmation but sends no push', async () => {
  await scheduleViaLink();
  sent.length = 0;
  await deletion.cancelDeletion(1n);
  assert.equal(pushes().length, 1, 'only the scheduled push');
  assert.equal(sent[0].subject, 'Your HunterX account will not be deleted');
});

test('cancelling on the website pushes "Your account is safe" and emails', async () => {
  // Own address: an earlier test's cancel code for hunter@ is still in its cooldown.
  fake.models.users.rows[0].email = 'web-cancel@example.com';
  await scheduleViaLink();
  await deletion.requestDeletionCode('web-cancel@example.com', 'cancel');
  const code = sent.at(-1).html.match(/>(\d{6})</)[1];
  await deletion.cancelDeletionByCode('web-cancel@example.com', code);
  assert.deepEqual(pushes().map((n) => n.title), ['⚠️ Account deletion scheduled', '✅ Your account is safe']);
  assert.equal(sent.at(-1).subject, 'Your HunterX account will not be deleted');
});

test('the reminder goes out once, 3 days before deletion, as push and email', async () => {
  const now = new Date();
  const user = fake.models.users.rows[0];
  user.delete_at = new Date(now.getTime() + 2.5 * DAY);

  assert.equal(await deletion.sendDeletionReminders(now), 1);
  const [reminder] = pushes('ACCOUNT_DELETION_REMINDER');
  assert.equal(reminder.title, '⏳ 3 days until your account is deleted');
  assert.equal(reminder.data.url, '/(tabs)/profile');
  assert.equal(sent.at(-1).subject, 'Your HunterX account will be deleted in 3 days');

  sent.length = 0;
  assert.equal(await deletion.sendDeletionReminders(now), 0, 'never twice for the same date');
  assert.equal(sent.length, 0);
  assert.equal(pushes('ACCOUNT_DELETION_REMINDER').length, 1);
});

test('no reminder while deletion is further off, or for accounts not scheduled', async () => {
  const now = new Date();
  fake.models.users.rows.push({ id: 2n, email: 'later@example.com', role: 'USER', delete_at: new Date(now.getTime() + 10 * DAY) });
  assert.equal(await deletion.sendDeletionReminders(now), 0);
  assert.equal(pushes().length, 0);
});

test('a new deletion date gets its own reminder', async () => {
  const now = new Date();
  const user = fake.models.users.rows[0];
  user.delete_at = new Date(now.getTime() + 2.5 * DAY);
  await deletion.sendDeletionReminders(now);
  user.delete_at = new Date(now.getTime() + 2 * DAY);
  assert.equal(await deletion.sendDeletionReminders(now), 1);
  assert.equal(pushes('ACCOUNT_DELETION_REMINDER').at(-1).title, '⏳ 2 days until your account is deleted');
});

test('the last day gets a final reminder, once, after the 3-day one', async () => {
  const start = new Date();
  const deleteAt = new Date(start.getTime() + 2.5 * DAY);
  fake.models.users.rows[0].delete_at = deleteAt;

  await deletion.sendDeletionReminders(start);                                // 3-day
  const lastDayNow = new Date(deleteAt.getTime() - 20 * 60 * 60 * 1000);      // 20h left
  assert.equal(await deletion.sendDeletionReminders(lastDayNow), 1);
  assert.equal(await deletion.sendDeletionReminders(lastDayNow), 0, 'never twice');

  assert.deepEqual(pushes('ACCOUNT_DELETION_REMINDER').map((n) => n.title), [
    '⏳ 3 days until your account is deleted',
    '🚨 Last day to keep your account',
  ]);
  const last = pushes('ACCOUNT_DELETION_REMINDER').at(-1);
  assert.equal(last.data.url, '/(tabs)/profile');
  assert.ok(last.deliver_after < deleteAt, 'quiet hours never hold it past the deletion');
  assert.equal(sent.at(-1).subject, 'Last day to keep your HunterX account');
});

test('if the 3-day window was missed, only the last-day reminder goes', async () => {
  const now = new Date();
  fake.models.users.rows[0].delete_at = new Date(now.getTime() + 10 * 60 * 60 * 1000); // 10h left
  assert.equal(await deletion.sendDeletionReminders(now), 1);
  assert.deepEqual(pushes().map((n) => n.title), ['🚨 Last day to keep your account']);
});

test('admins cannot be scheduled for deletion', async () => {
  fake.models.users.rows[0].role = 'ADMIN';
  await assert.rejects(deletion.createDeletionLink(1n), /CANNOT_DELETE_ADMIN/);
});

// ── Purge vs. "Keep my account" ───────────────────────────

test('the purge deletes only accounts still due, re-checked at delete time', async () => {
  const user = fake.models.users.rows[0];
  user.delete_at = new Date(Date.now() - 1000);
  fake.models.users.rows.push({ id: 2n, email: 'kept@example.com', role: 'USER', delete_at: null });

  // A cancel that commits between the purge's scan and its delete wins.
  await assert.rejects(deletion.deleteUserAccount(2n, { onlyIfDueBy: new Date() }), /NOT_DUE/);
  assert.ok(fake.models.users.rows.some((u) => u.id === 2n));

  assert.equal(await deletion.purgeDueAccounts(), 1);
  assert.deepEqual(fake.models.users.rows.map((u) => u.id), [2n]);
});

test('once the date has passed, neither cancel path restores or says "safe"', async () => {
  const user = fake.models.users.rows[0];
  user.email = 'too-late@example.com';
  user.delete_at = new Date(Date.now() - 1000);

  await assert.rejects(deletion.cancelDeletion(1n), /DELETION_ALREADY_DUE/);
  assert.ok(user.delete_at, 'still scheduled');

  // The website can't even get a cancel code then.
  await deletion.requestDeletionCode('too-late@example.com', 'cancel');
  assert.equal(sent.length, 0, 'no code, no "your account is safe" email');
  assert.equal(pushes().length, 0);
});
