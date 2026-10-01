const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createRouter, createServer, serveStatic } = require('./http');
const { createStore } = require('./store');
const { registerApi } = require('./api');
const { createAuth } = require('./auth');

const ROOT = path.join(__dirname, '..');
const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;

function secret(name, devDefault) {
  if (process.env[name]) return process.env[name];
  if (!PROD) return devDefault;
  const generated = crypto.randomBytes(9).toString('base64url');
  console.warn(`[config] ${name} ist nicht gesetzt – temporäres Passwort: ${generated}  (dauerhaft: cf set-env <app> ${name} <passwort>)`);
  return generated;
}

const config = {
  rootPassword: secret('ROOT_PASSWORD', 'root'),
  // Startpasswort der Betreuer für Standorte ohne eigenes Passwort (änderbar im Superadmin)
  betreuerPassword: secret('BETREUER_PASSWORD', 'betreuer'),
  playerPassword: process.env.PLAYER_PASSWORD || 'onboarding',
  liveReload: !PROD && process.env.LIVE_RELOAD !== 'false'
};

// Ist React installiert (auf Cloud Foundry durch das Buildpack), wird es lokal ausgeliefert;
// sonst lädt support.js es wie gewohnt von unpkg.
function vendorFiles() {
  try {
    const dir = pkg => path.join(path.dirname(require.resolve(pkg + '/package.json')), 'umd');
    return {
      'react.production.min.js': path.join(dir('react'), 'react.production.min.js'),
      'react-dom.production.min.js': path.join(dir('react-dom'), 'react-dom.production.min.js')
    };
  } catch {
    return null;
  }
}
const VENDOR = vendorFiles();

function configScript() {
  let js = '';
  if (VENDOR) {
    const resources = {
      'https://unpkg.com/react@18.3.1/umd/react.production.min.js': '/vendor/react.production.min.js',
      'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js': '/vendor/react-dom.production.min.js'
    };
    js += `window.__resources = Object.assign(window.__resources || {}, ${JSON.stringify(resources)});\n`;
  }
  if (config.liveReload) {
    // Lädt die Seite neu, wenn sich Design-Dateien ändern oder der Server neu gestartet wurde.
    js += `(function () { var seen = false, es = new EventSource('/__livereload');
  es.onopen = function () { if (seen) location.reload(); seen = true; };
  es.onmessage = function () { location.reload(); }; })();\n`;
  }
  return js;
}

function liveReload(router) {
  const clients = new Set();
  router.get('/__livereload', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': verbunden\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });
  let timer;
  const notify = (_, file) => {
    if (file && !/\.(html|js|css)$/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => clients.forEach(c => c.write('data: reload\n\n')), 120);
  };
  fs.watch(ROOT, notify);
  fs.watch(path.join(ROOT, '_ds'), { recursive: true }, notify);
}

async function main() {
  const store = await createStore(config);
  const auth = createAuth(store, config);
  const router = createRouter();

  router.get('/health', (req, res) => res.json({ ok: true }));
  registerApi(router, store, config, auth);

  router.get('/config.js', (req, res) => res.type('js').set('Cache-Control', 'no-store').send(configScript()));
  router.get('/vendor/:file', (req, res) => {
    const file = VENDOR && VENDOR[req.params.file];
    if (!file) return res.sendStatus(404);
    res.set('Cache-Control', 'public, max-age=604800').sendFile(file);
  });
  if (config.liveReload) liveReload(router);

  // Kurze Adressen
  router.get('/', (req, res) => res.redirect('/Spieler.dc.html'));
  router.get('/spieler', (req, res) => res.redirect('/Spieler.dc.html' + (req.query.loc ? '?loc=' + encodeURIComponent(req.query.loc) : '')));
  router.get('/betreuer', (req, res) => res.redirect('/Betreuer.dc.html'));
  router.get('/root', (req, res) => res.redirect('/Superadmin.dc.html'));
  router.get('/admin', (req, res) => res.redirect('/Superadmin.dc.html'));

  // Nur die Design-Dateien werden ausgeliefert – nicht Server-Code oder Konfiguration.
  const page = (file, ...guards) => router.get('/' + file, ...guards, (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(ROOT, file)));
  page('Spieler.dc.html');
  page('Betreuer.dc.html', auth.page(['betreuer', 'root']));
  page('Superadmin.dc.html', auth.page(['root']));
  page('support.js');

  const ds = path.join(ROOT, '_ds');
  const fallback = (req, res) => {
    if (req.method === 'GET' && req.path.startsWith('/_ds/')) {
      return serveStatic(ds, req, res, decodeURIComponent(req.path.slice(5)), { 'Cache-Control': 'no-cache' });
    }
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Unbekannter API-Endpunkt.' });
    res.status(404).type('text').send('Nicht gefunden.');
  };

  const server = createServer(router, fallback);
  let port = +PORT;
  // Lokal ohne festen PORT auf den nächsten freien Port ausweichen, statt abzubrechen.
  server.on('error', err => {
    if (err.code === 'EADDRINUSE' && !process.env.PORT && port < +PORT + 20) {
      console.warn(`Port ${port} ist belegt – versuche ${port + 1} …`);
      server.listen(++port);
      return;
    }
    if (err.code === 'EADDRINUSE') console.error(`Port ${port} ist belegt. Anderen Port wählen, z.B.: PORT=4000 npm run dev`);
    else console.error(err);
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(`Escape Room läuft auf http://localhost:${port}`);
    console.log(`  Speicher:   ${store.backend}`);
    console.log('  Start: Standort wählen, dann als Spieler oder Betreuer anmelden – oder als Root');
    if (!PROD && !process.env.ROOT_PASSWORD) console.log('  Lokale Passwörter: Root "root", Betreuer "betreuer" (je Standort änderbar), Team "onboarding"');
    if (config.liveReload) console.log('  Live-Reload aktiv');
  });
}

main().catch(err => {
  console.error('Start fehlgeschlagen:', err);
  process.exit(1);
});
