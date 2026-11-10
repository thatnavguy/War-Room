'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const config = require('./config');
const ado = require('./ado');
const { createStore } = require('./store');

const me = '11111111-1111-1111-1111-111111111111';
const repositoryId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

test('Azure DevOps PR API uses configured project scope and author or reviewer filters', async (t) => {
  const originalConfig = { ...config };
  const originalFetch = global.fetch;
  const requests = [];
  Object.assign(config, {
    orgUrl: 'https://dev.azure.com/example',
    authHeader: 'Basic token',
    projects: ['Project One', 'Project Two'],
  });
  global.fetch = async (url) => {
    requests.push(new URL(url));
    return { ok: true, json: async () => ({ value: [] }) };
  };
  t.after(() => {
    Object.assign(config, originalConfig);
    global.fetch = originalFetch;
  });

  await ado.getGitRepositories();
  await ado.getPullRequests(repositoryId, me, 'creatorId');
  await ado.getPullRequests(repositoryId, me, 'reviewerId');

  assert.ok(requests[0].pathname.includes('/Project%20One/_apis/git/repositories'));
  assert.ok(requests[1].pathname.includes('/Project%20Two/_apis/git/repositories'));
  for (const [request, role] of [[requests[2], 'creatorId'], [requests[3], 'reviewerId']]) {
    assert.equal(request.searchParams.get('searchCriteria.status'), 'all');
    assert.equal(request.searchParams.get(`searchCriteria.${role}`), me);
    assert.equal(request.searchParams.get('api-version'), '7.1');
  }
});

test('Azure DevOps sync tracks open and closed PRs authored by or assigned to the user', async (t) => {
  const dbPath = require.resolve('./db');
  const syncPath = require.resolve('./azure-sync');
  const originalDb = require.cache[dbPath];
  const originalSync = require.cache[syncPath];
  const originalConfig = { ...config };
  const originalAdo = { ...ado };
  const state = new Map([
    ['lastSync', '2026-11-01T00:00:00Z'],
    ['priorityVersion', '1'],
    ['dueDateVersion', '1'],
    ['mentionsVersion', `1:${me}`],
    ['latestCommentsVersion', `1:${me}`],
  ]);
  const saved = [];
  const touches = [];
  const cleared = [];
  let localId = 100;
  const staleId = `pr:${repositoryId}:9`;

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      getSyncState: (key) => state.get(key) || null,
      setSyncState: (key, value) => state.set(key, value),
      sourceItemIds: () => [staleId],
      findItemId: () => 99,
      clearTouches: (id) => cleared.push(id),
      saveItem: (item) => { saved.push(item); return ++localId; },
      saveTouch: (id, type, date) => touches.push({ id, type, date }),
      setLatestCommentMention() {},
    },
  };
  delete require.cache[syncPath];
  Object.assign(config, {
    orgUrl: 'https://dev.azure.com/example',
    lookbackDays: 365,
    projects: ['Project One'],
  });

  const authored = {
    pullRequestId: 10,
    status: 'active',
    title: 'Authored PR',
    description: 'Change summary',
    creationDate: '2026-10-10T00:00:00Z',
    createdBy: { id: me, displayName: 'Example User' },
    reviewers: [],
  };
  const reviewed = {
    pullRequestId: 11,
    status: 'active',
    title: 'Review request',
    creationDate: '2026-10-11T00:00:00Z',
    createdBy: { id: '22222222-2222-2222-2222-222222222222', displayName: 'Another User' },
    reviewers: [{ id: me, displayName: 'Example User' }],
  };
  const completed = {
    pullRequestId: 12,
    status: 'completed',
    closedDate: '2026-10-12T00:00:00Z',
    createdBy: { id: me, displayName: 'Example User' },
    reviewers: [],
  };
  const abandoned = {
    pullRequestId: 14,
    status: 'abandoned',
    createdBy: { id: '22222222-2222-2222-2222-222222222222' },
    reviewers: [{ id: me, displayName: 'Example User' }],
  };
  Object.assign(ado, {
    getMyIdentity: async () => ({ id: me, displayName: 'Example User' }),
    getGitRepositories: async () => [{
      id: repositoryId,
      name: 'Repo One',
      project: { name: 'Project One' },
    }],
    getPullRequests: async (_repositoryId, _identityId, role) =>
      role === 'creatorId' ? [authored, completed] : [reviewed, abandoned, {
        pullRequestId: 13,
        status: 'active',
        createdBy: { id: '22222222-2222-2222-2222-222222222222' },
        reviewers: [{ id: '33333333-3333-3333-3333-333333333333' }],
      }],
    getPullRequest: async (_repositoryId, pullRequestId) => ({
      description: pullRequestId === 10 ? 'Full PR description' : 'Review description',
    }),
    queryEverAssigned: async () => [],
    queryCreatedByMe: async () => [],
    queryChangedByMe: async () => [],
    queryChangedSince: async () => [],
    getWorkItems: async () => [],
  });

  t.after(() => {
    Object.assign(config, originalConfig);
    Object.assign(ado, originalAdo);
    delete require.cache[syncPath];
    if (originalSync) require.cache[syncPath] = originalSync;
    if (originalDb) require.cache[dbPath] = originalDb;
    else delete require.cache[dbPath];
  });

  const stats = await require('./azure-sync').runSync();

  assert.equal(stats.errors.length, 0);
  assert.equal(stats.pullRequests, 4);
  assert.equal(stats.candidates, 4);
  assert.deepEqual(new Set(saved.map((item) => item.external_id)), new Set([
    `pr:${repositoryId}:10`,
    `pr:${repositoryId}:11`,
    `pr:${repositoryId}:12`,
    `pr:${repositoryId}:14`,
  ]));
  assert.equal(saved.find((item) => item.external_id.endsWith(':10')).created_by, 'Example User');
  assert.equal(saved.find((item) => item.external_id.endsWith(':10')).description, 'Full PR description');
  assert.equal(saved.find((item) => item.external_id.endsWith(':11')).assigned_to, 'Example User');
  assert.equal(saved.find((item) => item.external_id.endsWith(':10')).is_closed, false);
  assert.deepEqual(
    saved.filter((item) => item.is_closed).map(({ state }) => state).sort(),
    ['Abandoned', 'Completed']
  );
  assert.equal(saved.find((item) => item.external_id.endsWith(':12')).changed_date, '2026-10-12T00:00:00Z');
  assert.deepEqual(touches.map(({ type }) => type).sort(), ['assigned', 'assigned', 'created', 'created']);
  assert.deepEqual(cleared, [99]);
  assert.equal(saved.find((item) => item.external_id.endsWith(':10')).url,
    'https://dev.azure.com/example/Project%20One/_git/Repo%20One/pullrequest/10');
});

