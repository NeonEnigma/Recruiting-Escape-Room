const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

function issueToken(user) {
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    SECRET,
    { expiresIn: '8h' }
  );
  return {
    token, role: user.role,
    p_timed: user.p_timed, p_dev: user.p_dev, p_ai: user.p_ai,
    spectates_id: user.spectates_id, location_id: user.location_id
  };
}

function timerRunning(locationId) {
  const loc = db.prepare('SELECT timer_state, timer_end FROM locations WHERE id = ?').get(locationId);
  if (!loc) return false;
  if (loc.timer_state !== 'running') return false;
  return loc.timer_end && loc.timer_end > Date.now();
}

// POST /api/login
// Location login: { username: 'John'|'Spectator', location_id, password }
// Admin login:    { username: 'admin', password }
router.post('/login', (req, res) => {
  const { location_id, username, password } = req.body;
  if (!password) return res.status(400).json({ error: 'Passwort erforderlich.' });
  if (!username) return res.status(400).json({ error: 'Benutzername erforderlich.' });

  const uname = String(username).trim().toLowerCase();
  let user;
  if (uname === 'john' || uname === 'spectator') {
    if (!location_id) return res.status(400).json({ error: 'Standort erforderlich.' });
    const prefix = uname === 'john' ? 'john_' : 'spectator_';
    user = db.prepare('SELECT * FROM users WHERE username = ?').get(prefix + location_id);
    if (!user) return res.status(404).json({ error: 'Kein Account für diesen Standort.' });
  } else {
    // Admin (or any other exact username)
    user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Ungültige Zugangsdaten.' });
  }

  // A player may only log in while their location's timer is running
  if (user.role === 'player' && !timerRunning(user.location_id)) {
    return res.status(403).json({ error: 'Der Timer wurde noch nicht gestartet – bitte warten.' });
  }

  res.json(issueToken(user));
});

// POST /api/verify-unlock — check a password to allow changing location.
// Accepts the location's Spectator password OR the Admin password.
// Body: { location_id, password }
router.post('/verify-unlock', (req, res) => {
  const { location_id, password } = req.body;
  if (!password) return res.status(400).json({ error: 'Passwort erforderlich.' });

  const admin = db.prepare("SELECT password_hash FROM users WHERE username = 'admin'").get();
  if (admin && bcrypt.compareSync(password, admin.password_hash)) {
    return res.json({ ok: true });
  }
  if (location_id) {
    const spec = db.prepare("SELECT password_hash FROM users WHERE username = ?").get('spectator_' + location_id);
    if (spec && bcrypt.compareSync(password, spec.password_hash)) {
      return res.json({ ok: true });
    }
  }
  res.status(401).json({ ok: false, error: 'Falsches Passwort.' });
});

// GET /api/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, username, role, p_timed, p_dev, p_ai, spectates_id, location_id, created_at FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

// GET /api/locations — public list for the pre-login location picker
router.get('/locations', (req, res) => {
  const locs = db.prepare('SELECT id, name FROM locations ORDER BY name').all();
  res.json(locs);
});

module.exports = router;
