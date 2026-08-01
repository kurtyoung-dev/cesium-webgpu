#!/usr/bin/env node
// Probe (NEW-ORBITAL-J2-KERNEL verify — Batch 277): the engine's df64
// (two-float / double-single) scaffold helpers + a secular-J2 mean-element
// orbital demo kernel must propagate a known element set on the GPU and
// match a CPU FP64 reference within a stated tolerance.
//
// What it does:
//   1. Fetches the SHIPPED engine scaffold WGSL
//      (ComputeInstanceScaffold.wgsl — the df64 helpers + the bindings +
//      the dispatch entry point) raw from the dev server.
//   2. Composes prologue + scaffold + the secular-J2 demo kernel exactly as
//      `WebGPUComputeInstanceRenderer` does, but binds a COPY_SRC-readable
//      output buffer so the per-instance `positionHigh + positionLow` can be
//      read back. Dispatches it for a small known LEO/MEO/GEO element set at
//      a LARGE propagation time (30 days) where f32 angle accumulation
//      visibly loses precision.
//   3. Composes the SAME model with the angle accumulation done in plain
//      f32 (no df64) — the precision-degraded control.
//   4. Implements the identical J2-secular + Kepler + GMST propagator in JS
//      FP64 as the reference.
//
// Asserts:
//   (A) df64 GPU positions match the FP64 reference within MAX_DF64_ERR_M
//       (< 1 km) at LEO over the propagation span — and well under that.
//   (B) the df64 path's max error is strictly BELOW the f32 control's max
//       error by a wide margin (the df64 precision win is real, not noise).
//   (C) zero WebGPU validation errors.
//
// Usage: node Tools/visual-regression/probe-orbital-j2.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

// Physical constants (must match the demo kernel + the JS reference).
const GM = 3.986004418e14;
const EARTH_RADIUS = 6.378137e6;
const J2 = 1.08263e-3;
const EARTH_ROTATION_RATE = 7.2921159e-5;

const FPI = 13; // a, e, inc, raan0, argp0, M0, mDotHi, mDotLo, gmst0, r,g,b, px
const PROPAGATE_SECONDS = 30 * 86400; // 30 days — f32 angle terms lose bits here
const MAX_DF64_ERR_M = 1000.0; // < 1 km tolerance (LEO over the span)

// ── A known element set (demo-owned layout; gmst0 baked as a lane) ──
// gmst0 chosen as a fixed non-trivial epoch angle so ECI->ECEF is exercised.
const GMST0 = 1.7453292519943295; // 100 deg in rad
function elementSet() {
  // [a, e, inc, raan0, argp0, M0]
  const raw = [
    // LEO — ~700 km, 51.6 deg (ISS-like)
    [EARTH_RADIUS + 700e3, 0.001, 0.9006, 0.5, 1.2, 0.3],
    // LEO — ~550 km, 53 deg
    [EARTH_RADIUS + 550e3, 0.0008, 0.925, 2.1, 0.4, 4.0],
    // LEO — ~1200 km, 87 deg (near-polar)
    [EARTH_RADIUS + 1200e3, 0.005, 1.5184, 4.7, 2.9, 1.1],
    // MEO — ~20200 km, 55 deg (GPS-like)
    [EARTH_RADIUS + 20200e3, 0.01, 0.9599, 1.0, 3.0, 5.5],
    // GEO — ~35786 km, ~0 deg
    [EARTH_RADIUS + 35786e3, 0.0003, 0.02, 3.3, 0.7, 2.2],
  ];
  return raw.map((r) => {
    const a = r[0];
    const e = r[1];
    const inc = r[2];
    const n = Math.sqrt(GM / (a * a * a));
    // J2-corrected mean-anomaly secular rate (the demo's mDot), in FP64.
    const ome2 = 1 - e * e;
    const p = a * ome2;
    const reOverP = EARTH_RADIUS / p;
    const factor = 1.5 * J2 * reOverP * reOverP * n;
    const si = Math.sin(inc);
    const mDot = n + factor * Math.sqrt(ome2) * (1 - 1.5 * si * si);
    const mDotHi = Math.fround(mDot);
    const mDotLo = mDot - mDotHi;
    return {
      a,
      e,
      inc,
      raan0: r[3],
      argp0: r[4],
      M0: r[5],
      n,
      mDot,
      mDotHi,
      mDotLo,
    };
  });
}

