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

test('admins cannot be scheduled for deletion', async () => {
  fake.models.users.rows[0].role = 'ADMIN';
  await assert.rejects(deletion.createDeletionLink(1n), /CANNOT_DELETE_ADMIN/);
});
