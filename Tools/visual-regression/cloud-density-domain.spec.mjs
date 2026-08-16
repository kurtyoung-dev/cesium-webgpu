// RUNNER REQUIREMENT: Node >= 22.18. This spec statically imports a `.ts` module
// (WebGPUCloudDensityDomain.ts, below), which relies on Node's built-in type
// stripping. That is on by default only from Node 22.18 onward; the root
// package.json `engines.node` (">=22.0.0") is intentionally NOT tightened for
// this one spec — run it under Node >= 22.18, or add `--experimental-strip-types`
// on 22.6-22.17.
// @purpose Pins the cloud density-domain layout: noise origin/phase/rotation float offsets shared between WebGPUCloudDensityDomain.ts and the WGSL, via exports.
// @status ACTIVE
//
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultVariant } from "./lib/wgsl-variant.mjs";

import {
  CLOUD_DENSITY_DETAIL_OFFSET,
  CLOUD_DENSITY_DETAIL_ORIGIN_PHASE_OFFSET,
  CLOUD_DENSITY_DETAIL_RATIO,
  CLOUD_DENSITY_DETAIL_ROTATION,
  CLOUD_DENSITY_MORPHOLOGY_ORIGIN_FLOATS,
  CLOUD_DENSITY_MORPHOLOGY_ORIGIN_HIGH_OFFSET,
  CLOUD_DENSITY_MORPHOLOGY_ORIGIN_LOW_OFFSET,
  CLOUD_DENSITY_ORIGIN_PHASE_FLOATS,
  CLOUD_DENSITY_ORIGIN_PHASE_STRIDE,
  CLOUD_DENSITY_PRIMARY_ORIGIN_FLOATS,
  CLOUD_DENSITY_SHAPE_OFFSET,
  CLOUD_DENSITY_SHAPE_ORIGIN_PHASE_OFFSET,
  CLOUD_DENSITY_SHAPE_ROTATION,
  CLOUD_DENSITY_WARP_OFFSET,
  CLOUD_DENSITY_WARP_ORIGIN_PHASE_OFFSET,
  CLOUD_DENSITY_WARP_RATIO,
  CLOUD_DENSITY_WARP_ROTATION,
  CLOUD_DENSITY_WORLD_TO_NOISE,
  writeCloudDensityAdvectedOriginPhases,
  writeCloudDensityOriginPhases,
  writeCloudMorphologyOriginHighLow,
} from "../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityDomain.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const tsPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityDomain.ts",
);
const wgslPath = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Environment/CloudDensityDomain.wgsl",
);
const tsSource = fs.readFileSync(tsPath, "utf8");
const wgslSource = fs.readFileSync(wgslPath, "utf8");
const cloudShaderPath = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
);
const cloudShaderSource = fs.readFileSync(cloudShaderPath, "utf8");

