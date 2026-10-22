/**
 * Portable Markdown notes persisted through the configured storage provider.
 *
 * Both the server and bin\note.mjs use this module, so there is one definition
 * of the file format. The selected note collection is the source of truth;
 * tracker snapshots are separate derived data.
 */
import { readFile, writeFile, rename, mkdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { APP_DIR, config } from "./config.mjs";
import { createHash } from "node:crypto";
import {createStorage,StorageError} from "./storage.mjs";
import {searchRecords} from "./search.mjs";

export { APP_DIR };
export const NOTES_DIR = config.notesDir;
export const storage = createStorage(config.storage,NOTES_DIR);
const CACHE_DIR=join(NOTES_DIR,".cache",`activecollab-${config.activeCollab.accountId ?? "off"}-${config.activeCollab.projectId ?? "off"}-${config.activeCollab.userId ?? "off"}`);
const CACHE_FILE = join(CACHE_DIR,"index.json");

const AC_WEB = `https://app.activecollab.com/${config.activeCollab.accountId}`;
const AC_API = `${AC_WEB}/api/v1`;
const AC_PROJECT = config.activeCollab.projectId;
const AC_USER_ID = config.activeCollab.userId;

export const DEFAULT_AUTHOR = config.author;
export const STATUSES = ["active", "waiting", "blocked", "parked", "done"];
const FILE_RE = /^[a-z0-9][a-z0-9-]{0,80}\.md$/;
const TICKET_FILE_RE = /^ac-(\d+)\.md$/;
// "## 2026-10-19 Claude" or "## 2026-10-19 14:05 ChatGPT"
const ENTRY_RE = /^## (\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))? +(.+?)\s*$/;
const AUTHOR_RE = /^[A-Za-z][\w .-]{0,39}$/;
const META_ORDER = ["ticket", "title", "status", "next"];

/** An error with the HTTP status the server should answer with. */
export class NoteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ------------------------------------------------------------------ format

function splitFront(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fm) return { meta: {}, body: text };
  const meta = {};
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  return { meta, body: text.slice(fm[0].length) };
}

function joinFront(meta, body) {
  const keys = [...META_ORDER.filter((k) => k in meta), ...Object.keys(meta).filter((k) => !META_ORDER.includes(k))];
  const lines = keys.map((k) => `${k}: ${meta[k] ?? ""}`.trimEnd());
  return `---\n${lines.join("\n")}\n---\n\n${body.replace(/^\n+/, "")}`;
}

function parseNote(raw) {
  const { meta, body } = splitFront(raw);
  const summary = [];
  const entries = [];
  let current = null;
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(ENTRY_RE);
    if (m) {
      current = { date: m[1], time: m[2] ?? "", author: m[3], lines: [] };
      entries.push(current);
      continue;
    }
    (current ? current.lines : summary).push(line);
  }
  return {
    meta,
    summary: summary.join("\n").trim(),
    entries: entries.map(({ lines, ...e }, index) => {
      let text = lines.join("\n").trim();
      let identity = {};
      const request=text.match(/^<!-- local-collab-request ([0-9a-f-]{36}) -->\n*/);
      if(request)text=text.slice(request[0].length);
      const marker = text.match(/^<!-- local-collab-identity (.+) -->\n*/);
      if (marker) {
        try { identity = cleanIdentity(JSON.parse(marker[1])); text = text.slice(marker[0].length); }
        catch { /* Preserve malformed metadata as ordinary note text. */ }
      }
      return { ...e, index, ...identity, ...(request?{requestId:request[1]}:{}), text };
    }),
  };
}

const sortKey = (e) => `${e.date} ${e.time.padStart(5, "0")}`;

function latestEntry(entries) {
  let best = null;
  for (const e of entries) if (!best || sortKey(e) >= sortKey(best)) best = e;
  return best;
}

const versionOf = (raw) => createHash("sha256").update(raw).digest("hex").slice(0, 16);

