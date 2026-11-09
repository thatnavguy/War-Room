'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createStore } = require('./store');
const config = require('./config');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'war-room-discovery-'));
  const store = createStore(path.join(directory, 'items.db'));
  const previousDays = config.discoveryDays;
  config.discoveryDays = 30;
  t.after(() => {
    config.discoveryDays = previousDays;
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const save = (externalId, overrides = {}) => store.saveItem({
    provider: 'azure-devops', source_scope: 'https://dev.azure.com/example',
    external_id: externalId, title: 'Review warehouse work', project: 'Warehouse',
    type: 'Task', state: 'Active', is_closed: false,
    changed_date: new Date().toISOString(), ...overrides,
  });
  return { store, save };
}

test('discovery includes only recent open stored items without any recorded touch', (t) => {
  const { store, save } = fixture(t);
  const recent = save('recent');
  save('old', { changed_date: new Date(Date.now() - 31 * 86400000).toISOString() });
  save('closed', { is_closed: true });
  save('missing-date', { changed_date: null });
  save('invalid-date', { changed_date: 'not-a-date' });
  for (const touch of ['assigned', 'created', 'edited', 'commented', 'mentioned']) {
    const id = save(touch);
    store.saveTouch(id, touch);
  }
  assert.deepEqual(store.queryItems({ discovery: true }).items.map((item) => item.id), [recent]);
  assert.equal(store.queryItems({}).total, 5);
  // Briefing-only query options cannot expose touched or closed work in discovery.
  assert.deepEqual(store.queryItems({
    discovery: true, closedOnly: true, hiddenOnly: true, assignedToMe: true, focus: 'attention', touch: 'edited',
  }).items.map((item) => item.id), [recent]);
  assert.equal(store.getItem(recent).touches.length, 0);
});

test('discovery uses the configured timestamp window and moves involved items into Briefing Room', (t) => {
  const { store, save } = fixture(t);
  const inside = save('inside', { changed_date: new Date(Date.now() - (30 * 24 - 1) * 3600000).toISOString() });
  const outside = save('outside', { changed_date: new Date(Date.now() - (30 * 24 + 1) * 3600000).toISOString() });
  assert.deepEqual(store.queryItems({ discovery: true }).items.map((item) => item.id), [inside]);
  config.discoveryDays = 31;
  assert.equal(store.queryItems({ discovery: true }).total, 2);
  store.saveTouch(outside, 'commented');
  assert.equal(store.queryItems({ discovery: true }).total, 1);
  assert.deepEqual(store.queryItems({}).items.map((item) => item.id), [outside]);
});

test('discovery filters and filter options include untouched projects but exclude old and involved work', (t) => {
  const { store, save } = fixture(t);
  save('one', { tags: 'Inventory; Release', priority_level: 'High' });
  save('two', { project: 'Another project', type: 'Bug', state: 'New', tags: 'Inventory-Old' });
  const tracked = save('tracked', { project: 'Tracked only', tags: 'Tracked', priority_level: 'Low' });
  store.saveTouch(tracked, 'assigned');
  save('old', {
    project: 'Old only', tags: 'Old', changed_date: new Date(Date.now() - 60 * 86400000).toISOString(),
  });
  save('closed', { project: 'Closed only', tags: 'Closed', is_closed: true });
  assert.deepEqual(store.getFilterValues(true), {
    projects: ['Another project', 'Warehouse'], types: ['Bug', 'Task'], states: ['Active', 'New'],
    providers: ['azure-devops'], priorities: ['High'], labels: ['Inventory', 'Inventory-Old', 'Release'],
    iterations: [], touches: [],
  });
  assert.deepEqual(store.getFilterValues().projects, ['Tracked only']);
  for (const filters of [
    { project: 'Warehouse' }, { type: 'Task' }, { state: 'Active' },
    { priority: 'High' }, { label: 'inventory' }, { search: 'Release' },
  ]) {
    assert.equal(store.queryItems({ discovery: true, ...filters }).total, 1);
  }
  assert.equal(store.queryItems({ discovery: true, label: 'Invent' }).total, 0);
  assert.equal(store.queryItems({ discovery: true, provider: 'github' }).total, 0);
});

test('discovery supports stable pagination without changing the stored items', (t) => {
  const { store, save } = fixture(t);
  const changed = new Date().toISOString();
  for (let i = 0; i < 205; i++) save(String(i), { changed_date: changed });
  const first = store.queryItems({ discovery: true });
  const next = store.queryItems({ discovery: true, offset: 200 });
  assert.equal(first.total, 205);
  assert.equal(first.items.length, 200);
  assert.equal(next.items.length, 5);
  assert.equal(new Set([...first.items, ...next.items].map((item) => item.id)).size, 205);
  assert.equal(store.queryItems({}).total, 0);
});

test('discovery API uses local queries for both items and their filter options', (t) => {
  const { store, save } = fixture(t);
  save('one');
  const dbPath = require.resolve('./db');
  const apiPath = require.resolve('./api');
  const originalDb = require.cache[dbPath];
  const originalApi = require.cache[apiPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: store };
  delete require.cache[apiPath];
  const api = require('./api');
  t.after(() => {
    if (originalDb) require.cache[dbPath] = originalDb;
    else delete require.cache[dbPath];
    if (originalApi) require.cache[apiPath] = originalApi;
    else delete require.cache[apiPath];
  });
  const request = (routePath, query) => {
    const route = api.stack.find((layer) => layer.route?.path === routePath && layer.route.methods.get);
    const res = { json(body) { this.body = body; } };
    route.route.stack[0].handle({ query }, res);
    return res.body;
  };
  assert.equal(request('/items', { room: 'discovery' }).total, 1);
  assert.equal(request('/items', {}).total, 0);
  assert.deepEqual(request('/filters', { room: 'discovery' }).projects, ['Warehouse']);
  assert.deepEqual(request('/filters', {}).projects, []);
});
