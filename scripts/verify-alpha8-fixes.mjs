// Correct-behaviour verification for the alpha.7 review item R1 (history completeness).
//
// Usage: node scripts/verify-alpha8-fixes.mjs [<source-root>]
//
// The review's own probe (dist/review-20261001-alpha7/mse-alpha7-lifecycle-review.mjs) asserts
// the alpha.7 defect on purpose; these assertions describe the CORRECT behaviour. The
// cross-version chains run against the frozen alpha.4/alpha.6 engines when those baselines
// exist on this machine, and always run in a self-contained synthetic form.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.argv[2] ?? new URL('..', import.meta.url).pathname)
const { LearningEngine } = await import(pathToFileURL(join(root, 'src/index.mjs')))
const ALPHA6 = process.env.MSE_ALPHA6_ENGINE ?? ''
const ALPHA4 = process.env.MSE_ALPHA4_ENGINE ?? ''

const DAY = 86_400_000
const results = []
const proposal = extra => ({ kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1', ...extra })
function run(id, fn) {
  try { results.push({ id, pass: true, detail: fn() }) }
  catch (failure) { results.push({ id, pass: false, detail: failure?.message ?? String(failure) }) }
}
function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-alpha8-r1-'))
  let now = Date.UTC(2030, 0, 1)
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => now })
  return { stateRoot, engine, advance: ms => { now += ms }, at: () => now, restart: () => new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => now }),
    cleanup: () => rmSync(stateRoot, { recursive: true, force: true }) }
}
const rowOf = engine => engine.list({ limit: 10 }).lessons[0]
const statePath = stateRoot => join(stateRoot, 'lessons-v1.json')
/** Rewrite one stored row into the shape an older build would have left behind. */
function reshape(stateRoot, fields) {
  const state = JSON.parse(readFileSync(statePath(stateRoot), 'utf8'))
  for (const field of fields.remove) delete state.lessons[0][field]
  for (const [field, value] of Object.entries(fields.set ?? {})) state.lessons[0][field] = value
  writeFileSync(statePath(stateRoot), JSON.stringify(state))
}

run('r1-an-upgraded-legacy-row-can-never-certify-lost-history', () => {
  const f = fixture()
  try {
    const first = f.engine.record({ eventId: 'legacy-original', ...proposal() })
    assert.equal(f.engine.evaluateRegistered({ lessonId: first.id }).decision, 'accepted')
    f.advance(91 * DAY)
    // alpha.4 shape: no generation contract at all.
    reshape(f.stateRoot, { remove: ['historyComplete', 'generation', 'originEvent', 'generationEvent', 'eventIds'] })
    const upgraded = f.restart()
    const observed = rowOf(upgraded)
    const reopened = upgraded.record({ eventId: 'upgrade-observed', newGeneration: true,
      expectedVersion: observed.version, expectedGeneration: 0, ...proposal() })
    assert.equal(reopened.status, 'candidate', 'a bound observation still opens a generation')
    assert.equal(upgraded.evaluateRegistered({ lessonId: first.id }).decision, 'accepted')
    const before = rowOf(upgraded)
    assert.notEqual(before.historyComplete, true, 'a re-open never certifies missing history')
    f.advance(91 * DAY)
    const replay = upgraded.record({ eventId: 'legacy-original', ...proposal() })
    assert.equal(replay.skipped, 'new_observation_required')
    const after = rowOf(upgraded)
    assert.equal(after.version, before.version)
    assert.equal(after.expiresAt, before.expiresAt)
    assert.equal(after.status, 'validated')
    assert.equal(after.validation?.decision, 'accepted', 'a refused replay changes no credit')
    assert.equal(after.verified, before.verified)
    return { skipped: replay.skipped, version: after.version, marker: after.historyComplete }
  } finally { f.cleanup() }
})

