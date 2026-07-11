#!/usr/bin/env node
// Probe (C7-SPLAT-DEPTH-COMPOSE) — WebGPU Gaussian splats must COMPOSE over
// the opaque globe (not vanish), and a splat genuinely behind the surface
// must STAY hidden.
//
// ROOT CAUSE the fix addressed (2026-07-09): the frustum loop unconditionally
// deferred splat commands with an `_oitPipeline` to the OIT translucent pass
// (GS-WSR), but `executeTranslucentPass` early-returned when the frame had
// zero TRANSLUCENT commands — the deferred splats were silently DROPPED every
// frame. That presented as "the splat is occluded by the opaque globe"
// (it rendered only in scenes that happened to race the async OIT pipeline
// resolve). WebGL parity executes GAUSSIAN_SPLATS inline in the scene pass
// (SceneRenderer.js `performGaussianSplatPass`) and never routes splats
// through OIT; the deferral is now opt-in (`_splatOITDeferral`, default
// false) and a never-drop seatbelt renders any deferred splats inline.
//
// Uses the synthetic FR-driven splat interface (`_splatData`) — the live
// WebGPU splat data path. (Real GaussianSplatPrimitive tilesets do not yet
// produce `_splatData`/`_renderResources.splatBuffer` for the FR — tracked
// separately as NEW-SPLAT-TILESET-PRODUCER-BRIDGE in DEFERRED_WORK.md.)
//
// Checks:
//   (1) globe rendered (opaque surface present under nadir camera).
//   (2) RED splat 2 km ABOVE the surface renders OVER the globe (>2000 px).
//   (3) GREEN splat 3 km BELOW the surface STAYS HIDDEN (<50 px) — depth
//       test against the globe works (the fix is not "always on top").
//   (4) no deferred-splat leak (`_deferredOITSplats` null after a frame).
//   (5) opt-in deferral armed (`_splatOITDeferral = true`): the never-drop
//       seatbelt still renders the splat inline (>2000 px, no drop).
//   (6) zero console/WebGPU validation errors.
//
// Usage: node Tools/visual-regression/probe-splat-globe-occlusion.mjs
// Env:   PROBE_BASE (default http://localhost:8080)
// Out:   Tools/visual-regression/output/splat-occlusion-{default,deferral-armed}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
const errors = [];
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error") {
    errors.push(t);
  } else if (
    m.type() === "warning" &&
    /Invalid CommandBuffer|Attachment state|not compatible|validation/i.test(t)
  ) {
    errors.push(`validation: ${t.split("\n")[0]}`);
  }
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  const ctx = scene.context;
  v.clock.shouldAnimate = false;

  scene.globe.show = true;
  scene.imageryLayers.removeAll();
  scene.imageryLayers.addImageryProvider(
    new C.GridImageryProvider({ cells: 4 }),
  );
  scene.globe.baseColor = new C.Color(0.35, 0.25, 0.15, 1.0);
  scene.globe.showGroundAtmosphere = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  scene.backgroundColor = C.Color.BLACK;
  scene.fog.enabled = false;

  await ctx.getFeatureRendererAsync(16);

  const LON = -75.0;
  const LAT = 40.0;
  const R = 600.0;
  const R2 = R * R;
  const FLOATS = 16;

  const makeSplatPrim = (alt, color) => {
    const data = new Float32Array(FLOATS);
    const pos = C.Cartesian3.fromDegrees(LON, LAT, alt);
    const enc = C.EncodedCartesian3.fromCartesian(pos, {
      high: new C.Cartesian3(),
      low: new C.Cartesian3(),
    });
    data[0] = enc.high.x;
    data[1] = enc.high.y;
    data[2] = enc.high.z;
    data[3] = enc.low.x;
    data[4] = enc.low.y;
    data[5] = enc.low.z;
    data[6] = R2;
    data[7] = 0;
    data[8] = 0;
    data[9] = R2;
    data[10] = 0;
    data[11] = R2;
    data[12] = color[0];
    data[13] = color[1];
    data[14] = color[2];
    data[15] = 0.95;
    return {
      show: true,
      modelMatrix: C.Matrix4.IDENTITY,
      _splatData: data,
      _splatCount: 1,
      _webgpuCache: undefined,
      update(frameState) {
        const fr = frameState.context.getFeatureRenderer(16);
        if (fr) fr.update(this, frameState);
      },
      isDestroyed() {
        return false;
      },
      destroy() {},
    };
  };

  // RED splat 2 km ABOVE the ellipsoid surface — must render OVER the globe.
  scene.primitives.add(makeSplatPrim(2000.0, [1.0, 0.05, 0.05]));
  // GREEN splat 3 km BELOW the surface — must STAY HIDDEN behind the globe
  // (top of the splat is ~2.4 km underground).
  scene.primitives.add(makeSplatPrim(-3000.0, [0.05, 1.0, 0.05]));

  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(LON, LAT, 8000.0),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });

  const frame = async (n) => {
    for (let i = 0; i < n; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  };

  // Let the globe surface settle so its depth is real. `tilesLoaded` fires
  // several frames BEFORE the WebGPU globe color/depth actually lands on the
  // canvas (async imagery + sceneFB warm-up), so gate on real non-black
  // pixels, not just the flag.
  const canvasNonBlack = () => {
    const c = scene.canvas;
    const off = document.createElement("canvas");
    off.width = c.width;
    off.height = c.height;
    const cx = off.getContext("2d");
    cx.drawImage(c, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let p = 0; p < c.width * c.height; p++) {
      const i = 4 * p;
      if (d[i] + d[i + 1] + d[i + 2] > 30) n++;
    }
    return n;
  };
  for (let t = 0; t < 160 && !scene.globe.tilesLoaded; t++) {
    await frame(2);
  }
  for (let t = 0; t < 120 && canvasNonBlack() < 200000; t++) {
    await frame(4);
  }
  await frame(20);

  const snap = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        const c = scene.canvas;
        const off = document.createElement("canvas");
        off.width = c.width;
        off.height = c.height;
        const cx = off.getContext("2d");
        cx.drawImage(c, 0, 0);
        resolve({
          data: cx.getImageData(0, 0, c.width, c.height).data,
          w: c.width,
          h: c.height,
        });
      });
      scene.render();
    });

  const count = (img, pred) => {
    let n = 0;
    for (let p = 0; p < img.w * img.h; p++) if (pred(img.data, 4 * p)) n++;
    return n;
  };
  const isRed = (d, i) => d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90;
  const isGreen = (d, i) => d[i + 1] > 150 && d[i] < 90 && d[i + 2] < 90;
  const isNonBlack = (d, i) => d[i] + d[i + 1] + d[i + 2] > 30;

  const img = await snap();
  const red = count(img, isRed);
  const green = count(img, isGreen);
  const nonBlack = count(img, isNonBlack);
  const globePixels = nonBlack - red - green;

  const sr = scene._alternateSceneRenderer;
  const deferredLeak = !!sr?._deferredOITSplats;
  const tilesLoaded = scene.globe.tilesLoaded;

  // (5) Arm the opt-in GS-WSR deferral: the never-drop seatbelt must render
  // the deferred splats inline (zero-TRANSLUCENT frame) instead of dropping.
  let redArmed = -1;
  let deferredLeakArmed = null;
  if (sr) {
    sr._splatOITDeferral = true;
    await frame(10);
    const imgArmed = await snap();
    redArmed = count(imgArmed, isRed);
    deferredLeakArmed = !!sr._deferredOITSplats;
    sr._splatOITDeferral = false;
    await frame(5);
  }

  return {
    red,
    green,
    nonBlack,
    globePixels,
    deferredLeak,
    tilesLoaded,
    redArmed,
    deferredLeakArmed,
    numFrustums: (scene._view?.frustumCommandsList ?? []).length,
  };
});

