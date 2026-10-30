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
const cloudShaderSource =
  [
    "CloudMarchSampling.wgsl",
    "CloudSolarLighting.wgsl",
    "CloudAerialTransport.wgsl",
    "CloudDensityFormation.wgsl",
    "CloudDensityMoments.wgsl",
    "CloudViewIntegration.wgsl",
  ]
    .map((name) =>
      fs.readFileSync(path.join(path.dirname(cloudShaderPath), name), "utf8"),
    )
    .join("\n") +
  "\n" +
  fs.readFileSync(cloudShaderPath, "utf8");

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
  const normalized = defaultVariant(source)
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
  //
  // Re-frozen again 2026-08-09 (C13-16 U2 composition): all three density
  // evaluators now apply the model-approved variance budget and fibre carve
  // before erosion; the two full-density routes additionally apply the same
  // genus-conditioned erosion-depth compensation. The default CUMULUS row is
  // still exact identity, the macro route moved in the same change, and
  // `legacyBakedBase` remains untouched for the third time.
  const frozenLegacyHashes = {
    legacyBakedBase:
      "63cc67e6e7790a33c3ac39a3958d74335debe667d67d24a0e0e2c35609af4cde",
    legacyCloudDensity:
      "7e66e67d4a669bfb58cec116705cf50d38113a333a15201cb3e48c3df664adef",
    legacyCloudBaseDensity:
      "78862a846cbbc14516e40fbbc7513e7a617dd38e2cd6bdefb63c9ee34c1d4380",
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

const cloudSamplingProgram = fs.readFileSync(
  path.join(
    root,
    "packages/engine/Source/Shaders/WebGPU/Environment/CloudMarchSampling.wgsl",
  ),
  "utf8",
);
const cloudSolarProgram = fs.readFileSync(
  path.join(
    root,
    "packages/engine/Source/Shaders/WebGPU/Environment/CloudSolarLighting.wgsl",
  ),
  "utf8",
);
const cloudMath = await import("./lib/wgsl-mini-eval.mjs");
const cloudMathGlobals = {
  PI: Math.PI,
  __functions: {
    exp: Math.exp,
    asin: Math.asin,
    acos: Math.acos,
    mix: (a, b, t) =>
      cloudMath.isVec(a)
        ? cloudMath.vec(
            ...cloudMath
              .laneValues(a)
              .map((v, i) => v * (1 - t) + cloudMath.laneValues(b)[i] * t),
          )
        : a * (1 - t) + b * t,
  },
};
const marchBoundary = cloudMath.compileFunction(
  cloudMath.stripComments(cloudSamplingProgram),
  "cloudMarchIntervalBoundary",
  cloudMathGlobals,
);

test("cloud march boundaries remain finite, monotonic and complete across near/far growth budgets", () => {
  for (const count of [1, 2, 24, 64, 96])
    for (const chord of [2500, 111000, 800000])
      for (const entry of [0, 3000, 500000])
        for (const growth of [1, 1.01, 1.1, 2, 1e6]) {
          const exponent = Math.min(Math.log(growth) * count, 8);
          let previous = marchBoundary(0, count, chord, entry, 2500, exponent),
            integrated = 0;
          assert.equal(previous, 0);
          for (let interval = 1; interval <= count; interval++) {
            const next = marchBoundary(
              interval,
              count,
              chord,
              entry,
              2500,
              exponent,
            );
            assert(Number.isFinite(next) && next > previous);
            integrated += next - previous;
            previous = next;
          }
          assert(Math.abs(previous - chord) < chord * 1e-10);
          assert(Math.abs(integrated - chord) < chord * 1e-10);
        }
  const near = marchBoundary(1, 24, 111000, 0, 2500, 0);
  const far = marchBoundary(1, 24, 111000, 500000, 2500, 0);
  assert(near < 500);
  assert.equal(far, 111000 / 24);
});

test("cloud projected footprint responds to distance, field of view and output resolution", () => {
  const footprint = cloudMath.compileFunction(
    cloudMath.stripComments(cloudSamplingProgram),
    "cloudViewPixelFootprint",
    cloudMathGlobals,
  );
  assert.equal(footprint(0, 0.8, 1080), 0);
  assert.equal(footprint(500000, 0.8, 1080), 2 * footprint(250000, 0.8, 1080));
  assert.equal(footprint(500000, 0.8, 2160), footprint(500000, 0.4, 1080));
  assert(footprint(200, 0.8, 1080) < 1);
});

test("cloud local sunlight follows ellipsoid occlusion and the elevated solar disk horizon", () => {
  const globals = {
    ...cloudMathGlobals,
    __functions: {
      ...cloudMathGlobals.__functions,
      cloudShellAxes: () => cloudMath.vec(6378137, 6378137, 6356752.314245179),
    },
  };
  for (const name of [
    "cloudSolarDiskVisibility",
    "cloudSunVisibility",
    "cloudLocalDaylight",
    "cloudLocalSunlight",
  ])
    globals.__functions[name] = cloudMath.compileFunction(
      cloudMath.stripComments(cloudSolarProgram),
      name,
      globals,
    );
  const {
    cloudSunVisibility: visibility,
    cloudLocalSunlight: sunlight,
    cloudLocalDaylight: daylight,
  } = globals.__functions;
  const equator = cloudMath.vec(6378137 + 2000, 0, 0),
    pole = cloudMath.vec(0, 0, 6356752.314245179 + 2000);
  assert.equal(visibility(equator, cloudMath.vec(1, 0, 0)), 1);
  assert.equal(visibility(equator, cloudMath.vec(-1, 0, 0)), 0);
  assert.equal(visibility(pole, cloudMath.vec(0, 0, 1)), 1);
  assert.equal(visibility(pole, cloudMath.vec(0, 0, -1)), 0);
  assert.deepEqual(
    cloudMath.laneValues(sunlight(equator, cloudMath.vec(-1, 0, 0))),
    [0, 0, 0],
  );
  assert.equal(daylight(equator, cloudMath.vec(-1, 0, 0)), 0.002);
  const dip = Math.acos(6378137 / (6378137 + 2000));
  const at = (angle) =>
    visibility(equator, cloudMath.vec(Math.sin(angle), Math.cos(angle), 0));
  assert(Math.abs(at(-dip) - 0.5) < 0.01);
  assert.equal(at(-dip + 0.0093), 1);
  assert.equal(at(-dip - 0.0093), 0);
});

test("baked cloud specialization removes live FBM without changing the historical form", async () => {
  const { preprocess, shaderDefines } = await import("./lib/wgsl-variant.mjs");
  const bit = shaderDefines.ShaderDefineHi.CLOUD_NOISE_BAKED_ONLY;
  assert.equal(bit, 1 << 8);
  const source = wgslSource + "\n" + cloudShaderSource;
  const baked = preprocess(source, 0, bit);
  const live = defaultVariant(source);
  assert.match(live, /fn fbmNoise\(/);
  assert.doesNotMatch(baked, /\bfbmNoise\s*\(/);
  assert.match(functionSource(baked, "noiseBakedEnabled"), /return true;/);
  const before = fs.readFileSync(cloudShaderPath, "utf8");
  assert.match(before, /\/\/>>else\s+fn fbmNoise/);
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
  for (const flags of [
    bit,
    bit | shaderDefines.ShaderDefineHi.CLOUD_MARCH_EMIT_RECONSTRUCTION,
    bit | shaderDefines.ShaderDefineHi.CLOUD_MORPHOLOGY_BASE_ONLY,
    bit |
      shaderDefines.ShaderDefineHi.CLOUD_MORPHOLOGY_BASE_ONLY |
      shaderDefines.ShaderDefineHi.CLOUD_MARCH_EMIT_RECONSTRUCTION,
  ]) {
    assert.doesNotThrow(() => naga.validate_wgsl(preprocess(source, 0, flags)));
  }
});

test("cloud async march requests deduplicate pending variants and discard late publication", async () => {
  const { transform } = await import("esbuild");
  const { WebGPUPipelineRequestGuard } =
    await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUPipelineRequestGuard.ts");
  const { shaderDefines } = await import("./lib/wgsl-variant.mjs");
  const renderer = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
    ),
    "utf8",
  );
  const begin = renderer.indexOf("function requestCloudMarchPipeline(");
  const end = renderer.indexOf("function initializeCloudPipeline(", begin);
  assert(begin >= 0 && end > begin);
  const transformed = await transform(renderer.slice(begin, end), {
    loader: "ts",
    format: "cjs",
  });
  let moduleCreates = 0,
    requests = 0,
    finish;
  let expectedFlags =
    shaderDefines.ShaderDefineHi.CLOUD_NOISE_BAKED_ONLY |
    shaderDefines.ShaderDefineHi.CLOUD_MORPHOLOGY_BASE_ONLY;
  class Modules {
    getOrCreate() {
      moduleCreates++;
      return {};
    }
  }
  const dependencies = {
    WebGPUShaderModuleCache: Modules,
    performance: globalThis.performance,
    ShaderDefineHi: shaderDefines.ShaderDefineHi,
    ShaderSourceId: shaderDefines.ShaderSourceId,
    CLOUD_QF_NOISE_BAKED: 1,
    CLOUD_MARCH_EMIT_DEFINES_HI:
      shaderDefines.ShaderDefineHi.CLOUD_MARCH_EMIT_RECONSTRUCTION,
    CLOUD_MARCH_EMITTED_FORMAT: "rg32float",
    PROCEDURAL_CLOUDS_SOURCE: "fixture",
  };
  const { runInNewContext } = await import("node:vm");
  const request = runInNewContext(
    transformed.code + "\nrequestCloudMarchPipeline;",
    dependencies,
  );
  const device = { createPipelineLayout: () => ({}) };
  const cache = {
    uniformData: new Float32Array(176),
    bindGroupLayout: {},
    marchPipelines: new Map(),
    marchRequestGuard: new WebGPUPipelineRequestGuard(),
    marchModules: null,
    marchPipelineLayout: null,
  };
  const context = {
    _device: device,
    _cloudCache: cache,
    webgpuPipelineCache: {
      getPipelineSync: () => undefined,
      getPipeline: (descriptor) => {
        requests++;
        assert.equal(descriptor.definesHi, expectedFlags);
        assert.equal(descriptor.fragment.targets.length, 1);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  };
  cache.uniformData[74] = 1;
  for (let i = 0; i < 100; i++)
    assert.equal(request(context, cache, "rgba16float", false), null);
  assert.equal(requests, 1);
  const pipeline = {};
  finish(pipeline);
  await Promise.resolve();
  assert.equal(request(context, cache, "rgba16float", false), pipeline);
  cache.marchPipelines.clear();
  assert.equal(request(context, cache, "rgba16float", false), null);
  cache.marchRequestGuard.invalidate();
  context._cloudCache = {};
  finish({ stale: true });
  await Promise.resolve();
  assert.equal(cache.marchPipelines.get("rgba16float:" + expectedFlags), null);
  expectedFlags = shaderDefines.ShaderDefineHi.CLOUD_NOISE_BAKED_ONLY;
  context._cloudCache = cache;
  for (const values of [
    [[75, 0.2]],
    [[128, 0.5]],
    [
      [132, 2],
      [133, 1],
    ],
    [
      [136, 1],
      [137, 1],
    ],
    [
      [140, 1],
      [141, 1],
    ],
    [[168, 0.4]],
  ]) {
    cache.uniformData.fill(0);
    cache.uniformData[74] = 1;
    for (const [slot, value] of values) cache.uniformData[slot] = value;
    cache.marchPipelines.clear();
    assert.equal(request(context, cache, "rgba16float", false), null);
  }
  assert.equal(requests, 8);
  assert(moduleCreates > 0);
});

const densityFormationProgram = fs.readFileSync(
  path.join(
    root,
    "packages/engine/Source/Shaders/WebGPU/Environment/CloudDensityFormation.wgsl",
  ),
  "utf8",
);

test("formed density quadrature preserves clear mass, two occupied populations and transmission bounds", () => {
  const transmission = cloudMath.compileFunction(
    cloudMath.stripComments(densityFormationProgram),
    "cloudMomentTransmittance",
    cloudMathGlobals,
  );
  const moment = (populations) => {
    const values = [1, 2, 3, 0].map((power) =>
      populations.reduce(
        (sum, [density, weight]) =>
          sum + weight * (power ? density ** power : Number(density > 0)),
        0,
      ),
    );
    return { x: values[0], y: values[1], z: values[2], w: values[3] };
  };
  for (const populations of [
    [[0, 1]],
    [[0.4, 1]],
    [
      [0, 0.7],
      [0.3, 0.3],
    ],
    [
      [0, 0.4],
      [0.1, 0.2],
      [0.8, 0.4],
    ],
    [
      [0.1, 0.5],
      [0.9, 0.5],
    ],
  ]) {
    const m = moment(populations);
    let previous = 1;
    for (const scale of [0, 0.1, 1, 10, 100]) {
      const actual = transmission(m, scale);
      const expected = populations.reduce(
        (sum, [density, weight]) => sum + weight * Math.exp(-density * scale),
        0,
      );
      assert(
        Number.isFinite(actual) && actual >= 0 && actual <= previous + 1e-12,
      );
      assert(
        Math.abs(actual - expected) < 1e-8,
        "quadrature must be exact for at most two occupied nodes plus clear area",
      );
      previous = actual;
    }
  }
  const sparse = moment([
    [0, 0.75],
    [1, 0.25],
  ]);
  assert(transmission(sparse, 100) >= 0.75);
  assert(
    Math.exp(-sparse.x * 100) < 0.001,
    "mean-density extinction loses clear area",
  );
  const erode = cloudMath.compileFunction(
    cloudMath.stripComments(densityFormationProgram),
    "cloudErodedDensity",
    cloudMathGlobals,
  );
  for (const base of [0, 0.1, 0.6, 1])
    for (const low of [0, 0.1, 0.6, 0.99])
      assert.equal(
        erode(base, low),
        Math.max(0, Math.min(1, (base - low) / (1 - low))),
      );
});

test("moment producer and all selected detailed/preview/emission shaders validate", async () => {
  const { preprocess, shaderDefines } = await import("./lib/wgsl-variant.mjs");
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
  const producer = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Shaders/WebGPU/Compute/CloudDensityMomentsBake.wgsl",
    ),
    "utf8",
  );
  naga.validate_wgsl(
    wgslSource + "\n" + densityFormationProgram + "\n" + producer,
  );
  const flags = shaderDefines.ShaderDefineHi;
  const selected =
    flags.CLOUD_DENSITY_MOMENTS |
    flags.CLOUD_NOISE_BAKED_ONLY |
    flags.CLOUD_MORPHOLOGY_BASE_ONLY;
  for (const additional of [
    0,
    flags.CLOUD_MARCH_EMIT_RECONSTRUCTION,
    flags.CLOUD_LIGHTING_PREVIEW,
  ])
    naga.validate_wgsl(
      preprocess(
        wgslSource + "\n" + cloudShaderSource,
        0,
        selected | additional,
      ),
    );
  const source = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Shaders/WebGPU/Environment/CloudDensityMoments.wgsl",
    ),
    "utf8",
  );
  assert.match(source, /footprintMeters/);
  assert.match(
    source,
    /cloudDistantDensityWeight\(footprintMeters, period, dot\(rayDir, up\)\)/,
  );
  assert.match(source, /decodeWeatherChannels/);
  assert.doesNotMatch(defaultVariant(source), /cloudDensityMomentsTex/);
});

