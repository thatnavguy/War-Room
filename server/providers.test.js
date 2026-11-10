'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createStore } = require('./store');
const { getProvider, listProviders } = require('./providers');
const config = require('./config');
const ado = require('./ado');

test('label options split tags from tracked work and filters match whole labels', (t) => {
  const filename = fixture();
  const store = createStore(filename);
  t.after(() => {
    store.close();
    fs.rmSync(path.dirname(path.dirname(filename)), { recursive: true, force: true });
  });
  const base = { provider: 'azure-devops', source_scope: 'https://dev.azure.com/example' };
  const first = store.saveItem({ ...base, external_id: '1', tags: ' Sandbox-Dev ; Warehouse ; ; ' });
  const second = store.saveItem({ ...base, external_id: '2', tags: 'Sandbox-Dev-Old; Warehouse' });
  const third = store.saveItem({ ...base, external_id: '3', tags: '50%_done' });
  store.saveItem({ ...base, external_id: '4', tags: 'Untouched' });
  for (const id of [first, second, third]) store.saveTouch(id, 'mentioned', '2026-01-01');
  assert.deepEqual(store.getFilterValues().labels, ['50%_done', 'Sandbox-Dev', 'Sandbox-Dev-Old', 'Warehouse']);
  assert.equal(store.queryItems({ label: 'Sandbox-Dev' }).total, 1);
  assert.equal(store.queryItems({ label: 'sandbox-dev' }).total, 1);
  assert.equal(store.queryItems({ label: 'Sandbox' }).total, 0);
  assert.equal(store.queryItems({ label: '50%_done' }).total, 1);
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-hall-test-'));
  return path.join(directory, 'nested', 'items.db');
}

test('needs attention counts only stale open work currently assigned to the source profile', (t) => {
  const filename = fixture();
  const store = createStore(filename);
  t.after(() => {
    store.close();
    fs.rmSync(path.dirname(path.dirname(filename)), { recursive: true, force: true });
  });
  const scope = 'https://dev.azure.com/example';
  store.setSyncState('meDisplayName', 'Me', 'azure-devops', scope);
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const save = (externalId, overrides = {}, touches = ['assigned']) => {
    const id = store.saveItem({
      provider: 'azure-devops', source_scope: scope, external_id: externalId,
      assigned_to: 'Me', changed_date: ago(31), is_closed: false, ...overrides,
    });
    for (const touch of touches) store.saveTouch(id, touch, ago(31));
    return id;
  };
  const staleMine = save('1', {}, ['assigned', 'commented']);
  save('2', { assigned_to: 'Someone else' });
  save('3', { assigned_to: 'Someone else' }, ['created', 'edited', 'mentioned']);
  save('4', { assigned_to: null });
  save('5', { is_closed: true });
  save('6', { changed_date: ago(29) });
  save('7', { source_scope: 'https://dev.azure.com/another' });
  save('8', { provider: 'another-provider' });
  save('9', { changed_date: null });
  save('10', {}, []);
  assert.equal(store.getSummary(30).stale, 1);
  assert.equal(store.getSummary(32).stale, 0);
  assert.equal(store.queryItems({}).total, 8);

  store.saveItem({
    provider: 'azure-devops', source_scope: scope, external_id: '1',
    assigned_to: 'Someone else', changed_date: ago(31), is_closed: false,
  });
  assert.equal(store.getSummary(30).stale, 0);
  assert.equal(store.getItem(staleMine).touches.length, 2);
});

test('needs attention applies the stale threshold to timestamps rather than date strings', (t) => {
  const filename = fixture();
  const store = createStore(filename);
  t.after(() => {
    store.close();
    fs.rmSync(path.dirname(path.dirname(filename)), { recursive: true, force: true });
  });
  const scope = 'https://dev.azure.com/example';
  store.setSyncState('meDisplayName', 'Me', 'azure-devops', scope);
  for (const [externalId, hours] of [['1', 30 * 24 + 1], ['2', 30 * 24 - 1]]) {
    const id = store.saveItem({
      provider: 'azure-devops', source_scope: scope, external_id: externalId,
      assigned_to: 'Me', changed_date: new Date(Date.now() - hours * 3600000).toISOString(),
    });
    store.saveTouch(id, 'assigned');
  }
  assert.equal(store.getSummary(30).stale, 1);
});

test('daily digest focus keeps open items due today, overdue, or changed today', (t) => {
  const filename = fixture();
  const store = createStore(filename);
  t.after(() => {
    store.close();
    fs.rmSync(path.dirname(path.dirname(filename)), { recursive: true, force: true });
  });
  const scope = 'https://dev.azure.com/example';
  const now = Date.now();
  const ago = (days) => new Date(now - days * 86400000).toISOString();
  const save = (externalId, overrides = {}) => {
    const id = store.saveItem({
      provider: 'azure-devops', source_scope: scope, external_id: externalId, is_closed: false, ...overrides,
    });
    store.saveTouch(id, 'assigned', ago(1));
    return id;
  };
  save('due-today', { due_date: new Date(now).toISOString(), changed_date: ago(10) });
  save('overdue', { due_date: ago(3), changed_date: ago(10) });
  save('changed-today', { changed_date: new Date(now).toISOString() });
  save('future-due', { due_date: new Date(now + 5 * 86400000).toISOString(), changed_date: ago(10) });
  save('no-dates', { changed_date: ago(10) });
  save('closed-overdue', { due_date: ago(3), changed_date: ago(10), is_closed: true });

  const digest = store.queryItems({ focus: 'digest' });
  assert.deepEqual(
    digest.items.map((item) => item.external_id).sort(),
    ['changed-today', 'due-today', 'overdue'],
  );
  assert.equal(store.queryItems({ focus: 'digest', project: 'missing' }).total, 0);
  assert.equal(store.queryItems({ focus: '' }).total, 5);
  assert.equal(store.queryItems({ focus: 'nonsense' }).total, 5);
});

test('needs attention focus keeps only stale open work assigned to the source profile', (t) => {
  const filename = fixture();
  const store = createStore(filename);
  t.after(() => {
    store.close();
    fs.rmSync(path.dirname(path.dirname(filename)), { recursive: true, force: true });
  });
  const scope = 'https://dev.azure.com/example';
  store.setSyncState('meDisplayName', 'Me', 'azure-devops', scope);
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const staleDays = config.staleDays;
  const save = (externalId, overrides = {}) => {
    const id = store.saveItem({
      provider: 'azure-devops', source_scope: scope, external_id: externalId, is_closed: false, ...overrides,
    });
    store.saveTouch(id, 'assigned', ago(1));
    return id;
  };
  save('stale-mine', { assigned_to: 'Me', changed_date: ago(staleDays + 5) });
  save('recent-mine', { assigned_to: 'Me', changed_date: ago(1) });
  save('stale-other', { assigned_to: 'Someone else', changed_date: ago(staleDays + 5) });
  save('stale-closed', { assigned_to: 'Me', changed_date: ago(staleDays + 5), is_closed: true });

  const attention = store.queryItems({ focus: 'attention' });
  assert.deepEqual(attention.items.map((item) => item.external_id), ['stale-mine']);
  assert.equal(store.queryItems({ focus: 'attention', state: 'missing' }).total, 0);
});

test('source numbers cannot collide across providers or repositories', (t) => {
  const filename = fixture();
  const store = createStore(filename);
  t.after(() => {
    store.close();
    fs.rmSync(path.dirname(path.dirname(filename)), { recursive: true, force: true });
  });
  const save = (provider, scope, closed = false) => store.saveItem({
    provider, source_scope: scope, external_id: '42', title: scope,
    state: closed ? 'closed' : 'open', is_closed: closed,
  });
  const adoId = save('azure-devops', 'https://dev.azure.com/example');
  const githubId = save('github', 'owner/one');
  const otherId = save('github', 'owner/two');
  assert.equal(new Set([adoId, githubId, otherId]).size, 3);
  assert.equal(save('github', 'owner/one'), githubId);
  for (const id of [adoId, githubId, otherId]) store.saveTouch(id, 'assigned', '2026-01-01');
  assert.equal(store.queryItems({ search: '42' }).total, 3);
  assert.equal(store.queryItems({ search: '0042' }).total, 3);
  assert.equal(store.queryItems({ provider: 'github' }).total, 2);
  save('github', 'owner/two', true);
  assert.equal(store.getSummary(14).open, 2);
  assert.equal(store.getItem(otherId).touches.length, 1);
  store.setSyncState('lastSync', 'one', 'github', 'owner/one');
  store.setSyncState('lastSync', 'two', 'github', 'owner/two');
  assert.equal(store.getSyncState('lastSync', 'github', 'owner/one'), 'one');
  store.setSyncState('meDisplayName', 'Me', 'github', 'owner/one');
  store.saveItem({ provider: 'github', source_scope: 'owner/one', external_id: '42', assigned_to: 'Me', is_closed: false });
  assert.equal(store.queryItems({ assignedToMe: true }).total, 1);
});

test('legacy Azure DevOps items retain local IDs, touches and sync state', (t) => {
  const filename = fixture();
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const legacy = new Database(filename);
  legacy.exec(`
    CREATE TABLE work_items (
      id INTEGER PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', assigned_to TEXT, created_by TEXT,
      created_date TEXT, changed_by TEXT, changed_date TEXT, tags TEXT, area_path TEXT, iteration_path TEXT,
      project TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', synced_at TEXT NOT NULL
    );
    CREATE TABLE touches (work_item_id INTEGER, touch_type TEXT, touched_at TEXT, PRIMARY KEY(work_item_id, touch_type));
    CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO work_items (id, title, state, synced_at) VALUES (109642, 'Existing item', 'Active', '2026-01-01');
    INSERT INTO touches VALUES (109642, 'commented', '2026-01-01');
    INSERT INTO sync_state VALUES ('lastSync', '2026-01-01');
    ALTER TABLE work_items ADD COLUMN description TEXT;
    UPDATE work_items SET description = '<p>Original description</p>';
  `);
  legacy.close();
  const scope = 'https://dev.azure.com/example';
  let store = createStore(filename, scope);
  assert.equal(store.getItem(109642).external_id, '109642');
  assert.equal(store.getItem(109642).description, '<p>Original description</p>');
  assert.equal(store.getItem(109642).touches[0].touch_type, 'commented');
  store.saveTouch(109642, 'mentioned', '2026-02-01');
  assert.equal(store.getItem(109642).touches.length, 2);
  assert.equal(store.getSyncState('lastSync', 'azure-devops', scope), '2026-01-01');
  assert.equal(store.saveItem({ id: 109642, source_scope: scope, title: 'Updated' }), 109642);
  store.close();
  store = createStore(filename, scope);
  t.after(() => {
    store.close();
    fs.rmSync(path.dirname(path.dirname(filename)), { recursive: true, force: true });
  });
  assert.equal(store.getItem(109642).title, 'Updated');
  assert.ok(store.getItem(109642).touches.some((touch) => touch.touch_type === 'mentioned'));
});

test('only implemented providers are advertised and unsupported providers fail explicitly', () => {
  assert.deepEqual(listProviders().map((provider) => provider.id), ['azure-devops', 'github']);
  assert.equal(getProvider('azure-devops').label, 'Azure DevOps');
  assert.equal(getProvider('github').label, 'GitHub');
  assert.throws(() => getProvider('gitlab'), /Unsupported provider/);
});

test('project filter lists only projects with recorded touches, including closed items', (t) => {
  const filename = fixture();
  const store = createStore(filename);
  t.after(() => {
    store.close();
    fs.rmSync(path.dirname(path.dirname(filename)), { recursive: true, force: true });
  });
  const save = (externalId, project, isClosed = false) => store.saveItem({
    provider: 'azure-devops', source_scope: 'https://dev.azure.com/example',
    external_id: externalId, project, is_closed: isClosed,
  });
  save('1', 'Untouched');
  const touched = save('2', 'Touched');
  const closed = save('3', 'Previously touched', true);
  const duplicate = save('4', 'Touched');
  const empty = save('5', '');
  for (const id of [touched, closed, duplicate, empty]) store.saveTouch(id, 'commented', '2026-01-01');
  assert.deepEqual(store.getFilterValues().projects, ['Previously touched', 'Touched']);
});

test('iteration filter lists only iterations with touched or mentioned items, including closed items', (t) => {
  const filename = fixture();
  const store = createStore(filename);
  t.after(() => {
    store.close();
    fs.rmSync(path.dirname(path.dirname(filename)), { recursive: true, force: true });
  });
  const save = (externalId, iteration, isClosed = false) => store.saveItem({
    provider: 'azure-devops', source_scope: 'https://dev.azure.com/example',
    external_id: externalId, iteration_path: iteration, is_closed: isClosed,
  });
  save('1', 'Untouched');
  const touched = save('2', 'Touched');
  const closed = save('3', 'Previously touched', true);
  const duplicate = save('4', 'Touched');
  const empty = save('5', '');
  const missing = save('6', null);
  const mentioned = save('7', 'Mentioned');
  for (const id of [touched, closed, duplicate, empty, missing]) store.saveTouch(id, 'commented', '2026-01-01');
  store.saveTouch(mentioned, 'mentioned', '2026-01-01');
  assert.deepEqual(store.getFilterValues().iterations, ['Mentioned', 'Previously touched', 'Touched']);
});

test('history uses the external ID and refuses a different source scope', async (t) => {
  const oldScope = config.orgUrl;
  const oldPat = config.pat;
  const oldUpdates = ado.getUpdates;
  t.after(() => { config.orgUrl = oldScope; config.pat = oldPat; ado.getUpdates = oldUpdates; });
  config.orgUrl = 'https://dev.azure.com/example';
  config.pat = 'test-token';
  let requestedId;
  ado.getUpdates = async (id) => { requestedId = id; return []; };
  const provider = getProvider('azure-devops');
  assert.deepEqual(await provider.getHistory({ id: 1, external_id: '109642', source_scope: config.orgUrl }), []);
  assert.equal(requestedId, '109642');
  await assert.rejects(provider.getHistory({ external_id: '109642', source_scope: 'https://dev.azure.com/other' }), /different.*organization/);
});

test('Azure DevOps pull request history loads safe text comments from its repository threads', async (t) => {
  const oldScope = config.orgUrl;
  const oldPat = config.pat;
  const oldThreads = ado.getPullRequestThreads;
  t.after(() => {
    config.orgUrl = oldScope;
    config.pat = oldPat;
    ado.getPullRequestThreads = oldThreads;
  });
  config.orgUrl = 'https://dev.azure.com/example';
  config.pat = 'test-token';
  let requested;
  ado.getPullRequestThreads = async (repositoryId, pullRequestId) => {
    requested = { repositoryId, pullRequestId };
    return [{ id: 4, comments: [
      { id: 7, commentType: 'text', content: '**Looks good**', author: { displayName: 'Reviewer' }, publishedDate: '2026-10-10T00:00:00Z' },
      { id: 8, commentType: 'system', content: 'System message' },
    ] }];
  };
  const history = await getProvider('azure-devops').getHistory({
    external_id: 'pr:11111111-1111-1111-1111-111111111111:42',
    source_scope: config.orgUrl,
  });
  assert.deepEqual(requested, {
    repositoryId: '11111111-1111-1111-1111-111111111111',
    pullRequestId: '42',
  });
  assert.equal(history.length, 1);
  assert.equal(history[0].comment, '<p><strong>Looks good</strong></p>');
  assert.equal(history[0].by, 'Reviewer');
});

test('related links use the provider external ID and reject a different organization', async (t) => {
  const oldScope = config.orgUrl;
  const oldPat = config.pat;
  const oldRelations = ado.getRelations;
  t.after(() => { config.orgUrl = oldScope; config.pat = oldPat; ado.getRelations = oldRelations; });
  config.orgUrl = 'https://dev.azure.com/example';
  config.pat = 'test-token';
  let requestedId;
  ado.getRelations = async (id) => { requestedId = id; return []; };
  const item = { id: 1, external_id: '86852', project: 'Example', source_scope: config.orgUrl };
  assert.deepEqual(await getProvider('azure-devops').getRelatedLinks(item), []);
  assert.equal(requestedId, '86852');
  await assert.rejects(getProvider('azure-devops').getRelatedLinks({ ...item, source_scope: 'https://dev.azure.com/other' }), /different.*organization/);
});

test('saving Azure DevOps settings preserves other providers and unrelated environment settings', () => {
  const result = config.mergeEnv('# Settings\nGITHUB_SCOPE=owner/repo\nADO_ORG_URL=old\nCUSTOM_OPTION=keep\n', {
    ADO_ORG_URL: 'new', PROJECTS: 'Example',
  });
  assert.match(result, /GITHUB_SCOPE=owner\/repo/);
  assert.match(result, /CUSTOM_OPTION=keep/);
  assert.match(result, /ADO_ORG_URL=new/);
  assert.match(result, /PROJECTS=Example/);
});

test('priority persists, filters touched open items, and does not list untouched values', (t) => {
    const filename = fixture();
    const store = createStore(filename);
    t.after(() => {
      store.close();
      fs.rmSync(path.dirname(path.dirname(filename)), { recursive: true, force: true });
    });
    const base = { provider: 'azure-devops', source_scope: 'https://dev.azure.com/example' };
    const id = store.saveItem({ ...base, external_id: '1', priority_level: 'P3 - Medium' });
    store.saveTouch(id, 'assigned', '2026-01-01');
    store.saveItem({ ...base, external_id: '2', priority_level: 'Untouched' });
    assert.equal(store.getItem(id).priority_level, 'P3 - Medium');
    assert.deepEqual(store.getFilterValues().priorities, ['P3 - Medium']);
    assert.equal(store.queryItems({ priority: 'P3 - Medium' }).total, 1);
    assert.equal(store.queryItems({ priority: 'P1 - Critical' }).total, 0);
    assert.deepEqual(store.sourceItemIds(base.provider, base.source_scope), ['1']);
  });

test('Azure DevOps discovers custom priority and falls back to standard numeric priority', async (t) => {
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });
    let fields;
    global.fetch = async (url, options) => {
      if (url.includes('/wit/fields?')) return { ok: true, json: async () => ({
        value: [{ name: 'Priority Level', referenceName: 'Custom.PriorityLevel' }],
      }) };
      fields = JSON.parse(options.body).fields;
      return { ok: true, json: async () => ({ value: [
        { id: 1, fields: { 'Custom.PriorityLevel': 'P3 - Medium', 'Microsoft.VSTS.Common.Priority': 2 } },
        { id: 2, fields: { 'Microsoft.VSTS.Common.Priority': 1 } },
        { id: 3, fields: {} },
      ] }) };
    };
    const items = await ado.getWorkItems([1, 2, 3]);
    assert.ok(fields.includes('Custom.PriorityLevel'));
    assert.deepEqual(items.map((item) => item.priority_level), ['P3 - Medium', '1', null]);
  });

