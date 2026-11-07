/**
 * The sky-cubemap page steps of the landing cell E-SKY-cube: add a glTF model
 * so the WebGPU dynamic environment map is built, read the six faces of its
 * mip 0 back, and the pure Node comparison of two arms' face records.
 * @purpose Page-side model step and cube-face readback for the landing cells of kind sky-cube (E-SKY-cube), the Node-side record builder (per-face sha256, byte length, non-zero byte count and the face file the bytes were written to; every statistic computed in Node) and the pure two-arm comparison (identity = equal per-face sha256; else the per-face maximum absolute delta, decoded per element for rgba16float): a page without the cube answers NOT AVAILABLE naming the missing seam, never a zero.
 * @status ACTIVE
 *
 * WHAT CREATES THE CUBE. Only a Model or a Cesium3DTileset owns a
 * `DynamicEnvironmentMapManager`. The WebGPU manager keeps the cube on
 * `manager._webgpuCache.cubemapTexture` once `Model.update` has given it a
 * position and the "DynEnvMap Sky Fill" compute pass has run; the cache's
 * `pendingRefresh` is null and `needsUpdate` false when a refresh has
 * committed. The step adds the model from the rig's `skyCubeModel` dial,
 * renders until the manager's cache reads settled on three consecutive frames,
 * and reads the faces; a cube that never settles within the frame budget is
 * NOT AVAILABLE with the frame count, not a read of a half-built cube.
 *
 * WHY A COMPUTE COPY AND NOT copyTextureToBuffer. The engine creates the cube
 * with TEXTURE_BINDING, STORAGE_BINDING, RENDER_ATTACHMENT and COPY_DST usage
 * and no COPY_SRC, so a direct texture-to-buffer copy would be a validation
 * error on the page. The cube is sampled instead: a compute pass loads every
 * texel of a mip-0 `2d-array` view of the cube with `textureLoad` (no
 * filtering) and writes the texel's packed bits to a storage buffer
 * (`pack4x8unorm` for rgba8unorm, two `pack2x16float` words for rgba16float),
 * which is then mapped and returned as bytes. The pass is the probe's own, on
 * the page's device, inside its own validation error scope (an error there
 * answers NOT AVAILABLE); it reads the engine's cube and writes nothing the
 * engine owns.
 *
 * WEBGL. The upstream manager keeps a WebGL cube map (`manager._radianceMap`)
 * whose faces would be read with `readPixels`; this piece reads the WebGPU
 * cube only, and the cell's rig is WebGPU only, so the read does not apply to
 * a WebGL page and no WebGL face read is claimed.
 *
 * @module Tools/visual-regression/lib/sky-cubemap-steps
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Faces of a cube. */
export const SKY_CUBE_FACE_COUNT = 6;

/** Frames the readback waits for the manager's cache to settle. */
export const SKY_CUBE_MAX_FRAMES = 600;

/** Frames the model step waits for the model to be ready. */
export const SKY_CUBE_MODEL_MAX_FRAMES = 900;

/** Consecutive settled reads that count the refresh as committed. */
export const SKY_CUBE_SETTLED_READS = 3;

/** The verdict words of {@link compareSkyCubeRecords}. */
export const SKY_CUBE_COMPARE = Object.freeze({
  IDENTICAL: "IDENTICAL",
  DIFFERS: "DIFFERS",
  NOT_AVAILABLE: "NOT AVAILABLE",
});

const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * The first error of a `skyCubeModel` dial value, or null. Pure.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function skyCubeModelViolation(value) {
  if (value === null || typeof value !== "object") {
    return "skyCubeModel must be {url, lon, lat, height}";
  }
  const { url, lon, lat, height } = /** @type {any} */ (value);
  if (typeof url !== "string" || !url.startsWith("/")) {
    return "skyCubeModel.url must be a same-origin path starting with /";
  }
  for (const [key, number] of [
    ["lon", lon],
    ["lat", lat],
    ["height", height],
  ]) {
    if (!Number.isFinite(number)) {
      return `skyCubeModel.${key} must be a finite number`;
    }
  }
  return null;
}

/**
 * PAGE SIDE. Add the model at its pinned position and render until it is
 * ready. Self-contained: passed to `page.evaluate`.
 *
 * @param {{moduleUrl: string, model: {url: string, lon: number, lat: number,
 *   height: number}, maxFrames: number}} input
 * @returns {Promise<object>} JSON-safe.
 */
