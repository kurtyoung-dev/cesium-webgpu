#!/usr/bin/env node
// Probe (NEW-COMPUTE-INSTANCE-WEBGL2-FALLBACK verify): a
// `ComputeInstanceCollection` with a `cpuKernel` must RENDER and MOVE on the
// WebGL2 backend (which has no compute shaders), and land its dots at the same
// screen positions as the WebGPU compute leg within tolerance.
//
// The SAME scene is built twice — once on ?renderer=webgl (the new CPU-kernel
// fallback path) and once on ?renderer=webgpu (the GPU compute path) — with a
// matching WGSL `kernel` + JS `cpuKernel` pair (a non-orbital Lissajous toy,
// proving the system carries no orbital knowledge). For each backend the probe
// captures the magenta dot mask at two sim times from a FIXED camera.
//
// Asserts:
//   (A) WebGL RENDERS — magenta pixel count over threshold at both times.
//   (B) WebGL MOVES   — the magenta mask changes substantially between the two
//       times while the camera is fixed (animation comes purely from the
//       per-frame time scalar; params upload once).
//   (C) WebGL ~ WebGPU — the two backends' magenta centroids agree within a
//       few pixels at the same sim time (same RTE math, same quad expansion),
//       and the per-backend rendered/move behavior matches.
//   (D) zero console / WebGPU validation errors on either backend.
//
// Determinism: requestRenderMode off, clock pinned to epoch + frameIndex*step,
// readback inside scene.postRender (same harness as
// probe-compute-instance-generic.mjs).
//
// Usage: node Tools/visual-regression/probe-compute-instance-webgl2.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

