'use strict';

const config = require('./config');

const API_VERSION = '2022-11-28';
const SEARCH_PAGE_LIMIT = 10; // GitHub search returns at most 1000 results
const COMMENT_PAGE_LIMIT = 10;

function apiBase() {
  return config.ghHost === 'github.com' ? 'https://api.github.com' : `https://${config.ghHost}/api/v3`;
}

async function ghFetch(path) {
  const url = path.startsWith('http') ? path : `${apiBase()}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.ghToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub request failed ${res.status} ${url}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function getMyIdentity() {
  const user = await ghFetch('/user');
  if (!user.login) throw new Error('GitHub did not return your login. Check the token in Settings before syncing.');
  return { id: String(user.id), login: user.login, displayName: user.name || user.login };
}

function repoClause() {
  return config.ghRepos.map((repo) => `repo:${repo}`).join(' ');
}

async function searchIssues(qualifiers) {
  const items = [];
  let incomplete = false;
  // GitHub requires a single item type per search; fetch both to keep the feed unified.
  for (const type of ['issue', 'pull-request']) {
    const q = [qualifiers, `is:${type}`, repoClause()].filter(Boolean).join(' ');
    for (let page = 1; page <= SEARCH_PAGE_LIMIT; page++) {
      const data = await ghFetch(`/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}&sort=updated&order=desc`);
      const pageItems = data.items || [];
      items.push(...pageItems);
      incomplete ||= Boolean(data.incomplete_results);
      if (pageItems.length < 100) break;
      if (page === SEARCH_PAGE_LIMIT) incomplete = true;
    }
  }
  return { items, incomplete };
}

function repoFromApiUrl(repositoryUrl) {
  const match = String(repositoryUrl || '').match(/\/repos\/([^/]+\/[^/]+)$/);
  return match ? match[1] : '';
}

async function getComments(repo, number) {
  const comments = [];
  for (let page = 1; page <= COMMENT_PAGE_LIMIT; page++) {
    const data = await ghFetch(`/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    comments.push(...data);
    if (data.length < 100) break;
  }
  return comments;
}

async function getEvents(repo, number) {
  return ghFetch(`/repos/${repo}/issues/${number}/events?per_page=100`);
}

function mentionsMe(text, login) {
  if (!text || !login) return false;
  const escaped = String(login).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])@${escaped}(?![\\w-])`, 'i').test(String(text));
}

module.exports = {
  apiBase,
  getMyIdentity,
  searchIssues,
  repoFromApiUrl,
  getComments,
  getEvents,
  mentionsMe,
};
