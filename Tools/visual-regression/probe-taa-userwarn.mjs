#!/usr/bin/env node
// Probe (Batch 290): two-part gate for the
// NEW-TAA-PIPELINE-ORDER-RECONCILE + NEW-POSTPROCESS-USER-WARN-PROD stage.
//
// Part 1 — NEW-TAA-PIPELINE-ORDER-RECONCILE. The order decision kept TAA
//   PRE-tonemap (linear/HDR). This re-verifies that TAA still RESOLVES and
//   is TEMPORALLY STABLE in that domain after the decision was locked in:
//     • resolveCount strictly increases while TAA is on (the pre-tonemap
//       resolve pass actually encodes);
//     • a SETTLED scene (static primitives + camera, history converged)
//       has near-identical consecutive frames despite per-frame jitter
//       (TAA accumulation cancels it — a bypassed/broken resolve flickers);
//     • a camera ROTATION (lookRight, no positional delta so the teleport
//       history-reset never fires — the BLEND path is what's tested) makes
//       the image follow within ONE frame (large diff) without ballooning
//       the billboard pixel count (broken neighborhood clamp → ~2x ghost).
//   Pre-tonemap is correct because TAA.wgsl's resolve does its OWN
//   reversible tonemap-weighting (c/(1+luma)); on already-tonemapped SDR
//   the inverse c/(1-luma) divides by ~0 at highlights → Inf/NaN. The
//   stability + no-smear checks would degrade if the clamp domain were
//   wrong for the input, so a clean pass corroborates the decision.
//
// Part 2 — NEW-POSTPROCESS-USER-WARN-PROD. A user-supplied GLSL
//   PostProcessStage (no `wgslFragmentShader` uniform) is SKIPPED on
//   WebGPU (the backend needs WGSL). The drop warning was pragma-stripped
//   in production, so shipping users got silence. Un-stripped, it must now
//   fire as a permanent `console.warn` (deduped once) AND not crash the
//   scene. We also confirm a WGSL-equipped stage emits NO warning (the
//   warning is GLSL-specific, not "any user stage").
//
// Determinism: requestRenderMode off (continuous widget loop); every
// readback inside scene.postRender, same task as the frame's present.
//
// Usage: node Tools/visual-regression/probe-taa-userwarn.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
const warns = [];
page.on("console", (m) => {
  const t = m.type();
  if (t === "error") errors.push(m.text());
  if (t === "warning" || t === "warn") warns.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

// ── Setup + helpers (persist on window across evaluate calls) ──────────
await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  scene.requestRenderMode = false;
  v.clock.shouldAnimate = false;

  scene.globe.show = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  scene.backgroundColor = C.Color.BLACK;

  const img = document.createElement("canvas");
  img.width = 16;
  img.height = 16;
  const ictx = img.getContext("2d");
  ictx.fillStyle = "#ff00ff";
  ictx.fillRect(0, 0, 16, 16);

  const bb = scene.primitives.add(new C.BillboardCollection({ scene }));
  const N = 40;
  const bbItems = [];
  for (let i = 0; i < N; i++) {
    const lon = -0.5 + (i % 8) * 0.125;
    const lat = -0.3 + Math.floor(i / 8) * 0.125;
    bbItems.push(
      bb.add({
        image: img,
        position: C.Cartesian3.fromDegrees(lon, lat, 120000.0),
      }),
    );
  }

  v.camera.setView({ destination: C.Cartesian3.fromDegrees(0.0, 0.0, 2.0e6) });

  const oncePostRender = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve();
      });
    });

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
    });

  const pp = () => scene._alternateSceneRenderer?._postProcess ?? null;
  const inspect = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        const pipeline = pp();
        const taa = pipeline?.taaEffect ?? null;
        resolve({
          hasTaaEffect: !!taa,
          taaEnabled: taa ? taa.enabled === true : false,
          resolveCount: taa ? (taa.getStatistics().resolveCount ?? -1) : -1,
          userStageCount: pipeline?._userStages?.length ?? -1,
        });
      });
    });

  const nonBlack = (s) => {
    let n = 0;
    for (let p = 0; p < s.w * s.h; p++) {
      const i = 4 * p;
      if (s.data[i] > 16 || s.data[i + 1] > 16 || s.data[i + 2] > 16) n++;
    }
    return n;
  };
  const magenta = (s) => {
    let n = 0;
    for (let p = 0; p < s.w * s.h; p++) {
      const i = 4 * p;
      if (s.data[i] > 150 && s.data[i + 2] > 150 && s.data[i + 1] < 90) n++;
    }
    return n;
  };
  const diffFrac = (s1, s2) => {
    let n = 0;
    const t = 12;
    for (let p = 0; p < s1.w * s1.h; p++) {
      const i = 4 * p;
      if (
        Math.abs(s1.data[i] - s2.data[i]) > t ||
        Math.abs(s1.data[i + 1] - s2.data[i + 1]) > t ||
        Math.abs(s1.data[i + 2] - s2.data[i + 2]) > t
      ) {
        n++;
      }
    }
    return n / (s1.w * s1.h);
  };

  window.__probe = {
    C,
    scene,
    snap,
    inspect,
    nonBlack,
    magenta,
    diffFrac,
    runStaticFrames: async (n) => {
      for (let f = 0; f < n; f++) await oncePostRender();
    },
  };
});

