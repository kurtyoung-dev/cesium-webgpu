import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { decodePng } from "../lib/png-decode.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import {
  C13_42_GODRAY_FIXTURE,
  CAPTURE_BORDER_TEXELS,
  classifyLinearDepth,
  classifyProjectedHullSample,
  convexHullFromProjectedCorners,
  createBoxFromProjectedRectangle,
  createFixtureCamera,
  createFixtureSunPosition,
  deriveFixtureMasks,
  deriveGodRayCaptureMasks,
  expectedShaftDirectionRadians,
  linearSamplerFootprint,
  projectWorld,
  projectedEmitterPixels,
  refuseF16Amplitude,
  traceF32Ray,
} from "./lib/c13-42-godray-fixture.mjs";
import { computeC13_42CellMetrics } from "./lib/c13-42-reproduction-contract.mjs";
import { buildGodRayGeometry } from "./probe-c13-42-reported-demos.mjs";

const generateUrl = new URL(
  "../../packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayGenerate.wgsl",
  import.meta.url,
);
const generateF16Url = new URL(
  "../../packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayGenerate_f16.wgsl",
  import.meta.url,
);
const compositeUrl = new URL(
  "../../packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayComposite.wgsl",
  import.meta.url,
);
const compositeF16Url = new URL(
  "../../packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayComposite_f16.wgsl",
  import.meta.url,
);

function count(source, expression) {
  return [...source.matchAll(expression)].length;
}

function close(actual, expected, epsilon = 1e-12) {
  return Math.abs(actual - expected) <= epsilon;
}

function declaredRectangleCorners(rectangle) {
  const { u0, u1, v0, v1 } = rectangle;
  return [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ];
}

function projectedFixtureCorners() {
  const camera = createFixtureCamera(6_378_137);
  const projectRectangle = (rectangle) =>
    createBoxFromProjectedRectangle({
      camera,
      rectangle,
      frontDistance: rectangle.frontDistance,
      thickness: rectangle.thickness,
    }).corners.map((corner) => projectWorld(camera, corner).uv);
  return {
    emitter: projectRectangle(C13_42_GODRAY_FIXTURE.emitter),
    occluder: projectRectangle(C13_42_GODRAY_FIXTURE.occluder),
  };
}

function defaultMaskInput(control = "near-occluder") {
  const corners = projectedFixtureCorners();
  return {
    emitterProjectedCorners: corners.emitter,
    occluderProjectedCorners: corners.occluder,
    control,
  };
}

function nonZero(values) {
  return values.reduce((count, value) => count + Number(value !== 0), 0);
}

let mainMasks;

function mainFixtureMasks(input = defaultMaskInput()) {
  mainMasks ??= deriveFixtureMasks(input);
  return mainMasks;
}

function orderedF32Diagnostic(taps, color, decay, decayBeforeSample = false) {
  const f32 = Math.fround;
  const { weight, exposure } = C13_42_GODRAY_FIXTURE.config;
  let baseline = f32(0);
  let main = f32(0);
  let illumDecay = f32(1);
  for (const tap of taps) {
    if (decayBeforeSample) {
      illumDecay = f32(illumDecay * f32(decay));
    }
    const baselineSample = f32(
      f32(color * Number(tap.emitter === "inside" && tap.baselineIsSky)) *
        f32(1),
    );
    const mainSample = f32(
      f32(color * Number(tap.emitter === "inside" && tap.isSky)) * f32(1),
    );
    const gain = f32(f32(weight) * illumDecay);
    baseline = f32(baseline + f32(baselineSample * gain));
    main = f32(main + f32(mainSample * gain));
    if (!decayBeforeSample) {
      illumDecay = f32(illumDecay * f32(decay));
    }
  }
  const baselineOut = f32(baseline * f32(exposure));
  const mainOut = f32(main * f32(exposure));
  return {
    baseline: baselineOut,
    main: mainOut,
    deficit: baselineOut - mainOut,
  };
}

function nextUp(value) {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value);
  bits.setBigUint64(0, bits.getBigUint64(0) + 1n);
  return bits.getFloat64(0);
}

function nextDown(value) {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value);
  bits.setBigUint64(0, bits.getBigUint64(0) - 1n);
  return bits.getFloat64(0);
}

