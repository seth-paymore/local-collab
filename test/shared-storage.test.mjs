import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {request} from 'node:http';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openDatabase, restoreDatabase, MAX_RAW_BYTES} from '../storage-service/database.mjs';
import {createStorageServer} from '../storage-service/http.mjs';
import {createHttpStorage} from '../lib/storage.mjs';
import {png,jpeg} from '../test-support/image-fixtures.mjs';
import {inspectImage} from '../lib/images.mjs';

const [major, minor] = process.versions.node.split('.').map(Number);
const options = {timeout: 10000, skip: major < 22 || (major === 22 && minor < 13) ? 'Optional SQLite storage service requires Node.js 22.13+' : false};
function rawRequest(url, settings = {}, text) {
  return new Promise((resolve, reject) => {
    const req = request(url, settings, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, text: Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject); req.end(text);
  });
}
async function fixture(settings = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'collab-secure-'));
  let time = Date.now();
  const path = join(folder, 'notes.sqlite');
  const database = await openDatabase(path, {create: true, now: () => time, ...settings.database});
  database.createWorkspace('alpha'); database.createWorkspace('beta');
  const writer = database.issue({workspace: 'alpha', principal: 'agent-one', role: 'write'});
  const reader = database.issue({workspace: 'alpha', principal: 'reviewer'});
  const outsider = database.issue({workspace: 'beta', principal: 'agent-two', role: 'write'});
  const events = [];
  const server = createStorageServer({database, now: () => time, onEvent: e => events.push(e), ...settings.server});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, base = `${origin}/v1/workspaces/alpha`;
  async function call(path = '/notes', {token = writer.token, method = 'GET', raw, headers = {}, workspace = 'alpha', url} = {}) {
    return fetch(url ?? `${origin}/v1/workspaces/${workspace}${path}`, {method, headers: {...(token ? {Authorization: `Bearer ${token}`} : {}), ...(raw === undefined ? {} : {'Content-Type': 'application/json'}), ...headers}, ...(raw === undefined ? {} : {body: JSON.stringify({raw})})});
  }
  return {folder, path, database, server, writer, reader, outsider, events, origin, base, call,
    advance(ms) { time += ms; },
    async close() { server.closeAllConnections(); await new Promise(r => server.close(r)); database.close(); await rm(folder, {recursive: true, force: true}); },
  };
}

test('shared storage denies unauthenticated, cross-workspace, read-only, expired and revoked clients', options, async () => {
  const f = await fixture();
  try {
    for (const token of [null, 'invalid', `lc_${'a'.repeat(43)}`]) assert.equal((await f.call('/notes', {token})).status, 401);
    let response = await f.call('/notes/plan.md', {method: 'PUT', raw: '# Forged Author\nPrivate note', headers: {'If-None-Match': '*'}});
    assert.equal(response.status, 201);
    const version = response.headers.get('etag');
    assert.equal((await f.call('/notes', {token: f.reader.token})).status, 200);
    assert.equal((await f.call('/notes/plan.md', {token: f.reader.token, method: 'PUT', raw: 'forbidden', headers: {'If-Match': version}})).status, 403);
    for (const path of ['/notes', '/notes/plan.md', '/notes/plan.md/history', `/notes/plan.md/revisions/${version.slice(1, -1)}`]) {
      assert.equal((await f.call(path, {token: f.outsider.token})).status, 403, path);
    }
    assert.equal((await f.call('/notes/plan.md', {token: f.outsider.token, method: 'PUT', raw: 'cross-tenant', headers: {'If-Match': version}})).status, 403);
    assert.deepEqual(await (await f.call('/notes', {token: f.outsider.token, workspace: 'beta'})).json(), {notes: []});
    assert.equal((await f.call('/notes', {workspace: 'nonexistent'})).status, 403);
    const history = await (await f.call('/notes/plan.md/history')).json();
    assert.equal(history.entries[0].principal, 'agent-one');
    assert.equal(history.entries[0].credential_id, f.writer.id);
    assert.ok(!('raw' in history.entries[0]));
    f.database.revoke(f.reader.id);
    assert.equal((await f.call('/notes', {token: f.reader.token})).status, 401);
    const expired = f.database.issue({workspace: 'alpha', principal: 'short-lived', days: 1});
    f.advance(86400001);
    assert.equal((await f.call('/notes', {token: expired.token})).status, 401);
    const output = JSON.stringify({events: f.events, credentials: f.database.credentials()});
    assert.ok(!output.includes(f.writer.token)); assert.ok(!output.includes('Private note'));
    assert.ok(!output.includes('digest'));
    assert.equal((await f.call('/notes/plan.md')).headers.get('cache-control'), 'no-store');
  } finally { await f.close(); }
});

