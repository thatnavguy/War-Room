'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
  .replace('init().catch(showLoadError);', '');
const dashboardHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function dashboard(fetch, search = '') {
  function element() {
    const classes = new Set();
    return {
      dataset: {},
      value: '',
      checked: false,
      hidden: false,
      disabled: false,
      colSpan: 1,
      textContent: '',
      label: '',
      children: [],
      attributes: {},
      listeners: {},
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); },
        toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
      },
      querySelector() { return this.children.find((child) => child.type === 'button'); },
      focus(options) { this.focusOptions = options; },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      replaceChildren(...children) { this.children = children; },
      appendChild(child) {
        this.children = this.children.filter((entry) => entry !== child);
        this.children.push(child);
      },
      append(...children) { this.children.push(...children); },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
    };
  }
  const elements = new Map();
  const sessionValues = new Map();
  const localValues = new Map();
  const context = vm.createContext({
    document: {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
      },
      createElement: element,
      createElementNS: element,
      addEventListener() {},
    },
    Option: class Option {
      constructor(text, value) {
        this.text = text;
        this.textContent = text;
        this.value = value;
      }
    },
    fetch,
    location: { search },
    URLSearchParams,
    sessionStorage: {
      getItem: (key) => sessionValues.get(key) ?? null,
      setItem: (key, value) => sessionValues.set(key, value),
    },
    localStorage: {
      getItem: (key) => localValues.get(key) ?? null,
      setItem: (key, value) => localValues.set(key, value),
    },
  });
  vm.runInContext(source, context);
  return {
    elements,
    evaluate: (script) => vm.runInContext(script, context),
    flush: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

for (const hidden of [true, false]) {
  test(`${hidden ? 'Hide' : 'Restore'} moves focus without scrolling after refreshing the list`, async () => {
    const page = dashboard(async () => ({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ hidden }),
    }));
    page.evaluate(`
      const refreshed = [];
      loadSummary = async () => refreshed.push('summary');
      loadItems = async () => refreshed.push('items');
    `);
    await page.evaluate(`changeVisibility({ id: 1, external_id: 123 }, ${hidden}, document.createElement('button'))`);
    const focusTarget = hidden
      ? page.elements.get('#visibility-status').children[0]
      : page.elements.get('#f-hidden');
    assert.equal(focusTarget.focusOptions.preventScroll, true);
    assert.equal(page.evaluate("refreshed.join(',')"), 'summary,items');
    assert.match(page.elements.get('#visibility-status').textContent, hidden ? /hidden/ : /restored/);
  });
}

for (const errors of [['GitHub: request failed 422'], ['GitHub: request failed 403', 'Azure DevOps: request failed 401']]) {
  test(`sync displays the actual details for ${errors.length} reported issues`, async () => {
    const page = dashboard(async () => ({ ok: true, json: async () => ({ errors }) }));
    page.evaluate(`$('#sync-btn').appendChild({ type: 'button', textContent: 'Sync now' });`);
    await page.elements.get('#sync-btn').listeners.click();
    const message = page.elements.get('#results-body').children[0].children[0].textContent;
    assert.equal(message, `Sync completed with ${errors.length} issue${errors.length === 1 ? '' : 's'}: ${errors.join('; ')}`);
    assert.equal(page.elements.get('#sync-btn').disabled, false);
    assert.equal(page.elements.get('#sync-btn').children[0].textContent, 'Sync now');
  });
}

test('work-list type and state stay visible while their filters are absent', async () => {
  assert.doesNotMatch(dashboardHtml, /id="f-state"/);
  assert.doesNotMatch(dashboardHtml, /id="f-type"/);
  assert.match(dashboardHtml, /data-column="state">State<\/th>/);
  assert.match(dashboardHtml, /data-column="type">Type<\/th>/);
  const requests = [];
  const page = dashboard(async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ items: [], total: 0 }) };
  });
  page.evaluate(`applyFilterValues({ state: 'Active', type: 'Bug' }); loadItems();`);
  await page.flush();
  assert.equal(requests[0], '/api/items?');
  assert.equal(page.elements.has('#f-state'), false);
  assert.equal(page.elements.has('#f-type'), false);
});

