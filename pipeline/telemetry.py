"""Read ESA-ADB telemetry: one file per channel in <mission>/channels/, usually a zip holding a pickle.

Ported from the A2 reader, which worked on the real Mission 2 files. Pickles can run code when
loaded, so this is only safe because the files come from the official ESA-ADB release.
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd


def channel_files(mission_dir: Path) -> dict[str, Path]:
    """Map channel name (lower case, e.g. 'channel_12') to its file in <mission>/channels/."""
    files: dict[str, Path] = {}
    folder = mission_dir / "channels"
    if not folder.is_dir():
        return files
    for path in sorted(folder.iterdir()):
        if path.is_file() and path.stem.lower().startswith("channel"):
            files.setdefault(path.stem.lower(), path)
    return files


def _decode(name: str, raw: bytes) -> pd.DataFrame | pd.Series:
    """Decode file bytes by extension, or by trying pickle, then parquet, then CSV."""
    suffix = Path(name).suffix.lower()
    order = {".parquet": ["parquet"], ".csv": ["csv"], ".pkl": ["pickle"], ".pickle": ["pickle"]}.get(
        suffix, ["pickle", "parquet", "csv"]
    )
    errors = []
    for kind in order:
        try:
            buffer = io.BytesIO(raw)
            if kind == "pickle":
                return pd.read_pickle(buffer)
            if kind == "parquet":
                return pd.read_parquet(buffer)
            return pd.read_csv(buffer)
        except Exception as error:  # try the next format; report all failures together
            errors.append(f"{kind}: {type(error).__name__}: {error}")
    raise ValueError(f"could not decode {name} ({'; '.join(errors)})")


def load_channel(path: Path) -> pd.Series:
    """Return one channel on a sorted, duplicate-free, timezone-free UTC index.

    Numeric channels come back as floats; channels whose values are labels come back as a
    pandas Categorical (one category per state).
    """
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            names = [n for n in archive.namelist() if not n.endswith("/")]
            if not names:
                raise ValueError(f"{path.name} is an empty zip")
            table = _decode(names[0], archive.read(names[0]))
    else:
        table = _decode(path.name, path.read_bytes())

    if isinstance(table, pd.Series):
        table = table.to_frame("value")
    if not isinstance(table.index, pd.DatetimeIndex):
        time_cols = [c for c in table.columns if "time" in str(c).lower() or "date" in str(c).lower()]
        time_col = time_cols[0] if time_cols else table.columns[0]
        table = table.set_index(pd.to_datetime(table[time_col], utc=True)).drop(columns=[time_col])
    index = pd.DatetimeIndex(table.index)
    if index.tz is not None:
        index = index.tz_convert("UTC").tz_localize(None)
    # one time resolution everywhere: pandas 3 may read seconds or microseconds, and comparing
    # those with nanosecond label times fails when a label time is not a whole microsecond
    index = index.as_unit("ns")

    numeric = table.select_dtypes("number")
    if not numeric.empty:
        series = pd.Series(numeric.iloc[:, 0].to_numpy(dtype=float), index=index)
        series = series[np.isfinite(series.to_numpy())]
    else:  # a categorical channel: each sample is a state label such as "value_0"
        series = pd.Series(pd.Categorical(table.iloc[:, 0]), index=index)
        series = series[series.notna().to_numpy()]
    series = series.sort_index()
    return series[~series.index.duplicated()]