// ── JS FP64 reference (the trusted answer the GPU must match) ──
function propagateFP64(el, t) {
  const { a, e, inc, raan0, argp0, M0, n, mDot } = el;
  const ome2 = Math.max(1 - e * e, 1e-6);
  const p = a * ome2;
  const reOverP = EARTH_RADIUS / p;
  const factor = 1.5 * J2 * reOverP * reOverP * n;
  const ci = Math.cos(inc);
  const si = Math.sin(inc);
  const si2 = si * si;

  const raanDot = -factor * ci;
  const argpDot = factor * (2 - 2.5 * si2);

  const M = M0 + mDot * t;
  const raan = raan0 + raanDot * t;
  const argp = argp0 + argpDot * t;
  const gmst = GMST0 + EARTH_ROTATION_RATE * t;

  // Reduce M to [-pi, pi] for the Newton seed (matches the kernel).
  const Mred = reduceToPi(M);
  let E = Mred;
  for (let k = 0; k < 8; k++) {
    const f = E - e * Math.sin(E) - Mred;
    const fp = 1 - e * Math.cos(E);
    E = E - f / fp;
  }
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const r = a * (1 - e * cosE);
  const beta = Math.sqrt(Math.max(1 - e * e, 0));
  const nu = Math.atan2(beta * sinE, cosE - e);

  const u = nu + argp;
  const cu = Math.cos(u);
  const su = Math.sin(u);
  const co = Math.cos(raan);
  const so = Math.sin(raan);

  const xEci = r * (cu * co - su * ci * so);
  const yEci = r * (cu * so + su * ci * co);
  const zEci = r * (su * si);

  const cg = Math.cos(gmst);
  const sg = Math.sin(gmst);
  const xEcef = cg * xEci + sg * yEci;
  const yEcef = -sg * xEci + cg * yEci;
  const zEcef = zEci;
  return [xEcef, yEcef, zEcef];
}

function reduceToPi(angle) {
  const twoPi = 2 * Math.PI;
  let r = angle - twoPi * Math.round(angle / twoPi);
  if (r > Math.PI) r -= twoPi;
  else if (r < -Math.PI) r += twoPi;
  return r;
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
// Any page on the dev server works; we only need WebGPU + fetch.
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "domcontentloaded",
});

// Build the flat params array (FP64-faithful values; the GPU reads f32).
const els = elementSet();
const params = [];
for (const el of els) {
  params.push(
    el.a,
    el.e,
    el.inc,
    el.raan0,
    el.argp0,
    el.M0,
    el.mDotHi,
    el.mDotLo,
    GMST0,
    1.0,
    0.0,
    1.0,
    3.0,
  );
}
const instanceCount = els.length;

