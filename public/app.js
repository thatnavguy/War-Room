'use strict';

const $ = (sel) => document.querySelector(sel);

const searchInput = $('#search');
const filterEls = {
  provider: $('#f-provider'),
  priority: $('#f-priority'),
  project: $('#f-project'),
  type: $('#f-type'),
  state: $('#f-state'),
  iteration: $('#f-iteration'),
  from: $('#f-from'),
  to: $('#f-to'),
};
const mineCheckbox = $('#f-mine');
const FILTER_STORAGE_KEY = 'mission-hall.work-filters';

function saveFilters() {
  const params = new URLSearchParams();
  params.set('search', searchInput.value);
  for (const [key, el] of Object.entries(filterEls)) {
    if (el.value) params.set(key, el.value);
  }
  if (mineCheckbox.checked) params.set('mine', '1');
  sessionStorage.setItem(FILTER_STORAGE_KEY, params.toString());
}

function restoreFilters() {
  const saved = sessionStorage.getItem(FILTER_STORAGE_KEY);
  if (saved === null) return;
  const params = new URLSearchParams(saved);
  searchInput.value = params.get('search') || '';
  for (const [key, el] of Object.entries(filterEls)) {
    el.value = params.get(key) || '';
  }
  mineCheckbox.checked = params.get('mine') === '1';
}

let staleCutoff = null;
let meName = '';
let meProvider = '';
let meScope = '';
let providers = [];
let staleDays = 14;
let currentItems = [];

function fmtDate(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function elapsedDays(iso) {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

async function loadSummary() {
  const res = await fetch('/api/summary');
  const s = await res.json();
  if (!res.ok) throw new Error(s.error || 'Could not load the work summary.');
  $('#card-open').textContent = s.open;
  $('#card-recent').textContent = s.recentlyUpdated;
  $('#card-stale').textContent = s.stale;
  $('#card-stale-label').textContent = `unchanged for ${s.staleDays}+ days`;
  $('#last-sync').textContent = s.lastSync
    ? `Last synced ${new Date(s.lastSync).toLocaleString()}`
    : 'Never synced';
  $('#rail-connection').textContent = `${providers.filter((provider) => provider.configured).map((provider) => provider.label).join(', ')} · local tracking`;
  $('#attention-caption').textContent = `No update in ${s.staleDays}+ days`;

  staleCutoff = new Date(Date.now() - s.staleDays * 86400000);
  staleDays = s.staleDays;

  renderGroup('#group-state', s.byState);
  renderGroup('#group-type', s.byType);
  renderGroup('#group-project', s.byProject);
  renderGroup('#group-iteration', s.byIteration);
}

function renderGroup(sel, rows) {
  const ul = $(sel);
  ul.innerHTML = '';
  for (const row of rows.slice(0, 10)) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = row.key || '(none)';
    const count = document.createElement('span');
    count.textContent = row.n;
    li.append(name, count);
    ul.appendChild(li);
  }
}

async function loadFilters() {
  const res = await fetch('/api/filters');
  const f = await res.json();
  if (!res.ok) throw new Error(f.error || 'Could not load work filters.');
  fill(filterEls.project, f.projects, 'All projects');
  fill(filterEls.type, f.types, 'All types');
  fill(filterEls.state, f.states, 'All states');
  fill(filterEls.iteration, f.iterations, 'All iterations');
  fill(filterEls.priority, f.priorities, 'All priority levels');
  filterEls.provider.replaceChildren(new Option('All sources', ''));
  for (const provider of providers) {
    filterEls.provider.appendChild(new Option(provider.label, provider.id));
  }
  $('#provider-filter').hidden = providers.length < 2;
  restoreFilters();
}

function fill(select, values, placeholder) {
  select.replaceChildren(new Option(placeholder, ''));
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  }
}

