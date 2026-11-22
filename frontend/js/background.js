// The space outside the cockpit window, drawn on one <canvas> behind the console: a fixed
// starfield with a faint Milky Way band, gentle twinkling, an occasional shooting star, a slow
// comet and the limb of a planet low in the frame. The star positions come from a seeded random
// generator, so the sky looks the same on every visit. Switching monitors shifts the sky a little
// (parallax), which sells the idea of turning your head inside the ship.
// Animation runs at about 30 fps, stops while the tab is hidden, and is replaced by a single
// still frame when the visitor asks the operating system for reduced motion.

const FRAME_MS = 1000 / 30;
const PARALLAX_PX = 140; // how far the sky slides (in CSS px) when you switch monitors

/** Small deterministic PRNG (mulberry32), so the starfield is the same every load. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeStars(rand, count) {
  const stars = [];
  for (let i = 0; i < count; i += 1) {
    // a third of the stars crowd into a diagonal band: the Milky Way
    const inBand = rand() < 0.35;
    let x = rand();
    let y = rand();
    if (inBand) {
      x = rand();
      y = 0.15 + x * 0.55 + (rand() - 0.5) * 0.16;
    }
    const big = rand() < 0.04;
    stars.push({
      x,
      y,
      r: big ? 1.1 + rand() * 0.9 : 0.35 + rand() * 0.75,
      base: 0.35 + rand() * 0.6,
      speed: 0.4 + rand() * 1.6, // twinkle rate
      phase: rand() * Math.PI * 2,
      tint: rand() < 0.15 ? "255,214,170" : rand() < 0.3 ? "180,210,255" : "235,242,255",
    });
  }
  return stars;
}

export function initBackground(canvas, { reducedMotion = false } = {}) {
  const ctx = canvas.getContext("2d");
  const rand = seeded(20261117);
  const stars = makeStars(rand, 900);
  const shooting = [];
  let width = 0;
  let height = 0;
  let dpr = 1;
  let offset = 0; // current parallax offset in CSS px
  let target = 0;
  let last = 0;
  let nextShot = 4000;
  let running = false;
  let rafId = 0;
  let planetVisible = true;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const box = canvas.getBoundingClientRect();
    width = box.width;
    height = box.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!running) draw(performance.now());
  }

  function drawNebula() {
    const glow = ctx.createLinearGradient(0, height * 0.1, width, height * 0.8);
    glow.addColorStop(0, "rgba(40, 60, 120, 0)");
    glow.addColorStop(0.45, "rgba(70, 90, 160, 0.10)");
    glow.addColorStop(0.55, "rgba(120, 90, 170, 0.08)");
    glow.addColorStop(1, "rgba(40, 60, 120, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
  }

  function drawPlanet() {
    // the curve of a planet low on the left: shown until the three.js Earth (earth.js) is ready,
    // and kept if WebGL or the Earth texture is unavailable
    const cx = width * 0.12 - offset * 0.6;
    const cy = height * 1.55;
    const r = height * 0.85;
    const body = ctx.createRadialGradient(cx + r * 0.3, cy - r * 0.6, r * 0.1, cx, cy, r);
    body.addColorStop(0, "#1f5e93");
    body.addColorStop(0.7, "#0b2c4d");
    body.addColorStop(1, "#04101f");
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    const haze = ctx.createRadialGradient(cx, cy, r * 0.98, cx, cy, r * 1.06);
    haze.addColorStop(0, "rgba(120, 200, 255, 0.55)");
    haze.addColorStop(1, "rgba(120, 200, 255, 0)");
    ctx.fillStyle = haze;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.06, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawComet(now) {
    // crosses the top of the sky once every 90 s
    const t = (now / 90000) % 1;
    const x = width * (1.1 - t * 1.3) - offset * 0.3;
    const y = height * (0.08 + t * 0.12);
    const tail = ctx.createLinearGradient(x, y, x + 180, y - 24);
    tail.addColorStop(0, "rgba(190, 235, 255, 0.55)");
    tail.addColorStop(1, "rgba(190, 235, 255, 0)");
    ctx.strokeStyle = tail;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 180, y - 24);
    ctx.stroke();
    ctx.fillStyle = "rgba(230, 248, 255, 0.95)";
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawShootingStars(dt) {
    for (let i = shooting.length - 1; i >= 0; i -= 1) {
      const s = shooting[i];
      s.life += dt;
      const p = s.life / s.duration;
      if (p >= 1) {
        shooting.splice(i, 1);
        continue;
      }
      const x = s.x + s.vx * p;
      const y = s.y + s.vy * p;
      const fade = Math.sin(p * Math.PI);
      const trail = ctx.createLinearGradient(x, y, x - s.vx * 0.18, y - s.vy * 0.18);
      trail.addColorStop(0, `rgba(255, 255, 255, ${0.9 * fade})`);
      trail.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.strokeStyle = trail;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - s.vx * 0.18, y - s.vy * 0.18);
      ctx.stroke();
    }
  }

  function draw(now) {
    const dt = last ? Math.min(now - last, 100) : 0;
    last = now;
    offset += (target - offset) * Math.min(1, dt / 220);
    ctx.fillStyle = "#02040a";
    ctx.fillRect(0, 0, width, height);
    drawNebula();
    const twinkle = !reducedMotion;
    for (const star of stars) {
      const x = ((star.x * (width + PARALLAX_PX) - offset * 0.5) % (width + PARALLAX_PX) + width + PARALLAX_PX) % (width + PARALLAX_PX);
      const y = star.y * height;
      const alpha = twinkle ? star.base * (0.75 + 0.25 * Math.sin(now / 1000 * star.speed + star.phase)) : star.base;
      ctx.fillStyle = `rgba(${star.tint}, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!reducedMotion) {
      drawComet(now);
      nextShot -= dt;
      if (nextShot <= 0) {
        shooting.push({
          x: width * (0.2 + rand() * 0.7),
          y: height * (0.05 + rand() * 0.35),
          vx: -(220 + rand() * 260),
          vy: 90 + rand() * 120,
          life: 0,
          duration: 700 + rand() * 500,
        });
        nextShot = 5000 + rand() * 9000;
      }
      drawShootingStars(dt);
    }
    if (planetVisible) drawPlanet();
  }

  let lastFrame = 0;
  function loop(now) {
    rafId = requestAnimationFrame(loop);
    if (now - lastFrame < FRAME_MS) return;
    lastFrame = now;
    draw(now);
  }

  function start() {
    if (running || reducedMotion) return;
    running = true;
    last = 0;
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
  }

  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  new ResizeObserver(resize).observe(canvas);
  resize();
  start();

  return {
    /** Hide the 2D planet once the 3D Earth has taken its place. */
    setPlanetVisible(visible) {
      planetVisible = visible;
      if (!running) draw(performance.now());
    },
    /** Slide the sky for monitor 1 or 2. */
    setMonitor(monitor) {
      target = monitor === 2 ? PARALLAX_PX : 0;
      if (!running) {
        offset = target;
        draw(performance.now());
      }
    },
  };
}
