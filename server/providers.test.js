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

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-hall-test-'));
  return path.join(directory, 'nested', 'items.db');
}

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
  assert.equal(store.getSyncState('lastSync', 'azure-devops', scope), '2026-01-01');
  assert.equal(store.saveItem({ id: 109642, source_scope: scope, title: 'Updated' }), 109642);
  store.close();
  store = createStore(filename, scope);
  t.after(() => {
    store.close();
    fs.rmSync(path.dirname(path.dirname(filename)), { recursive: true, force: true });
  });
  assert.equal(store.getItem(109642).title, 'Updated');
});

test('only implemented providers are advertised and unsupported providers fail explicitly', () => {
  assert.deepEqual(listProviders().map((provider) => provider.id), ['azure-devops']);
  assert.equal(getProvider('azure-devops').label, 'Azure DevOps');
  assert.throws(() => getProvider('github'), /Unsupported provider/);
});

test('history uses the external ID and refuses a different source scope', async (t) => {
  const oldScope = config.orgUrl;
  const oldUpdates = ado.getUpdates;
  t.after(() => { config.orgUrl = oldScope; ado.getUpdates = oldUpdates; });
  config.orgUrl = 'https://dev.azure.com/example';
  let requestedId;
  ado.getUpdates = async (id) => { requestedId = id; return []; };
  const provider = getProvider('azure-devops');
  assert.deepEqual(await provider.getHistory({ id: 1, external_id: '109642', source_scope: config.orgUrl }), []);
  assert.equal(requestedId, '109642');
  await assert.rejects(provider.getHistory({ external_id: '109642', source_scope: 'https://dev.azure.com/other' }), /different.*organization/);
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
