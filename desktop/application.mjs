import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_ID, APP_NAME, desktopArguments, ensureServer, externalNavigation, localNavigation, quoteArgument, trustedFrame } from './policy.mjs';
import { createStartupController } from './startup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = existsSync(join(HERE, 'runtime', 'server.mjs')) ? join(HERE, 'runtime') : resolve(HERE, '..');
const ICON = join(RUNTIME, 'assets', process.platform === 'win32' ? 'local-collab.ico' : '../public/icon-512.png');
let mainWindow;
let openAttachment;

function focusMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function secureWindow(base, options = {}) {
  const window = new BrowserWindow({
    title: APP_NAME, icon: ICON, width: 1440, height: 920, minWidth: 720, minHeight: 500,
    show: false, autoHideMenuBar: true, backgroundColor: '#111827',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false },
    ...options,
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (localNavigation(url, base)) openAttachment(url);
    else if (externalNavigation(url)) shell.openExternal(url).catch(console.error);
    return { action: 'deny' };
  });
  const navigate = (event, url) => {
    if (localNavigation(url, base)) return;
    event.preventDefault();
    if (externalNavigation(url)) shell.openExternal(url).catch(console.error);
  };
  window.webContents.on('will-navigate', navigate);
  window.webContents.on('will-redirect', navigate);
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(window, {
      type: 'question', title: APP_NAME, message: 'Leave without saving your draft?',
      detail: 'Your unsaved text and queued images will be lost.',
      buttons: ['Keep editing', 'Leave'], defaultId: 0, cancelId: 0,
    });
    if (choice === 1) event.preventDefault();
  });
  return window;
}