test('old session filters and saved views no longer apply type, state, iteration, or date constraints', async () => {
  const requests = [];
  const page = dashboard(async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ items: [], total: 0 }) };
  });
  page.evaluate(`sessionStorage.setItem(FILTER_STORAGE_KEY, 'project=Example&type=Bug&state=Active&iteration=Sprint&from=2026-01-01&to=2026-01-31'); restoreFilters();`);
  assert.equal(page.elements.get('#f-project').value, 'Example');
  await page.evaluate('loadItems()');
  assert.equal(requests[0], '/api/items?project=Example');
  assert.doesNotMatch(page.evaluate('sessionStorage.getItem(FILTER_STORAGE_KEY)'), /type=|state=|iteration=|from=|to=/);
  page.evaluate(`applyFilterValues({ project: 'Another', type: 'Bug', state: 'Active', iteration: 'Sprint', from: '2026-01-01', to: '2026-01-31' });`);
  await page.evaluate('loadItems()');
  assert.equal(requests[1], '/api/items?project=Another');
});

test('due dates highlight today and overdue by local calendar day, but not future or missing dates', () => {
  const page = dashboard();
  const classify = (date, today) => page.evaluate(`dueDateStatus(${JSON.stringify(date)}, new Date(${JSON.stringify(today)}))`);
  assert.equal(classify('2026-11-06T23:59:59', '2026-11-06T00:00:01'), 'Due today');
  assert.equal(classify('2026-11-05T23:59:59', '2026-11-06T00:00:01'), 'Overdue');
  assert.equal(classify('2026-11-07T00:00:00', '2026-11-06T23:59:59'), '');
  assert.equal(classify(null, '2026-11-06'), '');
  assert.equal(classify('not a date', '2026-11-06'), '');
});

test('closed visibility and open-work focus filters switch without conflicting', async () => {
  const requests = [];
  const page = dashboard(async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ items: [], total: 0 }) };
  });
  const focus = page.elements.get('#f-focus');
  const visibility = page.elements.get('#f-hidden');
  focus.value = 'attention';
  visibility.value = 'closed';
  visibility.listeners.change({ target: visibility });
  await page.flush();
  assert.equal(focus.value, '');
  assert.equal(requests.at(-1), '/api/items?hidden=closed');
  focus.value = 'digest';
  focus.listeners.change({ target: focus });
  await page.flush();
  assert.equal(visibility.value, '');
  assert.equal(requests.at(-1), '/api/items?focus=digest');
});

test('focus filter provides presets and saved-view selector lists only user views', async () => {
  const requests = [];
  const page = dashboard(async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ items: [], total: 0 }) };
  });
  page.evaluate(`savedViews = [{ id: 'saved:example', name: 'My view', filters: { project: 'Example' } }];`);
  page.evaluate('renderSavedViews()');
  const select = page.elements.get('#saved-view-select');
  const savedGroup = select.children.find((child) => child.label === 'Your saved views');
  assert.deepEqual(savedGroup.children.map((option) => option.textContent), ['My view']);
  const savedViewMarkup = dashboardHtml.match(/<select id="saved-view-select"[\s\S]*?<\/select>/)[0];
  assert.doesNotMatch(savedViewMarkup, /Daily digest|Needs attention/);
  assert.match(dashboardHtml, /<option value="digest">Daily digest<\/option>/);
  assert.match(dashboardHtml, /<option value="attention">Needs attention<\/option>/);
  assert.equal(page.elements.get('#delete-view').disabled, true);

  page.elements.get('#f-focus').value = 'digest';
  page.elements.get('#f-focus').listeners.change({ target: page.elements.get('#f-focus') });
  await page.flush();
  assert.equal(page.elements.get('#f-focus').value, 'digest');
  assert.equal(requests.at(-1), '/api/items?focus=digest');

  select.value = 'saved:example';
  select.listeners.change();
  await page.flush();
  assert.equal(requests.at(-1), '/api/items?project=Example');
  assert.equal(page.elements.get('#delete-view').disabled, false);
  assert.equal(page.elements.get('#saved-view-status').textContent, '');

  select.value = '';
  select.listeners.change();
  assert.equal(page.elements.get('#saved-view-status').textContent, '');
  assert.equal(page.elements.get('#f-focus').value, '');

  page.elements.get('#f-project').value = 'Example';
  page.elements.get('#f-project').listeners.change();
  await page.flush();
  assert.equal(page.evaluate('currentSavedViewId'), '');
  assert.equal(requests.at(-1), '/api/items?project=Example');
});

