// wgsl-window-coordinates.spec.mjs — the WGSL window-coordinate helpers and the
// metres-per-pixel helper, EXECUTED out of their shipped source.
//
// @purpose Runs csm_eyeToWindowCoordinates, csm_modelToWindowCoordinates and csm_metersPerPixel through the WGSL evaluator and asserts their outputs against a CPU port of the GLSL twins, in WebGPU's NDC convention, for perspective, 2D orthographic and Columbus-View orthographic frustums.
// @status ACTIVE
//
// Pure Node, real modules, no browser, no GPU:
//   node --test Tools/visual-regression/wgsl-window-coordinates.spec.mjs
//   npm run test-visual-regression-node        # its registered runner home
//
// WHAT IS ASSERTED, AND WHY IT IS NOT A GREP
// ------------------------------------------
// Every number below comes out of the `.wgsl` files that ship, read by
// `lib/wgsl-mini-eval.mjs`. The oracle is a transcription of the GLSL twins,
// fed the SAME physical camera through the SAME engine frustum classes, so the
// comparison is between two computed pictures of one geometry rather than
// between a regex and a source line.
//
// The projection matrices come from `PerspectiveFrustum`,
// `OrthographicOffCenterFrustum` and `OrthographicFrustum` via
// `getProjectionMatrix(ClipSpaceConvention.WEBGPU)` — the same call
// `UniformState.updateFrustum` makes — so the WGSL sees the matrix the renderer
// actually packs into `CameraUniforms.projectionMatrix`, including the
// WebGPU 0-to-1 depth row.
//
// THE THREE WINDOW-COORDINATE DEFECTS
// -----------------------------------
// The GLSL twins read
//
//     vec4 q = czm_projection * positionEC;
//     q.xyz /= q.w;
//     q.xyz = (czm_viewportTransformation * vec4(q.xyz, 1.0)).xyz;
//     return q;                       // q.w is the CLIP w
//
// and `Matrix4.computeViewportTransformation` already maps NDC [-1,1] to
// pixels (`halfWidth * ndc.x + x + halfWidth`). The WGSL chunks fed that matrix
// `ndc.xy * 0.5 + 0.5`, kept the matrix's [-1,1]-to-[0,1] depth remap although
// WebGPU NDC z is already in [0,1], and returned the whole matrix product,
// whose w is 1.0 for every input. Three defects, one on each of x/y, z and w —
// so the assertion is componentwise equality with the oracle, and each
// mutation image below puts one of the three back and reads the number change.
//
// THE METRES-PER-PIXEL DEFECT
// ---------------------------
// `czm_metersPerPixel` has an orthographic arm — `czm_sceneMode2D ||
// czm_orthographicIn3D` — whose pixel size is the frustum extent over the
// viewport extent and does not depend on depth. The WGSL chunk had only the
// perspective arm, and it HAS a live consumer: `BufferPolylineMaterial.wgsl`
// imports it at `:14` and divides a metres width by it at `:112`. In 2D the
// perspective formula multiplies the answer by the eye-space depth, which for a
// 2D camera is the camera height, so a metres-wide polyline is drawn thousands
// of times too thin. `M3` is that number.
//
// The perspective arm is deliberately NOT changed: `M2` pins it to the exact
// expression that shipped, so the Edge leg's 3D capture is expected to be
// unchanged and a drift there is this spec's failure, not the capture's.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";
import {
  compileFunction,
  mat4,
  stripComments,
  vec4,
} from "./lib/wgsl-mini-eval.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const read = (relative) =>
  fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/gu, "\n");

const SHADERS = "packages/engine/Source/Shaders";

const eyeToWindowWgsl = read(
  `${SHADERS}/WebGPU/chunks/functions/csm_eyeToWindowCoordinates.wgsl`,
);
const modelToWindowWgsl = read(
  `${SHADERS}/WebGPU/chunks/functions/csm_modelToWindowCoordinates.wgsl`,
);
const metersPerPixelWgsl = read(
  `${SHADERS}/WebGPU/chunks/functions/csm_metersPerPixel.wgsl`,
);
const eyeToWindowGlsl = read(
  `${SHADERS}/Builtin/Functions/eyeToWindowCoordinates.glsl`,
);
const modelToWindowGlsl = read(
  `${SHADERS}/Builtin/Functions/modelToWindowCoordinates.glsl`,
);
const metersPerPixelGlsl = read(
  `${SHADERS}/Builtin/Functions/metersPerPixel.glsl`,
);
const polylineWgsl = read(
  `${SHADERS}/WebGPU/Collections/BufferPolylineMaterial.wgsl`,
);

