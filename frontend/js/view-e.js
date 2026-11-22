// View E: the alarm budget. Each detector is a step curve: lower its alarm threshold and it catches
// more anomalies, but also raises more false alarms (rare events flagged), counted per month of
// mission time. The knob sets the budget (the yellow line); each curve's dot shows how many
// anomalies it catches without going over it. One detector is highlighted (pick it above the chart
// or click near its curve); the others stay grey for comparison. Scores are out-of-fold
// cross-validation scores, so no event is scored by a model that trained on it.

import { COLORS, chartArea, freshSvg, hideTooltip, setNotice, showEmpty, showTooltip } from "./chart.js";
import { perMonth, shortId } from "./format.js";
import { BUDGET_STOPS } from "./state.js";

const MARGIN = { top: 12, right: 64, bottom: 34, left: 44 };
const MUTED = "#50658a";
const PICK_DISTANCE = 12;

/** Index of the last point on the curve that stays within the budget. */
function atBudget(curve, budget) {
  let index = 0;
  curve.false_alarms_per_month.forEach((rate, i) => {
    if (rate <= budget + 1e-9) index = i;
  });
  return index;
}

export function createBudget(panel, ctx) {
  const tools = document.createElement("div");
  tools.className = "tools segmented";
  tools.setAttribute("role", "group");
  tools.setAttribute("aria-label", "Highlighted detector");
  panel.querySelector(".panel-head").append(tools);

  const labelOf = (key) => ctx.results.detectors.find((d) => d.key === key)?.label ?? key;

  function buttons(mission) {
    const state = ctx.store.get();
    // a detector that is not implemented yet (the conformal stub) gets no button
    const listed = ctx.results.detectors.filter((d) => mission?.detectors?.[d.key]?.status !== "not_implemented");
    tools.replaceChildren(
      ...listed.map((detector) => {
        const result = mission?.detectors?.[detector.key];
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = detector.key === "conformal" ? "Conf." : detector.key;
        button.title = `${detector.key} · ${detector.label}: ${detector.description}`;
        button.setAttribute("aria-pressed", String(state.detector === detector.key));
        if (!result || result.status !== "ok") {
          button.disabled = true;
          button.title += " (not scored)";
        }
        button.addEventListener("click", () => ctx.store.set({ detector: detector.key }));
        return button;
      }),
    );
  }

  function draw() {
    const state = ctx.store.get();
    const mission = ctx.results.missions[String(state.mission)];
    buttons(mission);
    const { body, width, height } = chartArea(panel);

    if (!mission?.scored) {
      const anomalies = ctx.meta.missions.find((m) => m.mission === state.mission)?.anomalies ?? 0;
      showEmpty(body, `Mission ${state.mission} has ${anomalies} anomalies, fewer than the 30 needed to score detectors fairly. Its events are shown for description only.`);
      setNotice(panel, ["The budget curves are drawn for Missions 1 and 2."]);
      return;
    }

    const curves = ctx.results.detectors
      .filter((d) => mission.detectors[d.key]?.status === "ok")
      .map((d) => ({ key: d.key, label: d.label, ...mission.detectors[d.key].budget, scores: mission.detectors[d.key].scores }));
    const chosen = curves.find((c) => c.key === state.detector) ?? curves.find((c) => c.key === "D") ?? curves[0];

    const plotW = width - MARGIN.left - MARGIN.right;
    const plotH = height - MARGIN.top - MARGIN.bottom;
    const xMax = d3.max(curves, (c) => d3.max(c.false_alarms_per_month));
    const x = d3.scaleSymlog([0, xMax], [0, plotW]).constant(0.1);
    const y = d3.scaleLinear([0, mission.anomalies], [plotH, 0]).nice();
    const budget = Math.min(state.budget, xMax);

    const svg = freshSvg(body, width, height, `Anomalies caught against false alarms per month for each detector, Mission ${state.mission}`);
    const g = svg.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

    // the knob's stops as ticks, skipping any that would crowd its neighbour on the compressed low end
    const ticks = [];
    for (const t of [0, ...BUDGET_STOPS.filter((s) => s < xMax * 0.8), Math.round(xMax * 10) / 10]) {
      if (!ticks.length || x(t) - x(ticks.at(-1)) >= 30) ticks.push(t);
    }
    g.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(5).tickSize(-plotW).tickFormat("")).call((a) => a.select(".domain").remove());
    g.append("g")
      .call(d3.axisLeft(y).ticks(5).tickSize(4))
      .call((a) => a.selectAll("text").attr("class", "tick-label"));
    g.append("g")
      .attr("transform", `translate(0,${plotH})`)
      .call(d3.axisBottom(x).tickValues(ticks).tickFormat((t) => perMonth(t)).tickSize(4))
      .call((a) => a.selectAll("text").attr("class", "tick-label"));
    g.append("text").attr("class", "axis-unit").attr("x", plotW).attr("y", plotH + 28).attr("text-anchor", "end").text(`false alarms per month (rare events flagged · ${mission.rare_events} over ${mission.months.toFixed(1)} months)`);
    g.append("text").attr("class", "axis-unit").attr("transform", `translate(-34,${plotH / 2}) rotate(-90)`).attr("text-anchor", "middle").text(`anomalies caught (of ${mission.anomalies})`);

    // the budget: everything left of the line costs at most that many false alarms a month
    g.append("rect").attr("class", "budget-zone").attr("width", x(budget)).attr("height", plotH);
    g.append("line").attr("class", "budget-line").attr("x1", x(budget)).attr("x2", x(budget)).attr("y2", plotH);
    g.append("text")
      .attr("class", "budget-label")
      .attr("x", x(budget) + 5)
      .attr("y", 10)
      .text(state.budget > xMax ? `budget ≤ ${perMonth(state.budget)}/mo (beyond the last alarm)` : `budget ≤ ${perMonth(state.budget)}/mo`);

    const line = d3
      .line()
      .curve(d3.curveStepAfter)
      .x((p) => x(p[0]))
      .y((p) => y(p[1]));
    const points = (c) => [...c.false_alarms_per_month.map((r, i) => [r, c.caught[i]]), [xMax, c.caught.at(-1)]];

    const others = curves.filter((c) => c !== chosen);
    g.append("g")
      .selectAll("path")
      .data(others)
      .join("path")
      .attr("d", (c) => line(points(c)))
      .attr("fill", "none")
      .attr("stroke", MUTED)
      .attr("stroke-width", 1.5);
    g.append("path").attr("d", line(points(chosen))).attr("fill", "none").attr("stroke", COLORS.surface).attr("stroke-width", 6);
    g.append("path").attr("d", line(points(chosen))).attr("fill", "none").attr("stroke", COLORS.selected).attr("stroke-width", 2.5);

    // a dot where each curve meets the budget, labelled with its detector and count; labels are
    // nudged apart so they never overlap
    const marks = curves
      .map((c) => {
        const i = atBudget(c, budget);
        return { c, caught: c.caught[i], threshold: c.threshold[i], px: x(c.false_alarms_per_month[i]), py: y(c.caught[i]) };
      })
      .sort((a, b) => a.py - b.py);
    let lastY = -Infinity;
    for (const mark of marks) {
      mark.ly = Math.max(mark.py, lastY + 13);
      lastY = mark.ly;
    }
    const labelX = x(budget) + 8;
    g.append("g")
      .selectAll("circle")
      .data(marks)
      .join("circle")
      .attr("cx", (m) => m.px)
      .attr("cy", (m) => m.py)
      .attr("r", (m) => (m.c === chosen ? 5 : 3.5))
      .attr("fill", (m) => (m.c === chosen ? COLORS.selected : MUTED))
      .attr("stroke", COLORS.surface)
      .attr("stroke-width", 2);
    g.append("g")
      .selectAll("text")
      .data(marks)
      .join("text")
      .attr("class", (m) => `mark-label${m.c === chosen ? " chosen" : ""}`)
      .attr("x", labelX)
      .attr("y", (m) => m.ly)
      .attr("dy", "0.32em")
      .text((m) => `${m.c.key} ${m.caught}`);

    // hover: snap to the pointer's false-alarm rate and list every detector's count there
    const cursor = g.append("line").attr("class", "cursor").attr("y2", plotH).attr("visibility", "hidden");
    g.append("rect")
      .attr("width", plotW)
      .attr("height", plotH)
      .attr("fill", "transparent")
      .on("pointermove", (pointer) => {
        const [px, py] = d3.pointer(pointer, g.node());
        const rate = Math.max(0, x.invert(px));
        cursor.attr("x1", px).attr("x2", px).attr("visibility", "visible");
        const rows = curves
          .map((c) => ({ c, caught: c.caught[atBudget(c, rate)] }))
          .sort((a, b) => b.caught - a.caught)
          .map(({ c, caught }) => ({ value: `${caught} of ${mission.anomalies}`, label: `${c.key} · ${c.label}`, color: c === chosen ? COLORS.selected : MUTED }));
        showTooltip(pointer.clientX, pointer.clientY, `at ≤ ${perMonth(rate)} false alarms / month`, rows);
        const near = nearestCurve(px, py);
        g.style("cursor", near && near !== chosen ? "pointer" : null);
      })
      .on("pointerleave", () => {
        cursor.attr("visibility", "hidden");
        hideTooltip();
      })
      .on("click", (pointer) => {
        const [px, py] = d3.pointer(pointer, g.node());
        const near = nearestCurve(px, py);
        if (near) ctx.store.set({ detector: near.key });
      });

    function nearestCurve(px, py) {
      const rate = Math.max(0, x.invert(px));
      const best = d3.least(curves, (c) => Math.abs(y(c.caught[atBudget(c, rate)]) - py));
      return best && Math.abs(y(best.caught[atBudget(best, rate)]) - py) <= PICK_DISTANCE ? best : null;
    }

    // footnote: the chosen detector at this budget, against the drama rule, and the selected event's fate
    const mine = marks.find((m) => m.c === chosen);
    const drama = marks.find((m) => m.c.key === "A");
    const parts = [
      `At ≤ ${perMonth(state.budget)} false alarm${state.budget === 1 ? "" : "s"} a month, `,
      [`${chosen.key} catches ${mine.caught} of ${mission.anomalies}`, "b"],
    ];
    if (drama && drama.c !== chosen) parts.push(`; "${drama.c.label}" catches ${drama.caught}`);
    const selected = ctx.byId.get(state.selected);
    if (selected?.isAnomaly) {
      const score = chosen.scores[selected.id];
      if (score === undefined) parts.push(` · ${shortId(selected.id)} was not scored (missing features)`);
      else {
        const caught = mine.threshold !== null && score >= mine.threshold;
        parts.push(` · ${shortId(selected.id)} is `, [caught ? "caught" : "missed", "b"]);
      }
    } else if (selected) {
      const score = chosen.scores[selected.id];
      if (score !== undefined) {
        const flagged = mine.threshold !== null && score >= mine.threshold;
        parts.push(` · ${shortId(selected.id)} ${flagged ? "would be a false alarm" : "stays quiet"}`);
      }
    }
    setNotice(panel, parts);
  }

  return {
    update(state, changed) {
      if (!changed || ["mission", "budget", "detector", "selected"].some((key) => changed.has(key))) draw();
    },
    resize: draw,
  };
}