test("density statistics prepare asynchronously, reuse material data, rebake on changes and reject late publication", async () => {
  const { transform } = await import("esbuild");
  const source = fs
    .readFileSync(
      path.join(
        root,
        "packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityMoments.ts",
      ),
      "utf8",
    )
    .replace(
      /^import .+ from .+;\r?\n/gm,
      (match) => "const " + match.match(/^import (\w+)/)[1] + ' = "fixture";\n',
    );
  const transformed = await transform(source, { loader: "ts", format: "esm" });
  const { CloudDensityMomentsResources } = await import(
    "data:text/javascript;base64," +
      Buffer.from(transformed.code).toString("base64")
  );
  const previous = [
    globalThis.GPUShaderStage,
    globalThis.GPUTextureUsage,
    globalThis.GPUBufferUsage,
  ];
  globalThis.GPUShaderStage = { COMPUTE: 4 };
  globalThis.GPUTextureUsage = { STORAGE_BINDING: 8, TEXTURE_BINDING: 4 };
  globalThis.GPUBufferUsage = { STORAGE: 128, UNIFORM: 64, COPY_DST: 8 };
  try {
    let allocations = 0,
      submissions = 0,
      destroyed = 0;
    const pending = [];
    const resource = () => ({
      destroy() {
        destroyed++;
      },
      createView() {
        return {};
      },
    });
    const device = {
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createShaderModule: () => ({}),
      createComputePipelineAsync: () =>
        new Promise((resolve) => pending.push(resolve)),
      createTexture() {
        allocations++;
        return resource();
      },
      createBuffer() {
        allocations++;
        return resource();
      },
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginComputePass: () => ({
          setPipeline() {},
          setBindGroup() {},
          dispatchWorkgroups() {},
          end() {},
        }),
        finish: () => ({}),
      }),
      queue: {
        writeBuffer() {},
        submit() {
          submissions++;
        },
      },
    };
    const state = new CloudDensityMomentsResources(device),
      shape = {},
      detail = {},
      sampler = {};
    assert.equal(state.prepare(shape, detail, sampler, 0.45), null);
    state.prepare(shape, detail, sampler, 0.45);
    assert.equal(pending.length, 2);
    assert.equal(allocations, 0);
    for (const resolve of pending.splice(0)) resolve({});
    await new Promise((resolve) => setImmediate(resolve));
    const view = state.prepare(shape, detail, sampler, 0.45);
    assert(view);
    assert.equal(allocations, 3);
    assert.equal(submissions, 1);
    assert.equal(state.prepare(shape, detail, sampler, 0.45), view);
    assert.equal(submissions, 1);
    state.prepare(shape, detail, sampler, 0.5);
    assert.equal(submissions, 2);
    state.prepare({}, detail, sampler, 0.5);
    assert.equal(submissions, 3);
    state.destroy();
    assert.equal(destroyed, 3);
    assert.equal(state.prepare(shape, detail, sampler, 0.45), null);
    const late = new CloudDensityMomentsResources(device);
    late.prepare(shape, detail, sampler, 0.45);
    late.destroy();
    for (const resolve of pending.splice(0)) resolve({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(late.prepare(shape, detail, sampler, 0.45), null);
    assert.equal(allocations, 3);
  } finally {
    [
      globalThis.GPUShaderStage,
      globalThis.GPUTextureUsage,
      globalThis.GPUBufferUsage,
    ] = previous;
  }
});

