// View A: parallel coordinates. One line per event across the event features; anomalies drawn
// over rare events. Drag along an axis to keep only events inside that range (the filter is
// shared with every other view); click a line to select its event. Events missing a feature
// pass through a separate "n/a" row under that axis, so they stay visible instead of vanishing.

import { COLORS, categoryColor, chartArea, freshSvg, hideTooltip, logTicks, setNotice, short, showTooltip } from "./chart.js";
import { FEATURES, featureKeys } from "./features.js";
import { duration, shortId } from "./format.js";
import { activeEvents } from "./state.js";

const MARGIN = { top: 34, right: 30, bottom: 24, left: 30 };
const NA_GAP = 14; // the n/a row sits this far below each axis

function yScale(key, events, height) {
  const values = events.map((e) => e[key]).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  const spec = FEATURES[key];
  if (!values.length) return d3.scaleLinear([0, 1], [height, 0]);
  let [low, high] = d3.extent(values);
  if (spec.scale === "log") {
    low = Math.max(low, 1e-2);
    return d3.scaleLog([low, Math.max(high, low * 10)], [height, 0]).nice();
  }
  if (spec.scale === "symlog") return d3.scaleSymlog([Math.min(0, low), Math.max(high, 1)], [height, 0]).nice();
  if (low === high) [low, high] = [low - 1, high + 1];
  return d3.scaleLinear([low, high], [height, 0]).nice();
}

