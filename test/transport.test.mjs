import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile);

test('CLI never replays a write after a dropped response, but still works when the server is off',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'local-collab-transport-'));let received=0;
  const server=createServer(async(req,res)=>{for await(const chunk of req){}received++;req.socket.destroy();});
  server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
  const env={...process.env,LOCAL_COLLAB_CONFIG:join(folder,'missing.json'),LOCAL_COLLAB_NOTES:folder,LOCAL_COLLAB_PORT:String(port)};
  for(const key of Object.keys(env))if(/^ACTIVECOLLAB_|^ACTIVE_COLLAB$/.test(key))delete env[key];
  const args=[fileURLToPath(new URL('../bin/note.mjs',import.meta.url)),'add','example','--author','Reviewer','--text','One handoff'];
  try{
    await assert.rejects(execute(process.execPath,args,{env,windowsHide:true}),err=>err.stderr.includes('outcome is uncertain'));
    assert.equal(received,1);
    assert.deepEqual((await readdir(folder)).filter(name=>name.endsWith('.md')),[],'uncertain write must not replay to disk');
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await execute(process.execPath,args,{env,windowsHide:true});
    assert.ok((await readFile(join(folder,'example.md'),'utf8')).includes('One handoff'));
  }finally{
    if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await rm(folder,{recursive:true,force:true});
  }
});