test("correlated optical columns preserve clear coverage and are invariant to march partition count", () => {
  const source = cloudMath.stripComments(densityFormationProgram);
  const globals = {
    ...cloudMathGlobals,
    __functions: { ...cloudMathGlobals.__functions },
  };
  for (const name of [
    "cloudMomentTransmittance",
    "cloudOpticalMomentIncrement",
    "cloudColumnMomentTransmittance",
  ])
    globals.__functions[name] = cloudMath.compileFunction(
      source,
      name,
      globals,
    );
  const moments = cloudMath.vec4(0.25, 0.25, 0.25, 0.25);
  const expected = 0.75 + 0.25 * Math.exp(-20);
  for (const count of [1, 2, 8, 24, 48, 96, 128]) {
    const step = globals.__functions.cloudOpticalMomentIncrement(
      moments,
      20 / count,
    );
    const values = cloudMath.laneValues(step).map((value) => value * count);
    const actual = globals.__functions.cloudColumnMomentTransmittance(
      cloudMath.vec(...values),
      0.25,
    );
    assert(Math.abs(actual - expected) < 1e-8);
    assert(actual >= 0.75);
    if (count > 1)
      assert(
        Math.abs((0.75 + 0.25 * Math.exp(-20 / count)) ** count - expected) >
          0.1,
        "independent interval mixtures must fail the retained clear-area criterion",
      );
  }
});

