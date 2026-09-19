// collection-previous-frame-rte.spec.mjs — browser-free behaviour spec for the
// previous-frame relative-to-eye lanes in the four WebGPU collection camera
// uniform blocks (billboards, labels, points, polylines). Pure Node: no
// browser, no GPU, no build.
//
// @purpose Pins that every collection velocity stage reconstructs the previous clip position relative to the previous eye, that the packer writes the pair UniformState records, and that a still primitive under a reset previous frame emits exactly zero velocity.
// @status ACTIVE
//
// Each renderer's camera block is checked three ways:
//
//   1. LAYOUT, derived twice. Once from the WGSL struct text under the WGSL
//      uniform address-space layout rules, once by walking the packer's own
//      writes in the renderer source. The two derivations must agree field for
//      field, and the struct's size must equal the renderer's size constant.
//
//   2. OUTPUT. The packer cannot be imported from Node (these renderer modules
//      pull in `Shaders/**/*.js` string modules that only exist after a build),
//      so the packer's source text is extracted and executed with
//      `new Function`, injecting the real `Matrix4` / `Cartesian3` /
//      `EncodedCartesian3` plus stub frame and uniform state. Assertions are on
//      the returned `Float32Array`.
//
//   3. VELOCITY. The uniform floats the packer produced are fed through the
//      shader's OWN previous-frame arithmetic, classified from the shader text,
//      and the emitted NDC velocity is measured. A still primitive whose
//      previous frame was reset to the current one must emit exactly zero.
//
// The reset condition is the load-bearing one. `UniformState.update` reassigns
// the previous view-projection-relative-to-eye and the previous camera position
// to the current values whenever temporal history is incompatible — teleport,
// morph, scene-mode or map-projection change — so a reset frame is exactly the
// frame on which a static primitive must produce no motion at all.
//
// Run: node --test Tools/visual-regression/collection-previous-frame-rte.spec.mjs

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Cartesian3 from "../../packages/engine/Source/Core/Cartesian3.js";
import EncodedCartesian3 from "../../packages/engine/Source/Core/EncodedCartesian3.js";
import Matrix4 from "../../packages/engine/Source/Core/Matrix4.js";

const directory = dirname(fileURLToPath(import.meta.url));
const engineRoot = resolve(directory, "../../packages/engine/Source");
// A scratch root named for the SPEC rather than for the lane that wrote it.
// This file recreates the directory on every run, including in CI, so a lane
// name here would outlive its lane by years — and it would be swept by a
// hygiene pass that reads `cesium-lane/<name>` as a live worker's temp.
const mutantRoot = join(tmpdir(), "collection-previous-frame-rte", "mutants");
mkdirSync(mutantRoot, { recursive: true });

const read = (relative) =>
  readFileSync(resolve(engineRoot, relative), "utf8").replace(/\r\n/g, "\n");

// ── WGSL uniform address-space layout ───────────────────────────────────────

const WGSL_TYPES = {
  f32: { align: 4, size: 4 },
  i32: { align: 4, size: 4 },
  u32: { align: 4, size: 4 },
  "vec2<f32>": { align: 8, size: 8 },
  // vec3 is size 12 with alignment 16 — the trap the explicit pads exist for.
  "vec3<f32>": { align: 16, size: 12 },
  "vec4<f32>": { align: 16, size: 16 },
  "mat4x4<f32>": { align: 16, size: 64 },
};

const roundUp = (value, multiple) => Math.ceil(value / multiple) * multiple;

/**
 * Members of a named WGSL struct, in declaration order, comments stripped.
 *
 * @param {string} source WGSL text.
 * @param {string} name Struct name.
 * @returns {{name:string,type:string}[]} Declared members.
 */
function parseStruct(source, name) {
  const start = source.indexOf(`struct ${name} {`);
  assert.ok(start >= 0, `struct ${name} not found`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("\n}", open);
  assert.ok(close > open, `struct ${name} is not terminated`);
  const body = source
    .slice(open + 1, close)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0)
    .join(" ");
  return body
    .split(",")
    .map((decl) => decl.trim())
    .filter((decl) => decl.length > 0)
    .map((decl) => {
      const member = /^([A-Za-z_]\w*)\s*:\s*(.+)$/.exec(decl);
      assert.ok(member, `unparsed struct member in ${name}: "${decl}"`);
      return { name: member[1], type: member[2].trim() };
    });
}

/**
 * Float offset of every member plus the struct's own byte size.
 *
 * @param {{name:string,type:string}[]} members Parsed members.
 * @returns {{floats:Record<string,number>,bytes:Record<string,number>,size:number}} Layout.
 */
