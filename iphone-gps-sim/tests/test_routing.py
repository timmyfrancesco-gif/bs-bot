import unittest

import httpx

from gpssim.geocode import BoundingBox
from gpssim.models import Coordinate
from gpssim.routing import (
    MAX_WAYPOINTS,
    RouteError,
    Router,
    densify,
    haversine_m,
    plan_city_tour,
    sample_grid_points,
    suggest_waypoint_count,
    total_distance_m,
)

MILANO = Coordinate(45.4642, 9.1900)
# ~111 m più a nord di Milano.
MILANO_NORD = Coordinate(45.4652, 9.1900)
CESENA_BBOX = BoundingBox(south=44.1200, north=44.1600, west=12.2200, east=12.2700)


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _trip_payload(coordinates: list[tuple[float, float]], *, distance: float = 1000.0) -> dict:
    """``coordinates`` è già in ordine GeoJSON: [lon, lat]."""
    return {
        "code": "Ok",
        "trips": [{"geometry": {"coordinates": coordinates}, "distance": distance, "duration": 120.0}],
        "waypoints": [],
    }


class HaversineTest(unittest.TestCase):
    def test_stesso_punto_distanza_zero(self) -> None:
        self.assertEqual(haversine_m(MILANO, MILANO), 0.0)

    def test_un_centesimo_di_grado_di_latitudine_e_circa_111_metri(self) -> None:
        distance = haversine_m(MILANO, MILANO_NORD)
        self.assertGreater(distance, 100)
        self.assertLess(distance, 120)

    def test_total_distance_somma_i_segmenti(self) -> None:
        route = [MILANO, MILANO_NORD, MILANO]
        total = total_distance_m(route)
        single_leg = haversine_m(MILANO, MILANO_NORD)
        self.assertAlmostEqual(total, single_leg * 2, delta=0.01)

    def test_total_distance_di_un_solo_punto_e_zero(self) -> None:
        self.assertEqual(total_distance_m([MILANO]), 0.0)


class DensifyTest(unittest.TestCase):
    def test_punti_gia_vicini_restano_invariati(self) -> None:
        route = [MILANO, MILANO_NORD]
        self.assertEqual(densify(route, max_step_m=200), route)

    def test_inserisce_punti_intermedi_a_passo_regolare(self) -> None:
        far = Coordinate(MILANO.latitude + 0.01, MILANO.longitude)  # ~1,1 km
        dense = densify([MILANO, far], max_step_m=100)

        self.assertEqual(dense[0], MILANO)
        self.assertEqual(dense[-1], far)
        self.assertGreater(len(dense), 5)
        for a, b in zip(dense, dense[1:], strict=False):
            self.assertLessEqual(haversine_m(a, b), 100 + 1e-6)

    def test_meno_di_due_punti_torna_invariato(self) -> None:
        self.assertEqual(densify([], max_step_m=10), [])
        self.assertEqual(densify([MILANO], max_step_m=10), [MILANO])


class SampleGridPointsTest(unittest.TestCase):
    def test_restituisce_esattamente_il_numero_richiesto(self) -> None:
        for count in (2, 6, 12, 25):
            with self.subTest(count=count):
                points = sample_grid_points(CESENA_BBOX, count)
                self.assertEqual(len(points), count)

    def test_i_punti_stanno_dentro_il_riquadro(self) -> None:
        points = sample_grid_points(CESENA_BBOX, 16)
        for point in points:
            self.assertGreaterEqual(point.latitude, CESENA_BBOX.south)
            self.assertLessEqual(point.latitude, CESENA_BBOX.north)
            self.assertGreaterEqual(point.longitude, CESENA_BBOX.west)
            self.assertLessEqual(point.longitude, CESENA_BBOX.east)

    def test_un_riquadro_degenere_viene_allargato(self) -> None:
        """Un paese piccolissimo (o un punto isolato) non deve produrre un
        giro fatto di un solo punto ripetuto."""
        point_like_bbox = BoundingBox(south=44.14, north=44.14, west=12.24, east=12.24)
        points = sample_grid_points(point_like_bbox, 9)
        latitudes = {round(point.latitude, 6) for point in points}
        self.assertGreater(len(latitudes), 1)


class SuggestWaypointCountTest(unittest.TestCase):
    def test_una_citta_piccola_ha_poche_tappe(self) -> None:
        small = BoundingBox(south=44.14, north=44.15, west=12.24, east=12.25)
        self.assertLess(suggest_waypoint_count(small), MAX_WAYPOINTS)

    def test_una_metropoli_e_limitata_dal_tetto(self) -> None:
        huge = BoundingBox(south=41.7, north=42.0, west=12.3, east=12.7)  # ~ area di Roma
        self.assertEqual(suggest_waypoint_count(huge), MAX_WAYPOINTS)


