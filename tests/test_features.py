import numpy as np
import pandas as pd
import pytest

from pipeline.features import (
    categorical_channels,
    channel_event_features,
    compute_mission_features,
    frozen_share,
    interval_mask,
    state_shift,
    summarise_events,
)
from pipeline.labels import group_events, parse_intervals
from tests.helpers import write_zipped_pickle

T0 = pd.Timestamp("2000-01-01")
MINUTE = pd.Timedelta(minutes=1)


def minutes(n, start=T0):
    return pd.date_range(start, periods=n, freq="min")


def test_interval_mask_marks_inside_points_only():
    index = minutes(10)
    mask = interval_mask(index, [index[2], index[6]], [index[3], index[7]])
    assert mask.nonzero()[0].tolist() == [2, 3, 6, 7]


def test_interval_mask_accepts_times_finer_than_the_index():
    # a microsecond index with a label end that is not a whole microsecond used to raise ValueError
    index = minutes(10).as_unit("us")
    end = pd.DatetimeIndex([index[4] + pd.Timedelta(nanoseconds=500)]).as_unit("ns")
    mask = interval_mask(index, pd.DatetimeIndex([index[2]]), end)
    assert mask.nonzero()[0].tolist() == [2, 3, 4]


def test_frozen_share_skips_pairs_across_a_gap():
    times = pd.DatetimeIndex([T0, T0 + MINUTE, T0 + 2 * MINUTE, T0 + 60 * MINUTE])
    values = np.array([1.0, 1.0, 2.0, 2.0])
    # the last pair is 58 minutes apart, so only the first two pairs count: one repeat out of two
    assert frozen_share(times, values, max_step=5 * MINUTE) == pytest.approx(0.5)


def make_series(window_values, rng):
    """24 h of noisy baseline, then the given window values, at one sample per minute."""
    baseline = rng.normal(0, 1, 24 * 60)
    values = np.concatenate([baseline, window_values])
    return pd.Series(values, index=minutes(len(values)))


@pytest.mark.parametrize(
    ("window_kind", "expect_lvr_sign", "expect_frozen_up"),
    [("swings", 1, False), ("frozen", -1, True)],
)
def test_channel_event_features_detects_swings_and_freezes(window_kind, expect_lvr_sign, expect_frozen_up):
    rng = np.random.default_rng(0)
    window = rng.normal(0, 10, 120) if window_kind == "swings" else np.full(120, 0.3)
    series = make_series(window, rng)
    start = series.index[24 * 60]
    out = channel_event_features(
        series,
        masked=np.zeros(len(series), dtype=bool),
        window_starts=[start],
        window_ends=[series.index[-1]],
        baseline_start=start - pd.Timedelta(hours=6),
        baseline_end=start,
        floor=1e-6,
        max_step=5 * MINUTE,
    )
    assert out["status"] == "ok"
    assert np.sign(out["log_var_ratio"]) == expect_lvr_sign
    assert (out["frozen_delta"] > 0.5) == expect_frozen_up


def test_masked_baseline_samples_are_not_used():
    rng = np.random.default_rng(1)
    series = make_series(rng.normal(0, 1, 60), rng)
    start = series.index[24 * 60]
    masked = np.zeros(len(series), dtype=bool)
    masked[: 24 * 60] = True  # the whole baseline is covered by other labelled events
    out = channel_event_features(
        series, masked, [start], [series.index[-1]], start - pd.Timedelta(hours=6), start, 1e-6, 5 * MINUTE
    )
    assert out == {"kind": "numeric", "n_window": 60, "n_baseline": 0, "status": "few_baseline_samples"}


