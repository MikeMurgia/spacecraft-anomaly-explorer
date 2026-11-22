// Monitor 2 · Detector curves: ROC or precision-recall for every scored detector on the chosen
// mission, from out-of-fold cross-validation scores. The highlighted detector (shared with view E)
// gets its 95% bootstrap band; the others are grey for comparison. The thin reference line is
// "no skill": the diagonal for ROC, the share of anomalies for precision-recall. Click a name in the
// list on the right, or near a curve, to highlight it.

import { COLORS, chartArea, freshSvg, hideTooltip, setNotice, showEmpty, showTooltip } from "./chart.js";

const MUTED = "#50658a";
const LIST_W = 236;
const MARGIN = { top: 10, right: 16, bottom: 34, left: 44 };
const fmt = d3.format(".3f");

const METRICS = {
  roc: { label: "ROC", x: "fpr", y: "tpr", xTitle: "false positive rate", yTitle: "true positive rate", auc: "roc_auc", ci: "roc_auc_ci" },
  pr: { label: "Precision–recall", x: "recall", y: "precision", xTitle: "recall", yTitle: "precision", auc: "pr_auc", ci: "pr_auc_ci" },
};

export function createCurves(panel, ctx) {
  const tools = panel.querySelector("#metric-switch");
  tools.classList.add("segmented");
  tools.setAttribute("role", "group");
  tools.setAttribute("aria-label", "Curve type");
  for (const [key, text] of [
    ["roc", "ROC"],
    ["pr", "PR"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.metric = key;
    button.textContent = text;
    button.addEventListener("click", () => ctx.store.set({ metric: key }));
    tools.append(button);
  }

  function draw() {
    const state = ctx.store.get();
    for (const button of tools.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.metric === state.metric));
    const { body, width, height } = chartArea(panel);
    const mission = ctx.results.missions[String(state.mission)];
    if (!mission?.scored) {
      showEmpty(body, `Mission ${state.mission} is not scored (fewer than 30 anomalies). Switch to Mission 1 or 2.`);
      setNotice(panel, []);
      return;
    }
    const metric = METRICS[state.metric];
    const curves = ctx.results.detectors
      .filter((d) => mission.detectors[d.key]?.status === "ok")
      .map((d) => ({ ...d, result: mission.detectors[d.key] }));
    const chosen = curves.find((c) => c.key === state.detector) ?? curves[0];

    const plotW = width - LIST_W - MARGIN.left - MARGIN.right;
    const plotH = height - MARGIN.top - MARGIN.bottom;
    const side = Math.min(plotW, plotH); // square plot: both axes run 0 to 1
    const x = d3.scaleLinear([0, 1], [0, side]);
    const y = d3.scaleLinear([0, 1], [side, 0]);
    const svg = freshSvg(body, width, height, `${metric.label} curves for each detector, Mission ${state.mission}`);
    const g = svg.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top + (plotH - side) / 2})`);

    g.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(5).tickSize(-side).tickFormat("")).call((a) => a.select(".domain").remove());
    g.append("g").call(d3.axisLeft(y).ticks(5).tickSize(4)).call((a) => a.selectAll("text").attr("class", "tick-label"));
    g.append("g").attr("transform", `translate(0,${side})`).call(d3.axisBottom(x).ticks(5).tickSize(4)).call((a) => a.selectAll("text").attr("class", "tick-label"));
    g.append("text").attr("class", "axis-unit").attr("x", side / 2).attr("y", side + 28).attr("text-anchor", "middle").text(metric.xTitle);
    g.append("text").attr("class", "axis-unit").attr("transform", `translate(-34,${side / 2}) rotate(-90)`).attr("text-anchor", "middle").text(metric.yTitle);

    // no-skill reference
    if (state.metric === "roc") {
      g.append("line").attr("class", "reference").attr("x1", 0).attr("y1", side).attr("x2", side).attr("y2", 0);
    } else {
      g.append("line").attr("class", "reference").attr("x2", side).attr("y1", y(mission.prevalence)).attr("y2", y(mission.prevalence));
    }
    g.append("text")
      .attr("class", "axis-unit")
      .attr("x", side - 4)
      .attr("y", state.metric === "roc" ? x(0.5) + 26 : y(mission.prevalence) - 5)
      .attr("text-anchor", "end")
      .text(state.metric === "roc" ? "no skill (0.5)" : `no skill (${fmt(mission.prevalence)})`);

    const pts = (c) => c.result[state.metric][metric.x].map((v, i) => [v, c.result[state.metric][metric.y][i]]);
    const line = d3
      .line()
      .x((p) => x(p[0]))
      .y((p) => y(p[1]));
    const curveData = chosen.result[state.metric];
    const band = d3
      .area()
      .x((_, i) => x(curveData[metric.x][i]))
      .y0((_, i) => y(curveData.lo[i]))
      .y1((_, i) => y(curveData.hi[i]));
    g.append("path").attr("class", "band").attr("d", band(curveData.lo));
    g.append("g")
      .selectAll("path")
      .data(curves.filter((c) => c !== chosen))
      .join("path")
      .attr("d", (c) => line(pts(c)))
      .attr("fill", "none")
      .attr("stroke", MUTED)
      .attr("stroke-width", 1.5);
    g.append("path").attr("d", line(pts(chosen))).attr("fill", "none").attr("stroke", COLORS.surface).attr("stroke-width", 6);
    g.append("path").attr("d", line(pts(chosen))).attr("fill", "none").attr("stroke", COLORS.selected).attr("stroke-width", 2.5);

    // hover: read every detector at the pointer's x
    const cursor = g.append("line").attr("class", "cursor").attr("y2", side).attr("visibility", "hidden");
    g.append("rect")
      .attr("width", side)
      .attr("height", side)
      .attr("fill", "transparent")
      .on("pointermove", (pointer) => {
        const [px, py] = d3.pointer(pointer, g.node());
        const i = Math.max(0, Math.min(100, Math.round(x.invert(px) * 100)));
        cursor.attr("x1", x(i / 100)).attr("x2", x(i / 100)).attr("visibility", "visible");
        const rows = curves
          .map((c) => ({ c, v: c.result[state.metric][metric.y][i] }))
          .sort((a, b) => b.v - a.v)
          .map(({ c, v }) => ({ value: fmt(v), label: `${c.key} · ${c.label}`, color: c === chosen ? COLORS.selected : MUTED }));
        showTooltip(pointer.clientX, pointer.clientY, `${metric.x === "fpr" ? "false positive rate" : "recall"} ${fmt(i / 100)}`, rows);
        const near = d3.least(curves, (c) => Math.abs(y(c.result[state.metric][metric.y][i]) - py));
        g.style("cursor", near && Math.abs(y(near.result[state.metric][metric.y][i]) - py) < 10 ? "pointer" : null);
      })
      .on("pointerleave", () => {
        cursor.attr("visibility", "hidden");
        hideTooltip();
      })
      .on("click", (pointer) => {
        const [px, py] = d3.pointer(pointer, g.node());
        const i = Math.max(0, Math.min(100, Math.round(x.invert(px) * 100)));
        const near = d3.least(curves, (c) => Math.abs(y(c.result[state.metric][metric.y][i]) - py));
        if (near && Math.abs(y(near.result[state.metric][metric.y][i]) - py) < 10) ctx.store.set({ detector: near.key });
      });

    // detector list with each one's area under the curve and interval (the legend, and the picker)
    const list = svg.append("g").attr("transform", `translate(${width - LIST_W},${MARGIN.top + 4})`);
    list.append("text").attr("class", "col-head").attr("y", 0).text(`${state.metric === "roc" ? "ROC-AUC" : "PR-AUC (avg precision)"}`);
    const rows = ctx.results.detectors
      .map((d) => ({ ...d, result: mission.detectors[d.key] }))
      .filter((d) => d.result?.status !== "not_implemented"); // the conformal stub stays off the list
    const itemH = Math.min(34, (height - MARGIN.top - 24) / rows.length); // shrink the spacing on short screens
    const item = list
      .selectAll("g.curve-item")
      .data(rows)
      .join("g")
      .attr("class", (d) => `curve-item${d.key === chosen.key ? " chosen" : ""}${d.result?.status === "ok" ? "" : " off"}`)
      .attr("transform", (_, i) => `translate(0,${18 + i * itemH})`)
      .attr("tabindex", (d) => (d.result?.status === "ok" ? 0 : null))
      .attr("role", (d) => (d.result?.status === "ok" ? "button" : null))
      .on("click", (_, d) => d.result?.status === "ok" && ctx.store.set({ detector: d.key }))
      .on("keydown", (event, d) => {
        if ((event.key === "Enter" || event.key === " ") && d.result?.status === "ok") {
          event.preventDefault();
          ctx.store.set({ detector: d.key });
        }
      });
    item.append("rect").attr("class", "row-hit").attr("x", -6).attr("y", -12).attr("width", LIST_W - 4).attr("height", itemH - 2).attr("fill", "transparent");
    item.append("line").attr("x2", 14).attr("y1", -4).attr("y2", -4).attr("stroke", (d) => (d.key === chosen.key ? COLORS.selected : MUTED)).attr("stroke-width", (d) => (d.key === chosen.key ? 2.5 : 1.5));
    item
      .append("text")
      .attr("class", "item-name")
      .attr("x", 20)
      .text((d) => {
        const text = `${d.key} · ${d.label}`;
        return text.length > 30 ? `${text.slice(0, 29)}…` : text;
      })
      .append("title")
      .text((d) => d.description);
    item
      .append("text")
      .attr("class", "item-value")
      .attr("x", 20)
      .attr("y", 13)
      .text((d) => (d.result?.status === "ok" ? `${fmt(d.result[metric.auc])} [${fmt(d.result[metric.ci][0])}, ${fmt(d.result[metric.ci][1])}]` : "not scored"));

    setNotice(panel, [
      [`${chosen.key} · ${chosen.label}`, "b"],
      ` · shaded: 95% bootstrap band (${ctx.results.bootstrap} resamples) · ${mission.anomalies} anomalies vs ${mission.rare_events} rare events`,
    ]);
  }

  return {
    update(state, changed) {
      if (!changed || ["mission", "metric", "detector"].some((key) => changed.has(key))) draw();
    },
    resize: draw,
  };
}
