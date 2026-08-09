"""Giro completo di una città: campionamento dell'area + routing su strade reali.

L'idea è semplice, ma vale la pena scriverla perché definisce cosa questo
modulo **non** fa: non calcola un percorso che tocca letteralmente ogni singola
via della città (il "problema del postino cinese" in teoria dei grafi — un
tour che copre ogni arco di un grafo). Per una città come Roma quel problema è
enorme: il grafo stradale ha decine di migliaia di segmenti, il tour risultante
durerebbe giorni anche a velocità autostradale, e nessun motore di routing
pubblico lo calcolerebbe in tempo utile.

Quello che facciamo invece:

1. Geocodifichiamo il nome della città e prendiamo il suo riquadro geografico
   (``BoundingBox``, da Nominatim).
2. Campioniamo un certo numero di punti a griglia dentro quel riquadro —
   coprono l'intera area della città, non solo il centro.
3. Chiediamo al motore di routing (OSRM) un **giro di andata e ritorno** che
   tocchi tutti quei punti nell'ordine più efficiente, partendo e tornando
   nello stesso posto (`/trip`, che risolve un problema del commesso
   viaggiatore sul grafo stradale reale — diverso e molto più trattabile del
   postino cinese).
4. Infittiamo la geometria risultante: OSRM restituisce solo i punti che
   descrivono la forma della strada, che sulle rettilinee possono essere
   distanti centinaia di metri. Per un playback che sembri un movimento vero
   (non un teletrasporto a scatti) inseriamo punti intermedi ogni pochi metri.

Il risultato è un giro esteso che attraversa zone diverse di tutta la città
selezionata, su strade vere — non una promessa di copertura letterale di ogni
via.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Any

from .geocode import BoundingBox
from .models import Coordinate

logger = logging.getLogger(__name__)

#: Server pubblico di demo di OSRM. Nessuna chiave richiesta, ma è un servizio
#: condiviso e non pensato per un uso pesante: per un progetto serio o per
#: molte richieste ravvicinate, punta un'istanza propria con
#: ``GPSSIM_ROUTER_URL``.
DEFAULT_ENDPOINT = "https://router.project-osrm.org"

REQUEST_TIMEOUT = 30.0

#: Raggio medio della Terra, per l'haversine.
_EARTH_RADIUS_M = 6_371_000.0

#: Se il riquadro della città è più piccolo di questo, lo consideriamo
#: degenerate (un paese piccolissimo, o un punto isolato) e lo allarghiamo:
#: altrimenti il giro sarebbe un singolo punto.
_MIN_BBOX_SPAN_DEG = 0.01  # ~1,1 km in latitudine

#: Quanto allarghiamo un riquadro degenere.
_FALLBACK_HALF_SPAN_DEG = 0.015  # ~1,7 km per lato

#: Limite di punti da chiedere a OSRM. `/trip` risolve un problema del
#: commesso viaggiatore: il costo cresce rapidissimo con le tappe, e il server
#: pubblico di demo rifiuta (400) o rallenta parecchio ben prima che il costo
#: diventi proibitivo per un uso serio. Un tetto basso qui non è un limite
#: nostro — è il prezzo di usare un servizio condiviso e gratuito; un'istanza
#: propria (`GPSSIM_ROUTER_URL`) può reggerne molte di più.
MAX_WAYPOINTS = 15


class RouteError(Exception):
    """Il motore di routing non ha prodotto un giro utilizzabile.

    Non è un errore del dispositivo — non tocca l'iPhone né il tunnel — quindi
    ha una gerarchia separata, come `GeocodingError`.
    """

    def __init__(self, message: str, *, hint: str | None = None, detail: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint or "Riprova, oppure scegli una città diversa."
        #: Testo tecnico (es. il corpo della risposta HTTP): non nel messaggio
        #: principale, ma disponibile nel pannello «dettagli» della UI.
        self.detail = detail

    def to_dict(self) -> dict[str, Any]:
        return {"code": "route_failed", "message": self.message, "hint": self.hint, "detail": self.detail}


@dataclass(frozen=True)
class RoutePlan:
    """Un giro pronto per il playback: geometria densa + statistiche."""

    label: str
    points: list[Coordinate]
    distance_m: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "points": [point.to_dict() for point in self.points],
            "distance_m": self.distance_m,
        }


def _extract_error_detail(response: Any, limit: int = 300) -> str:
    """Il dettaglio tecnico da mettere in `RouteError.detail`: preferisce il
    campo `message` se OSRM ha risposto con JSON, altrimenti il testo grezzo
    (troncato — può essere una pagina HTML di un livello intermedio)."""
    try:
        payload = response.json()
    except ValueError:
        pass
    else:
        if isinstance(payload, dict) and payload.get("message"):
            return f"HTTP {response.status_code}: {payload['message']}"
    text = (response.text or "").strip()
    if len(text) > limit:
        text = text[:limit] + "…"
    return f"HTTP {response.status_code}: {text}" if text else f"HTTP {response.status_code}"


class Router:
    """Client OSRM: solo il metodo `/trip` che ci serve per il giro città."""

    def __init__(
        self,
        *,
        endpoint: str | None = None,
        client: Any = None,
    ) -> None:
        import os

        self.endpoint = (endpoint or os.environ.get("GPSSIM_ROUTER_URL") or DEFAULT_ENDPOINT).rstrip("/")
        self._client: Any = client
        self._owns_client = client is None

    async def close(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None

    async def trip(
        self, waypoints: list[Coordinate], *, profile: str = "driving"
    ) -> tuple[list[Coordinate], float]:
        """Giro di andata e ritorno che tocca tutte le tappe, nell'ordine più
        efficiente sul grafo stradale reale.

        :param waypoints: almeno 2 punti; il primo è partenza e arrivo.
        :returns: ``(geometria, distanza_in_metri)``.
        :raises RouteError: se il motore di routing non risponde o non trova un giro.
        """
        if len(waypoints) < 2:
            raise RouteError("Servono almeno due punti per costruire un giro.")

        import httpx

        if self._client is None:
            self._client = httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=True)

        # OSRM vuole "lon,lat" (invertito rispetto a come lo teniamo noi).
        coords = ";".join(f"{point.longitude:.6f},{point.latitude:.6f}" for point in waypoints)
        url = f"{self.endpoint}/trip/v1/{profile}/{coords}"
        params = {
            "roundtrip": "true",
            # `destination` accetta solo "any" o "last" — "first" non è un
            # valore valido e fa fallire il parser di OSRM con un secco 400
            # "Query string malformed", prima ancora di guardare le tappe.
            # Omesso: il default "any" ci va benissimo, non ci interessa quale
            # tappa risulti nominalmente ultima quando si torna comunque
            # all'origine.
            "source": "first",
            "overview": "full",
            "geometries": "geojson",
            "steps": "false",
        }

        try:
            response = await self._client.get(url, params=params)
        except httpx.TimeoutException as exc:
            raise RouteError(
                "Il motore di routing non ha risposto in tempo.",
                hint="La città potrebbe essere troppo estesa per il servizio pubblico di demo. Riprova, "
                "o scegli un'area più piccola.",
                detail=f"{type(exc).__name__}: {exc}",
            ) from exc
        except httpx.HTTPError as exc:
            raise RouteError(
                "Non riesco a contattare il motore di routing.",
                detail=f"{type(exc).__name__}: {exc}",
            ) from exc

        if response.status_code >= 400:
            # OSRM a volte spiega il rifiuto in un corpo JSON anche con uno
            # stato HTTP di errore; altre volte (limiti imposti a monte, non
            # da OSRM stesso) il corpo è testo semplice o una pagina. In
            # entrambi i casi vale la pena mostrarlo — e mostrare anche la
            # richiesta esatta che abbiamo mandato: è la sola diagnosi che
            # abbiamo per un servizio che non controlliamo, e senza la
            # richiesta un "Query string malformed" non dice dove guardare.
            detail = _extract_error_detail(response)
            raise RouteError(
                f"Il motore di routing ha risposto {response.status_code}.",
                hint="Il servizio pubblico di OSRM ha rifiutato la richiesta. Riprova, oppure prova "
                "un'area più piccola o meno tappe (campo «Tappe»).",
                detail=f"{detail}\nrichiesta: {response.request.url}",
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise RouteError("Risposta non valida dal motore di routing.") from exc

        code = payload.get("code")
        if code != "Ok":
            logger.warning("OSRM trip fallito: code=%s payload=%s", code, payload)
            raise RouteError(
                "Non è stato possibile costruire un giro che tocchi tutta l'area scelta.",
                hint="Succede se la città è troppo frammentata (isole, zone non connesse via strada). "
                "Prova un'altra città o un'area più piccola.",
                detail=f"code={code} message={payload.get('message')}",
            )

        trips = payload.get("trips") or []
        if not trips:
            raise RouteError("Il motore di routing non ha restituito nessun giro.")

        trip = trips[0]
        raw_coordinates = trip.get("geometry", {}).get("coordinates") or []
        if len(raw_coordinates) < 2:
            raise RouteError("Il giro restituito dal motore di routing è vuoto.")

        geometry = [Coordinate(lat, lon) for lon, lat in raw_coordinates]
        distance_m = float(trip.get("distance") or total_distance_m(geometry))
        return geometry, distance_m


# --------------------------------------------------------------------------- #
# Geometria: campionamento, infittimento, distanze
# --------------------------------------------------------------------------- #


def sample_grid_points(bbox: BoundingBox, count: int) -> list[Coordinate]:
    """Campiona ``count`` punti a griglia dentro il riquadro, per coprire
    l'intera area invece che solo il centro.

    Un riquadro troppo piccolo (paese minuscolo, punto isolato) viene allargato
    attorno al suo centro: altrimenti il giro sarebbe un singolo punto.
    """
    if (bbox.north - bbox.south) < _MIN_BBOX_SPAN_DEG or (bbox.east - bbox.west) < _MIN_BBOX_SPAN_DEG:
        bbox = BoundingBox.around(bbox.center, _FALLBACK_HALF_SPAN_DEG)
    south, north, west, east = bbox.south, bbox.north, bbox.west, bbox.east

    count = max(2, count)
    side = math.ceil(math.sqrt(count))
    # Un piccolo margine verso l'interno: i punti esatti sul bordo del
    # riquadro cadono spesso fuori città (campagna, mare), dove OSRM li
    # aggancia comunque alla strada più vicina ma allontanandosi dall'area.
    margin_lat = (north - south) * 0.08
    margin_lon = (east - west) * 0.08
    south, north = south + margin_lat, north - margin_lat
    west, east = west + margin_lon, east - margin_lon

    points: list[Coordinate] = []
    for row in range(side):
        for col in range(side):
            if len(points) >= count:
                break
            lat_fraction = row / (side - 1) if side > 1 else 0.5
            lon_fraction = col / (side - 1) if side > 1 else 0.5
            points.append(
                Coordinate(
                    south + lat_fraction * (north - south),
                    west + lon_fraction * (east - west),
                )
            )
    return points


def haversine_m(a: Coordinate, b: Coordinate) -> float:
    """Distanza in metri lungo la superficie terrestre tra due coordinate."""
    lat1, lat2 = math.radians(a.latitude), math.radians(b.latitude)
    delta_lat = math.radians(b.latitude - a.latitude)
    delta_lon = math.radians(b.longitude - a.longitude)
    sin_lat = math.sin(delta_lat / 2) ** 2
    sin_lon = math.sin(delta_lon / 2) ** 2
    h = sin_lat + math.cos(lat1) * math.cos(lat2) * sin_lon
    return 2 * _EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def total_distance_m(points: list[Coordinate]) -> float:
    return sum(haversine_m(a, b) for a, b in zip(points, points[1:], strict=False))


def suggest_waypoint_count(bbox: BoundingBox) -> int:
    """Quante tappe campionare in base all'estensione della città.

    Una stima grezza, non una scienza esatta: un paese piccolo non ha bisogno
    di tante tappe per essere "coperto" ragionevolmente, una metropoli come
    Roma sì — ma il tetto (`MAX_WAYPOINTS`) esiste perché il server pubblico
    di OSRM non è pensato per calcolare tour giganti.
    """
    area_deg2 = max(0.0, (bbox.north - bbox.south) * (bbox.east - bbox.west))
    count = 6 + round(area_deg2 * 4000)
    return max(6, min(count, MAX_WAYPOINTS))


async def plan_city_tour(
    router: Router,
    *,
    bbox: BoundingBox,
    origin: Coordinate,
    label: str,
    waypoint_count: int | None = None,
    profile: str = "driving",
    densify_step_m: float = 20.0,
) -> RoutePlan:
    """Pianifica il giro completo di una città: campiona l'area, chiede a OSRM
    il tour di andata e ritorno più efficiente, infittisce la geometria per un
    playback fluido.

    :param origin: punto di partenza e arrivo (in genere dove si trova già
        l'utente, o il centro della città).
    :param waypoint_count: quante tappe campionare; default in base all'area
        (`suggest_waypoint_count`).
    """
    target_count = waypoint_count if waypoint_count is not None else suggest_waypoint_count(bbox)
    target_count = max(2, min(target_count, MAX_WAYPOINTS))

    sampled = sample_grid_points(bbox, target_count - 1)
    waypoints = [origin, *sampled]

    geometry, distance_m = await router.trip(waypoints, profile=profile)
    dense = densify(geometry, densify_step_m)
    return RoutePlan(label=label, points=dense, distance_m=distance_m)


def densify(points: list[Coordinate], max_step_m: float) -> list[Coordinate]:
    """Inserisce punti intermedi dove due punti consecutivi sono più lontani di
    ``max_step_m``, così il playback avanza a passi regolari invece che a scatti
    sulle rettilinee (dove OSRM restituisce un punto ogni centinaia di metri).
    """
    if len(points) < 2:
        return list(points)

    dense: list[Coordinate] = [points[0]]
    for start, end in zip(points, points[1:], strict=False):
        distance = haversine_m(start, end)
        if distance <= max_step_m:
            dense.append(end)
            continue
        steps = math.ceil(distance / max_step_m)
        for step in range(1, steps + 1):
            fraction = step / steps
            dense.append(
                Coordinate(
                    start.latitude + fraction * (end.latitude - start.latitude),
                    start.longitude + fraction * (end.longitude - start.longitude),
                )
            )
    return dense
