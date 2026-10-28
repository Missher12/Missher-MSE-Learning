import test from 'node:test'
import assert from 'node:assert/strict'
import { projectActivity } from '../src/activity.mjs'

const DAY = 86_400_000
const SCOPE_A = 'a'.repeat(64)
const SCOPE_B = 'b'.repeat(64)
const at = (year, month, day, hour = 12) => Date.UTC(year, month - 1, day, hour)
const lesson = (id, scope = SCOPE_A, createdAt = at(2024, 1, 1), extra = {}) => ({
  id, scope, kind: 'correction', createdAt, historyComplete: false, ...extra,
})
const snapshot = (lessons = [], experiments = []) => ({ schema: 2, lessons, experiments })

test('deduplicates validation aliases, ignores orphan experiments, and keeps explicit activity kinds separate', () => {
  const rows = [
    lesson('lesson_a', SCOPE_A, at(2024, 1, 1), {
      validation: { decision: 'accepted', experimentId: 'experiment-one', at: at(2024, 1, 2) },
      trial: { state: 'withdrawn', at: at(2024, 1, 4) },
    }),
    lesson('lesson_b', SCOPE_A, at(2024, 1, 3), {
      validation: { decision: 'accepted', experimentId: 'aged-experiment', at: at(2024, 1, 5) },
    }),
    lesson('lesson_c', SCOPE_A, at(2024, 1, 6), {
      trial: { state: 'withdrawn', at: at(2024, 1, 7), reason: 'trial_withdrawn',
        planHash: 'c'.repeat(64), note: 'reference_only_unverified' },
    }),
    lesson('lesson_other_scope', SCOPE_B, at(2024, 1, 1)),
  ]
  const duplicateWithdrawal = { id: 'experiment-four', lessonId: 'lesson_c', version: 2,
    at: at(2024, 1, 7), decision: 'withdrawn', reasons: ['trial_withdrawn'], restored: null }
  const experiments = [
    { id: 'experiment-one', lessonId: 'lesson_a', at: at(2024, 1, 2), decision: 'accepted' },
    { id: 'experiment-two', lessonId: 'lesson_a', at: at(2024, 1, 3), decision: 'withdrawn' },
    { id: 'experiment-three', lessonId: 'lesson_a', at: at(2024, 1, 6), decision: 'reactivated' },
    duplicateWithdrawal,
    { ...duplicateWithdrawal },
    { id: 'orphan-experiment', lessonId: 'not-retained', at: at(2024, 1, 3), decision: 'accepted' },
    { id: 'other-scope-experiment', lessonId: 'lesson_other_scope', at: at(2024, 1, 3), decision: 'accepted' },
  ]
  const result = projectActivity(snapshot(rows, experiments), { scopeHash: SCOPE_A, days: 60,
    timeZone: 'UTC', now: at(2024, 2, 1) })
  assert.equal(result.ok, true)
  assert.equal(result.basis, 'retained_records')
  assert.equal(result.complete, false)
  assert.equal(result.totals.created, 3)
  assert.equal(result.totals.validation, 2, 'the stored experiment and its validation pointer count once')
  assert.equal(result.totals.withdrawn, 3,
    'a trial-only withdrawal counts, but its matching experiment is not counted twice')
  assert.equal(result.totals.reactivated, 1)
  assert.equal(result.totals.all, 9)
  assert.equal(result.events.filter(row => row.id === 'experiment-one').length, 1)
  assert.equal(result.events.some(row => row.lessonId === 'lesson_other_scope'), false)
  assert.equal(result.events.some(row => row.id === 'orphan-experiment'), false)
  assert.equal(result.events.some(row => row.id === 'aged-experiment'), true,
    'a retained validation pointer can stand in for an experiment aged out of the ring')
  assert.equal(result.events.some(row => row.id === `trial_lesson_a_${at(2024, 1, 4)}`), true,
    'a trial withdrawal without an explicit experiment remains visible')
  assert.equal(result.events.filter(row => row.id === duplicateWithdrawal.id).length, 1,
    'the duplicated withdrawal experiment identity is retained once')
  assert.equal(result.events.some(row => row.id === `trial_lesson_c_${at(2024, 1, 7)}`), false,
    'the same experiment and its trial alias are not counted as separate withdrawals')
  assert.equal(result.events.filter(row => row.lessonId === 'lesson_c' && row.type === 'withdrawn').length, 1,
    'a repeated experiment identity and its trial alias are represented once')
})

test('uses the requested time zone for leap day and crosses the year boundary by local date', () => {
  const now = Date.UTC(2024, 2, 1, 8, 30)
  const result = projectActivity(snapshot([
    lesson('lesson-leap', SCOPE_A, Date.UTC(2024, 2, 1, 7, 30)),
    lesson('lesson-year', SCOPE_A, Date.UTC(2023, 11, 31, 8, 30)),
  ]), { scopeHash: SCOPE_A, days: 3, timeZone: 'America/Los_Angeles', now })
  assert.equal(result.ok, true)
  assert.equal(result.range.end, '2024-03-01')
  assert.deepEqual(result.daily.map(row => row.date), ['2024-02-28', '2024-02-29', '2024-03-01'])
  assert.equal(result.daily.find(row => row.date === '2024-02-29').counts.created, 1)
  assert.equal(result.daily.find(row => row.date === '2023-12-31'), undefined)
  assert.equal(result.coverage.eventsOutsideSelectedRange, 1)
})

