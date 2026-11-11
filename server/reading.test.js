'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const exportedRouter = require('./reading');
const { createRouter } = exportedRouter;
const { createStore } = require('./reading-store');
const { createProviders } = require('./reading-providers');
const { render } = require('./reading-markdown');
const { LIMITS, canonical, resolveRelative, createRequest } = require('./reading-common');

const configForTest = () => ({
  orgUrl: 'https://dev.azure.com/example', authHeader: 'Basic test-ado-credential', pat: 'test-ado-credential',
  ghHost: 'github.com', ghToken: 'test-github-credential',
});
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const response = (value, status = 200, headers = {}) => new Response(
  Buffer.isBuffer(value) ? value : JSON.stringify(value), { status, headers });

async function setup(t, options = {}) {
  const store = options.store || createStore(':memory:');
  const app = express();
  app.use('/api/reading', createRouter({ config: configForTest(), ...options, store }));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    server.closeAllConnections();
    try {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      store.close();
    }
  });
  const base = `http://127.0.0.1:${server.address().port}/api/reading`;
  async function api(route, method = 'GET', body) {
    const res = await fetch(base + route, {
      method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = res.headers.get('content-type')?.startsWith('image/') ? Buffer.from(await res.arrayBuffer()) : await res.json();
    return { status: res.status, data, headers: res.headers };
  }
  return { api, store, base };
}

function adoFixture(type = 'codeWiki') {
  const calls = [];
  let failure = 0;
  const fetch = async (address, options) => {
    const url = new URL(address);
    calls.push({ url, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Basic test-ado-credential');
    if (failure) return response({ message: 'never expose source-body tokens' }, failure);
    if (url.pathname.endsWith('/_apis/projects')) return response({ value: [{ id: 'p1', name: 'Documentation' }, { id: 'p2', name: 'Other' }] });
    if (url.pathname.endsWith('/_apis/wiki/wikis')) return response({ value: [{
      id: 'wiki-one', name: 'Team Wiki', type, repositoryId: 'repository-id', mappedPath: type === 'codeWiki' ? '/docs' : '/',
      versions: type === 'codeWiki' ? [{ version: 'release/docs', versionType: 'branch' }] : [],
    }] });
    if (url.pathname.endsWith('/pages')) {
      if (url.searchParams.get('includeContent') === 'true') return response({
        path: url.searchParams.get('path'), content: '# Start\n\nFull content needle only in body.\n\n[Next](Next.md#install)\n\n![shot](../.attachments/shot.png)\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nalert("safe")\n```\n',
      });
      return response({ path: '/', subPages: [{ path: '/Guide', subPages: [{ path: '/Guide/Start', subPages: [] }] }] });
    }
    if (url.pathname.endsWith('/items')) return response(png);
    throw new Error('Unexpected mocked ADO endpoint');
  };
  return { fetch, calls, setFailure(value) { failure = value; } };
}

function githubFixture() {
  const calls = [];
  let failure = 0;
  let clones = 0;
  let now = Date.now();
  const files = {
    '/Home.md': Buffer.from('# Home\n\nWelcome to the wiki.\n\n[Guide](Guides/Install.md#setup)\n\n![icon](images/icon.png)'),
    '/Guides/Install.md': Buffer.from('# Setup\n\nBody-only keyword: telescope.\n\n[Home](../Home)\n\n[[Home page|Home]]'),
    '/images/icon.png': png,
    '/README.txt': Buffer.from('not a wiki page'),
  };
  const fetch = async (address, options) => {
    const url = new URL(address);
    calls.push({ url, options });
    assert.equal(options.redirect, 'manual');
    if (failure) return response({}, failure);
    if (url.hostname === 'api.github.com') {
      assert.equal(options.headers.Authorization, 'Bearer test-github-credential');
      if (url.pathname === '/search/repositories') return response({ items: [{ full_name: 'team/docs', name: 'docs' }] });
      if (/^\/repos\/team\/(?:docs|second)$/.test(url.pathname)) return response({ name: url.pathname.split('/').pop(), has_wiki: true });
    }
    if (url.hostname === 'github.com' && url.pathname.includes('.wiki.git/')) {
      assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('x-access-token:test-github-credential').toString('base64'));
      return response(Buffer.from('mock git response'));
    }
    throw new Error('Unexpected mocked GitHub endpoint');
  };
  const git = {
    async clone(options) {
      clones++;
      assert.equal(options.url, 'https://github.com/team/docs.wiki.git');
      assert.equal(options.noCheckout, true);
      assert.equal(options.depth, 1);
      assert.doesNotMatch(options.url, /credential|@/);
      await options.http.request({ url: options.url + '/info/refs?service=git-upload-pack', method: 'GET' });
      await options.http.request({ url: options.url + '/git-upload-pack', method: 'POST', body: [Buffer.from('read negotiation')] });
    },
    TREE: value => value,
    async walk({ map }) {
      await map('.', [{ type: async () => 'tree' }]);
      for (const name of Object.keys(files)) {
        await map(name.slice(1), [{ type: async () => 'blob', oid: async () => name }]);
      }
    },
    async readBlob({ oid }) { return { blob: files[oid] }; },
  };
  return { fetch, git, fsFactory: () => ({}), calls, now: () => now,
    get clones() { return clones; }, setFailure(value) { failure = value; }, expire() { now += 60001; } };
}

const addAdo = api => api('/connections', 'POST', { provider: 'azure-devops', target: 'p1', wikiId: 'wiki-one' });
const addGithub = api => api('/connections', 'POST', { provider: 'github', target: 'team/docs', wikiId: 'team/docs' });

test('Azure DevOps discovery is explicit; codeWiki version, tree, page, image, and content search use read-only native APIs', async t => {
  const fixture = adoFixture();
  const { api } = await setup(t, { fetch: fixture.fetch });
  assert.deepEqual((await api('/connections')).data, { connections: [] });
  assert.equal(fixture.calls.length, 0);
  assert.equal((await api('/targets?provider=azure-devops')).status, 400);
  assert.equal(fixture.calls.length, 0);
  const targets = await api('/targets?provider=azure-devops&q=doc');
  assert.deepEqual(targets.data.targets, [{ id: 'p1', name: 'Documentation', label: 'Documentation' }]);
  const wikis = await api('/wikis?provider=azure-devops&target=p1');
  assert.equal(wikis.data.wikis[0].id, 'wiki-one');
  assert.equal(wikis.data.wikis[0].metadata, undefined);
  const added = await addAdo(api);
  assert.equal(added.status, 201);
  const connection = added.data.connection;
  assert.equal(connection.scope, 'https://dev.azure.com/example');
  assert.equal(connection.fingerprint, undefined);
  assert.equal(connection.position, 0);
  const tree = await api(`/connections/${connection.id}/tree`);
  assert.deepEqual(tree.data.pages.map(p => p.path), ['/Guide', '/Guide/Start']);
  assert.ok(tree.data.fetchedAt);
  const page = await api(`/connections/${connection.id}/page?path=%2FGuide%2FStart`);
  assert.equal(page.status, 200);
  assert.equal(page.data.path, '/Guide/Start');
  assert.match(page.data.html, /<h1 id="wiki-heading-start">/);
  assert.match(page.data.html, /page=%2FGuide%2FNext#wiki-heading-install/);
  assert.match(page.data.html, /\/api\/reading\/connections\/\d+\/image\?path=%2F.attachments%2Fshot.png/);
  assert.match(page.data.html, /<table>/);
  assert.match(page.data.html, /<pre><code class="language-js">/);
  const image = await api(`/connections/${connection.id}/image?path=%2F.attachments%2Fshot.png`);
  assert.equal(image.status, 200);
  assert.deepEqual(image.data, png);
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(image.headers.get('cache-control'), 'no-store');
  const itemCall = fixture.calls.find(call => call.url.pathname.endsWith('/items'));
  assert.equal(itemCall.url.searchParams.get('path'), '/docs/.attachments/shot.png');
  assert.equal(itemCall.url.searchParams.get('versionDescriptor.version'), 'release/docs');
  for (const call of fixture.calls.filter(c => c.url.pathname.endsWith('/pages'))) {
    assert.equal(call.url.searchParams.get('versionDescriptor.version'), 'release/docs');
  }
  const search = await api(`/search?q=needle&connectionId=${connection.id}`);
  assert.equal(search.status, 200);
  assert.equal(search.data.results.length, 2);
  assert.match(search.data.results[0].excerpt, /needle/);
  assert.ok(search.data.results.every(r => !r.title.includes('needle')));
});

test('native projectWiki pages and attachments do not acquire a codeWiki mapped path or branch', async t => {
  const fixture = adoFixture('projectWiki');
  const { api } = await setup(t, { fetch: fixture.fetch });
  const { data } = await addAdo(api);
  assert.equal((await api(`/connections/${data.connection.id}/image?path=%2F.attachments%2Fa.png`)).status, 200);
  const call = fixture.calls.find(c => c.url.pathname.endsWith('/items'));
  assert.equal(call.url.searchParams.get('path'), '/.attachments/a.png');
  assert.equal(call.url.searchParams.has('versionDescriptor.version'), false);
});

test('GitHub discovers selected repositories only, clones wiki read-only without disk/token URLs, and searches bodies and local images', async t => {
  const fixture = githubFixture();
  const { api } = await setup(t, fixture);
  const targets = await api('/targets?provider=github&q=docs');
  assert.deepEqual(targets.data.targets, [{ id: 'team/docs', name: 'docs', label: 'team/docs' }]);
  const wikis = await api('/wikis?provider=github&target=team%2Fdocs');
  assert.equal(wikis.data.wikis[0].url, 'https://github.com/team/docs/wiki');
  assert.equal(fixture.clones, 0);
  const added = await addGithub(api);
  assert.equal(added.status, 201);
  const id = added.data.connection.id;
  const tree = await api(`/connections/${id}/tree`);
  assert.deepEqual(tree.data.pages.map(p => p.path), ['/Home', '/Guides/Install']);
  assert.equal(fixture.clones, 1);
  const page = await api(`/connections/${id}/page?path=%2FHome`);
  assert.match(page.data.html, /page=%2FGuides%2FInstall#wiki-heading-setup/);
  assert.match(page.data.html, /image\?path=%2Fimages%2Ficon.png/);
  assert.equal(page.data.url, 'https://github.com/team/docs/wiki/Home');
  const image = await api(`/connections/${id}/image?path=%2Fimages%2Ficon.png`);
  assert.deepEqual(image.data, png);
  const search = await api('/search?q=telescope');
  assert.equal(search.data.results.length, 1);
  assert.equal(search.data.results[0].path, '/Guides/Install');
  assert.ok(!search.data.results[0].title.includes('telescope'));
  assert.equal(fixture.clones, 1);
  assert.equal(fixture.calls.filter(c => c.url.hostname === 'github.com').length, 2);
  assert.equal((await api(`/connections/${id}/page?path=%2FHome&refresh=1`)).status, 200);
  assert.equal(fixture.clones, 2);
  fixture.expire();
  assert.equal((await api(`/connections/${id}/tree`)).status, 200);
  assert.equal(fixture.clones, 3);
});

test('real isomorphic-git clones an offline smart-HTTP wiki pack using only in-memory files', async () => {
  const git = require('isomorphic-git');
  const { Volume, createFsFromVolume } = require('memfs');
  const sourceFs = createFsFromVolume(new Volume());
  const dir = '/source';
  await git.init({ fs: sourceFs, dir, defaultBranch: 'master' });
  const home = await git.writeBlob({ fs: sourceFs, dir, blob: Buffer.from('# Home\n\nOffline packed content.') });
  const icon = await git.writeBlob({ fs: sourceFs, dir, blob: png });
  const images = await git.writeTree({ fs: sourceFs, dir, tree: [{ mode: '100644', path: 'icon.png', oid: icon, type: 'blob' }] });
  const root = await git.writeTree({ fs: sourceFs, dir, tree: [
    { mode: '100644', path: 'Home.md', oid: home, type: 'blob' },
    { mode: '040000', path: 'images', oid: images, type: 'tree' },
  ] });
  const person = { name: 'Offline Test', email: 'test@example.invalid', timestamp: 1700000000, timezoneOffset: 0 };
  const head = await git.writeCommit({ fs: sourceFs, dir, commit: { tree: root, parent: [], author: person, committer: person, message: 'Fixture' } });
  const { packfile } = await git.packObjects({ fs: sourceFs, dir, oids: [head, root, images, home, icon] });
  function pkt(value) {
    const body = Buffer.from(value);
    return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body]);
  }
  const advertisement = Buffer.concat([
    pkt('# service=git-upload-pack\n'), Buffer.from('0000'),
    pkt(`${head} HEAD\0multi_ack_detailed side-band-64k shallow ofs-delta symref=HEAD:refs/heads/master\n`),
    pkt(`${head} refs/heads/master\n`), Buffer.from('0000'),
  ]);
  const packed = Buffer.concat([
    pkt(`shallow ${head}\n`), Buffer.from('0000'), pkt('NAK\n'),
    pkt(Buffer.concat([Buffer.from([1]), Buffer.from(packfile)])), Buffer.from('0000'),
  ]);
  const calls = [];
  const providers = createProviders(configForTest(), { fetch: async (url, opts) => {
    calls.push({ url, opts });
    assert.equal(new URL(url).hostname, 'github.com');
    assert.equal(opts.redirect, 'manual');
    return response(opts.method === 'POST' ? packed : advertisement, 200, {
      'content-type': opts.method === 'POST' ? 'application/x-git-upload-pack-result' : 'application/x-git-upload-pack-advertisement',
    });
  } });
  const connection = { repository: 'team/docs', url: 'https://github.com/team/docs/wiki' };
  assert.deepEqual(await providers.github.tree(connection), [{ path: '/Home', title: 'Home' }]);
  assert.equal((await providers.github.page(connection, '/Home')).content, '# Home\n\nOffline packed content.');
  assert.deepEqual(await providers.github.image(connection, '/images/icon.png'), png);
  assert.equal(calls.length, 2);
  assert.equal(calls.filter(c => c.opts.method === 'POST').length, 1);
  assert.doesNotMatch(calls.map(c => c.url).join(' '), /credential|@/);
});

test('remote failures expose timestamped stale cache, while permission failures purge cache and remain errors', async t => {
  const fixture = adoFixture();
  const { api, store } = await setup(t, fixture);
  const id = (await addAdo(api)).data.connection.id;
  const first = await api(`/connections/${id}/page?path=%2FGuide`);
  fixture.setFailure(503);
  const stale = await api(`/connections/${id}/page?path=%2FGuide`);
  assert.equal(stale.status, 200);
  assert.match(stale.data.warning, /Stale cached page.*503/);
  assert.equal(stale.data.fetchedAt, first.data.fetchedAt);
  assert.equal((await api(`/connections/${id}/page?path=%2FUncached`)).status, 502);
  const staleSearch = await api(`/search?q=needle&connectionId=${id}`);
  assert.equal(staleSearch.status, 200);
  assert.ok(staleSearch.data.warnings.some(w => w.includes('Stale')));
  fixture.setFailure(403);
  const denied = await api(`/connections/${id}/page?path=%2FGuide`);
  assert.equal(denied.status, 403);
  assert.match(denied.data.error, /Wiki \(Read\)/);
  assert.equal(store.cached(id, 'page', '/Guide'), null);
  assert.equal(store.cached(id, 'tree', ''), null);
  assert.equal((await api('/connections')).data.connections.length, 1);
  assert.equal((await api(`/search?q=needle&connectionId=${id}`)).status, 403);
  fixture.setFailure(503);
  assert.equal((await api(`/connections/${id}/page?path=%2FGuide`)).status, 502);
});

test('GitHub TTL expiration fetches again; outages are explicit and a 404 never returns cached wiki contents', async t => {
  const fixture = githubFixture();
  const { api } = await setup(t, fixture);
  const id = (await addGithub(api)).data.connection.id;
  const first = await api(`/connections/${id}/page?path=%2FHome`);
  fixture.expire();
  fixture.setFailure(503);
  const stale = await api(`/connections/${id}/page?path=%2FHome`);
  assert.equal(stale.status, 200);
  assert.equal(stale.data.fetchedAt, first.data.fetchedAt);
  assert.match(stale.data.warning, /503/);
  fixture.setFailure(404);
  const denied = await api(`/connections/${id}/page?path=%2FHome`);
  assert.equal(denied.status, 404);
  assert.match(denied.data.error, /classic PAT repo scope/);
  assert.doesNotMatch(denied.data.error, /test-github-credential/);
});

test('saved collection CRUD is local, scoped to credentials, ordered, persistent, and keeps inaccessible entries', async t => {
  const filename = path.join(process.cwd(), `.reading-test-${process.pid}-${Date.now()}.db`);
  let disk = createStore(filename);
  const fixture = adoFixture();
  const config = configForTest();
  const { api, store } = await setup(t, { ...fixture, store: disk, config });
  t.after(() => { for (const suffix of ['', '-wal', '-shm']) fs.rmSync(filename + suffix, { force: true }); });
  const first = (await addAdo(api)).data.connection;
  assert.equal((await addAdo(api)).status, 409);
  // A second target is a separate saved project even when the mocked wiki IDs match.
  const second = (await api('/connections', 'POST', { provider: 'azure-devops', target: 'p2', wikiId: 'wiki-one' })).data.connection;
  const count = fixture.calls.length;
  const moved = await api(`/connections/${second.id}`, 'PATCH', { name: 'My saved wiki', position: 0 });
  assert.equal(moved.data.connection.name, 'My saved wiki');
  assert.deepEqual((await api('/connections')).data.connections.map(c => c.id), [second.id, first.id]);
  assert.equal(fixture.calls.length, count);
  config.authHeader = 'Basic changed-context';
  assert.equal((await api(`/connections/${first.id}/tree`)).status, 409);
  assert.equal((await api('/connections')).data.connections.length, 2);
  assert.equal(fixture.calls.length, count);
  config.authHeader = 'Basic test-ado-credential';
  config.orgUrl = 'https://dev.azure.com/different';
  assert.equal((await api(`/connections/${first.id}/tree`)).status, 409);
  assert.equal((await api(`/connections/${first.id}`, 'PATCH', { name: 'Still visible' })).status, 200);
  // A second SQLite connection verifies the data was persisted, not kept only in memory.
  disk = createStore(filename);
  assert.equal(disk.get(first.id).name, 'Still visible');
  assert.equal(disk.list().length, 2);
  disk.close();
  const deleted = await api(`/connections/${second.id}`, 'DELETE');
  assert.deepEqual(deleted.data, { removed: true });
  assert.equal(store.list()[0].position, 0);
  assert.equal(store.cached(second.id, 'tree', ''), null);
  assert.equal(fixture.calls.length, count);
});

test('request and path validation reject traversal, invalid updates, missing selections, and oversized JSON', async t => {
  const fixture = adoFixture();
  const { api, base } = await setup(t, fixture);
  const id = (await addAdo(api)).data.connection.id;
  for (const input of ['../secret', '/a/../../b', '/a\\b', '/%2e%2e/secret', 'https://other.invalid/image']) {
    const result = await api(`/connections/${id}/page?path=${encodeURIComponent(input)}`);
    // URL-shaped strings cannot traverse even if treated as a literal wiki page name.
    if (!input.startsWith('https:')) assert.equal(result.status, 400);
  }
  assert.equal((await api('/connections/1/tree?ignored=x')).status, 200);
  assert.equal((await api('/connections/99/tree')).status, 404);
  assert.equal((await api('/connections/no/tree')).status, 400);
  assert.equal((await api('/targets?provider=unknown&q=a')).status, 400);
  assert.equal((await api('/targets?provider=github&q[x]=a')).status, 400);
  assert.equal((await api('/wikis?provider=github&target=..%2Frepo')).status, 400);
  assert.equal((await api('/wikis?provider=azure-devops&target=..')).status, 400);
  assert.equal((await api('/connections', 'POST', { provider: 'azure-devops', target: 'p1', wikiId: 'not-found' })).status, 404);
  for (const body of [{ name: '' }, { position: -1 }, { position: 0.1 }, { position: 100 }, { url: 'https://other' }, {}]) {
    assert.equal((await api(`/connections/${id}`, 'PATCH', body)).status, 400);
  }
  assert.equal((await api('/search?q=')).status, 400);
  const large = await api(`/connections/${id}`, 'PATCH', { name: 'x'.repeat(17000) });
  assert.equal(large.status, 413);
  const invalidJSON = await fetch(base + '/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(invalidJSON.status, 400);
});

test('all-saved search reports partial source failures and never returns success when every source fails', async t => {
  const fixture = adoFixture();
  const gh = githubFixture();
  const adoProviders = createProviders(configForTest(), fixture);
  const ghProviders = createProviders(configForTest(), gh);
  const { api } = await setup(t, { providers: { 'azure-devops': adoProviders['azure-devops'], github: ghProviders.github } });
  await addAdo(api);
  const ghId = (await addGithub(api)).data.connection.id;
  fixture.setFailure(403);
  const partial = await api('/search?q=telescope');
  assert.equal(partial.status, 200);
  assert.equal(partial.data.results.length, 1);
  assert.ok(partial.data.warnings.some(w => w.includes('403')));
  gh.expire();
  gh.setFailure(403);
  const denied = await api('/search?q=needle');
  assert.equal(denied.status, 403);
  assert.ok(denied.data.error);
  assert.equal(denied.data.results, undefined);
  assert.equal((await api(`/connections/${ghId}/tree`)).status, 403);
});

test('Markdown preserves structure, page/heading links and images while blocking raw HTML and unsafe destinations', () => {
  const connection = { id: 7, provider: 'github', url: 'https://github.com/team/docs/wiki' };
  const html = render(`# Setup

# Setup

[Local](../Home.md#setup)
[Absolute](https://github.com/team/docs/wiki/Home#setup)
[External](https://example.com/docs)
[Bad](javascript:alert(1))
[Credentials](https://token@example.com/a)
[Escape](../../secret)

[[Home label|../Home]]

![OK](../images/icon.png)
![External](https://evil.example/track.png)
![Bad](data:image/svg+xml,bad)

<script>alert("x")</script>

- one
- two

| A | B |
|---|---|
| x | y |

\`\`\`html
<img src=x onerror=alert(1)>
\`\`\`
`, connection, '/Guides/Install');
  assert.match(html, /id="wiki-heading-setup"/);
  assert.match(html, /id="wiki-heading-setup-1"/);
  assert.equal((html.match(/page=%2FHome/g) || []).length, 3);
  assert.match(html, /%2FHome#wiki-heading-setup/);
  assert.match(html, /<ul>/);
  assert.match(html, /<table>/);
  assert.match(html, /language-html/);
  assert.match(html, /src="\/api\/reading\/connections\/7\/image\?path=%2Fimages%2Ficon.png"/);
  assert.doesNotMatch(html, /<script|<img src=x|href="javascript:|href="https:\/\/token@|src="https:\/\/evil|src="data:|page=.*secret/);
  assert.match(html, /rel="noreferrer noopener"/);
  assert.equal(canonical('//a///b/'), '/a/b');
  assert.equal(resolveRelative('/Guide/Start', '../Home'), '/Home');
  assert.throws(() => resolveRelative('/Home', '../secret'));
  const aliases = render('[Next](Page-name.md)\n\n[[Home page]]\n\n# A\n# A-1\n# A', connection, '/Home', [
    { path: '/Page name' }, { path: '/Home-page' },
  ]);
  assert.match(aliases, /page=%2FPage%20name/);
  assert.match(aliases, /page=%2FHome-page/);
  assert.match(aliases, /id="wiki-heading-a-2"/);
});

test('wiki headings cannot shadow reader controls and same-wiki absolute images remain local', () => {
  const connection = { id: 7, provider: 'github', url: 'https://github.com/team/docs/wiki' };
  const html = render(`# Search panel

[Jump](#search-panel)

![Diagram](https://github.com/team/docs/wiki/images/diagram.png)
![External](https://other.example/images/diagram.png)
`, connection, '/Home');
  assert.match(html, /id="wiki-heading-search-panel"/);
  assert.doesNotMatch(html, /id="search-panel"/);
  assert.match(html, /href="#wiki-heading-search-panel"/);
  assert.match(html, /src="\/api\/reading\/connections\/7\/image\?path=%2Fimages%2Fdiagram.png"/);
  assert.doesNotMatch(html, /src="https:/);
});

test('TOC navigation uses real, nested heading anchors and ignores duplicate markers and code headings', () => {
  const connection = { id: 7, provider: 'azure-devops', url: 'https://dev.azure.com/example/project/_wiki/wikis/wiki' };
  const html = render([
    'Before the contents.', '[[_TOC_]]', '', '# Overview', '', '### **Setup** and `tools`', '',
    '## Repeated', '', '## Repeated', '', '# 日本語', '',
    '```md', '# Not a heading', '[[_TOC_]]', '```', '', '[[_TOC_]]',
  ].join('\n'), connection, '/Guide');
  const nav = html.match(/<nav[\s\S]*?<\/nav>/)[0];
  assert.equal((html.match(/<nav /g) || []).length, 1);
  assert.match(html, /<p>Before the contents\.<\/p>\n<nav/);
  assert.match(nav, /<a href="#wiki-heading-overview">Overview<\/a><ul><li><a href="#wiki-heading-setup-and-tools">Setup and tools<\/a>/);
  assert.match(nav, /href="#wiki-heading-repeated"/);
  assert.match(nav, /href="#wiki-heading-repeated-1"/);
  assert.match(nav, /href="#wiki-heading-%E6%97%A5%E6%9C%AC%E8%AA%9E">日本語/);
  assert.doesNotMatch(nav, /Not a heading|<strong>|<code>/);
  for (const match of nav.matchAll(/href="#([^"]+)"/g)) {
    assert.ok(html.includes(`id="${decodeURIComponent(match[1])}"`));
  }
  assert.match(html, /<pre><code class="language-md"># Not a heading\n\[\[_TOC_\]\]/);
});

test('TOSP navigation includes only descendants, preserves source order, and safely groups nested child pages', () => {
  const connection = { id: 7, provider: 'azure-devops', url: 'https://dev.azure.com/example/project/_wiki/wikis/wiki' };
  const pages = [
    { path: '/Guide', title: 'Current page' },
    { path: '/Guide/Second', title: 'Second child' },
    { path: '/Guide/First/Deep', title: 'Deep child' },
    { path: '/Guide/First', title: '<script>First & child</script>' },
    { path: '/Guide/Folder/Leaf', title: 'Leaf' },
    { path: '/Guidebook/Other', title: 'Unrelated' },
    { path: '/Elsewhere', title: 'Other page' },
  ];
  const html = render('[[_TOSP_]]\n\n[[_TOSP_]]', connection, '/Guide', pages);
  assert.equal((html.match(/<nav /g) || []).length, 1);
  assert.match(html, /aria-label="Child pages"/);
  assert.ok(html.indexOf('Second child') < html.indexOf('&lt;script&gt;First'));
  assert.match(html, /page=%2FGuide%2FFirst">&lt;script&gt;First &amp; child&lt;\/script&gt;<\/a><ul><li><a href="\/reading.html\?wiki=7&amp;page=%2FGuide%2FFirst%2FDeep">Deep child/);
  assert.match(html, /<li>Folder<ul><li><a href="\/reading.html\?wiki=7&amp;page=%2FGuide%2FFolder%2FLeaf">Leaf/);
  assert.doesNotMatch(html, /Current page|Unrelated|Other page|<script>/);
  const root = render('[[_TOSP_]]', connection, '/', pages);
  assert.match(root, /page=%2FGuide">Current page/);
  assert.match(root, /page=%2FElsewhere">Other page/);
});

test('navigation markers keep literal examples intact and show useful empty states', () => {
  const connection = { id: 7, provider: 'azure-devops', url: 'https://dev.azure.com/example/project/_wiki/wikis/wiki' };
  const literal = render([
    '```md', '[[_TOC_]]', '[[_TOSP_]]', '```', '',
    '    [[_TOC_]]', '', '`[[_TOSP_]]`', '',
    '\\[\\[_TOC_\\]\\]', '', '[[_toc_]]', '', '[[Other page]]',
  ].join('\n'), connection, '/Guide');
  assert.doesNotMatch(literal, /<nav/);
  assert.match(literal, /<code>\[\[_TOSP_\]\]<\/code>/);
  assert.match(literal, /page=%2FOther%20page/);
  const empty = render('[[_TOC_]]\n\n[[_TOSP_]]', connection, '/Guide');
  assert.match(empty, /This page has no headings\./);
  assert.match(empty, /This page has no child pages\./);
});

test('a saved GitHub wiki cannot be used after switching credentials or enterprise host', async t => {
  const fixture = githubFixture();
  const config = configForTest();
  const { api } = await setup(t, { ...fixture, config });
  const id = (await addGithub(api)).data.connection.id;
  config.ghToken = 'changed-test-token';
  let result = await api(`/connections/${id}/page?path=%2FHome`);
  assert.equal(result.status, 409);
  assert.match(result.data.error, /Remove and add this connection/);
  config.ghToken = 'test-github-credential';
  config.ghHost = 'github.example.invalid';
  result = await api(`/connections/${id}/tree`);
  assert.equal(result.status, 409);
  assert.equal(fixture.clones, 1);
  assert.equal((await api('/connections')).data.connections.length, 1);
});

test('changing credentials while a remote read is in flight cannot return or cache the old context', async t => {
  const fixture = githubFixture();
  const config = configForTest();
  const providers = createProviders(config, fixture);
  const original = providers.github.page;
  const { api, store } = await setup(t, { providers, config });
  const id = (await addGithub(api)).data.connection.id;
  providers.github.page = async (...args) => {
    const page = await original(...args);
    config.ghToken = 'changed-during-read';
    return page;
  };
  const result = await api(`/connections/${id}/page?path=%2FHome`);
  assert.equal(result.status, 409);
  assert.equal(store.cached(id, 'page', '/Home'), null);
});

test('malformed provider success payloads remain errors rather than empty discovery or page trees', async t => {
  const { api } = await setup(t, { fetch: async () => response({}) });
  for (const route of ['/targets?provider=azure-devops&q=docs', '/targets?provider=github&q=docs',
    '/wikis?provider=azure-devops&target=p1', '/wikis?provider=github&target=team%2Fdocs']) {
    const result = await api(route);
    assert.equal(result.status, 502);
    assert.ok(result.data.error);
  }
  assert.equal((await api('/connections')).data.connections.length, 0);
});

test('credential-bearing requests never follow redirects, cross hosts/orgs, permit source writes, or expose response bodies', async () => {
  const config = configForTest();
  const calls = [];
  let next = () => response({}, 200);
  const request = createRequest(config, async (url, opts) => { calls.push({ url, opts }); return next(); });
  for (const url of ['https://evil.example/example/x', 'http://dev.azure.com/example/x',
    'https://dev.azure.com/another/x', 'https://dev.azure.com/example-evil/x',
    'https://user:token@dev.azure.com/example/x']) {
    await assert.rejects(request('azure-devops', url), /outside/);
  }
  assert.equal(calls.length, 0);
  await assert.rejects(request('azure-devops', config.orgUrl + '/_apis/projects', { method: 'POST' }), /read-only/);
  await assert.rejects(request('github', 'https://github.com/team/docs.wiki.git/git-receive-pack', { git: true, method: 'POST' }), /read-only/);
  await assert.rejects(request('github', 'https://github.com/team/docs/issues', { git: true }), /Invalid wiki Git/);
  next = () => response({}, 302, { location: 'https://evil.example' });
  await assert.rejects(request('github', 'https://api.github.com/repos/team/docs'), /Redirects are blocked/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.redirect, 'manual');
  next = () => response({ secret: 'token-must-not-leak' }, 401);
  await assert.rejects(request('github', 'https://api.github.com/repos/team/docs'), error =>
    error.status === 401 && !error.message.includes('token-must-not-leak'));
  next = () => response(Buffer.alloc(100), 200, { 'content-length': '100' });
  await assert.rejects(request('github', 'https://api.github.com/repos/team/docs', { max: 10 }), error => error.status === 413);
  next = () => { throw new Error('credential-should-not-leak'); };
  await assert.rejects(request('github', 'https://api.github.com/repos/team/docs'), error => error.staleAllowed && !error.message.includes('credential-should-not-leak'));
});

test('provider failures and image active content are not cached as successful responses', async t => {
  const config = configForTest();
  let badImage = true;
  const source = {
    async wikis() { return [{ id: 'one', name: 'Wiki', project: 'p', repository: '', url: 'https://dev.azure.com/example/p/_wiki/wikis/one' }]; },
    async tree() { return [{ path: '/Page', title: 'Page' }]; },
    async page() { throw new Error('secret-in-internal-error'); },
    async image() { return badImage ? Buffer.from('<svg onload="bad()"></svg>') : Buffer.alloc(LIMITS.image + 1); },
  };
  const { api, store } = await setup(t, { config, providers: { 'azure-devops': source } });
  const id = (await api('/connections', 'POST', { provider: 'azure-devops', target: 'p', wikiId: 'one' })).data.connection.id;
  let result = await api(`/connections/${id}/image?path=%2Fevil.svg`);
  assert.equal(result.status, 415);
  assert.equal(store.cached(id, 'image', '/evil.svg'), null);
  badImage = false;
  result = await api(`/connections/${id}/image?path=%2Fhuge.png`);
  assert.equal(result.status, 413);
  result = await api(`/connections/${id}/page?path=%2FPage`);
  assert.equal(result.status, 500);
  assert.doesNotMatch(result.data.error, /secret-in-internal-error/);
  assert.equal(store.cached(id, 'page', '/Page'), null);
});
