'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const config = require('./config');
const github = require('./github');
const { renderMarkdown } = require('./markdown');

function withGitHubConfig(t, overrides = {}) {
  const original = { ghToken: config.ghToken, ghHost: config.ghHost, ghRepos: config.ghRepos, lookbackDays: config.lookbackDays };
  Object.assign(config, { ghToken: 'test-token', ghHost: 'github.com', ghRepos: [], lookbackDays: 365, ...overrides });
  t.after(() => Object.assign(config, original));
}

function withFetch(t, handler) {
  const original = global.fetch;
  global.fetch = handler;
  t.after(() => { global.fetch = original; });
}

test('mentionsMe matches whole logins only', () => {
  assert.ok(github.mentionsMe('ping @me please', 'me'));
  assert.ok(github.mentionsMe('(@Me) thanks', 'me'));
  assert.ok(!github.mentionsMe('email me@example.com', 'example.com'));
  assert.ok(!github.mentionsMe('@me-2 is someone else', 'me'));
  assert.ok(!github.mentionsMe('', 'me'));
  assert.ok(!github.mentionsMe('@me', ''));
});

test('repoFromApiUrl extracts owner/repo from the search payload', () => {
  assert.equal(github.repoFromApiUrl('https://api.github.com/repos/octo/hello'), 'octo/hello');
  assert.equal(github.repoFromApiUrl('https://ghe.example.com/api/v3/repos/a/b'), 'a/b');
  assert.equal(github.repoFromApiUrl(''), '');
});

test('searchIssues searches both item types with repository filters and independent pagination', async (t) => {
  withGitHubConfig(t, { ghRepos: ['octo/one', 'octo/two'] });
  const queries = [];
  withFetch(t, async (url) => {
    const parsed = new URL(url);
    const query = parsed.searchParams.get('q');
    queries.push(query);
    assert.match(query, /is:(issue|pull-request)/);
    const page = Number(parsed.searchParams.get('page'));
    const items = query.includes('is:pull-request')
      ? [{ number: 200, pull_request: {} }]
      : page === 1 ? Array.from({ length: 100 }, (_, i) => ({ number: i })) : [{ number: 100 }];
    return { ok: true, json: async () => ({ items, incomplete_results: false }) };
  });
  const { items, incomplete } = await github.searchIssues('involves:@me updated:>=2026-01-01');
  assert.equal(items.length, 102);
  assert.ok(items.some((item) => item.pull_request));
  assert.equal(incomplete, false);
  assert.deepEqual(queries, [
    'involves:@me updated:>=2026-01-01 is:issue repo:octo/one repo:octo/two',
    'involves:@me updated:>=2026-01-01 is:issue repo:octo/one repo:octo/two',
    'involves:@me updated:>=2026-01-01 is:pull-request repo:octo/one repo:octo/two',
  ]);
});

for (const qualifiers of ['assignee:@me', 'author:@me']) {
  test(`searchIssues includes an item type for ${qualifiers} without repository filters`, async (t) => {
    withGitHubConfig(t);
    const queries = [];
    withFetch(t, async (url) => {
      queries.push(new URL(url).searchParams.get('q'));
      return { ok: true, json: async () => ({ items: [], incomplete_results: false }) };
    });
    assert.deepEqual(await github.searchIssues(qualifiers), { items: [], incomplete: false });
    assert.deepEqual(queries, [`${qualifiers} is:issue`, `${qualifiers} is:pull-request`]);
  });
}

test('searchIssues preserves incomplete results from either type or an earlier page', async (t) => {
  withGitHubConfig(t);
  withFetch(t, async (url) => {
    const parsed = new URL(url);
    const firstIssuePage = parsed.searchParams.get('q').includes('is:issue') && parsed.searchParams.get('page') === '1';
    return {
      ok: true,
      json: async () => ({
        items: firstIssuePage ? Array.from({ length: 100 }, (_, number) => ({ number })) : [],
        incomplete_results: firstIssuePage,
      }),
    };
  });
  assert.equal((await github.searchIssues('assignee:@me')).incomplete, true);
});