// The shared toy kernel — a Lissajous figure-8 anchored 8 Mm out on +X,
// rotating about +X over time. Expressed BOTH as a WGSL string (GPU) and a JS
// function (CPU) that compute the identical position; the probe asserts they
// agree on screen. Lanes: 0 phase(rad), 1 pixelSize(px).
const WGSL_KERNEL = `
  fn csm_computeInstance(index: u32, time: f32) -> ComputeInstanceOut {
    let base = index * FLOATS_PER_INSTANCE;
    let phase = params[base + 0u];
    let t = time * 0.003 + phase;
    let p = vec2<f32>(2.5e6 * sin(t), 1.2e6 * sin(2.0 * t));
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

// The JS cpuKernel mirror — same math. Stringified into the page (it runs in
// the browser context). MUST stay in lockstep with WGSL_KERNEL above.
const CPU_KERNEL_SRC = `
  function cpuKernel(out, index, time, params) {
    const base = index * 2;
    const phase = params[base + 0];
    const t = time * 0.003 + phase;
    const px = 2.5e6 * Math.sin(t);
    const py = 1.2e6 * Math.sin(2.0 * t);
    const rot = time * 0.0005;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const yzx = c * px - s * py;
    const yzy = s * px + c * py;
    out.position.x = 8.0e6;
    out.position.y = yzx;
    out.position.z = yzy;
    out.color.red = 1.0;
    out.color.green = 0.0;
    out.color.blue = 1.0;
    out.color.alpha = 1.0;
    out.pixelSize = params[base + 1];
  }`;

async function runBackend(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(
    async ({ wgsl, cpuSrc }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      scene.requestRenderMode = false;
      v.clock.shouldAnimate = false;

      let seed = 0x9e3779b9;
      const rand = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
      };

      // eslint-disable-next-line no-new-func
      const cpuKernel = new Function(`${cpuSrc}; return cpuKernel;`)();

      const collection = scene.primitives.add(
        new C.ComputeInstanceCollection({
          kernel: wgsl,
          cpuKernel: cpuKernel,
          floatsPerInstance: 2,
          boundingSphere: new C.BoundingSphere(C.Cartesian3.ZERO, 4.4e7),
        }),
      );
      const epoch = C.JulianDate.clone(v.clock.currentTime);
      collection.epoch = epoch;
      const COUNT = 400;
      for (let i = 0; i < COUNT; i++) {
        collection.addInstance([rand() * 2.0 * Math.PI, 10.0]);
      }

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
      const grab = () =>
        new Promise((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            const cv = scene.canvas;
            const off = document.createElement("canvas");
            off.width = cv.width;
            off.height = cv.height;
            const cx = off.getContext("2d");
            cx.drawImage(cv, 0, 0);
            resolve({
              data: cx.getImageData(0, 0, cv.width, cv.height).data,
              w: cv.width,
              h: cv.height,
            });
          });
        });
      const isMagenta = (d, i) => d[i] > 150 && d[i + 2] > 150 && d[i + 1] < 90;
      const analyze = (img) => {
        let count = 0;
        let sx = 0;
        let sy = 0;
        const mask = new Uint8Array(img.w * img.h);
        for (let p = 0; p < mask.length; p++) {
          if (isMagenta(img.data, 4 * p)) {
            mask[p] = 1;
            count++;
            sx += p % img.w;
            sy += (p / img.w) | 0;
          }
        }
        return {
          count,
          cx: count ? sx / count : 0,
          cy: count ? sy / count : 0,
          mask,
        };
      };

      let f = 0;
      for (; f < 15; f++) {
        await renderAt(f * 30.0);
      }
      const A = analyze(await grab());
      for (; f < 60; f++) {
        await renderAt(f * 30.0);
      }
      const B = analyze(await grab());

      let changed = 0;
      for (let p = 0; p < A.mask.length; p++) {
        if (A.mask[p] !== B.mask[p]) changed++;
      }
      const denom = Math.max(A.count, B.count, 1);

      return {
        instanceCount: collection.length,
        usedFallback: !!collection._webglCache,
        usedWebGPU: !!collection._webgpuCache,
        A: { count: A.count, cx: A.cx, cy: A.cy },
        B: { count: B.count, cx: B.cx, cy: B.cy },
        changedPct: changed / denom,
      };
    },
    { wgsl: WGSL_KERNEL, cpuSrc: CPU_KERNEL_SRC },
  );

  await browser.close();
  return { ...out, errors };
}

const webgl = await runBackend("webgl");
const webgpu = await runBackend("webgpu");

// (A) WebGL renders, (B) WebGL moves.
const aOK = webgl.A.count > 250 && webgl.B.count > 250;
const bOK = webgl.changedPct > 0.2;
// The WebGL leg must have gone through the CPU fallback, not the WebGPU cache.
const pathOK = webgl.usedFallback && !webgl.usedWebGPU;

// (C) WebGL ~ WebGPU centroid agreement at the SAME sim time (frame 15 -> A).
const dcx = webgl.A.cx - webgpu.A.cx;
const dcy = webgl.A.cy - webgpu.A.cy;
const centroidDist = Math.sqrt(dcx * dcx + dcy * dcy);
// A few px of slack: f32 kernel low=0 on the GPU vs AGI-split low on the CPU,
// plus AA edges. The dots span ~1e7 m on a 1024px viewport (~3e5 m/px), so a
// handful of px is well within "same position".
const cOK = centroidDist < 8.0 && webgpu.A.count > 250;

// (D) no errors on either backend.
const dOK = webgl.errors.length === 0 && webgpu.errors.length === 0;

console.log(
  `(A) WebGL renders: ${webgl.instanceCount} instances -> magenta px frame15=${webgl.A.count} frame60=${webgl.B.count} (threshold 250) ${aOK ? "OK" : "FAIL"}`,
);
console.log(
  `(B) WebGL moves: mask changed ${(webgl.changedPct * 100).toFixed(1)}% (threshold 20%) ${bOK ? "OK" : "FAIL"}`,
);
console.log(
  `    path: usedFallback=${webgl.usedFallback} usedWebGPU=${webgl.usedWebGPU} ${pathOK ? "OK" : "FAIL"}`,
);
console.log(
  `(C) WebGL~WebGPU centroid @frame15: webgl=(${webgl.A.cx.toFixed(1)},${webgl.A.cy.toFixed(1)}) webgpu=(${webgpu.A.cx.toFixed(1)},${webgpu.A.cy.toFixed(1)}) dist=${centroidDist.toFixed(2)}px (threshold 8) webgpuCount=${webgpu.A.count} ${cOK ? "OK" : "FAIL"}`,
);
console.log(
  `(D) console/validation errors: webgl=${webgl.errors.length} webgpu=${webgpu.errors.length} ${dOK ? "OK" : "FAIL"}`,
);
webgl.errors
  .slice(0, 5)
  .forEach((e) => console.log("  WEBGL ERR:", e.slice(0, 220)));
webgpu.errors
  .slice(0, 5)
  .forEach((e) => console.log("  WEBGPU ERR:", e.slice(0, 220)));

const pass = aOK && bOK && pathOK && cOK && dOK;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
