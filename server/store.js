'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');
  
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
    for (const col of ['description', 'acceptance_criteria', 'repro_steps', 'history', 'attachments', 'priority_level']) {
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
                          provider, source_scope, external_id, is_closed, priority_level)
  VALUES (@id, @rev, @title, @type, @state, @assigned_to, @created_by, @created_date,
          @changed_by, @changed_date, @tags, @area_path, @iteration_path, @project, @url, @synced_at,
          @description, @acceptance_criteria, @repro_steps, @history, @attachments,
          @provider, @source_scope, @external_id, @is_closed, @priority_level)
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
    priority_level = excluded.priority_level
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
      'tags', 'area_path', 'iteration_path', 'description', 'acceptance_criteria', 'repro_steps', 'history', 'attachments', 'priority_level']
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
  
  const TOUCH_JOIN = 'JOIN touches t ON t.work_item_id = w.id';
  
  function buildItemQuery(filters) {
    const where = ['w.is_closed = 0'];
    const params = {};
  
    if (filters.search) {
      const term = filters.search.trim();
      if (/^\d+$/.test(term)) {
        where.push('w.external_id = @searchId');
        params.searchId = String(BigInt(term));
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
  
    return { where: where.join(' AND '), params };
  }
  
  function queryItems(filters) {
    const { where, params } = buildItemQuery(filters);
    const limit = Math.min(filters.limit || 200, 500);
    const offset = filters.offset || 0;
    const rows = db.prepare(`
      SELECT DISTINCT w.* FROM work_items w ${TOUCH_JOIN}
      WHERE ${where}
      ORDER BY w.changed_date DESC
      LIMIT ${limit} OFFSET ${offset}
    `).all(params);
    const total = db.prepare(`
      SELECT COUNT(DISTINCT w.id) AS n FROM work_items w ${TOUCH_JOIN} WHERE ${where}
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
  
  function getSummary(staleDays) {
    const one = (sql, params) => db.prepare(sql).get(params || {});
    const all = (sql, params) => db.prepare(sql).all(params || {});
  
    const open = one(`
      SELECT COUNT(DISTINCT w.id) AS n FROM work_items w ${TOUCH_JOIN}
      WHERE w.is_closed = 0
    `).n;
  
    const recentlyUpdated = one(`
      SELECT COUNT(DISTINCT w.id) AS n FROM work_items w ${TOUCH_JOIN}
      WHERE w.is_closed = 0
        AND w.changed_date >= datetime('now', '-7 days')
    `).n;
  
    const stale = one(`
      SELECT COUNT(DISTINCT w.id) AS n FROM work_items w ${TOUCH_JOIN}
      WHERE w.is_closed = 0
        AND w.changed_date < datetime('now', '-' || @staleDays || ' days')
    `, { staleDays }).n;
  
    const group = (col) => all(`
      SELECT w.${col} AS key, COUNT(DISTINCT w.id) AS n FROM work_items w ${TOUCH_JOIN}
      WHERE w.is_closed = 0
      GROUP BY w.${col} ORDER BY n DESC
    `);
  
    const lastSync = getSyncState('lastSync');
    const totalTracked = one('SELECT COUNT(*) AS n FROM work_items').n;
  
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
  
  function getFilterValues() {
    const pick = (col) =>
      db.prepare(`SELECT DISTINCT ${col} AS v FROM work_items WHERE ${col} IS NOT NULL AND ${col} != '' ORDER BY ${col}`)
        .all().map((r) => r.v);
    return {
      projects: db.prepare(`
        SELECT DISTINCT w.project AS v FROM work_items w
        WHERE w.project != ''
          AND EXISTS (SELECT 1 FROM touches t WHERE t.work_item_id = w.id)
        ORDER BY w.project
      `).all().map((row) => row.v),
      types: pick('type'),
      states: db.prepare('SELECT DISTINCT state AS v FROM work_items WHERE is_closed = 0 ORDER BY state').all().map((r) => r.v),
      providers: pick('provider'),
      labels: [...new Set(db.prepare(`
        SELECT w.tags FROM work_items w WHERE w.tags IS NOT NULL
          AND EXISTS (SELECT 1 FROM touches t WHERE t.work_item_id = w.id)
      `).all().flatMap((row) => splitLabels(row.tags)))].sort((a, b) => a.localeCompare(b)),
      priorities: db.prepare(`
        SELECT DISTINCT w.priority_level AS v FROM work_items w
        WHERE w.priority_level IS NOT NULL AND w.priority_level != ''
          AND EXISTS (SELECT 1 FROM touches t WHERE t.work_item_id = w.id)
        ORDER BY w.priority_level
      `).all().map((row) => row.v),
      iterations: db.prepare(`
        SELECT DISTINCT w.iteration_path AS v FROM work_items w
        WHERE w.iteration_path IS NOT NULL AND w.iteration_path != ''
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
  
  return {
    saveItem,
    saveTouch,
    getSyncState,
    setSyncState,
    queryItems,
    getItem,
    getSummary,
    getFilterValues,
    knownItemIds,
    sourceItemIds,
    close: () => db.close(),
  };
}
  
module.exports = { createStore };
