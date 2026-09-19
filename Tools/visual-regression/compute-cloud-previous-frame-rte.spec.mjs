// @purpose Executes the real camera packers of the compute-instance and cloud-collection WebGPU renderers from Node to prove their previous-frame lanes carry a relative-to-eye pair taken from UniformState, and cross-checks every float offset against the renderers' own WGSL struct text and size constants.
//
// WHY THIS EXISTS
//
// Both velocity vertex stages used to compute the CURRENT clip position
// relative to the eye and the PREVIOUS one from a reconstructed full-magnitude
// world position:
//
//   let prevWorldPos = vec4<f32>(prevPosHigh + prevPosLow, 1.0);
//   let prevCenterClip = camera.prevViewProjection * prevWorldPos;
//
// `prevPosHigh + prevPosLow` rounds at the f32 ulp of an Earth radius, so a
// STATIC primitive under a STATIC camera emitted non-zero velocity. The fix
// makes the previous-frame expression the current-frame expression with
// previous-frame operands, which means the packers must carry a previous
// relative-to-eye matrix and a previous encoded camera split.
//
// WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT
//
// The load-bearing assertion is a behaviour of the OUTPUT, not of the source
// text: when the previous camera state equals the current camera state - which
// is exactly the condition `UniformState.update` forces on a history reset
// (teleport, morph, scene-mode or projection change) - the packed previous
// lanes must equal the packed current lanes float for float, so the shader
// subtracts two identical clip positions and emits zero. A moved-camera
// companion runs the same assertion inverted so the static case cannot pass
// vacuously, and a perturbation test proves the lanes carry `UniformState`'s
// values rather than a recomputation.
//
// These renderer modules cannot be imported from Node: they import generated
// `Shaders/**/*.js` modules that exist only after a build. The packer text is
// therefore extracted from the real source and executed with `new Function`,
// with the real `Matrix4` / `EncodedCartesian3` injected. A mutant that edits
// the packer changes what these tests read.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const coreUrl = (name) =>
  new URL(
    `file:///${path
      .resolve(root, "packages/engine/Source/Core", name)
      .replace(/\\/g, "/")}`,
  ).href;

const { default: Matrix4 } = await import(coreUrl("Matrix4.js"));
const { default: Cartesian3 } = await import(coreUrl("Cartesian3.js"));
const { default: EncodedCartesian3 } = await import(
  coreUrl("EncodedCartesian3.js")
);

const COMPUTE_WGSL_FILE = path.resolve(
  root,
  "packages/engine/Source/Shaders/WebGPU/Compute/ComputeInstanceRender.wgsl",
);
const COMPUTE_RENDERER_FILE = path.resolve(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUComputeInstanceRenderer.ts",
);
const CLOUD_RENDERER_FILE = path.resolve(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUCloudRenderer.ts",
);

const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------
// Derivation A - float offsets from the real WGSL struct text.
// ---------------------------------------------------------------------------

// WGSL uniform address space layout: size and alignment per host-shareable
// type. `vec3<f32>` is the load-bearing one - it occupies 12 bytes but aligns
// to 16, which is why every struct here carries an explicit trailing pad.
const WGSL_TYPES = {
  "mat4x4<f32>": { size: 64, align: 16 },
  "vec4<f32>": { size: 16, align: 16 },
  "vec3<f32>": { size: 12, align: 16 },
  "vec2<f32>": { size: 8, align: 8 },
  f32: { size: 4, align: 4 },
};

/**
 * Pull `struct <name> { ... }` out of WGSL source by brace matching.
 *
 * @param {string} source WGSL text.
 * @param {string} name Struct name.
 * @returns {string} The struct body, braces excluded.
 */
function structBody(source, name) {
  const key = `struct ${name} {`;
  const at = source.indexOf(key);
  assert.ok(at >= 0, `struct ${name} not found`);
  let depth = 0;
  for (let i = at + key.length - 1; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(at + key.length, i);
    }
  }
  assert.fail(`struct ${name} is unterminated`);
}

/**
 * Walk a WGSL struct body under the uniform layout rules.
 *
 * @param {string} body Struct body text.
 * @returns {{offsets: Record<string, number>, totalFloats: number}} Float
 *   offsets keyed by field name, and the struct's total size in floats.
 */
