# Spacecraft Anomaly Explorer

[![CI](https://github.com/MikeMurgia/spacecraft-anomaly-explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/MikeMurgia/spacecraft-anomaly-explorer/actions/workflows/ci.yml)
[![Pages](https://github.com/MikeMurgia/spacecraft-anomaly-explorer/actions/workflows/pages.yml/badge.svg)](https://github.com/MikeMurgia/spacecraft-anomaly-explorer/actions/workflows/pages.yml)

**When a spacecraft signal looks unusual, is it actually a fault?** In Mission 2 of the European
Space Agency's anomaly dataset (ESA-ADB), annotators labelled 644 unusual events: 613 are rare but
expected ("rare events") and only 31 are real faults ("anomalies"). This interactive console shows
how the two differ, which subsystems each touches, and what each alarm would cost an operator.

- **Live site:** https://mikemurgia.github.io/spacecraft-anomaly-explorer/ (best on a 16:9 desktop screen)
- **Course:** FSU CIS 4930 Introduction to Data Visualization, final project, Fall 2026 (Michael Murgia)

![Monitor 1: views A to E with anomaly id_635 selected](docs/images/monitor-1-explore.jpg)

## Findings

All numbers come from `python -m pipeline.evaluate` (fixed seed) and re-run exactly from this repo.

| | Result (Mission 2 unless noted) |
|---|---|
| **Drama misleads** | Alarming on the size of the variance change scores ROC-AUC 0.238 [0.129, 0.360], worse than chance: pick one anomaly and one rare event at random, and 76% of the time the rare event is the more dramatic one. |
| **Faults are narrow** | Anomalies touch a median of 5 channels against 19 for rare events, and every anomaly stays inside one subsystem. The one-line rule "touches few channels" scores 0.947 [0.910, 0.978]; a logistic regression on all six inputs scores 0.968 [0.938, 0.989]. |
| **Cost of alarms** | At no more than 1 false alarm a month, the logistic regression catches 27 of 31 anomalies, the channel-count rule 22, and the drama rule 4. |
| **Transfer** | Trained on Mission 2 and tested on Mission 1, the channel-count rule keeps 0.679 and the logistic regression 0.651, but the telemetry-only model drops to 0.402 [0.318, 0.484], below chance. Mission 3 (8 anomalies) is shown but not scored. |

The main caveat: channel counts and durations come from the annotators' labels, so a detector
watching live telemetry would not have them yet. See [Limitations](#limitations).

## The console

A drawn spacecraft cockpit with two monitors (the arrow tab switches between them). Every filter,
selection and setting is shared, so one brush updates every view.

| Monitor 1 · Explore | |
|---|---|
| **A** Event features | parallel coordinates of every event; drag along an axis to filter |
| **B** Event timeline | start time against duration; drag the overview strip to zoom in time, click a dot to select |
| **C** Linked channels | every channel of the selected event in σ from its own pre-event mean, with a tick where each first alarms; sort by biggest change or earliest alarm |
| **D** Subsystem heatmap | share of anomalies and rare events touching each subsystem; click a row to filter |
| **E** Alarm budget | anomalies caught against false alarms per month for each detector; the knob sets the budget |
| **Controls** | mission switch, previous/next anomaly, zoom to event, clear all, full screen |

| Monitor 2 · Analysis | |
|---|---|
| **Briefing** | the question, answered with the id_588 / id_635 pair |
| **Detector curves** | ROC or precision-recall for every detector, with 95% bootstrap bands |
| **Scores** | ROC-AUC, PR-AUC and catches within the budget; cross-validated or train-M2-test-M1 |
| **Cross-mission check** | the same features for Missions 1, 2 and 3 on shared axes |
| **Methods & limits** | data, pipeline, limitations and AI use |

![Monitor 2: briefing, detector curves, scores and the cross-mission check](docs/images/monitor-2-analysis.jpg)

Below 1100 px wide the console becomes one scrolling column of panels. It honours the operating
system's reduced-motion setting, and falls back to a 2D planet when WebGL is unavailable.

## Repository layout

```
pipeline/            offline Python: events, features, evaluation, static export
  labels.py            label rows -> events (timing, channels, subsystems, quality flags)
  telemetry.py         reads the zipped telemetry (numeric or state channels)
  features.py          per-channel features against a pre-event baseline, channel alarms
  prep_data.py         runs the two above for every mission -> data/processed/
  detectors/           baselines A, B, C, D, Dt and the conformal stub (not implemented)
  evaluate.py          cross-validation, bootstrap intervals, budget curves, transfer -> results.json
  export_static.py     data/processed/ + telemetry -> frontend/api/ (binned JSON per event)
  inspect_data.py      read-only summary of the raw files
backend/             optional FastAPI server for local development (the hosted site needs none)
frontend/            the console served by GitHub Pages
  index.html, css/     page and styles
  js/                  ES modules: state, data loading, layout, one file per view, background, Earth
  js/vendor/           D3 and three.js, unmodified, with their licences
  api/                 exported JSON the page reads (events, results, one file per event's signals)
  fonts/, textures/    bundled typefaces and the Earth image, with their licences and credit
data/                processed tables (small) and data/README.md (provenance, preprocessing)
tests/               pytest: pipeline, backend and static checks on the frontend
docs/                AI usage log and README images
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
ruff format --check .  # formatting
pytest                 # tests
```

GitHub Actions runs the same three checks on every push and pull request, and deploys `frontend/`
to GitHub Pages when it changes.

## Regenerating the data

The raw dataset is not in this repo (several GB, with its own licence). Download it from the DOI
below and put the `ESA-Mission1`, `ESA-Mission2` and `ESA-Mission3` folders in `data/raw/`, which
is git-ignored. Or point the pipeline elsewhere with `$env:ESA_ROOT = "C:\path\to\ESA-ADB"`.
Then, with the virtual environment active:

```powershell
python -m pipeline.prep_data       # raw files -> data/processed/        (about 3 minutes)
python -m pipeline.export_static   # data/processed/ -> frontend/api/    (the website's data)
python -m pipeline.evaluate        # detectors -> frontend/api/results.json + data/processed/results_summary.csv (about 2 minutes)
```

`evaluate` needs only `data/processed/`, so it re-runs without the raw data.
`python -m pipeline.inspect_data` prints a read-only summary of the raw files.

## Running locally

```powershell
uvicorn backend.main:app --reload   # then open http://127.0.0.1:8000/
```

The server serves the console plus a small JSON API (`/api/meta`, `/api/events?mission=2`,
`/api/events/m2_id_588/signals`). The hosted site reads the same exported files directly from
`frontend/api/`. Any static file server works too: `python -m http.server -d frontend`.

## Evaluation

The task is **event-level**: given one labelled event, is it an anomaly or a rare event? It is not
a streaming detector. Only Anomaly and Rare Event events with usable telemetry features are scored
(Mission 1: 104 anomalies and 76 rare events; Mission 2: 31 and 613).

| Detector | Score | Learns |
|---|---|---|
| A Looks dramatic | \|median log variance ratio\| | no |
| B Looks stuck | median change in frozen share | no |
| C Touches few channels | − log(1 + channels touched) | no |
| D Logistic regression | scikit-learn, all six inputs, balanced classes | yes |
| Dt Logistic, telemetry only | the same, on the three telemetry inputs | yes |

Inputs to D: log channels touched, subsystems touched, log hours covered, median and largest
|log variance ratio|, median frozen-share change. Annotator labels (category, class, subclass,
dimensionality, locality, length) are never inputs; `evaluate.py` refuses them.

Method: repeated stratified 5-fold cross-validation (10 repeats, seed 20261117), so every event is
scored by a model that never saw it; 2,000 stratified bootstrap resamples for 95% intervals; ROC
and precision-recall curves; anomalies caught against false alarms per month of mission time; and
a transfer test (train on all of Mission 2, test on Mission 1). A mission is scored only with at
least 30 anomalies, so Mission 3 is descriptive.

`pipeline/detectors/conformal_rare_event.py` holds the interface for a conformal detector that is
**not implemented**; the evaluation lists it as `not_implemented` and the app leaves it out.

## Limitations

- Only 31 anomalies in Mission 2, so every interval is wide.
- Channel counts and durations come from the annotators, so the strongest features would not be
  available to a live detector before an event is labelled. The telemetry-only model (Dt) is there
  to show what remains without them.
- Whole labelled events are scored, not a stream of telemetry.
- Frozen share barely moves: coarsely recorded channels repeat values all the time.
- Mission 1 lost 14 anomalies but only 2 rare events to missing telemetry (16 events, partly
  instant events with no time span), which biases its scores.
- Filtering on a feature in the app and then reading a detector built on that feature is circular.

## Data and attribution

De Canio, G., Kotowski, K., & Haskamp, C. (2025). *ESA Anomalies Dataset (ESA-ADB)* [Dataset].
European Space Agency. https://doi.org/10.5281/zenodo.15237121. Licensed CC BY 3.0 IGO. ESA
shifted all timestamps to start in 2000. Provenance and preprocessing: [data/README.md](data/README.md).

Earth imagery: Blue Marble: Next Generation (December 2004), Reto Stöckli, NASA Earth Observatory.

## Third-party software and assets

| Item | Use | Licence |
|---|---|---|
| D3.js v7.9.0 (vendored in `frontend/js/vendor/`) | charts | ISC |
| three.js r187 / 0.187.0 (vendored in `frontend/js/vendor/three/`) | 3D Earth | MIT |
| Rajdhani, IBM Plex Sans, IBM Plex Mono (bundled in `frontend/fonts/`, from @fontsource 5.3.0) | typefaces | SIL OFL-1.1 |
| Blue Marble: Next Generation (`frontend/textures/`) | Earth texture | NASA imagery, credit "NASA Earth Observatory" |
| FastAPI, Uvicorn | local server | MIT, BSD-3-Clause |
| pandas, NumPy, scikit-learn | pipeline and detectors | BSD-3-Clause |
| PyArrow | reading parquet telemetry | Apache-2.0 |
| pytest, Ruff, httpx2 | tests, linting, API test client | MIT, MIT, BSD-3-Clause |


## Licence

Code: MIT (see [LICENSE](LICENSE)). Data: CC BY 3.0 IGO, owned by its authors. Fonts, libraries and
imagery keep their own licences (table above).
