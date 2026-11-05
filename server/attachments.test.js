'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const config = require('./config');
const ado = require('./ado');
const { sanitizeHtml, summarizeUpdates } = require('./sanitize');

const source = 'https://dev.azure.com/example/project/_apis/wit/attachments/dcac75d1-57e7-49b4-b5ea-b4d3cfd7cd39?fileName=image.png';

test('preserves screenshots using a local authenticated image endpoint', () => {
  const original = config.orgUrl;
  config.orgUrl = 'https://dev.azure.com/example';
  try {
    const html = sanitizeHtml(`<p>Description</p><img src="${source}" onerror="alert(1)" style="width:1px">`);
    assert.match(html, /<img src="\/api\/attachments\/image\?url=/);
    assert.doesNotMatch(html, /onerror|style=/);
    assert.match(html, /loading="lazy"/);
    assert.match(summarizeUpdates([{ rev: 1, fields: { 'System.History': { newValue: `<img src="${source}">` } } }])[0].comment, /<img /);
    assert.equal(sanitizeHtml('<script>alert(1)</script><p>Safe</p>'), '<p>Safe</p>');
  } finally {
    config.orgUrl = original;
  }
});

test('rejects external hosts, other organizations, active content, and non-attachment paths', () => {
  const original = config.orgUrl;
  config.orgUrl = 'https://dev.azure.com/example';
  try {
    for (const url of [
      source.replace('dev.azure.com', 'attacker.example'),
      source.replace('/example/', '/different/'),
      source.replace('https:', 'http:'),
      source.replace('/attachments/', '/workitems/'),
      source.replace('/project/', '/%2fproject/'),
      'data:image/svg+xml,<svg onload="alert(1)">',
      'javascript:alert(1)',
    ]) {
      assert.equal(ado.imageAttachmentUrl(url), null);
    }
    assert.doesNotMatch(sanitizeHtml('<img src="https://attacker.example/image.png">'), /<img /);
    assert.match(sanitizeHtml('<img src="https://attacker.example/image.png">'), /Screenshot unavailable/);
  } finally {
    config.orgUrl = original;
  }
});

test('fetches only validated raster images without following redirects', async () => {
  const originalOrg = config.orgUrl;
  const originalFetch = global.fetch;
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  config.orgUrl = 'https://dev.azure.com/example';
  try {
    global.fetch = async (url, options) => {
      assert.equal(url, ado.imageAttachmentUrl(source));
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, config.authHeader);
      return new Response(png, { headers: { 'content-type': 'application/octet-stream' } });
    };
    const image = await ado.getImageAttachment(source);
    assert.equal(image.contentType, 'image/png');
    assert.deepEqual(image.data, png);
    global.fetch = async () => new Response('<svg onload="alert(1)">', { headers: { 'content-type': 'application/octet-stream' } });
    await assert.rejects(ado.getImageAttachment(source), /not a supported screenshot/);
    global.fetch = async () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } });
    await assert.rejects(ado.getImageAttachment(source), /not a supported screenshot/);
    global.fetch = async () => new Response(null, { status: 403 });
    await assert.rejects(ado.getImageAttachment(source), /403/);
    global.fetch = async () => new Response(Buffer.alloc(20 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } });
    await assert.rejects(ado.getImageAttachment(source), /20 MB/);
    global.fetch = async () => { throw new Error('Unexpected external request'); };
    await assert.rejects(ado.getImageAttachment('https://attacker.example/image.png'), /configured Azure DevOps organization/);
  } finally {
    config.orgUrl = originalOrg;
    global.fetch = originalFetch;
  }
});

test('loads live attached files with safe links, sizes and raster preview URLs', async () => {
  const originalOrg = config.orgUrl;
  const originalFetch = global.fetch;
  config.orgUrl = 'https://dev.azure.com/example';
  try {
    global.fetch = async (url) => {
      assert.match(url, /workitems\/105865\?\$expand=relations/);
      return Response.json({ relations: [
        { rel: 'AttachedFile', url: source, attributes: { name: 'Photo.JPG', resourceSize: 284160 } },
        { rel: 'AttachedFile', url: source, attributes: { name: 'Report.pdf' } },
        { rel: 'AttachedFile', url: source, attributes: { name: 'Drawing.svg', resourceSize: -1 } },
        { rel: 'AttachedFile', url: 'https://attacker.example/file', attributes: { name: 'Bad.png' } },
        { rel: 'System.LinkTypes.Related', url: source },
      ] });
    };
    const files = await ado.getAttachments(105865);
    assert.equal(files.length, 4);
    assert.equal(files[0].name, 'Photo.JPG');
    assert.equal(files[0].size, 284160);
    assert.equal(files[0].preview_url, `/api/attachments/image?url=${encodeURIComponent(ado.imageAttachmentUrl(source))}`);
    assert.equal(files[0].url, `${ado.imageAttachmentUrl(source)}&fileName=Photo.JPG&download=true`);
    assert.equal(files[1].preview_url, null);
    assert.equal(files[1].size, null);
    assert.equal(files[2].preview_url, null);
    assert.equal(files[2].size, null);
    assert.equal(files[3].url, null);
    assert.equal(files[3].preview_url, null);
    global.fetch = async () => Response.json({});
    assert.deepEqual(await ado.getAttachments(105865), []);
    global.fetch = async () => new Response(null, { status: 403 });
    await assert.rejects(ado.getAttachments(105865), /403/);
  } finally {
    config.orgUrl = originalOrg;
    global.fetch = originalFetch;
  }
});
