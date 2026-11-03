import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ID } from './policy.mjs';

const execute = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./startup-task.ps1', import.meta.url));

export function createStartupController({ app, configPath, executable = process.execPath,
  packaged = app.isPackaged, taskName = 'Local Collab', loginItemName = APP_ID,
  legacyTask, platform = process.platform } = {}) {
  const args = [...(packaged ? [] : [dirname(fileURLToPath(import.meta.url))]), '--server-only'];
  if (configPath && existsSync(configPath)) args.push(`--config=${configPath}`);
  // Electron quotes executable/arguments when writing the Windows command line.
  const launch = { path: executable, args };
  const legacy = legacyTask ?? (async action => {
    const literal = value => `'${String(value).replaceAll("'", "''")}'`;
    const command = `& {${await readFile(SCRIPT, 'utf8')}\n} -Action ${literal(action)} -ExpectedSupervisor ${literal(join(dirname(configPath), 'service', 'supervise.mjs'))} -TaskName ${literal(taskName)}`;
    try {
      // Run the task cmdlets directly. This does not change the machine's script
      // execution policy and works when unsigned .ps1 files cannot be launched.
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000 });
      return JSON.parse(stdout.trim());
    } catch (error) {
      throw new Error(error.stderr?.trim().split('\n').slice(0, 2).join(' ') || 'Windows startup could not be read or changed.');
    }
  });
  async function getState() {
    if (platform !== 'win32') return { supported: false, enabled: false, editable: false };
    const task = await legacy('Get');
    const native = app.getLoginItemSettings(launch);
    // openAtLogin verifies the complete command at the app ID's registry name.
    // Check that same entry's enabled flag, rather than another login command.
    const nativeItem = native.launchItems?.find(item => item.name === loginItemName && item.scope === 'user');
    const nativeEnabled = native.openAtLogin && nativeItem?.enabled;
    return { supported: true, enabled: Boolean(task.enabled || nativeEnabled),
      editable: !task.present || task.managed, source: task.enabled ? 'task' : nativeEnabled ? 'desktop' : 'none' };
  }
  async function setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Startup must be enabled or disabled.');
    if (platform !== 'win32') throw new Error('Windows startup is not available on this platform.');
    const task = await legacy('Get');
    if (task.present && !task.managed) throw new Error('A different Local Collab startup task exists. Manage it in Windows Task Scheduler.');
    if (task.present) {
      // Preserve an existing installation rather than register a second server.
      await legacy(enabled ? 'Enable' : 'Disable');
      if (!enabled) app.setLoginItemSettings({ ...launch, name: loginItemName, openAtLogin: false });
    } else app.setLoginItemSettings({ ...launch, name: loginItemName, openAtLogin: enabled, enabled });
    const saved = await getState();
    if (saved.enabled !== enabled) throw new Error('Windows did not save the startup setting.');
    return saved;
  }
  return { getState, setEnabled, launch };
}
