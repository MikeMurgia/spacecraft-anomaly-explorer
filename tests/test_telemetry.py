import numpy as np
import pandas as pd

from pipeline.telemetry import channel_files, load_channel
from tests.helpers import write_zipped_pickle


def test_channel_files_finds_only_channel_files(tmp_path):
    folder = tmp_path / "channels"
    folder.mkdir()
    (folder / "channel_1.zip").write_bytes(b"")
    (folder / "telecommand_1.zip").write_bytes(b"")
    assert list(channel_files(tmp_path)) == ["channel_1"]


def test_load_channel_reads_zipped_pickle(tmp_path):
    index = pd.DatetimeIndex(["2000-01-01 00:02", "2000-01-01 00:00", "2000-01-01 00:01", "2000-01-01 00:01"])
    frame = pd.DataFrame({"channel_1": [3.0, 1.0, 2.0, 2.0]}, index=index.tz_localize("UTC"))
    path = tmp_path / "channel_1.zip"
    write_zipped_pickle(path, frame)

    series = load_channel(path)

    assert series.index.is_monotonic_increasing  # sorted
    assert series.index.is_unique  # duplicate timestamp dropped
    assert series.index.tz is None  # timezone removed, still UTC
    np.testing.assert_array_equal(series.to_numpy(), [1.0, 2.0, 3.0])


def test_load_channel_keeps_state_labels_as_categories(tmp_path):
    index = pd.date_range("2000-01-01", periods=3, freq="min", tz="UTC")
    frame = pd.DataFrame({"channel_1": ["value_0", "value_1", "value_0"]}, index=index)
    path = tmp_path / "channel_1.zip"
    write_zipped_pickle(path, frame)

    series = load_channel(path)

    assert isinstance(series.dtype, pd.CategoricalDtype)
    assert series.tolist() == ["value_0", "value_1", "value_0"]
