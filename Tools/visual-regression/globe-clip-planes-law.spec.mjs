// globe-clip-planes-law.spec.mjs — on WebGPU the globe clips and draws the clip
// edge band exactly where WebGL does, for the same planes and camera.
//
// @purpose Executes the real clipping-plane packer and the globe shader's own plane-distance, union/intersection fold and pixel-metric helpers (out of GlobeTerrain.wgsl via wgsl-mini-eval) against independent transcriptions of WebGL's clip() path, then composes them over a rendered-globe pixel grid and requires the same discard set and the same edge band; every group is mutant-checked.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/globe-clip-planes-law.spec.mjs
//
// WHAT THE OBSERVABLE IS. A globe fragment is discarded when the clipping
// planes say so, and a kept fragment near a plane is painted with the edge
// colour. WebGL decides both in `getClippingFunction.js`'s generated `clip()`:
// every plane is carried to EYE space as `inverseTranspose(view * modelMatrix)
// * plane`, renormalised to a unit normal (`czm_transformPlane`), and a
// fragment's amount for that plane is `dot(n, positionEC - (-w * n))` divided
// by `czm_metersPerPixel(positionEC)`. Union mode discards when any amount is
// at or below 0, intersection mode when every one is; the kept fragment's
// combined amount is compared with the edge width in pixels.
//
// WHAT RUNS HERE, AND WHAT IT IS NOT. Nothing below transcribes the WGSL.
//   - The planes are packed by the REAL `updateWebGPUClippingPlanes`; the texel
//     it hands the device is what the shader would sample.
//   - The distance, the fold and the pixel metric are the shipped WGSL helper
//     functions, compiled from `GlobeTerrain.wgsl` by `wgsl-mini-eval`.
//   - Every oracle is written from `getClippingFunction.js`,
//     `transformPlane.glsl`, `metersPerPixel.glsl` and the plane's own
//     geometry, using Cesium's f64 `Matrix4` / `Ellipsoid` /
//     `IntersectionTests`.
// The entry points (`fragmentMain`, `fragmentPickMain`) hold loops, texture
// fetches and storage buffers no Node evaluator can run: which varying feeds the
// test, the pick-pass clip and the band's call site are accepted by the Edge
// leg, not here.
//
// GROUPS. A: one packed plane's signed distance, in metres, in eye space.
// B: the union / intersection fold. C: the pixel metric the band is divided by.
// X: the three composed over a rendered globe, against WebGL's own decisions.
// M: mutants - each group is shown to go red when its helper is reverted.
//
// PRECISION. The packed plane is Float32, the evaluator is f64. The error
// bound is derived, not guessed: see `packingTolerance`.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";
import {
  compileFunction,
  stripComments,
  vec,
  vec4,
} from "./lib/wgsl-mini-eval.mjs";

import Cartesian3 from "../../packages/engine/Source/Core/Cartesian3.js";
import Ellipsoid from "../../packages/engine/Source/Core/Ellipsoid.js";
import IntersectionTests from "../../packages/engine/Source/Core/IntersectionTests.js";
import Matrix4 from "../../packages/engine/Source/Core/Matrix4.js";
import Ray from "../../packages/engine/Source/Core/Ray.js";
import {
  FRUSTA,
  VIEWPORT,
  enuModelMatrix,
  geometricEyePlane,
  glslAmountMetres,
  glslEyePlane,
  glslFold,
  glslMetersPerPixel,
  lookDownView,
  subtract,
  surfaceUnderPixel,
  tiltedSurface,
} from "./lib/globe-clip-webgl-oracle.mjs";
import { replaceFunctionBody } from "./lib/wgsl-function-body.mjs";

enableEngineTsResolution();
// The packer names the WebGPU usage flags as a global; Node has none.
globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2 };
const { updateWebGPUClippingPlanes } =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUClippingPlaneCollection.ts");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const GLOBE_WGSL = path.join(
  ROOT,
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
);

