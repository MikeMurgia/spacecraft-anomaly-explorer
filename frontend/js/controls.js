// The console hardware: mission toggles, monitor tabs, the alarm-budget knob, the four push
// buttons, the full-screen button, the event clock and the status bar with its filter chips.
// Each control only reads and writes the shared store; the views redraw themselves from it.

import { BUDGET_STOPS, activeEvents } from "./state.js";
import { short } from "./chart.js";
import { featureName } from "./features.js";
import { duration, perMonth, shortId, utcDay, utcStamp } from "./format.js";

const DIAL_SWEEP = 270; // degrees from the first detent to the last


const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function initControls(ctx) {
  const { store } = ctx;
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  // ---- mission toggles (one set on each monitor, kept in step) ----
  const available = new Set(ctx.meta.missions.map((m) => m.mission));
  for (const button of $$(".toggle[data-mission]")) {
    const mission = Number(button.dataset.mission);
    if (!available.has(mission)) {
      button.disabled = true;
      button.title = `Mission ${mission} is not in this export`;
    }
    button.addEventListener("click", () => ctx.switchMission(mission));
  }

  // ---- monitor tabs ----
  for (const button of $$("[data-goto]")) {
    button.addEventListener("click", () => store.set({ monitor: Number(button.dataset.goto) }));
  }

  // ---- alarm-budget knob: an <input type=range> drives a drawn dial ----
  const knob = document.getElementById("budget");
  const dial = document.querySelector(".dial svg");
  const ticks = dial.querySelector(".ticks");
  BUDGET_STOPS.forEach((_, i) => {
    const angle = ((-DIAL_SWEEP / 2 + (i * DIAL_SWEEP) / (BUDGET_STOPS.length - 1)) * Math.PI) / 180;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", 66 + Math.sin(angle) * 50);
    line.setAttribute("y1", 66 - Math.cos(angle) * 50);
    line.setAttribute("x2", 66 + Math.sin(angle) * 58);
    line.setAttribute("y2", 66 - Math.cos(angle) * 58);
    ticks.append(line);
  });
  knob.max = String(BUDGET_STOPS.length - 1);
  knob.addEventListener("input", () => store.set({ budget: BUDGET_STOPS[Number(knob.value)] }));
  // the dial itself can be scrolled or dragged, like a real knob
  const dialEl = document.querySelector(".dial");
  dialEl.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      stepKnob(event.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );
  let dragY = null;
  dialEl.addEventListener("pointerdown", (event) => {
    dragY = event.clientY;
    dialEl.setPointerCapture(event.pointerId);
  });
  dialEl.addEventListener("pointermove", (event) => {
    if (dragY === null) return;
    const steps = Math.trunc((dragY - event.clientY) / 18);
    if (steps) {
      stepKnob(steps);
      dragY = event.clientY;
    }
  });
  dialEl.addEventListener("pointerup", () => (dragY = null));
  dialEl.addEventListener("pointercancel", () => (dragY = null));

  function stepKnob(steps) {
    const index = Math.max(0, Math.min(BUDGET_STOPS.length - 1, Number(knob.value) + steps));
    knob.value = String(index);
    store.set({ budget: BUDGET_STOPS[index] });
  }

  // ---- push buttons (the status bar's "Clear all" shares the action) ----
  const actions = {
    "prev-anomaly": () => stepAnomaly(-1),
    "next-anomaly": () => stepAnomaly(1),
    "zoom-event": zoomToEvent,
    "clear-all": () => store.set({ filters: {}, window: null, subsystem: null, selected: null }),
  };
  for (const button of $$("[data-action]")) {
    button.addEventListener("click", () => actions[button.dataset.action]());
  }

  /** Select the previous or next anomaly in time among the events currently shown. */
  function stepAnomaly(direction) {
    const state = store.get();
    const anomalies = activeEvents(ctx.events, state)
      .filter((event) => event.isAnomaly)
      .sort((a, b) => a.startMs - b.startMs);
    if (!anomalies.length) return;
    const current = ctx.byId.get(state.selected);
    let next;
    if (!current) {
      next = direction > 0 ? anomalies[0] : anomalies.at(-1);
    } else if (direction > 0) {
      next = anomalies.find((event) => event.startMs > current.startMs) ?? anomalies[0];
    } else {
      next = anomalies.findLast((event) => event.startMs < current.startMs) ?? anomalies.at(-1);
    }
    store.set({ selected: next.id });
  }

  /** Narrow the timeline to the selected event with a margin of three event lengths (at least a day). */
  function zoomToEvent() {
    const event = ctx.byId.get(store.get().selected);
    if (!event) return;
    const margin = Math.max(3 * (event.endMs - event.startMs), 24 * 3600e3);
    store.set({ window: [event.startMs - margin, event.endMs + margin] });
  }

  // ---- full screen ----
  const fullscreen = document.getElementById("fullscreen");
  if (!document.fullscreenEnabled) fullscreen.hidden = true;
  fullscreen.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  });

  // ---- everything that redraws when the state changes ----
  const track = document.getElementById("track");
  const monitors = [document.getElementById("monitor-1"), document.getElementById("monitor-2")];
  const deckLabel = document.getElementById("deck-label");
  const clock = document.getElementById("clock-value");
  const status = document.getElementById("status-text");
  const chips = document.getElementById("chips");
  const budgetValue = document.getElementById("budget-value");

  /** The off-screen monitor is inert (no tab stops); in the stacked small-screen layout both are on screen. */
  function applyInert(state) {
    const stacked = document.body.classList.contains("stacked");
    monitors.forEach((monitor, i) => (monitor.inert = !stacked && i + 1 !== state.monitor));
  }
  window.addEventListener("sae:layout", () => applyInert(store.get()));

  function render(state, changed) {
    if (!changed || changed.has("mission")) {
      for (const button of $$(".toggle[data-mission]")) {
        button.setAttribute("aria-pressed", String(Number(button.dataset.mission) === state.mission));
      }
    }
    if (!changed || changed.has("monitor")) {
      track.dataset.monitor = String(state.monitor);
      applyInert(state);
      deckLabel.textContent = `OPS CONSOLE · ${state.monitor}`;
      ctx.background?.setMonitor(state.monitor);
      ctx.earth?.setMonitor(state.monitor);
      if (changed) monitors[state.monitor - 1].focus({ preventScroll: true });
    }
    if (!changed || changed.has("budget")) {
      const index = Math.max(0, BUDGET_STOPS.indexOf(state.budget));
      knob.value = String(index);
      const angle = -DIAL_SWEEP / 2 + (index * DIAL_SWEEP) / (BUDGET_STOPS.length - 1);
      dial.style.setProperty("--dial-angle", `${angle}deg`);
      [...ticks.children].forEach((tick, i) => tick.classList.toggle("on", i <= index));
      budgetValue.textContent = `≤ ${perMonth(state.budget)} / month`;
      knob.setAttribute("aria-valuetext", `${perMonth(state.budget)} false alarms per month`);
    }

    const selected = ctx.byId.get(state.selected);
    clock.textContent = selected ? `${shortId(selected.id)} · ${utcStamp(selected.startMs)}` : "none selected";
    document.querySelector('[data-action="zoom-event"]').disabled = !selected;

    const shown = activeEvents(ctx.events, state);
    const anomalies = shown.filter((event) => event.isAnomaly).length;
    const rare = shown.length - anomalies;
    status.innerHTML = `${shown.length} of ${ctx.events.length} events shown · <b class="anomaly">${plural(anomalies, "anomaly", "anomalies")}</b> · ${plural(rare, "rare event")}`;
    for (const button of $$('[data-action$="-anomaly"]')) button.disabled = anomalies === 0;
    renderChips(state, selected);
  }

  function renderChips(state, selected) {
    const items = Object.entries(state.filters).map(([key, [low, high]]) => ({
      text: `${featureName(key)} ${short(low)} to ${short(high)}`,
      clear: () => {
        const filters = { ...store.get().filters };
        delete filters[key];
        store.set({ filters });
      },
    }));
    if (state.subsystem) {
      items.push({ text: state.subsystem.replace(/^subsystem_/, "subsystem "), clear: () => store.set({ subsystem: null }) });
    }
    if (state.window) {
      items.push({
        text: `${utcDay(state.window[0])} → ${utcDay(state.window[1])}`,
        clear: () => store.set({ window: null }),
      });
    }
    if (selected) {
      items.push({
        text: `${shortId(selected.id)} · ${duration(selected.span_h)}`,
        clear: () => store.set({ selected: null }),
      });
    }
    chips.replaceChildren(
      ...items.map(({ text, clear }) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.title = text;
        const label = document.createElement("span");
        label.className = "chip-text";
        label.textContent = text;
        chip.append(label);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `Remove ${text}`);
        remove.addEventListener("click", clear);
        chip.append(remove);
        return chip;
      }),
    );
  }

  store.subscribe(render);
  render(store.get(), null);
  return { render };
}