def test_compute_mission_features_end_to_end(tmp_path):
    """A fake mission: one anomaly that freezes channel_1, one rare event elsewhere, one reversed row."""
    rng = np.random.default_rng(2)
    values = rng.normal(0, 1, 3 * 24 * 60)
    values[2 * 24 * 60 : 2 * 24 * 60 + 120] = 0.5  # frozen for two hours on day 3
    frame = pd.DataFrame({"channel_1": values}, index=minutes(len(values)).tz_localize("UTC"))
    (tmp_path / "channels").mkdir()
    write_zipped_pickle(tmp_path / "channels" / "channel_1.zip", frame)

    day3 = (T0 + pd.Timedelta(days=2)).isoformat()
    day3_2h = (T0 + pd.Timedelta(days=2, hours=2)).isoformat()
    labels = pd.DataFrame(
        {
            "id": ["id_1", "id_2", "id_3"],
            "channel": ["channel_1", "channel_9", "channel_1"],
            "starttime": [day3, day3, "2000-01-02T02:00:00"],
            "endtime": [day3_2h, day3_2h, "2000-01-02T01:00:00"],  # id_3 ends before it starts
        }
    )
    types = pd.DataFrame(
        {"id": ["id_1", "id_2", "id_3"], "category": ["Anomaly", "Rare Event", "Communication Gap"]}
    )
    channels = pd.DataFrame({"channel": ["channel_1"], "subsystem": ["subsystem_1"]})
    intervals = parse_intervals(labels)
    events = group_events(intervals, types, channels, mission=1)

    features, reversed_check = compute_mission_features(1, tmp_path, events, intervals, log=lambda _: None)

    by_pair = features.set_index(["id", "channel"])
    frozen = by_pair.loc[("m1_id_1", "channel_1")]
    assert frozen["status"] == "ok"
    assert frozen["log_var_ratio"] < -5  # the freeze makes the window far quieter than the baseline
    assert frozen["frozen_delta"] > 0.9
    assert by_pair.loc[("m1_id_2", "channel_9"), "status"] == "no_file"
    assert reversed_check.loc[0, "samples_found"] == 61  # the telemetry has data, so it is not a real gap

    summary = summarise_events(events, features).set_index("id")
    assert summary.loc["m1_id_1", "feature_status"] == "ok"
    assert summary.loc["m1_id_2", "feature_status"] == "no_usable_channel"
    assert summary.loc["m1_id_3", "feature_status"] == "not_computed"


def test_categorical_channels_reads_the_flag():
    channels = pd.DataFrame({"channel": ["a", "b", "c"], "categorical": ["YES", "NO", "True"]})
    assert categorical_channels(channels) == {"a", "c"}


def test_state_shift():
    assert state_shift(np.array([0, 0, 1, 1]), np.array([0, 0, 1, 1]), 2) == pytest.approx(0.0)
    assert state_shift(np.array([1, 1]), np.array([0, 0]), 2) == pytest.approx(1.0)


def test_categorical_channel_that_switches_to_a_new_state():
    """Baseline flips between states 0 and 1; during the event it sits in a state never seen before."""
    labels = ["value_0", "value_1"] * (12 * 60) + ["value_2"] * 120
    series = pd.Series(pd.Categorical(labels), index=minutes(len(labels)))
    start = series.index[24 * 60]
    out = channel_event_features(
        series,
        np.zeros(len(series), dtype=bool),
        [start],
        [series.index[-1]],
        start - pd.Timedelta(hours=6),
        start,
        0.0,
        5 * MINUTE,
    )
    assert out["kind"] == "categorical"
    assert out["state_shift"] == pytest.approx(1.0)  # completely different states
    assert out["frozen_delta"] == pytest.approx(1.0)  # it never repeated before; now it never changes
    assert "log_var_ratio" not in out  # variance is meaningless for labels


def run_alarm(series, window_minutes):
    """Run channel_event_features on the last `window_minutes` samples, with a 6-hour baseline."""
    start = series.index[-window_minutes]
    floor = 0.0 if isinstance(series.dtype, pd.CategoricalDtype) else 1e-6
    return channel_event_features(
        series,
        np.zeros(len(series), dtype=bool),
        [start],
        [series.index[-1]],
        start - pd.Timedelta(hours=6),
        start,
        floor,
        5 * MINUTE,
    )


def test_spike_alarm_fires_at_the_first_far_sample():
    rng = np.random.default_rng(4)
    window = rng.normal(0, 1, 60)
    window[30] = 25.0  # 25 baseline standard deviations away
    out = run_alarm(make_series(window, rng), 60)
    assert out["alarm_kind"] == "spike"
    assert out["alarm_h"] == pytest.approx(30 / 60)


def test_freeze_alarm_fires_when_a_run_outlasts_the_baseline():
    rng = np.random.default_rng(5)
    out = run_alarm(make_series(np.full(60, 0.1), rng), 60)  # continuous noise never repeats exactly
    assert out["alarm_kind"] == "freeze"
    assert out["alarm_h"] < 5 / 60  # within a few minutes of the event start


def test_state_alarm_fires_on_the_first_unusual_state():
    labels = ["value_0"] * (24 * 60) + ["value_0"] * 10 + ["value_3"] * 50
    series = pd.Series(pd.Categorical(labels), index=minutes(len(labels)))
    out = run_alarm(series, 60)
    assert out["alarm_kind"] == "state"
    assert out["alarm_h"] == pytest.approx(10 / 60)


def test_no_alarm_when_the_window_looks_like_the_baseline():
    rng = np.random.default_rng(6)
    out = run_alarm(make_series(rng.normal(0, 1, 60), rng), 60)
    assert out["alarm_h"] is None and out["alarm_kind"] is None