test('searchIssues reports the result cap without skipping the other item type', async (t) => {
  withGitHubConfig(t);
  const requests = [];
  withFetch(t, async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    const items = parsed.searchParams.get('q').includes('is:issue')
      ? Array.from({ length: 100 }, (_, number) => ({ number }))
      : [{ number: 1001, pull_request: {} }];
    return { ok: true, json: async () => ({ items, incomplete_results: false }) };
  });
  const result = await github.searchIssues('assignee:@me');
  assert.equal(result.incomplete, true);
  assert.equal(result.items.length, 1001);
  assert.equal(requests.length, 11);
  assert.match(requests.at(-1).searchParams.get('q'), /is:pull-request/);
  assert.equal(requests.at(-1).searchParams.get('page'), '1');
});

test('searchIssues surfaces GitHub failures instead of returning a partial success', async (t) => {
  withGitHubConfig(t);
  withFetch(t, async (url) => new URL(url).searchParams.get('q').includes('is:issue')
    ? { ok: true, json: async () => ({ items: [], incomplete_results: false }) }
    : { ok: false, status: 403, text: async () => 'Resource not accessible' });
  await assert.rejects(github.searchIssues('assignee:@me'), /GitHub request failed 403.*Resource not accessible/);
});

test('getMyIdentity requires a login', async (t) => {
  withGitHubConfig(t);
  withFetch(t, async () => ({ ok: true, json: async () => ({}) }));
  await assert.rejects(github.getMyIdentity(), /did not return your login/);
});

