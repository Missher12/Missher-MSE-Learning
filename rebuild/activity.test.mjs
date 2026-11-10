import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { projectActivity, mondayForDay } from './activity.mjs'
import { buildEngine } from '../scripts/rsi/adaptive-engine-fixture.mjs'

const fixture = JSON.parse(readFileSync(new URL('../delivery/usability130/ROOT-ACTIVITY-CASES.json', import.meta.url)))

test('activity uses unique retained IDs, original creation days, and excludes imports and future records', () => {
  const view = projectActivity(fixture.entries, fixture.now, fixture.timezone)
  assert.equal(view.retained, fixture.expected.retained)
  assert.equal(view.imported, fixture.expected.imported)
  assert.equal(view.knownNew, fixture.expected.validNonFutureNewLearning)
  assert.equal(view.today.total, fixture.expected.todayNew)
  assert.equal(view.week.total, fixture.expected.weekNew)
  assert.equal(view.beforeWindow.total, fixture.expected.beforeYearWindowNew)
  assert.equal(view.futureExcluded, fixture.expected.futureExcludedFromHeatmap)
  assert.deepEqual(view.days.filter(day => day.total > 0).map(day => [day.date, day.total]),
    [['2026-02-28', 1], ['2026-03-01', 2]])
  assert.equal(view.days.find(day => day.date === '2026-02-28').lesson, 1)
  assert.equal(view.days.find(day => day.date === '2026-03-01').rule, 1)
  assert.equal(view.days.find(day => day.date === '2026-03-01').digest, 1)
})

test('activity deduplicates IDs and distinguishes unknown, imported, retired, and future entries', () => {
  const now = Date.parse('2026-01-01T04:00:00Z')
  const entries = [
    { id: 'same', type: 'rule', createdAt: Date.parse('2025-12-31T16:00:00Z'), importedFrom: null, status: 'retired' },
    { id: 'same', type: 'lesson', createdAt: now, importedFrom: null, status: 'active' },
    { id: 'bad-time', type: 'digest', createdAt: Number.NaN, importedFrom: null },
    { id: 'import', type: 'lesson', createdAt: now, importedFrom: {}, status: 'active' },
    { id: 'future', type: 'rule', createdAt: now + 1, importedFrom: null },
  ]
  const copy = structuredClone(entries)
  const view = projectActivity(entries, now, 'Asia/Shanghai')
  assert.equal(view.retained, 4)
  assert.equal(view.imported, 1)
  assert.equal(view.unknownCreatedAt, 1)
  assert.equal(view.futureExcluded, 1)
  assert.equal(view.knownNew, 1)
  assert.equal(view.today.rule, 1)
  assert.equal(view.today.total, view.today.rule + view.today.lesson + view.today.digest)
  assert.deepEqual(entries, copy, 'projection does not mutate persisted entries')
})

test('activity uses local calendar days across DST and a 365-day boundary', () => {
  const now = Date.parse('2026-03-08T16:00:00Z')
  const entries = [
    { id: 'before-dst', type: 'rule', createdAt: Date.parse('2025-03-09T05:00:00Z'), importedFrom: null },
    { id: 'dst-start', type: 'lesson', createdAt: Date.parse('2025-03-09T06:30:00Z'), importedFrom: null },
    { id: 'window-start', type: 'digest', createdAt: Date.parse('2025-03-09T07:00:00Z'), importedFrom: null },
  ]
  const view = projectActivity(entries, now, 'America/New_York')
  assert.equal(view.todayDate, '2026-03-08')
  assert.equal(view.days.length, 365)
  assert.equal(view.windowStart, '2025-03-09')
  assert.equal(view.days[0].date, '2025-03-09')
  assert.equal(view.days[0].total, 3)
  assert.equal(view.days[0].rule, 1)
  assert.equal(view.days[0].lesson, 1)
  assert.equal(view.days[0].digest, 1)
})

test('Monday week grouping crosses calendar years and empty history stays explicit', () => {
  assert.equal(mondayForDay('2026-01-01'), '2025-12-29')
  const empty = projectActivity([], Date.parse('2026-01-01T04:00:00Z'), 'Asia/Shanghai')
  assert.equal(empty.week.start, '2025-12-29')
  assert.equal(empty.week.total, 0)
  assert.equal(empty.knownNew, 0)
  assert.equal(empty.days.length, 365)
})

test('engine status adds only aggregate activity and leaves the memory document unchanged', () => {
  const { root, engine } = buildEngine()
  try {
    const before = engine.store.read()
    const activity = engine.statusView().activity
    const after = engine.store.read()
    assert.deepEqual(after, before)
    assert.equal(activity.retained, before.entries.length)
    assert.ok(!Object.hasOwn(activity, 'entries'))
    assert.ok(!JSON.stringify(activity).includes('instruction'))
    assert.ok(!JSON.stringify(activity).includes('originSession'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