function layout(members) {
  const floats = {};
  const bytes = {};
  let cursor = 0;
  let structAlign = 1;
  for (const member of members) {
    const info = WGSL_TYPES[member.type];
    assert.ok(info, `unmodelled WGSL type "${member.type}"`);
    structAlign = Math.max(structAlign, info.align);
    cursor = roundUp(cursor, info.align);
    assert.equal(
      cursor % 4,
      0,
      `${member.name} does not start on a float boundary`,
    );
    floats[member.name] = cursor / 4;
    bytes[member.name] = cursor;
    cursor += info.size;
  }
  return { floats, bytes, size: roundUp(cursor, structAlign) };
}

// ── Renderer source: extraction and execution ───────────────────────────────

/**
 * Source text of a top-level function declaration, braces balanced.
 *
 * @param {string} source JavaScript text.
 * @param {string} name Function name.
 * @returns {string} The declaration's full source.
 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`function ${name} is not terminated`);
}

/**
 * Module-scope scratch declarations the packer closes over.
 *
 * @param {string} source Renderer source text.
 * @returns {string} The declarations, newline joined.
 */
function extractScratch(source) {
  const lines = source.match(
    /^const scratch\w+ = new (?:Matrix4|Cartesian3|EncodedCartesian3)\(\);$/gm,
  );
  assert.ok(lines && lines.length > 0, "no scratch declarations found");
  return lines.join("\n");
}

/**
 * The integer a `const NAME = <number>;` declaration binds.
 *
 * @param {string} source Renderer source text.
 * @param {string} name Constant name.
 * @returns {number} Its value.
 */
function sizeConstant(source, name) {
  const declaration = new RegExp(`const ${name} = (\\d+);`).exec(source);
  assert.ok(declaration, `${name} declaration not found`);
  return Number(declaration[1]);
}

/**
 * Executes the real packer text with the real Core math injected.
 *
 * @param {string} source Renderer source text (possibly mutated).
 * @param {string} name Packer function name.
 * @returns {Function} The packer.
 */
function loadPacker(source, name) {
  const body = `${extractScratch(source)}\n${extractFunction(
    source,
    name,
  )}\nreturn ${name};`;
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "Matrix4",
    "Cartesian3",
    "EncodedCartesian3",
    "recordLogDepthEncoder",
    body,
  );
  return factory(Matrix4, Cartesian3, EncodedCartesian3, () => {});
}

/**
 * Float indices the packer writes, with the expression each write carries.
 * `Matrix4.pack(expr, uniformData, N)` contributes sixteen floats from N.
 *
 * @param {string} packerSource Packer function source.
 * @returns {{matrices:object[],scalars:object[],highest:number}} The walk.
 */
function walkWrites(packerSource) {
  const stripped = packerSource.replace(/\/\/[^\n]*/g, "");
  const matrices = [];
  const scalars = [];
  let highest = -1;
  const packRe =
    /Matrix4\.pack\(\s*([\w.]+)\s*,\s*uniformData\s*,\s*(\d+)\s*\)/g;
  for (let hit = packRe.exec(stripped); hit; hit = packRe.exec(stripped)) {
    const offset = Number(hit[2]);
    matrices.push({ expr: hit[1], offset });
    highest = Math.max(highest, offset + 15);
  }
  const scalarRe = /uniformData\[(\d+)\]\s*=\s*([^;]+);/g;
  for (let hit = scalarRe.exec(stripped); hit; hit = scalarRe.exec(stripped)) {
    const offset = Number(hit[1]);
    scalars.push({ expr: hit[2].trim(), offset });
    highest = Math.max(highest, offset);
  }
  return { matrices, scalars, highest };
}

/**
 * Offset of the single `Matrix4.pack` whose packed expression matches.
 *
 * @param {object} walk The packer walk.
 * @param {string} expr Packed expression text.
 * @returns {number} Its float offset.
 */
function matrixOffset(walk, expr) {
  const hits = walk.matrices.filter((entry) => entry.expr === expr);
  assert.equal(hits.length, 1, `expected one Matrix4.pack(${expr}, ...)`);
  return hits[0].offset;
}

/**
 * Offset of the single scalar write whose right-hand side matches.
 *
 * @param {object} walk The packer walk.
 * @param {string} expr Right-hand side text.
 * @returns {number} Its float offset.
 */
function scalarOffset(walk, expr) {
  const hits = walk.scalars.filter((entry) => entry.expr === expr);
  assert.equal(hits.length, 1, `expected one write of ${expr}`);
  return hits[0].offset;
}

// ── f32 arithmetic, mirroring what the vertex stage computes ────────────────

const fr = Math.fround;

/**
 * Column-major mat4 times vec4, rounded to f32 at every step.
 *
 * @param {number[]} m Sixteen column-major floats.
 * @param {number[]} v Four floats.
 * @returns {number[]} The transformed vector.
 */
function transform(m, v) {
  const out = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++) {
    let acc = 0;
    for (let col = 0; col < 4; col++) {
      acc = fr(acc + fr(m[col * 4 + row] * v[col]));
    }
    out[row] = acc;
  }
  return out;
}

