// Isolated two-process interleaving: pause one reaper AFTER its real final lstat, not a fake stat.
import { mkdtempSync, rmSync, writeFileSync, utimesSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { MemoryStore } from '../memory.mjs'
const root=realpathSync(mkdtempSync(join(tmpdir(),'mse-stale-race-')))
const moduleUrl=new URL('../memory.mjs',import.meta.url).href
const children=[]
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
function launch(role) {
  const code=`
import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const root=${JSON.stringify(root)}, role=${JSON.stringify(role)};
const pause=file=>{const until=Date.now()+7000;while(!fs.existsSync(root+'/'+file)){if(Date.now()>until)throw Error('barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}};
if(role==='B') {const original=fs.lstatSync;let calls=0;fs.lstatSync=function(path,...args){const value=original.call(this,path,...args);if(String(path)===root+'/.memory-v1.lock'&&++calls===3){process.stdout.write('AFTER_STAT_B\\n');pause('release-B')}return value};syncBuiltinESMExports()}
const {MemoryStore}=await import(${JSON.stringify(moduleUrl)});const store=new MemoryStore({stateRoot:root});
try {store.transaction(doc=>{if(role==='A'){process.stdout.write('LOCKED_A\\n');pause('release-A')}doc['writer'+role]=true;return true});process.stdout.write(JSON.stringify({role,ok:true})+'\\n')}
catch(e){process.stdout.write(JSON.stringify({role,ok:false,code:e.code??e.message})+'\\n')}
`
  const proc=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']})
  const child={role,proc,text:'',stderr:'',exited:false,code:null}
  proc.stdout.on('data',chunk=>{child.text+=chunk})
  proc.stderr.on('data',chunk=>{child.stderr+=chunk})
  proc.on('exit',code=>{child.exited=true;child.code=code})
  children.push(child);return child
}
async function until(predicate,ms=8000){const limit=Date.now()+ms;while(!predicate()){if(Date.now()>limit)throw Error('parent timeout');await delay(10)}}
const output={scope:'real temporary writer processes; deliberate scheduler delay after a genuine stat',productionWrites:0,providerCalls:0}
try {
  const store=new MemoryStore({stateRoot:root});store.transaction(doc=>{doc.sentinel='preserve';return true})
  const lock=join(root,'.memory-v1.lock');writeFileSync(lock,JSON.stringify({pid:2147483647,token:'dead-owner'}),{mode:0o600});const old=(Date.now()-10*60_000)/1000;utimesSync(lock,old,old)
  const b=launch('B');await until(()=>b.text.includes('AFTER_STAT_B')||b.exited)
  if(!b.text.includes('AFTER_STAT_B'))throw Error('expected final-stat barrier was not reached: '+b.text+b.stderr)
  const a=launch('A');await until(()=>a.text.includes('LOCKED_A')||a.exited)
  writeFileSync(join(root,'release-B'),'go')
  await until(()=>b.exited)
  writeFileSync(join(root,'release-A'),'go')
  await until(()=>a.exited)
  const final=store.read()
  output.writers=children.map(child=>({role:child.role,exit:child.code,output:child.text.trim().split('\n').map(line=>{try{return JSON.parse(line)}catch{return line}}),stderr:child.stderr}))
  output.final={sentinel:final.sentinel,writerA:final.writerA===true,writerB:final.writerB===true}
  const successes=output.writers.flatMap(w=>w.output.filter(row=>row?.ok===true).map(()=>w.role))
  output.acknowledgedUpdatesPreserved=successes.length>0&&successes.every(role=>final['writer'+role]===true)
  output.ok=output.acknowledgedUpdatesPreserved
  if(!output.ok)process.exitCode=1
}catch(e){output.ok=false;output.error=e.message;process.exitCode=1}
finally{for(const child of children)if(!child.exited)child.proc.kill('SIGKILL');rmSync(root,{recursive:true,force:true});console.log(JSON.stringify(output,null,2))}