enableEngineTsResolution();

const engineModule = async (relative) =>
  (
    await import(
      pathToFileURL(path.join(root, "packages/engine/Source", relative)).href
    )
  ).default;

const Matrix4 = await engineModule("Core/Matrix4.js");
const PerspectiveFrustum = await engineModule("Core/PerspectiveFrustum.js");
const OrthographicFrustum = await engineModule("Core/OrthographicFrustum.js");
const OrthographicOffCenterFrustum = await engineModule(
  "Core/OrthographicOffCenterFrustum.js",
);
const ClipSpaceConvention = await engineModule("Core/ClipSpaceConvention.js");

// ═══════════════════════════════════════════════════════════════════════
// The shipped WGSL, compiled. `compile` is also how every mutation image is
// built: the same reader over a one-substitution copy of the same text.
// ═══════════════════════════════════════════════════════════════════════

const compile = (source, name) =>
  compileFunction(stripComments(source), name, { __functions: {} });

/**
 * Apply one textual substitution and refuse if it did not bite. A mutation
 * image that silently matched nothing is a green test over unmutated source.
 *
 * @param {string} source The WGSL.
 * @param {string|RegExp} from What to replace.
 * @param {string} to The replacement.
 * @returns {string} The mutated WGSL.
 */
function mutate(source, from, to) {
  const out = source.replace(from, to);
  assert.notEqual(out, source, `the mutation ${String(from)} matched nothing`);
  return out;
}

const eyeToWindow = compile(eyeToWindowWgsl, "csm_eyeToWindowCoordinates");
const modelToWindow = compile(
  modelToWindowWgsl,
  "csm_modelToWindowCoordinates",
);
const metersPerPixel = compile(metersPerPixelWgsl, "csm_metersPerPixel");

// ═══════════════════════════════════════════════════════════════════════
// Fixtures: one viewport, one perspective camera, one 2D orthographic camera
// and one Columbus-View orthographic camera, built from the engine's own
// frustum classes so the matrices are the renderer's.
// ═══════════════════════════════════════════════════════════════════════

const VIEWPORT = Object.freeze({ x: 0, y: 0, width: 1024, height: 768 });
const PIXEL_RATIO = 2.0; // HiDPI on purpose: a ratio of 1 hides a ratio bug.

/** The viewport matrix both twins take, with the GLSL's 0-to-1 depth range. */
const viewportTransformationMatrix = Matrix4.computeViewportTransformation(
  VIEWPORT,
  0.0,
  1.0,
  new Matrix4(),
);

/** `Matrix4` is column-major already, so this is a straight handover. */
const toMat4 = (matrix) => mat4(Array.from(matrix));

const VIEWPORT_MATRIX = toMat4(viewportTransformationMatrix);

const perspective = new PerspectiveFrustum({
  fov: Math.PI / 3,
  aspectRatio: VIEWPORT.width / VIEWPORT.height,
  near: 1.0,
  far: 5.0e8,
});

/**
 * A 2D camera at 6 km: `Camera._adjustOrthographicFrustum` ties the frustum
 * extents to the eye height, so the height appears twice — once as the extent
 * that sets the true pixel size and once as the eye-space depth the perspective
 * formula wrongly multiplies in.
 */
const SCENE2D_EYE_HEIGHT = 6000.0;
const scene2D = new OrthographicOffCenterFrustum({
  left: (-SCENE2D_EYE_HEIGHT * VIEWPORT.width) / VIEWPORT.height / 2.0,
  right: (SCENE2D_EYE_HEIGHT * VIEWPORT.width) / VIEWPORT.height / 2.0,
  bottom: -SCENE2D_EYE_HEIGHT / 2.0,
  top: SCENE2D_EYE_HEIGHT / 2.0,
  near: 1.0,
  far: 5.0e8,
});

