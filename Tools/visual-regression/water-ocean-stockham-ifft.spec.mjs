// water-ocean-stockham-ifft.spec.mjs — the FFT ocean's shared-memory Stockham
// inverse FFT, executed out of the shipped WGSL through the dispatches the real
// renderer records, against the ping-pong kernel it keeps and an f64 IDFT.
//
// How it runs without a GPU. `lib/ocean-fft-device-harness.mjs` bundles the real
// `WebGPUOceanRenderer.ts` (and its compute-chain companion) over a recording
// device. One bake frame is replayed: the recorded twiddle dispatch is executed
// from `OceanTwiddle.wgsl` by `lib/wgsl-compute-exec.mjs`; at the recorded evolve
// dispatch the two textures it writes are seeded with a known spectrum instead;
// every recorded inverse-FFT dispatch is then executed, with the bind groups the
// renderer built, and the result is read from the two textures the recorded merge
// dispatch binds. So the kernel's load/store coordinates, the renderer's bind-group
// wiring and the kernel selection are all exercised, not re-implemented.
//
// f32 model. The executor rounds every f32 operation and never fuses a
// multiply-add, so "bit-identical" here means identical under IEEE f32 without
// contraction. A device may contract differently in the two kernels; the Edge
// displacement readback (FFT-ocean job) is the device-level acceptance.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createRecordingDevice,
  loadOceanRenderer,
  makeOceanPrimitive,
  runOceanFrames,
} from "./lib/ocean-fft-device-harness.mjs";
import { compileComputeModule } from "./lib/wgsl-compute-exec.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import OceanSurfacePrimitive from "../../packages/engine/Source/Scene/OceanSurfacePrimitive.js";
import GlobeWaterOcean from "../../packages/engine/Source/Scene/GlobeWaterOcean.js";
import VerticalDatum from "../../packages/engine/Source/Core/VerticalDatum.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const OCEAN = "packages/engine/Source/Shaders/WebGPU/Ocean";
const CHAIN = "Renderer/WebGPU/WebGPUOceanComputeChain.ts";

const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const WGSL = {
  twiddle: read(`${OCEAN}/OceanTwiddle.wgsl`),
  pingpong: read(`${OCEAN}/OceanIFFT.wgsl`),
  stockham: read(`${OCEAN}/OceanStockhamIFFT.wgsl`),
  evolve: read(`${OCEAN}/OceanTimeSpectrum.wgsl`),
  merge: read(`${OCEAN}/OceanMerge.wgsl`),
};
const N = 256;

/**
 * A transform for `loadOceanRenderer` that replaces one exact, unique text in
 * the file whose path ends with `suffix`; it throws if the anchor is missing or
 * repeated, so a mutant can never silently become the original.
 */
function mutation(suffix, from, to) {
  let applied = 0;
  const transform = (file, text) => {
    if (!file.endsWith(suffix)) {
      return text;
    }
    const normalized = text.replace(/\r\n/g, "\n");
    const parts = normalized.split(from);
    assert.equal(parts.length, 2, `mutation anchor in ${suffix}: ${from}`);
    applied += 1;
    return parts.join(to);
  };
  transform.applied = () => applied;
  return transform;
}

/** Two seeded spectra shaped like h(k, t): magnitude falling as 1/|k|. */
function seededSpectra() {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  const fields = [new Float32Array(N * N * 4), new Float32Array(N * N * 4)];
  for (const field of fields) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const k = Math.hypot(x - 128, y - 128) + 1;
        const i = (y * N + x) * 4;
        field[i] = Math.fround((rnd() * 0.05) / k);
        field[i + 1] = Math.fround((rnd() * 0.05) / k);
      }
    }
  }
  return fields;
}
const SPECTRA = seededSpectra();

const compiled = new Map();
function kernel(code) {
  if (!compiled.has(code)) {
    compiled.set(code, compileComputeModule(code));
  }
  return compiled.get(code);
}

function bindingsOf(dispatch) {
  const bindings = {};
  for (const entry of dispatch.entries) {
    bindings[entry.binding] = entry.texture ?? entry.buffer;
  }
  return bindings;
}