// REPAIRED 2026-09-13 (C13-42f, lane Curumo). This test was RED at
// `ea651de6d8` and had been since Batch 1471 (`3a9d6b80f0`) rewrote the god-ray
// march: 10 of its 18 assertions no longer matched the shipped shader, and
// Node stops a test at its first failure, so the other nine had not been
// evaluated against the current sources at all. Six of the ten asserted
// behaviour Batch 1471 REMOVED ON PURPOSE and they are deleted rather than
// re-anchored — `textureSampleLevel(sceneColorTex, …)` (the march no longer
// reads scene colour; `GodRayGenerate.wgsl:3-6`, `:55-62`), the
// `illumination + sample * (weight * illumDecay)` accumulation and the
// per-step `illumDecay * decay` (replaced by `godRayAccumulate` over
// normalized `visibleSum`/`weightSum` and a sample-count-invariant
// `attenStep`, `:26-53`), and the f16 `vec3<f16>` accumulator with its
// `f16(weight * illumDecay)` cast (the f16 variant now marches in f32 and
// narrows only the final combine, `GodRayGenerate_f16.wgsl:6-23`). The law
// those six used to approximate is pinned properly — by parsing and EVALUATING
// the shader, with inertness mutants — in
// `Tools/visual-regression/godray-energy-law.spec.mjs` (`npm run
// test-engine-node`), which is where it belongs. What survives here is what
// this test's own name claims and that spec does not cover: the f32 step size,
// the depth gate, the sample-then-step order, and the composite's additive
// topology.
test("production GodRay WGSL keeps f32 step, depth-gate, and additive topology", async () => {
  const [generate, generateF16, composite, compositeF16] = await Promise.all([
    readFile(generateUrl, "utf8"),
    readFile(generateF16Url, "utf8"),
    readFile(compositeUrl, "utf8"),
    readFile(compositeF16Url, "utf8"),
  ]);

  for (const source of [generate, generateF16]) {
    // `density * invN`, where `invN = 1.0 / f32(sampleCount)`, is arithmetically
    // the `density / f32(sampleCount)` this assertion was written against; the
    // reciprocal is named because Batch 1471 reuses it twice more (the midpoint
    // offset and the attenuation-ratio evaluation).
    assert.equal(count(source, /let invN = 1\.0 \/ n;/gu), 1);
    assert.equal(
      count(
        source,
        /let deltaUV = \(sunUV - in\.uv\) \* \(density \* invN\);/gu,
      ),
      1,
    );
    assert.equal(count(source, /stepUV = stepUV \+ deltaUV;/gu), 1);
    assert.equal(
      count(
        source,
        /let isSky = step\(far \* occlusionCutoff, linearDepth\);/gu,
      ),
      1,
    );
    // Sample, THEN step: the depth read must use the step's own position, not
    // its successor's. The predecessor of this assertion required the opposite
    // order, matching the pre-1471 march that sampled at `(i + 1) / n` while
    // weighting by index; `GodRayGenerate.wgsl:257-262` records why that was
    // wrong and why the midpoint scheme replaced it.
    assert.equal(
      source.indexOf("sceneDepthTex, texSampler, stepUV") <
        source.indexOf("stepUV = stepUV + deltaUV;"),
      true,
    );
  }
  for (const source of [composite, compositeF16]) {
    assert.equal(
      count(source, /textureSample\(godrayTex, texSampler, in\.uv\)/gu),
      1,
    );
  }
  assert.match(composite, /scene\.rgb \+ rays\.rgb/u);
  assert.match(compositeF16, /vec3<f32>\(scene \+ rays\)/u);
});

test("fixture constants are immutable, byte-quantized, and unscored", () => {
  assert.equal(Object.isFrozen(C13_42_GODRAY_FIXTURE), true);
  assert.equal(Object.isFrozen(C13_42_GODRAY_FIXTURE.config), true);
  assert.equal(Object.isFrozen(C13_42_GODRAY_FIXTURE.colorBytes), true);
  assert.equal(C13_42_GODRAY_FIXTURE.backingWidth, 512);
  assert.equal(C13_42_GODRAY_FIXTURE.backingHeight, 512);
  assert.equal(C13_42_GODRAY_FIXTURE.rayWidth, 256);
  assert.equal(C13_42_GODRAY_FIXTURE.rayHeight, 256);
  assert.deepEqual(C13_42_GODRAY_FIXTURE.colorBytes, [25, 25, 25, 255]);
  assert.equal(C13_42_GODRAY_FIXTURE.colorByte, 25);
  assert.equal(C13_42_GODRAY_FIXTURE.colorNormalizedF32, Math.fround(25 / 255));
  assert.notEqual(C13_42_GODRAY_FIXTURE.colorNormalizedF32, Math.fround(0.1));
  assert.equal(C13_42_GODRAY_FIXTURE.thresholds, null);
  assert.equal(C13_42_GODRAY_FIXTURE.providerIntegration.status, "STRUCTURAL");
  assert.equal(C13_42_GODRAY_FIXTURE.providerIntegration.implemented, false);
  assert.equal(C13_42_GODRAY_FIXTURE.config.sampleCount, 64);
  assert.equal(C13_42_GODRAY_FIXTURE.config.occlusionFarCutoff, 0.9);
});

test("camera, finite emitter, and occluder use the reviewed front face", () => {
  const camera = createFixtureCamera(6_378_137);
  assert.deepEqual(camera.forward, [1, 0, 0]);
  assert.deepEqual(camera.up, [0, 0, 1]);
  assert.deepEqual(camera.right, [0, -1, 0]);
  assert.equal(camera.frustum.aspectRatio, 1);
  assert.equal(camera.frustum.fov, Math.PI / 3);
  assert.equal(camera.frustum.near, 1);
  assert.equal(camera.frustum.far, 10_000);
  assert.throws(() =>
    createBoxFromProjectedRectangle({
      camera: { ...camera, right: [0, 1, 0] },
      rectangle: C13_42_GODRAY_FIXTURE.emitter,
      frontDistance: C13_42_GODRAY_FIXTURE.emitter.frontDistance,
      thickness: C13_42_GODRAY_FIXTURE.emitter.thickness,
    }),
  );

  const sun = createFixtureSunPosition(camera);
  assert.equal(
    sun.every((value) => Number.isFinite(value)),
    true,
  );
  assert.equal(sun[0] > camera.position[0], true);

  for (const primitive of [
    [C13_42_GODRAY_FIXTURE.emitter, 9500, 100],
    [C13_42_GODRAY_FIXTURE.occluder, 200, 1],
  ]) {
    const [rectangle, frontDistance, thickness] = primitive;
    const box = createBoxFromProjectedRectangle({
      camera,
      rectangle,
      frontDistance,
      thickness,
    });
    assert.deepEqual(box.axes.columns, [camera.right, camera.up, [-1, -0, -0]]);
    assert.equal(box.corners.length, 8);
    assert.equal(box.frontFaceDistance, frontDistance);
    assert.equal(box.thickness, thickness);
    assert.equal(
      box.corners.every((corner) =>
        corner.every((value) => Number.isFinite(value)),
      ),
      true,
    );
    const projectedCorners = box.corners.map((corner) =>
      projectWorld(camera, corner),
    );
    assert.equal(
      projectedCorners.every(({ uv }) =>
        uv.every((value) => Number.isFinite(value)),
      ),
      true,
    );
    assert.equal(
      convexHullFromProjectedCorners(projectedCorners.map(({ uv }) => uv))
        .length >= 3,
      true,
    );
  }
});

