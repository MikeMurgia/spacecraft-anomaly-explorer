// The Earth below the ship: a three.js sphere wrapped in NASA's Blue Marble image, lit from one
// side so it has a day side and a night side, with a thin blue atmosphere glow at its edge. It
// sits low on the left of the window, turns slowly, and slides a little when you switch monitors
// (the same parallax as the stars). main.js loads this module only after the charts are drawn,
// so three.js (about 420 KB gzipped) never delays the console.
//
// If WebGL is unavailable or the texture is missing, initEarth() resolves to null and the 2D
// planet drawn by background.js stays in place, so the page always has a planet.

import * as THREE from "./vendor/three/three.module.js";

const TEXTURE = "textures/earth-blue-marble.jpg";
const FRAME_MS = 1000 / 30;
const TURN_SECONDS = 240; // one full rotation every four minutes
const PARALLAX_PX = 84; // the planet is closer than the stars, but the window frame hides most of the shift

function loadTexture(url) {
  return new Promise((resolve, reject) => new THREE.TextureLoader().load(url, resolve, undefined, reject));
}

/** A soft glow just outside the planet's edge: brightest where the surface is seen edge-on. */
function atmosphere(radius) {
  const material = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vNormal;
      void main() {
        float rim = pow(clamp(0.78 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 2.4);
        gl_FragColor = vec4(0.38, 0.68, 1.0, 1.0) * rim;
      }`,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius * 1.07, 96, 64), material);
}

export async function initEarth(canvas, { reducedMotion = false } = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  } catch (error) {
    console.info("Earth: WebGL unavailable, keeping the 2D planet.", error.message);
    return null;
  }

  let texture;
  try {
    texture = await loadTexture(TEXTURE);
  } catch {
    console.info(`Earth: ${TEXTURE} not found, keeping the 2D planet.`);
    renderer.dispose();
    return null;
  }
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  // an orthographic camera measured in CSS pixels, so the planet can be placed like the 2D one
  const camera = new THREE.OrthographicCamera(0, 1, 0, -1, 1, 8000);
  camera.position.z = 4000;

  // tilt: lean the north pole away from us so the visible top of the sphere shows mid-latitudes,
  // then add Earth's 23.4° axial tilt; the inner mesh spins about its own axis
  const tilt = new THREE.Group();
  const spin = new THREE.Mesh(
    new THREE.SphereGeometry(1, 128, 96),
    new THREE.MeshPhongMaterial({ map: texture, specular: new THREE.Color(0x223344), shininess: 14 }),
  );
  tilt.add(spin);
  tilt.rotation.set(0.95, 0, THREE.MathUtils.degToRad(23.4));
  const glow = atmosphere(1);
  const planet = new THREE.Group();
  planet.add(glow, tilt);
  scene.add(planet);

  // sunlight from the upper right, in front of the planet; a little ambient light keeps the night side from going fully black
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(1, 0.7, 0.9);
  scene.add(sun, new THREE.AmbientLight(0x6f86b0, 0.12));

  let width = 0;
  let height = 0;
  let offset = 0;
  let target = 0;
  let lastFrame = 0;
  let last = 0;
  let rafId = 0;
  let running = false;

  function layout() {
    const box = canvas.getBoundingClientRect();
    width = box.width;
    height = box.height;
    renderer.setSize(width, height, false);
    camera.right = width;
    camera.bottom = -height;
    camera.updateProjectionMatrix();
  }

  function place() {
    // same spot as the 2D placeholder: centre far below the bottom-left corner, so only its upper limb shows
    const radius = height * 0.85;
    planet.scale.setScalar(radius);
    planet.position.set(width * 0.12 - offset, -height * 1.55, 0);
  }

  function frame(now) {
    const dt = last ? Math.min(now - last, 100) : 0;
    last = now;
    offset += (target - offset) * Math.min(1, dt / 220);
    if (!reducedMotion) spin.rotation.y += (dt / 1000) * ((Math.PI * 2) / TURN_SECONDS);
    place();
    renderer.render(scene, camera);
  }

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    if (now - lastFrame < FRAME_MS) return;
    lastFrame = now;
    frame(now);
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

  /** Draw once (reduced motion, or a change while paused). */
  function still() {
    offset = target;
    last = 0;
    frame(performance.now());
  }

  new ResizeObserver(() => {
    layout();
    if (!running) still();
  }).observe(canvas);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault(); // let the browser restore the context; three.js rebuilds its state when it does
    stop();
  });
  canvas.addEventListener("webglcontextrestored", () => (reducedMotion ? still() : start()));

  layout();
  spin.rotation.y = -1.2; // start with the Atlantic and Africa in view
  still();
  start();

  return {
    setMonitor(monitor) {
      target = monitor === 2 ? PARALLAX_PX : 0;
      if (!running) still();
    },
  };
}
