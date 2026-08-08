import asyncio
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from gpssim.errors import ErrorCode, GpsSimError
from gpssim.tunnel import RsdTunnel, TunnelOutputParser


class TunnelOutputParserTest(unittest.TestCase):
    def test_script_mode_una_riga(self) -> None:
        info = TunnelOutputParser().feed("fdaa:1122:3344::1 51234")
        assert info is not None
        self.assertEqual(info.address, "fdaa:1122:3344::1")
        self.assertEqual(info.port, 51234)

    def test_output_leggibile_su_righe_separate(self) -> None:
        parser = TunnelOutputParser()
        self.assertIsNone(parser.feed("Identifier: 00008120-001234567890001E"))
        self.assertIsNone(parser.feed("Interface: utun6"))
        self.assertIsNone(parser.feed("RSD Address: fdaa::abcd"))
        info = parser.feed("RSD Port: 60105")
        assert info is not None
        self.assertEqual(info.address, "fdaa::abcd")
        self.assertEqual(info.port, 60105)

    def test_ignora_le_righe_di_rumore(self) -> None:
        parser = TunnelOutputParser()
        for line in ("", "INFO tunnel created", "Protocol: TunnelProtocol.TCP"):
            self.assertIsNone(parser.feed(line))


def _fake_tunnel_script(body: str) -> Path:
    """Scrive uno script che imita `pymobiledevice3 lockdown start-tunnel`."""
    directory = Path(tempfile.mkdtemp(prefix="gpssim-test-"))
    script = directory / "fake_tunnel.py"
    script.write_text(
        textwrap.dedent(
            """
            import sys, time
            """
        )
        + textwrap.dedent(body)
    )
    return script


class RsdTunnelTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        # Nei test il processo non crea davvero interfacce di rete: evitiamo che
        # `_build_argv` antepponga sudo.
        patcher = mock.patch("gpssim.tunnel.is_privileged", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_cattura_indirizzo_e_porta_e_resta_vivo(self) -> None:
        script = _fake_tunnel_script(
            """
            print("fdaa::1 49152", flush=True)
            time.sleep(30)
            """
        )
        tunnel = RsdTunnel("UDID", base_command=[sys.executable, str(script)])
        try:
            info = await tunnel.start(timeout=10)
            self.assertEqual(info.address, "fdaa::1")
            self.assertEqual(info.port, 49152)
            self.assertIsNotNone(info.pid)
            self.assertTrue(tunnel.is_alive)
        finally:
            await tunnel.stop()
        self.assertFalse(tunnel.is_alive)

    async def test_privilegi_insufficienti_riconosciuti_da_stderr(self) -> None:
        script = _fake_tunnel_script(
            """
            print("sudo: a password is required", file=sys.stderr, flush=True)
            sys.exit(1)
            """
        )
        tunnel = RsdTunnel("UDID", base_command=[sys.executable, str(script)])
        with self.assertRaises(GpsSimError) as raised:
            await tunnel.start(timeout=10)
        self.assertEqual(raised.exception.code, ErrorCode.INSUFFICIENT_PRIVILEGES)

    async def test_developer_mode_riconosciuta_da_stderr(self) -> None:
        script = _fake_tunnel_script(
            """
            print("ERROR: Developer mode is not enabled", file=sys.stderr, flush=True)
            sys.exit(1)
            """
        )
        tunnel = RsdTunnel("UDID", base_command=[sys.executable, str(script)])
        with self.assertRaises(GpsSimError) as raised:
            await tunnel.start(timeout=10)
        self.assertEqual(raised.exception.code, ErrorCode.DEVELOPER_MODE_OFF)

    async def test_uscita_senza_tunnel_e_un_errore_tipizzato(self) -> None:
        script = _fake_tunnel_script(
            """
            print("qualcosa è andato storto", file=sys.stderr, flush=True)
            sys.exit(2)
            """
        )
        tunnel = RsdTunnel("UDID", base_command=[sys.executable, str(script)])
        with self.assertRaises(GpsSimError) as raised:
            await tunnel.start(timeout=10)
        self.assertEqual(raised.exception.code, ErrorCode.TUNNEL_FAILED)
        self.assertIn("qualcosa è andato storto", raised.exception.detail or "")

    async def test_timeout_se_il_tunnel_non_si_apre(self) -> None:
        script = _fake_tunnel_script(
            """
            time.sleep(30)
            """
        )
        tunnel = RsdTunnel("UDID", base_command=[sys.executable, str(script)])
        with self.assertRaises(GpsSimError) as raised:
            await tunnel.start(timeout=0.5)
        self.assertEqual(raised.exception.code, ErrorCode.TUNNEL_FAILED)
        self.assertFalse(tunnel.is_alive)

    async def test_la_morte_del_processo_viene_segnalata(self) -> None:
        """Se il tunnel muore l'iPhone torna alla posizione reale: il callback è
        l'unico modo che la UI ha di saperlo."""
        script = _fake_tunnel_script(
            """
            print("fdaa::2 49153", flush=True)
            time.sleep(0.2)
            sys.exit(3)
            """
        )
        lost: asyncio.Future[GpsSimError] = asyncio.get_running_loop().create_future()
        tunnel = RsdTunnel(
            "UDID",
            base_command=[sys.executable, str(script)],
            on_lost=lambda error: lost.done() or lost.set_result(error),
        )
        await tunnel.start(timeout=10)
        error = await asyncio.wait_for(lost, timeout=10)
        self.assertEqual(error.code, ErrorCode.TUNNEL_LOST)
        await tunnel.stop()

    async def test_stop_non_viene_segnalato_come_caduta(self) -> None:
        script = _fake_tunnel_script(
            """
            print("fdaa::3 49154", flush=True)
            time.sleep(30)
            """
        )
        calls: list[GpsSimError] = []
        tunnel = RsdTunnel(
            "UDID",
            base_command=[sys.executable, str(script)],
            on_lost=calls.append,
        )
        await tunnel.start(timeout=10)
        await tunnel.stop()
        await asyncio.sleep(0.2)
        self.assertEqual(calls, [])

    async def test_senza_privilegi_e_senza_sudo_fallisce_subito(self) -> None:
        with mock.patch("gpssim.tunnel.is_privileged", return_value=False):
            tunnel = RsdTunnel("UDID", allow_sudo=False)
            with self.assertRaises(GpsSimError) as raised:
                await tunnel.start(timeout=1)
        self.assertEqual(raised.exception.code, ErrorCode.INSUFFICIENT_PRIVILEGES)


if __name__ == "__main__":
    unittest.main()
