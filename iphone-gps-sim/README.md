# iphone-gps-sim

Simula la posizione GPS di un iPhone collegato via USB, usando la modalità
sviluppatore di iOS. Alternativa open source a GhostMe.

> **Stato: fase 1 completata.** C'è il core (device manager, location service,
> tunnel RSD) e una CLI di test. Nessuna interfaccia grafica: arriva nella fase 2.

## Come funziona

iOS espone un servizio da sviluppatore che sovrascrive la posizione riportata da
CoreLocation. Arrivarci richiede una catena di prerequisiti, e questo progetto
non fa altro che percorrerla in modo affidabile e dirti esattamente dove si
rompe:

1. **usbmuxd** elenca gli iPhone collegati.
2. **lockdown** apre la connessione (e fa comparire la richiesta di fiducia).
3. **Modalità sviluppatore** attiva (iOS 16+).
4. **Developer Disk Image montata** (`mounter auto-mount`) — richiede **l'iPhone
   sbloccato**.
5. **Tunnel RSD** su iOS 17+ — richiede **root/amministratore**.
6. **Override della posizione**, mantenuto da un keep-alive a **1,5 s**.

### Le tre insidie che definiscono il progetto

**iOS 17+ richiede il tunnel RSD.** I servizi da sviluppatore non passano più da
lockdownd: vivono dentro un tunnel di rete, e crearlo significa creare
un'interfaccia di rete. Il tunnel viene aperto da un processo separato
(`pymobiledevice3 lockdown start-tunnel --script-mode`), di cui catturiamo
indirizzo e porta RSD dall'output; quelli vengono poi riusati per ogni comando
successivo, senza riaprire nulla.

**Da iOS 18 la posizione si resetta scollegando l'USB.** L'override decade appena
il canale col dispositivo si chiude, quindi le coordinate vengono rimandate ogni
1,5 secondi. Il keep-alive è anche il nostro rilevatore di guasti: è il primo a
sapere che il canale non risponde più.

**Se il tunnel cade la posizione torna reale, e non va nascosto.** Quando il
processo del tunnel muore o gli invii iniziano a fallire, la sessione passa in
stato `LOST` con `real_location=True` e l'errore allegato. Nessun fallimento
silenzioso: se `LOST` non venisse mostrato, l'utente crederebbe di essere a
Milano mentre l'iPhone dice la verità.

## Requisiti

- Python 3.10+
- `pymobiledevice3` **10.4.0** (versione pinnata: l'API cambia in modo
  incompatibile tra le major — la 10.x è interamente async)
- macOS, Linux o Windows con i driver Apple installati
- root/amministratore per il tunnel RSD (solo su iOS 17+)
- iPhone sbloccato, autorizzato, con la modalità sviluppatore attiva

## Installazione

```bash
cd iphone-gps-sim
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

## Uso (CLI di test)

```bash
# Quali iPhone vedo?
python -m gpssim devices

# Diagnostica completa: privilegi, usbmuxd, dev mode, DDI, tunnel, backend
python -m gpssim doctor

# Solo il tunnel, per debug: stampa indirizzo e porta RSD e resta aperto
sudo python -m gpssim tunnel

# Simula una posizione (Duomo di Milano) e mantienila
sudo python -m gpssim set 45.4642 9.1900

# ...per 30 secondi, poi ripristina automaticamente
sudo python -m gpssim set 45.4642 9.1900 --hold 30

# Ripristina la posizione reale
sudo python -m gpssim clear
```

Opzioni utili: `--udid` per scegliere il dispositivo, `-v` / `-vv` per i log,
`--backend dvt|simulatelocation` per forzare un backend, `--no-recover` per
disattivare la riconnessione automatica, `--no-sudo` per fallire subito invece di
tentare l'elevazione.

Su macOS e Linux, se il processo non è già root, il tunnel viene avviato con
`sudo -n` (mai un prompt invisibile): se serve la password, l'errore lo dice.

## Architettura

| Modulo | Responsabilità |
| --- | --- |
| `gpssim/errors.py` | Tassonomia degli errori: codici stabili + messaggi e suggerimenti in italiano |
| `gpssim/models.py` | `Coordinate`, `DeviceInfo`, `TunnelInfo`, `SessionState`, `Status` |
| `gpssim/tunnel.py` | Tunnel RSD: avvio, cattura di indirizzo/porta, watchdog sulla morte del processo |
| `gpssim/device.py` | Rilevamento, lockdown, developer mode, mount DDI, RSD → `DeviceConnection` |
| `gpssim/location.py` | Backend di posizione + `LocationSession` (keep-alive, stato, recupero) |
| `gpssim/cli.py` | CLI di test |

### I due backend di posizione

`dvt` (preferito)
: canale DTX `com.apple.instruments.server.services.LocationSimulation`, aperto
  una volta e riutilizzato. Il keep-alive riscrive le coordinate sullo stesso
  canale, quindi costa pochissimo.

`simulatelocation` (riserva)
: servizio `com.apple.dt.simulatelocation`, una connessione per comando.
  L'implementazione è nostra e non quella di `pymobiledevice3` perché quella non
  chiude la connessione: a un invio ogni 1,5 s si esaurirebbero i descrittori di
  file.

### Errori gestiti

Ogni caso previsto ha un codice e un messaggio dedicati: `no_device`,
`cable_disconnected`, `not_paired`, `trust_pending`, `trust_denied`,
`device_locked`, `developer_mode_off`, `ddi_not_mounted`, `ddi_unavailable`,
`insufficient_privileges`, `tunnel_failed`, `tunnel_lost`,
`tunnel_unsupported_platform`, `location_unsupported`, `location_push_failed`,
`usbmuxd_unavailable`.

Il tunnel gira in un sottoprocesso, quindi i suoi guasti arrivano come testo su
stderr: `RsdTunnel._diagnose_startup_failure` lo traduce nello stesso insieme di
codici, così la UI non deve distinguere l'origine dell'errore.

## Stato dell'API interna

```python
from gpssim import Coordinate, LocationSession

session = LocationSession()
session.add_listener(lambda status: print(status.to_dict()))

await session.connect()                            # prepara: DDI + tunnel + backend
await session.set_location(Coordinate(45.4642, 9.19))  # avvia il keep-alive
await session.restore_real_location()              # il pulsante della fase 2
await session.disconnect()
```

`status.to_dict()` è già il payload che la barra di stato della fase 2 consumerà:
stato, dispositivo, tunnel, target, backend, esito dell'ultimo invio, e
`real_location` per dire senza ambiguità cosa sta mostrando l'iPhone.

## Test

```bash
python -m unittest discover -s tests -t .
```

34 test, nessun iPhone necessario: il tunnel è esercitato con sottoprocessi finti
(cattura dell'output, morte del processo, privilegi mancanti, timeout) e la
sessione con un backend finto (keep-alive, degrado, passaggio a `LOST`,
riconnessione).

## Roadmap

- **Fase 1 ✅** — device manager, location service, CLI di test
- **Fase 2** — API FastAPI, mappa Leaflet, ricerca indirizzi Nominatim, barra di
  stato, pulsante «ripristina posizione reale», wrapper `pywebview`
- **Fase 3** — bookmark, cronologia (SQLite), percorsi GPX
- **Fase 4** — build con PyInstaller

## Avvertenza

Strumento per sviluppo e test su dispositivi propri. Falsificare la posizione può
violare i termini di servizio delle app che la usano.
