'use strict';

const { ReadingError, LIMITS, canonical, context, createRequest } = require('./reading-common');

const enc = encodeURIComponent;

function createProviders(config, options = {}) {
  const request = options.request || createRequest(config, options.fetch);
  const now = options.now || Date.now;
  async function json(provider, url) {
    const { bytes } = await request(provider, url, { max: LIMITS.response });
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw new ReadingError('Source returned invalid JSON.', 502); }
  }
  const adoBase = () => context(config, 'azure-devops').scope;
  const ghBase = () => {
    const { scope } = context(config, 'github');
    return scope === 'https://github.com' ? 'https://api.github.com' : scope + '/api/v3';
  };
  function repo(target) {
    if (typeof target !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(target) || target.split('/').some(s => s === '.' || s === '..')) {
      throw new ReadingError('GitHub target must be owner/repository.', 400);
    }
    return target;
  }
  function adoWiki(connection) {
    return `${adoBase()}/${enc(connection.project)}/_apis/wiki/wikis/${enc(connection.wikiId)}`;
  }
  function version(url, connection) {
    if (connection.metadata?.version) {
      url.searchParams.set('versionDescriptor.version', connection.metadata.version);
      url.searchParams.set('versionDescriptor.versionType', connection.metadata.versionType || 'branch');
    }
    return url;
  }
  const azure = {
    async targets(q) {
      const items = [];
      let continuation;
      for (let count = 0; count < 10; count++) {
        const url = new URL(`${adoBase()}/_apis/projects`);
        url.searchParams.set('api-version', '7.1');
        url.searchParams.set('$top', '100');
        if (continuation) url.searchParams.set('continuationToken', continuation);
        const response = await request('azure-devops', url.href, { max: LIMITS.response });
        let data;
        try { data = JSON.parse(response.bytes.toString()); } catch { throw new ReadingError('Source returned invalid JSON.', 502); }
        if (!Array.isArray(data.value)) throw new ReadingError('Azure DevOps did not return a project list.', 502);
        items.push(...data.value);
        continuation = response.headers.get('x-ms-continuationtoken');
        if (!continuation) return items.filter(p => p.name.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 50).map(p => ({ id: p.id, name: p.name, label: p.name }));
      }
      throw new ReadingError('Project discovery exceeded 1,000 projects. Narrow access or use a smaller organization.', 413);
    },
    async wikis(target) {
      if (/[\\/%?#]/.test(target) || ['.', '..'].includes(target)) throw new ReadingError('Invalid Azure DevOps project.', 400);
      const data = await json('azure-devops', `${adoBase()}/${enc(target)}/_apis/wiki/wikis?api-version=7.1`);
      if (!Array.isArray(data.value)) throw new ReadingError('Azure DevOps did not return a wiki list.', 502);
      return data.value.map(w => ({
        id: w.id, name: w.name, project: target, repository: w.repositoryId || '',
        url: `${adoBase()}/${enc(target)}/_wiki/wikis/${enc(w.id)}`,
        metadata: { mappedPath: w.mappedPath || '/', repositoryId: w.repositoryId,
          version: w.versions?.[0]?.version || w.version?.version,
          versionType: w.versions?.[0]?.versionType || w.version?.versionType || 'branch', type: w.type },
      }));
    },
    async tree(connection) {
      const url = version(new URL(adoWiki(connection) + '/pages'), connection);
      url.searchParams.set('path', '/');
      url.searchParams.set('recursionLevel', 'full');
      url.searchParams.set('api-version', '7.1');
      const data = await json('azure-devops', url.href);
      if (typeof data.path !== 'string') throw new ReadingError('Azure DevOps did not return a wiki page tree.', 502);
      const pages = [];
      function visit(page, depth = 0) {
        if (depth > 100 || pages.length >= LIMITS.files) throw new ReadingError('Wiki tree exceeds the Reading Room size limit.', 413);
        if (page.path && page.path !== '/') {
          const path = canonical(page.path);
          pages.push({ path, title: path.split('/').pop() });
        }
        for (const sub of page.subPages || []) visit(sub, depth + 1);
      }
      visit(data);
      return pages;
    },
    async page(connection, path) {
      const url = version(new URL(adoWiki(connection) + '/pages'), connection);
      url.searchParams.set('path', path);
      url.searchParams.set('includeContent', 'true');
      url.searchParams.set('api-version', '7.1');
      const data = await json('azure-devops', url.href);
      if (typeof data.content !== 'string') throw new ReadingError('The source did not return wiki page content.', 502);
      if (Buffer.byteLength(data.content) > LIMITS.page) throw new ReadingError('Wiki page exceeds the Reading Room size limit.', 413);
      return { path, title: path.split('/').pop() || connection.wikiName, content: data.content,
        url: `${connection.url}?pagePath=${enc(path)}` };
    },
    async image(connection, path) {
      if (!connection.metadata?.repositoryId) throw new ReadingError('Wiki repository information is unavailable; remove and add this connection again.', 409);
      // Attachments are Git items in both native and code-backed Azure wikis.
      const mapped = connection.metadata.mappedPath || '/';
      const itemPath = canonical(mapped + '/' + path);
      const url = version(new URL(`${adoBase()}/${enc(connection.project)}/_apis/git/repositories/${enc(connection.metadata.repositoryId)}/items`), connection);
      url.searchParams.set('path', itemPath);
      url.searchParams.set('download', 'true');
      url.searchParams.set('$format', 'octetStream');
      url.searchParams.set('api-version', '7.1');
      return (await request('azure-devops', url.href, { max: LIMITS.image, accept: 'application/octet-stream' })).bytes;
    },
  };

  const snapshots = new Map();
  const pending = new Map();
  const git = options.git || require('isomorphic-git');
  const fsFactory = options.fsFactory || (() => require('memfs').createFsFromVolume(new (require('memfs').Volume)()));
  async function snapshot(connection) {
    const target = repo(connection.repository);
    const key = `${context(config, 'github').fingerprint}:${target}`;
    const existing = snapshots.get(key);
    // Git snapshots have a bounded 60-second TTL; REST pages are fetched on every request.
    if (existing && now() - existing.at < 60000) return existing;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      const fs = fsFactory();
      const dir = '/wiki';
      const http = { async request({ url, method, body }) {
        let payload;
        if (body) {
          const chunks = [];
          let size = 0;
          for await (const chunk of body) {
            size += chunk.length;
            if (size > 1024 * 1024) throw new ReadingError('Git negotiation exceeds the Reading Room size limit.', 413);
            chunks.push(Buffer.from(chunk));
          }
          payload = Buffer.concat(chunks);
        }
        const result = await request('github', url, { method: method || 'GET', body: payload, git: true, max: LIMITS.response });
        return { url, method, statusCode: 200, statusMessage: 'OK', headers: Object.fromEntries(result.headers), body: [result.bytes] };
      } };
      try {
        await git.clone({ fs, http, dir, url: `${context(config, 'github').scope}/${target}.wiki.git`,
          depth: 1, singleBranch: true, noCheckout: true, noTags: true,
          onAuth: () => ({ username: 'x-access-token', password: config.ghToken }) });
        const files = new Map();
        await git.walk({ fs, dir, trees: [git.TREE({ ref: 'HEAD' })], map: async (path, [entry]) => {
          if (path === '.' || await entry.type() !== 'blob') return;
          if (files.size >= LIMITS.files) throw new ReadingError('Wiki exceeds 4,000 files.', 413);
          files.set(canonical('/' + path), await entry.oid());
        } });
        const value = { fs, dir, files, at: now() };
        snapshots.delete(key);
        snapshots.set(key, value);
        while (snapshots.size > 4) snapshots.delete(snapshots.keys().next().value);
        return value;
      } catch (error) {
        if (error instanceof ReadingError) throw error;
        // isomorphic-git can wrap transport errors; never expose its URL/auth-bearing messages.
        if (error?.data?.statusCode) {
          throw require('./reading-common').sourceError('github', error.data.statusCode);
        }
        throw new ReadingError('Unable to read the GitHub wiki repository. Enable the wiki and publish its first page in GitHub. Use a token supporting wiki Git reads (classic PAT repo scope for private repositories), with organization SSO authorized.', 502);
      }
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }
  async function blob(connection, filename, max) {
    const state = await snapshot(connection);
    const oid = state.files.get(filename);
    if (!oid) throw new ReadingError('Wiki file not found.', 404);
    const { blob } = await git.readBlob({ fs: state.fs, dir: state.dir, oid });
    if (blob.length > max) throw new ReadingError('Wiki file exceeds the Reading Room size limit.', 413);
    return Buffer.from(blob);
  }
  const github = {
    refresh(connection) {
      snapshots.delete(`${context(config, 'github').fingerprint}:${repo(connection.repository)}`);
    },
    fetchedAt(connection) {
      const state = snapshots.get(`${context(config, 'github').fingerprint}:${repo(connection.repository)}`);
      return state ? new Date(state.at).toISOString() : undefined;
    },
    async targets(q) {
      const url = new URL(ghBase() + '/search/repositories');
      url.searchParams.set('q', q);
      url.searchParams.set('per_page', '30');
      const data = await json('github', url.href);
      if (!Array.isArray(data.items)) throw new ReadingError('GitHub did not return repository search results.', 502);
      return data.items.map(r => ({ id: r.full_name, name: r.name, label: r.full_name }));
    },
    async wikis(target) {
      target = repo(target);
      const data = await json('github', ghBase() + '/repos/' + target);
      if (typeof data.has_wiki !== 'boolean') throw new ReadingError('GitHub did not return repository wiki availability.', 502);
      if (!data.has_wiki) return [];
      return [{ id: target, name: `${data.name || target.split('/')[1]} Wiki`, project: target.split('/')[0],
        repository: target, url: `${context(config, 'github').scope}/${target}/wiki`, metadata: {} }];
    },
    async tree(connection) {
      const state = await snapshot(connection);
      const pages = [...state.files.keys()].filter(p => /\.md$/i.test(p)).map(p => ({
        path: p.replace(/\.md$/i, ''), title: p.split('/').pop().replace(/\.md$/i, '').replace(/-/g, ' '),
      }));
      if (!pages.length) throw new ReadingError('The GitHub wiki has no Markdown pages. Publish its first wiki page in GitHub, then add the connection again.', 404);
      return pages;
    },
    async page(connection, path) {
      const state = await snapshot(connection);
      const filename = [...state.files.keys()].find(p => p.replace(/\.md$/i, '') === path && /\.md$/i.test(p));
      if (!filename) throw new ReadingError('Wiki page not found.', 404);
      return { path, title: path.split('/').pop().replace(/-/g, ' '),
        content: (await blob(connection, filename, LIMITS.page)).toString('utf8'),
        url: `${connection.url}/${path.slice(1).split('/').map(enc).join('/')}` };
    },
    async image(connection, path) { return blob(connection, canonical(path), LIMITS.image); },
  };
  return { 'azure-devops': azure, github };
}

module.exports = { createProviders };