test('markdown rendering escapes HTML, keeps links safe, and highlights my login', () => {
  const html = renderMarkdown('# Hi\n\n<script>alert(1)</script> **bold** `x < y`\n\n- [ok](https://example.com)\n- [bad](javascript:alert(1))\n\ncc @ThatBCGuy', 'thatbcguy');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<code>x &lt; y</code>'));
  assert.ok(html.includes('<a href="https://example.com"'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('<span class="my-name">@ThatBCGuy</span>'));
  assert.equal(renderMarkdown('   '), '');
  assert.equal(renderMarkdown(null), '');
});

test('GitHub sync discovers items, records touches, and scans comments for mentions', async (t) => {
  const storePath = require.resolve('./db');
  const syncPath = require.resolve('./github-sync');
  const originalStore = require.cache[storePath];
  const originalGithub = { ...github };
  withGitHubConfig(t);

  const state = new Map();
  const saved = [];
  const touches = [];
  const latestComments = [];
  const store = {
    getSyncState: (key, provider, scope) => state.get(`${provider}|${scope}|${key}`) || null,
    setSyncState: (key, value, provider, scope) => state.set(`${provider}|${scope}|${key}`, value),
    saveItem: (item) => { saved.push(item); return saved.length; },
    saveTouch: (id, type, date) => touches.push({ id, type, date }),
    sourceScopes: () => [],
    sourceItemIds: () => [],
    findItemId: () => null,
    setLatestCommentMention: (id, identityId, mentioned) => latestComments.push({ id, identityId, mentioned }),
  };
  require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: store };
  delete require.cache[syncPath];

  const issue = (repo, number, overrides = {}) => ({
    repository_url: `https://api.github.com/repos/${repo}`,
    number,
    title: `Item ${number}`,
    state: 'open',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
    html_url: `https://github.com/${repo}/issues/${number}`,
    labels: [{ name: 'bug' }],
    ...overrides,
  });
  const assignedItem = issue('octo/one', 1, { assignees: [{ login: 'other' }, { login: 'me' }] });
  const createdItem = issue('octo/one', 2, { user: { login: 'me' } });
  const prItem = issue('octo/two', 3, { pull_request: {}, state: 'closed', user: { login: 'other' } });

  Object.assign(github, {
    getMyIdentity: async () => ({ id: '7', login: 'me', displayName: 'Me' }),
    searchIssues: async (qualifiers) => {
      if (qualifiers.startsWith('assignee:')) return { items: [assignedItem], incomplete: false };
      if (qualifiers.startsWith('author:')) return { items: [createdItem], incomplete: false };
      return { items: [assignedItem, prItem], incomplete: false };
    },
    getComments: async (repo, number) => {
      if (repo === 'octo/one' && Number(number) === 1) {
        return [
          { user: { login: 'other' }, body: 'cc @me', created_at: '2026-02-02T00:00:00Z' },
          { user: { login: 'me' }, body: 'on it', created_at: '2026-02-03T00:00:00Z' },
        ];
      }
      return [{ user: { login: 'other' }, body: 'no mention', created_at: '2026-02-02T00:00:00Z' }];
    },
  });

  t.after(() => {
    Object.assign(github, originalGithub);
    delete require.cache[syncPath];
    if (originalStore) require.cache[storePath] = originalStore;
    else delete require.cache[storePath];
  });

  const sync = require('./github-sync');
  const stats = await sync.runSync();

  assert.equal(stats.errors.length, 0);
  assert.equal(stats.candidates, 3);
  assert.equal(stats.upserted, 3);

  const savedAssigned = saved.find((item) => item.external_id === '1');
  assert.equal(savedAssigned.provider, 'github');
  assert.equal(savedAssigned.source_scope, 'github.com/octo/one');
  assert.equal(savedAssigned.assigned_to, 'me');
  assert.equal(savedAssigned.tags, 'bug');
  assert.equal(savedAssigned.is_closed, false);
  const savedPr = saved.find((item) => item.external_id === '3');
  assert.equal(savedPr.type, 'Pull Request');
  assert.equal(savedPr.state, 'Closed');
  assert.equal(savedPr.is_closed, true);
  assert.equal(savedPr.project, 'octo/two');

  const assignedLocalId = saved.indexOf(savedAssigned) + 1;
  const createdLocalId = saved.indexOf(saved.find((item) => item.external_id === '2')) + 1;
  assert.ok(touches.some((touch) => touch.id === assignedLocalId && touch.type === 'assigned'));
  assert.ok(touches.some((touch) => touch.id === createdLocalId && touch.type === 'created'));
  assert.ok(touches.some((touch) => touch.id === assignedLocalId && touch.type === 'commented' && touch.date === '2026-02-03T00:00:00Z'));
  assert.ok(touches.some((touch) => touch.id === assignedLocalId && touch.type === 'mentioned' && touch.date === '2026-02-02T00:00:00Z'));

  // The latest comment on item 1 is mine, so it does not mention me.
  assert.ok(latestComments.some((entry) => entry.id === assignedLocalId && entry.identityId === 'me' && entry.mentioned === false));

  assert.equal(state.get('github||lastSync') != null, true);
  assert.equal(state.get('github||mentionsVersion'), '1:me');
  assert.equal(state.get('github|github.com/octo/one|meDisplayName'), 'me');
});

test('GitHub history combines comments and events into revisions', async (t) => {
  const originalGithub = { ...github };
  withGitHubConfig(t);
  Object.assign(github, {
    getComments: async () => [
      { user: { login: 'me' }, body: '**hello**', created_at: '2026-02-01T00:00:00Z' },
    ],
    getEvents: async () => [
      { event: 'assigned', actor: { login: 'boss' }, assignee: { login: 'me' }, created_at: '2026-02-02T00:00:00Z' },
      { event: 'subscribed', actor: { login: 'other' }, created_at: '2026-02-03T00:00:00Z' },
    ],
  });
  t.after(() => Object.assign(github, originalGithub));

  const sync = require('./github-sync');
  const revisions = await sync.getHistory(
    { source_scope: 'github.com/octo/one', external_id: '1' }, 'me');
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].by, 'boss');
  assert.deepEqual(revisions[0].changes, [{ field: 'Assigned to', from: null, to: 'me' }]);
  assert.equal(revisions[1].comment, '<p><strong>hello</strong></p>');
  assert.ok(revisions[0].rev > revisions[1].rev);
});
