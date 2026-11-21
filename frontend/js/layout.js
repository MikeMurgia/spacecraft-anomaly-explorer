// Fits the 1920 px-wide console to the window. The scale comes from the window's width, and the
// design height follows the window's height, so a 1920x1080 screen shows the console exactly as
// designed and a 1920x960 browser window shrinks the panels slightly instead of adding side bars.

export const DESIGN_WIDTH = 1920;
const MIN_DESIGN_HEIGHT = 860; // shorter than this and the console scrolls instead of squashing

export function initLayout(onChange) {
  const root = document.documentElement;
  let pending = false;

  function apply() {
    pending = false;
    const scale = window.innerWidth / DESIGN_WIDTH;
    let height = window.innerHeight / scale;
    const tall = height < MIN_DESIGN_HEIGHT;
    if (tall) height = MIN_DESIGN_HEIGHT;
    root.style.setProperty("--s", scale.toFixed(5));
    root.style.setProperty("--H", height.toFixed(1));
    document.body.classList.toggle("tall", tall);
    onChange?.({ scale, height });
  }

  window.addEventListener("resize", () => {
    if (!pending) {
      pending = true;
      requestAnimationFrame(apply);
    }
  });
  apply();
}
