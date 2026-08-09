"""Override della posizione GPS e keep-alive.

Due backend, perché iOS espone due strade diverse per lo stesso risultato:

``dvt``
    Canale DTX ``com.apple.instruments.server.services.LocationSimulation``,
    aperto una volta e riutilizzato. È il backend preferito: il keep-alive
    riscrive le coordinate sullo stesso canale, quindi costa pochissimo, e la
    caduta del canale è immediatamente visibile.

``simulatelocation``
    Servizio ``com.apple.dt.simulatelocation``, protocollo binario minimale, una
    connessione per comando. Serve da riserva quando il canale DTX non è
    disponibile. La connessione viene chiusa a ogni invio: la versione in
    ``pymobiledevice3`` non lo fa, e a un invio ogni 1,5 s si esaurirebbero i
    descrittori di file.

Sopra i backend c'è :class:`LocationSession`, che è il cuore del comportamento
richiesto: da iOS 18 l'override viene azzerato appena il canale si chiude, quindi
le coordinate vengono rimandate ogni 1,5 s. Se gli invii iniziano a fallire, lo
stato passa a ``LOST`` e viene notificato: la posizione sull'iPhone è tornata
reale e l'utente deve saperlo.
"""

from __future__ import annotations

import asyncio
import logging
import struct
import time
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from .device import DeviceConnection, DeviceManager, ProgressCallback, noop_progress
from .errors import ErrorCode, GpsSimError, classify
from .models import KEEPALIVE_INTERVAL, Coordinate, RouteProgress, SessionState, Status
from .routing import haversine_m, total_distance_m

logger = logging.getLogger(__name__)

#: Quanti invii consecutivi possono fallire prima di dichiarare persa la sessione.
MAX_PUSH_FAILURES = 3

#: Tentativi di ricostruzione della sessione dopo una caduta, con attese crescenti.
RECOVERY_BACKOFF = (2.0, 4.0, 8.0, 16.0)


@asynccontextmanager
async def _quiet() -> AsyncIterator[None]:
    """Ingoia gli errori di chiusura, ma lasciandone traccia nei log: liberare
    risorse non deve mai far fallire un teardown."""
    try:
        yield
    except Exception as exc:
        logger.debug("errore ignorato durante la chiusura: %r", exc)


# --------------------------------------------------------------------------- #
# Backend
# --------------------------------------------------------------------------- #


class LocationBackend(ABC):
    """Interfaccia minima verso il servizio di simulazione posizione."""

    name: str

    @abstractmethod
    async def open(self) -> None:
        """Prepara il backend. Solleva se il servizio non è raggiungibile."""

    @abstractmethod
    async def set(self, coordinate: Coordinate) -> None:
        """Imposta (o riconferma) la posizione simulata."""

    @abstractmethod
    async def clear(self) -> None:
        """Rimuove l'override: l'iPhone torna alla posizione reale."""

    @abstractmethod
    async def close(self) -> None:
        """Rilascia le risorse. Non deve sollevare."""


class DvtLocationBackend(LocationBackend):
    """Canale DTX persistente. Preferito perché il keep-alive è quasi gratuito."""

    name = "dvt"

    def __init__(self, service_provider: Any) -> None:
        self._service_provider = service_provider
        self._provider: Any = None
        self._simulation: Any = None

    async def open(self) -> None:
        from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
        from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation

        provider = DvtProvider(self._service_provider)
        simulation = LocationSimulation(provider)
        try:
            await simulation.connect()
        except Exception:
            async with _quiet():
                await provider.close()
            raise
        self._provider = provider
        self._simulation = simulation

    async def set(self, coordinate: Coordinate) -> None:
        await self._require().set(coordinate.latitude, coordinate.longitude)

    async def clear(self) -> None:
        await self._require().clear()

    async def close(self) -> None:
        if self._simulation is not None:
            async with _quiet():
                await self._simulation.close()
            self._simulation = None
        if self._provider is not None:
            async with _quiet():
                await self._provider.close()
            self._provider = None

    def _require(self) -> Any:
        if self._simulation is None:
            raise GpsSimError(
                ErrorCode.LOCATION_UNSUPPORTED,
                detail="canale DTX non aperto",
            )
        return self._simulation


