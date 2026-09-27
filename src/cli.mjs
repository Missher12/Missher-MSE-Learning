#!/usr/bin/env node
import { LearningEngine } from './index.mjs'

// Local trusted-host transport. stdout is protocol-only; no shell commands or model calls.
const operations = new Set(['prepare', 'record', 'accept', 'cancel', 'complete', 'status', 'reflectionRequest', 'reflectionResult'])
let input = ''
try {
  process.stdin.setEncoding('utf8')
  for await (const part of process.stdin) {
    input += part
    if (Buffer.byteLength(input) > 65_536) throw new Error('input_too_large')
  }
  const request = JSON.parse(input)
  if (!operations.has(request.op)) throw new Error('invalid_operation')
  const engine = new LearningEngine(request.config)
  process.stdout.write(JSON.stringify(engine[request.op](request.input ?? {})) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? 'invalid_request' }) + '\n')
  process.exitCode = 1
}
