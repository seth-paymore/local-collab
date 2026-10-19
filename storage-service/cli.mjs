import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {open, rm} from 'node:fs/promises';
import {openDatabase, restoreDatabase} from './database.mjs';
import {createStorageServer} from './http.mjs';

process.umask(0o077);
const HELP = `Local Collab shared storage (Node.js 22.13+)
  init                          Create a new private database
  workspace --workspace ID      Create an isolated note collection
  issue --workspace ID --principal ID --role read|write --out TOKEN_FILE [--days 30]
                                Issue a client credential to a NEW private file
  credentials                   List credential metadata, never secrets
  revoke --id CREDENTIAL_ID      Disable a credential issued by this service
  serve [--port 4318] [--origin https://notes.example.com]
                                Listen on 127.0.0.1 behind an HTTPS tunnel
  backup --out NEW_FILE          Create a consistent private snapshot
  restore --from SNAPSHOT        Restore to a NEW database path

All commands accept --db PATH (or LOCAL_COLLAB_STORAGE_DB).
Default: ~/.local-collab/storage/database.sqlite
No command prints credential secrets. Administration is local to the host.
See docs/SHARED-STORAGE.md for setup, permissions and recovery.`;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') return console.log(HELP);
  const allowed = {
    init: [], workspace: ['workspace'], issue: ['workspace', 'principal', 'role', 'out', 'days'],
    credentials: [], revoke: ['id'], serve: ['port', 'origin'], backup: ['out'], restore: ['from'],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error('Unknown command; use --help');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2), value = args[i + 1];
    if (!args[i].startsWith('--') || !['db', ...allowed[command]].includes(key) || !value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error('Invalid or duplicate option; use --help');
    options[key] = value;
  }
  const required = name => { if (!options[name]) throw new Error(`--${name} is required`); return options[name]; };
  const path = resolve(options.db ?? process.env.LOCAL_COLLAB_STORAGE_DB ?? join(homedir(), '.local-collab', 'storage', 'database.sqlite'));
  if (command === 'restore') {
    await restoreDatabase(required('from'), path);
    return console.log(JSON.stringify({restored: path}));
  }
  const database = await openDatabase(path, {create: command === 'init'});
  let serving = false;
  try {
    if (command === 'init') console.log(JSON.stringify({created: path}));
    if (command === 'workspace') { database.createWorkspace(required('workspace')); console.log(JSON.stringify({workspace: options.workspace, created: true})); }
    if (command === 'credentials') console.log(JSON.stringify(database.credentials(), null, 2));
    if (command === 'revoke') console.log(JSON.stringify({id: required('id'), revoked: database.revoke(options.id)}));
    if (command === 'backup') { await database.backup(required('out')); console.log(JSON.stringify({backup: resolve(options.out)})); }
    if (command === 'issue') {
      const workspace = required('workspace'), principal = required('principal'), role = required('role');
      const destination = resolve(required('out'));
      // Fail before issuing anything if the destination already exists or cannot be opened.
      const file = await open(destination, 'wx', 0o600);
      let credential, failed = false;
      try {
        credential = database.issue({workspace, principal, role, days: options.days === undefined ? 30 : Number(options.days)});
        await file.writeFile(`${credential.token}\n`, 'utf8'); await file.sync();
      } catch (error) {
        if (credential) database.revoke(credential.id);
        failed = true;
        throw error;
      } finally { await file.close(); if (failed) await rm(destination, {force: true}); }
      const {token, ...metadata} = credential;
      console.log(JSON.stringify({...metadata, tokenFile: destination}));
    }
    if (command === 'serve') {
      const port = options.port === undefined ? 4318 : Number(options.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
      const server = createStorageServer({database, publicOrigin: options.origin, onEvent: value => console.error(JSON.stringify(value))});
      await new Promise((resolveStart, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveStart); });
      serving = true;
      console.log(JSON.stringify({service: 'local-collab-storage', url: `http://127.0.0.1:${port}`, publicOrigin: options.origin ?? null, pid: process.pid}));
      let stopping = false;
      const stop = () => {
        if (stopping) return; stopping = true;
        server.close(() => { database.close(); });
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 10000).unref();
      };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    }
  } finally { if (!serving) database.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
