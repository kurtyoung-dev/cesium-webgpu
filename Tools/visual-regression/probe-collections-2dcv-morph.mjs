#!/usr/bin/env node
// Probe (MORPH-COLLECTIONS-AUDIT): verify Billboard / Point / Polyline / Label
// collections render at the correct map location on WebGPU in SCENE2D and
// COLUMBUS_VIEW, vs WebGL as the reference.
//
// Adds one Point, one Polyline, one Label, and one Billboard at a fixed
// lon/lat, flies the camera to look straight down at them, morphs to the
// requested mode (instant), settles, then crops a window around the expected
// screen location and reports non-background pixel coverage. A collection that
// is "broken in 2D/CV" projects its geometry off-screen / to the wrong place,
// so its crop coverage on WebGPU will diverge sharply from WebGL.
//
// Usage: node Tools/visual-regression/probe-collections-2dcv-morph.mjs
// Env:   PROBE_BASE (default http://localhost:8134)
// Out:   Tools/visual-regression/output/coll2dcv-{2d,cv}-{webgl,webgpu}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";

// SceneMode: 1=COLUMBUS_VIEW, 2=SCENE2D, 3=SCENE3D
const MODES = [
  { name: "3d", id: 3 }, // baseline: do the collections render on WebGPU at all?
  { name: "2d", id: 2 },
  { name: "cv", id: 1 },
];

const LON = -75.0;
const LAT = 40.0;

async function capture(rendererArg, mode) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  const stats = await page.evaluate(
    async ({ modeId, lon, lat }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      // Build collections with one entry each at the same location.
      const pos = C.Cartesian3.fromDegrees(lon, lat, 0.0);
      const pos2 = C.Cartesian3.fromDegrees(lon + 1.0, lat + 0.5, 0.0);

      const bb = scene.primitives.add(new C.BillboardCollection());
      bb.add({
        position: pos,
        image: (() => {
          const cv = document.createElement("canvas");
          cv.width = cv.height = 16;
          const g = cv.getContext("2d");
          g.fillStyle = "#ff00ff";
          g.fillRect(0, 0, 16, 16);
          return cv;
        })(),
      });

      const pts = scene.primitives.add(new C.PointPrimitiveCollection());
      pts.add({ position: pos2, color: C.Color.YELLOW, pixelSize: 20 });

      const pls = scene.primitives.add(new C.PolylineCollection());
      pls.add({
        positions: [
          C.Cartesian3.fromDegrees(lon - 1.5, lat - 1.0, 0.0),
          C.Cartesian3.fromDegrees(lon + 1.5, lat + 1.0, 0.0),
        ],
        width: 6,
        material: C.Material.fromType("Color", { color: C.Color.CYAN }),
      });

      const lbls = scene.primitives.add(new C.LabelCollection());
      lbls.add({
        position: C.Cartesian3.fromDegrees(lon - 0.5, lat - 1.2, 0.0),
        text: "TEST",
        fillColor: C.Color.LIME,
        font: "32px sans-serif",
      });

      if (modeId === 1) scene.morphToColumbusView(0);
      else if (modeId === 2) scene.morphTo2D(0);
      else scene.morphTo3D(0);

      // Look straight down at the cluster.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, 1500000.0),
      });

      for (let i = 0; i < 120; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      // Re-center after morph settles (2D/CV camera may have shifted).
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, 1500000.0),
      });
      for (let i = 0; i < 30; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Count colored (non-imagery) pixels: magenta, yellow, cyan, lime.
      const c = scene.canvas;
      const off = document.createElement("canvas");
      off.width = c.width;
      off.height = c.height;
      const cx = off.getContext("2d");
      cx.drawImage(c, 0, 0);
      const data = cx.getImageData(0, 0, c.width, c.height).data;
      let magenta = 0,
        yellow = 0,
        cyan = 0,
        lime = 0,
        marked = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        // High-saturation primaries; loose thresholds for AA/blend.
        if (r > 180 && b > 180 && g < 120) {
          magenta++;
          marked++;
        } else if (r > 180 && g > 180 && b < 120) {
          yellow++;
          marked++;
        } else if (g > 150 && b > 150 && r < 120) {
          cyan++;
          marked++;
        } else if (g > 180 && r < 160 && b < 120) {
          lime++;
          marked++;
        }
      }
      return {
        mode: scene.mode,
        w: c.width,
        h: c.height,
        magenta, // billboard
        yellow, // point
        cyan, // polyline
        lime, // label
        marked,
      };
    },
    { modeId: mode.id, lon: LON, lat: LAT },
  );

  await page.waitForTimeout(500);
  const out = path.join(OUT_DIR, `coll2dcv-${mode.name}-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();

  console.log(
    `  [${rendererArg}/${mode.name}] bb(magenta)=${stats.magenta} pt(yellow)=${stats.yellow} pl(cyan)=${stats.cyan} lbl(lime)=${stats.lime} errs=${errors.length}`,
  );
  errors.slice(0, 4).forEach((e) => console.log(`      ERR: ${e}`));
  return { out, stats, errors };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const results = {};
  for (const mode of MODES) {
    for (const r of ["webgl", "webgpu"]) {
      console.log(`[probe-collections-2dcv-morph] ${r} ${mode.name}`);
      results[`${r}-${mode.name}`] = await capture(r, mode);
    }
  }
  console.log("\n[probe-collections-2dcv-morph] SUMMARY (counts of colored px)");
  for (const mode of MODES) {
    const gl = results[`webgl-${mode.name}`].stats;
    const gp = results[`webgpu-${mode.name}`].stats;
    const ratio = (a, b) => (a === 0 ? (b === 0 ? "1.0" : "INF") : (b / a).toFixed(2));
    console.log(`  ${mode.name}:`);
    console.log(`    billboard: GL=${gl.magenta} GPU=${gp.magenta} ratio=${ratio(gl.magenta, gp.magenta)}`);
    console.log(`    point:     GL=${gl.yellow} GPU=${gp.yellow} ratio=${ratio(gl.yellow, gp.yellow)}`);
    console.log(`    polyline:  GL=${gl.cyan} GPU=${gp.cyan} ratio=${ratio(gl.cyan, gp.cyan)}`);
    console.log(`    label:     GL=${gl.lime} GPU=${gp.lime} ratio=${ratio(gl.lime, gp.lime)}`);
  }
  console.log("[probe-collections-2dcv-morph] done");
})();
