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
      disabled: false,
      textContent: '',
      label: '',
      children: [],
      attributes: {},
      listeners: {},
      classList: {
        add() {},
        remove() {},
        toggle() {},
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

test('preset views are listed before saved views and filter the work list', async () => {
  const requests = [];
  const page = dashboard(async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ items: [], total: 0 }) };
  });
  page.evaluate('renderSavedViews()');
  const select = page.elements.get('#saved-view-select');
  const presetGroup = select.children.find((child) => child.label === 'Preset views');
  assert.deepEqual(presetGroup.children.map((option) => option.textContent), ['Daily digest', 'Needs attention']);
  assert.equal(page.elements.get('#delete-view').disabled, true);

  select.value = 'preset:daily-digest';
  select.listeners.change();
  await page.flush();
  assert.equal(page.elements.get('#f-focus').value, 'digest');
  assert.equal(requests.at(-1), '/api/items?focus=digest');
  assert.equal(page.elements.get('#delete-view').disabled, true);
  assert.match(page.elements.get('#saved-view-status').textContent, /Daily digest/);

  select.value = 'preset:needs-attention';
  select.listeners.change();
  await page.flush();
  assert.equal(requests.at(-1), '/api/items?focus=attention');

  page.elements.get('#f-project').value = 'Example';
  page.elements.get('#f-project').listeners.change();
  await page.flush();
  assert.equal(page.evaluate('currentSavedViewId'), '');
  assert.equal(requests.at(-1), '/api/items?focus=attention&project=Example');
});

test('the stale summary count opens the needs attention preset', async () => {
  const requests = [];
  const page = dashboard(async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ items: [], total: 0 }) };
  });
  page.elements.get('#card-stale-button').listeners.click();
  await page.flush();
  assert.equal(requests.at(-1), '/api/items?focus=attention');
  assert.equal(page.elements.get('#f-focus').value, 'attention');
  assert.equal(page.elements.get('#f-focus').focusOptions.preventScroll, true);
  assert.equal(page.evaluate('currentSavedViewId'), 'preset:needs-attention');
});

test('saved views cannot reuse a preset view name', () => {
  const page = dashboard();
  page.evaluate(`$('#saved-view-name').value = 'daily digest';`);
  page.elements.get('#save-view-form').listeners.submit({ preventDefault() {} });
  assert.match(page.elements.get('#saved-view-error').textContent, /already exists/);
  assert.equal(page.elements.get('#saved-view-error').hidden, false);
});

test('restoring a preset view from the session keeps it selected', () => {
  const page = dashboard(async () => ({ ok: true, json: async () => ({ items: [], total: 0 }) }));
  page.evaluate(`sessionStorage.setItem(FILTER_STORAGE_KEY, 'focus=digest&savedView=preset:daily-digest'); restoreFilters();`);
  assert.equal(page.elements.get('#f-focus').value, 'digest');
  assert.equal(page.evaluate('currentSavedViewId'), 'preset:daily-digest');
  page.evaluate(`sessionStorage.setItem(FILTER_STORAGE_KEY, 'savedView=preset:unknown'); restoreFilters();`);
  assert.equal(page.evaluate('currentSavedViewId'), '');
});
