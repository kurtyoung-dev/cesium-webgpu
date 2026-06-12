#!/usr/bin/env node
// Probe (NEW-COMPUTE-INSTANCE-SYSTEM feature-agnosticism verify): the
// generic `ComputeInstanceCollection` must work with a NON-orbital kernel —
// proving the engine system carries zero orbital domain knowledge. The
// kernel here drives instances along a Lissajous figure-8 path around a
// fixed point above the globe (pure toy math, nothing Keplerian):
//   (A) RENDER — 400 magenta dots on the figure-8 produce a magenta pixel
//       count over threshold from a fixed camera,
//   (B) MOVE — the dots advance along the path purely from the per-frame
//       time scalar (params upload once). The magenta mask at frame ~15 vs
//       frame ~60 must differ substantially (>20% of mask pixels change)
//       while the camera stays fixed,
//   (C) produce ZERO console errors (incl. WebGPU validation errors).
//
// Batch 235 additions (BV + TAA velocity for the compute-instance system):
//   (D) BV — the user-supplied `boundingSphere` threads onto the draw
//       command (`boundingVolume` present, `cull === true`),
//   (E) TAA ON — the command carries a `velocityCommand` (prev-position
//       ping-pong + velocity pipeline live) and the whole run still
//       produces ZERO console/validation errors (covered by (C)),
//   (F) TAA OFF again — the `velocityCommand` detaches.
//
// Determinism: same harness as probe-orbital-catalog.mjs (see its header
// for the postRender-readback + requestRenderMode rationale) — widget loop
// keeps running, clock pinned to epoch + i*30 s per frame, so the kernel's
// `time` input is an exact function of the frame index.
//
// Usage: node Tools/visual-regression/probe-compute-instance-generic.mjs
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

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;

  scene.requestRenderMode = false;
  v.clock.shouldAnimate = false;

  // Seeded PRNG so the instance set is identical across runs.
  let seed = 0x9e3779b9;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // NON-orbital kernel: Lissajous figure-8 in the YZ plane around a fixed
  // anchor 8 Mm out on +X (above the globe), with the WHOLE pattern slowly
  // rotating about +X (so the pixel mask provably moves even though the
  // 400 random-phase dots densely cover the closed curve in any single
  // frame). Lanes: 0 phaseOffset(rad), 1 pixelSize(px). Position derives
  // from time + per-instance phase only.
  const lissajousKernel = `
    fn csm_computeInstance(index: u32, time: f32) -> ComputeInstanceOut {
      let base = index * FLOATS_PER_INSTANCE;
      let phase = params[base + 0u];
      let t = time * 0.003 + phase;

      // Figure-8 in a local 2D frame...
      let p = vec2<f32>(2.5e6 * sin(t), 1.2e6 * sin(2.0 * t));
      // ...rotated as a whole about +X over time (pinwheel).
      let rot = time * 0.0005;
      let c = cos(rot);
      let s = sin(rot);
      let yz = vec2<f32>(c * p.x - s * p.y, s * p.x + c * p.y);

      let anchor = vec3<f32>(8.0e6, 0.0, 0.0);
      var out: ComputeInstanceOut;
      out.position = anchor + vec3<f32>(0.0, yz.x, yz.y);
      out.color = vec4<f32>(1.0, 0.0, 1.0, 1.0);
      out.pixelSize = params[base + 1u];
      return out;
    }`;

  const BV_RADIUS = 4.4e7; // earth center, GEO radius + margin
  const collection = scene.primitives.add(
    new C.ComputeInstanceCollection({
      kernel: lissajousKernel,
      floatsPerInstance: 2,
      // Batch 235: user-contract bounding volume (positions are
      // GPU-resident; the figure-8 maxes out ~1.05e7 m from origin).
      boundingSphere: new C.BoundingSphere(C.Cartesian3.ZERO, BV_RADIUS),
    }),
  );
  const epoch = C.JulianDate.clone(v.clock.currentTime);
  collection.epoch = epoch;

  const COUNT = 400;
  for (let i = 0; i < COUNT; i++) {
    collection.addInstance([rand() * 2.0 * Math.PI, 10.0]);
  }

  // Camera: 25 Mm out on +X, looking at the anchor — the figure-8 sits in
  // front of the globe.
  scene.morphTo3D(0);
  v.camera.setView({
    destination: new C.Cartesian3(2.5e7, 0.0, 0.0),
    orientation: {
      direction: new C.Cartesian3(-1.0, 0.0, 0.0),
      up: new C.Cartesian3(0.0, 0.0, 1.0),
    },
  });

  const oncePostRender = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve();
      });
    });
  const renderAt = async (simSeconds) => {
    v.clock.currentTime = C.JulianDate.addSeconds(
      epoch,
      simSeconds,
      new C.JulianDate(),
    );
    await oncePostRender();
    await oncePostRender();
  };
  // Readback inside scene.postRender — see probe-orbital-catalog.mjs.
  const grab = () =>
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
  const isMagenta = (d, i) => d[i] > 150 && d[i + 2] > 150 && d[i + 1] < 90;
  const magentaMask = (img) => {
    const mask = new Uint8Array(img.w * img.h);
    let count = 0;
    for (let p = 0; p < mask.length; p++) {
      if (isMagenta(img.data, 4 * p)) {
        mask[p] = 1;
        count++;
      }
    }
    return { mask, count };
  };

  // Warmup at 30 s/frame: async pipeline resolve + params upload + first
  // dispatches. Between captures (45 frames * 30 s = 1350 s): path angle
  // advances 4.05 rad and the whole pattern rotates 0.675 rad (~39°).
  let f = 0;
  for (; f < 15; f++) {
    await renderAt(f * 30.0);
  }
  const imgA = await grab();
  const A = magentaMask(imgA);

  for (; f < 60; f++) {
    await renderAt(f * 30.0);
  }
  const imgB = await grab();
  const B = magentaMask(imgB);

  let changed = 0;
  for (let p = 0; p < A.mask.length; p++) {
    if (A.mask[p] !== B.mask[p]) changed++;
  }
  const denom = Math.max(A.count, B.count, 1);

  // ── (D) Batch 235: the user BV must ride the draw command ──
  const cache = collection._webgpuCache;
  const cmd = cache?.command;
  const bvState = {
    hasBoundingVolume: !!cmd?.boundingVolume,
    bvRadius: cmd?.boundingVolume?.radius ?? 0,
    cullFlag: cmd?.cull === true,
  };

  // ── (E) TAA ON: prev-position ping-pong + velocityCommand ──
  // The partner buffer allocates on the first TAA frame and the async
  // velocity pipeline resolves over the next few — give it 12 frames of
  // headroom, then the attachment must be stable.
  scene.taaEnabled = true;
  for (let k = 0; k < 12; k++) {
    await renderAt(f * 30.0);
    f++;
  }
  const taaOnState = {
    hasVelocityCommand: !!cache?.command?.velocityCommand,
    velocityInstances: cache?.command?.velocityCommand?.instanceCount ?? 0,
    pingPongPartnerAllocated: !!cache?.instanceBuffers?.[1],
  };

  // ── (F) TAA OFF: velocityCommand must detach within a few frames ──
  scene.taaEnabled = false;
  for (let k = 0; k < 6; k++) {
    await renderAt(f * 30.0);
    f++;
  }
  const taaOffState = {
    hasVelocityCommand: !!cache?.command?.velocityCommand,
  };

  return {
    instanceCount: collection.length,
    simTimeA_s: 15 * 30,
    simTimeB_s: 60 * 30,
    magentaA: A.count,
    magentaB: B.count,
    changedPixels: changed,
    changedPct: changed / denom,
    bvRadiusSupplied: BV_RADIUS,
    bvState,
    taaOnState,
    taaOffState,
  };
});