test('rejects invalid time zones and ranges while reporting malformed or future event times', () => {
  assert.deepEqual(projectActivity(snapshot(), { scopeHash: SCOPE_A, days: 367, timeZone: 'UTC', now: at(2024, 1, 1) }),
    { ok: false, code: 'activity_range_invalid' })
  assert.deepEqual(projectActivity(snapshot(), { scopeHash: SCOPE_A, days: 1, timeZone: 'Mars/Olympus', now: at(2024, 1, 1) }),
    { ok: false, code: 'activity_timezone_invalid' })
  const result = projectActivity(snapshot([
    lesson('lesson-invalid', SCOPE_A, 'not-a-timestamp'),
    lesson('lesson-future', SCOPE_A, at(2024, 1, 2)),
  ]), { scopeHash: SCOPE_A, days: 1, timeZone: 'UTC', now: at(2024, 1, 1) })
  assert.equal(result.ok, true)
  assert.equal(result.coverage.invalidTimestamps, 2)
  assert.equal(result.totals.created, null, 'a missing category is not manufactured as zero')
  assert.equal(result.daily[0].counts.created, null)
})

test('daily, weekly and selected-range totals use the same deduplicated event set', () => {
  const rows = [
    lesson('lesson-jan1', SCOPE_A, at(2024, 1, 1)),
    lesson('lesson-jan4', SCOPE_A, at(2024, 1, 4)),
    lesson('lesson-jan9', SCOPE_A, at(2024, 1, 9)),
  ]
  const experiments = [
    { id: 'validation-jan4', lessonId: 'lesson-jan4', at: at(2024, 1, 4, 13), decision: 'rejected' },
    { id: 'withdraw-jan9', lessonId: 'lesson-jan9', at: at(2024, 1, 9, 13), decision: 'withdrawn' },
  ]
  const result = projectActivity(snapshot(rows, experiments), { scopeHash: SCOPE_A, days: 10,
    timeZone: 'UTC', now: at(2024, 1, 10) })
  assert.equal(result.ok, true)
  assert.equal(result.daily.length, 10)
  assert.equal(result.weekly.length, 2)
  for (const type of ['created', 'validation', 'withdrawn', 'reactivated', 'all']) {
    const daily = result.daily.reduce((sum, row) => sum + (row.counts[type] ?? 0), 0)
    const weekly = result.weekly.reduce((sum, row) => sum + (row.counts[type] ?? 0), 0)
    assert.equal(daily, result.totals[type] ?? 0, `${type} daily sum matches the range total`)
    assert.equal(weekly, result.totals[type] ?? 0, `${type} weekly sum matches the range total`)
  }
  assert.equal(result.daily.find(row => row.date === '2024-01-02').counts.validation, null)
  assert.equal(result.totals.created, 3)
  assert.equal(result.totals.validation, 1)
  assert.equal(result.totals.withdrawn, 1)
  assert.equal(result.events.length, 5)
  assert.equal(DAY, 86_400_000)
})

test('keeps distinct same-day experiments of one version and removes only duplicate event identities', () => {
  const timestamp = at(2024, 1, 5)
  const row = lesson('lesson-same-version', SCOPE_A, at(2024, 1, 1))
  const first = { id: 'experiment-first', lessonId: row.id, version: 2, at: timestamp, decision: 'accepted' }
  const result = projectActivity(snapshot([row], [first, { ...first },
    { id: 'experiment-second', lessonId: row.id, version: 2, at: timestamp, decision: 'rejected' }]), {
    scopeHash: SCOPE_A, days: 10, timeZone: 'UTC', now: at(2024, 1, 10),
  })
  assert.equal(result.ok, true)
  assert.equal(result.totals.validation, 2, 'two experiment IDs count even on the same day and version')
  assert.equal(result.events.filter(event => event.id === first.id).length, 1, 'a repeated entity identity counts once')
  assert.equal(result.daily.find(day => day.date === '2024-01-05').counts.validation, 2)
})

