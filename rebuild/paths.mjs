import { posix, win32 } from 'node:path'

// Host realpaths may use drive letters, UNC shares, or Windows extended-length prefixes.
// Keep the path flavour attached to the value; never compare Windows names with POSIX slashes.
function pathParts(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f]/u.test(value)) return null
  let path = value.replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\(?=[A-Za-z]:[\\/])/u, '')
  if (/^[A-Za-z]:[\\/]/u.test(path) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(path)) {
    return { api: win32, path: win32.normalize(path) }
  }
  if (!posix.isAbsolute(path)) return null
  // Existing macOS /tmp alias compatibility; callers resolve filesystem links separately.
  path = path === '/private/tmp' ? '/tmp' : path.startsWith('/private/tmp/') ? path.slice(8) : path
  return { api: posix, path: posix.normalize(path) }
}

export const isAbsolutePath = value => pathParts(value) !== null

/** Relative name only for the same real root/volume, never a sibling prefix or traversal. */
export function relativeInside(candidate, root) {
  const target = pathParts(candidate)
  const base = pathParts(root)
  if (target === null || base === null || target.api !== base.api) return null
  const rel = base.api.relative(base.path, target.path)
  if (rel === '..' || rel.startsWith(`..${base.api.sep}`) || base.api.isAbsolute(rel)) return null
  // A disk/filesystem root cannot grant learning access to the whole machine.
  if (rel !== '' && base.path === base.api.parse(base.path).root) return null
  return rel
}

export const pathInside = (candidate, roots) => roots.some(root => relativeInside(candidate, root) !== null)
