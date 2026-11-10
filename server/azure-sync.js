'use strict';

const config = require('./config');
const ado = require('./ado');
const db = require('./db');
const { latestMention, latestCommentMentionsMe } = require('./mentions');

let running = false;

function normIdentity(identity) {
  if (!identity) return '';
  if (typeof identity === 'string') return identity.toLowerCase();
  return (identity.uniqueName || identity.displayName || '').toLowerCase();
}

function isMe(identity, me) {
  if (!identity) return false;
  if (me.id && identity.id && String(identity.id).toLowerCase() === me.id) return true;
  return normIdentity(identity) !== '' && normIdentity(identity) === me.displayName;
}

function mapItem(wi) {
  const f = wi.fields || {};
  const attachments = (wi.relations || [])
    .filter((r) => r.rel === 'AttachedFile')
    .map((r) => ({ name: (r.attributes && r.attributes.name) || 'attachment', url: r.url }));
  return {
    id: wi.id,
    rev: wi.rev || 0,
    title: f['System.Title'] || '',
    priority_level: wi.priority_level ?? null,
    due_date: wi.due_date ?? null,
    type: f['System.WorkItemType'] || '',
    state: f['System.State'] || '',
    assigned_to: f['System.AssignedTo'] ? f['System.AssignedTo'].displayName : null,
    created_by: f['System.CreatedBy'] ? f['System.CreatedBy'].displayName : null,
    created_date: f['System.CreatedDate'] || null,
    changed_by: f['System.ChangedBy'] ? f['System.ChangedBy'].displayName : null,
    changed_date: f['System.ChangedDate'] || null,
    tags: f['System.Tags'] || null,
    area_path: f['System.AreaPath'] || null,
    iteration_path: f['System.IterationPath'] || null,
    project: f['System.TeamProject'] || '',
    description: f['System.Description'] || null,
    acceptance_criteria: f['Microsoft.VSTS.Common.AcceptanceCriteria'] || null,
    repro_steps: f['Microsoft.VSTS.TCM.ReproSteps'] || null,
    history: f['System.History'] || null,
    attachments: attachments.length > 0 ? JSON.stringify(attachments) : null,
    url: wi.url ? wi.url.replace(/_apis\/wit\/workItems\/(\d+).*/, '') : '',
    synced_at: new Date().toISOString(),
  };
}

function itemWebUrl(item) {
  return `${config.orgUrl}/${encodeURIComponent(item.project)}/_workitems/edit/${item.id}`;
}

