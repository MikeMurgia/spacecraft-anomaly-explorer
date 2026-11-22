// Helpers for the per-event channel traces exported to api/signals/: scaling numeric bins to σ,
// ordering channels, and formatting times relative to the event start. Used by view C and the
// briefing on Monitor 2.

import { short } from "./chart.js";

export const SIGMA_CAP = 10;
const SIGMA_MIN = 3;

/** Hours relative to the event start as "+5 min", "−6 h", "0". */
export function signedHours(rel) {
  const size = Math.abs(rel);
  if (size < 1 / 120) return "0";
  const sign = rel > 0 ? "+" : "−";
  return size < 1 ? `${sign}${Math.round(size * 60)} min` : `${sign}${short(size)} h`;
}

/** Severity used for sorting: size of the variance change, or of the state change. */
export function severity(channel) {
  if (channel.kind === "numeric" && Number.isFinite(channel.log_var_ratio)) return Math.abs(channel.log_var_ratio);
  if (channel.kind === "categorical" && Number.isFinite(channel.state_shift)) return channel.state_shift;
  return -1;
}

export function sortChannels(channels, mode) {
  const usable = (c) => c.status === "ok";
  return [...channels].sort((a, b) => {
    if (usable(a) !== usable(b)) return usable(a) ? -1 : 1;
    if (mode === "onset") {
      const ta = a.alarm_h ?? Infinity;
      const tb = b.alarm_h ?? Infinity;
      if (ta !== tb) return ta - tb;
    }
    return severity(b) - severity(a) || a.name.localeCompare(b.name);
  });
}

/** Numeric bins converted to σ from the pre-event mean (falls back to the window's own range). */
export function sigmaBins(channel) {
  const { min, max, baseline_mean: mean, baseline_std: std } = channel;
  const scaled = std > 0 && Number.isFinite(mean);
  let centre = mean;
  let unit = std;
  if (!scaled) {
    const values = [...min, ...max].filter((v) => v !== null);
    const [lo, hi] = d3.extent(values);
    centre = ((lo ?? 0) + (hi ?? 0)) / 2;
    unit = (hi - lo) / 2 || 1;
  }
  const lows = min.map((v) => (v === null ? null : (v - centre) / unit));
  const highs = max.map((v) => (v === null ? null : (v - centre) / unit));
  const peak = d3.max([...lows, ...highs], (v) => (v === null ? 0 : Math.abs(v))) ?? 0;
  const limit = scaled ? Math.min(SIGMA_CAP, Math.max(SIGMA_MIN, Math.ceil(peak))) : 1;
  return { lows, highs, limit, scaled, clipped: scaled && peak > SIGMA_CAP };
}

/** For a state channel: the most common state in the bins before the event. */
export function usualState(channel, eventStartBin) {
  const before = channel.mode.slice(0, Math.max(1, eventStartBin)).filter((m) => m >= 0);
  if (!before.length) return null;
  return d3.greatest(d3.rollups(before, (v) => v.length, (m) => m), (d) => d[1])[0];
}