function deriveWgslLayout(body) {
  const stripped = body.replace(/\/\/[^\n]*/g, "");
  const fields = [...stripped.matchAll(/(\w+)\s*:\s*([\w<>]+)\s*,/g)];
  assert.ok(fields.length > 0, "no fields parsed from struct body");
  const offsets = {};
  let byteOffset = 0;
  for (const [, name, type] of fields) {
    const info = WGSL_TYPES[type];
    assert.ok(info, `unhandled WGSL type \`${type}\` on field \`${name}\``);
    byteOffset = Math.ceil(byteOffset / info.align) * info.align;
    assert.equal(
      byteOffset % 4,
      0,
      `field \`${name}\` does not start on a float boundary`,
    );
    offsets[name] = byteOffset / 4;
    byteOffset += info.size;
  }
  // A struct's own alignment is the max of its members' alignments; every
  // struct here contains a mat4, so that is 16.
  const totalBytes = Math.ceil(byteOffset / 16) * 16;
  return { offsets, totalFloats: totalBytes / 4 };
}

// ---------------------------------------------------------------------------
// Derivation B - float offsets read off the real packer source text.
// ---------------------------------------------------------------------------

/**
 * The integer third argument of `Matrix4.pack(<binding>, data, N)`.
 *
 * @param {string} source Packer text.
 * @param {string} binding The packed value's identifier.
 * @returns {number} Destination float offset.
 */
function packOffset(source, binding) {
  const re = new RegExp(
    `Matrix4\\.pack\\(\\s*${binding}\\s*,\\s*data\\s*,\\s*(\\d+)\\s*\\)`,
  );
  const m = re.exec(source);
  assert.ok(m, `no \`Matrix4.pack(${binding}, data, N)\` in the packer`);
  return Number(m[1]);
}

/**
 * The float offset and zero-fill range of the previous encoded camera split.
 *
 * @param {string} source Packer text.
 * @returns {{high: number, fill: [number, number]}} Offsets.
 */