async function loadItems() {
  saveFilters();
  const params = new URLSearchParams();
  if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
  for (const [key, el] of Object.entries(filterEls)) {
    if (el.value) params.set(key, el.value);
  }
  if (mineCheckbox.checked) params.set('mine', '1');
  const res = await fetch('/api/items?' + params);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not load work items.');
  currentItems = data.items;
  $('#result-count').textContent = `${data.total.toLocaleString()} ${data.total === 1 ? 'item' : 'items'}`;

  const tbody = $('#results-body');
  tbody.replaceChildren();
  if (data.items.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'table-message';
    cell.colSpan = 9;
    cell.textContent = data.total === 0 ? 'No work items match these filters.' : 'No items to show.';
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  for (const item of data.items) {
    const tr = document.createElement('tr');
    tr.className = 'work-row';
    tr.dataset.id = item.id;
    if (staleCutoff && item.changed_date && new Date(item.changed_date) < staleCutoff) {
      tr.classList.add('stale-row');
    }
    if (meName && item.provider === meProvider && item.source_scope === meScope && item.assigned_to === meName) {
      tr.classList.add('mine-row');
    }

    const cells = [
      { label: 'ID', value: item.external_id, kind: 'id' },
      { label: 'Title', value: item.title, kind: 'title' },
      { label: 'Type', value: item.type },
      { label: 'State', value: item.state, kind: 'state' },
      { label: 'Assigned to', value: item.assigned_to },
      { label: 'Project', value: item.project },
      { label: 'Iteration', value: item.iteration_path ? item.iteration_path.split('\\').pop() : '–', title: item.iteration_path },
      { label: 'Changed', value: fmtDate(item.changed_date) },
      { label: 'Priority level', value: item.priority_level },
    ];

    cells.forEach((cell, i) => {
      const td = document.createElement('td');
      td.dataset.label = cell.label;
      if (cell.kind === 'id') {
        td.className = 'id-cell';
        const a = document.createElement('a');
        a.href = `/item.html?id=${item.id}`;
        a.textContent = item.external_id;
        a.title = `${item.provider_label} · ${item.source_scope}`;
        td.appendChild(a);
      } else if (cell.kind === 'title') {
        td.className = 'title-cell';
        const a = document.createElement('a');
        a.href = `/item.html?id=${item.id}`;
        a.textContent = cell.value || 'Untitled work item';
        td.appendChild(a);
      } else if (cell.kind === 'state') {
        const state = document.createElement('span');
        state.className = `state-tag${tr.classList.contains('stale-row') ? ' state-tag-stale' : ''}`;
        state.textContent = cell.value || 'Unknown';
        td.appendChild(state);
      } else {
        if (cell.label === 'Assigned to' && item.my_display_name && cell.value === item.my_display_name) {
          const name = document.createElement('span');
          name.className = 'my-name';
          name.textContent = cell.value;
          td.appendChild(name);
        } else {
          td.textContent = cell.value == null || cell.value === '' ? '–' : cell.value;
        }
        if (cell.title) td.title = cell.title;
      }
      tr.appendChild(td);
    });

    tr.addEventListener('click', (e) => {
      if (!e.target.closest('a')) location.href = `/item.html?id=${item.id}`;
    });
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') location.href = `/item.html?id=${item.id}`;
    });
    tbody.appendChild(tr);
  }
}

