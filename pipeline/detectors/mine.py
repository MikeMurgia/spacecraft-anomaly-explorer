"""My detector (Phase 3).

The logic inside fit() and score() is written by me, Michael Murgia. The interface and this empty
stub were set up with AI assistance (see docs/AI_USAGE.md).

Until fit() and score() are implemented they raise NotImplementedError, and the evaluation harness
reports this detector as "not implemented yet" and carries on with the baselines.

Interface (the same as every detector in pipeline/detectors/__init__.py):
    fit(X, y)  X: DataFrame with the columns in pipeline.evaluate.MODEL_INPUTS, one row per event
               y: numpy array, 1 = Anomaly, 0 = Rare Event
               Called once per cross-validation fold, on training events only. Return self.
    score(X)   numpy array with one float per row of X, higher = more anomalous.
               Must not look at labels; only rows of X.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


class MyDetector:
    key = "mine"
    learns = True  # set to False if your detector is a fixed rule that ignores the training labels
    label = "My detector"
    description = "Phase 3: to be written by me"

    def fit(self, X: pd.DataFrame, y: np.ndarray) -> MyDetector:
        raise NotImplementedError("Phase 3: write MyDetector.fit")

    def score(self, X: pd.DataFrame) -> np.ndarray:
        raise NotImplementedError("Phase 3: write MyDetector.score")