test('matches a dual-record withdrawal by production reason and structure, not timestamp alone', () => {
  const timestamp = at(2024, 1, 5)
  const same = lesson('lesson-same-operation', SCOPE_A, at(2024, 1, 1), {
    trial: { state: 'withdrawn', at: timestamp, reason: 'manual', planHash: 'a'.repeat(64),
      note: 'reference_only_unverified' },
  })
  const distinct = lesson('lesson-distinct-operation', SCOPE_A, at(2024, 1, 1), {
    trial: { state: 'withdrawn', at: timestamp, reason: 'task_checker_failure', planHash: 'b'.repeat(64),
      note: 'reference_only_unverified' },
  })
  const uncertain = lesson('lesson-uncertain-operation', SCOPE_A, at(2024, 1, 1), {
    trial: { state: 'withdrawn', at: timestamp, reason: 'manual', planHash: 'plan-unknown' },
  })
  const independent = lesson('lesson-independent-same-reason', SCOPE_A, at(2024, 1, 1), {
    trial: { state: 'withdrawn', at: timestamp, reason: 'manual', planHash: 'c'.repeat(64),
      note: 'reference_only_unverified', epoch: 4 },
  })
  const multiple = lesson('lesson-multiple-experiments', SCOPE_A, at(2024, 1, 1), {
    trial: { state: 'withdrawn', at: timestamp, reason: 'manual', planHash: 'd'.repeat(64),
      note: 'reference_only_unverified' },
  })
  const result = projectActivity(snapshot([same, distinct, uncertain, independent, multiple], [
    { id: 'experiment-same', lessonId: same.id, version: 2, at: timestamp,
      decision: 'withdrawn', reasons: ['manual'], restored: null },
    { id: 'experiment-distinct', lessonId: distinct.id, version: 2, at: timestamp,
      decision: 'withdrawn', reasons: ['manual'], restored: null },
    { id: 'experiment-uncertain', lessonId: uncertain.id, version: 2, at: timestamp,
      decision: 'withdrawn', reasons: ['manual'], restored: null },
    { id: 'experiment-independent', lessonId: independent.id, version: 2, at: timestamp,
      decision: 'withdrawn', reasons: ['manual'], restored: null },
    { id: 'experiment-multiple-first', lessonId: multiple.id, version: 2, at: timestamp,
      decision: 'withdrawn', reasons: ['manual'], restored: null },
    { id: 'experiment-multiple-second', lessonId: multiple.id, version: 2, at: timestamp,
      decision: 'withdrawn', reasons: ['manual'], restored: null },
  ]), { scopeHash: SCOPE_A, days: 10, timeZone: 'UTC', now: at(2024, 1, 10) })
  assert.equal(result.ok, true)
  assert.equal(result.totals.withdrawn, 10)
  assert.equal(result.events.filter(event => event.lessonId === same.id && event.type === 'withdrawn').length, 1,
    'matching production reason, record shape and time identify one operation')
  assert.equal(result.events.find(event => event.id === `trial_${distinct.id}_${timestamp}`).attribution,
    'distinct_same_time', 'different reasons at the same millisecond remain separate')
  assert.equal(result.events.find(event => event.id === `trial_${uncertain.id}_${timestamp}`).attribution,
    'uncertain', 'matching timestamps and reasons do not deduplicate a trial without its production shape')
  assert.equal(result.events.filter(event => event.lessonId === independent.id && event.type === 'withdrawn').length, 2,
    'an epoch marks a separate same-reason closure even when the production alias shape otherwise matches')
  assert.equal(result.events.find(event => event.id === `trial_${independent.id}_${timestamp}`).attribution,
    'uncertain', 'same-reason independent closures are retained without claiming a proven relationship')
  assert.equal(result.events.filter(event => event.lessonId === multiple.id
    && event.id.startsWith('experiment-multiple-')).length, 2,
  'two different retained experiment IDs at the same millisecond remain separate')
  assert.equal(result.events.find(event => event.id === `trial_${multiple.id}_${timestamp}`).attribution,
    'uncertain', 'a trial is not merged when multiple distinct experiments share its timestamp')
})

test('uses Asia/Shanghai calendar dates across its local midnight', () => {
  const beforeMidnight = Date.UTC(2024, 0, 1, 15, 59)
  const afterMidnight = Date.UTC(2024, 0, 1, 16, 0)
  const result = projectActivity(snapshot([
    lesson('lesson-before-sh-midnight', SCOPE_A, beforeMidnight),
    lesson('lesson-after-sh-midnight', SCOPE_A, afterMidnight),
  ]), { scopeHash: SCOPE_A, days: 2, timeZone: 'Asia/Shanghai', now: afterMidnight })
  assert.equal(result.ok, true)
  assert.deepEqual(result.daily.map(day => day.date), ['2024-01-01', '2024-01-02'])
  assert.equal(result.daily[0].counts.created, 1)
  assert.equal(result.daily[1].counts.created, 1)
})

test('the projection leaves its input snapshot untouched and caps the requested window at 366 days', () => {
  const state = snapshot([lesson('lesson-immutable', SCOPE_A, at(2024, 1, 1))])
  const frozenLesson = Object.freeze(state.lessons[0])
  state.lessons[0] = frozenLesson
  Object.freeze(state.lessons)
  Object.freeze(state.experiments)
  Object.freeze(state)
  const result = projectActivity(state, { scopeHash: SCOPE_A, days: 366, timeZone: 'UTC', now: at(2024, 12, 31) })
  assert.equal(result.ok, true)
  assert.equal(result.daily.length, 366)
  assert.equal(result.range.days, 366)
})
