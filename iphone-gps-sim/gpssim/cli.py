"""Riga di comando: diagnostica del core e avvio dell'interfaccia.

I comandi `devices`, `doctor`, `tunnel`, `set` e `clear` esercitano il core senza
UI — servono a capire perché un dispositivo non collabora. `serve` e `app` avviano
l'interfaccia vera, rispettivamente nel browser e in una finestra nativa.

    python -m gpssim devices
    python -m gpssim doctor
    python -m gpssim tunnel
    python -m gpssim set 45.4642 9.1900 --hold 30
    python -m gpssim clear
    python -m gpssim serve --open
    python -m gpssim app
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import signal
import sys

from .device import DeviceManager
from .errors import ErrorCode, GpsSimError
from .location import LocationSession
from .models import KEEPALIVE_INTERVAL, Coordinate, SessionState, Status
from .server import DEFAULT_HOST, DEFAULT_PORT
from .tunnel import RsdTunnel, is_privileged

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_INTERRUPTED = 130

_STATE_LABEL = {
    SessionState.IDLE: "inattivo",
    SessionState.PREPARING: "preparazione",
    SessionState.READY: "pronto",
    SessionState.SIMULATING: "simulazione attiva",
    SessionState.LOST: "COLLEGAMENTO PERSO",
    SessionState.ERROR: "errore",
}


def _print(message: str) -> None:
    print(message, flush=True)


def _print_error(error: GpsSimError) -> None:
    print(f"\n✗ {error.message}", file=sys.stderr, flush=True)
    print(f"  → {error.hint}", file=sys.stderr, flush=True)
    if error.detail:
        print(f"  dettaglio: {error.detail}", file=sys.stderr, flush=True)


def _on_status(status: Status) -> None:
    label = _STATE_LABEL.get(status.state, status.state.value)
    line = f"[{label}]"
    if status.message:
        line += f" {status.message}"
    _print(line)
    if status.state is SessionState.LOST and status.error:
        _print(f"  → {status.error['hint']}")


# --------------------------------------------------------------------------- #
# Comandi
# --------------------------------------------------------------------------- #


async def cmd_devices(args: argparse.Namespace) -> int:
    devices = await DeviceManager(allow_sudo=not args.no_sudo).list_devices()
    if not devices:
        _print("Nessun iPhone collegato via USB.")
        return EXIT_ERROR

    for device in devices:
        developer_mode = {True: "attiva", False: "DISATTIVATA", None: "n/d"}[device.developer_mode]
        _print(
            f"{device.name}\n"
            f"  UDID:            {device.udid}\n"
            f"  iOS:             {device.ios_version} ({device.product_type})\n"
            f"  connessione:     {device.connection_type}\n"
            f"  dev mode:        {developer_mode}\n"
            f"  tunnel RSD:      {'necessario' if device.needs_tunnel else 'non necessario'}"
        )
    return EXIT_OK


async def cmd_doctor(args: argparse.Namespace) -> int:
    """Passa in rassegna tutti i prerequisiti e dice quale manca."""
    _print(f"privilegi:         {'root/admin' if is_privileged() else 'utente normale (servirà sudo)'}")

    manager = DeviceManager(allow_sudo=not args.no_sudo)
    try:
        devices = await manager.list_devices()
    except GpsSimError as error:
        _print_error(error)
        return EXIT_ERROR

    _print(f"usbmuxd:           ok, {len(devices)} dispositivo/i")
    if not devices:
        _print_error(GpsSimError(ErrorCode.NO_DEVICE))
        return EXIT_ERROR

    session = LocationSession(
        manager=manager,
        preferred_backend=args.backend,
        auto_recover=False,
    )
    try:
        await session.connect(args.udid, on_progress=lambda message: _print(f"  … {message}"))
    except GpsSimError as error:
        _print_error(error)
        return EXIT_ERROR

    status = session.status
    assert status.device is not None
    _print(f"dispositivo:       {status.device.name} — iOS {status.device.ios_version}")
    _print(f"dev mode:          {status.device.developer_mode}")
    _print(f"DDI montata:       {status.device.ddi_mounted}")
    if status.tunnel:
        _print(f"tunnel RSD:        [{status.tunnel.address}]:{status.tunnel.port} (pid {status.tunnel.pid})")
    else:
        _print("tunnel RSD:        non necessario su questa versione di iOS")
    _print(f"backend posizione: {status.backend}")
    _print("\n✓ Tutto pronto per simulare la posizione.")

    await session.disconnect()
    return EXIT_OK


async def cmd_tunnel(args: argparse.Namespace) -> int:
    """Apre solo il tunnel e ne stampa le coordinate, tenendolo vivo."""
    manager = DeviceManager(allow_sudo=not args.no_sudo)
    devices = await manager.list_devices()
    udid = args.udid or (devices[0].udid if devices else None)
    if udid is None:
        _print_error(GpsSimError(ErrorCode.NO_DEVICE))
        return EXIT_ERROR

    lost: asyncio.Future[GpsSimError] = asyncio.get_running_loop().create_future()

    def on_lost(error: GpsSimError) -> None:
        if not lost.done():
            lost.set_result(error)

    tunnel = RsdTunnel(udid, on_lost=on_lost, allow_sudo=not args.no_sudo)
    try:
        info = await tunnel.start()
    except GpsSimError as error:
        _print_error(error)
        return EXIT_ERROR

    _print(f"RSD Address: {info.address}")
    _print(f"RSD Port:    {info.port}")
    _print(f"pid:         {info.pid}")
    _print("\nTunnel attivo. Ctrl-C per chiudere.")
    shutdown = asyncio.ensure_future(args.shutdown.wait())
    done, pending = await asyncio.wait({lost, shutdown}, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    await tunnel.stop()
    if lost in done:
        _print_error(lost.result())
        return EXIT_ERROR
    _print("Tunnel chiuso.")
    return EXIT_OK


async def cmd_set(args: argparse.Namespace) -> int:
    try:
        coordinate = Coordinate(args.latitude, args.longitude)
    except ValueError as exc:
        _print(f"✗ Coordinate non valide: {exc}")
        return EXIT_ERROR

    session = LocationSession(
        manager=DeviceManager(allow_sudo=not args.no_sudo),
        keepalive_interval=args.interval,
        auto_recover=not args.no_recover,
        preferred_backend=args.backend,
    )
    session.add_listener(_on_status)

    try:
        await session.connect(args.udid)
        await session.set_location(coordinate)
    except GpsSimError as error:
        _print_error(error)
        return EXIT_ERROR

    _print(
        f"\nKeep-alive ogni {args.interval}s. "
        + (f"Mantengo per {args.hold}s." if args.hold else "Ctrl-C per ripristinare la posizione reale.")
    )

    if args.hold:
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(args.shutdown.wait(), timeout=args.hold)
    else:
        await args.shutdown.wait()
    if args.shutdown.is_set():
        _print("\nInterruzione richiesta.")

    if args.keep:
        _print(
            "Lascio l'override attivo (--keep). Attenzione: da iOS 18 la posizione "
            "torna reale appena il canale si chiude."
        )
        return EXIT_OK

    with contextlib.suppress(GpsSimError):
        await session.restore_real_location()
    await session.disconnect()
    return EXIT_OK


async def cmd_clear(args: argparse.Namespace) -> int:
    """Ripristina la posizione reale su un dispositivo già preparato."""
    session = LocationSession(
        manager=DeviceManager(allow_sudo=not args.no_sudo),
        auto_recover=False,
        preferred_backend=args.backend,
    )
    session.add_listener(_on_status)
    try:
        await session.connect(args.udid)
        await session.restore_real_location()
    except GpsSimError as error:
        _print_error(error)
        return EXIT_ERROR
    await session.disconnect()
    _print("✓ Posizione reale ripristinata.")
    return EXIT_OK


async def cmd_serve(args: argparse.Namespace) -> int:
    """Avvia API e interfaccia web, senza aprire una finestra."""
    from .api import create_app
    from .server import pick_port, serve

    port = args.port if args.port is not None else pick_port(args.host)
    session = LocationSession(
        manager=DeviceManager(allow_sudo=not args.no_sudo),
        preferred_backend=args.backend,
    )
    app = create_app(session=session)

    url = f"http://{args.host}:{port}"
    _print(f"Interfaccia disponibile su {url}")
    _print("Ctrl-C per chiudere (la posizione reale viene ripristinata).")
    if args.open:
        import webbrowser

        webbrowser.open(url)

    # I segnali sono di uvicorn (vedi `owns_signals` nel parser): installare anche
    # i nostri handler non funzionerebbe, perché uvicorn li sostituisce quando
    # `serve()` parte, e Ctrl-C finirebbe nel vuoto. Alla sua uscita graziosa
    # scatta lo shutdown dell'app, che è dove la posizione reale viene
    # ripristinata e il tunnel chiuso.
    try:
        await serve(app, host=args.host, port=port, log_level="info" if args.verbose else "warning")
    except Exception as exc:
        _print(f"✗ Il server locale si è fermato: {exc}")
        await session.disconnect()
        return EXIT_ERROR

    _print("Chiusura completata.")
    # Difensivo: se `serve()` è morta prima dell'avvio, il lifespan non è passato.
    await session.disconnect()
    return EXIT_OK


def cmd_app(args: argparse.Namespace) -> int:
    """Apre la finestra nativa. Sincrona: pywebview vuole il thread principale."""
    from .desktop import PywebviewUnavailableError, run_desktop

    try:
        run_desktop(host=args.host, port=args.port, allow_sudo=not args.no_sudo, debug=args.verbose > 1)
    except PywebviewUnavailableError as error:
        print(f"\n✗ {error}", file=sys.stderr)
        return EXIT_ERROR
    return EXIT_OK


# --------------------------------------------------------------------------- #
# Parser
# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gpssim",
        description="Simulatore di posizione GPS per iPhone collegato via USB.",
    )
    parser.add_argument("--udid", help="UDID del dispositivo (default: il primo iPhone USB)")
    parser.add_argument("-v", "--verbose", action="count", default=0, help="log più dettagliati (ripetibile)")
    parser.add_argument(
        "--backend",
        choices=("dvt", "simulatelocation"),
        help="forza un backend invece di scegliere automaticamente",
    )
    parser.add_argument(
        "--no-sudo",
        action="store_true",
        help="non provare a elevare con sudo: se servono privilegi, fallisci subito",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("devices", help="elenca gli iPhone collegati").set_defaults(handler=cmd_devices)
    subparsers.add_parser("doctor", help="verifica tutti i prerequisiti").set_defaults(handler=cmd_doctor)
    subparsers.add_parser("tunnel", help="apri il tunnel RSD e stampa indirizzo e porta").set_defaults(
        handler=cmd_tunnel
    )

    set_parser = subparsers.add_parser("set", help="imposta una posizione e tienila con il keep-alive")
    set_parser.add_argument("latitude", type=float)
    set_parser.add_argument("longitude", type=float)
    set_parser.add_argument(
        "--hold",
        type=float,
        help="secondi da mantenere prima di uscire (default: indefinito)",
    )
    set_parser.add_argument(
        "--interval",
        type=float,
        default=KEEPALIVE_INTERVAL,
        help=f"intervallo del keep-alive in secondi (default: {KEEPALIVE_INTERVAL})",
    )
    set_parser.add_argument(
        "--no-recover",
        action="store_true",
        help="non riconnettere automaticamente dopo una caduta",
    )
    set_parser.add_argument(
        "--keep",
        action="store_true",
        help="non ripristinare la posizione reale all'uscita",
    )
    set_parser.set_defaults(handler=cmd_set)

    subparsers.add_parser("clear", help="ripristina la posizione reale").set_defaults(handler=cmd_clear)

    for name, help_text, handler in (
        ("serve", "avvia API e interfaccia web nel browser", cmd_serve),
        ("app", "apri l'app in una finestra nativa (pywebview)", cmd_app),
    ):
        web_parser = subparsers.add_parser(name, help=help_text)
        web_parser.add_argument(
            "--host",
            default=DEFAULT_HOST,
            help=f"indirizzo di ascolto (default: {DEFAULT_HOST})",
        )
        web_parser.add_argument(
            "--port",
            type=int,
            help=f"porta (default: {DEFAULT_PORT}, o una libera se occupata)",
        )
        if name == "serve":
            web_parser.add_argument("--open", action="store_true", help="apri il browser all'avvio")
        # uvicorn installa i propri handler di SIGINT/SIGTERM e sovrascrive i
        # nostri: per `serve` i segnali sono suoi, altrimenti Ctrl-C non arriva
        # a nessuno dei due.
        web_parser.set_defaults(handler=handler, owns_signals=True)

    return parser


def _configure_logging(verbosity: int) -> None:
    level = {0: logging.WARNING, 1: logging.INFO}.get(verbosity, logging.DEBUG)
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    if verbosity < 2:
        # pymobiledevice3 è molto verboso a livello INFO.
        logging.getLogger("pymobiledevice3").setLevel(logging.WARNING)


async def _run(args: argparse.Namespace) -> int:
    # Ctrl-C imposta un evento invece di cancellare il task: i comandi lo
    # aspettano e possono ripristinare la posizione reale prima di uscire, senza
    # dover gestire la propagazione di CancelledError.
    args.shutdown = asyncio.Event()
    if getattr(args, "owns_signals", False):
        return await args.handler(args)

    loop = asyncio.get_running_loop()
    for signal_name in ("SIGINT", "SIGTERM"):
        handled_signal = getattr(signal, signal_name, None)
        if handled_signal is None:
            continue
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(handled_signal, args.shutdown.set)

    return await args.handler(args)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    _configure_logging(args.verbose)
    try:
        # `app` è sincrono di proposito: pywebview deve stare sul thread
        # principale, quindi il server gli gira accanto in un thread di servizio.
        if not asyncio.iscoroutinefunction(args.handler):
            return args.handler(args)
        return asyncio.run(_run(args))
    except KeyboardInterrupt:
        return EXIT_INTERRUPTED
    except asyncio.CancelledError:
        return EXIT_INTERRUPTED
    except GpsSimError as error:
        _print_error(error)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
