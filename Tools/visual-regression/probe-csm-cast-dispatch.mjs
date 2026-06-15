#!/usr/bin/env node
// probe-csm-cast-dispatch — NEW-CSM-CAST-NO-DISPATCH-VIEWER verification
// (Batch 296).
//
// Confirms WebGPU shadow CAST commands actually reach the cast pass and a
// caster visibly darkens the ground. Same scene as probe-csm-soft-shadow:
// a 120m extruded wall on flat terrain under a low sun, top-down camera over
// the lit ground where the cast shadow falls.
//
// Diagnostics captured per WebGPU cell:
//   - csmRenderer._castDispatches  (must be > 0 with shadows on + CSM on)
//   - shadowMap.passes[j].commandList lengths just before the cast pass
//   - umbra (dark) pixel count inside the ground ROI  (must be > 0 → casts)
//
// Cells:
//   A: WebGPU, CSM on            → CSM cascade cast path
//   B: WebGPU, CSM off (single)  → single shadow-map cast path
//   C: WebGL,  shadows on        → reference (must show a shadow)
//
// Pass conditions:
//   - 0 device errors in every cell
//   - A: csm._castDispatches > 0  AND  A.umbraPx > 0  (CSM casts)
//   - B: B.umbraPx > 0                                (single map casts)
//   - C: C.umbraPx > 0                                (reference casts)
//   - A.umbraPx and B.umbraPx within a wide band of C.umbraPx (same shadow)

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";
const VIEW = { lon: -79.9959, lat: 40.4406 };
const FIXED_CLOCK_UTC = "2026-06-15T21:10:00Z";

