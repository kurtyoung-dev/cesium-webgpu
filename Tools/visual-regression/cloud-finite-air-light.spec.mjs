// @purpose Verifies finite spectral cloud air transport and its append-only atmosphere inputs.
// @status ACTIVE
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLOUD_AIR_LIGHT_OFFSET,
  CLOUD_AIR_LIGHT_FLOATS,
  readPublishedAtmosphereParams,
  writeCloudAirLightUniforms,
} from "../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudAirLight.ts";
import {
  compileFunction,
  stripComments,
  vec as vec3,
} from "./lib/wgsl-mini-eval.mjs";
import {
  defaultVariant,
  hiVariant,
  ShaderDefineHi,
} from "./lib/wgsl-variant.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const dir = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Environment",
);
const raw = fs.readFileSync(path.join(dir, "CloudAirLight.wgsl"), "utf8");
const selected = stripComments(defaultVariant(raw));
const solar = stripComments(
  fs.readFileSync(path.join(dir, "CloudSolarLighting.wgsl"), "utf8"),
);
const functions = {
  exp: Math.exp,
  sqrt: Math.sqrt,
  pow: Math.pow,
  acos: Math.acos,
  asin: Math.asin,
};
const globals = { PI: Math.PI, __functions: functions };
for (const name of [
  "cloudSolarDiskVisibility",
  "cloudAirSegmentWeight",
  "cloudAirRayleighPhase",
  "cloudAirMiePhase",
  "cloudAirSunColumn",
  "cloudAirSolarVisibility",
]) {
  functions[name] = compileFunction(
    name === "cloudSolarDiskVisibility" ? solar : selected,
    name,
    globals,
  );
}

test("the atmosphere row appends without changing the old cloud uniform prefix", () => {
  assert.equal(CLOUD_AIR_LIGHT_OFFSET, 180);
  assert.equal(CLOUD_AIR_LIGHT_FLOATS, 16);
  const data = new Float32Array(200).fill(123);
  const params = new Float32Array(24);
  params.set([6378137, 6537590.5, 8500, 1200, 0.758, 50]);
  params.set([5.5e-6, 13e-6, 22.4e-6], 8);
  params.set([21e-6, 21e-6, 21e-6], 12);
  params.set([0.65e-6, 1.881e-6, 0.085e-6], 20);
  const end = writeCloudAirLightUniforms(data, 180, undefined, params, 0.5);
  assert.equal(end, 196);
  assert.ok(data.subarray(0, 180).every((x) => x === 123));
  assert.ok(data.subarray(196).every((x) => x === 123));
  assert.deepEqual(Array.from(data.subarray(180, 184)), [
    params[8],
    params[9],
    params[10],
    params[2],
  ]);
  assert.deepEqual(Array.from(data.subarray(188, 192)), [
    params[20],
    params[21],
    params[22],
    params[4],
  ]);
  assert.equal(data[192], 25);
  assert.equal(data[193], 1);
  assert.equal(data[194], params[1] - params[0]);
  assert.notEqual(data[194], 111000);
  writeCloudAirLightUniforms(
    data,
    180,
    { lighting: { enableSunLight: false } },
    params,
    1,
  );
  assert.equal(data[192], 0);
});

test("missing or invalid published data gives finite local inputs without waiting", () => {
  const data = new Float32Array(196);
  const conditions = {
    scattering: {
      rayleighCoefficient: { x: 0, y: 0, z: 0 },
      mieCoefficient: { x: 0, y: 0, z: 0 },
      rayleighScaleHeight: 9000,
      mieScaleHeight: 1400,
      mieAnisotropy: 0,
    },
    skyAtmosphere: { lightIntensity: 20 },
  };
  writeCloudAirLightUniforms(data, 180, conditions, undefined, 1);
  assert.equal(data[180], 0);
  assert.equal(data[183], 9000);
  assert.equal(data[187], 1400);
  assert.equal(data[191], 0);
  assert.equal(data[192], 20);
  assert.equal(data[193], 0);
  assert.ok(data.every(Number.isFinite));
  writeCloudAirLightUniforms(
    data,
    180,
    undefined,
    new Float32Array(24).fill(NaN),
    1,
  );
  assert.equal(data[193], 0);
  assert.ok(data.every(Number.isFinite));
  writeCloudAirLightUniforms(data, 180, undefined, Object.create(null), 1);
  assert.equal(data[193], 0);
  assert.ok(data.every(Number.isFinite));
});

