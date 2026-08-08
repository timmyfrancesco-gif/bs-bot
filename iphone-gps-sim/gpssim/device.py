"""Rilevamento dispositivi e handshake completo fino a un service provider usabile.

La sequenza è quella imposta da iOS, in questo ordine:

1. ``usbmuxd`` elenca gli iPhone collegati;
2. si apre una connessione ``lockdown`` (che innesca la richiesta di fiducia);
3. si verifica la modalità sviluppatore (iOS 16+);
4. si monta la Developer Disk Image (``mounter auto-mount``) — **richiede
   l'iPhone sbloccato**;
5. su iOS 17+ si apre il tunnel RSD e si usa quello per ogni comando successivo.

Il risultato è un :class:`DeviceConnection`: un service provider pronto (RSD su
iOS 17+, lockdown sui più vecchi) più il tunnel che lo tiene in vita.
"""

from __future__ import annotations

import functools
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from .errors import ErrorCode, GpsSimError, classify
from .models import DeviceInfo, TunnelInfo
from .tunnel import RsdTunnel

logger = logging.getLogger(__name__)

#: Callback di log/progresso: riceve un messaggio già in italiano.
ProgressCallback = Callable[[str], None]


def noop_progress(_message: str) -> None:
    """Default per ``on_progress``: non fa nulla."""


# --------------------------------------------------------------------------- #
# Import di pymobiledevice3
# --------------------------------------------------------------------------- #
# L'API di pymobiledevice3 cambia tra le major: la versione è pinnata in
# requirements.txt e l'import è centralizzato qui, così un'incompatibilità si
# manifesta in un punto solo e con un messaggio comprensibile.


@dataclass(frozen=True)
class _Pmd3:
    """I simboli di pymobiledevice3 che usiamo, risolti una volta sola."""

    usbmux: Any
    create_using_usbmux: Any
    RemoteServiceDiscoveryService: Any
    auto_mount: Any
    exceptions: Any


@functools.lru_cache(maxsize=1)
def _pmd3() -> _Pmd3:
    try:
        from pymobiledevice3 import exceptions as pmd3_exceptions
        from pymobiledevice3 import usbmux
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
        from pymobiledevice3.services.mobile_image_mounter import auto_mount
    except ImportError as exc:  # pragma: no cover - dipende dall'ambiente
        raise GpsSimError(ErrorCode.PYMOBILEDEVICE3_MISSING, cause=exc) from exc

    return _Pmd3(
        usbmux=usbmux,
        create_using_usbmux=create_using_usbmux,
        RemoteServiceDiscoveryService=RemoteServiceDiscoveryService,
        auto_mount=auto_mount,
        exceptions=pmd3_exceptions,
    )


class DeviceConnection:
    """Una sessione aperta verso un iPhone: lockdown + (eventuale) tunnel + RSD.

    ``service_provider`` è ciò che i backend di posizione consumano; è l'RSD su
    iOS 17+ e il client lockdown sui dispositivi più vecchi.
    """

    def __init__(
        self,
        device: DeviceInfo,
        lockdown: Any,
        *,
        rsd: Any = None,
        tunnel: RsdTunnel | None = None,
    ) -> None:
        self.device = device
        self.lockdown = lockdown
        self.rsd = rsd
        self.tunnel = tunnel

    @property
    def service_provider(self) -> Any:
        return self.rsd if self.rsd is not None else self.lockdown

    @property
    def tunnel_info(self) -> TunnelInfo | None:
        return self.tunnel.info if self.tunnel is not None else None

    @property
    def is_alive(self) -> bool:
        """`False` se il tunnel è morto: in quel caso l'iPhone è già tornato
        alla posizione reale, qualunque cosa dica il nostro stato interno."""
        if self.tunnel is not None:
            return self.tunnel.is_alive
        return True

    async def close(self) -> None:
        if self.rsd is not None:
            try:
                await self.rsd.close()
            except Exception:
                logger.debug("errore chiudendo l'RSD", exc_info=True)
            self.rsd = None
        if self.tunnel is not None:
            await self.tunnel.stop()
            self.tunnel = None
        if self.lockdown is not None:
            try:
                await self.lockdown.close()
            except Exception:
                logger.debug("errore chiudendo lockdown", exc_info=True)
            self.lockdown = None


