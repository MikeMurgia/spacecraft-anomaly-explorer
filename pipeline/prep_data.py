"""Build the processed event tables from the raw ESA-ADB files.

Run from the repo root with the virtual environment active:
    python -m pipeline.prep_data                  # every mission found, with telemetry features
    python -m pipeline.prep_data --missions 2     # one mission
    python -m pipeline.prep_data --labels-only    # skip telemetry (fast)

Writes, per mission N, into data/processed/:
    events_mN.csv            one row per labelled event (all categories)
    channel_features_mN.csv  one row per (event, channel) for Anomaly and Rare Event events
    quality_mN.json          counts and data-quality checks for data/README.md and the report
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import pandas as pd

from pipeline import config
from pipeline.features import categorical_channels, compute_mission_features, summarise_events
from pipeline.labels import group_events, mission_dirs, parse_intervals, read_label_tables


def build_mission(mission: int, mission_dir: Path, labels_only: bool) -> dict:
    """Process one mission, write its files and return its quality summary."""
    started = time.perf_counter()
    labels, types, channels = read_label_tables(mission_dir)
    intervals = parse_intervals(labels)
    events = group_events(intervals, types, channels, mission)

    if labels_only:
        channel_features, reversed_check = pd.DataFrame(), pd.DataFrame()
    else:
        channel_features, reversed_check = compute_mission_features(
            mission, mission_dir, events, intervals, categorical=categorical_channels(channels)
        )
    events = summarise_events(events, channel_features)

    config.DATA_PROCESSED.mkdir(parents=True, exist_ok=True)
    events.to_csv(config.DATA_PROCESSED / f"events_m{mission}.csv", index=False)
    if not labels_only:
        channel_features.to_csv(config.DATA_PROCESSED / f"channel_features_m{mission}.csv", index=False)

    quality = {
        "mission": mission,
        "events_per_category": events["category"].value_counts().to_dict(),
        "label_rows": len(intervals),
        "label_rows_no_channel": int(intervals["channel"].isna().sum()),
        "label_rows_end_before_start": int(intervals["reversed"].sum()),
        "long_events": events.loc[events["long_event"], ["id", "category", "span_h"]]
        .round(1)
        .to_dict("records"),
        "feature_status": events["feature_status"].value_counts().to_dict(),
        "channel_status": (
            channel_features["status"].value_counts().to_dict() if not channel_features.empty else {}
        ),
        "channels_flagged_categorical_in_channels_csv": len(categorical_channels(channels)),
        "channel_kinds_used": (
            channel_features.dropna(subset=["kind"])
            .drop_duplicates("channel")["kind"]
            .value_counts()
            .to_dict()
            if "kind" in channel_features.columns
            else {}
        ),
        "reversed_rows_vs_telemetry": reversed_check.astype(str).to_dict("records"),
        "seconds": round(time.perf_counter() - started, 1),
    }
    (config.DATA_PROCESSED / f"quality_m{mission}.json").write_text(json.dumps(quality, indent=2))
    return quality


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--missions", type=int, nargs="+", help="default: every mission found")
    parser.add_argument("--labels-only", action="store_true", help="skip telemetry features")
    args = parser.parse_args()

    found = mission_dirs(config.esa_root())
    missing = sorted(set(args.missions or []) - set(found))
    if missing:
        raise SystemExit(f"No folder for mission(s) {missing} in {config.esa_root()}; found {sorted(found)}")

    for mission in args.missions or sorted(found):
        print(f"\n=== Mission {mission} ===")
        quality = build_mission(mission, found[mission], args.labels_only)
        shown = {k: v for k, v in quality.items() if k not in ("reversed_rows_vs_telemetry", "long_events")}
        shown["long_events"] = f"{len(quality['long_events'])} (listed in quality_m{mission}.json)"
        print(json.dumps(shown, indent=2))
        for check in quality["reversed_rows_vs_telemetry"]:
            print(
                f"  reversed row {check['id']} {check['channel']}: {check['samples_found']} samples "
                f"found, about {check['samples_if_no_gap']} expected if there were no gap"
            )


if __name__ == "__main__":
    main()
