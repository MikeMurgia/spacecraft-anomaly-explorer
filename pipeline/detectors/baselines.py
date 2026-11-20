"""Baseline detectors A-D. A-C are one-feature rules; D is an off-the-shelf scikit-learn model."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from pipeline.config import SEED


@dataclass
class RuleDetector:
    """Scores each event by one feature: sign * feature, or its absolute value. Nothing is learned."""

    key: str
    label: str
    description: str
    column: str
    sign: float = 1.0
    absolute: bool = False
    learns: bool = False

    def fit(self, X: pd.DataFrame, y: np.ndarray) -> RuleDetector:
        return self

    def score(self, X: pd.DataFrame) -> np.ndarray:
        values = X[self.column].to_numpy(dtype=float)
        return self.sign * (np.abs(values) if self.absolute else values)


class LibraryLogistic:
    """Logistic regression on all model inputs, standardised first. Labelled as a library baseline.

    class_weight="balanced" weights the rare Anomaly class up so the model does not simply learn
    "always Rare Event" when only 5% of Mission 2's events are anomalies.
    """

    key = "D"
    learns = True
    label = "Library: logistic regression"
    description = "scikit-learn logistic regression on all event features (standardised, class-balanced)"

    def __init__(self) -> None:
        self.model = make_pipeline(
            StandardScaler(),
            LogisticRegression(class_weight="balanced", max_iter=1000, random_state=SEED),
        )

    def fit(self, X: pd.DataFrame, y: np.ndarray) -> LibraryLogistic:
        self.model.fit(X.to_numpy(dtype=float), y)
        return self

    def score(self, X: pd.DataFrame) -> np.ndarray:
        return self.model.predict_proba(X.to_numpy(dtype=float))[:, 1]


def baselines() -> list:
    return [
        RuleDetector(
            key="A",
            label="Looks dramatic",
            description="|median log variance ratio|: alarms on whatever changed most",
            column="lvr_median",
            absolute=True,
        ),
        RuleDetector(
            key="B",
            label="Looks stuck",
            description="median frozen-share change: alarms on channels repeating values more than usual",
            column="frozen_delta_median",
        ),
        RuleDetector(
            key="C",
            label="Touches few channels",
            description="minus the number of channels (log scale): alarms on narrow events",
            column="log_n_channels",
            sign=-1.0,
        ),
        LibraryLogistic(),
    ]