export function createParallelCoordinates(panel, ctx) {
  let keys = [];
  let x;
  let y = {};
  let innerHeight = 0;
  let lines;
  let brushes = {};
  let syncing = false;

  const missionMeta = () => ctx.meta.missions.find((m) => m.mission === ctx.store.get().mission);

  function point(event, key) {
    const value = event[key];
    const missing = value === null || value === undefined || !Number.isFinite(value);
    if (missing) return [x(key), innerHeight + NA_GAP];
    // a log axis cannot show 0 (an instant event lasts 0 h): pin such values to the bottom of the axis
    const scale = y[key];
    return [x(key), scale(FEATURES[key].scale === "log" ? Math.max(value, scale.domain()[0]) : value)];
  }

  function build() {
    const { body, width, height } = chartArea(panel);
    keys = featureKeys(missionMeta());
    const innerWidth = width - MARGIN.left - MARGIN.right;
    innerHeight = height - MARGIN.top - MARGIN.bottom;
    x = d3.scalePoint(keys, [0, innerWidth]);
    y = Object.fromEntries(keys.map((key) => [key, yScale(key, ctx.events, innerHeight)]));

    const svg = freshSvg(body, width, height, "Parallel coordinates of event features, anomalies against rare events");
    const g = svg.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

    // draw rare events first and anomalies last, so the 31 anomalies are never buried
    const ordered = [...ctx.events].sort((a, b) => a.isAnomaly - b.isAnomaly);
    const path = d3.line();
    lines = g
      .append("g")
      .attr("class", "pc-lines")
      .selectAll("path")
      .data(ordered, (e) => e.id)
      .join("path")
      .attr("d", (e) => path(keys.map((key) => point(e, key))))
      .attr("fill", "none")
      .attr("stroke-linejoin", "round");

    // the selected event is drawn again on top, with a surface-coloured ring under it
    const selectedLayer = g.append("g").attr("class", "pc-selected");

    // invisible wide strokes make each line easy to hover and click
    g.append("g")
      .attr("class", "pc-hits")
      .selectAll("path")
      .data(ordered, (e) => e.id)
      .join("path")
      .attr("d", (e) => path(keys.map((key) => point(e, key))))
      .attr("fill", "none")
      .attr("stroke", "transparent")
      .attr("stroke-width", 7)
      .style("cursor", "pointer")
      .on("pointerenter pointermove", (event, e) => hover(event, e))
      .on("pointerleave", () => {
        hideTooltip();
        lines.classed("hovered", false);
      })
      .on("click", (_, e) => ctx.store.set({ selected: ctx.store.get().selected === e.id ? null : e.id }));

    // one axis per feature, with its own brush
    brushes = {};
    for (const key of keys) {
      const axis = g.append("g").attr("class", "pc-axis").attr("transform", `translate(${x(key)},0)`);
      const scale = y[key];
      const ticks = FEATURES[key].scale === "log" ? logTicks(scale) : scale.ticks(4);
      axis
        .call(d3.axisLeft(scale).tickValues(ticks).tickFormat(short).tickSize(4))
        .call((a) => a.selectAll("text").attr("class", "tick-label"));
      axis.append("text").attr("class", "na-label").attr("x", -6).attr("y", innerHeight + NA_GAP).attr("dy", "0.32em").text("n/a");
      axis
        .append("text")
        .attr("class", "axis-title")
        .attr("y", -20)
        .attr("text-anchor", "middle")
        .text(FEATURES[key].label)
        .append("title")
        .text(FEATURES[key].help);
      axis.append("text").attr("class", "axis-unit").attr("y", -8).attr("text-anchor", "middle").text(FEATURES[key].unit);

      const brush = d3
        .brushY()
        .extent([
          [-11, 0],
          [11, innerHeight],
        ])
        .on("brush end", (event) => {
          if (syncing || !event.sourceEvent) return; // ignore moves made by sync()
          const filters = { ...ctx.store.get().filters };
          if (event.selection) {
            const [top, bottom] = event.selection;
            filters[key] = [scale.invert(bottom), scale.invert(top)];
          } else {
            delete filters[key];
          }
          ctx.store.set({ filters });
        });
      brushes[key] = { brush, group: axis.append("g").attr("class", "pc-brush").call(brush) };
    }

    style();
    sync();
    drawSelected(selectedLayer, path);
  }

  function hover(pointer, e) {
    lines.classed("hovered", (d) => d.id === e.id);
    const rows = keys.map((key) => ({ value: short(e[key]), label: FEATURES[key].label.toLowerCase() }));
    showTooltip(pointer.clientX, pointer.clientY, `${shortId(e.id)} · ${e.category} · ${duration(e.span_h)}`, rows);
  }

  /** Colour each line: its category if it passes every filter and the time window, grey otherwise. */
  function style() {
    const state = ctx.store.get();
    const active = new Set(activeEvents(ctx.events, state).map((e) => e.id));
    lines
      .attr("stroke", (e) => (active.has(e.id) ? categoryColor(e) : COLORS.inactive))
      .attr("stroke-opacity", (e) => (!active.has(e.id) ? 0.25 : e.isAnomaly ? 0.9 : 0.4))
      .attr("stroke-width", (e) => (e.isAnomaly ? 1.6 : 1.1));
    // active anomalies on top of everything else in the line layer
    lines.filter((e) => e.isAnomaly && active.has(e.id)).raise();
  }

  function drawSelected(layer, path) {
    const event = ctx.byId.get(ctx.store.get().selected);
    const data = event ? [event] : [];
    const d = (e) => path(keys.map((key) => point(e, key)));
    layer.selectAll("path.ring").data(data).join("path").attr("class", "ring").attr("d", d).attr("fill", "none").attr("stroke", COLORS.surface).attr("stroke-width", 6);
    layer.selectAll("path.line").data(data).join("path").attr("class", "line").attr("d", d).attr("fill", "none").attr("stroke", COLORS.selected).attr("stroke-width", 2.5);
    layer
      .selectAll("circle")
      .data(event ? keys.map((key) => point(event, key)) : [])
      .join("circle")
      .attr("cx", (p) => p[0])
      .attr("cy", (p) => p[1])
      .attr("r", 3.5)
      .attr("fill", COLORS.selected)
      .attr("stroke", COLORS.surface)
      .attr("stroke-width", 2);
  }

  /** Move the brushes to match the shared filters (after Clear all, a chip's ×, or a mission change). */
  function sync() {
    const { filters } = ctx.store.get();
    syncing = true;
    for (const key of keys) {
      const { brush, group } = brushes[key];
      const range = filters[key];
      group.call(brush.move, range ? [y[key](range[1]), y[key](range[0])] : null);
    }
    syncing = false;
  }

  function notice() {
    const state = ctx.store.get();
    const n = Object.keys(state.filters).length;
    setNotice(
      panel,
      n
        ? [[`${n} axis filter${n > 1 ? "s" : ""}`, "b"], " active · grey lines are filtered out here, in B or in D"]
        : ["Anomalies (orange) drawn over rare events (blue). Hover a line for its values."],
    );
  }

  return {
    update(state, changed) {
      if (!changed || changed.has("mission")) {
        build();
        notice();
        return;
      }
      if (changed.has("filters")) sync();
      if (changed.has("filters") || changed.has("window") || changed.has("subsystem")) {
        style();
        notice();
      }
      if (changed.has("selected") || changed.has("filters")) {
        drawSelected(d3.select(panel).select(".pc-selected"), d3.line());
      }
    },
    resize: () => {
      build();
    },
  };
}
