"""API HTTP locale che espone la sessione al frontend.

Il server gira solo su ``127.0.0.1``: non è un servizio di rete, è il ponte tra
la UI web e il core della fase 1. Ogni endpoint restituisce l'istantanea completa
dello stato (``Status.to_dict()``), così il frontend non deve mai ricostruirlo
componendo risposte diverse.

Lo stato arriva anche in push su ``/api/events`` (Server-Sent Events): la caduta
del tunnel non è provocata da un'azione dell'utente, quindi non può essere
comunicata come risposta a una richiesta — deve poter arrivare da sola.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .errors import ErrorCode, GpsSimError
from .geocode import BoundingBox, Geocoder, GeocodingError
from .location import LocationSession
from .models import Coordinate, Status
from .routing import RouteError, Router
from .routing import plan_city_tour as compute_city_tour

logger = logging.getLogger(__name__)

WEB_ROOT = Path(__file__).parent / "web"

#: Ogni codice di errore ha una risposta HTTP sensata, così il frontend può
#: distinguere "non c'è il dispositivo" da "manca il permesso" anche prima di
#: leggere il corpo.
_HTTP_STATUS: dict[ErrorCode, int] = {
    ErrorCode.NO_DEVICE: 404,
    ErrorCode.DEVICE_NOT_FOUND: 404,
    ErrorCode.INSUFFICIENT_PRIVILEGES: 403,
    ErrorCode.PYMOBILEDEVICE3_MISSING: 500,
    ErrorCode.INTERNAL: 500,
    ErrorCode.USBMUXD_UNAVAILABLE: 503,
}
#: Tutto il resto è "il dispositivo non è in uno stato utilizzabile": 409.
_DEFAULT_HTTP_STATUS = 409

#: Ogni quanto mandare un commento SSE se non cambia nulla, per tenere viva la
#: connessione attraverso eventuali proxy e per accorgersi dei client morti.
SSE_HEARTBEAT = 15.0


class LocationRequest(BaseModel):
    latitude: float = Field(ge=-90.0, le=90.0)
    longitude: float = Field(ge=-180.0, le=180.0)


class ConnectRequest(BaseModel):
    udid: str | None = None


class CityTourRequest(BaseModel):
    city: str = Field(min_length=1, max_length=200)
    speed_kmh: float = Field(default=50.0, gt=0, le=200)
    profile: str = Field(default="driving", pattern="^(driving|cycling|walking)$")
    #: `None` lascia decidere in base all'estensione della città.
    waypoints: int | None = Field(default=None, ge=2, le=50)


class PlayRouteRequest(BaseModel):
    points: list[LocationRequest] = Field(min_length=2)
    speed_kmh: float = Field(gt=0, le=200)
    label: str = Field(default="Giro", max_length=200)


def create_app(
    *,
    session: LocationSession | None = None,
    geocoder: Geocoder | None = None,
    router: Router | None = None,
) -> FastAPI:
    """Costruisce l'app. Sessione, geocoder e router sono iniettabili per i test."""
    session = session or LocationSession()
    geocoder = geocoder or Geocoder()
    router = router or Router()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        yield
        # Alla chiusura la posizione reale va ripristinata: lasciare l'override
        # attivo mentre l'app non c'è più significa lasciare l'utente senza il
        # pulsante per annullarlo.
        with suppress(Exception):
            await session.disconnect()
        with suppress(Exception):
            await geocoder.close()
        with suppress(Exception):
            await router.close()

    app = FastAPI(
        title="iphone-gps-sim",
        description="API locale del simulatore di posizione GPS per iPhone",
        lifespan=lifespan,
    )
    app.state.session = session
    app.state.geocoder = geocoder
    app.state.router = router

    # ------------------------------------------------------------------ #
    # Errori
    # ------------------------------------------------------------------ #

    @app.exception_handler(GpsSimError)
    async def _handle_gpssim_error(_request: Request, error: GpsSimError) -> JSONResponse:
        status_code = _HTTP_STATUS.get(error.code, _DEFAULT_HTTP_STATUS)
        logger.info("%s -> HTTP %d", error.code.value, status_code)
        return JSONResponse(
            status_code=status_code,
            content={"error": error.to_dict(), "status": session.status.to_dict()},
        )

    @app.exception_handler(GeocodingError)
    async def _handle_geocoding_error(_request: Request, error: GeocodingError) -> JSONResponse:
        return JSONResponse(status_code=502, content={"error": error.to_dict()})

    @app.exception_handler(RouteError)
    async def _handle_route_error(_request: Request, error: RouteError) -> JSONResponse:
        return JSONResponse(status_code=502, content={"error": error.to_dict()})

    # ------------------------------------------------------------------ #
    # Stato e dispositivi
    # ------------------------------------------------------------------ #

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        """Usata dal wrapper desktop per sapere quando la finestra può aprirsi."""
        from . import __version__

        return {"ok": True, "version": __version__}

    @app.get("/api/status")
    async def get_status() -> dict[str, Any]:
        return session.status.to_dict()

    @app.get("/api/devices")
    async def get_devices() -> dict[str, Any]:
        devices = await session.manager.list_devices()
        return {"devices": [device.to_dict() for device in devices]}

    @app.post("/api/session/connect")
    async def connect(payload: ConnectRequest | None = None) -> dict[str, Any]:
        """Prepara il dispositivo: developer mode, DDI, tunnel, backend."""
        status = await session.connect(payload.udid if payload else None)
        return status.to_dict()

    @app.post("/api/session/disconnect")
    async def disconnect() -> dict[str, Any]:
        status = await session.disconnect()
        return status.to_dict()

    # ------------------------------------------------------------------ #
    # Posizione
    # ------------------------------------------------------------------ #

    @app.post("/api/location")
    async def set_location(payload: LocationRequest) -> dict[str, Any]:
        status = await session.set_location(Coordinate(payload.latitude, payload.longitude))
        return status.to_dict()

    @app.post("/api/location/restore")
    async def restore_location() -> dict[str, Any]:
        """Il pulsante «ripristina posizione reale»."""
        status = await session.restore_real_location()
        return status.to_dict()

    # ------------------------------------------------------------------ #
    # Giro città
    # ------------------------------------------------------------------ #

    @app.post("/api/routes/plan")
    async def plan_route(payload: CityTourRequest) -> Any:
        """Pianifica (senza avviare) un giro che copre l'area della città data.

        Non è "ogni singola strada": campiona l'area con più tappe quanto più
        la città è estesa e chiede al motore di routing il giro di andata e
        ritorno più efficiente che le tocchi tutte, su strade vere.
        """
        places = await geocoder.search(payload.city, limit=1)
        if not places:
            return JSONResponse(
                status_code=404,
                content={
                    "error": {
                        "code": "city_not_found",
                        "message": f"Nessun risultato per «{payload.city}».",
                        "hint": "Controlla il nome e riprova — anche solo il nome della città basta.",
                    }
                },
            )
        place = places[0]
        bbox = place.bbox or BoundingBox.around(place.coordinate, 0.02)
        label = f"Giro di {place.label.split(',')[0].strip()}"
        plan = await compute_city_tour(
            router,
            bbox=bbox,
            origin=place.coordinate,
            label=label,
            waypoint_count=payload.waypoints,
            profile=payload.profile,
        )
        return {**plan.to_dict(), "speed_kmh": payload.speed_kmh}

    @app.post("/api/routes/play")
    async def play_route(payload: PlayRouteRequest) -> dict[str, Any]:
        points = [Coordinate(point.latitude, point.longitude) for point in payload.points]
        status = await session.play_route(points, speed_kmh=payload.speed_kmh, label=payload.label)
        return status.to_dict()

    @app.post("/api/routes/stop")
    async def stop_route() -> dict[str, Any]:
        status = await session.stop_route()
        return status.to_dict()

    # ------------------------------------------------------------------ #
    # Eventi
    # ------------------------------------------------------------------ #

    @app.get("/api/events")
    async def events() -> StreamingResponse:
        return StreamingResponse(
            _status_stream(session),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-store",
                # Innocuo in locale, ma evita che un proxy accumuli lo stream.
                "X-Accel-Buffering": "no",
            },
        )

    # ------------------------------------------------------------------ #
    # Geocoding
    # ------------------------------------------------------------------ #

    @app.get("/api/geocode/search")
    async def geocode_search(
        q: str = Query(min_length=1, max_length=200),
        limit: int = Query(default=6, ge=1, le=20),
    ) -> dict[str, Any]:
        places = await geocoder.search(q, limit=limit)
        return {"results": [place.to_dict() for place in places]}

    @app.get("/api/geocode/reverse")
    async def geocode_reverse(
        latitude: float = Query(ge=-90.0, le=90.0),
        longitude: float = Query(ge=-180.0, le=180.0),
    ) -> dict[str, Any]:
        place = await geocoder.reverse(Coordinate(latitude, longitude))
        return {"result": place.to_dict() if place else None}

    # ------------------------------------------------------------------ #
    # Frontend
    # ------------------------------------------------------------------ #

    if WEB_ROOT.is_dir():
        @app.get("/")
        async def index() -> FileResponse:
            return FileResponse(WEB_ROOT / "index.html")

        app.mount("/", StaticFiles(directory=WEB_ROOT), name="web")
    else:  # pragma: no cover - solo se il pacchetto è installato male
        logger.warning("cartella web non trovata in %s: solo API", WEB_ROOT)

    return app


async def _status_stream(session: LocationSession) -> AsyncIterator[str]:
    """Genera lo stream SSE dello stato.

    La coda è limitata: se il client non tiene il passo si perdono gli
    aggiornamenti intermedi, mai l'ultimo — è uno stato, non un log, quindi
    scartare i vecchi è la cosa giusta.
    """
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=32)

    def on_status(status: Status) -> None:
        payload = status.to_dict()
        if queue.full():
            with suppress(asyncio.QueueEmpty):
                queue.get_nowait()
        with suppress(asyncio.QueueFull):
            queue.put_nowait(payload)

    remove = session.add_listener(on_status)
    try:
        # Il primo evento è lo stato corrente: chi si collega non deve aspettare
        # un cambiamento per sapere dove siamo.
        yield _sse(session.status.to_dict())
        while True:
            try:
                payload = await asyncio.wait_for(queue.get(), timeout=SSE_HEARTBEAT)
            except asyncio.TimeoutError:
                yield ": heartbeat\n\n"
            else:
                yield _sse(payload)
    finally:
        remove()


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
