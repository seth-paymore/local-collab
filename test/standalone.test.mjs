import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

test('fresh standalone installation supports model attribution without tracker credentials', async () => {
  const folder=await mkdtemp(join(tmpdir(),'local-collab-standalone-'));
  const probe=createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening');
  const port=probe.address().port; await new Promise(resolve=>probe.close(resolve));
  const env={...process.env,LOCAL_COLLAB_CONFIG:join(folder,'missing.json'),LOCAL_COLLAB_NOTES:folder,LOCAL_COLLAB_PORT:String(port),LOCAL_COLLAB_AUTHOR:'Reviewer'};
  for(const key of Object.keys(env)) if (/^ACTIVECOLLAB_|^ACTIVE_COLLAB$/.test(key)) delete env[key];
  const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  const ended=once(child,'exit');
  let output=''; child.stderr.on('data',chunk=>{output+=chunk});
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`Server did not start: ${output}`)),10000);
      child.stdout.on('data',chunk=>{if(String(chunk).includes('listening')){clearTimeout(timer);resolve()}});
      child.once('error',err=>{clearTimeout(timer);reject(err)});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error(`Server exited: ${output}`))});
    });
    const base=`http://127.0.0.1:${port}/api`;
    const request=async(path,method='GET',body)=>{
      const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
      return {status:response.status,data:await response.json()};
    };
    assert.deepEqual((await request('/config')).data,{author:'Reviewer',activeCollabEnabled:false,storage:{type:'filesystem',label:'Markdown files'}});
    const ac=(await request('/activecollab')).data;
    assert.equal(ac.enabled,false); assert.equal(ac.mine.length,0);
    assert.equal((await request('/activecollab/refresh','POST',{})).status,503);
    const entry={author:'Agent One',agent:'Reviewer',provider:'Any Provider',model:'model-family/version-2',text:'Shared context',status:'waiting'};
    let note=(await request('/notes/example/entries','POST',entry)).data;
    assert.equal(note.entries[0].agent,entry.agent);
    assert.equal(note.entries[0].model,entry.model);
    assert.equal(note.entries[0].provider,entry.provider);
    assert.equal(note.entries[0].text,entry.text);
    assert.equal(note.ac,null);
    note=(await request('/notes/example/entries','POST',{author:'Another Agent',text:'No model metadata needed'})).data;
    assert.equal(note.entries[0].model,entry.model);
    assert.equal(note.entries[1].model,undefined);
    assert.equal((await request('/notes/example/entries','POST',{...entry,model:'bad -->\n## forged'})).status,400);
    const response=await fetch(base+'/notes/example/entries',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.com'},body:JSON.stringify(entry)});
    assert.equal(response.status,403);
    assert.equal((await request('/notes/example')).data.entries.length,2);
    const raw=await request('/notes/example/raw','PUT',{raw:note.raw,version:'stale'});
    assert.equal(raw.status,409);
  } finally {
    child.kill(); await ended;
    await rm(folder,{recursive:true,force:true});
  }
});
