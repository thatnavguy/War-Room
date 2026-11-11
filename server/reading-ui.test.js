'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'reading.js'), 'utf8')
  .split('initReadingRoom().catch(')[0];

function reader(fetch, { stored, search = '' } = {}) {
  function element(tag = 'div') {
    const classes = new Set();
    return {
      tagName: tag.toUpperCase(), hidden: false, value: '', dataset: {}, children: [], attributes: {}, listeners: {},
      textContent: '', disabled: false,
      classList: {
        add: (value) => classes.add(value),
        contains: (value) => classes.has(value),
        toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value),
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      querySelector() { return null; },
      focus() { this.focused = true; },
      scrollIntoView() {},
      reportValidity() { return true; },
    };
  }
  const elements = new Map();
  const documentListeners = {};
  const values = new Map(stored ? [['war-room-reading-position', stored]] : []);
  const location = { pathname: '/reading.html', search, hash: '', origin: 'http://localhost:4086', href: `http://localhost:4086/reading.html${search}` };
  const context = vm.createContext({
    document: {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
      },
      createElement: element,
      addEventListener(name, callback) { documentListeners[name] = callback; },
      getElementById() { return null; },
    },
    window: { scrollY: 0, scrollTo({ top }) { this.scrollY = top; }, addEventListener() {} },
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    history: {
      pushState(state, unused, url) { const parsed = new URL(url, location.origin); Object.assign(location, { search: parsed.search, hash: parsed.hash }); },
      replaceState(state, unused, url) { this.pushState(state, unused, url); },
    },
    location, URLSearchParams, URL, CSS: { escape: value => value }, fetch, setTimeout, clearTimeout,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
  });
  vm.runInContext(source, context);
  return {
    elements, values,
    evaluate: (script) => vm.runInContext(script, context),
    flush: () => new Promise((resolve) => setTimeout(resolve, 10)),
    click(link) {
      let prevented = false;
      documentListeners.click({
        target: { closest: () => link }, button: 0,
        preventDefault() { prevented = true; },
      });
      return prevented;
    },
  };
}

const connection = { id: 1, name: 'Team handbook', provider: 'azure-devops', project: 'Operations' };
const reply = (data, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => data });
const setup = (page) => page.evaluate(`connections = [${JSON.stringify(connection)}]; renderCollection();`);

test('returning readers reopen their selected wiki and last page without discovery requests', async () => {
  const requests = [];
  const page = reader(async (url) => {
    requests.push(url);
    if (url === '/api/providers') return reply({ providers: [] });
    if (url.endsWith('/connections')) return reply({ connections: [connection] });
    if (url.endsWith('/tree')) return reply({ pages: [{ path: '/Home', title: 'Home' }, { path: '/Development/Setup', title: 'Setup' }] });
    return reply({ path: '/Development/Setup', title: 'Setup', html: '<p>Install the tools.</p>', url: 'https://dev.azure.com/example/wiki', fetchedAt: '2026-11-10T09:00:00Z' });
  }, { stored: JSON.stringify({ lastWiki: '1', wikis: { 1: { path: '/Development/Setup', scroll: 420 } } }) });
  await page.evaluate('initReadingRoom()');
  await page.flush();
  assert.equal(page.evaluate('currentPath'), '/Development/Setup');
  assert.ok(requests.some((url) => url.includes('path=%2FDevelopment%2FSetup')));
  assert.ok(requests.every((url) => !url.includes('/targets') && !url.includes('/wikis?')));
  assert.equal(page.elements.get('#document-title').textContent, 'Setup');
  assert.equal(JSON.parse(page.values.get('war-room-reading-position')).wikis['1'].scroll, 420);
});

test('empty collections do not enumerate projects or repositories', async () => {
  const calls = [];
  const page = reader(async (url) => {
    calls.push(url);
    return reply(url === '/api/providers' ? { providers: [] } : { connections: [] });
  });
  await page.evaluate('initReadingRoom()');
  assert.deepEqual(calls.sort(), ['/api/providers', '/api/reading/connections']);
  assert.equal(page.elements.get('#reading-empty').hidden, false);
  assert.equal(page.elements.get('#reading-workspace').hidden, true);
});