test("fixture record accepts actual projected corners, not declared rectangles", () => {
  const { emitter: emitterCorners, occluder: occluderCorners } =
    projectedFixtureCorners();
  assert.equal(emitterCorners.length, 8);
  assert.equal(occluderCorners.length, 8);
  const record = mainFixtureMasks({
    emitterProjectedCorners: emitterCorners,
    occluderProjectedCorners: occluderCorners,
  });
  assert.equal(record.status, "analytic-only");
  assert.equal(record.thresholds, null);
  assert.equal(record.providerIntegration.status, "STRUCTURAL");
  const emitterHull = convexHullFromProjectedCorners(emitterCorners);
  const occluderHull = convexHullFromProjectedCorners(occluderCorners);
  assert.equal(classifyProjectedHullSample([0.5, 0.5], emitterHull), "inside");
  assert.equal(
    classifyProjectedHullSample([0.45, 0.5], occluderHull),
    "outside",
  );
  assert.equal(
    classifyProjectedHullSample([0.5, 0.5], occluderHull),
    "excluded",
  );
  for (const [key, corners] of [
    [
      "emitterProjectedCorners",
      declaredRectangleCorners(C13_42_GODRAY_FIXTURE.emitter),
    ],
    [
      "occluderProjectedCorners",
      declaredRectangleCorners(C13_42_GODRAY_FIXTURE.occluder),
    ],
  ]) {
    assert.throws(() =>
      deriveFixtureMasks({
        emitterProjectedCorners:
          key === "emitterProjectedCorners" ? corners : emitterCorners,
        occluderProjectedCorners:
          key === "occluderProjectedCorners" ? corners : occluderCorners,
      }),
    );
  }
});

test("f32 march rejects closed-form and wrong-order mutants", () => {
  const { emitter: emitterCorners, occluder: occluderCorners } =
    projectedFixtureCorners();
  const emitterHull = convexHullFromProjectedCorners(emitterCorners);
  const occluderHull = convexHullFromProjectedCorners(occluderCorners);
  let pixelX;
  let pixelY;
  let trace;
  search: for (let y = 0; y < 256; y += 1) {
    for (let x = 0; x < 256; x += 1) {
      const candidate = traceF32Ray(x, y, { emitterHull, occluderHull });
      if (
        candidate.affected &&
        !candidate.excluded &&
        candidate.diagnostics !== null &&
        candidate.taps.filter(({ emitter }) => emitter === "inside").length > 1
      ) {
        pixelX = x;
        pixelY = y;
        trace = candidate;
        break search;
      }
    }
  }
  assert.notEqual(trace, undefined, "expected an analytic affected trace");
  assert.equal(trace.taps.length, 64);

  const f32 = Math.fround;
  const px = f32((pixelX + 0.5) / 256);
  const py = f32((pixelY + 0.5) / 256);
  const scale = f32(f32(0.96) / f32(64));
  const dx = f32(f32(f32(0.75) - px) * scale);
  const dy = f32(f32(f32(0.25) - py) * scale);
  let qx = px;
  let qy = py;
  const closed = [];
  for (let step = 1; step <= 64; step += 1) {
    qx = f32(qx + dx);
    qy = f32(qy + dy);
    assert.equal(close(trace.taps[step - 1].uv.x, qx, 0), true);
    assert.equal(close(trace.taps[step - 1].uv.y, qy, 0), true);
    closed.push({
      x: f32(px + f32(step * dx)),
      y: f32(py + f32(step * dy)),
    });
  }
  assert.equal(
    trace.taps.some(
      ({ uv }, index) => uv.x !== closed[index].x || uv.y !== closed[index].y,
    ),
    true,
    "the closed form must not silently replace the rounded recurrence",
  );
  assert.notDeepEqual(trace.taps[0].uv, { x: px, y: py });
  const expected = orderedF32Diagnostic(
    trace.taps,
    Math.fround(25 / 255),
    C13_42_GODRAY_FIXTURE.config.decay,
  );
  assert.deepEqual(trace.diagnostics, expected);
  assert.notDeepEqual(
    expected,
    orderedF32Diagnostic(
      trace.taps,
      Math.fround(0.1),
      C13_42_GODRAY_FIXTURE.config.decay,
    ),
  );
  assert.notDeepEqual(
    expected,
    orderedF32Diagnostic(trace.taps, Math.fround(25 / 255), 1),
  );
  assert.notDeepEqual(
    expected,
    orderedF32Diagnostic(
      trace.taps,
      Math.fround(25 / 255),
      C13_42_GODRAY_FIXTURE.config.decay,
      true,
    ),
  );
});

