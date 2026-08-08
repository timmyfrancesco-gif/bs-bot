import unittest
from unittest import mock

from gpssim import cli
from gpssim.models import KEEPALIVE_INTERVAL


class ParserTest(unittest.TestCase):
    def setUp(self) -> None:
        self.parser = cli.build_parser()

    def test_set_richiede_le_coordinate(self) -> None:
        args = self.parser.parse_args(["set", "45.4642", "9.19"])
        self.assertEqual(args.latitude, 45.4642)
        self.assertEqual(args.longitude, 9.19)
        self.assertEqual(args.interval, KEEPALIVE_INTERVAL)
        self.assertFalse(args.keep)

    def test_opzioni_globali_prima_del_sottocomando(self) -> None:
        args = self.parser.parse_args(["--udid", "ABC", "--no-sudo", "-vv", "devices"])
        self.assertEqual(args.udid, "ABC")
        self.assertTrue(args.no_sudo)
        self.assertEqual(args.verbose, 2)

    def test_serve_lascia_i_segnali_a_uvicorn(self) -> None:
        """uvicorn installa i propri handler di SIGINT quando parte e sovrascrive
        i nostri: senza questo flag Ctrl-C non arriverebbe a nessuno dei due e il
        server resterebbe vivo."""
        for command in ("serve", "app"):
            with self.subTest(command=command):
                self.assertTrue(getattr(self.parser.parse_args([command]), "owns_signals", False))

    def test_gli_altri_comandi_gestiscono_i_segnali_da_soli(self) -> None:
        for command in (["devices"], ["doctor"], ["tunnel"], ["clear"], ["set", "0", "0"]):
            with self.subTest(command=command):
                args = self.parser.parse_args(command)
                self.assertFalse(getattr(args, "owns_signals", False))

    def test_porta_e_host_dei_comandi_web(self) -> None:
        args = self.parser.parse_args(["serve", "--host", "0.0.0.0", "--port", "9000", "--open"])
        self.assertEqual(args.host, "0.0.0.0")
        self.assertEqual(args.port, 9000)
        self.assertTrue(args.open)

    def test_app_non_ha_open(self) -> None:
        self.assertFalse(hasattr(self.parser.parse_args(["app"]), "open"))

    def test_backend_forzabile(self) -> None:
        self.assertEqual(self.parser.parse_args(["--backend", "dvt", "doctor"]).backend, "dvt")
        with self.assertRaises(SystemExit):
            self.parser.parse_args(["--backend", "inesistente", "doctor"])

    def test_senza_sottocomando_esce(self) -> None:
        with self.assertRaises(SystemExit):
            self.parser.parse_args([])


class CommandTest(unittest.IsolatedAsyncioTestCase):
    async def test_coordinate_invalide_non_toccano_il_dispositivo(self) -> None:
        """La validazione avviene prima di aprire tunnel e sessione."""
        args = cli.build_parser().parse_args(["set", "999", "0"])
        with mock.patch.object(cli, "LocationSession") as session_class:
            self.assertEqual(await cli.cmd_set(args), cli.EXIT_ERROR)
        session_class.assert_not_called()

    def test_app_senza_pywebview_spiega_l_alternativa(self) -> None:
        from gpssim.desktop import PywebviewUnavailableError

        args = cli.build_parser().parse_args(["app"])
        with mock.patch(
            "gpssim.desktop.run_desktop", side_effect=PywebviewUnavailableError()
        ):
            self.assertEqual(cli.cmd_app(args), cli.EXIT_ERROR)


class MainDispatchTest(unittest.TestCase):
    def test_i_comandi_sincroni_non_passano_da_asyncio_run(self) -> None:
        """`app` è sincrono perché pywebview vuole il thread principale: se
        finisse in `asyncio.run` la finestra non si aprirebbe."""
        with (
            mock.patch.object(cli, "cmd_app", return_value=cli.EXIT_OK) as handler,
            mock.patch("asyncio.run") as asyncio_run,
        ):
            # `set_defaults` cattura la funzione al momento della costruzione del
            # parser, quindi il parser va costruito dopo la patch.
            code = cli.main(["app"])
        self.assertEqual(code, cli.EXIT_OK)
        handler.assert_called_once()
        asyncio_run.assert_not_called()

    def test_i_comandi_async_passano_da_asyncio_run(self) -> None:
        with self._patched_asyncio_run(return_value=cli.EXIT_OK) as asyncio_run:
            self.assertEqual(cli.main(["devices"]), cli.EXIT_OK)
        asyncio_run.assert_called_once()

    def test_ctrl_c_esce_con_il_codice_convenzionale(self) -> None:
        with self._patched_asyncio_run(side_effect=KeyboardInterrupt):
            self.assertEqual(cli.main(["devices"]), cli.EXIT_INTERRUPTED)

    def test_un_errore_di_dominio_diventa_un_messaggio_non_un_traceback(self) -> None:
        from gpssim.errors import ErrorCode, GpsSimError

        with self._patched_asyncio_run(side_effect=GpsSimError(ErrorCode.DEVICE_LOCKED)):
            self.assertEqual(cli.main(["devices"]), cli.EXIT_ERROR)

    def _patched_asyncio_run(self, **kwargs):
        """`asyncio.run` finto che chiude la coroutine ricevuta.

        Senza la chiusura, `main()` crea `_run(args)` e nessuno lo attende: il
        RuntimeWarning che ne segue sporcherebbe l'output di tutta la suite.
        """
        def fake_run(coroutine, *args, **inner):
            coroutine.close()
            if "side_effect" in kwargs:
                raise kwargs["side_effect"]
            return kwargs.get("return_value")

        return mock.patch("asyncio.run", side_effect=fake_run)


if __name__ == "__main__":
    unittest.main()
