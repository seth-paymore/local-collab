import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { desktopArguments, ensureServer, externalNavigation, localNavigation, probeServer, quoteArgument } from '../desktop/policy.mjs';

test('packaged shortcut launches preserve the first configuration option', () => {
  const options = ['--config=C:\\My Notes\\local-collab.config.json', '--install-shortcuts'];
  assert.deepEqual(desktopArguments(['Local Collab.exe', ...options], true), options);
  assert.deepEqual(desktopArguments(['electron.exe', 'desktop', ...options], false), options);
});

test('desktop keeps local navigation and attachments while external links cannot invoke local programs', () => {
  const base = 'http://127.0.0.1:4317';
  for (const path of ['/', '/#/example.md', '/api/notes/example/attachments/image.png']) assert.equal(localNavigation(base + path, base), true);
  for (const url of ['https://github.com/seth-paymore/local-collab', 'http://127.0.0.1:4318/', 'file:///C:/secret', 'javascript:alert(1)']) assert.equal(localNavigation(url, base), false);
  assert.equal(externalNavigation('https://app.activecollab.com/407220/projects/6'), true);
  for (const url of ['file:///C:/Windows/cmd.exe', 'javascript:alert(1)', 'ms-settings:privacy', 'https://user:password@example.com']) assert.equal(externalNavigation(url), false);
  assert.equal(quoteArgument('C:\\Program Files\\Local Collab\\'), '"C:\\Program Files\\Local Collab\\\\"');
  assert.equal(quoteArgument('--config=C:\\My Notes\\config.json'), '"--config=C:\\My Notes\\config.json"');
});

test('desktop reuses the actual healthy server and refuses an unrelated service on its port', async () => {
  let requests = 0;
  let payload = { ok: true, app: 'local-collab', pid: 42 };
  const server = createServer((_req, res) => { requests++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let starts = 0;
    assert.equal((await ensureServer(base, () => { starts++; })).pid, 42);
    assert.equal(starts, 0); assert.equal(requests, 1);
    payload = { ok: true, app: 'something-else' };
    await assert.rejects(ensureServer(base, () => { starts++; }), /other than Local Collab/);
    assert.equal(starts, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal(await probeServer(base), null);
});

test('desktop starts the supervisor only once and reports a failed start', async () => {
  let starts = 0, polls = 0;
  const health = { ok: true, app: 'local-collab' };
  assert.equal(await ensureServer('http://127.0.0.1:4317', () => { starts++; }, {
    probe: async () => ++polls < 3 ? null : health, interval: 1,
  }), health);
  assert.equal(starts, 1);
  await assert.rejects(ensureServer('http://127.0.0.1:4317', () => {}, {
    probe: async () => null, timeout: 1, interval: 1,
  }), /could not start/);
});
