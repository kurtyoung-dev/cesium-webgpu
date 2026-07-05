#!/usr/bin/env node
// Probe (TAA-SLICE-2B-MODEL-MRT-MOTION — premise-verification / regression):
// The TAA per-model motion-vector path (prev-frame joint / morph / instance
// UBOs → dedicated single-target rg16float velocity pass → TAA shader prefers
// per-pixel motion at @binding(5)) was implemented across Batches 96/104/106/
// 130/134/174/175/325 but the roadmap still listed TAA-SLICE-2B as "open".
// This probe locks the SHIPPED behavior in place so a regression can't silently
// revert it, and proves the discriminating claim: a SKINNED + ANIMATED model
// under a STATIONARY camera emits NON-ZERO per-pixel velocity — i.e. skinned
// geometry is no longer treated as static.
//
// What's verified on WebGPU with scene.taaEnabled = true, camera fixed:
//   (1) The animated CesiumMan color command carries a `.velocityCommand`
//       (routes through `_runVelocityPass`).
//   (2) The scene-FB rg16float velocity texture is allocated (the velocity
//       pass ran).
//   (3) GPU readback of the velocity texture shows a meaningful cluster of
//       non-zero motion pixels. Because the camera never moves, that motion
//       can ONLY come from the per-vertex skinning/animation delta computed
//       with the prev-frame joint matrices — the exact thing Slice-2b adds.
//   (4) 0 console / WebGPU-validation errors across the animated frames and
//       the canvas is non-degenerate. A PNG of the canvas is written for a
//       human read.
//
// OFF-gate companion assertion: with taaEnabled=false the model command
// carries NO velocityCommand and the velocity texture stays unallocated.
//
// Usage: node Tools/visual-regression/probe-taa-model-skinned-velocity.mjs
// Env:   PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = `${dirname(fileURLToPath(import.meta.url))}/output`;
mkdirSync(OUT_DIR, { recursive: true });

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

