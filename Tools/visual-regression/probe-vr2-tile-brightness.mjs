// NEW-VR2-7 reproduction probe — per-tile brightness anomaly.
// @purpose Repro: per-tile imagery brightness anomaly at 5 Mm over Lake Superior — max adjacent-block luminance jump WebGPU vs WebGL; PROBE_DARK lane.
// @status ACTIVE
//
// Symptom (doc): at ~5 Mm camera altitude over Lake Superior, WebGPU shows
// one rectangular imagery tile distinctly brighter than its neighbors with a
// sharp visible boundary; persists after tiles finish loading. WebGL renders
// uniform brightness across all tiles. Suspects: per-tile material-uniform
// staleness, parent-fallback imagery, per-tile fog/drape leak.
//
// Method: globe + lighting, camera nadir over Lake Superior at 5 Mm, render
// to settle, screenshot both backends. Quantify by splitting the globe region
// into a block grid and measuring the largest brightness JUMP between
// adjacent blocks (a sharp tile-boundary discontinuity). The anomaly = WebGPU
// has a much larger max adjacent-block jump than WebGL.
//
// Output: Tools/visual-regression/output/vr2tile-{webgl,webgpu}.png + stats.
// Run with PROBE_DARK=1 to also disable globe lighting (suspect-test #2:
// if the jump persists unlit → imagery-state; if it vanishes → lighting).

import { chromium } from "playwright";
import fs from "fs";

const PROBE_BASE = process.env.PROBE_BASE || "http://localhost:8080";
const DARK = process.env.PROBE_DARK === "1";
const OUT_DIR = "Tools/visual-regression/output";
const SUFFIX = DARK ? "-dark" : "";

async function run(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on("pageerror", (e) =>
    console.log(`>> [${renderer}] pageerror: ${e.message}`),
  );
  await page.goto(
    `${PROBE_BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
    {
      waitUntil: "networkidle",
    },
  );
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(() => {
    window.__probeErrors = [];
    const dev = window.viewer?.scene?.context?._device;
    if (dev)
      dev.onuncapturederror = (ev) =>
        window.__probeErrors.push(ev?.error?.message ?? "");
  });

  const setup = await page.evaluate(async (dark) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.useDefaultRenderLoop = false;
    const scene = v.scene;
    scene.skyBox.show = false;
    scene.skyAtmosphere.show = false;
    scene.globe.showGroundAtmosphere = false;
    scene.globe.enableLighting = !dark;
    scene.fog.enabled = false;
    v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T18:00:00Z");
    v.clock.shouldAnimate = false;
    // Nadir over Lake Superior (~47.7N, 87.5W) at 5 Mm.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-87.5, 47.7, 5_000_000),
      orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
    });
    // Render until tile queues drain (the anomaly persists post-load, so we
    // want fully-settled tiles to rule out streaming artifacts).
    let settledFrames = 0;
    for (let i = 0; i < 900; i++) {
      scene.requestRender();
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      const q = scene.globe._surface?._tileLoadQueueHigh?.length ?? 0;
      const m = scene.globe._surface?._tileLoadQueueMedium?.length ?? 0;
      const l = scene.globe._surface?._tileLoadQueueLow?.length ?? 0;
      if (q + m + l === 0) settledFrames++;
      else settledFrames = 0;
      if (settledFrames > 60) break; // 60 consecutive empty-queue frames
    }
    return { ok: true, dark };
  }, DARK);

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  const out = `${OUT_DIR}/vr2tile-${renderer}${SUFFIX}.png`;
  await page.screenshot({ path: out });

  // Block-grid brightness analysis over the globe region (center area, away
  // from UI). Find the largest mean-luminance jump between adjacent blocks.
  const stats = await page.evaluate(
    async (durl) => {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const cx = c.getContext("2d");
          cx.drawImage(img, 0, 0);
          const data = cx.getImageData(0, 0, c.width, c.height).data;
          // Restrict to the globe disk region (avoid UI top-right + dark space).
          const x0 = 40,
            x1 = c.width - 260,
            y0 = 80,
            y1 = c.height - 60;
          const BS = 24; // block size px
          const cols = Math.floor((x1 - x0) / BS);
          const rows = Math.floor((y1 - y0) / BS);
          const lum = []; // [row][col] mean luminance, or null if mostly space
          for (let r = 0; r < rows; r++) {
            lum[r] = [];
            for (let col = 0; col < cols; col++) {
              let s = 0,
                n = 0;
              for (let yy = 0; yy < BS; yy += 3) {
                for (let xx = 0; xx < BS; xx += 3) {
                  const px = x0 + col * BS + xx;
                  const py = y0 + r * BS + yy;
                  const i = (py * c.width + px) * 4;
                  const L =
                    0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                  s += L;
                  n++;
                }
              }
              const m = s / n;
              lum[r][col] = m > 12 ? m : null; // skip near-black space blocks
            }
          }
          // Largest jump between horizontally/vertically adjacent globe blocks.
          let maxJump = 0,
            jx = -1,
            jy = -1;
          for (let r = 0; r < rows; r++) {
            for (let col = 0; col < cols; col++) {
              const a = lum[r][col];
              if (a == null) continue;
              const right = col + 1 < cols ? lum[r][col + 1] : null;
              const down = r + 1 < rows ? lum[r + 1][col] : null;
              for (const b of [right, down]) {
                if (b == null) continue;
                const d = Math.abs(a - b);
                if (d > maxJump) {
                  maxJump = d;
                  jx = x0 + col * BS;
                  jy = y0 + r * BS;
                }
              }
            }
          }
          resolve({ rows, cols, maxJump: Math.round(maxJump), jx, jy });
        };
        img.src = durl;
      });
    },
    `data:image/png;base64,${(await fs.promises.readFile(out)).toString("base64")}`,
  );

  await browser.close();
  return { setup, errs, stats, out };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const wgl = await run("webgl");
  const wgpu = await run("webgpu");
  console.log(
    `=== NEW-VR2-7 per-tile brightness reproduction${DARK ? " (lighting OFF)" : ""} ===\n`,
  );
  for (const [name, r] of [
    ["webgl", wgl],
    ["webgpu", wgpu],
  ]) {
    console.log(
      `  ${name}: maxAdjacentBlockJump=${r.stats.maxJump} (at ${r.stats.jx},${r.stats.jy}) grid=${r.stats.rows}x${r.stats.cols} errs=${r.errs.length}`,
    );
    console.log(`    png: ${r.out}`);
  }
  const ratio =
    wgl.stats.maxJump > 0
      ? (wgpu.stats.maxJump / wgl.stats.maxJump).toFixed(2)
      : "inf";
  console.log(
    `\n  WebGPU/WebGL max-jump ratio: ${ratio}  (anomaly if WebGPU jump >> WebGL)`,
  );
})();