const oneLine = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();

function localStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

function cleanAuthor(author) {
  const value = oneLine(author) || DEFAULT_AUTHOR;
  if (!AUTHOR_RE.test(value)) throw new NoteError(400, "Author must be a short name starting with a letter");
  return value;
}

function cleanIdentity(value = {}) {
  const result = {};
  for (const key of ["agent", "provider", "model"]) {
    if (value[key] === undefined || value[key] === "") continue;
    if (typeof value[key] !== "string" || value[key].length > 100 || !/^[\p{L}\p{N} ._:/-]+$/u.test(value[key])) throw new NoteError(400, `Invalid ${key}`);
    result[key] = value[key].trim();
  }
  return result;
}

function cleanStatus(status) {
  const value = oneLine(status).toLowerCase();
  if (!STATUSES.includes(value)) throw new NoteError(400, `Status must be one of ${STATUSES.join(", ")}`);
  return value;
}

/**
 * Accepts the ways people and assistants name a note, and returns its file:
 * "123", "#123", "ac-123", "ac-123.md" -> "ac-123.md"; "release-plan" -> "release-plan.md".
 */
export function noteFile(name) {
  const n = String(name ?? "").trim().replace(/^#/, "").replace(/\.md$/i, "").toLowerCase();
  if (/^\d{1,7}$/.test(n)) return `ac-${n}.md`;
  const file = `${n}.md`;
  if (!FILE_RE.test(file)) throw new NoteError(400, `Invalid note name "${name}". Use a ticket number such as 123, or a topic slug such as release-plan.`);
  return file;
}

function ticketOf(file, meta) {
  const m = file.match(TICKET_FILE_RE);
  if (m) return m[1];
  return /^\d+$/.test(meta.ticket ?? "") ? meta.ticket : "";
}

// ------------------------------------------------------------------ writes

async function writeAtomic(path, content) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  // Windows refuses a rename while another process briefly holds the target.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) {
        await rm(tmp, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
    }
  }
}

// Every write is read-modify-write, so two quick edits to one note (status then
// next step, or two assistants posting at once) must run one after the other
// or the second drops the first.
const fileLocks = new Map();
function withFileLock(file, fn) {
  const run = (fileLocks.get(file) ?? Promise.resolve()).then(fn, fn);
  fileLocks.set(file, run.catch(() => {}));
  return run;
}

async function existingRecord(file) {
  try {return await storage.read(file);}
  catch(err) {if(err instanceof StorageError && err.status===404)return null;throw err;}
}

export async function uploadImage(name, bytes) {
  const file=noteFile(name);
  return withFileLock(file,async()=>{
    await storage.read(file);
    const {bytes:ignored,...image}=await storage.putImage(file,bytes);
    return {...image,url:`/api/notes/${file}/attachments/${image.id}`};
  });
}
export async function readImage(name,id) {
  return storage.getImage(noteFile(name),id);
}

async function newNoteMeta(file, title) {
  const ticket = ticketOf(file, {});
  const meta = {};
  if (ticket) {
    meta.ticket = ticket;
    meta.title = oneLine(title) || (await loadCache()).tasks?.[ticket]?.name || "";
  } else {
    meta.title = oneLine(title) || file.replace(/\.md$/, "").replace(/-/g, " ");
  }
  meta.status = "active";
  meta.next = "";
  return meta;
}

function applyMeta(meta, { title, status, next }) {
  if (title !== undefined) meta.title = oneLine(title);
  if (status !== undefined) meta.status = cleanStatus(status);
  if (next !== undefined) meta.next = oneLine(next);
}

