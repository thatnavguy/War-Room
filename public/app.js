'use strict';

const $ = (sel) => document.querySelector(sel);
const isDiscovery = new URLSearchParams(location.search).get('room') === 'discovery';
const isInspection = new URLSearchParams(location.search).get('room') === 'inspection';
const COLUMN_DEFS = [
  { id: 'id', label: 'ID', required: true },
  { id: 'title', label: 'Title', required: true },
  { id: 'type', label: 'Type' },
  { id: 'state', label: 'State' },
  { id: 'assigned', label: 'Assigned to' },
  { id: 'project', label: 'Project' },
  { id: 'due', label: 'Due date' },
  { id: 'changed', label: 'Changed' },
  { id: 'priority', label: 'Priority level' },
];
const COLUMNS_STORAGE_KEY = isDiscovery ? 'mission-hall.discovery-columns'
  : isInspection ? 'mission-hall.inspection-columns' : 'mission-hall.work-columns';
const defaultColumns = () => COLUMN_DEFS.map(({ id }) => ({ id, visible: true }));
let columns = defaultColumns();

function columnCount() {
  return columns.filter((column) => column.visible).length + (isDiscovery ? 0 : 1);
}

function setColumnsStatus(message, error = false) {
  $('#columns-status').textContent = message;
  $('#columns-status').classList.toggle('status-error', error);
}

function loadColumns() {
  try {
    const stored = localStorage.getItem(COLUMNS_STORAGE_KEY);
    if (stored === null) return;
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed) || parsed.length !== COLUMN_DEFS.length ||
      new Set(parsed.map((column) => column?.id)).size !== COLUMN_DEFS.length ||
      parsed.some((column) => !column || typeof column.visible !== 'boolean' ||
        !COLUMN_DEFS.some((definition) => definition.id === column.id && (!definition.required || column.visible)))) {
      throw new Error('Invalid column layout.');
    }
    columns = parsed.map(({ id, visible }) => ({ id, visible }));
  } catch {
    setColumnsStatus('Could not read the saved columns. Showing defaults. Use Reset columns to replace the saved layout.', true);
  }
}

function applyColumns() {
  for (const row of [$('#results-head'), ...$('#results-body').children]) {
    const cells = [...row.children];
    for (const column of columns) {
      const cell = cells.find((candidate) => candidate.dataset.column === column.id);
      if (!cell) continue;
      cell.hidden = !column.visible;
      row.appendChild(cell);
    }
    const actions = cells.find((cell) => cell.className === 'work-actions' || cell.id === 'work-actions-heading');
    if (actions) row.appendChild(actions);
    const message = cells.find((cell) => cell.classList.contains('table-message'));
    if (message) message.colSpan = columnCount();
  }
}

function saveColumns(next, message) {
  try {
    localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    setColumnsStatus('Could not save columns in this browser. Check its storage settings and try again.', true);
    renderColumnOptions();
    return false;
  }
  columns = next;
  renderColumnOptions();
  applyColumns();
  setColumnsStatus(message);
  return true;
}

function renderColumnOptions(focusId, direction) {
  const list = $('#column-options');
  list.replaceChildren();
  columns.forEach((column, index) => {
    const definition = COLUMN_DEFS.find(({ id }) => id === column.id);
    const row = document.createElement('li');
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = column.visible;
    input.disabled = Boolean(definition.required);
    input.addEventListener('change', () => {
      saveColumns(columns.map((entry) => entry.id === column.id ? { ...entry, visible: input.checked } : entry),
        `${definition.label} ${input.checked ? 'shown' : 'hidden'}.`);
      $(`#column-options input[data-column="${column.id}"]`)?.focus({ preventScroll: true });
    });
    input.dataset.column = column.id;
    const text = document.createElement('span');
    text.textContent = definition.label + (definition.required ? ' (always visible)' : '');
    label.append(input, text);
    row.appendChild(label);
    for (const [step, name] of [[-1, 'up'], [1, 'down']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'column-move';
      button.textContent = name === 'up' ? 'Up' : 'Down';
      button.setAttribute('aria-label', `Move ${definition.label} ${name}`);
      button.dataset.column = column.id;
      button.dataset.direction = name;
      button.disabled = index + step < 0 || index + step >= columns.length;
      button.addEventListener('click', () => {
        const next = columns.map((entry) => ({ ...entry }));
        [next[index], next[index + step]] = [next[index + step], next[index]];
        if (saveColumns(next, `${definition.label} moved ${name}.`)) renderColumnOptions(column.id, name);
      });
      row.appendChild(button);
    }
    list.appendChild(row);
  });
  if (focusId) {
    const button = $(`#column-options button[data-column="${focusId}"][data-direction="${direction}"]`);
    const opposite = direction === 'up' ? 'down' : 'up';
    (button?.disabled ? $(`#column-options button[data-column="${focusId}"][data-direction="${opposite}"]`) : button)?.focus({ preventScroll: true });
  }
}

$('#reset-columns').addEventListener('click', () => saveColumns(defaultColumns(), 'Default columns restored.'));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('#columns-panel').open) {
    $('#columns-panel').open = false;
    $('#columns-panel summary').focus();
  }
});

