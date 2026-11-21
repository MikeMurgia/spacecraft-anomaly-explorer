// Boot: size the console, start the sky, load the exported data, wire the controls, then hand
// the shared context to every view. Views are added to VIEWS as they are built; each one is a
// function (element, ctx) -> { update(state, changed) } and redraws only what changed.

import { initBackground } from "./background.js";
import { initControls } from "./controls.js";
import { loadEvents, loadMeta, loadResults } from "./data.js";
import { initLayout } from "./layout.js";
import { DEFAULTS, createStore } from "./state.js";

const VIEWS = {
  // filled in by the next build steps, e.g. "view-a": createParallelCoordinates
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
    reducedMotion,
    switchMission: null,
  };
  const views = [];

  initLayout(() => {
    for (const view of views) view.resize?.();
  });
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
      const patch = { mission, filters: {}, window: null, selected: null };
      if (ctx.store) ctx.store.set(patch);
      else ctx.store = createStore({ ...DEFAULTS, ...patch });
    } finally {
      if (ticket === request) document.body.classList.remove("loading");
    }
  };
  await ctx.switchMission(firstMission);

  initControls(ctx);

  for (const panel of document.querySelectorAll(".panel[id]")) {
    const create = VIEWS[panel.id];
    if (create) views.push(create(panel, ctx));
  }
  const updateViews = (state, changed) => {
    for (const view of views) view.update(state, changed);
  };
  ctx.store.subscribe(updateViews);
  updateViews(ctx.store.get(), null);
  window.sae = ctx; // handy in the browser console while developing: sae.store.get()
}

boot().catch((error) => {
  console.error(error);
  const box = document.getElementById("load-error");
  box.textContent = `Could not load the console data (${error.message}). If you are running locally, build it with: python -m pipeline.prep_data, python -m pipeline.export_static, python -m pipeline.evaluate.`;
  box.hidden = false;
});
