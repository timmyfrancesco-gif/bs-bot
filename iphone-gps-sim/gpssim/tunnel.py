"""Gestione del tunnel RSD richiesto da iOS 17+.

Da iOS 17 i servizi da sviluppatore non sono più esposti da lockdownd: vanno
raggiunti tramite RemoteServiceDiscovery, che a sua volta vive dentro un tunnel
di rete verso il dispositivo. Creare quel tunnel significa creare
un'interfaccia di rete, quindi serve root/amministratore.

Invece di richiedere che tutta l'app girerà come root, il tunnel viene creato da
un processo separato — ``pymobiledevice3 lockdown start-tunnel --script-mode`` —
di cui catturiamo indirizzo e porta RSD dall'output. Quell'indirizzo viene poi
riusato per ogni comando successivo, e il processo resta vivo per tutta la
sessione: se muore, il tunnel cade e l'iPhone torna alla posizione reale.
Questo modulo è responsabile di accorgersene e di dirlo (callback
``on_lost``), mai di ignorarlo.
"""

from __future__ import annotations

import asyncio
import collections
import logging
import os
import re
import sys
from collections.abc import Awaitable, Callable, Sequence

from .errors import ErrorCode, GpsSimError
from .models import TunnelInfo

logger = logging.getLogger(__name__)

#: `--script-mode` stampa una sola riga: "<indirizzo> <porta>".
_SCRIPT_MODE_RE = re.compile(r"^\s*(?P<address>[0-9A-Fa-f:.%\-\w]+)\s+(?P<port>\d{1,5})\s*$")
#: Fallback sull'output leggibile, nel caso `--script-mode` sparisca o cambi.
_ADDRESS_RE = re.compile(r"RSD Address:\s*(?P<address>\S+)")
_PORT_RE = re.compile(r"RSD Port:\s*(?P<port>\d+)")

#: Comando che crea il tunnel. Sovrascrivibile: in un build congelato (fase 4)
#: `python -m pymobiledevice3` non esiste e va sostituito con l'eseguibile
#: impacchettato.
DEFAULT_TUNNEL_COMMAND: tuple[str, ...] = (sys.executable, "-m", "pymobiledevice3")


class TunnelOutputParser:
    """Estrae indirizzo e porta RSD dalle righe di output di `start-tunnel`.

    Riconosce sia `--script-mode` (una riga "<indirizzo> <porta>") sia l'output
    leggibile con "RSD Address:" e "RSD Port:" su righe separate.
    """

    def __init__(self) -> None:
        self._address: str | None = None
        self._port: int | None = None

    def feed(self, line: str) -> TunnelInfo | None:
        """Consuma una riga; restituisce il risultato appena è completo."""
        if (match := _SCRIPT_MODE_RE.match(line)) is not None:
            return TunnelInfo(address=match.group("address"), port=int(match.group("port")))

        if (found := _ADDRESS_RE.search(line)) is not None:
            self._address = found.group("address")
        if (found := _PORT_RE.search(line)) is not None:
            self._port = int(found.group("port"))
        if self._address is not None and self._port is not None:
            return TunnelInfo(address=self._address, port=self._port)
        return None

#: Frammenti di stderr che indicano un problema di privilegi anziché di device.
_PRIVILEGE_MARKERS = (
    "a password is required",
    "a terminal is required",
    "no tty present",
    "sudo: a password",
    "must be run as root",
    "requires root",
    "permission denied",
    "operation not permitted",
    "access is denied",
)

_LOST_CALLBACK = Callable[[GpsSimError], Awaitable[None] | None]


def is_privileged() -> bool:
    """`True` se il processo corrente può creare interfacce di rete."""
    if os.name == "nt":
        try:
            import ctypes

            return bool(ctypes.windll.shell32.IsUserAnAdmin())  # type: ignore[attr-defined]
        except Exception:  # pragma: no cover - dipende dalla piattaforma
            return False
    return getattr(os, "geteuid", lambda: 1)() == 0


