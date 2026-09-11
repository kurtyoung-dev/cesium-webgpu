// buffer-polyline-meters-width.spec.mjs — census C-04 / `-07` item 18 acceptance.
//
// @purpose Acceptance for BufferPolylineCollection widthUnits:"meters" on WebGPU: the packer's sign and the WGSL branch pinned as ONE convention against the GLSL oracle.
// @status ACTIVE
//
// Pure Node, real modules, no browser, no GPU:
//   node --test Tools/visual-regression/buffer-polyline-meters-width.spec.mjs
//   npm run test-engine-node        # its registered runner home
//
// WHAT THE ROW ASKED
// ------------------
// CesiumJS 1.145 gave `BufferPolylineCollection` a `widthUnits` option
// ("pixels" | "meters"). On WebGL a metres width is drawn at a constant GROUND
// width: `renderBufferPolylineCollection.js` packs the width NEGATED when the
// collection is in metres, and `BufferPolylineMaterialVS.glsl` reads that sign —
//
//     float width = abs(signedWidth);
//     if (signedWidth < 0.0)
//         width /= max(czm_metersPerPixel(positionEC), czm_epsilon7);
//
// so the drawn width shrinks as the camera pulls away. On WebGPU neither half
// existed: `WebGPUBufferPolylineRenderer` wrote the width UNSIGNED and
// `BufferPolylineMaterial.wgsl` had no sign test, so a 50 m road was drawn
// 50 px wide at every altitude.
//
// WHY THE TWO HALVES ARE ONE CONVENTION (and why this file pins them together)
// ---------------------------------------------------------------------------
// The sign is not metadata riding alongside the width — it IS the width's high
// bit. Sign the attribute without adding the shader branch and the vertex
// shader extrudes by a NEGATIVE half-width, which flips the miter offset at
// every vertex: the ribbon turns inside out rather than merely rendering at the
// wrong scale. Add the branch without signing the attribute and nothing happens
// at all. So every behavioural test below runs against BOTH halves and each
// half is separately mutated away (M1, M2), with M3 making the shader branch
// INERT rather than absent.
//
// WHAT IS REAL HERE AND WHAT IS MODELLED — stated up front
// --------------------------------------------------------
//   REAL   `BufferPolylineCollection` is constructed for both unit kinds and
//          its `widthUnits` read back (R1), including the DeveloperError a
//          third value raises. Both backends read that ONE field.
//   REAL   the WebGPU packer's sign expression is EXTRACTED from
//          `WebGPUBufferPolylineRenderer.ts` and EVALUATED (R2). This spec
//          therefore asserts the sign the shipped code computes, not that some
//          string is present: an inverted ternary evaluates to the wrong sign
//          and fails, which an `assert.match` on the source could not catch.
//   REAL   the frustum. `PerspectiveFrustum` supplies `projectionMatrix[1][1]`
//          to the WGSL model and `offCenterFrustum.top/right/near` to the GLSL
//          model, so the two backends' metres→pixels conversions are compared
//          through the SAME real projection rather than a hand-written one.
//   MODEL  the two vertex shaders' width arithmetic. A CPU spec cannot run
//          WGSL, so each shader is transcribed — and, exactly as the sibling
//          `vector-layer-draping.spec.mjs` does, every switch the transcription
//          depends on is DERIVED FROM THE SHADER SOURCE (WGSL_HAS_METERS_ARM,
//          WGSL_CHUNK_USES_EYE_DEPTH, …). A shader edit changes the model and
//          the behavioural comparison fails on the shader, not on a string.
//
// THE ACCEPTANCE (census C-04)
// ----------------------------
// "One metres and one pixels collection at two camera distances one octave
//  apart; the metres stroke halves on both backends, the pixels stroke does
//  not." B1/B2 are that, computed in device pixels.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const read = (relative) =>
  fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/gu, "\n");

