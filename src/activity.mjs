const DAY_MS = 86_400_000
const MAX_DAYS = 366
const MAX_ACTIVITY_EVENTS = 1_024
const LESSON_CAP = 300
const EXPERIMENT_CAP = 256
const EVENT_TYPES = Object.freeze(['created', 'validation', 'withdrawn', 'reactivated'])
const VALIDATION_DECISIONS = new Set(['accepted', 'rejected', 'inconclusive'])
const VALID_DECISIONS = new Set([...VALIDATION_DECISIONS, 'withdrawn', 'reactivated'])
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u
const SAFE_ID = /^[A-Za-z0-9_-]{1,96}$/u

function utcDate(year, month, day) {
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  return date
}

function parseDate(value) {
  if (typeof value !== 'string') return null
  const match = DATE_PATTERN.exec(value)
  if (match === null) return null
  const [, year, month, day] = match.map(Number)
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = utcDate(year, month, day)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date : null
}

function dateKey(date) {
  return date.toISOString().slice(0, 10)
}

function shiftDate(value, offset) {
  const date = parseDate(value)
  if (date === null) return null
  date.setUTCDate(date.getUTCDate() + offset)
  return dateKey(date)
}

function dateInZone(at, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(at))
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function countValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function weekStart(value) {
  const date = parseDate(value)
  if (date === null) return null
  const mondayOffset = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - mondayOffset)
  return dateKey(date)
}

function emptyCounts() {
  return Object.fromEntries([...EVENT_TYPES, 'all'].map(type => [type, null]))
}

/**
 * Read-only calendar over records that are still present in one scope.
 *
 * The returned counts describe retained records only. A null category means this snapshot has no
 * matching event for that period; it is deliberately not turned into a historical zero.
 */
