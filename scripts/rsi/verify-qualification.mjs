/** Developer-only. Packing verifies the reviewed release against an actual fresh, offline replay. */
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFileSync,realpathSync,writeFileSync,renameSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {isDeepStrictEqual} from 'node:util'
import {RECALL_QUALIFICATION} from '../../rebuild/recall-qualification.mjs'
import {NORMALIZATION_RULE} from '../../rebuild/recall.mjs'

const SELECTOR_FILES=['rebuild/evolution.mjs','rebuild/recall.mjs','src/recall.mjs']
// The frozen selector qualification predates this one exact, non-semantic cache implementation.
// Keep the old policy digest as the record identity while requiring the complete old→new source
// tuple below; any other selector change still requires a separately reviewed qualification.
const CACHE_ONLY_SOURCE_COMPATIBILITY=Object.freeze({
  id:'analysis-cache-bounded-lru-v1',
  candidateId:'whole-word-error-to-existing-log-v1',
  from:{
    'rebuild/evolution.mjs':'04fc76ffc70fd0ceab830ba475d301c8b499009d9afcd97fe9c6e12361e0db65',
    'rebuild/recall.mjs':'ee8db9fc7f122814eadc3ba97f8b8fa9c8b1400cf9b5f3da052b5d352b5add31',
    'src/recall.mjs':'e3a3bf35f298033bc5e4bcf2d48fa7cde9fa78d0613ad3bd8d556093af634911'
  },
  to:{
    'rebuild/evolution.mjs':'04fc76ffc70fd0ceab830ba475d301c8b499009d9afcd97fe9c6e12361e0db65',
    'rebuild/recall.mjs':'ee8db9fc7f122814eadc3ba97f8b8fa9c8b1400cf9b5f3da052b5d352b5add31',
    'src/recall.mjs':'c671809fc7cb1ac5f9fcb03bf105732d4db478bd0fa20cb36cbb483541d50a77'
  }
})
// The only additional selector-source change admitted for MSE 1.5.0 removes the obsolete total
// method-history limit. Qualification identity stays frozen; current source must match this full
// tuple exactly, and the existing offline replay below must still reproduce its saved evidence.
const METHOD_HISTORY_GROWTH_COMPATIBILITY=Object.freeze({
  id:'method-history-page-growth-v1',
  candidateId:'whole-word-error-to-existing-log-v1',
  from:CACHE_ONLY_SOURCE_COMPATIBILITY.from,
  to:{
    'rebuild/evolution.mjs':'b33ba302ed336d81cd7e3bf2f120648eff0ed8e905c1f5500f3644f15d5fca86',
    'rebuild/recall.mjs':'ee8db9fc7f122814eadc3ba97f8b8fa9c8b1400cf9b5f3da052b5d352b5add31',
    'src/recall.mjs':'c671809fc7cb1ac5f9fcb03bf105732d4db478bd0fa20cb36cbb483541d50a77'
  }
})
const REPLAY_FILES=['scripts/rsi/auto-offline.mjs','scripts/rsi/compare-normalization.mjs',
  'scripts/rsi/replay.mjs','tests/fixtures/recall-cases.json','tests/fixtures/rsi/recall-comparison.json',
  'tests/fixtures/rsi/normalization-controls.json','tests/fixtures/rsi/auto-independent-controls.json']
const sha=value=>createHash('sha256').update(value).digest('hex')
const digests=(root,files)=>Object.fromEntries(files.map(path=>[path,sha(readFileSync(join(root,path)))]))

