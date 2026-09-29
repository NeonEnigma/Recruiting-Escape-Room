// Spielregeln, Session-Modell und Rätsel-Lösung. Die Lösung liegt nur hier auf dem
// Server, damit sie nicht im Quelltext des Spieler-Terminals auftaucht.
const crypto = require('crypto');

const MAX_LOCATIONS = 8;
const DEFAULT_DURATION = 30 * 60 * 1000;
const STEP = 5 * 60 * 1000;
const MIN_DURATION = 60 * 1000;
// Falls das Terminal nach erfolgreichem Training geschlossen wird, gilt die Session
// nach dieser Zeit trotzdem als geschafft.
const AUTO_FINISH_MS = 15 * 1000;

const DEFAULT_LOCATIONS = [
  { id: 'wdf', name: 'Walldorf Campus', city: 'Walldorf' },
  { id: 'ber', name: 'Berlin Mitte', city: 'Berlin' },
  { id: 'muc', name: 'München Ost', city: 'München' }
];

// rel: ign = ohne Zusammenhang, feat = Merkmal, leak = Data Leakage, target = Zielvariable
const COLS = [
  { key: 'id', label: 'Sensor-ID', desc: 'Kennung des Messgeräts', rel: 'ign' },
  { key: 'maschine', label: 'Maschine', desc: 'Bezeichnung in der Halle', rel: 'ign' },
  { key: 'farbe', label: 'Gehäusefarbe', desc: 'Lackierung der Maschine', rel: 'ign' },
  { key: 'techniker', label: 'Techniker:in', desc: 'Zuständig für die letzte Prüfung', rel: 'ign' },
  { key: 'temp', label: 'Temperatur', desc: 'Lagertemperatur in °C', range: '20 – 120 °C', rel: 'feat' },
  { key: 'vib', label: 'Vibration', desc: 'Schwinggeschwindigkeit in mm/s', range: '0 – 25 mm/s', rel: 'feat' },
  { key: 'rpm', label: 'Drehzahl', desc: 'Umdrehungen pro Minute', range: '500 – 3.000 U/min', rel: 'feat' },
  { key: 'std', label: 'Betriebsstunden', desc: 'Seit der letzten Wartung', range: '0 – 5.000 h', rel: 'feat' },
  { key: 'kosten', label: 'Reparaturkosten', desc: 'In € – nach dem Ausfall erfasst', range: '€', rel: 'leak' },
  { key: 'ausfall', label: 'Ausfall in 24 h', desc: 'Ist die Maschine ausgefallen? Ja / Nein', range: 'Ja / Nein', rel: 'target' }
];
const ROWS = [
  ['S-201', 'Presse 1', 'Grau', 'M. Weber', 64, 3.1, 1450, 820, 0, 'Nein'],
  ['S-202', 'Fräse 2', 'Blau', 'J. Koch', 98, 14.2, 2780, 4310, 4200, 'Ja'],
  ['S-203', 'Presse 3', 'Grau', 'A. Yilmaz', 71, 4.0, 1520, 1250, 0, 'Nein'],
  ['S-204', 'Drehbank 1', 'Grün', 'M. Weber', 9999, 5.2, 1600, 900, 0, 'Nein'],
  ['S-205', 'Fräse 1', 'Blau', 'L. Braun', 105, 18.7, 2900, 4780, 5100, 'Ja'],
  ['S-206', 'Presse 2', 'Grau', 'J. Koch', 58, -4.0, 1380, 300, 0, 'Nein'],
  ['S-207', 'Drehbank 2', 'Grün', 'A. Yilmaz', 88, 11.5, 2400, 3600, 3800, 'Ja'],
  ['S-208', 'Fräse 3', 'Blau', 'L. Braun', 67, 3.8, '', 1100, 0, 'Nein'],
  ['S-202', 'Fräse 2', 'Blau', 'J. Koch', 98, 14.2, 2780, 4310, 4200, 'Ja'],
  ['S-209', 'Presse 4', 'Grau', 'M. Weber', 62, 2.9, 1410, 640, 0, 'Nein'],
  ['S-210', 'Drehbank 3', 'Grün', 'J. Koch', 76, 6.1, 310000, 1900, 0, 'Nein'],
  ['S-211', 'Fräse 4', 'Blau', 'A. Yilmaz', 101, 16.3, 2850, 4550, 4700, 'Ja'],
  ['S-212', 'Presse 5', 'Grau', 'L. Braun', 69, 4.4, 1500, 72000, 0, 'Nein'],
  ['S-213', 'Drehbank 4', 'Grün', 'M. Weber', 55, 2.2, 1300, 420, 0, 'Nein'],
  ['S-214', 'Fräse 5', 'Blau', 'J. Koch', 94, 13.8, 2700, 4020, 3900, 'Ja']
];
const BAD = [3, 5, 7, 10, 12];
const DUP = [1, 8];

