'use strict';

const MarkdownIt = require('markdown-it');
const { resolveRelative } = require('./reading-common');

function render(content, connection, current, pages = []) {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const headings = [];
  const renderedNavigation = new Set();
  md.block.ruler.before('paragraph', 'wiki-navigation', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const line = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]).trim();
    const marker = /^\[\[_(TOC|TOSP)_\]\]$/.exec(line);
    if (!marker) return false;
    if (silent) return true;
    const token = state.push('wiki_navigation', '', 0);
    token.content = marker[1];
    token.map = [startLine, startLine + 1];
    state.line = startLine + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  function navigationList(items) {
    return '<ul>' + items.map(item => '<li>' +
      (item.href ? `<a href="${md.utils.escapeHtml(item.href)}">${md.utils.escapeHtml(item.text)}</a>` : md.utils.escapeHtml(item.text)) +
      (item.children.length ? navigationList(item.children) : '') + '</li>').join('') + '</ul>';
  }
  function headingTree() {
    const root = { level: 0, children: [] };
    const stack = [root];
    for (const heading of headings) {
      while (stack.at(-1).level >= heading.level) stack.pop();
      const item = { ...heading, children: [] };
      stack.at(-1).children.push(item);
      stack.push(item);
    }
    return root.children;
  }
  function subpageTree() {
    const root = { children: [] };
    const nodes = new Map();
    const prefix = current === '/' ? '/' : current + '/';
    for (const page of pages) {
      if (!page.path.startsWith(prefix) || page.path === current) continue;
      let parent = root;
      let path = prefix.slice(0, -1);
      const parts = page.path.slice(prefix.length).split('/');
      for (const part of parts) {
        path += '/' + part;
        if (!nodes.has(path)) {
          const item = { text: part, children: [] };
          nodes.set(path, item);
          parent.children.push(item);
        }
        parent = nodes.get(path);
      }
      parent.text = page.title || parts.at(-1);
      parent.href = `/reading.html?wiki=${encodeURIComponent(connection.id)}&page=${encodeURIComponent(page.path)}`;
    }
    return root.children;
  }
  md.renderer.rules.wiki_navigation = (tokens, index) => {
    const kind = tokens[index].content;
    if (renderedNavigation.has(kind)) return '';
    renderedNavigation.add(kind);
    const title = kind === 'TOC' ? 'Contents' : 'Child pages';
    const items = kind === 'TOC' ? headingTree() : subpageTree();
    const empty = kind === 'TOC' ? 'This page has no headings.' : 'This page has no child pages.';
    return `<nav class="wiki-navigation" aria-label="${title}"><p class="wiki-navigation-title">${title}</p>` +
      (items.length ? navigationList(items) : `<p class="reading-help">${empty}</p>`) + '</nav>\n';
  };
  md.block.ruler.before('fence', 'azure-mermaid', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const line = index => state.src.slice(state.bMarks[index] + state.tShift[index], state.eMarks[index]);
    if (!/^:::\s*mermaid\s*$/i.test(line(startLine))) return false;
    let closing = startLine + 1;
    while (closing < endLine && !/^:::\s*$/.test(line(closing))) closing++;
    if (closing === endLine) return false;
    if (silent) return true;
    const token = state.push('fence', 'code', 0);
    token.info = 'mermaid';
    token.content = state.getLines(startLine + 1, closing, state.blkIndent, true);
    token.map = [startLine, closing + 1];
    token.markup = ':::';
    state.line = closing + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index];
    if (token.info.trim().split(/\s+/)[0].toLowerCase() !== 'mermaid') {
      return defaultFence(tokens, index, options, env, self);
    }
    return '<figure class="wiki-diagram"><figcaption>Mermaid diagram</figcaption>' +
      '<div class="diagram-output" tabindex="0" role="region" aria-label="Diagram; scroll to see more" hidden></div>' +
      '<p class="diagram-hint" hidden>Scroll within the diagram to see more.</p>' +
      '<p class="diagram-status" role="status">Loading diagram...</p>' +
      '<details class="diagram-source"><summary>Diagram source</summary><pre><code class="language-mermaid">' +
      md.utils.escapeHtml(token.content) + '</code></pre></details></figure>\n';
  };
  const slugs = new Map();
  const usedSlugs = new Set();
  const knownPaths = new Set(pages.map(page => page.path));
  const alias = value => value.toLowerCase().replace(/ /g, '-');
  const aliases = new Map();
  for (const page of pages) {
    const key = alias(page.path);
    aliases.set(key, aliases.has(key) ? null : page.path);
  }
  function pagePath(path) {
    return knownPaths.has(path) ? path : aliases.get(alias(path)) || path;
  }
  const headingFragment = value => '#wiki-heading-' + value.slice(1);
  function localLink(href, image = false) {
    try {
      if (!href || href.startsWith('//')) return null;
      if (href.startsWith('#')) return image ? null : headingFragment(href);
      let raw = href;
      if (/^[a-z][a-z\d+.-]*:/i.test(raw)) {
        const url = new URL(raw);
        if (url.username || url.password) return null;
        if (['https:', 'http:', 'mailto:'].includes(url.protocol)) {
          const base = new URL(connection.url);
          if (url.origin !== base.origin || !(url.pathname === base.pathname || url.pathname.startsWith(base.pathname + '/'))) return image ? null : url.href;
          raw = url.searchParams.get('pagePath') || url.pathname.slice(base.pathname.length) || current;
          raw += url.hash;
        } else return null;
      }
      const hashAt = raw.indexOf('#');
      const fragment = hashAt < 0 ? '' : headingFragment(raw.slice(hashAt));
      raw = (hashAt < 0 ? raw : raw.slice(0, hashAt)).split('?')[0];
      let path = raw ? resolveRelative(current, raw) : current;
      if (image) return `/api/reading/connections/${encodeURIComponent(connection.id)}/image?path=${encodeURIComponent(path)}`;
      path = pagePath(path.replace(/\.md$/i, ''));
      return `/reading.html?wiki=${encodeURIComponent(connection.id)}&page=${encodeURIComponent(path)}${fragment}`;
    } catch { return null; }
  }
  md.inline.ruler.before('link', 'wiki-link', (state, silent) => {
    if (state.src.slice(state.pos, state.pos + 2) !== '[[') return false;
    const end = state.src.indexOf(']]', state.pos + 2);
    if (end < 0) return false;
    const parts = state.src.slice(state.pos + 2, end).split('|');
    if (!silent) {
      const token = state.push('link_open', 'a', 1);
      let target = parts[1] || parts[0];
      if (!/^(?:[a-z][a-z\d+.-]*:|\/|#|\.{1,2}\/)/i.test(target)) {
        target = '/' + (connection.provider === 'github' ? target.replace(/ /g, '-') : target);
      }
      token.attrSet('href', target);
      state.push('text', '', 0).content = parts[0];
      state.push('link_close', 'a', -1);
    }
    state.pos = end + 2;
    return true;
  });
  const defaultLink = md.renderer.rules.link_open || ((tokens, i, opts, env, self) => self.renderToken(tokens, i, opts));
  md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
    const href = localLink(tokens[i].attrGet('href'));
    tokens[i].attrSet('href', href || '#');
    if (href && /^(?:https?:|mailto:)/.test(href)) tokens[i].attrSet('rel', 'noreferrer noopener');
    return defaultLink(tokens, i, opts, env, self);
  };
  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, i, opts, env, self) => {
    const src = localLink(tokens[i].attrGet('src'), true);
    if (!src) return md.utils.escapeHtml(tokens[i].content || '[External image blocked]');
    tokens[i].attrSet('src', src);
    tokens[i].attrSet('loading', 'lazy');
    return defaultImage(tokens, i, opts, env, self);
  };
  md.core.ruler.after('inline', 'wiki-headings', state => {
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (token.type !== 'heading_open') continue;
      const inline = state.tokens[i + 1];
      const heading = inline?.children?.map(child => ['text', 'code_inline', 'image'].includes(child.type) ? child.content : '').join('') || inline?.content || '';
      const base = heading.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s/g, '-') || 'section';
      let count = slugs.get(base) || 0;
      let slug = count ? `${base}-${count}` : base;
      while (usedSlugs.has(slug)) slug = `${base}-${++count}`;
      slugs.set(base, count + 1);
      usedSlugs.add(slug);
      const id = 'wiki-heading-' + slug;
      token.attrSet('id', id);
      headings.push({ text: heading, level: Number(token.tag.slice(1)), href: '#' + encodeURIComponent(id) });
    }
  });
  return md.render(content);
}

module.exports = { render };