/**
 * Drive the renderer to its first dispatching (bake) frame and replay it.
 *
 * @returns {Promise<object>} The frame's dispatches, the inverse-FFT field
 *   pair the merge reads, and which kernels ran.
 */
async function replayBakeFrame({ ifftKernel, transform } = {}) {
  const api = await loadOceanRenderer(transform ? { transform } : {});
  const { device, log } = createRecordingDevice();
  const prim = makeOceanPrimitive(
    ifftKernel === undefined ? {} : { _ifftKernel: ifftKernel },
  );
  const frames = await runOceanFrames(api, device, log, prim, 3);
  const bake = frames.find((f) => f.length > 0);
  assert.ok(bake, "the renderer must dispatch within three frames");
  const ran = [];
  let output;
  for (const dispatch of bake) {
    const code = dispatch.code.replace(/\r\n/g, "\n");
    if (code === WGSL.evolve) {
      // Stand in for the time evolution: seed the two textures it writes.
      const bindings = bindingsOf(dispatch);
      for (const [binding, spectrum] of [
        [1, SPECTRA[0]],
        [2, SPECTRA[1]],
      ]) {
        bindings[binding].data = Float32Array.from(spectrum);
      }
      continue;
    }
    if (code === WGSL.merge) {
      const bindings = bindingsOf(dispatch);
      output = [bindings[0].data, bindings[1].data];
      break;
    }
    if (code === WGSL.twiddle || code === WGSL.pingpong) {
      ran.push(
        `${code === WGSL.twiddle ? "twiddle" : "pingpong"}:${dispatch.entryPoint}`,
      );
    } else if (code.includes("fn horizontalStockham(")) {
      ran.push(`stockham:${dispatch.entryPoint}`);
    } else {
      continue; // the initial spectrum: its output is not read by this replay
    }
    kernel(code).dispatch(
      dispatch.entryPoint,
      bindingsOf(dispatch),
      dispatch.workgroups,
    );
  }
  assert.ok(output, "the bake frame must reach the merge");
  return { frames, bake, ran, output, api, prim, device, log };
}

function compareFields(a, b) {
  let maxAbs = 0;
  let identical = 0;
  for (let t = 0; t < N * N; t++) {
    let same = true;
    for (const [fa, fb] of [
      [a[0], b[0]],
      [a[1], b[1]],
    ]) {
      for (const c of [0, 1]) {
        const x = fa[t * 4 + c];
        const y = fb[t * 4 + c];
        maxAbs = Math.max(maxAbs, Math.abs(x - y));
        same &&= Object.is(x, y);
      }
    }
    identical += same ? 1 : 0;
  }
  return { maxAbs, identical };
}

/** Max abs error of a field pair against an f64 2D IDFT on a sparse grid. */
function errorVsIdft(fields) {
  let maxErr = 0;
  let maxRef = 0;
  for (let f = 0; f < 2; f++) {
    const spectrum = SPECTRA[f];
    for (let yy = 0; yy < N; yy += 37) {
      for (let xx = 0; xx < N; xx += 41) {
        let re = 0;
        let im = 0;
        for (let y = 0; y < N; y++) {
          for (let x = 0; x < N; x++) {
            const a = (2 * Math.PI * ((x * xx + y * yy) % N)) / N;
            const i = (y * N + x) * 4;
            const c = Math.cos(a);
            const s = Math.sin(a);
            re += spectrum[i] * c - spectrum[i + 1] * s;
            im += spectrum[i] * s + spectrum[i + 1] * c;
          }
        }
        const o = (yy * N + xx) * 4;
        maxRef = Math.max(maxRef, Math.abs(re), Math.abs(im));
        maxErr = Math.max(
          maxErr,
          Math.abs(fields[f][o] - re),
          Math.abs(fields[f][o + 1] - im),
        );
      }
    }
  }
  return { maxErr, maxRef };
}

let pingpongRun;
let stockhamRun;
let defaultRun;
async function runs() {
  pingpongRun ??= await replayBakeFrame({ ifftKernel: "pingpong" });
  stockhamRun ??= await replayBakeFrame({ ifftKernel: "stockham" });
  defaultRun ??= await replayBakeFrame();
  return { pingpongRun, stockhamRun, defaultRun };
}