test('real HTTP adapter interoperates with the secured database and stale writes never replace newer notes', options, async () => {
  const f = await fixture();
  try {
    const storage = createHttpStorage({baseUrl: f.base, auth: {type: 'bearer', tokenEnv: 'TEST_STORAGE_TOKEN'}}, {env: {TEST_STORAGE_TOKEN: f.writer.token}});
    assert.deepEqual(await storage.list(), []);
    const first = await storage.write('handoff.md', 'Original Markdown\n', null);
    assert.equal((await storage.read('handoff.md')).raw, 'Original Markdown\n');
    await assert.rejects(storage.write('handoff.md', 'duplicate create', null), error => error.status === 409);
    const newer = await storage.write('handoff.md', 'Newer Markdown\n', first.revision);
    await assert.rejects(storage.write('handoff.md', 'stale overwrite', first.revision), error => error.status === 409);
    assert.deepEqual(await storage.read('handoff.md'), newer);
    const history = await (await f.call('/notes/handoff.md/history')).json();
    assert.equal(history.entries.length, 2);
    assert.equal(history.entries[0].previous, first.revision.slice(1, -1));
    const old = await (await f.call(`/notes/handoff.md/revisions/${first.revision.slice(1, -1)}`)).json();
    assert.equal(old.raw, first.raw);
    const failed = await f.call('/notes/handoff.md', {method: 'PUT', raw: 'unconditional'});
    assert.equal(failed.status, 428);
  } finally { await f.close(); }
});

