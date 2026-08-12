import unittest

from gpssim.speed import MIN_SPEED_FACTOR, build_speed_profile


class SpeedProfileTest(unittest.TestCase):
    def test_si_parte_alla_velocita_di_crociera(self) -> None:
        profile = build_speed_profile(70.0, 5_000.0, seed=1)
        self.assertAlmostEqual(profile.kmh_at(0.0), 70.0)

    def test_la_velocita_non_scende_mai_sotto_il_minimo_garantito(self) -> None:
        profile = build_speed_profile(70.0, 8_000.0, seed=42)
        floor = 70.0 * MIN_SPEED_FACTOR
        for i in range(101):
            fraction = i / 100
            self.assertGreaterEqual(profile.kmh_at(fraction), floor - 1e-9)
            self.assertLessEqual(profile.kmh_at(fraction), 70.0 + 1e-9)

    def test_la_velocita_varia_lungo_il_giro_non_e_costante(self) -> None:
        """Il punto della richiesta: non un valore fisso, ma un giro che
        rallenta e riprende — l'insieme dei valori campionati deve avere una
        variazione reale, non essere sempre lo stesso numero."""
        profile = build_speed_profile(70.0, 8_000.0, seed=7)
        samples = {round(profile.kmh_at(i / 200), 1) for i in range(201)}
        self.assertGreater(len(samples), 5)
        self.assertGreater(max(samples) - min(samples), 10.0)

    def test_le_transizioni_sono_morbide_non_a_scalino(self) -> None:
        """Due frazioni vicine non possono avere velocità molto diverse: la
        variazione è la stessa che si sente rallentando in auto, non un
        teletrasporto tra due velocità."""
        profile = build_speed_profile(70.0, 8_000.0, seed=3)
        previous = profile.kmh_at(0.0)
        for i in range(1, 501):
            current = profile.kmh_at(i / 500)
            self.assertLess(abs(current - previous), 5.0)
            previous = current

    def test_stesso_seed_stesso_andamento(self) -> None:
        a = build_speed_profile(60.0, 6_000.0, seed=99)
        b = build_speed_profile(60.0, 6_000.0, seed=99)
        for i in range(20):
            self.assertAlmostEqual(a.kmh_at(i / 20), b.kmh_at(i / 20))

    def test_percorso_senza_lunghezza_resta_alla_velocita_target(self) -> None:
        profile = build_speed_profile(80.0, 0.0, seed=1)
        self.assertEqual(profile.kmh_at(0.0), 80.0)
        self.assertEqual(profile.kmh_at(1.0), 80.0)

    def test_velocita_target_zero_o_negativa_non_solleva(self) -> None:
        profile = build_speed_profile(0.0, 1_000.0, seed=1)
        self.assertEqual(profile.kmh_at(0.5), 0.0)


if __name__ == "__main__":
    unittest.main()
