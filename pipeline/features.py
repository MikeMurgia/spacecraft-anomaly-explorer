"""Per-channel and per-event telemetry features.

For every (event, channel) pair:
  window    = the samples inside the intervals the annotators marked for this event on this channel
  baseline  = the samples just before the event starts, over a period as long as the event
              (at least BASELINE_MIN_H, at most BASELINE_MAX_H), with every labelled interval on this
              channel and every mission-wide (no-channel) interval removed

Numeric channels:
  log_var_ratio = ln((var(window) + floor) / (var(baseline) + floor))
                  0 = no change, > 0 = more variable than usual, < 0 = quieter than usual
Categorical channels (each sample is a state label, so variance has no meaning):
  state_shift   = total variation distance between the state frequencies in window and baseline
                  0 = same mix of states, 1 = completely different states
Both kinds:
  frozen_delta  = share of repeated values in the window minus the same share in the baseline,
                  so a channel that always repeats values (coarse quantisation) scores near 0

Channel alarm (display only, used to sort channels by "earliest move" in the app; it is not one of
the event detectors that are evaluated):
  spike   first window sample more than ALARM_SIGMAS baseline standard deviations from the baseline mean
  freeze  the moment a run of identical values in the window becomes longer than any run in the baseline
  state   (categorical) first window sample whose state differs from the baseline's most common state
  alarm_h = hours from the event's start to the earliest of these
"""

from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pandas as pd

from pipeline.telemetry import channel_files, load_channel

TARGET_CATEGORIES = ("Anomaly", "Rare Event")
BASELINE_MIN_H = 6.0
BASELINE_MAX_H = 168.0
MIN_WINDOW_SAMPLES = 5
MIN_BASELINE_SAMPLES = 20
GAP_FACTOR = 5.0  # neighbouring samples further apart than 5x the usual spacing are a data gap
VAR_FLOOR_REL = 1e-3  # variance floor = (0.001 x the channel's overall std) squared
LONG_EVENT_H = 168.0  # events longer than a week are kept but flagged
ALARM_SIGMAS = 4.0  # spike alarm threshold, in baseline standard deviations
TRUE_WORDS = {"1", "true", "yes", "y", "t"}


def categorical_channels(channels: pd.DataFrame) -> set[str]:
    """Channel names that channels.csv marks as categorical (column 'categorical')."""
    if "categorical" not in channels.columns:
        return set()
    flagged = channels["categorical"].astype(str).str.strip().str.lower().isin(TRUE_WORDS)
    return set(channels.loc[flagged, "channel"].astype(str))


def interval_mask(index: pd.DatetimeIndex, starts, ends) -> np.ndarray:
    """True for every timestamp inside at least one [start, end] interval."""
    mask_delta = np.zeros(len(index) + 1, dtype=np.int64)
    if len(starts):
        lo = index.searchsorted(pd.DatetimeIndex(starts), side="left")
        hi = index.searchsorted(pd.DatetimeIndex(ends), side="right")
        np.add.at(mask_delta, lo, 1)
        np.add.at(mask_delta, hi, -1)
    return np.cumsum(mask_delta[:-1]) > 0


def frozen_share(times: pd.DatetimeIndex, values: np.ndarray, max_step: pd.Timedelta) -> float:
    """Share of neighbouring sample pairs whose value did not change. Pairs across a data gap are skipped."""
    if len(values) < 2:
        return float("nan")
    close = np.diff(times.as_unit("ns").asi8) <= max_step.value  # compare in nanoseconds on both sides
    if not close.any():
        return float("nan")
    return float((values[1:] == values[:-1])[close].mean())


def state_shift(window_codes: np.ndarray, baseline_codes: np.ndarray, n_states: int) -> float:
    """Total variation distance between two state-frequency distributions (0 = same, 1 = disjoint)."""
    p_window = np.bincount(window_codes, minlength=n_states) / len(window_codes)
    p_baseline = np.bincount(baseline_codes, minlength=n_states) / len(baseline_codes)
    return float(0.5 * np.abs(p_window - p_baseline).sum())


def identical_runs(times: pd.DatetimeIndex, values: np.ndarray, max_step: pd.Timedelta):
    """Start index and length of every run of identical values; a data gap ends a run."""
    if len(values) == 0:
        return np.array([], dtype=np.int64), np.array([], dtype=np.int64)
    same = (values[1:] == values[:-1]) & (np.diff(times.as_unit("ns").asi8) <= max_step.value)
    breaks = np.flatnonzero(~same) + 1
    starts = np.concatenate([[0], breaks])
    ends = np.concatenate([breaks, [len(values)]])
    return starts, ends - starts