test('independent service connections use atomic database conditions for concurrent create and edit', options, async () => {
  const f = await fixture();
  const second = await openDatabase(f.path);
  const server = createStorageServer({database: second});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/v1/workspaces/alpha/notes/race.md`;
  try {
    const created = await Promise.all([f.call('/notes/race.md', {method: 'PUT', raw: 'one', headers: {'If-None-Match': '*'}}), f.call('', {url, method: 'PUT', raw: 'two', headers: {'If-None-Match': '*'}})]);
    assert.deepEqual(created.map(r => r.status).sort(), [201, 412]);
    const etag = (await f.call('/notes/race.md')).headers.get('etag');
    const edited = await Promise.all([f.call('/notes/race.md', {method: 'PUT', raw: 'three', headers: {'If-Match': etag}}), f.call('', {url, method: 'PUT', raw: 'four', headers: {'If-Match': etag}})]);
    assert.deepEqual(edited.map(r => r.status).sort(), [200, 412]);
    assert.equal((await (await f.call('/notes/race.md/history')).json()).entries.length, 2);
    assert.ok(f.database.integrity());
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); second.close(); await f.close(); }
});

test('gateway rejects foreign hosts/origins, malformed requests, unsafe methods and workspace quota overflow', options, async () => {
  const f = await fixture({database: {maxNotes: 1}});
  try {
    assert.equal((await rawRequest(`${f.base}/notes`, {headers: {Host: 'attacker.example', Authorization: `Bearer ${f.writer.token}`}})).status, 421);
    assert.equal((await f.call('/notes', {headers: {Origin: 'https://attacker.example'}})).status, 403);
    assert.equal((await f.call('/notes', {headers: {Origin: 'null'}})).status, 403);
    assert.equal((await f.call('/notes', {method: 'DELETE'})).status, 405);
    assert.equal((await f.call('/notes?token=secret')).status, 400);
    assert.equal((await f.call('/notes/evil%2fpath.md')).status, 400);
    const write = (raw, headers = {}) => f.call('/notes/a.md', {method: 'PUT', raw, headers: {'If-None-Match': '*', ...headers}});
    assert.equal((await write('x', {'Content-Type': 'text/plain'})).status, 415);
    assert.equal((await write('x', {'Content-Encoding': 'gzip'})).status, 415);
    assert.equal((await write('x', {'If-Match': '"arbitrary"'})).status, 400);
    assert.equal((await write('x'.repeat(MAX_RAW_BYTES + 1))).status, 413);
    // The declared-size guard rejects before reading the body. Sending that body
    // anyway can race the gateway's Connection: close response on macOS.
    const oversized=await rawRequest(`${f.base}/notes/a.md`,{method:'PUT',headers:{Authorization:`Bearer ${f.writer.token}`,'Content-Type':'application/json','Content-Length':800001,'If-None-Match':'*'}});
    assert.equal(oversized.status,413);
    const malformed = await rawRequest(`${f.base}/notes/a.md`, {method: 'PUT', headers: {Authorization: `Bearer ${f.writer.token}`, 'Content-Type': 'application/json', 'If-None-Match': '*'}}, '{not json');
    assert.equal(malformed.status, 400);
    assert.equal((await write('accepted')).status, 201);
    assert.equal((await f.call('/notes/b.md', {method: 'PUT', raw: 'too many', headers: {'If-None-Match': '*'}})).status, 409);
    assert.deepEqual(f.database.list(f.writer.token, 'alpha'), ['a.md']);
    assert.throws(() => createStorageServer({database: f.database, publicOrigin: 'http://notes.example'}), /HTTPS/);
  } finally { await f.close(); }
});

test('history cannot exhaust a workspace storage budget through repeated empty edits', options, async () => {
  const f = await fixture({database: {maxWorkspaceBytes: 2048}});
  try {
    const first = f.database.write(f.writer.token, 'alpha', 'budget.md', '', null);
    const second = f.database.write(f.writer.token, 'alpha', 'budget.md', '', first.version);
    assert.throws(() => f.database.write(f.writer.token, 'alpha', 'budget.md', '', second.version), error => error.status === 409);
    assert.equal(f.database.history(f.writer.token, 'alpha', 'budget.md').length, 2);
    assert.equal(f.database.read(f.writer.token, 'alpha', 'budget.md').version, second.version);
  } finally { await f.close(); }
});

test('history pagination preserves every accepted revision and recovery adds a new attributed version', options, async () => {
  const f = await fixture();
  try {
    let note = f.database.write(f.writer.token, 'alpha', 'history.md', 'original', null);
    const original = note;
    for (let i = 0; i < 102; i++) note = f.database.write(f.writer.token, 'alpha', 'history.md', `revision ${i}`, note.version);
    const page = await (await f.call('/notes/history.md/history')).json();
    assert.equal(page.entries.length, 100); assert.ok(page.next);
    const rest = await (await f.call(`/notes/history.md/history?before=${page.next}`)).json();
    assert.equal(rest.entries.length, 3); assert.equal(rest.next, null);
    const recovered = await f.call('/notes/history.md', {method: 'PUT', raw: original.raw, headers: {'If-Match': note.version}});
    assert.equal(recovered.status, 200);
    assert.equal(f.database.history(f.writer.token, 'alpha', 'history.md')[0].previous, note.version.slice(1, -1));
    assert.equal(f.database.read(f.writer.token, 'alpha', 'history.md').raw, 'original');
    const {DatabaseSync} = await import('node:sqlite');
    const inspection = new DatabaseSync(f.path);
    try {
      assert.throws(() => inspection.exec('DELETE FROM revisions'), /append only/);
      assert.throws(() => inspection.exec("UPDATE events SET event='altered'"), /append only/);
    } finally { inspection.close(); }
  } finally { await f.close(); }
});

test('an in-flight write rechecks revoked credentials before committing the note', options, async () => {
  const f = await fixture();
  try {
    let accepted;
    const authenticated = new Promise(resolve => { accepted = resolve; });
    const authorize = f.database.authorize;
    f.database.authorize = (...args) => { const actor = authorize(...args); accepted(); return actor; };
    const response = new Promise((resolve, reject) => {
      const req = request(`${f.base}/notes/revoked.md`, {method: 'PUT', headers: {Authorization: `Bearer ${f.writer.token}`, 'Content-Type': 'application/json', 'If-None-Match': '*'}}, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.write('{"raw":"');
      authenticated.then(() => { f.database.revoke(f.writer.id); req.end('must not commit"}'); }).catch(reject);
    });
    assert.equal(await response, 401);
    assert.deepEqual(f.database.list(f.reader.token, 'alpha'), []);
  } finally { await f.close(); }
});

test('request limits apply per client and expire without trusting forwarded addresses', options, async () => {
  const f = await fixture({server: {requestsPerMinute: 2, attemptsPerMinute: 20}});
  try {
    assert.equal((await f.call()).status, 200);
    assert.equal((await f.call()).status, 200);
    const limited = await f.call('/notes', {headers: {'X-Forwarded-For': '192.0.2.1'}});
    assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal((await f.call('/notes', {token: f.reader.token})).status, 200);
    f.advance(60001); assert.equal((await f.call()).status, 200);
  } finally { await f.close(); }
});

test('private snapshot restores note history and credentials into a new database without overwriting files', options, async () => {
  const f = await fixture();
  try {
    const first = f.database.write(f.writer.token, 'alpha', 'plan.md', 'before backup', null);
    const backup = join(f.folder, 'snapshot.sqlite'), destination = join(f.folder, 'restored.sqlite');
    await f.database.backup(backup);
    f.database.write(f.writer.token, 'alpha', 'plan.md', 'after backup', first.version);
    await assert.rejects(f.database.backup(backup), /EEXIST/);
    await restoreDatabase(backup, destination);
    await assert.rejects(restoreDatabase(backup, destination), /EEXIST/);
    const restored = await openDatabase(destination);
    try {
      assert.ok(restored.integrity());
      assert.equal(restored.read(f.writer.token, 'alpha', 'plan.md').raw, 'before backup');
      assert.equal(restored.history(f.writer.token, 'alpha', 'plan.md').length, 1);
      assert.equal(restored.credentials().length, 3);
      assert.ok(!(await readFile(backup)).includes(Buffer.from(f.writer.token)));
      if (process.platform !== 'win32') assert.equal((await stat(backup)).mode & 0o777, 0o600);
    } finally { restored.close(); }
  } finally { await f.close(); }
});

test('administration CLI writes a credential only to its exclusive private file and never stdout', options, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'collab-admin-'));
  const cli = fileURLToPath(new URL('../storage-service/cli.mjs', import.meta.url));
  const path = join(folder, 'db.sqlite'), tokenFile = join(folder, 'agent.token');
  const run = args => spawnSync(process.execPath, [cli, ...args, '--db', path], {encoding: 'utf8'});
  try {
    assert.equal(run(['init']).status, 0);
    assert.equal(run(['workspace', '--workspace', 'team']).status, 0);
    const result = run(['issue', '--workspace', 'team', '--principal', 'agent-one', '--role', 'write', '--out', tokenFile]);
    assert.equal(result.status, 0, result.stderr);
    const token = (await readFile(tokenFile, 'utf8')).trim();
    assert.match(token, /^lc_[A-Za-z0-9_-]{43}$/);
    assert.ok(!result.stdout.includes(token)); assert.ok(!result.stderr.includes(token));
    const retry = run(['issue', '--workspace', 'team', '--principal', 'agent-one', '--role', 'write', '--out', tokenFile]);
    assert.notEqual(retry.status, 0);
    assert.equal(JSON.parse(run(['credentials']).stdout).length, 1);
    const {id} = JSON.parse(result.stdout);
    assert.equal(JSON.parse(run(['revoke', '--id', id]).stdout).revoked, true);
    const db = await openDatabase(path);
    try { assert.throws(() => db.authorize(token, 'team'), error => error.status === 401); }
    finally { db.close(); }
  } finally { await rm(folder, {recursive: true, force: true}); }
});

test('HTTP client bounds streamed responses before buffering an entire oversized upstream body', async () => {
  let cancelled = false, chunks = 0;
  const fetcher = async () => new Response(new ReadableStream({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(500000)); },
    cancel() { cancelled = true; },
  }));
  const storage = createHttpStorage({baseUrl: 'https://storage.example', auth: {type: 'bearer', tokenEnv: 'TEST_TOKEN'}}, {env: {TEST_TOKEN: 'synthetic'}, fetch: fetcher});
  await assert.rejects(storage.list(), error => error.status === 502 && /oversized/.test(error.message));
  assert.ok(cancelled); assert.ok(chunks <= 6);
});

test('shared images enforce workspace roles, immutable content, budgets and snapshot recovery',options,async()=>{
  const f=await fixture({database:{maxWorkspaceBytes:3500}});
  try{
    f.database.write(f.writer.token,'alpha','image.md','note',null);
    const storage=createHttpStorage({baseUrl:f.base,auth:{type:'bearer',tokenEnv:'TEST_TOKEN'}},{env:{TEST_TOKEN:f.writer.token}});
    const image=await storage.putImage('image.md',png);assert.equal(image.created,true);
    assert.equal((await storage.putImage('image.md',png)).created,false);
    assert.deepEqual((await storage.getImage('image.md',image.id)).bytes,png);
    const url=`${f.base}/notes/image.md/attachments/${image.id}`;
    for(const token of [null,f.outsider.token]){
      const response=await fetch(url,{headers:token?{Authorization:`Bearer ${token}`}:{}});
      assert.equal(response.status,token?403:401);
    }
    const read=await fetch(url,{headers:{Authorization:`Bearer ${f.reader.token}`}});assert.equal(read.status,200);assert.equal(read.headers.get('cross-origin-resource-policy'),'same-origin');
    const denied=await fetch(url,{method:'PUT',headers:{Authorization:`Bearer ${f.reader.token}`,'If-None-Match':'*','Content-Type':'image/png'},body:png});assert.equal(denied.status,403);
    await assert.rejects(storage.putImage('image.md',jpeg),error=>error.status===409);
    assert.equal((await storage.read('image.md')).raw,'note');
    assert.equal((await fetch(url.replace(image.id,`${'a'.repeat(64)}.png`),{method:'PUT',headers:{Authorization:`Bearer ${f.writer.token}`,'If-None-Match':'*','Content-Type':'image/png'},body:png})).status,400);
    const snapshot=join(f.folder,'image-backup.sqlite'),recovered=join(f.folder,'image-recovered.sqlite');
    await f.database.backup(snapshot);await restoreDatabase(snapshot,recovered);
    const restored=await openDatabase(recovered);
    try{assert.deepEqual(restored.getImage(f.writer.token,'alpha','image.md',image.id).bytes,png);}finally{restored.close();}
    f.database.revoke(f.reader.id);
    assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${f.reader.token}`}})).status,401);
  }finally{await f.close();}
});