export async function pageSkyCubeAddModel({ moduleUrl, model, maxFrames }) {
  const root = /** @type {any} */ (globalThis);
  const viewer = root.viewer;
  const scene = viewer && viewer.scene;
  if (!scene) {
    return {
      added: false,
      reason: "NOT AVAILABLE: no viewer on the page (seam: window.viewer)",
    };
  }
  const C = await import(moduleUrl);
  if (typeof C.Model?.fromGltfAsync !== "function") {
    return {
      added: false,
      reason: "NOT AVAILABLE: Model.fromGltfAsync (seam: the Cesium module)",
    };
  }
  try {
    const position = C.Cartesian3.fromDegrees(
      model.lon,
      model.lat,
      model.height,
    );
    const added = await C.Model.fromGltfAsync({
      url: model.url,
      modelMatrix: C.Transforms.eastNorthUpToFixedFrame(position),
      scene,
    });
    scene.primitives.add(added);
    root.__skyCubeModel = added;
    let frames = 0;
    while (added.ready !== true && frames < maxFrames) {
      scene.initializeFrame();
      scene.render(viewer.clock.currentTime);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      frames++;
    }
    return { added: true, ready: added.ready === true, frames };
  } catch (error) {
    return {
      added: false,
      reason: `the model could not be added: ${String(error && error.message ? error.message : error)}`,
    };
  }
}

/**
 * PAGE SIDE. Render until the manager's cube has settled, then read the six
 * faces of mip 0. Self-contained: passed to `page.evaluate`.
 *
 * @param {{maxFrames: number, settledReads: number}} input
 * @returns {Promise<object>} `{available: true, format, size, mipLevels,
 *   frames, faces: [{face, bytes (base64)}]}` or `{available: false, reason}`.
 */
