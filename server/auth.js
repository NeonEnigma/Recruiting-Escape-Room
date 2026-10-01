// Anmeldung für Betreuer (je Standort) und Root. Nach erfolgreicher Anmeldung erhält der
// Browser ein signiertes, HttpOnly-Cookie mit Rolle und Standort.
const crypto = require('crypto');

const COOKIE = 'escape_auth';
const MAX_AGE = 12 * 60 * 60; // Sekunden

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
}

function checkPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const actual = crypto.scryptSync(String(pw), salt, 32);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

function sign(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

function verify(secret, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function createAuth(store, config) {
  const db = store.db;
  const rootHash = hashPassword(config.rootPassword);

  // Liefert { role: 'root' } oder { role: 'betreuer', loc } – oder null.
  function identify(req) {
    const p = verify(db.secret, readCookie(req, COOKIE));
    if (!p) return null;
    if (p.role === 'root') return { role: 'root' };
    const loc = db.locations.find(l => l.id === p.loc);
    // Standort gelöscht oder Passwort geändert → Anmeldung ungültig
    if (p.role !== 'betreuer' || !loc || (loc.authV || 0) !== p.v) return null;
    return { role: 'betreuer', loc: loc.id };
  }

  function setCookie(req, res, payload) {
    const token = sign(db.secret, { ...payload, exp: Date.now() + MAX_AGE * 1000 });
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.set('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`);
  }
  function clearCookie(res) {
    res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  // Prüft Root-Passwort oder das Betreuer-Passwort des Standorts.
  function login(role, locId, password) {
    if (role === 'root') return checkPassword(password, rootHash) ? { role: 'root' } : null;
    const loc = db.locations.find(l => l.id === locId);
    if (role !== 'betreuer' || !loc) return null;
    return checkPassword(password, loc.betreuerHash) ? { role: 'betreuer', loc: loc.id, v: loc.authV || 0 } : null;
  }

  // Root darf alles; ein Betreuer nur Routen ohne :loc oder mit seinem eigenen Standort.
  const allowed = (who, req, roles) => who && roles.includes(who.role) && (who.role === 'root' || !req.params.loc || who.loc === req.params.loc);

  function api(roles) {
    return (req, res, next) => {
      const who = identify(req);
      if (allowed(who, req, roles)) { req.who = who; return next(); }
      res.status(who ? 403 : 401).json({ error: who ? 'Keine Berechtigung.' : 'Bitte erneut anmelden.' });
    };
  }

  // Seiten leiten ohne passende Anmeldung zur Startseite um.
  function page(roles) {
    return (req, res, next) => {
      const who = identify(req);
      if (who && roles.includes(who.role)) { req.who = who; return next(); }
      res.redirect('/');
    };
  }

  return { identify, login, setCookie, clearCookie, api, page };
}

module.exports = { createAuth, hashPassword, checkPassword };
