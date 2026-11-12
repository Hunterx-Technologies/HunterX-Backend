// Dashboard date filter: ?range= presets, ?from=&to=, and chart buckets
// (utils/dashboardRange.js). Days are IST.
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { resolveRange, rangeBuckets } = await import('../src/utils/dashboardRange.js');

// 2026-11-11 10:00 IST
before(() => mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-11T04:30:00Z') }));
after(() => mock.timers.reset());

const span = (q) => {
  const r = resolveRange(q);
  return `${r.fromKey}..${r.toKey}/${r.days}`;
};

test('defaults to the last 7 days, today included', () => {
  assert.equal(span({}), '2026-11-05..2026-11-11/7');
  assert.equal(span({ range: '' }), '2026-11-05..2026-11-11/7');
});

test('day and month presets end today', () => {
  assert.equal(span({ range: '30d' }), '2026-10-13..2026-11-11/30');
  assert.equal(span({ range: '90d' }), '2026-08-14..2026-11-11/90');
  assert.equal(span({ range: '6m' }), '2026-05-12..2026-11-11/184');
  assert.equal(span({ range: '1y' }), '2025-11-12..2026-11-11/365');
  assert.equal(span({ range: '3y' }), '2023-11-12..2026-11-11/1096');
});

test('range boundaries are IST midnights as UTC instants', () => {
  const r = resolveRange({ range: '7d' });
  assert.equal(r.startUtc.toISOString(), '2026-11-04T18:30:00.000Z');
  assert.equal(r.endUtc.toISOString(), '2026-11-11T18:30:00.000Z');
  assert.equal(r.endAt.getTime(), Date.now()); // ends today → as of now
});

test('the previous period has the same length, just before', () => {
  const r = resolveRange({ from: '2026-09-01', to: '2026-09-30' });
  assert.equal(`${r.prev.fromKey}..${r.prev.toKey}/${r.prev.days}`, '2026-08-02..2026-08-31/30');
  assert.equal(r.endAt.toISOString(), '2026-09-30T18:29:59.999Z'); // ended in the past → its last instant
});

test('custom ranges: to is clamped to today, bad input is refused', () => {
  assert.equal(span({ from: '2026-11-01', to: '2027-01-01' }), '2026-11-01..2026-11-11/11');
  for (const q of [
    { range: '2w' },
    { from: '2026-10-10', to: '2026-10-01' },
    { from: '2026-12-01', to: '2026-12-02' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-01-01' },
    { from: '2015-01-01', to: '2026-01-01' },
  ]) {
    assert.throws(() => resolveRange(q), (e) => e.message === 'INVALID_RANGE' && typeof e.reason === 'string', JSON.stringify(q));
  }
});

test('month presets clamp to short months', () => {
  mock.timers.setTime(Date.parse('2026-08-30T04:30:00Z')); // Aug 30 → day after is Aug 31; 6 months back is Feb (28 days)
  assert.equal(resolveRange({ range: '6m' }).fromKey, '2026-02-28');
  mock.timers.setTime(Date.parse('2026-11-11T04:30:00Z'));
});

test('buckets: daily up to ~3 months, weekly to ~13 months, monthly beyond', () => {
  const daily = rangeBuckets(resolveRange({ range: '90d' }));
  assert.equal(daily.unit, 'day');
  assert.equal(daily.buckets.length, 90);

  const weekly = rangeBuckets(resolveRange({ range: '1y' }));
  assert.equal(weekly.unit, 'week');
  assert.equal(weekly.buckets[0].key, '2025-11-12');
  assert.equal(weekly.buckets.at(-1).to.toISOString().slice(0, 10), '2026-11-11');

  const monthly = rangeBuckets(resolveRange({ range: '3y' }));
  assert.equal(monthly.unit, 'month');
  assert.equal(monthly.buckets[0].key, '2023-11-12');
  assert.equal(monthly.buckets[1].key, '2023-12-01');
  assert.equal(monthly.buckets.at(-1).key, '2026-11-01');

  // Buckets cover every day exactly once.
  const days = monthly.buckets.reduce((n, b) => n + Math.round((b.to - b.from) / 864e5) + 1, 0);
  assert.equal(days, 1096);
});