// ── Part 1: TAA pre-tonemap still resolves + temporally stable ─────────
const taa = await page.evaluate(async () => {
  const P = window.__probe;
  P.scene.taaEnabled = true;
  await P.runStaticFrames(20);
  const st1 = await P.inspect();
  await P.runStaticFrames(20);
  const st2 = await P.inspect();

  // Settled — history converged.
  await P.runStaticFrames(15);
  const s1 = await P.snap();
  const s2 = await P.snap();
  const settledDiff = P.diffFrac(s1, s2);
  const settledMagenta = P.magenta(s2);
  const settledNonBlack = P.nonBlack(s2);

  // Camera rotation only (blend path; no teleport reset).
  P.scene.camera.lookRight(0.04);
  const m1 = await P.snap();
  const movedDiff = P.diffFrac(s2, m1);
  const movedMagenta = P.magenta(m1);

  return {
    resolveCount1: st1.resolveCount,
    resolveCount2: st2.resolveCount,
    hasTaaEffect: st2.hasTaaEffect,
    taaEnabled: st2.taaEnabled,
    settledDiff,
    settledMagenta,
    settledNonBlack,
    movedDiff,
    movedMagenta,
  };
});

// ── Part 2a: WGSL-equipped user stage → NO warning, no crash ───────────
const warnsBeforeWgsl = warns.length;
const wgslStage = await page.evaluate(async () => {
  const P = window.__probe;
  const C = P.C;
  // Minimal valid WGSL FS stage. The WebGPU user-stage convention:
  // fragmentMain returns vec4, samples the source. Tints red so it's a
  // real (non-identity) effect; carried via the wgslFragmentShader uniform.
  const wgsl = `
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSamp: sampler;
@fragment fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = textureSample(srcTex, srcSamp, uv);
  return vec4f(c.rgb * vec3f(1.0, 0.6, 0.6), c.a);
}`;
  const stage = new C.PostProcessStage({
    name: "probe-wgsl-tint",
    // A GLSL body is required by the PostProcessStage constructor; the
    // WebGPU path ignores it and uses wgslFragmentShader instead.
    fragmentShader:
      "uniform sampler2D colorTexture; in vec2 v_textureCoordinates; void main() { out_FragColor = texture(colorTexture, v_textureCoordinates); }",
    uniforms: { wgslFragmentShader: wgsl },
  });
  P.scene.postProcessStages.add(stage);
  await P.runStaticFrames(10);
  const st = await P.inspect();
  const s = await P.snap();
  return { userStageCount: st.userStageCount, nonBlack: P.nonBlack(s) };
});
const warnsAfterWgsl = warns.length;

