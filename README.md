# Recruiting Escape Room

Escape Room für das SAP-Recruiting: Teams melden sich an einem Terminal an, lösen eine
Programmieraufgabe (Platzhalter) und trainieren eine KI zur Vorhersage von Maschinenausfällen.
Betreuer:innen steuern pro Standort den 30-Minuten-Timer, verfolgen den Fortschritt live und
senden Hinweise. Im Superadmin werden bis zu 8 Standorte verwaltet.

| Seite | Adresse | Zugang |
| --- | --- | --- |
| Spieler-Terminal | `/Spieler.dc.html` (bzw. `/`), Standort per `?loc=wdf` | öffentlich, Teampasswort im Spiel |
| Betreuer-Konsole | `/Betreuer.dc.html` (bzw. `/betreuer`) | Benutzer `betreuer` oder `admin` |
| Superadmin | `/Superadmin.dc.html` (bzw. `/admin`) | Benutzer `admin` |

## Lokal starten

Voraussetzung: Node.js ≥ 20. Der Server kommt ohne Abhängigkeiten aus – `npm install` ist lokal
nicht nötig.

```bash
npm run dev
```

Danach <http://localhost:3000> öffnen. `npm run dev` startet den Server bei Änderungen in
`server/` neu und lädt offene Browser-Tabs automatisch neu, sobald sich eine `.dc.html`,
`support.js` oder das Design-System ändert (Live-Reload). Anderer Port: `PORT=4000 npm run dev`.

Lokale Zugangsdaten: `admin` / `admin`, `betreuer` / `betreuer`, Teampasswort `onboarding`.
Der Spielstand liegt in `data/state.json` – zum Zurücksetzen einfach löschen.

Tests (starten einen eigenen Server auf einem Zufallsport):

```bash
npm test
```

## Deployment auf SAP BTP Cloud Foundry

```bash
cf login -a <api-endpoint>
cf push
cf set-env escape-room ADMIN_PASSWORD <passwort>
cf set-env escape-room BETREUER_PASSWORD <passwort>
cf restage escape-room
```

Ohne gesetzte Passwörter erzeugt der Server beim Start zufällige und schreibt sie ins Log
(`cf logs escape-room --recent`).

**Dauerhafte Speicherung:** Das Dateisystem einer CF-App ist flüchtig – ohne Datenbank gehen
angelegte Standorte und laufende Sessions bei Restart/Restage verloren (es werden dann wieder
die drei Standard-Standorte angelegt). Mit PostgreSQL bleibt alles erhalten:

```bash
cf create-service postgresql-db trial escape-room-db
```

Dann in `manifest.yml` den Block `services` einkommentieren und erneut `cf push`. Der Server
erkennt den gebundenen Service automatisch (alternativ: Umgebungsvariable `DATABASE_URL`).

Die App muss mit **einer Instanz** laufen, weil der Spielzustand im Speicher gehalten wird.

### Umgebungsvariablen

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `ADMIN_PASSWORD` | lokal `admin`, produktiv zufällig | Passwort für Benutzer `admin` |
| `BETREUER_PASSWORD` | lokal `betreuer`, produktiv zufällig | Passwort für Benutzer `betreuer` |
| `PLAYER_PASSWORD` | `onboarding` | Teampasswort am Terminal (Groß-/Kleinschreibung egal) |
| `SHOW_PROTO_NAV` | lokal `true`, produktiv `false` | Prototyp-Navigation unten rechts |
| `DATABASE_URL` | – | PostgreSQL-Verbindung, falls kein BTP-Service gebunden ist |
| `DATA_DIR` | `./data` | Ablage für `state.json` ohne Datenbank |
| `LIVE_RELOAD` | lokal an | `false` schaltet den Live-Reload ab |

## Aufbau

```
Spieler.dc.html, Betreuer.dc.html, Superadmin.dc.html   Screens aus Claude Design
support.js, _ds/                                        Design-Runtime und Design-System
server/index.js     HTTP-Server, Seiten, Zugriffsschutz, Live-Reload
server/api.js       REST-API
server/game.js      Spielregeln, Timer, Rätseldaten und Lösungsprüfung
server/store.js     Speicherung (Datei oder PostgreSQL)
server/http.js      schlanker Router auf node:http
```

Die Screens bleiben im Claude-Design-Format; statt `localStorage` sprechen sie per `fetch` mit
dem Server und fragen den Zustand jede Sekunde ab. Die Lösung des KI-Rätsels (welche Spalten
Merkmal/Ziel sind, welche Messreihen fehlerhaft sind) und das Teampasswort liegen nur auf dem
Server und sind im Quelltext des Terminals nicht sichtbar.

Werden die Screens erneut aus Claude Design synchronisiert, muss die Logik im
`<script data-dc-script>`-Block erhalten bleiben (API-Aufrufe statt `localStorage`), ebenso
`<script src="./config.js">` im Kopf der Seiten.

### API

| Methode & Pfad | Zugang | Zweck |
| --- | --- | --- |
| `GET /api/state` | öffentlich | Standorte, Sessions, Serverzeit |
| `GET /api/puzzle` | öffentlich | Spalten und Messreihen (ohne Lösung) |
| `POST /api/terminal/:loc/login` | öffentlich | `{ name, password }` → Spieler-Token |
| `POST /api/terminal/:loc/code` | Spieler-Token | Programmieraufgabe abschließen |
| `POST /api/terminal/:loc/train` | Spieler-Token | `{ roles, removed }` → `{ ok, acc, issues }` |
| `POST /api/terminal/:loc/finish` | Spieler-Token | Escape Room abschließen |
| `POST /api/sessions/:loc/start` · `pause` · `resume` · `reset` | Betreuer | Timer steuern |
| `POST /api/sessions/:loc/adjust` | Betreuer | `{ minutes: 5 \| -5 }` |
| `POST /api/sessions/:loc/hint` | Betreuer | `{ text }` an das Team senden |
| `POST /api/locations` · `DELETE /api/locations/:loc` | Admin | Standorte verwalten (max. 8) |
