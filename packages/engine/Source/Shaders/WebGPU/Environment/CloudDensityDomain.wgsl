// Campaign 13 C13-37 — planet-stable cloud-density coordinate domains.
//
// The three periodic baked-texture domains use campaign-fixed seeded SO(3)
// rotations, offsets, and non-harmonic scale ratios. This breaks the aligned
// ECEF repeat lattice without adding texture taps, bindings, or samplers.
//
// Matrix columns below are the WGSL column-major spelling of the row-major TS
// constants in WebGPUCloudDensityDomain.ts. Shape/detail keep the original
// seeded draws; the warp transform was re-drawn decorrelated (splitmix32
// generation seed 45296) — see the TS module docstring for the full provenance.

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
  // world-noise; on the RTE route it is origin-relative noise. Texture lookup
  // sites consume the three bounded periodic domains below.
  canonical: vec3<f32>,
  shape: vec3<f32>,
  warp: vec3<f32>,
  detail: vec3<f32>,
}

fn wrapCloudDensityDomain(value: vec3<f32>) -> vec3<f32> {
  return fract(value);
}

// Construct all domains from a raw world coordinate already converted to noise
// units. This is the direct/non-RTE route and a useful CPU-oracle equivalent.
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

// Reconstruct periodic domains from CPU-f64 origin phases plus a small,
// camera-relative noise delta. The phases are packed as three vec3+pad rows:
// shape, warp, detail. Keeping the large origin out of shader f32 arithmetic
// makes these texture coordinates stable at every planetary camera location.
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
