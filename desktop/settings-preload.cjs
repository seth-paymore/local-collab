const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopSettings', {
  getState: () => ipcRenderer.invoke('desktop:startup-state'),
  setStartup: enabled => ipcRenderer.invoke('desktop:startup-save', enabled),
});
