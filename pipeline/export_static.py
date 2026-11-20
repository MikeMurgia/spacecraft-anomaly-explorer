"""Export the website's data into frontend/api/ so the hosted site needs no backend.

Run from the repo root after pipeline.prep_data:
    python -m pipeline.export_static

Writes:
    frontend/api/meta.json               missions, counts, which features exist, dataset credit
    frontend/api/events-mN.json          one entry per Anomaly / Rare Event, with event-level features
    frontend/api/signals/<event id>.json every channel the event touches, binned for plotting

Each signal file covers the event plus the same length of time before and after it (the period the
baseline was taken from), split into BINS equal time bins. Numeric channels keep the lowest and
highest value in each bin, so short spikes and flat stretches both stay visible; categorical
channels keep the most common state in each bin.
"""

from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

import numpy as np
import pandas as pd

from pipeline import config
from pipeline.features import BASELINE_MAX_H, BASELINE_MIN_H, TARGET_CATEGORIES, categorical_channels
from pipeline.labels import mission_dirs, parse_intervals, read_label_tables
from pipeline.telemetry import channel_files, load_channel

BINS = 200
SIGNIFICANT_DIGITS = 5
CITATION = (
    "De Canio, G., Kotowski, K., & Haskamp, C. (2025). ESA Anomalies Dataset (ESA-ADB). "
    "European Space Agency. https://doi.org/10.5281/zenodo.15237121"
)


def plot_window(start: pd.Timestamp, end: pd.Timestamp, span_h: float) -> tuple[pd.Timestamp, pd.Timestamp]:
    """The event plus its baseline length (clamped like the features) on each side."""
    pad = pd.Timedelta(hours=float(np.clip(span_h, BASELINE_MIN_H, BASELINE_MAX_H)))
    return start - pad, end + pad


def bin_index(times: pd.DatetimeIndex, t0: pd.Timestamp, t1: pd.Timestamp, bins: int) -> np.ndarray:
    """Which of `bins` equal time bins between t0 and t1 each timestamp falls in."""
    span = (t1 - t0).value
    position = (times.as_unit("ns").asi8 - t0.value) / span
    return np.clip((position * bins).astype(np.int64), 0, bins - 1)


def bin_min_max(times, values, t0, t1, bins=BINS) -> tuple[np.ndarray, np.ndarray]:
    """Lowest and highest value per bin; NaN where a bin has no samples."""
    lows = np.full(bins, np.inf)
    highs = np.full(bins, -np.inf)
    if len(values):
        index = bin_index(times, t0, t1, bins)
        np.minimum.at(lows, index, values)
        np.maximum.at(highs, index, values)
    empty = ~np.isfinite(lows)
    lows[empty], highs[empty] = np.nan, np.nan
    return lows, highs


def bin_mode(times, codes, t0, t1, n_states: int, bins=BINS) -> np.ndarray:
    """Most common state code per bin; -1 where a bin has no samples."""
    counts = np.zeros((bins, max(n_states, 1)), dtype=np.int64)
    if len(codes):
        np.add.at(counts, (bin_index(times, t0, t1, bins), codes), 1)
    modes = counts.argmax(axis=1)
    modes[counts.sum(axis=1) == 0] = -1
    return modes


def hours_between(earlier: pd.Timestamp, later: pd.Timestamp) -> float:
    return (later - earlier) / pd.Timedelta(hours=1)


def compact(values) -> list:
    """Round to SIGNIFICANT_DIGITS and turn NaN into null, to keep the JSON small and valid."""
    return [
        float(f"{v:.{SIGNIFICANT_DIGITS}g}") if np.isfinite(v) else None for v in np.asarray(values, float)
    ]


def number(value) -> float | None:
    return None if value is None or pd.isna(value) else float(f"{float(value):.{SIGNIFICANT_DIGITS}g}")


