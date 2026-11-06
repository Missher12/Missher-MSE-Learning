/**
 * Offline challenger comparison. Inputs are projections frozen before the tool outcome;
 * expected is joined only after one native objective has been determined. Re-run the frozen
 * strategy on those projections without a store, model call, or serving it in the host.
 * Counts describe the candidate's exact method version, not global recall accuracy.
 */
import {adaptivePolicyMatches} from './adaptive-recall.mjs'

export function replayAdaptivePolicy(policy) {
  const incumbent = {hits:0,misses:0,falseOffers:0}
  const candidate = {hits:0,misses:0,falseOffers:0}
  const sessions=new Set([policy.firstSession]), queries=new Set([policy.firstQuery])
  let evaluated=0, independentGains=0, independentControls=0, regressions=0, repeats=0, incomplete=0
  for (const s of policy.samples ?? []) {
    if (!['holdout_hit','negative_control','negative'].includes(s.result)) continue
    const c=s.replay
    if (!c || !Array.isArray(c.features) || typeof c.baselineHasTarget!=='boolean'
      || typeof c.canAdd!=='boolean' || typeof c.expected!=='boolean'
      || typeof s.session!=='string' || typeof s.query!=='string'
      || (s.result==='holdout_hit')!==c.expected) { incomplete++; continue }
    const old=c.baselineHasTarget
    const added=!old && c.canAdd && adaptivePolicyMatches(policy,c.features)
    const next=old || added
    // A contrary observation is never hidden by deduplication. Repeated corroboration
    // cannot, on the other hand, bootstrap a new independent positive or negative control.
    if (added && !c.expected) regressions++
    const independent=!sessions.has(s.session) && !queries.has(s.query)
    sessions.add(s.session);queries.add(s.query)
    if (!independent) { repeats++;continue }
    evaluated++
    for (const [metrics,offer] of [[incumbent,old],[candidate,next]]) {
      if (c.expected) metrics[offer?'hits':'misses']++
      else if (offer) metrics.falseOffers++
    }
    if (c.expected && added) independentGains++
    // A genuine contrast must have room for the candidate. A full budget is not evidence
    // that the trigger correctly abstained.
    if (!c.expected && !old && c.canAdd && !next) independentControls++
  }
  const reason=regressions?'new_false_offer':incomplete?'incomplete_replay':
    !independentGains?'no_independent_gain':!independentControls?'no_independent_control':'strict_gain'
  return {approved:reason==='strict_gain',reason,evaluated,independentGains,independentControls,
    regressions,repeats,incomplete,incumbent,candidate}
}