class SimulateLocationBackend(LocationBackend):
    """Riserva su ``com.apple.dt.simulatelocation``.

    Il protocollo è: un ``uint32`` big-endian di comando (0 = imposta,
    1 = azzera), poi — per il comando 0 — latitudine e longitudine come stringhe
    ASCII precedute dalla loro lunghezza. Una connessione per comando, chiusa
    subito dopo.
    """

    name = "simulatelocation"
    SERVICE_NAME = "com.apple.dt.simulatelocation"
    _COMMAND_START = 0
    _COMMAND_STOP = 1

    def __init__(self, service_provider: Any) -> None:
        self._service_provider = service_provider

    async def open(self) -> None:
        # Una connessione di prova: se il servizio non c'è (DDI non montata),
        # è meglio saperlo ora che al primo keep-alive.
        service = await self._connect()
        await service.close()

    async def set(self, coordinate: Coordinate) -> None:
        latitude = str(coordinate.latitude).encode()
        longitude = str(coordinate.longitude).encode()
        service = await self._connect()
        try:
            await service.sendall(struct.pack(">I", self._COMMAND_START))
            await service.sendall(struct.pack(">I", len(latitude)) + latitude)
            await service.sendall(struct.pack(">I", len(longitude)) + longitude)
        finally:
            await service.close()

    async def clear(self) -> None:
        service = await self._connect()
        try:
            await service.sendall(struct.pack(">I", self._COMMAND_STOP))
        finally:
            await service.close()

    async def close(self) -> None:
        return None

    async def _connect(self) -> Any:
        return await self._service_provider.start_lockdown_developer_service(self.SERVICE_NAME)


async def open_backend(service_provider: Any, *, preferred: str | None = None) -> LocationBackend:
    """Apre il backend migliore disponibile.

    :param preferred: forza ``"dvt"`` o ``"simulatelocation"`` invece di provarli
        in ordine. Utile per diagnosticare.
    """
    candidates: list[type[LocationBackend]]
    if preferred == "dvt":
        candidates = [DvtLocationBackend]
    elif preferred == "simulatelocation":
        candidates = [SimulateLocationBackend]
    else:
        candidates = [DvtLocationBackend, SimulateLocationBackend]

    first_error: GpsSimError | None = None
    for candidate in candidates:
        backend = candidate(service_provider)
        try:
            await backend.open()
        except Exception as exc:
            await backend.close()
            error = classify(exc, default=ErrorCode.LOCATION_UNSUPPORTED)
            logger.warning("backend %s non disponibile: %s", candidate.name, error.detail or error.message)
            first_error = first_error or error
            continue
        logger.info("backend posizione: %s", backend.name)
        return backend

    raise first_error or GpsSimError(ErrorCode.LOCATION_UNSUPPORTED)


# --------------------------------------------------------------------------- #
# Sessione
# --------------------------------------------------------------------------- #

StatusListener = Callable[[Status], Awaitable[None] | None]


