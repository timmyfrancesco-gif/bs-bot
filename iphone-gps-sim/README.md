# iphone-gps-sim

Simula la posizione GPS di un iPhone collegato via USB, usando la modalità
sviluppatore di iOS. Alternativa open source a GhostMe.

> **Stato: fase 2 completata.** Core, API locale e interfaccia con mappa. Restano
> bookmark/cronologia/GPX (fase 3) e il build con PyInstaller (fase 4).

> **Non è ancora stato provato su un iPhone vero.** È stato sviluppato in un
> ambiente senza USB, quindi tutto ciò che non tocca il dispositivo è verificato
> (140 test, l'interfaccia pilotata in un browser reale, le firme di
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

### Giro città: gira per tutta l'area di una città, non solo un punto

Oltre a impostare una singola posizione, l'app pianifica un **giro di andata e
ritorno che copre l'intera area di una città** — scrivi "Cesena", "Cervia",
"Roma", qualunque città — su strade vere, a una velocità che scegli tu, e il
telefono si sposta lungo il tracciato in tempo reale.

Non è però una copertura letterale di *ogni singola via*: quello è un problema
diverso (in teoria dei grafi si chiama "del postino cinese" — un tour che
attraversa ogni arco di un grafo), enorme su una città grande. Il grafo
stradale di Roma ha decine di migliaia di segmenti; un tour che li tocchi tutti
durerebbe giorni anche a velocità autostradale, e nessun motore di routing
pubblico lo calcolerebbe in tempo utile. Quello che l'app fa invece:

1. Geocodifica la città e prende il suo riquadro geografico.
2. Campiona punti a griglia dentro quel riquadro — più punti quanto più la
   città è estesa — per coprire l'intera area, non solo il centro.
3. Chiede al motore di routing (OSRM) il giro di andata e ritorno più
   efficiente che tocchi tutti quei punti su strade reali, partendo e tornando
   allo stesso posto.
4. Infittisce la geometria risultante a un punto ogni ~20 m, così il
   dispositivo si sposta con passi regolari invece che a scatti sulle
   rettilinee.

La velocità che scegli è quella di **crociera**, non un valore fisso per
tutto il giro: `gpssim/speed.py` genera un profilo che rallenta e riprende
gradualmente lungo il percorso (mai sotto il 45% del target, mai sopra),
come nel traffico vero — invece di muoversi a un ritmo costante e
riconoscibile dall'inizio alla fine.

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

Nel pannello **Giro città**: scrivi il nome di una città e premi l'icona di
ricerca (o Invio) — compare un elenco di corrispondenze, come nella ricerca
indirizzi, per scegliere quella giusta quando il nome è ambiguo. Scelto il
risultato, imposta la velocità (km/h) e premi **Genera il giro** — traccia il
percorso sulla mappa e mostra distanza e tempo stimato, senza ancora muovere
nulla. Premi **Avvia il giro** per farlo partire davvero; **Ferma il giro** lo
interrompe dov'è (per tornare alla posizione reale c'è sempre «Ripristina
posizione reale»). Il campo «Tappe» è opzionale: lasciandolo vuoto l'app
sceglie da sola in base all'estensione della città.

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
| `gpssim/routing.py` | Giro città: campionamento dell'area + routing OSRM + infittimento della geometria |
| `gpssim/speed.py` | Profilo di velocità realistico (variazione attorno al target) per il playback del giro |
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
| `POST /api/routes/plan` | pianifica il giro di un luogo già geocodificato (`{label, latitude, longitude, bbox, speed_kmh, profile, waypoints}`), non lo avvia |
| `POST /api/routes/play` | avvia il playback di un giro (`{points, speed_kmh, label}`) |
| `POST /api/routes/stop` | ferma il giro dov'è |

