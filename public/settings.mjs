const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};

export function installSettings() {
  const button = document.querySelector('#desktop-settings');
  const dialog = element('dialog', undefined, 'jobs-dialog');
  dialog.setAttribute('aria-label', 'Settings');
  const heading = element('div', undefined, 'jobs-heading');
  const close = element('button', 'Close', 'ghost');
  close.type = 'button';
  close.addEventListener('click', () => dialog.close());
  heading.append(element('h2', 'Settings'), close);
  const status = element('p'); status.setAttribute('role', 'status');
  const details = element('dl');
  const jobs = element('button', 'Manage background jobs', 'primary'); jobs.type = 'button';
  jobs.addEventListener('click', () => { dialog.close(); document.querySelector('#jobs-open').click(); });
  dialog.append(heading, status, details, element('h3', 'Windows startup'),
    element('p', 'Use Settings in the desktop app to start the local server when you sign in to Windows.', 'muted'), jobs);
  document.body.append(dialog);
  button.addEventListener('click', async () => {
    dialog.showModal(); status.textContent = 'Checking local server…'; details.replaceChildren();
    try {
      const get = async path => {
        const response = await fetch(`/api/${path}`);
        if (!response.ok) throw new Error(`Could not load settings (${response.status}).`);
        return response.json();
      };
      const [health, config] = await Promise.all([get('health'), get('config')]);
      status.textContent = health.ok ? 'Local server is running.' : 'Local server is unavailable.';
      for (const [label, value] of [
        ['Server', health.url], ['Storage', config.storage.label], ['Notes location', health.notesDir],
        ['Default author', config.author], ['ActiveCollab', config.activeCollabEnabled ? 'Enabled' : 'Disabled'],
      ]) details.append(element('dt', label), element('dd', value));
    } catch (error) { status.textContent = error.message; }
  });
}