const searchInput = $('#search');
const filterEls = {
  focus: $('#f-focus'),
  hidden: $('#f-hidden'),
  provider: $('#f-provider'),
  priority: $('#f-priority'),
  label: $('#f-label'),
  project: $('#f-project'),
};
const mineCheckbox = $('#f-mine');
if (isDiscovery) {
  delete filterEls.focus;
  delete filterEls.hidden;
}
const FILTER_STORAGE_KEY = isDiscovery ? 'mission-hall.discovery-filters'
  : isInspection ? 'mission-hall.inspection-filters' : 'mission-hall.work-filters';
const SAVED_VIEWS_KEY = isDiscovery ? 'mission-hall.saved-discovery-views'
  : isInspection ? 'mission-hall.saved-inspection-views' : 'mission-hall.saved-work-views';
const savedViewSelect = $('#saved-view-select');
const savedViewStatus = $('#saved-view-status');
const PRESET_VIEW_NAMES = isDiscovery ? [] : ['Daily digest', 'Needs attention'];
let savedViews = [];
let currentSavedViewId = '';

function allViews() {
  return savedViews;
}

function currentFilterValues() {
  const filters = { search: searchInput.value };
  for (const [key, el] of Object.entries(filterEls)) filters[key] = el.value;
  filters.mine = !isDiscovery && mineCheckbox.checked;
  return filters;
}

function applyFilterValues(filters) {
  searchInput.value = filters.search || '';
  for (const [key, el] of Object.entries(filterEls)) el.value = filters[key] || '';
  mineCheckbox.checked = !isDiscovery && Boolean(filters.mine);
}