fs.mkdirSync(OUT_DIR, { recursive: true });
const canvas = page.locator("canvas").first();
await canvas.screenshot({
  path: path.join(OUT_DIR, "splat-occlusion-default.png"),
});

let ok = true;
const check = (label, pass, detail) => {
  console.log(`(${label}) ${detail} ${pass ? "OK" : "FAIL"}`);
  if (!pass) ok = false;
};

check(
  "1",
  out.globePixels > 20000 && out.tilesLoaded,
  `globe rendered under nadir camera: globePixels=${out.globePixels} tilesLoaded=${out.tilesLoaded}`,
);
check(
  "2",
  out.red > 2000,
  `RED splat (2 km ABOVE surface) composes OVER the opaque globe: redPx=${out.red} (pre-fix: 0)`,
);
check(
  "3",
  out.green < 50,
  `GREEN splat (3 km BELOW surface) stays HIDDEN behind the globe: greenPx=${out.green}`,
);
check(
  "4",
  out.deferredLeak === false,
  `no deferred-splat leak on the default path: _deferredOITSplats set=${out.deferredLeak}`,
);
check(
  "5",
  out.redArmed > 2000 && out.deferredLeakArmed === false,
  `opt-in deferral armed: never-drop seatbelt renders inline: redPx=${out.redArmed}, leak=${out.deferredLeakArmed}`,
);
check("6", errors.length === 0, `console/validation errors: ${errors.length}`);
if (errors.length) {
  for (const e of errors.slice(0, 8)) console.log(`  ERR: ${e}`);
}

console.log(ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