test('due dates persist through reopening and clear when removed at the source', (t) => {
  const filename = fixture();
  let store = createStore(filename);
  t.after(() => {
    store.close();
    fs.rmSync(path.dirname(path.dirname(filename)), { recursive: true, force: true });
  });
  const base = { provider: 'azure-devops', source_scope: 'https://dev.azure.com/example', external_id: '1' };
  const due = '2026-11-06T00:00:00Z';
  const id = store.saveItem({ ...base, due_date: due });
  store.saveTouch(id, 'assigned');
  store.close();
  store = createStore(filename);
  assert.equal(store.getItem(id).due_date, due);
  assert.equal(store.queryItems({}).items[0].due_date, due);
  assert.equal(store.saveItem({ ...base, due_date: null }), id);
  assert.equal(store.getItem(id).due_date, null);
});

test('Azure DevOps requests supported due-date fields and handles missing due dates', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  for (const referenceName of ['Microsoft.VSTS.Scheduling.DueDate', 'Custom.DueDate', null]) {
    let fields;
    global.fetch = async (url, options) => {
      if (url.includes('/wit/fields?')) {
        return { ok: true, json: async () => ({
          value: referenceName ? [{ name: 'Due Date', referenceName, type: 'dateTime' }] : [],
        }) };
      }
      fields = JSON.parse(options.body).fields;
      return { ok: true, json: async () => ({ value: [
        { id: 1, fields: referenceName ? { [referenceName]: '2026-11-06T00:00:00Z' } : {} },
        { id: 2, fields: {} },
      ] }) };
    };
    const items = await ado.getWorkItems([1, 2]);
    assert.deepEqual(items.map((item) => item.due_date), [
      referenceName ? '2026-11-06T00:00:00Z' : null, null,
    ]);
    if (referenceName) assert.ok(fields.includes(referenceName));
    else assert.ok(!fields.includes('Microsoft.VSTS.Scheduling.DueDate'));
  }
});
