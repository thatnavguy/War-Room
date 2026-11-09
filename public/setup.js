'use strict';

const $ = (sel) => document.querySelector(sel);

async function load() {
  const cfg = await fetch('/api/config').then((r) => r.json());

  $('#org-url').value = cfg.azureDevOps.orgUrl || '';
  $('#projects').value = cfg.azureDevOps.projects || '';
  $('#ado-auto-sync-minutes').value = cfg.azureDevOps.autoSyncMinutes;
  $('#pat-hint').textContent = cfg.azureDevOps.patSet
    ? 'A token is saved. Leave blank to keep it, or paste a new one to replace it.'
    : 'No token saved yet.';
  $('#ado-status').textContent = cfg.azureDevOps.configured ? 'Connected' : 'Not connected';
  $('#ado-status').classList.toggle('is-connected', cfg.azureDevOps.configured);

  $('#gh-repos').value = cfg.github.repos || '';
  $('#gh-host').value = cfg.github.host || 'github.com';
  $('#gh-auto-sync-minutes').value = cfg.github.autoSyncMinutes;
  $('#gh-token-hint').textContent = cfg.github.tokenSet
    ? 'A token is saved. Leave blank to keep it, or paste a new one to replace it.'
    : 'No token saved yet.';
  $('#github-status').textContent = cfg.github.configured ? 'Connected' : 'Not connected';
  $('#github-status').classList.toggle('is-connected', cfg.github.configured);

  $('#port').value = cfg.port;
  $('#stale-days').value = cfg.staleDays;
  $('#lookback-days').value = cfg.lookbackDays;
}

function wireForm(formSel, statusSel, buildBody) {
  $(formSel).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $(formSel).querySelector('button[type="submit"]');
    const status = $(statusSel);
    btn.disabled = true;
    status.textContent = 'Saving…';
    status.className = 'muted';
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      status.textContent = data.portChanged
        ? `Saved. Port changed to ${data.port} — restart the server to apply.`
        : 'Saved.';
      status.className = 'muted status-success';
      $('#pat').value = '';
      $('#gh-token').value = '';
      await load();
    } catch (err) {
      status.textContent = err.message;
      status.className = 'muted status-error';
    } finally {
      btn.disabled = false;
    }
  });
}

wireForm('#ado-form', '#ado-save-status', () => ({
  azureDevOps: {
    orgUrl: $('#org-url').value,
    pat: $('#pat').value,
    projects: $('#projects').value,
    autoSyncMinutes: Number($('#ado-auto-sync-minutes').value),
  },
}));

wireForm('#github-form', '#github-save-status', () => ({
  github: {
    ghToken: $('#gh-token').value,
    ghRepos: $('#gh-repos').value,
    ghHost: $('#gh-host').value,
    autoSyncMinutes: Number($('#gh-auto-sync-minutes').value),
  },
}));

wireForm('#general-form', '#general-save-status', () => ({
  general: {
    port: parseInt($('#port').value, 10),
    staleDays: parseInt($('#stale-days').value, 10),
    lookbackDays: parseInt($('#lookback-days').value, 10),
  },
}));

load().catch((err) => {
  $('#ado-save-status').textContent = err.message;
  $('#ado-save-status').className = 'muted status-error';
});
