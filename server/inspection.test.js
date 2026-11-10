'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createStore } = require('./store');

test('Inspection Room includes only touched GitHub pull requests', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'war-room-inspection-'));
  const store = createStore(path.join(directory, 'items.db'));
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const save = (externalId, overrides = {}, touched = true) => {
    const id = store.saveItem({
      provider: 'github', source_scope: 'github.com/example/project',
      external_id: externalId, title: externalId, project: 'Pull requests',
      type: 'Pull Request', state: 'Open', is_closed: false,
      changed_date: new Date().toISOString(), ...overrides,
    });
    if (touched) store.saveTouch(id, 'commented');
    return id;
  };
  save('open-pr');
  save('closed-pr', { is_closed: true, project: 'Closed pull requests' });
  save('untouched-pr', {}, false);
  save('github-issue', { type: 'Issue', project: 'GitHub issues' });
  save('ado-pull-request', { provider: 'azure-devops', project: 'Azure DevOps' });

  assert.deepEqual(store.queryItems({ inspection: true }).items.map((item) => item.external_id), ['open-pr']);
  assert.deepEqual(store.queryItems({ inspection: true, closedOnly: true }).items.map((item) => item.external_id), ['closed-pr']);
  const briefingIds = store.queryItems({}).items.map((item) => item.external_id);
  assert.ok(!briefingIds.includes('open-pr'));
  assert.ok(briefingIds.includes('ado-pull-request'));
  const filters = store.getFilterValues('inspection');
  assert.deepEqual(filters.projects, ['Closed pull requests', 'Pull requests']);
  assert.deepEqual(filters.types, ['Pull Request']);
  assert.deepEqual(filters.providers, ['github']);
  assert.ok(!store.getFilterValues().projects.includes('Pull requests'));

  const summary = store.getSummary(30, true);
  assert.equal(summary.open, 1);
  assert.equal(summary.totalTracked, 2);
  assert.deepEqual(summary.byType, [{ key: 'Pull Request', n: 1 }]);
  assert.equal(store.getSummary(30).open, 2);
});

test('Inspection Room API scopes item results and filter values to pull requests', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'war-room-inspection-api-'));
  const store = createStore(path.join(directory, 'items.db'));
  const pr = store.saveItem({
    provider: 'github', source_scope: 'github.com/example/project',
    external_id: 'pr', title: 'Pull request', type: 'Pull Request',
    state: 'Open', project: 'Repository', is_closed: false, changed_date: new Date().toISOString(),
  });
  const issue = store.saveItem({
    provider: 'github', source_scope: 'github.com/example/project',
    external_id: 'issue', title: 'Issue', type: 'Issue',
    state: 'Open', project: 'Repository', is_closed: false, changed_date: new Date().toISOString(),
  });
  store.saveTouch(pr, 'commented');
  store.saveTouch(issue, 'commented');

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
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const request = (routePath, query) => {
    const route = api.stack.find((layer) => layer.route?.path === routePath && layer.route.methods.get);
    const res = { json(body) { this.body = body; } };
    route.route.stack[0].handle({ query }, res);
    return res.body;
  };
  assert.deepEqual(request('/items', { room: 'inspection' }).items.map((item) => item.external_id), ['pr']);
  assert.deepEqual(request('/filters', { room: 'inspection' }).types, ['Pull Request']);
});
