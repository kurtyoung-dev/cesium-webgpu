#!/usr/bin/env node
// Probe (NEW-POINTCLOUDLOD-SLOT255-OFFBYONE verify): the point-cloud LOD
// compute compaction must NOT corrupt the point at local slot 255 when a
// workgroup is fully occupied (all 256 lanes visible).
//
// Root cause being verified: the old shader reused `sharedVisible[255]` to
// broadcast the workgroup's global output offset. That slot is also a REAL
// compacted-index storage slot, and at full occupancy (LOD 0 keeps every
// point + all pass the frustum/distance test) `localCount == 256`, so slot
// 255 holds the 256th visible point's index. Overwriting it with the base
// offset corrupted that point — it was written to the output as the base
// offset value (0 for the first workgroup) instead of its true index, which
// shows up as a DUPLICATE of index 0 and a MISSING index 255.
//
// This probe runs the actual generated WGSL directly on a real WebGPU
// device (no Scene wiring needed — the LOD processor is a standalone compute
// utility). It crafts a 256-point set positioned so EVERY point is visible
// at LOD 0, dispatches one workgroup, reads back the compacted indices +
// count, and asserts the output is exactly the permutation {0..255} with no
// duplicate and no dropped index. Pre-fix this fails (index 0 duplicated,
// index 255 absent); post-fix it passes.
//
// Both entry points are exercised: the portable `computeMain` and, when the
// device exposes subgroups, `computeMainSubgroups` (it had the identical
// slot-255 clobber).
//
// Usage: node Tools/visual-regression/probe-pointcloud-lod.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const WGSL_URL = `${BASE}/Build/CesiumUnminified/Shaders/WebGPU/Compute/PointCloudLOD.wgsl`;

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

// A blank page is enough — we only need a WebGPU device, not a Cesium scene.
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "domcontentloaded",
});