def json_value(value):
    """Make a table cell JSON-friendly: booleans stay booleans, numbers are rounded, blanks become null."""
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        return number(value)
    return None if pd.isna(value) else value


def export_mission(mission: int, mission_dir: Path, out: Path) -> dict:
    """Write one mission's event list and signal files; return its entry for meta.json."""
    events = pd.read_csv(config.DATA_PROCESSED / f"events_m{mission}.csv", parse_dates=["start", "end"])
    features = pd.read_csv(config.DATA_PROCESSED / f"channel_features_m{mission}.csv")
    labels, _types, channels = read_label_tables(mission_dir)
    intervals = parse_intervals(labels)
    intervals = intervals[~intervals["reversed"] & intervals["channel"].notna()].assign(
        eid=lambda t: f"m{mission}_" + t["id"]
    )
    subsystem_of = (
        dict(zip(channels["channel"].astype(str), channels["subsystem"].astype(str), strict=True))
        if "subsystem" in channels.columns
        else {}
    )
    flagged = categorical_channels(channels)

    targets = events[events["category"].isin(TARGET_CATEGORIES)].set_index("id")
    windows = {eid: plot_window(row["start"], row["end"], row["span_h"]) for eid, row in targets.iterrows()}
    stats = features.set_index(["id", "channel"])
    traces: dict[str, list] = {eid: [] for eid in targets.index}

    files = channel_files(mission_dir)
    needed = intervals[intervals["eid"].isin(targets.index)]
    for channel, rows in needed.groupby("channel"):
        path = files.get(channel.lower())
        try:
            series = load_channel(path) if path else None
        except Exception:  # the reason is already recorded in channel_features
            series = None
        if series is not None and channel in flagged and not isinstance(series.dtype, pd.CategoricalDtype):
            series = series.astype("category")
        for eid, pieces in rows.groupby("eid"):
            t0, t1 = windows[eid]
            info = stats.loc[(eid, channel)] if (eid, channel) in stats.index else pd.Series(dtype=object)
            trace = {
                "name": channel,
                "subsystem": str(subsystem_of.get(channel, "unknown")),
                "status": info.get("status", "no_file"),
                # the alarm is stored as hours from the event start; the plot measures from t0
                "alarm_h": number(info.get("alarm_h") + hours_between(t0, targets.at[eid, "start"]))
                if pd.notna(info.get("alarm_h"))
                else None,
                "alarm_kind": json_value(info.get("alarm_kind")),
                "labelled_h": [
                    [round(hours_between(t0, s), 4), round(hours_between(t0, e), 4)]
                    for s, e in zip(pieces["start"], pieces["end"], strict=True)
                ],
            }
            if series is not None and not series.empty:
                i0, i1 = series.index.searchsorted(t0), series.index.searchsorted(t1, side="right")
                part = series.iloc[i0:i1]
                if isinstance(series.dtype, pd.CategoricalDtype):
                    trace |= {
                        "kind": "categorical",
                        "states": [str(s) for s in series.cat.categories],
                        "mode": bin_mode(
                            part.index, part.cat.codes.to_numpy(), t0, t1, len(series.cat.categories)
                        ).tolist(),
                        "state_shift": number(info.get("state_shift")),
                        "frozen_delta": number(info.get("frozen_delta")),
                    }
                else:
                    lows, highs = bin_min_max(part.index, part.to_numpy(), t0, t1)
                    trace |= {
                        "kind": "numeric",
                        "min": compact(lows),
                        "max": compact(highs),
                        "baseline_mean": number(info.get("baseline_mean")),
                        "baseline_std": number(info.get("baseline_std")),
                        "log_var_ratio": number(info.get("log_var_ratio")),
                        "frozen_delta": number(info.get("frozen_delta")),
                    }
            traces[eid].append(trace)
        del series

    for eid, row in targets.iterrows():
        t0, t1 = windows[eid]
        payload = {
            "id": eid,
            "mission": mission,
            "category": row["category"],
            "t0": t0.isoformat() + "Z",
            "t1": t1.isoformat() + "Z",
            "bins": BINS,
            "event_h": [round(hours_between(t0, row["start"]), 4), round(hours_between(t0, row["end"]), 4)],
            "channels": traces[eid],
        }
        (out / "signals" / f"{eid}.json").write_text(json.dumps(payload, separators=(",", ":")))

    keep = [
        "category",
        "span_h",
        "covered_h",
        "n_channels",
        "n_subsystems",
        "n_channels_read",
        "lvr_median",
        "lvr_absmax",
        "frozen_delta_median",
        "state_shift_median",
        "n_channels_alarmed",
        "first_alarm_h",
        "feature_status",
        "long_event",
    ]
    rows_out = []
    for eid, row in targets.iterrows():
        entry = {
            "id": eid,
            "start": row["start"].isoformat() + "Z",
            "end": row["end"].isoformat() + "Z",
            "subsystems": [s for s in str(row["subsystems"]).split("|") if s and s != "nan"],
        }
        entry |= {column: json_value(row.get(column)) for column in keep}
        rows_out.append(entry)
    (out / f"events-m{mission}.json").write_text(json.dumps(rows_out, separators=(",", ":")))

    numeric_used = features.get("kind", pd.Series(dtype=str)).eq("numeric").any()
    categorical_used = features.get("kind", pd.Series(dtype=str)).eq("categorical").any()
    counts = events["category"].value_counts()
    return {
        "mission": mission,
        "events_per_category": {k: int(v) for k, v in counts.items()},
        "anomalies": int(counts.get("Anomaly", 0)),
        "rare_events": int(counts.get("Rare Event", 0)),
        "first": events["start"].min().isoformat() + "Z",
        "last": events["end"].max().isoformat() + "Z",
        "channels_in_mission": len(channels),
        "has_variance_ratio": bool(numeric_used),
        "has_state_shift": bool(categorical_used),
        "scored": int(counts.get("Anomaly", 0)) >= 30,  # Mission 3 (8 anomalies) is descriptive only
    }