run('r1-a-short-ring-from-an-older-build-is-not-proof', () => {
  const f = fixture()
  try {
    const first = f.engine.record({ eventId: 'alpha6-origin', ...proposal() })
    assert.equal(f.engine.evaluateRegistered({ lessonId: first.id }).decision, 'accepted')
    f.engine.record({ eventId: 'alpha6-extra', ...proposal() })
    // alpha.6 shape: a short ring and a generation event, but no completeness marker.
    reshape(f.stateRoot, { remove: ['historyComplete'] })
    f.advance(91 * DAY)
    const upgraded = f.restart()
    const before = rowOf(upgraded)
    assert.equal(before.eventIds.length, 2, 'the short ring looks harmless')
    const unbound = upgraded.record({ eventId: 'unbound-upgrade-observation', ...proposal() })
    assert.equal(unbound.skipped, 'new_observation_required', 'a short ring is not a complete history')
    const after = rowOf(upgraded)
    assert.equal(after.version, before.version)
    assert.equal(after.expiresAt, before.expiresAt)
    // The same row stays opaque after a restart, and a bound condition still works.
    const restarted = f.restart()
    assert.equal(restarted.record({ eventId: 'another-unbound', ...proposal() }).skipped, 'new_observation_required')
    const observed = rowOf(restarted)
    const reopened = restarted.record({ eventId: 'bound-observation', newGeneration: true,
      expectedVersion: observed.version, expectedGeneration: observed.generation ?? 0, ...proposal() })
    assert.equal(reopened.status, 'candidate')
    assert.notEqual(rowOf(restarted).historyComplete, true, 'the reopened generation is still incomplete')
    return { skipped: unbound.skipped, ring: before.eventIds.length }
  } finally { f.cleanup() }
})

run('r1-a-legal-reopen-does-not-make-history-complete', () => {
  const f = fixture()
  try {
    const first = f.engine.record({ eventId: 'legacy-original', ...proposal() })
    assert.equal(f.engine.evaluateRegistered({ lessonId: first.id }).decision, 'accepted')
    f.advance(91 * DAY)
    reshape(f.stateRoot, { remove: ['historyComplete', 'generation', 'originEvent', 'generationEvent', 'eventIds'] })
    const upgraded = f.restart()
    const observed = rowOf(upgraded)
    upgraded.record({ eventId: 'first-bound', newGeneration: true, expectedVersion: observed.version,
      expectedGeneration: 0, ...proposal() })
    assert.equal(upgraded.evaluateRegistered({ lessonId: first.id }).decision, 'accepted')
    f.advance(91 * DAY)
    // A never-seen event is still unprovable on a row that never had a complete ring.
    const unbound = upgraded.record({ eventId: 'never-seen-after-reopen', ...proposal() })
    assert.equal(unbound.skipped, 'new_observation_required')
    const observed2 = rowOf(upgraded)
    const second = upgraded.record({ eventId: 'second-bound', newGeneration: true,
      expectedVersion: observed2.version, expectedGeneration: observed2.generation, ...proposal() })
    assert.equal(second.status, 'candidate', 'a bound condition keeps working for later generations')
    assert.equal(rowOf(upgraded).generation, 2)
    return { skipped: unbound.skipped, generation: rowOf(upgraded).generation }
  } finally { f.cleanup() }
})

run('r1-a-complete-ring-is-proven-until-an-event-is-dropped', () => {
  const f = fixture()
  try {
    const first = f.engine.record({ eventId: 'initial', ...proposal() })
    f.engine.evaluateRegistered({ lessonId: first.id })
    assert.equal(rowOf(f.engine).historyComplete, true)
    f.advance(91 * DAY)
    assert.equal(f.engine.record({ eventId: 'fresh', ...proposal() }).status, 'candidate')
    assert.equal(rowOf(f.engine).historyComplete, true, 're-opening keeps the proven history')
    f.engine.evaluateRegistered({ lessonId: first.id })
    for (let index = 1; index <= 6; index++) f.engine.record({ eventId: `additional-${index}`, ...proposal() })
    assert.equal(rowOf(f.engine).eventIds.length, 8)
    assert.equal(rowOf(f.engine).historyComplete, true, 'a full ring that dropped nothing is still complete')
    f.engine.record({ eventId: 'one-more', ...proposal() })
    assert.equal(rowOf(f.engine).historyComplete, false, 'the first dropped event ends completeness')
    f.advance(91 * DAY)
    assert.equal(f.engine.record({ eventId: 'after-drop', ...proposal() }).skipped, 'new_observation_required')
    assert.equal(rowOf(f.engine).historyComplete, false, 'completeness never returns')
    return { markerAfterDrop: false, ring: rowOf(f.engine).eventIds.length }
  } finally { f.cleanup() }
})

