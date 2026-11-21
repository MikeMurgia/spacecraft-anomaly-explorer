// View C: every channel of the selected event, stacked on one shared time axis that runs from a
// baseline-length before the event to a baseline-length after it (the event itself is shaded).
// Numeric rows are drawn in standard deviations from the channel's own pre-event mean, so a
// quiet channel and a loud one can be compared; each row's range is printed at its left (at most
// ±10σ, beyond that values are clipped and marked). State channels show the most common state in
// each time bin, bright where it differs from the usual pre-event state. A yellow tick marks where
// each channel first alarmed; the line through the whole stack is the event's first alarm.
// The list scrolls; sort it by the size of the change or by which channel moved first.

import { COLORS, categoryColor, chartArea, hideTooltip, setNotice, short, showEmpty, showTooltip } from "./chart.js";
import { loadSignals } from "./data.js";
import { shortId } from "./format.js";

const LABEL_W = 176;
const ROW_H = 34;
const AXIS_H = 38;
const SIGMA_CAP = 10;
const SIGMA_MIN = 3;
const SCROLLBAR = 10;
const INK = "#c9d6ea"; // the signal itself: neutral ink, so colour stays reserved for category and alarms
const QUIET = "#33476a"; // a state channel sitting in its usual state

const ALARM_TEXT = { spike: "more than 4σ from the pre-event mean", freeze: "repeated value longer than any run before the event", state: "left its usual pre-event state" };

/** Hours relative to the event start as "+5 min", "−6 h", "0". */
function signedHours(rel) {
  const size = Math.abs(rel);
  if (size < 1 / 120) return "0";
  const sign = rel > 0 ? "+" : "−";
  return size < 1 ? `${sign}${Math.round(size * 60)} min` : `${sign}${short(size)} h`;
}

/** Severity used for sorting: size of the variance change, or of the state change. */
function severity(channel) {
  if (channel.kind === "numeric" && Number.isFinite(channel.log_var_ratio)) return Math.abs(channel.log_var_ratio);
  if (channel.kind === "categorical" && Number.isFinite(channel.state_shift)) return channel.state_shift;
  return -1;
}

function sortChannels(channels, mode) {
  const usable = (c) => c.status === "ok";
  return [...channels].sort((a, b) => {
    if (usable(a) !== usable(b)) return usable(a) ? -1 : 1;
    if (mode === "onset") {
      const ta = a.alarm_h ?? Infinity;
      const tb = b.alarm_h ?? Infinity;
      if (ta !== tb) return ta - tb;
    }
    return severity(b) - severity(a) || a.name.localeCompare(b.name);
  });
}

/** Numeric bins converted to σ from the pre-event mean (falls back to the window's own range). */
function sigmaBins(channel) {
  const { min, max, baseline_mean: mean, baseline_std: std } = channel;
  const scaled = std > 0 && Number.isFinite(mean);
  let centre = mean;
  let unit = std;
  if (!scaled) {
    const values = [...min, ...max].filter((v) => v !== null);
    const [lo, hi] = d3.extent(values);
    centre = ((lo ?? 0) + (hi ?? 0)) / 2;
    unit = (hi - lo) / 2 || 1;
  }
  const lows = min.map((v) => (v === null ? null : (v - centre) / unit));
  const highs = max.map((v) => (v === null ? null : (v - centre) / unit));
  const peak = d3.max([...lows, ...highs], (v) => (v === null ? 0 : Math.abs(v))) ?? 0;
  const limit = scaled ? Math.min(SIGMA_CAP, Math.max(SIGMA_MIN, Math.ceil(peak))) : 1;
  return { lows, highs, limit, scaled, clipped: scaled && peak > SIGMA_CAP };
}

/** For a state channel: the most common state in the bins before the event. */
function usualState(channel, eventStartBin) {
  const before = channel.mode.slice(0, Math.max(1, eventStartBin)).filter((m) => m >= 0);
  if (!before.length) return null;
  return d3.greatest(d3.rollups(before, (v) => v.length, (m) => m), (d) => d[1])[0];
}

