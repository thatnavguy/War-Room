'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { render } = require('./reading-markdown');

const connection = { id: 1, provider: 'azure-devops', url: 'https://dev.azure.com/example/project/_wiki/wikis/wiki' };
const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'reading-diagrams.js'), 'utf8');

function diagram(source) {
  const classes = new Set();
  const parts = {
    '.language-mermaid': { textContent: source },
    '.diagram-source': { open: false },
    '.diagram-hint': { hidden: true },
    '.diagram-status': { hidden: false, textContent: 'Loading diagram...', classList: { add: value => classes.add(value) } },
    '.diagram-output': {
      hidden: true, children: [], scrollWidth: 640, clientWidth: 640, scrollHeight: 240, clientHeight: 240,
      replaceChildren(...children) { this.children = children; },
    },
  };
  return { parts, querySelector: selector => parts[selector] };
}

function renderer(figures, mermaid) {
  let resize;
  const context = vm.createContext({
    window: { addEventListener: (event, listener) => { if (event === 'resize') resize = listener; } },
    document: { querySelectorAll: () => figures, createElement: tag => ({ tagName: tag, decode: async () => {} }) },
    DOMParser: class DOMParser {
      parseFromString() {
        return {
          querySelector: selector => selector === 'title' ? { textContent: 'Delivery workflow' } : null,
          documentElement: { getAttribute: () => '0 0 640 240' },
        };
      }
    },
    mermaid,
  });
  vm.runInContext(script, context);
  vm.runInContext('loadMermaid = async () => mermaid;', context);
  const root = { querySelectorAll: () => figures };
  return {
    run: isCurrent => context.window.ReadingDiagrams.render(root, isCurrent),
    evaluate: code => vm.runInContext(code, context),
    resize: () => resize(),
  };
}

test('GitHub fences and Azure DevOps blocks become escaped diagram sources without consuming ordinary code or prose', () => {
  const markdown = [
    '```mermaid',
    'flowchart LR',
    '  A["<script>alert(1)</script>"] --> B[Done]',
    '```',
    '',
    '::: mermaid',
    'sequenceDiagram',
    '  Alice->>Bob: Hello',
    ':::',
    '',
    'After the diagram.',
    '',
    '```js',
    'const ordinary = true;',
    '```',
    '',
    '````text',
    ':::mermaid',
    'Not a real diagram here.',
    ':::',
    '````',
  ].join('\n');
  const html = render(markdown, connection, '/Home');
  assert.equal((html.match(/<figure class="wiki-diagram">/g) || []).length, 2);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<p>After the diagram\.<\/p>/);
  assert.match(html, /class="language-js">const ordinary = true;/);
  assert.match(html, /class="language-text">:::mermaid/);
  assert.doesNotMatch(html, /<script>/);
  const unclosed = render(':::mermaid\nflowchart LR\nA --> B', connection, '/Home');
  assert.doesNotMatch(unclosed, /<figure/);
  const adjacent = render('Before the diagram.\n:::mermaid\nflowchart LR\nA --> B\n:::\nAfter the diagram.', connection, '/Home');
  assert.match(adjacent, /<p>Before the diagram\.<\/p>\n<figure/);
  assert.match(adjacent, /<\/figure>\n<p>After the diagram\.<\/p>/);
});

test('diagrams render as inert, sized SVG images with accessible titles and retained source', async () => {
  const figure = diagram('flowchart LR\nA --> B');
  const calls = [];
  const page = renderer([figure], {
    render: async (id, source) => {
      calls.push({ id, source });
      return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240"><title>Delivery workflow</title></svg>' };
    },
  });
  await page.run();
  assert.equal(calls[0].source, 'flowchart LR\nA --> B');
  const image = figure.parts['.diagram-output'].children[0];
  assert.equal(image.tagName, 'img');
  assert.match(image.src, /^data:image\/svg\+xml;charset=utf-8,/);
  assert.equal(image.alt, 'Delivery workflow');
  assert.equal(image.width, 640);
  assert.equal(figure.parts['.diagram-status'].hidden, true);
  assert.equal(figure.parts['.diagram-source'].open, false);
  assert.equal(figure.parts['.language-mermaid'].textContent, calls[0].source);
  assert.equal(figure.parts['.diagram-hint'].hidden, true);
  figure.parts['.diagram-output'].clientWidth = 320;
  page.resize();
  assert.equal(figure.parts['.diagram-hint'].hidden, false);
  figure.parts['.diagram-output'].clientWidth = 640;
  page.resize();
  assert.equal(figure.parts['.diagram-hint'].hidden, true);
  figure.parts['.diagram-output'].clientHeight = 120;
  page.resize();
  assert.equal(figure.parts['.diagram-hint'].hidden, false);
});

test('an invalid diagram exposes its source and error without preventing later diagrams', async () => {
  const bad = diagram('broken diagram');
  const good = diagram('flowchart LR\nA --> B');
  const page = renderer([bad, good], {
    render: async (id, source) => {
      if (source === 'broken diagram') throw new Error('Unknown diagram type.');
      return { svg: '<svg />' };
    },
  });
  await page.run();
  assert.equal(bad.parts['.diagram-source'].open, true);
  assert.match(bad.parts['.diagram-status'].textContent, /Unknown diagram type/);
  assert.equal(bad.parts['.diagram-output'].hidden, true);
  assert.equal(good.parts['.diagram-output'].hidden, false);
});

test('missing local assets and oversized diagrams show an explicit source fallback', async () => {
  const first = diagram('flowchart LR\nA --> B');
  const page = renderer([first], {});
  page.evaluate('loadMermaid = async () => { throw new Error("Offline"); };');
  await page.run();
  assert.match(first.parts['.diagram-status'].textContent, /Reload Reading Room/);
  assert.equal(first.parts['.diagram-source'].open, true);

  const large = diagram('x'.repeat(50001));
  let rendered = false;
  await renderer([large], { render: async () => { rendered = true; } }).run();
  assert.equal(rendered, false);
  assert.match(large.parts['.diagram-status'].textContent, /50,000-character limit/);
});

test('a late diagram render does not modify a document after navigation', async () => {
  const figure = diagram('flowchart LR\nA --> B');
  let complete;
  let current = true;
  const page = renderer([figure], { render: () => new Promise(resolve => { complete = resolve; }) });
  const pending = page.run(() => current);
  await new Promise(resolve => setImmediate(resolve));
  current = false;
  complete({ svg: '<svg />' });
  await pending;
  assert.equal(figure.parts['.diagram-output'].children.length, 0);
});