def channel_alarm(
    w_times: pd.DatetimeIndex,
    w_values: np.ndarray,
    b_times: pd.DatetimeIndex,
    b_values: np.ndarray,
    categorical: bool,
    min_sigma: float,
    max_step: pd.Timedelta,
    event_start: pd.Timestamp,
) -> tuple[float | None, str | None]:
    """(hours from event start to the first alarm, alarm kind), or (None, None) if it never alarms."""
    candidates = []  # (index into the window, kind)
    if categorical:
        usual = np.bincount(b_values).argmax()
        changed = np.flatnonzero(w_values != usual)
        if len(changed):
            candidates.append((changed[0], "state"))
    else:
        limit = ALARM_SIGMAS * max(float(b_values.std()), min_sigma)
        far = np.flatnonzero(np.abs(w_values - b_values.mean()) > limit)
        if len(far):
            candidates.append((far[0], "spike"))
        _, b_lengths = identical_runs(b_times, b_values, max_step)
        longest = int(b_lengths.max()) if len(b_lengths) else 1
        w_starts, w_lengths = identical_runs(w_times, w_values, max_step)
        frozen = w_starts[w_lengths > longest]
        if len(frozen):
            candidates.append((int(frozen[0]) + longest, "freeze"))  # the sample that breaks the record
    if not candidates:
        return None, None
    index, kind = min(candidates)
    return (w_times[index] - event_start) / pd.Timedelta(hours=1), kind


def channel_event_features(
    series: pd.Series,
    masked: np.ndarray,
    window_starts,
    window_ends,
    baseline_start: pd.Timestamp,
    baseline_end: pd.Timestamp,
    floor: float,
    max_step: pd.Timedelta,
) -> dict:
    """Features for one event on one channel. masked marks samples the baseline must not use."""
    categorical = isinstance(series.dtype, pd.CategoricalDtype)
    times = series.index
    values = series.cat.codes.to_numpy() if categorical else series.to_numpy()

    i0 = times.searchsorted(min(window_starts), side="left")
    i1 = times.searchsorted(max(window_ends), side="right")
    in_window = interval_mask(times[i0:i1], window_starts, window_ends)
    w_times, w_values = times[i0:i1][in_window], values[i0:i1][in_window]

    j0 = times.searchsorted(baseline_start, side="left")
    j1 = times.searchsorted(baseline_end, side="left")  # stop before the event starts
    keep = ~masked[j0:j1]
    b_times, b_values = times[j0:j1][keep], values[j0:j1][keep]

    out = {
        "kind": "categorical" if categorical else "numeric",
        "n_window": len(w_values),
        "n_baseline": len(b_values),
    }
    if len(w_values) < MIN_WINDOW_SAMPLES:
        return out | {"status": "few_window_samples"}
    if len(b_values) < MIN_BASELINE_SAMPLES:
        return out | {"status": "few_baseline_samples"}

    frozen_w = frozen_share(w_times, w_values, max_step)
    frozen_b = frozen_share(b_times, b_values, max_step)
    alarm_h, alarm_kind = channel_alarm(
        w_times, w_values, b_times, b_values, categorical, np.sqrt(floor), max_step, baseline_end
    )
    out |= {
        "status": "ok",
        "frozen_window": frozen_w,
        "frozen_baseline": frozen_b,
        "frozen_delta": frozen_w - frozen_b,
        "alarm_h": alarm_h,
        "alarm_kind": alarm_kind,
    }
    if categorical:
        return out | {"state_shift": state_shift(w_values, b_values, len(series.cat.categories))}
    return out | {
        "log_var_ratio": float(np.log((w_values.var() + floor) / (b_values.var() + floor))),
        "baseline_mean": float(b_values.mean()),
        "baseline_std": float(b_values.std()),
    }


