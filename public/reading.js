'use strict';

const $ = (selector) => document.querySelector(selector);
const STORAGE_KEY = 'war-room-reading-position';
const providerNames = { 'azure-devops': 'Azure DevOps', github: 'GitHub' };
let connections = [];
let currentWiki = null;
let currentPath = null;
let pages = [];
let readingState = { lastWiki: '', wikis: {} };
let navigationVersion = 0;
let targetVersion = 0;
let searchVersion = 0;
let targetId = '';
let scrollTimer;
let restoringScroll = false;
let documentLoaded = false;
const expandedBranches = new Map();

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function message(selector, text, tone = 'error') {
  $(selector).textContent = text || '';
  $(selector).hidden = !text;
  $(selector).classList.toggle('reading-info', tone === 'info');
}

async function request(path, options = {}) {
  const response = await fetch(`/api/reading${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Reading Room could not reach its server. Restart War Room and try again.');
  }
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `Reading Room request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function run(action) {
  Promise.resolve().then(action).catch((error) => message('#reading-notice', error.message));
}

function restoreReadingState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed.lastWiki !== 'string' || !parsed.wikis || typeof parsed.wikis !== 'object' || Array.isArray(parsed.wikis)) {
      throw new Error('The saved reading position is invalid.');
    }
    readingState = parsed;
  } catch (error) {
    message('#storage-notice', `Your last reading position could not be restored. ${error.message}`);
  }
}

function persistReadingState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(readingState));
  } catch (error) {
    message('#storage-notice', `Your reading position could not be saved in this browser. ${error.message}`);
  }
}

function rememberPosition() {
  if (!currentWiki || currentPath === null || !documentLoaded || restoringScroll || !$('#search-panel').hidden) return;
  readingState.wikis[String(currentWiki.id)] = { path: currentPath, scroll: window.scrollY };
  readingState.lastWiki = String(currentWiki.id);
  persistReadingState();
}

function pageUrl(id, path) {
  const params = new URLSearchParams({ wiki: String(id), page: path });
  return `/reading.html?${params}`;
}

function setLocation(id, path, mode = 'push', hash = '') {
  const url = pageUrl(id, path) + hash;
  if (location.pathname + location.search + location.hash !== url) {
    history[mode === 'replace' ? 'replaceState' : 'pushState'](null, '', url);
  }
}

