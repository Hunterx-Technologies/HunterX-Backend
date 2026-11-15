// The admin panel's calendar (utils/adminClock.js): dashboard ranges and
// "today" follow the admin's browser zone for the request, IST without one.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: {} });

const { runWithAdminTimezone, getAdminTimezone, adminDayStart } = await import('../src/utils/adminClock.js');
const { resolveRange } = await import('../src/utils/dashboardRange.js');

const day = (s) => new Date(`${s}T00:00:00.000Z`);

test('outside an admin request the calendar is IST', () => {
  assert.equal(getAdminTimezone(), 'Asia/Kolkata');
  assert.equal(adminDayStart(day('2026-11-15')).toISOString(), '2026-11-14T18:30:00.000Z');
});

test('an invalid X-Timezone falls back to IST', () => {
  runWithAdminTimezone('Mars/Base', () => assert.equal(getAdminTimezone(), 'Asia/Kolkata'));
});

test('a custom range starts and ends at the admin\'s midnight, kept across awaits', async () => {
  await runWithAdminTimezone('America/New_York', async () => {
    await new Promise((r) => setTimeout(r, 1));
    const r = resolveRange({ from: '2026-11-01', to: '2026-11-03' });
    // 1 Nov 2026 is the EDT→EST switch: midnight is still UTC−4, the 4th's is UTC−5.
    assert.equal(r.startUtc.toISOString(), '2026-11-01T04:00:00.000Z');
    assert.equal(r.endUtc.toISOString(), '2026-11-04T05:00:00.000Z');
  });
});
