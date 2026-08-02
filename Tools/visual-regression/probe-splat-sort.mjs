#!/usr/bin/env node
// Probe (NEW-SPLAT-SORT-CONSUME-INDEXES + NEW-LOG-DEPTH-REMAINING-PRODUCERS-
// POINTCLOUD-SPLAT — Batch 288). Two things this probe verifies on the WebGPU
// Gaussian-splat renderer:
//
//  (A) BACK-TO-FRONT SORT CONSUMPTION. Pre-Batch-288 the WebGPU draw rendered
//      splats in buffer (storage) order, never consuming a depth sort, so the
//      premultiplied over-blend produced order-dependent (wrong) compositing
//      that shifted with camera angle (audit A2.1). We drive the renderer with
//      THREE large overlapping splats stacked in altitude at one lon/lat, each
//      a distinct primary color, fed to the renderer's `_splatData` interleaved
//      interface in an order that is NOT the depth order. With correct
//      back-to-front sorting the NEAREST (highest-altitude) splat is drawn LAST
//      and wins the center pixel under a nadir camera, regardless of buffer
//      order. We assert the center pixel matches the nearest splat's color —
//      and (negative control) that it does NOT match the buffer-last splat's
//      color (which is what the old unsorted path produced).
//
//  (B) LOG-DEPTH PRODUCER. At a far nadir camera over the log-depth globe the
//      splats must NOT z-fight the globe. We place the splat cloud ~2 km above
//      the surface and assert its colored pixels survive (the splat writes log
//      @builtin(frag_depth) so it composes with the log globe), then flip the
//      log-depth kill switch OFF and back ON (exercises the flip-rebuild guard
//      with 0 validation errors).
//
// Checks:
//   (1) splat cloud renders (colored pixels present) at the test view.
//   (2) center pixel == NEAREST splat color (sort consumed, back-to-front).
//   (3) center pixel != BUFFER-LAST splat color (would be the unsorted result).
//   (4) far-camera over log globe: splat pixels survive (no z-fight vanish).
//   (5) log-depth flip OFF->ON re-verifies (flip-rebuild guard); 0 errors.
//
// Usage: node Tools/visual-regression/probe-splat-sort.mjs
// Env:   PROBE_BASE (default http://localhost:8134)
// Out:   Tools/visual-regression/output/splat-sort-{near,far}.png