test('Azure DevOps PRs move between open and closed views across syncs', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'war-room-azure-pr-'));
  const store = createStore(path.join(directory, 'items.db'));
  const dbPath = require.resolve('./db');
  const syncPath = require.resolve('./azure-sync');
  const originalDb = require.cache[dbPath];
  const originalSync = require.cache[syncPath];
  const originalConfig = { ...config };
  const originalAdo = { ...ado };
  const scope = 'https://dev.azure.com/example';
  const externalId = `pr:${repositoryId}:42`;
  let status = 'active';
  let fail = false;
  const pullRequest = () => ({
    pullRequestId: 42, status, title: 'Example PR',
    creationDate: '2026-10-10T00:00:00Z',
    closedDate: status === 'active' ? null : '2026-10-12T00:00:00Z',
    createdBy: { id: me, displayName: 'Example User' },
    reviewers: [],
  });
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: store };
  delete require.cache[syncPath];
  Object.assign(config, { orgUrl: scope, lookbackDays: 365, projects: ['Project One'] });
  Object.assign(ado, {
    getMyIdentity: async () => ({ id: me, displayName: 'Example User' }),
    getGitRepositories: async () => [{ id: repositoryId, name: 'Repo', project: { name: 'Project One' } }],
    getPullRequests: async (_repo, _identity, role) => {
      if (fail) throw new Error('Temporary PR failure');
      return role === 'creatorId' ? [pullRequest()] : [];
    },
    getPullRequest: async () => pullRequest(),
    queryEverAssigned: async () => [],
    queryCreatedByMe: async () => [],
    queryChangedByMe: async () => [],
    queryChangedSince: async () => [],
    getWorkItems: async () => [],
  });
  t.after(() => {
    Object.assign(config, originalConfig);
    Object.assign(ado, originalAdo);
    if (originalSync) require.cache[syncPath] = originalSync;
    else delete require.cache[syncPath];
    if (originalDb) require.cache[dbPath] = originalDb;
    else delete require.cache[dbPath];
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const sync = require('./azure-sync');
  await sync.runSync();
  const id = store.findItemId('azure-devops', scope, externalId);
  assert.deepEqual(store.queryItems({ inspection: true }).items.map((item) => item.id), [id]);

  status = 'completed';
  await sync.runSync();
  assert.equal(store.queryItems({ inspection: true }).total, 0);
  assert.deepEqual(store.queryItems({ inspection: true, closedOnly: true }).items.map((item) => item.id), [id]);
  assert.equal(store.getItem(id).state, 'Completed');

  fail = true;
  await assert.rejects(sync.runSync(), /Temporary PR failure/);
  assert.equal(store.queryItems({ inspection: true, closedOnly: true }).total, 1);
  fail = false;
  status = 'active';
  await sync.runSync();
  assert.deepEqual(store.queryItems({ inspection: true }).items.map((item) => item.id), [id]);
  assert.equal(store.queryItems({ inspection: true, closedOnly: true }).total, 0);
});