test("distant density admission uses the noise feature wavelength and retains near and limb detail", () => {
  const weight = cloudMath.compileFunction(
    cloudMath.stripComments(densityFormationProgram),
    "cloudDistantDensityWeight",
    cloudMathGlobals,
  );
  const period = 1 / (0.0003 * 0.45);
  assert.equal(
    weight(6000, period, 0.9),
    1,
    "the global orbital footprint must select filtered optics",
  );
  assert.equal(weight(10, period, 0.9), 0);
  assert.equal(weight(100000, period, 0.1), 0);
  assert.equal(weight(6000, period, -0.9), 1);
  const partial = weight(period * 0.375, period, 0.9);
  assert(Math.abs(partial - 0.5) < 1e-8);
});

test("zero-coverage statistical bins are empty even at the largest possible noise value", () => {
  const gate = cloudMath.compileFunction(
    cloudMath.stripComments(densityFormationProgram),
    "cloudCoverageGate",
    cloudMathGlobals,
  );
  for (const noise of [0, 0.4, 0.7, 1]) assert.equal(gate(noise, 1), 0);
  for (const threshold of [0, 0.3, 0.6, 0.9])
    for (const noise of [0, 0.4, 0.7, 1]) {
      const t = Math.max(0, Math.min(1, (noise - threshold) / (1 - threshold)));
      assert.equal(gate(noise, threshold), t * t * (3 - 2 * t));
    }
});