test('switching providers discards stale discovery results', async () => {
  let release;
  const page = reader(() => new Promise((resolve) => { release = resolve; }));
  page.evaluate("$('#add-provider').value = 'azure-devops'; $('#target-query').value = 'Team';");
  const pending = page.evaluate('findTargets({ preventDefault() {} })');
  await page.flush();
  page.evaluate("$('#add-provider').value = 'github'; updateProvider();");
  release(reply({ targets: [{ id: 'old', name: 'Old Azure project' }] }));
  await pending;
  assert.equal(page.elements.get('#target-results').children.length, 0);
  assert.equal(page.elements.get('#add-form').hidden, true);
});

test('late page responses never overwrite a newer document', async () => {
  let releaseFirst;
  const page = reader(async (url) => {
    if (url.includes('First')) return new Promise((resolve) => { releaseFirst = resolve; });
    return reply({ path: '/Second', title: 'Second page', html: '<p>Second</p>', url: 'https://example.com/wiki/Second' });
  });
  setup(page);
  page.evaluate(`currentWiki = connections[0]; pages = [{path:'/First',title:'First'},{path:'/Second',title:'Second'}];`);
  const first = page.evaluate("loadPage('/First')");
  await page.flush();
  await page.evaluate("loadPage('/Second')");
  releaseFirst(reply({ path: '/First', title: 'First page', html: '<p>First</p>', url: 'https://example.com/wiki/First' }));
  await first;
  assert.equal(page.elements.get('#document-title').textContent, 'Second page');
  assert.equal(page.evaluate('currentPath'), '/Second');
});

test('missing pages retain their saved connection and offer recovery', async () => {
  const page = reader(async () => reply({ error: 'Page was removed.' }, 404));
  setup(page);
  page.evaluate("currentWiki = connections[0]; pages = [{path:'/Home',title:'Home'}];");
  await page.evaluate("loadPage('/Missing')");
  assert.equal(page.evaluate('connections.length'), 1);
  assert.equal(page.elements.get('#document-panel').hidden, true);
  const status = page.elements.get('#reader-status');
  assert.match(status.children[0].textContent, /no longer available/);
  assert.deepEqual(status.children.slice(1).map((child) => child.textContent), ['Try again', 'Go to wiki home']);
});

test('search sends the selected scope and displays partial-search warnings', async () => {
  const calls = [];
  const page = reader(async (url) => {
    calls.push(url);
    return reply({ results: [{ connectionId: 1, connectionName: 'Handbook', path: '/Runbook', title: 'Runbook', excerpt: 'Deploy safely' }], warnings: ['Another wiki is unavailable.'] });
  });
  setup(page);
  page.evaluate("currentWiki = connections[0]; $('#page-query').value = 'deploy'; $('#search-scope').value = 'current';");
  await page.evaluate('searchPages({preventDefault(){}})');
  assert.match(calls[0], /connectionId=1/);
  assert.match(page.elements.get('#search-summary').textContent, /Another wiki is unavailable/);
  page.evaluate("$('#search-scope').value = 'all';");
  await page.evaluate('searchPages({preventDefault(){}})');
  assert.doesNotMatch(calls[1], /connectionId=/);
  assert.equal(page.elements.get('#search-results').children.length, 1);
});

test('corrupt browser state is reported instead of preventing the room from opening', async () => {
  const page = reader(async () => reply({ connections: [] }), { stored: '{broken' });
  page.evaluate('restoreReadingState()');
  assert.match(page.elements.get('#storage-notice').textContent, /could not be restored/);
  assert.equal(page.evaluate('readingState.lastWiki'), '');
});

test('form events prevent navigation synchronously', async () => {
  const page = reader(async () => reply({ targets: [] }));
  let prevented = false;
  page.elements.get('#target-form').listeners.submit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  await page.flush();
});

test('contents links scroll to the existing heading without fetching the page again', () => {
  const requests = [];
  const page = reader(async url => { requests.push(url); return reply({}); });
  setup(page);
  page.evaluate(`
    currentWiki = connections[0]; currentPath = '/Home'; documentLoaded = true;
    var scrolledToHeading = false;
    $('#document-body').querySelector = selector => selector === '#wiki-heading-setup'
      ? { scrollIntoView() { scrolledToHeading = true; } } : null;
  `);
  assert.equal(page.click({ href: 'http://localhost:4086/reading.html?wiki=1&page=%2FHome#wiki-heading-setup' }), true);
  assert.equal(page.evaluate('scrolledToHeading'), true);
  assert.equal(page.evaluate('location.hash'), '#wiki-heading-setup');
  assert.equal(page.evaluate('currentPath'), '/Home');
  assert.equal(requests.length, 0);
});
