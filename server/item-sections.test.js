'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'item.js'), 'utf8');

function element() {
  return {
    hidden: false,
    value: '',
    children: [],
    addEventListener() {},
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
  };
}

function page() {
  const nodes = new Map();
  const get = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: get, createElement: element },
    location: { search: '' },
    window: { addEventListener() {} },
    URLSearchParams,
    fetch: async () => ({ json: async () => ({}) }),
  });
  vm.runInContext(source, context);
  return { context, get };
}

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
