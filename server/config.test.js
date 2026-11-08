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
    assert.equal(process.env.GH_TOKEN, 'saved-token');
    config.load();
    assert.equal(config.ghToken, 'saved-token');
  `], {
    cwd: __dirname,
    env: {
      ...process.env,
      NODE_PATH: path.join(__dirname, '..', 'node_modules'),
      GH_TOKEN: 'inherited-token',
      GH_HOST: 'inherited.example.com',
      PORT: '9999',
      LOOKBACK_DAYS: '90',
    },
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
