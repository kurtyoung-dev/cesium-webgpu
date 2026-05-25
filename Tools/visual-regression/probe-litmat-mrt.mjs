#!/usr/bin/env node
// Probe-litmat-mrt — Slice 5c-B Batch 121 verification.
//
// Adds an extruded Polygon with MaterialAppearance (Color Lit) so the
// primitive renders through WebGPUPrimitiveCommands with the Phong
// pipeline path. The polygon's 3D box-like extrusion gives the per-
// fragment normal real variation across faces (top, sides) — divergent
// from depth-derived approximations especially at the silhouette edges
// of the extruded box.
//
// Expected: zero device errors (regression-free) + a measurable C-vs-D
// Slice 4 signal from the polygon's MRT writes being consumed.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const VIEW = { lon: -79.9959, lat: 40.4406, height: 800.0 };
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

      // Add an extruded polygon with a Color Lit MaterialAppearance.
      // The extruded box has top + 4 side faces, each with its own
      // surface normal — exercises per-face normal divergence.
      const polygonPositions = C.Cartesian3.fromDegreesArray([
        view.lon - 0.001, view.lat - 0.001,
        view.lon + 0.001, view.lat - 0.001,
        view.lon + 0.001, view.lat + 0.001,
        view.lon - 0.001, view.lat + 0.001,
      ]);
      const geom = new C.PolygonGeometry({
        polygonHierarchy: new C.PolygonHierarchy(polygonPositions),
        extrudedHeight: 300,
        height: 280,
        vertexFormat:
          C.MaterialAppearance.MaterialSupport.BASIC.vertexFormat,
      });
      const primitive = new C.Primitive({
        geometryInstances: new C.GeometryInstance({ geometry: geom }),
        appearance: new C.MaterialAppearance({
          material: C.Material.fromType("Color", {
            color: new C.Color(0.9, 0.4, 0.2, 1.0),
          }),
        }),
        asynchronous: false,
      });
      v.scene.primitives.add(primitive);

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
        orientation: {
          heading: C.Math.toRadians(45),
          pitch: C.Math.toRadians(-30),
        },
      });

      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 400) break;
      }
      // Extra frames for primitive ready state.
      for (let i = 0; i < 200; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
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
        ao_requested: ao,
        deferred_requested: deferred,
        sceneDeferredLighting: v.scene.deferredLighting,
        sceneTilesLoaded: v.scene.globe.tilesLoaded,
        env_useDeferredLighting:
          v.scene._environmentState?.useDeferredLighting ?? null,
        centerPixel,
        primitiveCount: v.scene.primitives.length,
      };
    },
    { view: VIEW, clockUTC: FIXED_CLOCK_UTC, ao, deferred },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);

  await page.waitForTimeout(1000);
  const out = path.join(OUT_DIR, `litmat-mrt-${label}.png`);
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
  console.log("[probe-litmat-mrt] capturing 4-cell matrix with extruded polygon");

  const cells = [];
  cells.push(await capture("a-ao-off-def-off", { ao: false, deferred: false }));
  cells.push(await capture("b-ao-off-def-on", { ao: false, deferred: true }));
  cells.push(await capture("c-ao-on-def-off", { ao: true, deferred: false }));
  cells.push(await capture("d-ao-on-def-on", { ao: true, deferred: true }));

  for (const cell of cells) {
    console.log(`\n  [${cell.label}]`);
    console.log(
      `    canvas center: rgba(${cell.diagnostics.centerPixel?.r ?? "?"}, ${
        cell.diagnostics.centerPixel?.g ?? "?"
      }, ${cell.diagnostics.centerPixel?.b ?? "?"})`,
    );
    console.log(
      `    def=${cell.diagnostics.sceneDeferredLighting} envFlag=${cell.diagnostics.env_useDeferredLighting} prims=${cell.diagnostics.primitiveCount}`,
    );
    if (cell.deviceErrors.length) {
      console.log(`    ✗ ${cell.deviceErrors.length} device errors`);
      cell.deviceErrors
        .slice(0, 2)
        .forEach((e) => console.log(`      ${e.text?.slice(0, 200)}`));
    } else {
      console.log(`    ✓ no device errors`);
    }
    const errs = (cell.messages ?? []).filter(
      (m) => m.t === "error" || m.t === "pageerror",
    );
    if (errs.length) {
      console.log(`    ✗ ${errs.length} console err / pageerror events`);
      errs.slice(0, 2).forEach((e) =>
        console.log(
          `      ${e.t}: ${(e.text ?? "").split("\n")[0].slice(0, 200)}`,
        ),
      );
    }
  }

  console.log("\n[probe-litmat-mrt] diffs:");
  const aoDiff = await diffPngs(cells[0].out, cells[2].out);
  console.log(
    `  [A vs C] AO engagement: mismatch=${aoDiff.mismatchPct.toFixed(3)}% meanDelta=${aoDiff.meanDelta.toFixed(3)}`,
  );
  const slice4Diff = await diffPngs(cells[2].out, cells[3].out);
  console.log(
    `  [C vs D] Slice 4 signal: mismatch=${slice4Diff.mismatchPct.toFixed(3)}% meanDelta=${slice4Diff.meanDelta.toFixed(3)}`,
  );

  const reportPath = path.join(OUT_DIR, "litmat-mrt-report.json");
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
        diffs: { aoEngagement: aoDiff, slice4Signal: slice4Diff },
      },
      null,
      2,
    ),
  );
  console.log(`\n  report: ${reportPath}`);
})();
