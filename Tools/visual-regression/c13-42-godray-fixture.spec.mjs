import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  C13_42_GODRAY_FIXTURE,
  classifyLinearDepth,
  classifyProjectedHullSample,
  convexHullFromProjectedCorners,
  createBoxFromProjectedRectangle,
  createFixtureCamera,
  createFixtureSunPosition,
  deriveFixtureMasks,
  linearSamplerFootprint,
  projectWorld,
  refuseF16Amplitude,
  traceF32Ray,
} from "./lib/c13-42-godray-fixture.mjs";

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

test("production GodRay WGSL keeps f32 step, depth-gate, and additive topology", async () => {
  const [generate, generateF16, composite, compositeF16] = await Promise.all([
    readFile(generateUrl, "utf8"),
    readFile(generateF16Url, "utf8"),
    readFile(compositeUrl, "utf8"),
    readFile(compositeF16Url, "utf8"),
  ]);

  for (const source of [generate, generateF16]) {
    assert.equal(
      count(
        source,
        /let deltaUV = \(sunUV - in\.uv\) \* \(density \/ f32\(sampleCount\)\);/gu,
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
    assert.equal(count(source, /textureSampleLevel\(\s*sceneColorTex,/gu), 1);
    assert.equal(
      source.indexOf("stepUV = stepUV + deltaUV;") <
        source.indexOf("sceneDepthTex, texSampler, stepUV"),
      true,
    );
  }
  assert.match(
    generate,
    /illumination = illumination \+ sample \* \(weight \* illumDecay\);/u,
  );
  assert.match(generate, /illumDecay = illumDecay \* decay;/u);
  assert.match(generateF16, /var illumination: vec3<f16>/u);
  assert.match(generateF16, /f16\(weight \* illumDecay\)/u);
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