function setManager(open) {
  $('#wiki-manager').hidden = !open;
  $('#manage-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('#manager-title').focus({ preventScroll: true });
  else $('#manage-toggle').focus({ preventScroll: true });
}

function setPagesOpen(open, returnFocus = false) {
  $('#page-sidebar').classList.toggle('is-open', open);
  $('#pages-toggle').setAttribute('aria-expanded', String(open));
  $('#pages-toggle').textContent = open ? 'Close pages' : 'Pages';
  if (open) {
    const first = $('#page-tree').querySelector('[aria-current="page"]') || $('#page-tree').querySelector('a');
    first?.focus({ preventScroll: true });
  } else if (returnFocus) $('#pages-toggle').focus({ preventScroll: true });
}

function renderCollection() {
  $('#wiki-select').replaceChildren(...connections.map((connection) => {
    const option = node('option', `${connection.name} (${providerNames[connection.provider]})`);
    option.value = String(connection.id);
    return option;
  }));
  if (currentWiki) $('#wiki-select').value = String(currentWiki.id);
  $('#reading-workspace').hidden = !connections.length;
  $('#reading-empty').hidden = Boolean(connections.length);
  $('#pages-toggle').hidden = !connections.length;
  renderManagedWikis();
}

function actionButton(label, handler, className = 'button') {
  const button = node('button', label, className);
  button.type = 'button';
  button.addEventListener('click', () => run(async () => {
    button.disabled = true;
    try { await handler(); } finally { button.disabled = false; }
  }));
  return button;
}

async function updateConnection(id, values) {
  await request(`/connections/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(values) });
  const data = await request('/connections');
  connections = data.connections;
  currentWiki = connections.find((entry) => String(entry.id) === String(currentWiki?.id)) || null;
  renderCollection();
  if (currentWiki && documentLoaded) {
    $('#document-source').textContent = sourceLabel(currentWiki);
  }
}

function renderManagedWikis() {
  const list = $('#managed-wikis');
  list.replaceChildren();
  connections.forEach((connection, index) => {
    const item = node('li');
    const label = node('label', undefined, 'form-field');
    label.append(node('span', 'Display name'));
    const input = node('input');
    input.value = connection.name;
    input.maxLength = 100;
    input.required = true;
    input.setAttribute('aria-label', `Display name for ${connection.name}`);
    label.append(input);
    const actions = node('div', undefined, 'managed-actions');
    const save = actionButton('Save name', async () => {
      if (!input.reportValidity() || !input.value.trim()) throw new Error('Enter a display name before saving.');
      await updateConnection(connection.id, { name: input.value.trim() });
      message('#reading-notice', 'Wiki name saved.', 'info');
    });
    const up = actionButton('Up', async () => updateConnection(connection.id, { position: index - 1 }));
    up.disabled = index === 0;
    up.setAttribute('aria-label', `Move ${connection.name} up`);
    const down = actionButton('Down', async () => updateConnection(connection.id, { position: index + 1 }));
    down.disabled = index === connections.length - 1;
    down.setAttribute('aria-label', `Move ${connection.name} down`);
    const remove = actionButton('Remove', async () => {
      if (item.querySelector('.remove-confirmation')) return;
      const confirmation = node('div', undefined, 'remove-confirmation');
      confirmation.append(node('span', `Remove "${connection.name}" from Reading Room? The original wiki will not change.`));
      const confirm = actionButton('Remove from collection', async () => {
        await request(`/connections/${encodeURIComponent(connection.id)}`, { method: 'DELETE' });
        const wasCurrent = String(currentWiki?.id) === String(connection.id);
        delete readingState.wikis[String(connection.id)];
        connections = connections.filter((entry) => String(entry.id) !== String(connection.id));
        if (readingState.lastWiki === String(connection.id)) readingState.lastWiki = '';
        persistReadingState();
        if (wasCurrent) {
          ++navigationVersion;
          currentWiki = null;
          currentPath = null;
          documentLoaded = false;
        }
        renderCollection();
        if (wasCurrent && connections.length) await openWiki(connections[0].id, undefined, 'replace');
        else if (!connections.length) {
          history.replaceState(null, '', '/reading.html');
          document.title = 'Reading Room - War Room';
        }
        message('#reading-notice', 'Wiki removed from your collection. The original wiki is unchanged.', 'info');
        $('#manager-title').focus({ preventScroll: true });
      }, 'button reading-danger');
      const cancel = actionButton('Keep wiki', async () => {
        confirmation.remove();
        remove.focus();
      });
      confirmation.append(confirm, cancel);
      item.append(confirmation);
      confirm.focus();
    }, 'button reading-danger');
    actions.append(save, up, down, remove);
    item.append(label, actions, node('p', sourceLabel(connection), 'reading-help'));
    list.append(item);
  });
}

function sourceLabel(connection) {
  const target = connection.provider === 'github' ? connection.repository : connection.project;
  return `${providerNames[connection.provider]} / ${target || connection.wikiName}`;
}

function resetTargets() {
  ++targetVersion;
  targetId = '';
  $('#target-results').replaceChildren();
  $('#add-form').hidden = true;
  $('#add-wiki').replaceChildren();
  $('#add-name').value = '';
  message('#add-status', '');
}

function updateProvider() {
  resetTargets();
  const provider = $('#add-provider').value;
  $('#target-query').disabled = !provider;
  $('#target-search').disabled = !provider;
  $('#target-query').value = '';
  $('#target-label').textContent = provider === 'azure-devops' ? 'Project' : provider === 'github' ? 'Repository' : 'Project or repository';
  $('#target-query').placeholder = provider === 'github' ? 'Repository name or owner/repository' : 'Search by project name';
  $('#target-hint').textContent = provider
    ? 'Search for a specific name. Reading Room does not list every project or wiki.'
    : 'Choose a source first. Nothing is listed until you search.';
}

async function findTargets(event) {
  event.preventDefault();
  resetTargets();
  const version = targetVersion;
  const query = $('#target-query').value.trim();
  if (!query) return;
  const provider = $('#add-provider').value;
  $('#target-search').disabled = true;
  message('#add-status', 'Finding matching projects or repositories...');
  try {
    const data = await request(`/targets?${new URLSearchParams({ provider, q: query })}`);
    if (version !== targetVersion) return;
    message('#add-status', data.targets.length ? 'Choose a project or repository to see its wikis.' : 'No matches. Try a more specific name or check your connection permissions in Settings.');
    $('#target-results').replaceChildren(...data.targets.map((target) => {
      const item = node('li');
      item.append(actionButton(target.label || target.name, async () => {
        const selectionVersion = ++targetVersion;
        targetId = String(provider === 'azure-devops' ? target.name : target.id);
        $('#add-form').hidden = true;
        $('#add-wiki').replaceChildren();
        message('#add-status', `Finding wikis in ${target.label || target.name}...`);
        try {
          const result = await request(`/wikis?${new URLSearchParams({ provider, target: targetId })}`);
          if (selectionVersion !== targetVersion) return;
          if (!result.wikis.length) {
            message('#add-status', 'No wiki is available here. Create one in the source, or choose another project or repository.');
            return;
          }
          $('#add-wiki').replaceChildren(...result.wikis.map((wiki) => {
            const option = node('option', wiki.name);
            option.value = String(wiki.id);
            return option;
          }));
          $('#selected-target').textContent = `${providerNames[provider]} / ${target.label || target.name}`;
          $('#add-form').hidden = false;
          message('#add-status', '');
          $('#add-wiki').focus();
        } catch (error) {
          if (selectionVersion === targetVersion) message('#add-status', error.message);
        }
      }, 'wiki-choice'));
      return item;
    }));
  } catch (error) {
    if (version === targetVersion) message('#add-status', error.message);
  } finally {
    $('#target-search').disabled = !$('#add-provider').value;
  }
}

async function addWiki(event) {
  event.preventDefault();
  const button = $('#add-submit');
  button.disabled = true;
  const values = {
    provider: $('#add-provider').value,
    target: targetId,
    wikiId: $('#add-wiki').value,
    name: $('#add-name').value.trim() || undefined,
  };
  message('#add-status', 'Connecting your wiki. The first read may take a moment...');
  try {
    const result = await request('/connections', { method: 'POST', body: JSON.stringify(values) });
    connections = (await request('/connections')).connections;
    resetTargets();
    renderCollection();
    setManager(false);
    await openWiki(result.connection.id);
    message('#reading-notice', 'Wiki added to your collection.', 'info');
  } catch (error) {
    message('#add-status', error.message);
  } finally { button.disabled = false; }
}

function renderTree() {
  const root = { children: new Map() };
  const wikiId = String(currentWiki.id);
  if (!expandedBranches.has(wikiId)) expandedBranches.set(wikiId, new Set());
  const expanded = expandedBranches.get(wikiId);
  for (const page of pages) {
    const parts = page.path.split('/').filter(Boolean);
    if (!parts.length) parts.push(page.title || 'Home');
    let branch = root;
    for (const part of parts) {
      if (!branch.children.has(part)) branch.children.set(part, { title: part.replace(/-/g, ' '), children: new Map() });
      branch = branch.children.get(part);
    }
    branch.page = page;
    branch.title = page.title;
  }
  function branchList(branch, parentPath = '') {
    const list = node('ul');
    for (const [segment, child] of branch.children) {
      const branchPath = `${parentPath}/${segment}`;
      const item = node('li');
      let label;
      if (child.page) {
        label = node('a', child.title);
        label.href = pageUrl(currentWiki.id, child.page.path);
        label.dataset.pagePath = child.page.path;
        if (child.page.path === currentPath) label.setAttribute('aria-current', 'page');
      } else label = node('span', child.title, 'tree-folder');
      if (child.children.size) {
        const details = node('details');
        const activeAncestor = `/${String(currentPath || '').replace(/^\/+/, '')}`.startsWith(`${branchPath}/`);
        details.open = expanded.has(branchPath) || activeAncestor;
        details.addEventListener('toggle', () => {
          if (details.open) expanded.add(branchPath);
          else expanded.delete(branchPath);
        });
        const summary = node('summary');
        summary.append(label);
        details.append(summary, branchList(child, branchPath));
        item.append(details);
      } else item.append(label);
      list.append(item);
    }
    return list;
  }
  $('#page-tree').replaceChildren(branchList(root));
}

function showReaderStatus(text, loading = false) {
  documentLoaded = false;
  $('#document-panel').hidden = true;
  $('#search-panel').hidden = true;
  $('#reader-status').hidden = false;
  $('#reader-status').replaceChildren(node('p', text));
  $('#reader-status').setAttribute('aria-busy', String(loading));
}

function showReaderError(error, id, path, home = false) {
  showReaderStatus(error.status === 404 ? `This page is no longer available. ${error.message}` : error.message);
  $('#reader-status').append(actionButton('Try again', async () => {
    if (home) await openWiki(id, path, 'replace');
    else await loadPage(path, { mode: 'replace', force: true });
  }));
  if (!home && pages.length) {
    $('#reader-status').append(actionButton('Go to wiki home', async () => {
      await loadPage(homePage().path);
    }));
  }
}

function homePage() {
  return pages.find((page) => /^\/?home$/i.test(page.path)) || pages[0];
}

async function openWiki(id, path, mode = 'push', hash = '', refresh = false) {
  const connection = connections.find((entry) => String(entry.id) === String(id));
  if (!connection) {
    message('#reading-notice', 'This wiki is not in your collection. Add it using Manage wikis, or choose a saved wiki.');
    return;
  }
  rememberPosition();
  const version = ++navigationVersion;
  ++searchVersion;
  currentWiki = connection;
  currentPath = null;
  pages = [];
  $('#wiki-select').value = String(id);
  $('#page-tree').replaceChildren();
  message('#tree-status', 'Loading pages...');
  showReaderStatus(`Opening ${connection.name}...`, true);
  setPagesOpen(false);
  try {
    const tree = await request(`/connections/${encodeURIComponent(id)}/tree${refresh ? '?refresh=1' : ''}`);
    if (version !== navigationVersion) return;
    pages = tree.pages;
    message('#tree-status', tree.warning || (!pages.length ? 'This wiki has no pages yet. Add pages in the original wiki.' : ''));
    renderTree();
    const saved = readingState.wikis[String(id)];
    const selected = path !== undefined ? path : typeof saved?.path === 'string' ? saved.path : homePage()?.path;
    if (selected === undefined) {
      showReaderStatus('This wiki has no readable pages yet. Add a page in the source, then refresh.');
      if (connection.url) {
        const link = node('a', 'Open original wiki', 'button');
        link.href = connection.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        $('#reader-status').append(link);
      }
      return;
    }
    await loadPage(selected, { mode, hash });
  } catch (error) {
    if (version !== navigationVersion) return;
    message('#tree-status', 'Pages could not be loaded. Your saved connection has not been removed.');
    showReaderError(error, id, path, true);
  }
}

function scrollToSection(hash) {
  try {
    const anchor = decodeURIComponent(hash.slice(1));
    const heading = $('#document-body').querySelector(`#${CSS.escape(anchor)}`)
      || $('#document-body').querySelector(`#${CSS.escape(`wiki-heading-${anchor}`)}`);
    heading?.scrollIntoView();
  } catch {
    message('#reading-notice', 'The document opened, but its section link is not valid.');
  }
}

async function loadPage(path, { mode = 'push', hash = '', force = false } = {}) {
  if (!currentWiki) return;
  rememberPosition();
  const id = String(currentWiki.id);
  const version = ++navigationVersion;
  ++searchVersion;
  currentPath = path;
  setLocation(id, path, mode, hash);
  renderTree();
  showReaderStatus('Loading document...', true);
  setPagesOpen(false);
  try {
    const page = await request(`/connections/${encodeURIComponent(id)}/page?${new URLSearchParams({ path, ...(force ? { refresh: '1' } : {}) })}`);
    if (version !== navigationVersion) return;
    currentPath = page.path;
    setLocation(id, page.path, 'replace', hash);
    $('#document-title').textContent = page.title;
    $('#document-path').textContent = page.path.split('/').filter(Boolean).join(' / ');
    $('#document-source').textContent = sourceLabel(currentWiki);
    $('#document-refreshed').textContent = page.fetchedAt ? `Fetched ${new Date(page.fetchedAt).toLocaleString()}` : '';
    $('#open-original').href = page.url;
    message('#document-warning', page.warning);
    $('#document-body').innerHTML = page.html;
    if (!page.html) $('#document-body').append(node('p', 'This page has no content yet.'));
    $('#reader-status').hidden = true;
    $('#document-panel').hidden = false;
    $('#search-panel').hidden = true;
    document.title = `${page.title} - Reading Room - War Room`;
    renderTree();
    const documentBody = $('#document-body');
    if (documentBody.querySelector('figure.wiki-diagram')) {
      if (window.ReadingDiagrams) {
        await window.ReadingDiagrams.render(documentBody, () => version === navigationVersion);
        if (version !== navigationVersion) return;
      } else {
        message('#document-warning', [page.warning, 'Diagram rendering did not load. Reload Reading Room to try again.'].filter(Boolean).join(' '));
        for (const details of documentBody.querySelectorAll('.diagram-source')) details.open = true;
      }
    }
    documentLoaded = true;
    const saved = readingState.wikis[id];
    const scroll = saved?.path === page.path && Number.isFinite(saved.scroll) ? Math.max(0, saved.scroll) : 0;
    restoringScroll = true;
    requestAnimationFrame(() => {
      if (version !== navigationVersion) { restoringScroll = false; return; }
      if (hash) scrollToSection(hash);
      else window.scrollTo({ top: scroll, behavior: 'instant' });
      restoringScroll = false;
      rememberPosition();
    });
  } catch (error) {
    if (version !== navigationVersion) return;
    showReaderError(error, id, path);
  }
}

async function searchPages(event) {
  event.preventDefault();
  const query = $('#page-query').value.trim();
  if (!query) return;
  rememberPosition();
  const version = ++searchVersion;
  const navigation = navigationVersion;
  const connectionId = $('#search-scope').value === 'current' ? String(currentWiki.id) : '';
  const params = new URLSearchParams({ q: query });
  if (connectionId) params.set('connectionId', connectionId);
  $('#page-search').disabled = true;
  $('#reader-status').hidden = true;
  $('#document-panel').hidden = true;
  $('#search-panel').hidden = false;
  $('#search-title').textContent = `Results for "${query}"`;
  $('#search-results').replaceChildren();
  message('#search-summary', 'Searching page content. The first search can take longer while pages are loaded...');
  try {
    const data = await request(`/search?${params}`);
    if (version !== searchVersion || navigation !== navigationVersion) return;
    const scope = connectionId ? currentWiki.name : 'your saved wikis';
    const warnings = data.warnings?.length ? ` ${data.warnings.join(' ')}` : '';
    message('#search-summary', `${data.results.length} result${data.results.length === 1 ? '' : 's'} in ${scope}.${warnings}`);
    $('#search-results').replaceChildren(...data.results.map((result) => {
      const item = node('li');
      const link = node('a', result.title);
      link.href = pageUrl(result.connectionId, result.path);
      item.append(link, node('small', `${result.connectionName} / ${result.path}`), node('p', result.excerpt));
      return item;
    }));
  } catch (error) {
    if (version === searchVersion && navigation === navigationVersion) message('#search-summary', error.message);
  } finally { $('#page-search').disabled = false; }
}

async function restoreLocation(mode = 'replace') {
  const params = new URLSearchParams(location.search);
  const requestedWiki = params.get('wiki');
  const requestedPath = params.has('page') ? params.get('page') : undefined;
  const selected = requestedWiki || readingState.lastWiki || String(connections[0]?.id || '');
  if (!connections.some((entry) => String(entry.id) === selected)) {
    if (requestedWiki) message('#reading-notice', 'The linked wiki is not in your saved collection. Add it using Manage wikis.');
    if (connections.length) await openWiki(connections[0].id, undefined, mode);
  } else await openWiki(selected, requestedPath, mode, location.hash);
}

async function initReadingRoom() {
  history.scrollRestoration = 'manual';
  restoreReadingState();
  const [collection, providersResponse] = await Promise.all([
    request('/connections'),
    fetch('/api/providers').then(async (response) => {
      if (!response.ok) throw new Error('Could not load connections. Restart War Room and try again.');
      return response.json();
    }),
  ]);
  connections = collection.connections;
  $('#add-provider').append(...providersResponse.providers.filter((provider) => provider.configured).map((provider) => {
    const option = node('option', provider.label);
    option.value = provider.id;
    return option;
  }));
  renderCollection();
  if (connections.length) await restoreLocation();
}

$('#manage-toggle').addEventListener('click', () => setManager($('#wiki-manager').hidden));
$('#manager-close').addEventListener('click', () => setManager(false));
$('#empty-add').addEventListener('click', () => {
  setManager(true);
  $('#wiki-manager').scrollIntoView({ block: 'start' });
  $('#add-provider').focus({ preventScroll: true });
});
$('#add-provider').addEventListener('change', updateProvider);
$('#target-query').addEventListener('input', () => resetTargets());
$('#target-form').addEventListener('submit', (event) => { event.preventDefault(); run(() => findTargets(event)); });
$('#add-form').addEventListener('submit', (event) => { event.preventDefault(); run(() => addWiki(event)); });
$('#wiki-select').addEventListener('change', () => run(() => openWiki($('#wiki-select').value)));
$('#reading-search').addEventListener('submit', (event) => { event.preventDefault(); run(() => searchPages(event)); });
$('#tree-refresh').addEventListener('click', () => run(() => openWiki(currentWiki.id, currentPath ?? undefined, 'replace', '', true)));
$('#page-refresh').addEventListener('click', () => run(() => loadPage(currentPath, { mode: 'replace', force: true })));
$('#search-back').addEventListener('click', () => {
  ++searchVersion;
  if (currentPath !== null) run(() => loadPage(currentPath, { mode: 'replace' }));
  else if (currentWiki) run(() => openWiki(currentWiki.id, undefined, 'replace'));
});
$('#pages-toggle').addEventListener('click', () => setPagesOpen(!$('#page-sidebar').classList.contains('is-open'), true));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('#page-sidebar').classList.contains('is-open')) setPagesOpen(false, true);
});
document.addEventListener('click', (event) => {
  const link = event.target.closest('a');
  if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || link.target === '_blank') return;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin || url.pathname !== '/reading.html' || !url.searchParams.has('page')) return;
  event.preventDefault();
  const id = url.searchParams.get('wiki');
  const path = url.searchParams.get('page');
  if (documentLoaded && String(currentWiki?.id) === id && currentPath === path && url.hash) {
    setLocation(id, path, 'push', url.hash);
    scrollToSection(url.hash);
    rememberPosition();
    return;
  }
  run(async () => {
    if (String(currentWiki?.id) === id) await loadPage(path, { hash: url.hash });
    else await openWiki(id, path, 'push', url.hash);
    $('#reader').focus({ preventScroll: true });
  });
});
window.addEventListener('popstate', () => run(() => restoreLocation()));
window.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(rememberPosition, 150);
}, { passive: true });
window.addEventListener('pagehide', rememberPosition);
initReadingRoom().catch((error) => {
  message('#reading-notice', error.message);
  $('#reading-empty').hidden = false;
});