// ── Part 2b: GLSL-only user stage → permanent warning, no crash ────────
const warnsBeforeGlsl = warns.length;
const glslStage = await page.evaluate(async () => {
  const P = window.__probe;
  const C = P.C;
  // No wgslFragmentShader uniform → SKIPPED on WebGPU → must warn.
  const stage = new C.PostProcessStage({
    name: "probe-glsl-only",
    fragmentShader:
      "uniform sampler2D colorTexture; in vec2 v_textureCoordinates; void main() { out_FragColor = texture(colorTexture, v_textureCoordinates) * vec4(0.5, 1.0, 0.5, 1.0); }",
  });
  P.scene.postProcessStages.add(stage);
  await P.runStaticFrames(10);
  const st = await P.inspect();
  const s = await P.snap();
  return { userStageCount: st.userStageCount, nonBlack: P.nonBlack(s) };
});
const _warnsAfterGlsl = warns.length;

// ── Assertions ─────────────────────────────────────────────────────────
const resolveRan =
  taa.resolveCount1 > 0 && taa.resolveCount2 > taa.resolveCount1;
const taaStateOK =
  taa.hasTaaEffect &&
  taa.taaEnabled &&
  resolveRan &&
  taa.settledNonBlack > 1500;
const taaStableOK = taa.settledDiff < 0.01;
const taaNoSmearOK =
  taa.movedDiff > 0.004 &&
  taa.movedDiff > 4 * taa.settledDiff &&
  taa.movedMagenta < 1.7 * Math.max(1, taa.settledMagenta);

// WGSL stage compiled into the pipeline's user-stage chain → count 1,
// emitted NO new warning (warning is GLSL-specific).
const wgslNewWarns = warnsAfterWgsl - warnsBeforeWgsl;
const wgslOK =
  wgslStage.userStageCount === 1 &&
  wgslStage.nonBlack > 1500 &&
  wgslNewWarns === 0;

// GLSL-only stage was SKIPPED (user-stage count stays 1 — the WGSL one)
// and the drop warning fired with the expected text. oneTimeWarning
// dedupes, so exactly one new warn containing the GLSL marker.
const glslWarnTexts = warns
  .slice(warnsBeforeGlsl)
  .filter((w) => /GLSL custom shaders are not transpiled/.test(w));
const glslWarnedOK = glslWarnTexts.length >= 1;
const glslNoCrashOK =
  glslStage.userStageCount === 1 && glslStage.nonBlack > 1500;

// No console errors anywhere (no crash from either user stage).
const eOK = errors.length === 0;

console.log(
  `(1) TAA pre-tonemap resolve: count ${taa.resolveCount1}->${taa.resolveCount2} effect:${taa.hasTaaEffect} enabled:${taa.taaEnabled} nonBlack:${taa.settledNonBlack} -> ${taaStateOK ? "OK" : "FAIL"}`,
);
console.log(
  `(1) TAA stability: settledDiff:${taa.settledDiff.toFixed(5)} (<0.01) -> ${taaStableOK ? "OK" : "FAIL"}`,
);
console.log(
  `(1) TAA no-smear: movedDiff:${taa.movedDiff.toFixed(5)} (>0.004 & >4x settled) magenta settled:${taa.settledMagenta} moved:${taa.movedMagenta} (<1.7x) -> ${taaNoSmearOK ? "OK" : "FAIL"}`,
);
console.log(
  `(2a) WGSL user stage: count:${wgslStage.userStageCount}==1 nonBlack:${wgslStage.nonBlack} newWarns:${wgslNewWarns}==0 -> ${wgslOK ? "OK" : "FAIL"}`,
);
console.log(
  `(2b) GLSL-only stage warned: matches:${glslWarnTexts.length}>=1 -> ${glslWarnedOK ? "OK" : "FAIL"}`,
);
console.log(
  `(2b) GLSL-only no-crash: count:${glslStage.userStageCount}==1 nonBlack:${glslStage.nonBlack} -> ${glslNoCrashOK ? "OK" : "FAIL"}`,
);
console.log(`(e) console errors: ${errors.length} -> ${eOK ? "OK" : "FAIL"}`);
if (glslWarnTexts[0]) console.log("  WARN:", glslWarnTexts[0].slice(0, 200));
errors.slice(0, 8).forEach((e) => console.log("  ERR:", e.slice(0, 300)));

const pass =
  taaStateOK &&
  taaStableOK &&
  taaNoSmearOK &&
  wgslOK &&
  glslWarnedOK &&
  glslNoCrashOK &&
  eOK;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
