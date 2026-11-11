/** Shared error and size contract for the current learning store. */
export const MAX_STORE_BYTES = 2 * 1024 * 1024
export class LearningError extends Error {
  constructor(code) { super(code); this.code = code }
}
export function check(condition, code = 'invalid_input') { if (!condition) throw new LearningError(code) }