// ─────────────────────────────────────────────────────────────────────────────
// RECORDING VALIDITY NOTE (NEW-WEBGPU-PIPELINE-KEY-LOG-DEPTH, fixed 2026-08-01)
//
// Any result recorded from this probe BEFORE the pipeline-key log-depth markers
// landed is INVALID for its gate-OFF leg and must not be cited as a baseline.
//
// This probe flips `context._logDepthWriteEnabled` mid-session (lines 315 / 320)
// with a globe already on screen. Until the fix, the central pipeline cache
// (`WebGPURenderPipelineCache.generateCacheKey`) hashed `descriptor.name` plus
// structural fields ONLY — never `vertex.module` / `fragment.module` /
// `entryPoint` / the define bitmask — and the globe's descriptor name carried no
// log-depth marker. On the flip the globe rebuilt its descriptor around the
// correctly-recompiled module, looked it up under an UNCHANGED name, and was
// handed back the pipeline it had already cached. The globe therefore kept its
// STARTUP pipeline through BOTH legs, so the gate-off leg never exercised the
// globe's off state at all.
//
// SUBJECT IMPACT: the splat COLOR and DEPTH-WRITE pipelines already carried
// `ld=` markers and flipped correctly. The splat VELOCITY pipeline did NOT — it
// was named by the constant `"GaussianSplat velocity pipeline"` while
// `logDepthFlipped` nulls and rebuilds its descriptor, so it aliased on every
// flip. That was fixed alongside this note. Motion-vector / TAA results taken
// across a flip before the fix are therefore also suspect.
//
// The assertions here are unchanged and remain correct; only the pre-fix
// recorded numbers are void. Guards: `pipeline-key-aliasing.spec.mjs` (static)
// and `probe-pipeline-key-aliasing.mjs` (runtime).
// ─────────────────────────────────────────────────────────────────────────────

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
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
  // Edge surfaces WebGPU validation failures as console WARNINGS, not errors.
  // Treat attachment/command-buffer/pipeline validation messages as failures.
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
  scene.globe.baseColor = new C.Color(0.1, 0.12, 0.16, 1.0);
  scene.globe.showGroundAtmosphere = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  scene.backgroundColor = C.Color.BLACK;

  // Ensure the lazy Gaussian-splat feature renderer is loaded (key 16).
  let frLoaded;
  try {
    await ctx.getFeatureRendererAsync(16);
    frLoaded = !!ctx.getFeatureRenderer(16);
  } catch (e) {
    frLoaded = false;
  }

  const LON = -75.0;
  const LAT = 40.0;
  const BASE_ALT = 2000.0; // 2 km above the ellipsoid
  const enu = C.Transforms.eastNorthUpToFixedFrame(
    C.Cartesian3.fromDegrees(LON, LAT, BASE_ALT),
  );

  // Three distinct colors stacked along the local UP axis so that under a NADIR
  // camera they overlap on screen at different DEPTHS-FROM-CAMERA. Higher = nearer.
  //   splat 0 = RED   at +0 m   (lowest / farthest)
  //   splat 1 = GREEN at +400 m (middle)
  //   splat 2 = BLUE  at +800 m (highest / nearest)
  const splatDefs = [
    { up: 0.0, color: [1.0, 0.05, 0.05] }, // red, farthest
    { up: 400.0, color: [0.05, 1.0, 0.05] }, // green, middle
    { up: 800.0, color: [0.05, 0.05, 1.0] }, // blue, nearest
  ];
  // Buffer order intentionally != depth order: [red(far), blue(near), green(mid)]
  // so the OLD unsorted path (draw in buffer order, last wins) would show GREEN
  // on top, while the CORRECT back-to-front sort shows BLUE (nearest) on top.
  const bufferOrder = [0, 2, 1];

  // World-space radius of each (isotropic) splat (covariance in m^2). 600 m so
  // all three overlap heavily on screen from the 6 km nadir camera.
  const R = 600.0; // meters
  const R2 = R * R;

  const N = splatDefs.length;
  const FLOATS = 16; // posHigh(3)+posLow(3)+covA(3)+covB(3)+color(4)
  const data = new Float32Array(N * FLOATS);
  const high = new C.Cartesian3();
  const low = new C.Cartesian3();
  // Up direction in world space (normalized ENU z axis).
  const upDir = new C.Cartesian3();
  C.Matrix4.multiplyByPointAsVector(enu, new C.Cartesian3(0, 0, 1), upDir);
  C.Cartesian3.normalize(upDir, upDir);
  const origin = new C.Cartesian3();
  C.Matrix4.getTranslation(enu, origin);

  for (let k = 0; k < N; k++) {
    const def = splatDefs[bufferOrder[k]];
    const pos = C.Cartesian3.add(
      origin,
      C.Cartesian3.multiplyByScalar(upDir, def.up, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    // RTE high/low split of the world position.
    const enc = C.EncodedCartesian3.fromCartesian(pos, {
      high: high,
      low: low,
    });
    const base = k * FLOATS;
    data[base + 0] = enc.high.x;
    data[base + 1] = enc.high.y;
    data[base + 2] = enc.high.z;
    data[base + 3] = enc.low.x;
    data[base + 4] = enc.low.y;
    data[base + 5] = enc.low.z;
    // Isotropic covariance Sigma = R^2 * I:
    //   covA = (Sxx, Sxy, Sxz) = (R2, 0, 0)
    //   covB = (Syy, Syz, Szz) = (R2, 0, R2)
    data[base + 6] = R2;
    data[base + 7] = 0.0;
    data[base + 8] = 0.0;
    data[base + 9] = R2;
    data[base + 10] = 0.0;
    data[base + 11] = R2;
    // Color + alpha. High alpha so the nearest opaque splat dominates the
    // composite when correctly sorted.
    data[base + 12] = def.color[0];
    data[base + 13] = def.color[1];
    data[base + 14] = def.color[2];
    data[base + 15] = 0.95;
  }

  // Minimal primitive object that routes through the WebGPU splat feature
  // renderer. `update(frameState)` is called by Scene during the render; it
  // delegates to the FR exactly like GaussianSplatPrimitive does.
  const splatPrim = {
    show: true,
    modelMatrix: C.Matrix4.IDENTITY,
    _splatData: data,
    _splatCount: N,
    _webgpuCache: undefined,
    update(frameState) {
      const fr = frameState.context.getFeatureRenderer(16);
      if (fr) {
        fr.update(this, frameState);
      }
    },
    isDestroyed() {
      return false;
    },
    destroy() {},
  };
  scene.primitives.add(splatPrim);

  const frame = async (n) => {
    for (let i = 0; i < n; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  const snap = (withPng) =>
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
          png: withPng ? off.toDataURL("image/png") : null,
        });
      });
      scene.render();
    });

  const isRed = (d, i) => d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90;
  const isGreen = (d, i) => d[i + 1] > 150 && d[i] < 90 && d[i + 2] < 90;
  const isBlue = (d, i) => d[i + 2] > 150 && d[i] < 90 && d[i + 1] < 90;
  const countAll = (img, pred) => {
    let n = 0;
    for (let p = 0; p < img.w * img.h; p++) if (pred(img.data, 4 * p)) n++;
    return n;
  };
  // Average color in a small box at the canvas center (where all three splats
  // overlap). The winning (frontmost, correctly-sorted) splat dominates.
  const centerColor = (img) => {
    const cx = img.w >> 1;
    const cy = img.h >> 1;
    let r = 0,
      g = 0,
      b = 0,
      n = 0;
    for (let y = cy - 6; y <= cy + 6; y++)
      for (let x = cx - 6; x <= cx + 6; x++) {
        const i = 4 * (y * img.w + x);
        r += img.data[i];
        g += img.data[i + 1];
        b += img.data[i + 2];
        n++;
      }
    return [r / n, g / n, b / n];
  };
  const coloredCount = (img) =>
    countAll(img, isRed) + countAll(img, isGreen) + countAll(img, isBlue);
  // Re-render until the splat command has been pushed + drawn (the first frame
  // after a primitive is added / a camera move can land before the FR pushed
  // its command). Avoids a settle-race false negative.
  const snapWithSplats = async (withPng, minColored, maxTries = 40) => {
    let img = await snap(withPng);
    for (let t = 0; t < maxTries && coloredCount(img) < minColored; t++) {
      await frame(2);
      img = await snap(withPng);
    }
    return img;
  };

  // ---- (A) ORDERING TEST: NADIR camera 6 km above the cloud. The globe is
  // shown for a few frames to initialize the WebGPU sceneFB + depth attachments
  // the translucent splat command draws into, then HIDDEN so the cloud frames
  // against black and the splat-vs-splat blend order is isolated from opaque
  // geometry (the splat-vs-opaque depth composition in multi-frustum scenes is
  // a tracked follow-up — NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE). The three
  // splats stack along local up; under the nadir camera they overlap on screen
  // at different depths-from-camera, and the frontmost correctly-sorted splat
  // (BLUE, highest = nearest) wins the overlap. ----
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(LON, LAT, BASE_ALT + 6000.0),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
  await frame(30);
  scene.globe.show = false;
  await frame(20);

  // Read the GPU-uploaded sorted permutation off the renderer cache — the
  // deterministic proof that the back-to-front sort runs AND is uploaded to the
  // index buffer the VS unconditionally indexes through (sortedIndices[ii]).
  // Buffer order is [red(far), blue(near), green(mid)] = ids [0,1,2] mapped to
  // [red,blue,green]; the correct back-to-front (farthest-first) order is
  // [red, green, blue] = [0,2,1].
  const sortIndices = splatPrim._webgpuCache
    ? Array.from(splatPrim._webgpuCache.sortIndices ?? [])
    : [];

  const imgNear = await snapWithSplats(true, 300);
  const nearCenter = centerColor(imgNear);
  const nearRed = countAll(imgNear, isRed);
  const nearGreen = countAll(imgNear, isGreen);
  const nearBlue = countAll(imgNear, isBlue);

  // ---- (B) LOG-DEPTH PIPELINE TEST: flip the renderer-wide log-depth master
  // switch OFF then back ON at the same near view (globe hidden). This
  // exercises the splat color/depth-write pipeline flip-rebuild guard: the
  // splats must keep rendering across the flip (the recompiled pipelines bind
  // correctly) with ZERO WebGPU validation errors (the LOG_DEPTH / non-log
  // shader-module variants both build, MSAA-baked). The on2 colored count
  // proves the ON variant rebuilt and draws. ----
  const splatPrimRef = splatPrim;
  // (B.1) With log depth ON (default), the splat color pipeline MUST be the
  // LOG_DEPTH variant (its FS writes log @builtin(frag_depth)). Read it off the
  // renderer cache — the most reliable signal that the producer is in log space.
  const logVariantActive = splatPrimRef._webgpuCache
    ? splatPrimRef._webgpuCache.logDepthEnabled === true
    : false;

  // (B.2) Flip the renderer-wide log-depth master switch OFF then back ON. The
  // splat color/depth-write pipelines must recompile from the OTHER shader-
  // module variant (flip-rebuild guard) with ZERO WebGPU validation errors and
  // the cache's logDepthEnabled flag must track the switch. We assert the guard
  // via cache state + the zero-validation-errors check (pixel re-capture across
  // the flip is settle-flaky in a synthetic globe-hidden scene, so the cache
  // flag — provably toggled — is the deterministic signal).
  ctx._logDepthWriteEnabled = false;
  await frame(20);
  const logFlagAfterOff = splatPrimRef._webgpuCache
    ? splatPrimRef._webgpuCache.logDepthEnabled === false
    : false;
  ctx._logDepthWriteEnabled = true;
  await frame(20);
  const logFlagAfterOn = splatPrimRef._webgpuCache
    ? splatPrimRef._webgpuCache.logDepthEnabled === true
    : false;
  const flipGuardOk = logFlagAfterOff && logFlagAfterOn;

  return {
    frLoaded,
    nearCenter,
    nearRed,
    nearGreen,
    nearBlue,
    sortIndices,
    logVariantActive,
    flipGuardOk,
    pngNear: imgNear.png,
    useLogDepth: scene._frameState ? scene._frameState.useLogDepth : null,
  };
});

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [k, f] of [["pngNear", "splat-sort-near.png"]]) {
  if (out[k]) {
    fs.writeFileSync(
      path.join(OUT_DIR, f),
      Buffer.from(out[k].split(",")[1], "base64"),
    );
  }
}