class RouterTripTest(unittest.IsolatedAsyncioTestCase):
    async def test_costruisce_l_url_e_traduce_la_geometria(self) -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json=_trip_payload([[9.19, 45.4642], [9.1910, 45.4652]]))

        router = Router(endpoint="https://osrm.test", client=_client(handler))
        geometry, distance = await router.trip([MILANO, MILANO_NORD], profile="driving")

        self.assertEqual(len(requests), 1)
        self.assertIn("/trip/v1/driving/", str(requests[0].url))
        # OSRM vuole lon,lat: verifichiamo che non li abbiamo invertiti per errore.
        self.assertIn("9.19", str(requests[0].url))
        self.assertEqual(geometry, [Coordinate(45.4642, 9.19), Coordinate(45.4652, 9.191)])
        self.assertEqual(distance, 1000.0)

    async def test_meno_di_due_tappe_non_chiama_la_rete(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            raise AssertionError("non doveva partire nessuna richiesta")

        router = Router(endpoint="https://osrm.test", client=_client(handler))
        with self.assertRaises(RouteError):
            await router.trip([MILANO], profile="driving")

    async def test_codice_diverso_da_ok_e_un_errore(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"code": "NoTrips", "trips": []})

        router = Router(endpoint="https://osrm.test", client=_client(handler))
        with self.assertRaises(RouteError):
            await router.trip([MILANO, MILANO_NORD])

    async def test_nessun_trip_restituito(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"code": "Ok", "trips": []})

        router = Router(endpoint="https://osrm.test", client=_client(handler))
        with self.assertRaises(RouteError):
            await router.trip([MILANO, MILANO_NORD])

    async def test_geometria_vuota_e_un_errore(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_trip_payload([[9.19, 45.4642]]))

        router = Router(endpoint="https://osrm.test", client=_client(handler))
        with self.assertRaises(RouteError):
            await router.trip([MILANO, MILANO_NORD])

    async def test_errore_http(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, text="down")

        router = Router(endpoint="https://osrm.test", client=_client(handler))
        with self.assertRaises(RouteError):
            await router.trip([MILANO, MILANO_NORD])

    async def test_400_porta_il_corpo_della_risposta_nel_dettaglio(self) -> None:
        """Un 400 diretto (non un `code` logico nel corpo) è quasi sempre il
        servizio pubblico che rifiuta la richiesta a monte — il corpo della
        risposta è la sola diagnosi disponibile, va sempre nel dettaglio."""

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(400, json={"code": "TooBig", "message": "Too many waypoints"})

        router = Router(endpoint="https://osrm.test", client=_client(handler))
        with self.assertRaises(RouteError) as raised:
            await router.trip([MILANO, MILANO_NORD])
        self.assertIn("Too many waypoints", raised.exception.detail)
        self.assertIn("400", raised.exception.detail)
        self.assertIn("tappe", raised.exception.hint)

    async def test_400_con_corpo_non_json_usa_il_testo_grezzo(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(400, text="<html>Bad Request</html>")

        router = Router(endpoint="https://osrm.test", client=_client(handler))
        with self.assertRaises(RouteError) as raised:
            await router.trip([MILANO, MILANO_NORD])
        self.assertIn("Bad Request", raised.exception.detail)

    async def test_timeout(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("troppo lento", request=request)

        router = Router(endpoint="https://osrm.test", client=_client(handler))
        with self.assertRaises(RouteError) as raised:
            await router.trip([MILANO, MILANO_NORD])
        self.assertIn("tempo", raised.exception.message)

    async def test_rete_assente(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("nessuna rete", request=request)

        router = Router(endpoint="https://osrm.test", client=_client(handler))
        with self.assertRaises(RouteError):
            await router.trip([MILANO, MILANO_NORD])

    async def test_risposta_non_json(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="<html>non json</html>")

        router = Router(endpoint="https://osrm.test", client=_client(handler))
        with self.assertRaises(RouteError):
            await router.trip([MILANO, MILANO_NORD])

    async def test_close_non_chiude_un_client_non_nostro(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_trip_payload([[9.19, 45.4642], [9.1910, 45.4652]]))

        client = _client(handler)
        router = Router(endpoint="https://osrm.test", client=client)
        await router.close()
        self.assertFalse(client.is_closed)
        await client.aclose()


class PlanCityTourTest(unittest.IsolatedAsyncioTestCase):
    async def test_pianifica_con_l_origine_come_prima_tappa_e_infittisce(self) -> None:
        captured: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["request"] = request
            # Un giro grezzo di 3 tappe con un lato lungo, per verificare che
            # `plan_city_tour` lo infittisca prima di restituirlo.
            return httpx.Response(
                200,
                json=_trip_payload(
                    [[9.19, 45.4642], [9.19, 45.4742], [9.19, 45.4642]],
                    distance=11_100.0,
                ),
            )

        router = Router(endpoint="https://osrm.test", client=_client(handler))
        plan = await plan_city_tour(
            router,
            bbox=CESENA_BBOX,
            origin=MILANO,
            label="Giro di prova",
            waypoint_count=4,
            densify_step_m=200.0,
        )

        request = captured["request"]
        # origine + 3 tappe campionate = 4 waypoint mandati a OSRM.
        self.assertEqual(str(request.url).count(";") + 1, 4)
        self.assertEqual(plan.label, "Giro di prova")
        self.assertEqual(plan.distance_m, 11_100.0)
        self.assertEqual(plan.points[0], MILANO)
        self.assertGreater(len(plan.points), 3, "la geometria grezza andava infittita")

    async def test_il_numero_di_tappe_e_limitato_dal_tetto(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_trip_payload([[9.19, 45.4642], [9.20, 45.47]]))

        router = Router(endpoint="https://osrm.test", client=_client(handler))
        await plan_city_tour(
            router, bbox=CESENA_BBOX, origin=MILANO, label="Test", waypoint_count=999
        )
        # Nessuna eccezione: `plan_city_tour` deve aver limitato internamente
        # il numero di tappe a `MAX_WAYPOINTS`, non passarlo così com'è a OSRM.


if __name__ == "__main__":
    unittest.main()