export function projectActivity(state, { scopeHash, days = 90, timeZone = 'Asia/Shanghai', now = Date.now() } = {}) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.lessons)
    || !Array.isArray(state.experiments)) return { ok: false, code: 'activity_store_unavailable' }
  if (typeof scopeHash !== 'string' || !/^[a-f0-9]{64}$/u.test(scopeHash)) {
    return { ok: false, code: 'activity_scope_invalid' }
  }
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) {
    return { ok: false, code: 'activity_range_invalid' }
  }
  if (typeof timeZone !== 'string' || timeZone.length < 1 || timeZone.length > 64) {
    return { ok: false, code: 'activity_timezone_invalid' }
  }
  if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15) {
    return { ok: false, code: 'activity_clock_invalid' }
  }

  let formatter
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    formatter.format(new Date(now))
  } catch { return { ok: false, code: 'activity_timezone_invalid' } }

  const end = dateInZone(now, formatter)
  const start = shiftDate(end, -(days - 1))
  if (start === null || parseDate(end) === null) return { ok: false, code: 'activity_range_invalid' }

  const lessons = state.lessons.filter(row => row?.scope === scopeHash && typeof row.id === 'string')
  const lessonById = new Map(lessons.map(row => [row.id, row]))
  const allExperimentIds = new Set(state.experiments.filter(row => typeof row?.id === 'string').map(row => row.id))
  const seen = new Set()
  const explicitWithdrawals = new Map()
  const retained = []
  let invalidTimestamps = 0
  let outsideRange = 0

  const add = ({ id, lessonId, at, type, decision = null, lessonKind = null, attribution = null }) => {
    if (typeof id !== 'string' || !SAFE_ID.test(id) || seen.has(id)) return
    seen.add(id)
    const timestamp = countValue(at)
    if (timestamp === null || timestamp > now) { invalidTimestamps += 1; return }
    let day
    try { day = dateInZone(timestamp, formatter) } catch { invalidTimestamps += 1; return }
    if (day < start || day > end) { outsideRange += 1; return }
    retained.push({ id, lessonId, at: timestamp, day, type, decision,
      ...(attribution === null ? {} : { attribution }),
      lessonKind: lessonKind === 'correction' || lessonKind === 'method' ? lessonKind : null })
  }

  for (const lesson of lessons) {
    add({ id: `created_${lesson.id}`, lessonId: lesson.id, at: lesson.createdAt, type: 'created',
      lessonKind: lesson.kind })
  }

  for (const experiment of state.experiments) {
    const lesson = lessonById.get(experiment?.lessonId)
    const decision = experiment?.decision
    if (lesson === undefined || typeof experiment?.id !== 'string' || !VALID_DECISIONS.has(decision)) continue
    const type = VALIDATION_DECISIONS.has(decision) ? 'validation'
      : decision === 'withdrawn' ? 'withdrawn' : 'reactivated'
    if (decision === 'withdrawn' && SAFE_ID.test(experiment.id) && !seen.has(experiment.id)) {
      const at = countValue(experiment.at)
      if (at !== null && at <= now) {
        const key = `${lesson.id}\u0000${at}`
        const rows = explicitWithdrawals.get(key) ?? []
        const reason = Array.isArray(experiment.reasons) && experiment.reasons.length === 1
          && typeof experiment.reasons[0] === 'string' && experiment.reasons[0].length > 0
          && experiment.reasons[0].length <= 64 ? experiment.reasons[0] : null
        rows.push({ reason, productionShape: Number.isSafeInteger(experiment.version) && experiment.version > 0
          && reason !== null && Object.hasOwn(experiment, 'restored')
          && (experiment.restored === null || typeof experiment.restored === 'string') })
        explicitWithdrawals.set(key, rows)
      }
    }
    add({ id: experiment.id, lessonId: lesson.id, at: experiment.at, type, decision, lessonKind: lesson.kind })
  }

  for (const lesson of lessons) {
    const validation = lesson.validation
    // The validation pointer is an alias for its experiment. It can supply a retained verdict
    // only when the matching experiment has aged out of the bounded experiment ring.
    if (validation?.decision === 'accepted' && typeof validation.experimentId === 'string'
      && !allExperimentIds.has(validation.experimentId)) {
      add({ id: validation.experimentId, lessonId: lesson.id, at: validation.at, type: 'validation',
        decision: 'accepted', lessonKind: lesson.kind })
    }
    if (lesson.trial?.state === 'withdrawn') {
      const at = countValue(lesson.trial.at)
      if (at === null) invalidTimestamps += 1
      else {
        const sameTime = explicitWithdrawals.get(`${lesson.id}\u0000${at}`) ?? []
        const reason = typeof lesson.trial.reason === 'string' && lesson.trial.reason.length > 0
          && lesson.trial.reason.length <= 64
          ? lesson.trial.reason : null
        const trialShapeKnown = !Object.hasOwn(lesson.trial, 'epoch')
          && lesson.trial.note === 'reference_only_unverified'
          && typeof lesson.trial.planHash === 'string' && /^[a-f0-9]{64}$/u.test(lesson.trial.planHash)
        const sameOperation = reason !== null && trialShapeKnown && sameTime.length === 1
          && sameTime[0].productionShape && sameTime[0].reason === reason
        const attribution = sameTime.length === 0 ? null
          : sameOperation ? null
            : reason !== null && sameTime.every(row => row.reason !== null && row.reason !== reason)
              ? 'distinct_same_time' : 'uncertain'
        if (!sameOperation) add({ id: `trial_${lesson.id}_${at}`, lessonId: lesson.id, at, type: 'withdrawn',
          decision: 'trial_withdrawn', lessonKind: lesson.kind, attribution })
      }
    }
  }

  retained.sort((left, right) => right.at - left.at || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const eventsTruncated = retained.length > MAX_ACTIVITY_EVENTS
  const events = retained.slice(0, MAX_ACTIVITY_EVENTS)
  const daysByKey = new Map()
  for (const event of events) {
    let row = daysByKey.get(event.day)
    if (row === undefined) {
      row = { date: event.day, counts: emptyCounts() }
      daysByKey.set(event.day, row)
    }
    row.counts[event.type] = (row.counts[event.type] ?? 0) + 1
    row.counts.all = (row.counts.all ?? 0) + 1
  }

  const daily = []
  for (let offset = 0; offset < days; offset += 1) {
    const date = shiftDate(start, offset)
    const row = daysByKey.get(date)
    daily.push(row ?? { date, counts: emptyCounts() })
  }

  const weeklyByStart = new Map()
  for (const row of daily) {
    const week = weekStart(row.date)
    let group = weeklyByStart.get(week)
    if (group === undefined) {
      group = { weekStart: week, start: row.date, end: row.date, counts: emptyCounts() }
      weeklyByStart.set(week, group)
    }
    group.end = row.date
    for (const type of [...EVENT_TYPES, 'all']) {
      if (row.counts[type] !== null) group.counts[type] = (group.counts[type] ?? 0) + row.counts[type]
    }
  }
  const weekly = [...weeklyByStart.values()]
  const totals = emptyCounts()
  for (const row of daily) {
    for (const type of [...EVENT_TYPES, 'all']) {
      if (row.counts[type] !== null) totals[type] = (totals[type] ?? 0) + row.counts[type]
    }
  }
  const scopedExperimentCount = state.experiments.filter(row => lessonById.has(row?.lessonId)).length
  const incompleteHistoryRows = lessons.filter(row => row.historyComplete !== true).length

  return {
    ok: true,
    basis: 'retained_records',
    complete: false,
    range: { start, end, days, timeZone },
    daily,
    weekly,
    totals,
    events,
    recent: events.slice(0, 12),
    coverage: {
      complete: false,
      reason: 'retained_records_are_not_a_complete_daily_history',
      lessonRows: lessons.length,
      lessonRowsAtCapacity: lessons.length >= LESSON_CAP,
      rowsWithIncompleteEventHistory: incompleteHistoryRows,
      experimentRows: scopedExperimentCount,
      experimentRingAtCapacity: state.experiments.length >= EXPERIMENT_CAP,
      possibleExperimentTruncation: state.experiments.length >= EXPERIMENT_CAP,
      invalidTimestamps,
      eventsOutsideSelectedRange: outsideRange,
      eventsTruncated,
      eventLimit: MAX_ACTIVITY_EVENTS,
      included: EVENT_TYPES,
      unavailableSources: [{ source: 'adoptions', reason: 'no_event_time_with_session_scope_in_this_projection' }],
    },
  }
}
