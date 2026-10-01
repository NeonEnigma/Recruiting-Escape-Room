// Startet den Server mit leerem Datenverzeichnis und spielt den kompletten Ablauf durch.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3000 + Math.floor(Math.random() * 1000) + 5000;
const BASE = 'http://localhost:' + PORT;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'escape-test-'));
let proc;

// Cookies der Anmeldungen: Betreuer Walldorf, Betreuer Berlin, Root
let BETREUER, BETREUER_BER, ADMIN;

async function call(method, url, body, auth) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Cookie = auth;
  const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT, DATA_DIR: dataDir, LIVE_RELOAD: 'false', NODE_ENV: 'test' }
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', d => { if (String(d).includes('läuft')) resolve(); });
    proc.on('exit', code => reject(new Error('Server beendet: ' + code)));
  });
  BETREUER = await login({ role: 'betreuer', loc: 'wdf', password: 'betreuer' });
  BETREUER_BER = await login({ role: 'betreuer', loc: 'ber', password: 'betreuer' });
  ADMIN = await login({ role: 'root', password: 'root' });
});

async function login(body) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(r.status, 200, 'Anmeldung ' + JSON.stringify(body));
  return r.headers.get('set-cookie').split(';')[0];
}
after(() => { proc.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('Seiten und Zugriffsschutz', async () => {
  assert.equal((await call('GET', '/')).status, 302);
  assert.equal((await call('GET', '/Spieler.dc.html')).status, 200);
  assert.equal((await call('GET', '/Betreuer.dc.html')).status, 302, 'ohne Anmeldung zur Startseite');
  assert.equal((await call('GET', '/Betreuer.dc.html', null, BETREUER)).status, 200);
  assert.equal((await call('GET', '/Betreuer.dc.html', null, ADMIN)).status, 200);
  assert.equal((await call('GET', '/Superadmin.dc.html', null, BETREUER)).status, 302);
  assert.equal((await call('GET', '/Betreuer.dc.html', null, 'escape_auth=gefälscht.abc')).status, 302);
  assert.equal((await call('GET', '/Superadmin.dc.html', null, ADMIN)).status, 200);
  assert.equal((await call('GET', '/_ds/industry-8ef56458-4fb0-41eb-a4c0-4aa8fbd88bf5/styles.css')).status, 200);
  assert.equal((await call('GET', '/_ds/../server/index.js')).status, 404);
  assert.equal((await call('GET', '/package.json')).status, 404);
  assert.equal((await call('POST', '/api/sessions/wdf/start')).status, 401);
  assert.equal((await call('POST', '/api/locations', { name: 'X', city: 'Y', password: 'abcd' }, BETREUER)).status, 403);
});

test('Anmeldung und Rechte pro Standort', async () => {
  assert.equal((await call('POST', '/api/auth/login', { role: 'betreuer', loc: 'wdf', password: 'falsch' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { role: 'root', password: 'betreuer' })).status, 401);
  const staff = await call('GET', '/api/staff', null, BETREUER);
  assert.deepEqual([staff.json.role, staff.json.loc], ['betreuer', 'wdf']);
  assert.equal((await call('POST', '/api/sessions/ber/hint', { text: 'x' }, BETREUER)).status, 403, 'fremder Standort');
  assert.equal((await call('POST', '/api/sessions/ber/hint', { text: 'x' }, BETREUER_BER)).status, 200);
  assert.equal((await call('POST', '/api/sessions/muc/hint', { text: 'x' }, ADMIN)).status, 200, 'Root darf alle');
  const { json } = await call('GET', '/api/state');
  assert.ok(json.locations.every(l => !('betreuerHash' in l)), 'keine Passwort-Hashes im öffentlichen Zustand');
  // Terminal entsperren
  assert.equal((await call('POST', '/api/auth/check', { loc: 'wdf', password: 'betreuer' })).status, 200);
  assert.equal((await call('POST', '/api/auth/check', { loc: 'wdf', password: 'root' })).status, 200);
  assert.equal((await call('POST', '/api/auth/check', { loc: 'wdf', password: 'x' })).status, 401);
});

test('Rätseldaten enthalten keine Lösung', async () => {
  const { json } = await call('GET', '/api/puzzle');
  assert.equal(json.cols.length, 10);
  assert.ok(json.cols.every(c => !('rel' in c)));
  assert.equal(json.rows.length, 15);
});

test('Kompletter Spielablauf', async () => {
  let r = await call('POST', '/api/terminal/wdf/login', { name: 'Team A', password: 'onboarding' });
  assert.equal(r.status, 409, 'Login vor dem Start nicht möglich');

  r = await call('POST', '/api/sessions/wdf/start', {}, BETREUER);
  assert.equal(r.json.state.sessions.wdf.status, 'running');

  r = await call('POST', '/api/terminal/wdf/login', { name: 'Team A', password: 'falsch' });
  assert.equal(r.status, 401);
  r = await call('POST', '/api/terminal/wdf/login', { name: 'Team A', password: ' ONBOARDING ' });
  assert.equal(r.status, 200);
  const token = r.json.token;
  assert.ok(!('token' in r.json.state.sessions.wdf), 'Token wird nicht öffentlich geteilt');
  assert.equal(r.json.state.sessions.wdf.stage, 1);

  assert.equal((await call('POST', '/api/terminal/wdf/code', { token: 'falsch' })).status, 401);
  r = await call('POST', '/api/terminal/wdf/code', { token });
  assert.equal(r.json.state.sessions.wdf.stage, 2);

  r = await call('POST', '/api/terminal/wdf/train', { token, roles: { temp: 'feat', kosten: 'feat' }, removed: {} });
  assert.equal(r.json.result.ok, false);
  assert.ok(r.json.result.issues.length >= 3);
  assert.equal(r.json.state.sessions.wdf.fails, 1);

  assert.equal((await call('POST', '/api/terminal/wdf/finish', { token })).status, 409, 'Abschluss erst nach erfolgreichem Training');

  const roles = { temp: 'feat', vib: 'feat', rpm: 'feat', std: 'feat', ausfall: 'target' };
  const removed = { 3: true, 5: true, 7: true, 8: true, 10: true, 12: true };
  r = await call('POST', '/api/terminal/wdf/train', { token, roles, removed });
  assert.deepEqual(r.json.result, { ok: true, acc: 96, issues: [] });
  assert.equal(r.json.state.sessions.wdf.solved, true);

  r = await call('POST', '/api/terminal/wdf/finish', { token });
  const s = r.json.state.sessions.wdf;
  assert.equal(s.status, 'finished');
  assert.equal(s.stage, 3);
  assert.ok(s.elapsed >= 0 && s.elapsed < 60000);
});

test('Timer: Pause, Fortsetzen, ±5 Minuten, Reset, Hinweis', async () => {
  await call('POST', '/api/sessions/ber/start', {}, BETREUER_BER);
  let r = await call('POST', '/api/sessions/ber/adjust', { minutes: 5 }, BETREUER_BER);
  assert.equal(r.json.state.sessions.ber.duration, 35 * 60000);
  r = await call('POST', '/api/sessions/ber/pause', {}, BETREUER_BER);
  assert.equal(r.json.state.sessions.ber.status, 'paused');
  assert.equal((await call('POST', '/api/terminal/ber/login', { name: 'B', password: 'onboarding' })).status, 409, 'Kein Login während Pause');
  r = await call('POST', '/api/sessions/ber/resume', {}, BETREUER_BER);
  assert.equal(r.json.state.sessions.ber.status, 'running');
  r = await call('POST', '/api/sessions/ber/hint', { text: 'Schaut auf die Einheiten.' }, BETREUER_BER);
  assert.equal(r.json.state.sessions.ber.hint.text, 'Schaut auf die Einheiten.');
  const sid = r.json.state.sessions.ber.sid;
  r = await call('POST', '/api/sessions/ber/reset', {}, BETREUER_BER);
  assert.equal(r.json.state.sessions.ber.status, 'idle');
  assert.notEqual(r.json.state.sessions.ber.sid, sid);
});

test('Standortverwaltung', async () => {
  assert.equal((await call('POST', '/api/locations', { name: 'Köln Zentrum', city: 'Köln' }, ADMIN)).status, 400, 'Passwort fehlt');
  let r = await call('POST', '/api/locations', { name: 'Köln Zentrum', city: 'Köln', password: 'koeln1' }, ADMIN);
  assert.equal(r.status, 200);
  assert.equal(r.json.id, 'kol');
  const kol = await login({ role: 'betreuer', loc: 'kol', password: 'koeln1' });
  assert.equal((await call('POST', '/api/sessions/kol/start', {}, kol)).status, 200);
  // Passwortwechsel meldet bestehende Betreuer ab
  assert.equal((await call('POST', '/api/locations/kol/password', { password: 'neu123' }, ADMIN)).status, 200);
  assert.equal((await call('GET', '/api/staff', null, kol)).status, 401);
  await login({ role: 'betreuer', loc: 'kol', password: 'neu123' });
  assert.equal((await call('POST', '/api/locations', { name: 'köln zentrum', city: 'Köln', password: 'abcd' }, ADMIN)).status, 409);
  for (let i = 0; i < 4; i++) await call('POST', '/api/locations', { name: 'Ort ' + i, city: 'Stadt', password: 'abcd' }, ADMIN);
  r = await call('POST', '/api/locations', { name: 'Zu viel', city: 'Stadt', password: 'abcd' }, ADMIN);
  assert.equal(r.status, 409);
  assert.equal(r.json.state.locations.length, 8);
  r = await call('DELETE', '/api/locations/kol', null, ADMIN);
  assert.ok(!r.json.state.locations.some(l => l.id === 'kol'));
  assert.ok(!('kol' in r.json.state.sessions));
});

test('Zustand wird gespeichert', async () => {
  await new Promise(res => setTimeout(res, 100));
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(saved.sessions.wdf.status, 'finished');
  assert.equal(saved.locations.length, 7);
});