def compute_mission_features(
    mission: int,
    mission_dir: Path,
    events: pd.DataFrame,
    intervals: pd.DataFrame,
    categorical: set[str] = frozenset(),
    log: Callable[[str], None] = print,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Return (channel_features, reversed_check) for one mission.

    channel_features: one row per (event, channel) for Anomaly and Rare Event events.
    reversed_check:   for label rows whose end is before their start, how many telemetry samples
                      fall between the two timestamps (a real communication gap has almost none).
    categorical:      channels to treat as state labels even if they are stored as numbers.
    """
    files = channel_files(mission_dir)
    targets = events[events["category"].isin(TARGET_CATEGORIES)].set_index("id")

    timed = intervals[~intervals["reversed"]].assign(eid=lambda t: f"m{mission}_" + t["id"])
    mission_wide = timed[timed["channel"].isna()]
    needed = timed[timed["eid"].isin(targets.index) & timed["channel"].notna()]
    reversed_rows = intervals[intervals["reversed"] & intervals["channel"].notna()]

    channels = sorted(set(needed["channel"]) | set(reversed_rows["channel"]))
    rows, checks = [], []
    started = time.perf_counter()
    for n, channel in enumerate(channels, 1):
        pairs = needed[needed["channel"] == channel]
        path = files.get(channel.lower())
        problem, detail = None, ""
        try:
            series = load_channel(path) if path else None
        except Exception as error:  # keep going: one unreadable file must not stop the mission
            series, problem, detail = None, f"read_error: {type(error).__name__}", f" -> {error}"[:400]
        if series is None or series.empty:
            problem = problem or ("no_file" if path is None else "empty_file")
            rows += [{"id": eid, "channel": channel, "status": problem} for eid in pairs["eid"].unique()]
            log(f"  [{n}/{len(channels)}] {channel}: {problem}{detail}")
            continue
        if channel in categorical and not isinstance(series.dtype, pd.CategoricalDtype):
            series = series.astype("category")  # stored as numbers, but the numbers are state codes
        is_categorical = isinstance(series.dtype, pd.CategoricalDtype)

        steps = np.diff(series.index.as_unit("ns").asi8)  # sample spacing in nanoseconds
        max_step = pd.Timedelta(int(GAP_FACTOR * np.median(steps)) if len(steps) else 0)
        scale = float("nan") if is_categorical else float(series.std())
        on_channel = timed[timed["channel"] == channel]
        blocked = pd.concat([on_channel, mission_wide])
        masked = interval_mask(series.index, blocked["start"], blocked["end"])

        for eid, piece in pairs.groupby("eid"):
            row = {"id": eid, "channel": channel}
            if not is_categorical and not scale > 0:
                rows.append(row | {"kind": "numeric", "status": "constant_channel"})
                continue
            start = targets.at[eid, "start"]
            length = pd.Timedelta(
                hours=float(np.clip(targets.at[eid, "span_h"], BASELINE_MIN_H, BASELINE_MAX_H))
            )
            floor = 0.0 if is_categorical else (VAR_FLOOR_REL * scale) ** 2
            row |= channel_event_features(
                series, masked, piece["start"], piece["end"], start - length, start, floor, max_step
            )
            rows.append(row)

        for _, bad in reversed_rows[reversed_rows["channel"] == channel].iterrows():
            lo, hi = min(bad["start"], bad["end"]), max(bad["start"], bad["end"])
            found = int(series.index.searchsorted(hi, "right") - series.index.searchsorted(lo, "left"))
            usual = (hi - lo) / pd.Timedelta(int(np.median(steps))) if len(steps) else float("nan")
            checks.append(
                {
                    "id": f"m{mission}_{bad['id']}",
                    "channel": channel,
                    "from": lo,
                    "to": hi,
                    "samples_found": found,
                    "samples_if_no_gap": round(float(usual)),
                }
            )
        kind = "categorical" if is_categorical else "numeric"
        log(
            f"  [{n}/{len(channels)}] {channel} ({kind}): {len(pairs['eid'].unique())} events "
            f"({time.perf_counter() - started:.0f}s elapsed)"
        )
        del series, masked

    return pd.DataFrame(rows), pd.DataFrame(checks)


def summarise_events(events: pd.DataFrame, channel_features: pd.DataFrame) -> pd.DataFrame:
    """Add event-level features (medians across usable channels) and quality flags to the event table."""
    columns = [
        "n_channels_read",
        "n_categorical_read",
        "lvr_median",
        "lvr_absmax",
        "frozen_delta_median",
        "state_shift_median",
        "n_channels_alarmed",
        "first_alarm_h",
    ]
    if channel_features.empty or "frozen_delta" not in channel_features.columns:
        summary = pd.DataFrame(columns=columns)
    else:
        ok = channel_features[channel_features["status"] == "ok"].reindex(
            columns=["id", "channel", "kind", "log_var_ratio", "frozen_delta", "state_shift", "alarm_h"]
        )
        summary = ok.groupby("id").agg(
            n_channels_read=("channel", "size"),
            n_categorical_read=("kind", lambda k: int((k == "categorical").sum())),
            lvr_median=("log_var_ratio", "median"),
            lvr_absmax=("log_var_ratio", lambda s: float(s.abs().max())),
            frozen_delta_median=("frozen_delta", "median"),
            state_shift_median=("state_shift", "median"),
            n_channels_alarmed=("alarm_h", "count"),
            first_alarm_h=("alarm_h", "min"),
        )
    out = events.merge(summary, left_on="id", right_index=True, how="left")
    for column in ("n_channels_read", "n_categorical_read", "n_channels_alarmed"):
        out[column] = out[column].fillna(0).astype(int)
    target = out["category"].isin(TARGET_CATEGORIES)
    out["feature_status"] = np.where(
        ~target, "not_computed", np.where(out["n_channels_read"] > 0, "ok", "no_usable_channel")
    )
    out["long_event"] = out["span_h"] > LONG_EVENT_H
    return out
