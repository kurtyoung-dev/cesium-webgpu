// PointCloudSort.wgsl — GPU bitonic merge sort for point cloud depth ordering
//
// Sorts point indices by distance-to-camera for correct back-to-front
// transparency rendering of point cloud data (3D Tiles, LAS/LAZ).
//
// Algorithm: Parallel bitonic sort on packed (distance, index) pairs.
// Each element is a u32 pair stored as two separate arrays (SOA) for
// coalesced memory access. The sort key is the squared distance to camera
// (avoids sqrt), stored as a u32 bitcast of f32 with sign-flip for
// correct unsigned comparison ordering.
//
// Dispatch model:
//   Phase 1: Local bitonic sort within workgroups (shared memory)
//   Phase 2: Global bitonic merge across workgroups (storage buffers)
//
// Each dispatch handles one "k,j" step of the bitonic network.
// Host dispatches O(log²N) passes total.
//
// Workgroup size: 256 threads, each handling one element.
// Maximum per-workgroup sort: 256 elements (phase 1).
// For N > 256, multiple global merge passes required.

struct SortParams {
  elementCount: u32,   // Total number of points to sort
  k: u32,             // Bitonic block size (power of 2)
  j: u32,             // Bitonic step within block (power of 2)
  _pad: u32,
}

@group(0) @binding(0) var<uniform> params: SortParams;
@group(0) @binding(1) var<storage, read_write> sortKeys: array<u32>;   // bitcast f32 distance
@group(0) @binding(2) var<storage, read_write> indices: array<u32>;    // original point index

var<workgroup> sharedKeys: array<u32, 256>;
var<workgroup> sharedIndices: array<u32, 256>;

// Float-to-sortable-uint: flip sign bit so IEEE 754 floats sort correctly
// as unsigned integers. Positive floats already sort correctly; negative
// floats need all bits flipped.
fn floatToSortableUint(f: f32) -> u32 {
  let bits = bitcast<u32>(f);
  // If sign bit is set (negative), flip all bits; otherwise flip only sign bit
  let mask = select(0x80000000u, 0xFFFFFFFFu, (bits & 0x80000000u) != 0u);
  return bits ^ mask;
}

fn sortableUintToFloat(u: u32) -> f32 {
  let mask = select(0x80000000u, 0xFFFFFFFFu, (u & 0x80000000u) == 0u);
  return bitcast<f32>(u ^ mask);
}

// ═══════════════════════════════════════════════════════════
// LOCAL SORT — Bitonic sort within a single workgroup using shared memory
// ═══════════════════════════════════════════════════════════

@compute @workgroup_size(256)
fn localBitonicSort(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(workgroup_id) wid: vec3<u32>,
) {
  let localIdx = lid.x;
  let globalIdx = wid.x * 256u + localIdx;

  // Load into shared memory (pad with max value for out-of-bounds)
  if (globalIdx < params.elementCount) {
    sharedKeys[localIdx] = sortKeys[globalIdx];
    sharedIndices[localIdx] = indices[globalIdx];
  } else {
    sharedKeys[localIdx] = 0xFFFFFFFFu; // Sort to end
    sharedIndices[localIdx] = 0xFFFFFFFFu;
  }

  workgroupBarrier();

  // Bitonic sort network within workgroup (up to 256 elements)
  // k = block size (2, 4, 8, ..., 256)
  for (var k = 2u; k <= 256u; k = k << 1u) {
    // j = comparison distance (k/2, k/4, ..., 1)
    for (var j = k >> 1u; j > 0u; j = j >> 1u) {
      let ixj = localIdx ^ j;
      if (ixj > localIdx) {
        // Determine sort direction: ascending in first half of block,
        // descending in second half — builds bitonic sequence
        let ascending = (localIdx & k) == 0u;

        let keyA = sharedKeys[localIdx];
        let keyB = sharedKeys[ixj];

        let shouldSwap = select(keyA < keyB, keyA > keyB, ascending);
        if (shouldSwap) {
          sharedKeys[localIdx] = keyB;
          sharedKeys[ixj] = keyA;
          let tmpIdx = sharedIndices[localIdx];
          sharedIndices[localIdx] = sharedIndices[ixj];
          sharedIndices[ixj] = tmpIdx;
        }
      }
      workgroupBarrier();
    }
  }

  // Write back to global memory
  if (globalIdx < params.elementCount) {
    sortKeys[globalIdx] = sharedKeys[localIdx];
    indices[globalIdx] = sharedIndices[localIdx];
  }
}

// ═══════════════════════════════════════════════════════════
// GLOBAL MERGE — One step of the bitonic merge across workgroups
// ═══════════════════════════════════════════════════════════
//
// Dispatched once per (k, j) pair where k > 256 (workgroup size).
// Host iterates: for k in [512, 1024, ..., N]: for j in [k/2, ..., 1]: dispatch

@compute @workgroup_size(256)
fn globalBitonicMerge(
  @builtin(global_invocation_id) gid: vec3<u32>,
) {
  let idx = gid.x;
  if (idx >= params.elementCount) {
    return;
  }

  let k = params.k;
  let j = params.j;

  let ixj = idx ^ j;

  // Only the lower-indexed thread of each pair performs the comparison
  if (ixj <= idx) {
    return;
  }

  // Bounds check partner
  if (ixj >= params.elementCount) {
    return;
  }

  let ascending = (idx & k) == 0u;

  let keyA = sortKeys[idx];
  let keyB = sortKeys[ixj];

  let shouldSwap = select(keyA < keyB, keyA > keyB, ascending);
  if (shouldSwap) {
    sortKeys[idx] = keyB;
    sortKeys[ixj] = keyA;
    let tmpIdx = indices[idx];
    indices[idx] = indices[ixj];
    indices[ixj] = tmpIdx;
  }
}
