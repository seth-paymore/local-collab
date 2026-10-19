/**
 * Local Collab: a private notes server over local Markdown notes.
 *
 * Runs in the background from login (see service\install.ps1), serves the page
 * at http://127.0.0.1:4317, and takes notes from humans and agents over
 * a small JSON API (see README.md). It listens on 127.0.0.1 only. The one
 * ActiveCollab sync reads shared tickets separately from private notes. The only
 * outbound mutation is explicitly confirmed parent completion; no notes are sent.
 *
 * Run by hand: node server.mjs [--open]
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { config, publicConfig } from "./lib/config.mjs";
import {StorageError} from "./lib/storage.mjs";
import {
  APP_DIR,
  NOTES_DIR,
  STATUSES,
  NoteError,
  activeCollabSummary,
  addEntry,
  createNote,
  getNote,
  listNotes,
  loadCache,
  refreshActiveCollab,
  refreshTicket,
  completeTicket,
  replaceRaw,
  search,
  updateMeta,
} from "./lib/notes.mjs";

const PUBLIC_DIR = join(APP_DIR, "public");
const PORT = config.port;
const HOST = "127.0.0.1";
const APP_URL = `http://${HOST}:${PORT}`;
const AC_REFRESH_MS = 60 * 60 * 1000;
const STARTED_AT = new Date().toISOString();

const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
  "/icon-192.png": ["icon-192.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
  "/favicon.ico": ["icon-192.png", "image/png"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, payload, type = "application/json; charset=utf-8") {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type });
  res.end(type.startsWith("application/json") ? JSON.stringify(payload) : payload);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new NoteError(413, "Request too large");
    chunks.push(chunk);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    throw new NoteError(400, "Body must be JSON");
  }
}

// A web page on another site must not be able to write here. Browsers only
// send a JSON body or a custom header cross-site after a CORS preflight, which
// this server never approves, and they always label such requests with an
// Origin. Local tools (curl, node, PowerShell) send JSON and no Origin.
function writeAllowed(req) {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return false;
  const json = (req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json");
  return json || req.headers["x-local-collab"] === "1";
}

async function route(req, res) {
  // Rejecting any other Host stops a site that rebinds its hostname to
  // 127.0.0.1 from reading these notes.
  if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) return send(res, 421, { error: "Unexpected Host header" });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD" && !writeAllowed(req)) {
    return send(res, 403, { error: "Writes need a JSON body (Content-Type: application/json) and no foreign Origin" });
  }

  if (method === "GET" && STATIC[url.pathname]) {
    const [name, type] = STATIC[url.pathname];
    return send(res, 200, await readFile(join(PUBLIC_DIR, name)), type);
  }

  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "api") return send(res, 404, { error: "Not found" });
  const [, resource, name, action] = parts;
  if (resource === "config" && method === "GET") return send(res, 200, publicConfig());

  if (resource === "health" && method === "GET") {
    return send(res, 200, { ok: true, app: "local-collab", url: APP_URL, notesDir: NOTES_DIR, pid: process.pid, startedAt: STARTED_AT });
  }

  if (resource === "notes" && !name) {
    if (method === "GET") return send(res, 200, { notesDir: config.storage.type==="http"?"Configured storage API":NOTES_DIR, statuses: STATUSES, notes: await listNotes() });
    if (method === "POST") return send(res, 201, await createNote(await readJson(req)));
  }
  if (resource === "notes" && name) {
    if (!action && method === "GET") return send(res, 200, await getNote(name));
    if (action === "entries" && method === "POST") {
      const note = await addEntry(name, await readJson(req));
      log(`entry ${note.file} by ${note.entries.at(-1)?.author ?? "?"}${note.created ? " (new note)" : ""}`);
      return send(res, note.created ? 201 : 200, note);
    }
    if ((action === "meta" || !action) && method === "PATCH") return send(res, 200, await updateMeta(name, await readJson(req)));
    if (action === "raw" && method === "PUT") {
      const body = await readJson(req);
      return send(res, 200, await replaceRaw(name, body.raw, body.version));
    }
  }
  if (resource === "search" && method === "GET") return send(res, 200, { results: await search(url.searchParams.get("q")) });
  if (resource === "activecollab" && !name && method === "GET") return send(res, 200, await activeCollabSummary());
  if (resource === "activecollab" && name === "refresh" && method === "POST") return send(res, 200, await refreshActiveCollab());
  if (resource === "activecollab" && /^\d{1,7}$/.test(name ?? "") && method === "POST") {
    if (action === "refresh") return send(res, 200, await refreshTicket(name));
    if (action === "complete") return send(res, 200, await completeTicket(name, await readJson(req)));
  }

  return send(res, 404, { error: "Not found. See README.md for the API." });
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    const expected=err instanceof NoteError || err instanceof StorageError;
    if (!expected) log("error", err);
    send(res, expected ? err.status : 500, { error: expected ? err.message : "Server error, see logs\\server.log" });
  });
});

// Keeps ticket names and assignees current while the server runs all day.
// Read only; a failure (no token, network down) is logged and retried later.
async function refreshIfStale() {
  if (!config.activeCollab.enabled) return;
  const { fetchedAt } = await loadCache();
  const { detailsFetchedAt } = await loadCache();
  if (detailsFetchedAt && fetchedAt && Date.now() - Date.parse(fetchedAt) < AC_REFRESH_MS - 60_000) return;
  try {
    const summary = await refreshActiveCollab();
    log(`ActiveCollab refreshed: ${summary.openTasks} open tasks`);
  } catch (err) {
    log(`ActiveCollab refresh failed: ${err.message}`);
  }
}

// --open launches Edge once the server is listening, or, when an earlier copy
// already holds the port, just opens that one.
function openBrowser() {
  if (!process.argv.includes("--open")) return;
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", APP_URL] : [APP_URL];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide:true });
  child.on("error", err => log(`Open ${APP_URL} in your browser (${err.code})`));
  child.unref();
}

server.on("error", (err) => {
  if (err.code !== "EADDRINUSE") throw err;
  log(`Local Collab is already running at ${APP_URL}`);
  openBrowser();
  process.exit(0);
});

server.listen(PORT, HOST, () => {
  log(`Local Collab listening on ${APP_URL}, notes in ${NOTES_DIR}`);
  openBrowser();
  refreshIfStale();
  setInterval(refreshIfStale, AC_REFRESH_MS).unref();
});