async function syncPullRequests(identity, me, stats) {
  const repositories = (await ado.getGitRepositories()).filter((repository) =>
    repository.id && repository.name && repository.project?.name && !repository.isDisabled);
  const pullRequests = new Map();
  let cursor = 0;

  async function worker() {
    while (cursor < repositories.length) {
      const repository = repositories[cursor++];
      const [createdByMe, reviewerForMe] = await Promise.all([
        ado.getPullRequests(repository.id, me.id, 'creatorId'),
        ado.getPullRequests(repository.id, me.id, 'reviewerId'),
      ]);
      for (const items of [createdByMe, reviewerForMe]) {
        for (const pullRequest of items) {
          if (!['active', 'completed', 'abandoned'].includes(pullRequest.status) ||
              !Number.isSafeInteger(pullRequest.pullRequestId)) continue;
          const createdByMeNow = String(pullRequest.createdBy?.id || '').toLowerCase() === me.id;
          const reviewer = (pullRequest.reviewers || []).find((entry) =>
            String(entry.id || '').toLowerCase() === me.id);
          if (!createdByMeNow && !reviewer) continue;

          const externalId = `pr:${repository.id.toLowerCase()}:${pullRequest.pullRequestId}`;
          const existing = pullRequests.get(externalId);
          pullRequests.set(externalId, {
            externalId,
            repository,
            pullRequest,
            createdByMe: Boolean(existing?.createdByMe || createdByMeNow),
            reviewer: existing?.reviewer || reviewer || null,
          });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(6, repositories.length) }, worker));
  const candidates = [...pullRequests.values()];
  cursor = 0;
  async function detailsWorker() {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++];
      const details = await ado.getPullRequest(
        candidate.repository.id, candidate.pullRequest.pullRequestId
      );
      Object.assign(candidate.pullRequest, details);
      candidate.createdByMe = String(candidate.pullRequest.createdBy?.id || '').toLowerCase() === me.id;
      candidate.reviewer = (candidate.pullRequest.reviewers || []).find((entry) =>
        String(entry.id || '').toLowerCase() === me.id) || null;
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, candidates.length) }, detailsWorker));

  const eligibleIds = new Set();
  for (const { externalId, repository, pullRequest, createdByMe, reviewer } of pullRequests.values()) {
    if (!['active', 'completed', 'abandoned'].includes(pullRequest.status) || (!createdByMe && !reviewer)) continue;
    eligibleIds.add(externalId);
    const item = {
      provider: 'azure-devops',
      source_scope: config.orgUrl,
      external_id: externalId,
      rev: 0,
      title: pullRequest.title || '',
      type: 'Pull Request',
      state: { active: 'Active', completed: 'Completed', abandoned: 'Abandoned' }[pullRequest.status],
      assigned_to: reviewer ? (identity.displayName || null) : null,
      created_by: pullRequest.createdBy?.displayName || null,
      created_date: pullRequest.creationDate || null,
      changed_by: null,
      changed_date: pullRequest.lastUpdatedDate || pullRequest.closedDate || null,
      project: repository.project.name,
      description: pullRequest.description || null,
      url: `${config.orgUrl}/${encodeURIComponent(repository.project.name)}/_git/${encodeURIComponent(repository.name)}/pullrequest/${pullRequest.pullRequestId}`,
      is_closed: pullRequest.status !== 'active',
      synced_at: new Date().toISOString(),
    };
    const localId = db.saveItem(item);
    stats.upserted++;
    if (createdByMe) {
      db.saveTouch(localId, 'created', item.created_date);
      stats.touches++;
    }
    if (reviewer) {
      db.saveTouch(localId, 'assigned', item.changed_date);
      stats.touches++;
    }
  }
  for (const externalId of db.sourceItemIds('azure-devops', config.orgUrl)
    .filter((id) => id.startsWith('pr:') && !eligibleIds.has(id))) {
    const localId = db.findItemId('azure-devops', config.orgUrl, externalId);
    if (localId) db.clearTouches(localId);
  }
  stats.pullRequests = eligibleIds.size;
  stats.candidates += eligibleIds.size;
}

