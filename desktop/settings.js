const startup = document.querySelector('#startup');
const save = document.querySelector('#save');
const status = document.querySelector('#status');
let saved = false;
function showState(state) {
  saved = state.enabled;
  startup.checked = saved;
  startup.disabled = !state.editable;
  save.disabled = true;
  document.querySelector('#server').textContent = `Running at ${state.server}`;
  status.className = '';
  status.textContent = !state.supported ? 'Windows startup is not available on this platform.' : !state.editable
    ? 'A different startup task exists. Manage it in Windows Task Scheduler.'
    : saved ? 'Startup is enabled.' : 'Startup is disabled.';
}
function showError(error) { status.className = 'error'; status.textContent = error.message; }
window.desktopSettings.getState().then(showState).catch(showError);
startup.addEventListener('change', () => { save.disabled = startup.checked === saved; });
save.addEventListener('click', async () => {
  save.disabled = true; startup.disabled = true;
  status.className = ''; status.textContent = 'Saving…';
  try { showState(await window.desktopSettings.setStartup(startup.checked)); }
  catch (error) { showError(error); startup.disabled = false; save.disabled = false; }
});
document.querySelector('#close').addEventListener('click', () => window.close());
