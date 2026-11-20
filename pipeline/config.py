"""Project-wide paths and constants.

Every other module imports paths from here, so nothing else hard-codes a location
and nothing personal (like C:\\Users\\...) ever lands in the repo.
"""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_RAW = ROOT / "data" / "raw"  # default home of the ESA-ADB download (git-ignored)
DATA_PROCESSED = ROOT / "data" / "processed"
STATIC_API = ROOT / "frontend" / "api"

MISSIONS = (1, 2, 3)
SEED = 20261117  # one fixed seed for every random step (CV folds, bootstrap, jitter)


def esa_root() -> Path:
    """Folder that holds ESA-Mission1, ESA-Mission2 and ESA-Mission3.

    Uses data/raw/ inside the repo by default. Set the ESA_ROOT environment variable
    to use a copy stored somewhere else instead.
    """
    value = os.environ.get("ESA_ROOT")
    path = Path(value).expanduser().resolve() if value else DATA_RAW
    if not path.is_dir():
        raise RuntimeError(
            f"ESA-ADB data not found at {path}. Put ESA-Mission1..3 in data/raw/ or set ESA_ROOT."
        )
    return path
