const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const when = value => value ? new Date(value).toLocaleString() : '—';
export function installJobs(author) {
  const open = document.querySelector('#jobs-open');
  const dialog = element('dialog', undefined, 'jobs-dialog');
  dialog.setAttribute('aria-label', 'Background jobs');
  const heading = element('div', undefined, 'jobs-heading');
  heading.append(element('h2', 'Background jobs'));
  const close = element('button', 'Close', 'ghost'); close.type = 'button'; close.addEventListener('click', () => dialog.close()); heading.append(close);
  const description = element('p', 'Jobs run while Local Collab is available. Results stay in shared notes until an agent reviews them.', 'muted small');
  const error = element('p', '', 'error'); error.setAttribute('role', 'alert');
  const list = element('div'); const history = element('div');
  dialog.append(heading, description, error, element('h3', 'Scheduled jobs'), list, element('h3', 'Recent results'), history);
  document.body.append(dialog);
  let busy = false;
  async function api(path, body) {
    const response = await fetch(`/api/jobs${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'Job request failed.'); return value;
  }
  const action = (label, run) => {
    const button = element('button', label, 'ghost'); button.type = 'button';
    button.addEventListener('click', async () => {
      if (busy) return; busy = true; button.disabled = true; error.textContent = '';
      try { await run(); await refresh(); } catch (failure) { error.textContent = failure.message; } finally { busy = false; button.disabled = false; }
    });
    return button;
  };
  async function refresh() {
    const [configured, results, inbox] = await Promise.all([api(''), api('/runs'), api('/inbox')]);
    open.textContent = inbox.runs.length ? `Jobs · ${inbox.runs.length} to review` : 'Jobs';
    if (!dialog.open) return;
    error.textContent = configured.error ?? '';
    list.replaceChildren(); history.replaceChildren();
    if (!configured.jobs.length) list.append(element('p', 'No jobs configured.', 'muted'));
    for (const job of configured.jobs) {
      const card = element('section', undefined, 'job-card');
      const schedule = job.schedule.kind === 'daily' ? `Daily at ${job.schedule.time} (${job.schedule.timeZone})` : `Every ${job.schedule.minutes} minutes`;
      card.append(element('strong', job.name), element('p', `${schedule} · ${job.paused ? 'Paused' : `Next: ${when(job.nextRunAt)}`}`, 'muted small'));
      if (job.activeRun) card.append(element('p', `Running since ${when(job.activeRun.startedAt ?? job.activeRun.createdAt)}`));
      else if (job.lastRun) card.append(element('p', `Last result: ${job.lastRun.status} · ${when(job.lastRun.finishedAt)}`));
      const controls = element('div', undefined, 'jobs-actions');
      const run = action('Run now', () => api(`/${encodeURIComponent(job.id)}/run`, { requestId: crypto.randomUUID() })); run.disabled = Boolean(job.activeRun);
      controls.append(run, action(job.paused ? 'Resume' : 'Pause', () => api(`/${encodeURIComponent(job.id)}/pause`, { paused: !job.paused })));
      card.append(controls); list.append(card);
    }
    if (!results.runs.length) history.append(element('p', 'No runs yet.', 'muted'));
    for (const run of results.runs.slice(0, 30)) {
      const card = element('section', undefined, 'job-card');
      card.append(element('strong', `${run.name} · ${run.status}`), element('p', `Started: ${when(run.startedAt ?? run.createdAt)} · Finished: ${when(run.finishedAt)}`, 'muted small'));
      if (run.summary || run.error) {
        const details = element('details'); details.append(element('summary', 'Result'), element('pre', run.summary || run.error, 'job-summary')); card.append(details);
      }
      const controls = element('div', undefined, 'jobs-actions');
      const note = element('a', 'Open review note'); note.href = `#/${encodeURIComponent(run.notificationNote)}.md`; note.addEventListener('click', () => dialog.close()); controls.append(note);
      if (run.reviewedAt) controls.append(element('span', `Reviewed by ${run.reviewedBy}`, 'muted small'));
      else if (['succeeded', 'failed', 'timed_out', 'interrupted'].includes(run.status) && run.notifiedAt) controls.append(action('Mark reviewed', () => api(`/runs/${run.id}/review`, { author: author() })));
      card.append(controls); history.append(card);
    }
  }
  open.addEventListener('click', () => { dialog.showModal(); refresh().catch(failure => { error.textContent = failure.message; }); });
  refresh().catch(() => {});
  setInterval(() => { if (!busy) refresh().catch(failure => { if (dialog.open) error.textContent = failure.message; }); }, 10000);
}
