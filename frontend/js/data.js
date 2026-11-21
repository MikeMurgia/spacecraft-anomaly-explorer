// Loads the JSON exported by the Python pipeline from api/. Relative paths work both on GitHub
// Pages (/spacecraft-anomaly-explorer/) and on the local server (/).

const cache = new Map();

async function getJSON(path, { signal, keep = true } = {}) {
  if (keep && cache.has(path)) return cache.get(path);
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const data = await response.json();
  if (keep) cache.set(path, data);
  return data;
}

export const loadMeta = () => getJSON("api/meta.json");

export const loadResults = () => getJSON("api/results.json");

/** Anomaly and Rare Event entries for one mission, with start/end parsed as UTC milliseconds. */
export async function loadEvents(mission) {
  const events = await getJSON(`api/events-m${mission}.json`);
  for (const event of events) {
    event.startMs ??= Date.parse(event.start);
    event.endMs ??= Date.parse(event.end);
    event.isAnomaly ??= event.category === "Anomaly";
  }
  return events;
}

/** Binned telemetry for every channel of one event. Pass an AbortSignal to cancel a stale request. */
export function loadSignals(eventId, signal) {
  if (!/^m\d+_id_\d+$/.test(eventId)) return Promise.reject(new Error(`bad event id ${eventId}`));
  return getJSON(`api/signals/${eventId}.json`, { signal, keep: cache.size < 200 });
}
