'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, '..', 'data', 'devops-center.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

for (const col of ['description', 'acceptance_criteria', 'repro_steps', 'history', 'attachments']) {
  if (!db.prepare(`PRAGMA table_info(work_items)`).all().some((c) => c.name === col)) {
    db.exec(`ALTER TABLE work_items ADD COLUMN ${col} TEXT`);
  }
}

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

const CLOSED_STATES = "('Closed','Removed','Done','Resolved')";

const upsertItem = db.prepare(`
INSERT INTO work_items (id, rev, title, type, state, assigned_to, created_by, created_date,
                        changed_by, changed_date, tags, area_path, iteration_path, project, url, synced_at,
                        description, acceptance_criteria, repro_steps, history, attachments)
VALUES (@id, @rev, @title, @type, @state, @assigned_to, @created_by, @created_date,
        @changed_by, @changed_date, @tags, @area_path, @iteration_path, @project, @url, @synced_at,
        @description, @acceptance_criteria, @repro_steps, @history, @attachments)
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
  attachments = excluded.attachments
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

function getSyncState(key) {
  const row = getStateStmt.get(key);
  return row ? row.value : null;
}

function setSyncState(key, value) {
  setStateStmt.run(key, value);
}

function saveItem(item) {
  upsertItem.run(item);
}

function saveTouch(workItemId, touchType, touchedAt) {
  upsertTouch.run(workItemId, touchType, touchedAt || null);
}

const TOUCH_JOIN = 'JOIN touches t ON t.work_item_id = w.id';

function buildItemQuery(filters) {
  const where = [`w.state NOT IN ${CLOSED_STATES}`];
  const params = {};

  if (filters.search) {
    const term = filters.search.trim();
    if (/^\d+$/.test(term)) {
      where.push('w.id = @searchId');
      params.searchId = parseInt(term, 10);
    } else {
      where.push(`(w.title LIKE @search OR w.tags LIKE @search OR w.project LIKE @search OR w.state LIKE @search)`);
      params.search = `%${term}%`;
    }
  }
  if (filters.project) { where.push('w.project = @project'); params.project = filters.project; }
  if (filters.type) { where.push('w.type = @type'); params.type = filters.type; }
  if (filters.state) { where.push('w.state = @state'); params.state = filters.state; }
  if (filters.iteration) { where.push('w.iteration_path = @iteration'); params.iteration = filters.iteration; }
  if (filters.touch) { where.push('t.touch_type = @touch'); params.touch = filters.touch; }
  if (filters.assignedToMe) {
    const meName = getSyncState('meDisplayName');
    if (meName) { where.push('w.assigned_to = @meName'); params.meName = meName; }
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
  const closed = CLOSED_STATES;
  const one = (sql, params) => db.prepare(sql).get(params || {});
  const all = (sql, params) => db.prepare(sql).all(params || {});

  const open = one(`
    SELECT COUNT(DISTINCT w.id) AS n FROM work_items w ${TOUCH_JOIN}
    WHERE w.state NOT IN ${closed}
  `).n;

  const recentlyUpdated = one(`
    SELECT COUNT(DISTINCT w.id) AS n FROM work_items w ${TOUCH_JOIN}
    WHERE w.state NOT IN ${closed}
      AND w.changed_date >= datetime('now', '-7 days')
  `).n;

  const stale = one(`
    SELECT COUNT(DISTINCT w.id) AS n FROM work_items w ${TOUCH_JOIN}
    WHERE w.state NOT IN ${closed}
      AND w.changed_date < datetime('now', '-' || @staleDays || ' days')
  `, { staleDays }).n;

  const group = (col) => all(`
    SELECT w.${col} AS key, COUNT(DISTINCT w.id) AS n FROM work_items w ${TOUCH_JOIN}
    WHERE w.state NOT IN ${closed}
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
    projects: pick('project'),
    types: pick('type'),
    states: db.prepare(`SELECT DISTINCT state AS v FROM work_items WHERE state NOT IN ${CLOSED_STATES} ORDER BY state`).all().map((r) => r.v),
    iterations: pick('iteration_path'),
    touches: ['assigned', 'created', 'edited', 'commented'],
  };
}

function knownItemIds() {
  return new Set(db.prepare('SELECT id FROM work_items').all().map((r) => r.id));
}

module.exports = {
  saveItem,
  saveTouch,
  getSyncState,
  setSyncState,
  queryItems,
  getItem,
  getSummary,
  getFilterValues,
  knownItemIds,
};