const HELPERS = [
  "globeClipPlaneDistance",
  "globeClipPlanesSeed",
  "globeClipPlanesStep",
  "globeClipMetersPerPixel",
];

// ── Loading the shader laws ─────────────────────────────────────────────────

const rawWgsl = fs.readFileSync(GLOBE_WGSL, "utf8").replace(/\r\n/g, "\n");

/**
 * Compile the four clip helpers out of a WGSL source text.
 *
 * @param {string} source GlobeTerrain.wgsl text (possibly mutated).
 * @returns {object} The callables, by name.
 */
function loadLaws(source) {
  const stripped = stripComments(source);
  const functions = {};
  const globals = { __functions: functions };
  for (const name of HELPERS) {
    functions[name] = compileFunction(stripped, name, globals);
  }
  return functions;
}

const laws = loadLaws(rawWgsl);

// ── Cameras, planes and the real packer ─────────────────────────────────────

const ORIGIN = { lon: -105, lat: 45 };

/**
 * Run the real packer. Returns the packed texels exactly as the device would
 * receive them, as plain arrays.
 *
 * @param {object[]} planes `{normal:{x,y,z}, distance}` per plane.
 * @param {object} options `view`, `modelMatrix`, `union`, `withInverseViewTranspose`.
 * @returns {number[][]} One `[x, y, z, w]` texel per plane.
 */
function packPlanes(planes, options) {
  const writes = [];
  const device = {
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createSampler: () => ({}),
    queue: {
      writeTexture: (_destination, data) =>
        writes.push(Float32Array.from(data)),
    },
  };
  const uniformState = { view: options.view };
  if (options.withInverseViewTranspose) {
    uniformState.inverseViewTranspose = Matrix4.inverseTranspose(
      options.view,
      new Matrix4(),
    );
  }
  const collection = {
    length: planes.length,
    get: (i) => planes[i],
    modelMatrix: options.modelMatrix ?? Matrix4.clone(Matrix4.IDENTITY),
    _unionClippingRegions: options.union ?? true,
  };
  updateWebGPUClippingPlanes(collection, {
    context: { device, uniformState },
  });
  assert.equal(writes.length, 1, "the packer uploads exactly once");
  const data = writes[0];
  return planes.map((_, i) => Array.from(data.subarray(i * 4, i * 4 + 4)));
}

/** Distance bound for a Float32-packed plane read in f64: the rounding of each term. */
function packingTolerance(texel, positionEC, amount) {
  const ulp = 2 ** -23;
  return (
    ulp *
      (Math.abs(positionEC.x) +
        Math.abs(positionEC.y) +
        Math.abs(positionEC.z) +
        Math.abs(texel[3]) +
        Math.abs(amount)) +
    1e-9
  );
}

const callDistance = (fns, positionEC, texel) =>
  fns.globeClipPlaneDistance(
    vec(positionEC.x, positionEC.y, positionEC.z),
    vec4(texel[0], texel[1], texel[2], texel[3]),
  );

/** Fragment positions on the ellipsoid, in world space, around `ORIGIN`. */
function surfacePoints() {
  const offsets = [-5, -1, -0.1, 0, 0.1, 1, 5];
  const out = [];
  for (const dLon of offsets) {
    for (const dLat of offsets) {
      out.push(Cartesian3.fromDegrees(ORIGIN.lon + dLon, ORIGIN.lat + dLat, 0));
    }
  }
  return out;
}

