import {createServer as httpServer} from 'node:http';
import {randomUUID, createHash} from 'node:crypto';
import {ServiceError, NOTE_NAME, WORKSPACE} from './database.mjs';

const MAX_BODY_BYTES = 800000;
const HEADERS = {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"};
function limiter(maximum, windowMs, now) {
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error('Invalid rate limit');
  const buckets = new Map();
  return key => {
    const time = now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= time) {
      for (const [id, entry] of buckets) if (entry.until <= time) buckets.delete(id);
      if (!bucket && buckets.size >= 10000) throw new ServiceError(429, 'Request limit reached');
      bucket = {until: time + windowMs, used: 0}; buckets.set(key, bucket);
    }
    if (++bucket.used > maximum) throw new ServiceError(429, 'Request limit reached');
  };
}
async function body(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') || req.headers['content-encoding']) throw new ServiceError(415, 'Uncompressed application/json required');
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) throw new ServiceError(413, 'Request too large');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ServiceError(413, 'Request too large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ServiceError(400, 'Invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.raw !== 'string') throw new ServiceError(400, 'Body must contain only raw Markdown');
  return value.raw;
}

// Only the storage gateway is suitable for a TLS tunnel. Never tunnel the local UI.
export function createStorageServer({database, publicOrigin, now = Date.now, requestsPerMinute = 1200, attemptsPerMinute = 2400, maxConcurrent = 32, onEvent = () => {}}) {
  let origin;
  if (publicOrigin) {
    origin = new URL(publicOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('publicOrigin must be an HTTPS origin');
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('Invalid concurrency limit');
  const clientLimit = limiter(requestsPerMinute, 60000, now), networkLimit = limiter(attemptsPerMinute, 60000, now);
  let active = 0;
  const server = httpServer({maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000}, async (req, res) => {
    const requestId = randomUUID();
    function send(status, value, headers = {}) {
      res.writeHead(status, {...HEADERS, 'X-Request-Id': requestId, ...(status >= 400 ? {Connection: 'close'} : {}), ...headers});
      res.end(JSON.stringify(value));
    }
    let counted = false;
    try {
      // Bind checks also protect accidental reuse of this factory on a public listener.
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.localAddress)) throw new ServiceError(403, 'Gateway must listen on loopback behind HTTPS');
      networkLimit(req.socket.remoteAddress);
      const port = server.address().port;
      const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...(origin ? [origin.host] : [])]);
      if (!hosts.has(req.headers.host)) throw new ServiceError(421, 'Unexpected Host header');
      if (req.headers.origin !== undefined) throw new ServiceError(403, 'Browser access is not supported');
      if (active >= maxConcurrent) throw new ServiceError(503, 'Service is busy');
      active++; counted = true;
      req.setTimeout(10000, () => req.destroy());
      if (!['GET', 'PUT'].includes(req.method)) throw new ServiceError(405, 'Method not allowed');
      const authorization = req.headers.authorization;
      if (req.rawHeaders.filter((value, i) => i % 2 === 0 && value.toLowerCase() === 'authorization').length !== 1 || !/^Bearer lc_[A-Za-z0-9_-]{43}$/.test(authorization ?? '')) throw new ServiceError(401, 'Valid client credentials required');
      const token = authorization.slice(7);
      clientLimit(createHash('sha256').update(token).digest('hex'));
      // Match the raw target: no URL-normalized dot segments, encoded slashes or aliases.
      const match = /^\/v1\/workspaces\/([a-z0-9-]+)\/notes(?:\/([a-z0-9-]+\.md)(?:\/(history|revisions\/([0-9a-f-]{36})))?)?(?:\?before=([0-9]+))?$/.exec(req.url);
      if (!match || !WORKSPACE.test(match[1]) || (match[2] && !NOTE_NAME.test(match[2])) || (match[5] && match[3] !== 'history')) throw new ServiceError(400, 'Invalid storage path');
      const [, workspace, name, action, revision, before] = match;
      database.authorize(token, workspace, req.method === 'PUT');
      if (req.method === 'GET') {
        if (!name) return send(200, {notes: database.list(token, workspace)});
        if (action === 'history') {
          const entries = database.history(token, workspace, name, before ? Number(before) : undefined);
          return send(200, {entries, next: entries.length === 100 ? entries.at(-1).sequence : null});
        }
        const value = action ? database.revision(token, workspace, name, revision) : database.read(token, workspace, name);
        return send(200, value, {ETag: value.version});
      }
      if (!name || action) throw new ServiceError(405, 'Method not allowed');
      const existing = req.headers['if-match'], missing = req.headers['if-none-match'];
      if (existing === undefined && missing === undefined) throw new ServiceError(428, 'A conditional write is required');
      if ((existing !== undefined && missing !== undefined) || (missing !== undefined && missing !== '*') || (existing !== undefined && !/^"[0-9a-f-]{36}"$/.test(existing))) throw new ServiceError(400, 'Invalid write precondition');
      const raw = await body(req);
      const result = database.write(token, workspace, name, raw, missing === '*' ? null : existing);
      const {created, ...value} = result;
      send(created ? 201 : 200, value, {ETag: value.version});
    } catch (error) {
      const status = error instanceof ServiceError ? error.status : 500;
      // Only redacted metadata leaves the handler. Never log tokens, URLs or note bodies.
      if (status !== 429) { try { onEvent({event: 'storage.request.failed', requestId, status}); } catch {} }
      if (!res.headersSent && !res.destroyed) send(status, {error: status === 500 ? 'Storage request failed' : error.message, requestId}, status === 401 ? {'WWW-Authenticate': 'Bearer realm="local-collab-storage"'} : status === 429 ? {'Retry-After': '60'} : status === 405 ? {Allow: 'GET, PUT'} : {});
    } finally { if (counted) active--; }
  });
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 128;
  server.keepAliveTimeout = 5000;
  return server;
}
