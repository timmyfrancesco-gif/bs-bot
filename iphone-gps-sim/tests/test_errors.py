import unittest

from gpssim.errors import MESSAGES, ErrorCode, GpsSimError, classify


class _FakePmd3Error(Exception):
    """Finge un'eccezione di pymobiledevice3: la mappa è per nome di classe."""


DeveloperModeIsNotEnabledError = type("DeveloperModeIsNotEnabledError", (_FakePmd3Error,), {})
PasswordRequiredError = type("PasswordRequiredError", (_FakePmd3Error,), {})
SubclassOfMapped = type("SubclassOfMapped", (DeveloperModeIsNotEnabledError,), {})


class ClassifyTest(unittest.TestCase):
    def test_ogni_codice_ha_un_messaggio(self) -> None:
        for code in ErrorCode:
            self.assertIn(code, MESSAGES, f"manca il messaggio per {code}")
            self.assertTrue(MESSAGES[code].message)
            self.assertTrue(MESSAGES[code].hint)

    def test_gpssimerror_passa_invariato(self) -> None:
        original = GpsSimError(ErrorCode.DEVICE_LOCKED)
        self.assertIs(classify(original), original)

    def test_mappa_le_eccezioni_pymobiledevice3_per_nome(self) -> None:
        self.assertEqual(
            classify(DeveloperModeIsNotEnabledError()).code, ErrorCode.DEVELOPER_MODE_OFF
        )
        self.assertEqual(classify(PasswordRequiredError()).code, ErrorCode.DEVICE_LOCKED)

    def test_risale_la_gerarchia(self) -> None:
        self.assertEqual(classify(SubclassOfMapped()).code, ErrorCode.DEVELOPER_MODE_OFF)

    def test_errori_di_connessione_sono_cavo_staccato(self) -> None:
        self.assertEqual(classify(ConnectionResetError()).code, ErrorCode.CABLE_DISCONNECTED)
        self.assertEqual(classify(BrokenPipeError()).code, ErrorCode.CABLE_DISCONNECTED)

    def test_permessi(self) -> None:
        self.assertEqual(classify(PermissionError()).code, ErrorCode.INSUFFICIENT_PRIVILEGES)

    def test_default_configurabile(self) -> None:
        error = classify(ValueError("boom"), default=ErrorCode.LOCATION_PUSH_FAILED)
        self.assertEqual(error.code, ErrorCode.LOCATION_PUSH_FAILED)
        self.assertEqual(error.detail, "ValueError: boom")

    def test_to_dict_espone_quello_che_serve_alla_ui(self) -> None:
        payload = GpsSimError(ErrorCode.TUNNEL_LOST, detail="exit 1").to_dict()
        self.assertEqual(payload["code"], "tunnel_lost")
        self.assertEqual(payload["detail"], "exit 1")
        self.assertTrue(payload["message"])
        self.assertTrue(payload["hint"])


if __name__ == "__main__":
    unittest.main()
