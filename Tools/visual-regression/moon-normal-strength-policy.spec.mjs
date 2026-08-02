// C12-35 L0 — behavioral contract for the backend-neutral Moon normal-map
// strength and demand policy.

import assert from "node:assert/strict";
import test from "node:test";

import resolveMoonNormalMapStrength from "../../packages/engine/Source/Scene/resolveMoonNormalMapStrength.js";

// Moon's Material construction performs browser-type instanceof checks. The
// policy test does not create any browser resources, but these constructors
// must exist for the real Moon class to be instantiated under Node.
for (const name of [
  "HTMLCanvasElement",
  "HTMLVideoElement",
  "ImageData",
  "HTMLImageElement",
  "ImageBitmap",
  "OffscreenCanvas",
]) {
  globalThis[name] ??= class {};
}

const [{ default: Moon }, { default: Cartesian3 }, { default: JulianDate }] =
  await Promise.all([
    import("../../packages/engine/Source/Scene/Moon.js"),
    import("../../packages/engine/Source/Core/Cartesian3.js"),
    import("../../packages/engine/Source/Core/JulianDate.js"),
  ]);

const normalUrl = "https://example.invalid/moon-normal.png";
const cases = [
  ["undefined defaults to one", undefined, 1.0],
  ["null defaults to one", null, 1.0],
  ["zero stays zero", 0.0, 0.0],
  ["a finite positive value stays unchanged", 2.5, 2.5],
  ["a negative value resolves to zero", -0.25, 0.0],
  ["NaN resolves to zero", Number.NaN, 0.0],
  ["positive infinity resolves to zero", Number.POSITIVE_INFINITY, 0.0],
  ["negative infinity resolves to zero", Number.NEGATIVE_INFINITY, 0.0],
];

function createFrameState(featureRenderer) {
  return {
    time: JulianDate.fromIso8601("2026-08-02T00:00:00Z"),
    atmosphericConditions: {
      lighting: {
        enableMoonPhase: false,
        enableLunarNormalMap: true,
        enableLunarBRDF: false,
        enableOppositionSurge: false,
        enableMoonSkyWash: false,
      },
    },
    context: {
      uniformState: {
        sunDirectionWC: new Cartesian3(1.0, 0.0, 0.0),
      },
      getFeatureRenderer() {
        return featureRenderer;
      },
    },
    camera: {
      positionWC: new Cartesian3(7000000.0, 0.0, 0.0),
    },
    commandList: [],
    skyAtmosphereVisible: false,
  };
}

function updateThroughBackend(strength, backend) {
  const moon = new Moon();
  moon.normalMapUrl = normalUrl;
  moon.normalMapStrength = strength;

  let webgpuStrength;
  const featureRenderer =
    backend === "webgpu"
      ? {
          update(_moon, frameState) {
            // This is the exact backend-neutral publication consumed by
            // WebGPUEnvironmentRenderer's normalStrength uniform packer.
            webgpuStrength = frameState.moonNormalMapStrength;
          },
        }
      : undefined;
  const frameState = createFrameState(featureRenderer);

  let webglDemand;
  moon._updateWebGLMoonTextures = function (_context, demand) {
    webglDemand = demand;
    return false;
  };
  moon._ellipsoidPrimitive.update = function () {};
  moon.update(frameState);

  return {
    published: frameState.moonNormalMapStrength,
    consumed:
      backend === "webgpu"
        ? webgpuStrength
        : moon._ellipsoidPrimitive.lunarNormalStrength,
    demand: webglDemand,
  };
}

test("resolver returns only finite nonnegative strengths", () => {
  for (const [label, input, expected] of cases) {
    const resolved = resolveMoonNormalMapStrength(normalUrl, true, input);
    assert.equal(resolved, expected, label);
    assert.equal(Number.isFinite(resolved), true, `${label}: must be finite`);
    assert.ok(resolved >= 0.0, `${label}: must be nonnegative`);
  }
});

test("toggle-off and absent-map gates resolve to zero", () => {
  assert.equal(resolveMoonNormalMapStrength(normalUrl, false, 4.0), 0.0);
  assert.equal(resolveMoonNormalMapStrength(undefined, true, 4.0), 0.0);
  assert.equal(resolveMoonNormalMapStrength(null, true, 4.0), 0.0);
});

test("WebGL and WebGPU receive the same resolved scalar", () => {
  for (const [label, input, expected] of cases) {
    const webgl = updateThroughBackend(input, "webgl");
    const webgpu = updateThroughBackend(input, "webgpu");

    assert.equal(webgl.published, expected, `${label}: WebGL publication`);
    assert.equal(webgl.consumed, expected, `${label}: WebGL consumer`);
    assert.equal(webgpu.published, expected, `${label}: WebGPU publication`);
    assert.equal(webgpu.consumed, expected, `${label}: WebGPU consumer`);
    assert.equal(webgl.consumed, webgpu.consumed, `${label}: backend parity`);
    assert.equal(webgl.demand, expected > 0.0, `${label}: source demand`);
    assert.equal(Number.isFinite(webgl.consumed), true);
    assert.ok(webgl.consumed >= 0.0);
  }
});
