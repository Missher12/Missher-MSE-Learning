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
