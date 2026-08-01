#!/usr/bin/env node
// Probe-taa-disocclusion — Slice 5c-B Batch 126 verification.
//
// Toggles `scene.taaEnabled` on/off with and without camera motion
// to exercise TAA's disocclusion path. Pre-Batch-126 TAA had 2
// disocclusion checks (motion magnitude, depth delta); Batch 126
// adds a 3rd: G-buffer normal divergence between current pixel and
// reprojected previous-frame pixel position.
//
// Verification goals:
//   1. ✓ no WebGPU device errors → new binding 6 (G-buffer normal
//      placeholder + real view) builds + binds cleanly.
//   2. A vs B (TAA off vs on, static camera): some divergence
//      expected because TAA jitters sub-pixel offsets per frame.
//   3. C vs D (TAA off vs on, after orbit motion): divergence
//      should be ≥ A-vs-B because the orbit triggers disocclusion
//      logic on every silhouette pixel.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Grand Canyon — terrain silhouettes give TAA's disocclusion path
// pixels to fire on.
const VIEW = { lon: -112.1129, lat: 36.0544, height: 8_000 };
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

async function capture(label, { taa, orbit }) {
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
    viewport: { width: 1280, height: 720 },
  });

  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(() => {
    const dev = window.viewer?.scene?.context?._device;
    window.__probeErrors = [];
    if (!dev) return;
    dev.onuncapturederror = (ev) => {
      window.__probeErrors.push({ text: ev?.error?.message ?? "" });
    };
  });

  const diagnostics = await page.evaluate(
    async ({ view, clockUTC, taa, orbit }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;

      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      v.scene.globe.enableLighting = true;
      v.scene.taaEnabled = taa;

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
        orientation: {
          heading: C.Math.toRadians(0),
          pitch: C.Math.toRadians(-30),
        },
      });

      // Initial settle.
      for (let i = 0; i < 1000; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 300) break;
      }

      // Optional orbit motion to exercise disocclusion. 15° heading
      // change over 30 frames → ~0.5°/frame which is large enough to
      // produce silhouette-pixel disocclusion at TAA's threshold.
      if (orbit) {
        for (let i = 0; i < 30; i++) {
          v.camera.setView({
            destination: C.Cartesian3.fromDegrees(
              view.lon,
              view.lat,
              view.height,
            ),
            orientation: {
              heading: C.Math.toRadians((i / 30) * 15),
              pitch: C.Math.toRadians(-30),
            },
          });
          v.scene.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
      }

      // Final settle so the captured pixel is the post-disocclusion
      // converged state, not the mid-motion frame.
      for (let i = 0; i < 60; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const canvas = v.canvas;
      let centerPixel;
      try {
        const tmp = document.createElement("canvas");
        tmp.width = canvas.width;
        tmp.height = canvas.height;
        const ctx2d = tmp.getContext("2d");
        ctx2d.drawImage(canvas, 0, 0);
        const cx = (canvas.width / 2) | 0;
        const cy = (canvas.height / 2) | 0;
        const data = ctx2d.getImageData(cx, cy, 1, 1).data;
        centerPixel = { r: data[0], g: data[1], b: data[2], a: data[3] };
      } catch (e) {
        centerPixel = { error: String(e?.message ?? e) };
      }

      return {
        taa_requested: taa,
        scene_taaEnabled: v.scene.taaEnabled,
        sceneTilesLoaded: v.scene.globe.tilesLoaded,
        gBufferFB_exists: !!v.scene._view?.gBufferFramebuffer,
        centerPixel,
      };
    },
    { view: VIEW, clockUTC: FIXED_CLOCK_UTC, taa, orbit },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);

  await page.waitForTimeout(1000);
  const out = path.join(OUT_DIR, `taa-disocclusion-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return { label, out, diagnostics, deviceErrors, messages };
}

async function diffPngs(a, b) {
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
      const a = await decode(ba);
      const b = await decode(bb);
      if (a.w !== b.w || a.h !== b.h) return { error: "size mismatch" };
      let mismatch = 0;
      let sum = 0;
      const total = a.w * a.h;
      for (let i = 0; i < a.data.length; i += 4) {
        const d =
          Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]);
        sum += d;
        if (d > 30) mismatch++;
      }
      return { mismatchPct: (100 * mismatch) / total, meanDelta: sum / total };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-taa-disocclusion] capturing 4-cell matrix");

  const cells = [];
  cells.push(await capture("a-taa-off-static", { taa: false, orbit: false }));
  cells.push(await capture("b-taa-on-static", { taa: true, orbit: false }));
  cells.push(await capture("c-taa-off-orbit", { taa: false, orbit: true }));
  cells.push(await capture("d-taa-on-orbit", { taa: true, orbit: true }));

  for (const cell of cells) {
    console.log(`\n  [${cell.label}]`);
    console.log(
      `    canvas center: rgba(${cell.diagnostics.centerPixel?.r ?? "?"}, ${
        cell.diagnostics.centerPixel?.g ?? "?"
      }, ${cell.diagnostics.centerPixel?.b ?? "?"})`,
    );
    console.log(
      `    taa=${cell.diagnostics.scene_taaEnabled} tilesLoaded=${cell.diagnostics.sceneTilesLoaded} gBufferFB=${cell.diagnostics.gBufferFB_exists}`,
    );
    if (cell.deviceErrors.length) {
      console.log(`    ✗ ${cell.deviceErrors.length} device errors`);
      cell.deviceErrors
        .slice(0, 2)
        .forEach((e) => console.log(`      ${e.text?.slice(0, 200)}`));
    } else {
      console.log(`    ✓ no device errors`);
    }
  }

  console.log("\n[probe-taa-disocclusion] diffs:");
  const aoff_bon = await diffPngs(cells[0].out, cells[1].out);
  console.log(
    `  [A static off vs B static on]: mismatch=${aoff_bon.mismatchPct.toFixed(3)}% meanDelta=${aoff_bon.meanDelta.toFixed(3)}`,
  );
  const coff_don = await diffPngs(cells[2].out, cells[3].out);
  console.log(
    `  [C orbit off vs D orbit on]: mismatch=${coff_don.mismatchPct.toFixed(3)}% meanDelta=${coff_don.meanDelta.toFixed(3)}`,
  );
  console.log(
    `    Static: TAA jitter sub-pixel — small diff (~0.1% noise floor)`,
  );
  console.log(
    `    Orbit: TAA history + disocclusion gates — should be ≥ static diff`,
  );

  const reportPath = path.join(OUT_DIR, "taa-disocclusion-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        view: VIEW,
        cells: cells.map((c) => ({
          label: c.label,
          screenshot: c.out,
          diagnostics: c.diagnostics,
          deviceErrorCount: c.deviceErrors.length,
        })),
        diffs: { staticOnOff: aoff_bon, orbitOnOff: coff_don },
      },
      null,
      2,
    ),
  );
  console.log(`\n  report: ${reportPath}`);
})();
