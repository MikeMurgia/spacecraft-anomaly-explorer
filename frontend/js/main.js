// Boot: size the console, start the sky, load the exported data, wire the controls, then hand
// the shared context to every view. Views are added to VIEWS as they are built; each one is a
// function (element, ctx) -> { update(state, changed) } and redraws only what changed.

import { initBackground } from "./background.js";
import { createBriefing } from "./briefing.js";
import { sizeChanged } from "./chart.js";
import { initControls } from "./controls.js";
import { createCurves } from "./curves.js";
import { loadEvents, loadMeta, loadResults } from "./data.js";
import { initLayout } from "./layout.js";
import { createMissionCheck } from "./missions.js";
import { createScores } from "./scores.js";
import { DEFAULTS, createStore } from "./state.js";
import { createParallelCoordinates } from "./view-a.js";
import { createTimeline } from "./view-b.js";
import { createChannelStack } from "./view-c.js";
import { createHeatmap } from "./view-d.js";
import { createBudget } from "./view-e.js";

const VIEWS = {
  "view-a": createParallelCoordinates,
  "view-b": createTimeline,
  "view-c": createChannelStack,
  "view-d": createHeatmap,
  "view-e": createBudget,
  briefing: createBriefing,
  curves: createCurves,
  scores: createScores,
  missions: createMissionCheck,
};

async function boot() {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ctx = {
    store: null,
    meta: null,
    results: null,
    events: [],
    byId: new Map(),
    background: null,
    earth: null,
    reducedMotion,
    switchMission: null,
  };
  const views = [];

  initLayout();
  ctx.background = initBackground(document.getElementById("sky"), { reducedMotion });

  const [meta, results] = await Promise.all([loadMeta(), loadResults()]);
  ctx.meta = meta;
  ctx.results = results;
  const missions = meta.missions.map((m) => m.mission);
  const firstMission = missions.includes(DEFAULTS.mission) ? DEFAULTS.mission : missions[0];

  let request = 0;
  ctx.switchMission = async (mission) => {
    if (mission === ctx.store?.get().mission) return;
    const ticket = ++request;
    document.body.classList.add("loading");
    try {
      const events = await loadEvents(mission);
      if (ticket !== request) return; // a later click won the race
      ctx.events = events;
      ctx.byId = new Map(events.map((event) => [event.id, event]));
      // a new mission starts clean: its filters, time window and selection make no sense here
      const patch = { mission, filters: {}, window: null, subsystem: null, selected: null };
      if (ctx.store) ctx.store.set(patch);
      else ctx.store = createStore({ ...DEFAULTS, ...patch });
    } finally {
      if (ticket === request) document.body.classList.remove("loading");
    }
  };
  await ctx.switchMission(firstMission);

  initControls(ctx);

  // each view redraws when its chart area is no longer the size it was drawn at: a window
  // resize, or its footnote growing to two lines. At most once per frame.
  let pending = false;
  const observer = new ResizeObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      for (const view of views) if (sizeChanged(view.body)) view.resize?.();
    });
  });
  for (const panel of document.querySelectorAll(".panel[id]")) {
    const create = VIEWS[panel.id];
    if (!create) continue;
    const view = create(panel, ctx);
    view.body = panel.querySelector("[data-chart]");
    views.push(view);
    observer.observe(view.body);
  }
  const updateViews = (state, changed) => {
    for (const view of views) view.update(state, changed);
  };
  ctx.store.subscribe(updateViews);
  updateViews(ctx.store.get(), null);
  window.sae = ctx; // handy in the browser console while developing: sae.store.get()

  // the 3D Earth last, so three.js never delays the charts; if it cannot start, the 2D planet stays.
  // Phone-sized screens skip it to save data and battery, and so does a browser without WebGL
  // (checked here first, so three.js is not even downloaded).
  const probe = document.createElement("canvas");
  const webgl = Boolean(probe.getContext("webgl2") || probe.getContext("webgl"));
  if (webgl && window.innerWidth >= 700) {
    import("./earth.js")
      .then(({ initEarth }) => initEarth(document.getElementById("earth"), { reducedMotion }))
      .then((earth) => {
        if (!earth) return;
        ctx.earth = earth;
        earth.setMonitor(ctx.store.get().monitor);
        ctx.background.setPlanetVisible(false);
      })
      .catch((error) => console.info("Earth: not loaded, keeping the 2D planet.", error.message));
  }
}

boot().catch((error) => {
  console.error(error);
  const box = document.getElementById("load-error");
  box.textContent = `Could not load the console data (${error.message}). If you are running locally, build it with: python -m pipeline.prep_data, python -m pipeline.export_static, python -m pipeline.evaluate.`;
  box.hidden = false;
});
