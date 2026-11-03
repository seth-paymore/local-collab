import { app, dialog } from 'electron';
import { startDesktop, startServerOnly } from './application.mjs';
import { desktopArguments } from './policy.mjs';

const serverOnly = desktopArguments(process.argv, app.isPackaged).includes('--server-only');
const started = serverOnly ? startServerOnly().then(() => app.exit(0)) : startDesktop();
started.catch(async error => {
  console.error(error);
  if (serverOnly) { app.exit(1); return; }
  await app.whenReady();
  dialog.showErrorBox('Local Collab could not open', error.message);
  app.exit(1);
});
