# Background jobs

Local Collab runs trusted local commands on a daily or interval schedule. It
saves each run and appends a result entry to a shared note. Agents see pending
results the next time they use the notes CLI, and can mark a run reviewed after
recording their assessment. No AI scheduler or model API is needed for execution.

## Register a job

Save a private definition outside the checkout:

```json
{
  "id": "daily-snapshot",
  "name": "Daily performance snapshot",
  "command": {
    "executable": "C:/Program Files/nodejs/node.exe",
    "args": ["C:/path/to/collector.mjs"],
    "cwd": "C:/path/to"
  },
  "schedule": { "kind": "daily", "time": "09:00", "timeZone": "America/New_York" },
  "notificationNote": "agent-inbox",
  "timeoutMs": 300000,
  "enabled": true
}
```

```sh
node bin/job.mjs register /path/to/private-definition.json
node bin/job.mjs list
node bin/job.mjs run daily-snapshot
node bin/job.mjs inbox
node bin/job.mjs history daily-snapshot
node bin/job.mjs pause daily-snapshot
node bin/job.mjs resume daily-snapshot
node bin/job.mjs review RUN-UUID --author Reviewer
```

Paths must be absolute. Commands receive an argument array and run without a
shell. Register only trusted, noninteractive commands that finish. Definitions
are changed through the local CLI/file, and the runner reloads them automatically;
the website API can run/pause registered jobs but cannot supply executable code.
Interval schedules use `{ "kind": "interval", "minutes": 60 }`.

## Results and agent handoff

Each process receives `LOCAL_COLLAB_JOB_DIR`, `LOCAL_COLLAB_JOB_ID` and
`LOCAL_COLLAB_JOB_RUN_ID`. The first is its unique evidence directory. A collector
can write `result.json`, other evidence files and a `summary.md` there. The runner
appends up to 16 KiB of summary text with timestamps, outcome, run ID and evidence
location to the configured note. Existing note status and next steps are preserved.

`note show`, `list`, `search` and `health` display pending job review notices.
With `--json`, notices go to stderr so stdout keeps its existing JSON format.
Reading does not mark a result reviewed. Job completion and review are independent
of accepting a fix or completing a tracker task.

The **Jobs** button shows schedules, current runs, recent outcomes and review
links. It provides Run now, Pause/Resume and Mark reviewed controls. A successful
exit means the command completed; collectors must report incomplete capture by
exiting nonzero and explaining it in `summary.md`.

## Schedule and recovery

The server must be running and the computer must be awake and connected to the
required services. Windows sign-in startup can be enabled in desktop Settings.
An overdue schedule runs once when the runner returns, records its actual capture
time and schedules the next future occurrence. Daily jobs use their specified
time zone and run once per local calendar date, including a repeated DST hour.
New and resumed jobs schedule their next future occurrence; Run now is separate.

One run per job can be active. Detached workers survive a server restart, and a
persisted result outbox retries note delivery with the existing note API's save
identifier protection. Interrupted/unknown outcomes are reported for review;
commands are not automatically replayed after an uncertain result.

Commands have a default five-minute timeout (maximum thirty minutes) and a 1 MiB
combined stdout/stderr limit. Windows uses process-tree termination on timeout;
if Windows refuses it, the direct process is stopped and a warning is retained
with the private run record. Scripts must not launch background daemons.

## Private local state

Definitions, schedules, run records and output live in `<notesDir>/.jobs/` by
default. Optional local configuration key `jobsDir` selects a different absolute
directory. Job state and evidence stay on the executing computer, including when
notes use HTTP storage. Back up that directory along with notes. No job files or
credentials are included in desktop packages. Keep credentials in an explicitly
configured private credential source, never in command arguments or note output.

API endpoints: `GET /api/jobs`, `GET /api/jobs/inbox`, `GET /api/jobs/runs`,
`GET /api/jobs/{id}/runs`, `POST /api/jobs/{id}/run` with `{requestId}`,
`POST /api/jobs/{id}/pause` with `{paused}`, and
`POST /api/jobs/runs/{runId}/review` with `{author}`. POST requests use the same
localhost Host/Origin and JSON/custom-header checks as existing note writes.