class DeviceManager:
    """Operazioni sui dispositivi: elenco e preparazione della sessione."""

    def __init__(self, *, allow_sudo: bool = True) -> None:
        self.allow_sudo = allow_sudo

    # ------------------------------------------------------------------ #
    # Elenco
    # ------------------------------------------------------------------ #

    async def list_devices(self) -> list[DeviceInfo]:
        """Elenca gli iPhone raggiungibili via USB.

        Non tocca la Developer Disk Image né il tunnel: serve solo a popolare un
        selettore. Un dispositivo che non risponde a lockdown viene comunque
        elencato, con le informazioni che abbiamo.
        """
        pmd3 = _pmd3()
        try:
            mux_devices = await pmd3.usbmux.list_devices()
        except Exception as exc:
            raise classify(exc, default=ErrorCode.USBMUXD_UNAVAILABLE) from exc

        devices: list[DeviceInfo] = []
        seen: set[str] = set()
        for mux_device in mux_devices:
            if mux_device.serial in seen:
                continue
            seen.add(mux_device.serial)
            devices.append(await self._describe(pmd3, mux_device))
        return devices

    async def _describe(self, pmd3: _Pmd3, mux_device: Any) -> DeviceInfo:
        lockdown = None
        try:
            lockdown = await pmd3.create_using_usbmux(serial=mux_device.serial, autopair=False)
            values = lockdown.all_values or {}
            info = DeviceInfo(
                udid=mux_device.serial,
                name=values.get("DeviceName") or "iPhone",
                ios_version=lockdown.product_version,
                product_type=lockdown.product_type or "unknown",
                connection_type=mux_device.connection_type,
            )
            if info.ios_major >= 16:
                try:
                    info.developer_mode = await lockdown.get_developer_mode_status()
                except Exception:
                    logger.debug("stato modalità sviluppatore non interrogabile", exc_info=True)
            return info
        except Exception:
            logger.debug("dispositivo %s non interrogabile", mux_device.serial, exc_info=True)
            return DeviceInfo(
                udid=mux_device.serial,
                name="iPhone (non autorizzato)",
                ios_version="0",
                product_type="unknown",
                connection_type=mux_device.connection_type,
            )
        finally:
            if lockdown is not None:
                try:
                    await lockdown.close()
                except Exception:
                    pass

    # ------------------------------------------------------------------ #
    # Preparazione
    # ------------------------------------------------------------------ #

    async def prepare(
        self,
        udid: str | None = None,
        *,
        on_progress: ProgressCallback = noop_progress,
        on_tunnel_lost: Callable[[GpsSimError], Awaitable[None] | None] | None = None,
        pair_timeout: float = 30.0,
        tunnel_timeout: float = 60.0,
    ) -> DeviceConnection:
        """Esegue l'handshake completo e restituisce una connessione pronta.

        :param udid: dispositivo target; ``None`` prende il primo iPhone USB.
        :param on_progress: callback per la barra di stato.
        :param on_tunnel_lost: invocata se il tunnel muore *dopo* la preparazione.
        :raises GpsSimError: sempre tipizzato — iPhone bloccato, developer mode
            off, DDI non montato, permessi insufficienti, cavo staccato.
        """
        pmd3 = _pmd3()

        on_progress("Cerco l'iPhone collegato via USB…")
        target_udid = await self._resolve_udid(pmd3, udid)

        on_progress("Apro la connessione lockdown…")
        lockdown = await self._connect_lockdown(pmd3, target_udid, pair_timeout)

        connection: DeviceConnection | None = None
        try:
            values = lockdown.all_values or {}
            device = DeviceInfo(
                udid=lockdown.udid or target_udid,
                name=values.get("DeviceName") or "iPhone",
                ios_version=lockdown.product_version,
                product_type=lockdown.product_type or "unknown",
                connection_type="USB",
            )
            on_progress(f"{device.name} — iOS {device.ios_version}")

            await self._ensure_developer_mode(lockdown, device, on_progress)
            await self._ensure_ddi(pmd3, lockdown, device, on_progress)

            if not device.needs_tunnel:
                on_progress("iOS precedente alla 17: uso direttamente lockdown, nessun tunnel.")
                return DeviceConnection(device, lockdown)

            on_progress("Avvio il tunnel RSD (richiede privilegi di amministratore)…")
            tunnel = RsdTunnel(
                device.udid,
                on_lost=on_tunnel_lost,
                allow_sudo=self.allow_sudo,
            )
            tunnel_info = await tunnel.start(timeout=tunnel_timeout)
            on_progress(f"Tunnel attivo: RSD [{tunnel_info.address}]:{tunnel_info.port}")

            rsd = await self._connect_rsd(pmd3, tunnel, tunnel_info)
            connection = DeviceConnection(device, lockdown, rsd=rsd, tunnel=tunnel)
            # L'RSD riporta la versione reale del sistema: usiamola come fonte
            # di verità, l'handshake del tunnel è più recente di quello lockdown.
            device.ios_version = getattr(rsd, "product_version", device.ios_version) or device.ios_version
            on_progress("Dispositivo pronto.")
            return connection
        except Exception as exc:
            if connection is not None:
                await connection.close()
            else:
                try:
                    await lockdown.close()
                except Exception:
                    pass
            raise classify(exc) from exc

    # ------------------------------------------------------------------ #
    # Passi dell'handshake
    # ------------------------------------------------------------------ #

    async def _resolve_udid(self, pmd3: _Pmd3, udid: str | None) -> str:
        try:
            mux_devices = await pmd3.usbmux.list_devices()
        except Exception as exc:
            raise classify(exc, default=ErrorCode.USBMUXD_UNAVAILABLE) from exc

        usb_devices = [device for device in mux_devices if device.is_usb]
        if not usb_devices:
            if mux_devices:
                raise GpsSimError(
                    ErrorCode.NO_DEVICE,
                    message="Trovo l'iPhone solo via Wi-Fi, non via USB.",
                    hint="Collega il cavo: la simulazione della posizione richiede "
                    "la connessione USB.",
                )
            raise GpsSimError(ErrorCode.NO_DEVICE)

        if udid is None:
            return usb_devices[0].serial

        for device in usb_devices:
            if device.matches_udid(udid):
                return device.serial
        raise GpsSimError(
            ErrorCode.DEVICE_NOT_FOUND,
            detail=f"udid richiesto: {udid}",
        )

    async def _connect_lockdown(self, pmd3: _Pmd3, udid: str, pair_timeout: float) -> Any:
        try:
            return await pmd3.create_using_usbmux(serial=udid, pair_timeout=pair_timeout)
        except Exception as exc:
            raise classify(exc, default=ErrorCode.NOT_PAIRED) from exc

    async def _ensure_developer_mode(
        self, lockdown: Any, device: DeviceInfo, on_progress: ProgressCallback
    ) -> None:
        if device.ios_major < 16:
            device.developer_mode = None
            return
        try:
            enabled = await lockdown.get_developer_mode_status()
        except Exception:
            # Non riuscire a *leggere* lo stato non è un motivo per fermarsi: se
            # la modalità è davvero off, il mount della DDI lo dirà comunque.
            logger.debug("lettura modalità sviluppatore fallita", exc_info=True)
            on_progress("Non riesco a leggere lo stato della modalità sviluppatore, procedo.")
            device.developer_mode = None
            return

        device.developer_mode = enabled
        if not enabled:
            raise GpsSimError(ErrorCode.DEVELOPER_MODE_OFF)
        on_progress("Modalità sviluppatore attiva.")

    async def _ensure_ddi(
        self, pmd3: _Pmd3, lockdown: Any, device: DeviceInfo, on_progress: ProgressCallback
    ) -> None:
        """Monta la Developer Disk Image. L'iPhone deve essere sbloccato."""
        exceptions = pmd3.exceptions
        on_progress("Monto la Developer Disk Image (iPhone sbloccato)…")
        try:
            await pmd3.auto_mount(lockdown)
        except exceptions.AlreadyMountedError:
            device.ddi_mounted = True
            on_progress("Developer Disk Image già montata.")
            return
        except exceptions.DeveloperModeIsNotEnabledError as exc:
            device.ddi_mounted = False
            raise GpsSimError(ErrorCode.DEVELOPER_MODE_OFF, cause=exc) from exc
        except exceptions.DeveloperDiskImageNotFoundError as exc:
            device.ddi_mounted = False
            raise GpsSimError(ErrorCode.DDI_UNAVAILABLE, cause=exc) from exc
        except Exception as exc:
            device.ddi_mounted = False
            error = classify(exc, default=ErrorCode.DDI_NOT_MOUNTED)
            # Il device bloccato è il caso di gran lunga più comune qui, e
            # pymobiledevice3 non lo riporta sempre con un'eccezione dedicata.
            if error.code is ErrorCode.INTERNAL and _looks_locked(exc):
                raise GpsSimError(ErrorCode.DEVICE_LOCKED, cause=exc) from exc
            raise error from exc

        device.ddi_mounted = True
        on_progress("Developer Disk Image montata.")

    async def _connect_rsd(self, pmd3: _Pmd3, tunnel: RsdTunnel, tunnel_info: TunnelInfo) -> Any:
        rsd = pmd3.RemoteServiceDiscoveryService((tunnel_info.address, tunnel_info.port))
        try:
            await rsd.connect()
        except Exception as exc:
            await tunnel.stop()
            raise GpsSimError(
                ErrorCode.TUNNEL_FAILED,
                message="Tunnel aperto, ma l'endpoint RSD non risponde.",
                hint="Riprova: se l'errore persiste, stacca e ricollega il cavo e "
                "assicurati che nessun altro tunnel sia attivo sullo stesso iPhone.",
                detail=tunnel.stderr_tail or None,
                cause=exc,
            ) from exc
        return rsd


_LOCK_MARKERS = ("locked", "passcode", "password", "unlock", "escrow", "deny")


def _looks_locked(exc: BaseException) -> bool:
    text = f"{type(exc).__name__} {exc}".lower()
    return any(marker in text for marker in _LOCK_MARKERS)
