/**
 * Reads the opt-in FFT ocean's displacement field back from the GPU, so two
 * runs of the ocean can be compared by what the compute chain produced and not
 * only by the picture.
 * @purpose Page-side readback of the FFT ocean's rgba16float displacement texture through a compute-shader copy (the texture has no COPY_SRC), returning a JSON-safe record with a sha-256 of the field and its statistics, plus the pure comparison and the kernel-identity verdict a probe records.
 * @status ACTIVE
 *
 * WHY A COMPUTE-SHADER COPY AND NOT `copyTextureToBuffer`. The displacement
 * texture is created by `createComputeTexture`
 * (`Renderer/WebGPU/WebGPUOceanComputeChain.ts:188-201`, used for the field at
 * `:246-250`) with usage STORAGE_BINDING | TEXTURE_BINDING | COPY_DST and no
 * COPY_SRC, so `copyTextureToBuffer` on it is a WebGPU validation error. It
 * can still be bound as `texture_2d<f32>` (TEXTURE_BINDING), so this piece
 * binds it to a one-off compute pipeline whose WGSL does `textureLoad` over the
 * whole texture into a storage buffer, copies that to a MAP_READ buffer and
 * maps it. The engine is not changed for it: there is no engine debug readback
 * of the displacement (nothing outside the two ocean WebGPU files names
 * `displacementTexture`).
 *
 * THE LIMIT OF THE IDENTITY. The field is rgba16float. The compute chain
 * computes in f32 and the merge pass stores into f16, so two kernels that
 * differ by f32 rounding produce the same bytes unless a value falls across an
 * f16 rounding boundary. "Identical" here is identity at f16 resolution of an
 * f32 computation: it shows the two kernels give the same displacement as the
 * renderer sees it, and it cannot show they are bit-identical in f32. The hash
 * is taken over the f32 values the shader loads (each an exact f16 value).
 *
 * THE PRIVATE ACCESSOR. The field lives on
 * `scene.globe.water.ocean.primitive._webgpuCache.displacementTexture`.
 * `_webgpuCache` is the per-primitive state the FFT ocean renderer
 * (`Renderer/WebGPU/WebGPUOceanRenderer.ts`, declared `_webgpuCache?: unknown`
 * at `:133`, created at `:438-440`) stores as an `OceanCache`
 * (`WebGPUOceanComputeChain.ts:71`: `initialized`, `frameNumber`,
 * `simulationSeconds`, `computePipelinesReady`, `computePipelinesFailed`,
 * `displacementTexture`). It is not public API; a rename there makes this
 * piece read `available: false` with a reason, never a wrong number. The wave
 * time comes from the frame clock and the ocean's `simulationEpoch`, and the
 * noise is a seeded xorshift (`WebGPUOceanComputeChain.ts:158-170`), so two
 * pages at one frozen clock and epoch compute the same field.
 *
 * AN ALL-ZERO FIELD IS NOT A MEASUREMENT. A chain that never ran leaves the
 * texture zero, and two zero fields are identical for any kernel. The record
 * carries `nonZero` (the count of non-zero values) and the comparison is not
 * `measured` when either field is all zero.
 *
 * RAW VALUES STAY OUT OF THE RECORD. A 256 x 256 rgba field is 262144 numbers,
 * megabytes of JSON per readback. The record carries the hash and statistics;
 * `includeValues: true` adds `values` (a plain array) for a probe that wants
 * `maxAbsDelta`, which {@link compareDisplacementReadbacks} reports only when
 * both records carry `values`.
 *
 * @module Tools/visual-regression/lib/ocean-displacement-readback
 */

/** The accessor the record names; the engine's private ocean state. */
export const OCEAN_DISPLACEMENT_ACCESSOR =
  "primitive._webgpuCache.displacementTexture";

/** The default number of frames rendered before the readback. */
export const OCEAN_READBACK_DEFAULT_FRAMES = 8;

/**
 * PAGE SIDE. Render `frames` frames at the frozen clock, then read the FFT
 * ocean's displacement texture back. Never throws: every unavailable path is
 * `available: false` with a `reason`. Self-contained (it is passed to
 * `page.evaluate`): no imports, no closures over this module.
 *
 * @param {{frames?: number, includeValues?: boolean}} [args]
 * @returns {Promise<{available: boolean, reason?: string, accessor: string,
 *   format: string|null, width: number|null, height: number|null,
 *   sampleCount: number|null, hash: string|null, min: number|null,
 *   max: number|null, mean: number|null, nonFinite: number|null,
 *   nonZero: number|null, kernel: string|null, frameNumber: number|null,
 *   simulationSeconds: number|null, computePipelinesReady: boolean|null,
 *   values?: number[]}>}
 */
