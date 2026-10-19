# Secured shared storage

The optional storage service lets multiple Local Collab installations share one
note collection. It implements the [HTTP storage contract](STORAGE.md) using a
private SQLite database. The normal application still runs on localhost and uses
Markdown files unless you explicitly select HTTP storage.

```text
Local app / agent on each computer
            |
     HTTPS + client credential
            |
Dedicated storage hostname / Cloudflare TLS tunnel
            |
Storage gateway on 127.0.0.1:4318
            |
Private SQLite database: workspaces, credentials, notes, images, revision history
```

This service is separate from `server.mjs`. Do not expose the local application
UI, port 4317, or the database file through a tunnel or a public file server.
GitHub Pages hosts only the showcase; it cannot run this API or store private
notes. No hosted service is created by installing this code.

## Security boundary

- Every list, read, history, image and write operation requires a client credential.
  There are no anonymous note endpoints or browser sessions.
- Each credential belongs to exactly one workspace and one principal. `read`
  permits reads and history; `write` also permits creation and replacement of
  notes and image uploads. A workspace is a shared collection: everyone with read access can read
  **all** its notes and images. Use separate workspaces for separate audiences.
- Credentials contain 256 bits of random material. Only their SHA-256 digests
  are stored. Each has an expiry of 1 to 90 days, with 30 days as the default.
  Give each installation or agent its own credential. Host administration can
  disable an individual credential without changing other clients.
- There are no HTTP credential-management or workspace-management endpoints.
  Administration requires filesystem access on the service host.
- A database transaction checks the expected revision and saves the note and its
  historical revision together. Stale creates/updates fail with `412`. No
  automatic overwrite or replay is performed.
- History records the authenticated **credential ID and principal**, independently
  of the Markdown's claimed author, provider or model. These content fields remain
  self-reported. If several agents use one installation's credential, history
  identifies that installation, not which local agent made the request.
- Historical revisions and administrative events are append-only through the
  service; there is no delete API. Database triggers reject ordinary updates or
  deletes of history. A host/database administrator can still alter the database:
  this is not cryptographically tamper-proof logging.
- The gateway binds only to loopback. It rejects unexpected Host headers, browser
  Origin headers, unsupported methods, compressed/oversized bodies and writes
  without a revision condition. It ignores forwarded identity/IP headers.
- Defaults: 128 KiB per note, 10,000 notes per workspace, 32 active requests and
  128 open connections,
  1,200 requests/minute per credential and 2,400 attempts/minute per upstream
  socket address. A conservative 256 MiB workspace budget charges twice each
  revision's content bytes plus 1 KiB metadata. Full budgets reject further writes
  without deleting history. Behind a tunnel, the network budget applies to the
  combined tunnel traffic. Limits reset on process restart; enforce additional
  abuse protection at the TLS edge for an internet-facing service.

The local UI still trusts programs running as your OS user. It has no application
login. Keep it on localhost and protect the computer/user account. Access to a
local installation holding a write credential grants that credential's workspace
permissions. Tokens identify clients, not individual people signed into a UI.

## Host setup

Use a maintained Node.js 24 release (22.13+ is the minimum for the optional
`node:sqlite` service). The local application itself still supports Node.js 20+.
No npm dependencies are needed. The examples use a Unix path; on Windows use a
private directory under your own user profile and quote paths containing spaces.

Create the database **outside the repository and any web root**:

```sh
node storage-service/cli.mjs init --db /private/collab/database.sqlite
node storage-service/cli.mjs workspace --db /private/collab/database.sqlite --workspace team
node storage-service/cli.mjs issue --db /private/collab/database.sqlite --workspace team --principal desktop-agent --role write --days 30 --out /private/collab/desktop-agent.token
node storage-service/cli.mjs serve --db /private/collab/database.sqlite --origin https://notes.example.com
```

The issuance command writes the secret to a **new file**, never stdout or process
arguments. It prints only credential metadata, including its ID and expiry.
Existing files cannot be overwritten. Share credentials using your private secret
distribution method, not tickets, notes, source control, chat logs or URLs.

The CLI uses an owner-only umask and creates new database/token/snapshot files with
mode `0600` on Unix. On Windows, use a directory with an NTFS ACL limited to the
service account and administrators; Unix permission modes do not establish that
ACL. Run the gateway as a dedicated OS user, and restrict its database directory
and TLS tunnel configuration to that user. The database contains private note
content in plaintext: use encrypted disks and encrypted, access-controlled backups.

Configure the chosen Cloudflare-managed TLS tunnel to forward a dedicated
`https://notes.example.com` hostname to `http://127.0.0.1:4318`. Its Host header
must match that HTTPS hostname or the local destination host/port. Public clients
must use HTTPS. There is no public plain-HTTP listener or trust in client-supplied
`X-Forwarded-*` headers. Keep the gateway and tunnel on the same host. A remote
TLS proxy forwarding cleartext across a network is not this deployment model.

TLS/tunnel provisioning, service supervision and scheduled encrypted backups are
operator responsibilities; the repository does not create those resources or
claim that a particular deployment is configured correctly. Before connecting
live notes, verify the public HTTPS route, denial cases, persistence across
restarts and a snapshot restore using synthetic data.