const PLANE_CASES = [
  {
    name: "ENU frame, normal (1,0,0), distance 0",
    planes: [{ normal: { x: 1, y: 0, z: 0 }, distance: 0 }],
    modelMatrix: () => enuModelMatrix(ORIGIN.lon, ORIGIN.lat),
  },
  {
    name: "ENU frame, normal (1,0,0), distance -700",
    planes: [{ normal: { x: 1, y: 0, z: 0 }, distance: -700 }],
    modelMatrix: () => enuModelMatrix(ORIGIN.lon, ORIGIN.lat),
  },
  {
    name: "ENU frame scaled by 2, normal (0,1,0), distance 40000",
    planes: [{ normal: { x: 0, y: 1, z: 0 }, distance: 40000 }],
    modelMatrix: () =>
      Matrix4.multiplyByUniformScale(
        enuModelMatrix(ORIGIN.lon, ORIGIN.lat),
        2,
        new Matrix4(),
      ),
  },
  {
    name: "identity model matrix (world-authored plane through the region)",
    planes: [{ normal: { x: 1, y: 0, z: 0 }, distance: 1_167_000 }],
    modelMatrix: () => Matrix4.clone(Matrix4.IDENTITY),
  },
];

// ═══ Group A: the plane law ═════════════════════════════════════════════════

const CAMERA = lookDownView(ORIGIN.lon, ORIGIN.lat, 1_000_000);

for (const withInverseViewTranspose of [false, true]) {
  for (const planeCase of PLANE_CASES) {
    test(`A1: the packed plane's distance equals WebGL's metres (${planeCase.name}; inverseViewTranspose ${withInverseViewTranspose ? "supplied" : "absent"})`, () => {
      const modelMatrix = planeCase.modelMatrix();
      const texels = packPlanes(planeCase.planes, {
        view: CAMERA.view,
        modelMatrix,
        withInverseViewTranspose,
      });
      const eyePlane = glslEyePlane(
        planeCase.planes[0],
        CAMERA.view,
        modelMatrix,
      );
      let compared = 0;
      let positive = 0;
      let negative = 0;
      for (const world of surfacePoints()) {
        const positionEC = Matrix4.multiplyByPoint(
          CAMERA.view,
          world,
          new Cartesian3(),
        );
        const expected = glslAmountMetres(eyePlane, positionEC);
        const actual = callDistance(laws, positionEC, texels[0]);
        const tolerance = packingTolerance(texels[0], positionEC, expected);
        assert.ok(
          tolerance < 10,
          `derived tolerance ${tolerance} m is not vacuous`,
        );
        assert.ok(
          Math.abs(actual - expected) <= tolerance,
          `distance ${actual} vs WebGL ${expected} (tolerance ${tolerance} m)`,
        );
        if (Math.abs(expected) > tolerance) {
          assert.equal(Math.sign(actual), Math.sign(expected), "sides agree");
          compared += 1;
          if (expected > 0) positive += 1;
          else negative += 1;
        }
      }
      // Without both sides in the sample the sign check is vacuous.
      assert.ok(
        compared > 20 && positive > 5 && negative > 5,
        "both sides sampled",
      );
    });
  }
}

test("A2: the two WebGL oracles agree (plane algebra vs plane geometry)", () => {
  for (const planeCase of PLANE_CASES) {
    const modelMatrix = planeCase.modelMatrix();
    const algebra = glslEyePlane(planeCase.planes[0], CAMERA.view, modelMatrix);
    const geometry = geometricEyePlane(
      planeCase.planes[0],
      CAMERA.view,
      modelMatrix,
    );
    for (const world of surfacePoints().slice(0, 12)) {
      const positionEC = Matrix4.multiplyByPoint(
        CAMERA.view,
        world,
        new Cartesian3(),
      );
      const viaGeometry = Cartesian3.dot(
        geometry.normal,
        Cartesian3.subtract(positionEC, geometry.point, new Cartesian3()),
      );
      assert.ok(
        Math.abs(viaGeometry - glslAmountMetres(algebra, positionEC)) < 1e-4,
        `${planeCase.name}: oracles diverge`,
      );
    }
  }
});

