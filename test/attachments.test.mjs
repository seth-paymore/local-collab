import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectImage,MAX_IMAGE_BYTES} from '../lib/images.mjs';
import {createFileStorage} from '../lib/storage.mjs';
import {imageMarkdown,imageHtml,imageType} from '../public/images.mjs';
import {png,jpeg,gif,webp,animatedPng,animatedGif,animatedWebp} from '../test-support/image-fixtures.mjs';
import {startLocalServer} from '../test-support/local-server.mjs';

test('raster checks reject active content, truncation, oversized files and excessive dimensions',()=>{
  for(const [bytes,type] of [[png,'image/png'],[jpeg,'image/jpeg'],[gif,'image/gif'],[webp,'image/webp']]){
    const info=inspectImage(bytes);assert.equal(info.type,type);assert.equal(info.width,3);assert.equal(info.height,2);
    assert.equal(imageType(bytes),type);assert.match(info.id,/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/);
    assert.throws(()=>inspectImage(bytes.subarray(0,-3)),error=>error.status===415);
  }
  for(const text of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>','<html><script>alert(1)</script></html>'])assert.throws(()=>inspectImage(Buffer.from(text)),error=>error.status===415);
  assert.throws(()=>inspectImage(Buffer.alloc(MAX_IMAGE_BYTES+1)),error=>error.status===413);
  const huge=Buffer.from(png);huge.writeUInt32BE(100000,16);
  assert.throws(()=>inspectImage(huge),error=>error.status===413);
  assert.throws(()=>inspectImage(png,`${'a'.repeat(64)}.png`),error=>error.status===400);
  for(const bytes of [animatedPng,animatedGif,animatedWebp])assert.equal(inspectImage(bytes).width,3);
  const tooMany=Buffer.from(animatedPng);tooMany.writeUInt32BE(201,tooMany.indexOf('acTL')+4);
  assert.throws(()=>inspectImage(tooMany),error=>error.status===413);
  const miscount=Buffer.from(animatedPng);miscount.writeUInt32BE(1,miscount.indexOf('acTL')+4);
  assert.throws(()=>inspectImage(miscount),error=>error.status===415);
  const bigCanvas=Buffer.from(animatedPng);bigCanvas.writeUInt32BE(8000,16);bigCanvas.writeUInt32BE(2000,20);
  bigCanvas.writeUInt32BE(7,bigCanvas.indexOf('acTL')+4);
  assert.throws(()=>inspectImage(bigCanvas),error=>error.status===413);
  const bigFrame=Buffer.from(animatedWebp);bigFrame.writeUInt16LE(16383,bigFrame.indexOf('VP8 ')+14);
  assert.throws(()=>inspectImage(bigFrame),error=>error.status===413);
  const offCanvas=Buffer.from(animatedGif);offCanvas.writeUInt16LE(100,offCanvas.indexOf(Buffer.from([44,0,0,0,0,3,0,2,0]))+1);
  assert.throws(()=>inspectImage(offCanvas),error=>error.status===415);
});

test('image references cannot render arbitrary URLs, active formats or injected markup',()=>{
  const path=`/api/notes/example.md/attachments/${inspectImage(png).id}`;
  const html=imageHtml('" onerror="alert(1)<script>',path);
  assert.ok(html.includes('alt="&quot; onerror=&quot;alert(1)&lt;script&gt;"'));
  assert.ok(!html.includes('<script>'));assert.ok(html.includes('loading="lazy"'));
  assert.ok(imageMarkdown('bad]name\n.png',path).startsWith('![bad_name_.png]'));
  for(const unsafe of ['https://tracker.example/image.png','javascript:alert(1)','/api/notes/a.md/attachments/../secret','data:image/svg+xml,evil'])assert.throws(()=>imageHtml('image',unsafe),/Invalid image/);
});

test('filesystem images are scoped to existing notes, deduplicated and omitted from the Markdown index',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'collab-images-file-'));
  try{
    const storage=createFileStorage(folder);
    await assert.rejects(storage.putImage('missing.md',png),error=>error.status===404);
    await storage.write('one.md','first',null);await storage.write('two.md','second',null);
    const image=await storage.putImage('one.md',png);
    assert.equal(image.created,true);assert.equal((await storage.putImage('one.md',png)).created,false);
    assert.deepEqual((await storage.getImage('one.md',image.id)).bytes,png);
    await assert.rejects(storage.getImage('two.md',image.id),error=>error.status===404);
    await assert.rejects(storage.getImage('one.md','../escape.png'),error=>error.status===400);
    assert.deepEqual((await storage.list()).sort(),['one.md','two.md']);
    assert.equal((await readdir(join(folder,'.attachments','one.md'))).length,1);
    const variant=index=>Buffer.concat([jpeg.subarray(0,2),Buffer.from([255,254,0,4,index,0]),jpeg.subarray(2)]);
    for(let i=0;i<49;i++)await storage.putImage('one.md',variant(i));
    await assert.rejects(storage.putImage('one.md',variant(49)),error=>error.status===409);
    assert.equal((await storage.putImage('one.md',png)).created,false);
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('local upload, image-only entry, safe save retries, CLI and restart preserve images without tracker access',{timeout:20000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),'collab-images-app-'));
  let app=await startLocalServer(folder);
  const json=async(path,body)=>{
    const response=await fetch(app.base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {response,value:await response.json()};
  };
  try{
    await json('/notes',{topic:'Images'});await json('/notes',{topic:'Other'});
    const upload=(bytes=png,extra={})=>fetch(app.base+'/api/notes/images.md/attachments',{method:'POST',headers:{'Content-Type':'image/png','X-Local-Collab':'1',...extra},body:bytes});
    assert.equal((await upload(png,{Origin:'https://attacker.example'})).status,403);
    assert.equal((await fetch(app.base+'/api/notes/images.md/attachments',{method:'POST',headers:{'Content-Type':'image/png'},body:png})).status,403);
    assert.equal((await upload(Buffer.from('<svg/>'))).status,415);
    assert.equal((await upload(jpeg)).status,415);
    assert.equal((await upload(Buffer.alloc(MAX_IMAGE_BYTES+1))).status,413);
    const response=await upload();assert.equal(response.status,201);
    const image=await response.json(),text=imageMarkdown('Screenshot.png',image.url);
    const requestId='dba39211-191d-41a8-8a90-9da600e7cdde';
    let note=(await json('/notes/images.md/entries',{text,requestId})).value;
    assert.equal(note.entries.length,1);assert.equal(note.entries[0].text,text);assert.equal(note.entries[0].author,'Reviewer');
    note=(await json('/notes/images.md/entries',{text,requestId})).value;assert.equal(note.entries.length,1);
    assert.equal((await json('/notes/images.md/entries',{text:'different',requestId})).response.status,409);
    const binary=await fetch(app.base+image.url);assert.equal(binary.headers.get('content-type'),'image/png');assert.equal(binary.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await binary.arrayBuffer()),png);
    assert.equal((await fetch(app.base+image.url.replace('images.md','other.md'))).status,404);
    const imagePath=join(folder,'fixture.png');await writeFile(imagePath,png);
    const cli=fileURLToPath(new URL('../bin/note.mjs',import.meta.url));
    const run=spawnSync(process.execPath,[cli,'upload','images','--file',imagePath,'--json'],{env:app.env,encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).id,image.id);
    const cliEnv=app.env;await app.close();app=null;
    const offline=spawnSync(process.execPath,[cli,'upload','images','--file',imagePath,'--json'],{env:cliEnv,encoding:'utf8'});
    assert.equal(offline.status,0,offline.stderr);assert.equal(JSON.parse(offline.stdout).id,image.id);
    app=await startLocalServer(folder);
    assert.deepEqual(Buffer.from(await (await fetch(app.base+image.url)).arrayBuffer()),png);
    assert.equal((await json('/notes/images')).value.entries.length,1);
  }finally{if(app)await app.close();await rm(folder,{recursive:true,force:true});}
});
