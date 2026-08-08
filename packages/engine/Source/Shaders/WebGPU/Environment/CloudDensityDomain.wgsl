// Planet-stable cloud-density coordinate domains.
//
// The three periodic baked-texture domains use fixed seeded SO(3) rotations,
// offsets, and non-harmonic scale ratios. This breaks the aligned ECEF repeat
// lattice without adding texture taps, bindings, or samplers.
//
// Matrix columns below are the WGSL column-major spelling of the row-major TS
// constants in WebGPUCloudDensityDomain.ts. The shape and detail transforms come
// from the original seeded draws; the warp transform comes from an independent
// draw decorrelated from them, splitmix32 generation seed 45296 — that module's
// docstring carries the full provenance.

const CLOUD_DENSITY_WORLD_TO_NOISE: f32 = 0.0003000000142492354;
const CLOUD_DENSITY_WARP_RATIO: f32 = 0.31830987334251404;
const CLOUD_DENSITY_DETAIL_RATIO: f32 = 4.949747562408447;

const CLOUD_DENSITY_SHAPE_ROTATION: mat3x3<f32> = mat3x3<f32>(
  vec3<f32>(0.6481302976608276, -0.25138190388679504, 0.7188422679901123),
  vec3<f32>(-0.7509533762931824, -0.36774903535842896, 0.548479437828064),
  vec3<f32>(0.1264757513999939, -0.8953031897544861, -0.42712539434432983),
);

const CLOUD_DENSITY_WARP_ROTATION: mat3x3<f32> = mat3x3<f32>(
  vec3<f32>(0.9397907257080078, 0.33879518508911133, -0.04484695941209793),
  vec3<f32>(0.019768714904785156, 0.07711493223905563, 0.9968262314796448),
  vec3<f32>(0.341178297996521, -0.9376945495605469, 0.0657743513584137),
);

const CLOUD_DENSITY_DETAIL_ROTATION: mat3x3<f32> = mat3x3<f32>(
  vec3<f32>(0.37974730134010315, -0.21341197192668915, 0.9001373648643494),
  vec3<f32>(-0.32391443848609924, -0.9421044588088989, -0.08670981228351593),
  vec3<f32>(0.8665283918380737, -0.25863969326019287, -0.4268888533115387),
);

const CLOUD_DENSITY_SHAPE_OFFSET: vec3<f32> = vec3<f32>(
  0.6620869040489197,
  0.2922023832798004,
  0.697387158870697,
);
const CLOUD_DENSITY_WARP_OFFSET: vec3<f32> = vec3<f32>(
  0.45028430223464966,
  0.19357918202877045,
  0.45167380571365356,
);
const CLOUD_DENSITY_DETAIL_OFFSET: vec3<f32> = vec3<f32>(
  0.7925757169723511,
  0.662077784538269,
  0.5091480016708374,
);

struct CloudDensityCoordinates {
  // The caller's untransformed coordinate. On the raw route this is full
  // world-noise; on the relative-to-eye route it is origin-relative noise.
  // Texture lookup sites consume the three bounded periodic domains below.
  canonical: vec3<f32>,
  shape: vec3<f32>,
  warp: vec3<f32>,
  detail: vec3<f32>,
}

fn wrapCloudDensityDomain(value: vec3<f32>) -> vec3<f32> {
  return fract(value);
}

// Construct all domains from a raw world coordinate already converted to noise
// units. This is the direct, non-relative-to-eye route, and the one a CPU oracle
// can reproduce.
fn cloudDensityCoordinatesFromWorldNoise(
  worldNoise: vec3<f32>,
  puffSize: f32,
) -> CloudDensityCoordinates {
  let shape = CLOUD_DENSITY_SHAPE_ROTATION * (worldNoise * puffSize);
  let warpScale = puffSize * CLOUD_DENSITY_WARP_RATIO;
  let warp = CLOUD_DENSITY_WARP_ROTATION * (worldNoise * warpScale);
  let detail =
    CLOUD_DENSITY_DETAIL_ROTATION *
    (worldNoise * CLOUD_DENSITY_DETAIL_RATIO);

  return CloudDensityCoordinates(
    worldNoise,
    wrapCloudDensityDomain(shape + CLOUD_DENSITY_SHAPE_OFFSET),
    wrapCloudDensityDomain(warp + CLOUD_DENSITY_WARP_OFFSET),
    wrapCloudDensityDomain(detail + CLOUD_DENSITY_DETAIL_OFFSET),
  );
}

// Reconstruct periodic domains from CPU-f64 origin phases plus a small
// camera-relative noise delta. The phases are packed as three vec3-plus-pad
// rows: shape, warp, detail. Keeping the large origin out of shader f32
// arithmetic is what makes these texture coordinates stable at every planetary
// camera location.
fn cloudDensityCoordinatesFromOriginPhases(
  relativeNoise: vec3<f32>,
  puffSize: f32,
  shapeOriginPhase: vec3<f32>,
  warpOriginPhase: vec3<f32>,
  detailOriginPhase: vec3<f32>,
) -> CloudDensityCoordinates {
  let shapeDelta =
    CLOUD_DENSITY_SHAPE_ROTATION * (relativeNoise * puffSize);
  let warpScale = puffSize * CLOUD_DENSITY_WARP_RATIO;
  let warpDelta =
    CLOUD_DENSITY_WARP_ROTATION * (relativeNoise * warpScale);
  let detailDelta =
    CLOUD_DENSITY_DETAIL_ROTATION *
    (relativeNoise * CLOUD_DENSITY_DETAIL_RATIO);

  return CloudDensityCoordinates(
    relativeNoise,
    wrapCloudDensityDomain(shapeOriginPhase + shapeDelta),
    wrapCloudDensityDomain(warpOriginPhase + warpDelta),
    wrapCloudDensityDomain(detailOriginPhase + detailDelta),
  );
}

