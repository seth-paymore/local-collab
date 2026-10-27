import {readFile,writeFile,rename,rm,lstat,open} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {StorageError} from './storage.mjs';

export const INSTRUCTIONS_FILE = 'agent-instructions.md';
const normalize = text => text.replace(/\r\n/g,'\n');
export const instructionsHash = text => createHash('sha256').update(normalize(text)).digest('hex');

// The reserved document uses the selected storage and its revision contract.
export function createInstructions(storage) {
  let pending = Promise.resolve();
  async function record() {
    try {return await storage.read(INSTRUCTIONS_FILE);}
    catch(error) {if(error.status===404)return null;throw error;}
  }
  const describe = value => ({text:value?.raw??'',version:value?instructionsHash(value.raw):null,modified:value?.modified??null});
  return {
    async get() {return describe(await record());},
    set(input) {
      const run=pending.then(async()=>{
        if(!input||typeof input!=='object'||Array.isArray(input))throw new StorageError(400,'Instructions require text and version');
        const {text,version}=input;
        if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>500_000||text.includes('\0'))throw new StorageError(400,'Instructions need nonempty text, at most 500 KB');
        const current=await record();
        if(version!==(current?instructionsHash(current.raw):null))throw new StorageError(409,'Shared instructions changed. Reload before saving');
        return describe(await storage.write(INSTRUCTIONS_FILE,normalize(text),current?.revision??null));
      });
      pending=run.catch(()=>{});
      return run;
    },
  };
}

async function readRegular(path) {
  try {
    const info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink())throw new Error(`Expected a regular file: ${path}`);
    return await readFile(path,'utf8');
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}
async function atomic(path,text) {
  const temp=`${path}.${randomUUID()}.tmp`;
  await writeFile(temp,text,{flag:'wx',mode:0o600});
  try {
    for(let attempt=0;;attempt++) {
      try {await rename(temp,path);break;}
      catch(error){if(attempt>=5||!['EPERM','EBUSY','EACCES'].includes(error.code))throw error;await new Promise(resolve=>setTimeout(resolve,60*(attempt+1)));}
    }
  }finally{await rm(temp,{force:true});}
}

// Pulls preserve independent local edits and back up each replaced file.
export async function syncInstructions(document,target,{source,replaceLocal=false,check=false}={}) {
  if(typeof document?.text!=='string'||!document.text.trim()||document.version!==instructionsHash(document.text))throw new Error('No valid shared instructions to sync');
  if(typeof source!=='string'||!source)throw new Error('A source identity is required');
  const path=resolve(target);
  if(basename(path).toUpperCase()!=='AGENTS.MD')throw new Error('The sync target must be named AGENTS.md');
  const receiptPath=path+'.local-collab.json',backupPath=path+'.local-collab-backup',lockPath=path+'.local-collab-lock';
  let lock;
  try {lock=await open(lockPath,'wx',0o600);}
  catch(error){if(error.code==='EEXIST')throw new Error('Another instruction sync is in progress; inspect the lock before retrying');throw error;}
  try {
    const local=await readRegular(path),receiptRaw=await readRegular(receiptPath);
    let receipt=null;
    if(receiptRaw!==null){try{receipt=JSON.parse(receiptRaw);}catch{throw new Error('Invalid instruction sync receipt; inspect it before replacing local instructions');}}
    const currentHash=local===null?null:instructionsHash(local);
    const managed=receipt?.source===source&&receipt?.hash===currentHash;
    if(local!==null&&currentHash!==document.version&&!managed&&!replaceLocal)throw new Error('Local AGENTS.md has independent changes. Update Local Collab first, or use --replace-local after reviewing them');
    const changed=local!==document.text;
    if(check)return {path,version:document.version,changed};
    if(changed) {
      await readRegular(backupPath);
      if(local!==null)await atomic(backupPath,local);
      if(await readRegular(path)!==local)throw new Error('Local instructions changed during sync; no replacement made');
      await atomic(path,document.text);
      if(await readRegular(path)!==document.text)throw new Error('Instruction sync readback failed');
    }
    await atomic(receiptPath,JSON.stringify({source,hash:document.version},null,2)+'\n');
    return {path,version:document.version,changed};
  }finally{await lock.close();await rm(lockPath,{force:true});}
}