function previousSplitOffsets(source) {
  const at = source.indexOf("previousCameraPosition");
  assert.ok(at >= 0, "the packer never reads `previousCameraPosition`");
  const fill = /data\.fill\(\s*0\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g;
  let chosen;
  for (const m of source.matchAll(fill)) {
    // The fill that clears the split precedes the `prevCam` binding by a line;
    // take the last fill that starts before the conditional writes it guards.
    if (m.index < at) chosen = m;
  }
  assert.ok(chosen, "no `data.fill(0, A, B)` clears the previous split");
  const highs = [
    ...source.matchAll(/data\[(\d+)\] = scratchEncoded\.high\.x;/g),
  ];
  assert.equal(
    highs.length,
    2,
    "expected exactly two `scratchEncoded.high.x` writes (current, previous)",
  );
  return {
    high: Number(highs[1][1]),
    fill: [Number(chosen[1]), Number(chosen[2])],
  };
}

// ---------------------------------------------------------------------------
// Packer extraction and execution.
// ---------------------------------------------------------------------------

/**
 * Remove TypeScript `as` casts so the real statement text can be executed by
 * `new Function`. Handles `x as unknown as { ... }`, `x as { ... }` and
 * `x as Identifier`; nothing else appears in these two packers, and an
 * unhandled shape surfaces as a SyntaxError from `new Function` rather than
 * silently changing behaviour.
 *
 * @param {string} source TypeScript statement text.
 * @returns {string} JavaScript statement text.
 */
function stripAsCasts(source) {
  let out = "";
  let i = 0;
  for (;;) {
    const at = source.indexOf(" as ", i);
    if (at < 0) {
      out += source.slice(i);
      return out;
    }
    out += source.slice(i, at);
    let j = at + 4;
    while (j < source.length && /\s/.test(source[j])) j++;
    if (source.startsWith("unknown", j)) {
      i = j + "unknown".length;
      continue;
    }
    if (source[j] === "{") {
      let depth = 0;
      for (; j < source.length; j++) {
        if (source[j] === "{") depth++;
        else if (source[j] === "}") {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
      i = j;
      continue;
    }
    const ident = /^[A-Za-z_$][\w$]*/.exec(source.slice(j));
    assert.ok(ident, `unparsed type after \` as \` at index ${at}`);
    i = j + ident[0].length;
  }
}

/**
 * The compute-instance packer: the statements between the uniform-state
 * binding and the buffer write.
 *
 * @param {string} source Renderer source.
 * @returns {string} Executable statement text.
 */
function extractComputePacker(source) {
  const start = source.indexOf("  const us = context.uniformState;");
  assert.ok(start >= 0, "compute packer start marker moved");
  const end = source.indexOf(
    "device.queue.writeBuffer(cache.cameraUniformBuffer",
    start,
  );
  assert.ok(end > start, "compute packer end marker moved");
  return stripAsCasts(source.slice(start, end));
}

/**
 * The cloud packer: the body of the `packCloud` arrow function.
 *
 * @param {string} source Renderer source.
 * @returns {string} Executable statement text.
 */
function extractCloudPacker(source) {
  const key = "const packCloud = (data: Float32Array): void => {";
  const at = source.indexOf(key);
  assert.ok(at >= 0, "cloud packer signature moved");
  let depth = 0;
  for (let i = at + key.length - 1; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return stripAsCasts(source.slice(at + key.length, i));
      }
    }
  }
  assert.fail("cloud packer body is unterminated");
}

const m4Values = (m) => m;
const newScratch = () => ({
  scratchMVRTE: new Matrix4(),
  scratchMVP: new Matrix4(),
  scratchEncoded: { high: new Cartesian3(), low: new Cartesian3() },
});

/**
 * Build a `UniformState` stand-in. Only the members the packers actually read
 * are present, so a packer that starts reading something new fails loudly.
 *
 * @param {object} options Camera state.
 * @returns {object} The stub.
 */
function makeUniformState(options) {
  const {
    view,
    projection,
    cameraPosition,
    previousView,
    previousCameraPosition,
  } = options;
  const prevRte = Matrix4.clone(previousView ?? view, new Matrix4());
  prevRte[12] = 0;
  prevRte[13] = 0;
  prevRte[14] = 0;
  const previousViewProjectionRelativeToEye = Matrix4.multiply(
    projection,
    prevRte,
    new Matrix4(),
  );
  return {
    view,
    projection,
    cameraPosition,
    previousCameraPosition: previousCameraPosition ?? cameraPosition,
    previousViewProjection: Matrix4.multiply(
      projection,
      previousView ?? view,
      new Matrix4(),
    ),
    previousViewProjectionRelativeToEye,
    currentFrustum: { x: 1.0, y: 1.0e7 },
    oneOverLog2FarDepthFromNearPlusOne: 0.0423,
  };
}

// A view matrix satisfies t_V = -R_V * cameraPositionWC. Building the stub
// this way is what makes the previous camera the camera OF the previous view,
// which is the pairing the cancellation in the shader depends on.
function viewFor(camera, tilt) {
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  // Column-major rotation about Z, then the translation column that puts the
  // camera at the origin of eye space.
  const r = [c, -s, 0, s, c, 0, 0, 0, 1];
  const tx = -(r[0] * camera.x + r[3] * camera.y + r[6] * camera.z);
  const ty = -(r[1] * camera.x + r[4] * camera.y + r[7] * camera.z);
  const tz = -(r[2] * camera.x + r[5] * camera.y + r[8] * camera.z);
  return Matrix4.fromColumnMajorArray(
    [
      r[0],
      r[1],
      r[2],
      0,
      r[3],
      r[4],
      r[5],
      0,
      r[6],
      r[7],
      r[8],
      0,
      tx,
      ty,
      tz,
      1,
    ],
    new Matrix4(),
  );
}

const PROJECTION = Matrix4.fromColumnMajorArray(
  [
    1.299038, 0, 0, 0, 0, 2.414213, 0, 0, 0, 0, -1.0000002, -1, 0, 0,
    -2.0000002, 0,
  ],
  new Matrix4(),
);

const CAMERA = new Cartesian3(7378137.0, 1234567.0, -2345678.0);
// Moved by more than one 65536 encoding grid step plus a sub-grid remainder,
// so BOTH halves of the encoded split change, not just the low half.
const CAMERA_MOVED = new Cartesian3(
  7378137.0 + 196608.0 + 731.5,
  1234567.0 - 131072.0 - 17.25,
  -2345678.0 + 65536.0 + 3.125,
);

// ---------------------------------------------------------------------------
// Per-renderer contract.
// ---------------------------------------------------------------------------

const RENDERERS = [
  {
    label: "compute-instance",
    rendererFile: COMPUTE_RENDERER_FILE,
    wgslFrom: () => read(COMPUTE_WGSL_FILE),
    sizeConstant: /const CAMERA_UNIFORM_FLOATS = (\d+);/,
    bufferSizeText: "size: CAMERA_UNIFORM_FLOATS * 4,",
    currentMatrix: "mvpRelativeToEye",
    previousMatrix: "previousMvpRelativeToEye",
    currentHigh: "encodedCameraHigh",
    currentLow: "encodedCameraLow",
    previousHigh: "previousEncodedCameraHigh",
    previousLow: "previousEncodedCameraLow",
    legacyPrevious: "previousViewProjection",
    previousRteBinding: "prevVPRTE",
    legacyBinding: "prevVP",
    extract: extractComputePacker,
    run(body, uniformState, floats) {
      const scratch = newScratch();
      const data = new Float32Array(floats);
      // eslint-disable-next-line no-new-func -- executing the renderer's OWN packer text is the point: a mutant that edits it changes these numbers
      const fn = new Function(
        "context",
        "cache",
        "Matrix4",
        "EncodedCartesian3",
        "m4Values",
        "scratchMVRTE",
        "scratchMVP",
        "scratchEncoded",
        `${body}\nreturn data;`,
      );
      return fn(
        { uniformState, _canvas: { width: 1600, height: 900 } },
        { cameraUniformData: data },
        Matrix4,
        EncodedCartesian3,
        m4Values,
        scratch.scratchMVRTE,
        scratch.scratchMVP,
        scratch.scratchEncoded,
      );
    },
  },
  {
    label: "cloud-collection",
    rendererFile: CLOUD_RENDERER_FILE,
    wgslFrom: (source) => {
      const key = "const CLOUD_WGSL = /* wgsl */ `";
      const at = source.indexOf(key);
      assert.ok(at >= 0, "CLOUD_WGSL template literal moved");
      const end = source.indexOf("`;", at + key.length);
      assert.ok(end > at, "CLOUD_WGSL is unterminated");
      return source.slice(at + key.length, end);
    },
    sizeConstant: /const CLOUD_CAMERA_UNIFORM_FLOATS = (\d+);/,
    bufferSizeText: "size: CLOUD_CAMERA_UNIFORM_FLOATS * 4,",
    currentMatrix: "modelViewProjectionRTE",
    previousMatrix: "previousModelViewProjectionRTE",
    currentHigh: "encodedCameraHigh",
    currentLow: "encodedCameraLow",
    previousHigh: "previousEncodedCameraHigh",
    previousLow: "previousEncodedCameraLow",
    legacyPrevious: "prevViewProjection",
    previousRteBinding: "prevVPRTE",
    legacyBinding: "prevVP",
    extract: extractCloudPacker,
    run(body, uniformState, floats) {
      const scratch = newScratch();
      const data = new Float32Array(floats);
      // eslint-disable-next-line no-new-func -- executing the renderer's OWN packer text is the point: a mutant that edits it changes these numbers
      const fn = new Function(
        "data",
        "us",
        "context",
        "frameState",
        "Matrix4",
        "EncodedCartesian3",
        "m4Values",
        "scratchMVRTE",
        "scratchMVP",
        "scratchEncoded",
        `${body}\nreturn data;`,
      );
      return fn(
        data,
        uniformState,
        { _canvas: { width: 1600, height: 900 } },
        { frameNumber: 42 },
        Matrix4,
        EncodedCartesian3,
        m4Values,
        scratch.scratchMVRTE,
        scratch.scratchMVP,
        scratch.scratchEncoded,
      );
    },
  },
];

for (const r of RENDERERS) {
  test(`${r.label}: WGSL struct and packer agree on every previous-frame offset`, () => {
    const source = read(r.rendererFile);
    const wgsl = r.wgslFrom(source);
    const { offsets, totalFloats } = deriveWgslLayout(
      structBody(wgsl, "CameraUniforms"),
    );

    // The size constant is the renderer's own declaration of the layout.
    const declared = r.sizeConstant.exec(source);
    assert.ok(declared, `${r.label}: size constant not found`);
    assert.equal(
      Number(declared[1]),
      totalFloats,
      `${r.label}: size constant disagrees with the WGSL struct`,
    );
    // The camera buffer must derive its size from that constant, or growing
    // the struct leaves a binding smaller than its minimum binding size.
    assert.ok(
      source.includes(r.bufferSizeText),
      `${r.label}: camera buffer size is not derived from the size constant`,
    );

    const packer = r.extract(source);

    // Derivation B - the offsets written in the packer's own text.
    const split = previousSplitOffsets(packer);
    assert.equal(
      packOffset(packer, r.previousRteBinding),
      offsets[r.previousMatrix],
      `${r.label}: previous RTE matrix offset disagrees with the struct`,
    );
    assert.equal(
      split.high,
      offsets[r.previousHigh],
      `${r.label}: previous camera high offset disagrees with the struct`,
    );
    assert.deepEqual(
      split.fill,
      [offsets[r.previousHigh], offsets[r.previousLow] + 4],
      `${r.label}: the previous split's zero-fill does not cover exactly the split`,
    );
    assert.equal(
      packOffset(packer, r.legacyBinding),
      offsets[r.legacyPrevious],
      `${r.label}: the retained previous view-projection moved`,
    );

    // The retained world-space matrix must still be declared and still be
    // packed - the camera-uniform layout rule requires it.
    assert.ok(
      Object.hasOwn(offsets, r.legacyPrevious),
      `${r.label}: \`${r.legacyPrevious}\` was deleted from the struct`,
    );

    console.log(
      `${r.label}: ${totalFloats} floats / ${totalFloats * 4} bytes | ` +
        `${r.previousMatrix}@${offsets[r.previousMatrix]} ` +
        `${r.previousHigh}@${offsets[r.previousHigh]} ` +
        `${r.previousLow}@${offsets[r.previousLow]} ` +
        `${r.legacyPrevious}@${offsets[r.legacyPrevious]}`,
    );
  });

  test(`${r.label}: a history reset packs previous lanes identical to current`, () => {
    const source = read(r.rendererFile);
    const wgsl = r.wgslFrom(source);
    const { offsets, totalFloats } = deriveWgslLayout(
      structBody(wgsl, "CameraUniforms"),
    );
    const packer = r.extract(source);

    // The reset condition `UniformState.update` forces when temporal history
    // is incompatible: previous view-projection-relative-to-eye identical to
    // the current one, and the previous camera identical to the current one.
    const view = viewFor(CAMERA, 0.3);
    const data = r.run(
      packer,
      makeUniformState({
        view,
        projection: PROJECTION,
        cameraPosition: CAMERA,
      }),
      totalFloats,
    );

    const cur = offsets[r.currentMatrix];
    const prev = offsets[r.previousMatrix];
    for (let i = 0; i < 16; i++) {
      assert.equal(
        data[prev + i],
        data[cur + i],
        `${r.label}: previous matrix float ${i} differs from current under reset`,
      );
    }
    for (let i = 0; i < 3; i++) {
      assert.equal(
        data[offsets[r.previousHigh] + i],
        data[offsets[r.currentHigh] + i],
        `${r.label}: previous camera high ${i} differs from current under reset`,
      );
      assert.equal(
        data[offsets[r.previousLow] + i],
        data[offsets[r.currentLow] + i],
        `${r.label}: previous camera low ${i} differs from current under reset`,
      );
    }
    // The pads that separate the split must be exactly zero, or the shader
    // reads a vec3 whose neighbouring lane leaked into it.
    assert.equal(data[offsets[r.previousHigh] + 3], 0);
    assert.equal(data[offsets[r.previousLow] + 3], 0);

    console.log(
      `${r.label}: reset -> previous matrix [${data[prev]}, ${data[prev + 5]}, ` +
        `${data[prev + 10]}] == current [${data[cur]}, ${data[cur + 5]}, ` +
        `${data[cur + 10]}]; split high[0]=${data[offsets[r.previousHigh]]}`,
    );
  });

  test(`${r.label}: a moved camera makes previous and current lanes differ`, () => {
    const source = read(r.rendererFile);
    const wgsl = r.wgslFrom(source);
    const { offsets, totalFloats } = deriveWgslLayout(
      structBody(wgsl, "CameraUniforms"),
    );
    const packer = r.extract(source);

    const data = r.run(
      packer,
      makeUniformState({
        view: viewFor(CAMERA_MOVED, 0.42),
        projection: PROJECTION,
        cameraPosition: CAMERA_MOVED,
        previousView: viewFor(CAMERA, 0.3),
        previousCameraPosition: CAMERA,
      }),
      totalFloats,
    );

    const cur = offsets[r.currentMatrix];
    const prev = offsets[r.previousMatrix];
    let matrixDiffs = 0;
    for (let i = 0; i < 16; i++) {
      if (data[prev + i] !== data[cur + i]) matrixDiffs++;
    }
    assert.ok(
      matrixDiffs > 0,
      `${r.label}: previous matrix is identical to current after a camera move`,
    );

    let splitDiffs = 0;
    for (let i = 0; i < 3; i++) {
      if (
        data[offsets[r.previousHigh] + i] !== data[offsets[r.currentHigh] + i]
      )
        splitDiffs++;
      if (data[offsets[r.previousLow] + i] !== data[offsets[r.currentLow] + i])
        splitDiffs++;
    }
    assert.ok(
      splitDiffs > 0,
      `${r.label}: previous camera split is identical to current after a move`,
    );

    console.log(
      `${r.label}: moved -> ${matrixDiffs}/16 matrix floats and ` +
        `${splitDiffs}/6 split floats differ`,
    );
  });

  test(`${r.label}: previous lanes carry UniformState's values, not a recomputation`, () => {
    const source = read(r.rendererFile);
    const wgsl = r.wgslFrom(source);
    const { offsets, totalFloats } = deriveWgslLayout(
      structBody(wgsl, "CameraUniforms"),
    );
    const packer = r.extract(source);

    const base = makeUniformState({
      view: viewFor(CAMERA, 0.3),
      projection: PROJECTION,
      cameraPosition: CAMERA,
    });

    // Sentinels: values no recomputation from `view`/`projection` could
    // produce. If the packer recomputed the previous matrix instead of reading
    // `UniformState`, these would not appear in the output at all.
    const sentinelMatrix = Matrix4.fromColumnMajorArray(
      Array.from({ length: 16 }, (_, i) => 1000 + i),
      new Matrix4(),
    );
    // Deliberately NOT on the 65536 encoding grid, so the low half of the
    // split is non-zero and the low lanes are actually exercised.
    const sentinelCamera = new Cartesian3(3211264.5, -1179648.25, 917504.75);
    const perturbed = {
      ...base,
      previousViewProjectionRelativeToEye: sentinelMatrix,
      previousCameraPosition: sentinelCamera,
    };

    const data = r.run(packer, perturbed, totalFloats);

    const prev = offsets[r.previousMatrix];
    for (let i = 0; i < 16; i++) {
      assert.equal(
        data[prev + i],
        1000 + i,
        `${r.label}: previous matrix float ${i} did not follow UniformState`,
      );
    }

    const expected = EncodedCartesian3.fromCartesian(sentinelCamera, {
      high: new Cartesian3(),
      low: new Cartesian3(),
    });
    const hi = offsets[r.previousHigh];
    const lo = offsets[r.previousLow];
    assert.equal(data[hi + 0], Math.fround(expected.high.x));
    assert.equal(data[hi + 1], Math.fround(expected.high.y));
    assert.equal(data[hi + 2], Math.fround(expected.high.z));
    assert.equal(data[lo + 0], Math.fround(expected.low.x));
    assert.equal(data[lo + 1], Math.fround(expected.low.y));
    assert.equal(data[lo + 2], Math.fround(expected.low.z));

    // Derivation C - the sentinel landed where both earlier derivations said
    // it would, which is the executed-output confirmation of the offsets.
    assert.equal(
      data.indexOf(1000),
      prev,
      `${r.label}: the sentinel matrix landed at a different offset`,
    );

    console.log(
      `${r.label}: sentinel matrix at float ${data.indexOf(1000)}; split ` +
        `high=(${data[hi]}, ${data[hi + 1]}, ${data[hi + 2]}) ` +
        `low=(${data[lo]}, ${data[lo + 1]}, ${data[lo + 2]})`,
    );
  });
}

/**
 * The body of a `vertexVelocityMain` entry point, brace-matched. Scoping the
 * text assertions to this slice keeps a failure message readable and stops a
 * match elsewhere in the file from standing in for the real site.
 *
 * @param {string} source Shader or renderer source.
 * @returns {string} The velocity stage's text.
 */
function velocityStage(source) {
  const at = source.indexOf("fn vertexVelocityMain");
  assert.ok(at >= 0, "`fn vertexVelocityMain` not found");
  const open = source.indexOf("{", at);
  assert.ok(open > at, "velocity stage has no body");
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  assert.fail("velocity stage is unterminated");
}

test("both velocity stages reproject the previous position relative to the previous eye", () => {
  const computeWgsl = velocityStage(read(COMPUTE_WGSL_FILE));
  const cloudSource = velocityStage(read(CLOUD_RENDERER_FILE));

  // The defect's signature, in either spelling. Its absence is what makes the
  // packed lanes reachable rather than decorative.
  for (const [label, text] of [
    ["compute-instance", computeWgsl],
    ["cloud-collection", cloudSource],
  ]) {
    assert.doesNotMatch(
      text,
      RECONSTRUCTION_SHAPE,
      `${label}: the velocity stage still sums previous high and low into an absolute position`,
    );
  }

  assert.match(
    computeWgsl,
    /prev\.positionHigh - camera\.previousEncodedCameraHigh/,
    "compute-instance: previous high does not cancel against the previous camera high",
  );
  assert.match(
    computeWgsl,
    /camera\.previousMvpRelativeToEye \* vec4<f32>\(prevHighDiff \+ prevLowDiff, 1\.0\)/,
    "compute-instance: previous clip is not the previous RTE matrix times the RTE position",
  );
  assert.match(
    cloudSource,
    /input\.prevPositionHigh - camera\.previousEncodedCameraHigh/,
    "cloud-collection: previous high does not cancel against the previous camera high",
  );
  assert.match(
    cloudSource,
    /camera\.previousModelViewProjectionRTE \* vec4<f32>\(prevPosRTE, 1\.0\)/,
    "cloud-collection: previous clip is not the previous RTE matrix times the RTE position",
  );

  console.log(
    "both velocity stages: previous high cancels against the previous camera high",
  );
});

// ---------------------------------------------------------------------------
// The defect, measured. The two tests above pin the CPU lanes; this one
// evaluates each shader's previous-frame expression numerically in f32 and
// asserts the velocity it produces for a static primitive under a static
// camera. Restoring either site's `prevHigh + prevLow` line flips the shape
// this test detects and the asserted NUMBER stops being zero.
// ---------------------------------------------------------------------------

// The defect's signature in either spelling: a High operand summed directly
// with a Low operand. `WebGPUCloudRenderer` qualifies both with `input.`, the
// compute shader with `prev.`, so the qualifier is matched, not assumed.
const RECONSTRUCTION_SHAPE =
  /[Pp]osition[Hh]igh\s*\+\s*(?:\w+\.)*\w*[Pp]osition[Ll]ow/;

const f32 = Math.fround;

/**
 * Column-major mat4 times vec4, every operation rounded to f32 exactly as a
 * WGSL vertex stage would.
 *
 * @param {ArrayLike<number>} m Column-major matrix.
 * @param {number[]} v Vector.
 * @returns {number[]} The transformed vector.
 */
function mulF32(m, v) {
  const out = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let col = 0; col < 4; col++) {
      sum = f32(sum + f32(f32(m[col * 4 + row]) * v[col]));
    }
    out[row] = sum;
  }
  return out;
}

