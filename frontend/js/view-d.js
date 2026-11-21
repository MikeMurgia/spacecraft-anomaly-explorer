// View D: subsystem heatmap. For the events currently shown (view A filters + view B window), the
// share of anomalies and the share of rare events that touch each subsystem. Each column uses one
// hue from dark (0%) to full (100%), and the percentage is printed in the cell. Click a row to keep
// only events that touch that subsystem; click it again to release.

import { COLORS, chartArea, freshSvg, hideTooltip, setNotice, showTooltip, showTooltipAt } from "./chart.js";
import { activeEvents } from "./state.js";

const MARGIN = { top: 30, right: 8, bottom: 4, left: 112 };
const MIN_ROW = 17;
const COUNT_W = 46; // right-hand column with the number of events per subsystem
const CELL_GAP = 2;

const ramp = (color) => d3.interpolateRgb("#0c1829", color);
const pct = d3.format(".0%");

export function createHeatmap(panel, ctx) {
  function render() {
    const { body, width, height } = chartArea(panel);
    const state = ctx.store.get();
    // shares are computed without the subsystem filter itself, so the chosen row keeps its real share
    const events = activeEvents(ctx.events, { ...state, subsystem: null });
    const groups = [
      { key: "Anomaly", label: "Anomalies", color: COLORS.anomaly, events: events.filter((e) => e.isAnomaly) },
      { key: "Rare Event", label: "Rare events", color: COLORS.rare, events: events.filter((e) => !e.isAnomaly) },
    ];

    const all = [...new Set(ctx.events.flatMap((e) => e.subsystems ?? []))];
    const touching = (group, sub) => group.events.filter((e) => e.subsystems?.includes(sub)).length;
    let rows = all.map((sub) => ({
      sub,
      label: sub.replace(/^subsystem_/, "subsystem "),
      counts: groups.map((g) => touching(g, sub)),
      shares: groups.map((g) => (g.events.length ? touching(g, sub) / g.events.length : null)),
      total: events.filter((e) => e.subsystems?.includes(sub)).length,
    }));
    rows.sort((a, b) => (b.shares[0] ?? -1) - (a.shares[0] ?? -1) || (b.shares[1] ?? -1) - (a.shares[1] ?? -1));

    // fold the tail into one row if the subsystems do not all fit
    const maxRows = Math.max(1, Math.floor((height - MARGIN.top - MARGIN.bottom) / MIN_ROW));
    if (rows.length > maxRows) {
      const kept = rows.slice(0, maxRows - 1);
      const rest = rows.slice(maxRows - 1).map((r) => r.sub);
      const touchesRest = (e) => e.subsystems?.some((s) => rest.includes(s));
      rows = [
        ...kept,
        {
          sub: null,
          label: `${rest.length} others`,
          counts: groups.map((g) => g.events.filter(touchesRest).length),
          shares: groups.map((g) => (g.events.length ? g.events.filter(touchesRest).length / g.events.length : null)),
          total: events.filter(touchesRest).length,
        },
      ];
    }

    const svg = freshSvg(body, width, height, "Heatmap: share of anomalies and rare events touching each subsystem");
    const cellsW = width - MARGIN.left - MARGIN.right - COUNT_W;
    const rowH = Math.min(30, (height - MARGIN.top - MARGIN.bottom) / Math.max(rows.length, 1));
    const x = d3.scaleBand(groups.map((g) => g.key), [0, cellsW]).paddingInner(0);
    const g = svg.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

    g.selectAll("text.col")
      .data(groups)
      .join("text")
      .attr("class", "col-head")
      .attr("x", (d) => x(d.key) + x.bandwidth() / 2)
      .attr("y", -10)
      .attr("text-anchor", "middle")
      .text((d) => `${d.label} (${d.events.length})`);
    g.append("text").attr("class", "col-head").attr("x", cellsW + COUNT_W - 2).attr("y", -10).attr("text-anchor", "end").text("events");

    const selected = ctx.byId.get(state.selected);
    const row = g
      .selectAll("g.hm-row")
      .data(rows)
      .join("g")
      .attr("class", (d) => `hm-row${d.sub && d.sub === state.subsystem ? " chosen" : ""}`)
      .attr("transform", (_, i) => `translate(0,${i * rowH})`)
      .attr("tabindex", (d) => (d.sub ? 0 : null))
      .attr("role", (d) => (d.sub ? "button" : null))
      .attr("aria-pressed", (d) => (d.sub ? String(d.sub === state.subsystem) : null))
      .attr("aria-label", (d) => `${d.label}: ${d.shares.map((s, i) => `${s === null ? "n/a" : pct(s)} of ${groups[i].label.toLowerCase()}`).join(", ")}`)
      .style("cursor", (d) => (d.sub ? "pointer" : null))
      .on("click", (_, d) => choose(d))
      .on("keydown", (event, d) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          choose(d);
        }
      })
      .on("focus", (event, d) => showTooltipAt(event.currentTarget, d.label, tooltipRows(d)))
      .on("blur", hideTooltip);

    // a full-width hit area per row (bigger than the painted cells)
    row.append("rect").attr("class", "row-hit").attr("x", -MARGIN.left).attr("width", width).attr("height", rowH).attr("fill", "transparent");
    row
      .append("text")
      .attr("class", "row-label")
      .attr("x", -10)
      .attr("y", rowH / 2)
      .attr("dy", "0.32em")
      .attr("text-anchor", "end")
      .text((d) => d.label);
    // mark the subsystems the selected event touches
    row
      .filter((d) => selected && d.sub && selected.subsystems?.includes(d.sub))
      .append("circle")
      .attr("cx", -MARGIN.left + 6)
      .attr("cy", rowH / 2)
      .attr("r", 3.5)
      .attr("fill", COLORS.selected);

    row
      .selectAll("rect.cell")
      .data((d) => groups.map((group, i) => ({ row: d, group, share: d.shares[i], count: d.counts[i] })))
      .join("rect")
      .attr("class", "cell")
      .attr("x", (d) => x(d.group.key) + CELL_GAP / 2)
      .attr("y", CELL_GAP / 2)
      .attr("width", x.bandwidth() - CELL_GAP)
      .attr("height", rowH - CELL_GAP)
      .attr("rx", 2)
      .attr("fill", (d) => (d.share === null ? "#0c1829" : ramp(d.group.color)(d.share)))
      .on("pointerenter pointermove", (event, d) => showTooltip(event.clientX, event.clientY, d.row.label, tooltipRows(d.row)))
      .on("pointerleave", hideTooltip);

    row
      .selectAll("text.cell-value")
      .data((d) => groups.map((group, i) => ({ group, share: d.shares[i] })))
      .join("text")
      .attr("class", "cell-value")
      .attr("x", (d) => x(d.group.key) + x.bandwidth() / 2)
      .attr("y", rowH / 2)
      .attr("dy", "0.32em")
      .attr("text-anchor", "middle")
      .attr("fill", (d) => (d.share !== null && d.share > 0.55 ? "#06101c" : "#e4ecf7"))
      .text((d) => (d.share === null ? "–" : pct(d.share)));

    row
      .append("text")
      .attr("class", "row-count")
      .attr("x", cellsW + COUNT_W - 2)
      .attr("y", rowH / 2)
      .attr("dy", "0.32em")
      .attr("text-anchor", "end")
      .text((d) => d.total);

    const chosen = rows.find((r) => r.sub === state.subsystem);
    setNotice(
      panel,
      chosen
        ? ["Only events touching ", [chosen.label, "b"], " · click it again to release"]
        : ["An event can touch several subsystems. Click a row to filter."],
    );

    function tooltipRows(d) {
      return groups.map((group, i) => ({
        value: d.shares[i] === null ? "n/a" : pct(d.shares[i]),
        label: `of ${group.label.toLowerCase()} (${d.counts[i]} of ${group.events.length})`,
        color: group.color,
      }));
    }
  }

  function choose(d) {
    if (!d.sub) return;
    const current = ctx.store.get().subsystem;
    ctx.store.set({ subsystem: current === d.sub ? null : d.sub });
  }

  return {
    update(state, changed) {
      if (!changed || ["mission", "filters", "window", "selected", "subsystem"].some((key) => changed.has(key))) render();
    },
    resize: render,
  };
}
