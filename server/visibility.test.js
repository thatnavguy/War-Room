'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('./store');
const { latestCommentMentionsMe } = require('./mentions');

const scope = 'https://dev.azure.com/example';
const me = '11111111-1111-1111-1111-111111111111';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-hall-visibility-'));
  const filename = path.join(directory, 'items.db');
  const store = createStore(filename);
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  store.setSyncState('meDisplayName', 'Me', 'azure-devops', scope);
  store.setSyncState('meId', me, 'azure-devops', scope);
  const save = (externalId, overrides = {}) => {
    const id = store.saveItem({
      provider: 'azure-devops', source_scope: scope, external_id: externalId,
      assigned_to: 'Someone else', changed_date: '2020-01-01', ...overrides,
    });
    store.saveTouch(id, 'assigned', '2020-01-01');
    return id;
  };
  return { store, filename, save };
}

test('hiding is local, persistent across sync/reopening, and excluded from summaries', (t) => {
  const { store, filename, save } = fixture(t);
  const id = save('1');
  assert.deepEqual(store.setItemHidden(id, true), { hidden: true });
  assert.equal(store.queryItems({}).total, 0);
  assert.equal(store.queryItems({ hiddenOnly: true }).total, 1);
  assert.equal(store.getSummary(14).open, 0);
  assert.deepEqual(store.getSummary(14).byState, []);
  assert.equal(store.getItem(id).touches.length, 1);
  assert.equal(save('1'), id);
  assert.equal(store.queryItems({}).total, 0);
  const reopened = createStore(filename);
  try { assert.equal(reopened.queryItems({ hiddenOnly: true }).items[0].id, id); }
  finally { reopened.close(); }
  store.setItemHidden(id, false);
  assert.equal(store.queryItems({}).total, 1);
  assert.equal(store.queryItems({ hiddenOnly: true }).total, 0);
});

test('current assignment overrides a hide preference, and historical assignment alone does not', (t) => {
  const { store, save } = fixture(t);
  const id = save('1');
  store.setItemHidden(id, true);
  save('1', { assigned_to: 'Me' });
  assert.equal(store.queryItems({}).total, 1);
  assert.equal(store.queryItems({}).items[0].visibility_required, 1);
  assert.equal(store.queryItems({ hiddenOnly: true }).total, 0);
  assert.equal(store.getSummary(14).stale, 1);
  assert.equal(store.setItemHidden(id, true).status, 409);
  save('1', { assigned_to: 'Someone else' });
  assert.equal(store.queryItems({}).total, 0);
});

test('only the latest comment mention overrides hiding, scoped to the source identity', (t) => {
  const { store, save } = fixture(t);
  const id = save('1');
  store.setItemHidden(id, true);
  store.setLatestCommentMention(id, me, true);
  assert.equal(store.queryItems({}).total, 1);
  assert.equal(store.setItemHidden(id, true).status, 409);
  store.setLatestCommentMention(id, me, false);
  assert.equal(store.queryItems({}).total, 0);
  store.setLatestCommentMention(id, '22222222-2222-2222-2222-222222222222', true);
  assert.equal(store.queryItems({}).total, 0);
  const otherOrg = save('2', { source_scope: 'https://dev.azure.com/another', assigned_to: 'Me' });
  assert.deepEqual(store.setItemHidden(otherOrg, true), { hidden: true });
  assert.equal(store.setItemHidden(9999, true).status, 404);
});

test('restoring an overridden hide preference keeps the item visible after ownership changes', (t) => {
  const { store, save } = fixture(t);
  const id = save('1');
  store.setItemHidden(id, true);
  save('1', { assigned_to: 'Me' });
  store.setItemHidden(id, false);
  save('1');
  assert.equal(store.queryItems({}).total, 1);
});

test('latest comment means the last real comment, not an earlier mention or later field-only update', () => {
  const mention = `<a data-vss-mention="version:2.0,${me}">@Me</a>`;
  const first = { rev: 1, fields: { 'System.History': { newValue: mention } } };
  const second = { rev: 2, fields: { 'System.History': { newValue: 'Thanks' } } };
  const fieldOnly = { rev: 3, fields: { 'System.State': { newValue: 'Active' } } };
  assert.equal(latestCommentMentionsMe([fieldOnly, first], me), true);
  assert.equal(latestCommentMentionsMe([fieldOnly, second, first], me), false);
  assert.equal(latestCommentMentionsMe([{ ...first, fields: { 'System.History': { newValue: 'Me' } } }], me), false);
  assert.equal(latestCommentMentionsMe([], me), false);
});

test('private notes are stored locally, persist, and clear when emptied', (t) => {
  const { store, filename, save } = fixture(t);
  const id = save('1');
  assert.deepEqual(store.getItemNote(id), { note: '', updated_at: null });
  assert.equal(store.setItemNote(id, 'secret').note, 'secret');
  assert.equal(store.setItemNote(999, 'x').status, 404);
  const reopened = createStore(filename);
  try { assert.equal(reopened.getItemNote(id).note, 'secret'); } finally { reopened.close(); }
  store.setItemNote(id, '  ');
  assert.equal(store.getItemNote(id).note, '');
});

test('note images are stored locally and rendered only for local image URLs', (t) => {
  const { store, save } = fixture(t);
  const { renderMarkdown } = require('./markdown');
  const id = save('1');
  const added = store.addNoteImage(id, 'image/png', Buffer.from([1, 2, 3]));
  assert.deepEqual([...store.getNoteImage(added.id).data], [1, 2, 3]);
  assert.equal(store.addNoteImage(999, 'image/png', Buffer.from([1])).status, 404);
  const opts = { noteImages: true };
  assert.match(renderMarkdown(`![x](/api/note-images/${added.id})`, '', opts), /<img src="\/api\/note-images\/\d+"/);
  assert.doesNotMatch(renderMarkdown('![x](https://evil.example/a.png)', '', opts), /<img/);
  assert.doesNotMatch(renderMarkdown(`![x](/api/note-images/${added.id})`), /<img/);
  assert.doesNotMatch(renderMarkdown('<img src=x onerror=alert(1)> **b**', '', opts), /<img/);
});
