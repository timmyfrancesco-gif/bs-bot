# iphone-gps-sim

Simula la posizione GPS di un iPhone collegato via USB, usando la modalità
sviluppatore di iOS. Alternativa open source a GhostMe.

> **Stato: fase 2 completata.** Core, API locale e interfaccia con mappa. Restano
> bookmark/cronologia/GPX (fase 3) e il build con PyInstaller (fase 4).

> **Non è ancora stato provato su un iPhone vero.** È stato sviluppato in un
> ambiente senza USB, quindi tutto ciò che non tocca il dispositivo è verificato
> (91 test, l'interfaccia pilotata in un browser reale, le firme di
> `pymobiledevice3` 10.4.0 controllate una per una, la riga di comando del tunnel
> eseguita davvero contro il CLI); l'ultimo tratto — mount della DDI, tunnel
> aperto, coordinate accettate dall'iPhone — no. Se qualcosa non va, parti da
> `gpssim -vv doctor`: è scritto per dirti dove si rompe.

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
stato `LOST` con `real_location=True` e l'errore allegato. L'interfaccia lo mostra
in tre punti contemporaneamente — pastiglia di stato rossa, badge che dichiara
«posizione reale (simulazione caduta)», banner con il motivo — e il segnaposto
sulla mappa diventa rosso invece di scomparire: era lì che stavi simulando, ed è
quello che credevi fosse ancora vero.

## Requisiti

- Python 3.10+
- macOS, Linux o Windows con i driver Apple installati
- root/amministratore per il tunnel RSD (solo su iOS 17+)
- iPhone sbloccato, autorizzato, con la modalità sviluppatore attiva
- rete solo per i tile della mappa e la ricerca indirizzi: il resto è locale

Le versioni sono pinnate di proposito (`pymobiledevice3` cambia in modo
incompatibile tra le major — la 10.x è interamente async).

## Preparazione dell'iPhone

1. Collegalo con un **cavo dati** (non uno da sola ricarica) e **sbloccalo**.
2. Alla richiesta «Autorizzare questo computer?» tocca **Autorizza** e inserisci
   il codice.
3. Attiva **Impostazioni → Privacy e sicurezza → Modalità sviluppatore**, poi
   **riavvia** l'iPhone e sbloccalo di nuovo.
   La voce non c'è ancora? È normale: compare solo dopo che uno strumento da
   sviluppatore ha provato a connettersi. Esegui una volta `gpssim doctor`
   (sotto), poi ricontrolla le Impostazioni.

Sul computer serve anche il supporto USB per iPhone: su macOS c'è già; su Windows
installa **Apple Devices** (o iTunes); su Linux servono `usbmuxd` e
`libimobiledevice` (`sudo apt install usbmuxd libimobiledevice6`).

## Installazione

```bash
cd iphone-gps-sim
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

> **Attenzione a `sudo` e virtualenv.** `sudo` reimposta il `PATH`, quindi
> `sudo python -m gpssim` userebbe il Python di sistema, dove le dipendenze non
> ci sono. Usa sempre il percorso completo dell'interprete del venv:
> `sudo .venv/bin/python -m gpssim …`.

## Uso

### Prima prova: la diagnostica

Parti sempre da qui. `doctor` percorre tutta la catena e si ferma al primo
prerequisito mancante, dicendoti cosa fare:

```bash
sudo .venv/bin/python -m gpssim doctor
```

Su un iPhone pronto stampa versione, stato della modalità sviluppatore, DDI
montata, indirizzo e porta del tunnel RSD e il backend scelto. Se qualcosa manca,
il messaggio dice esattamente cosa (iPhone bloccato, modalità sviluppatore
disattivata, permessi insufficienti, cavo staccato…).

### Interfaccia

```bash
# Finestra nativa
sudo .venv/bin/python -m gpssim app

