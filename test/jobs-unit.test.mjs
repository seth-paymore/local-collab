import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJob, nextRunAt, JobsError } from '../lib/jobs.mjs';
import { finished, publicRun, runFile } from '../lib/job-store.mjs';

const definition = () => ({ id: 'daily-snapshot', name: 'Daily snapshot',
  command: { executable: process.execPath, args: ['capture.mjs', 'US & Canada'], cwd: process.cwd() },
  schedule: { kind: 'daily', time: '09:00', timeZone: 'America/New_York' } });
const invalid = value => assert.throws(() => validateJob(value), error => error instanceof JobsError && error.status === 400);

test('job definition defaults are explicit and independent of caller mutation', () => {
  const input = definition(), job = validateJob(input);
  assert.equal(job.enabled, true); assert.equal(job.timeoutMs, 300000); assert.equal(job.notificationNote, 'agent-inbox');
  input.command.args.push('changed'); input.schedule.time = '10:00';
  assert.deepEqual(job.command.args, ['capture.mjs', 'US & Canada']); assert.equal(job.schedule.time, '09:00');
  assert.equal(validateJob({ ...definition(), enabled: false, timeoutMs: 100 }).enabled, false);
  assert.equal(validateJob({ ...definition(), timeoutMs: 1800000 }).timeoutMs, 1800000);
});

test('job definitions reject unknown fields, malformed identities and notification paths', () => {
  for (const value of [null, [], {}, { ...definition(), shell: true }]) invalid(value);
  for (const id of ['../escape', 'UPPER', '', 'x'.repeat(61), 'line\nbreak']) invalid({ ...definition(), id });
  for (const name of ['', 'x'.repeat(121), 'line\nbreak', 'null\0byte']) invalid({ ...definition(), name });
  for (const notificationNote of ['../escape', '/absolute', 'topic.md', '', 'x'.repeat(82)]) invalid({ ...definition(), notificationNote });
  for (const timeoutMs of [99, 1800001, 100.5, '100']) invalid({ ...definition(), timeoutMs });
  for (const enabled of [0, 'true', null]) invalid({ ...definition(), enabled });
});

test('trusted commands require bounded argument arrays and absolute paths without a shell option', () => {
  const base = definition();
  for (const command of [null, [], { ...base.command, shell: true }, { ...base.command, executable: 'node' },
    { ...base.command, cwd: 'relative' }, { ...base.command, executable: process.execPath + '\n' },
    { ...base.command, args: 'capture.mjs' }, { ...base.command, args: [false] },
    { ...base.command, args: ['bad\0argument'] }, { ...base.command, args: ['x'.repeat(4097)] },
    { ...base.command, args: Array(65).fill('x') }]) invalid({ ...base, command });
  assert.equal(validateJob({ ...base, command: { ...base.command, args: Array(64).fill('') } }).command.args.length, 64);
});

test('daily and interval schedules reject invalid times, zones, bounds and unknown settings', () => {
  for (const schedule of [null, [], { kind: 'cron' }, { kind: 'daily', time: '9:00', timeZone: 'UTC' },
    { kind: 'daily', time: '24:00', timeZone: 'UTC' }, { kind: 'daily', time: '09:60', timeZone: 'UTC' },
    { kind: 'daily', time: '09:00', timeZone: 'Not/AZone' }, { ...definition().schedule, extra: true },
    ...[0, 525601, 1.5, '5'].map(minutes => ({ kind: 'interval', minutes })),
    { kind: 'interval', minutes: 1, extra: true }]) invalid({ ...definition(), schedule });
  for (const minutes of [1, 525600]) assert.equal(validateJob({ ...definition(), schedule: { kind: 'interval', minutes } }).schedule.minutes, minutes);
});

test('next schedule is strictly after the reference time and skips nonexistent spring times', () => {
  const daily = definition().schedule;
  assert.equal(nextRunAt(daily, Date.parse('2026-11-06T13:59:59Z')), '2026-11-06T14:00:00.000Z');
  assert.equal(nextRunAt(daily, Date.parse('2026-11-06T14:00:00Z')), '2026-11-07T14:00:00.000Z');
  assert.equal(nextRunAt({ ...daily, time: '02:30' }, Date.parse('2026-03-08T06:00:00Z')), '2026-03-09T06:30:00.000Z');
  assert.equal(nextRunAt({ kind: 'interval', minutes: 5 }, Date.parse('2026-11-06T14:00:12.345Z')), '2026-11-06T14:05:12.345Z');
});

test('public results omit trusted commands and run paths cannot escape storage', () => {
  const id = '14529db6-5ec2-4d02-a12f-e898125bb029';
  const result = publicRun({ id, status: 'succeeded', definition: definition(), workerPid: 42, stdout: 'private', notificationText: 'private' });
  assert.equal(result.id, id); assert.equal(result.summary, null);
  for (const key of ['definition', 'workerPid', 'stdout', 'notificationText']) assert.equal(Object.hasOwn(result, key), false);
  for (const status of ['succeeded', 'failed', 'timed_out', 'interrupted']) assert.equal(finished({ status }), true);
  for (const status of ['queued', 'running', undefined]) assert.equal(finished({ status }), false);
  assert.match(runFile(process.cwd(), id), /run\.json$/);
  for (const invalidId of ['../escape', '/absolute', '', id + '/extra']) assert.throws(() => runFile(process.cwd(), invalidId), JobsError);
});
