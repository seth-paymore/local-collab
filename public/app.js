// Local Collab page. Everything is rendered from the server's view of the
// markdown files; the files stay the source of truth.
import {MAX_IMAGE_BYTES,IMAGE_MARKDOWN,imageMarkdown,imageHtml,imageType} from './images.mjs';
import {installImageEvents} from './image-events.mjs';
import {highlightSearch} from './search-query.mjs';
import {installInstructionsEditor} from './instructions.mjs';

let AUTHOR = "Human";
let storageLabel="Markdown files";
let storageType="filesystem";
const POLL_MS = 10_000;

const state = {
  notes: [],
  statuses: [],
  notesDir: "",
  filter: "open",
  query: "",
  results: null,
  current: null,
  ac: { fetchedAt: null, mine: [], ids: {} },
};

const $ = (selector, root = document) => root.querySelector(selector);

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
const drafts=new Map();
const draftFor=file=>{
  if(!drafts.has(file))drafts.set(file,{text:'',images:[],requestId:crypto.randomUUID(),saving:false,queueing:0});
  return drafts.get(file);
};
function rememberDraft() {
  const file=$('#main .note')?.dataset.file;
  if(file&&$('#entry')&&!draftFor(file).saving)draftFor(file).text=$('#entry').value;
}
function renderImageQueue() {
  const file=$('#main .note')?.dataset.file,queue=$('#image-queue');if(!file||!queue)return;
  const draft=draftFor(file),busy=draft.saving||draft.queueing>0;
  queue.innerHTML=draft.images.map(item=>`<li><img src="${esc(item.preview)}" alt="Preview of ${esc(item.file.name)}"><span><strong>${esc(item.file.name||'Screenshot')}</strong><small>${(item.file.size/1024).toFixed(0)} KiB · ${item.uploaded?'Uploaded; ready to save':item.uploading?'Uploading…':'Ready to attach'}</small></span><button type="button" data-remove-image="${item.key}" aria-label="Remove ${esc(item.file.name||'image')} from draft" ${draft.saving?'disabled':''}>Remove</button></li>`).join('');
  $('#composer').setAttribute('aria-busy',String(busy));
  $('#composer').querySelectorAll('button,input,textarea').forEach(control=>{control.disabled=busy;});
  $('#save-entry').textContent=draft.saving?'Saving…':draft.queueing?'Preparing images…':'Add note';
}
async function queueImages(files) {
  const file=$('#main .note')?.dataset.file;
  if(!file){toast('Open a note before attaching images',true);return;}
  const draft=draftFor(file);if(draft.saving)return;
  draft.queueing++;renderImageQueue();
  try {
  for(const image of files) {
    if(draft.images.length>=8){toast('Attach up to 8 images per entry',true);break;}
    if(!image.size||image.size>MAX_IMAGE_BYTES){toast('Each image must be at most 5 MiB',true);continue;}
    const type=imageType(new Uint8Array(await image.slice(0,16).arrayBuffer()));
    if(!type){toast('Use PNG, JPEG, GIF or WebP images',true);continue;}
    if(draft.images.length>=8)break;
    const all=[...drafts.values()].flatMap(value=>value.images);
    if(all.reduce((size,item)=>size+item.file.size,0)+image.size>50*1024*1024){toast('Save or remove some queued images before adding more',true);break;}
    if(draft.images.some(item=>item.file.name===image.name&&item.file.size===image.size&&item.file.lastModified===image.lastModified))continue;
    draft.images.push({key:crypto.randomUUID(),file:image,type,preview:URL.createObjectURL(image),uploaded:null});
    draft.requestId=crypto.randomUUID();
  }
  }catch(error){toast(`Could not prepare the image: ${error.message}`,true);}
  finally{draft.queueing--;if(state.current?.file===file)renderImageQueue();}
}
async function uploadQueued(file,item) {
  const response=await fetch(`/api/notes/${encodeURIComponent(file)}/attachments`,{method:'POST',headers:{'X-Local-Collab':'1','Content-Type':item.type},body:item.file});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(value.error??`Image upload failed (${response.status})`);
  imageMarkdown(item.file.name,value.url);return value;
}

