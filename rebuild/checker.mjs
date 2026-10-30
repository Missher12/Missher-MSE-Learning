/**
 * Real deterministic checkers — actual programs, not claims.
 *
 * A checker turns an objective fact about the world into pass/fail with a bounded reason code.
 * Exit code 0 of an arbitrary command and model prose never reach this path; only the checker's
 * own evaluation does. Results carry counts and reason codes only — never file contents.
 */
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const MAX_FILE_BYTES = 256 * 1024

function safeFile(root, rel) {
  if (typeof root !== 'string' || root === '' || typeof rel !== 'string' || rel === '' || rel.length > 512
    || rel.includes('\u0000') || rel.startsWith('/')) return null
  const target = resolve(join(root, rel))
  const base = resolve(root)
  if (!target.startsWith(`${base}/`)) return null
  try {
    const stat = statSync(target)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null
    return readFileSync(target, 'utf8')
  } catch { return null }
}

/** Parses the file as JSON; a trailing comma is reported as the concrete reason. */
function jsonFileParses({ file, root } = {}) {
  const text = safeFile(root, file)
  const result = (status, reason, extra = {}) => ({ status, checkId: 'json-file-parses-v1', reason, ...extra })
  if (text === null) return result('not_applicable', 'file_unavailable')
  try {
    JSON.parse(text)
    return result('pass', 'parses', { bytes: Buffer.byteLength(text) })
  } catch (error) {
    const trailing = /Expected double-quoted property name|Unexpected token ','/iu.test(String(error?.message))
    return result('fail', trailing ? 'trailing_comma' : 'parse_error', { bytes: Buffer.byteLength(text) })
  }
}

export const CHECKERS = Object.freeze({ 'json-file-parses-v1': jsonFileParses })

export function runChecker(checkId, params) {
  const checker = Object.hasOwn(CHECKERS, checkId) ? CHECKERS[checkId] : null
  if (checker === null) return { status: 'not_applicable', checkId, reason: 'unknown_checker' }
  return checker(params)
}
