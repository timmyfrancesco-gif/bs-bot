import asyncio
import unittest
from unittest import mock

from gpssim.errors import ErrorCode, GpsSimError
from gpssim.location import LocationSession
from gpssim.models import Coordinate, SessionState
from tests.test_session import FakeBackend, FakeManager

# Punti vicini (decine-centinaia di metri): un giro reale è fatto di passi
# piccoli come questi (`densify` li produce a intervalli di pochi metri), e a
# distanze intracittadine il test resta veloce anche a velocità realistiche.
P0 = Coordinate(45.4642, 9.1900)
P1 = Coordinate(45.4652, 9.1900)  # ~111 m a nord
P2 = Coordinate(45.4652, 9.1910)  # ~78 m a est
ROUTE = [P0, P1, P2, P0]

#: Velocità alta apposta: un test non deve aspettare secondi per ogni passo.
FAST_KMH = 3600.0


async def _wait_until(condition, *, timeout: float = 3.0, step: float = 0.01) -> None:
    elapsed = 0.0
    while elapsed < timeout:
        if condition():
            return
        await asyncio.sleep(step)
        elapsed += step
    raise AssertionError("condizione non soddisfatta entro il timeout")


class RoutePlaybackTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.manager = FakeManager()
        self.backend = FakeBackend()
        patcher = mock.patch(
            "gpssim.location.open_backend", new=mock.AsyncMock(return_value=self.backend)
        )
        patcher.start()
        self.addCleanup(patcher.stop)

        # Un intervallo di keep-alive largo, apposta: i test qui muovono il
        # giro a velocità artificialmente alte per restare veloci, e un
        # keep-alive troppo frequente rimanderebbe lo stesso punto più volte
        # nel mezzo di un passo, sporcando l'ordine che verifichiamo.
        self.session = LocationSession(manager=self.manager, keepalive_interval=5.0, auto_recover=False)
        await self.session.connect()

    async def asyncTearDown(self) -> None:
        await self.session.disconnect()

    # ------------------------------------------------------------------ #

    async def test_il_giro_attraversa_tutti_i_punti_in_ordine(self) -> None:
        await self.session.play_route(ROUTE, speed_kmh=FAST_KMH, label="Test")
        await _wait_until(lambda: self.session.status.route is None or not self.session.status.route.playing)

        self.assertEqual(self.backend.sets, ROUTE)
        self.assertEqual(self.session.status.state, SessionState.SIMULATING)
        self.assertFalse(self.session.status.real_location)
        assert self.session.status.route is not None
        self.assertFalse(self.session.status.route.playing)
        self.assertEqual(self.session.status.route.index, len(ROUTE) - 1)
        self.assertEqual(self.session.status.route.remaining_m, 0.0)
        self.assertIn("completato", self.session.status.message)

    async def test_lo_stato_riflette_subito_il_giro_appena_pianificato(self) -> None:
        """Non serve aspettare il primo passo: `play_route` pubblica lo stato
        del giro prima ancora di far partire il task che lo esegue."""
        status = await self.session.play_route(ROUTE, speed_kmh=50.0, label="Test")
        self.assertIsNotNone(status.route)
        assert status.route is not None
        self.assertEqual(status.route.points, len(ROUTE))
        self.assertEqual(status.route.index, 0)
        self.assertTrue(status.route.playing)
        self.assertEqual(status.route.label, "Test")
        await self.session.stop_route()

    async def test_stop_route_interrompe_senza_ripristinare_la_posizione_reale(self) -> None:
        await self.session.play_route(ROUTE, speed_kmh=50.0, label="Test")
        await asyncio.sleep(0.05)  # troppo poco per completare un solo passo a 50 km/h
        status = await self.session.stop_route()

        self.assertIsNone(status.route)
        self.assertFalse(status.real_location, "il giro si ferma dov'è, non torna alla posizione reale")
        self.assertLess(len(self.backend.sets), len(ROUTE))

    async def test_set_location_interrompe_un_giro_in_corso(self) -> None:
        """Impostare un punto a mano è un'azione esplicita: deve vincere su
        qualunque giro automatico in corso."""
        await self.session.play_route(ROUTE, speed_kmh=50.0, label="Test")
        await self.session.set_location(P0)
        self.assertIsNone(self.session.status.route)
        self.assertEqual(self.session.status.target, P0)

    async def test_restore_real_location_interrompe_un_giro_in_corso(self) -> None:
        await self.session.play_route(ROUTE, speed_kmh=50.0, label="Test")
        status = await self.session.restore_real_location()
        self.assertIsNone(status.route)
        self.assertTrue(status.real_location)

    async def test_un_nuovo_giro_sostituisce_quello_in_corso(self) -> None:
        await self.session.play_route(ROUTE, speed_kmh=0.5, label="Lento")  # non finirà nel test
        await self.session.play_route([P0, P1], speed_kmh=FAST_KMH, label="Veloce")

        await _wait_until(lambda: self.session.status.route is None or not self.session.status.route.playing)
        assert self.session.status.route is not None
        self.assertEqual(self.session.status.route.label, "Veloce")
        self.assertEqual(self.session.status.route.points, 2)

    async def test_un_fallimento_durante_il_giro_marca_la_sessione_persa(self) -> None:
        self.backend.fail_with = ConnectionResetError("cavo staccato")
        await self.session.play_route(ROUTE, speed_kmh=50.0, label="Test")
        await _wait_until(lambda: self.session.status.state == SessionState.LOST)

        self.assertTrue(self.session.status.real_location)
        assert self.session.status.error is not None
        self.assertEqual(self.session.status.error["code"], "cable_disconnected")

    async def test_meno_di_due_punti_e_un_errore_chiaro(self) -> None:
        with self.assertRaises(GpsSimError) as raised:
            await self.session.play_route([P0], speed_kmh=50.0)
        self.assertEqual(raised.exception.code, ErrorCode.LOCATION_UNSUPPORTED)
        self.assertIsNone(self.session.status.route)

    async def test_senza_sessione_play_route_fallisce_subito(self) -> None:
        session = LocationSession(manager=FakeManager(), auto_recover=False)
        with self.assertRaises(GpsSimError) as raised:
            await session.play_route(ROUTE, speed_kmh=50.0)
        self.assertEqual(raised.exception.code, ErrorCode.NO_DEVICE)

    async def test_disconnect_ferma_un_giro_in_corso(self) -> None:
        await self.session.play_route(ROUTE, speed_kmh=0.5, label="Test")
        status = await self.session.disconnect()
        self.assertIsNone(status.route)
        self.assertEqual(status.state, SessionState.IDLE)


if __name__ == "__main__":
    unittest.main()
