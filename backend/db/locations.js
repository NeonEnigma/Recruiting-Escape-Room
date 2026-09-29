const bcrypt = require('bcryptjs');
const db = require('./database');

// A location always has exactly one player ("John") and one spectator.
// Their login name is always "John" / "Spectator" — the chosen location
// disambiguates which account is meant. Internally the usernames are unique
// per location (john_<id>, spectator_<id>).

function getPasswords() {
  const s = db.prepare('SELECT john_password, spectator_password FROM settings WHERE id = 1').get();
  return {
    john: (s && s.john_password) || '1234',
    spectator: (s && s.spectator_password) || '1234'
  };
}

// Create a location + its John and Spectator accounts. Returns location id.
function createLocation(name) {
  const info = db.prepare('INSERT INTO locations (name) VALUES (?)').run(name);
  const locId = info.lastInsertRowid;
  const pw = getPasswords();

  const johnHash = bcrypt.hashSync(pw.john, 10);
  const johnInfo = db.prepare(
    "INSERT INTO users (username, password_hash, role, location_id) VALUES (?, ?, 'player', ?)"
  ).run(`john_${locId}`, johnHash, locId);

  const specHash = bcrypt.hashSync(pw.spectator, 10);
  db.prepare(
    "INSERT INTO users (username, password_hash, role, spectates_id, location_id) VALUES (?, ?, 'spectator', ?, ?)"
  ).run(`spectator_${locId}`, specHash, johnInfo.lastInsertRowid, locId);

  return locId;
}

// Delete a location and its two accounts (+ their chat).
function deleteLocation(locId) {
  const accounts = db.prepare('SELECT id FROM users WHERE location_id = ?').all(locId);
  const del = db.prepare('DELETE FROM chat_messages WHERE user_id = ?');
  for (const a of accounts) del.run(a.id);
  db.prepare('DELETE FROM users WHERE location_id = ?').run(locId);
  db.prepare('DELETE FROM locations WHERE id = ?').run(locId);
}

// Re-hash all John/Spectator passwords after a global password change.
function applyPasswords() {
  const pw = getPasswords();
  const johnHash = bcrypt.hashSync(pw.john, 10);
  const specHash = bcrypt.hashSync(pw.spectator, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE role = 'player'").run(johnHash);
  db.prepare("UPDATE users SET password_hash = ? WHERE role = 'spectator'").run(specHash);
}

module.exports = { createLocation, deleteLocation, applyPasswords, getPasswords };
