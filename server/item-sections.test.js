'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'item.js'), 'utf8');

function element() {
  const attributes = new Map();
  const classes = new Set();
  return {
    hidden: false,
    value: '',
    children: [],
    dataset: {},
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    get childElementCount() { return this.children.length; },
    get textContent() {
      return this._textContent ?? this.children.map((child) => child.textContent || '').join('');
    },
    set textContent(value) { this._textContent = String(value); },
    set innerHTML(value) { this._textContent = String(value).replace(/<[^>]*>/g, ' '); },
    addEventListener() {},
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getAttribute(name) { return attributes.get(name) || null; },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
  };
}

function page(search = '') {
  const nodes = new Map();
  const get = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: get, createElement: element },
    location: { search },
    window: { addEventListener() {} },
    URLSearchParams,
    fetch: async () => ({ json: async () => ({}) }),
  });
  vm.runInContext(source, context);
  return { context, get };
}

test('items opened from discovery return to Discovery Room', () => {
  const { get } = page('?room=discovery');
  assert.equal(get('#room-back-link').href, '/?room=discovery');
  assert.equal(get('#room-back-label').textContent, 'Discovery Room');
  assert.match(get('#history-status').textContent, /Discovery Room/);
});

test('marks the section at the sticky-menu boundary as the current location', () => {
  const { context, get } = page();
  const nav = get('#item-sections');
  const sectionTops = new Map([['#detail', 40], ['#why', 240]]);
  const links = ['#detail', '#why'].map((href) => {
    const link = element();
    link.setAttribute('href', href);
    return link;
  });
  nav.hidden = false;
  nav.getBoundingClientRect = () => ({ bottom: 80 });
  nav.querySelectorAll = (selector) => selector.includes('aria-current')
    ? links.filter((link) => link.getAttribute('aria-current') === 'location')
    : links;
  for (const [href] of sectionTops) get(href).getBoundingClientRect = () => ({ top: sectionTops.get(href) });

  context.updateCurrentSection();
  assert.equal(links[0].getAttribute('aria-current'), 'location');
  assert.equal(links[0].classList.contains('is-current'), true);

  sectionTops.set('#detail', -200);
  sectionTops.set('#why', 70);
  context.updateCurrentSection();
  assert.equal(links[0].getAttribute('aria-current'), null);
  assert.equal(links[1].getAttribute('aria-current'), 'location');
  assert.equal(links[1].classList.contains('is-current'), true);
});

test('keeps recent revisions visible and makes older activity expandable and filter-aware', async () => {
  const { context, get } = page();
  const revisions = Array.from({ length: 7 }, (_, index) => ({
    rev: 7 - index,
    date: `2026-10-${String(28 - index).padStart(2, '0')}T10:00:00Z`,
    by: 'Example User',
    comment: index % 2 === 0 ? `<p>Comment ${index}</p>` : null,
    changes: [],
  }));
  context.fetch = async () => ({ ok: true, json: async () => ({ revisions }) });

  await vm.runInContext("loadHistory('123')", context);
  assert.equal(get('#history-status').textContent, '7 revisions');
  assert.equal(get('#history-list').children.length, 5);
  assert.equal(get('#older-history-list').children.length, 2);
  assert.equal(get('#older-history').hidden, false);
  assert.match(get('#older-history-summary').textContent, /Show older activity \(2\)/);

  get('#comments-only').checked = true;
  context.filterHistory();
  assert.equal(get('#older-history-list').children[0].hidden, true);
  assert.equal(get('#older-history-list').children[1].hidden, false);
  assert.equal(get('#older-history').hidden, false);
  assert.match(get('#older-history-summary').textContent, /Show older comments \(1\)/);
});

for (const section of [
  { id: 'sec-attachments', loader: 'loadAttachments', key: 'attachments', status: '#attachments-status', entry: { name: 'file.txt', url: 'https://example.com/file.txt' } },
  { id: 'sec-links', loader: 'loadRelatedLinks', key: 'links', status: '#links-status', entry: { type: 'Related', title: 'Another item', url: 'https://example.com/item' } },
]) {
  test(`${section.id} hides empty content and its menu link, then shows populated content`, async () => {
    const { context, get } = page();
    context.fetch = async () => ({ ok: true, json: async () => ({ [section.key]: [] }) });
    await vm.runInContext(`${section.loader}('123')`, context);
    assert.equal(get(`#${section.id}`).hidden, true);
    assert.equal(get(`#item-sections a[href="#${section.id}"]`).hidden, true);
    assert.equal(get('#sec-notes').hidden, false);
    assert.equal(get('#sec-history').hidden, false);

    context.fetch = async () => ({ ok: true, json: async () => ({ [section.key]: [section.entry] }) });
    await vm.runInContext(`${section.loader}('123')`, context);
    assert.equal(get(`#${section.id}`).hidden, false);
    assert.equal(get(`#item-sections a[href="#${section.id}"]`).hidden, false);
  });

  test(`${section.id} shows API errors rather than hiding them as empty content`, async () => {
    const { context, get } = page();
    get(`#${section.id}`).hidden = true;
    context.fetch = async () => ({ ok: false, json: async () => ({ error: 'Connection unavailable' }) });
    await vm.runInContext(`${section.loader}('123')`, context);
    assert.equal(get(`#${section.id}`).hidden, false);
    assert.equal(get(`#item-sections a[href="#${section.id}"]`).hidden, false);
    assert.match(get(section.status).textContent, /Connection unavailable/);
  });

  test(`${section.id} stays visible during loading and after network failure`, async () => {
    const { context, get } = page();
    let reject;
    context.fetch = () => new Promise((resolve, fail) => { reject = fail; });
    const loading = vm.runInContext(`${section.loader}('123')`, context);
    assert.equal(get(`#${section.id}`).hidden, false);
    assert.equal(get(`#item-sections a[href="#${section.id}"]`).hidden, false);
    reject(new Error('Network unavailable'));
    await loading;
    assert.equal(get(`#${section.id}`).hidden, false);
    assert.match(get(section.status).textContent, /Network unavailable/);
  });
}
