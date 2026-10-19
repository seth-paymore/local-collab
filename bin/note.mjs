#!/usr/bin/env node
/**
 * Command line for Local Collab, meant for agents.
 *
 * Talks to the server at http://127.0.0.1:4317. If the server is not running
 * (or a sandbox blocks localhost), it writes the same file directly through
 * lib\notes.mjs, so a note is never lost; the page picks it up either way.
 *
 *   node bin\note.mjs add 123 --author Claude --text "Reviewed the release checklist."
 *   node bin\note.mjs add 123 --author ChatGPT --status waiting --next "Human review" --file notes.md
 *   node bin\note.mjs set 123 --status done
 *   node bin\note.mjs show 123
 *   node bin\note.mjs list [--status open|active|waiting|blocked|parked|done|all]
 *   node bin\note.mjs search "preflight"
 *   node bin\note.mjs health
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import * as notes from "../lib/notes.mjs";
import { config } from "../lib/config.mjs";

const BASE = `http://127.0.0.1:${config.port}`;

const USAGE = `Usage:
  note add <ticket|topic> --author <name> (--text "..." | --file path | stdin)
           [--agent <name>] [--provider <provider>] [--model <model>]
           [--status active|waiting|blocked|parked|done] [--next "..."] [--title "..."]
  note set <ticket|topic> [--status ...] [--next "..."] [--title "..."]
  note show <ticket|topic>
  note list [--status open|all|active|waiting|blocked|parked|done]
  note search <text>
  note health

<ticket|topic> is a ticket number such as 123, or a topic slug such as release-plan.
"add" creates the note if it does not exist yet.`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    author: { type: "string" },
    agent: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    text: { type: "string" },
    file: { type: "string" },
    status: { type: "string" },
    next: { type: "string" },
    title: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, ...rest] = positionals;

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

let usedFallback = false;

// Calls the server; on a refused connection, runs `offline` against the files.
async function call(method, path, body, offline) {
  try {
    const response = await fetch(`${BASE}/api${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error ?? `HTTP ${response.status}`), { fromServer: true });
    return data;
  } catch (err) {
    if (err.fromServer || !offline) throw err;
    // A dropped response can follow a committed write. Replaying it through
    // storage directly would duplicate an entry or overwrite newer work.
    if (method !== "GET" && err.cause?.code !== "ECONNREFUSED") {
      throw new Error("The local API write outcome is uncertain. Read the latest note before retrying; no fallback write was attempted");
    }
    usedFallback = true;
    return offline();
  }
}

const meta = () => Object.fromEntries(["title", "status", "next"].filter((k) => opts[k] !== undefined).map((k) => [k, opts[k]]));
const viewUrl = (file) => `${BASE}/#/${file}`;

function printNote(note) {
  console.log(`${note.ticket ? `#${note.ticket} ` : ""}${note.title}`);
  console.log(`status: ${note.status}${note.next ? `   next: ${note.next}` : ""}`);
  if (note.ac) console.log(`ActiveCollab: ${note.ac.list}, assigned to ${note.ac.assignees.join(", ") || "nobody"}`);
  if (note.ac?.detail) {
    const d = note.ac.detail;
    console.log(`\n--- ActiveCollab snapshot (${d.fetchedAt}; ${d.completed ? "completed" : "open"}) ---\n${d.name}\n${d.body}`);
    for (const s of d.subtasks) console.log(`${s.completed ? "[x]" : "[ ]"} ${s.name}`);
    for (const c of d.comments) console.log(`\nActiveCollab comment ${c.id} by ${c.author}:\n${c.body}`);
    console.log("\n--- Private working notes (never posted to ActiveCollab) ---");
  }
  if (note.summary) console.log(`\n${note.summary}`);
  for (const e of [...note.entries].reverse()) console.log(`\n## ${e.date}${e.time ? ` ${e.time}` : ""} ${e.author}${[e.agent,e.provider,e.model].filter(Boolean).length ? ` [${[e.agent,e.provider,e.model].filter(Boolean).join(" · ")}]` : ""}\n${e.text}`);
  console.log(`\n${viewUrl(note.file)}`);
}

async function main() {
  if (opts.help || !command) {
    console.log(USAGE);
    return;
  }
  const name = rest[0];
  const needName = () => {
    if (!name) throw new Error(`"${command}" needs a ticket number or topic slug.\n\n${USAGE}`);
  };

  if (command === "add") {
    needName();
    const text = opts.text ?? (opts.file ? readFileSync(opts.file, "utf8") : await readStdin());
    if (!opts.author) throw new Error("Pass --author <name> so the entry says who wrote it.");
    const body = { text, author: opts.author, agent:opts.agent, provider:opts.provider, model:opts.model, ...meta() };
    const note = await call("POST", `/notes/${encodeURIComponent(name)}/entries`, body, () => notes.addEntry(name, body));
    if (opts.json) return console.log(JSON.stringify(note, null, 2));
    console.log(`${note.created ? "Created" : "Updated"} ${note.file}: entry by ${opts.author}, status ${note.status}${note.next ? `, next: ${note.next}` : ""}`);
    console.log(viewUrl(note.file));
  } else if (command === "set") {
    needName();
    if (!Object.keys(meta()).length) throw new Error("Pass at least one of --status, --next or --title.");
    const note = await call("PATCH", `/notes/${encodeURIComponent(name)}`, meta(), () => notes.updateMeta(name, meta()));
    console.log(`Updated ${note.file}: status ${note.status}${note.next ? `, next: ${note.next}` : ""}`);
  } else if (command === "show") {
    needName();
    const note = await call("GET", `/notes/${encodeURIComponent(name)}`, undefined, () => notes.getNote(name));
    if (opts.json) return console.log(JSON.stringify(note, null, 2));
    printNote(note);
  } else if (command === "list") {
    const { notes: all } = await call("GET", "/notes", undefined, async () => ({ notes: await notes.listNotes() }));
    const filter = (opts.status ?? "open").toLowerCase();
    const shown = all.filter((n) => (filter === "all" ? true : filter === "open" ? n.status !== "done" : n.status === filter));
    if (opts.json) return console.log(JSON.stringify(shown, null, 2));
    if (!shown.length) console.log(filter === "all" ? "No notes yet." : `No ${filter} notes.`);
    for (const n of shown) {
      const last = n.last ? `${n.last.date} ${n.last.author}` : "no entries";
      console.log(`${(n.ticket ? `#${n.ticket}` : n.file.replace(/\.md$/, "")).padEnd(22)} ${n.status.padEnd(8)} ${last.padEnd(22)} ${n.title}`);
    }
  } else if (command === "search") {
    const q = rest.join(" ");
    const { results } = await call("GET", `/search?q=${encodeURIComponent(q)}`, undefined, async () => ({ results: await notes.search(q) }));
    if (!results.length) console.log(`Nothing matches "${q}".`);
    for (const r of results) {
      console.log(`${r.ticket ? `#${r.ticket}` : r.file}  ${r.title}`);
      for (const h of r.hits) console.log(`    ${h.line}: ${h.text}`);
    }
  } else if (command === "health") {
    const health = await call("GET", "/health", undefined, null);
    console.log(`Local Collab is running at ${health.url} (pid ${health.pid}, since ${health.startedAt}), notes in ${health.notesDir}`);
  } else {
    throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }

  if (usedFallback) console.error(`(The server at ${BASE} was not reachable, so this used the files directly.)`);
}

main().catch((err) => {
  console.error(err.cause?.code === "ECONNREFUSED" ? `Local Collab is not running at ${BASE}.` : err.message);
  process.exit(1);
});
