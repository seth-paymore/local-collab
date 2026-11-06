import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { JobsError, JOB_ID, RUN_ID, acquireLock, withLock, readJson, writeJson, readRuns, runFile, alive, finished, publicRun } from './job-store.mjs';
export { JobsError };
const WORKER = fileURLToPath(new URL('../bin/job-worker.mjs', import.meta.url));
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value);

export function validateJob(value) {
  if (!plain(value) || Object.keys(value).some(key => !['id', 'name', 'command', 'schedule', 'notificationNote', 'enabled', 'timeoutMs'].includes(key))) throw new JobsError(400, 'Invalid job definition.');
  const { id, name, command, schedule } = value;
  if (!JOB_ID.test(id ?? '') || !line(name, 120)) throw new JobsError(400, 'Job needs a valid ID and name.');
  if (!plain(command) || Object.keys(command).some(key => !['executable', 'args', 'cwd'].includes(key)) || !line(command.executable, 4096) || !isAbsolute(command.executable) || !line(command.cwd, 4096) || !isAbsolute(command.cwd) || !Array.isArray(command.args) || command.args.length > 64 || command.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || /\0/.test(arg))) throw new JobsError(400, 'Job command needs absolute executable/working-directory paths and an argument array.');
  if (!plain(schedule)) throw new JobsError(400, 'A job schedule is required.');
  if (schedule.kind === 'daily') {
    if (Object.keys(schedule).some(key => !['kind', 'time', 'timeZone'].includes(key)) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time ?? '') || !line(schedule.timeZone, 80)) throw new JobsError(400, 'Daily schedule needs HH:MM and a time zone.');
    try { new Intl.DateTimeFormat('en', { timeZone: schedule.timeZone }).format(); } catch { throw new JobsError(400, 'Invalid job time zone.'); }
  } else if (schedule.kind !== 'interval' || Object.keys(schedule).some(key => !['kind', 'minutes'].includes(key)) || !Number.isInteger(schedule.minutes) || schedule.minutes < 1 || schedule.minutes > 525600) throw new JobsError(400, 'Interval schedule needs 1–525600 minutes.');
  const notificationNote = value.notificationNote ?? 'agent-inbox';
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(notificationNote)) throw new JobsError(400, 'Invalid notification topic.');
  const timeoutMs = value.timeoutMs ?? 300000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 1800000 || (value.enabled !== undefined && typeof value.enabled !== 'boolean')) throw new JobsError(400, 'Invalid job timeout or enabled setting.');
  return { id, name, command: { ...command, args: [...command.args] }, schedule: { ...schedule }, notificationNote, timeoutMs, enabled: value.enabled ?? true };
}
function calendar(schedule, timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: schedule.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(timestamp));
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { day: `${fields.year}-${fields.month}-${fields.day}`, time: `${fields.hour}:${fields.minute}` };
}
export function nextRunAt(schedule, after, lastScheduledFor) {
  if (schedule.kind === 'interval') return new Date(after + schedule.minutes * 60000).toISOString();
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: schedule.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const lastDay = lastScheduledFor ? calendar(schedule, Date.parse(lastScheduledFor)).day : null;
  for (let stamp = Math.floor(after / 60000) * 60000 + 60000, end = stamp + 3 * 86400000; stamp < end; stamp += 60000) {
    const fields = Object.fromEntries(formatter.formatToParts(new Date(stamp)).map(part => [part.type, part.value]));
    if (`${fields.hour}:${fields.minute}` === schedule.time && `${fields.year}-${fields.month}-${fields.day}` !== lastDay) return new Date(stamp).toISOString();
  }
  throw new JobsError(400, 'Could not calculate the next scheduled run.');
}
export async function registerJob(directory, definition) {
  const job = validateJob(definition), file = join(directory, 'definitions.json');
  return withLock(`${file}.lock`, async () => {
    const saved = await readJson(file, { schemaVersion: 1, jobs: [] });
    if (!Array.isArray(saved.jobs)) throw new JobsError(400, 'Invalid jobs registry.');
    saved.jobs = [...saved.jobs.filter(existing => existing.id !== job.id), job];
    await writeJson(file, saved);
    return { id: job.id, name: job.name };
  });
}