test("cloud deck ordering uses ray entry below, within and above the layer", () => {
  const source = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Shaders/WebGPU/Environment/CloudViewIntegration.wgsl",
    ),
    "utf8",
  );
  const entry = cloudMath.compileFunction(
    cloudMath.stripComments(source),
    "cloudDeckEntryDistance",
    cloudMathGlobals,
  );
  const v = cloudMath.vec;
  assert.equal(entry(v(-2, 300), v(-3, 600), 800, 1500, 4000), 300);
  assert.equal(entry(v(-2, 300), v(-3, 600), 2000, 1500, 4000), 0);
  assert.equal(entry(v(500, 900), v(100, 1000), 5000, 1500, 4000), 100);
  assert.equal(entry(v(-2, -1), v(-3, -1), 5000, 1500, 4000), 1e30);
  const low = entry(v(6000, 12700000), v(4000, 12702000), 6000, 0, 2000);
  const high = entry(v(-1000, 12700000), v(-4000, 12703000), 6000, 7000, 10000);
  assert(low < high);
  assert.equal((source.match(/\bmarchDeck\s*\(/g) ?? []).length, 1);
  assert.match(
    source,
    /result\.radiance \+= transmittance \* deck\.alpha \* deck\.hazed/,
  );
  assert.match(
    source,
    /result\.weightedDistanceSum \+= transmittance \* deck\.weightedDistanceSum/,
  );
  assert.doesNotMatch(source, /abs\(camAlt - mid/);
});

