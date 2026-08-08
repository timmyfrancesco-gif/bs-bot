"""Avvio del server locale, in primo piano o in un thread di servizio.

Il binding è sempre su ``127.0.0.1``: l'app controlla un iPhone collegato al
computer, non è un servizio da esporre in rete.
"""

from __future__ import annotations

import asyncio
import logging
import socket
import threading
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # importare FastAPI qui terrebbe fastapi tra le dipendenze del
    # core della fase 1, che non ne ha bisogno: serve solo per le annotazioni.
    from fastapi import FastAPI

logger = logging.getLogger(__name__)

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765


def pick_port(host: str = DEFAULT_HOST, preferred: int = DEFAULT_PORT) -> int:
    """Restituisce ``preferred`` se è libera, altrimenti una porta a caso.

    Una porta fissa rende l'URL prevedibile (comodo per il browser); ma se è
    occupata — tipicamente da una seconda istanza dell'app — è meglio partire su
    un'altra che non partire affatto.
    """
    for candidate in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind((host, candidate))
            except OSError:
                logger.info("porta %d occupata, ne cerco una libera", candidate)
                continue
            return probe.getsockname()[1]
    raise OSError("nessuna porta disponibile su " + host)  # pragma: no cover


def _build_config(app: FastAPI, host: str, port: int, log_level: str) -> Any:
    import uvicorn

    return uvicorn.Config(
        app,
        host=host,
        port=port,
        log_level=log_level,
        access_log=False,
        # Lo stream SSE resta aperto per tutta la sessione: senza questo uvicorn
        # lo chiuderebbe dopo il timeout di keep-alive di default.
        timeout_keep_alive=3600,
    )


async def serve(
    app: FastAPI,
    *,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    log_level: str = "warning",
) -> None:
    """Serve l'app nel loop corrente, fino a interruzione."""
    import uvicorn

    await uvicorn.Server(_build_config(app, host, port, log_level)).serve()


class BackgroundServer:
    """Il server in un thread dedicato, con il suo event loop.

    Serve al wrapper desktop: pywebview deve stare sul thread principale, quindi
    l'API non può girarci. La sessione con l'iPhone vive interamente nel loop di
    questo thread.
    """

    def __init__(
        self,
        app_factory: Callable[[], FastAPI],
        *,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
        log_level: str = "warning",
    ) -> None:
        self.app_factory = app_factory
        self.host = host
        self.port = port
        self.log_level = log_level

        self._server: Any = None
        self._thread: threading.Thread | None = None
        self._error: BaseException | None = None

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def start(self, timeout: float = 30.0) -> str:
        """Avvia il server e attende che accetti connessioni. Restituisce l'URL."""
        import uvicorn

        # L'app (e con essa la sessione) viene costruita nel thread del server,
        # così tutti gli oggetti asyncio nascono nel loop che li userà.
        def run() -> None:
            try:
                app = self.app_factory()
                self._server = uvicorn.Server(
                    _build_config(app, self.host, self.port, self.log_level)
                )
                asyncio.run(self._server.serve())
            except BaseException as exc:  # noqa: BLE001 - riportato al chiamante
                self._error = exc
                logger.exception("il server è terminato con un errore")

        self._thread = threading.Thread(target=run, name="gpssim-server", daemon=True)
        self._thread.start()

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._error is not None:
                raise RuntimeError("il server locale non è partito") from self._error
            if self._server is not None and getattr(self._server, "started", False):
                return self.url
            time.sleep(0.05)
        self.stop()
        raise TimeoutError(f"il server locale non ha risposto entro {timeout:.0f}s")

    def stop(self, timeout: float = 15.0) -> None:
        """Chiede l'uscita e attende il thread.

        L'attesa non è una formalità: è nello shutdown dell'app che la posizione
        reale viene ripristinata e il tunnel chiuso.
        """
        if self._server is not None:
            self._server.should_exit = True
        if self._thread is not None:
            self._thread.join(timeout)
            if self._thread.is_alive():
                logger.warning("il thread del server non si è chiuso entro %.0fs", timeout)
            self._thread = None
        self._server = None