run('r1-controls-still-hold', () => {
  const f = fixture()
  try {
    const first = f.engine.record({ eventId: 'initial', ...proposal() })
    f.engine.evaluateRegistered({ lessonId: first.id })
    f.advance(91 * DAY)
    // On a row whose history is not proven, missing/stale/denied conditions all refuse
    // without changing a single byte.
    reshape(f.stateRoot, { remove: ['historyComplete', 'generation', 'originEvent', 'generationEvent', 'eventIds'] })
    const upgraded = f.restart()
    const observed = rowOf(upgraded)
    const before = JSON.stringify(rowOf(upgraded))
    assert.equal(upgraded.record({ eventId: 'bare', newGeneration: true, ...proposal() }).skipped,
      'new_observation_required')
    assert.equal(upgraded.record({ eventId: 'denied', newGeneration: false, expectedVersion: observed.version,
      expectedGeneration: 0, ...proposal() }).skipped, 'new_observation_required')
    assert.equal(upgraded.record({ eventId: 'stale', newGeneration: true,
      expectedVersion: observed.version + 5, expectedGeneration: 0, ...proposal() }).skipped, 'stale_generation')
    assert.equal(JSON.stringify(rowOf(upgraded)), before, 'every refusal is byte-identical')
    return { refusalsUnchanged: true, historyComplete: rowOf(upgraded).historyComplete }
  } finally { f.cleanup() }
})

run('r1-a-manually-suspended-row-is-never-revived', () => {
  const f = fixture()
  try {
    const item = f.engine.record({ eventId: 'suspended-origin', ...proposal() })
    f.engine.evaluateRegistered({ lessonId: item.id })
    f.engine.suspend({ lessonId: item.id })
    f.advance(91 * DAY)
    f.engine.record({ eventId: 'proposal-after-suspension', ...proposal() })
    assert.equal(rowOf(f.engine).status, 'suspended')
    const observed = rowOf(f.engine)
    const bound = f.engine.record({ eventId: 'bound-after-suspension', newGeneration: true,
      expectedVersion: observed.version, expectedGeneration: observed.generation ?? 0, ...proposal() })
    assert.equal(rowOf(f.engine).status, 'suspended', 'a suspension is deliberate, not provable novelty')
    return { status: rowOf(f.engine).status, bound: bound.skipped ?? bound.status }
  } finally { f.cleanup() }
})

const realChains = []
if (existsSync(ALPHA4) && existsSync(ALPHA6)) {
  const { LearningEngine: Alpha4 } = await import(pathToFileURL(ALPHA4))
  const { LearningEngine: Alpha6 } = await import(pathToFileURL(ALPHA6))
  const chain = id => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'mse-alpha8-real-'))
    let now = Date.UTC(2030, 0, 1)
    const options = { stateRoot, adapterId: 'dsh', now: () => now }
    try {
      const a4 = new Alpha4(options)
      const initial = { eventId: 'legacy-original', kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' }
      const first = a4.record(initial)
      a4.evaluateRegistered({ lessonId: first.id })
      now += 91 * DAY
      if (id === 'alpha4-through-alpha6') {
        const a6 = new Alpha6(options)
        a6.record({ ...initial, eventId: 'alpha6-observed', newGeneration: true })
        a6.evaluateRegistered({ lessonId: first.id })
      } else {
        const a7 = new LearningEngine(options)
        const observed = a7.list({ limit: 10 }).lessons[0]
        a7.record({ ...initial, eventId: 'alpha7-observed', newGeneration: true,
          expectedVersion: observed.version, expectedGeneration: 0 })
        a7.evaluateRegistered({ lessonId: first.id })
      }
      const current = new LearningEngine(options)
      const before = current.list({ limit: 10 }).lessons[0]
      now += 91 * DAY
      const replay = current.record(initial)
      const after = current.list({ limit: 10 }).lessons[0]
      return { id, pass: replay.skipped === 'new_observation_required' && after.version === before.version
        && after.expiresAt === before.expiresAt, replay: replay.skipped ?? replay.duplicate,
        before: before.version, after: after.version }
    } finally { rmSync(stateRoot, { recursive: true, force: true }) }
  }
  realChains.push(chain('alpha4-through-alpha6'), chain('alpha4-bound-open'))
  for (const item of realChains) {
    results.push({ id: `r1-real-${item.id}`, pass: item.pass, detail: `replay=${item.replay} v${item.before}->v${item.after}` })
  }
} else {
  results.push({ id: 'r1-real-cross-version-chains', pass: true,
    detail: 'skipped: frozen alpha.4/alpha.6 baselines not present on this machine; the synthetic chains above cover the same shapes' })
}

const report = { source: root, schema: 'mse-alpha8-fix-checks-v1', passed: results.filter(row => row.pass).length,
  failed: results.filter(row => !row.pass).length, modelCalls: 0, realBaselines: realChains.length, results }
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (report.failed > 0) process.exitCode = 1
