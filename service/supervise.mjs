/**
 * Keeps server.mjs running for the login task (service\install.ps1).
 *
 * Restarts the server if it crashes, backing off up to a minute between tries,
 * and writes its output to logs\server.log (rotated at 2 MB). Exits when the
 * server exits cleanly, which is what it does when another copy already holds
 * the port, so a second launch never fights the first.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = join(APP_DIR, "logs");
const LOG_FILE = join(LOG_DIR, "server.log");
const MAX_LOG_BYTES = 2 * 1024 * 1024;

mkdirSync(LOG_DIR, { recursive: true });
if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`);
const log = createWriteStream(LOG_FILE, { flags: "a" });
const note = (line) => log.write(`${new Date().toISOString()} [supervisor] ${line}\n`);

let delay = 1000;

function start() {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [join(APP_DIR, "server.mjs")], {
    cwd: APP_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  note(`started server pid ${child.pid}`);

  child.on("exit", (code, signal) => {
    note(`server exited (code ${code}, signal ${signal})`);
    if (code === 0) {
      log.end(() => process.exit(0));
      return;
    }
    // A server that ran for a while before failing gets a quick restart; one
    // that keeps failing at startup backs off so it does not spin.
    if (Date.now() - startedAt > 60_000) delay = 1000;
    note(`restarting in ${delay / 1000}s`);
    setTimeout(start, delay);
    delay = Math.min(delay * 2, 60_000);
  });
}

start();