function freshSession() {
  return {
    sid: crypto.randomBytes(8).toString('hex'),
    token: null, team: '', status: 'idle', startedAt: null, elapsed: 0,
    duration: DEFAULT_DURATION, stage: 0, stageAt: [], hint: null, fails: 0, solvedAt: null
  };
}

function remaining(s, now) {
  if (!s) return 0;
  return Math.max(0, s.duration - s.elapsed - (s.status === 'running' ? now - s.startedAt : 0));
}

// Spieler dürfen nur agieren, solange die Zeit läuft.
function playable(s, now) {
  return s.status === 'running' && remaining(s, now) > 0;
}

function finish(s, now) {
  if (s.status === 'running') s.elapsed += now - s.startedAt;
  s.status = 'finished';
  s.stage = 3;
  s.stageAt[2] = now;
  s.stageAt[3] = now;
  s.token = null;
}

// Liefert true, wenn sich der Zustand geändert hat und gespeichert werden muss.
function autoFinish(db, now) {
  let changed = false;
  for (const s of Object.values(db.sessions)) {
    if (s.solvedAt && s.status !== 'finished' && now - s.solvedAt > AUTO_FINISH_MS) {
      finish(s, now);
      changed = true;
    }
  }
  return changed;
}

function cleanCheck(rm) {
  const dupRm = DUP.filter(i => rm[i]).length;
  const left = BAD.filter(i => !rm[i]).length + (dupRm === 0 ? 1 : 0);
  const wrong = Object.keys(rm).filter(k => rm[k] && !BAD.includes(+k) && !DUP.includes(+k)).length + (dupRm === 2 ? 1 : 0);
  return { left, wrong };
}

function diagnose(roles, removed) {
  const role = c => roles[c.key] || 'ign';
  const targets = COLS.filter(c => role(c) === 'target');
  const leak = COLS.some(c => c.rel === 'leak' && role(c) === 'feat');
  const extra = COLS.filter(c => role(c) === 'feat' && c.rel === 'ign').length;
  const missing = COLS.filter(c => c.rel === 'feat' && role(c) !== 'feat').length;
  const { left, wrong } = cleanCheck(removed);
  const out = [];
  if (targets.length === 0) out.push('Das Modell weiß nicht, was es vorhersagen soll – es fehlt eine Zielvariable.');
  else if (targets.length === 1 && targets[0].rel !== 'target') out.push('Das Modell sagt etwas vorher, das für die Frage „Fällt die Maschine aus?“ nicht hilft.');
  if (leak) out.push('Im Training fast 100 %, im Test unbrauchbar: Das Modell nutzt eine Information, die vor einem Ausfall noch gar nicht bekannt ist.');
  if (extra) out.push(extra === 1 ? 'Ein Merkmal ohne Zusammenhang zum Ausfall verwirrt das Modell.' : extra + ' Merkmale ohne Zusammenhang zum Ausfall verwirren das Modell.');
  if (missing) out.push(missing === 1 ? 'Dem Modell fehlt ein wichtiger Sensorwert.' : 'Dem Modell fehlen ' + missing + ' wichtige Sensorwerte.');
  if (left) out.push(left === 1 ? 'Eine unbrauchbare Messreihe verzerrt das Training.' : left + ' unbrauchbare Messreihen verzerren das Training.');
  if (wrong) out.push(wrong === 1 ? 'Eine korrekte Messreihe wurde gestrichen – dem Modell fehlen Beispiele.' : wrong + ' korrekte Messreihen wurden gestrichen – dem Modell fehlen Beispiele.');
  return out;
}

function train(rawRoles, rawRemoved) {
  const roles = {};
  const validRoles = ['ign', 'feat', 'target'];
  for (const c of COLS) {
    const r = rawRoles && rawRoles[c.key];
    if (validRoles.includes(r)) roles[c.key] = r;
  }
  const removed = {};
  for (let i = 0; i < ROWS.length; i++) if (rawRemoved && rawRemoved[i]) removed[i] = true;
  const issues = diagnose(roles, removed);
  const ok = !issues.length;
  const acc = ok ? 96 : Math.max(47, 84 - issues.length * 8 - (cleanCheck(removed).left ? 5 : 0));
  return { ok, acc, issues };
}

// Rätseldaten für das Terminal – ohne die Einordnung der Spalten.
const puzzle = {
  cols: COLS.map(({ rel, ...c }) => c),
  rows: ROWS
};

function slugId(city, locations) {
  const base = city.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '').slice(0, 3) || 'loc';
  let id = base, i = 2;
  while (locations.some(l => l.id === id)) id = base + i++;
  return id;
}

module.exports = {
  MAX_LOCATIONS, DEFAULT_DURATION, STEP, MIN_DURATION, DEFAULT_LOCATIONS,
  freshSession, remaining, playable, finish, autoFinish, train, puzzle, slugId
};
