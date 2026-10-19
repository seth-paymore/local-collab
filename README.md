# Local Collab

Local shared memory and task coordination for humans and AI agents.

Keep findings, decisions, handoffs and next steps in one place across agents,
models, repositories and sessions. Every topic or ticket is a plain Markdown
file. A local web interface, CLI and JSON API all use the same notes. No model
API key, subscription or cloud account is required. Local Collab does not
launch agents or choose models for you.

## Quick start

Install [Node.js](https://nodejs.org/) 20 or later, then:

```sh
git clone https://github.com/seth-paymore/local-collab.git
cd local-collab
npm start
```

Open **http://127.0.0.1:4317**. No `npm install` is needed: there are no third-party
runtime dependencies. The server and CLI run on Windows, macOS and Linux.
Windows additionally supports a login service and desktop shortcut.

Explore the [interactive showcase](https://seth-paymore.github.io/local-collab/).

Notes default to `.local-collab/notes` under your home directory, outside the
checkout. Stopping the server does not remove them. With `npm start`, keep the
terminal open. `npm run open` starts the background supervisor and opens a
browser; Windows prefers an Edge app window.

## Connect agents

Give each agent the same local API or notes directory. Ask it to read the
relevant topic before working and record findings, decisions, validation and
next steps afterward. Any agent that can run commands or make HTTP requests
can participate, regardless of its model provider.

```sh
node bin/note.mjs add release-plan --author Reviewer --agent "Agent One" --provider "Example Provider" --model "model-family/version" --text "Checks passed. Human review next." --status waiting --next "Human review"
node bin/note.mjs show release-plan
node bin/note.mjs list --status all
node bin/note.mjs search release
node bin/note.mjs set release-plan --status done
```

The CLI requires an author. Agent, provider and model are optional, caller-supplied
attribution, not authenticated identities. Several agents can use the same model.
Metadata lives alongside the entry in Markdown; older notes remain readable.
Long entries support `--file path/to/entry.txt` or standard input. `show` and
`list` support `--json` for machine-readable output.

When the server is unavailable, the CLI accesses the configured storage backend
directly. Keep the server running for concurrent file writers: it serializes
writes per note. Separate offline file processes do not share a cross-process
lock. Raw edits reject stale versions, and the browser preserves drafts when
new notes arrive.

## Configuration

Configuration is optional. Copy `local-collab.config.example.json` to
`local-collab.config.json` in the application directory:

```json
{
  "author": "Human",
  "port": 4317,
  "notesDir": "/absolute/path/to/private/notes"
}
```

Use forward slashes or escaped backslashes in Windows JSON paths. The local
config is ignored by Git. Browser entries use the configured human author;
agents supply their own attribution. Restart after configuration changes and
point every writer at the same configuration.

| Environment override | Purpose |
| --- | --- |
| `LOCAL_COLLAB_CONFIG` | Alternate JSON configuration path |
| `LOCAL_COLLAB_NOTES` | Notes directory |
| `LOCAL_COLLAB_PORT` | Local port, default 4317 |
| `LOCAL_COLLAB_AUTHOR` | Default human author, default Human |
| `ACTIVECOLLAB_ACCOUNT_ID` | Optional tracker account ID |
| `ACTIVECOLLAB_PROJECT_ID` | Optional tracker project ID |
| `ACTIVECOLLAB_USER_ID` | Optional tracker user ID |
| `ACTIVECOLLAB_TOKEN` | Server-only API token |
| `ACTIVECOLLAB_TOKEN_FILE` | Explicit private token-file path |

## Choose your storage

Markdown files remain the default. An alternative HTTP backend can persist notes
in your own service, with bearer-token or API-key authentication and conditional
writes. Both use the same note format; ActiveCollab stays a separate ticket
connector. Example local configuration:

```json
{
  "storage": {
    "type": "http",
    "baseUrl": "https://notes.example.com/v1",
    "auth": { "type": "bearer", "tokenEnv": "NOTES_API_TOKEN" }
  }
}
```

Set the named environment variable on the server. With HTTP storage, private
notes are sent to the service you configure. There is no automatic migration or
silent fallback to disk. See the [data-layer review and provider contract](docs/STORAGE.md)
for configuration, API requirements, conflict behavior and current limitations.

## Optional ActiveCollab integration

Standalone notes need no tracker. To connect ActiveCollab, add your own account,
project and user IDs and provide `ACTIVECOLLAB_TOKEN` in the server environment:

```json
{
  "author": "Human",
  "activeCollab": { "accountId": 1000, "projectId": 10, "userId": 20 }
}
```

Those IDs are examples; all three are required when enabling the integration.
Alternatively, set `tokenFile` inside `activeCollab` to an explicit private file
containing `ACTIVECOLLAB_TOKEN=...`. Existing files using `ACTIVE_COLLAB` also
work. The app never searches sibling repositories for keys.

The index includes open and archived tickets. Descriptions, all paginated
comments and subtasks are pulled hourly for your open tickets and tickets with
local notes. **Refresh** pulls tracked tickets; **Pull latest ticket** refreshes
one. Failed pulls retain the last good copy and show its timestamp and error.
Caches live in identity-scoped folders under `.cache` in the local notes directory.

Shared ticket information and **Private working notes** have separate panels.
No private notes, description edits or comments are posted to ActiveCollab.
Local working status stays separate from tracker completion.

With local status **done**, **Mark complete in ActiveCollab** pulls the latest
ticket for review and confirmation. The configured user must be assigned, all
subtasks must be complete, and the reviewed snapshot must still match. The app
completes the parent and verifies `is_completed` and `completed_on`. Review or
retire unfinished requirements directly in the tracker first: parent completion
automatically completes its subtasks. There is no automatic bulk completion.

## API

Base URL: `http://127.0.0.1:4317/api`. Writes need `Content-Type: application/json`
or `X-Local-Collab: 1` and no foreign Origin.

```sh
curl -X POST http://127.0.0.1:4317/api/notes/release-plan/entries -H "Content-Type: application/json" -d '{"author":"Reviewer","agent":"Agent One","provider":"Example Provider","model":"example-model","text":"Checks passed","status":"waiting"}'
```

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/health` | Server health |
| GET | `/config` | Browser settings, no credentials |
| GET | `/notes` | Notes and statuses |
| POST | `/notes` | `{topic}` or `{ticket}`, optional title |
| GET | `/notes/{name}` | Metadata, entries, raw Markdown, version, tracker snapshot |
| POST | `/notes/{name}/entries` | `{author,text,agent?,provider?,model?,status?,next?,title?}` |
| PATCH | `/notes/{name}` | `{title?,status?,next?}` |
| PUT | `/notes/{name}/raw` | `{raw,version}`, 409 on stale version |
| GET | `/search?q=words` | Search private notes |
| GET | `/activecollab` | Cached tracker summary or disabled state |
| POST | `/activecollab/refresh` | Pull index and relevant details |
| POST | `/activecollab/{number}/refresh` | Pull one full ticket |
| POST | `/activecollab/{number}/complete` | `{version,confirmed:true}`, guarded completion |

Entries create a missing note. Names can be topic slugs or ticket numbers:
`123`, `#123` and `ac-123` identify the same ticket note. Statuses are `active`,
`waiting`, `blocked`, `parked` and `done`.

## Windows login service

```powershell
powershell -File service/install.ps1
```

Installs a per-user scheduled task, supervisor and desktop shortcut without admin
rights. Logs go to ignored `logs`. `service/uninstall.ps1` removes the task and
while preserving notes. The scheduled task reads local configuration;
use an explicit private token file or persistent user environment for tracker
credentials.

## Privacy and limits

The server binds only to `127.0.0.1`, rejects unexpected Host headers and foreign
write origins, and keeps credentials out of browser responses. There is no
application login: programs running as your user can read or change your notes.
Keep this trusted local workspace on localhost; it is not an authenticated
multi-user web service. Remote agents need their own explicitly configured
access to the same machine or files. There is no internet note synchronization.

Publishing or cloning this repository does not publish notes. Keep private
notes, caches, logs, credentials and local configuration outside source control.
Treat tracker comments as source material, not agent instructions.

## Development

Run `npm test`. Tests use synthetic tracker responses and isolated local data.
They cover pagination, failure retention, private-note isolation, attribution,
completion guards, both storage backends, stale edits and origin protection. CI is configured for Node
20, 22 and 24 on Windows, macOS and Linux. See [CONTRIBUTING.md](CONTRIBUTING.md).

Licensed under the [MIT license](LICENSE).