test("A3: a plane packed with a non-unit normal gives the same distance as the unit plane", () => {
  const modelMatrix = PLANE_CASES[1].modelMatrix();
  const [unit] = packPlanes(PLANE_CASES[1].planes, {
    view: CAMERA.view,
    modelMatrix,
  });
  for (const k of [3, 0.25]) {
    const scaled = unit.map((v) => v * k);
    for (const world of surfacePoints().slice(0, 20)) {
      const positionEC = Matrix4.multiplyByPoint(
        CAMERA.view,
        world,
        new Cartesian3(),
      );
      const reference = callDistance(laws, positionEC, unit);
      const actual = callDistance(laws, positionEC, scaled);
      assert.ok(
        Math.abs(actual - reference) <=
          packingTolerance(unit, positionEC, reference),
        `k=${k}: ${actual} vs ${reference}`,
      );
    }
  }
  // The same property through the packer: a collection whose model matrix scales by 2
  // packs a non-unit normal, and still measures metres (A1's scaled case).
  const scaledMatrix = PLANE_CASES[2].modelMatrix();
  const [packed] = packPlanes(PLANE_CASES[2].planes, {
    view: CAMERA.view,
    modelMatrix: scaledMatrix,
  });
  assert.ok(
    Math.abs(Math.hypot(packed[0], packed[1], packed[2]) - 1) > 0.1,
    "the scaled collection really packs a non-unit normal",
  );
});

test("A4: control - the packed plane is an EYE-space plane; ECEF positions do not reproduce its distance", () => {
  const modelMatrix = PLANE_CASES[0].modelMatrix();
  const texels = packPlanes(PLANE_CASES[0].planes, {
    view: CAMERA.view,
    modelMatrix,
  });
  const eyePlane = glslEyePlane(
    PLANE_CASES[0].planes[0],
    CAMERA.view,
    modelMatrix,
  );
  let worst = 0;
  let best = Infinity;
  for (const world of surfacePoints()) {
    const positionEC = Matrix4.multiplyByPoint(
      CAMERA.view,
      world,
      new Cartesian3(),
    );
    const expected = glslAmountMetres(eyePlane, positionEC);
    const inWrongFrame = callDistance(laws, world, texels[0]);
    const error = Math.abs(inWrongFrame - expected);
    worst = Math.max(worst, error);
    best = Math.min(best, error);
  }
  // A measured property of the law: Earth-radius scale errors, far above any tolerance.
  assert.ok(worst > 1_000_000, `worst wrong-frame error ${worst} m`);
  assert.ok(best > 1_000, `smallest wrong-frame error ${best} m`);
});

// ═══ Group B: the fold ══════════════════════════════════════════════════════

function wgslFold(fns, distances, union) {
  let state = fns.globeClipPlanesSeed(union);
  for (const distance of distances) {
    state = fns.globeClipPlanesStep(state, distance, union);
  }
  return { clipped: state.y > 0.5, amount: state.x };
}

function* distanceSets() {
  const pool = [-250, -3, 0, 3, 40, 900];
  for (const a of pool) yield [a];
  for (const a of pool) for (const b of pool) yield [a, b];
  yield [5, -5, 0];
  yield [-5, -6, -7];
  yield [5, 6, 7];
  yield [0, 0, 0];
  yield [12, 0, -4];
  yield [-1, 8, 2];
}

function foldViolations(fns) {
  const violations = [];
  for (const union of [true, false]) {
    for (const distances of distanceSets()) {
      const expected = glslFold(distances, union);
      const actual = wgslFold(fns, distances, union);
      const label = `${union ? "union" : "intersection"} [${distances}]`;
      if (expected.clipped !== actual.clipped) {
        violations.push(
          `${label}: clipped ${actual.clipped}, WebGL ${expected.clipped}`,
        );
      } else if (!expected.clipped && expected.amount !== actual.amount) {
        violations.push(
          `${label}: amount ${actual.amount}, WebGL ${expected.amount}`,
        );
      }
      // Order independence.
      const reversed = wgslFold(fns, [...distances].reverse(), union);
      if (
        reversed.clipped !== actual.clipped ||
        (!actual.clipped && reversed.amount !== actual.amount)
      ) {
        violations.push(`${label}: depends on plane order`);
      }
    }
  }
  return violations;
}

