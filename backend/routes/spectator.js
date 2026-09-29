const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Ensure the caller is a spectator and return the player they watch
function getWatchedPlayer(req, res) {
  if (req.user.role !== 'spectator') {
    res.status(403).json({ error: 'Spectator only' });
    return null;
  }
  const me = db.prepare('SELECT spectates_id FROM users WHERE id = ?').get(req.user.id);
  if (!me || !me.spectates_id) {
    res.status(404).json({ error: 'No player assigned' });
    return null;
  }
  const player = db.prepare('SELECT id, username, p_timed, p_dev, p_ai FROM users WHERE id = ?').get(me.spectates_id);
  if (!player) {
    res.status(404).json({ error: 'Player not found' });
    return null;
  }
  return player;
}

// GET /api/spectator/target — status of the watched player
router.get('/target', requireAuth, (req, res) => {
  const player = getWatchedPlayer(req, res);
  if (!player) return;
  res.json({
    username: player.username,
    p_timed: player.p_timed,
    p_dev: player.p_dev,
    p_ai: player.p_ai
  });
});

// GET /api/spectator/chat — chat history of the watched player
router.get('/chat', requireAuth, (req, res) => {
  const player = getWatchedPlayer(req, res);
  if (!player) return;
  const messages = db.prepare('SELECT sender, text FROM chat_messages WHERE user_id = ? ORDER BY id').all(player.id);
  res.json(messages);
});

module.exports = router;
