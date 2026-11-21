// Shared state for both monitors. Every view reads from here and changes it only through
// store.set(), so one brush, click or button press updates every linked view at once.

/** The alarm-budget knob's detents, in false alarms per month (the same stops as the budget table). */
export const BUDGET_STOPS = Object.freeze([0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10]);

export const DEFAULTS = Object.freeze({
  mission: 2, // which mission's events are shown in the explorer
  monitor: 1, // 1 = explore (views A-E), 2 = analysis
  filters: {}, // feature key -> [low, high], from brushing an axis in view A
  window: null, // [start ms, end ms] from brushing the overview strip in view B, or null
  subsystem: null, // keep only events touching this subsystem (clicking a row in view D), or null
  selected: null, // selected event id, or null
  sort: "severity", // view C channel order: "severity" (|log variance ratio|) or "onset" (earliest alarm)
  detector: "D", // detector shown in view E
  budget: 1, // false alarms per month allowed (view E and the knob)
  metric: "roc", // Monitor 2 curves: "roc" or "pr"
});

/** A tiny observable store: get() the state, set() a patch, subscribe() to changes. */
export function createStore(initial = DEFAULTS) {
  let state = { ...initial };
  const listeners = new Set();
  return {
    get: () => state,
    set(patch) {
      const changed = Object.keys(patch).filter((key) => patch[key] !== state[key]);
      if (!changed.length) return;
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state, new Set(changed));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** True if an event passes every axis filter (a missing value never passes an active filter). */
export function passesFilters(event, filters) {
  return Object.entries(filters).every(([key, [low, high]]) => {
    const value = event[key];
    return value !== null && value !== undefined && value >= low && value <= high;
  });
}

/** True if the event starts inside the brushed time window (or there is no window). */
export function inWindow(event, window) {
  return !window || (event.startMs >= window[0] && event.startMs <= window[1]);
}

/** True if the event touches the chosen subsystem (or no subsystem is chosen). */
export function touchesSubsystem(event, subsystem) {
  return !subsystem || (event.subsystems ?? []).includes(subsystem);
}

/** The events that pass the feature filters (view A), the time window (view B) and the subsystem (view D). */
export function activeEvents(events, state) {
  return events.filter(
    (event) =>
      passesFilters(event, state.filters) && inWindow(event, state.window) && touchesSubsystem(event, state.subsystem),
  );
}
