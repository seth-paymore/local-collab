#!/usr/bin/env node
/**
 * Opens Local Collab in its own window: an Edge app window with no tabs or
 * address bar, separate from normal browsing. Starts the background server
 * first if it is not running. The desktop shortcut runs this with no console
 * (see service\create-shortcut.ps1).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../lib/config.mjs";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = `http://127.0.0.1:${config.port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthy() {
  try {
    return (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

async function waitUp(ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (await healthy()) return true;
  return false;
}

if (!(await healthy())) {
  // Prefer the login task, so the server outlives this window; fall back to
  // starting the supervisor directly if the task is missing.
  const task = process.platform === "win32" ? spawnSync("schtasks", ["/run", "/tn", "Local Collab"], { stdio: "ignore", windowsHide: true }) : {status:1};
  if (task.status !== 0 || !(await waitUp(8000))) {
    spawn(process.execPath, [join(APP_DIR, "service", "supervise.mjs")], { cwd: APP_DIR, detached: true, stdio: "ignore", windowsHide: true }).unref();
    await waitUp(8000);
  }
}

const edge = process.platform === "win32" && [
  join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
  join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
].find(existsSync);

if (edge) spawn(edge, [`--app=${BASE}/`, "--window-size=1440,920"], { detached: true, stdio: "ignore" }).unref();
else {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", `${BASE}/`] : [`${BASE}/`];
  const child = spawn(command, args, {detached:true,stdio:"ignore",windowsHide:true});
  child.on("error", () => console.log(`Open ${BASE}/ in your browser`));
  child.unref();
}