/** Columbus View with `camera.switchToOrthographicFrustum()` — the other arm. */
const COLUMBUS_EYE_HEIGHT = 9000.0;
const columbusOrthographic = new OrthographicFrustum({
  width: COLUMBUS_EYE_HEIGHT,
  aspectRatio: VIEWPORT.width / VIEWPORT.height,
  near: 1.0,
  far: 5.0e8,
});

/** The off-centre planes the GLSL reads as `czm_frustumPlanes`. */
const planesOf = (frustum) => {
  const off = frustum.offCenterFrustum ?? frustum;
  return {
    top: off.top,
    bottom: off.bottom,
    left: off.left,
    right: off.right,
    near: off.near,
  };
};

const projectionOf = (frustum, convention) =>
  toMat4(frustum.getProjectionMatrix(convention));

const CASES = Object.freeze({
  perspective: {
    label: "3D perspective",
    frustum: perspective,
    orthographic: false,
    eyeDepth: 4.0e5,
  },
  scene2D: {
    label: "2D orthographic",
    frustum: scene2D,
    orthographic: true,
    eyeDepth: SCENE2D_EYE_HEIGHT,
  },
  columbus: {
    label: "Columbus View orthographic",
    frustum: columbusOrthographic,
    orthographic: true,
    eyeDepth: COLUMBUS_EYE_HEIGHT,
  },
});

// ═══════════════════════════════════════════════════════════════════════
// ORACLE — the GLSL twins, transcribed, with a guard that the lines they
// transcribe are still there. A twin that moved must fail here rather than
// quietly certify a model of a shader that no longer exists.
// ═══════════════════════════════════════════════════════════════════════

const GLSL_WINDOW_BODY =
  /q\.xyz \/= q\.w;[\s\S]{0,200}?q\.xyz = \(czm_viewportTransformation \* vec4\(q\.xyz, 1\.0\)\)\.xyz;[\s\S]{0,200}?return q;/u;
const GLSL_METERS_ORTHO_ARM =
  /if \(czm_sceneMode == czm_sceneMode2D \|\| czm_orthographicIn3D == 1\.0\)/u;

/**
 * `czm_eyeToWindowCoordinates(positionEC)` against a WebGL-convention
 * projection, returning `[x, y, z, w]` with the clip `w` the twin preserves.
 *
 * @param {number[]} positionEC Eye-space position, `[x, y, z, w]`.
 * @param {object} frustum The engine frustum.
 * @returns {number[]} Window coordinates plus the clip w.
 */
function czmEyeToWindowCoordinates(positionEC, frustum) {
  const projection = frustum.getProjectionMatrix(ClipSpaceConvention.WEBGL);
  const clip = Matrix4.multiplyByVector(
    projection,
    { x: positionEC[0], y: positionEC[1], z: positionEC[2], w: positionEC[3] },
    {},
  );
  const ndc = [clip.x / clip.w, clip.y / clip.w, clip.z / clip.w];
  const window = Matrix4.multiplyByVector(
    viewportTransformationMatrix,
    { x: ndc[0], y: ndc[1], z: ndc[2], w: 1.0 },
    {},
  );
  return [window.x, window.y, window.z, clip.w];
}

/** `czm_metersPerPixel(positionEC, pixelRatio)`, both arms. */
function czmMetersPerPixel(positionEC, pixelRatio, frustum, orthographic) {
  const { top, bottom, left, right, near } = planesOf(frustum);
  const width = VIEWPORT.width;
  const height = VIEWPORT.height;
  let pixelWidth;
  let pixelHeight;
  if (orthographic) {
    pixelWidth = (right - left) / width;
    pixelHeight = (top - bottom) / height;
  } else {
    const distanceToPixel = -positionEC[2];
    const inverseNear = 1.0 / near;
    pixelHeight = (2.0 * distanceToPixel * (top * inverseNear)) / height;
    pixelWidth = (2.0 * distanceToPixel * (right * inverseNear)) / width;
  }
  return Math.max(pixelWidth, pixelHeight) * pixelRatio;
}

/** The perspective-only expression the chunk shipped with, for `M2`. */
const legacyPerspectiveMetersPerPixel = (positionEC, pixelRatio, projection) =>
  ((2.0 * -positionEC[2] * (1.0 / projection.__mat4[5])) / VIEWPORT.height) *
  pixelRatio;

