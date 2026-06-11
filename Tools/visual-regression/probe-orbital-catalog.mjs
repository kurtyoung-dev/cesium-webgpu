#!/usr/bin/env node
// Probe (Phase 3 — NEW-COMPUTE-INSTANCE-SYSTEM regression gate; formerly
// the Batch-230 NEW-ORBITAL-GPU-RESIDENT-RENDERER verify): the orbital
// catalog built ON TOP of the generic `ComputeInstanceCollection` — the
// circular-orbit element layout + WGSL kernel are defined IN THIS PROBE,
// exactly like the Sandcastle demo; the engine has zero orbital knowledge —
// must
//   (A) RENDER — ~2000 magenta points (varied circular orbits across three
//       shells) produce a magenta pixel count over threshold from a 35 Mm
//       camera,
//   (B) MOVE — positions are repopulated by the user compute kernel from
//       the per-frame time scalar alone (params upload once). The magenta
//       pixel mask at frame ~15 vs frame ~60 must differ substantially
//       (>20% of mask pixels change) while the camera stays fixed,
//   (C) produce ZERO console errors (incl. WebGPU validation errors).
//
// Determinism: the viewer's default render loop keeps running (a WebGPU
// canvas presents and clears its texture every frame, so canvas-2D
// readback only sees content when the widget loop rendered this frame —
// verified the hard way in the Batch 230 bring-up), but the clock is
// PINNED: `shouldAnimate = false` and the probe sets `clock.currentTime =
// epoch + i*30 s` each frame, so simulation time — and therefore object
// angle (angle = phase + meanMotion * t) — is an exact function of the
// frame index. LEO shell mean motion ~1.08e-3 rad/s → 45 frames * 30 s =
// 1350 s → ~1.5 rad of arc between captures.
//
// Usage: node Tools/visual-regression/probe-orbital-catalog.mjs
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

  // Deterministic time control: keep the widget render loop (it must
  // present each frame for canvas readback to see anything) but freeze
  // the clock — the probe sets currentTime explicitly per frame.
  // CRITICAL: the CesiumViewer app runs with requestRenderMode=true, so
  // once tiles settle the loop stops rendering — postRender never fires
  // (hang) and the canvas readback goes black. Force continuous renders.
  scene.requestRenderMode = false;
  v.clock.shouldAnimate = false;

  // Seeded PRNG so the catalog is identical across runs.
  let seed = 0x6d2b79f5;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Orbital element layout + circular-orbit kernel are PROBE-owned content
  // (the engine is feature-agnostic). Lanes: 0 semiMajorAxis(m),
  // 1 inclination(rad), 2 raan(rad), 3 phase(rad), 4 meanMotion(rad/s),
  // 5 epochOffset(s), 6-8 color rgb, 9 pixelSize(px). Kernel math ported
  // verbatim from the Batch-230 engine OrbitalPropagate.wgsl (f32, low=0
  // handled by the engine scaffold, ECI treated as ECEF / GMST skipped).
  const FPI = 10;
  const orbitalKernel = `
    fn csm_computeInstance(index: u32, time: f32) -> ComputeInstanceOut {
      let base = index * FLOATS_PER_INSTANCE;
      let a = params[base + 0u];
      let inc = params[base + 1u];
      let raan = params[base + 2u];
      let phase = params[base + 3u];
      let meanMotion = params[base + 4u];
      let epochOffset = params[base + 5u];

      let t = time - epochOffset;
      let angle = phase + meanMotion * t;
      let xp = a * cos(angle);
      let yp = a * sin(angle);

      let ci = cos(inc);
      let si = sin(inc);
      let co = cos(raan);
      let so = sin(raan);

      var out: ComputeInstanceOut;
      out.position = vec3<f32>(
        xp * co - yp * ci * so,
        xp * so + yp * ci * co,
        yp * si,
      );
      out.color = vec4<f32>(params[base + 6u], params[base + 7u], params[base + 8u], 1.0);
      out.pixelSize = params[base + 9u];
      return out;
    }`;

  const catalog = scene.primitives.add(
    new C.ComputeInstanceCollection({
      kernel: orbitalKernel,
      floatsPerInstance: FPI,
    }),
  );
  const epoch = C.JulianDate.clone(v.clock.currentTime);
  catalog.epoch = epoch;

  // ~2000 objects over three shells (LEO-ish, MEO-ish, GEO-ish radii).
  // meanMotion is the physical circular rate sqrt(GM/a^3). Same seeded
  // catalog as the Batch-230 baseline — the regression gate's pixel
  // numbers must stay equivalent.
  const GM = 3.986004418e14;
  const SHELLS = [7.0e6, 1.2e7, 2.0e7];
  const COUNT = 2000;
  for (let i = 0; i < COUNT; i++) {
    const a = SHELLS[i % SHELLS.length] * (1.0 + 0.05 * rand());
    catalog.addInstance([
      a,
      rand() * Math.PI, // inclination
      rand() * 2.0 * Math.PI, // raan
      rand() * 2.0 * Math.PI, // phase
      Math.sqrt(GM / (a * a * a)), // meanMotion
      0.0, // epochOffset
      1.0, // r  (magenta)
      0.0, // g
      1.0, // b
      4.0, // pixelSize
    ]);
  }

  // Camera: 35 Mm out on +X, looking at Earth's center — all three shells
  // in view.
  scene.morphTo3D(0);
  v.camera.setView({
    destination: new C.Cartesian3(3.5e7, 0.0, 0.0),
    orientation: {
      direction: new C.Cartesian3(-1.0, 0.0, 0.0),
      up: new C.Cartesian3(0.0, 0.0, 1.0),
    },
  });

  // Pin the clock to epoch + simSeconds, then wait for the widget loop's
  // next completed render at that time (scene.postRender fires after
  // scene.render, inside the same rAF callback, BEFORE the WebGPU canvas
  // presents — see grab()).
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
  // Readback MUST happen inside scene.postRender: a WebGPU canvas clears
  // its current texture on presentation (end of the rAF task), so a
  // drawImage from a later task reads black whenever the loop's timing
  // shifts (observed once imagery tiles start decoding). Inside
  // postRender the just-rendered, not-yet-presented texture is
  // guaranteed readable.
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

  // Warmup at 30 s/frame: async pipeline resolve + catalog upload + first
  // dispatches. Frame index drives simulation time throughout.
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

  // Mask change metric: pixels that are magenta in exactly one capture,
  // normalized by the larger mask.
  let changed = 0;
  for (let p = 0; p < A.mask.length; p++) {
    if (A.mask[p] !== B.mask[p]) changed++;
  }
  const denom = Math.max(A.count, B.count, 1);

  return {
    objectCount: catalog.length,
    simTimeA_s: 15 * 30,
    simTimeB_s: 60 * 30,
    magentaA: A.count,
    magentaB: B.count,
    changedPixels: changed,
    changedPct: changed / denom,
  };
});

const aOK = out.magentaA > 500 && out.magentaB > 500;
const bOK = out.changedPct > 0.2;
const cOK = errors.length === 0;

console.log(
  `(A) renders: ${out.objectCount} objects -> magenta px frame15=${out.magentaA} frame60=${out.magentaB} (threshold 500) ${aOK ? "OK" : "FAIL"}`,
);
console.log(
  `(B) moves: simT ${out.simTimeA_s}s -> ${out.simTimeB_s}s, mask changed ${out.changedPixels} px = ${(out.changedPct * 100).toFixed(1)}% of mask (threshold 20%) ${bOK ? "OK" : "FAIL"}`,
);
console.log(`(C) console errors: ${errors.length} ${cOK ? "OK" : "FAIL"}`);
errors.slice(0, 8).forEach((e) => console.log("  ERR:", e.slice(0, 250)));

const pass = aOK && bOK && cOK;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
