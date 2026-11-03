import { packager } from '@electron/packager';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ID, APP_NAME } from './policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const stage = join(root, '.desktop-build');
// Only source files are allowed into the distributable. Never copy a working
// checkout wholesale: local configuration, notes, tokens and logs stay private.
if (dirname(stage) !== root) throw new Error('Unexpected build staging directory.');
console.log(`Build staging directory: ${stage}`);
await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, 'runtime'), { recursive: true });
for (const name of ['main.mjs', 'application.mjs', 'policy.mjs', 'startup.mjs', 'startup-task.ps1',
  'preload.cjs', 'settings-preload.cjs', 'settings.html', 'settings.css', 'settings.js']) await cp(join(here, name), join(stage, name));
const metadata = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));
const { devDependencies, scripts, ...manifest } = metadata;
await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
for (const name of ['server.mjs', 'lib', 'public', 'assets/local-collab.ico', 'service/supervise.mjs', 'LICENSE']) {
  const destination = join(stage, 'runtime', name);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(root, name), destination, { recursive: true });
}
const paths = await packager({
  dir: stage, out: join(root, 'dist'), name: APP_NAME, executableName: APP_NAME,
  platform: 'win32', arch: 'x64', electronVersion: metadata.devDependencies.electron,
  download: { cacheRoot: join(here, 'node_modules', '.cache', 'electron') },
  appVersion: metadata.version, appBundleId: APP_ID, icon: join(root, 'assets', 'local-collab.ico'),
  overwrite: true, asar: false, prune: false,
  win32metadata: { CompanyName: 'Local Collab', FileDescription: APP_NAME, ProductName: APP_NAME,
    OriginalFilename: 'Local Collab.exe', InternalName: 'Local Collab' },
});
console.log(paths.join('\n'));
