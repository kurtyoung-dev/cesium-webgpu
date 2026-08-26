// PointCloudLOD.wgsl — GPU compute shader for point cloud LOD selection
//
// Performs projected-geometric-error LOD filtering and screen-space density control
// for large point cloud datasets (3D Tiles pnts, LAS/LAZ).
//
// Each point is tested against:
//   1. Projected geometric error → selects a LOD level
//   2. Selected LOD level → deterministic screen-space density decimation
//   3. Frustum containment → cull points outside view
//
// Output: compacted index buffer of visible points + atomic count.
// The host reads visibleCount to set the draw call's vertex count.
//
// Workgroup size: 256 threads, one point per thread.
// Dispatch: ceil(pointCount / 256) workgroups.

struct LODParams {
  cameraPositionLocal: vec3<f32>,
  _pad0: f32,
  projectionScale: f32,
  targetPixelSpacing: f32,
  geometricError: f32,
  lodFarDistance: f32,
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
  _pad2: vec2<f32>,
  modelLinear0: vec4<f32>,
  modelLinear1: vec4<f32>,
  modelLinear2: vec4<f32>,
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
// Dedicated broadcast slot for the global output offset. The earlier
// design reused sharedVisible[255] to broadcast this value, but at full
// workgroup occupancy localCount can equal 256 (LOD 0 keeps every point
// and all pass the frustum test), in which case sharedVisible[255] holds
// a REAL compacted point index — overwriting it corrupted that point
// (it got written to the output as the base offset instead of its true
// index). A separate scalar slot removes the data/broadcast aliasing.
var<workgroup> sharedGlobalOffset: u32;
var<workgroup> sharedGrantedCount: u32;

// Atomically reserve a range without ever publishing a visible count above
// the draw budget. A plain atomicAdd followed by write-side clipping leaves
// drawIndirect reading the unclipped count and indexing past visibleIndices.
fn reserveVisibleRange(requested: u32) -> vec2<u32> {
  var observed = atomicLoad(&visibleCount);
  loop {
    if (observed >= params.maxVisiblePoints || requested == 0u) {
      return vec2<u32>(params.maxVisiblePoints, 0u);
    }
    let desired = observed + min(requested, params.maxVisiblePoints - observed);
    let result = atomicCompareExchangeWeak(&visibleCount, observed, desired);
    if (result.exchanged) {
      return vec2<u32>(observed, desired - observed);
    }
    observed = result.old_value;
  }
  // Required by conservative WGSL control-flow validation. The loop returns
  // on every semantic path, so this fallback is unreachable.
  return vec2<u32>(params.maxVisiblePoints, 0u);
}

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

fn worldCameraDistance(pos: vec3<f32>) -> f32 {
  let localDelta = pos - params.cameraPositionLocal;
  let worldDelta = vec3<f32>(
    dot(params.modelLinear0.xyz, localDelta),
    dot(params.modelLinear1.xyz, localDelta),
    dot(params.modelLinear2.xyz, localDelta),
  );
  return length(worldDelta);
}

fn projectedSpacing(cameraDistance: f32) -> f32 {
  return params.geometricError * params.projectionScale /
    max(cameraDistance, 1e-4);
}

fn selectLOD(pos: vec3<f32>) -> u32 {
  let cameraDistance = worldCameraDistance(pos);
  if (params.lodFarDistance > 0.0 && cameraDistance > params.lodFarDistance) {
    return 4u;
  }
  let ratio = projectedSpacing(cameraDistance) / max(params.targetPixelSpacing, 0.25);
  if (ratio >= 4.0) { return 0u; }
  if (ratio >= 2.0) { return 1u; }
  if (ratio >= 1.0) { return 2u; }
  return 3u;
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
      // Step 2: projected-error LOD responds to distance and viewport size.
      let lodLevel = selectLOD(pos);

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

  // First thread allocates a contiguous range in the global output and
  // broadcasts the base offset to the rest of the workgroup via a
  // dedicated scalar (NOT a sharedVisible slot — see sharedGlobalOffset).
  let localCount = atomicLoad(&sharedCount);

  if (lid.x == 0u) {
    let reservation = reserveVisibleRange(localCount);
    sharedGlobalOffset = reservation.x;
    sharedGrantedCount = reservation.y;
  }
  workgroupBarrier();

  let baseOffset = sharedGlobalOffset;

  if (lid.x < sharedGrantedCount) {
    let globalIdx = baseOffset + lid.x;
    visibleIndices[globalIdx] = sharedVisible[lid.x];
  }
}

// ─── Subgroup-accelerated variant ────────────────────────────────────────────
// Same semantics as `computeMain` but uses subgroupBallot to collapse the
// per-thread atomicAdd contention on `visibleCount` into one atomic per
// subgroup. On NVIDIA / Intel / Apple / modern AMD this is 2-4× faster on
// workloads where most points are visible (high-density LOD 0/1 frames).
//
// IMPORTANT: WGSL requires `enable subgroups;` to precede every global
// declaration. The host preprocessor (WebGPUGPUCuller-style) prepends the
// directive on capable devices and strips this entire block via the
// __SUBGROUP_BLOCK_*__ sentinels on non-capable devices. Do not remove the
// sentinel comments.

// __SUBGROUP_BLOCK_START__
@compute @workgroup_size(256)
fn computeMainSubgroups(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(subgroup_invocation_id) sgLocalId: u32,
) {
  let pointIndex = gid.x;

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
    if (frustumTest(pos)) {
      let lodLevel = selectLOD(pos);
      if (lodLevel < 4u && shouldKeepAtLOD(pointIndex, lodLevel)) {
        isVisible = true;
      }
    }
  }

