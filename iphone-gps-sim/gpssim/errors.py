"""Tassonomia degli errori con messaggi pensati per l'utente finale.

Ogni fallimento prevedibile (iPhone bloccato, developer mode off, DDI non
montato, permessi insufficienti, cavo staccato, tunnel caduto) viene tradotto in
un :class:`GpsSimError` con un codice stabile che la UI puo' usare per decidere
cosa mostrare, piu' un messaggio e un suggerimento in italiano.

Il principio e' quello richiesto dal progetto: mai fallire in silenzio e mai
mostrare all'utente un traceback di ``pymobiledevice3``.
"""

from __future__ import annotations

import asyncio
import errno
from dataclasses import dataclass
from enum import Enum
from typing import Any


class ErrorCode(str, Enum):
    """Codici stabili: la UI può fare pattern-matching su questi, non sui testi."""

    USBMUXD_UNAVAILABLE = "usbmuxd_unavailable"
    NO_DEVICE = "no_device"
    DEVICE_NOT_FOUND = "device_not_found"
    CABLE_DISCONNECTED = "cable_disconnected"
    NOT_PAIRED = "not_paired"
    TRUST_PENDING = "trust_pending"
    TRUST_DENIED = "trust_denied"
    DEVICE_LOCKED = "device_locked"
    DEVELOPER_MODE_OFF = "developer_mode_off"
    DDI_NOT_MOUNTED = "ddi_not_mounted"
    DDI_UNAVAILABLE = "ddi_unavailable"
    INSUFFICIENT_PRIVILEGES = "insufficient_privileges"
    TUNNEL_FAILED = "tunnel_failed"
    TUNNEL_LOST = "tunnel_lost"
    TUNNEL_UNSUPPORTED_PLATFORM = "tunnel_unsupported_platform"
    LOCATION_UNSUPPORTED = "location_unsupported"
    LOCATION_PUSH_FAILED = "location_push_failed"
    PYMOBILEDEVICE3_MISSING = "pymobiledevice3_missing"
    INTERNAL = "internal"


@dataclass(frozen=True)
class _Template:
    message: str
    hint: str
    #: `True` se ripetere l'operazione dopo un intervento dell'utente ha senso.
    user_actionable: bool = True


