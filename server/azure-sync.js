'use strict';

const config = require('./config');
const ado = require('./ado');
const db = require('./db');

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

async function runSync() {
  if (running) return { skipped: true, reason: 'Sync already in progress' };
  running = true;
  const stats = { candidates: 0, upserted: 0, deepScanned: 0, touches: 0, errors: [] };

  try {
    const identity = await ado.getMyIdentity();
    const me = {
      id: identity.id ? String(identity.id).toLowerCase() : '',
      displayName: normIdentity(identity.displayName),
    };
    db.setSyncState('meDisplayName', identity.displayName || '');

    const lastSync = db.getSyncState('lastSync');
    const sinceIso = lastSync
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
    if (!db.getSyncState('priorityVersion')) {
      for (const id of db.sourceItemIds('azure-devops', config.orgUrl)) candidateIds.add(Number(id));
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
      .filter((wi) => changedSinceSet.has(wi.id))
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
          stats.deepScanned++;
        } catch (err) {
          stats.errors.push(`item ${id}: ${err.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    db.setSyncState('lastSync', now);
    db.setSyncState('priorityVersion', '1');
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
