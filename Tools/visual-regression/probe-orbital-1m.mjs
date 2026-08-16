#!/usr/bin/env node
// Probe (NEW-ORBITAL-DEVICE-LIMITS-PROBE verify — Batch 281): validate that
// the GPU-resident compute-instance pipeline scales to a 1M-object catalog
// within the WebGPU device limits the renderer relies on.
// @purpose Validates the GPU-resident compute-instance pipeline at a 1M-object catalog against negotiated device limits (SSBO sizes, dispatch headroom).
// @status ACTIVE
//
// The compute-instance system (NEW-COMPUTE-INSTANCE-SYSTEM) uploads the flat
// per-instance params to a read-only storage buffer ONCE, runs the user WGSL
// kernel each frame (one invocation/instance) into a 64-byte-per-record
// instance SSBO, and instance-draws screen-space quads vertex-pulling that
// SSBO. At 1M instances the at-risk ceilings are:
//
//   * maxStorageBufferBindingSize — both the params SSBO and the instance
//     records SSBO bind as a single storage buffer. The records buffer is
//     the larger of the two at FPI<=16: 1M * 64 B = 64 MB. Default ceiling
//     128 MB => ~2.097M full 64-B records / binding. The params SSBO at the
//     orbital FPI=10 is 1M * 10 * 4 = 40 MB.
//   * maxBufferSize — same two buffers; default min 256 MB, easily clears
//     64 MB.
//   * maxComputeWorkgroupsPerDimension — dispatch is ceil(N / 64) on X only.
//     1M / 64 = 15625 workgroups; default ceiling 65535 => headroom for ~4.2M
//     instances before the single-dimension dispatch must tile.
//   * maxComputeInvocationsPerWorkgroup — the scaffold uses @workgroup_size(64),
//     well under the default 256.
//
// This probe acquires its OWN device with EXPLICIT required limits (maxed to
// the adapter ceilings for the relevant limits), then:
//   (A) Reports the negotiated limits + computes the single-binding headroom
//       for a literal 1M target (records / params / pick-color buffers) and
//       the workgroup-dispatch headroom.
//   (B) Builds a ComputeInstanceCollection-shaped workload at the TARGET count
//       (default 1,000,000; PROBE_1M_COUNT overrides) — backing off to the
//       largest count the adapter's maxBufferSize/maxStorageBufferBindingSize
//       and a conservative VRAM budget can hold if 1M doesn't fit — composes
//       prologue + the SHIPPED ComputeInstanceScaffold.wgsl + a synthetic
//       deterministic-shell kernel exactly as WebGPUComputeInstanceRenderer
//       does, allocates the params + records SSBOs at the achieved count, and
//       DISPATCHES the compute kernel (ceil(N/64) workgroups).
//   (C) RENDERS the instanced quads (the SHIPPED ComputeInstanceRender.wgsl,
//       vertexMain/fragmentMain) into an offscreen rgba8unorm target with the
//       records SSBO bound, reads back the texture, and asserts a non-zero
//       (dense) cyan pixel coverage — proving the records the kernel wrote are
//       actually drawable at scale, not just allocated.
//   (D) Asserts ZERO WebGPU validation errors across the whole run (compute
//       dispatch + draw), and that the single-binding headroom for 1M is
//       positive on this adapter (or, if the multi-binding split is needed,
//       reports it as the next concrete work item).
//
// No CesiumViewer scene is needed — this is a raw-device limits validation, so
// it only needs WebGPU + fetch (to pull the shipped WGSL). It mirrors the
// raw-device harness of probe-orbital-j2.mjs.
//
// Usage: node Tools/visual-regression/probe-orbital-1m.mjs
// Env:   PROBE_BASE     (default http://localhost:8134)
//        PROBE_1M_COUNT (default 1000000; lower it for a slow adapter)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const TARGET_COUNT = Number(process.env.PROBE_1M_COUNT || 1000000);

