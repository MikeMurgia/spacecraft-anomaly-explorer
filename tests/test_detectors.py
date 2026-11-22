import numpy as np
import pandas as pd
import pytest

from pipeline.detectors import all_detectors
from pipeline.detectors.baselines import TELEMETRY_INPUTS, LibraryLogistic, RuleDetector
from pipeline.detectors.conformal_rare_event import ConformalRareEventDetector
from pipeline.evaluate import MODEL_INPUTS

X = pd.DataFrame({"lvr_median": [-3.0, 0.5, 2.0]})


def test_rule_detector_applies_sign_and_absolute_value():
    assert RuleDetector("t", "t", "t", "lvr_median").score(X).tolist() == [-3.0, 0.5, 2.0]
    assert RuleDetector("t", "t", "t", "lvr_median", absolute=True).score(X).tolist() == [3.0, 0.5, 2.0]
    assert RuleDetector("t", "t", "t", "lvr_median", sign=-1).score(X).tolist() == [3.0, -0.5, -2.0]


def test_library_logistic_learns_a_separable_pattern():
    rng = np.random.default_rng(0)
    y = np.array([1] * 20 + [0] * 80)
    features = pd.DataFrame(rng.normal(0, 1, (100, len(MODEL_INPUTS))), columns=MODEL_INPUTS)
    features["log_n_channels"] -= 3 * y  # anomalies touch fewer channels
    scores = LibraryLogistic("D", "D", "D").fit(features, y).score(features)
    assert scores.shape == (100,)
    assert ((scores >= 0) & (scores <= 1)).all()
    assert scores[y == 1].mean() > scores[y == 0].mean()


def test_conformal_detector_is_a_stub_until_implemented():
    # Replace this test with real ones once fit() and score() are written.
    with pytest.raises(NotImplementedError):
        ConformalRareEventDetector().fit(X, np.array([0, 1, 0]))


def test_detector_keys_are_unique_and_include_the_conformal_detector():
    keys = [d.key for d in all_detectors()]
    assert len(keys) == len(set(keys))
    assert keys[-1] == "conformal"


def test_telemetry_only_variant_ignores_label_geometry():
    rng = np.random.default_rng(1)
    y = np.array([1] * 20 + [0] * 80)
    features = pd.DataFrame(rng.normal(0, 1, (100, len(MODEL_INPUTS))), columns=MODEL_INPUTS)
    model = LibraryLogistic("Dt", "Dt", "Dt", columns=TELEMETRY_INPUTS).fit(features, y)
    changed = features.copy()
    changed[["log_n_channels", "n_subsystems", "log_covered_h"]] = 99.0  # annotator-derived inputs
    np.testing.assert_allclose(model.score(features), model.score(changed))