export async function pageSkyCubeReadFaces({ maxFrames, settledReads }) {
  const root = /** @type {any} */ (globalThis);
  const viewer = root.viewer;
  const scene = viewer && viewer.scene;
  const notAvailable = (seam) => ({
    available: false,
    reason: `NOT AVAILABLE: ${seam}`,
  });
  const model = root.__skyCubeModel;
  if (!model) {
    return notAvailable("no model was added (seam: globalThis.__skyCubeModel)");
  }
  const manager = model._environmentMapManager;
  if (!manager) {
    return notAvailable("the model has no environment map manager");
  }
  const device = scene.context && scene.context.device;
  if (!device || typeof device.createComputePipeline !== "function") {
    return notAvailable("scene.context.device (a WebGPU device)");
  }
  let frames = 0;
  let settled = 0;
  while (frames < maxFrames && settled < settledReads) {
    const cache = manager._webgpuCache;
    if (
      cache &&
      cache.cubemapTexture &&
      cache.pendingRefresh === null &&
      cache.needsUpdate === false
    ) {
      settled++;
    } else {
      settled = 0;
    }
    if (settled < settledReads) {
      scene.initializeFrame();
      scene.render(viewer.clock.currentTime);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      frames++;
    }
  }
  const cache = manager._webgpuCache;
  if (!cache || !cache.cubemapTexture) {
    return notAvailable(
      `manager._webgpuCache.cubemapTexture was not created in ${frames} frames`,
    );
  }
  if (settled < settledReads) {
    return notAvailable(
      `manager._webgpuCache did not settle (pendingRefresh / needsUpdate) in ${frames} frames`,
    );
  }
  const texture = cache.cubemapTexture;
  const format = String(texture.format);
  const size = texture.width;
  const mipLevels = texture.mipLevelCount;
  const float16 = format === "rgba16float";
  if (!float16 && format !== "rgba8unorm") {
    return notAvailable(
      `the cube's format ${format} (seam: rgba8unorm or rgba16float)`,
    );
  }
  const wordsPerTexel = float16 ? 2 : 1;
  const write = float16
    ? "dst[i * 2u] = pack2x16float(c.xy); dst[i * 2u + 1u] = pack2x16float(c.zw);"
    : "dst[i] = pack4x8unorm(c);";
  const code = `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = textureDimensions(src).x;
  if (id.x >= n || id.y >= n) { return; }
  let c = textureLoad(src, vec2<i32>(i32(id.x), i32(id.y)), i32(id.z), 0);
  let i = (id.z * n + id.y) * n + id.x;
  ${write}
}`;
  const faceBytes = size * size * 4 * wordsPerTexel;
  // Every object the readback creates, and its submit, sit inside one
  // validation scope, so an error of the probe's own pass is answered here as
  // NOT AVAILABLE and never reaches the page's error gate as a scene error, nor
  // a never-written staging buffer as six zero faces.
  device.pushErrorScope("validation");
  let scopeOpen = true;
  const out = device.createBuffer({
    label: "skyCube readback storage",
    size: faceBytes * 6,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const staging = device.createBuffer({
    label: "skyCube readback staging",
    size: faceBytes * 6,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const module = device.createShaderModule({
      label: "skyCube readback",
      code,
    });
    const pipeline = device.createComputePipeline({
      label: "skyCube readback",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: texture.createView({
            dimension: "2d-array",
            baseMipLevel: 0,
            mipLevelCount: 1,
          }),
        },
        { binding: 1, resource: { buffer: out } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), 6);
    pass.end();
    encoder.copyBufferToBuffer(out, 0, staging, 0, faceBytes * 6);
    device.queue.submit([encoder.finish()]);
    scopeOpen = false;
    const validationError = await device.popErrorScope();
    if (validationError) {
      return notAvailable(
        `GPU validation error during the face readback: ${String(validationError.message ?? validationError)}`,
      );
    }
    await staging.mapAsync(GPUMapMode.READ);
    const all = new Uint8Array(staging.getMappedRange().slice(0));
    staging.unmap();
    const faces = [];
    for (let face = 0; face < 6; face++) {
      const bytes = all.subarray(face * faceBytes, (face + 1) * faceBytes);
      let binary = "";
      for (let at = 0; at < bytes.length; at += 0x8000) {
        binary += String.fromCharCode.apply(
          null,
          bytes.subarray(at, at + 0x8000),
        );
      }
      faces.push({ face, bytes: btoa(binary) });
    }
    return { available: true, format, size, mipLevels, frames, faces };
  } catch (error) {
    return notAvailable(
      `the face readback threw ${String(error && error.message ? error.message : error)}`,
    );
  } finally {
    if (scopeOpen) {
      // A throw before the submit: close the scope; its error, if any, is the
      // throw this function already answered with.
      await device.popErrorScope().catch(() => null);
    }
    out.destroy();
    staging.destroy();
  }
}

/**
 * The record a sky-cube page carries, from the page's raw answer. Statistics
 * are computed here: the page returns bytes only. The bytes go to a file, one
 * per face, and never into the record. Pure apart from `writeFace`.
 *
 * @param {object|null|undefined} raw {@link pageSkyCubeReadFaces}' answer.
 * @param {{base: string, outputDirectory: string,
 *   writeFace?: (file: string, bytes: Buffer) => void}} options
 * @returns {object}
 */
export function skyCubeRecord(raw, { base, outputDirectory, writeFace }) {
  if (!raw || raw.available !== true) {
    return {
      available: false,
      reason:
        raw?.reason ??
        "NOT AVAILABLE: the page returned no face readback (seam: manager._webgpuCache.cubemapTexture)",
    };
  }
  const write =
    writeFace ??
    ((file, bytes) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    });
  const faces = (raw.faces ?? []).map((entry) => {
    const bytes = Buffer.from(String(entry.bytes ?? ""), "base64");
    const file = path.join(
      outputDirectory,
      `${base}-skycube-face${entry.face}.bin`,
    );
    write(file, bytes);
    let nonZeroBytes = 0;
    for (const byte of bytes) {
      if (byte !== 0) {
        nonZeroBytes++;
      }
    }
    return {
      face: entry.face,
      sha256: sha256(bytes),
      byteLength: bytes.length,
      nonZeroBytes,
      path: path.resolve(file),
    };
  });
  return {
    available: true,
    format: raw.format,
    size: raw.size,
    mipLevels: raw.mipLevels,
    frames: raw.frames,
    faces,
  };
}

/**
 * Add the model, read the faces and build the record. Node side.
 *
 * @param {{page: object, rig: object, moduleUrl: string, base: string,
 *   outputDirectory: string}} input
 * @returns {Promise<object>}
 */
export async function runSkyCubeSteps({
  page,
  rig,
  moduleUrl,
  base,
  outputDirectory,
}) {
  const model = rig?.dials?.skyCubeModel;
  const violation = skyCubeModelViolation(model);
  if (violation !== null) {
    return { available: false, reason: `NOT AVAILABLE: ${violation}` };
  }
  const added = await page.evaluate(pageSkyCubeAddModel, {
    moduleUrl,
    model,
    maxFrames: SKY_CUBE_MODEL_MAX_FRAMES,
  });
  if (added?.added !== true) {
    return {
      available: false,
      reason: added?.reason ?? "NOT AVAILABLE: the model step answered nothing",
    };
  }
  const raw = await page.evaluate(pageSkyCubeReadFaces, {
    maxFrames: SKY_CUBE_MAX_FRAMES,
    settledReads: SKY_CUBE_SETTLED_READS,
  });
  return {
    ...skyCubeRecord(raw, { base, outputDirectory }),
    model: { url: model.url, ready: added.ready, frames: added.frames },
  };
}

/**
 * One arm's verdict on its own cube: available, six faces, every face with
 * bytes, and every face with a non-zero byte (the sky fill writes alpha 1.0 on
 * every texel of every face, so an all-zero face is a face nothing was written
 * to). Pure.
 *
 * @param {object|null|undefined} record {@link skyCubeRecord}'s answer.
 * @returns {{pass: boolean, notAvailable?: boolean, reason?: string}}
 */
export function skyCubeRecordVerdict(record) {
  if (!record || record.available !== true) {
    return {
      pass: false,
      notAvailable: true,
      reason: record?.reason ?? "NOT AVAILABLE: no sky-cube record",
    };
  }
  const faces = record.faces ?? [];
  if (
    faces.length !== SKY_CUBE_FACE_COUNT ||
    faces.some((face) => !(face.byteLength > 0))
  ) {
    return {
      pass: false,
      reason: `the record holds ${faces.length} faces, or a face without bytes`,
    };
  }
  // The sky fill stores alpha 1.0 on every texel of all six layers
  // (Shaders/WebGPU/Compute/ProceduralSkyCubemap.wgsl, dispatched with z = 6),
  // so no legitimate face is all zero: each face is judged on its own.
  const empty = faces.filter((face) => !(face.nonZeroBytes > 0));
  if (empty.length > 0) {
    return {
      pass: false,
      reason: `face(s) ${empty.map((face) => face.face).join(", ")} hold only zero bytes: nothing was written there`,
      emptyFaces: empty.map((face) => face.face),
    };
  }
  return { pass: true };
}

function halfToFloat(half) {
  const sign = half & 0x8000 ? -1 : 1;
  const exponent = (half >> 10) & 0x1f;
  const fraction = half & 0x3ff;
  if (exponent === 0) {
    return sign * 2 ** -14 * (fraction / 1024);
  }
  if (exponent === 31) {
    return fraction === 0 ? sign * Infinity : NaN;
  }
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/**
 * The largest absolute element difference of two equal-length face byte
 * buffers: bytes for rgba8unorm, decoded halves for rgba16float. Pure.
 *
 * @param {Buffer} a
 * @param {Buffer} b
 * @param {string} format
 * @returns {number}
 */
export function faceMaxAbsDelta(a, b, format) {
  let max = 0;
  if (format === "rgba16float") {
    for (let at = 0; at + 1 < a.length; at += 2) {
      const delta = Math.abs(
        halfToFloat(a.readUInt16LE(at)) - halfToFloat(b.readUInt16LE(at)),
      );
      if (Number.isNaN(delta)) {
        return NaN;
      }
      max = Math.max(max, delta);
    }
    return max;
  }
  for (let at = 0; at < a.length; at++) {
    max = Math.max(max, Math.abs(a[at] - b[at]));
  }
  return max;
}

/**
 * Compare two arms' sky-cube records (BEFORE against TIP). Identity is equal
 * per-face sha256; otherwise the per-face maximum absolute delta from the face
 * files (`readFace(record, face)`), `null` for a face whose bytes cannot be
 * read. A record that is not available on either side makes the comparison
 * NOT AVAILABLE with that side's reason; a geometry difference (format, size,
 * face count) is DIFFERS without a delta. Pure apart from `readFace`.
 *
 * @param {object|null|undefined} before
 * @param {object|null|undefined} after
 * @param {{readFace?: (record: object, face: object) => Buffer|null}} [options]
 * @returns {{verdict: string, reason?: string, faces?: object[]}}
 */
export function compareSkyCubeRecords(before, after, options = {}) {
  const readFace =
    options.readFace ??
    ((_record, face) => {
      try {
        return fs.readFileSync(face.path);
      } catch {
        return null;
      }
    });
  for (const [arm, record] of [
    ["before", before],
    ["after", after],
  ]) {
    if (!record || record.available !== true) {
      return {
        verdict: SKY_CUBE_COMPARE.NOT_AVAILABLE,
        reason: `${arm} arm: ${record?.reason ?? "NOT AVAILABLE: no sky-cube record"}`,
      };
    }
  }
  const facesBefore = before.faces ?? [];
  const facesAfter = after.faces ?? [];
  if (
    before.format !== after.format ||
    before.size !== after.size ||
    facesBefore.length !== facesAfter.length
  ) {
    return {
      verdict: SKY_CUBE_COMPARE.DIFFERS,
      reason: `geometry differs: ${before.format} ${before.size}px x${facesBefore.length} against ${after.format} ${after.size}px x${facesAfter.length}`,
    };
  }
  const faces = facesBefore.map((faceBefore, index) => {
    const faceAfter = facesAfter[index];
    const identical =
      faceBefore.sha256 === faceAfter.sha256 &&
      faceBefore.byteLength === faceAfter.byteLength;
    let maxAbsDelta = identical ? 0 : null;
    if (!identical) {
      const a = readFace(before, faceBefore);
      const b = readFace(after, faceAfter);
      if (a && b && a.length === b.length) {
        maxAbsDelta = faceMaxAbsDelta(a, b, before.format);
      }
    }
    return { face: faceBefore.face, identical, maxAbsDelta };
  });
  return {
    verdict: faces.every((face) => face.identical)
      ? SKY_CUBE_COMPARE.IDENTICAL
      : SKY_CUBE_COMPARE.DIFFERS,
    faces,
  };
}