async function runSync() {
  if (running) return { skipped: true, reason: 'Sync already in progress' };
  running = true;
  const stats = { candidates: 0, upserted: 0, deepScanned: 0, touches: 0, pullRequests: 0, errors: [] };

  try {
    const identity = await ado.getMyIdentity();
    const me = {
      id: identity.id ? String(identity.id).toLowerCase() : '',
      displayName: normIdentity(identity.displayName),
    };
    if (!me.id) throw new Error('Azure DevOps did not return your identity ID. Check the connection in Settings before syncing mentions.');
    db.setSyncState('meDisplayName', identity.displayName || '');
    db.setSyncState('meId', me.id);

    const lastSync = db.getSyncState('lastSync');
    const mentionsBackfill = db.getSyncState('mentionsVersion') !== `1:${me.id}`;
    const latestCommentsBackfill = db.getSyncState('latestCommentsVersion') !== `1:${me.id}`;
    const sinceIso = lastSync && !mentionsBackfill
      ? lastSync
      : new Date(Date.now() - config.lookbackDays * 86400000).toISOString();
    // WIQL date-precision queries reject time components; date-only may rescan
    // the watermark day, which is idempotent.
    const sinceDate = sinceIso.slice(0, 10);

    const [everAssigned, created, changedByMe, changedSince] = await Promise.all([
      ado.queryEverAssigned(),
      ado.queryCreatedByMe(),
      ado.queryChangedByMe(),
      ado.queryChangedSince(sinceDate),
    ]);

    const candidateIds = new Set([...everAssigned, ...created, ...changedByMe, ...changedSince]);
    if (!db.getSyncState('priorityVersion') || !db.getSyncState('dueDateVersion') || latestCommentsBackfill) {
      for (const id of db.sourceItemIds('azure-devops', config.orgUrl)) {
        if (/^\d+$/.test(id)) candidateIds.add(Number(id));
      }
    }
    stats.candidates = candidateIds.size;

    const items = await ado.getWorkItems([...candidateIds]);
    const now = new Date().toISOString();

    const everAssignedSet = new Set(everAssigned);
    const createdSet = new Set(created);
    const changedByMeSet = new Set(changedByMe);
    const changedSinceSet = new Set(changedSince);
    const localIds = new Map();

    for (const wi of items) {
      const item = mapItem(wi);
      item.url = itemWebUrl(item);
      const localId = db.saveItem(item);
      localIds.set(wi.id, localId);
      stats.upserted++;

      if (everAssignedSet.has(wi.id)) {
        db.saveTouch(localId, 'assigned', item.changed_date);
        stats.touches++;
      }
      if (createdSet.has(wi.id)) {
        db.saveTouch(localId, 'created', item.created_date);
        stats.touches++;
      }
      if (changedByMeSet.has(wi.id)) {
        db.saveTouch(localId, 'edited', item.changed_date);
        stats.touches++;
      }
    }

    // Deep scan: items changed since watermark — check revision/comment authors.
    // On first sync, bound the deep scan to candidates we already discovered
    // plus items changed within the lookback window, to keep the run bounded.
    const deepScanIds = items
      .filter((wi) => changedSinceSet.has(wi.id) || latestCommentsBackfill)
      .map((wi) => ({ externalId: wi.id, localId: localIds.get(wi.id) }));

    const CONCURRENCY = 10;
    let cursor = 0;
    async function worker() {
      while (cursor < deepScanIds.length) {
        const { externalId: id, localId } = deepScanIds[cursor++];
        try {
          // Comments are not a separate endpoint on this API surface; a comment
          // shows up as a revision that changes System.History.
          const updates = await ado.getUpdates(id);
          db.setLatestCommentMention(localId, me.id, latestCommentMentionsMe(updates, me.id));
          const mine = updates.filter(
            (u) => u.revisedBy && isMe(u.revisedBy, me) && u.fields && Object.keys(u.fields).length > 0
          );

          if (mine.length > 0) {
            const lastMine = mine.map((u) => u.revisedDate).sort().pop();
            db.saveTouch(localId, 'edited', lastMine);
            stats.touches++;
          }

          const myComments = mine.filter((u) => u.fields && u.fields['System.History']);
          if (myComments.length > 0) {
            const lastComment = myComments.map((u) => u.revisedDate).sort().pop();
            db.saveTouch(localId, 'commented', lastComment);
            stats.touches++;
          }
          const mentionedAt = latestMention(updates, me.id);
          if (mentionedAt) {
            db.saveTouch(localId, 'mentioned', mentionedAt);
            stats.touches++;
          }
          stats.deepScanned++;
        } catch (err) {
          stats.errors.push(`item ${id}: ${err.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    await syncPullRequests(identity, me, stats);

    if (stats.errors.length === 0) {
      db.setSyncState('lastSync', now);
      db.setSyncState('priorityVersion', '1');
      db.setSyncState('dueDateVersion', '1');
      db.setSyncState('mentionsVersion', `1:${me.id}`);
      db.setSyncState('latestCommentsVersion', `1:${me.id}`);
    }
    stats.completedAt = now;
    return stats;
  } finally {
    running = false;
  }
}

function syncStatus() {
  return {
    running,
    lastSync: db.getSyncState('lastSync'),
  };
}

module.exports = { runSync, syncStatus };