export function createChannelStack(panel, ctx) {
  const sub = document.getElementById("view-c-sub");
  const tools = document.createElement("div");
  tools.className = "tools segmented";
  tools.setAttribute("role", "group");
  tools.setAttribute("aria-label", "Sort channels");
  for (const [mode, text, title] of [
    ["severity", "Biggest change", "sort by |log variance ratio| (state shift for state channels)"],
    ["onset", "Earliest alarm", "sort by when each channel first alarmed"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.sort = mode;
    button.textContent = text;
    button.title = title;
    button.addEventListener("click", () => ctx.store.set({ sort: mode }));
    tools.append(button);
  }
  panel.querySelector(".panel-head").append(tools);

  let signals = null;
  let controller = null;
  let scrollTop = 0;

  async function load(id) {
    controller?.abort();
    if (!id) {
      signals = null;
      draw();
      return;
    }
    controller = new AbortController();
    panel.classList.add("is-loading");
    try {
      const data = await loadSignals(id, controller.signal);
      if (data.id !== ctx.store.get().selected) return;
      signals = data;
      scrollTop = 0;
      draw();
    } catch (error) {
      if (error.name === "AbortError") return;
      signals = null;
      showEmpty(chartArea(panel).body, `Could not load the channels for ${shortId(id)} (${error.message}).`);
    } finally {
      panel.classList.remove("is-loading");
    }
  }

  function draw() {
    const { body, width, height } = chartArea(panel);
    const sort = ctx.store.get().sort;
    for (const button of tools.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.sort === sort));

    if (!signals) {
      sub.textContent = "select an event";
      showEmpty(body, "Select an event: click a line in A or a dot in B, or press NEXT ANOMALY.");
      setNotice(panel, []);
      return;
    }

    const event = ctx.byId.get(signals.id);
    const channels = sortChannels(signals.channels, sort);
    const t0 = Date.parse(signals.t0);
    const totalH = (Date.parse(signals.t1) - t0) / 3600e3;
    const [eventStart, eventEnd] = signals.event_h;
    const plotW = width - LABEL_W - SCROLLBAR;
    const x = d3.scaleLinear([0, totalH], [0, plotW]);
    const binW = plotW / signals.bins;
    const binX = (i) => (i + 0.5) * binW;
    const eventStartBin = Math.floor((eventStart / totalH) * signals.bins);
    const alarms = channels.filter((c) => c.alarm_h !== null && c.alarm_h !== undefined);
    const firstAlarm = alarms.length ? d3.least(alarms, (c) => c.alarm_h) : null;

    sub.textContent = `${shortId(signals.id)} · ${signals.category} · ${channels.length} channel${channels.length === 1 ? "" : "s"}`;
    body.replaceChildren();
    const wrap = d3.select(body).append("div").attr("class", "c-wrap");

    // ---- shared time axis (stays put while the rows scroll) ----
    const axis = wrap
      .append("svg")
      .attr("class", "c-axis")
      .attr("width", width)
      .attr("height", AXIS_H)
      .attr("role", "img")
      .attr("aria-label", "Time axis in hours from the event start");
    const hours = (h) => signedHours(h - eventStart); // plot hours (from t0) -> "+2 h" from the event start
    const whenAlarm = (h) => (hours(h) === "0" ? "at the event start" : hours(h));
    const ag = axis.append("g").attr("transform", `translate(${LABEL_W},0)`);
    ag.append("rect").attr("x", x(eventStart)).attr("width", Math.max(1, x(eventEnd) - x(eventStart))).attr("y", 16).attr("height", AXIS_H - 16).attr("class", "event-band");
    // ticks are placed at round hours relative to the event start (0 = start)
    const relative = d3.scaleLinear([-eventStart, totalH - eventStart], [0, plotW]);
    ag.append("g")
      .attr("transform", `translate(0,${AXIS_H - 2})`)
      .call(d3.axisBottom(relative).ticks(Math.floor(plotW / 70)).tickFormat(signedHours).tickSize(-4))
      .call((g) => g.select(".domain").remove())
      .call((g) => g.selectAll("text").attr("class", "tick-label").attr("y", -8));
    axis.append("text").attr("class", "axis-unit").attr("x", 0).attr("y", 20).text("time from event start");
    axis.append("text").attr("class", "axis-unit").attr("x", 0).attr("y", 32).text("rows: ±σ vs pre-event");
    if (firstAlarm) {
      const fx = x(firstAlarm.alarm_h);
      ag.append("path").attr("d", `M${fx - 5},3 L${fx + 5},3 L${fx},10 Z`).attr("fill", COLORS.alarm);
      const label = ag
        .append("text")
        .attr("class", "alarm-label")
        .attr("y", 10)
        .text(`first alarm ${whenAlarm(firstAlarm.alarm_h)}`);
      // keep the label inside the plot: to the right of the marker unless that runs off the end
      const fitsRight = fx + 8 + label.node().getComputedTextLength() <= plotW;
      label.attr("x", fitsRight ? fx + 8 : fx - 8).attr("text-anchor", fitsRight ? "start" : "end");
    }
    const axisCursor = ag.append("line").attr("class", "cursor").attr("y1", 0).attr("y2", AXIS_H).attr("visibility", "hidden");

    // ---- the rows ----
    const scroller = wrap.append("div").attr("class", "c-rows").style("height", `${height - AXIS_H}px`);
    const svg = scroller
      .append("svg")
      .attr("width", width - SCROLLBAR)
      .attr("height", channels.length * ROW_H)
      .attr("role", "img")
      .attr("aria-label", `${channels.length} channels of ${shortId(signals.id)}, sorted by ${sort === "onset" ? "earliest alarm" : "biggest change"}`);
    const plot = svg.append("g").attr("transform", `translate(${LABEL_W},0)`);
    plot.append("rect").attr("class", "event-band").attr("x", x(eventStart)).attr("width", Math.max(1, x(eventEnd) - x(eventStart))).attr("height", channels.length * ROW_H);
    if (firstAlarm) {
      plot.append("line").attr("class", "first-alarm").attr("x1", x(firstAlarm.alarm_h)).attr("x2", x(firstAlarm.alarm_h)).attr("y2", channels.length * ROW_H);
    }

    const rows = svg
      .selectAll("g.c-row")
      .data(channels, (c) => c.name)
      .join("g")
      .attr("class", "c-row")
      .attr("transform", (_, i) => `translate(0,${i * ROW_H})`);
    rows.append("line").attr("class", "row-rule").attr("x2", width - SCROLLBAR).attr("y1", ROW_H - 0.5).attr("y2", ROW_H - 0.5);

    const scaledBy = new Map(); // channel -> its bins in σ (kept here, not written onto the cached data)
    rows.each(function (channel) {
      const row = d3.select(this);
      const scaled = channel.kind === "numeric" ? sigmaBins(channel) : null;
      scaledBy.set(channel, scaled);

      // label column: name, then subsystem and the row's key number
      row.append("text").attr("class", "c-name").attr("x", 0).attr("y", 13).text(channel.name);
      let detail = channel.subsystem.replace(/^subsystem_/, "sub ");
      if (channel.status !== "ok") detail += ` · ${channel.status.replaceAll("_", " ")}`;
      else if (channel.kind === "numeric") detail += ` · lvr ${short(channel.log_var_ratio)}`;
      else if (channel.kind === "categorical") detail += ` · shift ${short(channel.state_shift)}`;
      row.append("text").attr("class", "c-detail").attr("x", 0).attr("y", 26).text(detail);
      const range = scaled ? (scaled.scaled ? `±${scaled.limit}σ` : "raw") : channel.kind === "categorical" ? "states" : "";
      row.append("text").attr("class", "c-range").attr("x", LABEL_W - 8).attr("y", ROW_H / 2).attr("dy", "0.32em").attr("text-anchor", "end").text(range);

      const g = row.append("g").attr("transform", `translate(${LABEL_W},0)`);
      const top = 3;
      const bottom = ROW_H - 7;

      // where the annotators marked this channel (thin bar along the row's foot)
      g.selectAll("rect.labelled")
        .data(channel.labelled_h)
        .join("rect")
        .attr("class", "labelled")
        .attr("x", (d) => x(d[0]))
        .attr("width", (d) => Math.max(2, x(d[1]) - x(d[0])))
        .attr("y", ROW_H - 4)
        .attr("height", 2.5)
        .attr("fill", categoryColor(event ?? { isAnomaly: signals.category === "Anomaly" }));

      if (scaled) {
        const y = d3.scaleLinear([-scaled.limit, scaled.limit], [bottom, top]).clamp(true);
        g.append("line").attr("class", "zero").attr("x2", plotW).attr("y1", y(0)).attr("y2", y(0));
        const band = d3
          .area()
          .defined((_, i) => scaled.lows[i] !== null)
          .x((_, i) => binX(i))
          .y0((_, i) => y(scaled.lows[i]))
          .y1((_, i) => Math.min(y(scaled.lows[i]) - 1, y(scaled.highs[i]))); // at least 1 px, so flat stretches stay visible
        g.append("path").attr("d", band(scaled.lows)).attr("fill", INK).attr("fill-opacity", 0.85);
        if (scaled.clipped) {
          const over = scaled.highs.flatMap((v, i) => (v !== null && v > SIGMA_CAP ? [[i, top - 1]] : []));
          const under = scaled.lows.flatMap((v, i) => (v !== null && v < -SIGMA_CAP ? [[i, bottom + 1]] : []));
          g.selectAll("rect.clip")
            .data([...over, ...under])
            .join("rect")
            .attr("class", "clip")
            .attr("x", (d) => d[0] * binW)
            .attr("width", Math.max(1, binW))
            .attr("y", (d) => d[1] - 1)
            .attr("height", 2);
        }
      } else if (channel.kind === "categorical") {
        const usual = usualState(channel, eventStartBin);
        g.selectAll("rect.state")
          .data(channel.mode.map((m, i) => ({ m, i })).filter((d) => d.m >= 0))
          .join("rect")
          .attr("class", "state")
          .attr("x", (d) => d.i * binW)
          .attr("width", binW + 0.3)
          .attr("y", (d) => (d.m === usual ? top + 7 : top))
          .attr("height", (d) => (d.m === usual ? bottom - top - 14 : bottom - top))
          .attr("fill", (d) => (d.m === usual ? QUIET : INK));
      } else {
        g.append("text").attr("class", "c-detail").attr("x", 6).attr("y", ROW_H / 2).attr("dy", "0.32em").text("no telemetry in this window");
      }

      if (channel.alarm_h !== null && channel.alarm_h !== undefined) {
        const ax = x(channel.alarm_h);
        g.append("line").attr("class", "alarm-tick").attr("x1", ax).attr("x2", ax).attr("y1", top - 1).attr("y2", bottom + 1);
        g.append("path").attr("d", `M${ax - 4},${top - 2} L${ax + 4},${top - 2} L${ax},${top + 4} Z`).attr("fill", COLORS.alarm);
      }
    });

    // ---- crosshair and tooltip ----
    const cursor = plot.append("line").attr("class", "cursor").attr("y2", channels.length * ROW_H).attr("visibility", "hidden");
    svg
      .append("rect")
      .attr("x", LABEL_W)
      .attr("width", plotW)
      .attr("height", channels.length * ROW_H)
      .attr("fill", "transparent")
      .on("pointermove", (pointer) => {
        const [px, py] = d3.pointer(pointer, plot.node());
        const bin = Math.max(0, Math.min(signals.bins - 1, Math.floor(px / binW)));
        const channel = channels[Math.floor(py / ROW_H)];
        cursor.attr("x1", px).attr("x2", px).attr("visibility", "visible");
        axisCursor.attr("x1", px).attr("x2", px).attr("visibility", "visible");
        if (!channel) return hideTooltip();
        const at = hours(x.invert(px));
        const rows = [];
        const scaled = scaledBy.get(channel);
        if (scaled) {
          const lo = scaled.lows[bin];
          const hi = scaled.highs[bin];
          const unit = scaled.scaled ? "σ" : " (raw)";
          rows.push({ value: lo === null ? "no data" : `${short(lo)} to ${short(hi)}${unit}`, label: "in this bin" });
          rows.push({ value: lo === null ? "–" : `${short(channel.min[bin])} to ${short(channel.max[bin])}`, label: "raw value" });
        } else if (channel.kind === "categorical") {
          const m = channel.mode[bin];
          rows.push({ value: m >= 0 ? channel.states[m] : "no data", label: "most common state" });
        }
        if (channel.alarm_h !== null && channel.alarm_h !== undefined) {
          rows.push({ value: hours(channel.alarm_h), label: ALARM_TEXT[channel.alarm_kind] ?? channel.alarm_kind ?? "alarm", color: COLORS.alarm });
        }
        showTooltip(pointer.clientX, pointer.clientY, `${channel.name} · ${at}`, rows);
      })
      .on("pointerleave", () => {
        cursor.attr("visibility", "hidden");
        axisCursor.attr("visibility", "hidden");
        hideTooltip();
      });

    const node = scroller.node();
    node.scrollTop = scrollTop;
    node.addEventListener("scroll", () => (scrollTop = node.scrollTop), { passive: true });

    const usable = channels.filter((c) => c.status === "ok").length;
    const parts = [];
    if (firstAlarm) parts.push("First alarm ", [whenAlarm(firstAlarm.alarm_h), "b"], ` on ${firstAlarm.name} (${firstAlarm.alarm_kind})`);
    else parts.push(["No channel alarmed", "b"]);
    parts.push(` · ${alarms.length} of ${channels.length} channels alarm`);
    if (usable < channels.length) parts.push(` · ${channels.length - usable} without usable features (listed last)`);
    if (channels.length * ROW_H > height - AXIS_H) parts.push(" · scroll for more");
    setNotice(panel, parts);
  }

  return {
    update(state, changed) {
      if (!changed || changed.has("selected") || changed.has("mission")) {
        load(state.selected);
        return;
      }
      if (changed.has("sort")) {
        scrollTop = 0;
        draw();
      }
    },
    resize: () => draw(),
  };
}