const aOK = out.magentaA > 300 && out.magentaB > 300;
const bOK = out.changedPct > 0.2;
const cOK = errors.length === 0;
const dOK =
  out.bvState.hasBoundingVolume &&
  out.bvState.bvRadius === out.bvRadiusSupplied &&
  out.bvState.cullFlag;
const eOK =
  out.taaOnState.hasVelocityCommand &&
  out.taaOnState.pingPongPartnerAllocated &&
  out.taaOnState.velocityInstances === out.instanceCount;
const fOK = !out.taaOffState.hasVelocityCommand;

console.log(
  `(A) renders: ${out.instanceCount} instances -> magenta px frame15=${out.magentaA} frame60=${out.magentaB} (threshold 300) ${aOK ? "OK" : "FAIL"}`,
);
console.log(
  `(B) moves: simT ${out.simTimeA_s}s -> ${out.simTimeB_s}s, mask changed ${out.changedPixels} px = ${(out.changedPct * 100).toFixed(1)}% of mask (threshold 20%) ${bOK ? "OK" : "FAIL"}`,
);
console.log(`(C) console errors: ${errors.length} ${cOK ? "OK" : "FAIL"}`);
errors.slice(0, 8).forEach((e) => console.log("  ERR:", e.slice(0, 250)));
console.log(
  `(D) bounding volume: onCommand=${out.bvState.hasBoundingVolume} radius=${out.bvState.bvRadius} (supplied ${out.bvRadiusSupplied}) cull=${out.bvState.cullFlag} ${dOK ? "OK" : "FAIL"}`,
);
console.log(
  `(E) TAA on: velocityCommand=${out.taaOnState.hasVelocityCommand} instances=${out.taaOnState.velocityInstances} pingPongPartner=${out.taaOnState.pingPongPartnerAllocated} ${eOK ? "OK" : "FAIL"}`,
);
console.log(
  `(F) TAA off: velocityCommand=${out.taaOffState.hasVelocityCommand} (must be false) ${fOK ? "OK" : "FAIL"}`,
);

const pass = aOK && bOK && cOK && dOK && eOK && fOK;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
