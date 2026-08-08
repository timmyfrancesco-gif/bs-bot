"""Wrapper desktop: la stessa UI web, dentro una finestra nativa.

``pywebview`` deve girare sul thread principale, quindi il server HTTP va in un
thread di servizio (:class:`gpssim.server.BackgroundServer`). Alla chiusura della
finestra il server viene fermato e il suo shutdown ripristina la posizione reale.
"""

from __future__ import annotations

import logging
from typing import Any

from .api import create_app
from .location import LocationSession
from .server import DEFAULT_HOST, BackgroundServer, pick_port

logger = logging.getLogger(__name__)

WINDOW_TITLE = "Simulatore GPS iPhone"


class PywebviewUnavailableError(RuntimeError):
    """pywebview non è installato o non trova un motore di rendering."""

    def __init__(self, cause: BaseException | None = None) -> None:
        super().__init__(
            "pywebview non è disponibile.\n"
            "Installalo con `pip install pywebview` (su Linux serve anche "
            "python3-gi e gir1.2-webkit2-4.1), oppure usa `python -m gpssim serve` "
            "e apri l'indirizzo nel browser."
        )
        if cause is not None:
            self.__cause__ = cause


def run_desktop(
    *,
    host: str = DEFAULT_HOST,
    port: int | None = None,
    allow_sudo: bool = True,
    width: int = 1280,
    height: int = 820,
    debug: bool = False,
) -> None:
    """Apre la finestra dell'app. Ritorna quando l'utente la chiude."""
    try:
        import webview
    except ImportError as exc:
        raise PywebviewUnavailableError(exc) from exc

    from .device import DeviceManager

    resolved_port = port or pick_port(host)

    def app_factory() -> Any:
        return create_app(session=LocationSession(manager=DeviceManager(allow_sudo=allow_sudo)))

    server = BackgroundServer(app_factory, host=host, port=resolved_port)
    url = server.start()
    logger.info("server locale su %s", url)

    try:
        webview.create_window(
            WINDOW_TITLE,
            url,
            width=width,
            height=height,
            min_size=(960, 640),
        )
        webview.start(debug=debug)
    except Exception as exc:
        # Su Linux l'errore tipico è "no supported GUI toolkit": è un problema di
        # ambiente, non dell'app, e la via d'uscita è il browser.
        raise PywebviewUnavailableError(exc) from exc
    finally:
        server.stop()
