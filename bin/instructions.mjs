#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {config} from '../lib/config.mjs';
import {storage} from '../lib/notes.mjs';
import {createInstructions,syncInstructions} from '../lib/instructions.mjs';

const usage=`Usage:
  instructions show [--json]
  instructions set --file path --version <version|new>
  instructions sync --target path/to/AGENTS.md [--check] [--replace-local] [--json]

Edit shared instructions in Local Collab. Bots pull them into AGENTS.md with sync.
The version comes from show --json; use new only for the first import.
Independent local edits are preserved unless --replace-local is explicitly used.`;
const {positionals,values:opts}=parseArgs({allowPositionals:true,options:{file:{type:'string'},version:{type:'string'},target:{type:'string'},json:{type:'boolean'},check:{type:'boolean'},'replace-local':{type:'boolean'},help:{type:'boolean',short:'h'}}});
const base=`http://127.0.0.1:${config.port}/api/instructions`;
const offline=createInstructions(storage);
async function call(method,body) {
  try {
    const response=await fetch(base,{method,headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();
    if(!response.ok)throw Object.assign(new Error(result.error??`HTTP ${response.status}`),{fromServer:true});
    return result;
  }catch(error) {
    if(error.fromServer||error.cause?.code!=='ECONNREFUSED')throw error;
    console.error('(Local Collab is stopped; using its configured storage.)');
    return method==='GET'?offline.get():offline.set(body);
  }
}
async function main() {
  const command=positionals[0];
  if(opts.help||!command)return console.log(usage);
  if(command==='show') {
    const value=await call('GET');
    if(opts.json)return console.log(JSON.stringify(value,null,2));
    if(value.version===null)throw new Error('No shared instructions saved yet');
    return process.stdout.write(value.text);
  }
  if(command==='set') {
    if(!opts.file||!opts.version)throw new Error('Pass --file and --version (use new for the first import)');
    const result=await call('PUT',{text:await readFile(opts.file,'utf8'),version:opts.version==='new'?null:opts.version});
    return console.log(`Shared instructions saved: ${result.version}`);
  }
  if(command==='sync') {
    if(!opts.target)throw new Error('Pass --target with the intended AGENTS.md');
    const result=await syncInstructions(await call('GET'),opts.target,{source:base,check:opts.check,replaceLocal:opts['replace-local']});
    console.log(opts.json?JSON.stringify(result):`${result.changed?(opts.check?'Needs sync':'Synced'):'Current'}: ${result.path} (${result.version})`);
    if(opts.check&&result.changed)process.exitCode=1;
    return;
  }
  throw new Error(usage);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