test("aerial transport uses contributing distance and altitude rather than empty shell range", () => {
  const source = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Shaders/WebGPU/Environment/CloudAerialTransport.wgsl",
    ),
    "utf8",
  );
  const representative = cloudMath.compileFunction(
    cloudMath.stripComments(source),
    "cloudVisibleAerialSample",
    cloudMathGlobals,
  );
  const sample = cloudMath.laneValues(
    representative(
      0.9 * 1000 + 0.05 * 50000,
      0.95 * 2000,
      0.95,
      500,
      100000,
      1500,
      4000,
    ),
  );
  assert(Math.abs(sample[0] - 3400 / 0.95) < 1e-8);
  assert(Math.abs(sample[1] - 2000) < 1e-8);
  assert(sample[0] < 4000);
  assert.deepEqual(
    cloudMath.laneValues(representative(0, 0, 0, 500, 100000, 1500, 4000)),
    [500, 1500],
  );
  const march = functionSource(defaultVariant(cloudShaderSource), "marchDeck");
  assert.match(march, /visibleDistanceSum \+= sampleWeight \* sampleDistance/);
  assert.match(
    march,
    /visibleAltitudeSum \+= sampleWeight \* \(deckBottom \+ heightFraction \* layerThickness\)/,
  );
  assert.match(march, /visible\.y, -rayDir, visibleUp, visible\.x/);
  assert.doesNotMatch(march, /cloudSampleTransmittance\(|let midDist =/);
  assert.match(march, /hazed = mix\(toneMapped, farTarget, aerial\)/);
});

