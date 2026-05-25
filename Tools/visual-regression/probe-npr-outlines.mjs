#!/usr/bin/env node
// Probe-npr-outlines — Slice 5c-B Batch 123 verification.
//
// Toggles scene.enableNPROutlines on/off and measures A-vs-B diff at
// a view with terrain silhouette features (camera near canyon rim,
// expecting visible edges where depth gradient + normal divergence
// peak). Sentinel pixels (sky) should be unchanged so the diff
// concentrates on actual geometry edges.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Grand Canyon area — terrain with sharp ridges + canyons → depth
// gradient AND normal divergence both fire.
const VIEW = { lon: -112.1129, lat: 36.0544, height: 8_000 };
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

async function capture(label, { npr, strength }) {
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
    async ({ view, clockUTC, npr, strength }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;

      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      v.scene.globe.enableLighting = true;
      v.scene.enableNPROutlines = npr;
      v.scene.nprEdgeStrength = strength;
      // Production-ish thresholds: only paint edges at actual
      // crease/silhouette discontinuities (not every pixel). With
      // Batch 127 the env-effects chain works end-to-end, so the
      // diff between cells is now real visible edge contribution.
      v.scene.nprNormalThreshold = 0.05;
      v.scene.nprDepthThreshold = 0.002;
      v.scene.nprEdgeColor = new C.Color(1.0, 0.0, 1.0, 1.0); // magenta
      // Batch 128 — MSAA depth resolve now populates a single-sample
      // sampleable depth view in BOTH single-sample and MSAA modes,
      // so probes can use the default `msaaSamples=4` and env effects
      // still activate. (Pre-Batch-128 we had to force =1 to bypass
      // the depth wiring gate.)

      // Force the lazy FR loader to settle before rendering, otherwise
      // the first ~3-5 frames skip NPR while the dynamic import is in
      // flight. By awaiting here we ensure every render frame sees the
      // FR registered.
      if (
        npr &&
        typeof v.scene.context?.getFeatureRendererAsync === "function"
      ) {
        await v.scene.context.getFeatureRendererAsync(47);
      }

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
        orientation: {
          heading: C.Math.toRadians(0),
          pitch: C.Math.toRadians(-30),
        },
      });

      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 400) break;
      }

      const canvas = v.canvas;
      let centerPixel = null;
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
        npr_requested: npr,
        scene_enableNPROutlines: v.scene.enableNPROutlines,
        edgeStrength: v.scene.nprEdgeStrength,
        sceneTilesLoaded: v.scene.globe.tilesLoaded,
        gBufferFB_exists: !!v.scene._view?.gBufferFramebuffer,
        nprFR_exists: !!v.scene.context?.getFeatureRenderer?.(47), // NPR_OUTLINES key
        centerPixel,
      };
    },
    { view: VIEW, clockUTC: FIXED_CLOCK_UTC, npr, strength },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);

  await page.waitForTimeout(1000);
  const out = path.join(OUT_DIR, `npr-outlines-${label}.png`);
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
  console.log("[probe-npr-outlines] capturing 3-cell matrix");

  const cells = [];
  cells.push(await capture("a-off", { npr: false, strength: 0.0 }));
  cells.push(await capture("b-on-full", { npr: true, strength: 1.0 }));
  cells.push(await capture("c-on-half", { npr: true, strength: 0.5 }));

  for (const cell of cells) {
    console.log(`\n  [${cell.label}]`);
    console.log(
      `    canvas center: rgba(${cell.diagnostics.centerPixel?.r ?? "?"}, ${
        cell.diagnostics.centerPixel?.g ?? "?"
      }, ${cell.diagnostics.centerPixel?.b ?? "?"})`,
    );
    console.log(
      `    npr=${cell.diagnostics.scene_enableNPROutlines} strength=${cell.diagnostics.edgeStrength} fr=${cell.diagnostics.nprFR_exists}`,
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

  console.log("\n[probe-npr-outlines] diffs:");
  const aoff_vs_bon = await diffPngs(cells[0].out, cells[1].out);
  console.log(
    `  [A off vs B on-full]: mismatch=${aoff_vs_bon.mismatchPct.toFixed(3)}% meanDelta=${aoff_vs_bon.meanDelta.toFixed(3)}`,
  );
  const bfull_vs_chalf = await diffPngs(cells[1].out, cells[2].out);
  console.log(
    `  [B full vs C half]: mismatch=${bfull_vs_chalf.mismatchPct.toFixed(3)}% meanDelta=${bfull_vs_chalf.meanDelta.toFixed(3)}`,
  );
  console.log(
    `    A vs B > 0% → outline pass is producing output (edges visible)`,
  );
  console.log(
    `    B vs C > 0% but smaller → strength config affects output (half opacity ≠ full)`,
  );

  const reportPath = path.join(OUT_DIR, "npr-outlines-report.json");
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
        diffs: { aoff_vs_bon, bfull_vs_chalf },
      },
      null,
      2,
    ),
  );
  console.log(`\n  report: ${reportPath}`);
})();