test('the stale summary count selects the Focus needs attention filter', async () => {
  const requests = [];
  const page = dashboard(async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ items: [], total: 0 }) };
  });
  page.elements.get('#f-project').value = 'Example';
  page.elements.get('#card-stale-button').listeners.click();
  await page.flush();
  assert.equal(requests.at(-1), '/api/items?focus=attention&project=Example');
  assert.equal(page.elements.get('#f-focus').value, 'attention');
  assert.equal(page.elements.get('#f-focus').focusOptions.preventScroll, true);
  assert.equal(page.evaluate('currentSavedViewId'), '');
});

test('saved views cannot reuse a preset view name', () => {
  const page = dashboard();
  page.evaluate(`$('#saved-view-name').value = 'daily digest';`);
  page.elements.get('#save-view-form').listeners.submit({ preventDefault() {} });
  assert.match(page.elements.get('#saved-view-error').textContent, /already exists/);
  assert.equal(page.elements.get('#saved-view-error').hidden, false);
});

test('legacy preset session state restores its Focus filter without selecting a saved view', () => {
  const page = dashboard(async () => ({ ok: true, json: async () => ({ items: [], total: 0 }) }));
  page.evaluate(`sessionStorage.setItem(FILTER_STORAGE_KEY, 'focus=digest&savedView=preset:daily-digest'); restoreFilters();`);
  assert.equal(page.elements.get('#f-focus').value, 'digest');
  assert.equal(page.evaluate('currentSavedViewId'), '');
  page.evaluate(`sessionStorage.setItem(FILTER_STORAGE_KEY, 'savedView=preset:unknown'); restoreFilters();`);
  assert.equal(page.evaluate('currentSavedViewId'), '');
});

test('Discovery Room uses local room-specific requests, navigation, and filter storage', async () => {
  const requests = [];
  const page = dashboard(async (url) => {
    requests.push(url);
    const responses = {
      '/api/providers': { providers: [{ id: 'azure-devops', label: 'Azure DevOps', configured: true }] },
      '/api/config': { configured: true, discoveryDays: 30 },
      '/api/sync/status': { lastSync: null },
      '/api/filters?room=discovery': { projects: ['Untouched project'], types: [], states: [], priorities: [], labels: [] },
      '/api/items?room=discovery': { items: [], total: 0 },
    };
    assert.ok(Object.hasOwn(responses, url), `Unexpected request: ${url}`);
    return { ok: true, json: async () => responses[url] };
  }, '?room=discovery');
  await page.evaluate('init()');
  assert.equal(page.elements.get('#page-title').textContent, 'Discovery Room');
  assert.match(page.elements.get('#page-intro').textContent, /last 30 days/);
  assert.equal(page.elements.get('#nav-discovery').attributes['aria-current'], 'page');
  for (const selector of ['#work-summary', '#focus-filter', '#visibility-filter', '#mine-filter', '#work-actions-heading']) {
    assert.equal(page.elements.get(selector).hidden, true, selector);
  }
  assert.equal(page.elements.get('#saved-view-select').children.length, 1);
  assert.equal(page.evaluate('FILTER_STORAGE_KEY'), 'mission-hall.discovery-filters');
  assert.equal(page.evaluate('SAVED_VIEWS_KEY'), 'mission-hall.saved-discovery-views');
  assert.equal(page.evaluate('itemHref(42)'), '/item.html?id=42&room=discovery');
  assert.equal(requests.some((url) => url === '/api/summary' || url === '/api/sync'), false);
  assert.match(page.elements.get('#results-body').children[0].children[0].textContent, /already stored/);
  page.evaluate(`applyFilterValues({ mine: true, focus: 'digest', hidden: 'closed' });`);
  assert.equal(page.elements.get('#f-mine').checked, false);
});

