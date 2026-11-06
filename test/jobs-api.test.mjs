import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('actual job API/CLI preserve note contracts, reject executable input and surface durable results on the next check', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'local-collab-job-api-'));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, LOCAL_COLLAB_CONFIG: join(folder, 'missing.json'), LOCAL_COLLAB_NOTES: folder, LOCAL_COLLAB_PORT: String(port), LOCAL_COLLAB_AUTHOR: 'Tester' };
  for (const key of Object.keys(env)) if (/^ACTIVECOLLAB_|^ACTIVE_COLLAB$/.test(key)) delete env[key];
  const base = `http://127.0.0.1:${port}/api`;
  const request = async (path, body, origin) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(origin ? { Origin: origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  async function start() {
    const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stderr.on('data', data => { output += data; });
    for (let attempt = 0; attempt < 150; attempt++) {
      try { if ((await request('/jobs')).status === 200) return child; } catch {}
      if (child.exitCode !== null) throw new Error(output);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    child.kill(); throw new Error('Job API did not start: ' + output);
  }
  async function stop(child) { const ended = once(child, 'exit'); child.kill(); await ended; }
  const script = join(folder, 'collector with spaces.mjs');
  await writeFile(script, 'import {writeFile} from "node:fs/promises"; import {join} from "node:path"; await writeFile(join(process.env.LOCAL_COLLAB_JOB_DIR,"summary.md"),"Fixture snapshot is ready.");');
  const definition = join(folder, 'definition.json');
  await writeFile(definition, JSON.stringify({ id: 'daily-fixture', name: 'Daily fixture', command: { executable: process.execPath, args: [script], cwd: folder }, schedule: { kind: 'daily', time: '09:00', timeZone: 'America/New_York' }, notificationNote: 'agent-inbox' }));
  let child = await start();
  try {
    await request('/notes/existing-topic/entries', { author: 'Tester', text: 'Existing note stays intact.', status: 'waiting', next: 'Original next step' });
    const existing = (await request('/notes/existing-topic')).data.raw;
    await execute(process.execPath, [join(ROOT, 'bin', 'job.mjs'), 'register', definition, '--json'], { env });
    assert.equal((await request('/jobs')).data.jobs.length, 1);
    const id = randomUUID();
    assert.equal((await request('/jobs/daily-fixture/run', { requestId: id }, 'https://foreign.example')).status, 403);
    assert.equal((await request('/jobs/daily-fixture/run', { executable: process.execPath })).status, 400);
    assert.equal((await request('/jobs/daily-fixture/pause', null)).status, 400);
    assert.equal((await request('/jobs/reload', [])).status, 400);
    assert.equal((await request('/jobs/daily-fixture/run', { requestId: id })).status, 202);
    assert.equal((await request('/jobs/daily-fixture/run', { requestId: id })).data.id, id);
    let inbox;
    for (let attempt = 0; attempt < 200; attempt++) {
      inbox = (await request('/jobs/inbox')).data.runs;
      if (inbox[0]?.notifiedAt) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(inbox[0]?.status, 'succeeded'); assert.ok(inbox[0].notifiedAt);
    const note = (await request('/notes/agent-inbox')).data;
    assert.equal(note.entries.length, 1); assert.equal(note.entries[0].author, 'Local Collab');
    assert.match(note.entries[0].text, /Fixture snapshot is ready/);
    const nextCheck = await execute(process.execPath, [join(ROOT, 'bin', 'note.mjs'), 'show', 'existing-topic', '--json'], { env });
    assert.match(nextCheck.stderr, /Job results awaiting agent review/);
    assert.equal(JSON.parse(nextCheck.stdout).raw, existing);
    await stop(child); child = null;
    // Simulate a crash after committing the note but before recording its receipt.
    const file = join(folder, '.jobs', 'runs', id, 'run.json');
    const run = JSON.parse(await readFile(file, 'utf8')); run.notifiedAt = null;
    await writeFile(file, JSON.stringify(run));
    child = await start();
    assert.equal((await request('/notes/agent-inbox')).data.entries.length, 1);
    assert.equal((await request('/jobs/inbox')).data.runs.length, 1);
    await execute(process.execPath, [join(ROOT, 'bin', 'job.mjs'), 'review', id, '--author', 'Reviewer', '--json'], { env });
    assert.equal((await request('/jobs/inbox')).data.runs.length, 0);
    assert.equal((await request('/notes/existing-topic')).data.raw, existing);
  } finally { if (child) await stop(child); }
});