# Oppure il server, e la mappa nel browser (consigliato su macOS: evita di far
# girare una finestra grafica come root)
sudo .venv/bin/python -m gpssim serve
# poi apri http://127.0.0.1:8765
```

Nella finestra: scegli l'iPhone e premi **Connetti** — è il passo lento, monta la
DDI e apre il tunnel, e la prima volta scarica la Developer Disk Image (serve
internet). Poi cerca un indirizzo o clicca sulla mappa e premi **Applica
posizione all'iPhone**. **Ripristina posizione reale** annulla l'override
lasciando la sessione aperta; chiudendo l'app la posizione reale viene comunque
ripristinata.

La barra di stato in basso dice sempre tre cose: in che stato è la sessione, cosa
sta *effettivamente* mostrando l'iPhone, e se il keep-alive sta ancora girando.

### Riga di comando

```bash
.venv/bin/python -m gpssim devices                       # quali iPhone vedo
sudo .venv/bin/python -m gpssim tunnel                   # solo il tunnel: indirizzo e porta RSD
sudo .venv/bin/python -m gpssim set 45.4642 9.1900       # simula e mantieni (Ctrl-C per uscire)
sudo .venv/bin/python -m gpssim set 45.4642 9.1900 --hold 30
sudo .venv/bin/python -m gpssim clear                    # ripristina la posizione reale
```

Opzioni utili: `--udid` per scegliere il dispositivo, `-v`/`-vv` per i log,
`--backend dvt|simulatelocation` per forzare un backend, `--no-recover` per
disattivare la riconnessione automatica, `--no-sudo` per fallire subito invece di
tentare l'elevazione.

### Perché `sudo`

Solo il tunnel RSD di iOS 17+ ne ha bisogno: crea un'interfaccia di rete. Se il
processo non è già root, il tunnel viene avviato con `sudo -n`, cioè senza mai
aprire un prompt che nella finestra dell'app non vedresti; se la password serve,
l'errore lo dice invece di restare appeso. Le due vie che funzionano:

- lanciare tutto con `sudo` (come sopra), oppure
- fare prima `sudo -v` per sbloccare la password, poi lanciare l'app da utente
  normale — vale finché non scade il timeout di `sudo` (~5 minuti).

Su **Windows** `sudo` non esiste: apri il terminale con «Esegui come
amministratore». Su iOS 16 e precedenti il tunnel non serve e `sudo` nemmeno.

## Architettura

| Modulo | Responsabilità |
| --- | --- |
| `gpssim/errors.py` | Tassonomia degli errori: codici stabili + messaggi e suggerimenti in italiano |
| `gpssim/models.py` | `Coordinate`, `DeviceInfo`, `TunnelInfo`, `SessionState`, `Status` |
| `gpssim/tunnel.py` | Tunnel RSD: avvio, cattura di indirizzo/porta, watchdog sulla morte del processo |
| `gpssim/device.py` | Rilevamento, lockdown, developer mode, mount DDI, RSD → `DeviceConnection` |
| `gpssim/location.py` | Backend di posizione + `LocationSession` (keep-alive, stato, recupero) |
| `gpssim/geocode.py` | Nominatim con rate limit, cache e User-Agent identificativo |
| `gpssim/api.py` | API FastAPI locale + stream SSE dello stato |
| `gpssim/server.py` | Avvio di uvicorn, in primo piano o in un thread di servizio |
| `gpssim/desktop.py` | Wrapper `pywebview` |
| `gpssim/web/` | Frontend (Leaflet 1.9.4 vendorizzato, nessuna CDN) |
| `gpssim/cli.py` | Riga di comando |

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

### API

Tutto su `127.0.0.1` — non è un servizio di rete, è il ponte tra la UI e il core.
Ogni endpoint restituisce l'istantanea completa dello stato, così il frontend non
deve mai ricomporlo da risposte diverse.

| Endpoint | |
| --- | --- |
| `GET /api/status` | stato corrente |
| `GET /api/devices` | iPhone collegati |
| `POST /api/session/connect` | prepara il dispositivo (DDI, tunnel, backend) |
| `POST /api/session/disconnect` | chiude tutto, ripristinando la posizione reale |
| `POST /api/location` | imposta la posizione e avvia il keep-alive |
| `POST /api/location/restore` | ripristina la posizione reale |
| `GET /api/events` | stream SSE dello stato |
| `GET /api/geocode/search?q=` | ricerca indirizzi |
| `GET /api/geocode/reverse?latitude=&longitude=` | nome del luogo alle coordinate |

Il codice HTTP distingue i casi prima che serva leggere il corpo: `403` permessi
insufficienti, `404` nessun dispositivo, `503` usbmuxd assente, `409` dispositivo
non in uno stato utilizzabile (bloccato, dev mode off, DDI non montata, tunnel
caduto), `502` ricerca indirizzi non disponibile. Il corpo porta sempre
`error.code`, `error.message`, `error.hint`.

Lo stato arriva anche in **push** su `/api/events`, e non è un dettaglio: la
caduta del tunnel non è provocata da un click, quindi non può essere comunicata
come risposta a una richiesta.

### Ricerca indirizzi

Le chiamate a Nominatim passano dal nostro processo, non dal browser: serve uno
User-Agent identificativo (la loro usage policy rifiuta quelli generici) e serve
rispettare il limite di **una richiesta al secondo**, cosa che una coda
serializzata fa e la digitazione dell'utente no. C'è anche una cache, che tra
l'altro rende gratuito il reverse geocoding mentre si trascina il segnaposto.
Con `GPSSIM_NOMINATIM_URL` si punta a un'istanza propria.

### Errori gestiti

`no_device`, `cable_disconnected`, `not_paired`, `trust_pending`, `trust_denied`,
`device_locked`, `developer_mode_off`, `ddi_not_mounted`, `ddi_unavailable`,
`insufficient_privileges`, `tunnel_failed`, `tunnel_lost`,
`tunnel_unsupported_platform`, `location_unsupported`, `location_push_failed`,
`usbmuxd_unavailable`.

Il tunnel gira in un sottoprocesso, quindi i suoi guasti arrivano come testo su
stderr: `RsdTunnel._diagnose_startup_failure` lo traduce nello stesso insieme di
codici, così la UI non deve distinguere l'origine dell'errore.

## Uso come libreria

```python
from gpssim import Coordinate, LocationSession