async function api(path, { method = "GET", body } = {}) {
  const headers = method === "GET" ? {} : { "X-Local-Collab": "1" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error ?? `Request failed (${response.status})`), { status: response.status });
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("is-error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 6000 : 2200);
}

// ------------------------------------------------------------- formatting

const sortKey = (e) => `${e.date} ${(e.time || "").padStart(5, "0")}`;

function fmtDate(date, time) {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86_400_000);
  const label =
    diff === 0 ? "Today"
    : diff === 1 ? "Yesterday"
    : day.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(y !== today.getFullYear() ? { year: "numeric" } : {}) });
  return time ? `${label} ${time}` : label;
}

function authorClass(author) {
  let hash = 0;
  for (const char of author) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return `a-${hash % 6}`;
}

function shortUrl(href) {
  const pr = href.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
  if (pr) return `${pr[1]} #${pr[2]}`;
  return href.replace(/^https?:\/\//, "").replace(/(.{60}).+/, "$1...");
}

function extractPrs(raw) {
  const seen = new Map();
  for (const m of raw.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)) seen.set(m[0], shortUrl(m[0]));
  return [...seen];
}

function ticketLink(number) {
  const note = state.notes.find((n) => n.ticket === number);
  if (note) return `<a href="#/${encodeURIComponent(note.file)}">#${number}</a>`;
  const url = state.ac.urls?.[number];
  if (url) return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">#${number}</a>`;
  return `#${number}`;
}

const external = (href, label) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;

// Input is raw text. It is escaped first, so every pattern below runs on safe
// HTML and only ever adds tags this function chooses. Finished fragments are
// held aside so a later pattern cannot reach inside them (a PR label such as
// "pos-backend #5890" must not become a ticket link inside a link).
function inline(text) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let s = String(text).replace(/\u0000/g,'');
  s = s.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${esc(code)}</code>`));
  s = s.replace(IMAGE_MARKDOWN,(_,alt,path)=>hold(imageHtml(alt,path)));
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => hold(external(href, label)));
  // Trailing punctuation belongs to the sentence, not the URL.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]*[^\s<).,;:!?'"])/g, (_, pre, href) => pre + hold(external(href, esc(shortUrl(href.replace(/&amp;/g, "&"))))));
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])#(\d{3,6})\b/g, (_, pre, n) => pre + hold(ticketLink(n)));
  s = s.replace(/^\[ \] /, "☐ ").replace(/^\[[xX]\] /, "☑ ");
  for (let pass = 0; pass < 3 && s.includes("\u0000"); pass++) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[i]);
  return s;
}

const LIST_RE = /^\s*([-*+]|\d+[.)])\s+/;
const FENCE_RE = /^\s*```/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const TABLE_RE = /^\s*\|/;