test("B1: union and intersection folds give WebGL's clip decision and clip amount", () => {
  assert.deepEqual(foldViolations(laws), []);
});

test("B2: the fold's decisions are non-trivial (both outcomes occur in both modes)", () => {
  for (const union of [true, false]) {
    const outcomes = new Set();
    for (const distances of distanceSets()) {
      outcomes.add(wgslFold(laws, distances, union).clipped);
    }
    assert.equal(
      outcomes.size,
      2,
      `${union ? "union" : "intersection"} sees both outcomes`,
    );
  }
  // The modes genuinely differ: one plane behind, one in front.
  assert.equal(wgslFold(laws, [-5, 7], true).clipped, true);
  assert.equal(wgslFold(laws, [-5, 7], false).clipped, false);
  assert.equal(wgslFold(laws, [0], true).clipped, true, "exactly 0 is clipped");
});

// ═══ Group C: the pixel metric ══════════════════════════════════════════════

const callMetric = (fns, at, dx, dy, perspective, pixelRatio) =>
  fns.globeClipMetersPerPixel(
    vec(at.x, at.y, at.z),
    vec(dx.x, dx.y, dx.z),
    vec(dy.x, dy.y, dy.z),
    perspective,
    pixelRatio,
  );

/**
 * @param {object} fns The compiled helpers.
 * @param {number} step Pixel step the eye-position differences are taken over: 1 is
 *   what a 2x2 quad gives the shader, a small fraction is the derivative it approximates.
 * @param {number} relativeTolerance Allowed relative error.
 */
function metricViolations(fns, step, relativeTolerance) {
  const violations = [];
  for (const [frustumName, frustum] of Object.entries(FRUSTA)) {
    for (const orthographic of [false, true]) {
      const ortho = orthographic
        ? { ...frustum, left: -3000, right: 3000, top: 2250, bottom: -2250 }
        : frustum;
      for (const tilt of [0, 60, 85]) {
        for (const azimuth of [0, 90, 215]) {
          for (const pixelRatio of [1, 2]) {
            for (const [px, py] of [
              [100, 100],
              [400, 300],
              [700, 500],
              [120, 520],
            ]) {
              const surface = tiltedSurface(tilt, azimuth, 1_500_000);
              if (orthographic && surface.normal[2] < 0.05) continue;
              const at = surfaceUnderPixel(
                px,
                py,
                ortho,
                orthographic,
                surface,
              );
              // A grazing ray can meet the surface behind the eye; WebGL never shades that.
              if (!orthographic && !(at.z < -1e5 && at.z > -5e7)) continue;
              const scaleBy = (v) => ({
                x: v.x / step,
                y: v.y / step,
                z: v.z / step,
              });
              const dx = scaleBy(
                subtract(
                  surfaceUnderPixel(
                    px + step,
                    py,
                    ortho,
                    orthographic,
                    surface,
                  ),
                  at,
                ),
              );
              const dy = scaleBy(
                subtract(
                  surfaceUnderPixel(
                    px,
                    py + step,
                    ortho,
                    orthographic,
                    surface,
                  ),
                  at,
                ),
              );
              const expected = glslMetersPerPixel(
                at,
                ortho,
                orthographic,
                pixelRatio,
              );
              const actual = callMetric(
                fns,
                at,
                dx,
                dy,
                !orthographic,
                pixelRatio,
              );
              if (
                !(Math.abs(actual - expected) <= relativeTolerance * expected)
              ) {
                violations.push(
                  `${frustumName} ${orthographic ? "ortho" : "persp"} tilt ${tilt} az ${azimuth} ratio ${pixelRatio} px ${px},${py}: ${actual} vs WebGL ${expected}`,
                );
              }
            }
          }
        }
      }
    }
  }
  return violations;
}

test("C1: with the screen derivative, the pixel metric equals czm_metersPerPixel exactly, for facing and grazing surfaces", () => {
  assert.deepEqual(metricViolations(laws, 1e-3, 1e-4), []);
});