MESSAGES: dict[ErrorCode, _Template] = {
    ErrorCode.USBMUXD_UNAVAILABLE: _Template(
        "Non riesco a parlare con usbmuxd.",
        "Su macOS assicurati che il servizio di sistema sia attivo; su Windows installa "
        "Apple Devices (o iTunes); su Linux avvia usbmuxd (`systemctl start usbmuxd`).",
    ),
    ErrorCode.NO_DEVICE: _Template(
        "Nessun iPhone collegato via USB.",
        "Collega l'iPhone con un cavo dati (non solo di ricarica) e sbloccalo.",
    ),
    ErrorCode.DEVICE_NOT_FOUND: _Template(
        "L'iPhone selezionato non è più raggiungibile.",
        "Ricollega il dispositivo oppure scegline un altro dalla lista.",
    ),
    ErrorCode.CABLE_DISCONNECTED: _Template(
        "Il cavo USB è stato staccato.",
        "Ricollega l'iPhone: da iOS 18 la posizione simulata si azzera appena il cavo "
        "viene rimosso, quindi va rifatta la connessione.",
    ),
    ErrorCode.NOT_PAIRED: _Template(
        "L'iPhone non è associato a questo computer.",
        "Sblocca l'iPhone, ricollega il cavo e tocca «Autorizza» nella richiesta di fiducia.",
    ),
    ErrorCode.TRUST_PENDING: _Template(
        "Sto aspettando che tu autorizzi questo computer sull'iPhone.",
        "Sull'iPhone tocca «Autorizza» e inserisci il codice di sblocco, poi riprova.",
    ),
    ErrorCode.TRUST_DENIED: _Template(
        "L'autorizzazione è stata rifiutata sull'iPhone.",
        "Stacca e ricollega il cavo, poi tocca «Autorizza» quando appare la richiesta.",
    ),
    ErrorCode.DEVICE_LOCKED: _Template(
        "L'iPhone è bloccato.",
        "Sbloccalo con il codice e tienilo sbloccato: il montaggio della Developer Disk "
        "Image funziona solo a schermo sbloccato.",
    ),
    ErrorCode.DEVELOPER_MODE_OFF: _Template(
        "La modalità sviluppatore è disattivata sull'iPhone.",
        "Impostazioni → Privacy e sicurezza → Modalità sviluppatore → attiva e riavvia "
        "l'iPhone. Se la voce non c'è, collega il dispositivo e riprova: appare dopo il "
        "primo tentativo di uso da sviluppatore.",
    ),
    ErrorCode.DDI_NOT_MOUNTED: _Template(
        "La Developer Disk Image non è montata.",
        "Sblocca l'iPhone e riprova la preparazione: il montaggio automatico "
        "(`mounter auto-mount`) richiede lo schermo sbloccato.",
    ),
    ErrorCode.DDI_UNAVAILABLE: _Template(
        "Non ho trovato una Developer Disk Image compatibile con questa versione di iOS.",
        "Serve una connessione a internet per scaricare la DDI la prima volta. "
        "Se iOS è appena stato aggiornato, l'immagine potrebbe non essere ancora "
        "disponibile nel repository pubblico.",
    ),
    ErrorCode.INSUFFICIENT_PRIVILEGES: _Template(
        "Permessi insufficienti per creare il tunnel RSD.",
        "Il tunnel di iOS 17+ crea un'interfaccia di rete e richiede root/amministratore. "
        "Avvia l'app con `sudo` (macOS/Linux) o come amministratore (Windows).",
    ),
    ErrorCode.TUNNEL_FAILED: _Template(
        "Non è stato possibile creare il tunnel RSD.",
        "Verifica che l'iPhone sia sbloccato e autorizzato, che nessun altro processo "
        "(Xcode, un altro tunnel pymobiledevice3) stia già usando il dispositivo, poi riprova.",
    ),
    ErrorCode.TUNNEL_LOST: _Template(
        "Il tunnel RSD è caduto: l'iPhone è tornato alla posizione reale.",
        "Ricollega il cavo e riavvia la sessione per riprendere la simulazione.",
    ),
    ErrorCode.TUNNEL_UNSUPPORTED_PLATFORM: _Template(
        "Questa piattaforma non supporta il tunnel RSD.",
        "Il tunnel richiede il supporto TUN/utun: usa macOS, Linux o Windows con i "
        "driver Apple installati.",
    ),
    ErrorCode.LOCATION_UNSUPPORTED: _Template(
        "Il servizio di simulazione posizione non risponde su questo dispositivo.",
        "Assicurati che la Developer Disk Image sia montata e che la modalità "
        "sviluppatore sia attiva, poi riprova.",
    ),
    ErrorCode.LOCATION_PUSH_FAILED: _Template(
        "Invio della posizione all'iPhone fallito.",
        "La connessione con il dispositivo si è interrotta. Sto provando a ripristinarla.",
    ),
    ErrorCode.PYMOBILEDEVICE3_MISSING: _Template(
        "pymobiledevice3 non è installato nell'ambiente in uso.",
        "Installa le dipendenze con `pip install -r requirements.txt`.",
    ),
    ErrorCode.INTERNAL: _Template(
        "Errore interno inatteso.",
        "Controlla i log per il dettaglio tecnico.",
        user_actionable=False,
    ),
}


class GpsSimError(Exception):
    """Errore applicativo con codice stabile, messaggio e suggerimento in italiano."""

    def __init__(
        self,
        code: ErrorCode,
        *,
        detail: str | None = None,
        message: str | None = None,
        hint: str | None = None,
        cause: BaseException | None = None,
    ) -> None:
        template = MESSAGES[code]
        self.code = code
        self.message = message or template.message
        self.hint = hint or template.hint
        self.user_actionable = template.user_actionable
        #: Dettaglio tecnico: utile nei log e nel pannello "dettagli" della UI, non
        #: nel messaggio principale.
        self.detail = detail or (f"{type(cause).__name__}: {cause}" if cause is not None else None)
        super().__init__(self.message)
        if cause is not None:
            self.__cause__ = cause

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code.value,
            "message": self.message,
            "hint": self.hint,
            "detail": self.detail,
            "user_actionable": self.user_actionable,
        }

    def __str__(self) -> str:
        return f"{self.message} {self.hint}".strip()


# --------------------------------------------------------------------------- #
# Traduzione delle eccezioni di pymobiledevice3
# --------------------------------------------------------------------------- #

