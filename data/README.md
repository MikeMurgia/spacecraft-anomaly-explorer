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

Regenerate with `python -m pipeline.prep_data` (all missions) or `--missions 2` (one mission).

| File | One row per | Contents |
|---|---|---|
| `events_mN.csv` | labelled event | timing, channels, subsystems, category, event-level features, quality flags |
| `channel_features_mN.csv` | (event, channel) pair | per-channel features and the reason when a channel could not be used |
| `quality_mN.json` | mission | counts and data-quality checks quoted in the report |

### 1. From label rows to events (`pipeline/labels.py`)

`labels.csv` has one row per (event id, channel, time interval). Rows are grouped by event id.

- `start` / `end`: earliest start and latest end of the event's rows.
- `span_h`: end minus start, in hours. `covered_h`: hours inside at least one labelled interval,
  counting overlaps once, so gaps between an event's pieces are excluded.
- `channels`, `n_channels`, `subsystems`, `n_subsystems`: the distinct channels the annotators
  marked, and their subsystems from `channels.csv`.
- Ids get a mission prefix (`m2_id_588`) so they are unique across missions.
- Category, class, subclass, dimensionality and locality come from `anomaly_types.csv`. They are
  annotator labels, so they are shown in the app but never used as model inputs (leakage).

**Data-quality rules**

- *Rows with no channel* (Mission 3: all 156 "Invalid Segment" events). They count towards the
  event's timing but not its channels (`n_rows_no_channel`). Their time ranges are treated as
  mission-wide bad data and removed from every baseline (below).
- *Rows that end before they start* (Mission 3: 18 rows in 3 Communication Gap events). Left out
  of the event's timing and counted in `n_rows_reversed`; never swapped. Checked against the
  telemetry (`quality_m3.json`): every channel has samples throughout each of the three ranges
  (e.g. `m3_id_53`: 103,691 samples found where about 100,595 are expected with no gap), so none of
  them is a real communication gap in either direction, and swapping would have invented gaps.
- *Long events* (span over one week, e.g. Mission 2's 465-hour anomaly `m2_id_633`): kept, because
  each is a genuine labelled event whose pieces cover the whole span, and flagged `long_event`.

### 2. Telemetry features (`pipeline/features.py`)

Computed for Anomaly and Rare Event events only, on **every** channel the event touches.

For each (event, channel):

- **Window:** the samples inside the intervals the annotators marked for that event on that channel.
- **Baseline:** the samples just before the event starts, over a period as long as the event,
  clamped to 6-168 hours. Samples inside any labelled interval on that channel (other events,
  communication gaps) or any mission-wide interval (invalid segments) are removed first.
- **Channel kind.** Numeric channels hold measurements. Categorical channels hold state labels
  (Mission 3 stores every channel as labels such as `value_0`, `value_1`); a channel is also
  treated as categorical when `channels.csv` flags it, even if its states are stored as numbers.
- **`log_var_ratio`** (numeric channels only) = ln((var(window) + f) / (var(baseline) + f)), where
  f = (0.001 x the channel's overall standard deviation)^2 keeps a perfectly flat baseline from
  giving infinity. 0 means no change; positive means more variable than usual; negative means
  quieter. Unlike A2's ratio it is not capped.
- **`state_shift`** (categorical channels only) = total variation distance between how often each
  state occurs in the window and in the baseline: 0 = the same mix of states, 1 = completely
  different states. Variance is not used for labels because the label order is arbitrary.
- **`frozen_delta`** = share of neighbouring samples with an identical value in the window, minus
  the same share in the baseline. Coarsely quantised channels repeat values all the time, so
  comparing against their own baseline removes that artefact (A2's frozen share did not).
- **Data gaps:** neighbouring samples more than 5x the channel's usual spacing apart are not
  treated as neighbours.
- **Minimum data:** at least 5 window samples and 20 baseline samples, otherwise the channel is
  recorded with `status` = `few_window_samples` / `few_baseline_samples`. Other statuses:
  `no_file`, `read_error`, `empty_file`, `constant_channel`.

Event-level features are medians across the channels with status `ok`: `lvr_median`,
`frozen_delta_median`; plus `lvr_absmax` (largest |log_var_ratio|) and `n_channels_read`.
`feature_status` is `ok`, `no_usable_channel`, or `not_computed` (other categories).

### 3. Normalisation

Features are stored raw. Ratios are already on a log scale centred at 0. Any further scaling
(rank or robust scaling for chart axes and model inputs) happens in the analysis and app code,
and is documented there.
