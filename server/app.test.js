'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { localOnly, errorHandler } = require('./app');

function run(middleware, headers) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
  let passed = false;
  middleware({ headers }, res, () => { passed = true; });
  return { passed, res };
}

test('local-only guard accepts localhost requests and same-origin browser calls', () => {
  for (const host of ['localhost:4073', '127.0.0.1:4073', '[::1]:4073', 'LOCALHOST']) {
    assert.equal(run(localOnly, { host }).passed, true, host);
  }
  assert.equal(run(localOnly, { host: 'localhost:4073', origin: 'http://localhost:4073' }).passed, true);
});

test('local-only guard rejects rebinding hosts and cross-site origins', () => {
  for (const headers of [
    { host: 'evil.example:4073' },
    { host: 'localhost.evil.example' },
    {},
    { host: 'localhost:4073', origin: 'https://evil.example' },
    { host: 'localhost:4073', origin: 'null' },
  ]) {
    const { passed, res } = run(localOnly, headers);
    assert.equal(passed, false, JSON.stringify(headers));
    assert.equal(res.statusCode, 403);
  }
});

test('error handler returns JSON and hides internal error details', (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const call = (err) => {
    const res = { headersSent: false, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    errorHandler(err, {}, res, () => assert.fail('next should not be called'));
    return res;
  };
  const bad = call(Object.assign(new Error('Unexpected token'), { status: 400 }));
  assert.deepEqual([bad.statusCode, bad.body.error], [400, 'Unexpected token']);
  const crash = call(new Error('secret path C:\\data'));
  assert.equal(crash.statusCode, 500);
  assert.doesNotMatch(crash.body.error, /secret/);
  assert.equal(errors.mock.callCount(), 1);
});