test("depth classification retains the far cutoff boundary", () => {
  assert.equal(classifyLinearDepth(9000), "sky");
  assert.equal(classifyLinearDepth(8999.999), "occluded");
  assert.equal(classifyLinearDepth(9200), "sky");
  assert.equal(classifyLinearDepth(200), "occluded");
});

test("linear filtering propagates exclusion from 256 to 512", () => {
  assert.deepEqual(linearSamplerFootprint([0.5, 0.5], 512, 512).texels, [
    { x: 255, y: 255, weight: 0.25 },
    { x: 256, y: 255, weight: 0.25 },
    { x: 255, y: 256, weight: 0.25 },
    { x: 256, y: 256, weight: 0.25 },
  ]);
  const evenComposite = linearSamplerFootprint(
    [(74 + 0.5) / 512, (90 + 0.5) / 512],
    256,
    256,
  );
  assert.deepEqual(evenComposite.texels, [
    { x: 36, y: 44, weight: 0.0625 },
    { x: 37, y: 44, weight: 0.1875 },
    { x: 36, y: 45, weight: 0.1875 },
    { x: 37, y: 45, weight: 0.5625 },
  ]);
  assert.deepEqual(
    linearSamplerFootprint([(75 + 0.5) / 512, (91 + 0.5) / 512], 256, 256)
      .texels,
    [
      { x: 37, y: 45, weight: 0.5625 },
      { x: 38, y: 45, weight: 0.1875 },
      { x: 37, y: 46, weight: 0.1875 },
      { x: 38, y: 46, weight: 0.0625 },
    ],
  );
  for (const [x, y] of [
    [0, 0],
    [511, 511],
  ]) {
    assert.deepEqual(
      linearSamplerFootprint([(x + 0.5) / 512, (y + 0.5) / 512], 256, 256)
        .texels,
      [{ x: x === 0 ? 0 : 255, y: y === 0 ? 0 : 255, weight: 1 }],
    );
  }

  const masks = mainFixtureMasks();
  assert.equal(masks.rayWidth, 256);
  assert.equal(masks.rayHeight, 256);
  assert.equal(nonZero(masks.excludedHalf) > 0, true);
  assert.equal(nonZero(masks.fullExcluded) > 0, true);
  for (let index = 0; index < masks.fullExcluded.length; index += 1) {
    const x = index % 512;
    const y = Math.floor(index / 512);
    const contributors = linearSamplerFootprint(
      [(x + 0.5) / 512, (y + 0.5) / 512],
      256,
      256,
    ).texels;
    const hasExcludedContributor = contributors.some(
      ({ x: halfX, y: halfY }) => masks.excludedHalf[halfY * 256 + halfX] !== 0,
    );
    assert.equal(masks.fullExcluded[index] !== 0, hasExcludedContributor);
  }
  const margin = C13_42_GODRAY_FIXTURE.rounding.marginUV;
  const positiveHull = [
    [0, 0.1],
    [0.75, 0.1],
    [0.75, 0.9],
    [0, 0.9],
  ];
  const negativeLeftEdge = 2 * margin;
  const negativeHull = [
    [negativeLeftEdge, 0.1],
    [0.75, 0.1],
    [0.75, 0.9],
    [negativeLeftEdge, 0.9],
  ];
  const positiveSlackAtMargin = margin - 0;
  const negativeSlackAtMargin = margin - negativeLeftEdge;
  assert.equal(positiveSlackAtMargin, margin);
  assert.equal(negativeSlackAtMargin, -margin);
  assert.equal(
    classifyProjectedHullSample([margin, 0.5], positiveHull),
    "excluded",
  );
  assert.equal(
    classifyProjectedHullSample([nextUp(margin), 0.5], positiveHull),
    "inside",
  );
  assert.equal(
    classifyProjectedHullSample([margin, 0.5], negativeHull),
    "excluded",
  );
  assert.equal(
    classifyProjectedHullSample([nextDown(margin), 0.5], negativeHull),
    "outside",
  );
});

test("causal controls retain the reviewed topology", () => {
  const main = mainFixtureMasks();
  const corners = projectedFixtureCorners();
  const emitterOnly = deriveFixtureMasks({
    emitterProjectedCorners: corners.emitter,
    control: "emitter-only",
  });
  const farDepth = deriveFixtureMasks({
    ...defaultMaskInput("far-depth"),
  });
  const fullCover = deriveFixtureMasks({
    emitterProjectedCorners: corners.emitter,
    occluderProjectedCorners: corners.emitter,
    control: "full-cover",
  });
  const exposureZero = deriveFixtureMasks({
    ...defaultMaskInput("exposure-zero"),
  });

  assert.equal(nonZero(main.affectedHalf) > 0, true);
  assert.equal(nonZero(main.deficitHalf) > 0, true);
  assert.equal(nonZero(emitterOnly.affectedHalf), 0);
  assert.equal(nonZero(emitterOnly.deficitHalf), 0);
  assert.equal(nonZero(farDepth.affectedHalf), 0);
  assert.equal(nonZero(farDepth.deficitHalf), 0);
  assert.equal(
    nonZero(fullCover.affectedHalf) > nonZero(main.affectedHalf),
    true,
  );
  assert.equal(
    nonZero(fullCover.deficitHalf) > nonZero(main.deficitHalf),
    true,
  );
  assert.deepEqual(exposureZero.affectedHalf, main.affectedHalf);
  assert.equal(nonZero(exposureZero.mainHalf), 0);
  assert.equal(nonZero(exposureZero.deficitHalf), 0);
  assert.equal(nonZero(exposureZero.fullDeficit), 0);
});