test('schema-one databases migrate image storage without changing existing notes or credentials',options,async()=>{
  const folder=await mkdtemp(join(tmpdir(),'collab-image-upgrade-')),path=join(folder,'legacy.sqlite');
  let db=await openDatabase(path,{create:true});
  try{
    db.createWorkspace('team');const credential=db.issue({workspace:'team',principal:'agent',role:'write'});
    db.write(credential.token,'team','legacy.md','Keep existing note',null);db.close();db=null;
    const {DatabaseSync}=await import('node:sqlite');const legacy=new DatabaseSync(path);
    legacy.exec('DROP TRIGGER keep_images_update; DROP TRIGGER keep_images_delete; DROP TABLE images; PRAGMA user_version=1;');legacy.close();
    db=await openDatabase(path);
    assert.equal(db.read(credential.token,'team','legacy.md').raw,'Keep existing note');
    assert.equal(db.putImage(credential.token,'team','legacy.md',inspectImage(png).id,png).created,true);
    assert.equal(db.credentials().length,1);assert.ok(db.integrity());
  }finally{if(db)db.close();await rm(folder,{recursive:true,force:true});}
});

test('gateway awaits asynchronous authorization for image and note reads',options,async()=>{
  const f=await fixture();
  try{
    const authorize=f.database.authorize;
    f.database.authorize=async(...args)=>authorize(...args);
    assert.equal((await f.call('/notes',{token:f.outsider.token})).status,403);
    f.database.write(f.writer.token,'alpha','async.md','note',null);
    const image=f.database.putImage(f.writer.token,'alpha','async.md',inspectImage(png).id,png);
    const response=await fetch(`${f.base}/notes/async.md/attachments/${image.id}`,{headers:{Authorization:`Bearer ${f.outsider.token}`}});
    assert.equal(response.status,403);
  }finally{await f.close();}
});
