# Spacecraft Anomaly Explorer

[![CI](https://github.com/MikeMurgia/spacecraft-anomaly-explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/MikeMurgia/spacecraft-anomaly-explorer/actions/workflows/ci.yml)

**When a spacecraft signal looks unusual, is it actually a fault?** In ESA-ADB Mission 2, annotators
labelled 644 unusual events: 613 are rare but normal and only 31 are true anomalies. This interactive
D3 console shows how the two differ, which subsystems each touches, and what each alarm costs.

- **Live site:** _coming soon_ (`https://mikemurgia.github.io/spacecraft-anomaly-explorer/`)
- **Course:** FSU CIS 4930 Introduction to Data Visualization, final project (Fall 2026)

## Repository layout

```
pipeline/   offline Python: build the event table, compute features, evaluate detectors, export JSON
backend/    optional FastAPI server for local development (the hosted site needs no backend)
frontend/   the D3 console served by GitHub Pages; frontend/api/ holds the exported JSON
data/       processed event tables (small) and data/README.md (provenance, licence, preprocessing)
tests/      pytest tests for the pipeline
docs/       AI usage log and other notes
```

## Setup (Windows PowerShell)

Needs Python 3.12 or newer and Git.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements-dev.txt
```

## Checks

```powershell
ruff check .           # lint
ruff format .          # auto-format
pytest                 # tests
```

GitHub Actions runs the same three checks on every push and pull request.

## Regenerating the data

_Filled in during Phase 1._ The raw dataset is not in this repo; see [data/README.md](data/README.md).

## Data and attribution

De Canio, G., Kotowski, K., & Haskamp, C. (2025). *ESA Anomalies Dataset (ESA-ADB)*. European Space
Agency. https://doi.org/10.5281/zenodo.15237121. Licensed CC BY 3.0 IGO.

## Third-party software

| Library | Use | Licence |
|---|---|---|
| D3.js v7.9.0 (vendored in `frontend/js/vendor/`) | charts | ISC |
| FastAPI, Uvicorn | local API | MIT, BSD-3-Clause |
| pandas, NumPy, scikit-learn | pipeline and baselines | BSD-3-Clause |
| PyArrow | reading parquet telemetry | Apache-2.0 |
| pytest, Ruff | tests and linting | MIT |

## AI usage

This project was built with help from an AI assistant (Claude). What it did and what I did is logged
session by session in [docs/AI_USAGE.md](docs/AI_USAGE.md). The anomaly detector in
`pipeline/detectors/mine.py` is my own work.

## Licence

Code: MIT (see [LICENSE](LICENSE)). Data: CC BY 3.0 IGO, owned by its authors.