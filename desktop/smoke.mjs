// Run with npm run smoke. Uses an isolated profile and filesystem fixtures;
// never connects to the owner's notes or tracker account.
import { app, BrowserWindow, shell } from 'electron';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_ID, ensureServer } from './policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = process.argv.find(value => value.startsWith('--app-root='))?.slice('--app-root='.length) ?? here;
const resultPath = process.argv.find(value => value.startsWith('--result='))?.slice('--result='.length) ?? join(tmpdir(), 'local-collab-desktop-smoke.json');
async function runSmoke() {
let desktop;
let stage = 'initialize';
try {
  for (const key of Object.keys(process.env)) if (/^ACTIVECOLLAB_|^ACTIVE_COLLAB$|^LOCAL_COLLAB_/.test(key)) delete process.env[key];
  const { startDesktop, startServerOnly } = await import(pathToFileURL(join(resolve(appRoot), 'application.mjs')).href);
  const serverChild = process.argv.indexOf('--server-only-child');
  if (serverChild >= 0) {
    const result = await startServerOnly({ configPath: process.argv[serverChild + 1], profilePath: process.argv[serverChild + 2] });
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    await writeFile(resultPath, JSON.stringify({ ok: true, ...result, windows: 0 }));
    app.exit(0);
    return;
  }
  const second = process.argv.indexOf('--second-instance');
  if (second >= 0) {
    assert.equal(await startDesktop({ configPath: process.argv[second + 1], profilePath: process.argv[second + 2] }), null);
    app.exit(0);
  } else {
    const folder = await mkdtemp(join(tmpdir(), 'local-collab-electron-smoke-'));
    const notesDir = join(folder, 'notes');
    await mkdir(notesDir);
    const configPath = join(folder, 'config with spaces.json');
    const profilePath = join(folder, 'profile');
    const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
    const port = portProbe.address().port;
    await new Promise(resolveClosed => portProbe.close(resolveClosed));
    await writeFile(configPath, JSON.stringify({ port, notesDir, author: 'Tester' }));
    const fixture = '---\nticket: ""\ntitle: "Desktop fixture"\nstatus: active\nnext: "Read fixture"\n---\n\n# Desktop fixture\n\n## 2026-11-03 12:00 Tester\n\nExisting notes stay readable.\n';
    await writeFile(join(notesDir, 'desktop-fixture.md'), fixture);
    stage = 'start actual desktop and background supervisor';
    desktop = await startDesktop({ configPath, profilePath, argv: [], startupOptions: {
      taskName: `Local Collab smoke ${process.pid}`, loginItemName: `${APP_ID}.smoke.${process.pid}`,
    } });
    assert.ok(desktop.supervisorPid);
    assert.equal(resolve(desktop.health.notesDir), resolve(notesDir));
    stage = 'read existing note in real renderer';
    for (let attempt = 0; attempt < 100; attempt++) {
      const visible = await desktop.window.webContents.executeJavaScript('document.body.innerText');
      if (visible.includes('Desktop fixture')) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    const page = await desktop.window.webContents.executeJavaScript('({title: document.title, text: document.body.innerText, node: typeof process, require: typeof require})');
    assert.equal(page.title, 'Local Collab'); assert.ok(page.text.includes('Desktop fixture'));
    assert.equal(page.node, 'undefined'); assert.equal(page.require, 'undefined');
    const preferences = desktop.window.webContents.getLastWebPreferences();
    assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
    assert.equal(desktop.appDetails.appId, APP_ID);
    assert.ok(desktop.appDetails.appIconPath.endsWith('local-collab.ico'));
    stage = 'reuse existing server';
    let starts = 0;
    assert.equal((await ensureServer(desktop.base, () => { starts++; })).pid, desktop.health.pid);
    assert.equal(starts, 0);
    stage = 'second launch focuses existing window';
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), `--app-root=${appRoot}`, '--second-instance', configPath, profilePath], {
      stdio: 'ignore', windowsHide: true,
    });
    const code = await Promise.race([once(child, 'exit').then(([exitCode]) => exitCode), new Promise((_, reject) => setTimeout(() => { child.kill(); reject(new Error('Second instance timed out')); }, 15000))]);
    assert.equal(code, 0);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    stage = 'Settings button and trusted settings bridge';
    assert.equal(await desktop.window.webContents.executeJavaScript('document.querySelector("#desktop-settings")?.textContent'), 'Settings');
    assert.equal(await desktop.window.webContents.executeJavaScript('typeof window.desktopSettings'), 'undefined');
    const settings = await desktop.openSettings();
    const initial = await settings.webContents.executeJavaScript('window.desktopSettings.getState()');
    assert.equal(initial.enabled, false); assert.equal(initial.editable, true);
    stage = 'actual per-user startup registration and removal';
    app.setAppUserModelId(`${APP_ID}.smoke.${process.pid}`);
    assert.equal((await desktop.startup.setEnabled(true)).enabled, true);
    assert.ok(desktop.startup.launch.args.some(arg => arg.includes('config with spaces.json')));
    assert.equal((await desktop.startup.setEnabled(false)).enabled, false);
    app.setAppUserModelId(APP_ID);
    const invalid = await settings.webContents.executeJavaScript('window.desktopSettings.setStartup("yes").then(() => "accepted", error => error.message)');
    assert.ok(invalid.includes('enabled or disabled'));
    settings.destroy();
    stage = 'shortcut identity and icon readback';
    const shortcut = join(folder, 'Local Collab.lnk');
    assert.equal(shell.writeShortcutLink(shortcut, { target: process.execPath, icon: desktop.appDetails.appIconPath, iconIndex: 0, appUserModelId: APP_ID }), true);
    const saved = shell.readShortcutLink(shortcut);
    assert.equal(saved.appUserModelId, APP_ID);
    assert.equal(saved.icon, desktop.appDetails.appIconPath);
    assert.equal(await readFile(join(notesDir, 'desktop-fixture.md'), 'utf8'), fixture);
    stage = 'closing window preserves background API';
    app.removeAllListeners('window-all-closed');
    desktop.window.destroy();
    assert.equal((await (await fetch(`${desktop.base}/api/health`)).json()).pid, desktop.health.pid);
    await writeFile(resultPath, JSON.stringify({ ok: true, appRoot, folder, health: desktop.health, supervisorPid: desktop.supervisorPid, checks: [
      'starts real background server with bundled Node', 'loads existing notes and keeps fixture unchanged',
      'sandboxed renderer has no Node or require', 'reuses healthy server', 'single-instance launch',
      'shortcut app ID and custom icon', 'server remains after window closes',
      'visible Settings button and isolated IPC bridge', 'real Windows startup registration readback/removal',
    ] }, null, 2));
    process.kill(desktop.supervisorPid);
    process.kill(desktop.health.pid);
    app.exit(0);
  }
} catch (error) {
  const startupDebug = desktop?.startup ? app.getLoginItemSettings(desktop.startup.launch) : undefined;
  if (desktop?.startup) { try { await desktop.startup.setEnabled(false); } catch {} }
  await writeFile(resultPath, JSON.stringify({ ok: false, stage, error: error.stack, startupDebug }, null, 2));
  if (desktop?.supervisorPid) { try { process.kill(desktop.supervisorPid); } catch {} }
  if (desktop?.supervisorPid && desktop?.health.pid) { try { process.kill(desktop.health.pid); } catch {} }
  app.exit(1);
}
}
void runSmoke();
