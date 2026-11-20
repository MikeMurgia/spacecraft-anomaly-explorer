"""Local development server: serves the console and the same JSON files the hosted site reads.

The hosted site on GitHub Pages needs no server; this exists so the console can be run locally
and the data queried as a small API. Run from the repo root with the virtual environment active:
    uvicorn backend.main:app --reload
then open http://127.0.0.1:8000/
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from pipeline import config

EVENT_ID = re.compile(r"m\d+_id_\d+")  # e.g. m2_id_588; anything else is rejected

app = FastAPI(title="Spacecraft Anomaly Explorer", version="0.1.0")


def json_file(path: Path) -> FileResponse:
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not exported yet; run python -m pipeline.export_static")
    return FileResponse(path, media_type="application/json")


@app.get("/api/meta")
def meta() -> FileResponse:
    """Missions, counts and dataset credit."""
    return json_file(config.STATIC_API / "meta.json")


@app.get("/api/events")
def events(mission: int) -> FileResponse:
    """Anomaly and Rare Event entries for one mission."""
    return json_file(config.STATIC_API / f"events-m{mission}.json")


@app.get("/api/events/{event_id}/signals")
def signals(event_id: str) -> FileResponse:
    """Binned telemetry for every channel of one event."""
    if not EVENT_ID.fullmatch(event_id):  # also blocks path tricks such as ../
        raise HTTPException(status_code=400, detail="Event ids look like m2_id_588")
    return json_file(config.STATIC_API / "signals" / f"{event_id}.json")


# Everything else is the console itself: index.html, CSS, JS and the exported api/ files.
app.mount("/", StaticFiles(directory=config.ROOT / "frontend", html=True), name="frontend")