test("cloud lighting preview preserves density integration and validates each startup recipe", async () => {
  const { preprocess, shaderDefines } = await import("./lib/wgsl-variant.mjs");
  const flags = shaderDefines.ShaderDefineHi;
  const source = wgslSource + "\n" + cloudShaderSource;
  const preview = preprocess(source, 0, flags.CLOUD_LIGHTING_PREVIEW);
  const complete = defaultVariant(source);
  assert.equal(
    functionSource(preview, "marchDeck"),
    functionSource(complete, "marchDeck"),
  );
  const lighting = functionSource(preview, "lightMarch");
  assert.doesNotMatch(lighting, /cloudDensity|lightMarchCone|for\s*\(/);
  assert.match(
    functionSource(complete, "lightMarch"),
    /cloudDensityAtCoordinates/,
  );
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
  for (const bits of [
    flags.CLOUD_LIGHTING_PREVIEW,
    flags.CLOUD_LIGHTING_PREVIEW | flags.CLOUD_NOISE_BAKED_ONLY,
    flags.CLOUD_LIGHTING_PREVIEW |
      flags.CLOUD_NOISE_BAKED_ONLY |
      flags.CLOUD_MORPHOLOGY_BASE_ONLY,
  ]) {
    assert.doesNotThrow(() => naga.validate_wgsl(preprocess(source, 0, bits)));
  }
});

test("cloud progressive selection draws preview before requesting final and retains it while pending", async () => {
  const { transform } = await import("esbuild");
  const { WebGPUPipelineRequestGuard } =
    await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUPipelineRequestGuard.ts");
  const { shaderDefines } = await import("./lib/wgsl-variant.mjs");
  const { runInNewContext } = await import("node:vm");
  const renderer = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
    ),
    "utf8",
  );
  const begin = renderer.indexOf("function requestCloudMarchPipeline(");
  const end = renderer.indexOf("function initializeCloudPipeline(", begin);
  const transformed = await transform(renderer.slice(begin, end), {
    loader: "ts",
    format: "cjs",
  });
  const modules = new Map(),
    pending = new Map(),
    requested = [];
  class Modules {
    getOrCreate(sourceId, source, bits, label, extra, hi) {
      if (!modules.has(hi)) {
        modules.set(hi, {});
      }
      return modules.get(hi);
    }
  }
  const { request, select } = runInNewContext(
    transformed.code +
      "\n({request:requestCloudMarchPipeline,select:selectCloudMarchPipeline});",
    {
      WebGPUShaderModuleCache: Modules,
      performance: globalThis.performance,
      ShaderDefineHi: shaderDefines.ShaderDefineHi,
      ShaderSourceId: shaderDefines.ShaderSourceId,
      CLOUD_QF_NOISE_BAKED: 1,
      CLOUD_MARCH_EMIT_DEFINES_HI:
        shaderDefines.ShaderDefineHi.CLOUD_MARCH_EMIT_RECONSTRUCTION,
      CLOUD_MARCH_EMITTED_FORMAT: "rg32float",
      PROCEDURAL_CLOUDS_SOURCE: "fixture",
      CLOUD_TEMPORAL_RESET_RESOURCE: 8,
    },
  );
  const cache = {
    uniformData: new Float32Array(176),
    bindGroupLayout: {},
    marchPipelines: new Map(),
    marchRequestGuard: new WebGPUPipelineRequestGuard(),
    marchModules: null,
    marchPipelineLayout: null,
    startupPreviewDrawn: false,
    usingStartupPreview: false,
    temporalHistoryPendingResetReasons: 0,
  };
  const device = { createPipelineLayout: () => ({}) };
  const context = {
    _device: device,
    _cloudCache: cache,
    webgpuPipelineCache: {
      getPipelineSync: () => undefined,
      getPipeline: (descriptor) => {
        requested.push(descriptor.definesHi);
        return new Promise((resolve) => {
          pending.set(descriptor.definesHi, resolve);
        });
      },
    },
  };
  const previewBit = shaderDefines.ShaderDefineHi.CLOUD_LIGHTING_PREVIEW;
  for (let i = 0; i < 20; i++) {
    assert.equal(select(context, cache, "rgba16float", true), null);
  }
  assert.deepEqual(requested, [previewBit]);
  const early = { preview: true },
    final = { final: true };
  pending.get(previewBit)(early);
  await Promise.resolve();
  assert.equal(select(context, cache, "rgba16float", true), early);
  assert.equal(cache.usingStartupPreview, true);
  assert.deepEqual(
    requested,
    [previewBit],
    "preparation alone is not a preview draw",
  );
  cache.startupPreviewDrawn = true;
  cache.temporalHistoryPendingResetReasons = 0;
  const mask = (cache.maskPipeline = {}),
    shadow = (cache.shadowPipeline = {}),
    selectedModule = cache.maskShaderModule;
  for (let i = 0; i < 20; i++) {
    assert.equal(select(context, cache, "rgba16float", true), early);
  }
  assert.deepEqual(requested, [previewBit, 0]);
  assert.equal(cache.maskPipeline, mask);
  assert.equal(cache.shadowPipeline, shadow);
  assert.equal(cache.maskShaderModule, selectedModule);
  assert.equal(cache.temporalHistoryPendingResetReasons, 0);
  pending.get(0)(final);
  await Promise.resolve();
  assert.equal(select(context, cache, "rgba16float", true), final);
  assert.equal(cache.usingStartupPreview, false);
  assert.equal(cache.temporalHistoryPendingResetReasons, 8);
  assert.equal(cache.maskPipeline, null);
  assert.equal(cache.shadowPipeline, null);
  cache.temporalHistoryPendingResetReasons = 0;
  assert.equal(select(context, cache, "rgba16float", true), final);
  assert.equal(select(context, cache, "rgba16float", false), final);
  assert.equal(cache.temporalHistoryPendingResetReasons, 0);
  assert.equal(request(context, cache, "rgba16float", false), final);
  assert.equal(requested.length, 2);
  cache.startupPreviewDrawn = false;
  assert.equal(select(context, cache, "bgra8unorm", false), null);
  assert.equal(
    requested.at(-1),
    0,
    "disabling progressive startup requests final directly",
  );
});