// ═══════════════════════════════════════════════════════════════════════
// The eye-space probe points. Off-axis on purpose: an on-axis point cannot
// separate a halved x/y scale from a shifted origin, because both land on the
// viewport centre.
// ═══════════════════════════════════════════════════════════════════════

const EYE_POINTS = Object.freeze([
  [0.0, 0.0, -10.0, 1.0],
  [3.0, -2.0, -10.0, 1.0],
  [-7.5, 4.25, -125.0, 1.0],
  [120.0, -90.0, -4000.0, 1.0],
  [-0.5, 0.75, -1.5, 1.0],
]);

const relative = (actual, expected) =>
  Math.abs(actual - expected) / Math.max(1.0, Math.abs(expected));

const closeTo = (actual, expected, message, tolerance = 1.0e-9) =>
  assert.ok(
    relative(actual, expected) <= tolerance,
    `${message}: got ${actual}, expected ${expected} (relative ${relative(actual, expected)})`,
  );

// ═══════════════════════════════════════════════════════════════════════
// W. The window-coordinate helpers.
// ═══════════════════════════════════════════════════════════════════════

test("W0 — the GLSL twins still say what the oracle transcribes", () => {
  assert.match(
    eyeToWindowGlsl,
    GLSL_WINDOW_BODY,
    "eyeToWindowCoordinates.glsl no longer assigns .xyz and returns the clip w",
  );
  assert.match(
    modelToWindowGlsl,
    GLSL_WINDOW_BODY,
    "modelToWindowCoordinates.glsl no longer assigns .xyz and returns the clip w",
  );
  assert.match(
    metersPerPixelGlsl,
    GLSL_METERS_ORTHO_ARM,
    "metersPerPixel.glsl no longer carries the 2D / orthographic arm",
  );
});

test("W1 — csm_eyeToWindowCoordinates equals the GLSL twin on all four lanes", () => {
  const projection = projectionOf(perspective, ClipSpaceConvention.WEBGPU);
  for (const point of EYE_POINTS) {
    const expected = czmEyeToWindowCoordinates(point, perspective);
    const actual = eyeToWindow(
      vec4(point[0], point[1], point[2], point[3]),
      projection,
      VIEWPORT_MATRIX,
    );
    closeTo(actual.x, expected[0], `window x at ${point}`);
    closeTo(actual.y, expected[1], `window y at ${point}`);
    // The twin's z is produced by the matrix from WebGL NDC; the WGSL's is
    // WebGPU NDC passed through. They are the same window depth, which is the
    // whole content of "in WebGPU's NDC convention".
    closeTo(actual.z, expected[2], `window z at ${point}`);
    // A destroyed w reads 1.0 here for every point.
    closeTo(actual.w, expected[3], `clip w at ${point}`);
    assert.notEqual(actual.w, 1.0, "the clip w must not be the matrix's 1.0");
  }
});

test("W2 — csm_modelToWindowCoordinates agrees with the eye-space twin", () => {
  const projection = projectionOf(perspective, ClipSpaceConvention.WEBGPU);
  // A model matrix that is not the identity, so the modelView multiply is
  // exercised rather than optimised away by the fixture.
  const modelView = mat4([
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 2.5, -1.25,
    -30.0, 1.0,
  ]);
  for (const point of EYE_POINTS) {
    const moved = [point[0] + 2.5, point[1] - 1.25, point[2] - 30.0, 1.0];
    const expected = czmEyeToWindowCoordinates(moved, perspective);
    const actual = modelToWindow(
      vec4(point[0], point[1], point[2], point[3]),
      modelView,
      projection,
      VIEWPORT_MATRIX,
    );
    closeTo(actual.x, expected[0], `model window x at ${point}`);
    closeTo(actual.y, expected[1], `model window y at ${point}`);
    closeTo(actual.z, expected[2], `model window z at ${point}`);
    closeTo(actual.w, expected[3], `model clip w at ${point}`);
  }
});