// ── Setup: load skinned+animated CesiumMan, fixed camera ───────────────
await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  scene.requestRenderMode = false;
  scene.globe.show = false; // isolate the model so velocity != globe/atmos
  scene.skyBox.show = false;
  scene.skyAtmosphere.show = false;
  scene.backgroundColor = C.Color.BLACK;

  const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
    C.Cartesian3.fromDegrees(0.0, 0.0, 0.0),
  );
  const model = scene.primitives.add(
    await C.Model.fromGltfAsync({
      url: "/Apps/SampleData/models/CesiumMan/Cesium_Man.glb",
      modelMatrix,
      scale: 4.0,
    }),
  );
  await new Promise((resolve) => {
    if (model.ready) return resolve();
    const rm = model.readyEvent.addEventListener(() => {
      rm();
      resolve();
    });
  });
  // Play the walk animation so joint matrices change every frame.
  model.activeAnimations.addAll({ loop: C.ModelAnimationLoop.REPEAT });

  // Fixed camera framing the model in world (ICRF) frame — NEVER moved
  // afterward, so any per-pixel velocity is purely skinning/animation-
  // driven. Frame the model's bounding sphere directly.
  const bs = model.boundingSphere;
  scene.camera.lookAt(
    bs.center,
    new C.HeadingPitchRange(0.0, -0.25, Math.max(bs.radius * 3.0, 8.0)),
  );
  // Release the reference frame but keep the world-space pose, so the
  // camera is truly stationary in ICRF (locked frames drift with Earth
  // rotation and would inject a global camera velocity).
  scene.camera.lookAtTransform(C.Matrix4.IDENTITY);

  // Advance the animation clock each frame. A high multiplier guarantees a
  // meaningful per-frame joint-pose delta in headless (where wall-clock
  // frame deltas are tiny), so the skinned vertices move several pixels
  // frame-to-frame and the velocity pass has real motion to emit.
  v.clock.shouldAnimate = true;
  v.clock.multiplier = 32.0;

  const oncePostRender = () =>
    new Promise((resolve) => {
      const rm = scene.postRender.addEventListener(() => {
        rm();
        resolve();
      });
    });

  window.__probe = {
    C,
    scene,
    model,
    runFrames: async (n) => {
      for (let f = 0; f < n; f++) {
        // Nudge the clock so animation time advances between frames even
        // if wall-clock deltas are tiny in headless.
        v.clock.currentTime = C.JulianDate.addSeconds(
          v.clock.currentTime,
          0.03,
          new C.JulianDate(),
        );
        await oncePostRender();
      }
    },
    // Inspect the model's velocity command inside a completed frame.
    inspect: () =>
      new Promise((resolve) => {
        const rm = scene.postRender.addEventListener(() => {
          rm();
          const list = scene.frameState.commandList;
          const cmd = list.find(
            (c) => c && c.owner === model && c.velocityCommand,
          );
          const fb = scene._alternateSceneRenderer?._sceneFramebuffer ?? null;
          resolve({
            modelCommandFound: !!list.find((c) => c && c.owner === model),
            hasVelocityCommand: !!cmd,
            velocityBindGroups: cmd?.velocityCommand?.bindGroups?.length ?? 0,
            velocityTextureAllocated: !!(fb?.velocityView ?? null),
          });
        });
      }),
    // Copy the rg16float velocity texture back to CPU and summarize it.
    readVelocity: async () => {
      const fb = scene._alternateSceneRenderer?._sceneFramebuffer;
      const tex = fb?._velocityTexture;
      const device = scene.context?._device;
      if (!tex || !device) return { ok: false, reason: "no texture/device" };
      const w = tex.width;
      const h = tex.height;
      const bytesPerPixel = 4; // rg16float
      const unpadded = w * bytesPerPixel;
      const padded = Math.ceil(unpadded / 256) * 256;
      const buf = device.createBuffer({
        size: padded * h,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: tex },
        { buffer: buf, bytesPerRow: padded, rowsPerImage: h },
        { width: w, height: h, depthOrArrayLayers: 1 },
      );
      device.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(buf.getMappedRange().slice(0));
      buf.unmap();
      buf.destroy();

      const half = (u16) => {
        const s = (u16 & 0x8000) >> 15;
        const e = (u16 & 0x7c00) >> 10;
        const f = u16 & 0x03ff;
        let val;
        if (e === 0) val = (f / 1024) * Math.pow(2, -14);
        else if (e === 31) val = f ? NaN : Infinity;
        else val = (1 + f / 1024) * Math.pow(2, e - 15);
        return s ? -val : val;
      };
      const dv = new DataView(bytes.buffer);
      let nonZero = 0;
      let maxMag = 0;
      let rawMax = 0; // any-magnitude max ignoring threshold/finite
      let nan = 0;
      let anyBits = 0; // count of pixels with any non-zero raw bytes
      let minX = w,
        minY = h,
        maxX = 0,
        maxY = 0;
      const THRESH = 1e-4; // NDC-delta magnitude
      for (let y = 0; y < h; y++) {
        const row = y * padded;
        for (let x = 0; x < w; x++) {
          const o = row + x * 4;
          const ru = dv.getUint16(o, true);
          const gu = dv.getUint16(o + 2, true);
          if (ru !== 0 || gu !== 0) anyBits++;
          const r = half(ru);
          const g = half(gu);
          const mag = Math.hypot(r, g);
          if (Number.isNaN(mag)) {
            nan++;
            continue;
          }
          if (mag > rawMax) rawMax = mag;
          if (mag > THRESH) {
            nonZero++;
            if (mag > maxMag) maxMag = mag;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      return {
        ok: true,
        width: w,
        height: h,
        nonZeroPixels: nonZero,
        anyBitsPixels: anyBits,
        rawMax,
        nan,
        maxMag,
        bbox: nonZero > 0 ? { minX, minY, maxX, maxY } : null,
      };
    },
    // Count lit pixels via a reliable GPU readback of the scene color
    // target (drawImage of a WebGPU canvas into a 2D context returns black
    // in headless, so it can't be used here).
    litPixels: async () => {
      const ct = scene._alternateSceneRenderer?._sceneFramebuffer?.colorTarget;
      const tex = ct?.getColorTexture?.(0) ?? null;
      const device = scene.context?._device;
      if (!tex || !device) return -1;
      const w = tex.width,
        h = tex.height;
      const padded = Math.ceil((w * 4) / 256) * 256;
      const buf = device.createBuffer({
        size: padded * h,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: tex },
        { buffer: buf, bytesPerRow: padded, rowsPerImage: h },
        { width: w, height: h, depthOrArrayLayers: 1 },
      );
      device.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const d = new Uint8Array(buf.getMappedRange().slice(0));
      buf.unmap();
      buf.destroy();
      let lit = 0;
      for (let y = 0; y < h; y++) {
        const row = y * padded;
        for (let x = 0; x < w; x++) {
          const o = row + x * 4;
          if (d[o] + d[o + 1] + d[o + 2] > 24) lit++;
        }
      }
      return lit;
    },
  };
});

// ── OFF-gate: TAA off — no velocity command, no velocity texture ───────
const off = await page.evaluate(async () => {
  window.__probe.scene.taaEnabled = false;
  await window.__probe.runFrames(20);
  return window.__probe.inspect();
});

// ── ON: TAA on — animate, then inspect + read back velocity ────────────
const on = await page.evaluate(async () => {
  window.__probe.scene.taaEnabled = true;
  // Warm up async velocity pipeline + accumulate animation delta.
  await window.__probe.runFrames(40);
  const insp = await window.__probe.inspect();
  const vel = await window.__probe.readVelocity();
  const lit = await window.__probe.litPixels();
  return { insp, vel, lit };
});

// Capture the rendered canvas for a human read.
const pngPath = `${OUT_DIR}/taa-model-skinned-velocity.png`;
await page.screenshot({ path: pngPath });

await browser.close();

// ── Verdict ────────────────────────────────────────────────────────────
const offOK =
  off.modelCommandFound &&
  !off.hasVelocityCommand &&
  !off.velocityTextureAllocated;

const v = on.vel;
const onOK =
  on.insp.modelCommandFound &&
  on.insp.hasVelocityCommand &&
  on.insp.velocityBindGroups >= 4 &&
  on.insp.velocityTextureAllocated &&
  v.ok &&
  v.nonZeroPixels > 200 && // a real cluster, not a stray texel
  v.maxMag > 1e-3 &&
  on.lit > 500; // model actually renders

const errOK = errors.length === 0;

console.log(`OFF-gate: ${JSON.stringify(off)} -> ${offOK ? "OK" : "FAIL"}`);
console.log(`ON insp:  ${JSON.stringify(on.insp)}`);
console.log(
  `ON vel:   ok=${v.ok} nonZero=${v.nonZeroPixels} anyBits=${v.anyBitsPixels} rawMax=${v.rawMax?.toExponential?.(3)} nan=${v.nan} maxMag=${v.maxMag?.toExponential?.(3)} bbox=${JSON.stringify(v.bbox)} tex=${v.width}x${v.height}`,
);
console.log(`ON lit pixels: ${on.lit}`);
console.log(`console errors: ${errors.length} -> ${errOK ? "OK" : "FAIL"}`);
if (errors.length) console.log(errors.slice(0, 8).join("\n"));
console.log(`PNG: ${pngPath}`);

const PASS = offOK && onOK && errOK;
console.log(`\nRESULT: ${PASS ? "PASS" : "FAIL"}`);
process.exit(PASS ? 0 : 1);
