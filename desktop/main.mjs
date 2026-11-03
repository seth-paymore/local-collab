import { app, dialog } from 'electron';
import { startDesktop } from './application.mjs';

startDesktop().catch(async error => {
  console.error(error);
  await app.whenReady();
  dialog.showErrorBox('Local Collab could not open', error.message);
  app.exit(1);
});
