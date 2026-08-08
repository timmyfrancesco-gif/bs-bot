import asyncio
import json
import unittest
from typing import Any

from fastapi.testclient import TestClient

from gpssim.api import _status_stream, create_app
from gpssim.errors import ErrorCode, GpsSimError
from gpssim.geocode import GeocodingError, Place
from gpssim.location import LocationSession
from gpssim.models import Coordinate, DeviceInfo, SessionState, Status, TunnelInfo
from gpssim.server import BackgroundServer, pick_port

MILANO = Coordinate(45.4642, 9.1900)


class FakeSession:
    """Sostituisce `LocationSession`: l'API va provata senza iPhone né tunnel."""

    def __init__(self) -> None:
        self.status = Status()
        self.manager = self
        self.devices = [
            DeviceInfo(
                udid="UDID-1",
                name="iPhone di prova",
                ios_version="18.2",
                product_type="iPhone16,1",
                connection_type="USB",
                developer_mode=True,
            )
        ]
        self.calls: list[tuple[str, Any]] = []
        self.fail_with: BaseException | None = None
        self._listeners: list[Any] = []

    # --- lato manager ---
    async def list_devices(self) -> list[DeviceInfo]:
        self.calls.append(("list_devices", None))
        if self.fail_with is not None:
            raise self.fail_with
        return self.devices

    # --- lato sessione ---
    def add_listener(self, listener: Any) -> Any:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    def emit(self, status: Status) -> None:
        """Simula un evento non richiesto (es. il tunnel che cade)."""
        self.status = status
        for listener in list(self._listeners):
            listener(status)

    async def connect(self, udid: str | None = None) -> Status:
        self.calls.append(("connect", udid))
        if self.fail_with is not None:
            raise self.fail_with
        self.status = Status(
            state=SessionState.READY,
            device=self.devices[0],
            tunnel=TunnelInfo(address="fdaa::1", port=49152, pid=1),
            backend="fake",
        )
        return self.status

    async def disconnect(self) -> Status:
        self.calls.append(("disconnect", None))
        self.status = Status()
        return self.status

    async def set_location(self, coordinate: Coordinate) -> Status:
        self.calls.append(("set_location", coordinate))
        if self.fail_with is not None:
            raise self.fail_with
        self.status.state = SessionState.SIMULATING
        self.status.target = coordinate
        self.status.real_location = False
        return self.status

    async def restore_real_location(self) -> Status:
        self.calls.append(("restore", None))
        self.status.state = SessionState.READY
        self.status.target = None
        self.status.real_location = True
        return self.status


class FakeGeocoder:
    def __init__(self) -> None:
        self.searches: list[str] = []
        self.fail_with: BaseException | None = None

    async def search(self, query: str, *, limit: int = 6) -> list[Place]:
        self.searches.append(query)
        if self.fail_with is not None:
            raise self.fail_with
        return [Place(label="Milano, Italia", coordinate=MILANO, kind="city")][:limit]

    async def reverse(self, coordinate: Coordinate) -> Place | None:
        if self.fail_with is not None:
            raise self.fail_with
        return Place(label="Duomo, Milano", coordinate=coordinate, kind="place_of_worship")

    async def close(self) -> None:
        return None


class ApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.session = FakeSession()
        self.geocoder = FakeGeocoder()
        app = create_app(session=self.session, geocoder=self.geocoder)
        self.client = TestClient(app)

    # ------------------------------------------------------------------ #

    def test_health(self) -> None:
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])

    def test_status_iniziale(self) -> None:
        payload = self.client.get("/api/status").json()
        self.assertEqual(payload["state"], "idle")
        self.assertTrue(payload["real_location"])

    def test_devices(self) -> None:
        payload = self.client.get("/api/devices").json()
        self.assertEqual(len(payload["devices"]), 1)
        self.assertEqual(payload["devices"][0]["udid"], "UDID-1")
        self.assertTrue(payload["devices"][0]["needs_tunnel"])

    def test_connect_restituisce_lo_stato_completo(self) -> None:
        payload = self.client.post("/api/session/connect", json={"udid": "UDID-1"}).json()
        self.assertEqual(payload["state"], "ready")
        self.assertEqual(payload["tunnel"]["port"], 49152)
        self.assertEqual(self.session.calls[-1], ("connect", "UDID-1"))

    def test_connect_senza_corpo(self) -> None:
        response = self.client.post("/api/session/connect")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.session.calls[-1], ("connect", None))

    def test_set_location(self) -> None:
        self.client.post("/api/session/connect")
        payload = self.client.post("/api/location", json={"latitude": 45.4642, "longitude": 9.19}).json()
        self.assertEqual(payload["state"], "simulating")
        self.assertFalse(payload["real_location"])
        self.assertEqual(payload["target"]["latitude"], 45.4642)

    def test_coordinate_fuori_range_rifiutate_dalla_validazione(self) -> None:
        response = self.client.post("/api/location", json={"latitude": 91, "longitude": 0})
        self.assertEqual(response.status_code, 422)

    def test_restore(self) -> None:
        self.client.post("/api/session/connect")
        self.client.post("/api/location", json={"latitude": 45.4642, "longitude": 9.19})
        payload = self.client.post("/api/location/restore").json()
        self.assertEqual(payload["state"], "ready")
        self.assertTrue(payload["real_location"])
        self.assertIsNone(payload["target"])

    # ------------------------------------------------------------------ #
    # Errori: il codice HTTP deve distinguere i casi, il corpo deve spiegarli
    # ------------------------------------------------------------------ #

    def test_device_bloccato_e_409_con_messaggio(self) -> None:
        self.session.fail_with = GpsSimError(ErrorCode.DEVICE_LOCKED)
        response = self.client.post("/api/session/connect")
        self.assertEqual(response.status_code, 409)
        body = response.json()
        self.assertEqual(body["error"]["code"], "device_locked")
        self.assertIn("bloccato", body["error"]["message"])
        self.assertTrue(body["error"]["hint"])
        # Anche in errore la risposta porta lo stato: il frontend non deve
        # fare una seconda richiesta per sapere dove si trova.
        self.assertIn("status", body)

    def test_permessi_insufficienti_e_403(self) -> None:
        self.session.fail_with = GpsSimError(ErrorCode.INSUFFICIENT_PRIVILEGES)
        response = self.client.post("/api/session/connect")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "insufficient_privileges")

    def test_nessun_dispositivo_e_404(self) -> None:
        self.session.fail_with = GpsSimError(ErrorCode.NO_DEVICE)
        self.assertEqual(self.client.post("/api/session/connect").status_code, 404)

    def test_usbmuxd_assente_e_503(self) -> None:
        self.session.fail_with = GpsSimError(ErrorCode.USBMUXD_UNAVAILABLE)
        self.assertEqual(self.client.get("/api/devices").status_code, 503)

    def test_tunnel_perso_e_409(self) -> None:
        self.session.fail_with = GpsSimError(ErrorCode.TUNNEL_LOST)
        response = self.client.post("/api/location", json={"latitude": 0, "longitude": 0})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "tunnel_lost")

    # ------------------------------------------------------------------ #
    # Geocoding
    # ------------------------------------------------------------------ #

    def test_ricerca_indirizzo(self) -> None:
        payload = self.client.get("/api/geocode/search", params={"q": "milano"}).json()
        self.assertEqual(payload["results"][0]["label"], "Milano, Italia")
        self.assertEqual(payload["results"][0]["latitude"], 45.4642)
        self.assertEqual(self.geocoder.searches, ["milano"])

    def test_ricerca_vuota_rifiutata(self) -> None:
        self.assertEqual(self.client.get("/api/geocode/search", params={"q": ""}).status_code, 422)

    def test_reverse(self) -> None:
        payload = self.client.get(
            "/api/geocode/reverse", params={"latitude": 45.4642, "longitude": 9.19}
        ).json()
        self.assertEqual(payload["result"]["label"], "Duomo, Milano")

    def test_geocoding_non_disponibile_e_502(self) -> None:
        """Un guasto di Nominatim non è un guasto del dispositivo: gerarchia
        separata, e la sessione con l'iPhone non ne risulta compromessa."""
        self.geocoder.fail_with = GeocodingError("Nominatim non risponde.")
        response = self.client.get("/api/geocode/search", params={"q": "milano"})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["error"]["code"], "geocoding_failed")

    # Lo stream SSE non è testabile con `TestClient`: l'ASGITransport di httpx
    # accumula il corpo della risposta fino all'ultimo chunk, e questo stream non
    # finisce mai. È coperto da `StatusStreamTest` (la logica) e da
    # `SseOverHttpTest` (il percorso reale, con uvicorn).

    # ------------------------------------------------------------------ #
    # Frontend
    # ------------------------------------------------------------------ #

    def test_serve_la_pagina_e_leaflet_vendorizzato(self) -> None:
        index = self.client.get("/")
        self.assertEqual(index.status_code, 200)
        self.assertIn("Simulatore GPS", index.text)

        for path in ("/app.js", "/style.css", "/vendor/leaflet.js", "/vendor/leaflet.css"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200, path)

    def test_lo_shutdown_ripristina_la_posizione_reale(self) -> None:
        """Chiudere l'app senza ripristinare lascerebbe l'iPhone con una posizione
        falsa e nessuna interfaccia per annullarla."""
        with TestClient(create_app(session=self.session, geocoder=self.geocoder)) as client:
            client.post("/api/session/connect")
            client.post("/api/location", json={"latitude": 45.4642, "longitude": 9.19})
        self.assertIn(("disconnect", None), self.session.calls)


