// Helpers shared by every chart: colours from the stylesheet, a sized <svg> inside a panel,
// an empty-state message, and one tooltip for the whole page.

const css = getComputedStyle(document.documentElement);
const token = (name) => css.getPropertyValue(name).trim();

/** Mark colours (validated: colour-blind separation and contrast on the panel surface). */
export const COLORS = {
  anomaly: token("--anomaly"),
  rare: token("--rare"),
  inactive: "#2b3b57",
  selected: token("--cyan"),
  alarm: token("--alarm"),
  grid: token("--grid"),
  axis: token("--axis"),
  surface: "#07101f", // panel surface seen through the glass, used for the 2 px rings between marks
};

export const categoryColor = (event) => (event.isAnomaly ? COLORS.anomaly : COLORS.rare);

const builtSize = new WeakMap();

/** The panel's chart area, its size in design pixels (clientWidth ignores the console's scale transform). */
export function chartArea(panel) {
  const body = panel.querySelector("[data-chart]");
  const area = { body, width: body.clientWidth, height: body.clientHeight };
  builtSize.set(body, area);
  return area;
}

/** True if a chart area is now a different size from when its chart was last drawn. */
export function sizeChanged(body) {
  const built = builtSize.get(body);
  return !built || Math.abs(built.width - body.clientWidth) > 0.5 || Math.abs(built.height - body.clientHeight) > 0.5;
}

/** Replace the chart area's contents with a fresh <svg> of the given size. */
export function freshSvg(body, width, height, label) {
  body.replaceChildren();
  return d3
    .select(body)
    .append("svg")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("role", "img")
    .attr("aria-label", label);
}

/** A centred message in place of a chart (no data, nothing selected, ...). */
export function showEmpty(body, message) {
  const box = document.createElement("div");
  box.className = "empty";
  box.textContent = message;
  body.replaceChildren(box);
}

/** Write a panel's footnote; parts may be strings or [text, "b"] for bold. Uses textContent only. */
export function setNotice(panel, parts) {
  const notice = panel.querySelector("[data-notice]");
  notice.replaceChildren(
    ...parts.map((part) => {
      if (typeof part === "string") return document.createTextNode(part);
      const element = document.createElement(part[1]);
      element.textContent = part[0];
      return element;
    }),
  );
}

// ---- one tooltip for the page ----
const tip = document.getElementById("tooltip");

/**
 * Show the tooltip near the pointer. rows: [{ value, label, color? }] -- value first and strong,
 * label after it; a colour adds a short line key. Built with textContent, never innerHTML.
 */
export function showTooltip(clientX, clientY, title, rows = []) {
  const head = document.createElement("div");
  head.className = "tip-title";
  head.textContent = title;
  const lines = rows.map(({ value, label, color }) => {
    const row = document.createElement("div");
    row.className = "tip-row";
    if (color) {
      const key = document.createElement("i");
      key.style.background = color;
      row.append(key);
    }
    const strong = document.createElement("b");
    strong.textContent = value;
    row.append(strong, document.createTextNode(` ${label}`));
    return row;
  });
  tip.replaceChildren(head, ...lines);
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  const x = clientX + 14 + box.width > window.innerWidth ? clientX - box.width - 14 : clientX + 14;
  const y = Math.min(clientY + 14, window.innerHeight - box.height - 6);
  tip.style.left = `${Math.max(6, x)}px`;
  tip.style.top = `${Math.max(6, y)}px`;
}

export function hideTooltip() {
  tip.hidden = true;
}

/** Tooltip for an element that has keyboard focus (positioned at its bottom-right corner). */
export function showTooltipAt(element, title, rows) {
  const box = element.getBoundingClientRect();
  showTooltip(box.right, box.bottom, title, rows);
}

/** Short numeric label: 3 significant digits, no trailing zeros; thousands written out ("1,000", not "1e+3"). */
export function short(value) {
  if (value === null || value === undefined) return "n/a";
  return Math.abs(value) >= 1000 ? d3.format(",.0f")(value) : d3.format(".3~g")(value);
}

/** Tick values for a log axis: the powers of ten, plus 3s when the range is under two decades. */
export function logTicks(scale) {
  const all = scale.ticks();
  const mantissa = (v) => Math.round(v / 10 ** Math.floor(Math.log10(v) + 1e-9));
  const tens = all.filter((v) => mantissa(v) === 1);
  return tens.length >= 3 ? tens : all.filter((v) => [1, 3].includes(mantissa(v)));
}