# Le eccezioni di pymobiledevice3 sono importate per nome, non per classe: la
# gerarchia cambia tra le major e un import mancante non deve far crollare
# l'intero modulo. La versione è pinnata in requirements.txt, ma questo modulo
# resta tollerante per scelta.
_PMD3_NAME_MAP: dict[str, ErrorCode] = {
    "ConnectionFailedToUsbmuxdError": ErrorCode.USBMUXD_UNAVAILABLE,
    "MuxVersionError": ErrorCode.USBMUXD_UNAVAILABLE,
    "NoDeviceConnectedError": ErrorCode.NO_DEVICE,
    "DeviceNotFoundError": ErrorCode.DEVICE_NOT_FOUND,
    "BadDevError": ErrorCode.CABLE_DISCONNECTED,
    "ConnectionFailedError": ErrorCode.CABLE_DISCONNECTED,
    "NotPairedError": ErrorCode.NOT_PAIRED,
    "InvalidHostIDError": ErrorCode.NOT_PAIRED,
    "NotTrustedError": ErrorCode.TRUST_PENDING,
    "PairingDialogResponsePendingError": ErrorCode.TRUST_PENDING,
    "UserDeniedPairingError": ErrorCode.TRUST_DENIED,
    "PasswordRequiredError": ErrorCode.DEVICE_LOCKED,
    "PasscodeRequiredError": ErrorCode.DEVICE_LOCKED,
    "DeveloperModeIsNotEnabledError": ErrorCode.DEVELOPER_MODE_OFF,
    "DeveloperModeError": ErrorCode.DEVELOPER_MODE_OFF,
    "DeveloperDiskImageNotFoundError": ErrorCode.DDI_UNAVAILABLE,
    "NotMountedError": ErrorCode.DDI_NOT_MOUNTED,
    "AccessDeniedError": ErrorCode.INSUFFICIENT_PRIVILEGES,
    "UnrecognizedSelectorError": ErrorCode.LOCATION_UNSUPPORTED,
    "InvalidServiceError": ErrorCode.LOCATION_UNSUPPORTED,
    "StartServiceError": ErrorCode.DDI_NOT_MOUNTED,
    "RSDRequiredError": ErrorCode.TUNNEL_FAILED,
    "TunneldConnectionError": ErrorCode.TUNNEL_FAILED,
    "StreamClosedError": ErrorCode.CABLE_DISCONNECTED,
    "ConnectionTerminatedError": ErrorCode.CABLE_DISCONNECTED,
    "ChannelClosedError": ErrorCode.CABLE_DISCONNECTED,
}

#: errno che, su una connessione già stabilita, significano "il cavo non c'è più".
_DISCONNECT_ERRNOS = frozenset(
    {
        errno.ECONNRESET,
        errno.ECONNREFUSED,
        errno.ECONNABORTED,
        errno.EPIPE,
        errno.ENETDOWN,
        errno.ENETUNREACH,
        errno.EHOSTUNREACH,
        errno.ENODEV,
    }
)


def classify(exc: BaseException, *, default: ErrorCode = ErrorCode.INTERNAL) -> GpsSimError:
    """Traduce un'eccezione qualsiasi in un :class:`GpsSimError`.

    Se l'eccezione è già un ``GpsSimError`` viene restituita così com'è.
    """
    if isinstance(exc, GpsSimError):
        return exc

    for klass in type(exc).__mro__:
        code = _PMD3_NAME_MAP.get(klass.__name__)
        if code is not None:
            return GpsSimError(code, cause=exc)

    if isinstance(exc, ConnectionError) or (
        isinstance(exc, OSError) and exc.errno in _DISCONNECT_ERRNOS
    ):
        return GpsSimError(ErrorCode.CABLE_DISCONNECTED, cause=exc)

    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
        return GpsSimError(default, detail=f"timeout: {type(exc).__name__}", cause=exc)

    if isinstance(exc, PermissionError):
        return GpsSimError(ErrorCode.INSUFFICIENT_PRIVILEGES, cause=exc)

    if isinstance(exc, ModuleNotFoundError) and "pymobiledevice3" in str(exc):
        return GpsSimError(ErrorCode.PYMOBILEDEVICE3_MISSING, cause=exc)

    return GpsSimError(default, cause=exc)
