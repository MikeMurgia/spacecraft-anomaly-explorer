# Data

## Source and licence

De Canio, G., Kotowski, K., & Haskamp, C. (2025). *ESA Anomalies Dataset (ESA-ADB)* [Dataset].
European Space Agency. https://doi.org/10.5281/zenodo.15237121

Licensed **CC BY 3.0 IGO**: free to share and adapt with attribution. The dataset authors shifted
all timestamps to start in the year 2000.

## Raw data (not in this repo)

The raw telemetry is several GB, so it is never committed. To reproduce:

1. Download the dataset from the DOI above.
2. Unzip it anywhere **outside** this repo, so you have a folder containing
   `ESA-Mission1`, `ESA-Mission2` and `ESA-Mission3`.
3. Point the pipeline at it (PowerShell): `$env:ESA_ROOT = "C:\path\to\ESA-ADB"`

## Processed data (`data/processed/`)

_To be written in Phase 1: one row per labelled event per mission, with how events are grouped
from label rows, how each feature is computed, how missing telemetry and outliers are handled,
and how features are normalised._