test('Inspection Room uses pull-request scoped requests and separate preferences', async () => {
  const requests = [];
  const page = dashboard(async (url) => {
    requests.push(url);
    const responses = {
      '/api/providers': { providers: [{ id: 'github', label: 'GitHub', configured: true }] },
      '/api/config': { configured: true },
      '/api/summary?room=inspection': {
        open: 1, recentlyUpdated: 1, stale: 0, staleDays: 30,
        byState: [], byType: [], byProject: [], byIteration: [],
      },
      '/api/filters?room=inspection': { projects: ['Pull requests'], priorities: [], labels: [] },
      '/api/items?room=inspection': { items: [], total: 0 },
    };
    assert.ok(Object.hasOwn(responses, url), `Unexpected request: ${url}`);
    return { ok: true, json: async () => responses[url] };
  }, '?room=inspection');
  await page.evaluate('init()');
  assert.equal(page.elements.get('#page-title').textContent, 'Inspection Room');
  assert.equal(page.elements.get('#work-title').textContent, 'Tracked pull requests');
  assert.equal(page.elements.get('#nav-inspection').attributes['aria-current'], 'page');
  assert.equal(page.evaluate('FILTER_STORAGE_KEY'), 'mission-hall.inspection-filters');
  assert.equal(page.evaluate('SAVED_VIEWS_KEY'), 'mission-hall.saved-inspection-views');
  assert.equal(page.evaluate('COLUMNS_STORAGE_KEY'), 'mission-hall.inspection-columns');
  assert.equal(page.evaluate('itemHref(42)'), '/item.html?id=42&room=inspection');
  assert.ok(requests.includes('/api/summary?room=inspection'));
  assert.ok(requests.includes('/api/filters?room=inspection'));
  assert.ok(requests.includes('/api/items?room=inspection'));
  assert.equal(page.elements.get('#results-body').children[0].children[0].textContent,
    'No tracked GitHub pull requests match these filters.');
});

test('Discovery Room renders item links without hide actions and loads further results', async () => {
  const requests = [];
  const item = (id) => ({
    id, external_id: String(id), title: `Task ${id}`, provider_label: 'Azure DevOps',
    type: 'Task', state: 'Active', is_closed: false,
  });
  const page = dashboard(async (url) => {
    requests.push(url);
    return {
      ok: true,
      json: async () => ({ items: [item(url.includes('offset=') ? 2 : 1)], total: 2 }),
    };
  }, '?room=discovery');
  await page.evaluate('loadItems()');
  assert.equal(page.elements.get('#load-more').hidden, false);
  let rows = page.elements.get('#results-body').children;
  assert.equal(rows[0].children.length, 9);
  assert.equal(rows[0].children[0].children[0].href, '/item.html?id=1&room=discovery');
  await page.elements.get('#load-more').listeners.click();
  assert.equal(requests.at(-1), '/api/items?room=discovery&offset=1');
  rows = page.elements.get('#results-body').children;
  assert.equal(rows.length, 2);
  assert.equal(page.elements.get('#load-more').hidden, true);
  assert.equal(page.elements.get('#result-count').textContent, '2 of 2 items');
  await page.evaluate('loadItems()');
  assert.equal(requests.at(-1), '/api/items?room=discovery');
  assert.equal(page.elements.get('#results-body').children.length, 1);
});

test('a late discovery response cannot overwrite a newer set of filters', async () => {
  const pending = [];
  const page = dashboard(() => new Promise((resolve) => pending.push(resolve)), '?room=discovery');
  const first = page.evaluate('loadItems()');
  page.evaluate(`$('#search').value = 'new query'`);
  const second = page.evaluate('loadItems()');
  pending[1]({ ok: true, json: async () => ({ items: [], total: 0 }) });
  await second;
  pending[0]({ ok: true, json: async () => ({ items: [], total: 100 }) });
  await first;
  assert.equal(page.elements.get('#result-count').textContent, '0 of 0 items');
});