test("W3 — MUTATION: the [0,1] pre-bias halves the scale and shifts the origin", () => {
  const image = compile(
    mutate(
      eyeToWindowWgsl,
      "viewportTransformation * vec4<f32>(ndc, 1.0)",
      "viewportTransformation * vec4<f32>(ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5, ndc.z, 1.0)",
    ),
    "csm_eyeToWindowCoordinates",
  );
  const projection = projectionOf(perspective, ClipSpaceConvention.WEBGPU);
  const halfWidth = VIEWPORT.width * 0.5;
  const halfHeight = VIEWPORT.height * 0.5;
  let sawDifference = false;
  for (const point of EYE_POINTS) {
    const expected = czmEyeToWindowCoordinates(point, perspective);
    const wrong = image(
      vec4(point[0], point[1], point[2], point[3]),
      projection,
      VIEWPORT_MATRIX,
    );
    const ndcX = (expected[0] - (VIEWPORT.x + halfWidth)) / halfWidth;
    const ndcY = (expected[1] - (VIEWPORT.y + halfHeight)) / halfHeight;
    // The defect in closed form: half the scale, and an origin off by
    // halfWidth / 2 — 1.5 halfWidths from the viewport's left edge.
    closeTo(
      wrong.x,
      0.5 * halfWidth * ndcX + VIEWPORT.x + 1.5 * halfWidth,
      `pre-biased x at ${point}`,
    );
    closeTo(
      wrong.y,
      0.5 * halfHeight * ndcY + VIEWPORT.y + 1.5 * halfHeight,
      `pre-biased y at ${point}`,
    );
    if (relative(wrong.x, expected[0]) > 1.0e-6) {
      sawDifference = true;
    }
  }
  assert.ok(
    sawDifference,
    "the pre-bias image must differ from the twin somewhere in the grid",
  );
});

