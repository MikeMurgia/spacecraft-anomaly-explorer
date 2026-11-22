// Monitor 2 · Scores: one row per detector with its ROC-AUC and PR-AUC (point estimate, 95%
// bootstrap interval drawn as a bar on a 0-1 scale, the no-skill level marked) and how many
// anomalies it catches within the knob's alarm budget. Switch between the chosen mission's
// cross-validated scores and the transfer test (train on Mission 2, test on Mission 1). Click a
// row to highlight that detector everywhere.

import { COLORS, setNotice, showEmpty } from "./chart.js";
import { perMonth } from "./format.js";

const fmt = d3.format(".3f");
const GLYPH_W = 50;
const GLYPH_H = 12;

/** A tiny interval glyph: the bar is the 95% interval, the dot the estimate, the tick no skill. */
function glyph(value, [lo, hi], noSkill, chosen) {
  const x = d3.scaleLinear([0, 1], [3, GLYPH_W - 3]);
  const svg = d3.create("svg").attr("width", GLYPH_W).attr("height", GLYPH_H).attr("aria-hidden", "true");
  svg.append("line").attr("class", "glyph-axis").attr("x1", x(0)).attr("x2", x(1)).attr("y1", GLYPH_H / 2).attr("y2", GLYPH_H / 2);
  svg.append("line").attr("class", "glyph-skill").attr("x1", x(noSkill)).attr("x2", x(noSkill)).attr("y1", 1).attr("y2", GLYPH_H - 1);
  svg.append("line").attr("x1", x(lo)).attr("x2", x(hi)).attr("y1", GLYPH_H / 2).attr("y2", GLYPH_H / 2).attr("stroke", chosen ? COLORS.selected : "#7f93b2").attr("stroke-width", 3).attr("stroke-linecap", "round");
  svg.append("circle").attr("cx", x(value)).attr("cy", GLYPH_H / 2).attr("r", 3.5).attr("fill", chosen ? COLORS.selected : "#c9d6ea").attr("stroke", COLORS.surface).attr("stroke-width", 1.5);
  return svg.node();
}

function caughtAt(budgetCurve, budget) {
  let caught = 0;
  budgetCurve.false_alarms_per_month.forEach((rate, i) => {
    if (rate <= budget + 1e-9) caught = budgetCurve.caught[i];
  });
  return caught;
}

