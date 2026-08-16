#!/usr/bin/env node
// Probe-ellipsoid-mrt — Slice 5c-B Batch 118 verification.
// @purpose EllipsoidPrimitive writes real eye-space normals to G-buffer slot 1: AO must diverge between G-buffer and depth-fallback reads.
// @status ACTIVE
//
// Adds an EllipsoidPrimitive in front of the camera (large enough to
// cover ~30% of the viewport) and runs the same A/B/C/D matrix as
// probe-slice4-verify. With Batch 118 the ellipsoid pipeline writes
// real eye-space normals to G-buffer slot 1; the AO consumer should
// produce visibly different output when reading from the G-buffer
// (D, def-on) vs depth-fallback (C, def-off) because the ellipsoid's
// analytical ray-traced normals diverge from depth-derived normals
// (the ray-trace knows the surface curvature exactly; central
// differences across a curved silhouette produce noticeable
// approximation error).
//
// Expected post-Batch-118: C-vs-D > noise floor when ellipsoid covers
// a meaningful fraction of the canvas.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// View positioned so an ellipsoid centered AT the view target covers
// a meaningful fraction of the screen. Lower altitude so 200km
// ellipsoid radius spans ~30% of viewport.
const VIEW = { lon: -79.9959, lat: 40.4406, height: 500_000 };
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

