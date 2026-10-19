import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFileStorage,createHttpStorage} from '../lib/storage.mjs';

test('filesystem adapter keeps Markdown compatible and rejects stale revisions',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'local-collab-file-'));
  try {
    const store=createFileStorage(folder);
    assert.deepEqual(await store.list(),[]);
    let record=await store.write('example.md','old Markdown',null);
    assert.equal((await store.read('example.md')).raw,'old Markdown');
    await assert.rejects(store.write('example.md','overwrite',null),err=>err.status===409);
    const newer=await store.write('example.md','new Markdown',record.revision);
    await assert.rejects(store.write('example.md','stale',record.revision),err=>err.status===409);
    assert.notEqual(newer.revision,record.revision);
    await assert.rejects(store.read('../escape.md'),err=>err.status===400);
    assert.deepEqual(await store.list(),['example.md']);
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('authenticated HTTP storage supports the full note workflow, CAS and failures without fallback',async()=>{
  const records=new Map();let sequence=0,conflict=false,outage=false,redirect=false;
  const calls=[];
  const server=createServer(async(req,res)=>{
    calls.push({method:req.method,authorization:req.headers.authorization,key:req.headers['x-test-key']});
    const send=(status,body,headers={})=>{res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify(body));};
    if(req.headers.authorization!=='Bearer synthetic-token' && req.headers['x-test-key']!=='synthetic-key')return send(401,{error:'private upstream body must never leak'});
    if(outage)return send(503,{error:'private upstream error'});
    if(redirect){res.writeHead(302,{Location:'/unexpected'});return res.end();}
    if(req.url==='/v1/notes' && req.method==='GET')return send(200,{notes:[...records.keys()]});
    const name=decodeURIComponent(req.url.split('/').at(-1));
    if(req.method==='GET') {
      const record=records.get(name);return record?send(200,record,{ETag:record.version}):send(404,{});
    }
    if(req.method==='PUT') {
      if(conflict){conflict=false;return send(412,{error:'upstream conflict'});}
      const current=records.get(name);
      if(current?req.headers['if-match']!==current.version:req.headers['if-none-match']!=='*')return send(412,{});
      let text='';for await(const chunk of req)text+=chunk;
      const {raw}=JSON.parse(text);const record={raw,modified:Date.now(),version:`"revision-${++sequence}"`};
      records.set(name,record);return send(current?200:201,record,{ETag:record.version});
    }
    send(405,{});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const folder=await mkdtemp(join(tmpdir(),'local-collab-http-'));
  const settings={type:'http',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,auth:{type:'bearer',tokenEnv:'SYNTHETIC_NOTES_TOKEN'}};
  process.env.LOCAL_COLLAB_CONFIG=join(folder,'config.json');process.env.LOCAL_COLLAB_NOTES=folder;
  process.env.SYNTHETIC_NOTES_TOKEN='synthetic-token';
  await writeFile(process.env.LOCAL_COLLAB_CONFIG,JSON.stringify({storage:settings}));
  for(const key of ['ACTIVECOLLAB_ACCOUNT_ID','ACTIVECOLLAB_PROJECT_ID','ACTIVECOLLAB_USER_ID'])delete process.env[key];
  try {
    const notes=await import('../lib/notes.mjs');
    await notes.addEntry('example',{author:'Agent One',model:'model-a',text:'Remote handoff'});
    await Promise.all([notes.addEntry('example',{author:'Agent Two',text:'Second handoff'}),notes.addEntry('example',{author:'Human',text:'Review done'})]);
    let note=await notes.getNote('example');assert.equal(note.entries.length,3);assert.equal(note.entries[0].model,'model-a');
    assert.equal((await notes.search('handoff')).length,1);
    await notes.updateMeta('example',{status:'done',next:'Accepted'});
    note=await notes.getNote('example');assert.equal(note.status,'done');
    await assert.rejects(notes.replaceRaw('example','bad','stale'),err=>err.status===409);
    conflict=true;
    await assert.rejects(notes.addEntry('example',{author:'Human',text:'Must not overwrite concurrent edit'}),err=>err.status===409);
    assert.equal((await notes.getNote('example')).entries.length,3);
    const store=createHttpStorage({...settings,auth:{type:'api-key',header:'X-Test-Key',tokenEnv:'TEST_KEY'}},{env:{TEST_KEY:'synthetic-key'}});
    assert.equal((await store.list()).length,1);
    outage=true;
    await assert.rejects(notes.addEntry('example',{author:'Human',text:'No disk fallback'}),err=>err.status===502 && !err.message.includes('private upstream'));
    outage=false;redirect=true;
    await assert.rejects(store.list(),err=>err.status===502);
    redirect=false;
    assert.deepEqual((await readdir(folder)).filter(name=>name.endsWith('.md')),[]);
    assert.ok(calls.some(call=>call.key==='synthetic-key'));
    assert.ok(calls.filter(call=>!call.key).every(call=>call.authorization==='Bearer synthetic-token'));
    assert.throws(()=>createHttpStorage({...settings,baseUrl:'http://example.com'}),/HTTPS/);
    assert.throws(()=>createHttpStorage({...settings,baseUrl:'https://user:pass@example.com'}),/embedded credentials/);
  }finally{
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await rm(folder,{recursive:true,force:true});
  }
});
