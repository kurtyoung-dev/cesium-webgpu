// Campaign 8 performance BASELINE harness: load-time + steady-state FPS for WebGL vs
// WebGPU on the default globe. Read-only (loads the running :8080 server). Bounded.
import { chromium } from "playwright";

const BASE = "http://localhost:8080/Apps/CesiumViewer/index.html";
const FPS_WINDOW_MS = 6000,
  SETTLE_MS = 3000,
  HARD_TIMEOUT_MS = 45000;

async function measure(browser, renderer) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  const t0 = Date.now();
  await page.goto(`${BASE}?renderer=${renderer}`, {
    waitUntil: "load",
    timeout: 30000,
  });
  const timings = await page.evaluate(
    async ({ hardTimeout }) => {
      const start = performance.now();
      const v = () => window.viewer;
      const waitFor = (pred, ms) =>
        new Promise((resolve) => {
          const s = performance.now();
          const tick = () => {
            let ok;
            try {
              ok = pred();
            } catch {
              ok = false;
            }
            if (ok) return resolve(true);
            if (performance.now() - s > ms) return resolve(false);
            requestAnimationFrame(tick);
          };
          tick();
        });
      await waitFor(() => v() && v().scene && v().scene.canvas, hardTimeout);
      let firstFrame = -1;
      if (v() && v().scene) {
        await new Promise((resolve) => {
          const rm = v().scene.postRender.addEventListener(() => {
            firstFrame = performance.now() - start;
            rm();
            resolve();
          });
          setTimeout(resolve, hardTimeout);
        });
      }
      const tilesOk = await waitFor(
        () =>
          v() &&
          v().scene &&
          v().scene.globe &&
          v().scene.globe.tilesLoaded === true,
        hardTimeout,
      );
      return {
        firstFrameMs: firstFrame,
        tilesLoadedMs: tilesOk ? performance.now() - start : -1,
        backend:
          (v() &&
            v().scene &&
            v().scene.context &&
            (v().scene.context.isWebGPU ? "webgpu" : "webgl")) ||
          "?",
      };
    },
    { hardTimeout: HARD_TIMEOUT_MS },
  );
  await page.evaluate(
    (settle) => new Promise((r) => setTimeout(r, settle)),
    SETTLE_MS,
  );
  const fps = await page.evaluate(
    async ({ windowMs }) => {
      const v = window.viewer;
      if (!v || !v.scene) return { frames: 0, ms: windowMs, fps: 0 };
      v.scene.requestRenderMode = false;
      let frames = 0;
      const spin = v.scene.postRender.addEventListener(() => {
        frames++;
        try {
          v.camera.rotateRight(0.002);
        } catch {
          /**/
        }
      });
      const start = performance.now();
      await new Promise((res) => setTimeout(res, windowMs));
      const elapsed = performance.now() - start;
      spin();
      return { frames, ms: elapsed, fps: (frames * 1000) / elapsed };
    },
    { windowMs: FPS_WINDOW_MS },
  );
  await page.close();
  return {
    renderer,
    ...timings,
    ...fps,
    totalProbeMs: Date.now() - t0,
    errors: errors.slice(0, 3),
  };
}

let browser;
const results = {};
try {
  browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  results.webgl = await measure(browser, "webgl");
  results.webgpu = await measure(browser, "webgpu");
} finally {
  if (browser) await browser.close();
}

const g = results.webgl,
  w = results.webgpu,
  fmt = (n) => (typeof n === "number" ? n.toFixed(1) : String(n));
console.log("\n=== PERF BASELINE (default globe) ===");
for (const [k, r] of [
  ["WebGL", g],
  ["WebGPU", w],
]) {
  console.log(
    `\n${k} (ctx=${r.backend}):  firstFrame=${fmt(r.firstFrameMs)}ms  tilesLoaded=${fmt(r.tilesLoadedMs)}ms  FPS=${fmt(r.fps)} (${r.frames}f/${fmt(r.ms)}ms)  frameTime=${fmt(1000 / r.fps)}ms`,
  );
  if (r.errors.length) console.log(`  errors: ${JSON.stringify(r.errors)}`);
}
if (g.fps > 0 && w.fps > 0) {
  console.log(
    `\nRATIO WebGPU/WebGL FPS: ${fmt(w.fps / g.fps)}x  (${fmt((w.fps / g.fps - 1) * 100)}%; target >=+100%)`,
  );
  console.log(
    `Load delta: WebGPU ${fmt(w.tilesLoadedMs - g.tilesLoadedMs)}ms slower to tilesLoaded`,
  );
}