Il codice HTTP distingue i casi prima che serva leggere il corpo: `403` permessi
insufficienti, `404` nessun dispositivo o città non trovata, `503` usbmuxd
assente, `409` dispositivo non in uno stato utilizzabile (bloccato, dev mode
off, DDI non montata, tunnel caduto), `502` ricerca indirizzi o routing non
disponibili. Il corpo porta sempre `error.code`, `error.message`, `error.hint`.

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

### Motore di routing

Il giro città usa il server pubblico di demo di **OSRM**
(`router.project-osrm.org`), gratuito e senza chiave, ma condiviso e non
pensato per un uso pesante — non ha il rate limit esplicito di Nominatim, ma
non va bombardato di richieste. Per un uso serio, o per città enormi che il
demo rifiuta, punta un'istanza propria con `GPSSIM_ROUTER_URL`.

Il tetto di 15 tappe per giro (`gpssim.routing.MAX_WAYPOINTS`) esiste perché
`/trip` risolve un problema del commesso viaggiatore, il cui costo cresce
rapidissimo con le tappe; su un'istanza propria si può alzare parecchio. Se
compare comunque un «Il motore di routing ha risposto 400», il messaggio
d'errore porta nel dettaglio sia il corpo della risposta di OSRM sia la
richiesta esatta che gli abbiamo mandato — la diagnosi migliore possibile per
un servizio che non controlliamo.

Nota per chi tocca `gpssim/routing.py`: il parametro `destination` dell'API
`/trip` accetta solo `"any"` o `"last"`. Un valore diverso (es. `"first"`) non
dà un errore applicativo pulito — fa fallire il parser di OSRM con un secco
`HTTP 400 Query string malformed`, prima ancora che la richiesta venga
esaminata. Per questo qui `destination` non viene impostato affatto: il
default `"any"` va bene, non ci interessa quale tappa risulti nominalmente
ultima quando comunque si torna all'origine.

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

# Il giro città è due passi separati: pianificare (geocodifica + routing,
# senza toccare il dispositivo) e avviare (che invece lo tocca).
from gpssim.geocode import BoundingBox, Geocoder
from gpssim.routing import Router, plan_city_tour

geocoder, router = Geocoder(), Router()
place = (await geocoder.search("Cesena", limit=1))[0]
bbox = place.bbox or BoundingBox.around(place.coordinate, 0.02)  # non tutti i risultati hanno un riquadro
plan = await plan_city_tour(router, bbox=bbox, origin=place.coordinate, label=f"Giro di {place.label}")
await session.play_route(plan.points, speed_kmh=50, label=plan.label)
await session.stop_route()  # oppure lascialo finire da solo

await session.restore_real_location()
await session.disconnect()
```

## Test

```bash
python -m unittest discover -s tests -t .
```

140 test, nessun iPhone necessario. Il tunnel è esercitato con sottoprocessi
finti (cattura dell'output, morte del processo, privilegi mancanti, timeout), la
sessione con un backend finto (keep-alive, degrado, passaggio a `LOST`,
riconnessione, playback di un giro), l'API con una sessione finta, Nominatim con
un transport finto (rate limit, cache, 429, timeout, risposte malformate), e
OSRM con un transport finto (costruzione dell'URL, infittimento della
geometria, tetto sulle tappe, guasti del motore di routing).

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
Copre anche il giro città: pianificazione, tracciato disegnato sulla mappa,
avvio, avanzamento in barra di stato, stop.

## Roadmap

- **Fase 1 ✅** — device manager, location service, CLI di test
- **Fase 2 ✅** — API FastAPI, mappa Leaflet, ricerca Nominatim, barra di stato,
  pulsante «ripristina posizione reale», wrapper `pywebview`
- **Giro città ✅** — giro di andata e ritorno esteso su tutta l'area di una
  città a scelta, su strade reali (OSRM), a velocità configurabile
- **Fase 3** — bookmark, cronologia (SQLite), percorsi GPX importati da file
- **Fase 4** — build con PyInstaller

## Avvertenza

Strumento per sviluppo e test su dispositivi propri. Falsificare la posizione può
violare i termini di servizio delle app che la usano.
