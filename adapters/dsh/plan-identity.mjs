/**
 * The identity of one evaluation plan.
 *
 * A preview and the run it authorises must describe the same work. The hash below is computed
 * from everything that decides what would actually happen — the trusted scope, the lesson and
 * its version, the normalized cases with their oracles, the model route, and the budget that
 * caps the run — so the Host can recompute it at start time and refuse a plan whose world has
 * moved. A route that changed from one model to another between the preview and the click is
 * not "the same verification on the same model", and silently running the new one would spend
 * the person's budget on something they never saw.
 *
 * Host-free on purpose: this is a pure function of its inputs and is unit-tested as one.
 */
import { createHash } from 'node:crypto'

const scopeOf = projectKey => projectKey === undefined || projectKey === null
  ? 'instance'
  : `project:${createHash('sha256').update(String(projectKey)).digest('hex').slice(0, 16)}`

/**
 * @param input.projectKey - the Host-resolved scope, never a browser value.
 * @param input.row - the stored lesson row (`id`, `version`, `methodId`).
 * @param input.cases - normalized cases from `normalizeCases`.
 * @param input.route - the resolved route, or `null` for a registered algorithm.
 * @param input.limits - `{ evaluationTokensPerDay, evaluationCallsPerDay }` from the live engine.
 * @returns a stable 32-character digest.
 */
export function planIdentity({ projectKey, row, cases, route, limits }) {
  const body = [
    scopeOf(projectKey), row.id, row.version, row.methodId ?? null,
    (cases ?? []).map(item => [item.caseId, item.family, item.split, item.prompt,
      item.checker.kind, item.checker.expected, item.forbidden]),
    route === null || route === undefined ? null : [route.provider, route.model, route.reasoningEffort ?? null],
    limits?.evaluationTokensPerDay ?? null, limits?.evaluationCallsPerDay ?? null,
  ]
  return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32)
}

export default planIdentity
