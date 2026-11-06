'use strict';

const $ = (sel) => document.querySelector(sel);

const searchInput = $('#search');
const filterEls = {
  focus: $('#f-focus'),
  hidden: $('#f-hidden'),
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
const PRESET_VIEWS = [
  { id: 'preset:daily-digest', name: 'Daily digest', filters: { focus: 'digest' } },
  { id: 'preset:needs-attention', name: 'Needs attention', filters: { focus: 'attention' } },
];
let savedViews = [];
let currentSavedViewId = '';

function allViews() {
  return [...PRESET_VIEWS, ...savedViews];
}

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
  currentSavedViewId = allViews().some((view) => view.id === savedViewId) ? savedViewId : '';
}

function renderSavedViews() {
  savedViewSelect.replaceChildren(new Option('Choose a view', ''));
  const presetGroup = document.createElement('optgroup');
  presetGroup.label = 'Preset views';
  for (const view of PRESET_VIEWS) presetGroup.appendChild(new Option(view.name, view.id));
  savedViewSelect.appendChild(presetGroup);
  if (savedViews.length) {
    const savedGroup = document.createElement('optgroup');
    savedGroup.label = 'Your saved views';
    for (const view of savedViews) savedGroup.appendChild(new Option(view.name, view.id));
    savedViewSelect.appendChild(savedGroup);
  }
  savedViewSelect.value = currentSavedViewId;
  $('#delete-view').disabled = !currentSavedViewId || currentSavedViewId.startsWith('preset:');
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
let providers = [];
let staleDays = 14;
let currentItems = [];

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
    cell.colSpan = 10;
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
    if (item.my_display_name && item.assigned_to === item.my_display_name) {
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
        if (item.url && /^https?:\/\//i.test(item.url)) {
          const source = document.createElement('a');
          source.className = 'work-source-link';
          source.href = item.url;
          source.target = '_blank';
          source.rel = 'noopener noreferrer';
          source.title = `Open in ${item.provider_label} (new tab)`;
          source.setAttribute('aria-label', `Open work item ${item.external_id} in ${item.provider_label} (new tab)`);
          const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          icon.setAttribute('viewBox', '0 0 20 20');
          icon.setAttribute('fill', 'none');
          icon.setAttribute('aria-hidden', 'true');
          const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          shape.setAttribute('d', 'M11 3h6v6m0-6-9 9M8 4H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-4');
          shape.setAttribute('stroke', 'currentColor');
          shape.setAttribute('stroke-width', '1.5');
          shape.setAttribute('stroke-linecap', 'round');
          shape.setAttribute('stroke-linejoin', 'round');
          icon.appendChild(shape);
          source.appendChild(icon);
          source.addEventListener('keydown', (event) => event.stopPropagation());
          td.appendChild(source);
        }
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

    const actions = document.createElement('td');
    actions.className = 'work-actions';
    const visibilityButton = document.createElement('button');
    visibilityButton.className = 'work-visibility-button';
    visibilityButton.type = 'button';
    const restoring = Boolean(item.is_hidden);
    const protectedItem = !restoring && Boolean(item.visibility_required);
    const explanation = protectedItem
      ? 'Keep visible: assigned to you or the latest comment @mentions you.'
      : restoring ? 'Restore to My work' : 'Hide from My work';
    visibilityButton.title = explanation;
    visibilityButton.setAttribute('aria-label', `${restoring ? 'Restore' : 'Hide'} work item ${item.external_id}${protectedItem ? `. ${explanation}` : ''}`);
    visibilityButton.setAttribute('aria-disabled', String(protectedItem));
    if (restoring) {
      visibilityButton.textContent = 'Restore';
    } else {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 20 20');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M3 3l14 14M7.5 4.5A9 9 0 0 1 10 4c4 0 7 6 7 6a15 15 0 0 1-2 2.8M12 15.5a9 9 0 0 1-2 .5c-4 0-7-6-7-6a15 15 0 0 1 2-2.8M8 8a2.8 2.8 0 0 0 4 4');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      visibilityButton.appendChild(svg);
    }
    visibilityButton.addEventListener('keydown', (event) => event.stopPropagation());
    visibilityButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (protectedItem) return;
      changeVisibility(item, !restoring, visibilityButton);
    });
    actions.appendChild(visibilityButton);
    tr.appendChild(actions);

    tr.addEventListener('click', (e) => {
      if (!e.target.closest('a, button')) location.href = `/item.html?id=${item.id}`;
    });
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') location.href = `/item.html?id=${item.id}`;
    });
    tbody.appendChild(tr);
  }
}

async function changeVisibility(item, hidden, button) {
  button.disabled = true;
  const status = $('#visibility-status');
  try {
    const response = await fetch(`/api/items/${item.id}/visibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden }),
    });
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error(response.status === 404
        ? 'Restart the dashboard to enable Hide and Restore, then sync once.'
        : `Could not change item visibility (HTTP ${response.status}). Try again.`);
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not change item visibility.');
    status.classList.remove('inline-error');
    status.textContent = hidden ? `Work item ${item.external_id} hidden.` : `Work item ${item.external_id} restored.`;
    if (hidden) {
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'text-button visibility-undo';
      undo.textContent = 'Undo';
      undo.addEventListener('click', () => changeVisibility(item, false, undo));
      status.appendChild(undo);
    }
    await loadSummary();
    await loadItems();
    if (hidden) status.querySelector('button')?.focus({ preventScroll: true });
    else $('#f-hidden').focus({ preventScroll: true });
  } catch (error) {
    status.textContent = error.message || 'Could not change item visibility. Try again.';
    status.classList.add('inline-error');
    button.disabled = false;
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

function applyView(view) {
  currentSavedViewId = view.id;
  applyFilterValues(view.filters);
  setSavedViewStatus(`Showing “${view.name}”.`);
  renderSavedViews();
  loadItems().catch(showLoadError);
}

savedViewSelect.addEventListener('change', () => {
  const view = allViews().find((savedView) => savedView.id === savedViewSelect.value);
  if (!view) {
    currentSavedViewId = '';
    renderSavedViews();
    saveFilters();
    setSavedViewStatus('Using current filters.');
    return;
  }
  applyView(view);
});

$('#card-stale-button').addEventListener('click', () => {
  applyView(PRESET_VIEWS.find((view) => view.id === 'preset:needs-attention'));
  $('#f-focus').focus({ preventScroll: true });
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
  if (allViews().some((view) => view.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    error.textContent = 'A view with that name already exists.';
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
  const tableBody = $('#results-body');
  tableBody.replaceChildren();
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.className = 'table-message table-error';
  cell.colSpan = 10;
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
    await loadItems();
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
    const tbody = $('#results-body');
    tbody.replaceChildren();
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'table-message';
    cell.colSpan = 10;
    cell.textContent = 'Connect a work source to see your work.';
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }
  await loadSummary();
  await loadFilters();
  await loadItems();
}

init().catch(showLoadError);
