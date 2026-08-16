#!/usr/bin/env node
// Probe (Batch 244 — NEW-TAA-EFFECT-NEVER-ADDED): the TAA temporal-resolve
// stage gets its missing consumer. Batches 234/235 activated velocity
// EMISSION, but `WebGPUPostProcessPipeline.addTAA()` had zero callers —
// `_taaEffect` stayed null, `setStageEnabled("TAA", true)` no-opped, the
// Scene.js jitter block short-circuited, and `scene.taaEnabled = true`
// cost velocity passes + the MSAA=1 downgrade while producing NO temporal
// antialiasing. Batch 244 lazy-adds the effect from
// `configureWebGPUPostProcessPipeline` on the first taaEnabled frame.
// @purpose TAA resolve-consumer gate: effect lazily added on first taaEnabled frame; resolve encodes, settled-stable, no smear on rotation.
// @status ACTIVE
//
// Scene: 40 moving billboards + 40 moving points over a black background
// (globe/sky hidden), top-down camera. Phases:
//
//   (a) TAA OFF baseline — scene renders (non-black pixels), the pipeline
//       has NO `_taaEffect`, no velocityCommand attaches, msaa=4.
//   (b) TAA ON — `_taaEffect` non-null + enabled, the resolve pass
//       actually ENCODES (debug-pragma `resolveCount` in
//       `WebGPUTAAEffect.execute` strictly increases across frames),
//       velocity commands attach, 60 moving frames render with 0
//       console/validation errors, msaa=1. Then with the scene SETTLED
//       (static primitives + camera, history converged over 25 frames):
//         - STABLE: two consecutive frames pixel-diff SMALL (the jitter
//           is still applied every frame — TAA accumulation is what
//           cancels it; a bypassed resolve would flicker edge pixels).
//         - NOT SMEARED: rotate the camera (`lookRight(0.04)` ≈ 40 px
//           screen shift; rotation only, so the 50 km teleport-reset
//           never fires and the BLEND path is what's tested) and render
//           exactly ONE frame — diff vs the pre-move frame is LARGE
//           (image follows within a frame) and the billboard-color pixel
//           count does NOT balloon (a broken neighborhood clamp would
//           leave a ~90% ghost at the old positions ≈ 2x the count).
//   (c) TAA OFF again — effect bypassed (instance kept, enabled=false),
//       resolveCount FROZEN, velocity commands detach, msaa restored to
//       4, scene still renders, 0 errors.
//
// Determinism: requestRenderMode is disabled (continuous widget loop —
// the proven probe-taa-velocity-emission.mjs drive; explicit
// scene.render() under requestRenderMode skips frames whose dirty state
// didn't request a render, which made snapshots race the present).
// Every readback happens INSIDE scene.postRender, same task as the
// frame's render.
//
// Usage: node Tools/visual-regression/probe-taa-resolve.mjs
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
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
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
  // Continuous widget loop — postRender fires every RAF in the same
  // task as the frame's present (snapshot-safe).
  scene.requestRenderMode = false;
  v.clock.shouldAnimate = false;

  // Black background — deterministic pixel counts, no imagery noise.
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
  const pts = scene.primitives.add(new C.PointPrimitiveCollection());
  const N = 40;
  const bbItems = [];
  const ptItems = [];
  for (let i = 0; i < N; i++) {
    const lon = -0.5 + (i % 8) * 0.125;
    const lat = -0.3 + Math.floor(i / 8) * 0.125;
    bbItems.push(
      bb.add({
        image: img,
        position: C.Cartesian3.fromDegrees(lon, lat, 120000.0),
      }),
    );
    ptItems.push(
      pts.add({
        position: C.Cartesian3.fromDegrees(lon + 0.06, lat, 120000.0),
        color: C.Color.CYAN,
        pixelSize: 8,
      }),
    );
  }

  v.camera.setView({ destination: C.Cartesian3.fromDegrees(0.0, 0.0, 2.0e6) });

  let frame = 0;
  const moveAll = () => {
    for (let i = 0; i < N; i++) {
      const lon = -0.5 + (i % 8) * 0.125 + 0.02 * Math.sin(frame * 0.13 + i);
      const lat =
        -0.3 + Math.floor(i / 8) * 0.125 + 0.02 * Math.cos(frame * 0.11 + i);
      bbItems[i].position = C.Cartesian3.fromDegrees(lon, lat, 120000.0);
      ptItems[i].position = C.Cartesian3.fromDegrees(lon + 0.06, lat, 120000.0);
    }
    frame++;
  };

  const oncePostRender = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve();
      });
    });

  // Deterministic readback INSIDE scene.postRender — present clears the
  // WebGPU canvas texture, so readback in a later task is racy.
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
        const list = scene.frameState.commandList;
        const bbCmd = list.find((c) => c && c.owner === bb);
        const pipeline = pp();
        const taa = pipeline?.taaEffect ?? null;
        resolve({
          hasTaaEffect: !!taa,
          taaEnabled: taa ? taa.enabled === true : false,
          resolveCount: taa ? (taa.getStatistics().resolveCount ?? -1) : -1,
          bbHasVelocity: !!bbCmd?.velocityCommand,
          velocityTextureAllocated: !!(
            scene._alternateSceneRenderer?._sceneFramebuffer?.velocityView ??
            null
          ),
          msaaSamples: scene.context?._msaaSamples ?? -1,
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
    bb,
    pts,
    snap,
    inspect,
    nonBlack,
    magenta,
    diffFrac,
    runMovingFrames: async (n) => {
      for (let f = 0; f < n; f++) {
        moveAll();
        await oncePostRender();
      }
    },
    runStaticFrames: async (n) => {
      for (let f = 0; f < n; f++) {
        await oncePostRender();
      }
    },
  };
});