/** Creates an empty note. Fails if it already exists. */
export async function createNote({ ticket, topic, title }) {
  if (!String(ticket ?? "").trim() && !oneLine(topic)) throw new NoteError(400, "Give a ticket number or a topic name");
  const file = noteFile(String(ticket ?? "").trim() || oneLine(topic).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60));
  return withFileLock(file, async () => {
    if (await existingRecord(file)) throw new NoteError(409, `${file} already exists`);
    await storage.write(file,joinFront(await newNoteMeta(file,title || topic),""),null);
    return getNote(file);
  });
}

/**
 * Appends one entry, creating the note first if it does not exist, and
 * optionally updates title, status and next step in the same write. This is the
 * call assistants use.
 */
export async function addEntry(name, { text, author, title, status, next, agent, provider, model, requestId } = {}) {
  const file = noteFile(name);
  const body = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!body) throw new NoteError(400, "Entry text is empty");
  const who = cleanAuthor(author);
  const identity = cleanIdentity({agent, provider, model});
  if(requestId!==undefined && (typeof requestId!=="string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(requestId)))throw new NoteError(400,"Invalid save identifier");
  const marker = (requestId?`<!-- local-collab-request ${requestId} -->\n\n`:"")+(Object.keys(identity).length ? `<!-- local-collab-identity ${JSON.stringify(identity)} -->\n\n` : "");
  // A line that looks like an entry heading would split this entry in two.
  const safe = body.replace(/^## (?=\d{4}-\d{2}-\d{2})/gm, "### ");
  return withFileLock(file, async () => {
    const record=await existingRecord(file);
    if(requestId && record) {
      const saved=parseNote(record.raw).entries.find(entry=>entry.requestId===requestId);
      if(saved) {
        if(saved.text!==safe || saved.author!==who || ["agent","provider","model"].some(key=>(saved[key]??"")!==(identity[key]??"")))throw new NoteError(409,"That save identifier was already used for another entry");
        return getNote(file);
      }
    }
    const exists=Boolean(record);
    const { meta, body: existing } = exists ? splitFront(record.raw) : { meta: await newNoteMeta(file, title), body: "" };
    applyMeta(meta, { title: exists ? title : undefined, status, next });
    const ticket = ticketOf(file, meta);
    if (ticket && !meta.ticket) meta.ticket = ticket;
    const content = joinFront(meta, `${existing.replace(/\s*$/, "")}\n\n## ${localStamp()} ${who}\n\n${marker}${safe}\n`);
    await storage.write(file,content,record?.revision ?? null);
    return { ...(await getNote(file)), created: !exists };
  });
}

/** Updates title, status and/or next step. */
export async function updateMeta(name, updates = {}) {
  const file = noteFile(name);
  return withFileLock(file, async () => {
    const record=await storage.read(file);
    const { meta, body } = splitFront(record.raw);
    applyMeta(meta, updates);
    const ticket = ticketOf(file, meta);
    if (ticket && !meta.ticket) meta.ticket = ticket;
    await storage.write(file,joinFront(meta,body),record.revision);
    return getNote(file);
  });
}

/** Replaces the whole file, refusing if it changed since `version` was read. */
export async function replaceRaw(name, raw, version) {
  const file = noteFile(name);
  return withFileLock(file, async () => {
    const record=await storage.read(file);
    if (versionOf(record.raw) !== version) {
      throw new NoteError(409, "This note changed on disk since you opened it (another assistant may have written to it). Reload and redo the edit.");
    }
    await storage.write(file,String(raw ?? "").replace(/\r\n/g,"\n"),record.revision);
    return getNote(file);
  });
}

// ------------------------------------------------------------------- reads

function describe(file, raw, info, ac) {
  const note = parseNote(raw);
  const ticket = ticketOf(file, note.meta);
  const task = ticket ? ac.tasks?.[ticket] : undefined;
  const last = latestEntry(note.entries);
  return {
    file,
    ticket,
    title: note.meta.title || task?.name || file.replace(/\.md$/, "").replace(/-/g, " "),
    status: STATUSES.includes(note.meta.status) ? note.meta.status : "active",
    next: note.meta.next ?? "",
    modified: info.mtimeMs,
    entries: note.entries.length,
    last: last ? { date: last.date, time: last.time, author: last.author } : null,
    ac: task ?? null,
  };
}

async function readCollection() {
  const names = await storage.list();
  const pending=[...names],records=[];
  await Promise.all(Array.from({length:Math.min(8,names.length)},async()=>{
    for(let file;(file=pending.shift());)records.push({file,...await storage.read(file)});
  }));
  return records.sort((a,b)=>b.modified-a.modified);
}

export async function listNotes() {
  const records=await readCollection();
  const ac = await loadCache();
  return records.map(record=>describe(record.file,record.raw,{mtimeMs:record.modified},ac));
}

export async function getNote(name) {
  const file = noteFile(name);
  const record=await storage.read(file);
  const raw=record.raw;
  const info={mtimeMs:record.modified};
  const ac = await loadCache();
  const note = { ...describe(file, raw, info, ac), ...parseNote(raw), raw, version: versionOf(raw) };
  if (note.ac) {
    const detail = await ticketDetails(note.ticket);
    note.ac = { ...note.ac, ...(detail ? {name:detail.name, completed:detail.completed} : {}), detail };
    note.ac.syncError = ac.detailErrors?.find(e => e.number === note.ticket)?.error;
  }
  return note;
}

export async function search(query) {
  if (String(query ?? '').trim().length < 2) return [];
  const records=await readCollection();
  const ac=await loadCache();
  return searchRecords(records.map(record=>({...record,
    note:describe(record.file,record.raw,{mtimeMs:record.modified},ac)})),query);
}

// ------------------------------------------------------------ ActiveCollab

export async function loadCache() {
  if (!config.activeCollab.enabled) return {fetchedAt:null, tasks:{}};
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf8"));
  } catch {
    return { fetchedAt: null, tasks: {} };
  }
}

function activeCollabToken() {
  if (!config.activeCollab.enabled) throw new NoteError(503, "ActiveCollab is not configured");
  if (process.env.ACTIVECOLLAB_TOKEN?.trim()) return process.env.ACTIVECOLLAB_TOKEN.trim();
  const envFile = config.activeCollab.tokenFile;
  if (envFile && existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(ACTIVE_COLLAB|ACTIVECOLLAB_TOKEN)\s*=\s*(.+)$/);
      if (m && m[2].trim()) return m[2].trim();
    }
  }
  throw new NoteError(503, "Set ACTIVECOLLAB_TOKEN or configure a tokenFile containing ACTIVECOLLAB_TOKEN");
}