/**
 * Which previous-frame expression a velocity stage currently uses.
 *
 * @param {string} text Shader text.
 * @returns {"rte"|"world"} The detected shape.
 */
function previousShape(text) {
  const rte = /-\s*camera\.previousEncodedCameraHigh/.test(text);
  const world = RECONSTRUCTION_SHAPE.test(text);
  assert.ok(
    rte !== world,
    "the velocity stage must use exactly one previous-frame shape",
  );
  return rte ? "rte" : "world";
}

test("a static primitive under a static camera emits exactly zero velocity", () => {
  const enc = (c) =>
    EncodedCartesian3.fromCartesian(c, {
      high: new Cartesian3(),
      low: new Cartesian3(),
    });

  // A point on the ellipsoid, seen from a camera about 1000 km above it. Both
  // are at planetary magnitude, which is where the f32 reconstruction floor
  // bites.
  const position = new Cartesian3(6378137.0, 1234.5, -4321.75);
  const camera = new Cartesian3(7378137.0, 1234567.0, -2345678.0);
  const p = enc(position);
  const c = enc(camera);

  const view = viewFor(camera, 0.3);
  const viewRte = Matrix4.clone(view, new Matrix4());
  viewRte[12] = 0;
  viewRte[13] = 0;
  viewRte[14] = 0;
  const mvpRte = Matrix4.multiply(PROJECTION, viewRte, new Matrix4());
  const vpWorld = Matrix4.multiply(PROJECTION, view, new Matrix4());

  // The relative-to-eye position: each high term cancels first, then the two
  // small residuals are summed. This is the current-frame expression, and
  // under a history reset it is also the previous-frame one.
  const rteVec = [
    f32(f32(f32(p.high.x) - f32(c.high.x)) + f32(f32(p.low.x) - f32(c.low.x))),
    f32(f32(f32(p.high.y) - f32(c.high.y)) + f32(f32(p.low.y) - f32(c.low.y))),
    f32(f32(f32(p.high.z) - f32(c.high.z)) + f32(f32(p.low.z) - f32(c.low.z))),
    1,
  ];
  // The reconstruction the defect performed: an absolute world position formed
  // in f32, then a full-magnitude world-space matrix.
  const worldVec = [
    f32(f32(p.high.x) + f32(p.low.x)),
    f32(f32(p.high.y) + f32(p.low.y)),
    f32(f32(p.high.z) + f32(p.low.z)),
    1,
  ];

  const ndc = (clip) => [clip[0] / clip[3], clip[1] / clip[3]];
  const currentNdc = ndc(mulF32(mvpRte, rteVec));
  const velocityOf = (shape) => {
    const prev =
      shape === "rte" ? mulF32(mvpRte, rteVec) : mulF32(vpWorld, worldVec);
    const prevNdc = ndc(prev);
    return Math.hypot(currentNdc[0] - prevNdc[0], currentNdc[1] - prevNdc[1]);
  };

  // Negative control: the expression the fix replaced does NOT produce zero on
  // these inputs, so the assertion below cannot pass vacuously.
  const worldVelocity = velocityOf("world");
  assert.ok(
    worldVelocity > 0,
    "the reconstruction shape must produce non-zero velocity, or this test proves nothing",
  );

  const computeShape = previousShape(velocityStage(read(COMPUTE_WGSL_FILE)));
  const cloudShape = previousShape(velocityStage(read(CLOUD_RENDERER_FILE)));

  assert.equal(
    velocityOf(computeShape),
    0,
    "compute-instance: a static instance under a static camera emits non-zero velocity",
  );
  assert.equal(
    velocityOf(cloudShape),
    0,
    "cloud-collection: a static cloud under a static camera emits non-zero velocity",
  );

  console.log(
    `static-camera velocity: compute-instance(${computeShape})=` +
      `${velocityOf(computeShape)}, cloud-collection(${cloudShape})=` +
      `${velocityOf(cloudShape)}; reconstruction control=${worldVelocity}`,
  );
});