test("invalid backing sizes and nonfinite hulls are structural failures", () => {
  const valid = defaultMaskInput();
  for (const backingWidth of [511, 513, Infinity, NaN]) {
    assert.throws(() => deriveFixtureMasks({ ...valid, backingWidth }));
  }
  for (const backingHeight of [511, 513, -512, NaN]) {
    assert.throws(() => deriveFixtureMasks({ ...valid, backingHeight }));
  }
  for (const badPoint of [
    [NaN, 0.5],
    [Infinity, 0.5],
    [0.5, -Infinity],
  ]) {
    assert.throws(() =>
      convexHullFromProjectedCorners([
        badPoint,
        ...declaredRectangleCorners(C13_42_GODRAY_FIXTURE.emitter).slice(1),
      ]),
    );
  }
});

test("f16 amplitude remains an explicit refusal", () => {
  assert.throws(() => refuseF16Amplitude(), /f16 amplitude/u);
  assert.throws(() =>
    deriveFixtureMasks({ ...defaultMaskInput(), amplitudeFormat: "f16" }),
  );
});

// ---------------------------------------------------------------------------
// C13-42f — capture-side geometry: making `metrics.godRay` resolvable.
//
// `analyzeGodRayImages` produces the god-ray GEOMETRY metrics only when the
// caller supplies six masks at capture resolution, a projected emitter in
// pixels, and an expected shaft direction. The C13-42 probe supplied none of
// them, so `metrics.godRay` was `null` on every cell it has ever produced and
// four of the contract's own metric fields could not be derived from any
// receipt. These tests run the derivation over a SYNTHETIC capture whose
// geometry is known by construction — a PNG this file encodes, with a shaft
// drawn at a chosen bearing from a chosen emitter — so the verdicts are
// checkable without a browser.
//
// Not covered here, and OWED to the Edge leg: that the probe's own cell
// construction reaches these functions on a real page. That is a live
// `page.evaluate` against `WebGPUGodRayEffect`, and no Node spec can stand in
// for it. `_lane-out/EDGE_RECIPE_CURUMO.md` is the measurement.
// ---------------------------------------------------------------------------

const CAPTURE = Object.freeze({ width: 64, height: 48 });
const SYNTHETIC_SUN = Object.freeze({ u: 0.8, v: 0.2 });

function flatCapture(value, width = CAPTURE.width, height = CAPTURE.height) {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = value;
    pixels[index * 4 + 1] = value;
    pixels[index * 4 + 2] = value;
    pixels[index * 4 + 3] = 255;
  }
  return pixels;
}

/**
 * Brighten every pixel whose bearing from `emitter` is within `halfAngle` of
 * `direction`. That is a shaft with a KNOWN mean bearing, which is the only
 * property these tests read out of it.
 */
function wedgeCapture(base, emitter, direction, halfAngle, gain) {
  const pixels = base.slice();
  for (let y = 0; y < CAPTURE.height; y += 1) {
    for (let x = 0; x < CAPTURE.width; x += 1) {
      const bearing = Math.atan2(y - emitter.y, x - emitter.x);
      const offset = bearing - direction;
      const separation = Math.abs(
        Math.atan2(Math.sin(offset), Math.cos(offset)),
      );
      if (separation > halfAngle) continue;
      const o = (y * CAPTURE.width + x) * 4;
      pixels[o] = Math.min(255, pixels[o] + gain);
      pixels[o + 1] = Math.min(255, pixels[o + 1] + gain);
      pixels[o + 2] = Math.min(255, pixels[o + 2] + gain);
    }
  }
  return pixels;
}

function decodedCapture(pixels) {
  return decodePng(
    Buffer.from(encodeRgbaPng(pixels, CAPTURE.width, CAPTURE.height)),
  );
}

function syntheticGeometry(
  fixtureModule = {
    projectedEmitterPixels,
    deriveGodRayCaptureMasks,
    expectedShaftDirectionRadians,
  },
) {
  const emitter = fixtureModule.projectedEmitterPixels({
    sunScreenU: SYNTHETIC_SUN.u,
    sunScreenV: SYNTHETIC_SUN.v,
    width: CAPTURE.width,
    height: CAPTURE.height,
  });
  const derived = fixtureModule.deriveGodRayCaptureMasks({
    width: CAPTURE.width,
    height: CAPTURE.height,
    emitter,
    sunUsable: true,
  });
  const direction = fixtureModule.expectedShaftDirectionRadians({
    width: CAPTURE.width,
    height: CAPTURE.height,
    emitter,
    valid: derived.masks.valid,
  });
  return { emitter, derived, direction };
}

