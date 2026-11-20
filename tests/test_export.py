import json

import numpy as np
import pandas as pd
import pytest

from pipeline import config, export_static, prep_data
from pipeline.export_static import bin_min_max, bin_mode, compact
from tests.helpers import write_zipped_pickle

T0 = pd.Timestamp("2000-01-01")
T1 = T0 + pd.Timedelta(hours=4)


def test_bin_min_max_keeps_extremes_and_marks_empty_bins():
    times = pd.DatetimeIndex([T0, T0 + pd.Timedelta(minutes=10), T0 + pd.Timedelta(hours=3, minutes=30)])
    lows, highs = bin_min_max(times, np.array([1.0, 5.0, -2.0]), T0, T1, bins=4)
    assert lows[0] == 1.0 and highs[0] == 5.0  # both samples in the first hour
    assert np.isnan(lows[1]) and np.isnan(highs[2])  # nothing in hours two and three
    assert lows[3] == highs[3] == -2.0


def test_bin_mode_picks_the_most_common_state():
    times = pd.DatetimeIndex([T0, T0 + pd.Timedelta(minutes=1), T0 + pd.Timedelta(minutes=2)])
    assert bin_mode(times, np.array([1, 1, 0]), T0, T1, n_states=2, bins=4).tolist() == [1, -1, -1, -1]


def test_compact_rounds_and_turns_nan_into_null():
    assert compact([1.234567, np.nan]) == [1.2346, None]


@pytest.fixture
def fake_repo(tmp_path, monkeypatch):
    """A fake mission on disk, with the pipeline's output folders redirected into tmp_path."""
    mission_dir = tmp_path / "raw" / "ESA-Mission2"
    (mission_dir / "channels").mkdir(parents=True)
    index = pd.date_range("2000-01-01", periods=5 * 24 * 60, freq="min", tz="UTC")
    values = np.random.default_rng(3).normal(0, 1, len(index))
    write_zipped_pickle(
        mission_dir / "channels" / "channel_1.zip", pd.DataFrame({"channel_1": values}, index=index)
    )
    pd.DataFrame(
        {
            "ID": ["id_1"],
            "Channel": ["channel_1"],
            "StartTime": ["2000-01-03T00:00:00Z"],
            "EndTime": ["2000-01-03T02:00:00Z"],
        }
    ).to_csv(mission_dir / "labels.csv", index=False)
    pd.DataFrame({"ID": ["id_1"], "Category": ["Anomaly"]}).to_csv(
        mission_dir / "anomaly_types.csv", index=False
    )
    pd.DataFrame({"Channel": ["channel_1"], "Subsystem": ["subsystem_1"]}).to_csv(
        mission_dir / "channels.csv", index=False
    )
    monkeypatch.setenv("ESA_ROOT", str(tmp_path / "raw"))
    monkeypatch.setattr(config, "ROOT", tmp_path)  # the export refuses to write outside ROOT
    monkeypatch.setattr(config, "DATA_PROCESSED", tmp_path / "processed")
    monkeypatch.setattr(config, "STATIC_API", tmp_path / "frontend" / "api")
    return mission_dir


def test_export_writes_meta_events_and_signals(fake_repo):
    prep_data.build_mission(2, fake_repo, labels_only=False)
    export_static.main()

    meta = json.loads((config.STATIC_API / "meta.json").read_text())
    assert meta["missions"][0]["anomalies"] == 1
    assert meta["missions"][0]["has_variance_ratio"] is True

    events = json.loads((config.STATIC_API / "events-m2.json").read_text())
    assert events[0]["id"] == "m2_id_1" and events[0]["feature_status"] == "ok"

    signal = json.loads((config.STATIC_API / "signals" / "m2_id_1.json").read_text())
    trace = signal["channels"][0]
    assert signal["bins"] == len(trace["min"]) == len(trace["max"])
    assert signal["event_h"] == [6.0, 8.0]  # the 2-hour event, with the 6-hour minimum padding before it
    assert trace["labelled_h"] == [[6.0, 8.0]]
    assert trace["kind"] == "numeric" and trace["baseline_std"] > 0
