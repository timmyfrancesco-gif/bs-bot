"""Profilo di velocità realistico per il playback di un giro.

Un giro a velocità costante è il primo indizio che la posizione è simulata:
nel traffico vero la velocità sale, scende per una curva o un incrocio, e poi
torna a salire — mai a scatti. Qui generiamo lo stesso tipo di andamento
attorno alla velocità target scelta dall'utente: si parte in crociera, il
ritmo cambia a piccoli passi limitati lungo il percorso, e la transizione tra
un passo e l'altro è sempre smussata.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass

#: Non scende mai sotto questa frazione della velocità target — a 70 km/h il
#: minimo è ~31 km/h, coerente con un giro che rallenta a 50 poi 40 e riparte.
MIN_SPEED_FACTOR = 0.45

#: Un cambio di ritmo ogni circa questi metri: non ad ogni singolo passo,
#: altrimenti la variazione sarebbe innaturale quanto la velocità costante.
ANCHOR_SPACING_M = 900.0

#: Variazione massima tra un'ancora e la successiva. Limita i salti bruschi;
#: la transizione fra le ancore è comunque smussata da `SpeedProfile.kmh_at`.
MAX_ANCHOR_STEP = 0.35


@dataclass(frozen=True)
class SpeedProfile:
    """Fattori di velocità (0..1 rispetto al target) lungo un giro."""

    target_kmh: float
    anchors: list[float]

    def kmh_at(self, fraction: float) -> float:
        """Velocità istantanea alla frazione di percorso ``fraction`` (0..1)."""
        return self.target_kmh * _factor_at(self.anchors, fraction)


def build_speed_profile(target_kmh: float, total_m: float, *, seed: int | None = None) -> SpeedProfile:
    """Genera un profilo di velocità per un giro lungo ``total_m`` metri.

    Si parte alla velocità di crociera (il target scelto dall'utente); da lì
    il ritmo si muove a piccoli passi casuali ma limitati (`MAX_ANCHOR_STEP`),
    mai sotto `MIN_SPEED_FACTOR` del target. Il risultato: il giro rallenta e
    riaccelera come nel traffico vero, invece di procedere a velocità
    costante dall'inizio alla fine.

    :param seed: fissa la sequenza casuale — utile nei test; ``None`` (il
        default) dà un andamento diverso a ogni giro.
    """
    target_kmh = max(0.0, target_kmh)
    if total_m <= 0 or target_kmh <= 0:
        return SpeedProfile(target_kmh=target_kmh, anchors=[1.0, 1.0])

    count = max(2, round(total_m / ANCHOR_SPACING_M) + 1)
    rng = random.Random(seed)
    anchors = [1.0]
    for _ in range(count - 1):
        step = rng.uniform(-MAX_ANCHOR_STEP, MAX_ANCHOR_STEP)
        anchors.append(min(1.0, max(MIN_SPEED_FACTOR, anchors[-1] + step)))
    return SpeedProfile(target_kmh=target_kmh, anchors=anchors)


def _factor_at(anchors: list[float], fraction: float) -> float:
    """Interpola tra le ancore con un andamento a coseno: accelerazioni e
    frenate morbide, mai a scalino."""
    if len(anchors) == 1:
        return anchors[0]
    fraction = min(1.0, max(0.0, fraction))
    scaled = fraction * (len(anchors) - 1)
    index = min(len(anchors) - 2, int(scaled))
    local = scaled - index
    eased = (1 - math.cos(local * math.pi)) / 2
    return anchors[index] + (anchors[index + 1] - anchors[index]) * eased