async function installShortcuts(args, configPath) {
  if (process.platform !== 'win32' || !app.isPackaged) throw new Error('Shortcut setup requires the packaged Windows app.');
  const locations = [join(app.getPath('desktop'), `${APP_NAME}.lnk`), join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`)];
  for (const location of locations) {
    await mkdir(dirname(location), { recursive: true });
    if (existsSync(location) && !existsSync(`${location}.before-electron`)) await copyFile(location, `${location}.before-electron`);
    const details = { target: process.execPath, cwd: dirname(process.execPath), args,
      description: 'Open Local Collab', icon: process.execPath, iconIndex: 0, appUserModelId: APP_ID };
    if (!shell.writeShortcutLink(location, 'create', details)) throw new Error(`Could not create ${location}`);
    const saved = shell.readShortcutLink(location);
    if (saved.target !== details.target || saved.appUserModelId !== APP_ID || saved.args !== args) throw new Error(`Shortcut verification failed: ${location}`);
  }
  if (configPath) await writeFile(join(app.getPath('userData'), 'desktop-settings.json'), JSON.stringify({ configPath }, null, 2) + '\n');
  return locations;
}

async function configureDesktop({ argv = desktopArguments(process.argv, app.isPackaged), profilePath, configPath: explicitConfig, serverOnly = false } = {}) {
  app.setName(APP_NAME);
  app.setAppUserModelId(APP_ID);
  app.setPath('userData', profilePath ?? join(app.getPath('appData'), APP_NAME));
  await mkdir(app.getPath('userData'), { recursive: true });
  let saved = {};
  try { saved = JSON.parse(await readFile(join(app.getPath('userData'), 'desktop-settings.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const configArg = argv.find(value => value.startsWith('--config='))?.slice('--config='.length);
  const selectedConfig = explicitConfig ?? configArg ?? process.env.LOCAL_COLLAB_CONFIG ?? saved.configPath;
  const configPath = resolve(selectedConfig ?? join(app.getPath('userData'), 'local-collab.config.json'));
  if (selectedConfig && !existsSync(configPath)) throw new Error(`Configuration file not found: ${configPath}`);
  process.env.LOCAL_COLLAB_CONFIG = configPath;
  if (serverOnly) app.setPath('userData', join(app.getPath('userData'), 'server-launcher'));
  const { config } = await import(pathToFileURL(join(RUNTIME, 'lib', 'config.mjs')).href);
  return { argv, configPath, config };
}

async function backgroundServer(config) {
  const base = `http://127.0.0.1:${config.port}`;
  let supervisorPid;
  const health = await ensureServer(base, async () => {
    // Run the existing supervisor with Electron's bundled Node runtime. It stays
    // available to agents after the desktop window closes, just like npm run open.
    const child = spawn(process.execPath, [join(RUNTIME, 'service', 'supervise.mjs')], {
      cwd: RUNTIME, detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    await new Promise((resolveStarted, reject) => { child.once('spawn', resolveStarted); child.once('error', reject); });
    supervisorPid = child.pid;
    child.unref();
  });
  if (config.storage.type === 'filesystem' && health.notesDir &&
      resolve(health.notesDir).toLocaleLowerCase() !== resolve(config.notesDir).toLocaleLowerCase()) {
    throw new Error(`Another Local Collab workspace is using port ${config.port}. Use its configuration or a different port.`);
  }
  return { base, health, supervisorPid };
}

export async function startServerOnly(options = {}) {
  const { config } = await configureDesktop({ ...options, serverOnly: true });
  return backgroundServer(config);
}

export async function startDesktop(options = {}) {
  const { argv, configPath, config } = await configureDesktop(options);
  if (!app.requestSingleInstanceLock()) { app.quit(); return null; }
  app.on('second-instance', focusMain);
  app.on('activate', focusMain);
  await app.whenReady();
  const { base, health, supervisorPid } = await backgroundServer(config);
  mainWindow = secureWindow(base, {
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, preload: join(HERE, 'preload.cjs') },
  });
  const browserSession = mainWindow.webContents.session;
  browserSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(permission === 'clipboard-sanitized-write' && localNavigation(details.requestingUrl, base));
  });
  browserSession.setPermissionCheckHandler((_contents, permission, origin) => permission === 'clipboard-sanitized-write' && localNavigation(origin, base));
  const relaunchArgs = app.isPackaged ? [] : [HERE];
  const existingConfig = existsSync(configPath) ? configPath : undefined;
  if (existingConfig) relaunchArgs.push(`--config=${existingConfig}`);
  const args = relaunchArgs.map(quoteArgument).join(' ');
  const appDetails = { appId: APP_ID, appIconPath: ICON, appIconIndex: 0,
    relaunchCommand: `${quoteArgument(process.execPath)} ${args}`, relaunchDisplayName: APP_NAME };
  if (process.platform === 'win32') mainWindow.setAppDetails(appDetails);
  const startup = createStartupController({ app, configPath, ...options.startupOptions });
  let settingsWindow;
  const settingsUrl = pathToFileURL(join(HERE, 'settings.html')).href;
  const readStartup = async () => ({ ...await startup.getState(), server: base });
  const openSettings = async () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return settingsWindow; }
    settingsWindow = new BrowserWindow({ title: 'Local Collab Settings', icon: ICON, width: 560, height: 540,
      parent: mainWindow, resizable: false, autoHideMenuBar: true, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, preload: join(HERE, 'settings-preload.cjs') },
    });
    if (process.platform === 'win32') settingsWindow.setAppDetails(appDetails);
    settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
    settingsWindow.webContents.on('will-redirect', event => event.preventDefault());
    settingsWindow.on('closed', () => { settingsWindow = null; });
    settingsWindow.once('ready-to-show', () => settingsWindow?.show());
    await settingsWindow.loadURL(settingsUrl);
    return settingsWindow;
  };
  ipcMain.on('desktop:open-settings', event => {
    if (trustedFrame(event, mainWindow?.webContents, base, true)) openSettings().catch(console.error);
  });
  const requireSettings = event => {
    if (!trustedFrame(event, settingsWindow?.webContents, settingsUrl)) throw new Error('Settings request denied.');
  };
  ipcMain.handle('desktop:startup-state', event => { requireSettings(event); return readStartup(); });
  ipcMain.handle('desktop:startup-save', async (event, enabled) => {
    requireSettings(event);
    await startup.setEnabled(enabled);
    return readStartup();
  });
  openAttachment = url => {
    const child = secureWindow(base, { parent: mainWindow, width: 1100, height: 800 });
    if (process.platform === 'win32') child.setAppDetails(appDetails);
    child.loadURL(url).catch(error => { console.error(error); child.close(); });
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => { openSettings().catch(console.error); } }, { type: 'separator' }, { role: 'close' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ]));
  mainWindow.on('closed', () => { mainWindow = null; });
  app.on('window-all-closed', () => app.quit());
  await mainWindow.loadURL(`${base}/`);
  let shortcuts;
  if (argv.includes('--install-shortcuts')) shortcuts = await installShortcuts(args, existingConfig);
  return { window: mainWindow, base, health, shortcuts, configPath, appDetails, supervisorPid, openSettings, startup };
}
