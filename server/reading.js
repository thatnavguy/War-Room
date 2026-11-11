'use strict';

const express = require('express');
const { createStore, publicConnection } = require('./reading-store');
const { createProviders } = require('./reading-providers');
const { render } = require('./reading-markdown');
const { ReadingError, LIMITS, text, canonical, context, imageType } = require('./reading-common');

function createRouter(options = {}) {
  const config = options.config || require('./config');
  const store = options.store || createStore(options.database);
  const providers = options.providers || createProviders(config, options);
  const router = express.Router();
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  router.use(express.json({ limit: '16kb' }));
  router.locals = { store };
  function provider(value) {
    if (!Object.hasOwn(providers, value) || !['azure-devops', 'github'].includes(value)) throw new ReadingError('Unknown provider.', 400);
    context(config, value);
    return providers[value];
  }
  function verifyContext(connection) {
    const current = context(config, connection.provider);
    if (current.scope !== connection.scope || current.fingerprint !== connection.fingerprint) {
      throw new ReadingError('The configured host, organization, or credentials changed since this wiki was saved. Remove and add this connection again to authorize the new context.', 409);
    }
  }
  function saved(value, checkContext = true) {
    if (!/^[1-9]\d{0,14}$/.test(String(value))) throw new ReadingError('Invalid connection ID.', 400);
    const connection = store.get(Number(value));
    if (!connection) throw new ReadingError('Saved wiki not found.', 404);
    if (checkContext) verifyContext(connection);
    return connection;
  }
  const route = handler => async (req, res, next) => {
    try { await handler(req, res); } catch (error) { next(error); }
  };
  async function fetched(connection, kind, path = '', refresh = false) {
    try {
      const source = provider(connection.provider);
      if (refresh) source.refresh?.(connection);
      const value = await source[kind](connection, path);
      verifyContext(connection);
      if (kind === 'image') {
        if (!Buffer.isBuffer(value) || value.length > LIMITS.image) throw new ReadingError('Invalid or oversized wiki image.', 413);
        imageType(value);
      }
      return store.cache(connection.id, kind, path, value, source.fetchedAt?.(connection));
    } catch (error) {
      verifyContext(connection);
      if ([401, 403, 404].includes(error.status)) store.clearCache(connection.id);
      const cached = error instanceof ReadingError && error.staleAllowed && store.cached(connection.id, kind, path);
      if (cached) return { ...cached, warning: `Stale cached ${kind} from ${cached.fetchedAt}. ${error.message}` };
      throw error;
    }
  }
  router.get('/connections', route(async (req, res) => {
    res.json({ connections: store.list().map(publicConnection) });
  }));
  router.get('/targets', route(async (req, res) => {
    const q = text(req.query.q, 'search query', 200);
    res.json({ targets: await provider(req.query.provider).targets(q) });
  }));
  router.get('/wikis', route(async (req, res) => {
    const target = text(req.query.target, 'target', 300);
    const wikis = await provider(req.query.provider).wikis(target);
    res.json({ wikis: wikis.map(({ metadata, ...wiki }) => wiki) });
  }));
  router.post('/connections', route(async (req, res) => {
    const body = req.body;
    if (!body || Object.keys(body).some(k => !['provider', 'target', 'wikiId', 'name'].includes(k))) throw new ReadingError('Invalid connection fields.', 400);
    const source = provider(body.provider);
    const savedContext = context(config, body.provider);
    const target = text(body.target, 'target', 300);
    const wikiId = text(body.wikiId, 'wiki ID', 300);
    const name = body.name === undefined ? undefined : text(body.name, 'connection name', 150);
    const wikis = await source.wikis(target);
    const wiki = wikis.find(w => String(w.id) === wikiId);
    if (!wiki) throw new ReadingError('The requested wiki is not available in this target.', 404);
    const connection = {
      provider: body.provider, ...savedContext, project: wiki.project,
      repository: wiki.repository || '', wikiId: String(wiki.id), wikiName: wiki.name,
      name: name || wiki.name, url: wiki.url, metadata: wiki.metadata || {},
    };
    verifyContext(connection);
    const pages = await source.tree(connection);
    verifyContext(connection);
    const added = store.add(connection);
    store.cache(added.id, 'tree', '', pages, source.fetchedAt?.(connection));
    res.status(201).json({ connection: publicConnection(added) });
  }));
  router.patch('/connections/:id', route(async (req, res) => {
    const connection = saved(req.params.id, false);
    const body = req.body;
    if (!body || !Object.keys(body).length || Object.keys(body).some(k => !['name', 'position'].includes(k))) throw new ReadingError('Only name and position can be changed.', 400);
    const values = {};
    if (body.name !== undefined) values.name = text(body.name, 'connection name', 150);
    if (body.position !== undefined) {
      if (!Number.isInteger(body.position) || body.position < 0 || body.position >= store.list().length) throw new ReadingError('Position is outside the saved collection.', 400);
      values.position = body.position;
    }
    res.json({ connection: publicConnection(store.update(connection.id, values)) });
  }));
  router.delete('/connections/:id', route(async (req, res) => {
    store.remove(saved(req.params.id, false).id);
    res.json({ removed: true });
  }));
  router.get('/connections/:id/tree', route(async (req, res) => {
    const result = await fetched(saved(req.params.id), 'tree', '', req.query.refresh === '1');
    res.json({ pages: result.value, fetchedAt: result.fetchedAt, ...(result.warning ? { warning: result.warning } : {}) });
  }));
  router.get('/connections/:id/page', route(async (req, res) => {
    const connection = saved(req.params.id);
    const path = canonical(text(req.query.path, 'page path', 2000));
    const result = await fetched(connection, 'page', path, req.query.refresh === '1');
    const page = result.value;
    res.json({ path, title: page.title, html: render(page.content, connection, path, store.cached(connection.id, 'tree', '')?.value), url: page.url,
      fetchedAt: result.fetchedAt, ...(result.warning ? { warning: result.warning } : {}) });
  }));
  router.get('/connections/:id/image', route(async (req, res) => {
    const connection = saved(req.params.id);
    const path = canonical(text(req.query.path, 'image path', 2000));
    const result = await fetched(connection, 'image', path);
    res.set({ 'Content-Type': imageType(result.value), 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store', 'X-Reading-Fetched-At': result.fetchedAt,
      'Content-Security-Policy': "default-src 'none'; sandbox" });
    if (result.warning) res.set('X-Reading-Warning', result.warning);
    res.send(result.value);
  }));
  router.get('/search', route(async (req, res) => {
    const q = text(req.query.q, 'search query', 200).toLowerCase();
    const connections = req.query.connectionId === undefined ? store.list() : [saved(req.query.connectionId)];
    const results = [];
    const warnings = [];
    let inspected = 0;
    let successes = 0;
    let firstFailure;
    for (const row of connections) {
      const resultStart = results.length;
      const successStart = successes;
      try {
        const connection = saved(row.id);
        const tree = await fetched(connection, 'tree');
        if (tree.warning) warnings.push(`${connection.name}: ${tree.warning}`);
        for (const page of tree.value) {
          if (inspected >= LIMITS.searchPages) break;
          inspected++;
          try {
            const result = await fetched(connection, 'page', canonical(page.path));
            successes++;
            if (result.warning) warnings.push(`${connection.name}${page.path}: ${result.warning}`);
            const content = result.value.content;
            const index = content.toLowerCase().indexOf(q);
            if (index >= 0 || result.value.title.toLowerCase().includes(q)) {
              const start = Math.max(0, index - 80);
              results.push({ connectionId: connection.id, connectionName: connection.name,
                path: page.path, title: result.value.title, excerpt: content.slice(start, start + 240).replace(/\s+/g, ' ') });
            }
          } catch (error) {
            if ([401, 403, 404, 409].includes(error.status)) {
              results.splice(resultStart);
              successes = successStart;
            }
            firstFailure ||= error;
            warnings.push(`${connection.name}${page.path}: ${safeMessage(error)}`);
            if ([401, 403, 404, 409].includes(error.status)) throw error;
          }
        }
        if (!tree.value.length) successes++;
      } catch (error) {
        firstFailure ||= error;
        warnings.push(`${row.name}: ${safeMessage(error)}`);
        if (req.query.connectionId !== undefined) throw error;
      }
      if (inspected >= LIMITS.searchPages) {
        warnings.push('Search stopped at the 500-page limit. Search one saved wiki to narrow the results.');
        break;
      }
    }
    if (!successes && firstFailure) throw firstFailure;
    res.json({ results, ...(warnings.length ? { warnings: [...new Set(warnings)].slice(0, 100) } : {}) });
  }));
  function safeMessage(error) {
    return error instanceof ReadingError ? error.message : 'Unable to read the wiki source.';
  }
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof ReadingError ? error.status : error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError && error.status === 400 ? 400 : 500;
    res.status(status).json({ error: safeMessage(error) });
  });
  return router;
}

const defaultRouter = express.Router();
let activeRouter;
defaultRouter.use((req, res, next) => {
  try {
    activeRouter ||= createRouter();
    return activeRouter(req, res, next);
  } catch (error) {
    return res.status(500).json({ error: 'Reading Room storage could not be opened. Check write access to the application data directory.' });
  }
});
module.exports = defaultRouter;
module.exports.createRouter = createRouter;
