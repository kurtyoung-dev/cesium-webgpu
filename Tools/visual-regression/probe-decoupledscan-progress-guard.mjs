#!/usr/bin/env node
// Probe (C4-DECOUPLEDSCAN-PROGRESS-GUARD verify): the decoupled-lookback
// prefix-sum kernel must (a) still compute a CORRECT inclusive prefix sum
// across MANY workgroups now that the forward-progress watchdog bounds the
// lookback spin (A2.3), and (b) always TERMINATE (never hang the device).
//
// Background: WebGPU/WGSL guarantee no cross-workgroup forward progress, so
// the naive `loop { atomicLoad; if !empty break; storageBarrier() }` spin in
// DecoupledLookbackScan.wgsl could livelock and hang the GPU if a predecessor
// partition is never scheduled. The fix adds a bounded spin budget
// (MAX_LOOKBACK_SPINS) plus a host-side occupancy gate. This probe proves the
// watchdog does NOT change results on the normal path (the off-gate / parity
// evidence: correct scan output) and that deep multi-workgroup lookback
// terminates well within a frame.
//
// It runs the ACTUAL built WGSL on a real WebGPU device. The shader source is
// read from disk and injected (the dev server caches shader bytes in memory,
// so an HTTP fetch can serve a stale copy — reading the built file guarantees
// the freshly-compiled shader is exercised).
//
// This is a compute/unit-style probe — there is no rendered image, so there
// is no PNG to read; correctness is asserted numerically against the CPU
// reference prefix sum.
//
// Usage: node Tools/visual-regression/probe-decoupledscan-progress-guard.mjs
// Env:   PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const __dirname = dirname(fileURLToPath(import.meta.url));
const WGSL_PATH = resolve(
  __dirname,
  "../../Build/CesiumUnminified/Shaders/WebGPU/Compute/DecoupledLookbackScan.wgsl",
);

const wgsl = readFileSync(WGSL_PATH, "utf8");
const hasWatchdog = /MAX_LOOKBACK_SPINS/.test(wgsl);

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

// A blank secure-context page is enough — we only need a WebGPU device.
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "domcontentloaded",
});

const out = await page.evaluate(async (code) => {
  if (!navigator.gpu) return { fatal: "navigator.gpu missing" };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { fatal: "no adapter" };
  const device = await adapter.requestDevice();

  const validationErrors = [];
  device.addEventListener?.("uncapturederror", (e) =>
    validationErrors.push(String(e.error?.message ?? e.error)),
  );

  device.pushErrorScope("validation");
  const module = device.createShaderModule({ code });
  const pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module, entryPoint: "scan" },
  });

  const WORKGROUP = 256;
  const ST = GPUBufferUsage.STORAGE;
  const CD = GPUBufferUsage.COPY_DST;
  const CS = GPUBufferUsage.COPY_SRC;

  // Runs one scan over `input` (Uint32Array) and returns the GPU output.
  async function runScan(input) {
    const n = input.length;
    const partitionCount = Math.ceil(n / WORKGROUP);

    const paramsBuf = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | CD,
    });
    const params = new Uint32Array(64);
    params[0] = n;
    device.queue.writeBuffer(paramsBuf, 0, params.buffer, 0, 256);

    const inputBuf = device.createBuffer({ size: n * 4, usage: ST | CD });
    device.queue.writeBuffer(inputBuf, 0, input.buffer, 0, n * 4);

    const outputBuf = device.createBuffer({ size: n * 4, usage: ST | CS });

    const partitionsBuf = device.createBuffer({
      size: Math.max(4, partitionCount * 4),
      usage: ST | CD,
    });
    device.queue.writeBuffer(
      partitionsBuf,
      0,
      new Uint32Array(Math.max(1, partitionCount)).buffer,
    );

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuf } },
        { binding: 1, resource: { buffer: inputBuf } },
        { binding: 2, resource: { buffer: outputBuf } },
        { binding: 3, resource: { buffer: partitionsBuf } },
      ],
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(partitionCount, 1, 1);
    pass.end();

    const readBuf = device.createBuffer({
      size: n * 4,
      usage: GPUBufferUsage.MAP_READ | CD,
    });
    enc.copyBufferToBuffer(outputBuf, 0, readBuf, 0, n * 4);
    device.queue.submit([enc.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const result = new Uint32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    return result;
  }

  // CPU reference inclusive prefix sum.
  function cpuScan(input) {
    const r = new Uint32Array(input.length);
    let acc = 0;
    for (let i = 0; i < input.length; i++) {
      acc += input[i];
      r[i] = acc;
    }
    return r;
  }

  function firstMismatch(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return { i, gpu: a[i], cpu: b[i] };
    }
    return null;
  }

  const cases = [];

  // Case 1: 4000 all-ones (16 workgroups) → output[i] = i+1.
  {
    const n = 4000;
    const input = new Uint32Array(n).fill(1);
    const t0 = performance.now();
    const gpu = await runScan(input);
    const ms = performance.now() - t0;
    const mm = firstMismatch(gpu, cpuScan(input));
    cases.push({ name: "4000-ones(16wg)", n, ms, mismatch: mm });
  }

  // Case 2: 3211 pseudo-random small values (13 workgroups, ragged tail).
  {
    const n = 3211;
    const input = new Uint32Array(n);
    let s = 12345;
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      input[i] = s % 7; // small so the 30-bit VALUE_MASK never overflows
    }
    const gpu = await runScan(input);
    const mm = firstMismatch(gpu, cpuScan(input));
    cases.push({ name: "3211-random(13wg)", n, mismatch: mm });
  }

  // Case 3: 100000 all-ones (391 workgroups) — deep lookback; MUST terminate
  // quickly with the watchdog in place and produce output[last] = 100000.
  {
    const n = 100000;
    const input = new Uint32Array(n).fill(1);
    const t0 = performance.now();
    const gpu = await runScan(input);
    const ms = performance.now() - t0;
    const mm = firstMismatch(gpu, cpuScan(input));
    cases.push({
      name: "100000-ones(391wg)",
      n,
      ms,
      last: gpu[n - 1],
      mismatch: mm,
    });
  }

  const scopeErr = await device.popErrorScope();

  return { cases, scopeErr: scopeErr ? scopeErr.message : null, validationErrors };
}, wgsl);

await browser.close();

if (out.fatal) {
  console.error(`FATAL: ${out.fatal}`);
  process.exit(1);
}

let pass = true;
console.log(`WGSL watchdog constant present (MAX_LOOKBACK_SPINS): ${hasWatchdog}`);
if (!hasWatchdog) pass = false;

for (const c of out.cases) {
  const ok = c.mismatch === null;
  if (!ok) pass = false;
  const extra =
    (c.ms !== undefined ? ` ${c.ms.toFixed(1)}ms` : "") +
    (c.last !== undefined ? ` last=${c.last}` : "");
  console.log(
    `[${c.name}] n=${c.n}${extra} → ${ok ? "PASS" : `FAIL mismatch@${c.mismatch.i} gpu=${c.mismatch.gpu} cpu=${c.mismatch.cpu}`}`,
  );
}

if (out.scopeErr) {
  console.error(`shader/pipeline validation error: ${out.scopeErr}`);
  pass = false;
}
if (out.validationErrors?.length) {
  console.error(`device validation errors: ${out.validationErrors.join(" | ")}`);
  pass = false;
}
if (errors.length) {
  console.error(`console errors: ${errors.join(" | ")}`);
  pass = false;
}

console.log(pass ? "\nPROBE PASS" : "\nPROBE FAIL");
process.exit(pass ? 0 : 1);