async function loadAttention() {
  const res = await fetch('/api/items?limit=500');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not load items needing attention.');

  const staleItems = data.items
    .filter((item) => item.changed_date && new Date(item.changed_date) < staleCutoff)
    .sort((a, b) => new Date(a.changed_date) - new Date(b.changed_date));
  const list = $('#attention-list');
  list.replaceChildren();

  $('#attention-count').textContent = $('#card-stale').textContent;
  $('#attention-empty').hidden = staleItems.length > 0;
  $('#attention-list').hidden = staleItems.length === 0;
  $('#show-attention').hidden = staleItems.length === 0;

  for (const item of staleItems.slice(0, 5)) {
    const row = document.createElement('a');
    row.className = 'attention-row';
    row.href = `/item.html?id=${item.id}`;

    const age = document.createElement('span');
    age.className = 'attention-age';
    const days = elapsedDays(item.changed_date);
    age.textContent = days == null ? '–' : `${days} days`;

    const title = document.createElement('span');
    title.className = 'attention-title';
    title.textContent = item.title || 'Untitled work item';
    const project = document.createElement('span');
    project.className = 'attention-project';
    project.textContent = item.project || '–';
    const state = document.createElement('span');
    state.className = 'attention-state';
    state.textContent = item.state || 'Unknown';
    const changed = document.createElement('span');
    changed.className = 'attention-changed';
    changed.textContent = fmtDate(item.changed_date);

    row.append(age, title, project, state, changed);
    row.setAttribute('aria-label', `${item.title || 'Untitled work item'}, ${item.project || 'no project'}, ${item.state || 'unknown'}, unchanged for ${age.textContent}, last changed ${changed.textContent}`);
    list.appendChild(row);
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const debouncedLoad = debounce(loadItems, 200);
searchInput.addEventListener('input', () => {
  saveFilters();
  debouncedLoad();
});
for (const el of Object.values(filterEls)) el.addEventListener('change', loadItems);
mineCheckbox.addEventListener('change', loadItems);

$('#clear-filters').addEventListener('click', () => {
  searchInput.value = '';
  for (const el of Object.values(filterEls)) el.value = '';
  mineCheckbox.checked = false;
  loadItems();
  searchInput.focus();
});

$('#show-attention').addEventListener('click', () => {
  if (staleCutoff) filterEls.to.value = staleCutoff.toISOString().slice(0, 10);
  loadItems().catch(showLoadError);
  $('#work-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== searchInput && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) {
    e.preventDefault();
    searchInput.focus();
  } else if (e.key === 'Escape' && document.activeElement === searchInput) {
    searchInput.value = '';
    loadItems();
  }
});

function showLoadError(err) {
  const message = err.message || 'Something went wrong while loading your work.';
  $('#attention-list').hidden = false;
  $('#attention-list').replaceChildren();
  const error = document.createElement('p');
  error.className = 'inline-error';
  error.textContent = message;
  $('#attention-list').appendChild(error);
  const tableBody = $('#results-body');
  tableBody.replaceChildren();
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.className = 'table-message table-error';
  cell.colSpan = 9;
  cell.textContent = message;
  row.appendChild(cell);
  tableBody.appendChild(row);
}

$('#sync-btn').addEventListener('click', async () => {
  const btn = $('#sync-btn');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Syncing…';
  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const stats = await res.json();
    if (!res.ok) throw new Error(stats.error || 'Sync failed');
    if (stats.errors && stats.errors.length > 0) {
      throw new Error(`Sync completed with ${stats.errors.length} issue${stats.errors.length === 1 ? '' : 's'}. Check the server log for details.`);
    }
    await loadSummary();
    await loadFilters();
    await Promise.all([loadItems(), loadAttention()]);
  } catch (err) {
    showLoadError(err);
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Sync now';
  }
});

async function init() {
  const providerRes = await fetch('/api/providers');
  const providerData = await providerRes.json();
  if (!providerRes.ok) throw new Error(providerData.error || 'Could not load work sources.');
  providers = providerData.providers;
  const configRes = await fetch('/api/config');
  const cfg = await configRes.json();
  if (!configRes.ok) throw new Error(cfg.error || 'Could not check your work connections.');
  if (!cfg.configured) {
    $('#unconfigured').hidden = false;
    $('#sync-btn').disabled = true;
    $('#rail-connection').textContent = 'Not connected';
    $('#attention-list').hidden = true;
    $('#attention-empty').hidden = false;
    $('#attention-empty').textContent = 'Connect Azure DevOps to see work items that need attention.';
    return;
  }
  const meRes = await fetch('/api/me');
  const me = await meRes.json();
  if (!meRes.ok) throw new Error(me.error || 'Could not load your Azure DevOps profile.');
  meName = me.displayName;
  meProvider = me.provider;
  meScope = me.source_scope;
  await loadSummary();
  await loadFilters();
  await Promise.all([loadItems(), loadAttention()]);
}

init().catch(showLoadError);
