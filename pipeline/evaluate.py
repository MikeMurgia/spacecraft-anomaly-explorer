"""Phase 2: evaluate every detector on every scored mission, and Mission 2 -> Mission 1 transfer.

Run from the repo root after pipeline.prep_data:
    python -m pipeline.evaluate

Task (event-level, not streaming): given one labelled event, score how likely it is to be an
Anomaly rather than a Rare Event. Higher score = more anomalous.

Method
  * Events: Anomaly and Rare Event only, with usable telemetry features (others are counted, not used).
  * Cross-validation: repeated stratified 5-fold, 10 repeats, fixed seed. Every event is scored by a
    model that never saw it; its final score is the average of its 10 out-of-fold scores. Rule
    detectors learn nothing, so their scores are simply the rule applied to every event.
  * Uncertainty: stratified bootstrap of events (2000 resamples, anomaly count held fixed) gives 95%
    intervals for ROC-AUC and PR-AUC and bands around the curves.
  * Alarm budget: for every threshold, anomalies caught vs false alarms (rare events above the
    threshold) per month of the mission's labelled period.
  * Transfer: fit on all usable Mission 2 events, score Mission 1. ROC-AUC is the headline because
    PR-AUC depends on how common anomalies are (4.8% in Mission 2, 60% in Mission 1).

Writes frontend/api/results.json (read by the app) and data/processed/results_summary.csv.
"""

from __future__ import annotations

import copy
import json
import time

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, precision_recall_curve, roc_auc_score, roc_curve
from sklearn.model_selection import RepeatedStratifiedKFold

from pipeline import config
from pipeline.detectors import Detector, all_detectors
from pipeline.features import TARGET_CATEGORIES

MODEL_INPUTS = [
    "log_n_channels",  # log(1 + channels touched)
    "n_subsystems",
    "log_covered_h",  # log(1 + labelled hours)
    "lvr_median",
    "lvr_absmax",
    "frozen_delta_median",
]
# Annotator labels: describing the event's class in other words. Never a model input.
FORBIDDEN_INPUTS = {"id", "category", "class", "subclass", "dimensionality", "locality", "length"}
MIN_ANOMALIES_TO_SCORE = 30  # Mission 3 (8 anomalies) is descriptive only
CV_SPLITS, CV_REPEATS = 5, 10
N_BOOTSTRAP = 2000
GRID = np.linspace(0, 1, 101)  # common x axis for averaged curves and their bands
TRANSFER = (2, 1)  # (train mission, test mission)
DAYS_PER_MONTH = 30.44


# ---------- data ----------


def model_inputs(events: pd.DataFrame) -> pd.DataFrame:
    """The feature table every detector sees, one row per event, indexed by event id."""
    X = pd.DataFrame(
        {
            "log_n_channels": np.log1p(events["n_channels"].astype(float)),
            "n_subsystems": events["n_subsystems"].astype(float),
            "log_covered_h": np.log1p(events["covered_h"].astype(float)),
            "lvr_median": events["lvr_median"].astype(float),
            "lvr_absmax": events["lvr_absmax"].astype(float),
            "frozen_delta_median": events["frozen_delta_median"].astype(float),
        }
    )
    X.index = events["id"]
    leaked = FORBIDDEN_INPUTS & set(X.columns)
    if leaked:
        raise ValueError(f"label-derived columns must never be model inputs: {sorted(leaked)}")
    return X[MODEL_INPUTS]


def evaluation_set(events: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray, dict]:
    """(X, y, excluded) for the Anomaly / Rare Event events whose inputs are all present."""
    targets = events[events["category"].isin(TARGET_CATEGORIES)]
    X = model_inputs(targets)
    usable = X.notna().all(axis=1).to_numpy()
    excluded = targets.loc[~usable, "category"].value_counts().to_dict()
    y = (targets.loc[usable, "category"] == "Anomaly").to_numpy(dtype=int)
    return X[usable], y, {k: int(v) for k, v in excluded.items()}


def mission_months(events: pd.DataFrame) -> float:
    """Length of the mission's labelled period, first event start to last event end, in months."""
    span = pd.to_datetime(events["end"]).max() - pd.to_datetime(events["start"]).min()
    return span / pd.Timedelta(days=DAYS_PER_MONTH)


# ---------- scoring ----------