/**
 * `(high - camHigh) + (low - camLow)`, the order every shader here uses.
 *
 * @param {number[]} high Position high split.
 * @param {number[]} low Position low split.
 * @param {number[]} camHigh Camera high split.
 * @param {number[]} camLow Camera low split.
 * @returns {number[]} The eye-relative position.
 */
function relativeToEye(high, low, camHigh, camLow) {
  return [0, 1, 2].map((i) =>
    fr(fr(high[i] - camHigh[i]) + fr(low[i] - camLow[i])),
  );
}

/**
 * The pre-fix form: an absolute f32 world position.
 *
 * @param {number[]} high Position high split.
 * @param {number[]} low Position low split.
 * @returns {number[]} The reconstructed world position.
 */
function summedWorld(high, low) {
  return [0, 1, 2].map((i) => fr(high[i] + low[i]));
}

const ndc = (clip) => [clip[0] / clip[3], clip[1] / clip[3]];

// ── Fixtures ────────────────────────────────────────────────────────────────

const CAMERA_WC = new Cartesian3(7378137.0, 1234567.0, -2345678.0);
const MOVED_CAMERA_WC = new Cartesian3(7378137.0, 1234967.0, -2345678.0);
const SAMPLE_WC = new Cartesian3(4517590.9, 837081.9, 4426389.5);
// A second sample a few hundred metres from the eye. The same fixed
// reconstruction error subtends a far larger angle up close, which is where a
// summed world position visibly smears a static primitive.
const NEAR_SAMPLE_WC = new Cartesian3(7378437.0, 1234767.0, -2345578.0);

// An orthonormal basis, row major. Only its shape matters here.
const BASE_ROTATION = [
  [0.36, 0.48, -0.8],
  [-0.8, 0.6, 0.0],
  [0.48, 0.64, 0.6],
];

/**
 * A plausible non-trivial view matrix for a given eye, optionally turned about
 * the view's own third axis so a fixture can separate "the camera moved" from
 * "the camera moved and turned".
 *
 * @param {Cartesian3} cameraPosition The eye in world coordinates.
 * @param {number} [spin] Rotation applied to the basis, in radians.
 * @returns {Matrix4} The view matrix.
 */
function makeView(cameraPosition, spin = 0.0) {
  const cos = Math.cos(spin);
  const sin = Math.sin(spin);
  const spinMatrix = [
    [cos, -sin, 0],
    [sin, cos, 0],
    [0, 0, 1],
  ];
  const rotation = [0, 1, 2].map((row) =>
    [0, 1, 2].map((col) =>
      [0, 1, 2].reduce(
        (acc, k) => acc + spinMatrix[row][k] * BASE_ROTATION[k][col],
        0,
      ),
    ),
  );
  const view = Matrix4.clone(Matrix4.IDENTITY, new Matrix4());
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      view[col * 4 + row] = rotation[row][col];
    }
  }
  // A view matrix satisfies t = -R * cameraPositionWC.
  const eye = [cameraPosition.x, cameraPosition.y, cameraPosition.z];
  for (let row = 0; row < 3; row++) {
    view[12 + row] = -(
      view[row] * eye[0] +
      view[4 + row] * eye[1] +
      view[8 + row] * eye[2]
    );
  }
  return view;
}

const PROJECTION = (() => {
  const projection = Matrix4.clone(Matrix4.IDENTITY, new Matrix4());
  const near = 1.0;
  const far = 1.0e8;
  projection[0] = 1.3;
  projection[5] = 1.73;
  projection[10] = far / (near - far);
  projection[11] = -1.0;
  projection[14] = (far * near) / (near - far);
  projection[15] = 0.0;
  return projection;
})();

/**
 * `projection x (view with its translation column zeroed)` — the same
 * composition `UniformState` records as the view-projection relative to eye.
 *
 * @param {Matrix4} view The view matrix.
 * @param {Matrix4} projection The projection matrix.
 * @returns {Matrix4} The relative-to-eye view projection.
 */
function viewProjectionRelativeToEye(view, projection) {
  const viewRte = Matrix4.clone(view, new Matrix4());
  viewRte[12] = 0.0;
  viewRte[13] = 0.0;
  viewRte[14] = 0.0;
  return Matrix4.multiply(projection, viewRte, new Matrix4());
}

/**
 * Stub context and frame state. By default the previous-frame pair holds the
 * RESET condition: previous equals current, exactly as `UniformState.update`
 * leaves it when temporal history is incompatible.
 *
 * @param {object} [options] Fixture overrides.
 * @returns {object} A frame state the packers accept.
 */