// ── Phase (a): TAA OFF baseline ────────────────────────────────────────
const a = await page.evaluate(async () => {
  const P = window.__probe;
  P.scene.taaEnabled = false;
  await P.runMovingFrames(25);
  const st = await P.inspect();
  const s = await P.snap();
  return { ...st, nonBlack: P.nonBlack(s) };
});
const errsAfterA = errors.length;

// ── Phase (b): TAA ON — resolve runs, stable when settled, no smear ───
const b = await page.evaluate(async () => {
  const P = window.__probe;
  P.scene.taaEnabled = true;
  await P.runMovingFrames(30);
  const st1 = await P.inspect();
  await P.runMovingFrames(30);
  const st2 = await P.inspect();

  // Settle: static primitives + camera; let the history converge.
  await P.runStaticFrames(25);
  const s1 = await P.snap();
  const s2 = await P.snap();
  const settledDiff = P.diffFrac(s1, s2);
  const settledMagenta = P.magenta(s2);

  // Camera move — rotation only (no positional delta → the 50 km
  // teleport history-reset can't fire; this tests the blend path).
  P.scene.camera.lookRight(0.04);
  const m1 = await P.snap();
  const movedDiff = P.diffFrac(s2, m1);
  const movedMagenta = P.magenta(m1);

  return {
    ...st2,
    resolveCount1: st1.resolveCount,
    hasTaaEffect1: st1.hasTaaEffect,
    taaEnabled1: st1.taaEnabled,
    settledDiff,
    movedDiff,
    settledMagenta,
    movedMagenta,
    settledNonBlack: P.nonBlack(s2),
  };
});
const errsAfterB = errors.length;

// ── Phase (c): TAA OFF again — bypass, counter freezes, MSAA restored ──
const c = await page.evaluate(async () => {
  const P = window.__probe;
  P.scene.taaEnabled = false;
  await P.runStaticFrames(5);
  const stStart = await P.inspect();
  await P.runStaticFrames(10);
  const st = await P.inspect();
  const s = await P.snap();
  return {
    ...st,
    resolveCountAtStart: stStart.resolveCount,
    nonBlack: P.nonBlack(s),
  };
});
const errsAfterC = errors.length;

