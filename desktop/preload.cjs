const { ipcRenderer } = require('electron');
window.addEventListener('DOMContentLoaded', () => {
  const header = document.querySelector('.topbar');
  if (!header) return;
  let button = document.querySelector('#desktop-settings');
  if (!button) {
    button = document.createElement('button');
    button.id = 'desktop-settings';
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = 'Settings';
    header.insertBefore(button, header.querySelector('#shared-instructions'));
  }
  button.addEventListener('click', event => {
    event.stopImmediatePropagation();
    ipcRenderer.send('desktop:open-settings');
  }, { capture: true });
});
