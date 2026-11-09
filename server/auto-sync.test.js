'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAutoSync } = require('./auto-sync');

function fixture() {
  const timers = new Map();
  const calls = [];
  const errors = [];
  const busy = new Set();
  const config = {
    adoAutoSyncMinutes: 0,
    ghAutoSyncMinutes: 0,
    isConfigured: () => true,
    isGitHubConfigured: () => true,
  };
  const sync = {
    syncStatus: (id) => ({ running: busy.has(id) }),
    runSync: async (id) => { calls.push(id); return { errors: [] }; },
  };
  let nextId = 0;
  const scheduler = createAutoSync({
    config, sync,
    setIntervalFn: (callback, delay) => {
      const id = ++nextId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearIntervalFn: (id) => timers.delete(id),
    logError: (message) => errors.push(message),
  });
  return { config, sync, scheduler, timers, calls, errors, busy };
}

test('auto-sync is off by default', () => {
  const f = fixture();
  f.scheduler.start();
  assert.equal(f.timers.size, 0);
});

test('auto-sync uses independent intervals and targets each provider', async () => {
  const f = fixture();
  f.config.adoAutoSyncMinutes = 5;
  f.config.ghAutoSyncMinutes = 15;
  f.scheduler.start();
  const timers = [...f.timers.values()];
  assert.deepEqual(timers.map((timer) => timer.delay), [300000, 900000]);
  assert.equal(f.calls.length, 0);
  await timers[0].callback();
  await timers[1].callback();
  assert.deepEqual(f.calls, ['azure-devops', 'github']);
});

test('saving one interval preserves the other timer and zero disables only that source', () => {
  const f = fixture();
  f.config.adoAutoSyncMinutes = 5;
  f.config.ghAutoSyncMinutes = 15;
  f.scheduler.start();
  const githubTimer = f.timers.get(2);
  f.config.adoAutoSyncMinutes = 10;
  f.scheduler.start('azure-devops');
  assert.equal(f.timers.size, 2);
  assert.equal(f.timers.get(2), githubTimer);
  assert.equal(f.timers.get(3).delay, 600000);
  f.config.adoAutoSyncMinutes = 0;
  f.scheduler.start('azure-devops');
  assert.deepEqual([...f.timers.values()], [githubTimer]);
  f.scheduler.stop();
  assert.equal(f.timers.size, 0);
});

test('auto-sync skips unconfigured and busy sources without blocking the other provider', async () => {
  const f = fixture();
  f.config.adoAutoSyncMinutes = 1;
  f.config.ghAutoSyncMinutes = 1;
  f.scheduler.start();
  const [ado, github] = [...f.timers.values()];
  f.config.isConfigured = () => false;
  await ado.callback();
  assert.equal(f.calls.length, 0);
  f.config.isConfigured = () => true;
  f.busy.add('azure-devops');
  await ado.callback();
  await github.callback();
  assert.deepEqual(f.calls, ['github']);
});

test('auto-sync does not overlap its own pending run', async () => {
  const f = fixture();
  f.config.ghAutoSyncMinutes = 1;
  let finish;
  f.sync.runSync = (id) => {
    f.calls.push(id);
    return new Promise((resolve) => { finish = resolve; });
  };
  f.scheduler.start();
  const timer = [...f.timers.values()][0];
  const pending = timer.callback();
  await timer.callback();
  assert.deepEqual(f.calls, ['github']);
  finish({ errors: [] });
  await pending;
});

test('auto-sync reports partial failures and exceptions, then retries on the next interval', async () => {
  const f = fixture();
  f.config.ghAutoSyncMinutes = 1;
  let attempt = 0;
  f.sync.runSync = async () => {
    attempt++;
    if (attempt === 1) return { errors: ['request failed 404'] };
    if (attempt === 2) throw new Error('network unavailable');
    return { errors: [] };
  };
  f.scheduler.start();
  const timer = [...f.timers.values()][0];
  await timer.callback();
  await timer.callback();
  await timer.callback();
  assert.equal(attempt, 3);
  assert.deepEqual(f.errors, ['[auto-sync:github] request failed 404', '[auto-sync:github] network unavailable']);
});
