'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const config = require('./config');
const autoSync = require('./auto-sync');

function settingsApi(t) {
  const dbPath = require.resolve('./db');
  const apiPath = require.resolve('./api');
  const originalDb = require.cache[dbPath];
  const originalApi = require.cache[apiPath];
  const originalConfig = { ...config };
  const originalStart = autoSync.start;
  const saves = [];
  const starts = [];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {} };
  delete require.cache[apiPath];
  Object.assign(config, {
    orgUrl: 'https://dev.azure.com/example', pat: 'test-pat', ghToken: 'test-token',
    adoAutoSyncMinutes: 5, ghAutoSyncMinutes: 15, discoveryDays: 30,
    save: (values) => { saves.push(values); return { portChanged: false }; },
  });
  autoSync.start = (id) => starts.push(id);
  const api = require('./api');
  t.after(() => {
    Object.assign(config, originalConfig);
    autoSync.start = originalStart;
    if (originalDb) require.cache[dbPath] = originalDb;
    else delete require.cache[dbPath];
    if (originalApi) require.cache[apiPath] = originalApi;
    else delete require.cache[apiPath];
  });
  function request(method, body) {
    const route = api.stack.find((layer) => layer.route?.path === '/config' && layer.route.methods[method]);
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; },
    };
    route.route.stack[0].handle({ body }, res);
    return res;
  }
  return { request, saves, starts };
}

test('settings API returns independent auto-sync intervals', (t) => {
  const f = settingsApi(t);
  const res = f.request('get');
  assert.equal(res.body.azureDevOps.autoSyncMinutes, 5);
  assert.equal(res.body.github.autoSyncMinutes, 15);
});

test('settings API saves and reschedules only the specified source, including disabling it', (t) => {
  const f = settingsApi(t);
  assert.equal(f.request('post', { github: { autoSyncMinutes: 0 } }).statusCode, 200);
  assert.equal(f.saves[0].ghAutoSyncMinutes, 0);
  assert.equal(f.saves[0].adoAutoSyncMinutes, undefined);
  assert.deepEqual(f.starts, ['github']);
  assert.equal(f.request('post', {
    azureDevOps: { orgUrl: config.orgUrl, autoSyncMinutes: 10 },
  }).statusCode, 200);
  assert.equal(f.saves[1].adoAutoSyncMinutes, 10);
  assert.equal(f.saves[1].ghAutoSyncMinutes, undefined);
  assert.deepEqual(f.starts, ['github', 'azure-devops']);
  f.request('post', { general: { staleDays: 21 } });
  assert.deepEqual(f.starts, ['github', 'azure-devops']);
});

test('settings API rejects invalid intervals without writing or rescheduling', (t) => {
  const f = settingsApi(t);
  for (const source of ['azureDevOps', 'github']) {
    for (const minutes of [-1, 0.5, 1441, '5', null]) {
      const res = f.request('post', { [source]: { autoSyncMinutes: minutes } });
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /whole number/);
    }
  }
  assert.equal(f.saves.length, 0);
  assert.equal(f.starts.length, 0);
});

test('settings API exposes and validates the discovery window without rescheduling sync', (t) => {
  const f = settingsApi(t);
  assert.equal(f.request('get').body.discoveryDays, 30);
  for (const days of [0, -1, 1.5, 3651, '30', null]) {
    const result = f.request('post', { general: { discoveryDays: days } });
    assert.equal(result.statusCode, 400);
    assert.match(result.body.error, /Discovery window/);
  }
  assert.equal(f.saves.length, 0);
  assert.equal(f.request('post', { general: { discoveryDays: 90 } }).statusCode, 200);
  assert.equal(f.saves[0].discoveryDays, 90);
  assert.deepEqual(f.starts, []);
});

test('settings forms load and save separate intervals without exposing saved tokens', async () => {
  const elements = new Map();
  const posts = [];
  const cfg = {
    azureDevOps: { orgUrl: 'https://dev.azure.com/example', projects: '', patSet: true, configured: true, autoSyncMinutes: 5 },
    github: { repos: 'octo/one', host: 'github.com', tokenSet: true, configured: true, autoSyncMinutes: 15 },
    port: 4073, staleDays: 14, lookbackDays: 365, discoveryDays: 30,
  };
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', textContent: '', className: '', disabled: false,
      classList: { toggle() {} }, listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      querySelector() { return element(`${selector} button`); },
    });
    return elements.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: element },
    fetch: async (url, options) => {
      if (options) posts.push(JSON.parse(options.body));
      return { ok: true, json: async () => options ? { saved: true } : cfg };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'setup.js'), 'utf8'), context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element('#ado-auto-sync-minutes').value, 5);
  assert.equal(element('#gh-auto-sync-minutes').value, 15);
  assert.equal(element('#discovery-days').value, 30);
  element('#gh-auto-sync-minutes').value = '0';
  await element('#github-form').listeners.submit({ preventDefault() {} });
  assert.equal(posts[0].github.autoSyncMinutes, 0);
  assert.equal(posts[0].azureDevOps, undefined);
  element('#ado-auto-sync-minutes').value = '10';
  await element('#ado-form').listeners.submit({ preventDefault() {} });
  assert.equal(posts[1].azureDevOps.autoSyncMinutes, 10);
  assert.equal(posts[1].github, undefined);
  element('#discovery-days').value = '90';
  await element('#general-form').listeners.submit({ preventDefault() {} });
  assert.equal(posts[2].general.discoveryDays, 90);
  assert.equal(element('#pat').value, '');
  assert.equal(element('#gh-token').value, '');
});