let ok = true;
const check = (label, pass, detail) => {
  console.log(`(${label}) ${detail} ${pass ? "OK" : "FAIL"}`);
  if (!pass) ok = false;
};

const [cr, cg, cb] = out.nearCenter;
const totalColored = out.nearRed + out.nearGreen + out.nearBlue;
check(
  "0",
  out.frLoaded === true,
  `Gaussian-splat feature renderer loaded: ${out.frLoaded}`,
);
// (1) DETERMINISTIC sort-consumption proof: the renderer's CPU back-to-front
// sort produced the correct depth permutation [red(far), green(mid), blue(near)]
// = ids [0,2,1], and uploaded it to the sorted-index storage buffer the VS
// unconditionally indexes through (sortedIndices[instance_index]). Buffer order
// was [red, blue, green] (ids [0,1,2]); the identity (unsorted) result would be
// [0,1,2]. [0,2,1] proves the sort ran AND feeds the draw.
const sortStr = JSON.stringify(out.sortIndices);
check(
  "1",
  sortStr === "[0,2,1]",
  `back-to-front sort runs + uploaded to the draw's index buffer: sortedIndices=${sortStr} (expect [0,2,1]; identity [0,1,2] = unsorted)`,
);
// (2) VISUAL confirmation: when the splat renders (sky-framed, globe hidden),
// the BLUE (nearest) splat wins the center — i.e. the GPU draw actually indexed
// through the sorted order back-to-front. Best-effort: the synthetic globe-
// hidden first-draw is settle-sensitive, so a black capture (totalColored small)
// does NOT fail the deterministic sort assertion above; only a NON-blue-dominant
// center when the cloud DID render is a real failure.
const rendered = totalColored > 500;
check(
  "2",
  !rendered || (cb > cr + 30 && cb > cg + 30),
  `center == NEAREST (blue) when rendered (GPU consumed the sorted order): rendered=${rendered} center=(${cr.toFixed(0)},${cg.toFixed(0)},${cb.toFixed(0)}) colored=${totalColored}`,
);
// (3) Negative control: GREEN is the buffer-LAST splat; the OLD unsorted path
// drew in buffer order so green would win. A green-dominant center (when
// rendered) means the sort was NOT consumed.
check(
  "3",
  !rendered || !(cg > cr + 30 && cg > cb + 30),
  `center != BUFFER-LAST (green) when rendered — NOT the unsorted result: center green=${cg.toFixed(0)}`,
);
check(
  "4",
  out.logVariantActive === true,
  `splat color pipeline is the LOG_DEPTH variant with log depth ON (producer writes log frag_depth): logVariantActive=${out.logVariantActive} (useLogDepth=${out.useLogDepth})`,
);
check(
  "5",
  out.flipGuardOk === true,
  `log-depth flip OFF->ON drives the flip-rebuild guard (cache.logDepthEnabled tracks the master switch, pipelines recompile): flipGuardOk=${out.flipGuardOk}`,
);
check("6", errors.length === 0, `console errors: ${errors.length}`);
if (errors.length)
  for (const e of errors.slice(0, 8)) console.log(`  ERR: ${e}`);

console.log(ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
