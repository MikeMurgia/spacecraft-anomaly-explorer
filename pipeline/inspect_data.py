"""What each ESA-ADB mission contains. Reads files only; writes nothing.

Run from the repo root with the virtual environment active:
    python -m pipeline.inspect_data
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import pandas as pd

from pipeline import config
from pipeline.labels import group_events, mission_dirs, parse_intervals, read_label_tables


def describe_files(mission_dir: Path) -> None:
    """List the top-level contents and count every file by extension."""
    top = []
    for path in sorted(mission_dir.iterdir()):
        top.append(f"{path.name}/" if path.is_dir() else f"{path.name} ({path.stat().st_size / 1e6:.1f} MB)")
    print("  top level:", ", ".join(top))
    counts: Counter[str] = Counter()
    total_bytes = 0
    for path in mission_dir.rglob("*"):
        if path.is_file():
            counts[path.suffix.lower() or "(no extension)"] += 1
            total_bytes += path.stat().st_size
    print(f"  all files by extension: {dict(counts.most_common())}  total {total_bytes / 1e9:.2f} GB")


def describe_labels(mission: int, mission_dir: Path) -> None:
    """Print columns, event counts, duration checks and channel counts for one mission."""
    labels, types, channels = read_label_tables(mission_dir)
    for name, table in (("labels", labels), ("anomaly_types", types), ("channels", channels)):
        print(f"  {name}.csv: {len(table)} rows, columns {list(table.columns)}")
        blanks = {column: int(n) for column, n in table.isna().sum().items() if n}
        if blanks:
            print(f"    blank cells per column: {blanks}")

    intervals = parse_intervals(labels)
    events = group_events(intervals, types, channels, mission)

    no_channel = intervals[intervals["channel"].isna()]
    if len(no_channel):
        affected = events[events["n_rows_no_channel"] > 0]
        print(
            f"\n  label rows with no channel: {len(no_channel)}, in {len(affected)} events "
            f"({int((affected['n_channels'] == 0).sum())} of those have no channel at all)"
        )
        print("  affected events per category:", affected["category"].value_counts().to_dict())
        shown = no_channel.head(5).drop(columns="reversed")
        print("  first rows:\n    " + shown.to_string(index=False).replace("\n", "\n    "))

    reversed_rows = intervals[intervals["reversed"]]
    if len(reversed_rows):
        hit = events[events["n_rows_reversed"] > 0]
        print(f"\n  label rows with end before start: {len(reversed_rows)}, in {len(hit)} events")
        print("  affected events per category:", hit["category"].value_counts().to_dict())
        shown = reversed_rows.head(5).drop(columns="reversed")
        print("  first rows:\n    " + shown.to_string(index=False).replace("\n", "\n    "))

    print(f"\n  events: {len(events)}  example ids: {events['id'].head(3).tolist()}")
    print("  events per category:", events["category"].value_counts().to_dict())
    for column in ("class", "subclass"):
        if column in events.columns:
            print(f"  {column} per category:")
            print(
                "    " + events.groupby("category")[column].value_counts().to_string().replace("\n", "\n    ")
            )
    print(f"  date range: {events['start'].min()} -> {events['end'].max()}")

    label_ids = set(intervals["id"])
    type_ids = set(types["id"].astype(str))
    print(
        f"  ids in labels but not anomaly_types: {len(label_ids - type_ids)}; "
        f"in anomaly_types but not labels: {len(type_ids - label_ids)}"
    )
    unknown = int(events["subsystems"].str.contains("unknown").sum())
    print(f"  events with a channel missing from channels.csv: {unknown}")

    per_channel = intervals.groupby(["id", "channel"]).size()
    repeated = int((per_channel > 1).sum())
    print(f"\n  event-channel pairs with more than one interval: {repeated} of {len(per_channel)}")
    gappy = events[events["covered_h"] < 0.9 * events["span_h"]]
    print(f"  events whose labelled pieces cover < 90% of their span: {len(gappy)}")
    longest = events.nlargest(5, "span_h")[["id", "category", "span_h", "covered_h", "n_intervals"]]
    print("  five longest spans:\n    " + longest.round(1).to_string(index=False).replace("\n", "\n    "))

    summary = events.groupby("category")[["span_h", "covered_h", "n_channels", "n_subsystems"]].agg(
        ["median", "min", "max"]
    )
    print(
        "\n  per category (median / min / max):\n    " + summary.round(2).to_string().replace("\n", "\n    ")
    )


def main() -> None:
    pd.set_option("display.width", 200)
    root = config.esa_root()
    missions = mission_dirs(root)
    if not missions:
        raise SystemExit(f"No ESA-Mission<N> folders found in {root}")
    print(f"ESA-ADB root: {root}")
    for mission, mission_dir in missions.items():
        print(f"\n=== Mission {mission}: {mission_dir.name} ===")
        describe_files(mission_dir)
        try:
            describe_labels(mission, mission_dir)
        except (KeyError, FileNotFoundError, ValueError) as error:
            # Keep going so the other missions still report; the message says what is missing.
            print(f"  could not read labels: {type(error).__name__}: {error}")


if __name__ == "__main__":
    main()
