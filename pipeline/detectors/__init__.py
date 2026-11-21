"""Event-level detectors: given one labelled event's features, how anomalous is it?

Every detector follows the same small interface so the evaluation harness can treat them alike:

    detector.key          short id used in results.json and the app ("A", "B", "C", "D", "Dt", "conformal")
    detector.label        name shown in the app
    detector.description  one sentence on what the score means
    detector.learns       True if fit() learns from the training labels (rules learn nothing)
    detector.fit(X, y)    learn from training events (rule detectors learn nothing); returns self
    detector.score(X)     one number per event, higher = more anomalous

X is a DataFrame with the columns in MODEL_INPUTS (see pipeline/evaluate.py), y is 1 for Anomaly
and 0 for Rare Event.
"""

from __future__ import annotations

from typing import Protocol

import numpy as np
import pandas as pd


class Detector(Protocol):
    key: str
    label: str
    description: str
    learns: bool

    def fit(self, X: pd.DataFrame, y: np.ndarray) -> Detector: ...

    def score(self, X: pd.DataFrame) -> np.ndarray: ...


def all_detectors() -> list[Detector]:
    """The baselines, plus my own detector (skipped by the harness until it is implemented)."""
    from pipeline.detectors.baselines import baselines
    from pipeline.detectors.conformal_rare_event import ConformalRareEventDetector

    return [*baselines(), ConformalRareEventDetector()]
