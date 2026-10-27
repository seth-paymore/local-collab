import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createInstructions,instructionsHash,syncInstructions,INSTRUCTIONS_FILE} from '../lib/instructions.mjs';
import {createFileStorage} from '../lib/storage.mjs';
import {startLocalServer} from '../test-support/local-server.mjs';

const execute=promisify(execFile);
const document=text=>({text,version:instructionsHash(text)});
const source='http://127.0.0.1:4317/api/instructions';

test('canonical instructions persist independently with versioned concurrent editing',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'collab-instructions-'));
  try {
    const manager=createInstructions(createFileStorage(folder));
    assert.equal((await manager.get()).version,null);
    const original=await manager.set({text:'# Shared rules\r\nPreserve existing work.\r\n',version:null});
    assert.equal(original.text,'# Shared rules\nPreserve existing work.\n');
    assert.equal((await createInstructions(createFileStorage(folder)).get()).text,original.text);
    for(const value of [null,[],{text:'',version:original.version},{text:'x\0y',version:original.version}])await assert.rejects(()=>manager.set(value),error=>error.status===400);
    await assert.rejects(()=>manager.set({text:'Lost update',version:null}),error=>error.status===409);
    await assert.rejects(()=>manager.set({text:'No version'}),error=>error.status===409);
    const races=await Promise.allSettled(['First','Second'].map(text=>manager.set({text,version:original.version})));
    assert.equal(races.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(races.find(r=>r.status==='rejected').reason.status,409);
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('sync updates managed copies, preserves manual edits, and keeps the replaced version',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'collab-sync-'));
  const target=join(folder,'AGENTS.md');
  try {
    const first=document('# First\n');const second=document('# Second\n');
    assert.equal((await syncInstructions(first,target,{source})).changed,true);
    assert.equal((await syncInstructions(first,target,{source})).changed,false);
    assert.equal((await syncInstructions(second,target,{source,check:true})).changed,true);
    assert.equal(await readFile(target,'utf8'),first.text);
    assert.equal((await syncInstructions(second,target,{source})).changed,true);
    assert.equal(await readFile(target+'.local-collab-backup','utf8'),first.text);
    await writeFile(target,'Manual local change\n');
    await assert.rejects(()=>syncInstructions(first,target,{source}),/independent changes/);
    assert.equal(await readFile(target,'utf8'),'Manual local change\n');
    await syncInstructions(first,target,{source,replaceLocal:true});
    assert.equal(await readFile(target+'.local-collab-backup','utf8'),'Manual local change\n');
    await assert.rejects(()=>syncInstructions(second,target,{source:'another-workspace'}),/independent changes/);
    await assert.rejects(()=>syncInstructions({text:'Tampered',version:first.version},target,{source}),/valid shared/);
    await assert.rejects(()=>syncInstructions(first,join(folder,'README.md'),{source}),/named AGENTS/);
    await assert.rejects(()=>access(target+'.local-collab-lock'));
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('first import requires a match or explicit replacement, with safe line-ending adoption',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'collab-adopt-'));
  const target=join(folder,'AGENTS.md');
  try {
    await writeFile(target,'# Existing\r\n');
    await assert.rejects(()=>syncInstructions(document('# Different\n'),target,{source}),/independent changes/);
    await syncInstructions(document('# Existing\n'),target,{source});
    assert.equal(await readFile(target,'utf8'),'# Existing\n');
    assert.equal(await readFile(target+'.local-collab-backup','utf8'),'# Existing\r\n');
    await writeFile(target+'.local-collab.json','malformed');
    await assert.rejects(()=>syncInstructions(document('Next'),target,{source}),/Invalid instruction sync receipt/);
    await writeFile(target+'.local-collab-lock','running');
    await assert.rejects(()=>syncInstructions(document('Next'),target,{source}),/in progress/);
    assert.equal(await readFile(target,'utf8'),'# Existing\n');
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('actual API and CLI manage instructions without exposing them as notes or tracker changes',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'collab-instructions-http-'));
  const server=await startLocalServer(folder);
  const cli=fileURLToPath(new URL('../bin/instructions.mjs',import.meta.url));
  const call=async(path,method='GET',body,extra={})=>{
    const response=await fetch(server.base+'/api'+path,{method,headers:{'Content-Type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  let closed=false;
  try {
    assert.equal((await call('/instructions')).body.version,null);
    const denied=await call('/instructions','PUT',{text:'Foreign page',version:null},{Origin:'https://example.com'});
    assert.equal(denied.status,403);
    const input=join(folder,'import.txt');await writeFile(input,'# Shared synthetic instructions\n');
    await execute(process.execPath,[cli,'set','--file',input,'--version','new'],{env:server.env});
    const shown=JSON.parse((await execute(process.execPath,[cli,'show','--json'],{env:server.env})).stdout);
    assert.equal(shown.text,await readFile(input,'utf8'));
    assert.equal((await call('/instructions','PUT',{text:'Stale',version:'old'})).status,409);
    assert.equal((await call('/instructions','PUT',null)).status,400);
    assert.equal((await call('/notes')).body.notes.length,0);
    assert.equal((await call('/search?q=synthetic')).body.results.length,0);
    assert.equal((await call('/notes/agent-instructions')).status,400);
    assert.equal((await call('/notes/agent-instructions/entries','POST',{author:'Bot',text:'Not a timeline'})).status,400);
    const target=join(folder,'AGENTS.md');
    const synced=JSON.parse((await execute(process.execPath,[cli,'sync','--target',target,'--json'],{env:server.env})).stdout);
    assert.equal(synced.changed,true);
    const next=await call('/instructions','PUT',{text:'# Revised rules\n',version:shown.version});assert.equal(next.status,200);
    await assert.rejects(()=>execute(process.execPath,[cli,'sync','--target',target,'--check'],{env:server.env}),error=>error.code===1);
    assert.equal(await readFile(target,'utf8'),shown.text);
    await server.close();closed=true;
    await execute(process.execPath,[cli,'sync','--target',target],{env:server.env});
    assert.equal(await readFile(target,'utf8'),'# Revised rules\n');
    assert.equal(await readFile(join(folder,INSTRUCTIONS_FILE),'utf8'),'# Revised rules\n');
  }finally{if(!closed)await server.close();await rm(folder,{recursive:true,force:true});}
});