function makeFrameState(options = {}) {
  const cameraPositionWC = options.cameraPositionWC ?? CAMERA_WC;
  const view = makeView(cameraPositionWC);
  const viewProjection = Matrix4.multiply(PROJECTION, view, new Matrix4());
  const previousCameraPosition =
    options.previousCameraPosition ?? Cartesian3.clone(cameraPositionWC);
  const previousViewProjectionRelativeToEye =
    options.previousViewProjectionRelativeToEye ??
    viewProjectionRelativeToEye(
      makeView(previousCameraPosition, options.previousSpin ?? 0.0),
      PROJECTION,
    );
  const uniformState = {
    view,
    projection: PROJECTION,
    currentFrustum: { x: 1.0, y: 1.0e8 },
    oneOverLog2FarDepthFromNearPlusOne: 1.0 / Math.log2(1.0e8),
    pixelRatio: 1.0,
    gamma: 2.2,
    // Deliberately NOT the relative-to-eye matrix: it carries the view's
    // translation, so a packer that read this one into the new lanes would
    // produce different floats.
    previousViewProjection: options.previousViewProjection ?? viewProjection,
    previousViewProjectionRelativeToEye,
    previousCameraPosition,
  };
  return {
    context: {
      uniformState,
      canvas: { width: 1024, height: 768 },
      drawingBufferWidth: 1024,
    },
    camera: { positionWC: cameraPositionWC },
    mode: 3,
    pixelRatio: 1.0,
    splitPosition: 0.0,
    minimumDisableDepthTestDistance: 0.0,
    useHDR: false,
  };
}

// ── The four renderers ──────────────────────────────────────────────────────

const BILLBOARD_LANES = {
  currentMatrixExpr: "scratchMVPRTE",
  previousMatrixExpr: "scratchPrevMVPRTE",
  previousViewProjectionExpr: "prevVP",
  current: {
    matrix: "mvpRelativeToEye",
    high: "encodedCameraHigh",
    low: "encodedCameraLow",
    highExpr: "scratchEncodedCamera.high.x",
    lowExpr: "scratchEncodedCamera.low.x",
  },
  previous: {
    matrix: "previousMvpRelativeToEye",
    high: "previousEncodedCameraHigh",
    low: "previousEncodedCameraLow",
    highExpr: "scratchPrevEncodedCamera.high.x",
    lowExpr: "scratchPrevEncodedCamera.low.x",
  },
  prevAssignment: "prevCenterClip",
};

const RENDERERS = [
  {
    ...BILLBOARD_LANES,
    id: "billboard",
    shader: "Shaders/WebGPU/Collections/BillboardCollection.wgsl",
    renderer: "Renderer/WebGPU/WebGPUBillboardRenderer.js",
    packer: "packUniforms",
    sizeName: "UNIFORM_BUFFER_SIZE",
    extraArgs: [{}],
  },
  {
    ...BILLBOARD_LANES,
    id: "label",
    shader: "Shaders/WebGPU/Collections/BillboardCollectionSDF.wgsl",
    renderer: "Renderer/WebGPU/WebGPULabelRenderer.js",
    packer: "packUniforms",
    sizeName: "UNIFORM_BUFFER_SIZE",
    extraArgs: [{}],
  },
  {
    id: "point",
    shader: "Shaders/WebGPU/Collections/PointPrimitiveColor.wgsl",
    renderer: "Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js",
    packer: "packUniforms",
    sizeName: "UNIFORM_BUFFER_SIZE",
    currentMatrixExpr: "scratchMVPRTE",
    previousMatrixExpr: "scratchPrevMVPRTE",
    previousViewProjectionExpr: "prevVP",
    current: {
      matrix: "mvpRelativeToEye",
      high: "encodedCameraPositionMCHigh",
      low: "encodedCameraPositionMCLow",
      highExpr: "camHigh.x",
      lowExpr: "camLow.x",
    },
    previous: {
      matrix: "previousMvpRelativeToEye",
      high: "previousEncodedCameraPositionMCHigh",
      low: "previousEncodedCameraPositionMCLow",
      highExpr: "scratchPrevEncodedCamera.high.x",
      lowExpr: "scratchPrevEncodedCamera.low.x",
    },
    extraArgs: [],
    prevAssignment: "prevCenterClip",
  },
  {
    ...BILLBOARD_LANES,
    id: "polyline",
    shader: "Shaders/WebGPU/Collections/PolylineCollection.wgsl",
    renderer: "Renderer/WebGPU/WebGPUPolylineRenderer.js",
    packer: "packCameraUniforms",
    sizeName: "CAMERA_BUFFER_SIZE",
    extraArgs: [],
    prevAssignment: "prevClipStart",
  },
];

/**
 * Source text of a WGSL function declaration, braces balanced.
 *
 * @param {string} source WGSL text.
 * @param {string} name Function name.
 * @returns {string} The declaration's full source.
 */
function extractWgslFunction(source, name) {
  const start = source.indexOf(`fn ${name}(`);
  assert.ok(start >= 0, `fn ${name} not found`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`fn ${name} is not terminated`);
}

/**
 * Everything a test needs about one renderer, from given source text.
 *
 * @param {object} spec Renderer descriptor.
 * @param {string} shaderSource WGSL text.
 * @param {string} rendererSource Renderer source text.
 * @returns {object} Layout, walk and an executable packer.
 */
