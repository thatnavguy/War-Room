'use strict';

const $ = (sel) => document.querySelector(sel);

const searchInput = $('#search');
const filterEls = {
  provider: $('#f-provider'),
  priority: $('#f-priority'),
  label: $('#f-label'),
  project: $('#f-project'),
  type: $('#f-type'),
  state: $('#f-state'),
};
const mineCheckbox = $('#f-mine');
const FILTER_STORAGE_KEY = 'mission-hall.work-filters';
const SAVED_VIEWS_KEY = 'mission-hall.saved-work-views';
const savedViewSelect = $('#saved-view-select');
const savedViewStatus = $('#saved-view-status');
let savedViews = [];
let currentSavedViewId = '';

function currentFilterValues() {
  const filters = { search: searchInput.value };
  for (const [key, el] of Object.entries(filterEls)) filters[key] = el.value;
  filters.mine = mineCheckbox.checked;
  return filters;
}

function applyFilterValues(filters) {
  searchInput.value = filters.search || '';
  for (const [key, el] of Object.entries(filterEls)) el.value = filters[key] || '';
  mineCheckbox.checked = Boolean(filters.mine);
}

function saveFilters() {
  const params = new URLSearchParams();
  params.set('search', searchInput.value);
  for (const [key, el] of Object.entries(filterEls)) {
    if (el.value) params.set(key, el.value);
  }
  if (mineCheckbox.checked) params.set('mine', '1');
  if (currentSavedViewId) params.set('savedView', currentSavedViewId);
  sessionStorage.setItem(FILTER_STORAGE_KEY, params.toString());
}

function restoreFilters() {
  const saved = sessionStorage.getItem(FILTER_STORAGE_KEY);
  if (saved === null) return;
  const params = new URLSearchParams(saved);
  const filters = Object.fromEntries([...params.entries()]);
  filters.mine = params.get('mine') === '1';
  applyFilterValues(filters);
  const savedViewId = params.get('savedView') || '';
  currentSavedViewId = savedViews.some((view) => view.id === savedViewId) ? savedViewId : '';
}

function renderSavedViews() {
  savedViewSelect.replaceChildren(new Option('Choose a saved view', ''));
  for (const view of savedViews) {
    savedViewSelect.appendChild(new Option(view.name, view.id));
  }
  savedViewSelect.value = currentSavedViewId;
  $('#delete-view').disabled = !currentSavedViewId;
}

function setSavedViewStatus(message, isError = false) {
  savedViewStatus.textContent = message;
  savedViewStatus.classList.toggle('status-error', isError);
}

function persistSavedViews() {
  try {
    localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(savedViews));
    return true;
  } catch {
    setSavedViewStatus('Could not save views in this browser. Check its storage settings.', true);
    return false;
  }
}

function loadSavedViews() {
  try {
    const stored = localStorage.getItem(SAVED_VIEWS_KEY);
    if (stored === null) return;
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed) || parsed.some((view) =>
      !view || typeof view.id !== 'string' || typeof view.name !== 'string' ||
      !view.filters || typeof view.filters !== 'object'
    )) {
      throw new Error('Saved views have an invalid format.');
    }
    savedViews = parsed;
  } catch (error) {
    setSavedViewStatus(error instanceof SyntaxError
      ? 'Saved views could not be read. Clear this browser’s saved data to continue.'
      : error.message || 'Saved views could not be loaded.', true);
  }
}

let staleCutoff = null;
let meName = '';
let meProvider = '';
let meScope = '';
let providers = [];
let staleDays = 14;
let currentItems = [];
let attentionItems = [];
let attentionExpanded = false;