## Connect a client

Set a private environment variable in the **Local Collab server process** and in
any CLI process that accesses storage directly. For example:

```sh
export NOTES_API_TOKEN="$(cat /private/collab/desktop-agent.token)"
```

PowerShell equivalent:

```powershell
$env:NOTES_API_TOKEN = (Get-Content -LiteralPath 'C:\private\collab\desktop-agent.token' -Raw).Trim()
```

Keep the environment variable out of shell logs and source control. Add this
storage configuration to your ignored `local-collab.config.json`:

```json
{
  "storage": {
    "type": "http",
    "label": "Team workspace",
    "baseUrl": "https://notes.example.com/v1/workspaces/team",
    "auth": { "type": "bearer", "tokenEnv": "NOTES_API_TOKEN" }
  }
}
```

Restart the local app with that environment. It accesses storage on the server
side; the browser does not receive the credential. Give another machine/agent a
different credential with the same workspace when it should share these notes.
The bundled service uses Bearer credentials; the adapter's API-key option remains
available for other implementations of the HTTP contract.

Selecting a workspace does not import any existing files. Back up and migrate
deliberately. All clients in a workspace share the same note names. Separate
ActiveCollab accounts/projects should normally use separate workspaces, since
`ac-123.md` can refer to different tickets in different tracker projects.
ActiveCollab credentials and ticket caches stay on each installation, separate
from shared notes. Private notes are never sent as ActiveCollab comments.

## History, recovery and credential administration

The basic API remains `GET /notes`, `GET /notes/{name}` and conditional
`PUT /notes/{name}`, relative to `/v1/workspaces/{workspace}`. Authenticated
image reads and conditional uploads use the [attachment contract](STORAGE.md#image-attachments).
Images are immutable BLOBs scoped to a workspace and note. Creation records the
credential ID and principal, and charges the original byte count plus record
overhead against the workspace budget. Read-only clients cannot upload, including
duplicate content. The 5 MiB image and 50-image/100 MiB per-note limits also apply.

Version 1.2 upgrades a schema-1 database to schema 2 transactionally when it is
opened, adding image storage while preserving notes, credentials and history.
Take a snapshot before upgrading an existing service. New snapshots include
image bytes automatically; a Markdown export alone does not. This upgrade does
not start a gateway, select HTTP storage or move an installation's local files.

Two additional authenticated read endpoints provide history:

- `GET /notes/{name}/history` returns `{entries, next}` with at most 100 newest
  records. Entries include `sequence`, `revision`, `previous`, `modified`,
  `principal` and `credential_id`; note bodies and secrets are omitted. Continue
  with `?before={next}` until `next` is null.
- `GET /notes/{name}/revisions/{revision}` returns the old raw note, modified time
  and ETag. The revision path component is the UUID without surrounding quotes.

To recover a note, read its old revision, read the **current** note's ETag, then
PUT the recovered raw content with `If-Match` set to that current ETag. Recovery
creates a new attributed historical revision; it never erases intervening edits.
Any client with write access can replace an entire note, so preserve backups even
when collaborators normally use append-only entry commands.

Run these commands only on the service host:

```sh
node storage-service/cli.mjs credentials --db /private/collab/database.sqlite
node storage-service/cli.mjs revoke --db /private/collab/database.sqlite --id CREDENTIAL_ID
node storage-service/cli.mjs backup --db /private/collab/database.sqlite --out /private/backups/collab-snapshot.sqlite
node storage-service/cli.mjs restore --from /private/backups/collab-snapshot.sqlite --db /private/recovery/database.sqlite
```

Backups use SQLite's consistent `VACUUM INTO` snapshot operation and may run while
the gateway is serving. The destination must be a new file. Restore also requires
a new destination and verifies database/foreign-key integrity. Stop the gateway
before switching it to the recovered path. Never copy only the live SQLite file
while writes are active, overwrite a running database, or place the database on a
network filesystem. Restored snapshots include credential digests and their saved
expiry/revocation state; reapply any revocations made after the snapshot before
serving a restored database.

Keep encrypted snapshots off the service host as well. The bundled commands
support backup and restore, but do not schedule, encrypt, replicate or retain
snapshots for you. Provision a new workspace/archive offline if its conservative
budget is reached; there is no automatic history pruning.

## Limits and validation

This is a small-team, single-host gateway. Multiple clients share it over HTTP;
the SQLite file is never shared directly between computers. It is not a hosted
multi-tenant SaaS product with interactive sign-in, SSO, billing, per-note roles
or high availability. Another service can use Postgres or another database behind
the same contract, but it must enforce equivalent permissions and atomic writes.

Tests exercise real HTTP requests and SQLite: denied cross-workspace access on
all read/write/history paths, read-only/expired/revoked credentials, concurrent
creates/edits through independent database connections, authenticated history,
request and storage limits, backup/restore, and secret-file administration.
Client tests also verify bounded streaming reads and failure without disk
fallback. These tests establish code behavior; deployed TLS, host permissions,
backup scheduling and production operations require their own verification.
