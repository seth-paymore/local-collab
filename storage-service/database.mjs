import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {mkdir, open, chmod, rm, stat, copyFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {inspectImage,IMAGE_ID,MAX_NOTE_IMAGES,MAX_NOTE_IMAGE_BYTES} from '../lib/images.mjs';

export const NOTE_NAME = /^[a-z0-9][a-z0-9-]{0,80}\.md$/;
export const WORKSPACE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_RAW_BYTES = 128 * 1024;
const TOKEN = /^lc_[A-Za-z0-9_-]{43}$/;
const hash = value => createHash('sha256').update(value).digest('hex');

export class ServiceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function check(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new ServiceError(400, `Invalid ${label}`);
}
async function sqlite() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('The storage service requires Node.js 22.13+ (Node.js 24 recommended)');
  return import('node:sqlite');
}
async function createPrivateFile(path) {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const file = await open(path, 'wx', 0o600);
  await file.close();
}

// No network administration: credentials and workspaces are managed by the host owner.
export async function openDatabase(path, {create = false, now = Date.now, maxNotes = 10000, maxWorkspaceBytes = 256 * 1024 * 1024} = {}) {
  if (!Number.isInteger(maxNotes) || maxNotes < 1 || maxNotes > 10000) throw new Error('Invalid note quota');
  if (!Number.isSafeInteger(maxWorkspaceBytes) || maxWorkspaceBytes < 1024) throw new Error('Invalid workspace storage budget');
  path = resolve(path);
  const {DatabaseSync} = await sqlite();
  if (create) await createPrivateFile(path);
  if (!(await stat(path)).isFile()) throw new Error('Storage database must be a regular file');
  const db = new DatabaseSync(path, {enableForeignKeyConstraints: true, allowExtension: false});
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
    if (create) {
      db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        BEGIN IMMEDIATE;
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, created INTEGER NOT NULL, used_bytes INTEGER NOT NULL DEFAULT 0) STRICT;
        CREATE TABLE credentials (
          id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE,
          workspace TEXT NOT NULL REFERENCES workspaces(id), principal TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('read','write')),
          created INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER
        ) STRICT;
        CREATE TABLE notes (
          workspace TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL,
          raw TEXT NOT NULL, revision TEXT NOT NULL, modified INTEGER NOT NULL,
          PRIMARY KEY(workspace,name)
        ) STRICT;
        CREATE TABLE revisions (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL,
          revision TEXT NOT NULL UNIQUE, previous TEXT, raw TEXT NOT NULL,
          modified INTEGER NOT NULL, principal TEXT NOT NULL,
          credential_id TEXT NOT NULL REFERENCES credentials(id)
        ) STRICT;
        CREATE INDEX revision_history ON revisions(workspace,name,sequence DESC);
        CREATE TABLE events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL,
          subject TEXT NOT NULL, occurred INTEGER NOT NULL
        ) STRICT;
        CREATE TRIGGER keep_revisions_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT,'History is append only'); END;
        CREATE TRIGGER keep_revisions_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT,'History is append only'); END;
        CREATE TRIGGER keep_events_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'Audit is append only'); END;
        CREATE TRIGGER keep_events_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'Audit is append only'); END;
        PRAGMA user_version=1;
        COMMIT;
      `);
    }
    const version=db.prepare('PRAGMA user_version').get().user_version;
    if(version===1) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS images (
          workspace TEXT NOT NULL, name TEXT NOT NULL, id TEXT NOT NULL,
          bytes BLOB NOT NULL, created INTEGER NOT NULL, principal TEXT NOT NULL,
          credential_id TEXT NOT NULL REFERENCES credentials(id),
          PRIMARY KEY(workspace,name,id), FOREIGN KEY(workspace,name) REFERENCES notes(workspace,name)
        ) STRICT;
        CREATE TRIGGER IF NOT EXISTS keep_images_update BEFORE UPDATE ON images BEGIN SELECT RAISE(ABORT,'Images are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS keep_images_delete BEFORE DELETE ON images BEGIN SELECT RAISE(ABORT,'Images are immutable'); END;
        PRAGMA user_version=2; COMMIT;`);
    }else if(version!==2)throw new Error('Unsupported storage database schema');
    db.exec('PRAGMA synchronous=FULL;');
  } catch (error) { db.close(); throw error; }

  const event = (kind, subject) => db.prepare('INSERT INTO events(event,subject,occurred) VALUES(?,?,?)').run(kind, subject, now());
  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = action(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function authorize(token, workspace, write = false) {
    const credential = typeof token === 'string' && TOKEN.test(token)
      ? db.prepare('SELECT id,workspace,principal,role,expires,revoked FROM credentials WHERE digest=?').get(hash(token)) : null;
    if (!credential || credential.revoked !== null || credential.expires <= now()) throw new ServiceError(401, 'Valid client credentials required');
    if (credential.workspace !== workspace || (write && credential.role !== 'write')) throw new ServiceError(403, 'Access denied');
    return credential;
  }
  const record = row => ({raw: row.raw, modified: row.modified, version: `"${row.revision}"`});
  function readRow(workspace, name) {
    check(name, NOTE_NAME, 'note name');
    const row = db.prepare('SELECT raw,revision,modified FROM notes WHERE workspace=? AND name=?').get(workspace, name);
    if (!row) throw new ServiceError(404, 'Note not found');
    return row;
  }
  return {
    path,
    close() { db.close(); },
    createWorkspace(workspace) {
      check(workspace, WORKSPACE, 'workspace');
      return transaction(() => {
        if (db.prepare('SELECT id FROM workspaces WHERE id=?').get(workspace)) throw new ServiceError(409, 'Workspace already exists');
        db.prepare('INSERT INTO workspaces(id,created) VALUES(?,?)').run(workspace, now());
        event('workspace.create', workspace);
      });
    },
    issue({workspace, principal, role = 'read', days = 30}) {
      check(workspace, WORKSPACE, 'workspace'); check(principal, WORKSPACE, 'principal');
      if (!['read', 'write'].includes(role) || !Number.isInteger(days) || days < 1 || days > 90) throw new ServiceError(400, 'Role must be read or write; expiry must be 1 to 90 days');
      return transaction(() => {
        if (!db.prepare('SELECT id FROM workspaces WHERE id=?').get(workspace)) throw new ServiceError(404, 'Workspace not found');
        const id = randomUUID(), token = `lc_${randomBytes(32).toString('base64url')}`, created = now(), expires = created + days * 86400000;
        db.prepare('INSERT INTO credentials(id,digest,workspace,principal,role,created,expires) VALUES(?,?,?,?,?,?,?)').run(id, hash(token), workspace, principal, role, created, expires);
        event('credential.issue', id);
        return {id, token, workspace, principal, role, expires};
      });
    },
    revoke(id) {
      return transaction(() => {
        const changed = db.prepare('UPDATE credentials SET revoked=? WHERE id=? AND revoked IS NULL').run(now(), id);
        if (changed.changes) event('credential.revoke', id);
        return Boolean(changed.changes);
      });
    },
    credentials() { return db.prepare('SELECT id,workspace,principal,role,created,expires,revoked FROM credentials ORDER BY created,id').all(); },
    authorize,
    list(token, workspace) {
      authorize(token, workspace);
      return db.prepare('SELECT name FROM notes WHERE workspace=? ORDER BY name').all(workspace).map(row => row.name);
    },
    read(token, workspace, name) { authorize(token, workspace); return record(readRow(workspace, name)); },
    write(token, workspace, name, raw, prior) {
      check(name, NOTE_NAME, 'note name');
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_RAW_BYTES) throw new ServiceError(413, 'Note exceeds the 128 KiB content limit');
      if (prior !== null && (typeof prior !== 'string' || !/^"[0-9a-f-]{36}"$/.test(prior))) throw new ServiceError(400, 'Invalid revision');
      return transaction(() => {
        const actor = authorize(token, workspace, true);
        const current = db.prepare('SELECT revision FROM notes WHERE workspace=? AND name=?').get(workspace, name);
        if ((current ? `"${current.revision}"` : null) !== prior) throw new ServiceError(412, 'Note changed; reload before editing');
        if (!current && db.prepare('SELECT count(*) AS n FROM notes WHERE workspace=?').get(workspace).n >= maxNotes) throw new ServiceError(409, 'Workspace note quota reached');
        // A conservative budget for both current content, permanent history and metadata.
        const cost = 2 * Buffer.byteLength(raw) + 1024;
        const charged = db.prepare('UPDATE workspaces SET used_bytes=used_bytes+? WHERE id=? AND used_bytes+?<=?').run(cost, workspace, cost, maxWorkspaceBytes);
        if (!charged.changes) throw new ServiceError(409, 'Workspace storage budget reached');
        const revision = randomUUID(), modified = now();
        if (current) db.prepare('UPDATE notes SET raw=?,revision=?,modified=? WHERE workspace=? AND name=? AND revision=?').run(raw, revision, modified, workspace, name, current.revision);
        else db.prepare('INSERT INTO notes(workspace,name,raw,revision,modified) VALUES(?,?,?,?,?)').run(workspace, name, raw, revision, modified);
        db.prepare('INSERT INTO revisions(workspace,name,revision,previous,raw,modified,principal,credential_id) VALUES(?,?,?,?,?,?,?,?)').run(workspace, name, revision, current?.revision ?? null, raw, modified, actor.principal, actor.id);
        return {created: !current, ...record({raw, revision, modified})};
      });
    },
    history(token, workspace, name, before = Number.MAX_SAFE_INTEGER) {
      authorize(token, workspace); readRow(workspace, name);
      if (!Number.isSafeInteger(before) || before < 1) throw new ServiceError(400, 'Invalid history cursor');
      return db.prepare('SELECT sequence,revision,previous,modified,principal,credential_id FROM revisions WHERE workspace=? AND name=? AND sequence<? ORDER BY sequence DESC LIMIT 100').all(workspace, name, before);
    },
    revision(token, workspace, name, revision) {
      authorize(token, workspace); check(name, NOTE_NAME, 'note name');
      const row = db.prepare('SELECT raw,revision,modified FROM revisions WHERE workspace=? AND name=? AND revision=?').get(workspace, name, revision);
      if (!row) throw new ServiceError(404, 'Revision not found');
      return record(row);
    },
    putImage(token,workspace,name,id,bytes) {
      return transaction(()=>{
        const actor=authorize(token,workspace,true);readRow(workspace,name);
        const info=inspectImage(bytes,id);
        const old=db.prepare('SELECT bytes FROM images WHERE workspace=? AND name=? AND id=?').get(workspace,name,id);
        if(old){inspectImage(old.bytes,id);return {...info,created:false};}
        const quota=db.prepare('SELECT count(*) AS n,coalesce(sum(length(bytes)),0) AS total FROM images WHERE workspace=? AND name=?').get(workspace,name);
        if(quota.n>=MAX_NOTE_IMAGES || quota.total+bytes.length>MAX_NOTE_IMAGE_BYTES)throw new ServiceError(409,'This note has reached its image storage limit');
        const cost=bytes.length+1024;
        if(!db.prepare('UPDATE workspaces SET used_bytes=used_bytes+? WHERE id=? AND used_bytes+?<=?').run(cost,workspace,cost,maxWorkspaceBytes).changes)throw new ServiceError(409,'Workspace storage budget reached');
        db.prepare('INSERT INTO images(workspace,name,id,bytes,created,principal,credential_id) VALUES(?,?,?,?,?,?,?)').run(workspace,name,id,bytes,now(),actor.principal,actor.id);
        event('image.create',`${workspace}/${name}/${id}`);
        return {...info,created:true};
      });
    },
    getImage(token,workspace,name,id) {
      authorize(token,workspace);readRow(workspace,name);
      check(id,IMAGE_ID,'image identifier');
      const row=db.prepare('SELECT bytes FROM images WHERE workspace=? AND name=? AND id=?').get(workspace,name,id);
      if(!row)throw new ServiceError(404,'Image not found');
      const bytes=Buffer.from(row.bytes);return {...inspectImage(bytes,id),bytes};
    },
    async backup(destination) {
      destination = resolve(destination);
      if (destination === path) throw new Error('Backup destination must be a new file');
      await createPrivateFile(destination);
      try { db.prepare('VACUUM INTO ?').run(destination); await chmod(destination, 0o600); }
      catch (error) { await rm(destination, {force: true}); throw error; }
      event('database.backup', 'snapshot');
    },
    integrity() {
      return db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok' && db.prepare('PRAGMA foreign_key_check').all().length === 0;
    },
  };
}

// Restore into a new file. Never replace a running database or its WAL files.
export async function restoreDatabase(source, destination) {
  destination = resolve(destination);
  await mkdir(dirname(destination), {recursive: true, mode: 0o700});
  await copyFile(resolve(source), destination, constants.COPYFILE_EXCL);
  try {
    await chmod(destination, 0o600);
    const restored = await openDatabase(destination);
    try { if (!restored.integrity()) throw new Error('Backup integrity check failed'); }
    finally { restored.close(); }
  } catch (error) { await rm(destination, {force: true}); throw error; }
}
