'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mentionsMe, latestMention } = require('./mentions');
const { sanitizeHtml } = require('./sanitize');
const me = '11111111-1111-1111-1111-111111111111';
const other = '22222222-2222-2222-2222-222222222222';
const mention = (id = me) => `<a href="#" data-vss-mention="version:2.0,${id}">@Example User</a>`;

test('mentions match identity IDs, not names, authors or other users', () => {
  assert.equal(mentionsMe(mention(), me), true);
  assert.equal(mentionsMe(`<a data-vss-mention='version:2.0,${me}' href='#'>@User</a>`, me), true);
  assert.equal(mentionsMe(mention(other), me), false);
  assert.equal(mentionsMe('Example User and @Example User', me), false);
  assert.equal(mentionsMe(mention(), ''), false);
  assert.equal(mentionsMe(`<pre>${mention()}</pre>`, me), false);
  assert.equal(mentionsMe(`<!-- ${mention()} -->`, me), false);
});

test('mention timestamps use the actual changed date rather than the Azure DevOps sentinel', () => {
  const updates = [
    { revisedDate: '2026-01-01', fields: { 'System.History': { newValue: mention() } } },
    { revisedDate: '9999-01-01', fields: {
      'System.History': { newValue: mention() },
      'System.ChangedDate': { newValue: '2026-01-02T10:00:00Z' },
    } },
    { revisedDate: '2026-01-03', fields: { 'System.History': { newValue: mention(other) } } },
  ];
  assert.equal(latestMention(updates, me), '2026-01-02T10:00:00Z');
  assert.equal(latestMention([], me), null);
});

test('sanitizer highlights only the matching structured mention and strips supplied classes and handlers', () => {
  const html = `${mention()} ${mention(other)} <a href="#" class="my-name" onclick="alert(1)">Example User</a>`;
  const result = sanitizeHtml(html, me);
  assert.equal((result.match(/class="my-name"/g) || []).length, 1);
  assert.ok(!result.includes('onclick'));
  assert.ok(!result.includes('data-vss-mention'));
  assert.equal((sanitizeHtml(html).match(/class="my-name"/g) || []).length, 0);
});
