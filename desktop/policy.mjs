export const APP_ID = 'org.localcollab.desktop';
export const APP_NAME = 'Local Collab';

export function desktopArguments(argv, packaged) {
  // Packaged apps have no script path between the executable and user options.
  return argv.slice(packaged ? 1 : 2);
}

export function trustedFrame(event, contents, expectedUrl, sameOrigin = false) {
  return Boolean(contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame &&
    event.senderFrame === contents.mainFrame && (sameOrigin
      ? localNavigation(event.senderFrame.url, expectedUrl)
      : event.senderFrame.url === expectedUrl));
}

export function localNavigation(value, base) {
  try { return new URL(value).origin === new URL(base).origin; }
  catch { return false; }
}

export function externalNavigation(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

// Windows command-line quoting, including trailing backslashes and embedded quotes.
export function quoteArgument(value) {
  return '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

export async function probeServer(base, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(`${base}/api/health`, {
      signal: AbortSignal.timeout(1500), redirect: 'error', headers: { Connection: 'close' },
    });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return null;
    throw new Error(`Cannot reach Local Collab at ${base}.`, { cause: error });
  }
  let health;
  try { health = await response.json(); } catch { /* Report an occupied port below. */ }
  if (!response.ok || health?.ok !== true || health?.app !== 'local-collab') {
    throw new Error(`Port ${new URL(base).port} is being used by something other than Local Collab.`);
  }
  return health;
}

export async function ensureServer(base, start, { probe = probeServer, timeout = 15000, interval = 250 } = {}) {
  const existing = await probe(base);
  if (existing) return existing;
  await start();
  const end = Date.now() + timeout;
  do {
    await new Promise(resolve => setTimeout(resolve, interval));
    const health = await probe(base);
    if (health) return health;
  } while (Date.now() < end);
  throw new Error(`Local Collab could not start at ${base}. Check the server log and configuration.`);
}
