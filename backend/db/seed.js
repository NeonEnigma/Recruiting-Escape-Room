const bcrypt = require('bcryptjs');
const db = require('./database');
const { createLocation } = require('./locations');

function seed() {
  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('admin', hash, 'admin');
    console.log('Seeded admin user: admin / admin123');
  } else {
    console.log('Admin user already exists, skipping seed.');
  }

  // Ensure at least one location (with its John + Spectator accounts) exists
  if (db.prepare('SELECT COUNT(*) AS c FROM locations').get().c === 0) {
    createLocation('Walldorf');
    console.log('Seeded default location: Walldorf (John / Spectator)');
  }
}

seed();
