// One-off fixture generator: freeze real older-version learning stores for upgrade tests.
//
// Usage:
//   node scripts/make-legacy-fixtures.mjs <alpha2-src-dir> <daily-0.8-src-dir> <fixtures-root>
//
// Both inputs are read-only. The generated directories are small JSON stores produced by the
// real older engines, so `tests/upgrade.test.mjs` exercises the shapes that shipped rather than
// a hand-written approximation. Re-running overwrites the fixtures deliberately.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'

const [alpha2Path, dailyPath, fixturesRoot] = process.argv.slice(2).map(value => resolve(value))
if (!alpha2Path || !dailyPath || !fixturesRoot) {
  throw new Error('usage: node scripts/make-legacy-fixtures.mjs <alpha2-src-dir> <daily-0.8-src-dir> <fixtures-root>')
}
const load = dir => import(pathToFileURL(join(dir, 'src/index.mjs')))
const copyStore = (from, to) => {
  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  cpSync(join(from, 'lessons-v1.json'), join(to, 'lessons-v1.json'))
  if (existsSync(join(from, 'sessions'))) cpSync(join(from, 'sessions'), join(to, 'sessions'), { recursive: true })
}

const { LearningEngine: Alpha2 } = await load(alpha2Path)
const buildAlpha2 = (adapterId, prompt, turnPrompt) => {
  const root = mkdtempSync(join(tmpdir(), `mse-fixture-alpha2-${adapterId}-`))
  const engine = new Alpha2({ stateRoot: root, adapterId })
  engine.record({ eventId: 'legacy-correction', source: 'direct_user', kind: 'correction',
    instruction: '以后导出金额前先转换为数值，再按金额排序' })
  const method = engine.record({ eventId: 'legacy-method', source: 'host_proposal', kind: 'method', methodId: 'numeric-sort-v1' })
  const evaluated = engine.evaluateRegistered({ lessonId: method.id })
  engine.prepare({ sessionId: prompt, turnId: '1', prompt: turnPrompt, origin: 'user' })
  return { root, evaluated, instruction: method && engine.list().lessons.find(x => x.id === method.id).instruction }
}
const dshLegacy = buildAlpha2('dsh', 'legacy-alpha2-session', '导出金额并排序')
copyStore(dshLegacy.root, join(fixturesRoot, 'legacy-alpha2-schema2'))
const hermesLegacy = buildAlpha2('hermes', 'legacy-alpha2-hermes-session', '导出金额并排序')
copyStore(hermesLegacy.root, join(fixturesRoot, 'legacy-alpha2-schema2-hermes'))

const { LearningEngine: Daily } = await load(dailyPath)
const dailyRoot = mkdtempSync(join(tmpdir(), 'mse-fixture-daily-'))
const daily = new Daily({ stateRoot: dailyRoot, adapterId: 'dsh' })
daily.record({ eventId: 'legacy-daily-correction', source: 'direct_user', kind: 'correction',
  instruction: '以后导出报表金额前先核对货币单位再排序' })
daily.record({ eventId: 'legacy-daily-method', source: 'host_proposal', kind: 'method',
  instruction: '整理表格时先确认列名再逐列填充空值' })
const dailySession = 'legacy-daily-session'
daily.prepare({ sessionId: dailySession, turnId: '1', prompt: '导出报表金额并排序', origin: 'user' })
copyStore(dailyRoot, join(fixturesRoot, 'legacy-daily-schema1'))

const summary = {
  generatedAt: new Date().toISOString(),
  alpha2: { version: JSON.parse(readFileSync(join(alpha2Path, 'package.json'), 'utf8')).version,
    evaluation: dshLegacy.evaluated.decision, methodInstruction: dshLegacy.instruction,
    hermesAdapterFixture: 'legacy-alpha2-schema2-hermes' },
  daily: { version: JSON.parse(readFileSync(join(dailyPath, 'package.json'), 'utf8')).version,
    schema: daily.store.read().schema, lessons: daily.store.read().lessons.length },
}
writeFileSync(join(fixturesRoot, 'legacy-fixtures.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
