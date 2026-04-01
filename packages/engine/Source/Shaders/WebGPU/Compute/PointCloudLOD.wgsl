// PointCloudLOD.wgsl — GPU compute shader for point cloud LOD selection
//
// Performs distance-based LOD filtering and screen-space density control
// for large point cloud datasets (3D Tiles pnts, LAS/LAZ).
//
// Each point is tested against:
//   1. Camera distance → maps to a LOD level
//   2. Screen-space point spacing → density decimation
//   3. Frustum containment → cull points outside view
//
// Output: compacted index buffer of visible points + atomic count.
// The host reads visibleCount to set the draw call's vertex count.
//
// Workgroup size: 256 threads, one point per thread.
// Dispatch: ceil(pointCount / 256) workgroups.

struct LODParams {
  cameraPositionWC: vec3<f32>,
  _pad0: f32,
  // LOD thresholds: distance² boundaries for each level
  // Points beyond lod3Distance² are culled entirely
  lod0Distance2: f32,   // Full detail
  lod1Distance2: f32,   // 1/4 points (every 4th)
  lod2Distance2: f32,   // 1/16 points (every 16th)
  lod3Distance2: f32,   // 1/64 points (every 64th) — beyond this = culled
  // Frustum planes (6 × vec4, packed as 2 arrays of 3)
  frustumPlane0: vec4<f32>,
  frustumPlane1: vec4<f32>,
  frustumPlane2: vec4<f32>,
  frustumPlane3: vec4<f32>,
  frustumPlane4: vec4<f32>,
  frustumPlane5: vec4<f32>,
  // Point count and screen-space target
  pointCount: u32,
  maxVisiblePoints: u32,  // Budget cap to prevent overdraw
  screenSpaceRadius: f32, // Target minimum spacing in pixels
  geometricError: f32,    // Tile's geometric error for LOD refinement
}

// Input: point positions (could be quantized, decoded on CPU beforehand)
@group(0) @binding(0) var<uniform> params: LODParams;
@group(0) @binding(1) var<storage, read> positionsX: array<f32>;
@group(0) @binding(2) var<storage, read> positionsY: array<f32>;
@group(0) @binding(3) var<storage, read> positionsZ: array<f32>;

// Output: compacted visible point indices
@group(0) @binding(4) var<storage, read_write> visibleIndices: array<u32>;
@group(0) @binding(5) var<storage, read_write> visibleCount: atomic<u32>;

// Shared memory for workgroup-level compaction
var<workgroup> sharedVisible: array<u32, 256>;
var<workgroup> sharedCount: atomic<u32>;

fn frustumTest(pos: vec3<f32>) -> bool {
  // Test point against 6 frustum planes
  let planes = array<vec4<f32>, 6>(
    params.frustumPlane0, params.frustumPlane1, params.frustumPlane2,
    params.frustumPlane3, params.frustumPlane4, params.frustumPlane5,
  );

  for (var i = 0u; i < 6u; i++) {
    let d = dot(planes[i].xyz, pos) + planes[i].w;
    if (d < 0.0) {
      return false;
    }
  }
  return true;
}

fn distanceSquared(a: vec3<f32>, b: vec3<f32>) -> f32 {
  let d = a - b;
  return dot(d, d);
}

// Deterministic hash for LOD decimation — ensures stable point selection
// across frames (no flickering). Based on point index modulo.
fn shouldKeepAtLOD(pointIndex: u32, lodLevel: u32) -> bool {
  if (lodLevel == 0u) { return true; }             // LOD 0: keep all
  if (lodLevel == 1u) { return (pointIndex & 3u) == 0u; }  // LOD 1: every 4th
  if (lodLevel == 2u) { return (pointIndex & 15u) == 0u; } // LOD 2: every 16th
  return (pointIndex & 63u) == 0u;                 // LOD 3: every 64th
}

@compute @workgroup_size(256)
fn computeMain(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
) {
  let pointIndex = gid.x;

  // Initialize shared atomic on first thread
  if (lid.x == 0u) {
    atomicStore(&sharedCount, 0u);
  }
  workgroupBarrier();

  var isVisible = false;

  if (pointIndex < params.pointCount) {
    let pos = vec3<f32>(
      positionsX[pointIndex],
      positionsY[pointIndex],
      positionsZ[pointIndex],
    );

    // Step 1: Frustum culling
    if (frustumTest(pos)) {
      // Step 2: Distance-based LOD level
      let dist2 = distanceSquared(pos, params.cameraPositionWC);

      var lodLevel = 4u; // Beyond all LODs = culled
      if (dist2 < params.lod0Distance2) {
        lodLevel = 0u;
      } else if (dist2 < params.lod1Distance2) {
        lodLevel = 1u;
      } else if (dist2 < params.lod2Distance2) {
        lodLevel = 2u;
      } else if (dist2 < params.lod3Distance2) {
        lodLevel = 3u;
      }

      // Step 3: Decimation filter based on LOD level
      if (lodLevel < 4u && shouldKeepAtLOD(pointIndex, lodLevel)) {
        isVisible = true;
      }
    }
  }

  // Workgroup-level compaction using shared memory
  if (isVisible) {
    let localSlot = atomicAdd(&sharedCount, 1u);
    sharedVisible[localSlot] = pointIndex;
  }

  workgroupBarrier();

  // First thread allocates a contiguous range in the global output
  var globalOffset = 0u;
  let localCount = atomicLoad(&sharedCount);

  if (lid.x == 0u && localCount > 0u) {
    globalOffset = atomicAdd(&visibleCount, localCount);
  }

  workgroupBarrier();

  // Copy workgroup results to global output (all threads participate)
  // Re-read globalOffset from shared memory via the first thread's result
  // We need to broadcast globalOffset — use shared memory trick
  if (lid.x == 0u) {
    // Reuse slot 255 to broadcast the offset (safe because localCount < 256)
    sharedVisible[255u] = globalOffset;
  }
  workgroupBarrier();

  let baseOffset = sharedVisible[255u];

  if (lid.x < localCount) {
    let globalIdx = baseOffset + lid.x;
    // Budget cap: don't write beyond maxVisiblePoints
    if (globalIdx < params.maxVisiblePoints) {
      visibleIndices[globalIdx] = sharedVisible[lid.x];
    }
  }
}
