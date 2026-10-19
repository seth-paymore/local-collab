import {readFile,writeFile,readdir,stat,mkdir,rename,rm} from "node:fs/promises";
import {join} from "node:path";
import {createHash,randomUUID} from "node:crypto";

const FILE = /^[a-z0-9][a-z0-9-]{0,80}\.md$/;
const digest = raw => createHash("sha256").update(raw).digest("hex");
const MAX_RESPONSE_BYTES = 2_000_000;
export class StorageError extends Error {
  constructor(status,message) {super(message);this.status=status;}
}
function validName(name) {
  if(!FILE.test(name)) throw new StorageError(400,"Invalid note file name");
}
async function responseJson(response) {
  const reader=response.body?.getReader();
  if(!reader)throw new StorageError(502,"Storage returned an empty response");
  let size=0;const chunks=[];
  try {
    if(Number(response.headers.get("content-length") ?? 0)>MAX_RESPONSE_BYTES)throw new Error("limit");
    for(;;) {
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>MAX_RESPONSE_BYTES)throw new Error("limit");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }catch {
    try {await reader.cancel();}catch {}
    throw new StorageError(502,"Storage returned an invalid, oversized or interrupted JSON response");
  }finally{reader.releaseLock();}
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
        for(let attempt=0;;attempt++) {
          try {await rename(temp,path);break;}
          catch(err) {
            if(attempt>=5 || !["EPERM","EBUSY","EACCES"].includes(err.code))throw err;
            await new Promise(resolve=>setTimeout(resolve,60*(attempt+1)));
          }
        }
      } finally {await rm(temp,{force:true});}
      return this.read(name);
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
  async function call(path,method="GET",raw,revision) {
    const token=env[auth.tokenEnv];
    if(!token?.trim() || /[\r\n]/.test(token))throw new StorageError(503,`Set ${auth.tokenEnv} for the configured storage provider`);
    const headers={Accept:"application/json",[header]:auth.type==="bearer"?`Bearer ${token.trim()}`:token.trim()};
    if(method==="PUT") {
      headers[revision===null?"If-None-Match":"If-Match"]=revision===null?"*":revision;
      headers["Content-Type"]="application/json";
    }
    let response;
    try {response=await fetcher(`${base.href.replace(/\/$/,"")}${path}`,{method,headers,redirect:"error",signal:AbortSignal.timeout(15000),...(method==="PUT"?{body:JSON.stringify({raw})}:{})});}
    catch {throw new StorageError(502,"Configured storage is unavailable. No fallback storage was used");}
    if(!response.ok) {
      try {await response.body?.cancel();}catch {}
      const status=response.status===404?404:[409,412].includes(response.status)?409:502;
      throw new StorageError(status,status===409?"This note changed in remote storage. Reload before editing":`Storage ${method} failed (HTTP ${response.status})`);
    }
    const value=await responseJson(response);
    return {value,etag:response.headers.get("etag")};
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
  };
}

export function createStorage(settings,directory) {
  if(settings.type==="filesystem")return createFileStorage(directory);
  if(settings.type==="http")return createHttpStorage(settings);
  throw new StorageError(400,"Storage type must be filesystem or http");
}