const gpu = await page.evaluate(
  async ({ base, params, instanceCount, fpi, time, gmst0, consts }) => {
    const { GM, EARTH_RADIUS, J2 } = consts;

    // Fetch the SHIPPED engine scaffold WGSL (df64 helpers + bindings +
    // dispatch entry point + ComputeInstanceOut struct).
    const scaffoldResp = await fetch(
      `${base}/packages/engine/Source/Shaders/WebGPU/Compute/ComputeInstanceScaffold.wgsl`,
    );
    if (!scaffoldResp.ok) {
      return { error: `scaffold fetch ${scaffoldResp.status}` };
    }
    const scaffold = await scaffoldResp.text();

    // The secular-J2 demo kernel — df64 angle accumulation with a df64
    // mDot INPUT (MUST match the Sandcastle "WebGPU Orbital Catalog" kernel).
    const j2KernelDF64 = `
      fn csm_computeInstance(index: u32, time: f32) -> ComputeInstanceOut {
        let base = index * FLOATS_PER_INSTANCE;
        let a      = params[base + 0u];
        let e      = params[base + 1u];
        let inc    = params[base + 2u];
        let raan0  = params[base + 3u];
        let argp0  = params[base + 4u];
        let m0     = params[base + 5u];
        let mDot   = vec2<f32>(params[base + 6u], params[base + 7u]);
        let gmst0  = params[base + 8u];

        let n = sqrt(${GM} / (a * a * a));
        let ome2 = max(1.0 - e * e, 1.0e-6);
        let p = a * ome2;
        let reOverP = ${EARTH_RADIUS} / p;
        let factor = 1.5 * ${J2} * reOverP * reOverP * n;
        let ci = cos(inc);
        let si = sin(inc);
        let si2 = si * si;

        let raanDot = -factor * ci;
        let argpDot = factor * (2.0 - 2.5 * si2);

        let EARTH_ROT = vec2<f32>(7.2921159e-5, -1.6085300e-12);
        let M    = csm_df64_add_f32(csm_df64_mul_f32(mDot, time), m0);
        let raan = raan0 + raanDot * time;
        let argp = argp0 + argpDot * time;
        let gmst = csm_df64_add_f32(csm_df64_mul_f32(EARTH_ROT, time), gmst0);

        let Mhi = csm_df64_reducePi(M).x;
        var E = Mhi;
        for (var k = 0; k < 4; k = k + 1) {
          let f = E - e * sin(E) - Mhi;
          let fp = 1.0 - e * cos(E);
          E = E - f / fp;
        }
        let cosE = cos(E);
        let sinE = sin(E);
        let r = a * (1.0 - e * cosE);
        let beta = sqrt(max(1.0 - e * e, 0.0));
        let nu = atan2(beta * sinE, cosE - e);

        let u = nu + argp;
        let cu = cos(u);
        let su = sin(u);
        let co = cos(raan);
        let so = sin(raan);

        let xEci = r * (cu * co - su * ci * so);
        let yEci = r * (cu * so + su * ci * co);
        let zEci = r * (su * si);

        let cg = csm_df64_cos(gmst);
        let sg = csm_df64_sin(gmst);
        let xEcef = csm_df64_add(csm_df64_mul_f32(csm_df64(cg), xEci),
                                 csm_df64_mul_f32(csm_df64(sg), yEci));
        let yEcef = csm_df64_add(csm_df64_mul_f32(csm_df64(-sg), xEci),
                                 csm_df64_mul_f32(csm_df64(cg), yEci));
        let zEcef = csm_df64(zEci);

        var out = csm_emitDF64(xEcef, yEcef, zEcef);
        out.color = vec4<f32>(params[base + 9u], params[base + 10u], params[base + 11u], 1.0);
        out.pixelSize = params[base + 12u];
        return out;
      }`;

    // SAME model + SAME inputs, but the rate is collapsed to its f32 high
    // (mDot.x) and the angle accumulation + GMST run in plain f32 — the
    // precision-degraded control. Writes positionLow = 0.
    const j2KernelF32 = `
      fn csm_computeInstance(index: u32, time: f32) -> ComputeInstanceOut {
        let base = index * FLOATS_PER_INSTANCE;
        let a      = params[base + 0u];
        let e      = params[base + 1u];
        let inc    = params[base + 2u];
        let raan0  = params[base + 3u];
        let argp0  = params[base + 4u];
        let m0     = params[base + 5u];
        let mDot   = params[base + 6u];   // f32 high only (drop the df64 low)
        let gmst0  = params[base + 8u];

        let n = sqrt(${GM} / (a * a * a));
        let ome2 = max(1.0 - e * e, 1.0e-6);
        let p = a * ome2;
        let reOverP = ${EARTH_RADIUS} / p;
        let factor = 1.5 * ${J2} * reOverP * reOverP * n;
        let ci = cos(inc);
        let si = sin(inc);
        let si2 = si * si;

        let raanDot = -factor * ci;
        let argpDot = factor * (2.0 - 2.5 * si2);

        let M = m0 + mDot * time;          // f32 — loses bits for large time
        let raan = raan0 + raanDot * time;
        let argp = argp0 + argpDot * time;
        let gmst = gmst0 + 7.2921159e-5 * time;  // f32

        // Reduce M to keep Newton well-conditioned (the f32 loss is in the
        // VALUE of the reduced angle, not in conditioning).
        let twoPi = 6.2831855;
        let Mred = M - twoPi * round(M / twoPi);
        var E = Mred;
        for (var k = 0; k < 4; k = k + 1) {
          let f = E - e * sin(E) - Mred;
          let fp = 1.0 - e * cos(E);
          E = E - f / fp;
        }
        let cosE = cos(E);
        let sinE = sin(E);
        let r = a * (1.0 - e * cosE);
        let beta = sqrt(max(1.0 - e * e, 0.0));
        let nu = atan2(beta * sinE, cosE - e);

        let u = nu + argp;
        let cu = cos(u);
        let su = sin(u);
        let co = cos(raan);
        let so = sin(raan);

        let xEci = r * (cu * co - su * ci * so);
        let yEci = r * (cu * so + su * ci * co);
        let zEci = r * (su * si);

        let cg = cos(gmst);
        let sg = sin(gmst);
        var out: ComputeInstanceOut;
        out.position = vec3<f32>(
          cg * xEci + sg * yEci,
          -sg * xEci + cg * yEci,
          zEci,
        );
        out.color = vec4<f32>(1.0, 1.0, 1.0, 1.0);
        out.pixelSize = 3.0;
        return out;
      }`;

    const prologue = `const FLOATS_PER_INSTANCE: u32 = ${fpi >>> 0}u;\n\n`;

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return { error: "no adapter" };
    }
    const device = await adapter.requestDevice();
    const validationErrors = [];
    device.addEventListener("uncapturederror", (ev) => {
      validationErrors.push(String(ev.error?.message ?? ev.error));
    });

    const INSTANCE_RECORD_BYTES = 64;

    async function runKernel(kernelSrc) {
      const code = prologue + scaffold + "\n// kernel\n" + kernelSrc + "\n";
      device.pushErrorScope("validation");
      const module = device.createShaderModule({ code });
      const info = await module.getCompilationInfo();
      const compileMsgs = info.messages
        .filter((m) => m.type === "error")
        .map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);

      // Buffers: params (storage), instance records (storage|copy_src),
      // frame params (uniform: time f32 + count u32 + 2 pad).
      const paramsArr = new Float32Array(params);
      const paramsBuf = device.createBuffer({
        size: Math.max(paramsArr.byteLength, 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(paramsBuf, 0, paramsArr);

      const recordsBuf = device.createBuffer({
        size: instanceCount * INSTANCE_RECORD_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });

      const frameBuf = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const frameData = new ArrayBuffer(16);
      new Float32Array(frameData)[0] = time;
      new Uint32Array(frameData)[1] = instanceCount;
      device.queue.writeBuffer(frameBuf, 0, frameData);

      const bgl = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "read-only-storage" },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "storage" },
          },
          {
            binding: 2,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "uniform" },
          },
        ],
      });
      const pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
        compute: { module, entryPoint: "computeInstanceMain" },
      });
      const bindGroup = device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: paramsBuf } },
          { binding: 1, resource: { buffer: recordsBuf } },
          { binding: 2, resource: { buffer: frameBuf } },
        ],
      });

      const readbackBuf = device.createBuffer({
        size: instanceCount * INSTANCE_RECORD_BYTES,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(instanceCount / 64));
      pass.end();
      enc.copyBufferToBuffer(
        recordsBuf,
        0,
        readbackBuf,
        0,
        instanceCount * INSTANCE_RECORD_BYTES,
      );
      device.queue.submit([enc.finish()]);

      await readbackBuf.mapAsync(GPUMapMode.READ);
      const view = new Float32Array(readbackBuf.getMappedRange().slice(0));
      readbackBuf.unmap();

      const scopeErr = await device.popErrorScope();

      // Record layout (64 B): high vec3 @0..2 (pad @3), low vec3 @4..6
      // (pad @7), color vec4 @8..11, pixelSize @12. 16 floats per record.
      const positions = [];
      for (let i = 0; i < instanceCount; i++) {
        const o = i * 16;
        const highX = view[o + 0],
          highY = view[o + 1],
          highZ = view[o + 2];
        const lowX = view[o + 4],
          lowY = view[o + 5],
          lowZ = view[o + 6];
        positions.push([highX + lowX, highY + lowY, highZ + lowZ]);
      }
      paramsBuf.destroy();
      recordsBuf.destroy();
      frameBuf.destroy();
      readbackBuf.destroy();
      return {
        positions,
        compileMsgs,
        scopeErr: scopeErr ? String(scopeErr.message) : null,
      };
    }

    const df64 = await runKernel(j2KernelDF64);
    const f32 = await runKernel(j2KernelF32);

    return { df64, f32, validationErrors };
  },
  {
    base: BASE,
    params,
    instanceCount,
    fpi: FPI,
    time: PROPAGATE_SECONDS,
    gmst0: GMST0,
    consts: { GM, EARTH_RADIUS, J2 },
  },
);

