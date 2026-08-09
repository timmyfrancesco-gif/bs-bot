"""Ricerca indirizzi tramite Nominatim (OpenStreetMap).

Le chiamate passano dal nostro processo e non dal browser, per tre motivi:

1. la usage policy di Nominatim richiede uno User-Agent identificativo, e da
   dentro una pagina web non lo si può impostare;
2. impone **massimo una richiesta al secondo**: qui c'è una coda serializzata che
   lo rispetta, invece di sperare che l'utente digiti piano;
3. una cache evita di ripetere la stessa query mentre si scrive.

Chi preferisce un'istanza propria può cambiare endpoint con la variabile
d'ambiente ``GPSSIM_NOMINATIM_URL``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from .models import Coordinate

logger = logging.getLogger(__name__)

DEFAULT_ENDPOINT = "https://nominatim.openstreetmap.org"

#: La usage policy di Nominatim consente al massimo 1 richiesta al secondo.
MIN_REQUEST_INTERVAL = 1.1

#: Timeout: meglio dire "servizio lento" che tenere la UI appesa.
REQUEST_TIMEOUT = 10.0

CACHE_SIZE = 128


@dataclass(frozen=True)
class BoundingBox:
    """Riquadro geografico di un luogo (in genere una città), da Nominatim."""

    south: float
    north: float
    west: float
    east: float

    @property
    def center(self) -> Coordinate:
        return Coordinate((self.south + self.north) / 2, (self.west + self.east) / 2)

    @classmethod
    def around(cls, coordinate: Coordinate, half_span_deg: float) -> BoundingBox:
        """Un riquadro sintetico centrato su un punto: serve quando Nominatim
        non fornisce un riquadro (o ne fornisce uno troppo piccolo per un giro)."""
        return cls(
            south=coordinate.latitude - half_span_deg,
            north=coordinate.latitude + half_span_deg,
            west=coordinate.longitude - half_span_deg,
            east=coordinate.longitude + half_span_deg,
        )

    def to_dict(self) -> dict[str, float]:
        return {"south": self.south, "north": self.north, "west": self.west, "east": self.east}


@dataclass(frozen=True)
class Place:
    label: str
    coordinate: Coordinate
    #: Categoria OSM (``city``, ``restaurant``, …): utile come sottotitolo.
    kind: str | None = None
    #: Presente solo per luoghi "areali" (città, quartieri): Nominatim lo
    #: restituisce per ogni risultato, non solo per quelli espliciti come `city`.
    bbox: BoundingBox | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "latitude": self.coordinate.latitude,
            "longitude": self.coordinate.longitude,
            "kind": self.kind,
            "bbox": self.bbox.to_dict() if self.bbox else None,
        }


class GeocodingError(Exception):
    """Nominatim non ha risposto. Non è un errore del dispositivo: la sessione
    con l'iPhone non ne è toccata, quindi ha una gerarchia separata."""

    def __init__(self, message: str, *, hint: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint or "Controlla la connessione a internet e riprova."

    def to_dict(self) -> dict[str, Any]:
        return {"code": "geocoding_failed", "message": self.message, "hint": self.hint}


class Geocoder:
    """Client Nominatim con rate limit e cache."""

    def __init__(
        self,
        *,
        endpoint: str | None = None,
        user_agent: str | None = None,
        min_interval: float = MIN_REQUEST_INTERVAL,
        client: Any = None,
    ) -> None:
        from . import __version__

        self.endpoint = (endpoint or os.environ.get("GPSSIM_NOMINATIM_URL") or DEFAULT_ENDPOINT).rstrip("/")
        # Nominatim rifiuta gli User-Agent generici: identifichiamoci.
        self.user_agent = user_agent or f"iphone-gps-sim/{__version__} (+https://github.com/)"
        self.min_interval = min_interval

        # Un client già configurato (proxy, transport di test) può essere passato
        # dall'esterno; in quel caso non è nostro e non lo chiudiamo noi.
        self._client: Any = client
        self._owns_client = client is None
        self._lock = asyncio.Lock()
        self._last_request = 0.0
        self._cache: OrderedDict[tuple[str, ...], list[Place]] = OrderedDict()

    async def close(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None

    # ------------------------------------------------------------------ #

    async def search(self, query: str, *, limit: int = 6) -> list[Place]:
        """Cerca un indirizzo o un luogo."""
        query = query.strip()
        if not query:
            return []
        return await self._request(
            ("search", query.casefold(), str(limit)),
            "/search",
            {"q": query, "format": "jsonv2", "limit": str(limit), "addressdetails": "0"},
        )

    async def reverse(self, coordinate: Coordinate) -> Place | None:
        """Trova il nome del luogo a queste coordinate (per l'etichetta del marker)."""
        # 5 decimali ≈ 1 m: arrotondare rende la cache utile mentre si trascina
        # il marker, senza cambiare il risultato in modo percepibile.
        key = ("reverse", f"{coordinate.latitude:.5f}", f"{coordinate.longitude:.5f}")
        places = await self._request(
            key,
            "/reverse",
            {
                "lat": f"{coordinate.latitude:.6f}",
                "lon": f"{coordinate.longitude:.6f}",
                "format": "jsonv2",
                "zoom": "18",
            },
        )
        return places[0] if places else None

    # ------------------------------------------------------------------ #

    async def _request(self, cache_key: tuple[str, ...], path: str, params: dict[str, str]) -> list[Place]:
        if (cached := self._cache.get(cache_key)) is not None:
            self._cache.move_to_end(cache_key)
            return cached

        payload = await self._fetch(path, params)
        places = _parse(payload)

        self._cache[cache_key] = places
        while len(self._cache) > CACHE_SIZE:
            self._cache.popitem(last=False)
        return places

    async def _fetch(self, path: str, params: dict[str, str]) -> Any:
        import httpx

        if self._client is None:
            self._client = httpx.AsyncClient(
                headers={"User-Agent": self.user_agent, "Accept-Language": "it,en"},
                timeout=REQUEST_TIMEOUT,
                follow_redirects=True,
            )

        # Una richiesta alla volta, distanziate: è il rate limit di Nominatim.
        async with self._lock:
            wait = self.min_interval - (time.monotonic() - self._last_request)
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                response = await self._client.get(f"{self.endpoint}{path}", params=params)
            except httpx.TimeoutException as exc:
                raise GeocodingError(
                    "Il servizio di ricerca indirizzi non ha risposto in tempo.",
                    hint="Riprova tra qualche secondo, oppure inserisci le coordinate a mano.",
                ) from exc
            except httpx.HTTPError as exc:
                raise GeocodingError(
                    "Non riesco a contattare il servizio di ricerca indirizzi.",
                ) from exc
            finally:
                self._last_request = time.monotonic()

        if response.status_code == 429:
            raise GeocodingError(
                "Troppe richieste al servizio di ricerca indirizzi.",
                hint="Attendi un minuto: Nominatim consente una sola richiesta al secondo.",
            )
        if response.status_code >= 400:
            raise GeocodingError(
                f"Il servizio di ricerca indirizzi ha risposto {response.status_code}.",
            )

        try:
            return response.json()
        except ValueError as exc:
            raise GeocodingError("Risposta non valida dal servizio di ricerca indirizzi.") from exc


def _parse(payload: Any) -> list[Place]:
    """Normalizza la risposta di Nominatim (lista per /search, oggetto per /reverse)."""
    entries = payload if isinstance(payload, list) else [payload]
    places: list[Place] = []
    for entry in entries:
        if not isinstance(entry, dict) or "lat" not in entry or "lon" not in entry:
            continue
        try:
            coordinate = Coordinate(float(entry["lat"]), float(entry["lon"]))
        except (TypeError, ValueError):
            logger.debug("scarto un risultato con coordinate non valide: %r", entry)
            continue
        label = entry.get("display_name") or entry.get("name") or "senza nome"
        places.append(
            Place(
                label=label,
                coordinate=coordinate,
                kind=entry.get("type"),
                bbox=_parse_bbox(entry.get("boundingbox")),
            )
        )
    return places


def _parse_bbox(raw: Any) -> BoundingBox | None:
    """Nominatim restituisce `["south", "north", "west", "east"]` come stringhe."""
    if not isinstance(raw, list) or len(raw) != 4:
        return None
    try:
        south, north, west, east = (float(value) for value in raw)
    except (TypeError, ValueError):
        return None
    return BoundingBox(south=south, north=north, west=west, east=east)
