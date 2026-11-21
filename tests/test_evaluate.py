import json

import numpy as np
import pandas as pd
import pytest

from pipeline import config, evaluate
from pipeline.evaluate import (
    FORBIDDEN_INPUTS,
    MODEL_INPUTS,
    bootstrap_indices,
    budget_curve,
    evaluation_set,
    metrics_with_intervals,
    pr_on_grid,
    roc_on_grid,
)


def fake_events(mission: int, anomalies: int, rare: int, seed: int) -> pd.DataFrame:
    """Events where anomalies touch fewer channels and are quieter, plus one event without features."""
    rng = np.random.default_rng(seed)
    n = anomalies + rare
    is_anomaly = np.arange(n) < anomalies
    start = pd.Timestamp("2000-01-01") + pd.to_timedelta(rng.uniform(0, 365, n), unit="D")
    events = pd.DataFrame(
        {
            "id": [f"m{mission}_id_{i}" for i in range(n)],
            "category": np.where(is_anomaly, "Anomaly", "Rare Event"),
            "start": start,
            "end": start + pd.Timedelta(hours=2),
            "n_channels": np.where(is_anomaly, rng.integers(1, 6, n), rng.integers(10, 40, n)),
            "n_subsystems": rng.integers(1, 3, n),
            "covered_h": rng.uniform(0.5, 5, n),
            "lvr_median": np.where(is_anomaly, rng.normal(-2, 1, n), rng.normal(3, 1, n)),
            "lvr_absmax": rng.uniform(1, 10, n),
            "frozen_delta_median": rng.normal(0, 0.05, n),
        }
    )
    no_features = {"id": f"m{mission}_id_x", "category": "Rare Event", "start": start[0], "end": start[0]}
    gap = {"id": f"m{mission}_id_g", "category": "Communication Gap", "start": start[0], "end": start[0]}
    return pd.concat([events, pd.DataFrame([no_features, gap])], ignore_index=True)


def test_inputs_never_include_annotator_labels():
    assert not FORBIDDEN_INPUTS & set(MODEL_INPUTS)


def test_evaluation_set_drops_other_categories_and_missing_features():
    X, y, excluded = evaluation_set(fake_events(2, anomalies=5, rare=20, seed=0))
    assert list(X.columns) == MODEL_INPUTS
    assert (len(y), int(y.sum())) == (25, 5)
    assert excluded == {"Rare Event": 1}  # the communication gap is not a target, so not "excluded"


def test_budget_curve_steps_through_every_threshold():
    curve = budget_curve(np.array([1, 0, 1, 0]), np.array([0.9, 0.8, 0.7, 0.1]), months=2.0)
    assert curve["caught"] == [0, 1, 1, 2, 2]
    assert curve["false_alarms"] == [0, 0, 1, 1, 2]
    assert curve["false_alarms_per_month"] == [0.0, 0.0, 0.5, 0.5, 1.0]


def test_curves_and_intervals_for_a_perfect_detector(monkeypatch):
    monkeypatch.setattr(evaluate, "N_BOOTSTRAP", 50)
    y = np.array([1, 1, 1, 0, 0, 0, 0, 0])
    scores = np.array([0.9, 0.8, 0.7, 0.4, 0.3, 0.2, 0.1, 0.0])
    assert roc_on_grid(y, scores)[1:].min() == 1.0  # every anomaly found before any false alarm
    assert pr_on_grid(y, scores).min() == 1.0
    result = metrics_with_intervals(y, scores, seed=1)
    assert result["roc_auc"] == 1.0 and result["roc_auc_ci"] == [1.0, 1.0]


def test_bootstrap_keeps_the_anomaly_count():
    y = np.array([1] * 3 + [0] * 7)
    idx = bootstrap_indices(y, np.random.default_rng(0))
    assert len(idx) == 10 and y[idx].sum() == 3


@pytest.fixture
def quick(monkeypatch):
    monkeypatch.setattr(evaluate, "N_BOOTSTRAP", 50)
    monkeypatch.setattr(evaluate, "CV_REPEATS", 2)


def test_run_scores_missions_transfer_and_skips_the_stub(quick):
    events = {
        1: fake_events(1, anomalies=40, rare=30, seed=1),
        2: fake_events(2, anomalies=31, rare=200, seed=2),
        3: fake_events(3, anomalies=8, rare=25, seed=3),
    }
    results = evaluate.run(events)

    m2 = results["missions"]["2"]
    assert m2["scored"] and not results["missions"]["3"]["scored"]  # 8 anomalies: descriptive only
    assert m2["detectors"]["C"]["roc_auc"] > 0.9  # fewer channels really does mark anomalies here
    assert m2["detectors"]["conformal"] == {"status": "not_implemented"}
    assert "cv_roc_auc_range" in m2["detectors"]["D"]  # a fitted model varies between repeats
    assert "cv_roc_auc_range" not in m2["detectors"]["C"]  # a fixed rule does not
    assert len(m2["detectors"]["A"]["scores"]) == 231
    assert results["transfer"]["detectors"]["D"]["status"] == "ok"


def test_main_writes_results_files(quick, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_PROCESSED", tmp_path)
    monkeypatch.setattr(config, "STATIC_API", tmp_path / "api")
    fake_events(2, anomalies=31, rare=60, seed=4).to_csv(tmp_path / "events_m2.csv", index=False)

    evaluate.main()

    results = json.loads((tmp_path / "api" / "results.json").read_text())
    assert results["missions"]["2"]["detectors"]["B"]["status"] == "ok"
    table = pd.read_csv(tmp_path / "results_summary.csv")
    assert set(table["detector"].str[0]) >= {"A", "B", "C", "D"}