test("C1b: with whole-pixel differences (what a 2x2 quad gives), it stays within the second-order error", () => {
  // A difference across one pixel carries the term (dz * du) the derivative does not;
  // on a surface tilted 85 degrees that is measured at 3.5%, so 5% bounds it.
  assert.deepEqual(metricViolations(laws, 1, 0.05), []);
});

test("C2: the metric scales with pixel ratio and with depth, and takes the larger pixel extent", () => {
  const frustum = FRUSTA["stretched (non-square pixels)"];
  const surface = tiltedSurface(0, 0, 1_000_000);
  const at = surfaceUnderPixel(400, 300, frustum, false, surface);
  const dx = subtract(surfaceUnderPixel(401, 300, frustum, false, surface), at);
  const dy = subtract(surfaceUnderPixel(400, 301, frustum, false, surface), at);
  const one = callMetric(laws, at, dx, dy, true, 1);
  const two = callMetric(laws, at, dx, dy, true, 2);
  assert.ok(Math.abs(two - 2 * one) < 1e-9 * one, "pixel ratio multiplies");
  // Stretched frustum: pixel width (2*2*tan/800) beats height (2*tan/600).
  const width = (2 * 1_000_000 * frustum.right) / VIEWPORT.width;
  const height = (2 * 1_000_000 * frustum.top) / VIEWPORT.height;
  assert.ok(width > height * 1.4, "the fixture has unequal pixel extents");
  assert.ok(
    Math.abs(one - width) < 0.01 * width,
    "the larger extent is reported",
  );
});

// ═══ Group X: the whole decision over a rendered globe ═════════════════════

const GLOBE_FRUSTUM = FRUSTA["symmetric 60 deg"];
const GLOBE_CAMERA = lookDownView(ORIGIN.lon, ORIGIN.lat, 1_000_000);
const inverseCameraView = Matrix4.inverseTransformation(
  GLOBE_CAMERA.view,
  new Matrix4(),
);

/** Eye-space point where a pixel's centre ray meets the WGS84 surface, or undefined on a miss. */
function globeHit(px, py) {
  const ndcX = ((px + 0.5) / VIEWPORT.width) * 2 - 1;
  const ndcY = 1 - ((py + 0.5) / VIEWPORT.height) * 2;
  const eyeDirection = new Cartesian3(
    ndcX * (GLOBE_FRUSTUM.right / GLOBE_FRUSTUM.near),
    ndcY * (GLOBE_FRUSTUM.top / GLOBE_FRUSTUM.near),
    -1,
  );
  const direction = Cartesian3.normalize(
    Matrix4.multiplyByPointAsVector(
      inverseCameraView,
      eyeDirection,
      new Cartesian3(),
    ),
    new Cartesian3(),
  );
  const interval = IntersectionTests.rayEllipsoid(
    new Ray(GLOBE_CAMERA.position, direction),
    Ellipsoid.WGS84,
  );
  if (interval === undefined) return undefined;
  const world = Cartesian3.add(
    GLOBE_CAMERA.position,
    Cartesian3.multiplyByScalar(direction, interval.start, new Cartesian3()),
    new Cartesian3(),
  );
  return Matrix4.multiplyByPoint(GLOBE_CAMERA.view, world, new Cartesian3());
}

const SCENES = [
  {
    name: "one plane",
    planes: [{ normal: { x: 1, y: 0, z: 0 }, distance: 100_000 }],
  },
  {
    name: "two planes",
    planes: [
      { normal: { x: 1, y: 0, z: 0 }, distance: 100_000 },
      { normal: { x: 0, y: 1, z: 0 }, distance: 150_000 },
    ],
  },
];
const EDGE_WIDTH_PIXELS = 6;
const PIXEL_RATIO = 1;

