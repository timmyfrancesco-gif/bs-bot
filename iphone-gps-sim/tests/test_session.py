import asyncio
import unittest
from typing import Any
from unittest import mock

from gpssim.device import DeviceConnection
from gpssim.errors import ErrorCode, GpsSimError
from gpssim.location import MAX_PUSH_FAILURES, LocationBackend, LocationSession
from gpssim.models import Coordinate, DeviceInfo, SessionState, TunnelInfo

MILANO = Coordinate(45.4642, 9.1900)
ROMA = Coordinate(41.9028, 12.4964)


class FakeBackend(LocationBackend):
    name = "fake"

    def __init__(self, service_provider: Any = None) -> None:
        self.sets: list[Coordinate] = []
        self.clears = 0
        self.closed = False
        #: Quando è valorizzato, ogni `set` successivo solleva questa eccezione.
        self.fail_with: BaseException | None = None

    async def open(self) -> None:
        return None

    async def set(self, coordinate: Coordinate) -> None:
        if self.fail_with is not None:
            raise self.fail_with
        self.sets.append(coordinate)

    async def clear(self) -> None:
        self.clears += 1

    async def close(self) -> None:
        self.closed = True


class FakeLockdown:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


class FakeTunnel:
    def __init__(self) -> None:
        self.info = TunnelInfo(address="fdaa::1", port=49152, pid=4242)
        self.alive = True
        self.stopped = False

    @property
    def is_alive(self) -> bool:
        return self.alive

    async def stop(self) -> None:
        self.stopped = True
        self.alive = False


class FakeManager:
    """Sostituisce `DeviceManager`: nessun iPhone, nessun tunnel, nessun sudo."""

    def __init__(self) -> None:
        self.device = DeviceInfo(
            udid="00008120-001122334455001E",
            name="iPhone di prova",
            ios_version="18.2",
            product_type="iPhone16,1",
            connection_type="USB",
            developer_mode=True,
            ddi_mounted=True,
        )
        self.tunnel = FakeTunnel()
        self.prepare_calls = 0
        self.fail_with: BaseException | None = None
        self.on_tunnel_lost = None

    async def prepare(self, udid=None, *, on_progress=None, on_tunnel_lost=None, **_kwargs):
        self.prepare_calls += 1
        if self.fail_with is not None:
            raise self.fail_with
        self.on_tunnel_lost = on_tunnel_lost
        self.tunnel = FakeTunnel()
        return DeviceConnection(
            self.device,
            FakeLockdown(),
            rsd=object(),
            tunnel=self.tunnel,
        )


class LocationSessionTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.manager = FakeManager()
        self.backend = FakeBackend()
        patcher = mock.patch(
            "gpssim.location.open_backend",
            new=mock.AsyncMock(return_value=self.backend),
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def _session(self, **kwargs: Any) -> LocationSession:
        kwargs.setdefault("keepalive_interval", 0.05)
        kwargs.setdefault("auto_recover", False)
        return LocationSession(manager=self.manager, **kwargs)

    # ------------------------------------------------------------------ #

    async def test_connect_prepara_ma_non_simula(self) -> None:
        session = self._session()
        status = await session.connect()
        self.assertEqual(status.state, SessionState.READY)
        self.assertTrue(status.real_location)
        self.assertIsNone(status.target)
        self.assertEqual(status.backend, "fake")
        self.assertEqual(status.tunnel.port, 49152)
        self.assertEqual(self.backend.sets, [])
        await session.disconnect()

    async def test_errore_di_preparazione_finisce_in_stato_error(self) -> None:
        self.manager.fail_with = GpsSimError(ErrorCode.DEVICE_LOCKED)
        session = self._session()
        with self.assertRaises(GpsSimError) as raised:
            await session.connect()
        self.assertEqual(raised.exception.code, ErrorCode.DEVICE_LOCKED)
        self.assertEqual(session.status.state, SessionState.ERROR)
        self.assertEqual(session.status.error["code"], "device_locked")
        self.assertTrue(session.status.real_location)

    async def test_set_location_avvia_il_keepalive(self) -> None:
        session = self._session()
        await session.connect()
        status = await session.set_location(MILANO)
        self.assertEqual(status.state, SessionState.SIMULATING)
        self.assertFalse(status.real_location)
        self.assertEqual(self.backend.sets, [MILANO])

        # Il keep-alive deve riscrivere le stesse coordinate senza che nessuno
        # gliele richieda: da iOS 18 senza questo l'override decade.
        await asyncio.sleep(0.2)
        self.assertGreater(len(self.backend.sets), 1)
        self.assertTrue(all(coordinate == MILANO for coordinate in self.backend.sets))
        await session.disconnect()

    async def test_cambio_posizione_aggiorna_il_target_del_keepalive(self) -> None:
        session = self._session()
        await session.connect()
        await session.set_location(MILANO)
        await session.set_location(ROMA)
        self.backend.sets.clear()
        await asyncio.sleep(0.2)
        self.assertTrue(self.backend.sets)
        self.assertTrue(all(coordinate == ROMA for coordinate in self.backend.sets))
        await session.disconnect()

    async def test_ripristina_posizione_reale(self) -> None:
        session = self._session()
        await session.connect()
        await session.set_location(MILANO)
        status = await session.restore_real_location()
        self.assertEqual(status.state, SessionState.READY)
        self.assertTrue(status.real_location)
        self.assertIsNone(status.target)
        self.assertEqual(self.backend.clears, 1)

        # Nessun invio dopo il ripristino: il keep-alive è fermo.
        self.backend.sets.clear()
        await asyncio.sleep(0.2)
        self.assertEqual(self.backend.sets, [])
        await session.disconnect()

    async def test_fallimenti_ripetuti_del_keepalive_portano_a_lost(self) -> None:
        session = self._session()
        await session.connect()
        await session.set_location(MILANO)
        self.backend.fail_with = ConnectionResetError("cavo staccato")

        for _ in range(200):
            await asyncio.sleep(0.02)
            if session.status.state is SessionState.LOST:
                break

        self.assertEqual(session.status.state, SessionState.LOST)
        self.assertTrue(session.status.real_location, "in LOST l'iPhone mostra la posizione reale")
        self.assertEqual(session.status.error["code"], "cable_disconnected")
        self.assertGreaterEqual(session.status.consecutive_push_failures, MAX_PUSH_FAILURES)
        await session.disconnect()

    async def test_un_singolo_fallimento_non_interrompe_la_simulazione(self) -> None:
        session = self._session()
        await session.connect()
        await session.set_location(MILANO)

        self.backend.fail_with = ConnectionResetError("glitch")
        await asyncio.sleep(0.07)
        self.backend.fail_with = None
        await asyncio.sleep(0.15)

        self.assertEqual(session.status.state, SessionState.SIMULATING)
        self.assertTrue(session.status.last_push_ok)
        self.assertEqual(session.status.consecutive_push_failures, 0)
        await session.disconnect()

    async def test_tunnel_morto_rilevato_dal_keepalive(self) -> None:
        session = self._session()
        await session.connect()
        await session.set_location(MILANO)
        self.manager.tunnel.alive = False

        for _ in range(100):
            await asyncio.sleep(0.02)
            if session.status.state is SessionState.LOST:
                break

        self.assertEqual(session.status.state, SessionState.LOST)
        self.assertEqual(session.status.error["code"], "tunnel_lost")
        await session.disconnect()

    async def test_callback_del_tunnel_marca_la_sessione_persa(self) -> None:
        session = self._session()
        await session.connect()
        await session.set_location(MILANO)

        assert self.manager.on_tunnel_lost is not None
        self.manager.on_tunnel_lost(GpsSimError(ErrorCode.TUNNEL_LOST, detail="exit 1"))

        self.assertEqual(session.status.state, SessionState.LOST)
        self.assertTrue(session.status.real_location)
        await session.disconnect()

    async def test_i_listener_ricevono_ogni_cambio_di_stato(self) -> None:
        session = self._session()
        seen: list[SessionState] = []
        remove = session.add_listener(lambda status: seen.append(status.state))

        await session.connect()
        await session.set_location(MILANO)
        self.assertIn(SessionState.PREPARING, seen)
        self.assertIn(SessionState.READY, seen)
        self.assertIn(SessionState.SIMULATING, seen)

        remove()
        seen.clear()
        await session.restore_real_location()
        self.assertEqual(seen, [])
        await session.disconnect()

    async def test_set_location_senza_sessione_e_un_errore_chiaro(self) -> None:
        session = self._session()
        with self.assertRaises(GpsSimError) as raised:
            await session.set_location(MILANO)
        self.assertEqual(raised.exception.code, ErrorCode.NO_DEVICE)

    async def test_disconnect_ripristina_e_chiude_tutto(self) -> None:
        session = self._session()
        await session.connect()
        await session.set_location(MILANO)
        tunnel = self.manager.tunnel

        status = await session.disconnect()
        self.assertEqual(status.state, SessionState.IDLE)
        self.assertTrue(status.real_location)
        self.assertIsNone(status.device)
        self.assertEqual(self.backend.clears, 1)
        self.assertTrue(self.backend.closed)
        self.assertTrue(tunnel.stopped)

    async def test_riconnessione_automatica_dopo_una_caduta(self) -> None:
        session = self._session(auto_recover=True)
        with mock.patch("gpssim.location.RECOVERY_BACKOFF", (0.05,)):
            await session.connect()
            await session.set_location(MILANO)
            self.backend.fail_with = ConnectionResetError("cavo staccato")

            for _ in range(400):
                await asyncio.sleep(0.02)
                if session.status.state is SessionState.LOST:
                    break
            self.assertEqual(session.status.state, SessionState.LOST)

            # Il "cavo" torna: il recupero deve rimettere la stessa posizione.
            self.backend.fail_with = None
            for _ in range(400):
                await asyncio.sleep(0.02)
                if session.status.state is SessionState.SIMULATING:
                    break

        self.assertEqual(session.status.state, SessionState.SIMULATING)
        self.assertEqual(session.status.target, MILANO)
        self.assertGreaterEqual(self.manager.prepare_calls, 2)
        await session.disconnect()


class CoordinateTest(unittest.TestCase):
    def test_rifiuta_valori_fuori_range(self) -> None:
        with self.assertRaises(ValueError):
            Coordinate(91.0, 0.0)
        with self.assertRaises(ValueError):
            Coordinate(0.0, 181.0)

    def test_estremi_accettati(self) -> None:
        Coordinate(-90.0, -180.0)
        Coordinate(90.0, 180.0)


if __name__ == "__main__":
    unittest.main()
