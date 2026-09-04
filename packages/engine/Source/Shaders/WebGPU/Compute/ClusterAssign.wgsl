// ClusterAssign.wgsl — Forward+ light-to-cluster assignment compute
// shader.
//
// One thread per cluster in a (X, Y, Z) = (16, 9, 24) grid (3456
// clusters total). Each thread:
//
//   1. Reads its cluster's eye-space AABB from `clusterAABBs`.
//   2. Walks the active light list (up to `MAX_LIGHTS = 1024` lights
//      packed as ClusteredLight records).
//   3. For each light, tests:
//        - DIRECTIONAL (lightType=0): always added (affects every cluster).
//        - POINT (1), SPOT (2): sphere-AABB intersection using the
//          light's eye-space position and its range as the sphere
//          radius. Spot lights use a sphere-based culling pass here;
//          finer cone-based culling happens in the fragment shader
//          since the cone direction + cosAngle test is cheap per-pixel.
//   4. Writes the cluster's overlap count into `perClusterLightCount`
//      and the overlapping light indices into `perClusterLightIndices`
//      at a fixed per-cluster stride of `MAX_LIGHTS_PER_CLUSTER = 256`.
//      Indices beyond `count` in a cluster's slot remain whatever
//      previous-frame garbage occupied them; downstream consumers
//      (the FS) read only the first `count` entries.
//
// Memory layout (storage buffers):
//   - clusterAABBs:           3456 × 32 B  =  ~108 KiB (read-only)
//   - lights:                 1024 × 80 B  =  ~80  KiB (read-only, packed by CPU each frame)
//   - perClusterLightCount:   3456 × 4 B   =  ~13.5 KiB
//   - perClusterLightIndices: 3456 × 256 × 4 B = ~3.4 MiB
//
// Total clustered-lighting storage: ~3.6 MiB. Well within the
// default 128 MiB storage buffer binding limit.
//
// **Toji delta:** the reference example uses 256 max lights per
// cluster too but no upper light count, relying on the FS to clamp.
// Here we cap at MAX_LIGHTS = 1024 (scene-wide) so the per-cluster
// walk is bounded; future increase requires a maxStorageBufferBindingSize
// opt-up. Cesium scenes with tilesets carrying thousands of lights
// per frame would need CPU-side spatial culling before this dispatch.
//
// **Dirty tracking (CPU-side):** the dispatcher (WebGPUClusterAssign
// Renderer.ts) gates re-dispatch on (light list checksum, view matrix)
// changing — same logic as ClusterBoundsRenderer's (viewport, near,
// far, projection) gate. Static scenes only re-dispatch when the
// camera moves; static cameras only re-dispatch when lights change.

const TILE_COUNT_X: u32 = 16u;
const TILE_COUNT_Y: u32 = 9u;
const SLICE_COUNT_Z: u32 = 24u;
const TOTAL_CLUSTERS: u32 = TILE_COUNT_X * TILE_COUNT_Y * SLICE_COUNT_Z;

const MAX_LIGHTS: u32 = 1024u;
const MAX_LIGHTS_PER_CLUSTER: u32 = 256u;

// Light type enum — matches LightType in LightTypes.ts and the
// `lightType` field in LightCollection.pack().
const LIGHT_TYPE_DIRECTIONAL: i32 = 0;
const LIGHT_TYPE_POINT: i32 = 1;
const LIGHT_TYPE_SPOT: i32 = 2;

// Per-light record: 80 bytes = 20 floats. Matches the per-light layout
// of LightCollection.pack() but with positions / directions already
// transformed to eye-space by the CPU. The CPU also applies the view
// matrix to spot directions so the spot-cone check on the FS works
// against eye-space input vectors directly.
struct ClusteredLight {
  // .xyz = position (point/spot) OR direction (directional) in eye space
  // .w   = lightType as f32 (0=DIR, 1=POINT, 2=SPOT)
  posOrDirEC: vec4<f32>,
  // .xyz = color (linear RGB), .w = intensity
  colorAndIntensity: vec4<f32>,
  // .x = range (0 = infinite for point/spot), .y/z/w = constant/linear/quadratic atten
  rangeAndAtten: vec4<f32>,
  // .x = innerConeAngle (radians), .y = outerConeAngle (radians), .zw = pad
  coneAngles: vec4<f32>,
  // .xyz = spot forward direction (eye-space), .w = pad
  spotDirEC: vec4<f32>,
};