const polylineWgsl = read(
  "packages/engine/Source/Shaders/WebGPU/Collections/BufferPolylineMaterial.wgsl",
);
const metersPerPixelWgsl = read(
  "packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_metersPerPixel.wgsl",
);
const polylineRendererTs = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUBufferPolylineRenderer.ts",
);
const primitiveRendererTs = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUBufferPrimitiveRenderer.ts",
);
const polylineVsGlsl = read(
  "packages/engine/Source/Shaders/BufferPolylineMaterialVS.glsl",
);
const polylineCommonGlsl = read(
  "packages/engine/Source/Shaders/PolylineCommon.glsl",
);
const metersPerPixelGlsl = read(
  "packages/engine/Source/Shaders/Builtin/Functions/metersPerPixel.glsl",
);
const webglRendererJs = read(
  "packages/engine/Source/Scene/renderBufferPolylineCollection.js",
);

enableEngineTsResolution();

const engineModule = async (relative) =>
  (
    await import(
      pathToFileURL(path.join(root, "packages/engine/Source", relative)).href
    )
  ).default;

const BufferPolylineCollection = await engineModule(
  "Scene/BufferPolylineCollection.js",
);
const BoundingSphere = await engineModule("Core/BoundingSphere.js");
const Cartesian3 = await engineModule("Core/Cartesian3.js");
const PerspectiveFrustum = await engineModule("Core/PerspectiveFrustum.js");

// ═══════════════════════════════════════════════════════════════════════
// Switches DERIVED from the real sources. Every one of them feeds a MODEL
// whose output is then compared across backends, so removing the thing a
// switch describes fails as behaviour rather than as a missing string —
// which is what makes the inertness mutant (M3) detectable at all.
// ═══════════════════════════════════════════════════════════════════════

