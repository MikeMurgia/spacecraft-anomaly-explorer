// Monitor 2 · Cross-mission check: does the Mission 2 story hold on the other two spacecraft?
// One column per mission, one row per feature, and every row shares one x axis across the three
// columns so the missions can be compared directly. In each cell, anomalies (top strip) and rare
// events (bottom strip) are drawn as dots with their median marked; n counts the events that have
// the feature. The variance ratio only exists for numeric missions (1 and 2), the state shift only
// for Mission 3, whose channels are states. Mission 3 is shown but not scored (8 anomalies).

import { COLORS, chartArea, freshSvg, hideTooltip, logTicks, setNotice, short, showTooltip } from "./chart.js";
import { loadEvents } from "./data.js";
import { FEATURES } from "./features.js";
import { shortId } from "./format.js";

const ROWS = ["n_channels", "lvr_median", "frozen_delta_median", "state_shift_median"];
const LABEL_W = 118;
const HEAD_H = 34;
const AXIS_H = 14;
const COL_GAP = 18;
const N_W = 38;

/** Deterministic jitter from the event id, so dots do not move between redraws. */
function jitter(id) {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

export function createMissionCheck(panel, ctx) {
  let byMission = null;

  async function load() {
    const missions = ctx.meta.missions.map((m) => m.mission);
    const lists = await Promise.all(missions.map((m) => loadEvents(m)));
    byMission = new Map(missions.map((m, i) => [m, lists[i]]));
    draw();
  }

  function draw() {
    if (!byMission) return;
    const state = ctx.store.get();
    const { body, width, height } = chartArea(panel);
    const missions = [...byMission.keys()];
    const colW = (width - LABEL_W - (missions.length - 1) * COL_GAP) / missions.length;
    const plotW = colW - N_W;
    const rowH = (height - HEAD_H) / ROWS.length;
    const strip = (rowH - AXIS_H - 6) / 2;
    const svg = freshSvg(body, width, height, "Feature distributions of anomalies and rare events in each mission");

    // column heads
    missions.forEach((m, c) => {
      const meta = ctx.meta.missions.find((d) => d.mission === m);
      const x0 = LABEL_W + c * (colW + COL_GAP);
      const head = svg.append("g").attr("class", `mission-head${m === state.mission ? " current" : ""}`).attr("transform", `translate(${x0},0)`);
      head.append("text").attr("class", "mission-title").attr("y", 14).text(`Mission ${m}`);
      head
        .append("text")
        .attr("class", "axis-unit")
        .attr("y", 28)
        .text(`${meta.anomalies} anomalies · ${meta.rare_events} rare${meta.scored ? "" : " · not scored"}`);
    });

    ROWS.forEach((key, r) => {
      const spec = FEATURES[key];
      const y0 = HEAD_H + r * rowH;
      const values = missions.flatMap((m) => byMission.get(m).map((e) => e[key])).filter((v) => Number.isFinite(v));
      svg.append("text").attr("class", "axis-title").attr("x", 0).attr("y", y0 + strip).text(spec.label).append("title").text(spec.help);
      svg.append("text").attr("class", "axis-unit").attr("x", 0).attr("y", y0 + strip + 13).text(spec.unit);
      if (!values.length) return;

      // one x scale for the whole row, shared by every mission
      let x;
      if (spec.scale === "log") x = d3.scaleLog([Math.max(d3.min(values), 1), d3.max(values)], [0, plotW]).nice();
      else {
        const [lo, hi] = d3.extent(values);
        x = d3.scaleLinear(lo === hi ? [lo - 1, hi + 1] : [lo, hi], [0, plotW]).nice();
      }

      missions.forEach((m, c) => {
        const x0 = LABEL_W + c * (colW + COL_GAP);
        const g = svg.append("g").attr("transform", `translate(${x0},${y0})`);
        const events = byMission.get(m);
        const has = events.some((e) => Number.isFinite(e[key]));
        if (!has) {
          g.append("rect").attr("class", "na-cell").attr("width", plotW).attr("height", strip * 2 + 2).attr("rx", 3);
          g.append("text")
            .attr("class", "axis-unit")
            .attr("x", plotW / 2)
            .attr("y", strip + 4)
            .attr("text-anchor", "middle")
            .text(key === "lvr_median" ? "not measured: state channels" : "not measured: numeric channels");
          return;
        }
        g.append("g")
          .attr("transform", `translate(0,${strip * 2 + 4})`)
          .call(
            d3
              .axisBottom(x)
              .tickValues(spec.scale === "log" ? logTicks(x) : x.ticks(4))
              .tickFormat(short)
              .tickSize(3),
          )
          .call((a) => a.selectAll("text").attr("class", "tick-label").attr("dy", "0.5em"));

        [true, false].forEach((isAnomaly, s) => {
          const group = events.filter((e) => e.isAnomaly === isAnomaly && Number.isFinite(e[key]) && (spec.scale !== "log" || e[key] > 0));
          const top = s * (strip + 1);
          const color = isAnomaly ? COLORS.anomaly : COLORS.rare;
          g.append("rect").attr("class", "strip-bg").attr("y", top).attr("width", plotW).attr("height", strip);
          g.append("g")
            .selectAll("circle")
            .data(group, (e) => e.id)
            .join("circle")
            .attr("cx", (e) => x(e[key]))
            .attr("cy", (e) => top + 3 + jitter(e.id) * (strip - 6))
            .attr("r", isAnomaly ? 2.6 : 1.8)
            .attr("fill", color)
            .attr("fill-opacity", isAnomaly ? 0.9 : 0.45)
            .on("pointerenter", (pointer, e) =>
              showTooltip(pointer.clientX, pointer.clientY, `M${m} ${shortId(e.id)} · ${e.category}`, [{ value: short(e[key]), label: spec.label.toLowerCase() }]),
            )
            .on("pointerleave", hideTooltip);
          if (group.length) {
            const median = d3.median(group, (e) => e[key]);
            g.append("line").attr("class", "median").attr("x1", x(median)).attr("x2", x(median)).attr("y1", top - 1).attr("y2", top + strip + 1);
          }
          g.append("text")
            .attr("class", "n-label")
            .attr("x", plotW + 6)
            .attr("y", top + strip / 2)
            .attr("dy", "0.32em")
            .text(`n=${group.length}`);
        });
      });
    });

    const transfer = ctx.results.transfer;
    const telemetry = transfer?.detectors?.Dt;
    const narrow = transfer?.detectors?.C;
    const parts = ["White tick: median. Top strip anomalies, bottom strip rare events."];
    if (telemetry?.status === "ok" && narrow?.status === "ok") {
      parts.push(
        ` Trained on Mission ${transfer.train} and tested on Mission ${transfer.test}, the telemetry-only model scores ROC-AUC `,
        [d3.format(".3f")(telemetry.roc_auc), "b"],
        "; the channel-count rule scores ",
        [d3.format(".3f")(narrow.roc_auc), "b"],
        ".",
      );
    }
    setNotice(panel, parts);
  }

  load().catch((error) => setNotice(panel, [`Could not load every mission (${error.message}).`]));

  return {
    update(state, changed) {
      if (!changed || changed.has("mission")) draw();
    },
    resize: draw,
  };
}