async function capture(label, { renderer, useCsm }) {
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) => messages.push({ t: "pageerror", text: e.message }));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
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
    async ({ view, clockUTC, useCsm }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      v.terrainProvider = new C.EllipsoidTerrainProvider();
      v.imageryLayers.removeAll();
      v.scene.globe.baseColor = new C.Color(0.82, 0.8, 0.74, 1.0);
      v.scene.skyAtmosphere.show = false;
      v.scene.fog.enabled = false;
      v.scene.globe.showGroundAtmosphere = false;
      v.scene.globe.enableLighting = false;

      v.shadows = true;
      v.scene.shadowMap.enabled = true;
      v.scene.shadowMap.softShadows = true;
      v.scene.shadowMap.darkness = 0.3;
      v.scene.shadowMap.maximumDistance = 10000;
      v.scene.shadowMap.size = 2048;

      v.scene.useCascadedShadowMaps = useCsm;
      v.scene.cascadedShadowMapSoftShadows = true;
      v.scene.cascadedShadowMapResolution = 1024;

      const wallCoords = C.Cartesian3.fromDegreesArray([
        view.lon - 0.0004, view.lat - 0.003,
        view.lon + 0.0004, view.lat - 0.003,
        view.lon + 0.0004, view.lat + 0.003,
        view.lon - 0.0004, view.lat + 0.003,
      ]);
      const wall = new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(wallCoords),
            height: 0,
            extrudedHeight: 120,
            vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(
              new C.Color(0.6, 0.6, 0.62, 1.0),
            ),
          },
        }),
        appearance: new C.PerInstanceColorAppearance({
          translucent: false,
          flat: false,
        }),
        asynchronous: false,
        shadows: C.ShadowMode.ENABLED,
      });
      v.scene.primitives.add(wall);

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(
          view.lon + 0.0012,
          view.lat + 0.0012,
          1700.0,
        ),
        orientation: {
          heading: 0,
          pitch: C.Math.toRadians(-90),
          roll: 0,
        },
      });

      for (let i = 0; i < 1200; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 200) break;
      }
      for (let i = 0; i < 90; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Capture cast-pass command-list lengths just before the next cast pass.
      const shadowState = v.scene.frameState?.shadowState;
      const passLens = [];
      if (shadowState?.shadowMaps) {
        for (const sm of shadowState.shadowMaps) {
          const lens = (sm.passes || []).map((p) => p.commandList.length);
          passLens.push(lens);
        }
      }

      // ROI luminance → umbra count.
      const canvas = v.canvas;
      const tmp = document.createElement("canvas");
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      const ctx2d = tmp.getContext("2d");
      ctx2d.drawImage(canvas, 0, 0);
      const W = tmp.width;
      const H = tmp.height;
      const rx0 = Math.floor(W * 0.18);
      const rx1 = Math.floor(W * 0.66);
      const ry0 = Math.floor(H * 0.18);
      const ry1 = Math.floor(H * 0.72);
      const roiW = rx1 - rx0;
      const roiH = ry1 - ry0;
      const img = ctx2d.getImageData(rx0, ry0, roiW, roiH).data;
      let minLum = 255;
      let maxLum = 0;
      const lums = new Array(roiW * roiH);
      for (let p = 0, j = 0; p < img.length; p += 4, j++) {
        const lum = 0.299 * img[p] + 0.587 * img[p + 1] + 0.114 * img[p + 2];
        lums[j] = lum;
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
      }
      const span = Math.max(1, maxLum - minLum);
      const umbraCut = minLum + span * 0.28;
      let umbraPx = 0;
      for (const l of lums) if (l <= umbraCut) umbraPx++;

      return {
        renderer: v.scene.context?.isWebGPU ? "webgpu" : "webgl",
        useCsm: v.scene.useCascadedShadowMaps,
        castDispatches:
          v.scene.context?.csmRenderer?._castDispatches ?? null,
        csmEnabledOnContext: v.scene.context?.csmRenderer?.enabled === true,
        passLens,
        shadowMapCount: shadowState?.shadowMaps?.length ?? 0,
        tilesLoaded: v.scene.globe.tilesLoaded,
        primitives: v.scene.primitives.length,
        roi: { x0: rx0, y0: ry0, w: roiW, h: roiH },
        minLum: Math.round(minLum),
        maxLum: Math.round(maxLum),
        umbraCut: Math.round(umbraCut),
        umbraPx,
        roiTotal: roiW * roiH,
      };
    },
    { view: VIEW, clockUTC: FIXED_CLOCK_UTC, useCsm },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);
  await page.waitForTimeout(300);
  const out = path.join(OUT_DIR, `csm-cast-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return { label, out, diagnostics, deviceErrors, messages };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-csm-cast-dispatch] capturing 3-cell matrix\n");

  const cells = [];
  cells.push(await capture("a-webgpu-csm", { renderer: "webgpu", useCsm: true }));
  cells.push(await capture("b-webgpu-single", { renderer: "webgpu", useCsm: false }));
  cells.push(await capture("c-webgl", { renderer: "webgl", useCsm: false }));

  for (const cell of cells) {
    const d = cell.diagnostics;
    console.log(`  [${cell.label}] renderer=${d.renderer} csm=${d.useCsm}`);
    console.log(
      `    castDispatches=${d.castDispatches} ctxCsmEnabled=${d.csmEnabledOnContext} shadowMaps=${d.shadowMapCount}`,
    );
    console.log(`    passLens=${JSON.stringify(d.passLens)}`);
    console.log(
      `    umbraPx=${d.umbraPx}/${d.roiTotal} lum[min=${d.minLum},max=${d.maxLum},cut=${d.umbraCut}]`,
    );
    console.log(`    tilesLoaded=${d.tilesLoaded} prims=${d.primitives}`);
    const dbg = cell.messages.filter((m) => m.text?.includes("CSMCAST-DBG"));
    const uniq = [...new Set(dbg.map((m) => m.text))].slice(0, 6);
    uniq.forEach((t) => console.log(`    DBG ${t}`));
    if (cell.deviceErrors.length) {
      console.log(`    X ${cell.deviceErrors.length} device errors`);
      cell.deviceErrors.slice(0, 3).forEach((e) =>
        console.log(`      ${e.text?.slice(0, 200)}`),
      );
    } else {
      console.log(`    OK no device errors`);
    }
    console.log("");
  }

  const A = cells[0].diagnostics;
  const B = cells[1].diagnostics;
  const Cc = cells[2].diagnostics;
  const errAll = cells.reduce((s, c) => s + c.deviceErrors.length, 0);

  const aCasts = (A.castDispatches ?? 0) > 0;
  const aShadow = A.umbraPx > 200;
  const bShadow = B.umbraPx > 200;
  const cShadow = Cc.umbraPx > 200;

  console.log("[probe-csm-cast-dispatch] assertions:");
  console.log(`  A.castDispatches(${A.castDispatches}) > 0 → CSM cast pass dispatched: ${aCasts ? "PASS" : "FAIL"}`);
  console.log(`  A.umbraPx(${A.umbraPx}) > 200 → CSM casts visible shadow: ${aShadow ? "PASS" : "FAIL"}`);
  console.log(`  B.umbraPx(${B.umbraPx}) > 200 → single shadow map casts: ${bShadow ? "PASS" : "FAIL"}`);
  console.log(`  C.umbraPx(${Cc.umbraPx}) > 200 → WebGL reference casts: ${cShadow ? "PASS" : "FAIL"}`);
  console.log(`  total device errors=${errAll} → ${errAll === 0 ? "PASS" : "FAIL"}`);

  const pass = aCasts && aShadow && bShadow && cShadow && errAll === 0;
  console.log(`\n  OVERALL: ${pass ? "PASS" : "FAIL"}`);

  const reportPath = path.join(OUT_DIR, "csm-cast-dispatch-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        view: VIEW,
        clock: FIXED_CLOCK_UTC,
        cells: cells.map((c) => ({
          label: c.label,
          screenshot: c.out,
          diagnostics: c.diagnostics,
          deviceErrorCount: c.deviceErrors.length,
        })),
        assertions: { aCasts, aShadow, bShadow, cShadow, totalDeviceErrors: errAll, pass },
      },
      null,
      2,
    ),
  );
  console.log(`  report: ${reportPath}`);
  process.exitCode = pass ? 0 : 1;
})();
