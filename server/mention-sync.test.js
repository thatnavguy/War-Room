'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const config = require('./config');
const ado = require('./ado');
const me = '11111111-1111-1111-1111-111111111111';

test('mention-only items enter the list and failed scans retry backfill without advancing the checkpoint', async (t) => {
  const storePath = require.resolve('./db');
  const syncPath = require.resolve('./azure-sync');
  const originalStore = require.cache[storePath];
  const originalConfig = { ...config };
  const originalAdo = { ...ado };
  const state = new Map([['lastSync', '2026-11-01T00:00:00Z'], ['priorityVersion', '1']]);
  const touches = [];
  let queriedDate;
  let fail = false;
  const store = {
    getSyncState: (key) => state.get(key) || null,
    setSyncState: (key, value) => state.set(key, value),
    saveItem: () => 100,
    saveTouch: (id, type, date) => touches.push({ id, type, date }),
  };
  require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: store };
  delete require.cache[syncPath];
  Object.assign(config, { lookbackDays: 365, orgUrl: 'https://dev.azure.com/example' });
  Object.assign(ado, {
    getMyIdentity: async () => ({ id: me, displayName: 'Example User' }),
    queryEverAssigned: async () => [],
    queryCreatedByMe: async () => [],
    queryChangedByMe: async () => [],
    queryChangedSince: async (date) => { queriedDate = date; return [42]; },
    getWorkItems: async () => [{ id: 42, fields: { 'System.TeamProject': 'Example', 'System.State': 'Active' } }],
    getUpdates: async () => {
      if (fail) throw new Error('Temporary connection failure');
      return [{ revisedDate: '9999-01-01', revisedBy: { id: 'other', displayName: 'Other User' }, fields: {
        'System.History': { newValue: `<a href="#" data-vss-mention="version:2.0,${me}">@Example User</a>` },
        'System.ChangedDate': { newValue: '2026-10-01T10:00:00Z' },
      } }];
    },
  });
  t.after(() => {
    Object.assign(config, originalConfig);
    Object.assign(ado, originalAdo);
    delete require.cache[syncPath];
    if (originalStore) require.cache[storePath] = originalStore;
    else delete require.cache[storePath];
  });
  const sync = require('./azure-sync');
  const before = state.get('lastSync');
  const stats = await sync.runSync();
  assert.equal(stats.errors.length, 0);
  assert.ok(queriedDate < before.slice(0, 10));
  assert.deepEqual(touches, [{ id: 100, type: 'mentioned', date: '2026-10-01T10:00:00Z' }]);
  assert.equal(state.get('mentionsVersion'), `1:${me}`);
  state.delete('mentionsVersion');
  const successfulCheckpoint = state.get('lastSync');
  fail = true;
  const failed = await sync.runSync();
  assert.equal(failed.errors.length, 1);
  assert.equal(state.get('lastSync'), successfulCheckpoint);
  assert.ok(!state.has('mentionsVersion'));
});
