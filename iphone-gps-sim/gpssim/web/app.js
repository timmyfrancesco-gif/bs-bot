/*
 * Frontend del simulatore. Due concetti distinti, tenuti separati di proposito:
 *
 *   selezione  — dove l'utente sta scegliendo di andare (segnaposto trascinabile)
 *   attiva     — dove l'iPhone sta effettivamente dicendo di essere (pallino)
 *
 * Confonderli sarebbe il bug più grave possibile in un'app come questa: se il
 * tunnel cade, la selezione resta dov'è ma la posizione attiva non esiste più, e
 * l'interfaccia deve mostrare la differenza.
 *
 * Lo stato non viene mai inferito dalle azioni: arriva sempre dal server, via
 * risposta HTTP o via SSE. Una caduta del tunnel non è provocata da un click,
 * quindi solo il push può raccontarla.
 */
'use strict';

const STATE_LABEL = {
  idle: 'inattivo',
  preparing: 'preparazione',
  ready: 'pronto',
  simulating: 'simulazione attiva',
  lost: 'collegamento perso',
  error: 'errore',
};

const START_VIEW = { center: [41.9028, 12.4964], zoom: 5 };
const PLACE_ZOOM = 15;

const el = {};
const state = {
  status: null,
  selection: null,       // {latitude, longitude}
  selectionLabel: null,
  devices: [],
  searchToken: 0,
  tourOrigin: null,      // luogo scelto dall'elenco: {label, latitude, longitude, bbox}
  tourPlan: null,        // {label, points, distance_m, speed_kmh} — dall'ultimo /api/routes/plan
};

let map;
let selectionMarker;
let activeMarker;
let tourPolyline;
let keepaliveTimer;

// ---------------------------------------------------------------- utilità rete

/** Chiama l'API e trasforma `{error: {...}}` in un'eccezione con messaggio utile. */
async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = payload && payload.error ? payload.error : {};
    throw {
      code: error.code || 'http_' + response.status,
      message: error.message || `Errore ${response.status} dal server locale.`,
      hint: error.hint || '',
      detail: error.detail || '',
      status: payload && payload.status ? payload.status : null,
    };
  }
  return payload;
}

function showError(error) {
  el.alertMessage.textContent = error.message || 'Errore inatteso.';
  el.alertHint.textContent = error.hint || '';
  el.alertDetail.textContent = error.detail || '';
  el.alertDetail.hidden = !error.detail;
  el.alert.hidden = false;
}

function clearError() {
  el.alert.hidden = true;
}

// ------------------------------------------------------------------- selezione

function setSelection(coordinate, label) {
  state.selection = coordinate;
  state.selectionLabel = label || null;

  el.latInput.value = coordinate ? coordinate.latitude.toFixed(6) : '';
  el.lonInput.value = coordinate ? coordinate.longitude.toFixed(6) : '';
  el.selectionLabel.textContent = label || '';

  if (!coordinate) {
    if (selectionMarker) {
      map.removeLayer(selectionMarker);
      selectionMarker = null;
    }
  } else {
    const position = [coordinate.latitude, coordinate.longitude];
    if (selectionMarker) {
      selectionMarker.setLatLng(position);
    } else {
      selectionMarker = L.marker(position, { draggable: true, autoPan: true })
        .addTo(map)
        .on('dragend', () => {
          const { lat, lng } = selectionMarker.getLatLng();
          setSelection({ latitude: lat, longitude: lng });
          describeSelection();
        });
    }
  }
  refreshControls();
}

/** Chiede a Nominatim il nome del punto scelto. Puramente informativo: se
 *  fallisce, la selezione resta valida e l'utente può applicarla comunque. */
async function describeSelection() {
  const coordinate = state.selection;
  if (!coordinate) return;
  const token = ++state.searchToken;
  try {
    const payload = await api(
      `/api/geocode/reverse?latitude=${coordinate.latitude}&longitude=${coordinate.longitude}`
    );
    if (token !== state.searchToken) return;   // selezione già cambiata
    if (payload.result) {
      state.selectionLabel = payload.result.label;
      el.selectionLabel.textContent = payload.result.label;
    }
  } catch {
    // silenzio voluto: è un'etichetta, non un requisito
  }
}

