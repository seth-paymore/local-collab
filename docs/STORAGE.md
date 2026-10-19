# Data layer and storage providers

Local Collab keeps three kinds of data separate:

| Data | Authority | Where it lives |
| --- | --- | --- |
| Working notes, attribution, local status and next steps | Your note collection | The configured note storage backend |
| Ticket descriptions, discussions, subtasks and completion | ActiveCollab | Upstream tracker, with a derived local cache |
| Credentials and connection settings | Your local installation | Environment variables and ignored local configuration |

Agent providers and storage providers are different concepts. An entry's
`author`, `agent`, `provider` and `model` describe its contributor. Storage
configuration decides where all entries are persisted. ActiveCollab is a
ticket connector, not the storage backend for private working notes.

## Review and resulting boundaries

The original notes module combined Markdown parsing, direct filesystem access,
and tracker caching. That made a second storage backend require changes in every
note operation. The note collection now uses a small provider interface in
`lib/storage.mjs`; formatting and ticket behavior stay in `lib/notes.mjs`.

```text
Human / agent
     |
Local HTTP API or CLI
     |
Note model: Markdown, attribution, status, next step
     |
Storage interface: list / read / conditional write
     |                              |
Markdown files               Authenticated HTTP service

ActiveCollab ---> identity-scoped local cache ---> separate ticket panel
```

Both backends preserve the same raw Markdown and application API. Search and
summaries are derived from the stored notes. Tracker cache paths include account,
project and user IDs so changing a connection does not reuse another identity's
cache. Caches are disposable and stay under the local notes/cache directory,
even when note content uses HTTP storage. Old cache files are left intact and
the new identity-scoped cache is rebuilt on refresh.

The default backend remains Markdown files. The interface is intentionally small:

```js
{
  type, label, location,
  async list(),                         // validated note file names
  async read(name),                     // {raw, revision, modified}
  async write(name, raw, priorRevision) // conditional write; null means create
}
```

There is no automatic data migration when selecting another backend. Existing
files are preserved. Move/export notes deliberately before changing a live
installation. The HTTP backend does not silently fall back to local files when
unavailable, because doing so would split the authoritative note collection.

## Markdown files (default)

```json
{
  "notesDir": "/your/private/notes",
  "storage": { "type": "filesystem" }
}
```

Writes use temporary files and rename. The local server serializes read-modify-write
operations per note, and checks the previous content revision before writing.
Keep concurrent agents connected to that server. Separate offline processes do
not have a cross-process filesystem lock; this remains a known limitation.

## Authenticated HTTP storage

Use this adapter when you want a different underlying database or storage system.
Your service may use SQLite, Postgres, object storage or another implementation;
Local Collab uses the contract below. The client does not connect directly to a
database. An optional [secured SQLite gateway](SHARED-STORAGE.md) is bundled for
shared workspaces, with client credentials, read/write roles, authenticated
revision history and snapshot recovery. It is a separate host process, not an
authentication layer for the local UI.

```json
{
  "storage": {
    "type": "http",
    "label": "Team note storage",
    "baseUrl": "https://notes.example.com/v1",
    "auth": { "type": "bearer", "tokenEnv": "NOTES_API_TOKEN" }
  }
}
```

Set `NOTES_API_TOKEN` in the environment of the server and any CLI processes that
access storage directly. The token is sent in `Authorization: Bearer ...`.
An API-key header is also supported:

```json
{
  "type": "api-key",
  "header": "X-API-Key",
  "tokenEnv": "NOTES_API_KEY"
}
```

Use that object as `storage.auth`. Credentials are read server-side; the browser
configuration exposes only backend type and label. The adapter requires HTTPS,
except for loopback development endpoints. Embedded URL credentials and redirects
are rejected so the token is not forwarded to another destination. Remote API
error bodies are not returned to the local UI or CLI.

Choosing HTTP storage sends private working notes to the configured service.
The UI identifies the configured storage instead of claiming the notes stay on
this computer. The local interface still binds only to loopback. This does not
add authentication to the local UI; agent attribution is still self-reported.

## HTTP provider contract

All paths below are appended to `baseUrl`. Requests accept JSON. Names are the
validated filenames used by the application, such as `release-plan.md` or
`ac-123.md`, not arbitrary filesystem paths.

### List

`GET /notes` returns `200` and either an array of filenames or:

```json
{ "notes": ["release-plan.md", "ac-123.md"] }
```

Objects with a `name` field are also accepted. Names must be unique. The current
adapter expects one complete list, with a maximum of 10,000 records; it does not
implement list pagination.

### Read

`GET /notes/{filename}` returns `200` with a strong quoted `ETag` header:

```http
ETag: "revision-7"
Content-Type: application/json
```

```json
{ "raw": "---\ntitle: Release plan\nstatus: active\n---\n", "modified": 1792411200000 }
```

`modified` is milliseconds since the Unix epoch. Instead of a response header,
the JSON may contain `"version": "\"revision-7\""`. Weak ETags are rejected.
Return `404` for a missing note.

### Create or update

`PUT /notes/{filename}` sends `{ "raw": "..." }` with:

- `If-None-Match: *` when creating a missing note.
- `If-Match: "revision-7"` when updating a note that was read at that revision.

The service **must enforce these conditions atomically**. Return `409` or `412`
when the condition no longer matches. Return `200` or `201` on success, using the
same record body and a new strong ETag as for a read. The adapter checks that the
returned raw content matches what it submitted. It never automatically retries a
conflicting write, and never sends tracker comments as note storage operations.

Records must return valid JSON and fit within the current 2 MB response limit.
Authorization failures, malformed records and outages remain visible failures.
A failed or timed-out PUT can have an uncertain upstream outcome; refresh before
retrying rather than assuming the service did not save it.
The CLI also refuses to replay a local API write after a dropped or ambiguous
response. Direct-storage fallback for mutations is limited to a refused local
connection, when no server accepted the request.

## Validation and remaining tradeoffs

Tests exercise a real local HTTP fixture with bearer/API-key authentication,
complete note workflows, serial handoffs, search, stale-write conflicts, outage
behavior, redirect rejection, raw-content preservation and no disk fallback.
These verify the adapter contract; they do not certify an arbitrary external
service's own authorization, backups or atomic write implementation. The bundled
gateway has additional real HTTP/SQLite tests for its access boundaries,
concurrent writes, revision history, limits and snapshot recovery. Its deployment
and operational requirements are covered in the [shared storage guide](SHARED-STORAGE.md).

The current design reads note contents to build lists and search results, with
at most eight reads in flight. Search reuses those reads within each query. A large
remote collection will need an indexed query extension or batching; changing
storage alone does not supply server-side search. Explicit migration tooling,
cross-process filesystem locks and direct database clients remain future work.
