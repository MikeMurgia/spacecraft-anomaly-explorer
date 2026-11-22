// Fits the 1920 px-wide console to the window (or, below 1100 px wide, switches to a stacked layout). The scale comes from the window's width, and the
// design height follows the window's height, so a 1920x1080 screen shows the console exactly as
// designed and a 1920x960 browser window shrinks the panels slightly instead of adding side bars.

export const DESIGN_WIDTH = 1920;
const MIN_DESIGN_HEIGHT = 860; // shorter than this and the console scrolls instead of squashing
const STACK_BELOW = 1100; // narrower windows (tablets, phones) get one scrolling column of panels instead

export function initLayout(onChange) {
  const root = document.documentElement;
  let pending = false;

  function apply() {
    pending = false;
    const stacked = window.innerWidth < STACK_BELOW;
    if (stacked !== document.body.classList.contains("stacked")) {
      document.body.classList.toggle("stacked", stacked);
      window.dispatchEvent(new Event("sae:layout"));
    }
    if (stacked) {
      // the stacked layout is plain responsive CSS: no scaling, the page scrolls
      root.style.setProperty("--s", "1");
      root.style.removeProperty("--H");
      document.body.classList.remove("tall");
      onChange?.({ scale: 1, height: null, stacked });
      return;
    }
    const scale = window.innerWidth / DESIGN_WIDTH;
    let height = window.innerHeight / scale;
    const tall = height < MIN_DESIGN_HEIGHT;
    if (tall) height = MIN_DESIGN_HEIGHT;
    root.style.setProperty("--s", scale.toFixed(5));
    root.style.setProperty("--H", height.toFixed(1));
    document.body.classList.toggle("tall", tall);
    onChange?.({ scale, height, stacked });
  }

  window.addEventListener("resize", () => {
    if (!pending) {
      pending = true;
      requestAnimationFrame(apply);
    }
  });
  apply();
}
