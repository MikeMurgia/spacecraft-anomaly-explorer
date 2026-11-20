"""Project-wide paths and constants.

Every other module imports paths from here, so nothing else hard-codes a location
and nothing personal (like C:\\Users\\...) ever lands in the repo.
"""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_PROCESSED = ROOT / "data" / "processed"
STATIC_API = ROOT / "frontend" / "api"

MISSIONS = (1, 2, 3)
SEED = 20261117  # one fixed seed for every random step (CV folds, bootstrap, jitter)


def esa_root() -> Path:
    """Folder that holds ESA-Mission1, ESA-Mission2 and ESA-Mission3.

    Read from the ESA_ROOT environment variable so the raw data can live anywhere
    outside the repo.
    """
    value = os.environ.get("ESA_ROOT")
    if not value:
        raise RuntimeError(
            "Set ESA_ROOT to the folder that contains ESA-Mission1, ESA-Mission2 and ESA-Mission3."
        )
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise RuntimeError(f"ESA_ROOT does not exist or is not a folder: {path}")
    return path
