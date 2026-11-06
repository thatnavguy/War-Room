'use strict';

const config = require('./config');
const github = require('./github');
const db = require('./db');
const { renderMarkdown } = require('./markdown');

// Watermarks and identity-independent sync state live under this scope;
// per-repository identity (meDisplayName/meId) is stored under each repo scope.
const STATE_SCOPE = '';
const CONCURRENCY = 5;

let running = false;

function scopeFor(repo) {
  return `${config.ghHost}/${repo}`;
}

function mapItem(raw, me) {
  const repo = github.repoFromApiUrl(raw.repository_url);
  const assignees = (raw.assignees || []).map((a) => a && a.login).filter(Boolean);
  // "Assigned to me" compares a single name; surface the local user first.
  const assignedTo = assignees.includes(me.login) ? me.login : (assignees[0] || null);
  const isPr = Boolean(raw.pull_request);
  const closed = raw.state === 'closed';
  return {
    provider: 'github',
    source_scope: scopeFor(repo),
    external_id: String(raw.number),
    rev: 0,
    title: raw.title || '',
    type: isPr ? 'Pull Request' : 'Issue',
    state: closed ? 'Closed' : 'Open',
    is_closed: closed,
    assigned_to: assignedTo,
    created_by: raw.user ? raw.user.login : null,
    created_date: raw.created_at || null,
    changed_by: null, // GitHub search results do not expose the last editor
    changed_date: raw.updated_at || null,
    tags: (raw.labels || []).map((label) => label.name).filter(Boolean).join('; ') || null,
    area_path: null,
    iteration_path: raw.milestone ? raw.milestone.title : null,
    project: repo,
    description: raw.body || null,
    acceptance_criteria: null,
    repro_steps: null,
    history: null,
    attachments: null,
    url: raw.html_url || '',
    synced_at: new Date().toISOString(),
  };
}

function keyOf(raw) {
  return `${github.repoFromApiUrl(raw.repository_url)}#${raw.number}`;
}

