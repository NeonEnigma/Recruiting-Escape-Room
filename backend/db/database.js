const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'db.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'player',
    p_timed TEXT DEFAULT 'none',
    p_dev   TEXT DEFAULT 'none',
    p_ai    TEXT DEFAULT 'none',
    spectates_id INTEGER DEFAULT NULL,
    location_id INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration: add columns if missing (for existing DBs)
const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!cols.includes('p_timed')) db.exec("ALTER TABLE users ADD COLUMN p_timed TEXT DEFAULT 'none'");
if (!cols.includes('p_dev'))   db.exec("ALTER TABLE users ADD COLUMN p_dev TEXT DEFAULT 'none'");
if (!cols.includes('p_ai'))    db.exec("ALTER TABLE users ADD COLUMN p_ai TEXT DEFAULT 'none'");
if (!cols.includes('spectates_id')) db.exec("ALTER TABLE users ADD COLUMN spectates_id INTEGER DEFAULT NULL");
if (!cols.includes('location_id'))  db.exec("ALTER TABLE users ADD COLUMN location_id INTEGER DEFAULT NULL");

// Locations with a server-side 30-minute timer
db.exec(`
  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    timer_state TEXT DEFAULT 'idle',
    timer_end   INTEGER DEFAULT NULL,
    remaining_ms INTEGER DEFAULT 1800000
  );
`);

// Settings table for AI config + global John/Spectator passwords (single row, id=1)
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    ai_endpoint TEXT DEFAULT '',
    ai_token    TEXT DEFAULT '',
    john_password TEXT DEFAULT '1234',
    spectator_password TEXT DEFAULT '1234'
  );
`);
db.prepare('INSERT OR IGNORE INTO settings (id) VALUES (1)').run();
const scols = db.prepare("PRAGMA table_info(settings)").all().map(c => c.name);
if (!scols.includes('john_password'))      db.exec("ALTER TABLE settings ADD COLUMN john_password TEXT DEFAULT '1234'");
if (!scols.includes('spectator_password')) db.exec("ALTER TABLE settings ADD COLUMN spectator_password TEXT DEFAULT '1234'");

// Chat messages for the AI puzzle (persisted so spectators can follow along)
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = db;
