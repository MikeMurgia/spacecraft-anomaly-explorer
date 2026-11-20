"""Read the ESA-ADB label files and turn label rows into one row per event.

Each mission folder holds three label files:
  labels.csv         one row per (event id, channel, time interval) that the annotators marked
  anomaly_types.csv  one row per event id: category (Anomaly, Rare Event, ...), class, subclass, ...
  channels.csv       one row per telemetry channel, including the subsystem it belongs to
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

LABEL_FILES = ("labels.csv", "anomaly_types.csv", "channels.csv")
TYPE_COLUMNS = ("category", "class", "subclass", "dimensionality", "locality")


def mission_dirs(root: Path) -> dict[int, Path]:
    """Map mission number to folder, for every ESA-Mission<N> folder directly under root."""
    found: dict[int, Path] = {}
    for path in sorted(root.glob("ESA-Mission*")):
        number = path.name.removeprefix("ESA-Mission")
        if path.is_dir() and number.isdigit():
            found[int(number)] = path
    return found


def read_csv_lower(path: Path) -> pd.DataFrame:
    """Read a CSV and normalise its column names, e.g. 'StartTime' -> 'starttime'."""
    table = pd.read_csv(path)
    table.columns = [str(c).strip().lower().replace(" ", "_") for c in table.columns]
    return table


def read_label_tables(mission_dir: Path) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Return (labels, anomaly_types, channels) for one mission folder."""
    labels, types, channels = (read_csv_lower(mission_dir / name) for name in LABEL_FILES)
    return labels, types, channels


def parse_intervals(labels: pd.DataFrame) -> pd.DataFrame:
    """One row per labelled interval: id, channel, start, end (timestamps in UTC, timezone removed).

    A blank channel cell stays missing (<NA>) rather than becoming the text "nan".
    reversed is True where the end time is before the start time (a labelling error).
    """
    intervals = pd.DataFrame(
        {"id": labels["id"].astype("string"), "channel": labels["channel"].astype("string")}
    )
    intervals["start"] = pd.to_datetime(labels["starttime"], utc=True).dt.tz_localize(None)
    intervals["end"] = pd.to_datetime(labels["endtime"], utc=True).dt.tz_localize(None)
    intervals["reversed"] = intervals["end"] < intervals["start"]
    return intervals


def union_hours(starts: pd.Series, ends: pd.Series) -> float:
    """Hours covered by at least one interval. Overlapping time is counted once.

    Intervals with a missing start or end are skipped.
    """
    pairs = [(s, e) for s, e in zip(starts, ends, strict=True) if pd.notna(s) and pd.notna(e)]
    total = pd.Timedelta(0)
    run_start = run_end = None
    for start, end in sorted(pairs):
        if run_end is not None and start <= run_end:  # overlaps the current run: extend it
            run_end = max(run_end, end)
            continue
        if run_end is not None:  # a gap: close the current run
            total += run_end - run_start
        run_start, run_end = start, end
    if run_end is not None:
        total += run_end - run_start
    return total.total_seconds() / 3600


def group_events(
    intervals: pd.DataFrame, types: pd.DataFrame, channels: pd.DataFrame, mission: int
) -> pd.DataFrame:
    """Collapse labelled intervals into one row per event.

    span_h    = last end minus first start (what A2 called duration)
    covered_h = hours inside at least one labelled interval, so gaps between pieces are excluded
    Label rows with no channel still count towards the event's timing, but not towards its
    channels or subsystems; n_rows_no_channel records how many there were.
    """
    if "subsystem" in channels.columns:
        subsystem_of = dict(
            zip(channels["channel"].astype(str), channels["subsystem"].astype(str), strict=True)
        )
    else:
        subsystem_of = {}
    # A named channel missing from channels.csv gets "unknown"; a row with no channel gets no subsystem.
    subsystem = intervals["channel"].map(subsystem_of)
    has_channel = intervals["channel"].notna()
    subsystem[has_channel] = subsystem[has_channel].fillna("unknown")
    intervals = intervals.assign(subsystem=subsystem)

    rows = []
    for event_id, piece in intervals.groupby("id", sort=True):
        timed = piece[~piece["reversed"]]
        event_channels = sorted(piece["channel"].dropna().unique())
        event_subsystems = sorted(piece["subsystem"].dropna().unique())
        rows.append(
            {
                "id": f"m{mission}_{event_id}",
                "mission": mission,
                "start": timed["start"].min(),
                "end": timed["end"].max(),
                "covered_h": union_hours(timed["start"], timed["end"]),
                "n_intervals": len(piece),
                "n_rows_no_channel": int(piece["channel"].isna().sum()),
                "n_rows_reversed": int(piece["reversed"].sum()),
                "n_channels": len(event_channels),
                "n_subsystems": len(event_subsystems),
                "channels": "|".join(event_channels),
                "subsystems": "|".join(event_subsystems),
            }
        )
    events = pd.DataFrame(rows)
    events["span_h"] = (events["end"] - events["start"]).dt.total_seconds() / 3600

    meta = types.assign(id=f"m{mission}_" + types["id"].astype(str)).drop_duplicates("id")
    keep = ["id", *[c for c in TYPE_COLUMNS if c in meta.columns]]
    events = events.merge(meta[keep], on="id", how="left")
    if "category" not in events.columns:
        events["category"] = "Unknown"
    events["category"] = events["category"].fillna("Unknown")
    return events