function evaluate(root,sourceDigests){
  // Start the evaluator from exactly this tree, including its own fixtures and selector modules.
  let report
  try{
    const entry=realpathSync(join(root,'scripts/rsi/auto-offline.mjs'))
    const stdout=execFileSync(process.execPath,[entry],
      {cwd:root,encoding:'utf8',timeout:30_000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']})
    report=JSON.parse(stdout)
  }catch{return {ok:false,reason:'offline_replay_unavailable'}}
  if(report.recommendation!=='offline_recommendation' || report.frozenCandidate?.id!==NORMALIZATION_RULE.id
    || report.discovery?.assessment?.status!=='candidate_signal' || report.controls?.status!=='passed'
    || !report.controls.independentGainCases?.length || report.automaticPromotion!==false) {
    return {ok:false,reason:'offline_replay_refused'}
  }
  const runs=[report.discovery,report.controls]
  const total=key=>runs.reduce((n,row)=>n+row.overall[key].length,0)
  const evidence={
    schema:report.schema,recommendation:report.recommendation,
    discoveryCases:report.discovery.cases.length,controlCases:report.controls.cases.length,
    independentGainCases:report.controls.independentGainCases.map(x=>x.caseId),
    newMisses:total('newMisses'),newFalseOffers:total('newFalseOffers'),
    newGuardMisses:total('newGuardMisses'),overCapCases:total('candidateOverCapCases'),
    inputsDigest:sha(JSON.stringify(digests(root,REPLAY_FILES))),
    replayDigest:sha(JSON.stringify(report)),
  }
  if(evidence.newMisses||evidence.newFalseOffers||evidence.newGuardMisses||evidence.overCapCases) {
    return {ok:false,reason:'offline_regression'}
  }
  const data={candidateId:report.frozenCandidate.id,sourceDigests,evidence}
  return {ok:true,qualification:{...data,id:sha(JSON.stringify(data))}}
}

export function verifyRecallQualification(root,qualification=RECALL_QUALIFICATION){
  const sourceDigests=digests(root,SELECTOR_FILES)
  if(qualification.candidateId!==NORMALIZATION_RULE.id)return {ok:false,reason:'candidate_id'}
  const unchanged=isDeepStrictEqual(qualification.sourceDigests,sourceDigests)
  const cacheOnly=qualification.candidateId===CACHE_ONLY_SOURCE_COMPATIBILITY.candidateId
    && isDeepStrictEqual(qualification.sourceDigests,CACHE_ONLY_SOURCE_COMPATIBILITY.from)
    && isDeepStrictEqual(sourceDigests,CACHE_ONLY_SOURCE_COMPATIBILITY.to)
  const methodHistoryGrowth=qualification.candidateId===METHOD_HISTORY_GROWTH_COMPATIBILITY.candidateId
    && isDeepStrictEqual(qualification.sourceDigests,METHOD_HISTORY_GROWTH_COMPATIBILITY.from)
    && isDeepStrictEqual(sourceDigests,METHOD_HISTORY_GROWTH_COMPATIBILITY.to)
  if(!unchanged&&!cacheOnly&&!methodHistoryGrowth)return {ok:false,reason:'source_digest'}
  // The evaluator executes the current tree, but using the frozen source tuple preserves the old
  // qualification identity. Its exact replay evidence must still match below on every run.
  const actual=evaluate(root,qualification.sourceDigests)
  if(!actual.ok)return actual
  if(!isDeepStrictEqual(actual.qualification.evidence,qualification.evidence))return {ok:false,reason:'stale_offline_evidence'}
  if(qualification.id!==actual.qualification.id)return {ok:false,reason:'qualification_id'}
  return {ok:true,candidateId:qualification.candidateId,id:qualification.id,sourceDigests,
    ...(cacheOnly?{compatibility:CACHE_ONLY_SOURCE_COMPATIBILITY.id}:{}),
    ...(methodHistoryGrowth?{compatibility:METHOD_HISTORY_GROWTH_COMPATIBILITY.id}:{})}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const root=fileURLToPath(new URL('../../',import.meta.url))
  if(process.argv.length===3&&process.argv[2]==='--freeze'){
    const result=evaluate(root,digests(root,SELECTOR_FILES))
    if(!result.ok)throw Error(result.reason)
    const dest=join(root,'rebuild/recall-qualification.mjs')
    const code='/** Generated by the offline qualification verifier from this release. */\n'
      +'const data='+JSON.stringify(result.qualification,null,2)+'\n'
      +'Object.freeze(data.sourceDigests)\nObject.freeze(data.evidence.independentGainCases)\n'
      +'Object.freeze(data.evidence)\nexport const RECALL_QUALIFICATION=Object.freeze(data)\n'
    writeFileSync(dest+'.tmp',code);renameSync(dest+'.tmp',dest)
    console.log(JSON.stringify({frozen:result.qualification.id,evidence:result.qualification.evidence}))
  }else if(process.argv.length===2){
    const result=verifyRecallQualification(root);console.log(JSON.stringify(result))
    if(!result.ok)process.exitCode=1
  }else throw Error('use --freeze to explicitly record a reviewed replay, or no arguments to verify')
}
