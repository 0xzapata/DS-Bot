// The Usage page's numbers: the host's hourly rows, summed by hour, day, week, or month.

// A view row: [hour, owner, model, kind, input, cacheRead, cacheWrite, output, calls, room].
// `room` is the group the call happened in (-1 for none); older hosts leave it out.
export const HOUR = 0
export const OWNER = 1
export const MODEL = 2
export const KIND = 3
export const ROOM = 9

export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

// `stride`: every how many buckets the time axis prints a label, counted back from now.
export const RANGES = [
  { id: '24h', unit: 'hour', count: 24, stride: 6 },
  { id: '7d', unit: 'day', count: 7, stride: 1 },
  { id: '30d', unit: 'day', count: 30, stride: 5 },
  { id: '12w', unit: 'week', count: 12, stride: 2 },
  { id: '12m', unit: 'month', count: 12, stride: 1 },
]

// Hour keys are wall-clock times in the browser's zone. Reading them as UTC keeps every
// calendar step exact, whatever the zone's daylight saving does.
export const hourMs = key => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)), Number(key.slice(11, 13)) || 0)
export const dayKey = ms => new Date(ms).toISOString().slice(0, 10)
const hourKey = ms => new Date(ms).toISOString().slice(0, 13).replace('T', ' ')
// Weeks start on Monday.
export const mondayOf = ms => ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS

// A span of whole days the user picks, `from` to `to` inclusive, as day keys. The unit
// keeps the bars between about 7 and 60.
export function spanRange(from, to) {
  if (to < from) [from, to] = [to, from]
  const days = Math.round((hourMs(to) - hourMs(from)) / DAY_MS) + 1
  const unit = days <= 2 ? 'hour' : days <= 62 ? 'day' : days <= 182 ? 'week' : 'month'
  const range = { id: 'custom', unit, from, to, days }
  const count = spanBuckets(range).length
  const stride = unit === 'hour' ? 6 : [1, 2, 3, 5, 7, 10, 14].find(step => count / step <= 12) ?? Math.ceil(count / 12)
  return { ...range, count, stride }
}

// A picked span's buckets. The first and last week or month are cut to the span, so a
// bucket's `end` (exclusive) can fall before the calendar's.
function spanBuckets(range) {
  const first = hourMs(range.from)
  const end = hourMs(range.to) + DAY_MS
  const buckets = []
  if (range.unit === 'hour' || range.unit === 'day') {
    const step = range.unit === 'hour' ? HOUR_MS : DAY_MS
    for (let start = first; start < end; start += step) buckets.push({ start, end: start + step, key: range.unit === 'hour' ? hourKey(start) : dayKey(start) })
  } else if (range.unit === 'week') {
    for (let monday = mondayOf(first); monday < end; monday += 7 * DAY_MS) {
      buckets.push({ start: Math.max(monday, first), end: Math.min(monday + 7 * DAY_MS, end), key: dayKey(monday) })
    }
  } else {
    const year = new Date(first).getUTCFullYear()
    for (let month = new Date(first).getUTCMonth(); Date.UTC(year, month, 1) < end; month += 1) {
      const start = Date.UTC(year, month, 1)
      buckets.push({ start: Math.max(start, first), end: Math.min(Date.UTC(year, month + 1, 1), end), key: dayKey(start).slice(0, 7) })
    }
  }
  return buckets
}

// The range's buckets, oldest first, and the hour keys that bound it: `from` and `to`
// for the range itself, `before` for the same span just before it.
export function spanOf(range, now) {
  if (range.from) {
    return { buckets: spanBuckets(range), from: `${range.from} 00`, to: `${range.to} 23`, before: hourKey(hourMs(range.from) - range.days * DAY_MS) }
  }
  const buckets = bucketsOf(range, now)
  return { buckets: buckets.slice(range.count), from: hourKey(buckets[range.count].start), to: now, before: hourKey(buckets[0].start) }
}

// The range's buckets, oldest first, after as many before them for the comparison.
export function bucketsOf(range, now) {
  const end = hourMs(now)
  const today = end - (end % DAY_MS)
  const buckets = []
  for (let back = range.count * 2 - 1; back >= 0; back -= 1) {
    let start
    if (range.unit === 'hour') start = end - back * HOUR_MS
    else if (range.unit === 'day') start = today - back * DAY_MS
    else if (range.unit === 'week') start = mondayOf(today) - back * 7 * DAY_MS
    else start = Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth() - back, 1)
    buckets.push({ start, key: range.unit === 'hour' ? hourKey(start) : range.unit === 'month' ? dayKey(start).slice(0, 7) : dayKey(start) })
  }
  return buckets
}

