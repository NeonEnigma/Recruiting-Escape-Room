const crypto = require('crypto');
const game = require('./game');
const { requireRole } = require('./auth');

// Öffentliche Sicht auf eine Session – ohne Spieler-Token.
function publicSession(s) {
  const { token, solvedAt, ...rest } = s;
  return { ...rest, solved: !!solvedAt };
}

function registerApi(router, store, config) {
  const db = store.db;

  const snapshot = () => {
    const now = Date.now();
    if (game.autoFinish(db, now)) store.persist();
    const sessions = {};
    for (const l of db.locations) sessions[l.id] = publicSession(db.sessions[l.id]);
    return { serverNow: now, locations: db.locations, sessions };
  };
  const fail = (res, status, error) => res.status(status).json({ error, state: snapshot() });
  const done = (res, extra) => { store.persist(); res.json({ ...extra, state: snapshot() }); };

  function session(req, res) {
    const s = db.sessions[req.params.loc];
    if (!s || !db.locations.some(l => l.id === req.params.loc)) { fail(res, 404, 'Standort nicht gefunden.'); return null; }
    return s;
  }

  // ---------- Öffentlich ----------
  router.get('/api/state', (req, res) => res.json(snapshot()));
  router.get('/api/puzzle', (req, res) => res.json(game.puzzle));

  // ---------- Spieler-Terminal ----------
  router.post('/api/terminal/:loc/login', (req, res) => {
    const s = session(req, res); if (!s) return;
    const name = String(req.body.name || '').trim().slice(0, 60);
    const pw = String(req.body.password || '').trim().toLowerCase();
    if (!game.playable(s, Date.now())) return fail(res, 409, 'Die Session läuft gerade nicht.');
    if (!name) return fail(res, 400, 'Bitte gebt einen Namen ein.');
    if (pw !== config.playerPassword.toLowerCase()) return fail(res, 401, 'Zugangsdaten ungültig.');
    // Erneute Anmeldung (z.B. nach Gerätewechsel) setzt den Fortschritt nicht zurück.
    s.token = crypto.randomBytes(16).toString('hex');
    if (s.stage === 0) { s.team = name; s.stage = 1; s.stageAt[0] = Date.now(); }
    done(res, { token: s.token, sid: s.sid });
  });

  function player(req, res) {
    const s = session(req, res); if (!s) return null;
    if (!s.token || req.body.token !== s.token) { fail(res, 401, 'Bitte meldet euch erneut an.'); return null; }
    if (!game.playable(s, Date.now())) { fail(res, 409, 'Die Session läuft gerade nicht.'); return null; }
    return s;
  }

  router.post('/api/terminal/:loc/code', (req, res) => {
    const s = player(req, res); if (!s) return;
    if (s.stage === 1) { s.stage = 2; s.stageAt[1] = Date.now(); }
    done(res);
  });

  router.post('/api/terminal/:loc/train', (req, res) => {
    const s = player(req, res); if (!s) return;
    if (s.stage !== 2) return fail(res, 409, 'Das KI-Training ist gerade nicht aktiv.');
    const result = game.train(req.body.roles, req.body.removed);
    if (result.ok) s.solvedAt = s.solvedAt || Date.now();
    else s.fails = (s.fails || 0) + 1;
    done(res, { result });
  });

  router.post('/api/terminal/:loc/finish', (req, res) => {
    const s = session(req, res); if (!s) return;
    if (s.status === 'finished') return done(res);
    if (!s.token || req.body.token !== s.token) return fail(res, 401, 'Bitte meldet euch erneut an.');
    if (!s.solvedAt) return fail(res, 409, 'Das Modell wurde noch nicht erfolgreich trainiert.');
    game.finish(s, Date.now());
    done(res);
  });

  // ---------- Betreuer ----------
  const staff = requireRole(config, ['betreuer', 'admin']);
  router.get('/api/staff', staff, (req, res) => res.json({ role: req.role, playerPassword: config.playerPassword }));

  // Läuft die Zeit, wird die bisher verstrichene Zeit festgeschrieben (höchstens bis zum Ende).
  function settle(s, now) {
    if (s.status !== 'running') return;
    s.elapsed = Math.min(s.duration, s.elapsed + now - s.startedAt);
    s.startedAt = now;
  }

  router.post('/api/sessions/:loc/start', staff, (req, res) => {
    const s = session(req, res); if (!s) return;
    if (s.status !== 'idle') return fail(res, 409, 'Die Session wurde bereits gestartet.');
    Object.assign(s, { status: 'running', startedAt: Date.now(), elapsed: 0, duration: game.DEFAULT_DURATION });
    done(res);
  });

  router.post('/api/sessions/:loc/pause', staff, (req, res) => {
    const s = session(req, res); if (!s) return;
    if (s.status !== 'running') return fail(res, 409, 'Die Session läuft nicht.');
    settle(s, Date.now());
    s.status = 'paused';
    done(res);
  });

  router.post('/api/sessions/:loc/resume', staff, (req, res) => {
    const s = session(req, res); if (!s) return;
    if (s.status !== 'paused') return fail(res, 409, 'Die Session ist nicht pausiert.');
    s.status = 'running';
    s.startedAt = Date.now();
    done(res);
  });

  router.post('/api/sessions/:loc/adjust', staff, (req, res) => {
    const s = session(req, res); if (!s) return;
    if (s.status !== 'running' && s.status !== 'paused') return fail(res, 409, 'Die Session ist nicht aktiv.');
    const minutes = Math.max(-60, Math.min(60, parseInt(req.body.minutes, 10) || 0));
    settle(s, Date.now());
    s.duration = Math.max(game.MIN_DURATION, s.duration + minutes * 60000);
    done(res);
  });

  router.post('/api/sessions/:loc/reset', staff, (req, res) => {
    if (!session(req, res)) return;
    db.sessions[req.params.loc] = game.freshSession();
    done(res);
  });

  router.post('/api/sessions/:loc/hint', staff, (req, res) => {
    const s = session(req, res); if (!s) return;
    const text = String(req.body.text || '').trim().slice(0, 500);
    if (!text) return fail(res, 400, 'Bitte einen Hinweis eingeben.');
    s.hint = { text, t: Date.now() };
    done(res);
  });

  // ---------- Superadmin ----------
  const admin = requireRole(config, ['admin']);

  router.post('/api/locations', admin, (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 60);
    const city = String(req.body.city || '').trim().slice(0, 60);
    if (db.locations.length >= game.MAX_LOCATIONS) return fail(res, 409, 'Maximal ' + game.MAX_LOCATIONS + ' Standorte möglich. Bitte zuerst einen löschen.');
    if (!name || !city) return fail(res, 400, 'Bitte Bezeichnung und Stadt angeben.');
    if (db.locations.some(l => l.name.toLowerCase() === name.toLowerCase())) return fail(res, 409, 'Dieser Standort existiert bereits.');
    const id = game.slugId(city, db.locations);
    db.locations.push({ id, name, city });
    db.sessions[id] = game.freshSession();
    done(res, { id });
  });

  router.delete('/api/locations/:loc', admin, (req, res) => {
    if (!session(req, res)) return;
    db.locations = db.locations.filter(l => l.id !== req.params.loc);
    delete db.sessions[req.params.loc];
    done(res);
  });

}

module.exports = { registerApi };
