import {test} from 'node:test'
import assert from 'node:assert/strict'
import {replayAdaptivePolicy} from './adaptive-replay.mjs'
const caseOf=(session,query,features,expected,canAdd=true,baselineHasTarget=false)=>({session,query,
  result:expected?'holdout_hit':'negative_control',replay:{features,expected,canAdd,baselineHasTarget}})
const run=(...samples)=>replayAdaptivePolicy({firstSession:'source',firstQuery:'original',features:['null','field'],samples})
const positive=caseOf('independent','new phrasing',['field','null'],true)
const nearNegative=caseOf('other','other question',['field'],false)
test('separate held-out gains and real near negatives qualify only a strict, additive win',()=>{
 const r=run(positive,nearNegative)
 assert.equal(r.approved,true)
 assert.deepEqual(r.incumbent,{hits:0,misses:1,falseOffers:0})
 assert.deepEqual(r.candidate,{hits:1,misses:0,falseOffers:0})
 assert.equal(run({...positive,session:'source'},nearNegative).approved,false)
 assert.equal(run({...positive,query:'original'},nearNegative).approved,false)
 assert.equal(run(positive,caseOf('other','original',['field'],false)).approved,false)
 assert.equal(run(positive,caseOf('other','case2',['field'],false,false)).approved,false)
 assert.equal(run(caseOf('independent','new phrasing',['field','null'],true,true,true),nearNegative).approved,false)
})
test('a false offer vetoes improvement even when its session was already observed',()=>{
 const bad=caseOf('independent','other objective',['field','null'],false)
 assert.equal(run(positive,nearNegative,bad).reason,'new_false_offer')
 assert.equal(run(positive,nearNegative,{...bad,session:'third'}).candidate.falseOffers,1)
 assert.equal(run(positive,nearNegative,{...bad,replay:null}).approved,false)
 assert.equal(run(nearNegative,{result:'discovery_hit',...{session:'src',query:'discovery'}}).approved,false)
})

const candidate = { id: 'mem_candidate', version: 2, mode: 'method' }
const incumbent = { id: 'mem_incumbent', version: 1, mode: 'method' }
const warning = { id: 'mem_warning', version: 3, mode: 'guard' }
const userRule = { id: 'mem_rule', version: 1, mode: 'method' }
const v2 = (...samples) => replayAdaptivePolicy({ schema: 'mse-adaptive-recall-v2',
  entryId: candidate.id, version: candidate.version, firstSession: 'source', firstQuery: 'original',
  features: ['api', 'opcheck'], excludedFeatures: ['chart'], samples })
const full = ({ session, query, features, expected, observed = expected ? candidate : incumbent,
  baselineOffers = [incumbent, userRule, warning], candidateOffers, baselineBytes = 600,
  candidateBytes = expected ? 700 : 600, matched = expected, canAdd = true,
  result = expected ? 'holdout_hit' : 'negative_control' } = {}) => ({ session, query,
  turnKey: `${session}-${query}`, result,
  reason: expected ? 'independent_same_objective' : 'independent_unmatched_objective', at: 1,
  replay: { features, expected, matched, canAdd,
    baselineHasTarget: baselineOffers.some(row => row.id === candidate.id && row.version === candidate.version),
    baselineOffers, candidateOffers: candidateOffers ?? (expected ? [candidate, userRule, warning] : baselineOffers),
    protectedOffers: [userRule, warning], baselineBytes, candidateBytes,
    observedEntry: { id: observed.id, version: observed.version } } })

test('v2 promotion needs two independent positive gains and two complete, non-regressing controls',()=>{
 const approved=v2(
  full({session:'positive-1',query:'positive-query-1',features:['api','opcheck'],expected:true}),
  full({session:'positive-2',query:'positive-query-2',features:['api','opcheck'],expected:true}),
  full({session:'control-1',query:'control-query-1',features:['chart','opdraw'],expected:false,
    baselineOffers:[incumbent,userRule,warning]}),
  full({session:'control-2',query:'control-query-2',features:['chart','opdraw'],expected:false,
    observed:{id:'mem_other',version:4}, baselineOffers:[userRule,warning]}))
 assert.equal(approved.approved,true)
 assert.equal(approved.independentGains,2)
 assert.equal(approved.independentControls,2)
 assert.deepEqual(approved.removedMethods,['mem_incumbent'])
 assert.equal(approved.maxCandidateBytes,700)
 assert.equal(v2(
  full({session:'positive-1',query:'positive-query-1',features:['api','opcheck'],expected:true}),
  full({session:'positive-1',query:'positive-query-2',features:['api','opcheck'],expected:true}),
  full({session:'control-1',query:'control-query-1',features:['chart','opdraw'],expected:false,
    baselineOffers:[incumbent,userRule,warning]}),
  full({session:'control-2',query:'control-query-2',features:['chart','opdraw'],expected:false,
    baselineOffers:[incumbent,userRule,warning]})).independentGains,1)
 const repeatedEvidence=v2(
  full({session:'positive-1',query:'positive-query-1',features:['api','opcheck'],expected:true}),
  full({session:'positive-1',query:'positive-query-1',features:['api','opcheck'],expected:true}),
  full({session:'control-1',query:'control-query-1',features:['chart','opdraw'],expected:false,
    baselineOffers:[incumbent,userRule,warning]}),
  full({session:'control-2',query:'control-query-2',features:['chart','opdraw'],expected:false,
    baselineOffers:[incumbent,userRule,warning]}))
 assert.equal(repeatedEvidence.independentGains,1)
 assert.equal(repeatedEvidence.repeats,1)
 assert.equal(repeatedEvidence.approved,false, 'replay never counts the repeated turn as a second gain')
 const droppedRule=full({session:'positive-2',query:'positive-query-2',features:['api','opcheck'],expected:true,
  candidateOffers:[candidate,warning]})
 assert.equal(v2(
  full({session:'positive-1',query:'positive-query-1',features:['api','opcheck'],expected:true}),
  droppedRule,
  full({session:'control-1',query:'control-query-1',features:['chart','opdraw'],expected:false,
    baselineOffers:[incumbent,userRule,warning]}),
  full({session:'control-2',query:'control-query-2',features:['chart','opdraw'],expected:false,
    baselineOffers:[incumbent,userRule,warning]})).approved,false)
 const falseOffer=full({session:'bad',query:'bad-query',features:['api','opcheck'],expected:false,
  observed:incumbent, candidateOffers:[candidate,userRule,warning], candidateBytes:700,
  matched:true, result:'negative'})
 assert.equal(v2(
  full({session:'positive-1',query:'positive-query-1',features:['api','opcheck'],expected:true}),
  full({session:'positive-2',query:'positive-query-2',features:['api','opcheck'],expected:true}),
  full({session:'control-1',query:'control-query-1',features:['chart','opdraw'],expected:false,
    baselineOffers:[incumbent,userRule,warning]}),
  full({session:'control-2',query:'control-query-2',features:['chart','opdraw'],expected:false,
    baselineOffers:[incumbent,userRule,warning]}), falseOffer).reason,'offer_or_objective_regression')
 const lostControl=full({session:'control-lost',query:'control-lost-query',features:['chart','opdraw'],
  expected:false, observed:incumbent, baselineOffers:[incumbent,userRule,warning],
  candidateOffers:[userRule,warning], candidateBytes:400})
 assert.equal(v2(
  full({session:'positive-1',query:'positive-query-1',features:['api','opcheck'],expected:true}),
  full({session:'positive-2',query:'positive-query-2',features:['api','opcheck'],expected:true}),
  lostControl).reason,'offer_or_objective_regression')
})
