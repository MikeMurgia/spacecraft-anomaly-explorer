// The event features the explorer shows, with their labels, units and scales. View A draws one
// axis per feature; the status-bar chips and tooltips reuse the same names.

export const FEATURES = {
  n_channels: {
    label: "Channels",
    unit: "touched",
    scale: "log",
    help: "channels the annotators marked for this event",
  },
  covered_h: {
    label: "Duration",
    unit: "hours",
    scale: "log",
    help: "hours covered by the event's labelled intervals",
  },
  lvr_median: {
    label: "Variance ratio",
    unit: "log, median",
    scale: "linear",
    help: "median over channels of log(window variance / baseline variance); + louder, − quieter",
  },
  state_shift_median: {
    label: "State shift",
    unit: "0–1, median",
    scale: "linear",
    help: "median over channels of how much the mix of states changed from the baseline",
  },
  frozen_delta_median: {
    label: "Frozen Δ",
    unit: "share, median",
    scale: "linear",
    help: "median change in the share of repeated values versus the baseline",
  },
  first_alarm_h: {
    label: "First alarm",
    unit: "hours in",
    scale: "symlog",
    help: "hours from the event's start to the first channel alarm (display rule, 4σ / longest run / new state)",
  },
};

/** Axes for a mission: the variance ratio for numeric missions, the state shift for categorical ones. */
export function featureKeys(missionMeta) {
  const keys = ["n_channels", "covered_h"];
  if (missionMeta.has_variance_ratio) keys.push("lvr_median");
  if (missionMeta.has_state_shift) keys.push("state_shift_median");
  keys.push("frozen_delta_median", "first_alarm_h");
  return keys;
}

export const featureName = (key) => FEATURES[key]?.label ?? key;