function godRayMetricsFor(pixels, geometry) {
  const offImage = decodedCapture(flatCapture(30));
  const onImage = decodedCapture(pixels);
  return computeC13_42CellMetrics({
    kind: "godRay",
    offImage,
    onImage,
    repeatOffImage: offImage,
    repeatOnImage: onImage,
    frames: [offImage.data, onImage.data, offImage.data, onImage.data],
    ...(geometry === null
      ? {}
      : {
          masks: geometry.derived.masks,
          emitter: { x: geometry.emitter.x, y: geometry.emitter.y },
          expectedDirectionRadians: geometry.direction.radians,
        }),
  });
}

test("capture masks cover the capture, mark the border, and name what nothing publishes", () => {
  const emitter = projectedEmitterPixels({
    sunScreenU: SYNTHETIC_SUN.u,
    sunScreenV: SYNTHETIC_SUN.v,
    width: CAPTURE.width,
    height: CAPTURE.height,
  });
  assert.equal(emitter.x, SYNTHETIC_SUN.u * CAPTURE.width);
  assert.equal(emitter.y, SYNTHETIC_SUN.v * CAPTURE.height);
  assert.equal(emitter.insideFrame, true);

  const derived = deriveGodRayCaptureMasks({
    width: CAPTURE.width,
    height: CAPTURE.height,
    emitter,
    sunUsable: true,
  });
  const pixels = CAPTURE.width * CAPTURE.height;
  for (const name of [
    "valid",
    "emitter",
    "occluder",
    "ground",
    "behindCamera",
    "border",
  ]) {
    assert.equal(derived.masks[name].length, pixels, `${name} mask length`);
  }
  // Every captured pixel is measurable; the ring is marked, not removed, or
  // `leakageEnergy.border` could never be anything but zero.
  assert.equal(
    derived.masks.valid.reduce((total, value) => total + value, 0),
    pixels,
  );
  const ring =
    pixels -
    (CAPTURE.width - 2 * CAPTURE_BORDER_TEXELS) *
      (CAPTURE.height - 2 * CAPTURE_BORDER_TEXELS);
  assert.equal(
    derived.masks.border.reduce((total, value) => total + value, 0),
    ring,
  );
  assert.equal(derived.provenance.borderPixels, ring);
  // A usable sun attributes nothing to a behind-camera sun.
  assert.equal(
    derived.masks.behindCamera.reduce((total, value) => total + value, 0),
    0,
  );
  // The emitter mask is the sampler's footprint, so at most the four texels a
  // bilinear tap reads.
  assert.equal(derived.provenance.emitterTexels > 0, true);
  assert.equal(derived.provenance.emitterTexels <= 4, true);
  // The gap is NAMED, not silent.
  assert.deepEqual(derived.provenance.structurallyEmpty, [
    "ground",
    "occluder",
  ]);
  assert.equal(typeof derived.provenance.structurallyEmptyReason, "string");
  assert.equal(
    derived.masks.ground.reduce((total, value) => total + value, 0),
    0,
  );

  const unusable = deriveGodRayCaptureMasks({
    width: CAPTURE.width,
    height: CAPTURE.height,
    emitter,
    sunUsable: false,
  });
  assert.equal(
    unusable.masks.behindCamera.reduce((total, value) => total + value, 0),
    pixels,
  );

  // A sun that projects off-screen is a legal state, not a refusal.
  const offscreen = deriveGodRayCaptureMasks({
    width: CAPTURE.width,
    height: CAPTURE.height,
    emitter: projectedEmitterPixels({
      sunScreenU: 1.6,
      sunScreenV: -0.3,
      width: CAPTURE.width,
      height: CAPTURE.height,
    }),
    sunUsable: true,
  });
  assert.equal(offscreen.provenance.emitterInsideFrame, false);
  assert.equal(offscreen.provenance.emitterTexels, 0);

  // A supplied mask of the wrong size is refused rather than padded.
  assert.throws(
    () =>
      deriveGodRayCaptureMasks({
        width: CAPTURE.width,
        height: CAPTURE.height,
        emitter,
        sunUsable: true,
        groundMask: new Uint8Array(pixels - 1),
      }),
    /groundMask must cover exactly/u,
  );
  // A supplied mask IS used, and stops being named as structurally empty.
  const supplied = new Uint8Array(pixels);
  supplied[0] = 1;
  const withGround = deriveGodRayCaptureMasks({
    width: CAPTURE.width,
    height: CAPTURE.height,
    emitter,
    sunUsable: true,
    groundMask: supplied,
  });
  assert.equal(withGround.masks.ground[0], 1);
  assert.deepEqual(withGround.provenance.structurallyEmpty, ["occluder"]);
});

