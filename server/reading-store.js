'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { ReadingError } = require('./reading-common');

function createStore(filename = path.join(__dirname, '..', 'data', 'reading-room.db')) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, provider TEXT NOT NULL,
      scope TEXT NOT NULL, fingerprint TEXT NOT NULL, project TEXT NOT NULL,
      repository TEXT NOT NULL, wikiId TEXT NOT NULL, wikiName TEXT NOT NULL,
      url TEXT NOT NULL, position INTEGER NOT NULL, metadata TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cache (
      connectionId INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, path TEXT NOT NULL, body BLOB NOT NULL, fetchedAt TEXT NOT NULL,
      PRIMARY KEY(connectionId, kind, path)
    );
  `);
  function decode(row) { return row && { ...row, metadata: JSON.parse(row.metadata) }; }
  const get = id => decode(db.prepare('SELECT * FROM connections WHERE id = ?').get(id));
  const list = () => db.prepare('SELECT * FROM connections ORDER BY position, id').all().map(decode);
  const normalize = () => list().forEach((row, index) => db.prepare('UPDATE connections SET position = ? WHERE id = ?').run(index, row.id));
  return {
    db, get, list,
    add(data) {
      if (list().length >= 50) throw new ReadingError('You can save up to 50 wiki connections.', 409);
      if (db.prepare('SELECT id FROM connections WHERE provider = ? AND scope = ? AND project = ? AND wikiId = ?')
        .get(data.provider, data.scope, data.project, data.wikiId)) throw new ReadingError('This wiki is already saved.', 409);
      const result = db.prepare(`INSERT INTO connections
        (name, provider, scope, fingerprint, project, repository, wikiId, wikiName, url, position, metadata)
        VALUES (@name, @provider, @scope, @fingerprint, @project, @repository, @wikiId, @wikiName, @url, @position, @metadata)`)
        .run({ ...data, wikiId: String(data.wikiId), position: list().length, metadata: JSON.stringify(data.metadata || {}) });
      return get(result.lastInsertRowid);
    },
    update(id, values) {
      return db.transaction(() => {
        if (values.name !== undefined) db.prepare('UPDATE connections SET name = ? WHERE id = ?').run(values.name, id);
        if (values.position !== undefined) {
          const ordered = list().filter(row => row.id !== id);
          ordered.splice(Math.min(values.position, ordered.length), 0, get(id));
          ordered.forEach((row, index) => db.prepare('UPDATE connections SET position = ? WHERE id = ?').run(index, row.id));
        }
        return get(id);
      })();
    },
    remove(id) {
      db.transaction(() => { db.prepare('DELETE FROM connections WHERE id = ?').run(id); normalize(); })();
    },
    cached(id, kind, key) {
      const row = db.prepare('SELECT body, fetchedAt FROM cache WHERE connectionId = ? AND kind = ? AND path = ?').get(id, kind, key);
      if (!row) return null;
      return { value: kind === 'image' ? row.body : JSON.parse(row.body.toString()), fetchedAt: row.fetchedAt };
    },
    clearCache(id) { db.prepare('DELETE FROM cache WHERE connectionId = ?').run(id); },
    cache(id, kind, key, value, fetchedAt = new Date().toISOString()) {
      const body = kind === 'image' ? value : Buffer.from(JSON.stringify(value));
      db.prepare(`INSERT INTO cache (connectionId, kind, path, body, fetchedAt) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(connectionId, kind, path) DO UPDATE SET body=excluded.body, fetchedAt=excluded.fetchedAt`)
        .run(id, kind, key, body, fetchedAt);
      // Bound the fetched-content cache independently of the number of saved connections.
      while (db.prepare('SELECT COALESCE(SUM(length(body)), 0) AS size FROM cache').get().size > 128 * 1024 * 1024) {
        db.prepare('DELETE FROM cache WHERE rowid = (SELECT rowid FROM cache ORDER BY fetchedAt LIMIT 1)').run();
      }
      return { value, fetchedAt };
    },
    close() { db.close(); },
  };
}

function publicConnection(row) {
  const { id, name, provider, scope, project, repository, wikiId, wikiName, url, position } = row;
  return { id, name, provider, scope, project, repository, wikiId, wikiName, url, position };
}

module.exports = { createStore, publicConnection };