function fmtDate(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function dueDateStatus(iso, today = new Date()) {
  if (!iso) return '';
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return '';
  due.setHours(0, 0, 0, 0);
  const currentDay = new Date(today);
  currentDay.setHours(0, 0, 0, 0);
  if (due < currentDay) return 'Overdue';
  return due.getTime() === currentDay.getTime() ? 'Due today' : '';
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
  $('#card-stale-label').textContent = `assigned to you, unchanged for ${s.staleDays}+ days`;
  $('#last-sync').textContent = s.lastSync
    ? `Last synced ${new Date(s.lastSync).toLocaleString()}`
    : 'Never synced';
  $('#rail-connection').textContent = `${providers.filter((provider) => provider.configured).map((provider) => provider.label).join(', ')} · local tracking`;
  $('#attention-caption').textContent = `Assigned to you · No update in ${s.staleDays}+ days`;

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
  fill(filterEls.priority, f.priorities, 'All priority levels');
  fill(filterEls.label, f.labels, 'All labels');
  filterEls.provider.replaceChildren(new Option('All sources', ''));
  for (const provider of providers) {
    filterEls.provider.appendChild(new Option(provider.label, provider.id));
  }
  $('#provider-filter').hidden = providers.length < 2;
  restoreFilters();
  renderSavedViews();
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
      { label: 'Due date', value: item.due_date, kind: 'due' },
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
        const labels = String(item.tags || '').split(';').map((tag) => tag.trim()).filter(Boolean);
        if (labels.length) {
          const group = document.createElement('div');
          group.className = 'item-labels';
          group.setAttribute('aria-label', 'Labels');
          for (const label of labels) {
            const badge = document.createElement('span');
            badge.className = 'item-label';
            badge.textContent = label;
            group.appendChild(badge);
          }
          td.appendChild(group);
        }
      } else if (cell.kind === 'due') {
        const status = dueDateStatus(cell.value);
        const due = document.createElement('span');
        due.className = 'due-date';
        due.textContent = fmtDate(cell.value);
        if (status) {
          due.classList.add(status === 'Overdue' ? 'due-overdue' : 'due-today');
          due.textContent += ` · ${status}`;
        }
        td.appendChild(due);
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
  const items = [];
  let total;
  do {
    const res = await fetch(`/api/items?mine=1&limit=500&offset=${items.length}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load items needing attention.');
    total = data.total;
    if (data.items.length === 0 && items.length < total) {
      throw new Error('Could not load all items needing attention. Reload the page to try again.');
    }
    items.push(...data.items);
  } while (items.length < total);

  attentionItems = items
    .filter((item) => item.changed_date && new Date(item.changed_date) < staleCutoff)
    .sort((a, b) => new Date(a.changed_date) - new Date(b.changed_date));
  if (attentionItems.length <= 5) attentionExpanded = false;
  renderAttention();
}

function renderAttention() {
  const list = $('#attention-list');
  list.replaceChildren();

  $('#attention-count').textContent = attentionItems.length;
  $('#attention-empty').hidden = attentionItems.length > 0;
  list.hidden = attentionItems.length === 0;
  const toggle = $('#show-attention');
  toggle.hidden = attentionItems.length <= 5;
  toggle.textContent = attentionExpanded ? 'Show fewer' : 'View all';
  toggle.setAttribute('aria-expanded', String(attentionExpanded));

  for (const item of attentionExpanded ? attentionItems : attentionItems.slice(0, 5)) {
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
    const priority = document.createElement('span');
    priority.className = 'attention-priority';
    priority.textContent = item.priority_level || '–';
    priority.title = `Priority level: ${item.priority_level || 'Not set'}`;
    const changed = document.createElement('span');
    changed.className = 'attention-changed';
    changed.textContent = fmtDate(item.changed_date);

    row.append(age, title, project, state, priority, changed);
    row.setAttribute('aria-label', `${item.title || 'Untitled work item'}, ${item.project || 'no project'}, ${item.state || 'unknown'}, priority level ${item.priority_level || 'not set'}, unchanged for ${age.textContent}, last changed ${changed.textContent}`);
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
  currentSavedViewId = '';
  renderSavedViews();
  saveFilters();
  debouncedLoad();
});
function onFilterChange() {
  currentSavedViewId = '';
  renderSavedViews();
  loadItems().catch(showLoadError);
}
for (const el of Object.values(filterEls)) el.addEventListener('change', onFilterChange);
mineCheckbox.addEventListener('change', onFilterChange);

savedViewSelect.addEventListener('change', () => {
  const view = savedViews.find((savedView) => savedView.id === savedViewSelect.value);
  if (!view) {
    currentSavedViewId = '';
    renderSavedViews();
    saveFilters();
    setSavedViewStatus('Using current filters.');
    return;
  }
  currentSavedViewId = view.id;
  applyFilterValues(view.filters);
  setSavedViewStatus(`Showing “${view.name}”.`);
  renderSavedViews();
  loadItems().catch(showLoadError);
});

$('#save-view').addEventListener('click', () => {
  $('#saved-view-name').value = '';
  $('#saved-view-error').hidden = true;
  $('#save-view-dialog').showModal();
  $('#saved-view-name').focus();
});

$('#cancel-save-view').addEventListener('click', () => $('#save-view-dialog').close());

$('#save-view-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('#saved-view-name').value.trim();
  const error = $('#saved-view-error');
  if (!name) {
    error.textContent = 'Enter a name for this view.';
    error.hidden = false;
    return;
  }
  if (savedViews.some((view) => view.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    error.textContent = 'A saved view with that name already exists.';
    error.hidden = false;
    return;
  }
  const view = { id: crypto.randomUUID(), name, filters: currentFilterValues() };
  savedViews.push(view);
  if (!persistSavedViews()) {
    savedViews.pop();
    return;
  }
  currentSavedViewId = view.id;
  renderSavedViews();
  saveFilters();
  setSavedViewStatus(`Saved “${name}”.`);
  $('#save-view-dialog').close();
  $('#save-view').focus();
});

$('#delete-view').addEventListener('click', () => {
  const view = savedViews.find((savedView) => savedView.id === currentSavedViewId);
  if (!view || !window.confirm(`Delete the saved view “${view.name}”?`)) return;
  const previousViews = savedViews;
  savedViews = savedViews.filter((savedView) => savedView.id !== view.id);
  if (!persistSavedViews()) {
    savedViews = previousViews;
    return;
  }
  currentSavedViewId = '';
  renderSavedViews();
  saveFilters();
  setSavedViewStatus(`Deleted “${view.name}”.`);
});

$('#clear-filters').addEventListener('click', () => {
  searchInput.value = '';
  for (const el of Object.values(filterEls)) el.value = '';
  mineCheckbox.checked = false;
  currentSavedViewId = '';
  renderSavedViews();
  loadItems().catch(showLoadError);
  searchInput.focus();
});

$('#show-attention').addEventListener('click', () => {
  attentionExpanded = !attentionExpanded;
  renderAttention();
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== searchInput && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) {
    e.preventDefault();
    searchInput.focus();
  } else if (e.key === 'Escape' && document.activeElement === searchInput) {
    searchInput.value = '';
    currentSavedViewId = '';
    renderSavedViews();
    loadItems().catch(showLoadError);
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
  loadSavedViews();
  renderSavedViews();
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
