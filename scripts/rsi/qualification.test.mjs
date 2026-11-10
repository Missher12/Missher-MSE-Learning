import test from 'node:test'
import assert from 'node:assert/strict'
import {cpSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {join, relative, sep} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {verifyRecallQualification} from './verify-qualification.mjs'
const root=fileURLToPath(new URL('../../',import.meta.url))

test('a release with the same selector must still establish a gain on its current control cases',()=>{
  const copy=mkdtempSync(join(tmpdir(),'mse-qualification-'))
  try{
    for(const path of ['scripts/rsi','src','rebuild','tests/fixtures']){
      const source=join(root,path)
      cpSync(source,join(copy,path),{recursive:true,filter:item=>{
        if(path!=='rebuild') return true
        const rel=relative(source,item)
        return rel!=='.probes'&&!rel.startsWith(`.probes${sep}`)
      }})
    }
    assert.equal(verifyRecallQualification(copy).ok,true)
    const fixture=join(copy,'tests/fixtures/rsi/auto-independent-controls.json')
    const data=JSON.parse(readFileSync(fixture,'utf8'))
    // Only this disposable negative test changes a label. The saved certificate and selector
    // are untouched; their identity alone cannot overrule an actual new explicit false offer.
    const control=data.cases.find(x=>x.id==='new_indentation')
    control.expect.excluded.push(...control.expect.relevant)
    control.expect.relevant=[]
    writeFileSync(fixture,JSON.stringify(data))
    assert.equal(verifyRecallQualification(copy).reason,'offline_replay_refused')
    // Even an edit to metadata that leaves all judgments identical invalidates the old replay.
    cpSync(join(root,'tests/fixtures/rsi/auto-independent-controls.json'),fixture)
    const original=readFileSync(fixture,'utf8')
    writeFileSync(fixture,original+'\n')
    assert.equal(verifyRecallQualification(copy).reason,'stale_offline_evidence')
    writeFileSync(join(copy,'rebuild/recall.mjs'),readFileSync(join(copy,'rebuild/recall.mjs'),'utf8')+'\n')
    assert.equal(verifyRecallQualification(copy).reason,'source_digest')
  }finally{rmSync(copy,{recursive:true,force:true})}
})