class RsdTunnel:
    """Un tunnel RSD vivo, con il suo processo figlio e il suo watchdog.

    Uso tipico::

        tunnel = RsdTunnel(udid, on_lost=handler)
        info = await tunnel.start()
        ...  # info.address / info.port riusati per ogni comando
        await tunnel.stop()
    """

    def __init__(
        self,
        udid: str,
        *,
        on_lost: _LOST_CALLBACK | None = None,
        base_command: Sequence[str] | None = None,
        allow_sudo: bool = True,
        extra_args: Sequence[str] = (),
    ) -> None:
        self.udid = udid
        self.on_lost = on_lost
        self.base_command = tuple(base_command) if base_command else DEFAULT_TUNNEL_COMMAND
        self.allow_sudo = allow_sudo
        self.extra_args = tuple(extra_args)

        self.info: TunnelInfo | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._watchdog: asyncio.Task[None] | None = None
        self._stderr_reader: asyncio.Task[None] | None = None
        #: Ultime righe di stderr: sono la diagnosi quando il tunnel non parte.
        self._stderr_tail: collections.deque[str] = collections.deque(maxlen=40)
        self._stopping = False
        self._lost_reported = False

    # ------------------------------------------------------------------ #
    # Proprietà
    # ------------------------------------------------------------------ #

    @property
    def is_alive(self) -> bool:
        return self._process is not None and self._process.returncode is None

    @property
    def stderr_tail(self) -> str:
        return "\n".join(self._stderr_tail)

    # ------------------------------------------------------------------ #
    # Ciclo di vita
    # ------------------------------------------------------------------ #

    def _build_argv(self) -> list[str]:
        argv = [
            *self.base_command,
            "lockdown",
            "start-tunnel",
            "--script-mode",
            "--udid",
            self.udid,
            *self.extra_args,
        ]
        if os.name != "nt" and not is_privileged():
            if not self.allow_sudo:
                raise GpsSimError(
                    ErrorCode.INSUFFICIENT_PRIVILEGES,
                    detail="processo non privilegiato e sudo disabilitato",
                )
            # `-n`: mai chiedere la password interattivamente. Se serve, lo
            # scopriamo da stderr e lo diciamo con un messaggio chiaro invece di
            # bloccarci su un prompt che l'utente non vede.
            argv = ["sudo", "-n", "--", *argv]
        elif os.name == "nt" and not is_privileged():
            raise GpsSimError(
                ErrorCode.INSUFFICIENT_PRIVILEGES,
                hint="Chiudi l'app e riaprila con «Esegui come amministratore»: il "
                "tunnel RSD di iOS 17+ crea un'interfaccia di rete.",
            )
        return argv

    async def start(self, timeout: float = 60.0) -> TunnelInfo:
        """Avvia il tunnel e restituisce indirizzo e porta RSD.

        :param timeout: quanto attendere la riga con indirizzo e porta. Il default
            è generoso perché al primo avvio l'iPhone può chiedere l'autorizzazione.
        :raises GpsSimError: con codice ``INSUFFICIENT_PRIVILEGES``,
            ``TUNNEL_UNSUPPORTED_PLATFORM`` o ``TUNNEL_FAILED``.
        """
        if self.is_alive:
            assert self.info is not None
            return self.info

        argv = self._build_argv()
        logger.debug("avvio tunnel: %s", " ".join(argv))
        try:
            self._process = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.DEVNULL,
            )
        except FileNotFoundError as exc:
            raise GpsSimError(
                ErrorCode.TUNNEL_FAILED,
                message="Non trovo l'eseguibile necessario per creare il tunnel.",
                hint=f"Manca `{argv[0]}` nel PATH. Reinstalla le dipendenze del progetto.",
                cause=exc,
            ) from exc

        self._stderr_reader = asyncio.create_task(self._drain_stderr(), name="rsd-tunnel-stderr")

        try:
            self.info = await asyncio.wait_for(self._read_tunnel_info(), timeout)
        except asyncio.TimeoutError as exc:
            await self._kill_process()
            raise GpsSimError(
                ErrorCode.TUNNEL_FAILED,
                message="Il tunnel RSD non si è aperto entro il tempo previsto.",
                hint="Sblocca l'iPhone e conferma l'autorizzazione del computer, "
                "poi riprova. Se un altro tunnel è già attivo, chiudilo prima.",
                detail=self.stderr_tail or None,
                cause=exc,
            ) from exc
        except GpsSimError:
            await self._kill_process()
            raise
        except Exception as exc:  # pragma: no cover - difensivo
            await self._kill_process()
            raise GpsSimError(
                ErrorCode.TUNNEL_FAILED, detail=self.stderr_tail or None, cause=exc
            ) from exc

        self.info.pid = self._process.pid
        self._watchdog = asyncio.create_task(self._watch_process(), name="rsd-tunnel-watchdog")
        logger.info("tunnel RSD attivo su [%s]:%d (pid %s)", self.info.address, self.info.port, self.info.pid)
        return self.info

    async def stop(self) -> None:
        """Chiude il tunnel. Idempotente, e non segnala la chiusura come «caduta»."""
        self._stopping = True
        if self._watchdog is not None:
            self._watchdog.cancel()
            self._watchdog = None
        await self._kill_process()
        if self._stderr_reader is not None:
            self._stderr_reader.cancel()
            self._stderr_reader = None
        self.info = None

    # ------------------------------------------------------------------ #
    # Interni
    # ------------------------------------------------------------------ #

    async def _read_tunnel_info(self) -> TunnelInfo:
        """Legge stdout finché non trova indirizzo e porta RSD."""
        assert self._process is not None and self._process.stdout is not None
        parser = TunnelOutputParser()

        while True:
            raw = await self._process.stdout.readline()
            if not raw:
                # stdout chiuso: il processo è morto senza darci il tunnel.
                await self._process.wait()
                raise self._diagnose_startup_failure()

            line = raw.decode(errors="replace").rstrip("\r\n")
            if line:
                logger.debug("tunnel stdout: %s", line)
            if (info := parser.feed(line)) is not None:
                return info

    async def _drain_stderr(self) -> None:
        """Tiene stderr svuotato (altrimenti la pipe si riempie e il figlio si blocca)
        e conserva le ultime righe per la diagnosi."""
        assert self._process is not None and self._process.stderr is not None
        while True:
            raw = await self._process.stderr.readline()
            if not raw:
                return
            line = raw.decode(errors="replace").rstrip("\r\n")
            if line:
                self._stderr_tail.append(line)
                logger.debug("tunnel stderr: %s", line)

    def _diagnose_startup_failure(self) -> GpsSimError:
        """Trasforma l'output del processo morto nell'errore più utile possibile."""
        assert self._process is not None
        blob = self.stderr_tail.lower()
        returncode = self._process.returncode

        if any(marker in blob for marker in _PRIVILEGE_MARKERS):
            return GpsSimError(
                ErrorCode.INSUFFICIENT_PRIVILEGES,
                detail=self.stderr_tail or f"exit code {returncode}",
            )
        if "failed to start the tunnel on your platform" in blob or "notimplementederror" in blob:
            return GpsSimError(
                ErrorCode.TUNNEL_UNSUPPORTED_PLATFORM,
                detail=self.stderr_tail or f"exit code {returncode}",
            )
        if "no module named pymobiledevice3" in blob:
            return GpsSimError(ErrorCode.PYMOBILEDEVICE3_MISSING, detail=self.stderr_tail)
        if "developer mode" in blob:
            return GpsSimError(ErrorCode.DEVELOPER_MODE_OFF, detail=self.stderr_tail)
        if "passcode" in blob or "password" in blob or "unlock" in blob:
            return GpsSimError(ErrorCode.DEVICE_LOCKED, detail=self.stderr_tail)
        if "no device" in blob or "device not found" in blob or "nodeviceconnected" in blob:
            return GpsSimError(ErrorCode.NO_DEVICE, detail=self.stderr_tail)
        if "not paired" in blob or "trust" in blob:
            return GpsSimError(ErrorCode.NOT_PAIRED, detail=self.stderr_tail)
        return GpsSimError(
            ErrorCode.TUNNEL_FAILED,
            detail=self.stderr_tail or f"exit code {returncode}",
        )

    async def _watch_process(self) -> None:
        """Se il processo del tunnel muore mentre stiamo lavorando, la posizione
        sull'iPhone torna reale: va segnalato subito, non al prossimo comando."""
        assert self._process is not None
        returncode = await self._process.wait()
        if self._stopping:
            return
        logger.warning("il processo del tunnel RSD è terminato (exit %s)", returncode)
        await self._report_lost(
            GpsSimError(
                ErrorCode.TUNNEL_LOST,
                detail=self.stderr_tail or f"exit code {returncode}",
            )
        )

    async def _report_lost(self, error: GpsSimError) -> None:
        if self._lost_reported or self.on_lost is None:
            self._lost_reported = True
            return
        self._lost_reported = True
        try:
            result = self.on_lost(error)
            if asyncio.iscoroutine(result):
                await result
        except Exception:  # pragma: no cover - il callback non deve propagare
            logger.exception("callback on_lost del tunnel ha sollevato un'eccezione")

    async def _kill_process(self) -> None:
        process = self._process
        self._process = None
        if process is None or process.returncode is not None:
            return
        try:
            process.terminate()
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(process.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("il tunnel non ha risposto a SIGTERM, invio SIGKILL")
            try:
                process.kill()
            except ProcessLookupError:
                return
            await process.wait()
