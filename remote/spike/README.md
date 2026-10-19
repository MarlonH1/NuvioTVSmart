# Nuvio Remote – Machbarkeits-Spike (webOS)

Eigenständige Mini-App (`space.nuvio.remotespike`) mit JS-Service. Unabhängig von
Nuvio selbst, damit der Test nichts an der echten App kaputt macht.

Beantwortet auf dem echten TV:

1. Darf ein Dev-Mode-Service einen TCP-Port im LAN öffnen (HTTP + WebSocket, Port 47800–47804)?
2. Funktioniert mDNS (`_nuvio-remote._tcp`) auf UDP 5353? Fallback: UDP-Broadcast-Beacon auf :47810.
3. Funktionieren die Luna-Audio-Calls (Lautstärke +/–, Mute)?
4. Bleibt der Service am Leben, solange die App eine Subscription hält, und auch im Hintergrund?

## Bauen

```bash
cd NuvioTVSmart
npm install                    # einmalig, bringt @webos-tools/cli mit
node remote/spike/package.mjs  # → remote/spike/dist/space.nuvio.remotespike_0.0.1_all.ipk
```

## Auf den TV bringen

Das Gerät muss bei ares bekannt sein (`ares-setup-device`, Dev-Mode-App auf dem TV, Key-Server an).

```bash
npx ares-install -d <tv> remote/spike/dist/space.nuvio.remotespike_0.0.1_all.ipk
npx ares-launch  -d <tv> space.nuvio.remotespike
```

Service-Logs live mitlesen (optional):

```bash
npx ares-inspect -d <tv> -s space.nuvio.remotespike.service   # öffnet Node-Inspector
```

## Testschritte

Am TV zeigt die App den Status: Port, mDNS-Modus, Beacon, verbundene Clients, Luna-Ergebnisse, Log.

Vom PC im selben WLAN (Node 22+):

```bash
node remote/spike/tools/probe.mjs                  # Discovery (mDNS + Beacon), dann HTTP + WS-Ping
node remote/spike/tools/probe.mjs <tv-ip>          # ohne Discovery
node remote/spike/tools/probe.mjs <tv-ip> --volume up   # Luna-Audio testen (auch: down|get|mute|unmute)
avahi-browse -rpt _nuvio-remote._tcp               # mDNS gegenprüfen
```

Oder im Handy-Browser: `http://<tv-ip>:47800/`, dort sollte ein JSON-Status erscheinen.

Bitte schick mir danach:

- Die Probe-Ausgabe (alle drei Befehle).
- Was die App am TV unter **mDNS-Modus** anzeigt (`shared-5353` oder `announce-only`) und ob ein `listenError` steht.
- Ob die Lautstärke am TV sich wirklich ändert, und welche Luna-URI funktioniert hat.
- **Hintergrund-Test:** App starten → Home-Taste → nach 1, 5 und 15 min `probe.mjs <tv-ip>` laufen lassen. Antwortet der Service noch?
- Gleiches nach dem kompletten Schließen der App (Taste lange halten / App-Switcher).
- webOS-Version des TVs (Einstellungen → Allgemein → Über dieses TV-Gerät).

## Lokal getestet (PC, ohne Luna-Bus)

- mDNS-Ankündigung und Auflösung ✓, UDP-Beacon ✓, HTTP ✓, WebSocket hello/ping ✓ (RTT ~1 ms).
- Luna-Calls schlagen erwartungsgemäß mit `standalone (no luna bus)` fehl. Das geht nur am TV.
- Service-Code nutzt nur Node-8-kompatible Syntax und keine npm-Abhängigkeiten (eigene WS- und mDNS-Implementierung).

## Falls der Port im Dev-Mode blockiert ist

Alternativen, in dieser Reihenfolge:

1. **Bestehender Plugin-HTTP-Service von Nuvio:** `custom-poster-config.cjs` öffnet schon heute einen LAN-HTTP-Server auf 8092+. Funktioniert der, liegt es an Port oder Service-ID und nicht an der Sandbox.
2. **TV verbindet sich ausgehend** zu einem kleinen Relay (PC/NAS/Raspberry im LAN oder der spätere Go-Relay). Das Handy spricht dann mit dem Relay.
3. **Supabase Realtime** (wie Watch Party), also cloud-relayed. Das funktioniert immer, ist aber nicht LAN-only.
