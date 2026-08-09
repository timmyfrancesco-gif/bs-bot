#!/usr/bin/env python3
"""Verifica l'interfaccia con un browser reale, contro una sessione finta.

Non fa parte della suite `unittest`: richiede Playwright e un Chromium, che sono
una dipendenza pesante per un progetto il cui cuore è altrove. Ma il frontend non
è testabile a occhio, e questo script ha già trovato due difetti che nessun test
Python avrebbe visto — un segnaposto che spariva invece di diventare rosso alla
caduta del tunnel, e un `display: flex` che vinceva sull'attributo ``hidden``
tenendo il banner d'errore sempre a schermo.

    pip install playwright && playwright install chromium
    python tools/ui_check.py [--headed] [--screenshots CARTELLA] [--chromium PERCORSO]

Esce con 0 se il percorso completo funziona e non ci sono errori JavaScript.
I tile di OpenStreetMap non vengono contati: senza rete la mappa resta grigia, e
non è quello che stiamo verificando.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from gpssim.api import create_app  # noqa: E402
from gpssim.errors import ErrorCode, GpsSimError  # noqa: E402
from gpssim.models import Coordinate, SessionState, Status  # noqa: E402
from gpssim.server import BackgroundServer, pick_port  # noqa: E402
from tests.test_api import FakeGeocoder, FakeRouter, FakeSession  # noqa: E402


class FlakySession(FakeSession):
    """Come `FakeSession`, ma il tunnel "cade" da solo poco dopo `set_location`.

    La caduta viene emessa dall'interno del loop del server: è esattamente il
    percorso di un evento non richiesto, quello che solo il push SSE può
    raccontare al frontend.
    """

    DROP_AFTER = 0.6

    async def set_location(self, coordinate: Coordinate) -> Status:
        status = await super().set_location(coordinate)
        status.last_push_at = time.time()
        status.last_push_ok = True
        asyncio.create_task(self._drop(coordinate))
        return status

    async def _drop(self, coordinate: Coordinate) -> None:
        await asyncio.sleep(self.DROP_AFTER)
        self.emit(
            Status(
                state=SessionState.LOST,
                target=coordinate,
                real_location=True,
                last_push_at=time.time() - 4.0,
                message="Collegamento perso: l'iPhone mostra di nuovo la posizione reale.",
                error=GpsSimError(ErrorCode.TUNNEL_LOST).to_dict(),
            )
        )


def _is_tile(url: str) -> bool:
    """I tile di OpenStreetMap non caricano senza rete: non è un difetto nostro."""
    return "tile.openstreetmap.org" in url


class Checker:
    """Raccoglie le asserzioni invece di fermarsi alla prima: un report completo
    è più utile di un fallimento isolato."""

    def __init__(self) -> None:
        self.failures: list[str] = []

    def check(self, description: str, condition: bool, detail: str = "") -> None:
        mark = "✓" if condition else "✗"
        suffix = f"  ({detail})" if detail else ""
        print(f"  {mark} {description}{suffix}")
        if not condition:
            self.failures.append(description)


async def run(headed: bool, screenshots: Path | None, chromium: Path | None) -> int:
    from playwright.async_api import async_playwright

    session = FlakySession()
    server = BackgroundServer(
        lambda: create_app(session=session, geocoder=FakeGeocoder(), router=FakeRouter()),
        port=pick_port(preferred=0),
    )
    url = await asyncio.to_thread(server.start)
    print(f"server locale su {url}\n")

    checker = Checker()
    js_errors: list[str] = []
    failed_requests: list[str] = []

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            headless=not headed,
            executable_path=str(chromium) if chromium else None,
        )
        page = await browser.new_page(viewport={"width": 1280, "height": 820})
        page.on("pageerror", lambda exc: js_errors.append(f"pageerror: {exc}"))
        # Il testo del messaggio non contiene l'URL: la sorgente sta in
        # `location`, ed è l'unico modo per distinguere un errore del nostro
        # codice dal fallimento di un tile.
        page.on(
            "console",
            lambda message: js_errors.append(f"console.error: {message.text}")
            if message.type == "error" and not _is_tile(message.location.get("url", ""))
            else None,
        )
        page.on(
            "requestfailed",
            lambda request: failed_requests.append(f"{request.method} {request.url}")
            if not _is_tile(request.url)
            else None,
        )

        async def snap(name: str) -> None:
            if screenshots is not None:
                await page.screenshot(path=str(screenshots / f"{name}.png"))

        async def text(selector: str) -> str:
            return (await page.locator(selector).inner_text()).strip()

        async def enabled(selector: str) -> bool:
            return await page.locator(selector).is_enabled()

        async def visible(selector: str) -> bool:
            return await page.locator(selector).is_visible()

        async def count(selector: str) -> int:
            return await page.locator(selector).count()

        async def wait_state(fragment: str, timeout: float = 10_000) -> None:
            await page.wait_for_function(
                f"document.querySelector('#state-pill').textContent.includes('{fragment}')",
                timeout=timeout,
            )

        # ---------------------------------------------------------------- avvio
        print("avvio")
        await page.goto(url, wait_until="domcontentloaded")
        await page.wait_for_selector(".leaflet-container")
        await page.wait_for_function("document.querySelectorAll('#device-select option').length > 0")

        checker.check("la mappa si inizializza", await count(".leaflet-container") == 1)
        checker.check("il dispositivo compare in elenco", "iOS 18.2" in await text("#device-select option"))
        checker.check("lo stato parte da inattivo", (await text("#state-pill")).lower() == "inattivo")
        checker.check("il badge dice «posizione reale»", await text("#location-badge") == "posizione reale")
        checker.check("«applica» è disabilitato senza selezione", not await enabled("#apply"))
        checker.check("«ripristina» è disabilitato senza sessione", not await enabled("#restore"))
        # Regressione: `.alert { display: flex }` batteva l'attributo `hidden`.
        checker.check("il banner d'errore è nascosto", not await visible("#alert"))
        checker.check("i risultati di ricerca sono nascosti", not await visible("#search-results"))
        checker.check("l'indicatore keep-alive è nascosto", not await visible("#keepalive"))
        await snap("01-avvio")

        # -------------------------------------------------------------- ricerca
        print("\nricerca indirizzo")
        await page.fill("#search-input", "milano")
        await page.click("#search-button")
        await page.wait_for_selector("#search-results li:not(.results__empty)")
        await page.locator("#search-results li:not(.results__empty)").first.click()

        latitude = await page.input_value("#lat-input")
        checker.check("il risultato riempie le coordinate", latitude.startswith("45.4642"), latitude)
        checker.check("compare il segnaposto di selezione", await count(".leaflet-marker-icon") == 1)
        checker.check("l'etichetta del luogo è mostrata", "Milano" in await text("#selection-label"))
        checker.check("«applica» resta disabilitato senza sessione", not await enabled("#apply"))
        await snap("02-ricerca")

        # ----------------------------------------------------------- connessione
        print("\nconnessione")
        await page.click("#connect")
        await wait_state("pronto")

        checker.check("la barra mostra il tunnel RSD", "49152" in await text("#tunnel-info"))
        checker.check("la barra mostra il backend", "backend" in await text("#backend-info"))
        checker.check("il selettore si blocca a sessione aperta", not await enabled("#device-select"))
        checker.check("«applica» si abilita", await enabled("#apply"))
        checker.check("«ripristina» resta disabilitato senza override", not await enabled("#restore"))

        # ------------------------------------------------------------ simulazione
        print("\nsimulazione")
        await page.click("#apply")
        await wait_state("simulazione")

        checker.check("il badge passa a «simulata»", "simulata" in await text("#location-badge"))
        checker.check("compare il segnaposto attivo", await count(".marker-active") == 1)
        checker.check("l'indicatore keep-alive è visibile", await visible("#keepalive"))
        checker.check("«ripristina» si abilita", await enabled("#restore"))
        checker.check("nessun banner d'errore", not await visible("#alert"))
        await snap("03-simulazione")

        # ------------------------------------------------------ caduta del tunnel
        print("\ncaduta del tunnel (evento non richiesto, via SSE)")
        await wait_state("perso")

        checker.check("il badge torna a dichiarare la posizione reale",
                      "reale" in await text("#location-badge"))
        checker.check("il banner spiega cos'è successo", await visible("#alert"))
        checker.check("il banner nomina il tunnel", "tunnel" in (await text("#alert-message")).lower())
        checker.check("il banner dà un suggerimento", bool(await text("#alert-hint")))
        # Regressione: il segnaposto attivo spariva invece di diventare rosso.
        checker.check("il segnaposto attivo diventa rosso",
                      await count(".marker-active--lost") == 1)
        await asyncio.sleep(1.0)
        keepalive = await text("#keepalive-text")
        checker.check("il keep-alive è dichiarato fermo", "fermo" in keepalive, keepalive)
        await snap("04-tunnel-caduto")

        # ---------------------------------------------------------- ripristino
        print("\nripristino della posizione reale")
        await page.click("#restore")
        await wait_state("pronto")

        badge = await text("#location-badge")
        checker.check("il badge torna a «posizione reale»", badge == "posizione reale", badge)
        checker.check("il segnaposto attivo viene rimosso", await count(".marker-active") == 0)
        checker.check("il banner si richiude", not await visible("#alert"))
        await snap("05-ripristinato")

        # ------------------------------------------------------------ giro città
        print("\ngiro città")
        checker.check(
            "«Genera il giro» è disabilitato senza un luogo scelto", not await enabled("#tour-plan")
        )

        await page.fill("#tour-city", "milano")
        await page.click("#tour-search-button")
        await page.wait_for_selector("#tour-results li:not(.results__empty)")
        await page.locator("#tour-results li:not(.results__empty)").first.click()
        checker.check("scegliere un risultato abilita «Genera il giro»", await enabled("#tour-plan"))

        await page.click("#tour-plan")
        await page.wait_for_function(
            "document.querySelector('#tour-stats').textContent.includes('km')", timeout=8000
        )
        checker.check("le statistiche del giro sono mostrate", "km" in await text("#tour-stats"))
        checker.check("il tracciato è disegnato sulla mappa", await count(".leaflet-interactive") >= 1)
        checker.check("«Avvia il giro» si abilita dopo la pianificazione", await enabled("#tour-play"))
        await snap("06-giro-pianificato")

        await page.click("#tour-play")
        await wait_state("simulazione")
        checker.check("la barra mostra l'avanzamento del giro", await visible("#route-info"))
        route_info = await text("#route-info")
        checker.check("l'avanzamento nomina la città", "Milano" in route_info, route_info)
        checker.check("«Ferma il giro» sostituisce «Avvia il giro»", await visible("#tour-stop"))
        await snap("07-giro-avviato")

        await page.click("#tour-stop")
        await page.wait_for_function("document.getElementById('route-info').hidden === true", timeout=5000)
        checker.check("fermare il giro nasconde l'avanzamento", not await visible("#route-info"))
        checker.check("«Avvia il giro» ricompare dopo lo stop", await visible("#tour-play"))

        await browser.close()

    await asyncio.to_thread(server.stop)

    print("\nchiamate arrivate al server:", [name for name, _ in session.calls])
    checker.check("lo shutdown ripristina la posizione reale",
                  ("disconnect", None) in session.calls)
    checker.check("nessun errore JavaScript", not js_errors, "; ".join(js_errors[:3]))
    checker.check("nessuna richiesta fallita verso il server locale", not failed_requests,
                  "; ".join(failed_requests[:3]))

    if checker.failures:
        print(f"\n✗ {len(checker.failures)} verifiche fallite:")
        for failure in checker.failures:
            print(f"  - {failure}")
        return 1
    print("\n✓ tutte le verifiche passate")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--headed", action="store_true", help="mostra la finestra del browser")
    parser.add_argument(
        "--screenshots",
        type=Path,
        help="cartella in cui salvare gli screenshot di ogni passo",
    )
    parser.add_argument(
        "--chromium",
        type=Path,
        help="eseguibile Chromium da usare, se quello di Playwright non è disponibile",
    )
    args = parser.parse_args()
    if args.screenshots is not None:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    try:
        return asyncio.run(run(args.headed, args.screenshots, args.chromium))
    except ImportError:
        print(
            "Playwright non è installato.\n"
            "  pip install playwright && playwright install chromium",
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    sys.exit(main())