struct ClusterAABB {
  minPos: vec4<f32>,
  maxPos: vec4<f32>,
};

// Uniform: how many lights are active in `lights[]` this dispatch.
// Only the first `lightCount` entries are tested.
struct ClusterAssignUniforms {
  lightCount: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<storage, read> clusterAABBs: array<ClusterAABB>;
@group(0) @binding(1) var<storage, read> lights: array<ClusteredLight>;
@group(0) @binding(2) var<uniform> uniforms: ClusterAssignUniforms;
@group(0) @binding(3) var<storage, read_write> perClusterLightCount: array<u32>;
@group(0) @binding(4) var<storage, read_write> perClusterLightIndices: array<u32>;

// Standard sphere-AABB intersection. Returns true if any part of the
// sphere of (center, radius) lies inside or on the AABB.
//
// Algorithm: clamp the sphere center to the AABB → that yields the
// closest point on (or in) the AABB to the center. If the distance
// from that point to the center is ≤ radius, they overlap.
fn sphereOverlapsAABB(
  center: vec3<f32>,
  radius: f32,
  aabbMin: vec3<f32>,
  aabbMax: vec3<f32>,
) -> bool {
  let closest = clamp(center, aabbMin, aabbMax);
  let delta = closest - center;
  let distSq = dot(delta, delta);
  return distSq <= radius * radius;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= TILE_COUNT_X || gid.y >= TILE_COUNT_Y || gid.z >= SLICE_COUNT_Z) {
    return;
  }

  let clusterIdx = gid.x + gid.y * TILE_COUNT_X + gid.z * TILE_COUNT_X * TILE_COUNT_Y;
  let aabb = clusterAABBs[clusterIdx];
  let aabbMin = aabb.minPos.xyz;
  let aabbMax = aabb.maxPos.xyz;

  let lightCount = min(uniforms.lightCount, MAX_LIGHTS);
  let indexBase = clusterIdx * MAX_LIGHTS_PER_CLUSTER;

  var overlapCount: u32 = 0u;

  for (var i: u32 = 0u; i < lightCount; i = i + 1u) {
    if (overlapCount >= MAX_LIGHTS_PER_CLUSTER) {
      break;
    }

    let light = lights[i];
    let lightType = i32(light.posOrDirEC.w);

    var overlaps = false;
    if (lightType == LIGHT_TYPE_DIRECTIONAL) {
      // Directional lights have infinite reach — affect every cluster.
      overlaps = true;
    } else {
      // POINT or SPOT — sphere overlap test.
      // range == 0 = "infinite" per glTF KHR_lights_punctual. Treat as
      // a very large finite radius so the AABB test still works and
      // doesn't accidentally exclude clusters far from the light.
      // 1e8 is comfortably larger than any practical Cesium scene
      // (~Earth radius of 6.378e6 m is the bound on positions in
      // eye-space for terrain-scale scenes).
      let range = select(1.0e8, light.rangeAndAtten.x, light.rangeAndAtten.x > 0.0);
      overlaps = sphereOverlapsAABB(light.posOrDirEC.xyz, range, aabbMin, aabbMax);
    }

    if (overlaps) {
      perClusterLightIndices[indexBase + overlapCount] = i;
      overlapCount = overlapCount + 1u;
    }
  }

  // Per-cluster light count. Each cluster has its own slot in this
  // array and one writer thread, so no atomics needed.
  perClusterLightCount[clusterIdx] = overlapCount;
}
