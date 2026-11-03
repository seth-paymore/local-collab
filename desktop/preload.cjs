const { ipcRenderer } = require('electron');
window.addEventListener('DOMContentLoaded', () => {
  const header = document.querySelector('.topbar');
  if (!header) return;
  const button = document.createElement('button');
  button.id = 'desktop-settings';
  button.className = 'ghost';
  button.textContent = 'Settings';
  button.addEventListener('click', () => ipcRenderer.send('desktop:open-settings'));
  header.insertBefore(button, header.querySelector('#shared-instructions'));
});
