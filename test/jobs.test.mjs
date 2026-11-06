import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobRunner, registerJob, validateJob, nextRunAt } from '../lib/jobs.mjs';
import { runFile, readJson, writeJson } from '../lib/job-store.mjs';

async function fixture(code = 'await new Promise(resolve=>setTimeout(resolve,150)); console.log("captured"); await writeFile(join(process.env.LOCAL_COLLAB_JOB_DIR,"summary.md"),"Three regions captured. Review the evidence.");') {
  const directory = await mkdtemp(join(tmpdir(), 'local-collab-jobs-'));
  const script = join(directory, 'trusted job.mjs');
  await writeFile(script, `import {writeFile} from 'node:fs/promises'; import {join} from 'node:path'; ${code}`);
  const definition = { id: 'snapshot', name: 'Performance snapshot', command: { executable: process.execPath, args: [script], cwd: directory }, schedule: { kind: 'interval', minutes: 60 }, notificationNote: 'performance-review', timeoutMs: 5000 };
  await registerJob(directory, definition);
  const notes = new Map(); let deliveries = 0;
  const options = { directory, baseUrl: 'http://127.0.0.1:4317', pollMs: 60000, notify: async (topic, body) => { deliveries++; notes.set(body.requestId, { topic, ...body }); } };
  const runner = await new JobRunner(options).start();
  return { directory, definition, runner, options, notes, deliveries: () => deliveries };
}
async function finish(runner, count = 1) {
  for (let attempt = 0; attempt < 150; attempt++) {
    await runner.tick();
    if (runner.inbox().length >= count && runner.inbox().every(run => run.notifiedAt)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Job result did not arrive.');
}

test('daily schedules preserve Eastern time through DST and run once per local day', () => {
  const daily = { kind: 'daily', time: '09:00', timeZone: 'America/New_York' };
  assert.equal(nextRunAt(daily, Date.parse('2026-11-06T15:00:00Z')), '2026-11-07T14:00:00.000Z');
  assert.equal(nextRunAt(daily, Date.parse('2026-03-07T15:00:00Z')), '2026-03-08T13:00:00.000Z');
  const fallback = { ...daily, time: '01:30' };
  assert.equal(nextRunAt(fallback, Date.parse('2026-11-01T05:31:00Z'), '2026-11-01T05:30:00Z'), '2026-11-02T06:30:00.000Z');
  assert.throws(() => validateJob({ id: '../escape' }), /valid ID/);
});

test('real command results persist, notify once and remain in the inbox until reviewed', async () => {
  const f = await fixture();
  try {
    const requestId = randomUUID();
    const run = await f.runner.run('snapshot', { requestId });
    assert.equal((await f.runner.run('snapshot', { requestId })).id, run.id);
    await assert.rejects(f.runner.run('snapshot', { requestId: randomUUID() }), /already running/);
    await assert.rejects(f.runner.run('snapshot', { command: { executable: 'anything' } }), /request ID/);
    await finish(f.runner);
    const result = f.runner.inbox()[0];
    assert.equal(result.status, 'succeeded'); assert.match(result.summary, /Three regions/);
    assert.equal(f.notes.get(run.id).topic, 'performance-review');
    assert.match(f.notes.get(run.id).text, /Agent review requested/);
    assert.equal(await readFile(join(f.directory, 'runs', run.id, 'stdout.log'), 'utf8'), 'captured\n');
    assert.equal(JSON.stringify(f.runner.history()).includes('executable'), false);
    await f.runner.tick(); assert.equal(f.deliveries(), 1);
    await f.runner.review(run.id, 'Reviewer'); assert.equal(f.runner.inbox().length, 0);
    await f.runner.review(run.id, 'Other Reviewer'); assert.equal(f.runner.history()[0].reviewedBy, 'Reviewer');
  } finally { await f.runner.stop(); }
});

test('workers survive a runner restart and persisted notification receipts prevent duplicate delivery', async () => {
  const f = await fixture('await new Promise(resolve=>setTimeout(resolve,600)); console.log("finished after restart");');
  let resumed;
  try {
    const run = await f.runner.run('snapshot');
    await f.runner.stop();
    resumed = await new JobRunner(f.options).start();
    await assert.rejects(resumed.run('snapshot'), /already running/);
    await finish(resumed);
    assert.equal(resumed.inbox()[0].id, run.id);
    assert.equal(f.deliveries(), 1);
    await resumed.stop(); resumed = await new JobRunner(f.options).start();
    await resumed.tick(); assert.equal(f.deliveries(), 1);
  } finally { await resumed?.stop(); await f.runner.stop(); }
});

test('missed intervals catch up once and pause/resume persists without executing paused jobs', async () => {
  const f = await fixture('console.log("once");');
  try {
    const stateFile = join(f.directory, 'state', 'snapshot.json');
    const state = await readJson(stateFile);
    state.nextRunAt = new Date(Date.now() - 7 * 86400000).toISOString();
    await writeJson(stateFile, state);
    await f.runner.tick(); await finish(f.runner);
    assert.equal(f.runner.history().length, 1);
    assert.ok(Date.parse(f.runner.list().jobs[0].nextRunAt) > Date.now());
    await f.runner.tick(); assert.equal(f.runner.history().length, 1);
    await f.runner.pause('snapshot', true); await f.runner.tick();
    assert.equal(f.runner.list().jobs[0].paused, true);
    await f.runner.pause('snapshot', false);
    assert.equal(f.runner.list().jobs[0].paused, false);
  } finally { await f.runner.stop(); }
});

test('failed and timed-out real processes create actionable result notes', async () => {
  const failed = await fixture('console.error("read failed"); process.exitCode=7;');
  try { await failed.runner.run('snapshot'); await finish(failed.runner); assert.equal(failed.runner.inbox()[0].status, 'failed'); assert.match([...failed.notes.values()][0].text, /code 7/); }
  finally { await failed.runner.stop(); }
  const timeout = await fixture('await new Promise(resolve=>setTimeout(resolve,60000));');
  try {
    await registerJob(timeout.directory, { ...timeout.definition, timeoutMs: 200 });
    await timeout.runner.run('snapshot'); await finish(timeout.runner);
    assert.equal(timeout.runner.inbox()[0].status, 'timed_out');
  } finally { await timeout.runner.stop(); }
});

test('notification failures retry from persisted content and abandoned workers are reported', async () => {
  const f = await fixture('console.log("done");');
  try {
    const notify = f.runner.notify;
    let fail = true;
    f.runner.notify = async (topic, body) => { if (fail) throw new Error('Storage unavailable'); return notify(topic, body); };
    const run = await f.runner.run('snapshot');
    for (let attempt = 0; attempt < 100; attempt++) { await f.runner.tick(); if (f.runner.inbox().length) break; await new Promise(resolve => setTimeout(resolve, 30)); }
    assert.equal(f.runner.inbox()[0].notifiedAt, null);
    const stored = await readJson(runFile(f.directory, run.id));
    assert.match(stored.notificationText, /Job: Performance snapshot/);
    fail = false; await finish(f.runner); assert.equal(f.deliveries(), 1);
    await f.runner.review(run.id, 'Reviewer');
    const abandonedId = randomUUID();
    await mkdir(join(f.directory, 'runs', abandonedId), { recursive: true });
    const abandoned = { ...stored, id: abandonedId, status: 'queued', workerPid: null, childPid: null, createdAt: '2020-01-01T00:00:00Z', notifiedAt: null, notificationText: null, reviewedAt: null };
    await writeJson(runFile(f.directory, abandonedId), abandoned); f.runner.runs.set(abandonedId, abandoned);
    await f.runner.tick(); assert.equal(f.runner.inbox()[0].status, 'interrupted');
  } finally { await f.runner.stop(); }
});

test('an oversized real process output is bounded and reported as a failed job', async () => {
  const f = await fixture('process.stdout.write("x".repeat(2*1024*1024)); await new Promise(resolve=>setTimeout(resolve,500));');
  try {
    const run = await f.runner.run('snapshot'); await finish(f.runner);
    assert.equal(f.runner.inbox()[0].status, 'failed');
    assert.match(f.runner.inbox()[0].error, /output limit/);
    assert.ok((await readFile(join(f.directory, 'runs', run.id, 'stdout.log'))).length <= 1024 * 1024);
  } finally { await f.runner.stop(); }
});