/** WebGL's decision for one fragment, from clip() and GlobeFS's edge test. */
function glslDecision(eyePlanes, positionEC, frustum, union) {
  const pixelWidth = glslMetersPerPixel(
    positionEC,
    frustum,
    false,
    PIXEL_RATIO,
  );
  const amounts = eyePlanes.map(
    (plane) => glslAmountMetres(plane, positionEC) / pixelWidth,
  );
  const fold = glslFold(amounts, union);
  return {
    discard: fold.clipped,
    pixels: fold.amount,
    band: !fold.clipped && fold.amount < EDGE_WIDTH_PIXELS,
    amounts,
    pixelWidth,
  };
}

/** The WebGPU decision: shipped helpers over the packed texels, with the glue the behaviour statement spells out. */
function wgslDecision(fns, texels, positionEC, dx, dy, union) {
  let state = fns.globeClipPlanesSeed(union);
  for (const texel of texels) {
    state = fns.globeClipPlanesStep(
      state,
      callDistance(fns, positionEC, texel),
      union,
    );
  }
  const metersPerPixel = callMetric(fns, positionEC, dx, dy, true, PIXEL_RATIO);
  const clipped = state.y > 0.5;
  return {
    discard: clipped,
    band: !clipped && state.x / metersPerPixel < EDGE_WIDTH_PIXELS,
    pixels: state.x / metersPerPixel,
  };
}

function sceneViolations(fns) {
  const violations = [];
  const counts = { discard: 0, band: 0, plain: 0, skipped: 0, total: 0 };
  const modelMatrix = enuModelMatrix(ORIGIN.lon, ORIGIN.lat);
  for (const scene of SCENES) {
    for (const union of [true, false]) {
      const texels = packPlanes(scene.planes, {
        view: GLOBE_CAMERA.view,
        modelMatrix,
        union,
      });
      const eyePlanes = scene.planes.map((plane) =>
        glslEyePlane(plane, GLOBE_CAMERA.view, modelMatrix),
      );
      for (let py = 10; py < VIEWPORT.height - 10; py += 20) {
        for (let px = 10; px < VIEWPORT.width - 10; px += 20) {
          const here = globeHit(px, py);
          const right = globeHit(px + 1, py);
          const below = globeHit(px, py + 1);
          if (here === undefined || right === undefined || below === undefined)
            continue;
          counts.total += 1;
          const expected = glslDecision(eyePlanes, here, GLOBE_FRUSTUM, union);
          const actual = wgslDecision(
            fns,
            texels,
            here,
            subtract(right, here),
            subtract(below, here),
            union,
          );
          // Pixels the f32 packing or a neighbour-difference derivative
          // could legitimately tip either way are not asserted.
          const nearPlane = expected.amounts.some(
            (amount) => Math.abs(amount * expected.pixelWidth) < 1,
          );
          const nearBand =
            expected.pixels !== undefined &&
            Math.abs(expected.pixels - EDGE_WIDTH_PIXELS) <
              0.03 * EDGE_WIDTH_PIXELS;
          if (nearPlane || nearBand) {
            counts.skipped += 1;
            continue;
          }
          const label = `${scene.name} ${union ? "union" : "intersection"} px ${px},${py}`;
          if (actual.discard !== expected.discard) {
            violations.push(
              `${label}: discard ${actual.discard}, WebGL ${expected.discard}`,
            );
          } else if (!expected.discard && actual.band !== expected.band) {
            violations.push(
              `${label}: band ${actual.band}, WebGL ${expected.band}`,
            );
          }
          if (expected.discard) counts.discard += 1;
          else if (expected.band) counts.band += 1;
          else counts.plain += 1;
        }
      }
    }
  }
  return { violations, counts };
}

test("X1: over a rendered globe WebGPU discards the same fragments and draws the same edge band as WebGL", () => {
  const { violations, counts } = sceneViolations(laws);
  assert.deepEqual(violations, []);
  // The fixture exercises all three outcomes, in volume, and skips little.
  assert.ok(counts.discard > 100, `discarded ${counts.discard}`);
  assert.ok(counts.band > 40, `band ${counts.band}`);
  assert.ok(counts.plain > 100, `plain ${counts.plain}`);
  assert.ok(
    counts.skipped < 0.15 * counts.total,
    `skipped ${counts.skipped}/${counts.total}`,
  );
});

