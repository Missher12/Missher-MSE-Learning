const DAY_MS = 86_400_000
const TYPES = ['rule', 'lesson', 'digest']

function calendarDay(value, formatter) {
  if (!Number.isFinite(value) || Math.abs(value) > 8.64e15) return null
  try {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(value))
      .filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
    const year = Number(parts.year)
    const month = Number(parts.month)
    const day = Number(parts.day)
    if (!Number.isInteger(year) || year < 1 || year > 9999
      || !Number.isInteger(month) || !Number.isInteger(day)) return null
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  } catch { return null }
}

function civilDate(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day)
  if (match === null) throw new TypeError('invalid_day')
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

function dateKey(value) {
  const date = new Date(value)
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function plusDays(day, amount) { return dateKey(civilDate(day) + amount * DAY_MS) }

export function mondayForDay(day) {
  const weekday = new Date(civilDate(day)).getUTCDay()
  return plusDays(day, -((weekday + 6) % 7))
}

const emptyCounts = () => ({ total: 0, rule: 0, lesson: 0, digest: 0 })
function addRecord(counts, row) {
  counts.total += 1
  counts[row.type] += 1
}

/** Read-only, identity-deduplicated activity derived from the entries retained today. */
export function projectActivity(entries, now = Date.now(), timeZone = undefined) {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, calendar: 'gregory',
    numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' })
  const todayDate = calendarDay(now, formatter)
  if (todayDate === null) throw new TypeError('invalid_now')
  const windowStart = plusDays(todayDate, -364)
  const retainedIds = new Set()
  const dated = []
  let retained = 0
  let imported = 0
  let unknownCreatedAt = 0
  let futureExcluded = 0

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string'
      || entry.id === '' || retainedIds.has(entry.id)) continue
    retainedIds.add(entry.id)
    retained += 1
    const isImported = entry.importedFrom !== null && entry.importedFrom !== undefined
    if (isImported) imported += 1
    const day = calendarDay(entry.createdAt, formatter)
    if (day === null) {
      unknownCreatedAt += 1
      continue
    }
    if (entry.createdAt > now || day > todayDate) {
      if (!isImported) futureExcluded += 1
      continue
    }
    if (isImported || !TYPES.includes(entry.type)) continue
    dated.push({ date: day, type: entry.type })
  }

  const byDate = new Map()
  for (let offset = 0; offset < 365; offset += 1) {
    const date = plusDays(windowStart, offset)
    byDate.set(date, { date, ...emptyCounts() })
  }
  const beforeWindow = emptyCounts()
  const weekStart = mondayForDay(todayDate)
  const weeksByStart = new Map([[weekStart, { start: weekStart, end: todayDate, ...emptyCounts() }]])
  const knownTypes = { rule: 0, lesson: 0, digest: 0 }
  for (const row of dated) {
    knownTypes[row.type] += 1
    if (row.date < windowStart) addRecord(beforeWindow, row)
    else {
      const daily = byDate.get(row.date)
      if (daily !== undefined) addRecord(daily, row)
    }
    const start = mondayForDay(row.date)
    const weekRow = weeksByStart.get(start) ?? { start, end: plusDays(start, 6), ...emptyCounts() }
    addRecord(weekRow, row)
    weeksByStart.set(start, weekRow)
  }
  const week = weeksByStart.get(weekStart)
  week.end = todayDate
  const days = [...byDate.values()]
  const today = { ...emptyCounts(), date: todayDate, ...byDate.get(todayDate) }
  const firstMonday = mondayForDay(windowStart)
  const weeks = []
  for (let start = firstMonday; start <= todayDate; start = plusDays(start, 7)) {
    const cells = Array.from({ length: 7 }, (_, weekday) => {
      const date = plusDays(start, weekday)
      return date < windowStart || date > todayDate ? null : byDate.get(date)
    })
    weeks.push({ start, days: cells })
  }

  return { timeZone: zone, todayDate, windowStart, retained, imported, unknownCreatedAt,
    futureExcluded, knownNew: Object.values(knownTypes).reduce((sum, count) => sum + count, 0),
    knownTypes, beforeWindow, today, week, weekSummaries: [...weeksByStart.values()], days, weeks }
}