test("W4 — MUTATION: returning the whole matrix product re-biases z and destroys w", () => {
  const image = compile(
    mutate(
      eyeToWindowWgsl,
      "return vec4<f32>(window.x, window.y, ndc.z, clip.w);",
      "return window;",
    ),
    "csm_eyeToWindowCoordinates",
  );
  const projection = projectionOf(perspective, ClipSpaceConvention.WEBGPU);
  for (const point of EYE_POINTS) {
    const expected = czmEyeToWindowCoordinates(point, perspective);
    const wrong = image(
      vec4(point[0], point[1], point[2], point[3]),
      projection,
      VIEWPORT_MATRIX,
    );
    // z gets the matrix's [-1,1] -> [0,1] remap applied to a value already in
    // [0,1]: 0.5 * z + 0.5.
    closeTo(wrong.z, 0.5 * expected[2] + 0.5, `re-biased z at ${point}`);
    assert.equal(wrong.w, 1.0, "the matrix product's w is 1.0 for every input");
    assert.notEqual(
      wrong.w,
      expected[3],
      "so it cannot be the clip w the twin returns",
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════
// M. csm_metersPerPixel.
// ═══════════════════════════════════════════════════════════════════════

test("M0 — the live consumer still reaches this chunk", () => {
  // Not a substitute for the behaviour below: it is what makes the behaviour
  // matter. A chunk nobody imports is latent; this one is not.
  assert.match(
    polylineWgsl,
    /^#import csm_metersPerPixel;$/mu,
    "BufferPolylineMaterial.wgsl must still import the chunk",
  );
  assert.match(
    polylineWgsl,
    /widthCss = widthCss \/ max\(\s*csm_metersPerPixel\(/u,
    "…and still divide a metres width by it",
  );
});

test("M1 — 3D perspective matches the GLSL twin across depths", () => {
  const projection = projectionOf(perspective, ClipSpaceConvention.WEBGPU);
  for (const depth of [1.5, 40.0, 400.0, 6000.0, 4.0e5]) {
    const point = [0.0, 0.0, -depth, 1.0];
    const expected = czmMetersPerPixel(point, PIXEL_RATIO, perspective, false);
    const actual = metersPerPixel(
      vec4(point[0], point[1], point[2], point[3]),
      PIXEL_RATIO,
      vec4(VIEWPORT.x, VIEWPORT.y, VIEWPORT.width, VIEWPORT.height),
      projection,
    );
    closeTo(
      actual,
      expected,
      `perspective metres/pixel at ${depth} m`,
      1.0e-12,
    );
  }
});

test("M2 — the perspective arm is the expression that shipped, unchanged", () => {
  // The Edge leg expects a byte-identical 3D capture. This is that claim in
  // arithmetic: exact equality, not a tolerance.
  const projection = projectionOf(perspective, ClipSpaceConvention.WEBGPU);
  for (const depth of [1.5, 400.0, 4.0e5]) {
    const point = [0.0, 0.0, -depth, 1.0];
    assert.equal(
      metersPerPixel(
        vec4(point[0], point[1], point[2], point[3]),
        PIXEL_RATIO,
        vec4(VIEWPORT.x, VIEWPORT.y, VIEWPORT.width, VIEWPORT.height),
        projection,
      ),
      legacyPerspectiveMetersPerPixel(point, PIXEL_RATIO, projection),
      `the perspective arm moved at ${depth} m`,
    );
  }
});

test("M3 — 2D and Columbus-View orthographic match the GLSL twin, and did not before", () => {
  for (const key of ["scene2D", "columbus"]) {
    const { label, frustum, eyeDepth } = CASES[key];
    const projection = projectionOf(frustum, ClipSpaceConvention.WEBGPU);
    const point = [0.0, 0.0, -eyeDepth, 1.0];
    const expected = czmMetersPerPixel(point, PIXEL_RATIO, frustum, true);
    const actual = metersPerPixel(
      vec4(point[0], point[1], point[2], point[3]),
      PIXEL_RATIO,
      vec4(VIEWPORT.x, VIEWPORT.y, VIEWPORT.width, VIEWPORT.height),
      projection,
    );
    closeTo(actual, expected, `${label} metres/pixel`, 1.0e-12);

    // What the perspective-only chunk returned for the same camera. The metres
    // width the polyline draws is `width / metresPerPixel`, so an answer this
    // many times too large is a stroke that many times too thin.
    const preFix = legacyPerspectiveMetersPerPixel(
      point,
      PIXEL_RATIO,
      projection,
    );
    assert.ok(
      preFix / expected > 1000.0,
      `${label}: the pre-fix answer must be orders of magnitude too large, ` +
        `got a factor of ${preFix / expected}`,
    );
  }
});

test("M4 — the arm is chosen by the projection, not by a depth heuristic", () => {
  const viewport = vec4(
    VIEWPORT.x,
    VIEWPORT.y,
    VIEWPORT.width,
    VIEWPORT.height,
  );
  const at = (frustum, depth) =>
    metersPerPixel(
      vec4(0.0, 0.0, -depth, 1.0),
      PIXEL_RATIO,
      viewport,
      projectionOf(frustum, ClipSpaceConvention.WEBGPU),
    );
  // Orthographic: the same pixel size at every depth, as the GLSL arm has no
  // depth term at all.
  assert.equal(
    at(scene2D, 10.0),
    at(scene2D, 1.0e6),
    "an orthographic pixel must not change size with depth",
  );
  assert.equal(
    at(columbusOrthographic, 10.0),
    at(columbusOrthographic, 1.0e6),
    "…in Columbus View too",
  );
  // Perspective: it must, or the discriminator has been inverted.
  closeTo(
    at(perspective, 1.0e6) / at(perspective, 10.0),
    1.0e5,
    "a perspective pixel must grow linearly with depth",
    1.0e-9,
  );
});

test("M5 — MUTATION: dropping the orthographic arm is RED in 2D and CV only", () => {
  const image = compile(
    mutate(
      metersPerPixelWgsl,
      "projection[3][3] > 0.5",
      "projection[3][3] > 1.5",
    ),
    "csm_metersPerPixel",
  );
  const viewport = vec4(
    VIEWPORT.x,
    VIEWPORT.y,
    VIEWPORT.width,
    VIEWPORT.height,
  );
  for (const key of ["scene2D", "columbus"]) {
    const { label, frustum, eyeDepth } = CASES[key];
    const projection = projectionOf(frustum, ClipSpaceConvention.WEBGPU);
    const point = [0.0, 0.0, -eyeDepth, 1.0];
    const expected = czmMetersPerPixel(point, PIXEL_RATIO, frustum, true);
    const wrong = image(
      vec4(point[0], point[1], point[2], point[3]),
      PIXEL_RATIO,
      viewport,
      projection,
    );
    assert.ok(
      relative(wrong, expected) > 1000.0,
      `${label}: the unreachable arm must put the answer back off by orders ` +
        `of magnitude, got ${wrong} against ${expected}`,
    );
  }
  // …and the 3D leg is untouched by the same image, which is what makes the
  // mutant specific to the arm rather than to the function.
  const projection = projectionOf(perspective, ClipSpaceConvention.WEBGPU);
  const point = [0.0, 0.0, -400.0, 1.0];
  assert.equal(
    image(
      vec4(point[0], point[1], point[2], point[3]),
      PIXEL_RATIO,
      viewport,
      projection,
    ),
    metersPerPixel(
      vec4(point[0], point[1], point[2], point[3]),
      PIXEL_RATIO,
      viewport,
      projection,
    ),
    "the perspective answer must not move when the orthographic arm goes away",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// N. The text still compiles — offline, through the same naga build
// `vector-layer-draping.spec.mjs` uses. The evaluator reads a subset and can
// be satisfied by WGSL a driver would reject; these two close that gap for the
// chunk that has a live consumer, without a browser.
// ═══════════════════════════════════════════════════════════════════════

const NAGA_DIRECTORY = path.join(root, "Tools/shader-pipeline/naga-wasm-tools");

/**
 * `//>>ifdef` expansion for a given define set — the `//>>else` branch is the
 * historical path, matching `WebGPUShaderPreprocessor`'s zero-mask contract.
 *
 * @param {string} source The WGSL.
 * @param {string[]} defines Active flag names.
 * @returns {string} The expanded WGSL.
 */
function expandDefines(source, defines) {
  const active = new Set(defines);
  const out = [];
  const stack = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//>>ifdef")) {
      stack.push({ emitting: active.has(trimmed.split(/\s+/u)[1]) });
      continue;
    }
    if (trimmed.startsWith("//>>else")) {
      const top = stack[stack.length - 1];
      top.emitting = !top.emitting;
      continue;
    }
    if (trimmed.startsWith("//>>endif")) {
      stack.pop();
      continue;
    }
    if (stack.every((frame) => frame.emitting)) {
      out.push(line);
    }
  }
  return out.join("\n");
}

const loadNaga = async () => {
  const naga = await import(
    pathToFileURL(path.join(NAGA_DIRECTORY, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(NAGA_DIRECTORY, "naga_wasm_tools_bg.wasm"),
    ),
  });
  return naga;
};

test("N1 — the three chunks are valid WGSL modules on their own", async () => {
  const naga = await loadNaga();
  for (const [name, source] of [
    ["csm_eyeToWindowCoordinates", eyeToWindowWgsl],
    ["csm_modelToWindowCoordinates", modelToWindowWgsl],
    ["csm_metersPerPixel", metersPerPixelWgsl],
  ]) {
    assert.doesNotThrow(() => naga.validate_wgsl(source), `${name} is invalid`);
  }
});

test("N2 — the live consumer still assembles and validates with the chunk inlined", async () => {
  const naga = await loadNaga();
  const table = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUBufferPrimitiveRenderer.ts",
  );
  const chunkSource = (name) => {
    for (const directory of ["chunks/structs", "chunks/functions"]) {
      const candidate = path.join(
        root,
        SHADERS,
        "WebGPU",
        directory,
        `${name}.wgsl`,
      );
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, "utf8").replace(/\r\n/gu, "\n");
      }
    }
    throw new Error(`no chunk file for ${name}`);
  };
  const imports = [...polylineWgsl.matchAll(/^#import (\w+);$/gmu)].map(
    (match) => match[1],
  );
  assert.ok(imports.length > 0, "the shader declares no imports at all");
  for (const name of imports) {
    // An import the renderer's table cannot resolve is STRIPPED at preprocess
    // time behind a debug-only warning, so the shader compiles and the branch
    // silently disappears. That is the failure this line catches.
    assert.match(
      table,
      new RegExp(String.raw`^\s*${name}:\s*\w+,$`, "mu"),
      `${name} is imported but absent from BUFFER_WGSL_CHUNKS`,
    );
  }
  const assembled = polylineWgsl.replace(/^#import (\w+);$/gmu, (whole, name) =>
    chunkSource(name),
  );
  assert.equal(
    (assembled.match(/#import/gu) ?? []).length,
    0,
    "an import survived assembly",
  );
  for (const defines of [[], ["LOG_DEPTH"]]) {
    assert.doesNotThrow(
      () => naga.validate_wgsl(expandDefines(assembled, defines)),
      `the assembled shader is invalid with defines [${defines}]`,
    );
  }
});
