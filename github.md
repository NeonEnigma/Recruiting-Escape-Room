repo: NeonEnigma/Recruiting-Escape-Room
branch: main

## Last sync
date: 2026-09-29T11:14:06Z

### Updated in this project
- Spieler-Flow (Login → Code-Platzhalter → Datenauswahl → Bereinigung → Training) neu gestaltet
- Betreuer-Konsole mit Timer-Steuerung (Start/Pause/Reset, ±5 Min) nach Vorbild der Timer-API
- Superadmin-Standortverwaltung (max. 8 Standorte)

## Screen map
| Screen | Repo files |
| --- | --- |
| Spieler.dc.html | frontend/index.html, frontend/location.html, frontend/scratch.html, frontend/paused.html, frontend/timeout.html |
| Betreuer.dc.html | frontend/spectator.html, backend/routes/timer.js |
| Superadmin.dc.html | frontend/admin.html, backend/db/locations.js |