class RealSessionWiringTest(unittest.TestCase):
    """Un'istanza vera di `LocationSession` deve essere accettata dall'app senza
    che serva un iPhone: qui si verifica il collegamento, non il comportamento."""

    def test_app_costruibile_con_la_sessione_reale(self) -> None:
        app = create_app(session=LocationSession())
        with TestClient(app) as client:
            self.assertEqual(client.get("/api/status").json()["state"], "idle")


class StatusStreamTest(unittest.IsolatedAsyncioTestCase):
    """La logica dello stream, con tutto nello stesso event loop."""

    async def asyncSetUp(self) -> None:
        self.session = FakeSession()
        self.stream = _status_stream(self.session)

    async def asyncTearDown(self) -> None:
        await self.stream.aclose()

    async def test_il_primo_evento_e_lo_stato_corrente(self) -> None:
        """Chi si collega non deve aspettare un cambiamento per sapere dove siamo."""
        payload = await _next_event(self.stream)
        self.assertEqual(payload["state"], "idle")
        self.assertTrue(payload["real_location"])

    async def test_riceve_gli_eventi_non_richiesti(self) -> None:
        """La caduta del tunnel non è risposta a una richiesta: se non arrivasse
        in push, l'utente vedrebbe una simulazione che non esiste più."""
        await _next_event(self.stream)
        self.session.emit(
            Status(
                state=SessionState.LOST,
                real_location=True,
                error=GpsSimError(ErrorCode.TUNNEL_LOST).to_dict(),
            )
        )
        payload = await _next_event(self.stream)
        self.assertEqual(payload["state"], "lost")
        self.assertTrue(payload["real_location"])
        self.assertEqual(payload["error"]["code"], "tunnel_lost")

    async def test_la_coda_piena_scarta_i_vecchi_non_i_nuovi(self) -> None:
        """È uno stato, non un log: perdere gli intermedi va bene, perdere
        l'ultimo significherebbe mostrare all'utente una realtà superata."""
        await _next_event(self.stream)
        for index in range(100):
            self.session.emit(Status(state=SessionState.SIMULATING, message=f"evento {index}"))
        self.session.emit(Status(state=SessionState.LOST, message="ultimo"))

        payload = None
        while self.session._listeners and (payload is None or payload["message"] != "ultimo"):
            payload = await _next_event(self.stream)
            if payload["message"] == "ultimo":
                break
        assert payload is not None
        self.assertEqual(payload["message"], "ultimo")

    async def test_alla_chiusura_il_listener_viene_rimosso(self) -> None:
        await _next_event(self.stream)
        self.assertEqual(len(self.session._listeners), 1)
        await self.stream.aclose()
        self.assertEqual(self.session._listeners, [])


class SseOverHttpTest(unittest.IsolatedAsyncioTestCase):
    """Lo stesso stream sul percorso reale: uvicorn in un thread + client HTTP.

    Serve perché la configurazione di uvicorn (keep-alive lungo, buffering) fa
    parte del comportamento: un test solo sul generatore non la coprirebbe.
    """

    async def test_lo_stream_arriva_su_http(self) -> None:
        import httpx

        session = FakeSession()
        port = pick_port(preferred=0)
        server = BackgroundServer(
            lambda: create_app(session=session, geocoder=FakeGeocoder()), port=port
        )
        url = await asyncio.to_thread(server.start)
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                async with client.stream("GET", f"{url}/api/events") as response:
                    self.assertEqual(response.status_code, 200)
                    self.assertTrue(response.headers["content-type"].startswith("text/event-stream"))
                    async for line in response.aiter_lines():
                        if line.startswith("data:"):
                            payload = json.loads(line[len("data:") :])
                            break
                    else:  # pragma: no cover
                        self.fail("nessun evento ricevuto")
            self.assertEqual(payload["state"], "idle")
        finally:
            await asyncio.to_thread(server.stop)


async def _next_event(stream: Any) -> dict[str, Any]:
    """Prende il prossimo evento con dati dal generatore, saltando gli heartbeat."""
    async for chunk in stream:
        if chunk.startswith("data:"):
            return json.loads(chunk[len("data:") :])
    raise AssertionError("stream terminato senza eventi")


if __name__ == "__main__":
    unittest.main()
