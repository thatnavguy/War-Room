'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('project settings override inherited values while unspecified settings keep environment defaults', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-hall-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'server'));
  const configPath = path.join(directory, 'server', 'config.js');
  fs.copyFileSync(path.join(__dirname, 'config.js'), configPath);
  fs.writeFileSync(path.join(directory, '.env'), 'GH_TOKEN=saved-token\nGH_HOST=github.com\nPORT=4073\n');
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const config = require(${JSON.stringify(configPath)});
    assert.equal(config.ghToken, 'saved-token');
    assert.equal(config.ghHost, 'github.com');
    assert.equal(config.port, 4073);
    assert.equal(config.lookbackDays, 90);
    assert.equal(config.discoveryDays, 30);
    config.save({ discoveryDays: 90 });
    assert.equal(config.discoveryDays, 90);
    config.load();
    assert.equal(config.discoveryDays, 90);
    assert.equal(config.adoAutoSyncMinutes, 0);
    assert.equal(config.ghAutoSyncMinutes, 0);
    assert.equal(process.env.GH_TOKEN, 'saved-token');
    config.load();
    assert.equal(config.ghToken, 'saved-token');
    config.save({ adoAutoSyncMinutes: 5, ghAutoSyncMinutes: 15 });
    assert.equal(config.adoAutoSyncMinutes, 5);
    assert.equal(config.ghAutoSyncMinutes, 15);
    config.save({ adoAutoSyncMinutes: 0 });
    assert.equal(config.adoAutoSyncMinutes, 0);
    assert.equal(config.ghAutoSyncMinutes, 15);
    const fs = require('node:fs');
    const filename = ${JSON.stringify(path.join(directory, '.env'))};
    assert.match(fs.readFileSync(filename, 'utf8'), /ADO_AUTO_SYNC_MINUTES=0/);
    assert.match(fs.readFileSync(filename, 'utf8'), /GH_AUTO_SYNC_MINUTES=15/);
    const saved = fs.readFileSync(filename, 'utf8');
    assert.match(saved, /DISCOVERY_DAYS=90/);
    for (const days of [0, -1, 0.5, 3651, '30', null, NaN]) {
      assert.throws(() => config.save({ discoveryDays: days }), /whole number/);
      assert.equal(fs.readFileSync(filename, 'utf8'), saved);
    }
    for (const minutes of [-1, 0.5, 1441, '5', null, NaN]) {
      assert.throws(() => config.save({ ghAutoSyncMinutes: minutes }), /whole number/);
      assert.equal(fs.readFileSync(filename, 'utf8'), saved);
    }
    config.save({ ghAutoSyncMinutes: 1440 });
    assert.equal(config.ghAutoSyncMinutes, 1440);
    const beforeInjection = fs.readFileSync(filename, 'utf8');
    assert.throws(() => config.save({ projects: 'One\\nADO_ORG_URL=https://attacker.example' }), (err) => err.status === 400 && /line breaks/.test(err.message));
    assert.throws(() => config.save({ port: 70000 }), /Port/);
    assert.equal(fs.readFileSync(filename, 'utf8'), beforeInjection);
  `], {
    cwd: __dirname,
    env: {
      ...process.env,
      NODE_PATH: path.join(__dirname, '..', 'node_modules'),
      GH_TOKEN: 'inherited-token',
      GH_HOST: 'inherited.example.com',
      PORT: '9999',
      LOOKBACK_DAYS: '90',
      DISCOVERY_DAYS: '',
      ADO_AUTO_SYNC_MINUTES: '0',
      GH_AUTO_SYNC_MINUTES: '0',
    },
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