  // Subgroup-collapsed local compaction:
  //   - Each subgroup runs one ballot to count its visible lanes
  //   - Lane 0 of the subgroup performs ONE atomicAdd into sharedCount
  //     to reserve a contiguous slot range for the subgroup
  //   - Each visible lane then writes to its slot using its rank within
  //     the subgroup (popcount of lower-id lanes' visibility bits)
  let ballot = subgroupBallot(isVisible);
  let visibleInSubgroup =
    countOneBits(ballot.x) + countOneBits(ballot.y) +
    countOneBits(ballot.z) + countOneBits(ballot.w);

  // Lane rank within the subgroup's visible mask: count visibility bits
  // strictly below this lane's id. Branch explicitly because WGSL `select`
  // evaluates BOTH operands and `(1u << (sgLocalId - 32u))` would underflow
  // when sgLocalId < 32 even if the result is unused.
  let laneInWord = sgLocalId & 31u;
  let partialMask = select((1u << laneInWord) - 1u, 0u, laneInWord == 0u);
  let word = sgLocalId >> 5u;
  let laneMask0 = select(select(0u, partialMask, word == 0u), 0xFFFFFFFFu, word > 0u);
  let laneMask1 = select(select(0u, partialMask, word == 1u), 0xFFFFFFFFu, word > 1u);
  let laneMask2 = select(select(0u, partialMask, word == 2u), 0xFFFFFFFFu, word > 2u);
  let laneMask3 = select(0u, partialMask, word == 3u);
  let myRankInSubgroup =
    countOneBits(ballot.x & laneMask0) +
    countOneBits(ballot.y & laneMask1) +
    countOneBits(ballot.z & laneMask2) +
    countOneBits(ballot.w & laneMask3);

  var subgroupBase: u32 = 0u;
  if (sgLocalId == 0u && visibleInSubgroup > 0u) {
    subgroupBase = atomicAdd(&sharedCount, visibleInSubgroup);
  }
  // Broadcast lane 0's reserved offset to all lanes in the subgroup
  let myBase = subgroupBroadcast(subgroupBase, 0u);

  if (isVisible) {
    sharedVisible[myBase + myRankInSubgroup] = pointIndex;
  }

  workgroupBarrier();

  // Broadcast the reserved global offset via the dedicated scalar slot,
  // not sharedVisible[255] — at full occupancy localCount == 256 and
  // sharedVisible[255] holds a live compacted point index.
  let localCount = atomicLoad(&sharedCount);
  if (lid.x == 0u) {
    let reservation = reserveVisibleRange(localCount);
    sharedGlobalOffset = reservation.x;
    sharedGrantedCount = reservation.y;
  }
  workgroupBarrier();

  let baseOffset = sharedGlobalOffset;
  if (lid.x < sharedGrantedCount) {
    let globalIdx = baseOffset + lid.x;
    visibleIndices[globalIdx] = sharedVisible[lid.x];
  }
}
// __SUBGROUP_BLOCK_END__
