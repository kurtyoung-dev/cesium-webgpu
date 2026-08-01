#!/usr/bin/env node
// Probe-ssr-water — Slice 5c-B Batch 132 SSR verification scene.
//
// Builds a scene with a low-roughness reflective polygon ("lake")
// AND a tall block-shape polygon ("wall") behind/above the lake.
// At a low-angle camera view, SSR should produce a visible
// reflection of the wall on the lake's surface. Post-Batch-129 the
// reflection sources from the post-processed canvas, so the
// reflection color matches the wall's display-space color.
//
// 4-cell matrix toggles `scene.enableSSR` + `scene.deferredLighting`
// (the historical gate that Batch 122 made architecturally
// redundant — both values should now produce identical SSR output).
//
// Expected if SSR is firing:
//   - A (SSR off) vs B (SSR on): visible reflection blob on the lake
//     surface, mismatch should be measurable (>1% probably).
//   - B (SSR on, def off) vs C (SSR on, def on): post-Batch-122 these
//     read the same G-buffer view so should be ≤ noise.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Pittsburgh area; low altitude looking at a flat polygon.
const VIEW = { lon: -79.9959, lat: 40.4406, height: 400.0 };
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
      v.scene.globe.enableLighting = true;
      v.scene.enableSSR = ssr;
      v.scene.deferredLighting = deferred;
      // Strong reflection so the visual effect is unambiguous.
      v.scene.ssrReflectionStrength = 1.0;

      // Lake polygon — flat horizontal, glassy lit material at ground.
      const lakeCoords = C.Cartesian3.fromDegreesArray([
        view.lon - 0.003,
        view.lat - 0.0015,
        view.lon + 0.003,
        view.lat - 0.0015,
        view.lon + 0.003,
        view.lat + 0.0015,
        view.lon - 0.003,
        view.lat + 0.0015,
      ]);
      const lake = new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(lakeCoords),
            height: 240,
            // TEXTURED vertexFormat includes per-vertex normals so the
            // appearance picks `matColorLit` instead of `matColorFlat`.
            // The Lit variant emits @location(1) (G-buffer normal +
            // roughness) so SSR's sentinel check passes on these
            // pixels and the ray-marching actually attempts to
            // reflect.
            vertexFormat:
              C.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
          }),
        }),
        appearance: new C.MaterialAppearance({
          material: C.Material.fromType("Color", {
            color: new C.Color(0.05, 0.1, 0.2, 1.0),
          }),
          translucent: false,
        }),
        asynchronous: false,
      });
      v.scene.primitives.add(lake);

      // Wall polygon — extruded tall block north of the lake, bright
      // color so its reflection is easy to spot.
      const wallCoords = C.Cartesian3.fromDegreesArray([
        view.lon - 0.001,
        view.lat + 0.002,
        view.lon + 0.001,
        view.lat + 0.002,
        view.lon + 0.001,
        view.lat + 0.0025,
        view.lon - 0.001,
        view.lat + 0.0025,
      ]);
      const wall = new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(wallCoords),
            height: 240,
            extrudedHeight: 400,
            // TEXTURED vertexFormat includes per-vertex normals so the
            // appearance picks `matColorLit` instead of `matColorFlat`.
            // The Lit variant emits @location(1) (G-buffer normal +
            // roughness) so SSR's sentinel check passes on these
            // pixels and the ray-marching actually attempts to
            // reflect.
            vertexFormat:
              C.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
          }),
        }),
        appearance: new C.MaterialAppearance({
          material: C.Material.fromType("Color", {
            color: new C.Color(1.0, 0.7, 0.1, 1.0),
          }),
          translucent: false,
        }),
        asynchronous: false,
      });
      v.scene.primitives.add(wall);

      // Camera positioned at glancing angle to the lake, looking at the
      // wall + lake. Wall reflection should bounce off the lake into
      // the camera.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(
          view.lon,
          view.lat - 0.005,
          view.height,
        ),
        orientation: {
          heading: C.Math.toRadians(0), // facing north toward wall
          pitch: C.Math.toRadians(-15), // shallow downward angle
        },
      });
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 400) break;
      }
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
        ssr_requested: ssr,
        scene_enableSSR: v.scene.enableSSR,
        deferred_requested: deferred,
        sceneDeferredLighting: v.scene.deferredLighting,
        sceneTilesLoaded: v.scene.globe.tilesLoaded,
        primitivesCount: v.scene.primitives.length,
        centerPixel,
      };
    },
    { view: VIEW, clockUTC: FIXED_CLOCK_UTC, ssr, deferred },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);
  await page.waitForTimeout(1000);
  const out = path.join(OUT_DIR, `ssr-water-${label}.png`);
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
  console.log("[probe-ssr-water] capturing 4-cell matrix with lake + wall");

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
      `    ssr=${cell.diagnostics.scene_enableSSR} def=${cell.diagnostics.sceneDeferredLighting} prims=${cell.diagnostics.primitivesCount}`,
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

  console.log("\n[probe-ssr-water] diffs:");
  const ssrEng = await diffPngs(cells[0].out, cells[1].out);
  console.log(
    `  [A ssr-off vs B ssr-on, both def-off] SSR engagement: mismatch=${ssrEng.mismatchPct.toFixed(3)}% meanDelta=${ssrEng.meanDelta.toFixed(3)}`,
  );
  const defGate = await diffPngs(cells[1].out, cells[2].out);
  console.log(
    `  [B ssr-on def-off vs C ssr-on def-on] post-Batch-122 should be near-zero:` +
      ` mismatch=${defGate.mismatchPct.toFixed(3)}% meanDelta=${defGate.meanDelta.toFixed(3)}`,
  );

  const reportPath = path.join(OUT_DIR, "ssr-water-report.json");
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
        diffs: { ssrEngagement: ssrEng, deferredGate: defGate },
      },
      null,
      2,
    ),
  );
  console.log(`\n  report: ${reportPath}`);
})();
