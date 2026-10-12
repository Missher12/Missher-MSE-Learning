// THE ONE public file set: what a source archive and the candidate manifest may contain.
//
// Why this exists: `pack-source.mjs` used to `tar … .` and `pack.mjs` walked the tree with a small
// exclusion list, so both included whatever happened to be on disk — including the private evidence
// directory (`.probes/`), coordination notes, and any local scratch an operator left behind. A public
// artifact is a PUBLICATION, and a publication needs a whitelist, not a blacklist: "everything except
// the names we remembered to exclude" is how private material escapes.
//
// The rule is therefore: a file is public only if it is in a PUBLIC directory, or is one of the named
// PUBLIC FILES at the repository root. Everything else — dot-directories, private evidence, local
// scratch, build output, caches — stays on disk and out of both artifacts.
import { readdirSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'

/** Directories whose ENTIRE contents are public. */
export const PUBLIC_DIRECTORIES = Object.freeze(['src', 'adapters', 'scripts', 'tests', 'docs'])
/** Named root files that are public. Anything not listed here (and not in a public directory) is not. */
export const PUBLIC_FILES = Object.freeze([
  'package.json', 'README.md', 'README.en.md', 'LICENSE', 'cordis.patch.yml', 'VALIDATION.md',
])
/** Never public, even inside a public directory: build output, caches, binaries, OS metadata. */
export const PRIVATE_NAMES = Object.freeze(new Set([
  'node_modules', 'dist', '__pycache__', '.git', '.probes', '.venv', 'venv', '.mypy_cache',
  '.pytest_cache', '.eslintcache',
]))
const PRIVATE_SUFFIXES = Object.freeze(['.pyc', '.pyo', '.log', '.tmp'])
const MAC_METADATA = name => name.split('/').some(part =>
  part.startsWith('._') || part === '.DS_Store' || part === '__MACOSX')
const HIDDEN = name => name.startsWith('.')

/** Whether one repository-relative, POSIX-style path belongs to the public set. */
export function isPublicPath(relative) {
  if (typeof relative !== 'string' || relative === '' || relative.startsWith('/')) return false
  if (MAC_METADATA(relative)) return false
  const parts = relative.split('/')
  if (parts.some(part => PRIVATE_NAMES.has(part))) return false
  if (PRIVATE_SUFFIXES.some(suffix => relative.endsWith(suffix))) return false
  if (parts.length === 1) return PUBLIC_FILES.includes(parts[0])
  // A path INSIDE a public directory is public unless the entry itself is hidden or a cache file; the
  // directory walk never descends into a private one, so `parts` cannot contain one here.
  if (!PUBLIC_DIRECTORIES.includes(parts[0])) return false
  return !parts.some(part => HIDDEN(part) || part === '')
}

/**
 * Every public file under `root`, as sorted POSIX-style relative paths.
 *
 * Symlinks are skipped rather than followed: a link is not content, and following one could publish a
 * file outside the tree. Empty directories are not reported (an archive cannot carry one meaningfully).
 */
export function publicFiles(root) {
  const found = []
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const relative = prefix === '' ? entry.name : posix.join(prefix, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (PRIVATE_NAMES.has(entry.name) || HIDDEN(entry.name)) continue
        if (!isPublicPath(`${relative}/placeholder`)) continue
        walk(join(directory, entry.name), relative)
        continue
      }
      if (!entry.isFile()) continue
      if (!isPublicPath(relative)) continue
      found.push(relative)
    }
  }
  walk(root, '')
  return found.sort()
}

/** The bounded summary a manifest or a report carries instead of the whole list. */
export function publicSetSummary(root) {
  const files = publicFiles(root)
  const bytes = files.reduce((total, relative) => total + statSync(join(root, relative)).size, 0)
  return { count: files.length, bytes, files }
}