/** The parity law a kernel run must satisfy; throws when it does not. */
function assertParity(run, reference) {
  const { maxAbs, identical } = compareFields(run.output, reference.output);
  assert.equal(
    identical,
    N * N,
    `Stockham vs ping-pong: ${N * N - identical} texels differ (max ${maxAbs})`,
  );
  const { maxErr } = errorVsIdft(run.output);
  assert.ok(maxErr < 1e-6, `Stockham vs f64 IDFT: ${maxErr}`);
}

test("the Stockham module the renderer compiles is the shipped file and passes Naga", async () => {
  const { stockhamRun: run } = await runs();
  const codes = new Set(
    run.bake
      .filter((d) => d.entryPoint.endsWith("Stockham"))
      .map((d) => d.code.replace(/\r\n/g, "\n")),
  );
  assert.deepEqual([...codes], [WGSL.stockham]);
  const nagaDirectory = path.join(
    ROOT,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  assert.doesNotThrow(() => naga.validate_wgsl(WGSL.stockham));
  // Its workgroup storage is two 256 x vec4<f32> arrays: 8,192 of the 16,384
  // bytes WebGPU guarantees.
  const arrays = [
    ...WGSL.stockham.matchAll(
      /var<workgroup>\s+\w+:\s*array<vec4<f32>,\s*(\d+)>/g,
    ),
  ].map((m) => Number(m[1]) * 16);
  assert.equal(
    arrays.reduce((a, b) => a + b, 0),
    8192,
  );
});

test("PARITY: the Stockham path is bit-identical to the ping-pong path and within 1e-6 of an f64 IDFT", async () => {
  const { pingpongRun: pp, stockhamRun: st } = await runs();
  assert.deepEqual(st.ran, [
    "twiddle:precompute",
    "stockham:horizontalStockham",
    "stockham:verticalStockham",
  ]);
  assert.equal(pp.ran.filter((r) => r.startsWith("pingpong:")).length, 32);
  const ppError = errorVsIdft(pp.output);
  assert.ok(ppError.maxErr < 1e-6, `ping-pong vs f64 IDFT: ${ppError.maxErr}`);
  assert.ok(ppError.maxRef > 1e-3, "the reference must not be trivially zero");
  assertParity(st, pp);
});

test("the default kernel is Stockham, and it is the same field", async () => {
  const { defaultRun: run, pingpongRun: pp } = await runs();
  assert.deepEqual(
    run.ran.filter((r) => !r.startsWith("twiddle")),
    ["stockham:horizontalStockham", "stockham:verticalStockham"],
  );
  assertParity(run, pp);
});

test("dispatches per frame: 2 inverse-FFT dispatches on Stockham, 32 on ping-pong", async () => {
  const { pingpongRun: pp, stockhamRun: st } = await runs();
  const ifft = (frame) =>
    frame.filter((d) => /Step$|Stockham$/.test(d.entryPoint)).length;
  const steady = (run) => run.frames.at(-1);
  // Measured: bake frame 6 vs 36, steady frame 4 vs 34.
  assert.equal(st.bake.length, 6);
  assert.equal(pp.bake.length, 36);
  assert.equal(steady(st).length, 4);
  assert.equal(steady(pp).length, 34);
  assert.equal(ifft(steady(st)), 2);
  assert.equal(ifft(steady(pp)), 32);
  for (const d of steady(st).filter((x) => x.entryPoint.endsWith("Stockham"))) {
    assert.deepEqual(d.workgroups, [N, 1, 1]);
  }
});

test("the kernel switches at runtime without a re-bake or a new resource", async () => {
  const api = await loadOceanRenderer();
  const { device, log } = createRecordingDevice();
  const prim = makeOceanPrimitive({ _ifftKernel: "pingpong" });
  await runOceanFrames(api, device, log, prim, 3);
  // Both kernels' pipelines are requested at initialisation, so a switch
  // needs no compile: eight compute pipelines, two of them Stockham.
  const compute = log.pipelines.filter((p) => p.kind === "compute");
  assert.equal(compute.length, 8);
  assert.deepEqual(
    compute
      .map((p) => p.compute.entryPoint)
      .filter((e) => e.endsWith("Stockham")),
    ["horizontalStockham", "verticalStockham"],
  );
  const textures = log.textures.length;
  const buffers = log.buffers.length;
  prim._ifftKernel = "stockham";
  const [toStockham] = await runOceanFrames(api, device, log, prim, 1);
  prim._ifftKernel = "pingpong";
  const [back] = await runOceanFrames(api, device, log, prim, 1);
  assert.deepEqual(
    toStockham.map((d) => d.entryPoint),
    ["evolve", "horizontalStockham", "verticalStockham", "merge"],
  );
  assert.equal(back.length, 34);
  assert.equal(log.textures.length, textures);
  assert.equal(log.buffers.length, buffers);
});

test("lifecycle: 20 enable/run/destroy cycles on each kernel leave nothing live and do not grow", async () => {
  const api = await loadOceanRenderer();
  const { device, log } = createRecordingDevice();
  const perCycle = [];
  for (let cycle = 0; cycle < 20; cycle++) {
    const prim = makeOceanPrimitive({
      _ifftKernel: cycle % 2 === 0 ? "stockham" : "pingpong",
    });
    const before = [log.textures.length, log.buffers.length];
    await runOceanFrames(api, device, log, prim, 2);
    api.destroyWebGPUOceanResources(prim);
    assert.equal(prim._webgpuCache, undefined);
    assert.equal(log.liveTextures().length, 0, `cycle ${cycle} textures`);
    assert.equal(log.liveBuffers().length, 0, `cycle ${cycle} buffers`);
    perCycle.push([
      log.textures.length - before[0],
      log.buffers.length - before[1],
    ]);
  }
  assert.equal(new Set(perCycle.map(String)).size, 1, String(perCycle));
});

test("the public option: OceanSurfacePrimitive and GlobeWaterOcean carry ifftKernel", () => {
  assert.equal(new OceanSurfacePrimitive()._ifftKernel, "stockham");
  const prim = new OceanSurfacePrimitive({ ifftKernel: "pingpong" });
  assert.equal(prim.ifftKernel, "pingpong");
  prim.ifftKernel = "radix4";
  assert.equal(prim._ifftKernel, "pingpong", "an unknown kernel is ignored");
  prim.ifftKernel = "stockham";
  assert.equal(prim._ifftKernel, "stockham");
  assert.equal(
    new OceanSurfacePrimitive({ ifftKernel: 7 })._ifftKernel,
    "stockham",
  );

  const added = [];
  const scene = {
    primitives: {
      add: (p) => added.push(p),
      remove: () => true,
    },
  };
  const ocean = new GlobeWaterOcean(scene, undefined);
  ocean.verticalDatum = VerticalDatum.ELLIPSOID;
  assert.equal(ocean.ifftKernel, "stockham");
  ocean.ifftKernel = "pingpong";
  ocean.enabled = true;
  assert.equal(added[0]._ifftKernel, "pingpong", "forwarded on creation");
  ocean.ifftKernel = "stockham";
  assert.equal(added[0]._ifftKernel, "stockham", "forwarded live");
  ocean.ifftKernel = "bogus";
  assert.equal(ocean.ifftKernel, "stockham");
  ocean.enabled = false;
});

// ─────────────────────────────── mutants ───────────────────────────────

test("MUTANT R1: a transposed vertical-pass coordinate breaks parity", async () => {
  const { pingpongRun: pp } = await runs();
  const transform = mutation(
    "OceanStockhamIFFT.wgsl",
    "let coord = vec2<i32>(i32(wid.x), i32(t)); // lane = row, workgroup = column",
    "let coord = vec2<i32>(i32(t), i32(wid.x));",
  );
  const run = await replayBakeFrame({ ifftKernel: "stockham", transform });
  assert.ok(transform.applied() > 0);
  assert.throws(() => assertParity(run, pp), /texels differ/);
});

test("MUTANT R2: the vertical pass reading field A leaves the horizontal output unreachable", async () => {
  const { pingpongRun: pp } = await runs();
  const transform = mutation(
    CHAIN,
    'stockhamBindGroup("Ocean Stockham V BG", 1, 0)',
    'stockhamBindGroup("Ocean Stockham V BG", 0, 0)',
  );
  const run = await replayBakeFrame({ ifftKernel: "stockham", transform });
  assert.ok(transform.applied() > 0);
  assert.throws(() => assertParity(run, pp), /texels differ/);
});

test("MUTANT R3: a missing workgroup barrier between stages breaks parity", async () => {
  const { pingpongRun: pp } = await runs();
  const transform = mutation(
    "OceanStockhamIFFT.wgsl",
    "    sPong[t] = stockhamButterfly(d0, sPing[u32(d0.b)], sPing[u32(d0.a)]);\n    workgroupBarrier();",
    "    sPong[t] = stockhamButterfly(d0, sPing[u32(d0.b)], sPing[u32(d0.a)]);",
  );
  const run = await replayBakeFrame({ ifftKernel: "stockham", transform });
  assert.ok(transform.applied() > 0);
  assert.throws(() => assertParity(run, pp), /texels differ/);
});

test("MUTANT toggle: 'pingpong' selected but Stockham dispatched goes red", async () => {
  const transform = mutation(
    CHAIN,
    'return value === "pingpong" ? "pingpong" : "stockham";',
    'return false && value === "pingpong" ? "pingpong" : "stockham";',
  );
  const run = await replayBakeFrame({ ifftKernel: "pingpong", transform });
  assert.ok(transform.applied() > 0);
  assert.throws(() =>
    assert.equal(run.ran.filter((r) => r.startsWith("pingpong:")).length, 32),
  );
});

test("MUTANT inertness: an unreachable Stockham branch leaves the default on ping-pong and goes red", async () => {
  const transform = mutation(
    CHAIN,
    'if (kernel === "stockham") {',
    'if (false && kernel === "stockham") {',
  );
  const run = await replayBakeFrame({ transform });
  assert.ok(transform.applied() > 0);
  assert.throws(() =>
    assert.deepEqual(
      run.ran.filter((r) => !r.startsWith("twiddle")),
      ["stockham:horizontalStockham", "stockham:verticalStockham"],
    ),
  );
});

test("MUTANT executor: without f32 rounding the executor no longer reproduces the f32 field", async () => {
  const { stockhamRun: st } = await runs();
  const execPath = path.join(HERE, "lib/wgsl-compute-exec.mjs");
  const runStockham = (exec) => {
    const tex = (format, width = N, data = null) => ({
      width,
      height: N,
      format,
      data,
    });
    const u32 = (...v) => ({
      bytes: new Uint8Array(
        new Uint32Array([...v, 0, 0, 0, 0].slice(0, 4)).buffer,
      ),
    });
    const twiddle = tex("rgba32float", 8);
    exec
      .compileComputeModule(WGSL.twiddle)
      .dispatch("precompute", { 0: twiddle, 1: u32(N, 8) }, [8, N / 64, 1]);
    const a1 = tex("rg32float", N, Float32Array.from(SPECTRA[0]));
    const a2 = tex("rg32float", N, Float32Array.from(SPECTRA[1]));
    const b1 = tex("rg32float");
    const b2 = tex("rg32float");
    const stockham = exec.compileComputeModule(WGSL.stockham);
    stockham.dispatch(
      "horizontalStockham",
      { 0: twiddle, 1: a1, 2: a2, 3: b1, 4: b2 },
      [N, 1, 1],
    );
    stockham.dispatch(
      "verticalStockham",
      { 0: twiddle, 1: b1, 2: b2, 3: a1, 4: a2 },
      [N, 1, 1],
    );
    return [a1.data, a2.data];
  };
  const real = runStockham(await import(pathToFileURL(execPath).href));
  assert.equal(compareFields(real, st.output).identical, N * N);
  const unrounded = runStockham(
    await importMutated(execPath, [
      ["const F = Math.fround;", "const F = (x) => x;"],
    ]),
  );
  assert.ok(
    compareFields(unrounded, st.output).identical < N * N,
    "an executor without f32 rounding must not reproduce the f32 result",
  );
});