// Advance an existing coordinate bundle by a relative delta in canonical noise
// units. Raymarch code can use this instead of reconstructing domains from ECEF
// at every sample. Periodic members remain bounded; no texture is sampled here.
fn advanceCloudDensityCoordinates(
  coordinates: CloudDensityCoordinates,
  relativeNoiseDelta: vec3<f32>,
  puffSize: f32,
) -> CloudDensityCoordinates {
  let shapeDelta =
    CLOUD_DENSITY_SHAPE_ROTATION * (relativeNoiseDelta * puffSize);
  let warpScale = puffSize * CLOUD_DENSITY_WARP_RATIO;
  let warpDelta =
    CLOUD_DENSITY_WARP_ROTATION * (relativeNoiseDelta * warpScale);
  let detailDelta =
    CLOUD_DENSITY_DETAIL_ROTATION *
    (relativeNoiseDelta * CLOUD_DENSITY_DETAIL_RATIO);

  return CloudDensityCoordinates(
    coordinates.canonical + relativeNoiseDelta,
    wrapCloudDensityDomain(coordinates.shape + shapeDelta),
    wrapCloudDensityDomain(coordinates.warp + warpDelta),
    wrapCloudDensityDomain(coordinates.detail + detailDelta),
  );
}

// Coverage to density-gate threshold.
//
// Every cloud density evaluation gates the base noise with
// `smoothstep(1 - cEff, 1, base)`, so `1 - cEff` is the base value a sample has
// to exceed to be cloud at all. Passing coverage straight through as `cEff`
// assumes the base noise is uniform over [0, 1].
//
// It is not. The baked shape channel is a 4-octave periodic value-fBm,
// `valueFBM(p, 2)` in CloudNoiseBake.wgsl, and its rgba8 values over the whole
// 128³ bake measure mean 0.4307, sigma 0.0896, maximum 0.7176 — a narrow
// near-Gaussian. A linear threshold therefore walks off the top of the field's
// support below coverage 0.283, where 1 - c exceeds the field maximum and the
// gate is identically zero for every sample in the world; and at 0.35 only the
// top 0.5% of voxels clear it, each with a gate amplitude below the subtractive
// erosion floor of mean 0.525 × erosionStrength, so those survivors are zeroed
// too. An isolated coverage sweep measured contribution exactly 0 at coverage of
// 0.40 or less and 0.0009 at 0.45 — every fair-weather scattered-cumulus sky
// rendering clear.
//
// The curve below instead requires the cloudy volume fraction
// P(base > 1 - cEff) to be a smooth, strictly increasing, constant-elasticity
// function of coverage rather than a Gaussian tail composed with a linear
// threshold. Constant elasticity in threshold space is a power law, and three
// anchors fix it:
//   A1  cEff(c) = c for c >= CLOUD_COVERAGE_ANCHOR. The two branches cross
//       exactly at the anchor, so `max` of them reproduces the linear response
//       bit-for-bit at and above it and every working high-coverage scene is
//       untouched.
//   A2  1 - cEff(0.15) = 0.6025, about the field's 98th percentile: the sparsest
//       threshold whose surviving cores still clear the erosion floor, so 0.15
//       is genuinely sparse yet nonzero rather than a wall.
//   A3  cEff(0) = 0, so the threshold is 1 and a zero-coverage sky is
//       structurally clear.
// A1 and A2 give exponent 1/4 at anchor 0.55. The resulting curve is monotone on
// all of [0, 1], leaves coverage of 0.08 or less visually clear, and lifts 0.35
// to ~40% of the anchor's sky cover with ~80% of its peak density — scattered
// puffs, not overcast.
//
// Spelled as `anchor * pow(c / anchor, exponent)` rather than a pre-multiplied
// constant: at c == anchor the ratio is exactly 1 and `pow(1, e)` is exactly 1,
// so the anchor reproduces itself exactly in f32 and the preservation at and
// above the anchor is exact rather than approximate.
//
// CPU twin: `cloudEffectiveCoverage` in WebGPUCloudDensityDomain.ts. The two are
// pinned together by `cloud-coverage-response.spec.mjs`, so neither can be
// edited alone.
const CLOUD_COVERAGE_ANCHOR: f32 = 0.55;
const CLOUD_COVERAGE_EXPONENT: f32 = 0.25;

fn cloudEffectiveCoverage(coverage: f32) -> f32 {
  if (coverage <= 0.0) {
    return 0.0;
  }
  let c = min(coverage, 1.0);
  let lifted =
    CLOUD_COVERAGE_ANCHOR *
    pow(c / CLOUD_COVERAGE_ANCHOR, CLOUD_COVERAGE_EXPONENT);
  return max(c, lifted);
}