function md(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const startsBlock = (line) => FENCE_RE.test(line) || HEADING_RE.test(line) || LIST_RE.test(line) || TABLE_RE.test(line) || /^>/.test(line);

  while (i < lines.length) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = Math.min(6, heading[1].length + 2);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (LIST_RE.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && LIST_RE.test(lines[i])) {
        let item = lines[i++].replace(LIST_RE, "");
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST_RE.test(lines[i])) item += ` ${lines[i++].trim()}`;
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (TABLE_RE.test(line)) {
      const rows = [];
      while (i < lines.length && TABLE_RE.test(lines[i])) rows.push(lines[i++]);
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
      const [head, ...rest] = body;
      out.push(
        `<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` +
          `<tbody>${rest.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
      );
      continue;
    }
    if (/^>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${buf.map(inline).join("<br>")}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- sidebar

function matchesFilter(note) {
  if (state.filter === "all") return true;
  if (state.filter === "open") return note.status !== "done";
  return note.status === state.filter;
}

function renderChips() {
  const count = (f) => state.notes.filter((n) => (f === "all" ? true : f === "open" ? n.status !== "done" : n.status === f)).length;
  const filters = ["open", ...state.statuses, "all"];
  $("#status-filter").innerHTML = filters
    .map((f) => `<button type="button" data-filter="${f}" aria-pressed="${f === state.filter}">${f} ${count(f)}</button>`)
    .join("");
}

function noteItem(note) {
  const current = state.current?.file === note.file;
  return `<a class="item${current ? " is-current" : ""}" href="#/${encodeURIComponent(note.file)}"${current ? ' aria-current="page"' : ""}>
    <span class="item-top"><span class="num">${note.ticket ? `#${esc(note.ticket)}` : "Topic"}</span><span class="pill st-${esc(note.status)}">${esc(note.status)}</span></span>
    <span class="item-title">${esc(note.title)}</span>
    ${note.next ? `<span class="item-next">Next: ${esc(note.next)}</span>` : ""}
    <span class="item-meta">${note.last ? `${esc(fmtDate(note.last.date, note.last.time))} · ${esc(note.last.author)} · ${note.entries} ${note.entries === 1 ? "entry" : "entries"}` : "No entries yet"}</span>
  </a>`;
}

function highlight(text) {
  return highlightSearch(text,state.query);
}

function renderList() {
  const nav = $("#note-list");
  if (state.results) {
    nav.innerHTML = state.results.length
      ? state.results
          .map(
            (r) => `<a class="item" href="#/${encodeURIComponent(r.file)}">
              <span class="item-top"><span class="num">${r.ticket ? `#${esc(r.ticket)}` : "Topic"}</span><span class="pill st-${esc(r.status)}">${esc(r.status)}</span></span>
              <span class="item-title">${highlight(r.title)}</span>
              ${r.hits.map((h) => `<span class="hit">${highlight(h.text)}</span>`).join("")}
            </a>`,
          )
          .join("")
      : `<p class="empty">Nothing matches "${esc(state.query)}".</p>`;
    return;
  }
  const notes = state.notes.filter(matchesFilter);
  nav.innerHTML = notes.length
    ? notes.map(noteItem).join("")
    : `<p class="empty">${state.notes.length ? "No notes with this status." : "No notes yet. Start one from a ticket below or with New note."}</p>`;
}

function renderAc() {
  $(".ac-panel").hidden = state.ac.enabled === false;
  const { fetchedAt, mine } = state.ac;
  $("#ac-status").textContent = fetchedAt
    ? `${mine.length} open, assigned to you or created by you. Read ${new Date(fetchedAt).toLocaleString()}.`
    : "Not loaded yet. Refresh reads ActiveCollab and never writes to it.";
  const sorted = [...mine].sort((a, b) => Number(b.assignedToMe) - Number(a.assignedToMe) || Number(b.number) - Number(a.number));
  $("#ac-mine").innerHTML = sorted
    .map(
      (t) => `<li>
        <span class="num">#${esc(t.number)}</span>
        <span class="ac-name" title="${esc(t.name)}">${esc(t.name)}</span>
        <span class="tag">${t.assignedToMe ? "assigned" : "created"}</span>
        ${t.hasNotes
          ? `<a href="#/ac-${esc(t.number)}.md" aria-label="Notes for #${esc(t.number)}">Notes</a>`
          : `<button type="button" class="link" data-start-ticket="${esc(t.number)}" aria-label="Start notes for #${esc(t.number)}">Start</button>`}
      </li>`,
    )
    .join("");
}

// ------------------------------------------------------------------- note

function welcome() {
  $("#main").innerHTML = `<div class="welcome">
    <h2>Private ticket notes</h2>
    <p>${storageType==="http"?`Notes are stored through ${esc(storageLabel)}.`:`Each note is a Markdown file in <code>${esc(state.notesDir)}</code>.`} People and agents use the same note collection, so their entries appear here next to yours.</p>
    <p>Refresh pulls ticket details, comments and subtasks. Private notes and images use your selected storage. Completion is sent to ActiveCollab only through its separate confirmation.</p>
    <p><button type="button" class="primary" data-action="new">New note</button></p>
  </div>`;
}

function entryItem(entry) {
  return `<li class="entry">
    <div class="entry-head"><span class="author ${authorClass(entry.author)}">${esc(entry.author)}</span><span class="muted small">${[entry.agent,entry.provider,entry.model].filter(Boolean).map(esc).join(" · ")}</span><time datetime="${esc(entry.date)}">${esc(fmtDate(entry.date, entry.time))}</time></div>
    <div class="md">${md(entry.text)}</div>
  </li>`;
}

function acLine(note) {
  const ac = note.ac;
  if (ac) {
    const who = ac.assignees.length ? ac.assignees.join(", ") : "Unassigned";
    return ` · ${esc(ac.list)} · ${esc(who)} · ActiveCollab: ${ac.completed ? "completed" : "open"} · ${external(esc(ac.url), "Open in ActiveCollab")}`;
  }
  if (!note.ticket) return "";
  return state.ac.fetchedAt
    ? ` · <span>not among the open ActiveCollab tasks</span>`
    : ` · <span>refresh ActiveCollab to link it</span>`;
}

// Provider HTML is rendered as text, never inserted into the page as markup.
function acText(html) {
  const parsed = new DOMParser().parseFromString(String(html ?? ""), "text/html");
  parsed.querySelectorAll("script,style,iframe,object").forEach(el => el.remove());
  parsed.querySelectorAll("a").forEach(el => {
    const href = el.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) el.append(` (${href})`);
  });
  parsed.querySelectorAll("br").forEach(el => el.replaceWith("\n"));
  parsed.querySelectorAll("p,li,div,h1,h2,h3,blockquote").forEach(el => el.append("\n"));
  return parsed.body.textContent.trim();
}

function ticketPanel(note) {
  if (!note.ac) return "";
  const detail = note.ac.detail;
  return `<section class="ac-ticket" aria-label="Synced ActiveCollab ticket">
    <h2>ActiveCollab ticket</h2>
    <p class="muted">${detail ? `Last pulled ${esc(new Date(detail.fetchedAt).toLocaleString())}.` : "Full ticket has not been pulled yet."} Private working notes stay separate.</p>
    ${note.ac.syncError ? `<p class="warn">Latest pull failed: ${esc(note.ac.syncError)}. Showing the last saved copy.</p>` : ""}
    <button type="button" data-action="pull-ticket">Pull latest ticket</button>
    ${detail && !detail.completed && note.status === "done" ? `<button type="button" data-action="complete-ticket">Mark complete in ActiveCollab</button>` : ""}
    ${detail ? `<h3>${esc(detail.name)}</h3><p>ActiveCollab status: <strong>${detail.completed ? "Completed" : "Open"}</strong></p>
      <details><summary>Description</summary><div class="ac-text">${esc(acText(detail.body)) || "No description."}</div></details>
      <details open><summary>Subtasks (${detail.subtasks.filter(s=>s.completed).length}/${detail.subtasks.length} complete)</summary><ul>${detail.subtasks.map(s=>`<li>${s.completed ? "☑" : "☐"} ${esc(s.name)}</li>`).join("") || "<li>No subtasks.</li>"}</ul></details>
      <details><summary>ActiveCollab comments (${detail.comments.length})</summary><ol class="timeline">${[...detail.comments].sort((a,b)=>b.createdOn-a.createdOn || b.id-a.id).map(c=>`<li><p><strong>${esc(c.author)}</strong> · ${esc(new Date(c.createdOn*1000).toLocaleString())}</p><div class="ac-text">${esc(acText(c.body))}</div></li>`).join("")}</ol></details>` : ""}
    </section>`;
}

function renderNote(note) {
  const entries = [...note.entries].sort((a, b) => sortKey(b).localeCompare(sortKey(a)) || b.index - a.index);
  const prs = extractPrs(note.raw);
  const notAssigned = note.ac && !note.ac.assignedToMe && note.status === "active";
  // A re-render of the same note (new entries arrived) must not eat a draft.
  rememberDraft();
  const draft=draftFor(note.file);
  $("#main").innerHTML = `<article class="note" data-file="${esc(note.file)}">
    <header>
      <p class="eyebrow">${note.ticket ? `#${esc(note.ticket)}` : "Topic note"}${acLine(note)}</p>
      <textarea class="title-input" data-field="title" rows="1" aria-label="Title">${esc(note.title)}</textarea>
      <div class="fields">
        <label>Local working status
          <select data-field="status">${state.statuses.map((s) => `<option${s === note.status ? " selected" : ""}>${s}</option>`).join("")}</select>
        </label>
        <label class="grow">Next step
          <input data-field="next" value="${esc(note.next)}" placeholder="What has to happen next">
        </label>
      </div>
      ${notAssigned ? `<p class="warn">You are marked active here but are not in this ticket's ActiveCollab assignees.</p>` : ""}
      ${prs.length ? `<p class="prs">${prs.map(([href, label]) => external(esc(href), esc(label))).join("")}</p>` : ""}
    </header>
    <div id="stale-slot"></div>
    ${ticketPanel(note)}
    ${note.summary ? `<section class="summary md" aria-label="Summary">${md(note.summary)}</section>` : ""}
    <h2>Private working notes</h2>
    <form class="composer" id="composer">
      <label for="entry" class="visually-hidden">New entry</label>
      <textarea id="entry" name="text" placeholder="Add a note or paste a screenshot. Ctrl+Enter saves."></textarea>
      <div class="attachment-toolbar"><button type="button" data-action="choose-images">Attach images</button><input id="image-files" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden><span class="muted small">Paste or drop images here · 5 MiB each</span></div>
      <ul class="image-queue" id="image-queue" aria-label="Images in this draft"></ul>
      <div class="composer-foot"><span class="muted">Saved to ${esc(storageLabel)}, as ${esc(AUTHOR)}.</span><button id="save-entry" class="primary" type="submit">Add note</button></div>
    </form>
    <ol class="timeline">${entries.map(entryItem).join("") || `<li class="empty">No entries yet.</li>`}</ol>
    <details class="raw" id="raw">
      <summary>Edit the raw file</summary>
      <textarea id="raw-text" spellcheck="false" aria-label="Raw markdown">${esc(note.raw)}</textarea>
      <div class="composer-foot"><span class="muted">${esc(state.notesDir)}\\${esc(note.file)}</span><button type="button" data-action="save-raw">Save file</button></div>
    </details>
  </article>`;
  $('#entry').value=draft.text;renderImageQueue();
}

function isEditing() {
  return Boolean($("#entry")?.value.trim() || (state.current&&draftFor(state.current.file).images.length) || (state.current&&draftFor(state.current.file).saving) || $("#raw")?.open || document.activeElement?.matches?.("[data-field]"));
}

function showStale() {
  const slot = $("#stale-slot");
  if (!slot || slot.childElementCount) return;
  slot.innerHTML = `<p class="stale">This note or its synced ticket changed. <button type="button" data-action="reload">Show the latest</button></p>`;
}

// ------------------------------------------------------------------- data

async function loadList() {
  const data = await api("/notes");
  state.notes = data.notes;
  state.statuses = data.statuses;
  state.notesDir = data.notesDir;
  renderChips();
  if (state.query) await runSearch();
  else renderList();
}

async function loadAc() {
  state.ac = await api("/activecollab");
  renderAc();
}

async function openFromHash() {
  rememberDraft();
  const file = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  if (!file) {
    state.current = null;
    renderList();
    welcome();
    return;
  }
  try {
    state.current = await api(`/notes/${encodeURIComponent(file)}`);
    renderNote(state.current);
    document.title = `${state.current.ticket ? `#${state.current.ticket} ` : ""}${state.current.title} · Local Collab`;
  } catch (err) {
    state.current = null;
    $("#main").innerHTML = `<div class="welcome"><h2>Note not found</h2><p>${esc(err.message)}</p></div>`;
  }
  renderList();
}

async function runSearch() {
  const query=state.query;
  if (query.length < 2) {
    state.results = null;
  } else {
    const {results}=await api(`/search?q=${encodeURIComponent(query)}`);
    if (query!==state.query) return;
    state.results=results;
  }
  renderList();
}

async function poll() {
  if (document.hidden) return;
  try {
    await loadList();
    if (!state.current) return;
    const fresh = await api(`/notes/${encodeURIComponent(state.current.file)}`);
    if (fresh.version === state.current.version && fresh.ac?.detail?.fetchedAt === state.current.ac?.detail?.fetchedAt && fresh.ac?.syncError === state.current.ac?.syncError) return;
    if (isEditing()) showStale();
    else {
      state.current = fresh;
      renderNote(fresh);
    }
  } catch {
    // The server may be restarting; the next poll will catch up.
  }
}

async function createNote(body) {
  const note = await api("/notes", { method: "POST", body });
  await loadList();
  await loadAc();
  location.hash = `#/${encodeURIComponent(note.file)}`;
}

// ----------------------------------------------------------------- events

document.addEventListener("submit", async (event) => {
  if (event.target.id === "composer") {
    event.preventDefault();
    const file=event.target.closest('.note').dataset.file;
    const draft=draftFor(file),textarea=$('#entry');
    if(draft.saving||draft.queueing)return;
    draft.text=textarea.value;
    if(!draft.text.trim()&&!draft.images.length)return;
    draft.saving=true;renderImageQueue();
    let committed=false;
    try {
      for(const item of draft.images) {
        if(item.uploaded)continue;
        item.uploading=true;if(state.current?.file===file)renderImageQueue();
        try{item.uploaded=await uploadQueued(file,item);}finally{item.uploading=false;}
      }
      const text=[draft.text.trim(),...draft.images.map(item=>imageMarkdown(item.file.name,item.uploaded.url))].filter(Boolean).join('\n\n');
      const saved=await api(`/notes/${encodeURIComponent(file)}/entries`,{method:'POST',body:{text,requestId:draft.requestId}});
      committed=true;
      draft.images.forEach(item=>URL.revokeObjectURL(item.preview));draft.images=[];draft.text='';draft.requestId=crypto.randomUUID();
      if(state.current?.file===file){textarea.value='';state.current=saved;renderNote(saved);}
      await loadList();
      toast("Note saved");
      if(state.current?.file===file)$("#entry")?.focus();
    } catch (err) {
      toast(committed?'Note saved. The note list could not refresh.':`${err.message}. Your draft is kept.`, true);
    }finally{draft.saving=false;if(state.current?.file===file)renderImageQueue();}
  }
  if (event.target.id === "new-form") {
    event.preventDefault();
    const form = event.target;
    const ticket = form.ticket.value.trim();
    const topic = form.topic.value.trim();
    try {
      await createNote(ticket ? { ticket } : { topic });
      $("#new-dialog").close();
      form.reset();
    } catch (err) {
      if (err.status === 409 && ticket) {
        $("#new-dialog").close();
        form.reset();
        location.hash = `#/ac-${ticket.replace(/^#/, "")}.md`;
      } else {
        $("#new-error").textContent = err.message;
      }
    }
  }
});

document.addEventListener('input',event=>{
  if(event.target.id!=='entry')return;
  const draft=draftFor(event.target.closest('.note').dataset.file);
  draft.text=event.target.value;draft.requestId=crypto.randomUUID();
});
installImageEvents(document,queueImages,message=>toast(message,true));
window.addEventListener('beforeunload',event=>{
  rememberDraft();
  if([...drafts.values()].some(draft=>draft.text.trim()||draft.images.length||draft.queueing)){event.preventDefault();event.returnValue='';}
});

document.addEventListener("change", async (event) => {
  if(event.target.id==='image-files'){await queueImages(event.target.files);event.target.value='';return;}
  const field = event.target.dataset?.field;
  if (!field || !state.current) return;
  try {
    const updated = await api(`/notes/${encodeURIComponent(state.current.file)}/meta`, { method: "PATCH", body: { [field]: event.target.value } });
    state.current = updated;
    await loadList();
    toast("Saved");
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.target.id === "entry" && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    $("#composer").requestSubmit();
    return;
  }
  if (event.target.matches?.("input[data-field], textarea[data-field]") && event.key === "Enter") {
    event.preventDefault();
    event.target.blur();
    return;
  }
  const typing = event.target.closest?.("input, textarea, select, [contenteditable]");
  if (event.key === "/" && !typing) {
    event.preventDefault();
    $("#search").focus();
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if(target.dataset.action==='choose-images'){$('#image-files').click();return;}
  if(target.dataset.removeImage) {
    const draft=draftFor(target.closest('.note').dataset.file);if(draft.saving)return;
    const item=draft.images.find(image=>image.key===target.dataset.removeImage);
    if(item)URL.revokeObjectURL(item.preview);
    draft.images=draft.images.filter(image=>image!==item);draft.requestId=crypto.randomUUID();renderImageQueue();return;
  }
  if (target.dataset.filter) {
    state.filter = target.dataset.filter;
    state.query = "";
    state.results = null;
    $("#search").value = "";
    renderChips();
    renderList();
  } else if (target.id === "new-note" || target.dataset.action === "new") {
    $("#new-error").textContent = "";
    $("#new-dialog").showModal();
  } else if (target.dataset.startTicket) {
    try {
      await createNote({ ticket: target.dataset.startTicket });
    } catch (err) {
      toast(err.message, true);
    }
  } else if (target.id === "ac-refresh") {
    target.disabled = true;
    target.textContent = "Reading...";
    try {
      const result = await api("/activecollab/refresh", { method: "POST" });
      await loadAc();
      await loadList();
      if (state.current) await openFromHash();
      toast(result.detailErrors.length ? `Ticket list updated; ${result.detailErrors.length} full ticket pulls failed. Previous copies kept.` : "ActiveCollab tickets updated", result.detailErrors.length > 0);
    } catch (err) {
      toast(err.message, true);
    } finally {
      target.disabled = false;
      target.textContent = "Refresh";
    }
  } else if (["pull-ticket", "complete-ticket"].includes(target.dataset.action)) {
    target.disabled = true;
    try {
      const number = state.current.ticket;
      const detail = await api(`/activecollab/${number}/refresh`, {method:"POST"});
      if (target.dataset.action === "complete-ticket") {
        if (detail.subtasks.some(s=>!s.completed)) throw new Error("Open subtasks remain. Review or retire them in ActiveCollab before completing the parent.");
        if (!detail.completed && window.confirm(`Complete ActiveCollab #${number}: ${detail.name}?\n\nConfirm the work is accepted and you have checked for overlapping work. This updates the parent ticket only. Private notes and comments will not be sent.`)) {
          await api(`/activecollab/${number}/complete`, {method:"POST", body:{version:detail.version,confirmed:true}});
          toast("ActiveCollab completion verified");
        }
      }
      await loadAc();
      await openFromHash();
    } catch (err) { toast(err.message,true); }
    finally { target.disabled = false; }
  } else if (target.dataset.action === "save-raw") {
    try {
      state.current = await api(`/notes/${encodeURIComponent(state.current.file)}/raw`, {
        method: "PUT",
        body: { raw: $("#raw-text").value, version: state.current.version },
      });
      renderNote(state.current);
      await loadList();
      toast("File saved");
    } catch (err) {
      toast(err.message, true);
    }
  } else if (target.dataset.action === "reload") {
    await openFromHash();
  } else if (target.dataset.action === "close-dialog") {
    target.closest("dialog").close();
  }
});

let searchTimer;
$("#search").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = event.target.value.trim();
    runSearch().catch((err) => toast(err.message, true));
  }, 180);
});

// Light dismiss for browsers without <dialog closedby>.
const dialog = $("#new-dialog");
if (!("closedBy" in HTMLDialogElement.prototype)) {
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = r.top <= event.clientY && event.clientY <= r.bottom && r.left <= event.clientX && event.clientX <= r.right;
    if (!inside) dialog.close();
  });
}

window.addEventListener("hashchange", openFromHash);
window.addEventListener("focus", poll);
setInterval(poll, POLL_MS);

const settings = await api("/config");
installInstructionsEditor({api,toast});
AUTHOR = settings.author;
storageLabel=settings.storage.label;
storageType=settings.storage.type;
$(".private-badge").textContent=storageType==="http"?"Configured storage · local interface":"Private · this computer only";
await Promise.all([loadList(), loadAc()]);
await openFromHash();