class LocationSession:
    """Sessione completa: dispositivo, backend, keep-alive, stato osservabile.

    È la classe che la fase 2 esporrà via HTTP. Tutto lo stato che la UI deve
    mostrare vive in :attr:`status`, e ogni cambiamento viene notificato ai
    listener registrati con :meth:`add_listener`.
    """

    def __init__(
        self,
        *,
        manager: DeviceManager | None = None,
        keepalive_interval: float = KEEPALIVE_INTERVAL,
        auto_recover: bool = True,
        preferred_backend: str | None = None,
    ) -> None:
        self.manager = manager or DeviceManager()
        self.keepalive_interval = keepalive_interval
        self.auto_recover = auto_recover
        self.preferred_backend = preferred_backend

        self.status = Status(keepalive_interval=keepalive_interval)
        self._connection: DeviceConnection | None = None
        self._backend: LocationBackend | None = None
        self._keepalive: asyncio.Task[None] | None = None
        self._recovery: asyncio.Task[None] | None = None
        self._route_task: asyncio.Task[None] | None = None
        self._listeners: list[StatusListener] = []
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ #
    # Osservabilità
    # ------------------------------------------------------------------ #

    def add_listener(self, listener: StatusListener) -> Callable[[], None]:
        """Registra un listener sullo stato; restituisce la funzione per togliersi."""
        self._listeners.append(listener)

        def remove() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return remove

    def _publish(self) -> None:
        snapshot = self.status
        for listener in list(self._listeners):
            try:
                result = listener(snapshot)
                if asyncio.iscoroutine(result):
                    asyncio.create_task(result)
            except Exception:
                logger.exception("listener di stato ha sollevato un'eccezione")

    def _set_state(
        self,
        state: SessionState,
        *,
        message: str | None = None,
        error: GpsSimError | None = None,
        real_location: bool | None = None,
    ) -> None:
        self.status.state = state
        # Senza un messaggio esplicito quello dell'errore è la cosa più utile da
        # mostrare: uno stato di errore con la riga di stato vuota non dice nulla.
        self.status.message = message or (error.message if error is not None else None)
        self.status.error = error.to_dict() if error is not None else None
        if real_location is not None:
            self.status.real_location = real_location
        self._publish()

    # ------------------------------------------------------------------ #
    # Ciclo di vita
    # ------------------------------------------------------------------ #

    async def connect(
        self, udid: str | None = None, *, on_progress: ProgressCallback = noop_progress
    ) -> Status:
        """Prepara il dispositivo e apre il backend, senza simulare nulla."""
        async with self._lock:
            await self._teardown()
            self._set_state(SessionState.PREPARING, message="Preparazione in corso…", real_location=True)

            def progress(message: str) -> None:
                self.status.message = message
                self._publish()
                on_progress(message)

            try:
                connection = await self.manager.prepare(
                    udid,
                    on_progress=progress,
                    on_tunnel_lost=self._on_tunnel_lost,
                )
            except Exception as exc:
                error = classify(exc)
                self.status.device = None
                self.status.tunnel = None
                self.status.backend = None
                self._set_state(SessionState.ERROR, error=error, real_location=True)
                raise error from exc

            self._connection = connection
            self.status.device = connection.device
            self.status.tunnel = connection.tunnel_info

            try:
                self._backend = await open_backend(
                    connection.service_provider, preferred=self.preferred_backend
                )
            except Exception as exc:
                error = classify(exc, default=ErrorCode.LOCATION_UNSUPPORTED)
                await self._teardown()
                self._set_state(SessionState.ERROR, error=error, real_location=True)
                raise error from exc

            self.status.backend = self._backend.name
            self._set_state(
                SessionState.READY,
                message=f"{connection.device.name} pronto (backend {self._backend.name}).",
                real_location=True,
            )
            return self.status

    async def disconnect(self) -> Status:
        """Ripristina la posizione reale e chiude tutto."""
        async with self._lock:
            await self._clear_location(best_effort=True)
            await self._teardown()
            self.status.device = None
            self.status.tunnel = None
            self.status.backend = None
            self.status.target = None
            self._set_state(SessionState.IDLE, message="Disconnesso.", real_location=True)
            return self.status

    # ------------------------------------------------------------------ #
    # Comandi di posizione
    # ------------------------------------------------------------------ #

    async def set_location(self, coordinate: Coordinate) -> Status:
        """Imposta la posizione e avvia (o aggiorna) il keep-alive.

        Interrompe un giro città in corso: impostare un punto a mano è
        un'azione esplicita dell'utente, deve vincere su qualunque automatismo.
        """
        async with self._lock:
            await self._stop_route()
            await self._push_target(coordinate)
            self._set_state(
                SessionState.SIMULATING,
                message=f"Posizione simulata: {coordinate.latitude:.6f}, {coordinate.longitude:.6f}",
                real_location=False,
            )
            self._start_keepalive()
            return self.status

    async def restore_real_location(self) -> Status:
        """Il pulsante «ripristina posizione reale»: ferma il keep-alive e azzera
        l'override, lasciando la sessione pronta per un nuovo punto."""
        async with self._lock:
            await self._stop_route()
            await self._clear_location(best_effort=False)
            self.status.target = None
            self._set_state(
                SessionState.READY if self._backend is not None else SessionState.IDLE,
                message="Posizione reale ripristinata.",
                real_location=True,
            )
            return self.status

    # ------------------------------------------------------------------ #
    # Giro città
    # ------------------------------------------------------------------ #

    async def play_route(
        self, points: list[Coordinate], *, speed_kmh: float, label: str = "Giro"
    ) -> Status:
        """Avvia il playback di un giro: attraversa i punti in ordine, a
        velocità costante, senza bloccare il resto della sessione — chi vuole
        fermarlo o disconnettersi nel frattempo deve poterlo fare.
        """
        if len(points) < 2:
            raise GpsSimError(
                ErrorCode.LOCATION_UNSUPPORTED,
                message="Il giro non ha punti a sufficienza.",
                hint="Rigenera il giro e riprova.",
            )
        speed_kmh = max(1.0, speed_kmh)

        async with self._lock:
            self._require_backend()
            await self._stop_route()
            distance = total_distance_m(points)
            self.status.route = RouteProgress(
                label=label,
                points=len(points),
                index=0,
                distance_m=distance,
                remaining_m=distance,
                speed_kmh=speed_kmh,
                playing=True,
            )
            self._route_task = asyncio.create_task(
                self._route_loop(points, speed_kmh, label), name="gps-route"
            )
            self._publish()
            return self.status

    async def stop_route(self) -> Status:
        """Ferma il giro dov'è: la posizione simulata resta quella attuale.
        Per tornare alla posizione reale c'è `restore_real_location`."""
        async with self._lock:
            was_playing = self.status.route is not None
            await self._stop_route()
            if was_playing:
                self._set_state(
                    self.status.state,
                    message="Giro fermato.",
                    real_location=self.status.real_location,
                )
            return self.status

    async def _route_loop(self, points: list[Coordinate], speed_kmh: float, label: str) -> None:
        total = total_distance_m(points)
        traveled = 0.0
        speed_m_s = (speed_kmh * 1000) / 3600
        try:
            for index, point in enumerate(points):
                async with self._lock:
                    if self.status.route is None:
                        return
                    await self._push_target(point)
                    remaining = max(0.0, total - traveled)
                    self.status.route.index = index
                    self.status.route.remaining_m = remaining
                self._set_state(
                    SessionState.SIMULATING,
                    message=f"{label}: punto {index + 1}/{len(points)} · "
                    f"{remaining / 1000:.1f} km rimanenti",
                    real_location=False,
                )
                self._start_keepalive()

                if index + 1 < len(points):
                    step = haversine_m(point, points[index + 1])
                    traveled += step
                    await asyncio.sleep(step / speed_m_s)
        except asyncio.CancelledError:
            raise
        except GpsSimError:
            # `_push_target` ha già segnato la sessione come persa: qui c'è solo
            # da smettere di far avanzare un giro che non arriva più da nessuna parte.
            if self.status.route is not None:
                self.status.route.playing = False
            return
        else:
            async with self._lock:
                if self.status.route is not None:
                    self.status.route.playing = False
                    self.status.route.index = len(points) - 1
                    self.status.route.remaining_m = 0.0
            self._set_state(
                SessionState.SIMULATING,
                message=f"{label}: giro completato ({len(points)} punti).",
                real_location=False,
            )

    # ------------------------------------------------------------------ #
    # Keep-alive
    # ------------------------------------------------------------------ #

    def _start_keepalive(self) -> None:
        if self._keepalive is not None and not self._keepalive.done():
            return
        self._keepalive = asyncio.create_task(self._keepalive_loop(), name="gps-keepalive")

    async def _stop_keepalive(self) -> None:
        task = self._keepalive
        self._keepalive = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.debug("keep-alive terminato con errore", exc_info=True)

    async def _keepalive_loop(self) -> None:
        """Rimanda le coordinate ogni ``keepalive_interval`` secondi.

        Da iOS 18 questo non è un'ottimizzazione ma un requisito: senza, la
        posizione simulata decade. Il ciclo è anche il nostro rilevatore di
        guasti — è il primo a sapere che il canale non risponde più.
        """
        while True:
            await asyncio.sleep(self.keepalive_interval)

            target = self.status.target
            backend = self._backend
            if target is None or backend is None:
                return

            connection = self._connection
            if connection is not None and not connection.is_alive:
                self._mark_lost(GpsSimError(ErrorCode.TUNNEL_LOST))
                return

            try:
                await backend.set(target)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.status.last_push_ok = False
                self.status.consecutive_push_failures += 1
                error = classify(exc, default=ErrorCode.LOCATION_PUSH_FAILED)
                logger.warning(
                    "keep-alive fallito (%d/%d): %s",
                    self.status.consecutive_push_failures,
                    MAX_PUSH_FAILURES,
                    error.detail or error.message,
                )
                if self.status.consecutive_push_failures >= MAX_PUSH_FAILURES:
                    self._mark_lost(error)
                    return
                self._publish()
            else:
                self.status.last_push_at = time.time()
                self.status.last_push_ok = True
                self.status.consecutive_push_failures = 0
                self._publish()

    # ------------------------------------------------------------------ #
    # Caduta e recupero
    # ------------------------------------------------------------------ #

    def _mark_lost(self, error: GpsSimError) -> None:
        """Passa in stato ``LOST``: sull'iPhone la posizione è tornata reale.

        Questo è il punto in cui il vincolo «non fallire in silenzio» diventa
        codice: lo stato è esplicito, l'errore è allegato, e la UI ha tutto per
        dirlo all'utente.
        """
        self.status.last_push_ok = False
        self._set_state(
            SessionState.LOST,
            message="Collegamento perso: l'iPhone mostra di nuovo la posizione reale.",
            error=error,
            real_location=True,
        )
        if self.auto_recover and self.status.target is not None:
            self._schedule_recovery()

    def _on_tunnel_lost(self, error: GpsSimError) -> None:
        """Callback del watchdog del tunnel (gira nel loop asyncio)."""
        if self.status.state in (SessionState.IDLE, SessionState.ERROR):
            return
        logger.warning("tunnel RSD perso: %s", error.detail or error.message)
        self._mark_lost(error)

    def _schedule_recovery(self) -> None:
        if self._recovery is not None and not self._recovery.done():
            return
        self._recovery = asyncio.create_task(self._recovery_loop(), name="gps-recovery")

    async def _recovery_loop(self) -> None:
        """Tenta di ricostruire la sessione e di rimettere la posizione.

        Il caso tipico è il cavo staccato e ricollegato: senza questo, l'utente
        dovrebbe rifare tutto a mano. I tentativi sono limitati: se non ce la
        facciamo, lo stato resta ``LOST`` con l'ultimo errore, mai «tutto ok».
        """
        target = self.status.target
        if target is None:
            return

        for attempt, delay in enumerate(RECOVERY_BACKOFF, start=1):
            await asyncio.sleep(delay)
            if self.status.target is None:
                return

            udid = self.status.device.udid if self.status.device else None
            self.status.message = f"Riconnessione in corso (tentativo {attempt}/{len(RECOVERY_BACKOFF)})…"
            self._publish()
            try:
                await self.connect(udid)
                await self.set_location(target)
            except GpsSimError as error:
                logger.info("tentativo di riconnessione %d fallito: %s", attempt, error.message)
                self.status.target = target
                self._set_state(
                    SessionState.LOST,
                    message=f"Riconnessione fallita (tentativo {attempt}).",
                    error=error,
                    real_location=True,
                )
                continue
            except asyncio.CancelledError:
                raise
            else:
                logger.info("sessione ripristinata al tentativo %d", attempt)
                return

        self._set_state(
            SessionState.LOST,
            message="Riconnessione automatica non riuscita: ricollega il cavo e riprova.",
            error=GpsSimError(
                ErrorCode.TUNNEL_LOST,
                hint="Ho esaurito i tentativi automatici. Stacca e ricollega il cavo, "
                "sblocca l'iPhone e premi «Connetti».",
            ),
            real_location=True,
        )

    # ------------------------------------------------------------------ #
    # Interni
    # ------------------------------------------------------------------ #

    def _require_backend(self) -> LocationBackend:
        if self._backend is None:
            raise GpsSimError(
                ErrorCode.NO_DEVICE,
                message="Nessuna sessione attiva.",
                hint="Collega e prepara l'iPhone prima di impostare una posizione.",
            )
        return self._backend

    async def _push_target(self, coordinate: Coordinate) -> None:
        """Invia la posizione al backend e aggiorna solo i campi legati
        all'invio: messaggio e stato generale restano decisione del chiamante
        (`set_location` mostra le coordinate, il giro mostra l'avanzamento).

        Va chiamato con `self._lock` già acquisito dal chiamante.
        """
        backend = self._require_backend()
        try:
            await backend.set(coordinate)
        except Exception as exc:
            error = classify(exc, default=ErrorCode.LOCATION_PUSH_FAILED)
            self._mark_lost(error)
            raise error from exc

        self.status.target = coordinate
        self.status.last_push_at = time.time()
        self.status.last_push_ok = True
        self.status.consecutive_push_failures = 0

    async def _stop_route(self) -> None:
        """Cancella il giro in corso, se c'è. Va chiamato con `self._lock` già
        acquisito: è lo stesso pattern di `_stop_keepalive`."""
        task = self._route_task
        self._route_task = None
        self.status.route = None
        if task is None or task is asyncio.current_task():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.debug("giro terminato con errore durante lo stop", exc_info=True)

    async def _clear_location(self, *, best_effort: bool) -> None:
        await self._stop_keepalive()
        backend = self._backend
        if backend is None:
            return
        try:
            await backend.clear()
        except Exception as exc:
            if not best_effort:
                error = classify(exc, default=ErrorCode.LOCATION_PUSH_FAILED)
                self._mark_lost(error)
                raise error from exc
            logger.debug("clear della posizione fallito (best effort)", exc_info=True)

    async def _teardown(self) -> None:
        recovery = self._recovery
        self._recovery = None
        if recovery is not None and recovery is not asyncio.current_task():
            recovery.cancel()

        await self._stop_route()
        await self._stop_keepalive()
        if self._backend is not None:
            await self._backend.close()
            self._backend = None
        if self._connection is not None:
            await self._connection.close()
            self._connection = None
