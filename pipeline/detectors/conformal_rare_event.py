"""Conformal rare-event detector (not implemented yet)

Idea: learn what ordinary rare events look like, using only the training fold's Rare Event rows.
Score each event by how unlike them it is, as a conformal p-value against a held-out calibration
set of rare events. An alarm at p <= alpha then has an expected false-alarm rate of at most alpha
among rare events like the calibration ones, which turns the app's alarm-budget slider into alpha.

What the methods must do:
    fit(X, y)  X: DataFrame with the columns in pipeline.evaluate.MODEL_INPUTS, one row per event
               y: numpy array, 1 = Anomaly, 0 = Rare Event
               Called once per cross-validation fold, on training events only. Uses only the
               Rare Event rows (y == 0): split them into a part to learn "normal" from and a
               calibration part. Any randomness uses pipeline.config.SEED. Returns self.
    score(X)   numpy array with one float per row of X, higher = more anomalous (for example
               1 - p-value). Uses only the values in X: never the row labels (event ids).
"""

from __future__ import annotations

import numpy as np
import pandas as pd


class ConformalRareEventDetector:
    key = "conformal"
    label = "Conformal: unlike rare events"
    description = "conformal p-value of how unlike the training rare events an event is"
    learns = True  # fit() uses the labels to pick out the rare events

    def fit(self, X: pd.DataFrame, y: np.ndarray) -> ConformalRareEventDetector:
        raise NotImplementedError("ConformalRareEventDetector.fit is not implemented yet")

    def score(self, X: pd.DataFrame) -> np.ndarray:
        raise NotImplementedError("ConformalRareEventDetector.score is not implemented yet")
