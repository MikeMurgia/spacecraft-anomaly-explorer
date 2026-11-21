// Small formatting helpers shared by the controls and the views.

const pad = (n) => String(n).padStart(2, "0");

/** "2000-03-14 06:12 UTC" from UTC milliseconds. The dataset's dates were shifted by ESA, so they are labelled as dataset time. */
export function utcStamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "2000-03-14" from UTC milliseconds. */
export function utcDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Hours as "45 min", "3.2 h" or "4.1 d". */
export function duration(hours) {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return "n/a";
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}

/** "m2_id_588" -> "id_588" (the mission is shown elsewhere). */
export const shortId = (id) => id.replace(/^m\d+_/, "");

/** A per-month rate with sensible precision: 0.05, 0.25, 1, 2. */
export const perMonth = (rate) => (rate < 1 ? String(Number(rate.toFixed(2))) : String(Number(rate.toFixed(1))));

/** Number with a fixed count of decimals, or an en dash for a missing value. */
export const fixed = (value, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? "–" : value.toFixed(digits));