function functionSource(source, name) {
  const start = source.indexOf(`fn ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
    } else if (source[index] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  assert.fail(`unterminated function ${name}`);
}

function normalizedLegacyHash(source) {
  const normalized = source
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, "")
    .replace(/legacyCloudDensity/g, "cloudDensity")
    .replace(/legacyCloudBaseDensity/g, "cloudBaseDensity")
    .replace(/legacyBakedBase/g, "bakedBase")
    .replace(/,\)/g, ")");
  return createHash("sha256").update(normalized).digest("hex");
}

const domains = [
  {
    name: "shape",
    rotation: CLOUD_DENSITY_SHAPE_ROTATION,
    offset: CLOUD_DENSITY_SHAPE_OFFSET,
    phaseOffset: CLOUD_DENSITY_SHAPE_ORIGIN_PHASE_OFFSET,
  },
  {
    name: "warp",
    rotation: CLOUD_DENSITY_WARP_ROTATION,
    offset: CLOUD_DENSITY_WARP_OFFSET,
    phaseOffset: CLOUD_DENSITY_WARP_ORIGIN_PHASE_OFFSET,
  },
  {
    name: "detail",
    rotation: CLOUD_DENSITY_DETAIL_ROTATION,
    offset: CLOUD_DENSITY_DETAIL_OFFSET,
    phaseOffset: CLOUD_DENSITY_DETAIL_ORIGIN_PHASE_OFFSET,
  },
];

function dot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function row(matrix, index) {
  return matrix.slice(index * 3, index * 3 + 3);
}

function determinant3(matrix) {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

function fract(value) {
  return value - Math.floor(value);
}

function addF32(left, right) {
  return Math.fround(Math.fround(left) + Math.fround(right));
}

function multiplyF32(left, right) {
  return Math.fround(Math.fround(left) * Math.fround(right));
}

function matrixVectorF32(matrix, vector) {
  return [0, 1, 2].map((rowIndex) => {
    const base = rowIndex * 3;
    return addF32(
      addF32(
        multiplyF32(matrix[base], vector[0]),
        multiplyF32(matrix[base + 1], vector[1]),
      ),
      multiplyF32(matrix[base + 2], vector[2]),
    );
  });
}

function domainScalesF32(puffSize) {
  const puff = Math.fround(puffSize);
  return [
    puff,
    multiplyF32(puff, CLOUD_DENSITY_WARP_RATIO),
    CLOUD_DENSITY_DETAIL_RATIO,
  ];
}

function coordinatesFromOriginF32(phases, origin, worldPosition, puffSize) {
  const relativeMeters = worldPosition.map((value, index) =>
    Math.fround(value - origin[index]),
  );
  const relativeNoise = relativeMeters.map((value) =>
    multiplyF32(value, CLOUD_DENSITY_WORLD_TO_NOISE),
  );
  const scales = domainScalesF32(puffSize);

  return domains.map((domain, domainIndex) => {
    const scaled = relativeNoise.map((value) =>
      multiplyF32(value, scales[domainIndex]),
    );
    const delta = matrixVectorF32(domain.rotation, scaled);
    return [0, 1, 2].map((component) =>
      Math.fround(
        fract(addF32(phases[domain.phaseOffset + component], delta[component])),
      ),
    );
  });
}

function circularDifference(left, right) {
  const direct = Math.abs(left - right);
  return Math.min(direct, 1.0 - direct);
}

function parseWgslScalar(name) {
  const match = wgslSource.match(new RegExp(`const ${name}: f32 = ([^;]+);`));
  assert.ok(match, `missing WGSL scalar ${name}`);
  return Number(match[1]);
}

function parseWgslVector(name) {
  const match = wgslSource.match(
    new RegExp(`const ${name}: vec3<f32> = vec3<f32>\\(([\\s\\S]*?)\\);`),
  );
  assert.ok(match, `missing WGSL vector ${name}`);
  const values = match[1]
    .replaceAll("vec3<f32>", "")
    .match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)
    ?.map(Number);
  assert.equal(values?.length, 3, `${name} must contain three values`);
  return values;
}

function parseWgslMatrixRowMajor(name) {
  const match = wgslSource.match(
    new RegExp(`const ${name}: mat3x3<f32> = mat3x3<f32>\\(([\\s\\S]*?)\\);`),
  );
  assert.ok(match, `missing WGSL matrix ${name}`);
  const values = match[1]
    .replaceAll("vec3<f32>", "")
    .match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)
    ?.map(Number);
  assert.equal(values?.length, 9, `${name} must contain nine values`);
  // WGSL constructors list columns. Convert to the TS row-major convention.
  return [
    values[0],
    values[3],
    values[6],
    values[1],
    values[4],
    values[7],
    values[2],
    values[5],
    values[8],
  ];
}

test("campaign-fixed transforms are distinct right-handed SO(3) rotations", () => {
  assert.ok(
    Math.abs(CLOUD_DENSITY_WARP_RATIO - 1.0 / Math.PI) < 5e-8,
    "warp ratio must stay near 1/pi",
  );
  assert.notEqual(CLOUD_DENSITY_WARP_RATIO, Math.fround(0.32));
  assert.ok(
    CLOUD_DENSITY_DETAIL_RATIO > 4.8 &&
      CLOUD_DENSITY_DETAIL_RATIO < 5.1 &&
      Math.abs(
        CLOUD_DENSITY_DETAIL_RATIO - Math.round(CLOUD_DENSITY_DETAIL_RATIO),
      ) > 0.01,
    "detail ratio must stay near five but noninteger",
  );

  for (const domain of domains) {
    for (let i = 0; i < 3; i++) {
      assert.ok(
        Math.abs(dot(row(domain.rotation, i), row(domain.rotation, i)) - 1.0) <
          2e-7,
        `${domain.name} row ${i} is not unit length`,
      );
      for (let j = i + 1; j < 3; j++) {
        assert.ok(
          Math.abs(dot(row(domain.rotation, i), row(domain.rotation, j))) <
            2e-7,
          `${domain.name} rows ${i}/${j} are not orthogonal`,
        );
      }
    }
    assert.ok(
      Math.abs(determinant3(domain.rotation) - 1.0) < 2e-7,
      `${domain.name} determinant must be +1`,
    );
  }

  assert.notDeepEqual(
    CLOUD_DENSITY_SHAPE_ROTATION,
    CLOUD_DENSITY_WARP_ROTATION,
  );
  assert.notDeepEqual(
    CLOUD_DENSITY_SHAPE_ROTATION,
    CLOUD_DENSITY_DETAIL_ROTATION,
  );
  assert.notDeepEqual(
    CLOUD_DENSITY_WARP_ROTATION,
    CLOUD_DENSITY_DETAIL_ROTATION,
  );
});

test("TS and WGSL use the same f32 scales, transforms, and offsets", () => {
  assert.equal(
    Math.fround(parseWgslScalar("CLOUD_DENSITY_WORLD_TO_NOISE")),
    Math.fround(CLOUD_DENSITY_WORLD_TO_NOISE),
  );
  assert.equal(
    Math.fround(parseWgslScalar("CLOUD_DENSITY_WARP_RATIO")),
    Math.fround(CLOUD_DENSITY_WARP_RATIO),
  );
  assert.equal(
    Math.fround(parseWgslScalar("CLOUD_DENSITY_DETAIL_RATIO")),
    Math.fround(CLOUD_DENSITY_DETAIL_RATIO),
  );

  for (const domain of domains) {
    const upperName = domain.name.toUpperCase();
    assert.deepEqual(
      parseWgslMatrixRowMajor(`CLOUD_DENSITY_${upperName}_ROTATION`).map(
        Math.fround,
      ),
      [...domain.rotation].map(Math.fround),
    );
    assert.deepEqual(
      parseWgslVector(`CLOUD_DENSITY_${upperName}_OFFSET`).map(Math.fround),
      [...domain.offset].map(Math.fround),
    );
  }
});

test("the CPU phase writer is packed, periodic, and allocation-free by contract", () => {
  assert.equal(CLOUD_DENSITY_ORIGIN_PHASE_FLOATS, 12);
  assert.equal(CLOUD_DENSITY_ORIGIN_PHASE_STRIDE, 4);
  assert.deepEqual(
    domains.map((domain) => domain.phaseOffset),
    [0, 4, 8],
  );

  const sentinel = -19.0;
  const packed = new Float32Array(18).fill(sentinel);
  writeCloudDensityOriginPhases(
    packed,
    3,
    -6382042.382917,
    127194.289311,
    98731.471,
    0.45,
  );

  assert.deepEqual([...packed.slice(0, 3)], [sentinel, sentinel, sentinel]);
  assert.deepEqual([...packed.slice(15)], [sentinel, sentinel, sentinel]);
  for (const domain of domains) {
    const base = 3 + domain.phaseOffset;
    for (let component = 0; component < 3; component++) {
      assert.ok(packed[base + component] >= 0.0);
      assert.ok(packed[base + component] < 1.0);
    }
    assert.equal(packed[base + 3], 0.0);
  }

  const writer = tsSource.slice(
    tsSource.indexOf("function writeDomainOriginPhase("),
  );
  assert.doesNotMatch(writer, /\bnew\s+(?:Array|Float32Array|Object)\b/);
  assert.doesNotMatch(writer, /\.slice\s*\(|\.map\s*\(|\.filter\s*\(/);
});

test("CPU-f64 advection is folded before periodic phase down-cast", () => {
  const origin = [-6_382_042.382917, 127_194.289311, 98_731.471];
  const windX = 0.71;
  const windY = -0.34;
  const windSpeed = 47.5;
  const timeSeconds = 86_400.0 * 365.25 * 9.0 + 1234.5;
  const advectionMeters = windSpeed * timeSeconds;
  const advected = new Float32Array(CLOUD_DENSITY_ORIGIN_PHASE_FLOATS);
  const direct = new Float32Array(CLOUD_DENSITY_ORIGIN_PHASE_FLOATS);

  writeCloudDensityAdvectedOriginPhases(
    advected,
    0,
    origin[0],
    origin[1],
    origin[2],
    0.45,
    windX,
    windY,
    windSpeed,
    timeSeconds,
  );
  writeCloudDensityOriginPhases(
    direct,
    0,
    origin[0] + windX * advectionMeters,
    origin[1],
    origin[2] + windY * advectionMeters,
    0.45,
  );
  assert.deepEqual(advected, direct);
});

test("encoded morphology origin is unwrapped, advected, and RTE-stable", () => {
  assert.equal(CLOUD_DENSITY_MORPHOLOGY_ORIGIN_FLOATS, 8);
  assert.equal(CLOUD_DENSITY_PRIMARY_ORIGIN_FLOATS, 20);
  assert.equal(CLOUD_DENSITY_MORPHOLOGY_ORIGIN_HIGH_OFFSET, 0);
  assert.equal(CLOUD_DENSITY_MORPHOLOGY_ORIGIN_LOW_OFFSET, 4);

  const origin = [6_378_137.25, -190.5, 812.75];
  const relative = [23_450.25, -17_320.5, 8_111.125];
  const windX = 0.7;
  const windY = 0.3;
  const windSpeed = 31.0;
  const timeSeconds = 86400.0 * 420.0 + 45.5;
  const packed = new Float32Array(CLOUD_DENSITY_MORPHOLOGY_ORIGIN_FLOATS);
  writeCloudMorphologyOriginHighLow(
    packed,
    0,
    origin[0],
    origin[1],
    origin[2],
    windX,
    windY,
    windSpeed,
    timeSeconds,
  );

  const advection = windSpeed * timeSeconds;
  for (let component = 0; component < 3; component++) {
    const windComponent =
      component === 0
        ? windX * advection
        : component === 2
          ? windY * advection
          : 0;
    const direct = Math.fround(
      (origin[component] + relative[component] + windComponent) *
        CLOUD_DENSITY_WORLD_TO_NOISE,
    );
    const relativeNoise = Math.fround(
      relative[component] * CLOUD_DENSITY_WORLD_TO_NOISE,
    );
    const reconstructed = addF32(
      packed[CLOUD_DENSITY_MORPHOLOGY_ORIGIN_HIGH_OFFSET + component],
      addF32(
        packed[CLOUD_DENSITY_MORPHOLOGY_ORIGIN_LOW_OFFSET + component],
        relativeNoise,
      ),
    );
    assert.ok(
      Math.abs(reconstructed - direct) <=
        Math.max(Math.abs(direct) * 2 ** -22, 2 ** -20),
      `morphology component ${component} drifted from direct f32`,
    );
  }
  assert.equal(packed[3], 0.0);
  assert.equal(packed[7], 0.0);
  assert.ok(
    Math.abs(packed[0]) > 1.0,
    "morphology origin must remain unwrapped",
  );
});

test("CPU-f64 origin phases preserve periodic coordinates across camera origins", () => {
  const worldPositions = [
    [6378137.0 + 2200.25, 13.75, -8.5],
    [-4517590.878, 4517590.125, 2375.5],
    [-1105531.223, -1220493.887, 6150354.421],
  ];
  const originDeltas = [
    [0.0, 0.0, 0.0],
    [1732.25, -941.5, 337.75],
    [-35000.5, 19000.25, -7250.125],
  ];

  for (const worldPosition of worldPositions) {
    const coordinates = [];
    for (const delta of originDeltas) {
      const origin = worldPosition.map(
        (component, index) => component + delta[index],
      );
      const phases = new Float32Array(CLOUD_DENSITY_ORIGIN_PHASE_FLOATS);
      writeCloudDensityOriginPhases(
        phases,
        0,
        origin[0],
        origin[1],
        origin[2],
        0.45,
      );
      coordinates.push(
        coordinatesFromOriginF32(phases, origin, worldPosition, 0.45),
      );
    }

    for (
      let representation = 1;
      representation < coordinates.length;
      representation++
    ) {
      for (let domain = 0; domain < domains.length; domain++) {
        for (let component = 0; component < 3; component++) {
          const error = circularDifference(
            coordinates[0][domain][component],
            coordinates[representation][domain][component],
          );
          assert.ok(
            error <= 2.5e-5,
            `${domains[domain].name}[${component}] origin error ${error}`,
          );
        }
      }
    }
  }
});

test("deep-space relative rays keep density-domain drift below a quarter voxel", () => {
  const worldPosition = [4_515_902.75, -4_515_901.125, 2_375.5];
  const origins = [
    worldPosition,
    [
      worldPosition[0] + 30_000_000.25,
      worldPosition[1] - 40_000_000.5,
      worldPosition[2] + 20_000_000.125,
    ],
  ];
  const coordinates = origins.map((origin) => {
    const phases = new Float32Array(CLOUD_DENSITY_ORIGIN_PHASE_FLOATS);
    writeCloudDensityOriginPhases(
      phases,
      0,
      origin[0],
      origin[1],
      origin[2],
      0.45,
    );
    return coordinatesFromOriginF32(phases, origin, worldPosition, 0.45);
  });
  const resolutions = [128, 32, 32];
  for (let domain = 0; domain < domains.length; domain++) {
    for (let component = 0; component < 3; component++) {
      const texelError =
        circularDifference(
          coordinates[0][domain][component],
          coordinates[1][domain][component],
        ) * resolutions[domain];
      assert.ok(
        texelError <= 0.25,
        `${domains[domain].name}[${component}] deep-space drift ${texelError} texels`,
      );
    }
  }
});

test("translations that aliased the old aligned domains do not alias the combined domains", () => {
  const puffSize = 0.45;
  // Old coefficients were shape=.45, warp=.45*.32=.144, detail=5.
  // A 500-noise-unit axis translation therefore moved them by the integers
  // 225, 72, and 2500 respectively: all three periodic textures aliased.
  const oldCombinedPeriod = 500.0;
  const scales = domainScalesF32(puffSize);

  for (let axis = 0; axis < 3; axis++) {
    const translation = [0.0, 0.0, 0.0];
    translation[axis] = oldCombinedPeriod;
    const circularDeltas = [];

    for (let domainIndex = 0; domainIndex < domains.length; domainIndex++) {
      const scaled = translation.map((value) =>
        multiplyF32(value, scales[domainIndex]),
      );
      const transformed = matrixVectorF32(
        domains[domainIndex].rotation,
        scaled,
      );
      for (const component of transformed) {
        circularDeltas.push(Math.min(fract(component), 1.0 - fract(component)));
      }
    }

    assert.ok(
      circularDeltas.some((delta) => delta > 0.05),
      `old axis-${axis} combined period still aliases every new domain`,
    );
    assert.ok(
      circularDeltas.filter((delta) => delta > 0.01).length >= 6,
      `old axis-${axis} period remains suspiciously aligned`,
    );
  }
});

test("WGSL exposes pure coordinate helpers and owns no texture-tap cost", () => {
  assert.match(
    wgslSource,
    /struct CloudDensityCoordinates\s*\{[\s\S]*canonical:\s*vec3<f32>[\s\S]*shape:\s*vec3<f32>[\s\S]*warp:\s*vec3<f32>[\s\S]*detail:\s*vec3<f32>/,
  );
  assert.match(wgslSource, /fn cloudDensityCoordinatesFromWorldNoise\(/);
  assert.match(wgslSource, /fn cloudDensityCoordinatesFromOriginPhases\(/);
  assert.match(wgslSource, /fn advanceCloudDensityCoordinates\(/);

  const rawHelper = wgslSource.slice(
    wgslSource.indexOf("fn cloudDensityCoordinatesFromWorldNoise("),
    wgslSource.indexOf("fn cloudDensityCoordinatesFromOriginPhases("),
  );
  const originHelper = wgslSource.slice(
    wgslSource.indexOf("fn cloudDensityCoordinatesFromOriginPhases("),
    wgslSource.indexOf("fn advanceCloudDensityCoordinates("),
  );
  const advanceHelper = wgslSource.slice(
    wgslSource.indexOf("fn advanceCloudDensityCoordinates("),
  );
  for (const helper of [rawHelper, originHelper, advanceHelper]) {
    assert.match(helper, /CLOUD_DENSITY_SHAPE_ROTATION/);
    assert.match(helper, /CLOUD_DENSITY_WARP_ROTATION/);
    assert.match(helper, /CLOUD_DENSITY_DETAIL_ROTATION/);
    assert.match(helper, /wrapCloudDensityDomain/);
  }
  assert.match(originHelper, /shapeOriginPhase\s*\+\s*shapeDelta/);
  assert.match(originHelper, /warpOriginPhase\s*\+\s*warpDelta/);
  assert.match(originHelper, /detailOriginPhase\s*\+\s*detailDelta/);
  assert.match(
    advanceHelper,
    /coordinates\.canonical\s*\+\s*relativeNoiseDelta/,
  );
  assert.doesNotMatch(wgslSource, /textureSample|textureLoad|textureStore/);
  assert.doesNotMatch(wgslSource, /@group|@binding|\bvar\s+\w+\s*:\s*texture/);
  assert.doesNotMatch(wgslSource, /\bsampler\b/);
});

test("primary morphology stays in the unwrapped canonical RTE wind plane", () => {
  const relative = functionSource(
    cloudShaderSource,
    "cloudMorphologyCoordinateAtRelative",
  );
  assert.match(relative, /relativeWorld\s*\*\s*CLOUD_DENSITY_WORLD_TO_NOISE/);
  assert.match(
    relative,
    /cloud\.densityMorphologyOriginHigh\s*\+\s*\(\s*cloud\.densityMorphologyOriginLow\s*\+\s*relativeNoise\s*\)/,
  );
  assert.doesNotMatch(relative, /fract|wrapCloudDensityDomain|ROTATION/);

  const macro = functionSource(cloudShaderSource, "cloudMacroSampleAt");
  for (const factor of ["mammatusFactor", "speciesFactor", "featureFactor"]) {
    assert.match(
      macro,
      new RegExp(`${factor}\\(morphologyCoordinate,\\s*heightFraction\\)`),
    );
  }
  assert.doesNotMatch(
    macro,
    /(?:mammatusFactor|speciesFactor|featureFactor)\(\s*coordinates\.(?:shape|warp|detail)/,
  );
  const fullDensity = functionSource(
    cloudShaderSource,
    "cloudDensityFromMacro",
  );
  assert.match(
    fullDensity,
    /curlNoise3\(\s*sample\.morphologyCoordinate\s*\*\s*cloud\.curlFrequency\s*\)/,
  );

  const primaryMarch = cloudShaderSource.slice(
    cloudShaderSource.indexOf(
      "let usePlanetDensity = planetDensityEnabled() && noiseBakedEnabled();",
    ),
    cloudShaderSource.indexOf(
      "// Silver lining:",
      cloudShaderSource.indexOf(
        "let usePlanetDensity = planetDensityEnabled() && noiseBakedEnabled();",
      ),
    ),
  );
  assert.match(
    primaryMarch,
    /cloud\.densityMorphologyOriginHigh\s*\+\s*\(\s*cloud\.densityMorphologyOriginLow\s*\+\s*relativeNoise\s*\)/,
  );
  assert.doesNotMatch(
    primaryMarch,
    /morphologyCoordinate\s*=\s*densityCoordinates\.(?:shape|warp|detail)/,
  );
  const marchDeck = functionSource(cloudShaderSource, "marchDeck");
  const specialShade = marchDeck.slice(
    marchDeck.indexOf("var specialShadeCoordinate = samplePos * 0.0003;"),
    marchDeck.indexOf("weightedColor +="),
  );
  assert.match(
    specialShade,
    /var specialShadeCoordinate\s*=\s*samplePos\s*\*\s*0\.0003/,
  );
  assert.match(
    specialShade,
    /if \(usePlanetDensity\)\s*\{\s*specialShadeCoordinate\s*=\s*morphologyCoordinate/,
  );
});

test("LIVE and bit-13-off preserve the literal legacy density route", () => {
  // These hashes freeze the C13-37 A/B oracle: the LIVE and bit-13-off routes
  // must stay a LITERAL copy of the pre-C13-37 density evaluation, so the A/B
  // lane can attribute a difference to the new domain helpers rather than to a
  // silently edited control. The freeze is a drift DETECTOR, not a claim that
  // the density field can never change — a deliberate field change has to move
  // the legacy route and the macro route together, and re-freeze here with the
  // reason recorded.
  //
  // Re-frozen 2026-08-01 (CLOUD-LOW-COVERAGE-CUTOFF): the coverage gate in all
  // three evaluations — legacyCloudDensity, legacyCloudBaseDensity and
  // cloudMacroSampleAt — now routes `effectiveCoverage` through the shared
  // `cloudEffectiveCoverage` response in CloudDensityDomain.wgsl. That is the
  // one edit; `legacyBakedBase` is untouched and keeps its original hash, which
  // is what proves the re-freeze was scoped to the gate.
  //
  // Re-frozen again (C13-16, per-genus morphology): the same three evaluations
  // gained the genus fibre factor in their morphology chain and routed their
  // erosion height weight through `genusErosionHeightWeight`. Both edits are
  // identity at the default genus by explicit early return, so this is a
  // deliberate field EXTENSION moved through the legacy and macro routes
  // together — the condition the freeze's own docstring sets for a re-freeze.
  // `legacyBakedBase` is again untouched and keeps its original hash, which is
  // what proves the re-freeze was scoped to the morphology chain.
  const frozenLegacyHashes = {
    legacyBakedBase:
      "63cc67e6e7790a33c3ac39a3958d74335debe667d67d24a0e0e2c35609af4cde",
    legacyCloudDensity:
      "aedcb3c971a89d15c4966b5b0bc2a0d5d85fc469009378b242b8b111afe6cc39",
    legacyCloudBaseDensity:
      "10d19f4bf91f9e66803e038d8d44a31d0a72b31fe25d880b396bbf2feb408d61",
  };
  for (const [name, hash] of Object.entries(frozenLegacyHashes)) {
    assert.equal(
      normalizedLegacyHash(functionSource(cloudShaderSource, name)),
      hash,
      `${name} drifted from the frozen pre-C13-37 oracle`,
    );
  }

  for (const name of ["legacyCloudDensity", "legacyCloudBaseDensity"]) {
    const legacy = functionSource(cloudShaderSource, name);
    assert.match(
      legacy,
      /let samplePos\s*=\s*\(worldPos\s*\+\s*windOffset\)\s*\*\s*0\.0003/,
    );
    assert.match(legacy, /if \(noiseBakedEnabled\(\)\)/);
    assert.match(legacy, /legacyBakedBase\(samplePos\)/);
    assert.match(legacy, /fbmNoise\(samplePos\)/);
    assert.match(legacy, /mammatusFactor\(samplePos,\s*heightFraction\)/);
    assert.match(legacy, /speciesFactor\(samplePos,\s*heightFraction\)/);
    assert.match(legacy, /featureFactor\(samplePos,\s*heightFraction\)/);
    assert.doesNotMatch(
      legacy,
      /cloudMacroSampleAt|cloudDensityCoordinatesFromOriginPhases|densityMorphologyOrigin/,
    );
  }

  for (const [name, fallback] of [
    ["cloudDensity", "legacyCloudDensity"],
    ["cloudDensityWithFootprint", "legacyCloudDensity"],
    ["cloudBaseDensity", "legacyCloudBaseDensity"],
  ]) {
    const wrapper = functionSource(cloudShaderSource, name);
    assert.match(
      wrapper,
      /if \(!planetDensityEnabled\(\) \|\| !noiseBakedEnabled\(\)\)/,
    );
    assert.match(wrapper, new RegExp(`return ${fallback}\\(`));
  }
});

test("the primary RTE density path never adds shader-f32 wind", () => {
  const relativeDensity = functionSource(
    cloudShaderSource,
    "cloudDensityCoordinatesAtRelative",
  );
  const relativeMorphology = functionSource(
    cloudShaderSource,
    "cloudMorphologyCoordinateAtRelative",
  );
  for (const helper of [relativeDensity, relativeMorphology]) {
    assert.doesNotMatch(helper, /wind|cloud\.time|cloud\.windSpeed/);
  }
  assert.match(relativeDensity, /cloudDensityCoordinatesFromOriginPhases\(/);

  const march = functionSource(cloudShaderSource, "marchDeck");
  const coordinateDispatch = march.slice(
    march.indexOf("if (usePlanetDensity) {", march.indexOf("var base: f32;")),
    march.indexOf("if (!fine) {"),
  );
  const highPrecisionStart = coordinateDispatch.indexOf(
    "if (highPrecisionEnabled()) {",
  );
  const highPrecisionEnd = coordinateDispatch.indexOf(
    "} else {",
    highPrecisionStart,
  );
  assert.ok(highPrecisionStart >= 0 && highPrecisionEnd > highPrecisionStart);
  const highPrecisionBlock = coordinateDispatch.slice(
    highPrecisionStart,
    highPrecisionEnd,
  );
  assert.match(
    highPrecisionBlock,
    /let relativeNoise\s*=\s*rayNoisePerMeter\s*\*\s*sampleDistance/,
  );
  assert.match(highPrecisionBlock, /cloud\.densityShapeOriginPhase/);
  assert.match(highPrecisionBlock, /cloud\.densityWarpOriginPhase/);
  assert.match(highPrecisionBlock, /cloud\.densityMorphologyOriginHigh/);
  assert.match(highPrecisionBlock, /cloud\.densityMorphologyOriginLow/);
  assert.doesNotMatch(
    highPrecisionBlock,
    /windOffset|cloudWindOffset|cloud\.windSpeed|cloud\.time/,
  );
});

test("primary and light marches dispatch legacy lanes around the new macro path", () => {
  const march = functionSource(cloudShaderSource, "marchDeck");
  assert.match(
    march,
    /let usePlanetDensity\s*=\s*planetDensityEnabled\(\)\s*&&\s*noiseBakedEnabled\(\)/,
  );
  assert.match(march, /else\s*\{\s*base\s*=\s*legacyCloudBaseDensity\(/);
  assert.match(march, /else\s*\{\s*density\s*=\s*legacyCloudDensity\(/);

  const cone = functionSource(cloudShaderSource, "lightMarchCone");
  assert.match(cone, /else\s*\{\s*opticalDepth\s*\+=\s*legacyCloudDensity\(/);
  assert.match(
    cone,
    /else\s*\{\s*opticalDepth\s*\+=\s*legacyCloudBaseDensity\(/,
  );

  const straight = functionSource(cloudShaderSource, "lightMarch");
  assert.match(
    straight,
    /let usePlanetDensity\s*=\s*planetDensityEnabled\(\)\s*&&\s*noiseBakedEnabled\(\)/,
  );
  assert.match(
    straight,
    /else\s*\{\s*opticalDepth\s*\+=\s*legacyCloudDensity\(/,
  );
});

test("the shared domain composes into the IBL cloud consumer", async () => {
  const iblSource = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Shaders/WebGPU/Compute/ProceduralSkyCubemap.wgsl",
    ),
    "utf8",
  );
  assert.match(iblSource, /cloudDensityCoordinatesFromOriginPhases\(/);
  assert.doesNotMatch(iblSource, /u\._?cloudWindWorldOffset/);
  assert.match(iblSource, /relativeWorld\s*=\s*cloudIblLocalDeltaToWorld\(/);
  assert.match(iblSource, /coordinates\.warp/);
  assert.match(iblSource, /coordinates\.shape/);
  assert.match(iblSource, /coordinates\.detail/);

  const nagaDirectory = path.join(
    root,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  // C13-10 — naga must see what the PIPELINE compiles: the cloud march and the
  // temporal resolve now carry `//>>ifdef` variants, so their raw text holds both
  // branches at once and is not valid WGSL alone. `defaultVariant` is the engine
  // preprocessor at `definesHi = 0`, and a no-op for a directive-free shader.
  assert.doesNotThrow(() =>
    naga.validate_wgsl(
      `${defaultVariant(wgslSource)}\n${defaultVariant(iblSource)}`,
    ),
  );
});