// ═══ Group M: mutants - every group goes red when its helper is reverted ════

const MUTANTS = {
  planeDistanceNotRenormalised: {
    group: "A",
    mutate: (source) =>
      replaceFunctionBody(
        source,
        "globeClipPlaneDistance",
        "  return dot(positionEC, plane.xyz) + plane.w;",
      ),
  },
  planeDistanceWrongSign: {
    group: "A",
    mutate: (source) =>
      replaceFunctionBody(
        source,
        "globeClipPlaneDistance",
        "  return -(dot(positionEC, plane.xyz) + plane.w) / length(plane.xyz);",
      ),
  },
  foldIgnoresMode: {
    group: "B",
    mutate: (source) =>
      replaceFunctionBody(
        source,
        "globeClipPlanesStep",
        "  let clipped = select(0.0, 1.0, planeDistance <= 0.0);\n  return vec2<f32>(min(state.x, planeDistance), max(state.y, clipped));",
      ),
  },
  foldZeroIsKept: {
    group: "B",
    mutate: (source) =>
      replaceFunctionBody(
        source,
        "globeClipPlanesStep",
        "  let clipped = select(0.0, 1.0, planeDistance < 0.0);\n  if (isUnion) {\n    return vec2<f32>(min(state.x, planeDistance), max(state.y, clipped));\n  }\n  return vec2<f32>(max(state.x, planeDistance), min(state.y, clipped));",
      ),
  },
  metricIgnoresPixelRatio: {
    group: "C",
    mutate: (source) =>
      replaceFunctionBody(
        source,
        "globeClipMetersPerPixel",
        "  let rayScale = select(0.0, 1.0 / positionEC.z, perspective);\n  let widthDx = positionECDx.x - positionEC.x * positionECDx.z * rayScale;\n  let heightDy = positionECDy.y - positionEC.y * positionECDy.z * rayScale;\n  return max(abs(widthDx), abs(heightDy));",
      ),
  },
  metricKeepsViewRayStep: {
    group: "C",
    mutate: (source) =>
      replaceFunctionBody(
        source,
        "globeClipMetersPerPixel",
        "  return max(abs(positionECDx.x), abs(positionECDy.y)) * pixelRatio;",
      ),
  },
};

for (const [name, mutant] of Object.entries(MUTANTS)) {
  test(`M: mutant ${name} turns group ${mutant.group} red`, () => {
    const mutated = loadLaws(mutant.mutate(rawWgsl));
    let violations;
    if (mutant.group === "A") {
      const modelMatrix = PLANE_CASES[1].modelMatrix();
      const texels = packPlanes(PLANE_CASES[1].planes, {
        view: CAMERA.view,
        modelMatrix,
      });
      const eyePlane = glslEyePlane(
        PLANE_CASES[1].planes[0],
        CAMERA.view,
        modelMatrix,
      );
      const scaled = texels[0].map((v) => v * 3);
      violations = [];
      for (const world of surfacePoints()) {
        const positionEC = Matrix4.multiplyByPoint(
          CAMERA.view,
          world,
          new Cartesian3(),
        );
        const expected = glslAmountMetres(eyePlane, positionEC);
        for (const texel of [texels[0], scaled]) {
          const actual = callDistance(mutated, positionEC, texel);
          if (
            Math.abs(actual - expected) >
            packingTolerance(texel, positionEC, expected)
          ) {
            violations.push("distance");
          }
        }
      }
      violations.push(...sceneViolations(mutated).violations);
    } else if (mutant.group === "B") {
      violations = foldViolations(mutated);
    } else {
      violations = [
        ...metricViolations(mutated, 1e-3, 1e-4),
        ...metricViolations(mutated, 1, 0.05),
      ];
    }
    assert.ok(violations.length > 0, `mutant ${name} was not caught`);
  });
}