test("the shipped cell integral obeys Beer-Lambert and homogeneous partition invariance", () => {
  for (const sigma of [0, 1e-14, 1e-6, 2e-5, 0.01]) {
    for (const distance of [0, 1, 1000, 100000]) {
      const weight = functions.cloudAirSegmentWeight(sigma, distance);
      const expected =
        sigma === 0 ? distance : -Math.expm1(-sigma * distance) / sigma;
      assert.ok(Number.isFinite(weight) && weight >= 0);
      assert.ok(Math.abs(weight - expected) <= Math.max(1e-9, expected * 1e-9));
      const left = distance * 0.3;
      const partitioned =
        functions.cloudAirSegmentWeight(sigma, left) +
        Math.exp(-sigma * left) *
          functions.cloudAirSegmentWeight(sigma, distance - left);
      assert.ok(
        Math.abs(weight - partitioned) <= Math.max(1e-9, expected * 1e-9),
      );
    }
  }
});

test("the Rayleigh and Mie phase functions preserve angular normalization", () => {
  for (const g of [0, 0.758, -0.3]) {
    const count = 8192;
    let rayleigh = 0;
    let mie = 0;
    for (let i = 0; i < count; i++) {
      const cosine = -1 + ((i + 0.5) * 2) / count;
      rayleigh +=
        (functions.cloudAirRayleighPhase(cosine) * 4 * Math.PI) / count;
      mie += (functions.cloudAirMiePhase(cosine, g) * 4 * Math.PI) / count;
    }
    assert.ok(Math.abs(rayleigh - 1) < 1e-6);
    assert.ok(Math.abs(mie - 1) < 1e-5);
  }
});

test("local solar visibility includes planet shadow and the elevated horizon", () => {
  const radius = 6371000;
  assert.equal(functions.cloudAirSolarVisibility(0, 1, radius), 1);
  assert.equal(functions.cloudAirSolarVisibility(0, -1, radius), 0);
  assert.ok(
    Math.abs(functions.cloudAirSolarVisibility(0, 0, radius) - 0.5) < 1e-12,
  );
  assert.equal(functions.cloudAirSolarVisibility(10000, -0.03, radius), 1);
  for (const height of [0, 2750, 13000, 85000]) {
    for (const cosine of [-1, -0.02, 0, 0.02, 1]) {
      const column = functions.cloudAirSunColumn(height, cosine, 8500, radius);
      assert.ok(Number.isFinite(column) && column >= 0);
    }
  }
});