// MUST match WebGPUComputeInstanceRenderer constants.
const INSTANCE_RECORD_BYTES = 64;
const PICK_COLOR_BYTES = 16;
const COMPUTE_WORKGROUP_SIZE = 64;
// The orbital catalog's element layout is FPI=10; use it as the
// representative params footprint (params SSBO = N * FPI * 4 bytes).
const FPI = 10;

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

const out = await page.evaluate(
  async ({ base, targetCount, fpi, recBytes, pickBytes, wgSize }) => {
    if (!("gpu" in navigator)) {
      return { error: "navigator.gpu missing" };
    }

    // Fetch the SHIPPED engine WGSL — the scaffold (bindings + dispatch entry
    // point + the RTE high/low write) and the render shader (instanced
    // vertex-pull quad draw). Validating against the REAL shaders is the
    // point — a probe that hand-rolls its own would not catch a binding/limit
    // mismatch with what the renderer actually creates.
    const scaffoldResp = await fetch(
      `${base}/packages/engine/Source/Shaders/WebGPU/Compute/ComputeInstanceScaffold.wgsl`,
    );
    if (!scaffoldResp.ok) {
      return { error: `scaffold fetch ${scaffoldResp.status}` };
    }
    const scaffold = await scaffoldResp.text();
    const renderResp = await fetch(
      `${base}/packages/engine/Source/Shaders/WebGPU/Compute/ComputeInstanceRender.wgsl`,
    );
    if (!renderResp.ok) {
      return { error: `render fetch ${renderResp.status}` };
    }
    let renderSrc = await renderResp.text();
    // The shipped render WGSL carries //>>ifdef LOG_DEPTH preprocessor blocks
    // resolved by WebGPUShaderPreprocessor at pipeline build. For this raw
    // probe we want the defines=0 (no-LOG_DEPTH) variant, which is the //>>else
    // branch of every block — i.e. strip the //>>ifdef..//>>endif content and
    // keep only what's outside. Emulate the preprocessor for the LOG_DEPTH
    // flag (the only flag this shader uses): drop ifdef LOG_DEPTH..endif blocks
    // (no //>>else in this file, so the blocks just vanish — the defines=0
    // byte-identical-to-no-ifdef contract).
    renderSrc = stripIfdef(renderSrc, "LOG_DEPTH");

    function stripIfdef(src, flag) {
      const lines = src.split("\n");
      const kept = [];
      let depth = 0; // inside how many ifdef <flag> blocks
      let elseActive = false;
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith("//>>ifdef")) {
          const name = t.replace("//>>ifdef", "").trim();
          if (name === flag) {
            depth++;
            elseActive = false;
            continue;
          }
          // Unknown flag — keep the directive's body (defines=0 => else),
          // but this shader only uses LOG_DEPTH, so this path is unused.
          kept.push(line);
          continue;
        }
        if (t === "//>>else" && depth > 0) {
          elseActive = true;
          continue;
        }
        if (t === "//>>endif" && depth > 0) {
          depth--;
          elseActive = false;
          continue;
        }
        if (depth > 0 && !elseActive) {
          // Inside an ifdef LOG_DEPTH block, before any else => skip (defines=0).
          continue;
        }
        kept.push(line);
      }
      return kept.join("\n");
    }

    // ── Acquire a device with EXPLICIT required limits maxed to the adapter ──
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) {
      return { error: "no adapter" };
    }
    const aLim = adapter.limits;
    // Request the adapter's full ceiling for the limits the 1M target leans on
    // (storage binding size, buffer size, dispatch). requestDevice clamps to
    // the adapter max if we ask for exactly it, so read it back from the
    // device afterward to get the truly negotiated values.
    const requiredLimits = {
      maxStorageBufferBindingSize: aLim.maxStorageBufferBindingSize,
      maxBufferSize: aLim.maxBufferSize,
      maxComputeWorkgroupsPerDimension: aLim.maxComputeWorkgroupsPerDimension,
      maxComputeInvocationsPerWorkgroup: aLim.maxComputeInvocationsPerWorkgroup,
      maxStorageBuffersPerShaderStage: aLim.maxStorageBuffersPerShaderStage,
    };
    const device = await adapter.requestDevice({ requiredLimits });
    const validationErrors = [];
    device.addEventListener("uncapturederror", (ev) => {
      validationErrors.push(String(ev.error?.message ?? ev.error));
    });

    const L = device.limits;
    const negotiated = {
      maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
      maxBufferSize: L.maxBufferSize,
      maxComputeWorkgroupsPerDimension: L.maxComputeWorkgroupsPerDimension,
      maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup,
      maxComputeWorkgroupSizeX: L.maxComputeWorkgroupSizeX,
      maxStorageBuffersPerShaderStage: L.maxStorageBuffersPerShaderStage,
    };

    // ── (A) Theoretical single-binding headroom for a literal 1M target ──
    const ONE_M = 1000000;
    const recordsBytes1M = ONE_M * recBytes; // instance records SSBO
    const paramsBytes1M = ONE_M * fpi * 4; // params SSBO
    const pickBytes1M = ONE_M * pickBytes; // pick-color SSBO
    const bindCeil = negotiated.maxStorageBufferBindingSize;
    const bufCeil = negotiated.maxBufferSize;
    const headroom1M = {
      // Max full 64-B records that fit ONE storage binding.
      maxRecordsPerBinding: Math.floor(bindCeil / recBytes),
      recordsBytes1M,
      recordsFitsOneBinding:
        recordsBytes1M <= bindCeil && recordsBytes1M <= bufCeil,
      paramsBytes1M,
      paramsFitsOneBinding:
        paramsBytes1M <= bindCeil && paramsBytes1M <= bufCeil,
      pickBytes1M,
      pickFitsOneBinding: pickBytes1M <= bindCeil && pickBytes1M <= bufCeil,
      // Dispatch headroom: how many instances the single-dimension
      // ceil(N/64) dispatch can address before X must tile.
      workgroups1M: Math.ceil(ONE_M / wgSize),
      maxInstancesSingleDimDispatch:
        negotiated.maxComputeWorkgroupsPerDimension * wgSize,
    };
    // The largest instance count whose records SSBO fits ONE binding AND one
    // buffer AND the single-dim dispatch.
    const ceilByRecords = Math.floor(Math.min(bindCeil, bufCeil) / recBytes);
    const ceilByDispatch = headroom1M.maxInstancesSingleDimDispatch;
    const singleBindingMaxCount = Math.min(ceilByRecords, ceilByDispatch);

    // ── Choose the count actually exercised this run ──
    // Cap at the single-binding ceiling and at a conservative VRAM budget so
    // a small/integrated adapter doesn't OOM. The records+params+readback for
    // a render-and-read at 1M is ~64+40+ (1 texture) — well within budget —
    // but allocating 3 large SSBOs + a mappable readback on a 256 MB-class
    // integrated GPU can fail, so back off if maxBufferSize is small.
    const VRAM_BUDGET_BYTES = Math.min(bufCeil, bindCeil) * 0.75;
    const ceilByVram = Math.floor(VRAM_BUDGET_BYTES / recBytes);
    const achievedCount = Math.max(
      1,
      Math.min(targetCount, singleBindingMaxCount, ceilByVram),
    );

    // ── (B) Build + dispatch the real scaffold compute kernel ──
    // Synthetic deterministic-shell kernel: places instance i on a thin
    // spherical shell around the origin (lat/lon from a low-discrepancy-ish
    // hash of the index), radius ~1.2e7 m, rotating with time. Cyan dots.
    // Pure index+time math => no params upload needed for position, but we
    // still allocate the params SSBO at full size to exercise its binding.
    const shellKernel = `
      fn csm_computeInstance(index: u32, time: f32) -> ComputeInstanceOut {
        let fi = f32(index);
        // Spread points over a sphere via a golden-angle spiral.
        let golden = 2.39996323;
        let n = f32(csm_frame.instanceCount);
        let y = 1.0 - 2.0 * (fi + 0.5) / max(n, 1.0);   // [-1, 1]
        let r = sqrt(max(1.0 - y * y, 0.0));
        let theta = golden * fi + time * 1.0e-4;
        let radius = 1.2e7;
        var out: ComputeInstanceOut;
        out.position = vec3<f32>(
          radius * r * cos(theta),
          radius * y,
          radius * r * sin(theta),
        );
        out.color = vec4<f32>(0.0, 1.0, 1.0, 1.0);
        out.pixelSize = 2.0;
        return out;
      }`;

    const prologue = `const FLOATS_PER_INSTANCE: u32 = ${fpi >>> 0}u;\n\n`;
    const composed = prologue + scaffold + "\n// kernel\n" + shellKernel + "\n";

    device.pushErrorScope("validation");
    const computeModule = device.createShaderModule({ code: composed });
    const computeInfo = await computeModule.getCompilationInfo();
    const computeCompileErrs = computeInfo.messages
      .filter((m) => m.type === "error")
      .map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);

    // Buffers at the ACHIEVED count.
    const paramsBuf = device.createBuffer({
      label: "1M params",
      size: Math.max(achievedCount * fpi * 4, 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const recordsBuf = device.createBuffer({
      label: "1M records",
      size: Math.max(achievedCount * recBytes, recBytes),
      usage: GPUBufferUsage.STORAGE,
    });
    const frameBuf = device.createBuffer({
      label: "1M frame params",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const frameData = new ArrayBuffer(16);
    new Float32Array(frameData)[0] = 1000.0; // sim time
    new Uint32Array(frameData)[1] = achievedCount;
    device.queue.writeBuffer(frameBuf, 0, frameData);

    const computeBGL = device.createBindGroupLayout({
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
    const computePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [computeBGL] }),
      compute: { module: computeModule, entryPoint: "computeInstanceMain" },
    });
    const computeBG = device.createBindGroup({
      layout: computeBGL,
      entries: [
        { binding: 0, resource: { buffer: paramsBuf } },
        { binding: 1, resource: { buffer: recordsBuf } },
        { binding: 2, resource: { buffer: frameBuf } },
      ],
    });

    const workgroups = Math.ceil(achievedCount / wgSize);
    const dispatchWithinLimit =
      workgroups <= negotiated.maxComputeWorkgroupsPerDimension;

    const enc = device.createCommandEncoder({ label: "1M dispatch" });
    const cpass = enc.beginComputePass();
    cpass.setPipeline(computePipeline);
    cpass.setBindGroup(0, computeBG);
    cpass.dispatchWorkgroups(workgroups);
    cpass.end();
    device.queue.submit([enc.finish()]);

    const computeScopeErr = await device.popErrorScope();

    // ── (C) Render the instanced quads into an offscreen target + read back ──
    const W = 256;
    const H = 256;
    device.pushErrorScope("validation");
    const renderModule = device.createShaderModule({ code: renderSrc });
    const renderInfo = await renderModule.getCompilationInfo();
    const renderCompileErrs = renderInfo.messages
      .filter((m) => m.type === "error")
      .map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);

    // Camera UB: 256 bytes (matches the renderer's allocation). Build an MVP
    // that frames the shell: camera at (3.5e7, 0, 0) looking at the origin.
    // mvpRelativeToEye = projection * (view with translation column zeroed).
    const camUB = device.createBuffer({
      label: "1M camera UB",
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const camData = new Float32Array(64);
    // ── Minimal column-major mat4 math (mirrors what UniformState packs) ──
    function perspective(fovy, aspect, near, far) {
      const f = 1.0 / Math.tan(fovy / 2);
      const nf = 1.0 / (near - far);
      // WebGPU clip-z [0,1].
      return [
        f / aspect,
        0,
        0,
        0,
        0,
        f,
        0,
        0,
        0,
        0,
        far * nf,
        -1,
        0,
        0,
        far * near * nf,
        0,
      ];
    }
    function lookAtRotation(eye, center, up) {
      // Returns the VIEW matrix with translation column zeroed (RTE: the
      // camera-relative translation is applied per-vertex via encodedCamera).
      const zx = eye[0] - center[0],
        zy = eye[1] - center[1],
        zz = eye[2] - center[2];
      const zl = Math.hypot(zx, zy, zz);
      const fz = [zx / zl, zy / zl, zz / zl];
      // x = normalize(cross(up, z))
      const xx = up[1] * fz[2] - up[2] * fz[1];
      const xy = up[2] * fz[0] - up[0] * fz[2];
      const xz = up[0] * fz[1] - up[1] * fz[0];
      const xl = Math.hypot(xx, xy, xz);
      const fx = [xx / xl, xy / xl, xz / xl];
      // y = cross(z, x)
      const fy = [
        fz[1] * fx[2] - fz[2] * fx[1],
        fz[2] * fx[0] - fz[0] * fx[2],
        fz[0] * fx[1] - fz[1] * fx[0],
      ];
      // Column-major view with zero translation.
      return [
        fx[0],
        fy[0],
        fz[0],
        0,
        fx[1],
        fy[1],
        fz[1],
        0,
        fx[2],
        fy[2],
        fz[2],
        0,
        0,
        0,
        0,
        1,
      ];
    }
    function mul(a, b) {
      // column-major a*b
      const r = new Array(16).fill(0);
      for (let c = 0; c < 4; c++) {
        for (let row = 0; row < 4; row++) {
          let s = 0;
          for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
          r[c * 4 + row] = s;
        }
      }
      return r;
    }
    const eye = [3.5e7, 0, 0];
    const proj = perspective(Math.PI / 3, W / H, 1.0e5, 1.0e8);
    const viewRot = lookAtRotation(eye, [0, 0, 0], [0, 0, 1]);
    const mvp = mul(proj, viewRot);
    for (let i = 0; i < 16; i++) camData[i] = mvp[i];
    camData[16] = W; // viewportSize.x
    camData[17] = H; // viewportSize.y
    // logDepthNearFar (72-79), encodedCameraHigh (80-91), logDepthFactor(92..),
    // encodedCameraLow (96-107). RTE-encode the camera position high/low.
    // AGI 65536-grid split per EncodedCartesian3.
    function encode(v) {
      const SHIFT = 65536.0;
      const doubleHigh = Math.floor(v / SHIFT) * SHIFT;
      const high = doubleHigh;
      const low = v - doubleHigh;
      return [high, low];
    }
    const [hx, lx] = encode(eye[0]);
    const [hy, ly] = encode(eye[1]);
    const [hz, lz] = encode(eye[2]);
    camData[20] = hx;
    camData[21] = hy;
    camData[22] = hz;
    camData[24] = lx;
    camData[25] = ly;
    camData[26] = lz;
    // previousViewProjection (28..43) — identity (unused without TAA).
    camData[28] = 1;
    camData[33] = 1;
    camData[38] = 1;
    camData[43] = 1;
    device.queue.writeBuffer(camUB, 0, camData);

    // [-1,1] quad VB (6 verts), matches the renderer.
    const quad = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
    const quadVB = device.createBuffer({
      size: quad.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(quadVB, 0, quad);

    const renderBGL = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "read-only-storage" },
        },
      ],
    });
    const renderPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [renderBGL] }),
      vertex: {
        module: renderModule,
        entryPoint: "vertexMain",
        buffers: [
          {
            arrayStride: 8,
            stepMode: "vertex",
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
          },
        ],
      },
      fragment: {
        module: renderModule,
        entryPoint: "fragmentMain",
        targets: [
          {
            format: "rgba8unorm",
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
              },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
    const renderBG = device.createBindGroup({
      layout: renderBGL,
      entries: [
        { binding: 0, resource: { buffer: camUB } },
        { binding: 1, resource: { buffer: recordsBuf } },
      ],
    });

    const colorTex = device.createTexture({
      size: [W, H],
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    const renc = device.createCommandEncoder({ label: "1M render" });
    const rpass = renc.beginRenderPass({
      colorAttachments: [
        {
          view: colorTex.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    rpass.setPipeline(renderPipeline);
    rpass.setBindGroup(0, renderBG);
    rpass.setVertexBuffer(0, quadVB);
    rpass.draw(6, achievedCount);
    rpass.end();

    // Copy the texture to a mappable buffer (256-byte row alignment).
    const bytesPerRow = Math.ceil((W * 4) / 256) * 256;
    const readBuf = device.createBuffer({
      size: bytesPerRow * H,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    renc.copyTextureToBuffer(
      { texture: colorTex },
      { buffer: readBuf, bytesPerRow, rowsPerImage: H },
      [W, H],
    );
    device.queue.submit([renc.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();

    const renderScopeErr = await device.popErrorScope();

    // Count cyan pixels (the dense shell): low R, high G, high B.
    let cyan = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = y * bytesPerRow + x * 4;
        const r = pixels[o],
          g = pixels[o + 1],
          b = pixels[o + 2];
        if (r < 120 && g > 120 && b > 120) cyan++;
      }
    }

    paramsBuf.destroy();
    recordsBuf.destroy();
    frameBuf.destroy();
    camUB.destroy();
    quadVB.destroy();
    readBuf.destroy();
    colorTex.destroy();

    return {
      targetCount,
      achievedCount,
      negotiated,
      headroom1M,
      singleBindingMaxCount,
      ceilByRecords,
      ceilByDispatch,
      ceilByVram,
      workgroups,
      dispatchWithinLimit,
      cyan,
      totalPx: W * H,
      computeCompileErrs,
      renderCompileErrs,
      computeScopeErr: computeScopeErr ? String(computeScopeErr.message) : null,
      renderScopeErr: renderScopeErr ? String(renderScopeErr.message) : null,
      validationErrors,
    };
  },
  {
    base: BASE,
    targetCount: TARGET_COUNT,
    fpi: FPI,
    recBytes: INSTANCE_RECORD_BYTES,
    pickBytes: PICK_COLOR_BYTES,
    wgSize: COMPUTE_WORKGROUP_SIZE,
  },
);

if (out.error) {
  console.log(`SETUP FAIL: ${out.error}`);
  await browser.close();
  process.exit(1);
}

const MB = 1024 * 1024;
const fmtMB = (b) => `${(b / MB).toFixed(1)} MB`;
const fmtN = (n) => n.toLocaleString("en-US");

console.log("── Negotiated device limits ──");
console.log(
  `  maxStorageBufferBindingSize = ${fmtMB(out.negotiated.maxStorageBufferBindingSize)} (${fmtN(out.negotiated.maxStorageBufferBindingSize)} B)`,
);
console.log(
  `  maxBufferSize               = ${fmtMB(out.negotiated.maxBufferSize)}`,
);
console.log(
  `  maxComputeWorkgroupsPerDim  = ${fmtN(out.negotiated.maxComputeWorkgroupsPerDimension)}`,
);
console.log(
  `  maxComputeInvocations/WG    = ${out.negotiated.maxComputeInvocationsPerWorkgroup} (scaffold uses 64)`,
);
console.log(
  `  maxStorageBuffers/stage     = ${out.negotiated.maxStorageBuffersPerShaderStage}`,
);

console.log("── 1,000,000-instance single-binding headroom ──");
const h = out.headroom1M;
console.log(
  `  records SSBO  1M = ${fmtMB(h.recordsBytes1M)} (64 B/rec) -> fits one binding: ${h.recordsFitsOneBinding} (ceil ${fmtN(h.maxRecordsPerBinding)} recs/binding)`,
);
console.log(
  `  params  SSBO  1M = ${fmtMB(h.paramsBytes1M)} (FPI=10) -> fits one binding: ${h.paramsFitsOneBinding}`,
);
console.log(
  `  pick    SSBO  1M = ${fmtMB(h.pickBytes1M)} (16 B/inst) -> fits one binding: ${h.pickFitsOneBinding}`,
);
console.log(
  `  dispatch 1M = ${fmtN(h.workgroups1M)} workgroups (ceil 1M/64) <= ${fmtN(out.negotiated.maxComputeWorkgroupsPerDimension)} max-per-dim`,
);
console.log(
  `  single-dim dispatch caps at ${fmtN(h.maxInstancesSingleDimDispatch)} instances before X must tile`,
);
console.log(
  `  => single-binding max count = ${fmtN(out.singleBindingMaxCount)} (min of records-ceil ${fmtN(out.ceilByRecords)} / dispatch-ceil ${fmtN(out.ceilByDispatch)})`,
);

console.log("── Exercised workload ──");
console.log(
  `  target=${fmtN(out.targetCount)} achieved=${fmtN(out.achievedCount)} (vram-cap ${fmtN(out.ceilByVram)})`,
);
console.log(
  `  dispatched ${fmtN(out.workgroups)} workgroups; within limit: ${out.dispatchWithinLimit}`,
);
console.log(
  `  rendered cyan coverage: ${fmtN(out.cyan)} / ${fmtN(out.totalPx)} px`,
);

if (out.computeCompileErrs?.length) {
  console.log("  compute compile errors:");
  out.computeCompileErrs.forEach((m) => console.log("    ", m));
}
if (out.renderCompileErrs?.length) {
  console.log("  render compile errors:");
  out.renderCompileErrs.forEach((m) => console.log("    ", m));
}
if (out.computeScopeErr)
  console.log(`  compute scope error: ${out.computeScopeErr}`);
if (out.renderScopeErr)
  console.log(`  render scope error: ${out.renderScopeErr}`);

// ── Assertions ──
// (A) The 1M target fits a single storage binding for all three SSBOs AND the
//     single-dimension dispatch — i.e. NO multi-binding split is required at
//     1M on this adapter (the headline result the stage asks for).
const aOK =
  h.recordsFitsOneBinding &&
  h.paramsFitsOneBinding &&
  h.pickFitsOneBinding &&
  h.workgroups1M <= out.negotiated.maxComputeWorkgroupsPerDimension &&
  out.negotiated.maxComputeInvocationsPerWorkgroup >= 64;
// (B) The exercised dispatch (achieved count) ran within limits and rendered a
//     dense, non-zero shell.
const bOK = out.dispatchWithinLimit && out.cyan > 200;
// (C) Zero validation/compile/console errors across compute + draw.
const cOK =
  (out.validationErrors?.length ?? 0) === 0 &&
  !out.computeScopeErr &&
  !out.renderScopeErr &&
  (out.computeCompileErrs?.length ?? 0) === 0 &&
  (out.renderCompileErrs?.length ?? 0) === 0 &&
  errors.length === 0;

console.log(
  `(A) 1M fits single binding (records+params+pick) + dispatch + invocations: ${aOK ? "OK" : "FAIL — multi-binding split required, see headroom above"}`,
);
console.log(
  `(B) achieved ${fmtN(out.achievedCount)} dispatched within limits + rendered dense shell (${fmtN(out.cyan)} px > 200): ${bOK ? "OK" : "FAIL"}`,
);
console.log(
  `(C) zero validation/compile/console errors: gpu=${out.validationErrors?.length ?? 0} page=${errors.length} ${cOK ? "OK" : "FAIL"}`,
);
errors.slice(0, 6).forEach((e) => console.log("  ERR:", e.slice(0, 200)));
out.validationErrors
  ?.slice(0, 6)
  .forEach((e) => console.log("  VAL:", e.slice(0, 200)));

const pass = aOK && bOK && cOK;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