function analyze(spec, shaderSource, rendererSource) {
  const struct = layout(parseStruct(shaderSource, "CameraUniforms"));
  const packerSource = extractFunction(rendererSource, spec.packer);
  return {
    struct,
    walk: walkWrites(packerSource),
    declaredSize: sizeConstant(rendererSource, spec.sizeName),
    pack: loadPacker(rendererSource, spec.packer),
  };
}

/**
 * The floats a renderer's packer writes for one fixture.
 *
 * @param {object} spec Renderer descriptor.
 * @param {object} analysis Layout and packer.
 * @param {object} frameState Stub frame state.
 * @param {Matrix4} [modelMatrix] Collection model matrix.
 * @returns {Float32Array} The packed camera floats.
 */
function runPack(spec, analysis, frameState, modelMatrix) {
  const uniformData = new Float32Array(analysis.declaredSize / 4);
  analysis.pack(
    uniformData,
    frameState,
    modelMatrix ?? Matrix4.IDENTITY,
    ...spec.extraArgs,
  );
  return uniformData;
}

const slice16 = (data, offset) => Array.from(data.slice(offset, offset + 16));
const slice3 = (data, offset) => Array.from(data.slice(offset, offset + 3));

/**
 * The six f32 lanes `EncodedCartesian3` produces for a world position, in the
 * order a packer writes them. Built with the real encoder, so the expectation
 * is the engine's own split rather than a transcription of it.
 *
 * @param {Cartesian3} position A world position.
 * @returns {number[]} `[high.x, high.y, high.z, low.x, low.y, low.z]` as f32.
 */
function encodedSplit(position) {
  const encoded = EncodedCartesian3.fromCartesian(
    position,
    new EncodedCartesian3(),
  );
  return Array.from(
    Float32Array.from([
      encoded.high.x,
      encoded.high.y,
      encoded.high.z,
      encoded.low.x,
      encoded.low.y,
      encoded.low.z,
    ]),
  );
}

/**
 * Whether the shader builds its previous clip position relative to the
 * previous eye, or by summing the split into an absolute world position.
 *
 * @param {string} shaderSource WGSL text.
 * @param {object} spec Renderer descriptor.
 * @returns {{mode:string,matrix:string}} The classification.
 */