function saveFilters() {
  const params = new URLSearchParams();
  params.set('search', searchInput.value);
  for (const [key, el] of Object.entries(filterEls)) {
    if (el.value) params.set(key, el.value);
  }
  if (!isDiscovery && mineCheckbox.checked) params.set('mine', '1');
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
  if (savedViews.length) {
    const savedGroup = document.createElement('optgroup');
    savedGroup.label = 'Your saved views';
    for (const view of savedViews) savedGroup.appendChild(new Option(view.name, view.id));
    savedViewSelect.appendChild(savedGroup);
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
let providers = [];
let staleDays = 14;
let currentItems = [];
let itemsRequest = 0;

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
  const res = await fetch(isDiscovery ? '/api/sync/status'
    : isInspection ? '/api/summary?room=inspection' : '/api/summary');
  const s = await res.json();
  if (!res.ok) throw new Error(s.error || 'Could not load the work summary.');
  $('#last-sync').textContent = s.lastSync
    ? `Last synced ${new Date(s.lastSync).toLocaleString()}`
    : 'Never synced';
  $('#rail-connection').textContent = `${providers.filter((provider) => provider.configured).map((provider) => provider.label).join(', ') || 'No connected sources'} · local tracking`;
  if (isDiscovery) return;
  $('#card-open').textContent = s.open;
  $('#card-recent').textContent = s.recentlyUpdated;
  $('#card-stale').textContent = s.stale;
  $('#card-stale-button').classList.toggle('has-attention', s.stale > 0);
  $('#card-stale-label').textContent = `assigned to you, unchanged for ${s.staleDays}+ days`;
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
  const res = await fetch(isDiscovery ? '/api/filters?room=discovery'
    : isInspection ? '/api/filters?room=inspection' : '/api/filters');
  const f = await res.json();
  if (!res.ok) throw new Error(f.error || 'Could not load work filters.');
  fill(filterEls.project, f.projects, 'All projects');
  fill(filterEls.priority, f.priorities, 'All priority levels');
  fill(filterEls.label, f.labels, 'All labels');
  filterEls.provider.replaceChildren(new Option('All sources', ''));
  for (const provider of providers) {
    filterEls.provider.appendChild(new Option(provider.label, provider.id));
  }
  $('#provider-filter').hidden = isInspection || providers.length < 2;
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

function itemHref(id) {
  const room = isDiscovery ? 'discovery' : isInspection ? 'inspection' : '';
  return `/item.html?id=${id}${room ? `&room=${room}` : ''}`;
}

async function loadItems(append = false) {
  const request = ++itemsRequest;
  saveFilters();
  const params = new URLSearchParams();
  if (isDiscovery) params.set('room', 'discovery');
  else if (isInspection) params.set('room', 'inspection');
  if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
  for (const [key, el] of Object.entries(filterEls)) {
    if (el.value) params.set(key, el.value);
  }
  if (!isDiscovery && mineCheckbox.checked) params.set('mine', '1');
  if (isDiscovery && append) params.set('offset', currentItems.length);
  const res = await fetch('/api/items?' + params);
  const data = await res.json();
  if (request !== itemsRequest) return;
  if (!res.ok) throw new Error(data.error || 'Could not load work items.');
  currentItems = append ? [...currentItems, ...data.items] : data.items;
  $('#result-count').textContent = isDiscovery
    ? `${currentItems.length.toLocaleString()} of ${data.total.toLocaleString()} ${data.total === 1 ? 'item' : 'items'}`
    : `${data.total.toLocaleString()} ${data.total === 1 ? 'item' : 'items'}`;
  $('#load-more').hidden = !isDiscovery || currentItems.length >= data.total;

  const tbody = $('#results-body');
  tbody.replaceChildren();
  if (currentItems.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'table-message';
    cell.colSpan = columnCount();
    cell.textContent = isDiscovery
      ? 'No recent, open items without your involvement match these filters. Clear filters or change the discovery window in Settings. Discovery uses only items already stored on this computer.'
      : isInspection ? 'No tracked GitHub pull requests match these filters.'
      : data.total === 0 ? 'No work items match these filters.' : 'No items to show.';
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  for (const item of currentItems) {
    const tr = document.createElement('tr');
    tr.className = 'work-row';
    tr.dataset.id = item.id;
    if (!item.is_closed && staleCutoff && item.changed_date && new Date(item.changed_date) < staleCutoff) {
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
      td.dataset.column = COLUMN_DEFS[i].id;
      if (cell.kind === 'id') {
        td.className = 'id-cell';
        const a = document.createElement('a');
        a.href = itemHref(item.id);
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
        a.href = itemHref(item.id);
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
        const status = item.is_closed ? '' : dueDateStatus(cell.value);
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
      : restoring ? 'Restore to Briefing Room' : 'Hide from Briefing Room';
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
    if (!item.is_closed) actions.appendChild(visibilityButton);
    if (!isDiscovery) tr.appendChild(actions);

    tr.addEventListener('click', (e) => {
      if (!e.target.closest('a, button')) location.href = itemHref(item.id);
    });
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') location.href = itemHref(item.id);
    });
    tbody.appendChild(tr);
  }
  applyColumns();
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

const debouncedLoad = debounce(() => loadItems().catch(showLoadError), 200);
searchInput.addEventListener('input', () => {
  currentSavedViewId = '';
  renderSavedViews();
  saveFilters();
  debouncedLoad();
});
function onFilterChange(event) {
  if (!isDiscovery) {
    if (event?.target === filterEls.hidden && filterEls.hidden.value === 'closed') filterEls.focus.value = '';
    if (event?.target === filterEls.focus && filterEls.focus.value && filterEls.hidden.value === 'closed') filterEls.hidden.value = '';
  }
  currentSavedViewId = '';
  renderSavedViews();
  loadItems().catch(showLoadError);
}
for (const el of Object.values(filterEls)) el.addEventListener('change', onFilterChange);
mineCheckbox.addEventListener('change', onFilterChange);

function applyView(view) {
  currentSavedViewId = view.id;
  applyFilterValues(view.filters);
  renderSavedViews();
  loadItems().catch(showLoadError);
}

savedViewSelect.addEventListener('change', () => {
  const view = allViews().find((savedView) => savedView.id === savedViewSelect.value);
  if (!view) {
    currentSavedViewId = '';
    renderSavedViews();
    saveFilters();
    setSavedViewStatus('');
    return;
  }
  applyView(view);
});

$('#card-stale-button').addEventListener('click', () => {
  const focusFilter = filterEls.focus;
  if (!focusFilter) return;
  focusFilter.value = 'attention';
  onFilterChange({ target: focusFilter });
  focusFilter.focus({ preventScroll: true });
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
  if (PRESET_VIEW_NAMES.some((presetName) => presetName.toLocaleLowerCase() === name.toLocaleLowerCase()) ||
    allViews().some((view) => view.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
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
  cell.colSpan = columnCount();
  cell.textContent = message;
  row.appendChild(cell);
  tableBody.appendChild(row);
  $('#load-more').hidden = true;
}

$('#load-more').addEventListener('click', async () => {
  const button = $('#load-more');
  button.disabled = true;
  button.textContent = 'Loading…';
  try {
    await loadItems(true);
  } catch (error) {
    showLoadError(error);
  } finally {
    button.disabled = false;
    button.textContent = 'Load more items';
  }
});

$('#sync-btn').addEventListener('click', async () => {
  const btn = $('#sync-btn');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Syncing…';
  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const stats = await res.json();
    if (!res.ok) throw new Error(stats.error || 'Sync failed');
    if (stats.errors && stats.errors.length > 0) {
      throw new Error(`Sync completed with ${stats.errors.length} issue${stats.errors.length === 1 ? '' : 's'}: ${stats.errors.join('; ')}`);
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
  loadColumns();
  renderColumnOptions();
  applyColumns();
  if (isDiscovery) {
    document.title = 'Discovery Room — War Room';
    $('#page-title').textContent = 'Discovery Room';
    $('#room-breadcrumb').textContent = 'Discovery Room';
    $('#work-title').textContent = 'Work you haven’t been involved in';
    $('#nav-briefing').classList.remove('is-active');
    $('#nav-briefing').removeAttribute('aria-current');
    $('#nav-discovery').classList.add('is-active');
    $('#nav-discovery').setAttribute('aria-current', 'page');
    for (const selector of ['#work-summary', '#focus-filter', '#visibility-filter', '#mine-filter', '#work-actions-heading']) {
      $(selector).hidden = true;
    }
  } else if (isInspection) {
    document.title = 'Inspection Room — War Room';
    $('#page-title').textContent = 'Inspection Room';
    $('#room-breadcrumb').textContent = 'Inspection Room';
    $('#work-title').textContent = 'Tracked pull requests';
    $('#nav-briefing').classList.remove('is-active');
    $('#nav-briefing').removeAttribute('aria-current');
    $('#nav-inspection').classList.add('is-active');
    $('#nav-inspection').setAttribute('aria-current', 'page');
    $('#page-intro').textContent = 'GitHub pull requests you have touched, kept separate from your other work.';
  }
  loadSavedViews();
  renderSavedViews();
  const providerRes = await fetch('/api/providers');
  const providerData = await providerRes.json();
  if (!providerRes.ok) throw new Error(providerData.error || 'Could not load work sources.');
  providers = providerData.providers;
  const configRes = await fetch('/api/config');
  const cfg = await configRes.json();
  if (!configRes.ok) throw new Error(cfg.error || 'Could not check your work connections.');
  if (isDiscovery) {
    $('#page-intro').textContent = `Open items updated in the last ${cfg.discoveryDays} days, with no recorded assignment, creation, edit, comment, or mention involving you.`;
  }
  if (!cfg.configured) {
    $('#unconfigured').hidden = false;
    $('#sync-btn').disabled = true;
    $('#rail-connection').textContent = 'Not connected';
    if (isDiscovery) {
      await loadSummary();
      await loadFilters();
      await loadItems();
      return;
    }
    const tbody = $('#results-body');
    tbody.replaceChildren();
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'table-message';
    cell.colSpan = columnCount();
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
