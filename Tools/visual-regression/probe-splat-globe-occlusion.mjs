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
//   (7) CONTROL — a non-splat log-depth producer (PointPrimitive) at the SAME
//       below-surface position stays hidden. Names the subsystem: blue occluded
//       + green leaking = splat-pass-specific; both leaking = the scene
//       framebuffer. Only readable when P3 is green.
//   (P3) POSITIVE CONTROL for (7) — with its depth test disabled the same point
//       MUST paint. Without this, "blue = 0" is equally "correctly occluded"
//       and "never drew", and (7) names the wrong subsystem (C15-G6f).
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
await page.goto(
  `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
  {
    waitUntil: "networkidle",
  },
);
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
  // C15-G3c - hide the viewer chrome. `globePixels` was derived as
  // `nonBlack - red - green`, so every widget pixel counted as globe and
  // check (1) could not fail for "the globe did not render".
  for (const selector of [
    ".cesium-viewer-timelineContainer",
    ".cesium-viewer-animationContainer",
    ".cesium-viewer-bottom",
    ".cesium-viewer-toolbar",
    ".cesium-viewer-fullscreenContainer",
    ".cesium-viewer-navigationContainer",
    ".cesium-navigation-help",
    ".cesium-renderer-toggle",
  ]) {
    const element = document.querySelector(selector);
    if (element) element.style.display = "none";
  }

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
  const redPrim = makeSplatPrim(2000.0, [1.0, 0.05, 0.05]);
  scene.primitives.add(redPrim);
  // GREEN splat 3 km BELOW the surface — must STAY HIDDEN behind the globe
  // (top of the splat is ~2.4 km underground).
  const greenPrim = makeSplatPrim(-3000.0, [0.05, 1.0, 0.05]);
  scene.primitives.add(greenPrim);
  // ── C15-G6e — the DISCRIMINATING CONTROL.
  //
  // A NON-SPLAT primitive at the SAME below-surface position, drawn by a
  // different shipped renderer that is also a renderer-wide log-depth producer
  // (PointPrimitiveCollection, Batch 250). It answers the one question the
  // splat numbers cannot:
  //   blue OCCLUDED + green LEAKING -> the defect is specific to the splat
  //     pass (its depth attachment, its pass placement, or its declared depth
  //     state not being what executes).
  //   blue ALSO LEAKING              -> the globe's depth is not in the buffer
  //     these passes test against at all, and the subject is the scene
  //     framebuffer, not the splat renderer.
  // Either way the next round starts in the right subsystem instead of the
  // one the previous symptom pointed at.
  const points = scene.primitives.add(new C.PointPrimitiveCollection());
  const bluePoint = points.add({
    position: C.Cartesian3.fromDegrees(LON, LAT, -3000.0),
    pixelSize: 60,
    color: new C.Color(0.05, 0.05, 1.0, 1.0),
    disableDepthTestDistance: 0.0,
  });
  const setSplatsVisible = (visible) => {
    redPrim.show = visible;
    greenPrim.show = visible;
    bluePoint.show = visible;
  };

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

  // ── C15-G3c — the GLOBE-ONLY reference frame.
  //
  // Check (3) asserts "the GREEN splat below the surface stays hidden", but a
  // low green count is ALSO what you get when the splat never drew, and a high
  // one is GUARANTEED whenever the globe is not present at the splat's pixels
  // — there is then nothing to be occluded BY. The check had no way to tell
  // those apart, and `globePixels` was derived as `nonBlack - red - green`, so
  // the red splat's own sub-threshold halo and the viewer chrome both counted
  // as "globe" and check (1) could not fail for a missing globe either.
  //
  // So the globe is now measured on its own frame, with both splats hidden,
  // and the verdict is split PER PIXEL:
  //   greenOverGlobe — green pixels that DO have globe behind them. A real
  //                    depth-compare leak. This is the product check.
  //   greenOverVoid  — green pixels with NOTHING behind them. The premise
  //                    failed there; occlusion is not evaluable, and calling
  //                    that a splat defect would file a bug against the wrong
  //                    subsystem.
  setSplatsVisible(false);
  await frame(4);
  const globeOnly = await snap();
  const globeOnlyPixels = count(globeOnly, isNonBlack);

  // ── C15-G6f — the POSITIVE CONTROL check 7 was missing.
  //
  // Check 7 reads `bluePaintedOverGlobe < 50` and calls a LOW count "the
  // non-splat control is correctly occluded". But zero is equally what you get
  // when the PointPrimitive renderer painted nothing at all — a different FR,
  // a different pass slot, a `visibleCount` of 0, a pipeline still compiling.
  // That is the identical vacuity shape `C15-G3c` found in check 3 and
  // `C15-G3b.1` found in the readiness loop: one number, two incompatible
  // causes, no way to separate them. And the cost of getting it wrong is worse
  // here than anywhere else in this probe, because check 7's WHOLE job is to
  // name the subsystem the next round works in — a vacuous GREEN sends that
  // round into the splat renderer when the evidence actually says "the globe's
  // depth is not in the buffer these passes test against".
  //
  // So: show ONLY the point, with its depth test DISABLED. It then has nothing
  // that can hide it, and it MUST paint. If it does not, the instrument cannot
  // see its own control and check 7 is not evaluable — STRUCTURAL, not a
  // product verdict, exactly like P1/P2.
  // The FRAME is captured here (render order is fixed); the pixels are counted
  // below, with `PAINT_DELTA` — the SAME sensitivity check 7 is scored at. A
  // control measured at a different threshold than the check it certifies
  // certifies nothing.
  bluePoint.show = true;
  bluePoint.disableDepthTestDistance = Number.POSITIVE_INFINITY;
  await frame(4);
  const bluePositive = await snap();
  bluePoint.disableDepthTestDistance = 0.0;
  bluePoint.show = false;
  await frame(2);

  setSplatsVisible(true);
  await frame(4);

  const img = await snap();
  const red = count(img, isRed);
  const green = count(img, isGreen);
  const nonBlack = count(img, isNonBlack);
  const globePixels = globeOnlyPixels;
  // ── C15-G3d — classify by the DELTA against the globe-only frame.
  //
  // `isRed`/`isGreen` are ABSOLUTE predicates, and both of their premises were
  // accidents of the Batch-882 scene (splats over BLACK). With the globe
  // actually present they misreport in both directions:
  //   * the GridImageryProvider's own pale-green lines satisfy `isGreen`, so
  //     globe pixels count as leaked splat;
  //   * the RED splat over the olive globe, veiled by the GREEN splat drawn on
  //     top of it, lands at r≈149/g≈98 — just outside `isRed` (r>150) AND just
  //     outside `isGreen` (g<90). It reads as 33 px of "red" while the PNG
  //     plainly shows it composing over the globe.
  // Differencing against the globe-only frame and classifying by which channel
  // MOVED is background-independent and cannot count the globe as a splat.
  const PAINT_DELTA = 12;
  const paintedBy = (i) => {
    const dr = img.data[i] - globeOnly.data[i];
    const dg = img.data[i + 1] - globeOnly.data[i + 1];
    const db = img.data[i + 2] - globeOnly.data[i + 2];
    if (Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db)) < PAINT_DELTA) {
      return null;
    }
    if (db >= dr && db >= dg) return "blue";
    if (dr >= dg && dr >= db) return "red";
    if (dg >= dr && dg >= db) return "green";
    return "other";
  };
  // C15-G6f — the positive control, scored with `PAINT_DELTA`, the same
  // sensitivity as check 7 below. Blue-dominant delta against the globe-only
  // frame, on the frame where the point could not be occluded by anything.
  let bluePositiveControlPx = 0;
  for (let p = 0; p < bluePositive.w * bluePositive.h; p++) {
    const i = 4 * p;
    const dr = bluePositive.data[i] - globeOnly.data[i];
    const dg = bluePositive.data[i + 1] - globeOnly.data[i + 1];
    const db = bluePositive.data[i + 2] - globeOnly.data[i + 2];
    if (Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db)) < PAINT_DELTA) {
      continue;
    }
    if (db >= dr && db >= dg) bluePositiveControlPx++;
  }
  let redPainted = 0;
  let greenPaintedOverGlobe = 0;
  let greenPaintedOverVoid = 0;
  let bluePaintedOverGlobe = 0;
  let greenOverGlobe = 0;
  let greenOverVoid = 0;
  for (let p = 0; p < img.w * img.h; p++) {
    const i = 4 * p;
    if (!isGreen(img.data, i)) continue;
    if (isNonBlack(globeOnly.data, i)) {
      greenOverGlobe++;
    } else {
      greenOverVoid++;
    }
  }
  // Same split for RED, so check (2) also stops being satisfiable by a splat
  // drawn over empty space rather than composed over the globe.
  let redOverGlobe = 0;
  for (let p = 0; p < img.w * img.h; p++) {
    const i = 4 * p;
    if (isRed(img.data, i) && isNonBlack(globeOnly.data, i)) redOverGlobe++;
    const painted = paintedBy(i);
    if (painted === "blue") {
      if (isNonBlack(globeOnly.data, i)) bluePaintedOverGlobe++;
    } else if (painted === "red") {
      redPainted++;
    } else if (painted === "green") {
      if (isNonBlack(globeOnly.data, i)) {
        greenPaintedOverGlobe++;
      } else {
        greenPaintedOverVoid++;
      }
    }
  }

  // ── C15-G3d — the log-depth inputs BOTH producers encode from.
  //
  // Two splats at 6 km and 11 km with the globe at 8 km between them: the near
  // one composes and the far one leaks, i.e. every splat fragment beats the
  // globe. That is an ENCODE-SPACE mismatch (the splat's depth is uniformly
  // smaller), not a flipped compare — a flipped compare would hide the NEAR
  // splat, and the near splat is not hidden. These fields are what the next
  // run needs to name which mismatch it is, in one run instead of three.
  const usAny = ctx.uniformState;
  const logDepth = {
    logDepthWriteEnabled: ctx._logDepthWriteEnabled ?? null,
    useLogDepth: scene.frameState?.useLogDepth ?? null,
    currentFrustumNear: usAny?.currentFrustum?.x ?? null,
    currentFrustumFar: usAny?.currentFrustum?.y ?? null,
    oneOverLog2FarDepthFromNearPlusOne:
      usAny?.oneOverLog2FarDepthFromNearPlusOne ?? null,
    stashedEncodeNearFar: usAny?._logDepthEncodeNearFar
      ? Array.from(usAny._logDepthEncodeNearFar)
      : null,
    stashedEncodeFactor: usAny?._logDepthEncodeFactor ?? null,
  };

  // ── C15-G6g — the pair each producer ACTUALLY BAKED, read back from the
  // producers themselves (`recordLogDepthEncoder`).
  //
  // Every previous round argued from one of two quantities, and neither
  // decides the depth compare: the FIELDS each producer reads (proven
  // character-identical at `C15-G3d` — which says nothing about their values),
  // and a post-render sample of `uniformState` (which holds the LAST FRUSTUM
  // SLICE, not what anyone packed during the update phase). The deciding
  // quantity is the baked `(near, factor)`, and the producers DISAGREE in
  // source about which pair it should be: the collections fleet + the depth
  // plane prefer the stashed full-camera-frustum encode, while the globe and
  // the splat read the live `currentFrustum`. They coincide only while nothing
  // re-slices the frustum between their packs.
  //
  // Reconstructing each producer's frag_depth at the probe's own geometry from
  // its OWN baked pair turns the whole question into three numbers that either
  // interleave correctly or do not.
  const baked = usAny?._diagLogDepthEncoders ?? null;
  const encodeWith = (pair, eyeDistance) =>
    pair ? Math.log2(eyeDistance - pair[0] + 1.0) * pair[2] : null;
  const bakedVerdict = baked
    ? {
        splat: baked.splat ?? null,
        globe: baked.globe ?? null,
        collection: baked.collection ?? null,
        // Camera is 8 km nadir: globe surface 8 km away, red splat 6 km,
        // green splat and the blue control both 11 km.
        globeAt8km: encodeWith(baked.globe, 8000),
        redSplatAt6km: encodeWith(baked.splat, 6000),
        greenSplatAt11km: encodeWith(baked.splat, 11000),
        bluePointAt11km: encodeWith(baked.collection, 11000),
      }
    : null;

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
    greenOverGlobe,
    greenOverVoid,
    redPainted,
    greenPaintedOverGlobe,
    greenPaintedOverVoid,
    bluePaintedOverGlobe,
    bluePositiveControlPx,
    redOverGlobe,
    logDepth,
    bakedVerdict,
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
let structural = false;
const check = (label, pass, detail) => {
  console.log(`(${label}) ${detail} ${pass ? "OK" : "FAIL"}`);
  if (!pass) ok = false;
};
// C15-G3c — a precondition the run cannot evaluate its subject without.
// STRUCTURAL is never a product verdict and never a pass: exit 3, so "the
// globe was not there" can never be mistaken for either "the splat leaked"
// or "the splat was correctly occluded".
const precondition = (label, pass, detail) => {
  console.log(`(${label}) ${detail} ${pass ? "OK" : "STRUCTURAL"}`);
  if (!pass) structural = true;
};

check(
  "1",
  out.globePixels > 20000 && out.tilesLoaded,
  `globe rendered under nadir camera: globePixels=${out.globePixels} (measured on a SPLATS-HIDDEN frame with the viewer chrome hidden, not derived by subtraction) tilesLoaded=${out.tilesLoaded}`,
);
precondition(
  "P1",
  out.greenPaintedOverVoid === 0,
  `the globe covers every pixel the BELOW-surface splat paints (occlusion is only evaluable where there is something to be occluded by): greenPaintedOverVoid=${out.greenPaintedOverVoid} px of ${out.greenPaintedOverGlobe + out.greenPaintedOverVoid} green-painted px`,
);
check(
  "2",
  out.redPainted > 2000,
  `RED splat (2 km ABOVE surface) is RENDERED, not dropped (the C7-SPLAT-DEPTH-COMPOSE guard): redPaintedPx=${out.redPainted} (absolute-predicate redPx=${out.red}, which the C15-G3d note explains is not a rendering measurement over a coloured globe)`,
);
precondition(
  "P2",
  out.redPainted > 2000 && out.globePixels > 20000,
  `...and it is COMPOSED OVER the globe rather than over empty space, which is the half of check 2 that needs a globe to be evaluable: redPainted=${out.redPainted}, globePixels=${out.globePixels}`,
);
check(
  "3",
  out.greenPaintedOverGlobe < 50,
  `GREEN splat (3 km BELOW surface) stays HIDDEN where the globe is behind it: greenPaintedOverGlobe=${out.greenPaintedOverGlobe} (delta-classified, so the globe's own green grid lines cannot be counted as leaked splat; the absolute-predicate figures were greenOverGlobe=${out.greenOverGlobe}/greenOverVoid=${out.greenOverVoid})`,
);
precondition(
  "P3",
  out.bluePositiveControlPx > 500,
  `POSITIVE CONTROL for check 7: with its depth test DISABLED the PointPrimitive control PAINTS: bluePositiveControlPx=${out.bluePositiveControlPx}. ` +
    `A zero here means the control never reached the canvas, so check 7's low count says NOTHING about occlusion and its subsystem verdict is void — ` +
    `read the run as "both leaking" (the scene framebuffer is the subject), not as "splat-pass-specific".`,
);
check(
  "7",
  out.bluePaintedOverGlobe < 50,
  `CONTROL: a non-splat log-depth producer (PointPrimitive) at the SAME 3 km below-surface position stays HIDDEN: bluePaintedOverGlobe=${out.bluePaintedOverGlobe}. ` +
    `If this is GREEN while check 3 is RED, the defect is specific to the splat pass; if BOTH are RED the globe's depth is not in the buffer these passes test against and the subject is the scene framebuffer, not the splat renderer. ` +
    `THIS VERDICT IS ONLY READABLE WITH P3 GREEN — see P3.`,
);
console.log(
  `(diag) log depth — writeEnabled=${out.logDepth.logDepthWriteEnabled} useLogDepth=${out.logDepth.useLogDepth} ` +
    `currentFrustum=[${out.logDepth.currentFrustumNear}, ${out.logDepth.currentFrustumFar}] ` +
    `factor=${out.logDepth.oneOverLog2FarDepthFromNearPlusOne} ` +
    `stashedNearFar=${JSON.stringify(out.logDepth.stashedEncodeNearFar)} stashedFactor=${out.logDepth.stashedEncodeFactor} ` +
    `numFrustums=${out.numFrustums}`,
);
// ── C15-G6g — the BAKED-PAIR diagnostic, and the arithmetic it settles.
//
// This is the first time the three producers' OWN baked `(near, far, factor)`
// triples are on the same line. Read it like this:
//   * all three triples EQUAL          → the encode really is common, the
//     depth ordering below must be correct, and a leak convicts the pass;
//   * splat differs from globe         → the splat's frag_depth is on a
//     different curve; `greenSplatAt11km < globeAt8km` is then the leak,
//     arithmetically, and the fix is to put the splat on the fleet's side of
//     the stash-vs-live rule (see NEW-SPLAT-LOG-DEPTH-ENCODE-SOURCE-SPLIT);
//   * collection differs from globe    → the CONTROL is the odd one out and
//     check 7's asymmetry is an artefact of the control, not of the splat.
if (out.bakedVerdict) {
  const fmt = (t) => (t ? `[${t[0]}, ${t[1]}, ${t[2]}]` : "MISSING");
  const bv = out.bakedVerdict;
  console.log(
    `(diag) baked encode triples (near, far, factor) — ` +
      `splat=${fmt(bv.splat)} globe=${fmt(bv.globe)} collection=${fmt(bv.collection)}`,
  );
  console.log(
    `(diag) reconstructed frag_depth from each producer's OWN baked pair — ` +
      `globe@8km=${bv.globeAt8km} redSplat@6km=${bv.redSplatAt6km} ` +
      `greenSplat@11km=${bv.greenSplatAt11km} bluePoint@11km=${bv.bluePointAt11km}`,
  );
  const leaks = (d) =>
    d !== null && bv.globeAt8km !== null && d <= bv.globeAt8km;
  console.log(
    `(diag) predicted under less-equal — red composes=${leaks(bv.redSplatAt6km)} ` +
      `green LEAKS=${leaks(bv.greenSplatAt11km)} blue LEAKS=${leaks(bv.bluePointAt11km)} ` +
      `(measured: green ${out.greenPaintedOverGlobe >= 50 ? "LEAKS" : "hidden"}, ` +
      `blue ${out.bluePaintedOverGlobe >= 50 ? "LEAKS" : "hidden"}) — ` +
      `prediction MATCHES measurement -> the ENCODE is convicted; ` +
      `prediction says hidden but it LEAKS -> the encode is exonerated with ` +
      `numbers (not inference) and the PASS is convicted`,
  );
} else {
  console.log(
    `(diag) baked encode triples UNAVAILABLE — recordLogDepthEncoder did not ` +
      `run (release build with pragmas stripped, or a producer did not pack ` +
      `this frame). The encode question is NOT answered by this run.`,
  );
}
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

if (!ok) {
  console.log("FAIL");
} else if (structural) {
  console.log(
    "INCOMPLETE (structural) — a precondition failed, so at least one check " +
      "could not see its subject. That is an instrument gap owed as follow-up, " +
      "NOT a product verdict and NOT a pass.",
  );
} else {
  console.log("PASS");
}
await browser.close();
process.exit(ok ? (structural ? 3 : 0) : 1);
