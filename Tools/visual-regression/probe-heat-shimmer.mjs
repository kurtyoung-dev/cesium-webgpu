#!/usr/bin/env node
/**
 * Atmospheric Effects Phase B — HEAT SHIMMER (Batch 417b). WebGPU-only visual probe.
 *
 * The shimmer is a WebGPU screen-space effect with no WebGL twin, so the diff is
 * SHIMMER-ON vs SHIMMER-OFF on the SAME WebGPU canvas (not WebGL-vs-WebGPU). A
 * low oblique view over terrain puts textured GROUND in the lower frame and SKY
 * in the upper frame; the warp is band-concentrated to the lower frame.
 *
 * Proof criteria:
 *   - lower-third (ground) mismatch ON-vs-OFF must be materially > upper-third
 *     (sky) mismatch — the warp is near the ground, the sky is ~untouched;
 *   - ON frame-1 vs frame-2 (~350 ms apart) must differ in the lower band — the
 *     warp is animated, not a static distortion;
 *   - OFF vs OFF (two frames) must be ~0 — no spurious diff.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-heat-shimmer.mjs
 */
import { chromium } from "playwright";
import { errorGateInit, armWebGPUDevices } from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;
const OUT = "Tools/visual-regression/output";

// Region pixel-diff via canvas decode (no Node PNG dep). yLo..yHi are fractions.
function regionDiff(page, duA, duB, yLo, yHi) {
  return page.evaluate(
    async ([a, b, lo, hi]) => {
      const dec = async (du) => {
        const img = new Image();
        img.src = du;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return c.getContext("2d").getImageData(0, 0, c.width, c.height);
      };
      const A = await dec(a);
      const B = await dec(b);
      const W = A.width,
        H = A.height;
      const y0 = Math.floor(H * lo),
        y1 = Math.floor(H * hi);
      let diff = 0,
        n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const dr = Math.abs(A.data[i] - B.data[i]);
          const dg = Math.abs(A.data[i + 1] - B.data[i + 1]);
          const db = Math.abs(A.data[i + 2] - B.data[i + 2]);
          if (dr + dg + db > 24) {
            diff++;
          }
          n++;
        }
      }
      return +((100 * diff) / n).toFixed(2);
    },
    [duA, duB, yLo, yHi],
  );
}

async function shot(page, fs, name) {
  const canvas = await page.$(".cesium-widget canvas");
  await canvas.screenshot({ path: `${OUT}/${name}.png` });
  return (
    "data:image/png;base64," +
    fs.readFileSync(`${OUT}/${name}.png`).toString("base64")
  );
}

async function run() {
  const fs = await import("fs");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 720 },
  });
  await page.addInitScript(errorGateInit);
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !!(window.viewer && window.viewer.scene),
    null,
    {
      timeout: 60000,
    },
  );
  await armWebGPUDevices(page);

  // Low oblique view over the central US: textured ground low, sky high.
  await page.evaluate(async () => {
    const C = (window.Cesium =
      window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
    const v = window.viewer;
    v.scene.requestRenderMode = false; // let the animated warp advance
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-95.0, 39.0, 2500.0),
      orientation: {
        heading: C.Math.toRadians(90.0),
        pitch: C.Math.toRadians(8.0),
        roll: 0.0,
      },
    });
    v.scene.heatShimmerEnabled = false;
  });
  // Wait for terrain/imagery tiles to FULLY load before any capture, so OFF and
  // ON share identical terrain and the only difference is the shimmer warp (not
  // tiles streaming in between captures).
  const waitTiles = async () => {
    await page
      .waitForFunction(
        () => window.viewer.scene.globe.tilesLoaded === true,
        null,
        {
          timeout: 20000,
        },
      )
      .catch(() => {});
    await page.waitForTimeout(1200);
  };
  await waitTiles();
  const off1 = await shot(page, fs, "heat-shimmer-off");
  await page.waitForTimeout(350);
  const off2 = await shot(page, fs, "heat-shimmer-off2");

  // Turn shimmer ON, strong. (Tiles already loaded → diff is the warp only.)
  await page.evaluate(() => {
    window.viewer.scene.heatShimmerEnabled = true;
    window.viewer.scene.heatShimmerIntensity = 1.0;
  });
  await page.waitForTimeout(2500);
  const on1 = await shot(page, fs, "heat-shimmer-on");
  await page.waitForTimeout(350);
  const on2 = await shot(page, fs, "heat-shimmer-on2");

  const lowerOnOff = await regionDiff(page, off1, on1, 0.66, 1.0);
  const upperOnOff = await regionDiff(page, off1, on1, 0.0, 0.33);
  const lowerAnim = await regionDiff(page, on1, on2, 0.66, 1.0);
  const offStable = await regionDiff(page, off1, off2, 0.66, 1.0);

  console.log(
    JSON.stringify({ lowerOnOff, upperOnOff, lowerAnim, offStable }, null, 1),
  );

  const checks = [
    [
      `OFF is stable across frames (offStable ${offStable} < 1)`,
      offStable < 1.0,
    ],
    [
      `shimmer warps the lower (ground) frame (lowerOnOff ${lowerOnOff} > 2)`,
      lowerOnOff > 2.0,
    ],
    [
      `warp is concentrated low, not sky (lower ${lowerOnOff} > upper ${upperOnOff}*2)`,
      lowerOnOff > upperOnOff * 2.0,
    ],
    [`warp is ANIMATED (on1 vs on2 lower ${lowerAnim} > 1)`, lowerAnim > 1.0],
  ];
  console.log("\n=== ANALYSIS ===");
  let pass = true;
  for (const [n, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
    if (!ok) {
      pass = false;
    }
  }
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
run();
