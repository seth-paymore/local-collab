import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { withLock, runFile, readJson, writeJson } from './job-store.mjs';
import { validateJob } from './jobs.mjs';

export async function runWorker(directory, id) {
  const file = runFile(directory, id);
  let run = await readJson(file);
  const job = validateJob(run.definition);
  await withLock(join(directory, 'locks', `${job.id}.lock`), async () => {
    let allowed = false;
    await withLock(`${file}.lock`, async () => {
      run = await readJson(file);
      if (run.status !== 'queued') return;
      Object.assign(run, { status: 'running', startedAt: new Date().toISOString(), workerPid: process.pid });
      await writeJson(file, run); allowed = true;
    });
    if (!allowed) return;
    const folder = dirname(file);
    let child, timer, closed = false, tooLarge = false, timedOut = false, bytes = 0, startError;
    const stdout = createWriteStream(join(folder, 'stdout.log'));
    const stderr = createWriteStream(join(folder, 'stderr.log'));
    const terminate = () => {
      if (!child?.pid || closed) return;
      if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
        if (error && !closed) { run.terminationWarning = 'Windows refused process-tree termination; the direct job process was stopped.'; child.kill('SIGKILL'); }
      });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    try {
      stdout.on('error', () => { startError = 'Job output could not be saved.'; terminate(); });
      stderr.on('error', () => { startError = 'Job output could not be saved.'; terminate(); });
      const env = { ...process.env, LOCAL_COLLAB_JOB_DIR: folder, LOCAL_COLLAB_JOB_ID: job.id, LOCAL_COLLAB_JOB_RUN_ID: id };
      if (job.command.executable !== process.execPath) delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(job.command.executable, job.command.args, { cwd: job.command.cwd, shell: false, detached: process.platform !== 'win32', windowsHide: true, env });
      const output = stream => chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { tooLarge = true; terminate(); } else stream.write(chunk);
      };
      child.stdout.on('data', output(stdout)); child.stderr.on('data', output(stderr));
      const ended = new Promise(resolve => {
        child.once('error', error => { startError = `Job process could not start (${error.code ?? 'error'}).`; });
        child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
      });
      run.childPid = child.pid ?? null; await writeJson(file, run);
      timer = setTimeout(() => { timedOut = true; terminate(); }, job.timeoutMs);
      const { code, signal } = await ended;
      Object.assign(run, { exitCode: code, signal, status: timedOut ? 'timed_out' : code === 0 && !tooLarge && !startError ? 'succeeded' : 'failed',
        error: timedOut ? `Job exceeded its ${job.timeoutMs} ms time limit.` : tooLarge ? 'Job exceeded its 1 MiB output limit.' : startError ?? (code === 0 ? null : `Job exited with code ${code ?? signal ?? 'unknown'}.`) });
    } catch { terminate(); Object.assign(run, { status: 'failed', error: 'The job could not record a complete result.' }); }
    finally {
      clearTimeout(timer);
      await Promise.all([stdout, stderr].map(stream => new Promise(resolve => { if (stream.destroyed) resolve(); else stream.end(resolve); })));
      run.finishedAt = new Date().toISOString(); await writeJson(file, run);
    }
  });
}