test("the expected shaft direction is a circular mean that refuses when none exists", () => {
  const corner = projectedEmitterPixels({
    sunScreenU: SYNTHETIC_SUN.u,
    sunScreenV: SYNTHETIC_SUN.v,
    width: CAPTURE.width,
    height: CAPTURE.height,
  });
  const centre = projectedEmitterPixels({
    sunScreenU: 0.5,
    sunScreenV: 0.5,
    width: CAPTURE.width,
    height: CAPTURE.height,
  });
  const cornerDirection = expectedShaftDirectionRadians({
    width: CAPTURE.width,
    height: CAPTURE.height,
    emitter: corner,
  });
  const centreDirection = expectedShaftDirectionRadians({
    width: CAPTURE.width,
    height: CAPTURE.height,
    emitter: centre,
  });
  assert.equal(cornerDirection.resolvable, true);
  assert.equal(Number.isFinite(cornerDirection.radians), true);
  assert.equal(
    cornerDirection.validPixels,
    CAPTURE.width * CAPTURE.height,
    "with no valid mask every pixel away from the emitter is counted",
  );
  // ORIENTATION, pinned against geometry this file computes without the
  // estimator. Over a rectangle the uniform circular mean sits close to the
  // plain bearing from the emitter to the frame's centroid — 2.4635 rad
  // against 2.4981 rad for this emitter — so a closed-form bearing is a valid
  // independent check of the sign, which magnitude-only assertions are not.
  // Review finding F1 (Baran, 2026-09-13): a y-mirror of the accumulation
  // (`sumSin -= dy * inverseRadius`) left the whole suite at 16/16, because the
  // synthetic shaft is drawn along the module's OWN published direction and
  // follows any transformation of it. The mirrored value is -2.4635 rad, an
  // angular distance of ~1.32 rad from the bearing below, which this catches.
  const centroidBearing = Math.atan2(
    CAPTURE.height / 2 - corner.y,
    CAPTURE.width / 2 - corner.x,
  );
  const orientationError = Math.abs(
    Math.atan2(
      Math.sin(cornerDirection.radians - centroidBearing),
      Math.cos(cornerDirection.radians - centroidBearing),
    ),
  );
  assert.equal(
    orientationError < 0.1,
    true,
    `the expectation must point where the geometry does: ${cornerDirection.radians} vs ${centroidBearing}`,
  );
  // An emitter near a corner points into the frame; one at the centre is
  // surrounded, so its mean carries far less direction. The assertion is the
  // ORDERING, which follows from the geometry, not a recorded magnitude.
  assert.equal(
    centreDirection.conditioning < cornerDirection.conditioning,
    true,
  );

  // Two valid pixels on exactly opposite bearings cancel exactly: there is no
  // mean bearing, and the function says so instead of returning atan2(0, 0).
  const width = 5;
  const height = 5;
  const valid = new Uint8Array(width * height);
  valid[2 * width + 0] = 1;
  valid[2 * width + 4] = 1;
  const cancelled = expectedShaftDirectionRadians({
    width,
    height,
    emitter: { x: 2, y: 2 },
    valid,
  });
  assert.equal(cancelled.resolvable, false);
  assert.equal(cancelled.radians, null);
  assert.match(cancelled.reason, /symmetrically/u);

  // A valid region holding only the emitter's own pixel has nothing to bear on.
  const alone = new Uint8Array(width * height);
  alone[2 * width + 2] = 1;
  const empty = expectedShaftDirectionRadians({
    width,
    height,
    emitter: { x: 2, y: 2 },
    valid: alone,
  });
  assert.equal(empty.resolvable, false);
  assert.equal(empty.validPixels, 0);
});

test("a synthetic capture makes metrics.godRay resolvable and discriminates shaft direction", () => {
  const geometry = syntheticGeometry();
  assert.equal(geometry.direction.resolvable, true);

  // The before-state, pinned: the same capture with no geometry supplied
  // produces a PASSING cell whose god-ray metrics are simply absent. That is
  // what every C13-42 cell did before this wiring, and it is why the four
  // geometry threshold keys could not be derived from any receipt.
  const bare = godRayMetricsFor(
    wedgeCapture(
      flatCapture(30),
      geometry.emitter,
      geometry.direction.radians,
      0.3,
      120,
    ),
    null,
  );
  assert.equal(bare.godRay, null);
  assert.equal(bare.ok, true);

  const aligned = godRayMetricsFor(
    wedgeCapture(
      flatCapture(30),
      geometry.emitter,
      geometry.direction.radians,
      0.3,
      120,
    ),
    geometry,
  );
  assert.notEqual(aligned.godRay, null);
  assert.equal(aligned.godRay.ok, true);
  assert.equal(aligned.ok, true);
  assert.equal(aligned.godRay.shaftSupportFraction > 0, true);
  assert.equal(Number.isFinite(aligned.godRay.angularWidthRadians), true);
  // A shaft drawn along the expectation is aligned with it.
  assert.equal(aligned.godRay.radialAlignmentAngleErrorRadians < 0.1, true);
  // The border ring is inside `valid`, so energy that reaches the frame edge is
  // attributed instead of silently dropped.
  assert.equal(aligned.godRay.leakageEnergy.border > 0, true);

  const opposed = godRayMetricsFor(
    wedgeCapture(
      flatCapture(30),
      geometry.emitter,
      geometry.direction.radians + Math.PI,
      0.3,
      120,
    ),
    geometry,
  );
  assert.notEqual(opposed.godRay, null);
  assert.equal(opposed.godRay.ok, true);
  // The same apparatus, a shaft pointing the other way: the error is half a
  // turn. A metric that could not tell these apart would be worthless.
  assert.equal(opposed.godRay.radialAlignmentAngleErrorRadians > 3, true);
});

