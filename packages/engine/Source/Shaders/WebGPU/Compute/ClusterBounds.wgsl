// ClusterBounds.wgsl — Forward+ cluster-bounds compute shader
//
// Slice 5d Batch 137c, NEW-GBUFFER-CONSUMER-CLUSTERED-LIGHTING step 3.
//
// One thread per cluster in a (X, Y, Z) = (16, 9, 24) grid (3456
// clusters total — matches toji/webgpu-clustered-shading). Each
// thread:
//
//   1. Resolves its (tileX, tileY, sliceZ) coordinates from the
//      `@builtin(global_invocation_id)`.
//   2. Computes the cluster's 8 corner positions in eye-space by
//      unprojecting the 4 screen-space tile corners at two depth
//      slices (sliceZ and sliceZ + 1).
//   3. Reduces the 8 corners to an AABB (min vec4 + max vec4) and
//      writes the pair to the storage buffer at index
//      `tileX + tileY*16 + sliceZ*16*9`.
//
// Eye-space AABB is the right space for downstream light-cluster
// assignment (NEW-GBUFFER-CONSUMER-CLUSTERED-LIGHTING step 4): each
// punctual light projects its position/range to eye-space via the
// view matrix once per frame, and the sphere-AABB intersection test
// runs entirely in eye-space.
//
// **RTE delta from toji's example:** eye-space positions are small
// enough to fit in f32 without losing precision, so this compute
// shader does NOT need the encodedCameraHigh/Low RTE plumbing that
// every other Cesium-WebGPU shader carries. The view-space cluster
// bounds are bounded by the frustum near/far planes (typically meters
// to kilometers), well within f32 precision.
//
// **Depth slice distribution:** exponential between near and far per
// the canonical Forward+ literature. Equal screen-space tiles at
// every depth slice → uniform on-screen cluster density.
//
//   sliceZ(i) = -near * (far / near) ^ (i / NUM_Z_SLICES)
//
// The negative sign keeps the convention: in Cesium WebGPU eye-space,
// Z grows positive forward (camera looks toward +Z), so cluster
// bounds at increasing slice index advance INTO the scene. The
// `unprojectNdcToView` helper below already accounts for this.

const TILE_COUNT_X: u32 = 16u;
const TILE_COUNT_Y: u32 = 9u;
const SLICE_COUNT_Z: u32 = 24u;
const TOTAL_CLUSTERS: u32 = TILE_COUNT_X * TILE_COUNT_Y * SLICE_COUNT_Z;

// Per-frame uniform: viewport size + frustum near/far + inverse
// projection matrix (used to unproject NDC → eye-space corners).
//
// 32 bytes of vec4 + 64 bytes of mat4 = 96 bytes total. Padded to
// the 256-byte uniform-buffer alignment minimum at allocation site.
struct ClusterBoundsUniforms {
  // .x = viewport width, .y = viewport height, .z = near, .w = far
  viewportAndPlanes: vec4<f32>,
  // .x = tileCountX, .y = tileCountY, .z = sliceCountZ, .w = unused
  // (kept as f32 since u32 cluster counts are tiny — converted at
  // use site)
  gridDims: vec4<f32>,
  inverseProjection: mat4x4<f32>,
};