async function capture(label, { ao, deferred }) {
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
    messages.push({
      t: "pageerror",
      text: e.message,
      stack: e.stack ?? null,
    }),
  );

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  // Install device error hooks before any rendering.
  await page.evaluate(() => {
    const dev = window.viewer?.scene?.context?._device;
    window.__probeErrors = [];
    if (!dev) return;
    dev.onuncapturederror = (ev) => {
      window.__probeErrors.push({
        text: ev?.error?.message ?? "no message",
      });
    };
  });

  const diagnostics = await page.evaluate(
    async ({ view, clockUTC, ao, deferred }) => {
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

      const aoStage = v.scene.postProcessStages?.ambientOcclusion;
      if (aoStage) {
        aoStage.enabled = ao;
        if (aoStage.uniforms) {
          aoStage.uniforms.intensity = 6.0;
          aoStage.uniforms.lengthCap = 0.4;
        }
      }

      // Camera positioned above the ellipsoid center looking down.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
        orientation: {
          heading: C.Math.toRadians(0),
          pitch: C.Math.toRadians(-90),
        },
      });

      // Add an EllipsoidPrimitive directly under the camera so it
      // dominates the center of the frame. Radii 100km at ~500km
      // altitude looking straight down → ellipsoid spans ~25-30% of
      // viewport diameter.
      const centerCart = C.Cartesian3.fromDegrees(view.lon, view.lat, 150_000);
      const ellipsoidPrim = new C.EllipsoidPrimitive({
        center: centerCart,
        radii: new C.Cartesian3(100_000, 100_000, 100_000),
        material: C.Material.fromType("Color", {
          color: new C.Color(0.9, 0.4, 0.2, 1.0),
        }),
      });
      v.scene.primitives.add(ellipsoidPrim);

      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 400) break;
      }

      // Sample center + a known ellipsoid pixel for failure-mode
      // confirmation. Center pixel might be globe-only depending on
      // ellipsoid placement — that's why we also sample at a few
      // offset positions where the ellipsoid should be.
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
        ao_requested: ao,
        deferred_requested: deferred,
        sceneDeferredLighting: v.scene.deferredLighting,
        sceneTilesLoaded: v.scene.globe.tilesLoaded,
        gBufferFB_exists: !!v.scene._view?.gBufferFramebuffer,
        env_useDeferredLighting:
          v.scene._environmentState?.useDeferredLighting ?? null,
        centerPixel,
        canvasIsBlack:
          centerPixel?.r === 0 && centerPixel?.g === 0 && centerPixel?.b === 0,
        ellipsoidPrimitiveCount: v.scene.primitives.length,
      };
    },
    { view: VIEW, clockUTC: FIXED_CLOCK_UTC, ao, deferred },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);

  await page.waitForTimeout(1500);
  const out = path.join(OUT_DIR, `ellipsoid-mrt-${label}.png`);
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
      const total = a.w * a.h;
      let mismatch = 0;
      let sum = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const d =
          Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]);
        sum += d;
        if (d > 30) mismatch++;
      }
      return {
        totalPx: total,
        mismatchPx: mismatch,
        mismatchPct: (100 * mismatch) / total,
        meanDelta: sum / total,
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-ellipsoid-mrt] capturing 4-cell matrix with ellipsoid");

  const cells = [];
  cells.push(await capture("a-ao-off-def-off", { ao: false, deferred: false }));
  cells.push(await capture("b-ao-off-def-on", { ao: false, deferred: true }));
  cells.push(await capture("c-ao-on-def-off", { ao: true, deferred: false }));
  cells.push(await capture("d-ao-on-def-on", { ao: true, deferred: true }));

  console.log("\n[probe-ellipsoid-mrt] per-cell summary:");
  for (const cell of cells) {
    console.log(`\n  [${cell.label}]`);
    console.log(
      `    canvas center: rgba(${cell.diagnostics.centerPixel?.r ?? "?"}, ${
        cell.diagnostics.centerPixel?.g ?? "?"
      }, ${cell.diagnostics.centerPixel?.b ?? "?"})`,
    );
    console.log(
      `    def=${cell.diagnostics.sceneDeferredLighting} envFlag=${cell.diagnostics.env_useDeferredLighting} prims=${cell.diagnostics.ellipsoidPrimitiveCount}`,
    );
    if (cell.deviceErrors.length) {
      console.log(`    ✗ ${cell.deviceErrors.length} device errors`);
      cell.deviceErrors
        .slice(0, 2)
        .forEach((e) => console.log(`      ${e.text?.slice(0, 200)}`));
    } else {
      console.log(`    ✓ no device errors`);
    }
    const pageErrors = (cell.messages ?? []).filter((m) => m.t === "pageerror");
    const consoleErrs = (cell.messages ?? []).filter((m) => m.t === "error");
    if (pageErrors.length || consoleErrs.length) {
      console.log(
        `    ✗ ${pageErrors.length} pageerrors, ${consoleErrs.length} console.error events:`,
      );
      pageErrors.slice(0, 1).forEach((e) => {
        console.log(`      pageerror: ${(e.text ?? "").slice(0, 200)}`);
        if (e.stack) {
          console.log(`      stack (first 6 lines):`);
          (e.stack ?? "")
            .split("\n")
            .slice(0, 6)
            .forEach((l) => console.log(`        ${l}`));
        }
      });
      consoleErrs.slice(0, 2).forEach((e) => {
        const firstLine = (e.text ?? "").split("\n")[0];
        console.log(`      console.error: ${firstLine.slice(0, 200)}`);
      });
    }
  }

  console.log("\n[probe-ellipsoid-mrt] diffs:");
  // A vs C: AO engagement (should be big if AO works on this view)
  const aoDiff = await diffPngs(cells[0].out, cells[2].out);
  console.log(
    `  [A vs C] AO engagement: mismatch=${aoDiff.mismatchPct.toFixed(3)}% meanDelta=${aoDiff.meanDelta.toFixed(3)}`,
  );
  // C vs D: Slice 4 signal — depth-fallback (C) vs G-buffer-read (D).
  // With Batch 118 the ellipsoid's pixel coverage in D should read
  // real ray-traced normals from slot 1, diverging from C's
  // depth-derived normals at the ellipsoid silhouette.
  const slice4Diff = await diffPngs(cells[2].out, cells[3].out);
  console.log(
    `  [C vs D] Slice 4 signal (depth-fallback vs MRT G-buffer): ` +
      `mismatch=${slice4Diff.mismatchPct.toFixed(3)}% meanDelta=${slice4Diff.meanDelta.toFixed(3)}`,
  );
  console.log(
    `    pre-Batch-118 baseline was 0.000% (compute producer overwrote MRT writes)`,
  );
  console.log(
    `    Batch 117 alone: still 0.000% (globe-only emit + globe MRT writes overwritten by compute producer)`,
  );
  console.log(
    `    Batch 118 ellipsoid emit: any value > 0 means MRT writes from the ellipsoid pipeline reach the consumer`,
  );

  const reportPath = path.join(OUT_DIR, "ellipsoid-mrt-report.json");
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
          deviceErrors: c.deviceErrors,
        })),
        diffs: { aoEngagement: aoDiff, slice4Signal: slice4Diff },
      },
      null,
      2,
    ),
  );
  console.log(`\n  report: ${reportPath}`);
})();