/** The WGSL's metres arm: the sign test AND the conversion inside it. */
const WGSL_METERS_ARM =
  /if \(signedWidth < 0\.0\) \{[\s\S]{0,800}?csm_metersPerPixel\(/u;
const WGSL_HAS_METERS_ARM = WGSL_METERS_ARM.test(polylineWgsl);

/**
 * The arm's DIVISOR must be the chunk call itself. `WGSL_METERS_ARM` allows
 * 800 characters between the sign test and the call, so an arm whose
 * conversion has been neutralised — `1.0 * max(0.0, 1.0) + 0.0 *
 * csm_metersPerPixel(...)` — still satisfies it while dividing by 1.0. Anchor
 * on the whole division statement instead.
 */
const WGSL_ARM_DIVIDES_BY_CHUNK =
  /widthCss = widthCss \/ max\(\s*csm_metersPerPixel\(/u.test(polylineWgsl);

/**
 * ...and it must pass `params.pixelRatio`, not `1.0`. The chunk returns metres
 * per CSS pixel only when the ratio is applied, and the shader's closing
 * `* params.pixelRatio` depends on that cancellation; passing 1.0 draws a
 * metres line `pixelRatio` times too wide, which a model that supplies the
 * ratio itself can never see.
 */
const WGSL_ARM_PASSES_PIXEL_RATIO =
  /csm_metersPerPixel\(vec4<f32>\(posEC, 1\.0\), params\.pixelRatio,/u.test(
    polylineWgsl,
  );

/** The magnitude recovery — `abs`, never the raw signed value. */
const WGSL_TAKES_MAGNITUDE = /=\s*abs\(signedWidth\);/u.test(polylineWgsl);

/** The CSS-to-device scale that stands in for GLSL's `czm_pixelRatio` offset. */
const WGSL_SCALES_TO_DEVICE_PIXELS =
  /let width = \w+ \* params\.pixelRatio;/u.test(polylineWgsl);

/** The shader must actually pull the chunk in, and the chunk must be mapped. */
const WGSL_IMPORTS_CHUNK = /^#import csm_metersPerPixel;$/mu.test(polylineWgsl);
const CHUNK_IS_REGISTERED =
  /csm_metersPerPixel:\s*csm_metersPerPixelChunk,/u.test(primitiveRendererTs);

/**
 * `czm_metersPerPixel` measures eye-space DEPTH, not radial distance.
 *
 * Anchored on the ASSIGNMENT, not on the token: the chunk's own docstring
 * quotes `-positionEC.z` while explaining the difference, so a bare token match
 * survives a body that went back to `length(positionEC.xyz)` — which is exactly
 * how this switch first failed its own mutant.
 */
const WGSL_CHUNK_USES_EYE_DEPTH = /let \w+ = -positionEC\.z;/u.test(
  metersPerPixelWgsl,
);
/** ...and applies the pixel ratio unconditionally, as the GLSL does. */
const WGSL_CHUNK_APPLIES_PIXEL_RATIO = /return \w+ \* pixelRatio;/u.test(
  metersPerPixelWgsl,
);

/**
 * The chunk's ARITHMETIC, not only its inputs. `WGSL_CHUNK_USES_EYE_DEPTH`
 * proves the depth is read; it does not prove what is done with it. A
 * `pixelHeight` that divides by the depth instead of multiplying inverts the
 * altitude law — the stroke would GROW with distance — while leaving that
 * assignment untouched.
 */
const WGSL_CHUNK_TAN_THETA =
  /let tanTheta = 1\.0 \/ projection\[1\]\[1\];/u.test(metersPerPixelWgsl);
const WGSL_CHUNK_PIXEL_HEIGHT =
  /let pixelHeight = 2\.0 \* distanceToPixel \* tanTheta \/ viewport\.w;/u.test(
    metersPerPixelWgsl,
  );

/**
 * The WebGPU packer's sign expression, EXTRACTED AND EVALUATED.
 *
 * `assert.match` on this source would pass for an inverted ternary. Reading the
 * expression out and running it does not: `evaluate(true, 8)` has to come back
 * negative because the shipped arithmetic says so — the two branches' SIGNS
 * come from the shipped text, not from this file.
 *
 * Structurally parsed rather than `eval`ed. `new Function` would be the short
 * way and this repository's lint bans it outright; parsing also means an
 * expression shape this spec has never read is REFUSED (`null`) instead of
 * silently executed, which is the safer failure for a spec that reads shipping
 * source.
 */
function extractSignExpression() {
  const match = polylineRendererTs.match(
    /const signedWidth =\s*([\s\S]*?);\n/u,
  );
  if (!match) {
    return null;
  }
  const expression = match[1]
    .replace(/scratchPolylineMat\.width/gu, "width")
    .replace(/\s+/gu, " ")
    .trim();
  // `<flag> ? <±width> : <±width>` and nothing else.
  const ternary = expression.match(
    /^([A-Za-z_]\w*)\s*\?\s*(-?)\s*([A-Za-z_]\w*)\s*:\s*(-?)\s*([A-Za-z_]\w*)$/u,
  );
  if (!ternary) {
    return null;
  }
  const [, flag, trueSign, trueName, falseSign, falseName] = ternary;
  if (
    flag !== "widthInMeters" ||
    trueName !== "width" ||
    falseName !== "width"
  ) {
    return null;
  }
  const signOf = (token) => (token === "-" ? -1 : 1);
  return {
    expression,
    evaluate: (widthInMeters, width) =>
      (widthInMeters ? signOf(trueSign) : signOf(falseSign)) * width,
  };
}

const CPU_SIGN = extractSignExpression();
const CPU_SIGNS_METERS =
  CPU_SIGN !== null &&
  CPU_SIGN.evaluate(true, 8) === -8 &&
  CPU_SIGN.evaluate(false, 8) === 8;

/** The same convention on the WebGL side, for the oracle. */
const WEBGL_SIGN =
  /const signedWidth = widthInMeters \? -material\.width : material\.width;/u.test(
    webglRendererJs,
  );

// ═══════════════════════════════════════════════════════════════════════
// The frame. One REAL frustum drives both models.
// ═══════════════════════════════════════════════════════════════════════

const VIEWPORT = { width: 1600, height: 900 };
const PIXEL_RATIO = 2.0; // HiDPI on purpose: a ratio of 1 hides a ratio bug.
const FRUSTUM = new PerspectiveFrustum({
  fov: Math.PI / 3,
  aspectRatio: VIEWPORT.width / VIEWPORT.height,
  near: 1.0,
  far: 5.0e8,
});
const PROJECTION_1_1 = FRUSTUM.projectionMatrix[5];
const OFF_CENTER = FRUSTUM.offCenterFrustum;

/** `czm_epsilon7`, the floor both shaders divide by. */
const EPSILON7 = 1.0e-7;

// ═══════════════════════════════════════════════════════════════════════
// ORACLE — BufferPolylineMaterialVS.glsl + metersPerPixel.glsl +
// PolylineCommon.glsl, transcribed from the GLSL only.
// ═══════════════════════════════════════════════════════════════════════

/** `czm_metersPerPixel(positionEC, pixelRatio)` — the perspective arm. */
function czmMetersPerPixel(positionEC, pixelRatio) {
  const distanceToPixel = -positionEC[2];
  const inverseNear = 1.0 / OFF_CENTER.near;
  const pixelHeight =
    (2.0 * distanceToPixel * (OFF_CENTER.top * inverseNear)) / VIEWPORT.height;
  const pixelWidth =
    (2.0 * distanceToPixel * (OFF_CENTER.right * inverseNear)) / VIEWPORT.width;
  return Math.max(pixelWidth, pixelHeight) * pixelRatio;
}

/**
 * Half the extrusion the WebGL polyline applies, in FRAMEBUFFER pixels.
 *
 * `BufferPolylineMaterialVS.glsl:48-52` produces a width in CSS pixels;
 * `PolylineCommon.glsl:166` multiplies the half-width by `czm_pixelRatio` when
 * it offsets in window coordinates. A straight segment has a unit miter, so the
 * offset IS the half-width.
 */
function glslHalfWidthDevicePixels(signedWidth, positionEC) {
  let width = Math.abs(signedWidth);
  if (signedWidth < 0.0) {
    width /= Math.max(czmMetersPerPixel(positionEC, PIXEL_RATIO), EPSILON7);
  }
  return width * 0.5 * PIXEL_RATIO;
}

// ═══════════════════════════════════════════════════════════════════════
// SUBJECT — BufferPolylineMaterial.wgsl + csm_metersPerPixel.wgsl.
// `mutate` re-introduces one concrete defect at a time.
// ═══════════════════════════════════════════════════════════════════════

function csmMetersPerPixel(positionEC, pixelRatio) {
  const distanceToPixel = WGSL_CHUNK_USES_EYE_DEPTH
    ? -positionEC[2]
    : Math.hypot(positionEC[0], positionEC[1], positionEC[2]);
  // Derived, not transcribed: a chunk whose arithmetic moved must not keep
  // this model's arithmetic. NaN propagates into every comparison below.
  const tanTheta = WGSL_CHUNK_TAN_THETA ? 1.0 / PROJECTION_1_1 : Number.NaN;
  const pixelHeight = WGSL_CHUNK_PIXEL_HEIGHT
    ? (2.0 * distanceToPixel * tanTheta) / VIEWPORT.height
    : Number.NaN;
  return WGSL_CHUNK_APPLIES_PIXEL_RATIO
    ? pixelHeight * pixelRatio
    : Math.max(pixelHeight, pixelHeight * pixelRatio);
}

/**
 * Half the extrusion the WebGPU polyline applies, in FRAMEBUFFER pixels.
 * This shader extrudes directly in device pixels (`params.viewport.zw` is the
 * drawing buffer), so `miterLen = width * 0.5` on a straight segment.
 */
function wgslHalfWidthDevicePixels(signedWidth, positionEC, mutate = {}) {
  const hasArm =
    WGSL_HAS_METERS_ARM && WGSL_ARM_DIVIDES_BY_CHUNK && !mutate.dropShaderArm;
  // Without the magnitude recovery the raw signed value flows through, which is
  // the pre-fix shader exactly.
  let widthCss =
    WGSL_TAKES_MAGNITUDE && hasArm ? Math.abs(signedWidth) : signedWidth;
  if (hasArm && signedWidth < 0.0) {
    // The ratio the SHADER passes, not the one this file would like it to.
    const armRatio = WGSL_ARM_PASSES_PIXEL_RATIO ? PIXEL_RATIO : 1.0;
    widthCss /= Math.max(csmMetersPerPixel(positionEC, armRatio), EPSILON7);
  }
  const deviceWidth = WGSL_SCALES_TO_DEVICE_PIXELS
    ? widthCss * PIXEL_RATIO
    : widthCss;
  return deviceWidth * 0.5;
}

/** What each backend's CPU half hands its shader for one authored width. */
function packedWidth(authored, widthInMeters, mutate = {}) {
  if (mutate.dropCpuSign) {
    return authored;
  }
  return CPU_SIGNS_METERS && widthInMeters ? -authored : authored;
}

// ═══════════════════════════════════════════════════════════════════════
// The two camera distances, ONE OCTAVE APART, on the view axis.
// 400 m and 800 m: at 900 device-pixel height and a 60-degree vertical fov an
// 8 m road is a stroke a probe can actually measure at the near distance, and
// it must halve at the far one.
// ═══════════════════════════════════════════════════════════════════════

const NEAR_DISTANCE = 400.0;
const FAR_DISTANCE = 800.0;
const NEAR_EC = [0.0, 0.0, -NEAR_DISTANCE, 1.0];
const FAR_EC = [0.0, 0.0, -FAR_DISTANCE, 1.0];
const AUTHORED_METRES = 8.0;
const AUTHORED_PIXELS = 8.0;

// ═══════════════════════════════════════════════════════════════════════
// R. What is REAL
// ═══════════════════════════════════════════════════════════════════════

test("R1 — one collection field feeds both backends, and it only takes two values", () => {
  const positions = [
    Cartesian3.fromDegrees(-105.0, 39.0),
    Cartesian3.fromDegrees(-105.0, 40.0),
  ];
  const make = (options) =>
    new BufferPolylineCollection({
      primitiveCountMax: 2,
      vertexCountMax: 4,
      boundingVolume: BoundingSphere.fromPoints(positions),
      ...options,
    });

  assert.equal(make({}).widthUnits, "pixels", "the default must stay pixels");
  assert.equal(make({ widthUnits: "pixels" }).widthUnits, "pixels");
  assert.equal(make({ widthUnits: "meters" }).widthUnits, "meters");
  assert.throws(
    () => make({ widthUnits: "feet" }),
    "a third unit must be rejected rather than silently treated as pixels",
  );

  // No setter: both packers may read it once per update rather than watch it.
  const descriptor = Object.getOwnPropertyDescriptor(
    BufferPolylineCollection.prototype,
    "widthUnits",
  );
  assert.ok(descriptor?.get, "widthUnits must be a getter");
  assert.equal(descriptor.set, undefined, "widthUnits must have no setter");
});

test("R2 — the WebGPU packer's own sign expression evaluates to the convention", () => {
  assert.ok(
    CPU_SIGN !== null,
    "WebGPUBufferPolylineRenderer.ts declares no readable `const signedWidth = ...`",
  );
  // The expression is RUN, not matched: an inverted ternary fails here.
  assert.equal(
    CPU_SIGN.evaluate(true, 8),
    -8,
    `a metres width must pack NEGATIVE (expression: ${CPU_SIGN.expression})`,
  );
  assert.equal(
    CPU_SIGN.evaluate(false, 8),
    8,
    `a pixels width must pack POSITIVE (expression: ${CPU_SIGN.expression})`,
  );
  assert.ok(
    /collection\.widthUnits === "meters"/u.test(polylineRendererTs),
    "the sign must be derived from the collection's own widthUnits field",
  );
  assert.ok(
    WEBGL_SIGN,
    "renderBufferPolylineCollection.js no longer packs the same signed width — " +
      "the oracle this spec is written against has moved",
  );
});

test("R3 — the shader can actually reach the builtin it branches on", () => {
  assert.ok(
    WGSL_ARM_DIVIDES_BY_CHUNK,
    "the metres arm must DIVIDE by csm_metersPerPixel; a call that is merely " +
      "present inside the arm satisfies WGSL_METERS_ARM without converting",
  );
  assert.ok(
    WGSL_ARM_PASSES_PIXEL_RATIO,
    "the arm must pass params.pixelRatio into csm_metersPerPixel — 1.0 returns " +
      "metres per DEVICE pixel and the closing * params.pixelRatio then " +
      "double-counts the ratio",
  );
  assert.ok(
    WGSL_CHUNK_TAN_THETA && WGSL_CHUNK_PIXEL_HEIGHT,
    "csm_metersPerPixel's arithmetic has moved; this spec models the old one",
  );
  assert.ok(
    WGSL_IMPORTS_CHUNK,
    "BufferPolylineMaterial.wgsl must `#import csm_metersPerPixel;`",
  );
  assert.ok(
    CHUNK_IS_REGISTERED,
    "an unresolved bare #import is STRIPPED by resolveBufferImports (with only " +
      "a debug-stripped warning), so the chunk must be in BUFFER_WGSL_CHUNKS",
  );
  assert.ok(
    /widthUnits\?: "pixels" \| "meters";/u.test(primitiveRendererTs),
    "the collection shape the renderer reads must declare widthUnits",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// A. The builtin agrees with the GLSL builtin it is named after
// ═══════════════════════════════════════════════════════════════════════

test("A1 — csm_metersPerPixel matches czm_metersPerPixel over a spread of depths", () => {
  assert.ok(
    /czm_metersPerPixel/u.test(metersPerPixelGlsl),
    "metersPerPixel.glsl is no longer the twin this chunk is checked against",
  );
  for (const depth of [10, 100, 400, 800, 5000, 250000]) {
    const positionEC = [0, 0, -depth, 1];
    const glsl = czmMetersPerPixel(positionEC, PIXEL_RATIO);
    const wgsl = csmMetersPerPixel(positionEC, PIXEL_RATIO);
    assert.ok(
      Math.abs(glsl - wgsl) <= 1e-9 * Math.max(1, glsl),
      `depth ${depth}: GLSL ${glsl} vs WGSL ${wgsl}`,
    );
  }
});

test("A2 — the radial-distance draft is DETECTED away from the view axis", () => {
  // The chunk shipped for months with `length(positionEC.xyz)`, which agrees
  // with the GLSL only on the view axis. Off-axis it over-reports the metric
  // and draws a metres line too THIN — a defect no on-axis sample can see, and
  // the reason A1's fixtures are not the whole story.
  const offAxis = [180.0, 120.0, -400.0, 1.0];
  const faithful = czmMetersPerPixel(offAxis, PIXEL_RATIO);
  const radial =
    ((2.0 * Math.hypot(offAxis[0], offAxis[1], offAxis[2])) /
      PROJECTION_1_1 /
      VIEWPORT.height) *
    PIXEL_RATIO;
  assert.ok(
    radial > faithful * 1.05,
    "the fixture must actually separate the two definitions",
  );
  assert.ok(
    Math.abs(csmMetersPerPixel(offAxis, PIXEL_RATIO) - faithful) <
      Math.abs(radial - faithful),
    "csm_metersPerPixel must follow the GLSL's eye-space depth, not the radius",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// B. THE ACCEPTANCE — census C-04
// ═══════════════════════════════════════════════════════════════════════

function strokes(mutate = {}) {
  const at = (authored, inMeters, positionEC) => ({
    glsl: glslHalfWidthDevicePixels(
      packedWidth(authored, inMeters),
      positionEC,
    ),
    wgsl: wgslHalfWidthDevicePixels(
      packedWidth(authored, inMeters, mutate),
      positionEC,
      mutate,
    ),
  });
  return {
    metres: {
      near: at(AUTHORED_METRES, true, NEAR_EC),
      far: at(AUTHORED_METRES, true, FAR_EC),
    },
    pixels: {
      near: at(AUTHORED_PIXELS, false, NEAR_EC),
      far: at(AUTHORED_PIXELS, false, FAR_EC),
    },
  };
}

test("B1 — a metres stroke HALVES across one octave of camera distance, on both backends", () => {
  const { metres } = strokes();
  for (const backend of ["glsl", "wgsl"]) {
    const near = metres.near[backend];
    const far = metres.far[backend];
    assert.ok(
      near > 1.0,
      `${backend}: the near stroke must be measurable, got ${near}`,
    );
    assert.ok(
      Math.abs(near / far - 2.0) < 1e-6,
      `${backend}: doubling the distance must halve the stroke; got ${near} then ${far}`,
    );
  }
  // ...and the two backends must agree, not merely each halve.
  assert.ok(
    Math.abs(metres.near.glsl - metres.near.wgsl) < 1e-6 * metres.near.glsl,
    `near: WebGL ${metres.near.glsl} vs WebGPU ${metres.near.wgsl}`,
  );
  assert.ok(
    Math.abs(metres.far.glsl - metres.far.wgsl) < 1e-6 * metres.far.glsl,
    `far: WebGL ${metres.far.glsl} vs WebGPU ${metres.far.wgsl}`,
  );
});

test("B2 — a pixels stroke does NOT change across the same octave, on both backends", () => {
  const { pixels } = strokes();
  for (const backend of ["glsl", "wgsl"]) {
    assert.equal(
      pixels.near[backend],
      pixels.far[backend],
      `${backend}: a pixel width must be altitude-independent`,
    );
  }
  assert.equal(
    pixels.near.wgsl,
    pixels.near.glsl,
    "the pixels path must be untouched by the metres work",
  );
  // The authored width is in CSS pixels on both backends; the device-pixel
  // half-extrusion is therefore authored/2 x pixelRatio.
  assert.equal(pixels.near.wgsl, (AUTHORED_PIXELS * PIXEL_RATIO) / 2);
});

test("B3 — the two unit kinds are told apart per collection, in the same frame", () => {
  const { metres, pixels } = strokes();
  assert.notEqual(
    metres.near.wgsl,
    pixels.near.wgsl,
    "an 8 m road and an 8 px road must not draw at the same width",
  );
  // The whole user-visible complaint, as a number: at orbital distance a
  // ground-metre road must collapse to far less than a pixel road.
  const veryFar = wgslHalfWidthDevicePixels(
    packedWidth(AUTHORED_METRES, true),
    [0, 0, -250000.0, 1],
  );
  assert.ok(
    veryFar < pixels.near.wgsl / 10,
    `at orbital distance a ground-metre road must be far thinner than a pixel road, got ${veryFar}`,
  );
});

test("B4 — the pixel ratio cancels: the metres stroke follows metres per DEVICE pixel", () => {
  // WebGL's `width` is CSS pixels and `czm_metersPerPixel` returns metres per
  // CSS pixel, so the ratio cancels in the device-pixel offset. The WebGPU
  // shader must reproduce that cancellation, not merely agree at ratio 1.
  const metresPerDevicePixel =
    (2.0 * NEAR_DISTANCE * (1.0 / PROJECTION_1_1)) / VIEWPORT.height;
  const expected = AUTHORED_METRES / metresPerDevicePixel / 2;
  const { metres } = strokes();
  assert.ok(
    Math.abs(metres.near.wgsl - expected) < 1e-6 * expected,
    `the ratio must cancel: got ${metres.near.wgsl}, expected ${expected}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════
// M. The pair — each half alone must go RED
// ═══════════════════════════════════════════════════════════════════════

test("M1 — the shader branch WITHOUT the packer's sign is DETECTED", () => {
  const { metres } = strokes({ dropCpuSign: true });
  assert.ok(
    Math.abs(metres.near.wgsl - metres.near.glsl) > 1e-6 * metres.near.glsl,
    "an unsigned attribute must not still produce the WebGL stroke",
  );
  assert.equal(
    metres.near.wgsl,
    metres.far.wgsl,
    "without the sign the metres branch never runs, so the stroke stops " +
      "tracking altitude — which is the reported bug, restored",
  );
});

test("M2 — the packer's sign WITHOUT the shader branch INVERTS the extrusion", () => {
  const { metres } = strokes({ dropShaderArm: true });
  assert.ok(
    metres.near.wgsl < 0,
    "a negative packed width with no sign test extrudes by a NEGATIVE " +
      "half-width — every miter inverts, which is why the two halves are one " +
      `patch; got ${metres.near.wgsl}`,
  );
  assert.ok(
    Math.abs(metres.near.wgsl - metres.near.glsl) > 1e-6,
    "the inverted ribbon must not compare equal to WebGL",
  );
});

test("M3 — making the shader branch INERT (`if (false && ...)`) is DETECTED", () => {
  // Absence is the easy mutation. This is the hard one: the branch is still in
  // the file, still reads csm_metersPerPixel, and still never runs.
  const inert = polylineWgsl.replace(
    "if (signedWidth < 0.0) {",
    "if (false && signedWidth < 0.0) {",
  );
  assert.notEqual(inert, polylineWgsl, "the inertness mutant must apply");
  assert.ok(
    !WGSL_METERS_ARM.test(inert),
    "an inert branch must not satisfy the switch the model is derived from — " +
      "otherwise this spec certifies text shape rather than behaviour",
  );
  // And with the switch off, the behaviour B1 asserts is gone: the same
  // computation stays flat across the octave instead of halving.
  const near = wgslHalfWidthDevicePixels(
    packedWidth(AUTHORED_METRES, true),
    NEAR_EC,
    { dropShaderArm: true },
  );
  const far = wgslHalfWidthDevicePixels(
    packedWidth(AUTHORED_METRES, true),
    FAR_EC,
    { dropShaderArm: true },
  );
  assert.equal(near, far, "an inert branch cannot track altitude");
});

test("M4 — the magnitude recovery is present on both backends", () => {
  // `abs()` is load-bearing beyond metres: it is what keeps the extrusion
  // positive for any width a future packer signs for another reason.
  assert.ok(
    WGSL_TAKES_MAGNITUDE,
    "BufferPolylineMaterial.wgsl must recover the magnitude with abs()",
  );
  assert.ok(
    /float width = abs\(signedWidth\);/u.test(polylineVsGlsl),
    "...matching the GLSL oracle it transliterates",
  );
});

test("M5 — the WebGL half is untouched", () => {
  // Principle 5 in the negative direction: this lane fixes a WebGPU-only gap,
  // so the GLSL oracle must still be the shipped upstream text.
  assert.ok(
    /width \/= max\(czm_metersPerPixel\(positionEC\), czm_epsilon7\);/u.test(
      polylineVsGlsl,
    ),
    "BufferPolylineMaterialVS.glsl must keep upstream's metres conversion",
  );
  assert.ok(
    /expandWidth \* czm_pixelRatio/u.test(polylineCommonGlsl),
    "PolylineCommon.glsl must keep the CSS-to-device conversion the oracle assumes",
  );
});
