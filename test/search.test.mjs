import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {searchRecords} from '../lib/search.mjs';
import {searchTerms,highlightSearch} from '../public/search-query.mjs';

const record=(file,title,raw,modified=0,ticket='') => ({note:{file,title,ticket,status:'done'},raw,modified});

test('all words can span entries; quoted phrases require adjacent words',()=>{
  const records=[record('example.md','Authentication','## Agent One\nLogin works.\n\n## Agent Two\nSession retry verified.')];
  assert.equal(searchRecords(records,'LOGIN retry').length,1);
  assert.equal(searchRecords(records,'login missing').length,0);
  assert.equal(searchRecords(records,'"login retry"').length,0);
  assert.equal(searchRecords(records,'"session retry" LOGIN').length,1);
  assert.equal(searchRecords(records,'   ').length,0);
  assert.equal(searchRecords(records,'a').length,0);
  assert.deepEqual(searchTerms(' LOGIN login "session   retry" '),['login','session retry']);
  assert.equal(searchRecords([record('file-name.md','Other','')],'file-name').length,1);
});

test('ticket, title and phrase relevance outrank recency, before the result limit',()=>{
  const records=Array.from({length:65},(_,i)=>record(`body-${i}.md`,'Other','login retry',100+i));
  records.push(record('title.md','Login retry','',0));
  records.push(record('reversed.md','Retry after login','',1));
  records.push(record('ac-123.md','Ticket','',0,'123'));
  records.push(record('ac-1234.md','Longer number','123',1000,'1234'));
  let results=searchRecords(records,'login retry');
  assert.equal(results.length,60);
  assert.deepEqual(results.slice(0,3).map(result=>result.file),['title.md','reversed.md','body-64.md']);
  assert.equal(results[0].status,'done');
  for (const query of ['123','#123','ac-123','ac-123.md']) {
    assert.equal(searchRecords(records,query)[0].file,'ac-123.md');
  }
  assert.deepEqual(searchRecords(records,'#123').map(result=>result.file),['ac-123.md']);
  assert.equal(searchRecords([record('ac-123.md','Login','',0,'123')],'#123 login').length,1);
});

test('excerpts show distant matching words and real source line numbers',()=>{
  const raw=`Header\r\n${'earlier context '.repeat(90)}LOGIN succeeded.\r\n${'different context '.repeat(70)}Retry confirmed.`;
  const [result]=searchRecords([record('long.md','Other',raw)],'login retry');
  assert.ok(result.hits.some(hit=>hit.text.includes('LOGIN')));
  assert.ok(result.hits.some(hit=>hit.text.includes('Retry')));
  assert.ok(result.hits.some(hit=>hit.line===2));
  assert.ok(result.hits.some(hit=>hit.line===3));
  assert.ok(result.hits.every(hit=>hit.text.length<=242));
  const [phrase]=searchRecords([record('phrase.md','Other','prefix\nsession\nexpiry confirmed')],'"session expiry"');
  assert.ok(phrase.hits.some(hit=>hit.text.includes('session expiry')));
});

test('literal punctuation, Unicode and highlighted markup stay safe',()=>{
  const records=[record('literal.md','Other','C++ [retry] café <img onerror="bad"> & login')];
  assert.equal(searchRecords(records,'c++ [retry] café').length,1);
  assert.equal(searchRecords(records,'.*').length,0);
  assert.equal(highlightSearch('<img onerror="bad"> & login','img login'),
    '&lt;<mark>img</mark> onerror=&quot;bad&quot;&gt; &amp; <mark>login</mark>');
  assert.equal(highlightSearch('&amp;','amp'),'&amp;<mark>amp</mark>;');
  assert.equal(highlightSearch('C++ [retry] CAFÉ','c++ [retry] café'),
    '<mark>C++</mark> <mark>[retry]</mark> <mark>CAFÉ</mark>');
});

test('HTTP search, CLI JSON/text and offline CLI use the same ranked private notes',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'local-collab-search-'));
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const env={...process.env,LOCAL_COLLAB_CONFIG:join(folder,'missing.json'),LOCAL_COLLAB_NOTES:folder,LOCAL_COLLAB_PORT:String(port)};
  for(const key of Object.keys(env))if(/^ACTIVECOLLAB_|^ACTIVE_COLLAB$/.test(key))delete env[key];
  await writeFile(join(folder,'example.md'),'---\ntitle: Login retry\nstatus: done\n---\nLogin is good.\n\nRetry is good.');
  const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  const ended=once(child,'exit');let stderr='',stopped=false;
  child.stderr.on('data',chunk=>{stderr+=chunk});
  const cli=async(json=true)=>promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../bin/note.mjs',import.meta.url)),'search','login','retry',...(json?['--json']:[])],{env,windowsHide:true});
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`Search server startup: ${stderr}`)),10000);
      child.stdout.on('data',chunk=>{if(String(chunk).includes('listening')){clearTimeout(timer);resolve()}});
      child.once('error',error=>{clearTimeout(timer);reject(error)});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error(stderr))});
    });
    const base=`http://127.0.0.1:${port}`;
    const response=await fetch(`${base}/api/search?q=login%20retry`);
    assert.equal(response.status,200);
    const {results}=await response.json();
    assert.equal(results.length,1);
    assert.equal(results[0].file,'example.md');
    assert.ok(results[0].hits.every(hit=>!hit.text.includes('title:')));
    assert.deepEqual(JSON.parse((await cli()).stdout),results);
    assert.match((await cli(false)).stdout,/Login retry/);
    assert.equal((await fetch(`${base}/search-query.mjs`)).status,200);
    child.kill();await ended;stopped=true;
    assert.deepEqual(JSON.parse((await cli()).stdout),results);
  } finally {
    if(!stopped){child.kill();await ended;}
    await rm(folder,{recursive:true,force:true});
  }
});