// Per-cluster AABB: min.xyz + max.xyz packed into 2 vec4 (the .w
// channels carry padding so the storage buffer's per-element size is
// 32 bytes — clean 16-byte alignment for downstream consumers).
struct ClusterAABB {
  minPos: vec4<f32>,
  maxPos: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: ClusterBoundsUniforms;
@group(0) @binding(1) var<storage, read_write> clusterAABBs: array<ClusterAABB>;

// Unproject an NDC position (XY in [-1, 1], Z in [0, 1]) into eye
// space using the inverse projection matrix. Returns the eye-space
// position (.xyz) after perspective division.
fn unprojectNdcToView(ndc: vec3<f32>) -> vec3<f32> {
  let clip = vec4<f32>(ndc, 1.0);
  let view = uniforms.inverseProjection * clip;
  return view.xyz / view.w;
}

// Compute the eye-space Z for a given depth slice index. Uses the
// standard exponential distribution from the Forward+ literature so
// near clusters are tightly packed and far clusters spread out.
fn sliceZ(sliceIndex: f32) -> f32 {
  let near = uniforms.viewportAndPlanes.z;
  let far = uniforms.viewportAndPlanes.w;
  let numSlices = uniforms.gridDims.z;
  // sliceIndex ∈ [0, numSlices]. Returns eye-space Z (positive forward).
  return near * pow(far / near, sliceIndex / numSlices);
}

// Convert an eye-space Z (positive forward) into the matching NDC Z.
// We re-derive this rather than store a separate uniform because the
// inverse-projection path already encodes the projection details.
//
// For a standard perspective projection with the WebGPU clip range
// [0, 1]:
//
//   clip.w  = viewZ
//   clip.z  = (far * (viewZ - near)) / (viewZ * (far - near))
//
// Standard derivation; matches what GLM/glm and the WGSL canonical
// pipelines produce.
fn viewZToNdcZ(viewZ: f32) -> f32 {
  let near = uniforms.viewportAndPlanes.z;
  let far = uniforms.viewportAndPlanes.w;
  return (far * (viewZ - near)) / (viewZ * (far - near));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  // Bounds check against the 16×9×24 grid.
  if (gid.x >= TILE_COUNT_X || gid.y >= TILE_COUNT_Y || gid.z >= SLICE_COUNT_Z) {
    return;
  }

  let tileCountX = uniforms.gridDims.x;
  let tileCountY = uniforms.gridDims.y;

  // Screen-space tile bounds in NDC [-1, 1]. Each tile is
  // (2 / tileCountX, 2 / tileCountY) wide.
  let tileSizeX = 2.0 / tileCountX;
  let tileSizeY = 2.0 / tileCountY;
  let xMinNdc = -1.0 + f32(gid.x) * tileSizeX;
  let xMaxNdc = xMinNdc + tileSizeX;
  let yMinNdc = -1.0 + f32(gid.y) * tileSizeY;
  let yMaxNdc = yMinNdc + tileSizeY;

  // Depth slice bounds in eye-space Z, converted to NDC Z for the
  // unprojection. The unprojection runs through inverseProjection so
  // each corner picks up the projection's perspective distortion
  // automatically.
  let viewZNear = sliceZ(f32(gid.z));
  let viewZFar = sliceZ(f32(gid.z) + 1.0);
  let ndcZNear = viewZToNdcZ(viewZNear);
  let ndcZFar = viewZToNdcZ(viewZFar);

  // The 8 cluster corners in NDC:
  //   (xMin, yMin, zNear), (xMax, yMin, zNear),
  //   (xMin, yMax, zNear), (xMax, yMax, zNear),
  //   (xMin, yMin, zFar),  (xMax, yMin, zFar),
  //   (xMin, yMax, zFar),  (xMax, yMax, zFar)
  let c0 = unprojectNdcToView(vec3<f32>(xMinNdc, yMinNdc, ndcZNear));
  let c1 = unprojectNdcToView(vec3<f32>(xMaxNdc, yMinNdc, ndcZNear));
  let c2 = unprojectNdcToView(vec3<f32>(xMinNdc, yMaxNdc, ndcZNear));
  let c3 = unprojectNdcToView(vec3<f32>(xMaxNdc, yMaxNdc, ndcZNear));
  let c4 = unprojectNdcToView(vec3<f32>(xMinNdc, yMinNdc, ndcZFar));
  let c5 = unprojectNdcToView(vec3<f32>(xMaxNdc, yMinNdc, ndcZFar));
  let c6 = unprojectNdcToView(vec3<f32>(xMinNdc, yMaxNdc, ndcZFar));
  let c7 = unprojectNdcToView(vec3<f32>(xMaxNdc, yMaxNdc, ndcZFar));

  // Reduce 8 corners to an AABB.
  let aabbMin = min(
    min(min(c0, c1), min(c2, c3)),
    min(min(c4, c5), min(c6, c7)),
  );
  let aabbMax = max(
    max(max(c0, c1), max(c2, c3)),
    max(max(c4, c5), max(c6, c7)),
  );

  let index = gid.x + gid.y * TILE_COUNT_X + gid.z * TILE_COUNT_X * TILE_COUNT_Y;
  clusterAABBs[index].minPos = vec4<f32>(aabbMin, 0.0);
  clusterAABBs[index].maxPos = vec4<f32>(aabbMax, 0.0);
}