for (const room of ['', '?room=discovery']) {
  test(`column layout persists visibility and order independently for ${room || 'briefing'}`, async () => {
    const page = dashboard(async () => ({
      ok: true, json: async () => ({
        items: [{ id: 1, external_id: '1', title: 'Example', type: 'Task', state: 'New' }], total: 1,
      }),
    }), room);
    page.evaluate(`
      for (const column of COLUMN_DEFS) {
        const heading = document.createElement('th');
        heading.dataset.column = column.id;
        $('#results-head').appendChild(heading);
      }
      renderColumnOptions();
    `);
    assert.equal(page.elements.get('#column-options').children.length, 9);
    await page.evaluate('loadItems()');
    page.evaluate(`
      const next = defaultColumns();
      next.find(column => column.id === 'type').visible = false;
      next.unshift(next.pop());
      saveColumns(next, 'Updated');
    `);
    const rows = page.elements.get('#results-body').children;
    assert.equal(rows[0].children[0].dataset.column, 'priority');
    assert.equal(rows[0].children.find((cell) => cell.dataset.column === 'id').colSpan, 1);
    assert.equal(rows[0].children.find((cell) => cell.dataset.column === 'type').hidden, true);
    assert.equal(page.elements.get('#results-head').children[0].dataset.column, 'priority');
    const key = room ? 'mission-hall.discovery-columns' : 'mission-hall.work-columns';
    assert.equal(page.evaluate('COLUMNS_STORAGE_KEY'), key);
    page.evaluate('columns = defaultColumns(); loadColumns();');
    assert.equal(page.evaluate('columns[0].id'), 'priority');
    assert.equal(page.evaluate('columns.find(column => column.id === "type").visible'), false);
    page.elements.get('#reset-columns').listeners.click();
    assert.equal(rows[0].children[0].dataset.column, 'id');
    assert.equal(rows[0].children.find((cell) => cell.dataset.column === 'type').hidden, false);
    const required = page.elements.get('#column-options').children.slice(0, 2);
    assert.equal(required.every((row) => row.children[0].children[0].disabled), true);
  });
}

test('invalid saved columns report an error and retain defaults', () => {
  const page = dashboard();
  for (const stored of ['broken', '[null]', JSON.stringify([
    { id: 'id', visible: false }, { id: 'title', visible: true },
  ])]) {
    page.evaluate(`localStorage.setItem(COLUMNS_STORAGE_KEY, ${JSON.stringify(stored)}); loadColumns();`);
    assert.equal(page.evaluate('columns.length'), 9);
    assert.equal(page.evaluate('columns.every(column => column.visible)'), true);
    assert.match(page.elements.get('#columns-status').textContent, /Could not read/);
  }
});

test('failed column persistence leaves the displayed layout unchanged', () => {
  const page = dashboard();
  page.evaluate(`
    localStorage.setItem = () => { throw new Error('Storage disabled'); };
    const next = defaultColumns();
    next[2].visible = false;
    saveColumns(next, 'Updated');
  `);
  assert.equal(page.evaluate('columns[2].visible'), true);
  assert.match(page.elements.get('#columns-status').textContent, /Could not save/);
});

test('column controls move columns and preserve required visibility', () => {
  const page = dashboard();
  page.evaluate('renderColumnOptions()');
  const first = page.elements.get('#column-options').children[0];
  assert.equal(first.children[1].disabled, true);
  assert.equal(first.children[2].disabled, false);
  first.children[2].listeners.click();
  assert.equal(page.evaluate('columns[1].id'), 'id');
  assert.equal(page.evaluate('columns[1].visible'), true);
  assert.match(page.elements.get('#columns-status').textContent, /ID moved down/);
});

test('unconfigured connection prompt respects saved hidden columns', async () => {
  const page = dashboard(async (url) => ({
    ok: true,
    json: async () => url === '/api/providers' ? { providers: [] } : { configured: false },
  }));
  page.evaluate(`
    const saved = defaultColumns();
    saved.find(column => column.id === 'type').visible = false;
    localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(saved));
  `);
  await page.evaluate('init()');
  const message = page.elements.get('#results-body').children[0].children[0];
  assert.equal(message.colSpan, 9);
  assert.equal(message.textContent, 'Connect a work source to see your work.');
});
