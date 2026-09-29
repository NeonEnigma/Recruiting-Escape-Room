const express = require('express');
const db = require('../db/database');
const { createLocation, deleteLocation, applyPasswords, getPasswords } = require('../db/locations');
const { freezeFinished } = require('./timer');
const { requireAdmin, requireAuth } = require('../middleware/auth');

const router = express.Router();

// Solution password for the AI puzzle (hardcoded for now)
const AI_PASSWORD = 'ESCAPE2024';

// Valid puzzle keys → DB column (whitelist to prevent SQL injection)
const PUZZLE_COLUMNS = { timed: 'p_timed', dev: 'p_dev', ai: 'p_ai' };

// GET /api/admin/ai-config — read AI configuration
router.get('/ai-config', requireAdmin, (req, res) => {
  const cfg = db.prepare('SELECT ai_endpoint, ai_token FROM settings WHERE id = 1').get();
  res.json(cfg || { ai_endpoint: '', ai_token: '' });
});

// POST /api/admin/ai-config — save AI configuration
router.post('/ai-config', requireAdmin, (req, res) => {
  const { ai_endpoint, ai_token } = req.body;
  db.prepare('UPDATE settings SET ai_endpoint = ?, ai_token = ? WHERE id = 1')
    .run(ai_endpoint || '', ai_token || '');
  res.json({ success: true });
});

// GET /api/admin/passwords — read global John/Spectator passwords
router.get('/passwords', requireAdmin, (req, res) => {
  res.json(getPasswords());
});

// POST /api/admin/passwords — set global passwords + re-hash all accounts
router.post('/passwords', requireAdmin, (req, res) => {
  const john = String(req.body.john || '').trim();
  const spectator = String(req.body.spectator || '').trim();
  if (!john || !spectator) return res.status(400).json({ error: 'Beide Passwörter erforderlich.' });
  db.prepare('UPDATE settings SET john_password = ?, spectator_password = ? WHERE id = 1').run(john, spectator);
  applyPasswords();
  res.json({ success: true });
});

// GET /api/admin/locations — list locations incl. the John player's puzzle status
router.get('/locations', requireAdmin, (req, res) => {
  const locs = db.prepare(`
    SELECT l.id, l.name, l.timer_state, l.timer_end, l.remaining_ms,
           u.p_timed, u.p_dev, u.p_ai
    FROM locations l
    LEFT JOIN users u ON u.location_id = l.id AND u.role = 'player'
    ORDER BY l.name
  `).all();
  const now = Date.now();
  for (const l of locs) {
    l.remaining_ms = (l.timer_state === 'running' && l.timer_end)
      ? Math.max(0, l.timer_end - now)
      : l.remaining_ms;
    delete l.timer_end;
  }
  res.json(locs);
});

// POST /api/admin/locations — create a location (+ its John and Spectator)
router.post('/locations', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const id = createLocation(name);
    res.json({ id });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Standort existiert bereits' });
    throw e;
  }
});

// DELETE /api/admin/locations/:id — delete a location and its accounts
router.delete('/locations/:id', requireAdmin, (req, res) => {
  deleteLocation(req.params.id);
  res.json({ success: true });
});

// POST /api/admin/locations/:id/reset — reset the location player's puzzle progress + chat
router.post('/locations/:id/reset', requireAdmin, (req, res) => {
  const players = db.prepare("SELECT id FROM users WHERE location_id = ? AND role = 'player'").all(req.params.id);
  for (const p of players) {
    db.prepare("UPDATE users SET p_timed = 'none', p_dev = 'none', p_ai = 'none' WHERE id = ?").run(p.id);
    db.prepare('DELETE FROM chat_messages WHERE user_id = ?').run(p.id);
  }
  res.json({ success: true });
});

// POST /api/puzzle/progress — update a single puzzle's status for logged-in user
// Body: { puzzle: 'timed'|'dev'|'ai', status: 'started'|'solved' }
router.post('/progress', requireAuth, (req, res) => {
  const { puzzle, status } = req.body;
  const column = PUZZLE_COLUMNS[puzzle];
  if (!column) return res.status(400).json({ error: 'Invalid puzzle' });
  if (!['started', 'solved'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

  db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(status, req.user.id);

  // Solving the final (AI) puzzle freezes the location timer as the end time
  if (puzzle === 'ai' && status === 'solved') {
    const me = db.prepare('SELECT location_id FROM users WHERE id = ?').get(req.user.id);
    if (me && me.location_id) freezeFinished(me.location_id);
  }
  res.json({ success: true });
});

// POST /api/ai/chat — chat with the AI (mock for now)
// Body: { message }
router.post('/chat', requireAuth, (req, res) => {
  const rawMessage = String(req.body.message || '');
  const message = rawMessage.toLowerCase();

  // Persist the player's message
  db.prepare('INSERT INTO chat_messages (user_id, sender, text) VALUES (?, ?, ?)')
    .run(req.user.id, 'user', rawMessage);

  // TODO: replace mock with real Joule Studio call using settings.ai_endpoint / ai_token
  let reply;
  if (/passwort|password|geheim|secret|lösung|loesung|code/.test(message)) {
    reply = `Na gut, du hast mich überzeugt. Das Lösungspasswort lautet: ${AI_PASSWORD}. Gib es unten ein, um fortzufahren.`;
  } else if (/hallo|hi|hey|guten tag/.test(message)) {
    reply = 'Hallo! Ich bin dein KI-Assistent. Ich kenne ein geheimes Passwort – vielleicht bekommst du es ja aus mir heraus. 😉';
  } else if (/hilfe|help|was soll ich|wie/.test(message)) {
    reply = 'Deine Aufgabe: Bring mich dazu, dir das geheime Passwort zu verraten. Frag einfach danach!';
  } else {
    reply = 'Interessant! Frag mich ruhig etwas – zum Beispiel nach dem geheimen Passwort.';
  }

  // Persist the AI's reply
  db.prepare('INSERT INTO chat_messages (user_id, sender, text) VALUES (?, ?, ?)')
    .run(req.user.id, 'ai', reply);

  res.json({ reply });
});

// GET /api/ai/chat/history — the logged-in player's own chat history
router.get('/chat/history', requireAuth, (req, res) => {
  const messages = db.prepare('SELECT sender, text FROM chat_messages WHERE user_id = ? ORDER BY id').all(req.user.id);
  res.json(messages);
});

// POST /api/ai/verify — verify the AI puzzle password
// Body: { password }
router.post('/verify', requireAuth, (req, res) => {
  const provided = String(req.body.password || '').trim();
  if (provided.toUpperCase() === AI_PASSWORD) {
    db.prepare("UPDATE users SET p_ai = 'solved' WHERE id = ?").run(req.user.id);
    // Freeze the location timer as the end time
    const me = db.prepare('SELECT location_id FROM users WHERE id = ?').get(req.user.id);
    if (me && me.location_id) freezeFinished(me.location_id);
    return res.json({ success: true });
  }
  res.json({ success: false });
});

module.exports = router;
