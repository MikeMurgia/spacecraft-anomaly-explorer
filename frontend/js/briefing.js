// Monitor 2 · Briefing: the project's question, answered with one pair of Mission 2 events.
// id_588 is a rare event (harmless) whose channels swing wildly; id_635 is an anomaly (a fault)
// whose channels go quiet. Each card draws the event's three biggest-changing channels in σ from
// their pre-event means, on the same scale, so the contrast is visible at a glance. Every number
// on this panel is read from the exported data. Clicking a card opens that event on Monitor 1.

import { categoryColor, chartArea, short, showEmpty } from "./chart.js";
import { loadEvents, loadSignals } from "./data.js";
import { duration, shortId } from "./format.js";
import { SIGMA_CAP, sigmaBins, sortChannels } from "./signals.js";

const STORY_MISSION = 2;
const PAIR = ["m2_id_588", "m2_id_635"]; // the dramatic rare event, then the quiet anomaly
const ROWS = 3;
const INK = "#c9d6ea";

/** The pair to show: the two named events, or (if an export lacks them) the most dramatic rare event and the quietest anomaly. */
function choosePair(events) {
  const byId = new Map(events.map((e) => [e.id, e]));
  if (PAIR.every((id) => byId.has(id))) return PAIR.map((id) => byId.get(id));
  const withLvr = events.filter((e) => Number.isFinite(e.lvr_median));
  const rare = d3.greatest(withLvr.filter((e) => !e.isAnomaly), (e) => e.lvr_median);
  const anomaly = d3.least(withLvr.filter((e) => e.isAnomaly), (e) => e.lvr_median);
  return rare && anomaly ? [rare, anomaly] : [];
}

export function createBriefing(panel, ctx) {
  const lede = panel.querySelector("#briefing-lede");
  const pairBox = panel.querySelector(".pair");
  const takeaway = panel.querySelector(".takeaway");
  let pair = [];
  let traces = [];

  function writeLede() {
    const meta = ctx.meta.missions.find((m) => m.mission === STORY_MISSION);
    const drama = ctx.results.missions[String(STORY_MISSION)]?.detectors?.A;
    const parts = [];
    const add = (text, bold) => {
      const node = bold ? document.createElement("b") : document.createTextNode(text);
      if (bold) {
        node.textContent = text;
        if (bold === "anomaly") node.className = "anomaly";
      }
      parts.push(node);
    };
    add(`Mission ${STORY_MISSION} logged `);
    add(`${meta.rare_events} rare events`, true);
    add(" (unusual but expected) and ");
    add(`${meta.anomalies} anomalies`, "anomaly");
    add(" (real faults).");
    if (drama?.status === "ok") {
      // AUC of "Looks dramatic" = chance an anomaly out-changes a rare event, so 1 − AUC is the reverse
      add(" Pick one of each at random: the rare event is the more dramatic one ");
      add(`${Math.round((1 - drama.roc_auc) * 100)}% of the time.`, true);
    }
    lede.replaceChildren(...parts);
  }

  async function load() {
    const events = await loadEvents(STORY_MISSION);
    pair = choosePair(events);
    if (pair.length !== 2) {
      showEmpty(pairBox, "The briefing pair is not in this export.");
      takeaway.hidden = true;
      return;
    }
    traces = await Promise.all(pair.map((e) => loadSignals(e.id)));
    takeaway.hidden = !(pair[0].lvr_median > pair[1].lvr_median);
    draw();
  }

  function draw() {
    if (traces.length !== 2) return;
    const { width, height } = chartArea(panel);
    pairBox.replaceChildren();
    const gap = 14;
    const cardW = (width - gap) / 2;

    pair.forEach((event, k) => {
      const signals = traces[k];
      const card = document.createElement("button");
      card.type = "button";
      card.className = "pair-card";
      card.style.width = `${cardW}px`;
      card.style.setProperty("--accent", categoryColor(event));
      card.setAttribute("aria-label", `Open ${shortId(event.id)} on monitor 1`);
      card.addEventListener("click", () => openOnMonitor1(event.id));

      const head = document.createElement("div");
      head.className = "pair-head";
      const name = document.createElement("b");
      name.textContent = shortId(event.id);
      const tag = document.createElement("span");
      tag.className = `pair-tag ${event.isAnomaly ? "anomaly" : "rare"}`;
      tag.textContent = event.isAnomaly ? "ANOMALY · fault" : "RARE EVENT · harmless";
      head.append(name, tag);
      const facts = document.createElement("div");
      facts.className = "pair-facts";
      facts.textContent = `variance ratio ${event.lvr_median > 0 ? "+" : ""}${short(event.lvr_median)} · ${event.n_channels} channels · ${duration(event.covered_h)}`;
      card.append(head, facts);

      const withFoot = height >= 130; // drop the footnote line on short screens rather than squash the chart
      const chartH = Math.max(30, height - (withFoot ? 86 : 68)); // card padding and the text lines around the chart (facts may take two)
      const svg = d3
        .select(card)
        .append("svg")
        .attr("width", cardW - 16)
        .attr("height", chartH)
        .attr("aria-hidden", "true");
      const channels = sortChannels(signals.channels, "severity")
        .filter((c) => c.kind === "numeric" && c.status === "ok")
        .slice(0, ROWS);
      const totalH = (Date.parse(signals.t1) - Date.parse(signals.t0)) / 3600e3;
      const x = d3.scaleLinear([0, totalH], [0, cardW - 16]);
      const rowH = chartH / ROWS;
      const binW = (cardW - 16) / signals.bins;
      const [start, end] = signals.event_h;
      svg.append("rect").attr("class", "event-band").attr("x", x(start)).attr("width", Math.max(1, x(end) - x(start))).attr("height", chartH);
      // one shared σ scale for both cards (the cap), so "wild" and "flat" are compared fairly
      const y = d3.scaleLinear([-SIGMA_CAP, SIGMA_CAP], [rowH - 3, 3]).clamp(true);
      channels.forEach((channel, i) => {
        const bins = sigmaBins(channel);
        const g = svg.append("g").attr("transform", `translate(0,${i * rowH})`);
        g.append("line").attr("class", "zero").attr("x2", cardW - 16).attr("y1", y(0)).attr("y2", y(0));
        const band = d3
          .area()
          .defined((_, j) => bins.lows[j] !== null)
          .x((_, j) => (j + 0.5) * binW)
          .y0((_, j) => y(bins.lows[j]))
          .y1((_, j) => Math.min(y(bins.lows[j]) - 1, y(bins.highs[j])));
        g.append("path").attr("d", band(bins.lows)).attr("fill", INK).attr("fill-opacity", 0.85);
      });
      const foot = document.createElement("div");
      foot.className = "pair-foot";
      foot.textContent = `top ${channels.length} channels · ±${SIGMA_CAP}σ · shaded: event`;
      if (withFoot) card.append(foot);
      pairBox.append(card);
    });
  }

  function openOnMonitor1(id) {
    const go = () => ctx.store.set({ selected: id, monitor: 1 });
    if (ctx.store.get().mission === STORY_MISSION) go();
    else ctx.switchMission(STORY_MISSION).then(go);
  }

  writeLede();
  load().catch((error) => showEmpty(pairBox, `Could not load the briefing pair (${error.message}).`));

  return {
    update() {},
    resize: draw,
  };
}
