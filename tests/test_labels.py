import pandas as pd
import pytest

from pipeline.labels import group_events, mission_dirs, parse_intervals, union_hours

T0 = pd.Timestamp("2000-01-01 00:00")


def hours(*values):
    return pd.Series([T0 + pd.Timedelta(hours=v) for v in values])


@pytest.mark.parametrize(
    ("starts", "ends", "expected"),
    [
        ((0, 1), (2, 3), 3.0),  # overlapping pieces count the shared hour once
        ((0, 2), (1, 3), 2.0),  # a gap between pieces is not counted
        ((0, 1), (4, 2), 4.0),  # a piece inside another adds nothing
        ((), (), 0.0),  # no pieces
    ],
)
def test_union_hours(starts, ends, expected):
    assert union_hours(hours(*starts), hours(*ends)) == pytest.approx(expected)


def test_parse_intervals_converts_to_utc():
    labels = pd.DataFrame(
        {
            "id": ["id_1"],
            "channel": ["channel_1"],
            "starttime": ["2000-01-01T01:00:00+01:00"],
            "endtime": ["2000-01-01T02:00:00+01:00"],
        }
    )
    out = parse_intervals(labels)
    assert out.loc[0, "start"] == pd.Timestamp("2000-01-01 00:00")
    assert out.loc[0, "end"] == pd.Timestamp("2000-01-01 01:00")


def test_group_events():
    intervals = pd.DataFrame(
        {
            "id": ["id_1", "id_1", "id_1", "id_2"],
            "channel": ["channel_1", "channel_1", "channel_2", "channel_9"],
            "start": hours(0, 3, 0, 5),
            "end": hours(1, 4, 2, 6),
            "reversed": False,
        }
    )
    types = pd.DataFrame({"id": ["id_1", "id_2"], "category": ["Anomaly", "Rare Event"]})
    channels = pd.DataFrame(
        {"channel": ["channel_1", "channel_2"], "subsystem": ["subsystem_1", "subsystem_2"]}
    )

    events = group_events(intervals, types, channels, mission=2).set_index("id")

    first = events.loc["m2_id_1"]
    assert first["span_h"] == pytest.approx(4.0)  # 0 h to 4 h
    assert first["covered_h"] == pytest.approx(3.0)  # 0-2 h and 3-4 h; the 2-3 h gap is excluded
    assert (first["n_intervals"], first["n_channels"], first["n_subsystems"]) == (3, 2, 2)
    assert first["category"] == "Anomaly"
    assert events.loc["m2_id_2", "subsystems"] == "unknown"  # channel_9 is not in channels.csv


def test_mission_dirs_keeps_only_numbered_folders(tmp_path):
    for name in ("ESA-Mission1", "ESA-Mission10", "ESA-MissionX"):
        (tmp_path / name).mkdir()
    (tmp_path / "ESA-Mission2.txt").write_text("not a folder")
    assert sorted(mission_dirs(tmp_path)) == [1, 10]


def test_rows_without_channel_count_for_timing_only():
    labels = pd.DataFrame(
        {
            "id": ["id_1", "id_1", "id_2"],
            "channel": ["channel_1", None, None],
            "starttime": ["2000-01-01T00:00:00Z", "2000-01-01T00:00:00Z", "2000-01-02T00:00:00Z"],
            "endtime": ["2000-01-01T02:00:00Z", "2000-01-01T03:00:00Z", "2000-01-02T01:00:00Z"],
        }
    )
    types = pd.DataFrame({"id": ["id_1", "id_2"], "category": ["Anomaly", "Rare Event"]})
    channels = pd.DataFrame({"channel": ["channel_1"], "subsystem": ["subsystem_1"]})

    events = group_events(parse_intervals(labels), types, channels, mission=3).set_index("id")

    first = events.loc["m3_id_1"]
    assert first["span_h"] == pytest.approx(3.0)  # the channel-less row extends the event to 3 h
    assert (first["n_channels"], first["n_rows_no_channel"], first["subsystems"]) == (1, 1, "subsystem_1")
    second = events.loc["m3_id_2"]
    assert (second["n_channels"], second["channels"], second["subsystems"]) == (0, "", "")


def test_reversed_rows_are_left_out_of_timing():
    labels = pd.DataFrame(
        {
            "id": ["id_1", "id_1"],
            "channel": ["channel_1", "channel_1"],
            "starttime": ["2000-01-01T00:00:00Z", "2000-01-05T00:00:00Z"],
            "endtime": ["2000-01-01T02:00:00Z", "2000-01-01T00:00:00Z"],  # second row ends before it starts
        }
    )
    types = pd.DataFrame({"id": ["id_1"], "category": ["Communication Gap"]})
    channels = pd.DataFrame({"channel": ["channel_1"], "subsystem": ["subsystem_1"]})

    intervals = parse_intervals(labels)
    assert intervals["reversed"].tolist() == [False, True]

    event = group_events(intervals, types, channels, mission=3).set_index("id").loc["m3_id_1"]
    assert event["span_h"] == pytest.approx(2.0)
    assert event["covered_h"] == pytest.approx(2.0)
    assert event["n_rows_reversed"] == 1
