// Every transactional email, rendered by the real nodemailer (10.x) through
// the real src/utils/mailer.js — with its SMTP transport swapped for
// nodemailer's JSON transport, so messages are fully built (MIME, envelope,
// attachments) but nothing is sent. Also round-trips the data-export
// workbook through ExcelJS.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import ExcelJS from 'exceljs';
import bcrypt from 'bcryptjs';
import { createFakePrisma } from './support/fakePrisma.js';

process.env.JWT_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.WEBSITE_URL = 'https://www.example.com';
process.env.APP_URL = 'https://www.example.com';
process.env.EMAIL_FROM = 'HunterX <no-reply@example.com>';
delete process.env.REDIS_URL;

const fake = createFakePrisma();
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });

const { mailTransporter } = await import('../src/utils/mailer.js');
const smtpName = mailTransporter.transporter.name;
mailTransporter.transporter = nodemailer.createTransport({ jsonTransport: true }).transporter;

const sent = [];
const realSendMail = mailTransporter.sendMail.bind(mailTransporter);
mailTransporter.sendMail = async (msg) => {
  const info = await realSendMail(msg);
  sent.push({ ...JSON.parse(info.message), envelope: info.envelope });
  return info;
};

const auth = await import('../src/services/authService.js');
const deletion = await import('../src/services/accountDeletionService.js');
const dataExport = await import('../src/services/dataExportService.js');

const waitForMail = async (count) => {
  for (let i = 0; i < 50 && sent.length < count; i++) await new Promise((r) => setTimeout(r, 10));
};

function assertWellFormed(mail, to) {
  assert.deepEqual(mail.envelope.to, [to]);
  assert.equal(mail.from.address, 'no-reply@example.com');
  assert.ok(mail.subject.length > 0);
  assert.match(mail.html, /HUNTERX/);
}

beforeEach(() => {
  for (const m of Object.values(fake.models)) m.rows.length = 0;
  sent.length = 0;
  fake.models.users.rows.push({
    id: 1n, name: 'Hunter', email: 'hunter@example.com', hunter_id: 'HUN00001', role: 'USER',
    gender: null, token_version: 0, is_banned: false, password_hash: bcrypt.hashSync('Hunter#2026', 4),
    email_verified_at: new Date(), delete_at: null, created_at: new Date(), reset_token_expiry: null,
  });
  fake.models.auth_providers.rows.push({ id: 1n, user_id: 1n, provider: 'EMAIL', provider_id: 'hunter@example.com' });
});

test('the configured transport is SMTP (initialises without connecting)', () => {
  assert.equal(smtpName, 'SMTP');
});

test('signup verification code', async () => {
  await auth.sendOtp('new@example.com');
  assertWellFormed(sent[0], 'new@example.com');
  assert.match(sent[0].html, /\d{6}/);
});

test('"you already have an account" notice', async () => {
  await auth.sendOtp('hunter@example.com');
  assertWellFormed(sent[0], 'hunter@example.com');
  assert.match(sent[0].subject, /already have/);
});

test('password reset link', async () => {
  await auth.forgotPassword('hunter@example.com');
  await waitForMail(1);
  assertWellFormed(sent[0], 'hunter@example.com');
  assert.match(sent[0].html, /https:\/\/www\.example\.com\/reset-password\?token=[a-f0-9]{64}/);
});

test('"no password to reset" notice for Google accounts', async () => {
  fake.models.auth_providers.rows[0].provider = 'GOOGLE';
  await auth.forgotPassword('hunter@example.com');
  await waitForMail(1);
  assertWellFormed(sent[0], 'hunter@example.com');
  assert.match(sent[0].html, /Continue with Google/);
});

test('email change: code to the new address, notice to the old one', async () => {
  await auth.requestEmailChange(1n, 'next@example.com', 'Hunter#2026');
  assertWellFormed(sent[0], 'next@example.com');
  const code = sent[0].html.match(/>(\d{6})</)[1];
  await auth.confirmEmailChange(1n, 'next@example.com', code);
  await waitForMail(2);
  assertWellFormed(sent[1], 'hunter@example.com');
  assert.match(sent[1].html, /next@example\.com/);
});

test('account deletion: codes, and the scheduled notice', async () => {
  await deletion.requestDeletionCode('hunter@example.com', 'delete');
  assertWellFormed(sent[0], 'hunter@example.com');
  const code = sent[0].html.match(/>(\d{6})</)[1];
  await deletion.confirmDeletionByCode('hunter@example.com', code);
  await waitForMail(2);
  assertWellFormed(sent[1], 'hunter@example.com');
  assert.match(sent[1].subject, /will be deleted/);
  await deletion.requestDeletionCode('hunter@example.com', 'cancel');
  assertWellFormed(sent[2], 'hunter@example.com');
  assert.match(sent[2].subject, /Keep your/);
});

test('data export: the email carries a workbook ExcelJS can read back', async () => {
  await dataExport.requestDataExport(1n);
  assertWellFormed(sent[0], 'hunter@example.com');
  assert.equal(sent[0].attachments.length, 1);
  const attachment = sent[0].attachments[0];
  assert.equal(attachment.filename, 'HunterX_Data_Export_HUN00001.xlsx');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(attachment.content, 'base64'));
  assert.ok(workbook.worksheets.length > 0);
  const text = JSON.stringify(workbook.worksheets.map((s) => s.getSheetValues()));
  assert.match(text, /hunter@example\.com/);
});