session = LocationSession()
session.add_listener(lambda status: print(status.to_dict()))

await session.connect()                                # DDI + tunnel + backend
await session.set_location(Coordinate(45.4642, 9.19))  # avvia il keep-alive
await session.restore_real_location()
await session.disconnect()
```

## Test

```bash
python -m unittest discover -s tests -t .
```

90 test, nessun iPhone necessario. Il tunnel è esercitato con sottoprocessi finti
(cattura dell'output, morte del processo, privilegi mancanti, timeout), la
sessione con un backend finto (keep-alive, degrado, passaggio a `LOST`,
riconnessione), l'API con una sessione finta, e Nominatim con un transport finto
(rate limit, cache, 429, timeout, risposte malformate).

Lo stream SSE è testato in due punti: la logica del generatore, dove tutto sta in
un solo event loop, e il percorso reale con uvicorn in un thread — `TestClient`
non serve, perché l'ASGITransport di httpx accumula il corpo fino all'ultimo
chunk e questo stream non finisce mai.

### Interfaccia

```bash
pip install playwright && playwright install chromium
python tools/ui_check.py --screenshots /tmp/gpssim-shots
```

Non è nella suite (Chromium è una dipendenza pesante per un progetto il cui cuore
è altrove), ma il frontend non è verificabile a occhio e questo script ha già
trovato due difetti che nessun test Python avrebbe visto: un segnaposto che
spariva invece di diventare rosso alla caduta del tunnel, e un `display: flex`
che vinceva sull'attributo `hidden`, tenendo il banner d'errore sempre a schermo.

## Roadmap

- **Fase 1 ✅** — device manager, location service, CLI di test
- **Fase 2 ✅** — API FastAPI, mappa Leaflet, ricerca Nominatim, barra di stato,
  pulsante «ripristina posizione reale», wrapper `pywebview`
- **Fase 3** — bookmark, cronologia (SQLite), percorsi GPX
- **Fase 4** — build con PyInstaller

## Avvertenza

Strumento per sviluppo e test su dispositivi propri. Falsificare la posizione può
violare i termini di servizio delle app che la usano.