if (gpu.error) {
  console.log(`SETUP FAIL: ${gpu.error}`);
  await browser.close();
  process.exit(1);
}
for (const k of ["df64", "f32"]) {
  if (gpu[k].compileMsgs && gpu[k].compileMsgs.length) {
    console.log(`WGSL compile errors (${k}):`);
    gpu[k].compileMsgs.forEach((m) => console.log("  ", m));
  }
  if (gpu[k].scopeErr) {
    console.log(`validation scope error (${k}): ${gpu[k].scopeErr}`);
  }
}

// FP64 reference per instance, then per-component error of each GPU path.
const ref = els.map((el) => propagateFP64(el, PROPAGATE_SECONDS));
function errsAgainstRef(positions) {
  return positions.map((pos, i) => {
    const dx = pos[0] - ref[i][0];
    const dy = pos[1] - ref[i][1];
    const dz = pos[2] - ref[i][2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  });
}
const df64Errs = errsAgainstRef(gpu.df64.positions);
const f32Errs = errsAgainstRef(gpu.f32.positions);

// LEO instances are 0,1,2 (the strictest tolerance band).
const leoIdx = [0, 1, 2];
const df64LeoMax = Math.max(...leoIdx.map((i) => df64Errs[i]));
const df64Max = Math.max(...df64Errs);
const f32Max = Math.max(...f32Errs);
const f32LeoMax = Math.max(...leoIdx.map((i) => f32Errs[i]));

console.log(`propagation span: ${PROPAGATE_SECONDS / 86400} days`);
console.log("per-instance position error vs FP64 reference (m):");
const labels = ["LEO-700", "LEO-550", "LEO-1200", "MEO-GPS", "GEO"];
for (let i = 0; i < els.length; i++) {
  console.log(
    `  ${labels[i].padEnd(9)} df64=${df64Errs[i].toFixed(2).padStart(12)} m   f32=${f32Errs[i].toFixed(2).padStart(12)} m`,
  );
}

const aOK = df64LeoMax < MAX_DF64_ERR_M;
// df64 must beat f32 by a clear margin (>= 5x) on the worst LEO case, where
// the angle-precision loss dominates.
const ratio = f32LeoMax / Math.max(df64LeoMax, 1e-6);
const bOK = df64LeoMax < f32LeoMax && ratio >= 5.0;
const cOK = (gpu.validationErrors?.length ?? 0) === 0 && errors.length === 0;

console.log(
  `(A) df64 LEO max error ${df64LeoMax.toFixed(2)} m < ${MAX_DF64_ERR_M} m ${aOK ? "OK" : "FAIL"}`,
);
console.log(
  `(B) df64 beats f32: df64 LEO max ${df64LeoMax.toFixed(2)} m vs f32 LEO max ${f32LeoMax.toFixed(2)} m (ratio ${ratio.toFixed(1)}x, need >=5x) ${bOK ? "OK" : "FAIL"}`,
);
console.log(
  `(C) zero validation/console errors: gpu=${gpu.validationErrors?.length ?? 0} page=${errors.length} ${cOK ? "OK" : "FAIL"}`,
);
errors.slice(0, 6).forEach((e) => console.log("  ERR:", e.slice(0, 200)));
gpu.validationErrors
  ?.slice(0, 6)
  .forEach((e) => console.log("  VAL:", e.slice(0, 200)));
console.log(
  `(info) df64 all-instance max=${df64Max.toFixed(2)} m, f32 all-instance max=${f32Max.toFixed(2)} m`,
);

const pass = aOK && bOK && cOK;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