function readInputs() {
  const latitude = Number.parseFloat(el.latInput.value);
  const longitude = Number.parseFloat(el.lonInput.value);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

// ---------------------------------------------------------------------- ricerca

/** Cerca su Nominatim e mostra i risultati in `listEl`; `onSelect` decide cosa
 *  fare del luogo scelto — usata sia dalla ricerca indirizzi sia dal giro città,
 *  che vogliono lo stesso comportamento ma reagiscono in modo diverso al click. */
async function searchPlaces(query, listEl, onSelect) {
  if (!query) {
    listEl.hidden = true;
    return;
  }
  listEl.hidden = false;
  listEl.innerHTML = '<li class="results__empty">Cerco…</li>';
  try {
    const payload = await api(`/api/geocode/search?q=${encodeURIComponent(query)}`);
    renderPlaceResults(listEl, payload.results || [], onSelect);
  } catch (error) {
    listEl.innerHTML = '<li class="results__empty">Ricerca non disponibile.</li>';
    showError(error);
  }
}

function renderPlaceResults(listEl, results, onSelect) {
  listEl.innerHTML = '';
  if (results.length === 0) {
    listEl.innerHTML = '<li class="results__empty">Nessun risultato.</li>';
    return;
  }
  for (const place of results) {
    const item = document.createElement('li');
    const [head, ...rest] = place.label.split(', ');
    item.textContent = head;
    if (rest.length) {
      const small = document.createElement('small');
      small.textContent = rest.join(', ');
      item.appendChild(small);
    }
    item.addEventListener('click', () => onSelect(place));
    listEl.appendChild(item);
  }
}

function runSearch() {
  return searchPlaces(el.searchInput.value.trim(), el.searchResults, (place) => {
    setSelection({ latitude: place.latitude, longitude: place.longitude }, place.label);
    map.setView([place.latitude, place.longitude], PLACE_ZOOM);
    el.searchResults.hidden = true;
  });
}

// ------------------------------------------------------------------ dispositivi

async function loadDevices() {
  try {
    const payload = await api('/api/devices');
    state.devices = payload.devices || [];
  } catch (error) {
    state.devices = [];
    showError(error);
  }
  renderDevices();
}

function renderDevices() {
  const previous = el.deviceSelect.value;
  el.deviceSelect.innerHTML = '';

  if (state.devices.length === 0) {
    el.deviceSelect.innerHTML = '<option value="">Nessun iPhone collegato</option>';
    el.deviceDetail.textContent = 'Collega un iPhone con un cavo dati e sbloccalo.';
    refreshControls();
    return;
  }

  for (const device of state.devices) {
    const option = document.createElement('option');
    option.value = device.udid;
    option.textContent = `${device.name} — iOS ${device.ios_version}`;
    el.deviceSelect.appendChild(option);
  }
  if (state.devices.some((device) => device.udid === previous)) {
    el.deviceSelect.value = previous;
  }
  renderDeviceDetail();
  refreshControls();
}

function renderDeviceDetail() {
  const device = state.devices.find((candidate) => candidate.udid === el.deviceSelect.value);
  if (!device) {
    el.deviceDetail.textContent = '';
    return;
  }
  const notes = [];
  if (device.developer_mode === false) notes.push('modalità sviluppatore disattivata');
  if (device.needs_tunnel) notes.push('richiede il tunnel RSD (amministratore)');
  if (device.connection_type !== 'USB') notes.push('non collegato via USB');
  el.deviceDetail.textContent = notes.length ? notes.join(' · ') : `UDID ${device.udid}`;
}

// ----------------------------------------------------------------------- azioni

/** Disabilita il pulsante durante l'operazione: le azioni sul dispositivo non
 *  sono istantanee e un doppio click aprirebbe due tunnel. */
async function withBusy(button, action) {
  const wasDisabled = button.disabled;
  button.disabled = true;
  try {
    clearError();
    await action();
  } catch (error) {
    showError(error);
    if (error.status) applyStatus(error.status);
  } finally {
    button.disabled = wasDisabled;
    refreshControls();
  }
}

function connect() {
  return withBusy(el.connect, async () => {
    const udid = el.deviceSelect.value || null;
    applyStatus(await api('/api/session/connect', {
      method: 'POST',
      body: JSON.stringify({ udid }),
    }));
  });
}

function disconnect() {
  return withBusy(el.disconnect, async () => {
    applyStatus(await api('/api/session/disconnect', { method: 'POST' }));
  });
}

function applyLocation() {
  return withBusy(el.apply, async () => {
    const coordinate = readInputs() || state.selection;
    if (!coordinate) throw { message: 'Scegli prima un punto sulla mappa.', hint: '' };
    setSelection(coordinate, state.selectionLabel);
    applyStatus(await api('/api/location', {
      method: 'POST',
      body: JSON.stringify(coordinate),
    }));
  });
}

function restoreReal() {
  return withBusy(el.restore, async () => {
    applyStatus(await api('/api/location/restore', { method: 'POST' }));
  });
}

// ---------------------------------------------------------------------- giro città

function runTourSearch() {
  return searchPlaces(el.tourCity.value.trim(), el.tourResults, (place) => {
    state.tourOrigin = place;
    el.tourCity.value = place.label;
    el.tourResults.hidden = true;
    refreshControls();
  });
}

/** Chiede il giro completo del luogo scelto (routing reale), lo disegna sulla
 *  mappa, ma non lo avvia: quello è un passo separato. Il luogo deve venire
 *  dall'elenco di ricerca — un nome libero potrebbe corrispondere a più posti,
 *  e qui non c'è modo di far scegliere quale dopo il fatto. */
function planTour() {
  return withBusy(el.tourPlanButton, async () => {
    if (!state.tourOrigin) throw { message: 'Cerca una città e scegli un risultato dall\'elenco.', hint: '' };

    const waypoints = el.tourWaypoints.value ? Number.parseInt(el.tourWaypoints.value, 10) : null;
    const body = {
      label: state.tourOrigin.label,
      latitude: state.tourOrigin.latitude,
      longitude: state.tourOrigin.longitude,
      bbox: state.tourOrigin.bbox,
      speed_kmh: Number.parseFloat(el.tourSpeed.value) || 50,
      waypoints,
    };
    el.tourStats.textContent = 'Genero il giro… può richiedere qualche secondo.';
    const plan = await api('/api/routes/plan', { method: 'POST', body: JSON.stringify(body) });

    state.tourPlan = plan;
    drawTourPolyline(plan.points);
    const km = (plan.distance_m / 1000).toFixed(1);
    const minutes = Math.round((plan.distance_m / 1000 / plan.speed_kmh) * 60);
    el.tourStats.textContent = `${plan.label} — ${km} km, circa ${minutes} min a ${plan.speed_kmh} km/h.`;
    refreshControls();
  });
}

function playTour() {
  return withBusy(el.tourPlay, async () => {
    if (!state.tourPlan) throw { message: 'Genera prima il giro.', hint: '' };
    applyStatus(await api('/api/routes/play', {
      method: 'POST',
      body: JSON.stringify({
        points: state.tourPlan.points,
        speed_kmh: state.tourPlan.speed_kmh,
        label: state.tourPlan.label,
      }),
    }));
  });
}

function stopTour() {
  return withBusy(el.tourStop, async () => {
    applyStatus(await api('/api/routes/stop', { method: 'POST' }));
  });
}

function drawTourPolyline(points) {
  if (tourPolyline) {
    map.removeLayer(tourPolyline);
    tourPolyline = null;
  }
  if (!points || points.length === 0) return;
  const latlngs = points.map((point) => [point.latitude, point.longitude]);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0a68d8';
  tourPolyline = L.polyline(latlngs, { color: accent, weight: 3, opacity: 0.65 }).addTo(map);
  map.fitBounds(tourPolyline.getBounds(), { padding: [24, 24] });
}

// ------------------------------------------------------------------------ stato

function applyStatus(status) {
  if (!status) return;
  state.status = status;

  el.statusbar.dataset.state = status.state;
  el.statePill.textContent = STATE_LABEL[status.state] || status.state;
  el.statusMessage.textContent = status.message || '';

  renderLocationBadge(status);
  renderActiveMarker(status);
  renderStatusItems(status);

  // Un errore di sessione (tunnel caduto, cavo staccato) arriva via push e non
  // come risposta a un'azione: va mostrato con la stessa evidenza.
  if (status.error && (status.state === 'lost' || status.state === 'error')) {
    showError(status.error);
  } else if (status.state === 'simulating' || status.state === 'ready') {
    clearError();
  }

  if (status.device && !el.deviceSelect.value) {
    el.deviceSelect.value = status.device.udid;
  }
  refreshControls();
}

function renderLocationBadge(status) {
  const badge = el.locationBadge;
  badge.classList.remove('badge--simulated', 'badge--real', 'badge--lost');

  if (status.state === 'lost') {
    badge.textContent = 'posizione reale (simulazione caduta)';
    badge.classList.add('badge--lost');
  } else if (!status.real_location && status.target) {
    const { latitude, longitude } = status.target;
    badge.textContent = `simulata ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    badge.classList.add('badge--simulated');
  } else {
    badge.textContent = 'posizione reale';
    badge.classList.add('badge--real');
  }
}

function renderActiveMarker(status) {
  // In stato `lost` la posizione attiva non esiste più, ma il segnaposto resta —
  // colorato di rosso. Farlo sparire nasconderebbe l'informazione utile: era lì
  // che stavamo simulando, ed è quello che l'utente credeva fosse ancora vero.
  const active = Boolean(status.target) && (!status.real_location || status.state === 'lost');
  if (!active) {
    if (activeMarker) {
      map.removeLayer(activeMarker);
      activeMarker = null;
    }
    return;
  }
  const position = [status.target.latitude, status.target.longitude];
  const className = 'marker-active' + (status.state === 'lost' ? ' marker-active--lost' : '');
  const icon = L.divIcon({ className: '', html: `<div class="${className}"></div>`, iconSize: [18, 18] });
  if (activeMarker) {
    activeMarker.setLatLng(position).setIcon(icon);
  } else {
    activeMarker = L.marker(position, { icon, interactive: false, zIndexOffset: -100 }).addTo(map);
  }
}

function renderStatusItems(status) {
  if (status.tunnel) {
    el.tunnelInfo.hidden = false;
    el.tunnelInfo.textContent = `tunnel [${status.tunnel.address}]:${status.tunnel.port}`;
  } else {
    el.tunnelInfo.hidden = true;
  }

  if (status.backend) {
    el.backendInfo.hidden = false;
    el.backendInfo.textContent = `backend ${status.backend}`;
  } else {
    el.backendInfo.hidden = true;
  }

  el.keepalive.hidden = status.state !== 'simulating' && status.state !== 'lost';
  renderKeepalive();

  if (status.route) {
    el.routeInfo.hidden = false;
    const km = (status.route.remaining_m / 1000).toFixed(1);
    const eta = Math.max(0, Math.round(status.route.eta_seconds / 60));
    el.routeInfo.textContent = status.route.playing
      ? `${status.route.label}: ${status.route.index + 1}/${status.route.points} · ${km} km rimanenti · ~${eta} min`
      : `${status.route.label}: fermato`;
  } else {
    el.routeInfo.hidden = true;
  }
}

/** L'età dell'ultimo invio va aggiornata anche quando non arrivano eventi:
 *  un keep-alive fermo è esattamente il sintomo che l'utente deve vedere. */
function renderKeepalive() {
  const status = state.status;
  if (!status || el.keepalive.hidden) return;

  const dot = el.keepalive.querySelector('.dot');
  dot.classList.remove('dot--stale', 'dot--dead');

  if (!status.last_push_at) {
    el.keepaliveText.textContent = 'keep-alive in attesa';
    dot.classList.add('dot--stale');
    return;
  }

  const age = Date.now() / 1000 - status.last_push_at;
  const limit = (status.keepalive_interval || 1.5) * 3;
  if (status.state === 'lost') {
    dot.classList.add('dot--dead');
    el.keepaliveText.textContent = `keep-alive fermo da ${age.toFixed(0)}s`;
  } else if (age > limit || !status.last_push_ok) {
    dot.classList.add('dot--stale');
    el.keepaliveText.textContent = `ultimo invio ${age.toFixed(1)}s fa (${status.consecutive_push_failures} errori)`;
  } else {
    el.keepaliveText.textContent = `keep-alive ogni ${status.keepalive_interval}s`;
  }
}

function refreshControls() {
  const status = state.status;
  const stateName = status ? status.state : 'idle';
  const connected = ['ready', 'simulating', 'lost'].includes(stateName);
  const busy = stateName === 'preparing';

  el.connect.hidden = connected;
  el.disconnect.hidden = !connected;
  el.connect.disabled = busy || state.devices.length === 0;
  el.disconnect.disabled = busy;
  el.deviceSelect.disabled = connected || busy;
  el.refreshDevices.disabled = connected || busy;

  el.apply.disabled = !connected || busy || (!state.selection && !readInputs());
  el.restore.disabled = !connected || busy || !(status && status.target);

  const route = status && status.route;
  const routePlaying = Boolean(route && route.playing);
  el.tourPlay.hidden = routePlaying;
  el.tourStop.hidden = !routePlaying;
  el.tourPlanButton.disabled = !connected || busy || routePlaying || !state.tourOrigin;
  el.tourPlay.disabled = !connected || busy || !state.tourPlan || routePlaying;
  el.tourStop.disabled = busy;
}

// -------------------------------------------------------------------- eventi SSE

function subscribe() {
  const stream = new EventSource('/api/events');
  stream.addEventListener('message', (event) => {
    try {
      applyStatus(JSON.parse(event.data));
    } catch (error) {
      console.error('evento di stato illeggibile', error);
    }
  });
  stream.addEventListener('error', () => {
    // EventSource riprova da sé; se il server è davvero morto lo si vede dalla
    // barra di stato, che resta all'ultimo valore noto.
    el.statusMessage.textContent = 'Connessione al server locale interrotta, riprovo…';
  });
}

// --------------------------------------------------------------------------- avvio

function cacheElements() {
  const ids = {
    deviceSelect: 'device-select', refreshDevices: 'refresh-devices', connect: 'connect',
    disconnect: 'disconnect', deviceDetail: 'device-detail', searchInput: 'search-input',
    searchButton: 'search-button', searchResults: 'search-results', latInput: 'lat-input',
    lonInput: 'lon-input', selectionLabel: 'selection-label', apply: 'apply', restore: 'restore',
    alert: 'alert', alertMessage: 'alert-message', alertHint: 'alert-hint',
    alertDetail: 'alert-detail', alertClose: 'alert-close', statusbar: 'statusbar',
    statePill: 'state-pill', locationBadge: 'location-badge', statusMessage: 'status-message',
    keepalive: 'keepalive', keepaliveText: 'keepalive-text', tunnelInfo: 'tunnel-info',
    backendInfo: 'backend-info', routeInfo: 'route-info', tourCity: 'tour-city',
    tourSearchButton: 'tour-search-button', tourResults: 'tour-results',
    tourSpeed: 'tour-speed', tourWaypoints: 'tour-waypoints', tourPlanButton: 'tour-plan',
    tourStats: 'tour-stats', tourPlay: 'tour-play', tourStop: 'tour-stop',
    appVersion: 'app-version',
  };
  for (const [key, id] of Object.entries(ids)) {
    el[key] = document.getElementById(id);
  }
}

function initMap() {
  // Zoom a destra: a sinistra finirebbe sotto il pannello.
  map = L.map('map', { zoomControl: false, attributionControl: true })
    .setView(START_VIEW.center, START_VIEW.zoom);
  L.control.zoom({ position: 'topright' }).addTo(map);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  map.on('click', (event) => {
    setSelection({ latitude: event.latlng.lat, longitude: event.latlng.lng });
    describeSelection();
  });
}

function bindEvents() {
  el.refreshDevices.addEventListener('click', loadDevices);
  el.deviceSelect.addEventListener('change', renderDeviceDetail);
  el.connect.addEventListener('click', connect);
  el.disconnect.addEventListener('click', disconnect);
  el.apply.addEventListener('click', applyLocation);
  el.restore.addEventListener('click', restoreReal);
  el.alertClose.addEventListener('click', clearError);

  el.tourPlanButton.addEventListener('click', planTour);
  el.tourPlay.addEventListener('click', playTour);
  el.tourStop.addEventListener('click', stopTour);
  el.tourSearchButton.addEventListener('click', runTourSearch);
  el.tourCity.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runTourSearch();
    } else if (event.key === 'Escape') {
      el.tourResults.hidden = true;
    }
  });
  // Modificare il testo dopo una scelta invalida quella scelta: altrimenti
  // "Genera il giro" resterebbe attivo puntando a un luogo che non è più
  // quello scritto nel campo.
  el.tourCity.addEventListener('input', () => {
    state.tourOrigin = null;
    el.tourResults.hidden = true;
    refreshControls();
  });

  el.searchButton.addEventListener('click', runSearch);
  el.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runSearch();
    } else if (event.key === 'Escape') {
      el.searchResults.hidden = true;
    }
  });

  for (const input of [el.latInput, el.lonInput]) {
    input.addEventListener('change', () => {
      const coordinate = readInputs();
      if (coordinate) {
        setSelection(coordinate);
        map.setView([coordinate.latitude, coordinate.longitude], Math.max(map.getZoom(), PLACE_ZOOM));
        describeSelection();
      } else {
        refreshControls();
      }
    });
  }
}

/** Mostrata in alto a destra: utile a occhio per confermare che il browser
 *  stia caricando la versione dell'app appena aggiornata e non una cache. */
async function loadVersion() {
  try {
    const payload = await api('/api/health');
    el.appVersion.textContent = `v${payload.version}`;
  } catch {
    el.appVersion.textContent = '';
  }
}

async function main() {
  cacheElements();
  initMap();
  bindEvents();
  refreshControls();
  loadVersion();

  keepaliveTimer = setInterval(renderKeepalive, 500);
  window.addEventListener('beforeunload', () => clearInterval(keepaliveTimer));

  try {
    applyStatus(await api('/api/status'));
  } catch (error) {
    showError(error);
  }
  await loadDevices();
  subscribe();
}

document.addEventListener('DOMContentLoaded', main);
