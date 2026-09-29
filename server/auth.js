// HTTP Basic Auth für Betreuer-Konsole und Superadmin.
// Benutzer: "betreuer" (BETREUER_PASSWORD) und "admin" (ADMIN_PASSWORD).
const crypto = require('crypto');

const digest = v => crypto.createHash('sha256').update(String(v)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

function roleFor(config, header) {
  const [scheme, encoded] = String(header || '').split(' ');
  if (scheme !== 'Basic' || !encoded) return null;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  const user = decoded.slice(0, i).trim().toLowerCase();
  const pw = decoded.slice(i + 1);
  if (user === 'admin' && safeEqual(pw, config.adminPassword)) return 'admin';
  if (user === 'betreuer' && safeEqual(pw, config.betreuerPassword)) return 'betreuer';
  return null;
}

function requireRole(config, roles) {
  return (req, res, next) => {
    const role = roleFor(config, req.headers.authorization);
    if (role && roles.includes(role)) { req.role = role; return next(); }
    res.set('WWW-Authenticate', 'Basic realm="Escape Room", charset="UTF-8"');
    if (req.originalUrl.startsWith('/api/')) return res.status(role ? 403 : 401).json({ error: 'Keine Berechtigung.' });
    // Auch bei falscher Rolle 401, damit der Browser erneut nach Zugangsdaten fragt.
    res.status(401).type('text').send(role ? 'Keine Berechtigung für diese Seite – bitte als admin anmelden.' : 'Anmeldung erforderlich.');
  };
}

module.exports = { requireRole };
