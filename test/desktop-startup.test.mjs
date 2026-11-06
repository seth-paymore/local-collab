import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStartupController } from '../desktop/startup.mjs';
import { trustedFrame } from '../desktop/policy.mjs';

test('existing startup task is shown and managed without adding a duplicate login entry', async () => {
  let enabled = true;
  const actions = [], nativeWrites = [];
  const app = { isPackaged: true, getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: value => nativeWrites.push(value) };
  const controller = createStartupController({ app, platform: 'win32', configPath: 'example.json', legacyTask: async action => {
    actions.push(action);
    if (action !== 'Get') enabled = action === 'Enable';
    return { present: true, managed: true, enabled };
  } });
  assert.equal((await controller.getState()).enabled, true);
  assert.equal((await controller.setEnabled(false)).enabled, false);
  assert.equal((await controller.setEnabled(true)).enabled, true);
  assert.deepEqual(actions.filter(action => action !== 'Get'), ['Disable', 'Enable']);
  assert.equal(nativeWrites.length, 1);
  assert.equal(nativeWrites[0].openAtLogin, false);
});

test('fresh startup registration uses server-only mode and verifies the saved state', async () => {
  let enabled = false;
  const writes = [];
  const app = { isPackaged: true,
    getLoginItemSettings: () => ({ openAtLogin: enabled, launchItems: enabled ? [{ name: writes.at(-1).name, scope: 'user', enabled, args: writes.at(-1).args }] : [] }),
    setLoginItemSettings: value => { writes.push(value); enabled = value.openAtLogin; },
  };
  const controller = createStartupController({ app, platform: 'win32', executable: 'C:\\My Programs\\Local Collab.exe', configPath: 'example.json',
    legacyTask: async () => ({ present: false, managed: false, enabled: false }) });
  assert.equal((await controller.setEnabled(true)).enabled, true);
  assert.ok(writes[0].args.includes('--server-only'));
  assert.equal(writes[0].path, 'C:\\My Programs\\Local Collab.exe');
  assert.equal((await controller.setEnabled(false)).enabled, false);
  app.setLoginItemSettings = () => {};
  await assert.rejects(controller.setEnabled(true), /did not save/);
});

test('unknown startup task and invalid values cannot change Windows configuration', async () => {
  let writes = 0;
  const controller = createStartupController({ platform: 'win32', configPath: 'example.json', app: {
    getLoginItemSettings: () => ({}), setLoginItemSettings: () => { writes++; },
  }, legacyTask: async action => {
    if (action !== 'Get') writes++;
    return { present: true, managed: false, enabled: true };
  } });
  await assert.rejects(controller.setEnabled('true'), /enabled or disabled/);
  await assert.rejects(controller.setEnabled(false), /different Local Collab/);
  assert.equal((await controller.getState()).editable, false);
  assert.equal(writes, 0);
});

test('startup readback requires the matching command and its own enabled entry', async () => {
  let native = { openAtLogin: false, launchItems: [{ name: 'org.localcollab.desktop', scope: 'user', enabled: true }] };
  const controller = createStartupController({ app: { isPackaged: true, getLoginItemSettings: () => native }, platform: 'win32',
    configPath: 'example.json', legacyTask: async () => ({ present: false, managed: false, enabled: false }) });
  assert.equal((await controller.getState()).enabled, false);
  native = { openAtLogin: true, launchItems: [{ name: 'another-startup-entry', scope: 'user', enabled: true }] };
  assert.equal((await controller.getState()).enabled, false);
  native.launchItems = [{ name: 'org.localcollab.desktop', scope: 'user', enabled: false }];
  assert.equal((await controller.getState()).enabled, false);
});

test('only the intended top-level window can read or change desktop settings', () => {
  const frame = { url: 'file:///app/settings.html' };
  const settings = { isDestroyed: () => false, mainFrame: frame };
  assert.equal(trustedFrame({ sender: settings, senderFrame: frame }, settings, frame.url), true);
  assert.equal(trustedFrame({ sender: {}, senderFrame: frame }, settings, frame.url), false);
  assert.equal(trustedFrame({ sender: settings, senderFrame: { url: frame.url } }, settings, frame.url), false);
  assert.equal(trustedFrame({ sender: settings, senderFrame: null }, settings, frame.url), false);
  assert.equal(trustedFrame({ sender: settings, senderFrame: frame }, settings, 'file:///other/settings.html'), false);
  const mainFrame = { url: 'http://127.0.0.1:4317/#/example.md' };
  const main = { isDestroyed: () => false, mainFrame };
  assert.equal(trustedFrame({ sender: main, senderFrame: mainFrame }, main, 'http://127.0.0.1:4317', true), true);
});
