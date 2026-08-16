#!/usr/bin/env node
// probe-c10-10-shadow-single-sweep — C10-10-SHADOW-CAST-SINGLE-SWEEP verification.
// @purpose Verifies the shadow caster-list fold: sublist reference-identical to the old full scan incl. off-camera casters, shadows still render.
// @status ACTIVE
//
// Premise: with shadows on, the frame builds the per-cascade cast lists with a
// SECOND full-`commandList` sweep per shadow map (SceneRenderer.insertShadowCastCommands),
// re-running scene.updateDerivedCommands on every command + a per-call shadowedPasses
// array + .includes + light-frustum culling — duplicating the single PVS walk.
//
// This probe quantifies that walk and, after the fold, asserts the collected
// caster sublist is IDENTICAL (by reference) to the set the old full-scan would
// have produced — including OFF-CAMERA casters (INV-1).
//
// Scene: a 120 m extruded wall on flat terrain under a low sun (in-view caster
// that throws a visible ground shadow) PLUS a tall box ~1.7 km east that is
// OUTSIDE the top-down camera frustum but still a shadow caster (INV-1 off-camera
// caster). CSM on for cell A, single map for B, WebGL reference for C.
//
// Per-cell diagnostics:
//   N        = frameState.commandList.length              (the walk length)
//   maps     = shadowState.shadowMaps.length
//   cascades = shadowMaps[0].passes.length
//   K        = candidate casters in commandList (castShadows===true && shadowedPass)
//   casterCommandsLen (POST only) = shadowState.casterCommands.length
//   setEqual (POST only) = casterCommands === oldSet by reference (INV: fold parity)
//   camInvisCasters      = casters the camera frustum culls (isVisible === false)
//   camInvisInSublist    = camera-invisible casters that made it into casterCommands (INV-1)
//   passLens = shadowMaps[i].passes[j].commandList.length   (populated cast lists)
//   castDispatches (WebGPU CSM) / umbraPx (visible shadow)
//
// Pass conditions:
//   - 0 device errors every cell
//   - umbraPx > 200 every cell (a shadow renders; feature not degraded)
//   - POST: setEqual === true (fold collects the identical caster set)
//   - POST: camInvisCasters >= 1 AND camInvisInSublist === camInvisCasters (INV-1: every
//     off-camera caster preserved)
//   - passLens has at least one non-empty per-pass list (cast lists populated)

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const TAG = process.env.PROBE_TAG || "post"; // "pre" or "post"
const VIEW = { lon: -79.9959, lat: 40.4406 };
const FIXED_CLOCK_UTC = "2026-06-15T21:10:00Z";

