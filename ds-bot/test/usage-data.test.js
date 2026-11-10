import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RANGES, bucketsOf, compact, costOf, moneyOf, percent, spanOf, spanRange, summarize } from '../src/client/usage-data.js'

const range = id => RANGES.find(item => item.id === id)
// [hour, owner, model, kind, input, cacheRead, cacheWrite, output, calls]
const row = (hour, owner, tokens, model = 0) => [hour, owner, model, 0, tokens, 0, 0, 0, 1]

test('buckets end at the current hour, day, week, or month, after as many before them', () => {
  const hours = bucketsOf(range('24h'), '2026-10-09 22')
  assert.equal(hours.length, 48)
  assert.equal(hours.at(-1).key, '2026-10-09 22')
  assert.equal(hours.at(-24).key, '2026-10-08 23')
  assert.equal(hours[0].key, '2026-10-07 23')

  const days = bucketsOf(range('7d'), '2026-10-09 22')
  assert.deepEqual(days.slice(7).map(bucket => bucket.key), ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'])

  // 2026-10-09 is a Friday; its week starts on Monday the 5th.
  const weeks = bucketsOf(range('12w'), '2026-10-09 22')
  assert.equal(weeks.at(-1).key, '2026-10-05')
  assert.equal(weeks.at(-2).key, '2026-09-28')

  const months = bucketsOf(range('12m'), '2026-02-01 00')
  assert.equal(months.at(-1).key, '2026-02')
  assert.equal(months.at(-3).key, '2025-12')
  assert.equal(months[0].key, '2024-03')
})

test('a summary sums the range, the span before it, and each owner, model, and stack', () => {
  const view = {
    now: '2026-10-09 22',
    rows: [
      row('2026-10-01 09', 0, 50),
      row('2026-10-05 08', 0, 100),
      ['2026-10-05 09', 1, 1, 2, 10, 30, 5, 20, 2],
      row('2026-10-09 21', 0, 7),
      row('2026-09-01 00', 0, 999),
    ],
  }
  const week = summarize(view, range('7d'), undefined, item => `o${item[1]}`)
  assert.equal(week.total.total, 172)
  // The cache write counts as input.
  // No model has a price, so every token counts as unpriced and the cost stays 0.
  assert.deepEqual(week.total, { input: 122, cacheRead: 30, output: 20, calls: 4, total: 172, cost: 0, unpriced: 172 })
  assert.equal(week.previous, 50)
  assert.equal(week.buckets[2].key, '2026-10-05')
  assert.equal(week.buckets[2].sum.total, 165)
  assert.deepEqual([...week.buckets[2].stacks], [['o0', 100], ['o1', 65]])
  assert.equal(week.owners.get(1).total, 65)
  assert.equal(week.models.get(0).total, 107)
  assert.equal(week.kinds.get(2).calls, 2)

  const one = summarize(view, range('12w'), item => item[1] === 0)
  assert.equal(one.total.total, 1156)
  assert.equal(one.buckets.find(bucket => bucket.key === '2026-08-31').sum.total, 999)
  assert.equal(one.buckets.at(-1).sum.total, 107)
  assert.equal(one.buckets.at(-2).sum.total, 50)
})

test('a picked span sums by hour, day, week, or month by its length', () => {
  const units = [['2026-10-09', '2026-10-09'], ['2026-10-08', '2026-10-09'], ['2026-10-07', '2026-10-09'], ['2026-08-09', '2026-10-09'], ['2026-08-08', '2026-10-09'], ['2026-04-11', '2026-10-09'], ['2026-04-10', '2026-10-09']]
    .map(([from, to]) => { const span = spanRange(from, to); return [span.days, span.unit] })
  assert.deepEqual(units, [[1, 'hour'], [2, 'hour'], [3, 'day'], [62, 'day'], [63, 'week'], [182, 'week'], [183, 'month']])
  assert.deepEqual(spanRange('2026-10-09', '2026-10-01'), spanRange('2026-10-01', '2026-10-09'))

  const hours = spanRange('2026-10-08', '2026-10-09')
  const hourSpan = spanOf(hours, '2026-10-09 22')
  assert.equal(hours.count, 48)
  assert.equal(hourSpan.buckets[0].key, '2026-10-08 00')
  assert.equal(hourSpan.buckets.at(-1).key, '2026-10-09 23')
  assert.equal(hourSpan.before, '2026-10-06 00')

  // 2026-07-01 is a Wednesday: the first week starts on Monday the 29th but is cut to the span.
  const weeks = spanRange('2026-07-01', '2026-10-09')
  const weekSpan = spanOf(weeks, '2026-10-09 22')
  assert.equal(weeks.count, 15)
  assert.equal(weeks.stride, 2)
  assert.equal(weekSpan.buckets[0].key, '2026-06-29')
  assert.equal(weekSpan.buckets[0].start, Date.UTC(2026, 6, 1))
  assert.equal(weekSpan.buckets.at(-1).end, Date.UTC(2026, 9, 10))

  const months = spanOf(spanRange('2025-11-15', '2026-10-09'), '2026-10-09 22')
  assert.deepEqual([months.buckets.length, months.buckets[0].key, months.buckets.at(-1).key], [12, '2025-11', '2026-10'])
  assert.equal(months.buckets[0].start, Date.UTC(2025, 10, 15))
  assert.equal(months.buckets[1].start, Date.UTC(2025, 11, 1))
})

test('a picked span compares with as many days just before it and ignores the days after', () => {
  const view = {
    now: '2026-10-09 22',
    rows: [
      row('2026-09-27 23', 0, 1000),
      row('2026-09-28 00', 0, 5),
      row('2026-09-30 23', 0, 6),
      row('2026-10-01 00', 0, 10),
      row('2026-10-03 23', 1, 20),
      row('2026-10-04 00', 0, 999),
    ],
  }
  const days = summarize(view, spanRange('2026-10-01', '2026-10-03'))
  assert.deepEqual(days.buckets.map(bucket => [bucket.key, bucket.sum.total]), [['2026-10-01', 10], ['2026-10-02', 0], ['2026-10-03', 20]])
  assert.equal(days.total.total, 30)
  assert.equal(days.previous, 11)
  assert.equal(days.owners.get(1).total, 20)

  // The Tuesday before the span shares its first week's key but counts as the span before.
  const weeks = summarize({ now: view.now, rows: [row('2026-06-30 10', 0, 4), row('2026-07-01 00', 0, 9)] }, spanRange('2026-07-01', '2026-10-09'))
  assert.equal(weeks.buckets[0].sum.total, 9)
  assert.equal(weeks.previous, 4)
})

test('counts read short and shares round', () => {
  assert.equal(compact(0), '0')
  assert.equal(compact(950), '950')
  assert.equal(compact(1500), '1.5K')
  assert.equal(compact(12_340), '12.3K')
  assert.equal(compact(999_999), '1M')
  assert.equal(compact(2_000_000), '2M')
  assert.equal(compact(345_100_000), '345M')
  assert.equal(percent(1, 300), '<1')
  assert.equal(percent(0, 300), '0')
  assert.equal(percent(1, 3), '33')
  assert.equal(percent(5, 0), '0')
})

test('money follows the price table, and a model with no price is never free', () => {
  // input 1M uncached + 1M cache write, 2M cache read, 1M output.
  const priced = ['2026-10-09 10', 0, 0, 0, 1e6, 2e6, 1e6, 1e6, 1, -1]
  const unpriced = ['2026-10-09 11', 1, 1, 0, 5e5, 0, 0, 0, 1, 0]
  const price = { input: 0.5, cachedInput: 0.1, output: 2 }
  assert.equal(costOf(priced, price), 2 * 0.5 + 2 * 0.1 + 2)
  assert.equal(costOf(priced, undefined), undefined)
  const view = { now: '2026-10-09 22', models: [{ key: 'p/a', price }, { key: 'p/b' }], rooms: [{ id: 'r1', name: 'Team' }], rows: [priced, unpriced] }
  const day = summarize(view, RANGES.find(item => item.id === '24h'))
  assert.ok(Math.abs(day.models.get(0).cost - 3.2) < 1e-9)
  // The unpriced model says "price not set", not zero.
  assert.equal(moneyOf(day.models.get(1)), undefined)
  // A total that mixes both is a lower bound.
  assert.deepEqual({ ...moneyOf(day.total), amount: Math.round(moneyOf(day.total).amount * 100) / 100 }, { amount: 3.2, partial: true })
  assert.equal(moneyOf(day.owners.get(0)).partial, false)
  // Only the call made in a group counts for that group.
  assert.deepEqual([...day.rooms.keys()], [0])
  assert.equal(day.rooms.get(0).total, 5e5)
})