function classifyPreviousFrame(shaderSource, spec) {
  const velocity = extractWgslFunction(shaderSource, "vertexVelocityMain");
  const assignment = new RegExp(
    `let ${spec.prevAssignment}\\s*=\\s*\\n?\\s*camera\\.(\\w+)\\s*\\*`,
  ).exec(velocity);
  assert.ok(assignment, `no ${spec.prevAssignment} assignment found`);
  const matrix = assignment[1];
  // The point shader reaches its split through a dedicated helper, so the
  // helper body is part of the previous-frame expression.
  const helper = /translateRelativeToEyePrevious\(/.test(velocity)
    ? extractWgslFunction(shaderSource, "translateRelativeToEyePrevious")
    : "";
  const text = (velocity + helper).replace(/\/\/[^\n]*/g, "");
  const differencesSplit =
    text.includes(`camera.${spec.previous.high}`) &&
    text.includes(`camera.${spec.previous.low}`);
  const sumsSplit = /prev\w*(?:\.\w+)*\s*\+\s*(?:\w+\.)*prev\w*/i.test(text);
  if (matrix === spec.previous.matrix && differencesSplit) {
    return { mode: "relative-to-eye", matrix };
  }
  if (matrix === "previousViewProjection" && sumsSplit) {
    return { mode: "summed-world", matrix };
  }
  return { mode: "unclassified", matrix };
}

/**
 * The NDC velocity the shader's classified arithmetic emits for a primitive
 * that did not move, given the floats the packer produced.
 *
 * @param {object} spec Renderer descriptor.
 * @param {object} analysis Layout and packer.
 * @param {Float32Array} packed Packed camera floats.
 * @param {string} mode Classification from the shader text.
 * @param {Cartesian3} [sample] The primitive's world position.
 * @returns {number} The largest absolute NDC component of the velocity.
 */
function stillPrimitiveVelocity(spec, analysis, packed, mode, sample) {
  const { floats } = analysis.struct;
  const encoded = EncodedCartesian3.fromCartesian(
    sample ?? SAMPLE_WC,
    new EncodedCartesian3(),
  );
  const high = [encoded.high.x, encoded.high.y, encoded.high.z].map(fr);
  const low = [encoded.low.x, encoded.low.y, encoded.low.z].map(fr);

  const currentClip = transform(slice16(packed, floats[spec.current.matrix]), [
    ...relativeToEye(
      high,
      low,
      slice3(packed, floats[spec.current.high]),
      slice3(packed, floats[spec.current.low]),
    ),
    1,
  ]);

  let previousClip;
  if (mode === "relative-to-eye") {
    previousClip = transform(slice16(packed, floats[spec.previous.matrix]), [
      ...relativeToEye(
        high,
        low,
        slice3(packed, floats[spec.previous.high]),
        slice3(packed, floats[spec.previous.low]),
      ),
      1,
    ]);
  } else {
    previousClip = transform(slice16(packed, floats.previousViewProjection), [
      ...summedWorld(high, low),
      1,
    ]);
  }

  const current = ndc(currentClip);
  const previous = ndc(previousClip);
  return Math.max(
    Math.abs(current[0] - previous[0]),
    Math.abs(current[1] - previous[1]),
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("the current-frame model composition is bitwise stable under an identity model matrix", () => {
  // Every reset assertion below compares a previous matrix built as
  // `prevVpRte x zeroTranslation(modelMatrix)` against a current matrix built
  // as `projection x zeroTranslation(view x modelMatrix)`. They agree bitwise
  // only because multiplying by the identity is itself bitwise exact.
  const view = makeView(CAMERA_WC);
  const product = Matrix4.multiply(view, Matrix4.IDENTITY, new Matrix4());
  for (let i = 0; i < 16; i++) {
    assert.equal(product[i], view[i], `element ${i} moved`);
  }
});

for (const spec of RENDERERS) {
  const shaderSource = read(spec.shader);
  const rendererSource = read(spec.renderer);
  const analysis = analyze(spec, shaderSource, rendererSource);

  test(`${spec.id} — the WGSL struct and the packer's writes derive the same offsets`, () => {
    const { floats } = analysis.struct;
    const { walk } = analysis;

    assert.equal(
      analysis.struct.size,
      analysis.declaredSize,
      `${spec.sizeName} must equal the struct size`,
    );
    assert.equal(
      walk.highest + 1,
      analysis.declaredSize / 4,
      "the packer must fill the struct exactly to its last float",
    );

    assert.equal(
      matrixOffset(walk, spec.currentMatrixExpr),
      floats[spec.current.matrix],
    );
    assert.equal(
      matrixOffset(walk, spec.previousMatrixExpr),
      floats[spec.previous.matrix],
    );
    assert.equal(
      matrixOffset(walk, spec.previousViewProjectionExpr),
      floats.previousViewProjection,
    );
    assert.equal(
      scalarOffset(walk, spec.current.highExpr),
      floats[spec.current.high],
    );
    assert.equal(
      scalarOffset(walk, spec.current.lowExpr),
      floats[spec.current.low],
    );
    assert.equal(
      scalarOffset(walk, spec.previous.highExpr),
      floats[spec.previous.high],
    );
    assert.equal(
      scalarOffset(walk, spec.previous.lowExpr),
      floats[spec.previous.low],
    );

    // Every previous-frame member starts on a 16-byte boundary, so nothing
    // needed realignment when they were inserted.
    for (const name of [
      spec.previous.matrix,
      spec.previous.high,
      spec.previous.low,
      "previousViewProjection",
    ]) {
      assert.equal(
        analysis.struct.bytes[name] % 16,
        0,
        `${name} is not 16-byte aligned`,
      );
    }
  });

  test(`${spec.id} — a reset previous frame packs lanes identical to the current frame`, () => {
    const { floats } = analysis.struct;
    const packed = runPack(spec, analysis, makeFrameState());
    assert.deepEqual(
      slice16(packed, floats[spec.previous.matrix]),
      slice16(packed, floats[spec.current.matrix]),
      "previous matrix must equal the current one float for float",
    );
    assert.deepEqual(
      slice3(packed, floats[spec.previous.high]),
      slice3(packed, floats[spec.current.high]),
    );
    assert.deepEqual(
      slice3(packed, floats[spec.previous.low]),
      slice3(packed, floats[spec.current.low]),
    );
    // The pads stay zero so nothing bleeds into the vec3 lanes.
    assert.equal(packed[floats[spec.previous.high] + 3], 0);
    assert.equal(packed[floats[spec.previous.low] + 3], 0);
  });

  test(`${spec.id} — a camera that only travels separates the split and leaves the relative-to-eye matrix alone`, () => {
    const { floats } = analysis.struct;
    const packed = runPack(
      spec,
      analysis,
      makeFrameState({
        cameraPositionWC: MOVED_CAMERA_WC,
        previousCameraPosition: Cartesian3.clone(CAMERA_WC),
      }),
    );
    assert.notDeepEqual(
      slice3(packed, floats[spec.previous.high]).concat(
        slice3(packed, floats[spec.previous.low]),
      ),
      slice3(packed, floats[spec.current.high]).concat(
        slice3(packed, floats[spec.current.low]),
      ),
      "a travelling camera must move the previous split",
    );
    // Translation alone cannot change a matrix whose translation is zeroed,
    // which is exactly why the eye split has to carry the motion.
    assert.deepEqual(
      slice16(packed, floats[spec.previous.matrix]),
      slice16(packed, floats[spec.current.matrix]),
    );
  });

  test(`${spec.id} — a camera that also turns separates the previous matrix too`, () => {
    const { floats } = analysis.struct;
    const packed = runPack(
      spec,
      analysis,
      makeFrameState({
        cameraPositionWC: MOVED_CAMERA_WC,
        previousCameraPosition: Cartesian3.clone(CAMERA_WC),
        previousSpin: 0.02,
      }),
    );
    assert.notDeepEqual(
      slice16(packed, floats[spec.previous.matrix]),
      slice16(packed, floats[spec.current.matrix]),
    );
    assert.ok(
      stillPrimitiveVelocity(
        spec,
        analysis,
        packed,
        classifyPreviousFrame(shaderSource, spec).mode,
      ) > 1.0e-6,
      "a camera that moved and turned must produce real motion",
    );
  });

  test(`${spec.id} — the previous lanes hold UniformState's recorded pair, not a recomputation`, () => {
    const { floats } = analysis.struct;
    // The two cameras are SEPARATED for the whole test. With them equal — the
    // reset state the other tests key on — substituting the current camera for
    // the previous one in the packer is invisible here, and this test passed a
    // mutant that did exactly that. Separating them makes the substitution
    // change the packed split, so this test catches it too rather than relying
    // on its three neighbours.
    const separated = {
      cameraPositionWC: MOVED_CAMERA_WC,
      previousCameraPosition: Cartesian3.clone(CAMERA_WC),
    };
    const basePacked = runPack(spec, analysis, makeFrameState(separated));

    const perturbed = viewProjectionRelativeToEye(
      makeView(CAMERA_WC),
      PROJECTION,
    );
    perturbed[5] += 0.125;
    perturbed[9] -= 0.0625;
    const packed = runPack(
      spec,
      analysis,
      makeFrameState({
        ...separated,
        previousViewProjectionRelativeToEye: perturbed,
      }),
    );

    assert.notDeepEqual(
      slice16(packed, floats[spec.previous.matrix]),
      slice16(basePacked, floats[spec.previous.matrix]),
      "perturbing the recorded matrix must move the packed lanes",
    );
    assert.deepEqual(
      slice16(packed, floats[spec.previous.matrix]),
      Array.from(Float32Array.from(Array.from(perturbed))),
      "with an identity model matrix the lanes are the recorded matrix itself",
    );
    // The absolute previous view-projection is a different matrix in this
    // fixture, so a packer that read it instead would not match.
    assert.notDeepEqual(
      slice16(packed, floats[spec.previous.matrix]),
      slice16(packed, floats.previousViewProjection),
    );
    // The split must be the PREVIOUS camera's, not the current one's. This is
    // the half that a `previousCameraPosition` -> `cameraPosition` substitution
    // breaks, and the reason the fixture above separates the two.
    const previousSplit = encodedSplit(CAMERA_WC);
    assert.deepEqual(
      slice3(packed, floats[spec.previous.high]).concat(
        slice3(packed, floats[spec.previous.low]),
      ),
      previousSplit,
      "the previous split must encode UniformState's previous camera",
    );
    assert.notDeepEqual(
      slice3(packed, floats[spec.previous.high]).concat(
        slice3(packed, floats[spec.previous.low]),
      ),
      slice3(packed, floats[spec.current.high]).concat(
        slice3(packed, floats[spec.current.low]),
      ),
      "with the cameras separated the two splits cannot be equal",
    );
  });

  test(`${spec.id} — a still primitive emits exactly zero velocity on a reset previous frame`, () => {
    const classification = classifyPreviousFrame(shaderSource, spec);
    const packed = runPack(spec, analysis, makeFrameState());
    const velocity = stillPrimitiveVelocity(
      spec,
      analysis,
      packed,
      classification.mode,
    );
    assert.equal(
      velocity,
      0,
      `a still primitive emitted ${velocity} NDC of motion under ${classification.mode}`,
    );
    assert.equal(classification.mode, "relative-to-eye");
    assert.equal(classification.matrix, spec.previous.matrix);
  });

  test(`${spec.id} — summing the split into a world position is what moves a still primitive`, () => {
    const packed = runPack(spec, analysis, makeFrameState());
    const distant = stillPrimitiveVelocity(
      spec,
      analysis,
      packed,
      "summed-world",
    );
    assert.ok(
      distant > 1.0e-9,
      `the pre-fix arithmetic must move a still primitive, got ${distant}`,
    );
    // Close to the eye the same reconstruction error is a visible smear, not a
    // rounding artefact, so the control also states the magnitude that matters.
    const near = stillPrimitiveVelocity(
      spec,
      analysis,
      packed,
      "summed-world",
      NEAR_SAMPLE_WC,
    );
    assert.ok(
      near > 1.0e-4,
      `near the eye the pre-fix arithmetic must smear the primitive, got ${near}`,
    );
    // The shipped arithmetic is exact at both distances.
    assert.equal(
      stillPrimitiveVelocity(
        spec,
        analysis,
        packed,
        "relative-to-eye",
        NEAR_SAMPLE_WC,
      ),
      0,
    );
  });
}

// ── Mutants ─────────────────────────────────────────────────────────────────

const RTE_CALL = `  let prevPositionRTE = translateRelativeToEye(
    prevPosHigh, prevPosLow,
    camera.previousEncodedCameraHigh, camera.previousEncodedCameraLow);
  let prevCenterClip =
    camera.previousMvpRelativeToEye * vec4<f32>(prevPositionRTE, 1.0);`;
const SUMMED_CALL = `  let prevWorldPos = vec4<f32>(prevPosHigh + prevPosLow, 1.0);
  let prevCenterClip = camera.previousViewProjection * prevWorldPos;`;

const SHADER_MUTANTS = [
  { id: "billboard", steps: [{ find: RTE_CALL, replace: SUMMED_CALL }] },
  { id: "label", steps: [{ find: RTE_CALL, replace: SUMMED_CALL }] },
  {
    id: "point",
    steps: [
      {
        find: `  let prevEyeRelativePos = translateRelativeToEyePrevious(prevPosHigh, prevPosLow);
  let prevCenterClip = camera.previousMvpRelativeToEye * prevEyeRelativePos;`,
        replace: SUMMED_CALL,
      },
    ],
  },
  {
    id: "polyline",
    steps: [
      {
        find: `  let prevStartRTE = translateRelativeToEye(
    input.prevStartPosHighAndWidth.xyz, input.prevStartPosLow.xyz,
    camera.previousEncodedCameraHigh, camera.previousEncodedCameraLow,
  );`,
        replace: `  let prevStartWorld = vec4<f32>(
    input.prevStartPosHighAndWidth.xyz + input.prevStartPosLow.xyz,
    1.0,
  );`,
      },
      {
        find: `  let prevClipStart =
    camera.previousMvpRelativeToEye * vec4<f32>(prevStartRTE, 1.0);`,
        replace: `  let prevClipStart = camera.previousViewProjection * prevStartWorld;`,
      },
    ],
  },
];

for (const mutant of SHADER_MUTANTS) {
  const spec = RENDERERS.find((entry) => entry.id === mutant.id);
  test(`MUTANT ${mutant.id} — restoring the summed world position makes a still primitive move`, () => {
    const original = read(spec.shader);
    let mutated = original;
    for (const step of mutant.steps) {
      assert.equal(
        mutated.split(step.find).length - 1,
        1,
        "mutation anchor is not unique",
      );
      mutated = mutated.replace(step.find, step.replace);
    }
    assert.notEqual(mutated, original, "mutation did not apply");
    writeFileSync(
      join(mutantRoot, `${mutant.id}-summed-world.wgsl`),
      mutated,
      "utf8",
    );

    const analysis = analyze(spec, mutated, read(spec.renderer));
    const classification = classifyPreviousFrame(mutated, spec);
    assert.equal(classification.mode, "summed-world");
    const velocity = stillPrimitiveVelocity(
      spec,
      analysis,
      runPack(spec, analysis, makeFrameState()),
      classification.mode,
    );
    assert.ok(
      velocity > 1.0e-9,
      `the mutant must move a still primitive, got ${velocity}`,
    );
  });
}

test("MUTANT packer — writing the absolute previous view-projection into the new lanes breaks the reset identity", () => {
  const broken = [];
  for (const spec of RENDERERS) {
    const original = read(spec.renderer);
    const anchor =
      "const prevVPRTE = uniformState.previousViewProjectionRelativeToEye;";
    assert.equal(
      original.split(anchor).length - 1,
      1,
      `${spec.id}: packer anchor is not unique`,
    );
    const mutated = original.replace(
      anchor,
      "const prevVPRTE = uniformState.previousViewProjection;",
    );
    assert.notEqual(mutated, original, "mutation did not apply");
    writeFileSync(
      join(mutantRoot, `${spec.id}-absolute-previous-vp.js`),
      mutated,
      "utf8",
    );

    const analysis = analyze(spec, read(spec.shader), mutated);
    const { floats } = analysis.struct;
    const packed = runPack(spec, analysis, makeFrameState());
    if (
      slice16(packed, floats[spec.previous.matrix]).join() !==
      slice16(packed, floats[spec.current.matrix]).join()
    ) {
      broken.push(spec.id);
    }
    const velocity = stillPrimitiveVelocity(
      spec,
      analysis,
      packed,
      classifyPreviousFrame(read(spec.shader), spec).mode,
    );
    assert.ok(
      velocity > 1.0e-9,
      `${spec.id}: the packer mutant must move a still primitive, got ${velocity}`,
    );
  }
  assert.deepEqual(
    broken,
    RENDERERS.map((spec) => spec.id),
    "every renderer's reset identity must break under the packer mutant",
  );
});
