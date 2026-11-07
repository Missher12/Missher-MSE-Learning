import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

test('a competing stale-lock reaper cannot remove an acknowledged writer lock', () => {
  const script = join(process.cwd(), 'delivery/enterprise/stale-lock-race-review.mjs')
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 20_000 })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const report = JSON.parse(result.stdout.trim())
  assert.equal(report.productionWrites, 0)
  assert.equal(report.providerCalls, 0)
  assert.ok(report.writers.some(writer => writer.output.some(row => row?.ok === true)))
  assert.equal(report.acknowledgedUpdatesPreserved, true, JSON.stringify(report))
})
