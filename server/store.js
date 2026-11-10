'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

const INSPECTION_FILTER = `(
  (w.provider = 'github' AND w.type = 'Pull Request')
  OR (w.provider = 'azure-devops' AND w.type = 'Pull Request' AND w.external_id LIKE 'pr:%')
)`;

function createStore(filename, legacyScope = '') {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  const splitLabels = (tags) => String(tags || '').split(';').map((tag) => tag.trim()).filter(Boolean);
  db.function('has_label', { deterministic: true }, (tags, label) =>
    Number(splitLabels(tags).some((tag) => tag.toLowerCase() === label.toLowerCase())));
  
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  
  db.exec(`
  CREATE TABLE IF NOT EXISTS work_items (
    id            INTEGER PRIMARY KEY,
    rev           INTEGER NOT NULL DEFAULT 0,
    title         TEXT NOT NULL DEFAULT '',
    type          TEXT NOT NULL DEFAULT '',
    state         TEXT NOT NULL DEFAULT '',
    assigned_to   TEXT,
    created_by    TEXT,
    created_date  TEXT,
    changed_by    TEXT,
    changed_date  TEXT,
    tags          TEXT,
    area_path     TEXT,
    iteration_path TEXT,
    project       TEXT NOT NULL DEFAULT '',
    url           TEXT NOT NULL DEFAULT '',
    synced_at     TEXT NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS touches (
    work_item_id INTEGER NOT NULL,
    touch_type   TEXT NOT NULL CHECK (touch_type IN ('assigned','created','edited','commented')),
    touched_at   TEXT,
    PRIMARY KEY (work_item_id, touch_type)
  );
  
  CREATE TABLE IF NOT EXISTS sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS hidden_items (
    work_item_id INTEGER PRIMARY KEY,
    hidden_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS item_notes (
    work_item_id INTEGER PRIMARY KEY,
    note TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS note_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_item_id INTEGER NOT NULL,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS latest_comment_mentions (
    work_item_id INTEGER PRIMARY KEY,
    identity_id TEXT NOT NULL,
    mentions_me INTEGER NOT NULL
  );
  
  CREATE INDEX IF NOT EXISTS idx_items_state     ON work_items(state);
  CREATE INDEX IF NOT EXISTS idx_items_type      ON work_items(type);
  CREATE INDEX IF NOT EXISTS idx_items_project   ON work_items(project);
  CREATE INDEX IF NOT EXISTS idx_items_changed   ON work_items(changed_date);
  CREATE INDEX IF NOT EXISTS idx_items_iteration ON work_items(iteration_path);
  CREATE INDEX IF NOT EXISTS idx_touches_item    ON touches(work_item_id);
  `);
  
  db.transaction(() => {
    const touchSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'touches'").get().sql;
    if (!touchSchema.includes("'mentioned'")) {
      db.exec(`
        ALTER TABLE touches RENAME TO touches_before_mentions;
        CREATE TABLE touches (
          work_item_id INTEGER NOT NULL,
          touch_type TEXT NOT NULL CHECK (touch_type IN ('assigned','created','edited','commented','mentioned')),
          touched_at TEXT,
          PRIMARY KEY (work_item_id, touch_type)
        );
        INSERT INTO touches SELECT work_item_id, touch_type, touched_at FROM touches_before_mentions;
        DROP TABLE touches_before_mentions;
        CREATE INDEX idx_touches_item ON touches(work_item_id);
      `);
    }
    const columns = new Set(db.prepare('PRAGMA table_info(work_items)').all().map((c) => c.name));
    for (const col of ['description', 'acceptance_criteria', 'repro_steps', 'history', 'attachments', 'priority_level', 'due_date']) {
      if (!columns.has(col)) db.exec(`ALTER TABLE work_items ADD COLUMN ${col} TEXT`);
    }
    if (!columns.has('provider')) {
      db.exec(`
        ALTER TABLE work_items ADD COLUMN provider TEXT NOT NULL DEFAULT 'azure-devops';
        ALTER TABLE work_items ADD COLUMN source_scope TEXT NOT NULL DEFAULT '';
        ALTER TABLE work_items ADD COLUMN external_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE work_items ADD COLUMN is_closed INTEGER NOT NULL DEFAULT 0;
      `);
      db.prepare('UPDATE work_items SET source_scope = ?, external_id = CAST(id AS TEXT)').run(legacyScope);
      db.exec("UPDATE work_items SET is_closed = state IN ('Closed','Removed','Done','Resolved')");
      const stateRows = db.prepare('SELECT key, value FROM sync_state').all();
      const insert = db.prepare('INSERT OR IGNORE INTO sync_state (key, value) VALUES (?, ?)');
      for (const row of stateRows) {
        insert.run(JSON.stringify(['azure-devops', legacyScope, row.key]), row.value);
      }
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_items_source ON work_items(provider, source_scope, external_id)');
  })();
  
  const upsertItem = db.prepare(`
  INSERT INTO work_items (id, rev, title, type, state, assigned_to, created_by, created_date,
                          changed_by, changed_date, tags, area_path, iteration_path, project, url, synced_at,
                          description, acceptance_criteria, repro_steps, history, attachments,
                          provider, source_scope, external_id, is_closed, priority_level, due_date)
  VALUES (@id, @rev, @title, @type, @state, @assigned_to, @created_by, @created_date,
          @changed_by, @changed_date, @tags, @area_path, @iteration_path, @project, @url, @synced_at,
          @description, @acceptance_criteria, @repro_steps, @history, @attachments,
          @provider, @source_scope, @external_id, @is_closed, @priority_level, @due_date)
  ON CONFLICT(id) DO UPDATE SET
    rev = excluded.rev,
    title = excluded.title,
    type = excluded.type,
    state = excluded.state,
    assigned_to = excluded.assigned_to,
    created_by = excluded.created_by,
    created_date = excluded.created_date,
    changed_by = excluded.changed_by,
    changed_date = excluded.changed_date,
    tags = excluded.tags,
    area_path = excluded.area_path,
    iteration_path = excluded.iteration_path,
    project = excluded.project,
    url = excluded.url,
    synced_at = excluded.synced_at,
    description = excluded.description,
    acceptance_criteria = excluded.acceptance_criteria,
    repro_steps = excluded.repro_steps,
    history = excluded.history,
    attachments = excluded.attachments,
    is_closed = excluded.is_closed,
    priority_level = excluded.priority_level,
    due_date = excluded.due_date
  `);
  
  const upsertTouch = db.prepare(`
  INSERT INTO touches (work_item_id, touch_type, touched_at)
  VALUES (?, ?, ?)
  ON CONFLICT(work_item_id, touch_type) DO UPDATE SET
    touched_at = MAX(COALESCE(touches.touched_at, ''), COALESCE(excluded.touched_at, ''))
  `);
  
  const getStateStmt = db.prepare('SELECT value FROM sync_state WHERE key = ?');
  const setStateStmt = db.prepare(`
  INSERT INTO sync_state (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  
  function stateKey(key, provider, scope) {
    return JSON.stringify([provider, scope, key]);
  }
  
  function getSyncState(key, provider = 'azure-devops', scope = config.orgUrl) {
    const row = getStateStmt.get(stateKey(key, provider, scope));
    return row ? row.value : null;
  }
  
  function setSyncState(key, value, provider = 'azure-devops', scope = config.orgUrl) {
    setStateStmt.run(stateKey(key, provider, scope), value);
  }
  
  function saveItem(item) {
    const provider = item.provider || 'azure-devops';
    const scope = item.source_scope ?? config.orgUrl;
    const externalId = String(item.external_id ?? item.id);
    if (!scope || !externalId || externalId === 'undefined') throw new Error('An item requires a source scope and external ID.');
    if (provider !== 'azure-devops' && typeof item.is_closed !== 'boolean') {
      throw new Error('Providers must supply a normalized is_closed boolean.');
    }
    const existing = db.prepare('SELECT id FROM work_items WHERE provider = ? AND source_scope = ? AND external_id = ?')
      .get(provider, scope, externalId);
    // Local IDs remain stable; source IDs are only unique within their provider and scope.
    const id = existing ? existing.id : null;
    const defaults = Object.fromEntries(['assigned_to', 'created_by', 'created_date', 'changed_by', 'changed_date',
      'tags', 'area_path', 'iteration_path', 'description', 'acceptance_criteria', 'repro_steps', 'history', 'attachments', 'priority_level', 'due_date']
      .map((key) => [key, null]));
    const result = upsertItem.run({
      ...defaults, rev: 0, title: '', type: '', state: '', project: '', url: '', synced_at: new Date().toISOString(),
      ...item, id, provider, source_scope: scope, external_id: externalId,
      is_closed: Number(item.is_closed ?? ['Closed', 'Removed', 'Done', 'Resolved'].includes(item.state)),
    });
    return id ?? Number(result.lastInsertRowid);
  }
  
  function saveTouch(workItemId, touchType, touchedAt) {
    upsertTouch.run(workItemId, touchType, touchedAt || null);
  }

  function clearTouches(workItemId) {
    db.prepare('DELETE FROM touches WHERE work_item_id = ?').run(workItemId);
  }
  
  const TOUCH_JOIN = 'JOIN touches t ON t.work_item_id = w.id';
  const REQUIRED_ITEM = `(EXISTS (
    SELECT 1 FROM sync_state s
    WHERE s.key = json_array(w.provider, w.source_scope, 'meDisplayName')
      AND s.value != '' AND s.value = w.assigned_to
  ) OR EXISTS (
    SELECT 1 FROM latest_comment_mentions m JOIN sync_state s
      ON s.key = json_array(w.provider, w.source_scope, 'meId')
    WHERE m.work_item_id = w.id AND m.mentions_me = 1 AND lower(s.value) = m.identity_id
  ))`;
  const HIDDEN_ITEM = 'EXISTS (SELECT 1 FROM hidden_items h WHERE h.work_item_id = w.id)';
  const VISIBLE_ITEM = `(NOT ${HIDDEN_ITEM} OR ${REQUIRED_ITEM})`;

  function setLatestCommentMention(id, identityId, mentionsMe) {
    db.prepare(`INSERT INTO latest_comment_mentions VALUES (?, ?, ?)
      ON CONFLICT(work_item_id) DO UPDATE SET identity_id = excluded.identity_id,
      mentions_me = excluded.mentions_me`).run(id, identityId.toLowerCase(), Number(mentionsMe));
  }

  function getItemNote(id) {
    const row = db.prepare('SELECT note, updated_at FROM item_notes WHERE work_item_id = ?').get(id);
    return { note: row ? row.note : '', updated_at: row ? row.updated_at : null };
  }

  function setItemNote(id, note) {
    if (!db.prepare('SELECT 1 FROM work_items WHERE id = ?').get(id)) return { error: 'Work item not found.', status: 404 };
    if (!note.trim()) {
      db.prepare('DELETE FROM item_notes WHERE work_item_id = ?').run(id);
      return { note: '', updated_at: null };
    }
    const updated_at = new Date().toISOString();
    db.prepare(`INSERT INTO item_notes (work_item_id, note, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(work_item_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`).run(id, note, updated_at);
    return { note, updated_at };
  }

  function addNoteImage(workItemId, mime, data) {
    if (!db.prepare('SELECT 1 FROM work_items WHERE id = ?').get(workItemId)) return { error: 'Work item not found.', status: 404 };
    const info = db.prepare('INSERT INTO note_images (work_item_id, mime, data, created_at) VALUES (?, ?, ?, ?)')
      .run(workItemId, mime, data, new Date().toISOString());
    return { id: Number(info.lastInsertRowid) };
  }

  function getNoteImage(id) {
    return db.prepare('SELECT mime, data FROM note_images WHERE id = ?').get(id) || null;
  }

  function setItemHidden(id, hidden) {
    const item = db.prepare(`SELECT w.id, ${REQUIRED_ITEM} AS required FROM work_items w WHERE w.id = ?`).get(id);
    if (!item) return { error: 'Work item not found.', status: 404 };
    if (hidden && item.required) {
      return { error: 'This item cannot be hidden while assigned to you or when its latest comment @mentions you.', status: 409 };
    }
    if (hidden) db.prepare('INSERT OR REPLACE INTO hidden_items VALUES (?, ?)').run(id, new Date().toISOString());
    else db.prepare('DELETE FROM hidden_items WHERE work_item_id = ?').run(id);
    return { hidden };
  }
  
  function buildItemQuery(filters) {
    if (filters.discovery) {
      filters = { ...filters, closedOnly: false, hiddenOnly: false, focus: '', assignedToMe: false, touch: '' };
    }
    const where = [filters.closedOnly ? 'w.is_closed = 1' : 'w.is_closed = 0'];
    if (!filters.closedOnly) where.push(filters.hiddenOnly ? `${HIDDEN_ITEM} AND NOT ${REQUIRED_ITEM}` : VISIBLE_ITEM);
    const params = {};
    if (filters.discovery) {
      where.push('NOT EXISTS (SELECT 1 FROM touches t WHERE t.work_item_id = w.id)');
      where.push("julianday(w.changed_date) >= julianday('now', '-' || @discoveryDays || ' days')");
      params.discoveryDays = config.discoveryDays;
    }
    if (filters.inspection) where.push(INSPECTION_FILTER);
    else if (!filters.discovery) where.push(`NOT (${INSPECTION_FILTER})`);

    if (filters.focus === 'attention') filters.assignedToMe = true;
  
    if (filters.search) {
      const term = filters.search.trim();
      if (/^\d+$/.test(term)) {
        where.push("(w.external_id = @searchId OR (w.provider = 'azure-devops' AND w.type = 'Pull Request' AND w.external_id LIKE @searchPullRequestId))");
        params.searchId = String(BigInt(term));
        params.searchPullRequestId = `pr:%:${params.searchId}`;
      } else {
        where.push(`(w.title LIKE @search OR w.tags LIKE @search OR w.project LIKE @search OR w.state LIKE @search)`);
        params.search = `%${term}%`;
      }
    }
    if (filters.project) { where.push('w.project = @project'); params.project = filters.project; }
    if (filters.provider) { where.push('w.provider = @provider'); params.provider = filters.provider; }
    if (filters.priority) { where.push('w.priority_level = @priority'); params.priority = filters.priority; }
    if (filters.label) { where.push('has_label(w.tags, @label) = 1'); params.label = filters.label; }
    if (filters.type) { where.push('w.type = @type'); params.type = filters.type; }
    if (filters.state) { where.push('w.state = @state'); params.state = filters.state; }
    if (filters.iteration) { where.push('w.iteration_path = @iteration'); params.iteration = filters.iteration; }
    if (filters.touch) { where.push('t.touch_type = @touch'); params.touch = filters.touch; }
    if (filters.assignedToMe) {
      const identities = db.prepare('SELECT key, value FROM sync_state').all()
        .filter((row) => row.key.startsWith('['))
        .map((row) => ({ parts: JSON.parse(row.key), name: row.value }))
        .filter((row) => row.parts[2] === 'meDisplayName' && row.name);
      const clauses = identities.map((identity, i) => {
        params[`provider${i}`] = identity.parts[0];
        params[`scope${i}`] = identity.parts[1];
        params[`me${i}`] = identity.name;
        return `(w.provider = @provider${i} AND w.source_scope = @scope${i} AND w.assigned_to = @me${i})`;
      });
      where.push(clauses.length ? `(${clauses.join(' OR ')})` : '0');
    }
    if (filters.from) { where.push('w.changed_date >= @from'); params.from = filters.from; }
    if (filters.to) { where.push('w.changed_date <= @to'); params.to = filters.to + 'T23:59:59'; }
    if (filters.focus === 'attention') {
      where.push(`julianday(w.changed_date) < julianday('now', '-' || @focusStaleDays || ' days')`);
      params.focusStaleDays = config.staleDays;
    } else if (filters.focus === 'digest') {
      where.push(`(date(w.changed_date) = date('now', 'localtime')
        OR (w.due_date IS NOT NULL AND w.due_date != '' AND date(w.due_date) <= date('now', 'localtime')))`);
    }
  
    return { where: where.join(' AND '), params };
  }
  
  function queryItems(filters) {
    const { where, params } = buildItemQuery(filters);
    const join = filters.discovery ? '' : TOUCH_JOIN;
    const limit = Math.min(filters.limit || 200, 500);
    const offset = filters.offset || 0;
    const rows = db.prepare(`
      SELECT DISTINCT w.*, ${HIDDEN_ITEM} AS is_hidden, ${REQUIRED_ITEM} AS visibility_required FROM work_items w ${join}
      WHERE ${where}
      ORDER BY COALESCE(w.changed_date, w.created_date) DESC, w.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `).all(params);
    const total = db.prepare(`
      SELECT COUNT(DISTINCT w.id) AS n FROM work_items w ${join} WHERE ${where}
    `).get(params).n;
    return { items: rows, total };
  }
  
  function getItem(id) {
    const item = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
    if (!item) return null;
    const touches = db.prepare(
      'SELECT touch_type, touched_at FROM touches WHERE work_item_id = ? ORDER BY touch_type'
    ).all(id);
    return { ...item, touches };
  }
  
  function getSummary(staleDays, inspection = false) {
    const one = (sql, params) => db.prepare(sql).get(params || {});
    const all = (sql, params) => db.prepare(sql).all(params || {});
    const roomFilter = inspection ? `AND ${INSPECTION_FILTER}` : `AND NOT (${INSPECTION_FILTER})`;
  
    const open = one(`
      SELECT COUNT(DISTINCT w.id) AS n FROM work_items w ${TOUCH_JOIN}
      WHERE w.is_closed = 0 AND ${VISIBLE_ITEM} ${roomFilter}
    `).n;
  
    const recentlyUpdated = one(`
      SELECT COUNT(DISTINCT w.id) AS n FROM work_items w ${TOUCH_JOIN}
      WHERE w.is_closed = 0 AND ${VISIBLE_ITEM}
        AND w.changed_date >= datetime('now', '-7 days')
        ${roomFilter}
    `).n;
  
    const assigned = buildItemQuery({ assignedToMe: true, inspection });
    const stale = one(`
      SELECT COUNT(DISTINCT w.id) AS n FROM work_items w ${TOUCH_JOIN}
      WHERE ${assigned.where}
        AND julianday(w.changed_date) < julianday('now', '-' || @staleDays || ' days')
    `, { ...assigned.params, staleDays }).n;
  
    const group = (col) => all(`
      SELECT w.${col} AS key, COUNT(DISTINCT w.id) AS n FROM work_items w ${TOUCH_JOIN}
      WHERE w.is_closed = 0 AND ${VISIBLE_ITEM} ${roomFilter}
      GROUP BY w.${col} ORDER BY n DESC
    `);
  
    const lastSync = latestSyncWatermark();
    const totalTracked = inspection
      ? one(`SELECT COUNT(DISTINCT w.id) AS n FROM work_items w ${TOUCH_JOIN} WHERE ${INSPECTION_FILTER}`).n
      : one(`SELECT COUNT(*) AS n FROM work_items w WHERE NOT (${INSPECTION_FILTER})`).n;
  
    return {
      open,
      recentlyUpdated,
      stale,
      staleDays,
      byState: group('state'),
      byType: group('type'),
      byProject: group('project'),
      byIteration: group('iteration_path'),
      lastSync,
      totalTracked,
    };
  }
  
  function getFilterValues(room = '') {
    const discovery = room === true || room === 'discovery';
    const inspection = room === 'inspection';
    if (inspection) {
      const pick = (column) => db.prepare(`
        SELECT DISTINCT w.${column} AS v FROM work_items w
        WHERE ${INSPECTION_FILTER} AND EXISTS (SELECT 1 FROM touches t WHERE t.work_item_id = w.id)
          AND w.${column} IS NOT NULL AND w.${column} != ''
        ORDER BY w.${column}
      `).all().map((row) => row.v);
      return {
        projects: pick('project'),
        types: pick('type'),
        states: pick('state'),
        providers: pick('provider'),
        priorities: pick('priority_level'),
        labels: [...new Set(pick('tags').flatMap(splitLabels))].sort((a, b) => a.localeCompare(b)),
        iterations: [],
        touches: [],
      };
    }
    if (discovery) {
      const { where, params } = buildItemQuery({ discovery: true });
      const pick = (column) => db.prepare(`
        SELECT DISTINCT w.${column} AS v FROM work_items w
        WHERE ${where} AND w.${column} IS NOT NULL AND w.${column} != ''
        ORDER BY w.${column}
      `).all(params).map((row) => row.v);
      return {
        projects: pick('project'),
        types: pick('type'),
        states: pick('state'),
        providers: pick('provider'),
        priorities: pick('priority_level'),
        labels: [...new Set(pick('tags').flatMap(splitLabels))].sort((a, b) => a.localeCompare(b)),
        iterations: [],
        touches: [],
      };
    }
    const pick = (col) =>
      db.prepare(`SELECT DISTINCT w.${col} AS v FROM work_items w
        WHERE NOT (${INSPECTION_FILTER}) AND w.${col} IS NOT NULL AND w.${col} != '' ORDER BY w.${col}`)
        .all().map((r) => r.v);
    return {
      projects: db.prepare(`
        SELECT DISTINCT w.project AS v FROM work_items w
        WHERE w.project != ''
          AND NOT (${INSPECTION_FILTER})
          AND EXISTS (SELECT 1 FROM touches t WHERE t.work_item_id = w.id)
        ORDER BY w.project
      `).all().map((row) => row.v),
      types: pick('type'),
      states: pick('state'),
      providers: pick('provider'),
      labels: [...new Set(db.prepare(`
        SELECT w.tags FROM work_items w WHERE w.tags IS NOT NULL AND NOT (${INSPECTION_FILTER})
          AND EXISTS (SELECT 1 FROM touches t WHERE t.work_item_id = w.id)
      `).all().flatMap((row) => splitLabels(row.tags)))].sort((a, b) => a.localeCompare(b)),
      priorities: db.prepare(`
        SELECT DISTINCT w.priority_level AS v FROM work_items w
        WHERE w.priority_level IS NOT NULL AND w.priority_level != ''
          AND NOT (${INSPECTION_FILTER})
          AND EXISTS (SELECT 1 FROM touches t WHERE t.work_item_id = w.id)
        ORDER BY w.priority_level
      `).all().map((row) => row.v),
      iterations: db.prepare(`
        SELECT DISTINCT w.iteration_path AS v FROM work_items w
        WHERE w.iteration_path IS NOT NULL AND w.iteration_path != ''
          AND NOT (${INSPECTION_FILTER})
          AND EXISTS (SELECT 1 FROM touches t WHERE t.work_item_id = w.id)
        ORDER BY w.iteration_path
      `).all().map((row) => row.v),
      touches: ['assigned', 'created', 'edited', 'commented', 'mentioned'],
    };
  }
  
  function knownItemIds() {
    return new Set(db.prepare('SELECT id FROM work_items').all().map((r) => r.id));
  }

  function sourceItemIds(provider, scope) {
    return db.prepare(`
      SELECT external_id FROM work_items w WHERE provider = ? AND source_scope = ?
        AND EXISTS (SELECT 1 FROM touches t WHERE t.work_item_id = w.id)
    `).all(provider, scope).map((row) => row.external_id);
  }

  function sourceScopes(provider) {
    return db.prepare('SELECT DISTINCT source_scope AS scope FROM work_items WHERE provider = ? ORDER BY source_scope')
      .all(provider).map((row) => row.scope);
  }

  function findItemId(provider, scope, externalId) {
    const row = db.prepare('SELECT id FROM work_items WHERE provider = ? AND source_scope = ? AND external_id = ?')
      .get(provider, scope, String(externalId));
    return row ? row.id : null;
  }

  function identities() {
    return db.prepare('SELECT key, value FROM sync_state').all()
      .filter((row) => row.key.startsWith('['))
      .map((row) => ({ parts: JSON.parse(row.key), value: row.value }))
      .filter((row) => row.parts[2] === 'meDisplayName' && row.value)
      .map((row) => ({ provider: row.parts[0], source_scope: row.parts[1], displayName: row.value }));
  }

  function latestSyncWatermark() {
    const rows = db.prepare("SELECT value FROM sync_state WHERE key LIKE '%\"lastSync\"]'").all();
    return rows.map((row) => row.value).filter(Boolean).sort().pop() || null;
  }

  return {
    saveItem,
    saveTouch,
    clearTouches,
    getSyncState,
    setSyncState,
    queryItems,
    getItem,
    getSummary,
    getFilterValues,
    knownItemIds,
    sourceItemIds,
    sourceScopes,
    findItemId,
    identities,
    latestSyncWatermark,
    setItemHidden,
    getItemNote,
    setItemNote,
    addNoteImage,
    getNoteImage,
    setLatestCommentMention,
    close: () => db.close(),
  };
}
  
module.exports = { createStore };