def folder_size(path: Path) -> tuple[int, int, Path | None]:
    """(total bytes, number of files, largest file) under path."""
    files = [p for p in path.rglob("*") if p.is_file()]
    largest = max(files, key=lambda p: p.stat().st_size, default=None)
    return sum(p.stat().st_size for p in files), len(files), largest


def main() -> None:
    out = config.STATIC_API
    if not out.resolve().is_relative_to(config.ROOT):
        raise SystemExit(f"Refusing to write outside the repo: {out}")
    # Remove only this script's own outputs, so no stale event file survives a re-run while
    # files written by other steps (results.json from pipeline.evaluate) are kept.
    shutil.rmtree(out / "signals", ignore_errors=True)
    for old in [out / "meta.json", *out.glob("events-m*.json")]:
        old.unlink(missing_ok=True)
    (out / "signals").mkdir(parents=True)

    started = time.perf_counter()
    missions = []
    for mission, mission_dir in sorted(mission_dirs(config.esa_root()).items()):
        if not (config.DATA_PROCESSED / f"events_m{mission}.csv").exists():
            print(f"Mission {mission}: no processed tables; run python -m pipeline.prep_data first")
            continue
        print(f"Mission {mission}: exporting ...")
        missions.append(export_mission(mission, mission_dir, out))

    meta = {"missions": missions, "bins": BINS, "dataset": CITATION, "dataset_licence": "CC BY 3.0 IGO"}
    (out / "meta.json").write_text(json.dumps(meta, indent=2))

    total, count, largest = folder_size(out)
    print(f"\nWrote {count} files, {total / 1e6:.1f} MB in total, in {time.perf_counter() - started:.0f}s")
    if largest is not None:
        print(f"Largest file: {largest.name} ({largest.stat().st_size / 1e3:.0f} KB)")


if __name__ == "__main__":
    main()