export async function pageReadOceanDisplacement(args) {
  const frames = Math.max(0, Math.floor(Number(args && args.frames) || 0));
  const includeValues = !!(args && args.includeValues);
  const record = {
    available: false,
    accessor: "primitive._webgpuCache.displacementTexture",
    format: null,
    width: null,
    height: null,
    sampleCount: null,
    hash: null,
    min: null,
    max: null,
    mean: null,
    nonFinite: null,
    nonZero: null,
    kernel: null,
    frameNumber: null,
    simulationSeconds: null,
    computePipelinesReady: null,
  };
  const unavailable = (reason) => ({ ...record, available: false, reason });
  const messageOf = (error) =>
    String(error && error.message ? error.message : error);
  const root = /** @type {any} */ (globalThis);

  const viewer = root.viewer;
  const scene = viewer && viewer.scene;
  const context = scene && scene.context;
  if (!scene || !context) {
    return unavailable("the page has no viewer.scene.context");
  }
  if (!context.isWebGPU) {
    return unavailable("the FFT ocean's displacement texture is WebGPU-only");
  }
  const globe = scene.globe;
  const water = globe && globe.water;
  const ocean = water && water.ocean;
  if (!ocean) {
    return unavailable("the globe exposes no water.ocean facade");
  }
  const primitive = ocean.primitive;
  if (primitive === undefined || primitive === null) {
    return unavailable(
      "no ocean primitive exists (water.ocean.enabled is not on)",
    );
  }
  record.kernel =
    typeof primitive.ifftKernel === "string" ? primitive.ifftKernel : null;

  try {
    for (let i = 0; i < frames; i++) {
      scene.render(viewer.clock.currentTime);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  } catch (error) {
    return unavailable(`rendering ${frames} frames threw: ${messageOf(error)}`);
  }

  const cache = primitive._webgpuCache;
  if (!cache || typeof cache !== "object") {
    return unavailable(
      `the ocean primitive has no _webgpuCache after ${frames} frames`,
    );
  }
  record.frameNumber = Number.isFinite(cache.frameNumber)
    ? cache.frameNumber
    : null;
  record.simulationSeconds = Number.isFinite(cache.simulationSeconds)
    ? cache.simulationSeconds
    : null;
  record.computePipelinesReady =
    typeof cache.computePipelinesReady === "boolean"
      ? cache.computePipelinesReady
      : null;
  if (cache.computePipelinesFailed === true) {
    return unavailable("the ocean compute pipelines failed to build");
  }
  if (cache.computePipelinesReady !== true) {
    return unavailable(
      `the ocean compute pipelines were not ready after ${frames} frames`,
    );
  }
  if (!(cache.frameNumber > 0)) {
    return unavailable("the ocean compute chain has not run a frame");
  }
  const texture = cache.displacementTexture;
  if (!texture) {
    return unavailable("the ocean cache has no displacementTexture");
  }
  record.format = typeof texture.format === "string" ? texture.format : null;
  record.width = Number.isFinite(texture.width) ? texture.width : null;
  record.height = Number.isFinite(texture.height) ? texture.height : null;
  record.sampleCount = Number.isFinite(texture.sampleCount)
    ? texture.sampleCount
    : null;
  if (record.format !== "rgba16float") {
    return unavailable(
      `the displacement texture is ${record.format}, not rgba16float`,
    );
  }
  if (!(record.width > 0) || !(record.height > 0)) {
    return unavailable("the displacement texture has no size");
  }
  const device = context.device;
  if (!device || typeof device.createShaderModule !== "function") {
    return unavailable("the WebGPU context exposes no device");
  }

  const width = record.width;
  const height = record.height;
  const byteLength = width * height * 16;
  const usage = root.GPUBufferUsage;
  const mapMode = root.GPUMapMode;
  if (!usage || !mapMode) {
    return unavailable("the page has no GPUBufferUsage / GPUMapMode");
  }
  const code = `
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> dst : array<vec4<f32>>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id : vec3<u32>) {
  let dims = textureDimensions(src);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  dst[id.y * dims.x + id.x] = textureLoad(src, vec2<i32>(i32(id.x), i32(id.y)), 0);
}
`;
  let storage = null;
  let readback = null;
  let scopePushed = false;
  try {
    device.pushErrorScope("validation");
    scopePushed = true;
    const module = device.createShaderModule({
      label: "OceanDisplacementReadback",
      code,
    });
    const pipeline = device.createComputePipeline({
      label: "OceanDisplacementReadback",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    storage = device.createBuffer({
      label: "OceanDisplacementReadback storage",
      size: byteLength,
      usage: usage.STORAGE | usage.COPY_SRC,
    });
    readback = device.createBuffer({
      label: "OceanDisplacementReadback map",
      size: byteLength,
      usage: usage.MAP_READ | usage.COPY_DST,
    });
    const bindGroup = device.createBindGroup({
      label: "OceanDisplacementReadback",
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: { buffer: storage } },
      ],
    });
    const encoder = device.createCommandEncoder({
      label: "OceanDisplacementReadback",
    });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    encoder.copyBufferToBuffer(storage, 0, readback, 0, byteLength);
    device.queue.submit([encoder.finish()]);
    const validation = await device.popErrorScope();
    scopePushed = false;
    if (validation) {
      return unavailable(
        `GPU validation error during the readback: ${messageOf(validation)}`,
      );
    }
    await readback.mapAsync(mapMode.READ);
    const floats = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let finite = 0;
    let nonFinite = 0;
    let nonZero = 0;
    for (let i = 0; i < floats.length; i++) {
      const v = floats[i];
      if (!Number.isFinite(v)) {
        nonFinite++;
        continue;
      }
      if (v !== 0) {
        nonZero++;
      }
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      finite++;
    }
    const digest = await root.crypto.subtle.digest("SHA-256", floats.buffer);
    const hash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const result = {
      ...record,
      available: true,
      hash,
      min: finite > 0 ? min : null,
      max: finite > 0 ? max : null,
      mean: finite > 0 ? sum / finite : null,
      nonFinite,
      nonZero,
    };
    if (includeValues) {
      result.values = Array.from(floats);
    }
    return result;
  } catch (error) {
    return unavailable(`the displacement readback threw: ${messageOf(error)}`);
  } finally {
    if (scopePushed) {
      try {
        await device.popErrorScope();
      } catch (error) {
        // The scope is only popped to keep the device's stack balanced.
      }
    }
    for (const buffer of [storage, readback]) {
      try {
        if (buffer) {
          buffer.destroy();
        }
      } catch (error) {
        // A buffer already lost with its device has nothing left to free.
      }
    }
  }
}

/**
 * NODE SIDE. Read the displacement field on `page` (see
 * {@link pageReadOceanDisplacement}).
 *
 * @param {{evaluate: Function}} page
 * @param {{frames?: number, includeValues?: boolean}} [options]
 * @returns {Promise<object>} The page record.
 * @throws {TypeError} For `frames` that is not a non-negative integer.
 */
export function readOceanDisplacement(
  page,
  { frames = OCEAN_READBACK_DEFAULT_FRAMES, includeValues = false } = {},
) {
  if (!Number.isInteger(frames) || frames < 0) {
    throw new TypeError(
      `readOceanDisplacement: frames must be a non-negative integer, got ${String(frames)}`,
    );
  }
  return page.evaluate(pageReadOceanDisplacement, { frames, includeValues });
}

/**
 * PURE. The record with its raw `values` kept for the comparison but left out
 * of any JSON it is written into (made non-enumerable), so a probe can read
 * the field with values, diagnose a mismatch, and not write ~1 MB of floats
 * into its report. Returns the same record.
 *
 * @param {object} record A readback record.
 * @returns {object}
 */
export function keepValuesOutOfReport(record) {
  if (record && Array.isArray(record.values)) {
    Object.defineProperty(record, "values", {
      value: record.values,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return record;
}

/**
 * PURE. Compare two readback records.
 *
 * `measured` is true only when both are `available`, carry a hash, have equal
 * width, height and format, were read at the SAME finite `simulationSeconds`
 * (a wave-time mismatch is not a kernel disagreement), and neither field is
 * all zero (see the header). `identical` is hash equality and is false
 * whenever `measured` is false. `maxAbsDelta` and `differingValues` (how
 * many of the values differ) are present only when both records carry
 * `values` of equal length.
 *
 * @param {object} a
 * @param {object} b
 * @returns {{measured: boolean, identical: boolean, reason?: string,
 *   hashA: string|null, hashB: string|null, kernelA: string|null,
 *   kernelB: string|null, maxAbsDelta?: number}}
 */
export function compareDisplacementReadbacks(a, b) {
  const base = {
    hashA: a && typeof a.hash === "string" ? a.hash : null,
    hashB: b && typeof b.hash === "string" ? b.hash : null,
    kernelA: a && typeof a.kernel === "string" ? a.kernel : null,
    kernelB: b && typeof b.kernel === "string" ? b.kernel : null,
  };
  const notMeasured = (reason) => ({
    measured: false,
    identical: false,
    reason,
    ...base,
  });
  for (const [name, record] of [
    ["A", a],
    ["B", b],
  ]) {
    if (!record || record.available !== true) {
      return notMeasured(
        `readback ${name} is unavailable${record && record.reason ? `: ${record.reason}` : ""}`,
      );
    }
    if (typeof record.hash !== "string" || record.hash === "") {
      return notMeasured(`readback ${name} carries no hash`);
    }
  }
  for (const key of ["width", "height", "format"]) {
    if (a[key] !== b[key]) {
      return notMeasured(
        `the readbacks differ in ${key}: ${String(a[key])} vs ${String(b[key])}`,
      );
    }
  }
  if (
    !Number.isFinite(a.simulationSeconds) ||
    !Number.isFinite(b.simulationSeconds)
  ) {
    return notMeasured(
      `a readback carries no wave time (simulationSeconds ${String(a.simulationSeconds)} vs ${String(b.simulationSeconds)})`,
    );
  }
  if (a.simulationSeconds !== b.simulationSeconds) {
    return notMeasured(
      `the readbacks were taken at different wave times: simulationSeconds ${a.simulationSeconds} vs ${b.simulationSeconds}`,
    );
  }
  for (const [name, record] of [
    ["A", a],
    ["B", b],
  ]) {
    if (!(record.nonZero > 0)) {
      return notMeasured(
        `readback ${name} is an all-zero field (the compute chain produced nothing to compare)`,
      );
    }
  }
  const result = {
    measured: true,
    identical: a.hash === b.hash,
    ...base,
  };
  if (
    Array.isArray(a.values) &&
    Array.isArray(b.values) &&
    a.values.length === b.values.length
  ) {
    let maxAbsDelta = 0;
    let differingValues = 0;
    for (let i = 0; i < a.values.length; i++) {
      if (!Object.is(a.values[i], b.values[i])) {
        differingValues++;
      }
      const delta = Math.abs(a.values[i] - b.values[i]);
      if (delta > maxAbsDelta || Number.isNaN(delta)) {
        maxAbsDelta = delta;
      }
    }
    result.maxAbsDelta = maxAbsDelta;
    result.differingValues = differingValues;
  }
  return result;
}

/**
 * PURE. The verdict row for the kernel-identity check: the two legs ran
 * different kernels over the same wave time and produced the same displacement
 * field (at f16 resolution, see the header).
 *
 * `pass` only when the comparison is measured, identical, and the two records
 * name two different kernels: a comparison of one kernel with itself shows
 * determinism, not that the kernels agree, so it is `notRun`. A comparison
 * that is not measured is `notRun: true` and never a pass.
 *
 * @param {string} idPrefix
 * @param {object} a The first leg's readback.
 * @param {object} b The second leg's readback.
 * @returns {{id: string, pass: boolean, notRun?: true, comparison: object}}
 */
export function kernelIdentityVerdict(idPrefix, a, b) {
  const comparison = compareDisplacementReadbacks(a, b);
  const id = `${idPrefix}:ifft-kernel-identity`;
  if (!comparison.measured) {
    return { id, pass: false, notRun: true, comparison };
  }
  if (
    comparison.kernelA === null ||
    comparison.kernelB === null ||
    comparison.kernelA === comparison.kernelB
  ) {
    return {
      id,
      pass: false,
      notRun: true,
      comparison: {
        ...comparison,
        reason: `the legs do not run two different kernels (${String(comparison.kernelA)} vs ${String(comparison.kernelB)})`,
      },
    };
  }
  return { id, pass: comparison.identical, comparison };
}
