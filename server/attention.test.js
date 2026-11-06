'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
  .replace('init().catch(showLoadError);', '');

function dashboard(fetch) {
  function element() {
    return {
      value: '',
      checked: false,
      hidden: false,
      textContent: '',
      children: [],
      attributes: {},
      listeners: {},
      classList: {
        add() {},
        remove() {},
      },
      querySelector() { return this.children.find((child) => child.type === 'button'); },
      focus(options) { this.focusOptions = options; },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      replaceChildren(...children) { this.children = children; },
      appendChild(child) { this.children.push(child); },
      append(...children) { this.children.push(...children); },
      setAttribute(name, value) { this.attributes[name] = value; },
    };
  }
  const elements = new Map();
  const sessionValues = new Map();
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
    fetch,
    URLSearchParams,
    sessionStorage: {
      getItem: (key) => sessionValues.get(key) ?? null,
      setItem: (key, value) => sessionValues.set(key, value),
    },
  });
  vm.runInContext(source, context);
  vm.runInContext("staleCutoff = new Date('2026-10-01T00:00:00Z');", context);
  return {
    elements,
    load: () => vm.runInContext('loadAttention()', context),
    toggle: () => elements.get('#show-attention').listeners.click(),
    evaluate: (script) => vm.runInContext(script, context),
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
      loadAttention = async () => refreshed.push('attention');
    `);
    await page.evaluate(`changeVisibility({ id: 1, external_id: 123 }, ${hidden}, document.createElement('button'))`);
    const focusTarget = hidden
      ? page.elements.get('#visibility-status').children[0]
      : page.elements.get('#f-hidden');
    assert.equal(focusTarget.focusOptions.preventScroll, true);
    assert.equal(page.evaluate("refreshed.join(',')"), 'summary,items,attention');
    assert.match(page.elements.get('#visibility-status').textContent, hidden ? /hidden/ : /restored/);
  });
}

test('old session filters and saved views no longer apply iteration or date constraints', async () => {
  const requests = [];
  const page = dashboard(async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ items: [], total: 0 }) };
  });
  page.evaluate(`sessionStorage.setItem(FILTER_STORAGE_KEY, 'project=Example&iteration=Sprint&from=2026-01-01&to=2026-01-31'); restoreFilters();`);
  assert.equal(page.elements.get('#f-project').value, 'Example');
  await page.evaluate('loadItems()');
  assert.equal(requests[0], '/api/items?project=Example');
  assert.doesNotMatch(page.evaluate('sessionStorage.getItem(FILTER_STORAGE_KEY)'), /iteration=|from=|to=/);
  page.evaluate(`applyFilterValues({ project: 'Another', iteration: 'Sprint', from: '2026-01-01', to: '2026-01-31' });`);
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

function item(id, changed = '2026-01-01T00:00:00Z') {
  return { id, title: `Work ${id}`, changed_date: changed, project: 'Project', state: 'Active' };
}

test('attention shows the source priority level and a dash when it is missing', async () => {
  const page = dashboard(async () => ({
    ok: true, json: async () => ({
      items: [{ ...item(1), priority_level: 'High' }, item(2)], total: 2,
    }),
  }));
  await page.load();
  const rows = page.elements.get('#attention-list').children;
  const priority = (row) => row.children.find((child) => child.className === 'attention-priority');
  assert.equal(priority(rows[0]).textContent, 'High');
  assert.equal(priority(rows[1]).textContent, '–');
  assert.match(rows[0].attributes['aria-label'], /priority level High/);
  assert.match(rows[1].attributes['aria-label'], /priority level not set/);
});

test('attention expands and collapses in place without requests or filter changes', async () => {
  let requests = 0;
  const page = dashboard(async () => {
    requests++;
    return { ok: true, json: async () => ({ items: Array.from({ length: 8 }, (_, i) => item(i)), total: 8 }) };
  });
  const project = page.elements.get('#f-project');
  project.value = 'Example';
  await page.load();
  const list = page.elements.get('#attention-list');
  const toggle = page.elements.get('#show-attention');
  assert.equal(list.children.length, 5);
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.attributes['aria-expanded'], 'false');

  page.toggle();
  assert.equal(list.children.length, 8);
  assert.equal(toggle.textContent, 'Show fewer');
  assert.equal(toggle.attributes['aria-expanded'], 'true');
  page.toggle();
  assert.equal(list.children.length, 5);
  assert.equal(toggle.textContent, 'View all');
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  assert.equal(project.value, 'Example');
  assert.equal(requests, 1);
});

for (const count of [0, 3, 5]) {
  test(`attention hides the toggle for ${count} items`, async () => {
    const page = dashboard(async () => ({
      ok: true, json: async () => ({ items: Array.from({ length: count }, (_, i) => item(i)), total: count }),
    }));
    await page.load();
    assert.equal(page.elements.get('#show-attention').hidden, true);
    assert.equal(page.elements.get('#attention-list').children.length, count);
    assert.equal(page.elements.get('#attention-empty').hidden, count > 0);
    assert.equal(page.elements.get('#attention-list').hidden, count === 0);
  });
}

test('attention loads beyond the first 500 items and sorts oldest first', async () => {
  const requests = [];
  const page = dashboard(async (url) => {
    requests.push(url);
    const items = requests.length === 1
      ? Array.from({ length: 500 }, (_, i) => item(i, '2026-10-15T00:00:00Z'))
      : [item(501), item(502, '2025-01-01T00:00:00Z')];
    return { ok: true, json: async () => ({ items, total: 502 }) };
  });
  await page.load();
  assert.deepEqual(requests, ['/api/items?mine=1&limit=500&offset=0', '/api/items?mine=1&limit=500&offset=500']);
  const list = page.elements.get('#attention-list');
  assert.equal(list.children.length, 2);
  assert.equal(list.children[0].href, '/item.html?id=502');
  assert.equal(page.elements.get('#attention-count').textContent, 2);
});

test('attention keeps expansion after a reload and resets it when no longer needed', async () => {
  let count = 8;
  const page = dashboard(async () => ({
    ok: true, json: async () => ({ items: Array.from({ length: count }, (_, i) => item(i)), total: count }),
  }));
  await page.load();
  page.toggle();
  count = 9;
  await page.load();
  assert.equal(page.elements.get('#attention-list').children.length, 9);
  count = 3;
  await page.load();
  assert.equal(page.elements.get('#show-attention').hidden, true);
  assert.equal(page.elements.get('#show-attention').attributes['aria-expanded'], 'false');
});

test('attention reports failed or incomplete page loads instead of showing a partial list', async () => {
  for (const response of [
    { ok: false, json: async () => ({ error: 'Connection failed' }) },
    { ok: true, json: async () => ({ items: [], total: 6 }) },
  ]) {
    const page = dashboard(async () => response);
    await assert.rejects(page.load(), /Connection failed|Could not load all items/);
  }
});
