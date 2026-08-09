#!/usr/bin/env node
// Probe: GLOBE-CLIPPOLY-GEODETIC — globe clipping polygons, WebGL vs WebGPU.
//
// A clipping polygon at mid-latitude (~45°N) cuts a hole in the globe
// (solid baseColor, no imagery, black background). Verifies:
//   (1) The hole exists on BOTH backends (center of the polygon is
//       background-black).
//   (2) The clip boundary aligns between backends (pixel diff within
//       tolerance). Before the fix the WebGPU globe never activated the
//       polygon path at all (no hole), and its SDF lookup used exact
//       geocentric atan2 against a whole-globe equirect mapping instead of
//       the fastApproximateAtan2 + merged-extent atlas convention the SDF
//       is authored in (≤ ~0.19° boundary offset had it activated).
//
// Usage: node Tools/visual-regression/probe-globe-clippoly-geodetic.mjs
// Requires dev server on :8080.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const SETUP = `
  const Cesium = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  scene.skyBox.show = false;
  scene.skyAtmosphere.show = false;
  scene.sun.show = false;
  scene.moon.show = false;
  scene.backgroundColor = Cesium.Color.BLACK.clone();
  scene.globe.showGroundAtmosphere = false;
  scene.globe.enableLighting = false;

  // Solid-color globe — geometry-only comparison, no imagery network noise.
  viewer.imageryLayers.removeAll();
  scene.globe.baseColor = Cesium.Color.SANDYBROWN.clone();

  // Hexagonal clipping polygon centered at (-105, 45), ~2° radius —
  // mid-latitude, where a geocentric-vs-spherical latitude convention
  // mismatch is at its worst (~0.19° on WGS84).
  const centerLon = -105.0;
  const centerLat = 45.0;
  const degs = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * 2.0 * Math.PI;
    degs.push(centerLon + 2.4 * Math.cos(a), centerLat + 1.7 * Math.sin(a));
  }
  scene.globe.clippingPolygons = new Cesium.ClippingPolygonCollection({
    polygons: [
      new Cesium.ClippingPolygon({
        positions: Cesium.Cartesian3.fromDegreesArray(degs),
      }),
    ],
  });

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(centerLon, centerLat, 1000000.0),
    orientation: {
      heading: 0.0,
      pitch: Cesium.Math.toRadians(-90.0),
      roll: 0.0,
    },
  });

  // Hide ALL UI chrome (renderer toggle, nav help, timeline, credits, ion
  // token banner) — the diff must only see the scene canvas.
  const container = viewer.container;
  for (const el of document.body.children) {
    if (el !== container && !container.contains(el)) {
      el.style.display = "none";
    }
  }
  const canvas = scene.canvas;
  const hideNonCanvas = (root) => {
    for (const el of root.children) {
      if (el === canvas || el.contains(canvas)) {
        hideNonCanvas(el);
      } else {
        el.style.display = "none";
      }
    }
  };
  hideNonCanvas(container);
`;

async function run(rendererArg) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 800, height: 600 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(async (setup) => {
    // eslint-disable-next-line no-new-func
    const fn = new Function("return (async () => {" + setup + "})();");
    await fn();
  }, SETUP);

  // Settle — let terrain tiles refine to the target LOD.
  await page.evaluate(async () => {
    const v = window.viewer;
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(500);

  const out = path.join(OUT_DIR, `probe-globe-clippoly-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  return { out, errs };
}

// Decode both PNGs in a browser canvas, compute (a) whole-image mismatch %,
// (b) per-image "hole present" check — fraction of near-black pixels in a
// 120x120 box at canvas center (inside the polygon → background shows).
async function analyze(a, b) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const result = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: img.naturalWidth,
          h: img.naturalHeight,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const A = await decode(ba);
      const B = await decode(bb);
      if (A.w !== B.w || A.h !== B.h) return { error: "size mismatch" };

      const centerDarkFrac = (im) => {
        const cx = Math.floor(im.w / 2);
        const cy = Math.floor(im.h / 2);
        let dark = 0;
        let total = 0;
        for (let y = cy - 60; y < cy + 60; y++) {
          for (let x = cx - 60; x < cx + 60; x++) {
            const i = (y * im.w + x) * 4;
            const lum = im.data[i] + im.data[i + 1] + im.data[i + 2];
            if (lum < 60) dark++;
            total++;
          }
        }
        return dark / total;
      };

      const total = A.w * A.h;
      let mismatch = 0;
      for (let i = 0; i < A.data.length; i += 4) {
        const d =
          Math.abs(A.data[i] - B.data[i]) +
          Math.abs(A.data[i + 1] - B.data[i + 1]) +
          Math.abs(A.data[i + 2] - B.data[i + 2]);
        if (d > 30) mismatch++;
      }
      return {
        mismatchPct: ((100 * mismatch) / total).toFixed(2),
        holeFracA: centerDarkFrac(A).toFixed(3),
        holeFracB: centerDarkFrac(B).toFixed(3),
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-clippoly] running webgpu...");
  const gpu = await run("webgpu");
  console.log("[probe-clippoly] running webgl...");
  const gl = await run("webgl");

  console.log(`  webgpu png: ${gpu.out}`);
  console.log(`  webgl  png: ${gl.out}`);
  if (gpu.errs.length)
    console.log(
      `  webgpu errors:`,
      gpu.errs.slice(0, 5).map((e) => e.text),
    );
  if (gl.errs.length)
    console.log(
      `  webgl errors:`,
      gl.errs.slice(0, 5).map((e) => e.text),
    );

  const res = await analyze(gpu.out, gl.out);
  console.log(`  analysis:`, JSON.stringify(res));

  // PASS criteria:
  //   hole present on both (center ≥95% background-black), AND
  //   whole-image mismatch ≤ 2% (boundary alignment).
  const holeGpu = parseFloat(res.holeFracA ?? "0") >= 0.95;
  const holeGl = parseFloat(res.holeFracB ?? "0") >= 0.95;
  const aligned = parseFloat(res.mismatchPct ?? "100") <= 2.0;
  console.log(
    `  hole webgpu=${holeGpu} webgl=${holeGl} boundaryAligned=${aligned}`,
  );
  const parity = holeGpu && holeGl && aligned;
  console.log(`  PARITY: ${parity ? "PASS" : "FAIL"}`);
  console.log("[probe-clippoly] done");
  // A printed verdict that leaves with status 0 is read as green by anything
  // that scores runs by exit code, so the verdict carries the code.
  process.exit(parity ? 0 : 1);
})();
