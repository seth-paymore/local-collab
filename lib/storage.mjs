import {readFile,writeFile,readdir,stat,mkdir,rename,rm} from "node:fs/promises";
import {join} from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {inspectImage,IMAGE_ID,MAX_IMAGE_BYTES,MAX_NOTE_IMAGES,MAX_NOTE_IMAGE_BYTES} from "./images.mjs";

const FILE = /^[a-z0-9][a-z0-9-]{0,80}\.md$/;
const digest = raw => createHash("sha256").update(raw).digest("hex");
const MAX_RESPONSE_BYTES = 2_000_000;
export class StorageError extends Error {
  constructor(status,message) {super(message);this.status=status;}
}
function validName(name) {
  if(!FILE.test(name)) throw new StorageError(400,"Invalid note file name");
}
async function responseBytes(response,limit=MAX_RESPONSE_BYTES) {
  const reader=response.body?.getReader();
  if(!reader)throw new StorageError(502,"Storage returned an empty response");
  let size=0;const chunks=[];
  try {
    if(Number(response.headers.get("content-length") ?? 0)>limit)throw new Error("limit");
    for(;;) {
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>limit)throw new Error("limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }catch {
    try {await reader.cancel();}catch {}
    throw new StorageError(502,"Storage returned an invalid, oversized or interrupted response");
  }finally{reader.releaseLock();}
}
async function responseJson(response) {
  const bytes=await responseBytes(response);
  try{return JSON.parse(bytes.toString("utf8"));}catch{throw new StorageError(502,"Storage returned invalid JSON");}
}
async function commitFile(temp,path) {
  for(let attempt=0;;attempt++) {
    try {await rename(temp,path);return;}
    catch(error){if(attempt>=5||!["EPERM","EBUSY","EACCES"].includes(error.code))throw error;await new Promise(resolve=>setTimeout(resolve,60*(attempt+1)));}
  }
}

export function createFileStorage(directory) {
  return {
    type:"filesystem", label:"Markdown files", location:directory,
    async list() {
      await mkdir(directory,{recursive:true});
      return (await readdir(directory)).filter(name=>FILE.test(name));
    },
    async read(name) {
      validName(name);
      try {
        const path=join(directory,name);
        const raw=await readFile(path,"utf8");
        return {raw,revision:digest(raw),modified:(await stat(path)).mtimeMs};
      } catch(err) {
        if(err.code==="ENOENT") throw new StorageError(404,`No note named ${name}`);
        throw err;
      }
    },
    async write(name,raw,revision) {
      validName(name);
      let current=null;
      try {current=await this.read(name);} catch(err) {if(err.status!==404)throw err;}
      if((current?.revision ?? null)!==revision) throw new StorageError(409,"This note changed in storage. Reload before editing");
      await mkdir(directory,{recursive:true});
      const path=join(directory,name), temp=join(directory,`${name}.${randomUUID()}.tmp`);
      await writeFile(temp,raw,"utf8");
      try {
        await commitFile(temp,path);
      } finally {await rm(temp,{force:true});}
      return this.read(name);
    },
    async putImage(name,bytes) {
      validName(name);await this.read(name);
      const info=inspectImage(bytes), folder=join(directory,".attachments",name);
      await mkdir(folder,{recursive:true,mode:0o700});
      try {return {...await this.getImage(name,info.id),created:false};}
      catch(error){if(error.status!==404)throw error;}
      const files=(await readdir(folder)).filter(file=>IMAGE_ID.test(file));
      const sizes=await Promise.all(files.map(file=>stat(join(folder,file)).then(s=>s.size)));
      if(files.length>=MAX_NOTE_IMAGES || sizes.reduce((a,b)=>a+b,0)+bytes.length>MAX_NOTE_IMAGE_BYTES)throw new StorageError(409,"This note has reached its image storage limit");
      const temp=join(folder,`${info.id}.${randomUUID()}.tmp`);
      await writeFile(temp,bytes,{flag:"wx",mode:0o600});
      try{await commitFile(temp,join(folder,info.id));}finally{await rm(temp,{force:true});}
      return {...await this.getImage(name,info.id),created:true};
    },
    async getImage(name,id) {
      validName(name);if(!IMAGE_ID.test(id))throw new StorageError(400,"Invalid image identifier");
      await this.read(name);
      try {
        const path=join(directory,".attachments",name,id);
        if((await stat(path)).size>MAX_IMAGE_BYTES)throw new StorageError(502,"Stored image is too large");
        const bytes=await readFile(path);return {...inspectImage(bytes,id),bytes};
      }catch(error){if(error.code==="ENOENT")throw new StorageError(404,"Image not found");throw error;}
    },
  };
}

export function createHttpStorage(settings,{fetch:fetcher=globalThis.fetch,env=process.env}={}) {
  const base=new URL(settings.baseUrl);
  const loopback=["127.0.0.1","localhost","[::1]"].includes(base.hostname);
  if((base.protocol!=="https:" && !(loopback && base.protocol==="http:")) || base.username || base.password || base.search || base.hash) throw new StorageError(400,"Storage baseUrl requires HTTPS (HTTP allowed on loopback) and no embedded credentials, query or fragment");
  const auth=settings.auth ?? {type:"bearer",tokenEnv:"LOCAL_COLLAB_STORAGE_TOKEN"};
  if(!["bearer","api-key"].includes(auth.type) || !/^[A-Z][A-Z0-9_]*$/.test(auth.tokenEnv ?? ""))throw new StorageError(400,"Configure storage auth type and tokenEnv");
  const header=auth.type==="bearer"?"Authorization":auth.header ?? "X-API-Key";
  if(!/^[A-Za-z][A-Za-z0-9-]*$/.test(header) || /^(host|content-type|content-length|if-match|if-none-match)$/i.test(header)) throw new StorageError(400,"Invalid storage authentication header");
  async function request(path,method="GET",extra={},body,allowExisting=false) {
    const token=env[auth.tokenEnv];
    if(!token?.trim() || /[\r\n]/.test(token))throw new StorageError(503,`Set ${auth.tokenEnv} for the configured storage provider`);
    const headers={Accept:"application/json",...extra,[header]:auth.type==="bearer"?`Bearer ${token.trim()}`:token.trim()};
    let response;
    try {response=await fetcher(`${base.href.replace(/\/$/,"")}${path}`,{method,headers,redirect:"error",signal:AbortSignal.timeout(15000),...(body===undefined?{}:{body})});}
    catch {throw new StorageError(502,"Configured storage is unavailable. No fallback storage was used");}
    if(!response.ok && !(allowExisting&&response.status===412)) {
      try {await response.body?.cancel();}catch {}
      const status=response.status===404?404:[409,412].includes(response.status)?409:502;
      throw new StorageError(status,path.includes('/attachments/')?`Configured storage image request failed (HTTP ${response.status}). Check attachment support, permissions and storage limits`:status===409?"This note changed in remote storage. Reload before editing":`Storage ${method} failed (HTTP ${response.status})`);
    }
    return response;
  }
  async function call(path,method="GET",raw,revision) {
    const response=await request(path,method,method==="PUT"?{[revision===null?"If-None-Match":"If-Match"]:revision===null?"*":revision,"Content-Type":"application/json"}:{},method==="PUT"?JSON.stringify({raw}):undefined);
    return {value:await responseJson(response),etag:response.headers.get("etag")};
  }
  function record({value,etag}) {
    if(!value || typeof value!=="object")throw new StorageError(502,"Storage returned an invalid record");
    const revision=etag ?? value.version;
    if(typeof value.raw!=="string" || !Number.isFinite(value.modified) || value.modified<0 || typeof revision!=="string" || !/^"[^"\r\n]{1,250}"$/.test(revision))throw new StorageError(502,"Storage record requires raw, modified and a strong quoted ETag/version");
    return {raw:value.raw,modified:value.modified,revision};
  }
  return {
    type:"http",label:settings.label ?? "Authenticated storage API",location:base.origin,
    async list() {
      const {value}=await call("/notes");
      const items=Array.isArray(value)?value:value.notes;
      if(!Array.isArray(items) || items.length>10000)throw new StorageError(502,"Storage must return a notes array (maximum 10000)");
      const names=items.map(item=>typeof item==="string"?item:item.name);
      if(names.some(name=>typeof name!=="string" || !FILE.test(name)) || new Set(names).size!==names.length)throw new StorageError(502,"Storage returned invalid or duplicate note names");
      return names;
    },
    async read(name) {validName(name);return record(await call(`/notes/${encodeURIComponent(name)}`));},
    async write(name,raw,revision) {
      validName(name);
      const result=record(await call(`/notes/${encodeURIComponent(name)}`,"PUT",raw,revision));
      if(result.raw!==raw)throw new StorageError(502,"Storage write readback did not match the submitted note");
      return result;
    },
    async putImage(name,bytes) {
      validName(name);const info=inspectImage(bytes);
      const response=await request(`/notes/${encodeURIComponent(name)}/attachments/${info.id}`,"PUT",{"Content-Type":info.type,"If-None-Match":"*"},bytes,true);
      if(response.status===412){try{await response.body?.cancel();}catch{}await this.getImage(name,info.id);return {...info,created:false};}
      const value=await responseJson(response);
      if(["id","type","size","width","height"].some(key=>value[key]!==info[key]))throw new StorageError(502,"Storage image write readback did not match");
      return {...info,created:response.status===201};
    },
    async getImage(name,id) {
      validName(name);if(!IMAGE_ID.test(id))throw new StorageError(400,"Invalid image identifier");
      const response=await request(`/notes/${encodeURIComponent(name)}/attachments/${id}`,"GET",{Accept:"image/png, image/jpeg, image/gif, image/webp"});
      const bytes=await responseBytes(response,MAX_IMAGE_BYTES),info=inspectImage(bytes,id);
      if(response.headers.get("content-type")!==info.type)throw new StorageError(502,"Storage image Content-Type did not match");
      return {...info,bytes};
    },
  };
}

export function createStorage(settings,directory) {
  if(settings.type==="filesystem")return createFileStorage(directory);
  if(settings.type==="http")return createHttpStorage(settings);
  throw new StorageError(400,"Storage type must be filesystem or http");
}
