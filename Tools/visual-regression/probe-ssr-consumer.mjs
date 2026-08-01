#!/usr/bin/env node
// Probe-ssr-consumer — Slice 5c-B Batch 122 verification.
//
// Toggles `scene._enableSSR` on/off and toggles deferredLighting on/off
// (legacy gate that Batch 122 removed). Pre-Batch-122 the SSR shader
// only saw real normals when deferredLighting was on; post-Batch-122
// it always reads them when the G-buffer view is available, regardless
// of deferredLighting state.
//
// Expected post-Batch-122:
//   - A (SSR off): baseline scene
//   - B (SSR on, def off): SSR reads G-buffer (was depth-derived fallback before)
//   - C (SSR on, def on): SSR reads G-buffer (was G-buffer-via-deferredLighting before)
//
// B vs C should be ~0% post-Batch-122 — same G-buffer source. Pre-fix,
// B would diverge from C because B was using the shader's
// depth-derivative fallback path.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Low-altitude view over Pittsburgh river — water surfaces are the
// canonical SSR test case.
const VIEW = { lon: -79.9959, lat: 40.4406, height: 5_000.0 };
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

async function capture(label, { ssr, deferred }) {
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
    async ({ view, clockUTC, ssr, deferred }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;

      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      v.scene.deferredLighting = deferred;
      v.scene.globe.enableLighting = true;

      // Toggle SSR via the documented scene flag.
      v.scene._enableSSR = ssr;

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
        ssr_requested: ssr,
        deferred_requested: deferred,
        scene_enableSSR: v.scene._enableSSR,
        sceneDeferredLighting: v.scene.deferredLighting,
        sceneTilesLoaded: v.scene.globe.tilesLoaded,
        env_useDeferredLighting:
          v.scene._environmentState?.useDeferredLighting ?? null,
        gBufferFB_exists: !!v.scene._view?.gBufferFramebuffer,
        ssrFR_exists: !!v.scene.context?.getFeatureRenderer?.(28), // SSR FR key
        centerPixel,
      };
    },
    { view: VIEW, clockUTC: FIXED_CLOCK_UTC, ssr, deferred },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);

  await page.waitForTimeout(1000);
  const out = path.join(OUT_DIR, `ssr-consumer-${label}.png`);
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
  console.log("[probe-ssr-consumer] capturing 4-cell matrix");

  const cells = [];
  cells.push(
    await capture("a-ssr-off-def-off", { ssr: false, deferred: false }),
  );
  cells.push(await capture("b-ssr-on-def-off", { ssr: true, deferred: false }));
  cells.push(await capture("c-ssr-on-def-on", { ssr: true, deferred: true }));
  cells.push(await capture("d-ssr-off-def-on", { ssr: false, deferred: true }));

  for (const cell of cells) {
    console.log(`\n  [${cell.label}]`);
    console.log(
      `    canvas center: rgba(${cell.diagnostics.centerPixel?.r ?? "?"}, ${
        cell.diagnostics.centerPixel?.g ?? "?"
      }, ${cell.diagnostics.centerPixel?.b ?? "?"})`,
    );
    console.log(
      `    ssr=${cell.diagnostics.scene_enableSSR} def=${cell.diagnostics.sceneDeferredLighting} envFlag=${cell.diagnostics.env_useDeferredLighting} ssrFR=${cell.diagnostics.ssrFR_exists}`,
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

  console.log("\n[probe-ssr-consumer] diffs:");
  const ssrEngagement = await diffPngs(cells[0].out, cells[1].out);
  console.log(
    `  [A vs B] SSR engagement (off vs on, both def-off): mismatch=${ssrEngagement.mismatchPct.toFixed(3)}% meanDelta=${ssrEngagement.meanDelta.toFixed(3)}`,
  );
  const ssrDefSwap = await diffPngs(cells[1].out, cells[2].out);
  console.log(
    `  [B vs C] SSR with vs without deferred flag (both SSR-on):` +
      ` mismatch=${ssrDefSwap.mismatchPct.toFixed(3)}% meanDelta=${ssrDefSwap.meanDelta.toFixed(3)}`,
  );
  console.log(
    `    Pre-Batch-122: B used shader depth-derivative fallback; C used G-buffer → B≠C expected (~5-15%)`,
  );
  console.log(
    `    Post-Batch-122: B and C both read G-buffer → B≈C expected (≤noise)`,
  );

  const reportPath = path.join(OUT_DIR, "ssr-consumer-report.json");
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
        diffs: { ssrEngagement, ssrDefSwap },
      },
      null,
      2,
    ),
  );
  console.log(`\n  report: ${reportPath}`);
})();