export const tokensOf = row => row[4] + row[5] + row[6] + row[7]

// What a row cost under its model's price ({input, cachedInput, output} per million
// tokens), or undefined when the model has no price. Cache writes bill as input.
// ponytail: cache writes use the input price; add a cacheWrite price when a provider bills it apart.
export function costOf(row, price) {
  if (price === undefined) return undefined
  return ((row[4] + row[6]) * price.input + row[5] * price.cachedInput + row[7] * price.output) / 1e6
}
// `cost` sums the priced rows; `unpriced` counts tokens whose model has no price, so a
// sum with unpriced tokens never reads as complete.
const blank = () => ({ input: 0, cacheRead: 0, output: 0, calls: 0, total: 0, cost: 0, unpriced: 0 })
// Cache writes are billed as input, so they show as input.
function addRow(sum, row, price) {
  const cost = costOf(row, price)
  if (cost === undefined) sum.unpriced += tokensOf(row)
  else sum.cost += cost
  sum.input += row[4] + row[6]
  sum.cacheRead += row[5]
  sum.output += row[7]
  sum.calls += row[8]
  sum.total += tokensOf(row)
  return sum
}
function addTo(map, key, row, price) {
  map.set(key, addRow(map.get(key) ?? blank(), row, price))
}

// One range of the view, narrowed by `keep`. `seriesOf` names the stack a row joins in
// its bucket's bar. `previous` is the total of the same span just before the range.
export function summarize(view, range, keep = () => true, seriesOf = () => 'all') {
  const { buckets, from, to, before } = spanOf(range, view.now)
  const index = new Map(buckets.map((bucket, at) => [bucket.key, at]))
  const weeks = new Map()
  const keyOf = (hour) => {
    if (range.unit === 'hour') return hour
    if (range.unit === 'day') return hour.slice(0, 10)
    if (range.unit === 'month') return hour.slice(0, 7)
    const day = hour.slice(0, 10)
    let week = weeks.get(day)
    if (week === undefined) weeks.set(day, week = dayKey(mondayOf(hourMs(day))))
    return week
  }
  const current = buckets.map(bucket => ({ ...bucket, sum: blank(), stacks: new Map() }))
  const result = { buckets: current, total: blank(), previous: 0, owners: new Map(), models: new Map(), kinds: new Map(), rooms: new Map() }
  const priceOf = at => view.models?.[at]?.price
  for (const row of view.rows) {
    const hour = row[HOUR]
    if (hour < before || hour > to || !keep(row)) continue
    if (hour < from) {
      result.previous += tokensOf(row)
      continue
    }
    const at = index.get(keyOf(hour))
    if (at === undefined) continue
    const bucket = current[at]
    const price = priceOf(row[MODEL])
    addRow(bucket.sum, row, price)
    addRow(result.total, row, price)
    const series = seriesOf(row)
    bucket.stacks.set(series, (bucket.stacks.get(series) ?? 0) + tokensOf(row))
    addTo(result.owners, row[OWNER], row, price)
    addTo(result.models, row[MODEL], row, price)
    addTo(result.kinds, row[KIND], row, price)
    if ((row[ROOM] ?? -1) >= 0) addTo(result.rooms, row[ROOM], row, price)
  }
  return result
}

function trimmed(value) {
  const text = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}
// 999,999 reads 1M, not 1000K.
export function compact(count) {
  for (const [size, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (count >= size * 0.9995) return `${trimmed(count / size)}${unit}`
  }
  return String(Math.round(count))
}

export function percent(part, whole) {
  if (!(whole > 0) || !(part > 0)) return '0'
  const value = (part / whole) * 100
  return value < 1 ? '<1' : String(Math.round(value))
}

// Money for a sum: undefined when nothing in it is priced, so the page says "price not
// set" instead of a zero. `partial` is true when some of its tokens have no price.
export function moneyOf(sum) {
  if (sum.total > 0 && sum.unpriced >= sum.total) return undefined
  return { amount: sum.cost, partial: sum.unpriced > 0 }
}
