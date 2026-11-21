// View B: the event timeline. Each event is a dot at its start time, at a height set by how long
// it lasted (log scale); a thin line runs to its end once the zoom makes that visible. The strip
// underneath shows the whole mission; drag across it to zoom the timeline (and filter every other
// view to that window). Click a dot to select its event.

import { COLORS, categoryColor, chartArea, freshSvg, hideTooltip, logTicks, setNotice, short, showTooltip } from "./chart.js";
import { duration, shortId, utcDay, utcStamp } from "./format.js";
import { passesFilters, touchesSubsystem } from "./state.js";

const MARGIN = { top: 10, right: 14, bottom: 22, left: 46 };
const STRIP = 34; // overview strip height, including its label
const GAP = 14; // between the main plot's axis and the strip
const HIT_RADIUS = 18;

export function createTimeline(panel, ctx) {
  let svg;
  let main;
  let strip;
  let x;
  let xAll;
  let y;
  let plotWidth = 0;
  let plotHeight = 0;
  let brush;
  let brushGroup;
  let syncing = false;
  let shown = [];
  let delaunay = null;
  let span = [0, 0]; // first event start, last event end

  function missionExtent() {
    const meta = ctx.meta.missions.find((m) => m.mission === ctx.store.get().mission);
    const first = Date.parse(meta.first);
    const last = Date.parse(meta.last);
    span = [first, last];
    const pad = (last - first) * 0.01; // keep the first and last dots off the plot edges
    return [first - pad, last + pad];
  }

  function build() {
    const { body, width, height } = chartArea(panel);
    plotWidth = width - MARGIN.left - MARGIN.right;
    plotHeight = height - MARGIN.top - MARGIN.bottom - GAP - STRIP;
    svg = freshSvg(body, width, height, "Timeline of events: start time against duration");

    xAll = d3.scaleUtc(missionExtent(), [0, plotWidth]);
    x = xAll.copy();
    const durations = ctx.events.map((e) => e.covered_h).filter((h) => h > 0);
    y = d3.scaleLog([Math.max(d3.min(durations) ?? 0.1, 0.01), d3.max(durations) ?? 10], [plotHeight, 0]).nice();

    main = svg.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);
    main.append("clipPath").attr("id", "tl-clip").append("rect").attr("width", plotWidth).attr("height", plotHeight);
    main.append("g").attr("class", "grid");
    main.append("g").attr("class", "y-axis");
    main.append("g").attr("class", "x-axis").attr("transform", `translate(0,${plotHeight})`);
    main
      .append("text")
      .attr("class", "axis-unit")
      .attr("transform", `translate(${-36},${plotHeight / 2}) rotate(-90)`)
      .attr("text-anchor", "middle")
      .text("duration (h, log)");
    const plot = main.append("g").attr("clip-path", "url(#tl-clip)");
    plot.append("g").attr("class", "spans");
    plot.append("g").attr("class", "dots");
    plot.append("g").attr("class", "selection");

    // the overlay catches the pointer for the whole plot: hover finds the nearest dot
    main
      .append("rect")
      .attr("class", "overlay")
      .attr("width", plotWidth)
      .attr("height", plotHeight)
      .attr("fill", "transparent")
      .on("pointermove", (event) => {
        const e = nearest(event);
        main.select(".dots").selectAll("circle").classed("hovered", (d) => d === e);
        main.select(".overlay").style("cursor", e ? "pointer" : null);
        if (!e) return hideTooltip();
        showTooltip(event.clientX, event.clientY, `${shortId(e.id)} · ${e.category}`, [
          { value: utcStamp(e.startMs), label: "start" },
          { value: duration(e.covered_h), label: "covered" },
          { value: String(e.n_channels), label: "channels" },
          { value: short(e.lvr_median ?? e.state_shift_median), label: e.lvr_median !== null ? "variance ratio" : "state shift" },
        ]);
      })
      .on("pointerleave", () => {
        hideTooltip();
        main.select(".dots").selectAll("circle").classed("hovered", false);
      })
      .on("click", (event) => {
        const e = nearest(event);
        const state = ctx.store.get();
        if (e) ctx.store.set({ selected: state.selected === e.id ? null : e.id });
      });

    // overview strip: every event as a short tick, plus the brush that sets the time window
    strip = svg.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top + plotHeight + MARGIN.bottom + GAP})`);
    strip.append("rect").attr("class", "strip-bg").attr("width", plotWidth).attr("height", STRIP - 12);
    strip
      .append("g")
      .attr("class", "strip-ticks")
      .selectAll("line")
      .data([...ctx.events].sort((a, b) => a.isAnomaly - b.isAnomaly))
      .join("line")
      .attr("x1", (e) => xAll(e.startMs))
      .attr("x2", (e) => xAll(e.startMs))
      .attr("y1", (e) => (e.isAnomaly ? 3 : 8))
      .attr("y2", STRIP - 15)
      .attr("stroke", categoryColor)
      .attr("stroke-width", (e) => (e.isAnomaly ? 1.5 : 1))
      .attr("stroke-opacity", (e) => (e.isAnomaly ? 1 : 0.45));
    strip
      .append("text")
      .attr("class", "axis-unit")
      .attr("x", 0)
      .attr("y", STRIP - 1)
      .text(`whole mission · ${utcDay(span[0])} → ${utcDay(span[1])} · drag here to zoom`);
    brush = d3
      .brushX()
      .extent([
        [0, 0],
        [plotWidth, STRIP - 12],
      ])
      .on("brush end", (event) => {
        if (syncing || !event.sourceEvent) return;
        const window = event.selection ? event.selection.map((px) => xAll.invert(px).getTime()) : null;
        ctx.store.set({ window });
      });
    brushGroup = strip.append("g").attr("class", "tl-brush").call(brush);

    render();
  }

  function nearest(pointer) {
    if (!delaunay) return null;
    const [px, py] = d3.pointer(pointer, main.node());
    const i = delaunay.find(px, py);
    const e = shown[i];
    if (!e) return null;
    const dx = x(e.startMs) - px;
    const dy = y(Math.max(e.covered_h, y.domain()[0])) - py;
    return Math.hypot(dx, dy) <= HIT_RADIUS ? e : null;
  }

  function render() {
    const state = ctx.store.get();
    x.domain(state.window ?? xAll.domain());
    const cy = (e) => y(Math.max(e.covered_h ?? y.domain()[0], y.domain()[0]));

    main
      .select(".grid")
      .call(d3.axisLeft(y).tickValues(logTicks(y)).tickSize(-plotWidth).tickFormat(""))
      .call((g) => g.select(".domain").remove());
    main
      .select(".y-axis")
      .call(d3.axisLeft(y).tickValues(logTicks(y)).tickFormat(short).tickSize(4))
      .call((g) => g.selectAll("text").attr("class", "tick-label"));
    main
      .select(".x-axis")
      .call(d3.axisBottom(x).ticks(Math.max(3, Math.floor(plotWidth / 110))).tickSize(4))
      .call((g) => g.selectAll("text").attr("class", "tick-label"));

    // events inside the time window; those failing a feature filter stay as grey context
    const [from, to] = x.domain().map(Number);
    const inView = ctx.events.filter((e) => e.endMs >= from && e.startMs <= to);
    const passes = (e) => passesFilters(e, state.filters) && touchesSubsystem(e, state.subsystem);
    shown = inView.filter(passes).sort((a, b) => a.isAnomaly - b.isAnomaly);
    const context = inView.filter((e) => !passes(e));
    delaunay = shown.length ? d3.Delaunay.from(shown, (e) => x(e.startMs), cy) : null;

    main
      .select(".spans")
      .selectAll("line")
      .data(shown.filter((e) => x(e.endMs) - x(e.startMs) > 4), (e) => e.id)
      .join("line")
      .attr("x1", (e) => x(e.startMs))
      .attr("x2", (e) => x(e.endMs))
      .attr("y1", cy)
      .attr("y2", cy)
      .attr("stroke", categoryColor)
      .attr("stroke-width", 2)
      .attr("stroke-linecap", "round")
      .attr("stroke-opacity", 0.55);

    main
      .select(".dots")
      .selectAll("circle")
      .data([...context, ...shown], (e) => e.id)
      .join("circle")
      .order() // context first, then rare events, then anomalies on top
      .attr("cx", (e) => x(e.startMs))
      .attr("cy", cy)
      .attr("r", (e) => (!passes(e) ? 2.5 : e.isAnomaly ? 4.5 : 3.5))
      .attr("fill", (e) => (passes(e) ? categoryColor(e) : COLORS.inactive))
      .attr("fill-opacity", (e) => (passes(e) ? (e.isAnomaly ? 1 : 0.75) : 0.6))
      .attr("stroke", COLORS.surface)
      .attr("stroke-width", (e) => (e.isAnomaly ? 1.5 : 1));

    const selected = ctx.byId.get(state.selected);
    main
      .select(".selection")
      .selectAll("circle")
      .data(selected ? [selected] : [])
      .join("circle")
      .attr("cx", (e) => x(e.startMs))
      .attr("cy", cy)
      .attr("r", 8)
      .attr("fill", "none")
      .attr("stroke", COLORS.selected)
      .attr("stroke-width", 2);

    const anomalies = shown.filter((e) => e.isAnomaly).length;
    setNotice(panel, [
      state.window ? [`${utcDay(from)} → ${utcDay(to)}`, "b"] : ["Whole mission", "b"],
      ` · ${shown.length} events in view, ${anomalies} anomal${anomalies === 1 ? "y" : "ies"}`,
      context.length ? ` · ${context.length} grey (filtered in A or D)` : "",
    ]);
  }

  function syncBrush() {
    const { window } = ctx.store.get();
    syncing = true;
    brushGroup.call(brush.move, window ? window.map((t) => xAll(t)) : null);
    syncing = false;
  }

  return {
    update(state, changed) {
      if (!changed || changed.has("mission")) {
        build();
        syncBrush();
        return;
      }
      if (changed.has("window")) syncBrush();
      if (["window", "filters", "subsystem", "selected"].some((key) => changed.has(key))) render();
    },
    resize: () => {
      build();
      syncBrush();
    },
  };
}