def out_of_fold_scores(detector: Detector, X: pd.DataFrame, y: np.ndarray) -> tuple[np.ndarray, list[float]]:
    """Average out-of-fold score per event over all repeats, and the ROC-AUC of each repeat."""
    splitter = RepeatedStratifiedKFold(n_splits=CV_SPLITS, n_repeats=CV_REPEATS, random_state=config.SEED)
    per_repeat = np.full((CV_REPEATS, len(y)), np.nan)
    for fold, (train, test) in enumerate(splitter.split(X, y)):
        # a fresh copy for every fold, so nothing learned in one fold leaks into another
        model = copy.deepcopy(detector).fit(X.iloc[train], y[train])
        per_repeat[fold // CV_SPLITS, test] = model.score(X.iloc[test])
    repeat_auc = [float(roc_auc_score(y, scores)) for scores in per_repeat]
    return per_repeat.mean(axis=0), repeat_auc


# ---------- metrics ----------


def roc_on_grid(y: np.ndarray, scores: np.ndarray) -> np.ndarray:
    """True positive rate at each false positive rate in GRID."""
    fpr, tpr, _ = roc_curve(y, scores)
    return np.interp(GRID, fpr, tpr)


def pr_on_grid(y: np.ndarray, scores: np.ndarray) -> np.ndarray:
    """Interpolated precision at each recall in GRID: best precision reachable at that recall or above."""
    precision, recall, _ = precision_recall_curve(y, scores)
    order = np.argsort(recall)
    recall, precision = recall[order], precision[order]
    best_from_here = np.maximum.accumulate(precision[::-1])[::-1]
    return best_from_here[np.clip(np.searchsorted(recall, GRID, side="left"), 0, len(recall) - 1)]


def bootstrap_indices(y: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Resample anomalies and rare events separately, so every resample keeps the same anomaly count."""
    positives, negatives = np.flatnonzero(y == 1), np.flatnonzero(y == 0)
    return np.concatenate(
        [
            rng.choice(positives, len(positives), replace=True),
            rng.choice(negatives, len(negatives), replace=True),
        ]
    )


def metrics_with_intervals(y: np.ndarray, scores: np.ndarray, seed: int) -> dict:
    """Point estimates, 95% bootstrap intervals and curve bands for ROC and precision-recall."""
    rng = np.random.default_rng(seed)
    roc_aucs, pr_aucs, roc_curves, pr_curves = [], [], [], []
    for _ in range(N_BOOTSTRAP):
        idx = bootstrap_indices(y, rng)
        roc_aucs.append(roc_auc_score(y[idx], scores[idx]))
        pr_aucs.append(average_precision_score(y[idx], scores[idx]))
        roc_curves.append(roc_on_grid(y[idx], scores[idx]))
        pr_curves.append(pr_on_grid(y[idx], scores[idx]))

    def interval(values) -> list[float]:
        return [float(np.percentile(values, 2.5)), float(np.percentile(values, 97.5))]

    def band(curves) -> dict:
        stacked = np.vstack(curves)
        return {"lo": np.percentile(stacked, 2.5, axis=0), "hi": np.percentile(stacked, 97.5, axis=0)}

    return {
        "roc_auc": float(roc_auc_score(y, scores)),
        "roc_auc_ci": interval(roc_aucs),
        "pr_auc": float(average_precision_score(y, scores)),
        "pr_auc_ci": interval(pr_aucs),
        "roc": {"fpr": GRID, "tpr": roc_on_grid(y, scores), **band(roc_curves)},
        "pr": {"recall": GRID, "precision": pr_on_grid(y, scores), **band(pr_curves)},
    }


def budget_curve(y: np.ndarray, scores: np.ndarray, months: float) -> dict:
    """Anomalies caught vs false alarms per month as the alarm threshold is lowered, step by step."""
    thresholds = np.unique(scores)[::-1]
    caught = [int(((scores >= t) & (y == 1)).sum()) for t in thresholds]
    false_alarms = [int(((scores >= t) & (y == 0)).sum()) for t in thresholds]
    return {
        "threshold": [float("inf"), *thresholds.tolist()],  # inf = alarm on nothing
        "caught": [0, *caught],
        "false_alarms": [0, *false_alarms],
        "false_alarms_per_month": [0.0, *(np.array(false_alarms) / months).tolist()],
    }


# ---------- running ----------


def evaluate_detector(detector, X, y, months, seed, train=None) -> dict:
    """Score one detector (cross-validated, or trained on `train` for transfer) and measure it."""
    try:
        if train is None:
            scores, repeat_auc = out_of_fold_scores(detector, X, y)
        else:
            X_train, y_train = train
            scores = copy.deepcopy(detector).fit(X_train, y_train).score(X)
            repeat_auc = []
    except NotImplementedError:
        return {"status": "not_implemented"}
    result = {
        "status": "ok",
        **metrics_with_intervals(y, scores, seed),
        "budget": budget_curve(y, scores, months),
    }
    if repeat_auc and detector.learns:  # how much a learned model's quality depends on the fold split
        result["cv_roc_auc_range"] = [min(repeat_auc), max(repeat_auc)]
    result["scores"] = dict(zip(X.index, scores.tolist(), strict=True))
    return result


def describe(detector) -> dict:
    return {"key": detector.key, "label": detector.label, "description": detector.description}


def run(events_by_mission: dict[int, pd.DataFrame]) -> dict:
    """Evaluate all detectors. Returns the results.json structure."""
    detectors = all_detectors()
    results: dict = {
        "task": "event-level: Anomaly vs Rare Event, higher score = more anomalous",
        "seed": config.SEED,
        "cv": {"splits": CV_SPLITS, "repeats": CV_REPEATS},
        "bootstrap": N_BOOTSTRAP,
        "model_inputs": MODEL_INPUTS,
        "detectors": [describe(d) for d in detectors],
        "missions": {},
    }
    for mission, events in sorted(events_by_mission.items()):
        X, y, excluded = evaluation_set(events)
        entry = {
            "anomalies": int(y.sum()),
            "rare_events": int(len(y) - y.sum()),
            "excluded_no_features": excluded,
            "prevalence": float(y.mean()) if len(y) else None,
            "months": mission_months(events),
            "scored": int(y.sum()) >= MIN_ANOMALIES_TO_SCORE,
        }
        if entry["scored"]:
            print(f"Mission {mission}: {entry['anomalies']} anomalies, {entry['rare_events']} rare events")
            entry["detectors"] = {
                d.key: evaluate_detector(d, X, y, entry["months"], config.SEED + mission) for d in detectors
            }
        results["missions"][str(mission)] = entry

    train_m, test_m = TRANSFER
    if train_m in events_by_mission and test_m in events_by_mission:
        X_train, y_train, _ = evaluation_set(events_by_mission[train_m])
        X_test, y_test, _ = evaluation_set(events_by_mission[test_m])
        months = mission_months(events_by_mission[test_m])
        print(f"Transfer: train on Mission {train_m}, test on Mission {test_m}")
        results["transfer"] = {
            "train": train_m,
            "test": test_m,
            "prevalence": float(y_test.mean()),
            "detectors": {
                d.key: evaluate_detector(d, X_test, y_test, months, config.SEED + 100, (X_train, y_train))
                for d in detectors
            },
        }
    return results


# ---------- output ----------


def rounded(value, digits: int = 4):
    """Recursively round floats, turn NaN/inf into null and numpy types into plain Python, for JSON."""
    if isinstance(value, dict):
        return {k: rounded(v, digits) for k, v in value.items()}
    if isinstance(value, (list, tuple, np.ndarray)):
        return [rounded(v, digits) for v in value]
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        return round(float(value), digits) if np.isfinite(value) else None
    return value


def summary_table(results: dict) -> pd.DataFrame:
    rows = []
    sections = [(f"Mission {m}", e.get("detectors", {})) for m, e in results["missions"].items()]
    if "transfer" in results:
        t = results["transfer"]
        sections.append((f"Mission {t['train']} -> {t['test']}", t["detectors"]))
    labels = {d["key"]: d["label"] for d in results["detectors"]}
    for setting, detectors in sections:
        for key, r in detectors.items():
            if r["status"] != "ok":
                rows.append({"setting": setting, "detector": f"{key} {labels[key]}", "status": r["status"]})
                continue
            rows.append(
                {
                    "setting": setting,
                    "detector": f"{key} {labels[key]}",
                    "roc_auc": r["roc_auc"],
                    "roc_auc_lo": r["roc_auc_ci"][0],
                    "roc_auc_hi": r["roc_auc_ci"][1],
                    "pr_auc": r["pr_auc"],
                    "pr_auc_lo": r["pr_auc_ci"][0],
                    "pr_auc_hi": r["pr_auc_ci"][1],
                    "status": "ok",
                }
            )
    return pd.DataFrame(rows)


def print_table(table: pd.DataFrame, results: dict) -> None:
    if table.empty:
        print(f"\nNo mission has at least {MIN_ANOMALIES_TO_SCORE} anomalies, so nothing was scored")
        return
    for setting, rows in table.groupby("setting", sort=False):
        mission = setting.split()[-1]
        prevalence = (
            results["transfer"]["prevalence"]
            if "->" in setting
            else results["missions"][mission]["prevalence"]
        )
        print(f"\n{setting}  (PR no-skill = {prevalence:.3f}, ROC no-skill = 0.500)")
        for _, r in rows.iterrows():
            if r["status"] != "ok":
                print(f"  {r['detector']:<42} {r['status']}")
                continue
            roc = f"{r['roc_auc']:.3f} [{r['roc_auc_lo']:.3f}, {r['roc_auc_hi']:.3f}]"
            pr = f"{r['pr_auc']:.3f} [{r['pr_auc_lo']:.3f}, {r['pr_auc_hi']:.3f}]"
            print(f"  {r['detector']:<42} ROC-AUC {roc}   PR-AUC {pr}")


def main() -> None:
    started = time.perf_counter()
    events_by_mission = {}
    for path in sorted(config.DATA_PROCESSED.glob("events_m*.csv")):
        mission = int(path.stem.removeprefix("events_m"))
        events_by_mission[mission] = pd.read_csv(path)
    if not events_by_mission:
        raise SystemExit("No processed tables; run python -m pipeline.prep_data first")

    results = rounded(run(events_by_mission))
    config.STATIC_API.mkdir(parents=True, exist_ok=True)
    (config.STATIC_API / "results.json").write_text(json.dumps(results, separators=(",", ":")))

    table = summary_table(results)
    table.to_csv(config.DATA_PROCESSED / "results_summary.csv", index=False)
    print_table(table, results)
    print(f"\nWrote results.json and results_summary.csv in {time.perf_counter() - started:.0f}s")


if __name__ == "__main__":
    main()