async function acGet(token, path, method = "GET") {
  const response = await fetch(`${AC_API}${path}`, { method, headers: { "X-Angie-AuthApiToken": token }, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  if (!response.ok) throw new NoteError(502, `ActiveCollab ${method} ${path} returned ${response.status}`);
  const data = text ? JSON.parse(text) : {};
  return data.single ?? data;
}

const rows = (data, key) => Array.isArray(data) ? data : data[key] ?? [];

async function acPages(token, path, key) {
  const all = [], seen = new Set();
  for (let page = 1; page <= 1000; page++) {
    const payload = await acGet(token, `${path}?page=${page}`);
    if (!Array.isArray(payload) && !Array.isArray(payload[key])) throw new NoteError(502, `ActiveCollab returned no ${key} list at ${path}`);
    const batch = rows(payload, key);
    for (const item of batch) {
      if (seen.has(item.id)) throw new NoteError(502, `ActiveCollab pagination repeated an item at ${path}; retry the pull`);
      seen.add(item.id);
      all.push(item);
    }
    if (batch.length < 30) return all;
  }
  throw new NoteError(502, `ActiveCollab pagination limit reached at ${path}`);
}

async function readTicket(token, id) {
  const [payload, comments, subtasks] = await Promise.all([
    acGet(token, `/projects/${AC_PROJECT}/tasks/${id}`),
    acPages(token, `/comments/task/${id}`, "comments"),
    acGet(token, `/projects/${AC_PROJECT}/tasks/${id}/subtasks`),
  ]);
  const task = payload.task ?? payload;
  if (task.id !== id || task.project_id !== AC_PROJECT || task.is_trashed) throw new NoteError(502, "ActiveCollab returned an unexpected ticket");
  const detail = {
    name: task.name, body: task.body ?? "", completed: Boolean(task.is_completed), completedOn: task.completed_on,
    assigneeIds: [...new Set([...(task.assignee_ids ?? []), task.assignee_id].filter(Boolean))],
    updatedOn: task.updated_on, labels: task.labels ?? [], dueOn: task.due_on,
    comments: rows(comments, "comments").filter(c => !c.is_trashed).map(c => ({id:c.id, author:c.created_by_name ?? "Unknown", createdOn:c.created_on, body:c.body ?? ""})),
    subtasks: rows(subtasks, "subtasks").filter(s => !s.is_trashed).map(s => ({id:s.id, name:s.name, completed:Boolean(s.is_completed), assigneeId:s.assignee_id})),
  };
  return { ...detail, version: versionOf(JSON.stringify(detail)), fetchedAt: new Date().toISOString() };
}

async function ticketDetails(number) {
  try { return JSON.parse(await readFile(join(CACHE_DIR, `ticket-${number}.json`), "utf8")); }
  catch (err) { if (err.code === "ENOENT") return null; throw err; }
}

async function saveTicketDetail(number, detail) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeAtomic(join(CACHE_DIR, `ticket-${number}.json`), JSON.stringify(detail));
  await withFileLock(CACHE_FILE, async () => {
    const cache = await loadCache();
    if (cache.tasks?.[number]) Object.assign(cache.tasks[number], {name:detail.name, completed:detail.completed});
    cache.detailErrors = (cache.detailErrors ?? []).filter(e => e.number !== String(number));
    await writeAtomic(CACHE_FILE, JSON.stringify(cache));
  });
}

export async function refreshTicket(number) {
  if (!/^\d{1,7}$/.test(String(number))) throw new NoteError(400, "Invalid ticket number");
  const task = (await loadCache()).tasks?.[number];
  if (!task) throw new NoteError(404, "Refresh ActiveCollab first to find this ticket");
  return withFileLock(`ticket-${number}`, async () => {
    const detail = await readTicket(activeCollabToken(), task.id);
    await saveTicketDetail(number, detail);
    return detail;
  });
}

/** The only outbound mutation. Never sends note text, descriptions or comments. */
export async function completeTicket(number, { version, confirmed } = {}) {
  if (confirmed !== true || !version) throw new NoteError(400, "Review the ticket and confirm completion first");
  const note = await getNote(number);
  if (note.status !== "done") throw new NoteError(409, "Set the local working status to done before syncing completion");
  if (!note.ac) throw new NoteError(404, "Ticket not in the ActiveCollab cache");
  return withFileLock(`ticket-${number}`, async () => {
    const token = activeCollabToken();
    const live = await readTicket(token, note.ac.id);
    if (live.version !== version) throw new NoteError(409, "The ActiveCollab ticket changed. Refresh and review it again");
    if (live.subtasks.some(s => !s.completed)) throw new NoteError(409, "Open subtasks remain. Review or retire those requirements in ActiveCollab before completing the parent");
    if (!live.assigneeIds.includes(AC_USER_ID)) throw new NoteError(409, "The configured user must be assigned in ActiveCollab before completing this ticket");
    if (!live.completed) await acGet(token, `/complete/task/${note.ac.id}`, "PUT");
    const verified = await readTicket(token, note.ac.id);
    if (!verified.completed || !verified.completedOn) throw new NoteError(502, "Completion could not be verified. Refresh before retrying");
    await saveTicketDetail(number, verified);
    return verified;
  });
}

/** Reads open tasks and users from ActiveCollab. Never writes to it. */
let refreshRun;
export function refreshActiveCollab() {
  if (!refreshRun) refreshRun = refreshAll().finally(() => { refreshRun = null; });
  return refreshRun;
}

async function refreshAll() {
  const token = activeCollabToken();
  const [project, archive, usersPayload] = await Promise.all([acGet(token, `/projects/${AC_PROJECT}/tasks`), acPages(token, `/projects/${AC_PROJECT}/tasks/archive`, "tasks"), acGet(token, "/users")]);
  if (!Array.isArray(project.tasks)) throw new NoteError(502, "ActiveCollab returned no task list");
  const users = Array.isArray(usersPayload) ? usersPayload : usersPayload.users ?? [];
  const names = new Map(users.map((u) => [u.id, u.display_name ?? `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim()]));
  const lists = new Map((project.task_lists ?? []).map((l) => [l.id, l.name]));
  const tasks = {};
  for (const t of [...rows(archive, "tasks"), ...project.tasks]) {
    if (t.is_trashed) continue;
    const ids = [...new Set([...(t.assignee_ids ?? []), t.assignee_id].filter(Boolean))];
    tasks[t.task_number] = {
      id: t.id,
      number: String(t.task_number),
      name: t.name,
      list: lists.get(t.task_list_id) ?? "",
      assignees: ids.map((id) => names.get(id) ?? `user ${id}`),
      assignedToMe: ids.includes(AC_USER_ID),
      createdByMe: t.created_by_id === AC_USER_ID,
      completed: Boolean(t.is_completed),
      updatedOn: t.updated_on ? t.updated_on * 1000 : null,
      url: `${AC_WEB}/projects/${AC_PROJECT}?modal=Task-${t.id}-${AC_PROJECT}`,
    };
  }
  const cache = { fetchedAt: new Date().toISOString(), tasks };
  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeAtomic(CACHE_FILE, JSON.stringify(cache, null, 2));
  const noted = new Set((await listNotes()).map(n => n.ticket));
  const pending = Object.values(tasks).filter(t => noted.has(t.number) || (!t.completed && (t.assignedToMe || t.createdByMe)));
  const errors = [];
  // Limit API traffic; each worker fetches one ticket's three resources at a time.
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let task; (task = pending.shift());) {
      try { await refreshTicket(task.number); }
      catch (err) { errors.push({number:task.number, error:err.message}); }
    }
  }));
  return withFileLock(CACHE_FILE, async () => {
    const latest = await loadCache();
    latest.detailErrors = errors;
    latest.detailsFetchedAt = new Date().toISOString();
    await writeAtomic(CACHE_FILE, JSON.stringify(latest, null, 2));
    return activeCollabSummary(latest);
  });
}

export async function activeCollabSummary(cache) {
  cache ??= await loadCache();
  const noted = new Set((await listNotes()).map((n) => n.ticket).filter(Boolean));
  const mine = Object.values(cache.tasks ?? {})
    .filter((t) => (t.assignedToMe || t.createdByMe) && !t.completed)
    .map((t) => ({ ...t, hasNotes: noted.has(t.number) }))
    .sort((a, b) => Number(b.number) - Number(a.number));
  // Ticket number -> API id, so "#123" in a note can link to ActiveCollab.
  const ids = Object.fromEntries(Object.values(cache.tasks ?? {}).map((t) => [t.number, t.id]));
  return { enabled:config.activeCollab.enabled, fetchedAt: cache.fetchedAt, detailsFetchedAt:cache.detailsFetchedAt, detailErrors:cache.detailErrors ?? [], openTasks: Object.values(cache.tasks ?? {}).filter(t => !t.completed).length, mine, ids, urls:Object.fromEntries(Object.values(cache.tasks ?? {}).map(t=>[t.number,t.url])) };
}