// ── Assertions ─────────────────────────────────────────────────────────
const aOK =
  !a.hasTaaEffect &&
  !a.bbHasVelocity &&
  !a.velocityTextureAllocated &&
  a.msaaSamples === 4 &&
  a.nonBlack > 1500;

const resolveRan = b.resolveCount1 > 0 && b.resolveCount > b.resolveCount1;
const bStateOK =
  b.hasTaaEffect1 &&
  b.taaEnabled1 &&
  b.hasTaaEffect &&
  b.taaEnabled &&
  resolveRan &&
  b.bbHasVelocity &&
  b.velocityTextureAllocated &&
  b.msaaSamples === 1 &&
  b.settledNonBlack > 1500;
// Settled scene: consecutive frames near-identical despite per-frame
// jitter (TAA accumulation cancels it).
const bStableOK = b.settledDiff < 0.01;
// Moved frame: image follows within ONE frame (large diff vs pre-move)
// and no heavy ghost (billboard pixel count doesn't balloon at the old
// positions — broken clamping would roughly double it).
const bNoSmearOK =
  b.movedDiff > 0.004 &&
  b.movedDiff > 4 * b.settledDiff &&
  b.movedMagenta < 1.7 * Math.max(1, b.settledMagenta);

const cOK =
  c.hasTaaEffect && // instance kept (bypass, not teardown)
  !c.taaEnabled && // ...but bypassed
  c.resolveCount === c.resolveCountAtStart && // resolve stopped encoding
  !c.bbHasVelocity &&
  c.msaaSamples === 4 &&
  c.nonBlack > 1500;
const eOK = errsAfterC === 0;

console.log(
  `(a) OFF 25f: taaFx:${a.hasTaaEffect} vel:${a.bbHasVelocity} velTex:${a.velocityTextureAllocated} msaa:${a.msaaSamples} nonBlack:${a.nonBlack} -> ${aOK ? "OK" : "FAIL"}`,
);
console.log(
  `(b) ON 60f: taaFx:${b.hasTaaEffect} enabled:${b.taaEnabled} resolve:${b.resolveCount1}->${b.resolveCount} vel:${b.bbHasVelocity} velTex:${b.velocityTextureAllocated} msaa:${b.msaaSamples} nonBlack:${b.settledNonBlack} -> ${bStateOK ? "OK" : "FAIL"}`,
);
console.log(
  `(b) stability: settledDiff:${b.settledDiff.toFixed(5)} (<0.01) -> ${bStableOK ? "OK" : "FAIL"}`,
);
console.log(
  `(b) no-smear: movedDiff:${b.movedDiff.toFixed(5)} (>0.004 & >4x settled) magenta settled:${b.settledMagenta} moved:${b.movedMagenta} (<1.7x) -> ${bNoSmearOK ? "OK" : "FAIL"}`,
);
console.log(
  `(c) OFF 15f: taaFx:${c.hasTaaEffect} enabled:${c.taaEnabled} resolve:${c.resolveCountAtStart}==${c.resolveCount} vel:${c.bbHasVelocity} msaa:${c.msaaSamples} nonBlack:${c.nonBlack} -> ${cOK ? "OK" : "FAIL"}`,
);
console.log(
  `(e) console errors: a=${errsAfterA} b=${errsAfterB - errsAfterA} c=${errsAfterC - errsAfterB} total=${errsAfterC} -> ${eOK ? "OK" : "FAIL"}`,
);
errors.slice(0, 10).forEach((e) => console.log("  ERR:", e.slice(0, 300)));

const pass = aOK && bStateOK && bStableOK && bNoSmearOK && cOK && eOK;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
