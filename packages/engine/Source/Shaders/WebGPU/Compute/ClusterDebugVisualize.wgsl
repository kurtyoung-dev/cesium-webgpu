// ClusterDebugVisualize.wgsl — Forward+ end-to-end validation shader.
//
// Slice 5d Batch 149.
//
// Renders a fullscreen quad where each pixel's color encodes the
// number of clustered lights affecting that pixel's cluster:
//   - count == 0 → black (no lights overlap this cluster)
//   - count == 1 → red
//   - count == 2 → yellow
//   - count >= 4 → white
//
// This is purely a TEST harness for probe-cluster-fs-consumer.mjs —
// validates the full compute → assign → FS chain end-to-end before
// the chunk gets integrated into the real material shaders (Batch
// 150+).
//
// The shader reads `viewZ` from a uniform-supplied test value rather
// than a depth texture, because this debug pipeline doesn't actually
// render real geometry — it just samples a single cluster slice per
// dispatch. The probe drives the `testViewZ` value to walk through
// all 24 depth slices and confirm each slice's per-cluster counts
// match the assignment output.

const CL_TILE_COUNT_X: u32 = 16u;
const CL_TILE_COUNT_Y: u32 = 9u;
const CL_SLICE_COUNT_Z: u32 = 24u;
const CL_MAX_LIGHTS_PER_CLUSTER: u32 = 256u;

struct ClusteredLight {
  posOrDirEC: vec4<f32>,
  colorAndIntensity: vec4<f32>,
  rangeAndAtten: vec4<f32>,
  coneAngles: vec4<f32>,
  spotDirEC: vec4<f32>,
};

struct ClusteredAABB {
  minPos: vec4<f32>,
  maxPos: vec4<f32>,
};

struct DebugVisualizeUniforms {
  // .xy = viewport (width, height), .zw = (near, far)
  viewportAndPlanes: vec4<f32>,
  // .x = test viewZ (the depth slice the pixel is treated as being
  // at), .y = activeLightCount, .zw = unused.
  testParams: vec4<f32>,
};

@group(0) @binding(0) var<storage, read> clusterLights: array<ClusteredLight>;
@group(0) @binding(1) var<storage, read> clusterAABBs: array<ClusteredAABB>;
@group(0) @binding(2) var<storage, read> perClusterLightCount: array<u32>;
@group(0) @binding(3) var<storage, read> perClusterLightIndices: array<u32>;
@group(0) @binding(4) var<uniform> uniforms: DebugVisualizeUniforms;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vi: u32) -> VertexOutput {
  // Fullscreen triangle covering NDC [-1, 1].
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  var output: VertexOutput;
  output.clipPos = vec4<f32>(x, y, 0.0, 1.0);
  return output;
}

fn clusterIndexFor(fragCoord: vec2<f32>, viewZ: f32) -> u32 {
  let viewport = uniforms.viewportAndPlanes.xy;
  let near = uniforms.viewportAndPlanes.z;
  let far = uniforms.viewportAndPlanes.w;

  let tileSizeX = viewport.x / f32(CL_TILE_COUNT_X);
  let tileSizeY = viewport.y / f32(CL_TILE_COUNT_Y);
  let tileX = u32(clamp(floor(fragCoord.x / tileSizeX), 0.0, f32(CL_TILE_COUNT_X - 1u)));
  let tileY = u32(clamp(floor(fragCoord.y / tileSizeY), 0.0, f32(CL_TILE_COUNT_Y - 1u)));

  let absZ = max(abs(viewZ), near);
  let logZ = log(absZ / near);
  let logRatio = log(far / near);
  let sliceFloat = (logZ / logRatio) * f32(CL_SLICE_COUNT_Z);
  let sliceZ = u32(clamp(sliceFloat, 0.0, f32(CL_SLICE_COUNT_Z - 1u)));

  return tileX + tileY * CL_TILE_COUNT_X + sliceZ * CL_TILE_COUNT_X * CL_TILE_COUNT_Y;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let testViewZ = uniforms.testParams.x;
  let activeLights = uniforms.testParams.y;
  if (activeLights < 0.5) {
    // No lights configured — render black to distinguish from "cluster
    // has 0 overlapping lights" which is also a meaningful zero.
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  let idx = clusterIndexFor(in.clipPos.xy, testViewZ);
  let count = perClusterLightCount[idx];

  // Encode count in color:
  //   0 → black
  //   1 → red
  //   2 → yellow (red + green)
  //   3 → orange (red + half green)
  //   ≥4 → white
  if (count == 0u) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  } else if (count == 1u) {
    return vec4<f32>(1.0, 0.0, 0.0, 1.0);
  } else if (count == 2u) {
    return vec4<f32>(1.0, 1.0, 0.0, 1.0);
  } else if (count == 3u) {
    return vec4<f32>(1.0, 0.5, 0.0, 1.0);
  }
  return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}