test("physical transport stays outside density and preview recipes omit the added work", () => {
  const preview = hiVariant(raw, ShaderDefineHi.CLOUD_LIGHTING_PREVIEW);
  assert.doesNotMatch(
    preview,
    /cloudFiniteAirTransport|cloudAirSunTransmittance|for\s*\(/,
  );
  assert.match(selected, /for \(var i = 0u; i < 8u;/);
  assert.doesNotMatch(
    selected,
    /cloudDensity|lightMarch|cloudSampleSkyViewLut/,
  );
  assert.match(selected, /baked\.a > 0\.5/);
  assert.match(selected, /cloud\.airLightControl\.z/);
  assert.match(selected, /result\.radiance \+= result\.transmittance/);
  assert.match(
    selected,
    /weightedRadiance \* air\.transmittance \+ opacity \* air\.radiance/,
  );
  assert.match(
    selected,
    /cloudToneMappedRadiance\(transported, opacity, cloud\.exposure\)/,
  );
  const march = fs.readFileSync(
    path.join(dir, "ProceduralClouds.wgsl"),
    "utf8",
  );
  assert.match(
    march,
    /hazed = cloudPhysicalAerialColor\(weightedColor, opacity, hazed,/,
  );
  assert.doesNotMatch(
    march,
    /cloudSampleSkyViewLut\(visibleUp, rayDir, sunDir\)/,
  );
});

// ── R-12 contract: the selected physical aerial composite ───────────────────
//
// Replaces, on R-12's terms (R-2026-10-22-12), the three retired source-shape
// expectations named in 3463's ruling request: the physical-mode LDR blend
// `hazed = mix(toneMapped, farTarget, aerial)` read by cloud-aerial-path-length
// (MUTANT 0b), cloud-density-domain and cloud-curved-air-transport. The
// physical branch now composes in HDR, so this contract EXECUTES the shipped
// `cloudPhysicalAerialColor` with its air transport bound to known values:
// a vacuum leaves the cloud's own single tone map, the air acts per channel
// before that one tone map, and a transparent pixel stays zero. The mutants put
// back the inert arm and an LDR-after order, and each must turn a check red.
// The march's call geometry is pinned on the selected variant at the end.

const viewIntegration = stripComments(
  fs.readFileSync(path.join(dir, "CloudViewIntegration.wgsl"), "utf8"),
);

function physicalComposite(airSource = selected) {
  const air = { transmittance: vec3(1, 1, 1), radiance: vec3(0, 0, 0) };
  const fns = { ...functions };
  const env = { PI: Math.PI, cloud: { exposure: 1.3 }, __functions: fns };
  fns.cloudToneMappedRadiance = compileFunction(
    viewIntegration,
    "cloudToneMappedRadiance",
    env,
  );
  fns.cloudFiniteAirTransport = () => air;
  const color = compileFunction(airSource, "cloudPhysicalAerialColor", env);
  return {
    air,
    toneMap: (w, o) => fns.cloudToneMappedRadiance(w, o, env.cloud.exposure),
    run: (weighted, opacity, baseline = vec3(9, 9, 9)) =>
      color(
        weighted,
        opacity,
        baseline,
        1000,
        vec3(0, 0, 1),
        vec3(0, 0, 1),
        5000,
        6371000,
        vec3(0, 1, 0),
      ),
  };
}

function lanes(v) {
  return [v.x, v.y, v.z];
}

function assertClose(actual, expected, label) {
  for (const [a, e] of lanes(actual).map((a, i) => [a, lanes(expected)[i]])) {
    assert.ok(Number.isFinite(a), `${label}: finite`);
    assert.ok(
      Math.abs(a - e) <= 1e-12 * Math.max(1, Math.abs(e)),
      `${label}: ${a} vs ${e}`,
    );
  }
}

/** A vacuum leaves exactly the cloud's own single tone map, not the baseline. */
function assertVacuumIdentity(composite) {
  for (const [weighted, opacity] of [
    [vec3(0.4, 0.5, 0.6), 0.8],
    [vec3(2, 1, 0.5), 0.3],
    [vec3(0.01, 0.02, 0.03), 0.05],
  ]) {
    assertClose(
      composite.run(weighted, opacity),
      composite.toneMap(weighted, opacity),
      "vacuum",
    );
  }
}

/** The air applies per channel, in HDR, before the one tone map. */
function assertHdrComposition(composite) {
  const weighted = vec3(0.9, 0.6, 0.3);
  const opacity = 0.7;
  composite.air.transmittance = vec3(0.5, 0.7, 0.9);
  composite.air.radiance = vec3(0.2, 0.1, 0.05);
  const transported = vec3(
    0.9 * 0.5 + opacity * 0.2,
    0.6 * 0.7 + opacity * 0.1,
    0.3 * 0.9 + opacity * 0.05,
  );
  assertClose(
    composite.run(weighted, opacity),
    composite.toneMap(transported, opacity),
    "HDR composition",
  );
}

test("R-12 contract: a vacuum reduces the physical composite to the cloud's own single tone map", () => {
  assertVacuumIdentity(physicalComposite());
});

/**
 * The air radiance is premultiplied by the cloud's opacity: a barely covered
 * pixel with no cloud radiance of its own gains exactly opacity x L. A pixel
 * the cloud does not cover at all would pin nothing, because the tone map
 * returns 0 at zero opacity by its own select.
 */
function assertLowOpacityPremultiplied(composite) {
  composite.air.transmittance = vec3(1, 1, 1);
  composite.air.radiance = vec3(5, 5, 5);
  assertClose(
    composite.run(vec3(0, 0, 0), 0.01),
    composite.toneMap(vec3(0.05, 0.05, 0.05), 0.01),
    "low-opacity covered pixel",
  );
}

test("R-12 contract: the air acts per channel in HDR before one tone map, and its radiance is premultiplied by opacity", () => {
  const composite = physicalComposite();
  assertHdrComposition(composite);
  // Spectral: an extinction in one channel moves that channel only.
  composite.air.transmittance = vec3(1, 1, 1);
  composite.air.radiance = vec3(0, 0, 0);
  const clear = composite.run(vec3(0.5, 0.5, 0.5), 0.6);
  composite.air.transmittance = vec3(0.2, 1, 1);
  const red = composite.run(vec3(0.5, 0.5, 0.5), 0.6);
  assert.ok(red.x < clear.x, "the extinguished channel darkens");
  assert.equal(red.y, clear.y);
  assert.equal(red.z, clear.z);
  assertLowOpacityPremultiplied(composite);
});

test("MUTANT: the opacity dropped from the air term is red on the low-opacity covered pixel", () => {
  const mutated = selected.replace(
    /let transported = weightedRadiance \* air\.transmittance \+ opacity \* air\.radiance;/,
    "let transported = weightedRadiance * air.transmittance + air.radiance;",
  );
  assert.notEqual(mutated, selected, "the opacity mutation matched nothing");
  assert.throws(
    () => assertLowOpacityPremultiplied(physicalComposite(mutated)),
    assert.AssertionError,
  );
});

test("MUTANT: the inert arm (the baseline returned) is red on the vacuum identity", () => {
  const mutated = selected.replace(
    /let transported = weightedRadiance \* air\.transmittance \+ opacity \* air\.radiance;\s*return cloudToneMappedRadiance\(transported, opacity, cloud\.exposure\);/,
    "return baselineColor;",
  );
  assert.notEqual(mutated, selected, "the inert-arm mutation matched nothing");
  assert.throws(
    () => assertVacuumIdentity(physicalComposite(mutated)),
    assert.AssertionError,
  );
});

test("MUTANT: an LDR-after order (tone map, then air) is red on the HDR composition", () => {
  const mutated = selected.replace(
    /let transported = weightedRadiance \* air\.transmittance \+ opacity \* air\.radiance;\s*return cloudToneMappedRadiance\(transported, opacity, cloud\.exposure\);/,
    "return cloudToneMappedRadiance(weightedRadiance, opacity, cloud.exposure) * air.transmittance + air.radiance;",
  );
  assert.notEqual(mutated, selected, "the LDR-after mutation matched nothing");
  assert.throws(
    () => assertHdrComposition(physicalComposite(mutated)),
    assert.AssertionError,
  );
});

test("R-12 contract: the selected march hands the physical composite the visible sample the heuristic weight reads", () => {
  const march = stripComments(
    defaultVariant(
      fs.readFileSync(path.join(dir, "ProceduralClouds.wgsl"), "utf8"),
    ),
  );
  const geometry = ["visible.y", "-rayDir", "visibleUp", "visible.x"]
    .map((term) => term.replaceAll(".", "\\."))
    .join(",\\s*");
  // The heuristic weight and the physical composite read one visible sample.
  assert.match(
    march,
    new RegExp(`let aerial = cloudAerialFraction\\(\\s*${geometry},`),
  );
  assert.match(
    march,
    new RegExp(
      `hazed = cloudPhysicalAerialColor\\(weightedColor, opacity, hazed,\\s*${geometry},`,
    ),
  );
  assert.match(
    march,
    /QF_AERIAL_LUT\) != 0u\) \{\s*hazed = cloudPhysicalAerialColor/,
  );
});

test("the published LUT parameters are read through the manager's public accessor, never its private record", () => {
  const params = new Float32Array(24);
  // A manager that exposes only the private resource record publishes nothing.
  const privateOnly = {
    performanceManager: { _atmosphereLutResources: { paramsData: params } },
  };
  assert.equal(readPublishedAtmosphereParams(privateOnly), undefined);
  assert.equal(
    readPublishedAtmosphereParams({
      performanceManager: { getAtmosphereLUTParams: () => params },
    }),
    params,
  );
  for (const context of [
    {},
    { performanceManager: null },
    { performanceManager: { getAtmosphereLUTParams: () => null } },
    { performanceManager: { getAtmosphereLUTParams: () => [1, 2, 3] } },
    { performanceManager: { getAtmosphereLUTParams: 1 } },
  ]) {
    assert.equal(readPublishedAtmosphereParams(context), undefined);
  }
  const renderer = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
    ),
    "utf8",
  );
  assert.doesNotMatch(renderer, /_atmosphereLutResources/);
  assert.match(renderer, /readPublishedAtmosphereParams\(context\)/);
});
