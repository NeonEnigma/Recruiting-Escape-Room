const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const FULL_MS = 30 * 60 * 1000; // 30 minutes

// Compute the current remaining time (ms) for a location row
function computeRemaining(loc) {
  if (loc.timer_state === 'running' && loc.timer_end) {
    return Math.max(0, loc.timer_end - Date.now());
  }
  return loc.remaining_ms;
}

function getLocation(id) {
  return db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
}

// GET /api/timer/:locationId — current state + remaining (public read)
router.get('/:locationId', (req, res) => {
  const loc = getLocation(req.params.locationId);
  if (!loc) return res.status(404).json({ error: 'Location not found' });
  const remaining = computeRemaining(loc);
  // Auto-flip to a terminal state when a running timer hits zero
  let state = loc.timer_state;
  if (state === 'running' && remaining <= 0) {
    db.prepare("UPDATE locations SET timer_state = 'stopped', remaining_ms = 0, timer_end = NULL WHERE id = ?").run(loc.id);
    state = 'stopped';
  }
  res.json({ state, remaining_ms: remaining });
});

// Authorization for control endpoints: admin, or the spectator assigned to THIS location
function canControl(req, locationId) {
  if (req.user.role === 'admin') return true;
  if (req.user.role !== 'spectator') return false;
  const me = db.prepare('SELECT location_id FROM users WHERE id = ?').get(req.user.id);
  return me && String(me.location_id) === String(locationId);
}

function control(action) {
  return (req, res) => {
    const loc = getLocation(req.params.locationId);
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    if (!canControl(req, req.params.locationId)) return res.status(403).json({ error: 'Not allowed' });

    if (action === 'start') {
      // Resume from whatever time is left (or a full 30 min if idle/reset)
      const base = loc.timer_state === 'idle' ? FULL_MS : computeRemaining(loc);
      const remaining = base > 0 ? base : FULL_MS;
      db.prepare("UPDATE locations SET timer_state = 'running', timer_end = ?, remaining_ms = ? WHERE id = ?")
        .run(Date.now() + remaining, remaining, loc.id);
    } else if (action === 'pause') {
      const remaining = computeRemaining(loc);
      db.prepare("UPDATE locations SET timer_state = 'paused', remaining_ms = ?, timer_end = NULL WHERE id = ?")
        .run(remaining, loc.id);
    } else if (action === 'stop') {
      const remaining = computeRemaining(loc);
      db.prepare("UPDATE locations SET timer_state = 'stopped', remaining_ms = ?, timer_end = NULL WHERE id = ?")
        .run(remaining, loc.id);
    } else if (action === 'reset') {
      db.prepare("UPDATE locations SET timer_state = 'idle', remaining_ms = ?, timer_end = NULL WHERE id = ?")
        .run(FULL_MS, loc.id);
      // Reset the location's player progress + chat for a fresh run
      const players = db.prepare("SELECT id FROM users WHERE location_id = ? AND role = 'player'").all(loc.id);
      for (const p of players) {
        db.prepare("UPDATE users SET p_timed = 'none', p_dev = 'none', p_ai = 'none' WHERE id = ?").run(p.id);
        db.prepare('DELETE FROM chat_messages WHERE user_id = ?').run(p.id);
      }
    }

    const updated = getLocation(req.params.locationId);
    res.json({ state: updated.timer_state, remaining_ms: computeRemaining(updated) });
  };
}

router.post('/:locationId/start', requireAuth, control('start'));
router.post('/:locationId/pause', requireAuth, control('pause'));
router.post('/:locationId/stop',  requireAuth, control('stop'));
router.post('/:locationId/reset', requireAuth, control('reset'));

// POST /api/timer/:locationId/adjust — add/subtract minutes. Body: { minutes: 5 | -5 }
router.post('/:locationId/adjust', requireAuth, (req, res) => {
  const loc = getLocation(req.params.locationId);
  if (!loc) return res.status(404).json({ error: 'Location not found' });
  if (!canControl(req, req.params.locationId)) return res.status(403).json({ error: 'Not allowed' });

  const deltaMs = (parseInt(req.body.minutes) || 0) * 60 * 1000;
  const current = computeRemaining(loc);
  const next = Math.max(0, current + deltaMs);

  if (loc.timer_state === 'running') {
    db.prepare("UPDATE locations SET timer_end = ?, remaining_ms = ? WHERE id = ?")
      .run(Date.now() + next, next, loc.id);
  } else {
    db.prepare("UPDATE locations SET remaining_ms = ? WHERE id = ?").run(next, loc.id);
  }

  const updated = getLocation(req.params.locationId);
  res.json({ state: updated.timer_state, remaining_ms: computeRemaining(updated) });
});

// Freeze the timer as "finished" (called when the player solves the last puzzle)
function freezeFinished(locationId) {
  const loc = getLocation(locationId);
  if (!loc) return;
  const remaining = computeRemaining(loc);
  db.prepare("UPDATE locations SET timer_state = 'finished', remaining_ms = ?, timer_end = NULL WHERE id = ?")
    .run(remaining, loc.id);
}

module.exports = router;
module.exports.freezeFinished = freezeFinished;