const out = await page.evaluate(async (wgslUrl) => {
  // ── Acquire a device ────────────────────────────────────────────────
  if (!navigator.gpu) return { fatal: "navigator.gpu missing" };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { fatal: "no adapter" };
  const hasSubgroups =
    adapter.features.has("subgroups") ||
    adapter.features.has("chromium-experimental-subgroups");
  const device = await adapter.requestDevice({
    requiredFeatures: hasSubgroups
      ? [
          adapter.features.has("subgroups")
            ? "subgroups"
            : "chromium-experimental-subgroups",
        ]
      : [],
  });

  const validationErrors = [];
  device.addEventListener?.("uncapturederror", (e) =>
    validationErrors.push(String(e.error?.message ?? e.error)),
  );

  // ── Fetch the generated WGSL (the exact source the processor compiles) ─
  const rawShader = await (await fetch(wgslUrl)).text();

  const POINT_COUNT = 256; // exactly one full workgroup
  const MAX_VISIBLE = 256;

  // Params layout MUST match struct LODParams in PointCloudLOD.wgsl.
  // 36 f32/u32 slots, 144 bytes, padded to 256.
  const PARAMS_BYTES = 256;
  const f = new Float32Array(64);
  const u = new Uint32Array(f.buffer);
  // cameraPositionWC = origin
  f[0] = 0;
  f[1] = 0;
  f[2] = 0;
  f[3] = 0;
  // LOD distance² thresholds — make lod0Distance2 huge so EVERY point is
  // LOD 0 (keep-all). The others just need to be >= lod0.
  f[4] = 1e30; // lod0Distance2
  f[5] = 1e30; // lod1Distance2
  f[6] = 1e30; // lod2Distance2
  f[7] = 1e30; // lod3Distance2
  // 6 frustum planes at slots 8..31. Use planes that pass ALL points:
  // each plane normal·pos + w >= 0 for points near the origin. Six planes
  // of a generous axis-aligned box centered at origin, half-extent 1e6.
  // Plane form: dot(n, p) + w >= 0  (inside = positive).
  const planes = [
    [1, 0, 0, 1e6], // +X face:  x + 1e6 >= 0
    [-1, 0, 0, 1e6], // -X face: -x + 1e6 >= 0
    [0, 1, 0, 1e6],
    [0, -1, 0, 1e6],
    [0, 0, 1, 1e6],
    [0, 0, -1, 1e6],
  ];
  for (let i = 0; i < 6; i++) {
    f[8 + i * 4 + 0] = planes[i][0];
    f[8 + i * 4 + 1] = planes[i][1];
    f[8 + i * 4 + 2] = planes[i][2];
    f[8 + i * 4 + 3] = planes[i][3];
  }
  u[32] = POINT_COUNT;
  u[33] = MAX_VISIBLE;
  f[34] = 1.0; // screenSpaceRadius
  f[35] = 0.0; // geometricError

  // Positions: all within the box (so all 256 are visible at LOD 0).
  const posX = new Float32Array(POINT_COUNT);
  const posY = new Float32Array(POINT_COUNT);
  const posZ = new Float32Array(POINT_COUNT);
  for (let i = 0; i < POINT_COUNT; i++) {
    // Small spread well inside the ±1e6 box and inside lod0 distance.
    posX[i] = (i - 128) * 10;
    posY[i] = 0;
    posZ[i] = 0;
  }

  // ── Run one entry point, return the sorted visible-index list + count ─
  async function runEntry(entryPoint) {
    // Prepend `enable subgroups;` for the subgroup variant, else strip the
    // subgroup block — exactly what WebGPUPointCloudLODProcessor.initialize
    // does.
    let code;
    if (entryPoint === "computeMainSubgroups") {
      code = `enable subgroups;\n${rawShader}`;
    } else {
      code = rawShader.replace(
        /\/\/ __SUBGROUP_BLOCK_START__[\s\S]*?\/\/ __SUBGROUP_BLOCK_END__/,
        "// (stripped)",
      );
    }

    device.pushErrorScope("validation");
    const module = device.createShaderModule({ code });
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint },
    });

    const mk = (size, usage, data) => {
      const b = device.createBuffer({ size, usage });
      if (data) device.queue.writeBuffer(b, 0, data);
      return b;
    };
    const ST = GPUBufferUsage.STORAGE;
    const CD = GPUBufferUsage.COPY_DST;
    const CS = GPUBufferUsage.COPY_SRC;

    const paramsBuf = mk(
      PARAMS_BYTES,
      GPUBufferUsage.UNIFORM | CD,
      f.buffer.slice(
        0,
        PARAMS_BYTES > f.byteLength ? f.byteLength : PARAMS_BYTES,
      ),
    );
    // f is 64 floats (256 bytes) — write the whole thing.
    device.queue.writeBuffer(paramsBuf, 0, f.buffer, 0, PARAMS_BYTES);
    const bufX = mk(POINT_COUNT * 4, ST | CD, posX);
    const bufY = mk(POINT_COUNT * 4, ST | CD, posY);
    const bufZ = mk(POINT_COUNT * 4, ST | CD, posZ);
    const visibleIndices = mk(MAX_VISIBLE * 4, ST | CS);
    const visibleCount = mk(16, ST | CS | CD);

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuf } },
        { binding: 1, resource: { buffer: bufX } },
        { binding: 2, resource: { buffer: bufY } },
        { binding: 3, resource: { buffer: bufZ } },
        { binding: 4, resource: { buffer: visibleIndices } },
        { binding: 5, resource: { buffer: visibleCount } },
      ],
    });

    const enc = device.createCommandEncoder();
    enc.clearBuffer(visibleCount, 0, 16);
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1, 1, 1); // exactly one 256-thread workgroup
    pass.end();

    // Readback staging buffers
    const idxRead = device.createBuffer({
      size: MAX_VISIBLE * 4,
      usage: GPUBufferUsage.MAP_READ | CD,
    });
    const cntRead = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.MAP_READ | CD,
    });
    enc.copyBufferToBuffer(visibleIndices, 0, idxRead, 0, MAX_VISIBLE * 4);
    enc.copyBufferToBuffer(visibleCount, 0, cntRead, 0, 16);
    device.queue.submit([enc.finish()]);

    const scopeErr = await device.popErrorScope();

    await idxRead.mapAsync(GPUMapMode.READ);
    await cntRead.mapAsync(GPUMapMode.READ);
    const idx = Array.from(new Uint32Array(idxRead.getMappedRange().slice(0)));
    const count = new Uint32Array(cntRead.getMappedRange().slice(0))[0];
    idxRead.unmap();
    cntRead.unmap();

    // Only the first `count` slots are meaningful output.
    const written = idx.slice(0, count);
    const seen = new Set(written);
    const duplicates = written.length - seen.size;
    const missing = [];
    for (let i = 0; i < POINT_COUNT; i++) if (!seen.has(i)) missing.push(i);

    return {
      entryPoint,
      count,
      uniqueCount: seen.size,
      duplicates,
      missing,
      has255: seen.has(255),
      scopeErr: scopeErr ? scopeErr.message : null,
    };
  }

  const results = [];
  results.push(await runEntry("computeMain"));
  if (hasSubgroups) {
    results.push(await runEntry("computeMainSubgroups"));
  }

  return {
    hasSubgroups,
    results,
    validationErrors,
  };
}, WGSL_URL);

await browser.close();

// ── Evaluate ──────────────────────────────────────────────────────────
if (out.fatal) {
  console.error(`FATAL: ${out.fatal}`);
  process.exit(1);
}

let pass = true;
console.log(`subgroups supported: ${out.hasSubgroups}`);
for (const r of out.results) {
  const ok =
    r.count === 256 &&
    r.uniqueCount === 256 &&
    r.duplicates === 0 &&
    r.missing.length === 0 &&
    r.has255 === true &&
    !r.scopeErr;
  if (!ok) pass = false;
  console.log(
    `[${r.entryPoint}] count=${r.count} unique=${r.uniqueCount} ` +
      `duplicates=${r.duplicates} missing=[${r.missing.join(",")}] ` +
      `has255=${r.has255} scopeErr=${r.scopeErr ?? "none"} → ${ok ? "PASS" : "FAIL"}`,
  );
}

if (out.validationErrors.length) {
  console.error(`validation errors: ${out.validationErrors.join(" | ")}`);
  pass = false;
}
if (errors.length) {
  console.error(`console errors: ${errors.join(" | ")}`);
  pass = false;
}

console.log(pass ? "\nPROBE PASS" : "\nPROBE FAIL");
process.exit(pass ? 0 : 1);