async function runSync() {
  if (running) return { skipped: true, reason: 'Sync already in progress' };
  running = true;
  const stats = { candidates: 0, upserted: 0, deepScanned: 0, touches: 0, errors: [] };

  try {
    const identity = await github.getMyIdentity();
    const me = { login: identity.login, id: identity.login.toLowerCase() };

    const lastSync = db.getSyncState('lastSync', 'github', STATE_SCOPE);
    const mentionsBackfill = db.getSyncState('mentionsVersion', 'github', STATE_SCOPE) !== `1:${me.id}`;
    const sinceIso = lastSync && !mentionsBackfill
      ? lastSync
      : new Date(Date.now() - config.lookbackDays * 86400000).toISOString();
    const sinceDate = sinceIso.slice(0, 10);

    const [assigned, created, involved] = await Promise.all([
      github.searchIssues('assignee:@me'),
      github.searchIssues('author:@me'),
      github.searchIssues(`involves:@me updated:>=${sinceDate}`),
    ]);
    for (const result of [assigned, created, involved]) {
      if (result.incomplete) {
        stats.errors.push('GitHub search hit a result limit; some items may be missing until the next sync.');
      }
    }

    const candidates = new Map();
    const assignedKeys = new Set(assigned.items.map(keyOf));
    const createdKeys = new Set(created.items.map(keyOf));
    const involvedKeys = new Set(involved.items.map(keyOf));
    for (const raw of [...assigned.items, ...created.items, ...involved.items]) {
      candidates.set(keyOf(raw), raw);
    }
    stats.candidates = candidates.size;

    const now = new Date().toISOString();
    const localIds = new Map();

    for (const raw of candidates.values()) {
      const key = keyOf(raw);
      const item = mapItem(raw, me);
      if (!item.project) {
        stats.errors.push(`Could not determine the repository for "${item.title}"; skipped.`);
        continue;
      }
      const localId = db.saveItem(item);
      localIds.set(key, localId);
      stats.upserted++;

      // Identity is keyed per repository scope so visibility rules resolve per item.
      db.setSyncState('meDisplayName', me.login, 'github', item.source_scope);
      db.setSyncState('meId', me.id, 'github', item.source_scope);

      if (assignedKeys.has(key)) {
        db.saveTouch(localId, 'assigned', item.changed_date);
        stats.touches++;
      }
      if (createdKeys.has(key)) {
        db.saveTouch(localId, 'created', item.created_date);
        stats.touches++;
      }
    }

    // Deep scan comments on recently involved items (and, on first sync, every
    // tracked item) to find my comments and @mentions of me.
    const deepScan = involved.items
      .filter((raw) => localIds.has(keyOf(raw)))
      .map((raw) => ({ raw, localId: localIds.get(keyOf(raw)) }));
    if (mentionsBackfill) {
      for (const scope of db.sourceScopes('github')) {
        const repo = scope.slice(config.ghHost.length + 1);
        for (const externalId of db.sourceItemIds('github', scope)) {
          deepScan.push({
            raw: { repository_url: `${github.apiBase()}/repos/${repo}`, number: externalId },
            localId: db.findItemId('github', scope, externalId),
          });
        }
      }
    }

    let cursor = 0;
    async function worker() {
      while (cursor < deepScan.length) {
        const { raw, localId } = deepScan[cursor++];
        if (!localId) continue;
        const repo = github.repoFromApiUrl(raw.repository_url);
        try {
          const comments = await github.getComments(repo, raw.number);
          comments.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

          const mine = comments.filter((c) => c.user && c.user.login === me.login);
          if (mine.length > 0) {
            db.saveTouch(localId, 'commented', mine.at(-1).created_at);
            stats.touches++;
          }

          const mentioned = comments.filter((c) =>
            (!c.user || c.user.login !== me.login) && github.mentionsMe(c.body, me.login));
          if (mentioned.length > 0) {
            db.saveTouch(localId, 'mentioned', mentioned.at(-1).created_at);
            stats.touches++;
          }

          const latest = comments.at(-1);
          db.setLatestCommentMention(localId, me.id, github.mentionsMe(latest?.body, me.login));
          stats.deepScanned++;
        } catch (err) {
          stats.errors.push(`${repo}#${raw.number}: ${err.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    if (stats.errors.length === 0) {
      db.setSyncState('lastSync', now, 'github', STATE_SCOPE);
      db.setSyncState('mentionsVersion', `1:${me.id}`, 'github', STATE_SCOPE);
    }
    stats.completedAt = now;
    return stats;
  } finally {
    running = false;
  }
}

function eventChange(event) {
  switch (event.event) {
    case 'assigned': return { field: 'Assigned to', from: null, to: event.assignee?.login || '' };
    case 'unassigned': return { field: 'Assigned to', from: event.assignee?.login || '', to: null };
    case 'closed': return { field: 'State', from: null, to: 'Closed' };
    case 'reopened': return { field: 'State', from: null, to: 'Open' };
    case 'labeled': return { field: 'Label', from: null, to: event.label?.name || '' };
    case 'unlabeled': return { field: 'Label', from: event.label?.name || '', to: null };
    case 'milestoned': return { field: 'Milestone', from: null, to: event.milestone?.title || '' };
    case 'demilestoned': return { field: 'Milestone', from: event.milestone?.title || '', to: null };
    case 'renamed': return { field: 'Title', from: event.rename?.from || null, to: event.rename?.to || null };
    default: return null;
  }
}

async function getHistory(item, meLogin) {
  const repo = item.source_scope.slice(config.ghHost.length + 1);
  const [comments, events] = await Promise.all([
    github.getComments(repo, item.external_id),
    github.getEvents(repo, item.external_id).catch(() => []),
  ]);

  const revisions = [];
  for (const comment of comments) {
    revisions.push({
      rev: 0,
      date: comment.created_at || null,
      by: comment.user ? comment.user.login : 'Unknown',
      comment: renderMarkdown(comment.body || '', meLogin),
      changes: [],
    });
  }
  for (const event of events) {
    const change = eventChange(event);
    if (!change) continue;
    revisions.push({
      rev: 0,
      date: event.created_at || null,
      by: event.actor ? event.actor.login : 'Unknown',
      comment: null,
      changes: [change],
    });
  }
  revisions.sort((a, b) => (String(a.date) > String(b.date) ? -1 : 1));
  revisions.forEach((revision, i) => { revision.rev = revisions.length - i; });
  return revisions;
}

function syncStatus() {
  return {
    running,
    lastSync: db.getSyncState('lastSync', 'github', STATE_SCOPE),
  };
}

module.exports = { runSync, syncStatus, getHistory, mapItem, scopeFor };
