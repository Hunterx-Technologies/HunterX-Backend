// Pure helpers: tokens, password rules, hashing, email template escaping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

const helpers = await import('../src/utils/helpers.js');
const { escapeHtml } = await import('../src/utils/emailTemplates.js');

test('refresh token carries jti, family and token version', () => {
  const { refreshToken } = helpers.generateTokens('7', 'USER', null, 3, { jti: 'abc', familyId: 'fam' });
  const decoded = helpers.verifyRefreshToken(refreshToken);
  assert.equal(decoded.jti, 'abc');
  assert.equal(decoded.fam, 'fam');
  assert.equal(decoded.tv, 3);
});

test('access tokens signed with another algorithm are refused', () => {
  const forged = jwt.sign({ userId: '1', role: 'ADMIN' }, process.env.JWT_SECRET, { algorithm: 'HS512' });
  assert.throws(() => helpers.verifyAccessToken(forged), /invalid algorithm/);
});

test('unsigned (alg none) tokens are refused', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ userId: '1', role: 'ADMIN' })).toString('base64url');
  assert.throws(() => helpers.verifyAccessToken(`${header}.${body}.`));
});

test('strong password rules', () => {
  assert.equal(helpers.isStrongPassword('aaaaaaaa').valid, false);
  assert.deepEqual(helpers.isStrongPassword('aaaaaaaa').errors, ['ONE_UPPERCASE_LETTER', 'ONE_NUMBER', 'ONE_SPECIAL_CHARACTER']);
  assert.equal(helpers.isStrongPassword('Hunter#2026').valid, true);
});

test('sha256 is stable hex', () => {
  assert.equal(helpers.sha256('123456'), '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92');
});

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<img src=x onerror="a">'), '&lt;img src=x onerror=&quot;a&quot;&gt;');
});