export class JobRunner {
  constructor({ directory, notify, baseUrl, pollMs = 2000, now = Date.now }) {
    Object.assign(this, { directory, notify, baseUrl, pollMs, now });
    this.jobs = new Map(); this.states = new Map(); this.runs = new Map(); this.serial = Promise.resolve(); this.error = null;
  }
  mutate(action) { const pending = this.serial.then(action); this.serial = pending.catch(() => {}); return pending; }
  async start() {
    this.release = await acquireLock(join(this.directory, 'runner.lock'), 0);
    for (const run of await readRuns(this.directory)) this.runs.set(run.id, run);
    await this.tick();
    this.timer = setInterval(() => this.tick().catch(error => { this.error = error.message; }), this.pollMs);
    this.timer.unref();
    return this;
  }
  async stop() { clearInterval(this.timer); await this.serial; await this.release?.(); this.release = null; }
  stateFile(id) { return join(this.directory, 'state', `${id}.json`); }
  async refreshDefinitions() {
    const registry = await readJson(join(this.directory, 'definitions.json'), { schemaVersion: 1, jobs: [] });
    if (!Array.isArray(registry.jobs) || registry.jobs.length > 100) throw new JobsError(400, 'Configure up to 100 trusted jobs.');
    const jobs = registry.jobs.map(validateJob);
    if (new Set(jobs.map(job => job.id)).size !== jobs.length) throw new JobsError(400, 'Duplicate job IDs.');
    this.jobs = new Map(jobs.map(job => [job.id, job]));
    for (const job of jobs) {
      const fingerprint = JSON.stringify(job);
      const state = await readJson(this.stateFile(job.id), {});
      if (state.fingerprint !== fingerprint) {
        Object.assign(state, { fingerprint, paused: !job.enabled, nextRunAt: nextRunAt(job.schedule, this.now()) });
        await writeJson(this.stateFile(job.id), state);
      }
      this.states.set(job.id, state);
    }
  }
  async refreshRuns() {
    for (const [id, cached] of this.runs) {
      if (finished(cached)) continue;
      let run = await readJson(runFile(this.directory, id));
      const abandoned = run.status === 'queued' ? this.now() - Date.parse(run.createdAt) > 60000
        : !alive(run.workerPid, run.startedAt) && !alive(run.childPid, run.startedAt);
      if (!finished(run) && abandoned) {
        await withLock(`${runFile(this.directory, id)}.lock`, async () => {
          run = await readJson(runFile(this.directory, id));
          if (!finished(run) && !alive(run.workerPid, run.startedAt) && !alive(run.childPid, run.startedAt)) {
            Object.assign(run, { status: 'interrupted', finishedAt: new Date(this.now()).toISOString(), error: 'The worker stopped before recording a result. Review the outcome before retrying.' });
            await writeJson(runFile(this.directory, id), run);
          }
        });
      }
      this.runs.set(id, run);
    }
    for (const [id, state] of this.states) {
      if (state.activeRunId && finished(this.runs.get(state.activeRunId) ?? {})) {
        state.lastRunId = state.activeRunId; state.activeRunId = null;
        await writeJson(this.stateFile(id), state);
      }
    }
  }
  async deliverResults() {
    for (const run of this.runs.values()) {
      if (!finished(run) || run.notifiedAt) continue;
      if (!run.notificationText) {
        const folder = dirname(runFile(this.directory, run.id));
        const summaryFile = join(folder, 'summary.md');
        try { if ((await stat(summaryFile)).size <= 16384) run.summary = (await readFile(summaryFile, 'utf8')).trim(); } catch (error) { if (error.code !== 'ENOENT') run.summaryError = 'Job summary could not be read.'; }
        run.notificationText = `Job: ${run.name}\nResult: ${run.status}\nScheduled for: ${run.scheduledFor ?? 'manual run'}\nStarted: ${run.startedAt ?? run.createdAt}\nFinished: ${run.finishedAt}\nRun ID: ${run.id}\n${run.error ? `Outcome: ${run.error}\n` : ''}\n${run.summary ? `${run.summary}\n\n` : ''}Saved evidence: ${folder}\n\nAgent review requested: read the saved result, record any findings in this note, then mark this run reviewed with node bin/job.mjs review ${run.id} --author <name>.`;
        await writeJson(runFile(this.directory, run.id), run);
      }
      try {
        await this.notify(run.notificationNote, { author: 'Local Collab', agent: 'Job Runner', text: run.notificationText, requestId: run.id });
        run.notifiedAt = new Date(this.now()).toISOString(); run.notificationError = null;
        await writeJson(runFile(this.directory, run.id), run);
      } catch (error) { run.notificationError = error.message; }
    }
  }
  async tick() {
    return this.mutate(async () => {
      try { await this.refreshDefinitions(); this.error = null; } catch (error) { this.error = error.message; }
      await this.refreshRuns(); await this.deliverResults();
      if (this.error) return;
      for (const job of this.jobs.values()) {
        const state = this.states.get(job.id);
        if (!state.paused && !state.activeRunId && Date.parse(state.nextRunAt) <= this.now()) {
          await this.runInternal(job.id, { trigger: 'schedule', scheduledFor: state.nextRunAt });
        }
      }
    });
  }
  async runInternal(id, { trigger = 'manual', scheduledFor = null, requestId } = {}) {
    if (requestId && !RUN_ID.test(requestId)) throw new JobsError(400, 'Invalid run request ID.');
    const existing = requestId && this.runs.get(requestId);
    if (existing) { if (existing.jobId !== id) throw new JobsError(409, 'Run request ID is already in use.'); return publicRun(existing); }
    const job = this.jobs.get(id), state = this.states.get(id);
    if (!job) throw new JobsError(404, 'Job not found.');
    if (this.error) throw new JobsError(503, this.error);
    if (state.activeRunId) throw new JobsError(409, 'This job is already running.');
    const run = { schemaVersion: 1, id: requestId ?? randomUUID(), jobId: id, name: job.name, definition: job,
      status: 'queued', trigger, scheduledFor, createdAt: new Date(this.now()).toISOString(), notificationNote: job.notificationNote };
    await writeJson(runFile(this.directory, run.id), run);
    state.activeRunId = run.id;
    if (trigger === 'schedule') state.nextRunAt = nextRunAt(job.schedule, this.now(), scheduledFor);
    await writeJson(this.stateFile(id), state); this.runs.set(run.id, run);
    try {
      const child = spawn(process.execPath, [WORKER, this.directory, run.id], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
    } catch {
      Object.assign(run, { status: 'failed', finishedAt: new Date(this.now()).toISOString(), error: 'The job worker could not start.' });
      await writeJson(runFile(this.directory, run.id), run);
    }
    return publicRun(run);
  }
  async run(id, body = {}) {
    if (!plain(body) || Object.keys(body).some(key => key !== 'requestId')) throw new JobsError(400, 'Run requests can only supply a request ID.');
    return this.mutate(async () => { await this.refreshDefinitions(); return this.runInternal(id, body); });
  }
  async pause(id, paused) {
    if (typeof paused !== 'boolean') throw new JobsError(400, 'Paused must be true or false.');
    return this.mutate(async () => {
      await this.refreshDefinitions();
      const job = this.jobs.get(id), state = this.states.get(id);
      if (!job) throw new JobsError(404, 'Job not found.');
      state.paused = paused; state.nextRunAt = nextRunAt(job.schedule, this.now());
      await writeJson(this.stateFile(id), state); return this.list();
    });
  }
  async review(id, author) {
    if (!/^[A-Za-z][\w .-]{0,39}$/.test(author ?? '')) throw new JobsError(400, 'A reviewer name is required.');
    return this.mutate(async () => {
      const run = this.runs.get(id);
      if (!run || !finished(run) || !run.notifiedAt) throw new JobsError(409, 'Wait for a completed result note before marking a run reviewed.');
      if (!run.reviewedAt) { run.reviewedAt = new Date(this.now()).toISOString(); run.reviewedBy = author; await writeJson(runFile(this.directory, id), run); }
      return publicRun(run);
    });
  }
  list() {
    return { error: this.error, jobs: [...this.jobs.values()].map(job => ({ id: job.id, name: job.name, schedule: job.schedule, notificationNote: job.notificationNote,
      paused: this.states.get(job.id)?.paused ?? true, nextRunAt: this.states.get(job.id)?.nextRunAt, activeRun: this.runs.has(this.states.get(job.id)?.activeRunId) ? publicRun(this.runs.get(this.states.get(job.id).activeRunId)) : null,
      lastRun: this.runs.has(this.states.get(job.id)?.lastRunId) ? publicRun(this.runs.get(this.states.get(job.id).lastRunId)) : null })) };
  }
  history(id) { return [...this.runs.values()].filter(run => !id || run.jobId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(publicRun); }
  inbox() { return [...this.runs.values()].filter(run => finished(run) && !run.reviewedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicRun); }
}
