# Nuvio Remote – Daemon für gerootete webOS-TVs

Kleiner Node-Dienst, der als root beim Booten startet (Homebrew Channel). Er ist dauerhaft im
LAN erreichbar, auch wenn Nuvio geschlossen ist, und startet Nuvio bei Bedarf selbst.

```
Handy ──ws://<tv>:47800/ws──▶ Daemon (root) ◀──ws://127.0.0.1:47800/app── Nuvio-App (Player)
                               │
                               └─ luna-send: Lautstärke, App starten, Code-Anzeige
```

- **Handy-Protokoll:** v1, siehe `NuvioMobile/docs/remote-protocol.md`.
- **Daemon (immer da):** Kopplung und Tokens, Lautstärke, Nuvio starten.
- **Nuvio-App:** Wiedergabe. Der Daemon leitet `play`/`cmd` an sie weiter und verteilt ihren
  `state` an alle gekoppelten Handys.
- **`play` bei geschlossenem Nuvio:** Der Daemon startet die App und hält die Anfrage, bis sie
  sich verbindet (max. 45 s).
- **Kopplungscode:** Läuft Nuvio, zeigt es den Code selbst an. Sonst erscheint er als
  webOS-System-Hinweis über der aktuellen App.
- **Discovery:** mDNS `_nuvio-remote._tcp` plus UDP-Beacon auf :47810, wie im Spike getestet.
- **Daten:** `/var/lib/nuvio-remote/state.json` (TV-ID, Tokens). Log: `/tmp/nuvio-remote.log`.

## Brücke Daemon ↔ Nuvio-App

Gleicher flacher JSON-Umschlag wie das Handy-Protokoll, nur von `127.0.0.1` aus erlaubt.

| Richtung     | type                      | Felder                                                      |
| ------------ | ------------------------- | ----------------------------------------------------------- |
| App → Daemon | `app.hello`               | `version`                                                   |
| App → Daemon | `state`                   | `playback` (PlaybackState aus dem Protokoll)                |
| Daemon → App | `play`                    | `request` (PlayRequest)                                     |
| Daemon → App | `cmd`                     | `action`, `positionMs?`, `deltaMs?`, `trackId?`, `delayMs?` |
| Daemon → App | `pair.show` / `pair.hide` | `code`, `clientName`                                        |
| Daemon → App | `state.get`               | –                                                           |

## Installieren

Voraussetzung: TV gerootet, Homebrew Channel installiert, dort **SSH Server** an. Dann vom PC:

```bash
remote/daemon/install/deploy.sh <tv-ip>
```

Das kopiert den Dienst nach `/var/lib/nuvio-remote/daemon`, legt das Init-Skript
`/var/lib/webosbrew/init.d/nuvio-remote` an und startet ihn. Ab dem nächsten Booten startet er
von selbst und wird nach einem Absturz neu gestartet.

Auf dem TV (per SSH):

```bash
/var/lib/webosbrew/init.d/nuvio-remote status    # läuft er? + letzte Logzeilen
/var/lib/webosbrew/init.d/nuvio-remote restart
tail -f /tmp/nuvio-remote.log
```

Vom PC: `node remote/spike/tools/probe.mjs <tv-ip>` oder im Browser `http://<tv-ip>:47800/`.

## Entfernen

```bash
ssh root@<tv-ip> '/var/lib/webosbrew/init.d/nuvio-remote stop; rm -rf /var/lib/webosbrew/init.d/nuvio-remote /var/lib/nuvio-remote'
```

## Entwickeln

```bash
cd remote/daemon
npm test                                   # Node 22+, testet Handy + App + TV-Adapter über echte WebSockets
node main.js --no-luna --state /tmp/nr.json # lokal ohne TV
```

Der Code nutzt bewusst keine npm-Abhängigkeiten und läuft ab Node 8 (ältere webOS-Versionen).
