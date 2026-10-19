import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
export async function startLocalServer(folder) {
  const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const env={...process.env,LOCAL_COLLAB_NOTES:folder,LOCAL_COLLAB_CONFIG:join(folder,'config.json'),LOCAL_COLLAB_PORT:String(port),LOCAL_COLLAB_AUTHOR:'Reviewer'};
  for(const key of Object.keys(env))if(/^ACTIVECOLLAB_/.test(key))delete env[key];
  const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  const ended=once(child,'exit');let errors='';child.stderr.on('data',value=>errors+=value);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('Local server startup timed out: '+errors));},10000);
    child.stdout.on('data',value=>{if(String(value).includes('listening')){clearTimeout(timer);resolve();}});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Local server exited: '+errors));});
  });
  return {base:`http://127.0.0.1:${port}`,env,async close(){child.kill();await ended;}};
}
