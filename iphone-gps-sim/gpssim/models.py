"""Modelli dati condivisi tra core, CLI e (dalla fase 2) API HTTP."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

#: Da iOS 18 la posizione simulata viene azzerata appena il canale con il
#: dispositivo si chiude. Rimandare le coordinate a intervalli brevi mantiene
#: l'override attivo e ci fa accorgere subito se il canale è caduto.
KEEPALIVE_INTERVAL = 1.5

#: Versione di iOS dalla quale serve il tunnel RSD.
RSD_MIN_IOS = 17

#: Versione di iOS dalla quale il keep-alive è obbligatorio (prima era solo utile).
KEEPALIVE_REQUIRED_MIN_IOS = 18


class SessionState(str, Enum):
    """Stato della sessione, pensato per essere mostrato in una barra di stato."""

    #: Nessun dispositivo selezionato.
    IDLE = "idle"
    #: Handshake in corso: lockdown, mount DDI, tunnel.
    PREPARING = "preparing"
    #: Dispositivo pronto, nessuna posizione simulata attiva.
    READY = "ready"
    #: Override attivo e keep-alive in esecuzione.
    SIMULATING = "simulating"
    #: Il canale col dispositivo è caduto: la posizione sull'iPhone è tornata reale.
    LOST = "lost"
    #: Errore che richiede un intervento dell'utente.
    ERROR = "error"


@dataclass(frozen=True)
class Coordinate:
    latitude: float
    longitude: float

    def __post_init__(self) -> None:
        if not -90.0 <= self.latitude <= 90.0:
            raise ValueError(f"latitudine fuori range: {self.latitude}")
        if not -180.0 <= self.longitude <= 180.0:
            raise ValueError(f"longitudine fuori range: {self.longitude}")

    def to_dict(self) -> dict[str, float]:
        return {"latitude": self.latitude, "longitude": self.longitude}


@dataclass
class DeviceInfo:
    udid: str
    name: str
    ios_version: str
    product_type: str
    connection_type: str
    #: `None` quando l'informazione non è interrogabile (iOS < 16).
    developer_mode: bool | None = None
    ddi_mounted: bool | None = None

    @property
    def ios_major(self) -> int:
        head = self.ios_version.split(".", 1)[0]
        return int(head) if head.isdigit() else 0

    @property
    def needs_tunnel(self) -> bool:
        return self.ios_major >= RSD_MIN_IOS

    @property
    def needs_keepalive(self) -> bool:
        """Su iOS < 18 il keep-alive resta attivo comunque: costa poco e ci fa
        rilevare la caduta del canale entro 1,5 s invece che al prossimo comando."""
        return True

    def to_dict(self) -> dict[str, Any]:
        return {
            "udid": self.udid,
            "name": self.name,
            "ios_version": self.ios_version,
            "product_type": self.product_type,
            "connection_type": self.connection_type,
            "developer_mode": self.developer_mode,
            "ddi_mounted": self.ddi_mounted,
            "needs_tunnel": self.needs_tunnel,
        }


@dataclass
class TunnelInfo:
    """Coordinate del tunnel RSD, catturate dall'output di `lockdown start-tunnel`."""

    address: str
    port: int
    pid: int | None = None
    started_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "address": self.address,
            "port": self.port,
            "pid": self.pid,
            "started_at": self.started_at,
            "uptime": time.time() - self.started_at,
        }


@dataclass
class RouteProgress:
    """Avanzamento di un giro in corso (o appena pianificato): quanto manca,
    non solo dov'è il prossimo punto."""

    label: str
    points: int
    index: int
    distance_m: float
    remaining_m: float
    speed_kmh: float
    #: `False` mentre il giro è stato pianificato ma non ancora avviato.
    playing: bool = False

    @property
    def progress_fraction(self) -> float:
        if self.points <= 1:
            return 1.0
        return min(1.0, self.index / (self.points - 1))

    @property
    def eta_seconds(self) -> float:
        speed_m_s = (self.speed_kmh * 1000) / 3600
        return self.remaining_m / speed_m_s if speed_m_s > 0 else 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "points": self.points,
            "index": self.index,
            "distance_m": self.distance_m,
            "remaining_m": self.remaining_m,
            "speed_kmh": self.speed_kmh,
            "playing": self.playing,
            "progress_fraction": self.progress_fraction,
            "eta_seconds": self.eta_seconds,
        }


@dataclass
class Status:
    """Istantanea completa dello stato: è il payload che la UI mostra."""

    state: SessionState = SessionState.IDLE
    device: DeviceInfo | None = None
    tunnel: TunnelInfo | None = None
    #: Coordinate che stiamo tenendo attive sul dispositivo.
    target: Coordinate | None = None
    #: Backend in uso ("dvt" o "simulatelocation").
    backend: str | None = None
    keepalive_interval: float = KEEPALIVE_INTERVAL
    last_push_at: float | None = None
    last_push_ok: bool = False
    consecutive_push_failures: int = 0
    #: `True` quando sappiamo che l'iPhone sta mostrando la sua posizione reale.
    real_location: bool = True
    #: Giro città in corso (o appena pianificato). `None` fuori da quel flusso.
    route: RouteProgress | None = None
    error: dict[str, Any] | None = None
    message: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state.value,
            "device": self.device.to_dict() if self.device else None,
            "tunnel": self.tunnel.to_dict() if self.tunnel else None,
            "target": self.target.to_dict() if self.target else None,
            "backend": self.backend,
            "keepalive_interval": self.keepalive_interval,
            "last_push_at": self.last_push_at,
            "last_push_ok": self.last_push_ok,
            "consecutive_push_failures": self.consecutive_push_failures,
            "real_location": self.real_location,
            "route": self.route.to_dict() if self.route else None,
            "error": self.error,
            "message": self.message,
        }