test("the probe's geometry builder publishes all three inputs or none", () => {
  const onImage = decodedCapture(flatCapture(40));
  const usable = buildGodRayGeometry(
    [
      {
        enabled: true,
        sunScreenU: SYNTHETIC_SUN.u,
        sunScreenV: SYNTHETIC_SUN.v,
        sunUnusable: 0,
      },
    ],
    onImage,
  );
  assert.deepEqual(Object.keys(usable.inputs).sort(), [
    "emitter",
    "expectedDirectionRadians",
    "masks",
  ]);
  assert.equal(usable.record.resolvable, true);
  assert.equal(Number.isFinite(usable.record.expectedDirectionRadians), true);
  assert.equal(Number.isFinite(usable.record.directionConditioning), true);
  assert.deepEqual(usable.record.maskProvenance.structurallyEmpty, [
    "ground",
    "occluder",
  ]);

  // No effect on the page: no inputs, a stated reason, and a cell that keeps
  // the metrics it already had rather than acquiring a failing one.
  const absent = buildGodRayGeometry([null], onImage);
  assert.equal(absent.inputs, null);
  assert.equal(absent.record.resolvable, false);
  assert.match(absent.record.reason, /no god-ray effect/u);

  const nonFinite = buildGodRayGeometry(
    [{ enabled: true, sunScreenU: null, sunScreenV: 0.2, sunUnusable: 0 }],
    onImage,
  );
  assert.equal(nonFinite.inputs, null);
  assert.match(nonFinite.record.reason, /no finite sun screen position/u);

  // An unusable sun still measures — it attributes the whole frame to the
  // behind-camera mask, which is a verdict, not an absence.
  const unusable = buildGodRayGeometry(
    [
      {
        enabled: true,
        sunScreenU: SYNTHETIC_SUN.u,
        sunScreenV: SYNTHETIC_SUN.v,
        sunUnusable: 1,
      },
    ],
    onImage,
  );
  assert.equal(unusable.record.resolvable, true);
  assert.equal(unusable.record.maskProvenance.sunUsable, false);
  assert.equal(
    unusable.inputs.masks.behindCamera.reduce(
      (total, value) => total + value,
      0,
    ),
    CAPTURE.width * CAPTURE.height,
  );
});

// ---------------------------------------------------------------------------
// Inertness mutants. Each leaves every symbol, export and call site in place
// and changes only what the function PUBLISHES, then requires the verdict above
// to flip. A mutant that the suite survives means the assertion was not reading
// the thing it claims to read.
// ---------------------------------------------------------------------------

const FIXTURE_URL = new URL("./lib/c13-42-godray-fixture.mjs", import.meta.url);

async function importMutatedFixture(from, to) {
  // `* text=auto` with `core.autocrlf=true` means the working-tree copy may
  // arrive with either ending, so anchors are matched against a normalized
  // copy rather than against a bare "\n".
  const source = (await readFile(FIXTURE_URL, "utf8")).replace(/\r\n/gu, "\n");
  const occurrences = source.split(from).length - 1;
  assert.equal(occurrences, 1, `mutation anchor is not unique: ${from}`);
  const directory = mkdtempSync(path.join(tmpdir(), "c13-42f-mutant-"));
  const file = path.join(directory, "mutant.mjs");
  writeFileSync(file, source.replace(from, to));
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("MUTANT: a shaft direction turned half a turn fails the alignment verdict", async () => {
  const mutated = await importMutatedFixture(
    "    radians: Math.atan2(sumSin, sumCos),",
    "    radians: Math.atan2(sumSin, sumCos) + Math.PI,",
  );
  const geometry = syntheticGeometry(mutated);
  assert.equal(geometry.direction.resolvable, true);
  const aligned = godRayMetricsFor(
    wedgeCapture(
      flatCapture(30),
      geometry.emitter,
      // The shaft is still drawn where the UNMUTATED expectation points, so
      // only the published expectation moved.
      expectedShaftDirectionRadians({
        width: CAPTURE.width,
        height: CAPTURE.height,
        emitter: geometry.emitter,
        valid: geometry.derived.masks.valid,
      }).radians,
      0.3,
      120,
    ),
    geometry,
  );
  assert.notEqual(aligned.godRay, null);
  assert.equal(
    aligned.godRay.radialAlignmentAngleErrorRadians < 0.1,
    false,
    "the live verdict must not survive a half-turn expectation",
  );
});

test("MUTANT: masks that do not cover the capture fail the god-ray verdict", async () => {
  const mutated = await importMutatedFixture(
    "    masks: {\n      valid,",
    "    masks: {\n      valid: valid.subarray(0, pixels - 1),",
  );
  // Only the MASKS come from the mutant. The emitter and the expected
  // direction come from the live module, so the single thing this mutant
  // changes is whether the masks cover the capture.
  const live = syntheticGeometry();
  const geometry = {
    emitter: live.emitter,
    direction: live.direction,
    derived: mutated.deriveGodRayCaptureMasks({
      width: CAPTURE.width,
      height: CAPTURE.height,
      emitter: live.emitter,
      sunUsable: true,
    }),
  };
  assert.equal(
    geometry.derived.masks.valid.length,
    CAPTURE.width * CAPTURE.height - 1,
    "the mutant must actually shorten the mask",
  );
  const aligned = godRayMetricsFor(
    wedgeCapture(
      flatCapture(30),
      geometry.emitter,
      geometry.direction.radians,
      0.3,
      120,
    ),
    geometry,
  );
  assert.notEqual(aligned.godRay, null);
  assert.equal(
    aligned.godRay.ok,
    false,
    "a short mask must not be accepted as coverage",
  );
  assert.match(aligned.godRay.reason, /valid mask/u);
});
