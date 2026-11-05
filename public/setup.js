'use strict';

const $ = (sel) => document.querySelector(sel);

async function load() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  $('#org-url').value = cfg.orgUrl || '';
  $('#projects').value = cfg.projects || '';
  $('#port').value = cfg.port;
  $('#stale-days').value = cfg.staleDays;
  $('#lookback-days').value = cfg.lookbackDays;
  $('#pat-hint').textContent = cfg.patSet
    ? 'A token is saved. Leave blank to keep it, or paste a new one to replace it.'
    : 'No token saved yet.';
}

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#save-btn');
  const status = $('#save-status');
  btn.disabled = true;
  status.textContent = 'Saving…';
  status.className = 'muted';
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgUrl: $('#org-url').value,
        pat: $('#pat').value,
        projects: $('#projects').value,
        port: parseInt($('#port').value, 10),
        staleDays: parseInt($('#stale-days').value, 10),
        lookbackDays: parseInt($('#lookback-days').value, 10),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    status.textContent = data.portChanged
      ? `Saved. Port changed to ${data.port} — restart the server to apply.`
      : 'Saved.';
    status.className = 'muted status-success';
    $('#pat').value = '';
    await load();
  } catch (err) {
    status.textContent = err.message;
    status.className = 'muted status-error';
  } finally {
    btn.disabled = false;
  }
});

load().catch((err) => {
  $('#save-status').textContent = err.message;
  $('#save-status').className = 'muted status-error';
});
