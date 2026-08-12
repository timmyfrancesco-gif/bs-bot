"""Simulatore di posizione GPS per iPhone collegato via USB.

Alternativa open source a GhostMe, costruita su ``pymobiledevice3`` e sulla
modalità sviluppatore di iOS.

Fase 1 — questo pacchetto contiene il core senza interfaccia:

- :mod:`gpssim.device`: rilevamento dispositivi, developer mode, mount della DDI;
- :mod:`gpssim.tunnel`: tunnel RSD per iOS 17+ con cattura di indirizzo e porta;
- :mod:`gpssim.location`: override della posizione e keep-alive a 1,5 s;
- :mod:`gpssim.errors`: tassonomia degli errori con messaggi per l'utente;
- :mod:`gpssim.cli`: CLI di test (``python -m gpssim``).
"""

from .device import DeviceConnection, DeviceManager
from .errors import ErrorCode, GpsSimError, classify
from .location import (
    DvtLocationBackend,
    LocationBackend,
    LocationSession,
    SimulateLocationBackend,
    open_backend,
)
from .models import (
    KEEPALIVE_INTERVAL,
    Coordinate,
    DeviceInfo,
    SessionState,
    Status,
    TunnelInfo,
)
from .tunnel import RsdTunnel, TunnelOutputParser, is_privileged

__version__ = "0.4.0"

__all__ = [
    "KEEPALIVE_INTERVAL",
    "Coordinate",
    "DeviceConnection",
    "DeviceInfo",
    "DeviceManager",
    "DvtLocationBackend",
    "ErrorCode",
    "GpsSimError",
    "LocationBackend",
    "LocationSession",
    "RsdTunnel",
    "SessionState",
    "SimulateLocationBackend",
    "Status",
    "TunnelInfo",
    "TunnelOutputParser",
    "__version__",
    "classify",
    "is_privileged",
    "open_backend",
]
