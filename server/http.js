// Minimaler HTTP-Router auf Basis von node:http mit einer kleinen, an Express angelehnten
// API (req.params, req.body, res.status().json() …). So läuft der Server ohne npm install.
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};

function extend(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.set = (k, v) => {
    if (typeof k === 'object') Object.entries(k).forEach(([a, b]) => res.setHeader(a, b));
    else res.setHeader(k, v);
    return res;
  };
  res.type = t => res.set('Content-Type', { js: TYPES['.js'], text: TYPES['.txt'], html: TYPES['.html'] }[t] || t);
  res.send = body => {
    if (!res.getHeader('Content-Type')) res.type('text');
    res.end(body);
  };
  res.json = obj => { res.set('Content-Type', TYPES['.json']); res.end(JSON.stringify(obj)); };
  res.sendStatus = code => res.status(code).send(http.STATUS_CODES[code] || String(code));
  res.redirect = url => { res.statusCode = 302; res.setHeader('Location', url); res.end(); };
  res.sendFile = file => {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return res.sendStatus(404);
      res.set({ 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size });
      fs.createReadStream(file).pipe(res);
    });
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') return resolve({});
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 32 * 1024) { reject(Object.assign(new Error('Anfrage zu groß.'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('Ungültiges JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function createRouter() {
  const routes = [];
  const add = method => (pattern, ...handlers) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handlers });
  };
  const router = { get: add('GET'), post: add('POST'), delete: add('DELETE'), routes };

  // Führt die passende Route aus; liefert false, wenn keine passt.
  router.handle = (req, res, pathname) => {
    for (const r of routes) {
      if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      req.params = {};
      r.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); });
      let i = 0;
      const next = () => { const h = r.handlers[i++]; if (h) h(req, res, next); };
      next();
      return true;
    }
    return false;
  };
  return router;
}

// Liefert Dateien aus einem Verzeichnis aus, ohne es verlassen zu können.
function serveStatic(dir, req, res, relPath, headers) {
  const file = path.normalize(path.join(dir, relPath));
  if (!file.startsWith(dir + path.sep)) { res.sendStatus(404); return; }
  res.set(headers || {});
  res.sendFile(file);
}

function createServer(router, fallback) {
  return http.createServer(async (req, res) => {
    extend(res);
    const url = new URL(req.url, 'http://localhost');
    req.path = url.pathname;
    req.originalUrl = req.url;
    req.query = Object.fromEntries(url.searchParams);
    try {
      req.body = await readBody(req);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    try {
      if (!router.handle(req, res, url.pathname)) fallback(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: 'Interner Fehler.' });
    }
  });
}

module.exports = { createRouter, createServer, serveStatic };
