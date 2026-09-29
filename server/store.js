// Persistenz des Spielzustands. Der Zustand ist klein (max. 8 Standorte) und liegt im
// Speicher; jede Änderung wird als ein JSON-Dokument weggeschrieben:
//  - PostgreSQL, wenn ein Service gebunden ist (BTP: postgresql-db) oder DATABASE_URL gesetzt ist
//  - sonst eine lokale Datei (data/state.json). Auf Cloud Foundry ist das Dateisystem
//    flüchtig – ohne Datenbank gehen Standorte bei Restart/Restage verloren.
const fs = require('fs');
const path = require('path');
const game = require('./game');

function postgresConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  let vcap;
  try { vcap = JSON.parse(process.env.VCAP_SERVICES || '{}'); } catch { return null; }
  for (const list of Object.values(vcap)) {
    for (const svc of list) {
      const tags = (svc.tags || []).map(t => String(t).toLowerCase());
      const label = String(svc.label || '').toLowerCase();
      if (!label.includes('postgres') && !tags.some(t => t.includes('postgres'))) continue;
      const c = svc.credentials || {};
      const ssl = c.sslrootcert ? { ca: c.sslrootcert, rejectUnauthorized: false } : { rejectUnauthorized: false };
      if (c.uri && !c.hostname) return { connectionString: c.uri, ssl };
      return { host: c.hostname, port: +c.port || 5432, user: c.username, password: c.password, database: c.dbname, ssl };
    }
  }
  return null;
}

function fileBackend() {
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const file = path.join(dir, 'state.json');
  return {
    name: 'Datei ' + file,
    async load() {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    },
    async save(json) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, file);
    }
  };
}

function postgresBackend(cfg) {
  const { Pool } = require('pg');
  const pool = new Pool({ ...cfg, max: 2 });
  return {
    name: 'PostgreSQL',
    async load() {
      await pool.query('CREATE TABLE IF NOT EXISTS escape_state (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      const r = await pool.query("SELECT data FROM escape_state WHERE id = 'main'");
      return r.rows[0] ? r.rows[0].data : null;
    },
    async save(json) {
      await pool.query(
        "INSERT INTO escape_state (id, data, updated_at) VALUES ('main', $1, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
        [json]
      );
    }
  };
}

function seed() {
  const db = { locations: game.DEFAULT_LOCATIONS.map(l => ({ ...l })), sessions: {} };
  db.locations.forEach(l => { db.sessions[l.id] = game.freshSession(); });
  return db;
}

function normalize(db) {
  if (!db || !Array.isArray(db.locations)) return seed();
  db.sessions = db.sessions || {};
  db.locations.forEach(l => { if (!db.sessions[l.id]) db.sessions[l.id] = game.freshSession(); });
  return db;
}

async function createStore() {
  const pg = postgresConfig();
  const backend = pg ? postgresBackend(pg) : fileBackend();
  const db = normalize(await backend.load());
  let chain = Promise.resolve();

  const store = {
    backend: backend.name,
    db,
    // Schreibvorgänge werden seriell ausgeführt, damit ältere Stände keine neueren überschreiben.
    persist() {
      const json = JSON.stringify(db);
      chain = chain.then(() => backend.save(json)).catch(err => console.error('[store] Speichern fehlgeschlagen:', err.message));
      return chain;
    }
  };
  await store.persist();
  return store;
}

module.exports = { createStore };
