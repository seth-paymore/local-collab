#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { config } from '../lib/config.mjs';
import { registerJob } from '../lib/jobs.mjs';
import { readInbox } from '../lib/job-store.mjs';
const { positionals: [command, name], values } = parseArgs({ allowPositionals: true, options: { json: { type: 'boolean' }, author: { type: 'string' }, help: { type: 'boolean' } } });
const base = `http://127.0.0.1:${config.port}/api/jobs`;
async function request(path = '', body) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error), { fromServer: true }); return data;
}
async function main() {
  if (!command || values.help) { console.log('Usage: job register <definition.json> | list | inbox | history [job-id] | run <job-id> | pause <job-id> | resume <job-id> | review <run-id> --author <name> [--json]'); return; }
  let data;
  if (command === 'register') {
    if (!name) throw new Error('Pass the path to a trusted job definition JSON file.');
    data = await registerJob(config.jobsDir, JSON.parse(await readFile(name, 'utf8')));
    try { await request('/reload', {}); } catch (error) { data.reload = error.fromServer ? error.message : 'Job saved; it will load when the server is available.'; }
  } else if (command === 'list') data = await request();
  else if (command === 'inbox') {
    try { data = await request('/inbox'); } catch (error) { if (error.fromServer) throw error; data = { runs: await readInbox(config.jobsDir) }; }
  } else if (command === 'history') data = await request(name ? `/${encodeURIComponent(name)}/runs` : '/runs');
  else if (command === 'run') data = await request(`/${encodeURIComponent(name)}/run`, { requestId: randomUUID() });
  else if (command === 'pause' || command === 'resume') data = await request(`/${encodeURIComponent(name)}/pause`, { paused: command === 'pause' });
  else if (command === 'review') data = await request(`/runs/${encodeURIComponent(name)}/review`, { author: values.author });
  else throw new Error('Unknown job command. Use --help.');
  if (values.json) console.log(JSON.stringify(data, null, 2));
  else if (data.runs) {
    if (!data.runs.length) console.log('No job results awaiting review.');
    for (const run of data.runs) console.log(`${run.id}  ${run.status}  ${run.name}\n${run.summary ?? run.error ?? ''}\nRead note: ${run.notificationNote} | Finished: ${run.finishedAt}\n`);
  } else console.log(JSON.stringify(data, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
