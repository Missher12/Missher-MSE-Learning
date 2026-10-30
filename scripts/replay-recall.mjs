#!/usr/bin/env node
/**
 * Developer-only OFFLINE recall replay (EVOLUTION016). NOT part of the runtime package and never
 * registered on any background slot. It reads a frozen case file, calls the pure recall module,
 * and prints a per-case report.
 *
 * It does NOT read or write the learning library, does NOT call a model, does NOT change the
 * default ranking and never promotes an experience. A critical regression (a labelled relevant
 * entry missing, or a labelled excluded entry offered) makes the process exit 1; byte totals are
 * reported separately and can never offset that.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recallSelection, packRecall, replayRecall } from '../rebuild/recall.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const parseArgs = argv => {
  const args = {}
  for (const raw of argv) {
    const match = /^--([a-z-]+)=(.*)$/u.exec(raw)
    if (match !== null) { args[match[1]] = match[2]; continue }
    if (raw.startsWith('--')) args[raw.slice(2)] = true
  }
  return args
}
const args = parseArgs(process.argv.slice(2))
const fixturePath = args.cases === undefined || args.cases === true
  ? join(here, '..', 'tests', 'fixtures', 'recall-cases.json')
  : resolve(String(args.cases))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const cases = Array.isArray(fixture) ? fixture : (fixture.cases ?? [])

const baseline = (entries, ctx) => recallSelection(entries, ctx)
// The deliberate WRONG candidate used by the regression check: oldest rule first, ignoring the
// relevance tier (a plausible "unrelated rule first" bug). It must be caught by labelled cases.
const unrelatedFirst = (entries, ctx) => {
  const candidates = (entries ?? []).filter(entry => entry.status !== 'retired'
    && (entry.visibility === 'global'
      || (entry.originScope === ctx.scope && entry.originEnvironment === ctx.environment)))
  const ranked = candidates.map(entry => ({ entry }))
    .sort((left, right) => left.entry.updatedAt - right.entry.updatedAt)
  return packRecall(ranked, ctx)
}
const rankerName = typeof args.ranker === 'string' ? args.ranker : 'baseline'
const ranker = rankerName === 'baseline' ? baseline
  : rankerName === 'irrelevant-first' ? unrelatedFirst
    : null
if (ranker === null) {
  console.error(`unknown --ranker=${rankerName} (baseline|irrelevant-first)`)
  process.exit(2)
}
const report = replayRecall(cases, ranker)
console.log(JSON.stringify({ ranker: rankerName, fixture: fixturePath, modelCalls: 0,
  liveStoreReads: 0, liveStoreWrites: 0, ...report }, null, 2))
if (report.criticalRegressions > 0) process.exitCode = 1