export function createScores(panel, ctx) {
  let setting = "mission"; // "mission" (cross-validated on the chosen mission) or "transfer"
  const tools = document.createElement("div");
  tools.className = "tools segmented";
  tools.setAttribute("role", "group");
  tools.setAttribute("aria-label", "Which scores");
  panel.querySelector(".panel-head").append(tools);

  function draw() {
    const state = ctx.store.get();
    const transfer = ctx.results.transfer;
    tools.replaceChildren(
      ...[
        ["mission", `Mission ${state.mission} · CV`],
        ["transfer", transfer ? `Train M${transfer.train} → test M${transfer.test}` : "Transfer"],
      ].map(([key, text]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = text;
        button.setAttribute("aria-pressed", String(setting === key));
        if (key === "transfer" && !transfer) button.disabled = true;
        button.addEventListener("click", () => {
          setting = key;
          draw();
        });
        return button;
      }),
    );

    const body = panel.querySelector("[data-chart]");
    const source = setting === "transfer" ? transfer : ctx.results.missions[String(state.mission)];
    if (!source || (setting === "mission" && !source.scored)) {
      showEmpty(body, `Mission ${state.mission} is not scored (fewer than 30 anomalies). Pick Mission 1 or 2, or the transfer test.`);
      setNotice(panel, []);
      return;
    }
    const anomalies = setting === "transfer" ? null : source.anomalies;
    const prevalence = source.prevalence;

    const table = document.createElement("table");
    table.className = "scores-table";
    const caption = document.createElement("caption");
    caption.className = "visually-hidden";
    caption.textContent = setting === "transfer" ? "Detector scores when trained on one mission and tested on another" : `Cross-validated detector scores on Mission ${state.mission}`;
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const text of ["Detector", "ROC-AUC", "PR-AUC", `≤ ${perMonth(state.budget)}/mo`]) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = text;
      headRow.append(th);
    }
    headRow.lastChild.title = "anomalies caught within the alarm budget set by the knob";
    head.append(headRow);
    const rows = document.createElement("tbody");

    for (const detector of ctx.results.detectors) {
      const result = source.detectors?.[detector.key];
      if (result?.status === "not_implemented") continue; // the conformal stub stays off the table
      const chosen = detector.key === state.detector;
      const tr = document.createElement("tr");
      tr.className = chosen ? "chosen" : "";
      const name = document.createElement("th");
      name.scope = "row";
      const key = document.createElement("b");
      key.textContent = detector.key;
      const label = document.createElement("span");
      label.textContent = detector.label;
      name.append(key, label);
      name.title = detector.description;
      tr.append(name);

      if (result?.status !== "ok") {
        tr.classList.add("off");
        const cell = document.createElement("td");
        cell.colSpan = 3;
        cell.textContent = "not scored";
        tr.append(cell);
      } else {
        for (const [metric, ci, skill] of [
          ["roc_auc", "roc_auc_ci", 0.5],
          ["pr_auc", "pr_auc_ci", prevalence],
        ]) {
          const td = document.createElement("td");
          td.title = `${fmt(result[metric])}, 95% interval ${fmt(result[ci][0])} to ${fmt(result[ci][1])}`;
          const value = document.createElement("div");
          value.className = "metric";
          const strong = document.createElement("b");
          strong.textContent = fmt(result[metric]);
          value.append(glyph(result[metric], result[ci], skill, chosen), strong);
          td.append(value);
          tr.append(td);
        }
        const caught = document.createElement("td");
        caught.className = "caught";
        const total = anomalies ?? result.budget.caught.at(-1);
        caught.textContent = `${caughtAt(result.budget, state.budget)} / ${total}`;
        tr.append(caught);
        if (result.cv_roc_auc_range) { // only learning detectors report a spread across CV repeats
          tr.title = `ROC-AUC across the ${ctx.results.cv.repeats} CV repeats: ${fmt(result.cv_roc_auc_range[0])} to ${fmt(result.cv_roc_auc_range[1])}`;
        }
        tr.tabIndex = 0;
        tr.addEventListener("click", () => ctx.store.set({ detector: detector.key }));
        tr.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            ctx.store.set({ detector: detector.key });
          }
        });
      }
      rows.append(tr);
    }
    const cols = document.createElement("colgroup");
    for (const name of ["name", "metric-col", "metric-col", "caught-col"]) {
      const col = document.createElement("col");
      col.className = name;
      cols.append(col);
    }
    table.append(caption, cols, head, rows);
    body.replaceChildren(table);

    // Mission 1 has so few rare events that flagging every event stays under about 0.5 false
    // alarms a month; at a bigger budget every detector "catches" everything, which says nothing
    const reachable = d3.max(Object.values(source.detectors ?? {}), (r) => (r.status === "ok" ? d3.max(r.budget.false_alarms_per_month) : 0)) ?? 0;
    const tooLoose = state.budget >= reachable;

    setNotice(
      panel,
      setting === "transfer"
        ? [`Trained on all of M${transfer.train}, scored on M${transfer.test}. Rules A–C learn nothing, so they match M${transfer.test}'s own scores.`, tooLoose ? ` Flagging every event costs only ${perMonth(reachable)} false alarms a month here: turn the knob down.` : ""]
        : [`${ctx.results.cv.splits}-fold CV × ${ctx.results.cv.repeats}, seed ${ctx.results.seed} · bar: 95% CI · tick: no skill`, tooLoose ? ` · flagging every event costs only ${perMonth(reachable)}/mo here: turn the knob down` : ""],
    );
  }

  return {
    update(state, changed) {
      if (!changed || ["mission", "detector", "budget"].some((key) => changed.has(key))) draw();
    },
    resize: () => {},
  };
}