// Pass enum ids for the shadowed passes (Renderer/Pass.js).
const SHADOWED = { 2: 1, 5: 1, 8: 1, 9: 1 }; // GLOBE, CESIUM_3D_TILE, OPAQUE, TRANSLUCENT

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
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

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
    async ({ view, clockUTC, useCsm, SHADOWED }) => {
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

      // In-view caster: 120 m wall throwing a visible ground shadow.
      const wallCoords = C.Cartesian3.fromDegreesArray([
        view.lon - 0.0004,
        view.lat - 0.003,
        view.lon + 0.0004,
        view.lat - 0.003,
        view.lon + 0.0004,
        view.lat + 0.003,
        view.lon - 0.0004,
        view.lat + 0.003,
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

      // OFF-CAMERA caster (INV-1): a 200 m box ~1.7 km east, outside the
      // top-down camera footprint (~980 m radius at 1700 m) but still a
      // shadow caster in a shadowed (OPAQUE) pass.
      const offLon = view.lon + 0.02;
      const boxCoords = C.Cartesian3.fromDegreesArray([
        offLon - 0.0006,
        view.lat - 0.0006,
        offLon + 0.0006,
        view.lat - 0.0006,
        offLon + 0.0006,
        view.lat + 0.0006,
        offLon - 0.0006,
        view.lat + 0.0006,
      ]);
      const offBox = new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(boxCoords),
            height: 0,
            extrudedHeight: 200,
            vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(
              new C.Color(0.7, 0.5, 0.5, 1.0),
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
      v.scene.primitives.add(offBox);

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(
          view.lon + 0.0012,
          view.lat + 0.0012,
          1700.0,
        ),
        orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 },
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

      const scene = v.scene;
      const fs2 = scene.frameState;
      const shadowState = fs2?.shadowState;
      const commandList = fs2?.commandList ?? [];
      const N = commandList.length;

      // Candidate caster set the OLD full-scan would produce.
      const oldSet = [];
      for (const c of commandList) {
        if (c && c.castShadows === true && SHADOWED[c.pass] === 1)
          oldSet.push(c);
      }
      const K = oldSet.length;

      // Camera visibility for each candidate caster (PVS uses a far-plane-
      // dropped culling volume; frameState.cullingVolume is the same source).
      const camCull = fs2?.cullingVolume;
      const occluder =
        scene.mode === C.SceneMode.SCENE3D ? fs2.occluder : undefined;
      let camInvisCasters = 0;
      const camInvisSet = new Set();
      for (const c of oldSet) {
        let vis;
        try {
          vis = scene.isVisible(camCull, c, occluder);
        } catch (e) {
          vis = true;
        }
        if (!vis) {
          camInvisCasters++;
          camInvisSet.add(c);
        }
      }

      // POST: the folded sublist published by PVS.
      const casterCommands = shadowState?.casterCommands;
      const hasSublist = Array.isArray(casterCommands);
      let casterCommandsLen = null;
      let setEqual = null;
      let camInvisInSublist = null;
      if (hasSublist) {
        casterCommandsLen = casterCommands.length;
        const newSet = new Set(casterCommands);
        const oldRefSet = new Set(oldSet);
        // reference set-equality both directions
        let missing = 0;
        for (const c of oldSet) if (!newSet.has(c)) missing++;
        let extra = 0;
        for (const c of casterCommands) if (!oldRefSet.has(c)) extra++;
        setEqual = missing === 0 && extra === 0 && casterCommandsLen === K;
        camInvisInSublist = 0;
        for (const c of casterCommands)
          if (camInvisSet.has(c)) camInvisInSublist++;
      }

      const passLens = [];
      if (shadowState?.shadowMaps) {
        for (const sm of shadowState.shadowMaps) {
          passLens.push((sm.passes || []).map((p) => p.commandList.length));
        }
      }
      const maps = shadowState?.shadowMaps?.length ?? 0;
      const cascades = shadowState?.shadowMaps?.[0]?.passes?.length ?? 0;

      // ROI luminance → umbra count on the in-view wall shadow.
      const canvas = v.canvas;
      const tmp = document.createElement("canvas");
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      const ctx2d = tmp.getContext("2d");
      ctx2d.drawImage(canvas, 0, 0);
      const W = tmp.width,
        H = tmp.height;
      const rx0 = Math.floor(W * 0.18),
        rx1 = Math.floor(W * 0.66);
      const ry0 = Math.floor(H * 0.18),
        ry1 = Math.floor(H * 0.72);
      const roiW = rx1 - rx0,
        roiH = ry1 - ry0;
      const img = ctx2d.getImageData(rx0, ry0, roiW, roiH).data;
      let minLum = 255,
        maxLum = 0;
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
        renderer: scene.context?.isWebGPU ? "webgpu" : "webgl",
        useCsm: scene.useCascadedShadowMaps,
        N,
        K,
        maps,
        cascades,
        casterCommandsLen,
        hasSublist,
        setEqual,
        camInvisCasters,
        camInvisInSublist,
        passLens,
        castDispatches: scene.context?.csmRenderer?._castDispatches ?? null,
        tilesLoaded: scene.globe.tilesLoaded,
        primitives: scene.primitives.length,
        minLum: Math.round(minLum),
        maxLum: Math.round(maxLum),
        umbraCut: Math.round(umbraCut),
        umbraPx,
        roiTotal: roiW * roiH,
      };
    },
    { view: VIEW, clockUTC: FIXED_CLOCK_UTC, useCsm, SHADOWED },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);
  await page.waitForTimeout(300);
  const out = path.join(OUT_DIR, `c10-10-${TAG}-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return { label, out, diagnostics, deviceErrors, messages };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[probe-c10-10-shadow-single-sweep] TAG=${TAG} BASE=${BASE}\n`);

  const cells = [];
  cells.push(
    await capture("a-webgpu-csm", { renderer: "webgpu", useCsm: true }),
  );
  cells.push(
    await capture("b-webgpu-single", { renderer: "webgpu", useCsm: false }),
  );
  cells.push(await capture("c-webgl", { renderer: "webgl", useCsm: false }));

  for (const cell of cells) {
    const d = cell.diagnostics;
    console.log(`  [${cell.label}] renderer=${d.renderer} csm=${d.useCsm}`);
    console.log(
      `    N(commandList)=${d.N} K(casters)=${d.K} maps=${d.maps} cascades=${d.cascades}`,
    );
    console.log(
      `    sublist: has=${d.hasSublist} len=${d.casterCommandsLen} setEqual=${d.setEqual}`,
    );
    console.log(
      `    camInvisCasters=${d.camInvisCasters} camInvisInSublist=${d.camInvisInSublist}`,
    );
    console.log(`    passLens=${JSON.stringify(d.passLens)}`);
    console.log(
      `    castDispatches=${d.castDispatches} umbraPx=${d.umbraPx}/${d.roiTotal} lum[${d.minLum},${d.maxLum},cut=${d.umbraCut}]`,
    );
    console.log(`    tilesLoaded=${d.tilesLoaded} prims=${d.primitives}`);
    if (cell.deviceErrors.length) {
      console.log(`    X ${cell.deviceErrors.length} device errors`);
      cell.deviceErrors
        .slice(0, 3)
        .forEach((e) => console.log(`      ${e.text?.slice(0, 200)}`));
    } else {
      console.log(`    OK no device errors`);
    }
    console.log("");
  }

  const errAll = cells.reduce((s, c) => s + c.deviceErrors.length, 0);
  const umbraOk = cells.every((c) => c.diagnostics.umbraPx > 200);
  // Cast lists populate the same way both backends do: WebGL leaves
  // passes[].commandList populated post-render; WebGPU DRAINS them into a
  // local castCommands array + zeroes them (WebGPUContext:3957-3959), so its
  // "populated" signal is castDispatches>0 / a visible umbra instead.
  const castOk = cells.every((c) => {
    const d = c.diagnostics;
    if (d.renderer === "webgl") {
      return d.passLens.some((sm) => sm.some((n) => n > 0));
    }
    return d.umbraPx > 200; // WebGPU: shadow rendered (list drained on consume)
  });
  // POST-only assertions (sublist present)
  const postCells = cells.filter((c) => c.diagnostics.hasSublist);
  const setEqualOk =
    postCells.length === 0 ||
    postCells.every((c) => c.diagnostics.setEqual === true);
  const inv1Ok =
    postCells.length === 0 ||
    postCells.every(
      (c) =>
        c.diagnostics.camInvisCasters >= 1 &&
        c.diagnostics.camInvisInSublist === c.diagnostics.camInvisCasters,
    );

  console.log("[probe-c10-10-shadow-single-sweep] assertions:");
  console.log(
    `  0 device errors: ${errAll === 0 ? "PASS" : "FAIL"} (${errAll})`,
  );
  console.log(
    `  umbraPx>200 all cells (shadow renders): ${umbraOk ? "PASS" : "FAIL"}`,
  );
  console.log(
    `  cast populated (WebGL lists / WebGPU dispatch): ${castOk ? "PASS" : "FAIL"}`,
  );
  console.log(
    `  [POST] setEqual (fold caster set == old full-scan set): ${postCells.length ? (setEqualOk ? "PASS" : "FAIL") : "N/A (pre)"}`,
  );
  console.log(
    `  [POST] INV-1 off-camera casters preserved: ${postCells.length ? (inv1Ok ? "PASS" : "FAIL") : "N/A (pre)"}`,
  );

  const pass = errAll === 0 && umbraOk && castOk && setEqualOk && inv1Ok;
  console.log(`\n  OVERALL: ${pass ? "PASS" : "FAIL"}`);

  const reportPath = path.join(OUT_DIR, `c10-10-${TAG}-report.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        tag: TAG,
        view: VIEW,
        clock: FIXED_CLOCK_UTC,
        cells: cells.map((c) => ({
          label: c.label,
          screenshot: c.out,
          diagnostics: c.diagnostics,
          deviceErrorCount: c.deviceErrors.length,
        })),
        assertions: { errAll, umbraOk, castOk, setEqualOk, inv1Ok, pass },
      },
      null,
      2,
    ),
  );
  console.log(`  report: ${reportPath}`);
  process.exitCode = pass ? 0 : 1;
})();
