import { open, readFile, writeFile, rename, mkdir, rm, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { uptime } from 'node:os';

export const JOB_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const RUN_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export class JobsError extends Error { constructor(status, message) { super(message); this.status = status; } }
export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export async function writeJson(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n');
  try {
    for (let attempt = 0;; attempt++) {
      try { await rename(temp, file); break; }
      catch (error) { if (attempt === 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error; await new Promise(resolve => setTimeout(resolve, 60)); }
    }
  } finally { await rm(temp, { force: true }); }
}
export function alive(pid, startedAt) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  if (startedAt && Date.parse(startedAt) < Date.now() - uptime() * 1000 - 5000) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export async function acquireLock(file, waitMs = 5000) {
  await mkdir(dirname(file), { recursive: true });
  const token = randomUUID(), end = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token }));
      await handle.close();
      return async () => { if ((await readJson(file, {})).token === token) await rm(file, { force: true }); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readJson(file, {}).catch(() => null);
      if (owner?.pid && !alive(owner.pid, owner.startedAt)) { await rm(file, { force: true }); continue; }
      if (Date.now() >= end) throw new JobsError(409, 'Another job operation is still running.');
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
}
export async function withLock(file, action) { const release = await acquireLock(file); try { return await action(); } finally { await release(); } }
export function runFile(directory, id) { if (!RUN_ID.test(id)) throw new JobsError(400, 'Invalid run ID.'); return join(directory, 'runs', id, 'run.json'); }
export async function readRuns(directory) {
  let ids;
  try { ids = await readdir(join(directory, 'runs')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return Promise.all(ids.filter(id => RUN_ID.test(id)).map(id => readJson(runFile(directory, id))));
}
export const finished = run => ['succeeded', 'failed', 'timed_out', 'interrupted'].includes(run.status);
export function publicRun(run) {
  return Object.fromEntries(['id', 'jobId', 'name', 'status', 'trigger', 'scheduledFor', 'createdAt', 'startedAt', 'finishedAt', 'exitCode', 'error', 'summary', 'notificationNote', 'notifiedAt', 'reviewedAt', 'reviewedBy'].map(key => [key, run[key] ?? null]));
}
export async function readInbox(directory) { return (await readRuns(directory)).filter(run => finished(run) && !run.reviewedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicRun); }
