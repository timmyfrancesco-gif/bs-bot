import time
import unittest

import httpx

from gpssim.geocode import Geocoder, GeocodingError, _parse
from gpssim.models import Coordinate

SEARCH_PAYLOAD = [
    {
        "lat": "45.4641",
        "lon": "9.1919",
        "display_name": "Milano, Lombardia, Italia",
        "type": "city",
    },
    {
        "lat": "45.4640",
        "lon": "9.1896",
        "display_name": "Duomo, Piazza del Duomo, Milano",
        "type": "place_of_worship",
    },
]

REVERSE_PAYLOAD = {"lat": "45.4640", "lon": "9.1896", "display_name": "Duomo, Milano", "type": "attraction"}


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class ParseTest(unittest.TestCase):
    def test_lista_di_risultati(self) -> None:
        places = _parse(SEARCH_PAYLOAD)
        self.assertEqual(len(places), 2)
        self.assertEqual(places[0].label, "Milano, Lombardia, Italia")
        self.assertAlmostEqual(places[0].coordinate.latitude, 45.4641)
        self.assertEqual(places[0].kind, "city")

    def test_oggetto_singolo(self) -> None:
        places = _parse(REVERSE_PAYLOAD)
        self.assertEqual(len(places), 1)
        self.assertEqual(places[0].label, "Duomo, Milano")

    def test_scarta_i_risultati_inutilizzabili(self) -> None:
        """Nominatim può restituire voci senza coordinate: scartarle silenziosamente
        è giusto, farle diventare un errore no."""
        payload = [
            {"display_name": "senza coordinate"},
            {"lat": "non-un-numero", "lon": "9.0", "display_name": "coordinate rotte"},
            {"lat": "999", "lon": "9.0", "display_name": "fuori range"},
            "non un oggetto",
            SEARCH_PAYLOAD[0],
        ]
        places = _parse(payload)
        self.assertEqual(len(places), 1)
        self.assertEqual(places[0].label, "Milano, Lombardia, Italia")

    def test_senza_display_name_usa_name(self) -> None:
        places = _parse([{"lat": "1", "lon": "2", "name": "Posto"}])
        self.assertEqual(places[0].label, "Posto")


class GeocoderTest(unittest.IsolatedAsyncioTestCase):
    def _geocoder(self, handler, **kwargs) -> Geocoder:
        # min_interval a zero: il rate limit ha un test dedicato, gli altri non
        # devono pagare un secondo di attesa a testa.
        kwargs.setdefault("min_interval", 0.0)
        return Geocoder(endpoint="https://nominatim.test", client=_client(handler), **kwargs)

    async def test_search(self) -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json=SEARCH_PAYLOAD)

        places = await self._geocoder(handler).search("milano")
        self.assertEqual(len(places), 2)
        self.assertEqual(requests[0].url.params["q"], "milano")
        self.assertEqual(requests[0].url.params["format"], "jsonv2")

    async def test_reverse(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=REVERSE_PAYLOAD)

        place = await self._geocoder(handler).reverse(Coordinate(45.464, 9.1896))
        assert place is not None
        self.assertEqual(place.label, "Duomo, Milano")

    async def test_query_vuota_non_chiama_il_servizio(self) -> None:
        calls = 0

        def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json=[])

        geocoder = self._geocoder(handler)
        self.assertEqual(await geocoder.search("   "), [])
        self.assertEqual(calls, 0)

    async def test_la_cache_evita_le_richieste_ripetute(self) -> None:
        calls = 0

        def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json=SEARCH_PAYLOAD)

        geocoder = self._geocoder(handler)
        await geocoder.search("Milano")
        await geocoder.search("milano")   # stessa query, altro case
        await geocoder.search("  milano ")
        self.assertEqual(calls, 1)

    async def test_il_reverse_arrotonda_per_sfruttare_la_cache(self) -> None:
        """Trascinando il marker arrivano decine di coordinate quasi identiche:
        senza arrotondamento ognuna sarebbe una richiesta a Nominatim."""
        calls = 0

        def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json=REVERSE_PAYLOAD)

        geocoder = self._geocoder(handler)
        await geocoder.reverse(Coordinate(45.464012, 9.189600))
        await geocoder.reverse(Coordinate(45.464014, 9.189601))
        self.assertEqual(calls, 1)

    async def test_rispetta_il_rate_limit(self) -> None:
        """Un solo secondo di attesa qui è il prezzo per verificare la cosa che
        tiene il progetto dentro la usage policy di Nominatim."""
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=SEARCH_PAYLOAD)

        geocoder = self._geocoder(handler, min_interval=0.3)
        started = time.monotonic()
        await geocoder.search("uno")
        await geocoder.search("due")
        await geocoder.search("tre")
        elapsed = time.monotonic() - started
        # Due attese tra tre richieste distinte.
        self.assertGreaterEqual(elapsed, 0.55)

    async def test_429_ha_un_messaggio_dedicato(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(429, text="slow down")

        with self.assertRaises(GeocodingError) as raised:
            await self._geocoder(handler).search("milano")
        self.assertIn("Troppe richieste", raised.exception.message)

    async def test_errore_server(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, text="down")

        with self.assertRaises(GeocodingError) as raised:
            await self._geocoder(handler).search("milano")
        self.assertIn("503", raised.exception.message)

    async def test_timeout(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("troppo lento", request=request)

        with self.assertRaises(GeocodingError) as raised:
            await self._geocoder(handler).search("milano")
        self.assertIn("in tempo", raised.exception.message)
        self.assertIn("coordinate a mano", raised.exception.hint)

    async def test_rete_assente(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("nessuna rete", request=request)

        with self.assertRaises(GeocodingError) as raised:
            await self._geocoder(handler).search("milano")
        self.assertIn("Non riesco a contattare", raised.exception.message)

    async def test_risposta_non_json(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="<html>non json</html>")

        with self.assertRaises(GeocodingError):
            await self._geocoder(handler).search("milano")

    async def test_user_agent_identificativo(self) -> None:
        """La usage policy di Nominatim rifiuta gli User-Agent generici."""
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.headers.get("user-agent", ""))
            return httpx.Response(200, json=SEARCH_PAYLOAD)

        # Qui il client è nostro, così gli header di default vengono applicati.
        geocoder = Geocoder(endpoint="https://nominatim.test", min_interval=0.0)
        geocoder._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            headers={"User-Agent": geocoder.user_agent},
        )
        await geocoder.search("milano")
        await geocoder.close()
        self.assertIn("iphone-gps-sim/", seen[0])

    async def test_close_non_chiude_un_client_non_nostro(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=SEARCH_PAYLOAD)

        client = _client(handler)
        geocoder = Geocoder(endpoint="https://nominatim.test", client=client, min_interval=0.0)
        await geocoder.close()
        self.assertFalse(client.is_closed)
        await client.aclose()


if __name__ == "__main__":
    unittest.main()
