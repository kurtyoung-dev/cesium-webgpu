// BitonicSortU64.wgsl — GPU bitonic merge sort for packed 64-bit keys.
//
// Phase 2 consumer for `GPUSortKeys.wgsl`'s `(sortKeysHigh, sortKeysLow,
// commandIndices)` triple. Sorts by the 64-bit key formed by treating
// `(high, low)` as a `u64` lexicographically: compare high first, then
// low if high is equal.
//
// Key format produced by GPUSortKeys (front-to-back ascending):
//   high = (renderLayer << 24) | (~depthBits << 0)  [conservative — see Note]
//   low  = (sortPriority << 16) | materialSortId
//
// (We don't need to know the exact packing here — the sort is purely
// numerical on the (high, low) tuple. The host decides what each bit
// means via how it packs the keys.)
//
// Algorithm: parallel bitonic sort. Two stages:
//   - Phase 1: localBitonicSort256 — fully sorts groups of 256
//   - Phase 2: globalBitonicMerge — merges pairs across groups
//
// Same network shape as PointCloudSort.wgsl; only the comparator
// differs (u32 → u64-via-pair).

struct SortParams {
  elementCount: u32,
  k: u32,
  j: u32,
  _pad: u32,
}

@group(0) @binding(0) var<uniform> params: SortParams;
@group(0) @binding(1) var<storage, read_write> sortKeysHigh: array<u32>;
@group(0) @binding(2) var<storage, read_write> sortKeysLow: array<u32>;
@group(0) @binding(3) var<storage, read_write> commandIndices: array<u32>;

var<workgroup> sharedHigh: array<u32, 256>;
var<workgroup> sharedLow: array<u32, 256>;
var<workgroup> sharedIdx: array<u32, 256>;

// Compare (aHi, aLo) < (bHi, bLo) as u64.
fn lessThanU64(aHi: u32, aLo: u32, bHi: u32, bLo: u32) -> bool {
  if (aHi != bHi) {
    return aHi < bHi;
  }
  return aLo < bLo;
}

fn greaterThanU64(aHi: u32, aLo: u32, bHi: u32, bLo: u32) -> bool {
  if (aHi != bHi) {
    return aHi > bHi;
  }
  return aLo > bLo;
}

// ═══════════════════════════════════════════════════════════
// LOCAL SORT — Bitonic sort within a single workgroup
// ═══════════════════════════════════════════════════════════

@compute @workgroup_size(256)
fn localBitonicSort256(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(workgroup_id) wid: vec3<u32>,
) {
  let localIdx = lid.x;
  let globalIdx = wid.x * 256u + localIdx;

  if (globalIdx < params.elementCount) {
    sharedHigh[localIdx] = sortKeysHigh[globalIdx];
    sharedLow[localIdx] = sortKeysLow[globalIdx];
    sharedIdx[localIdx] = commandIndices[globalIdx];
  } else {
    // Pad with maximum u64 so OOB elements sort to the end.
    sharedHigh[localIdx] = 0xFFFFFFFFu;
    sharedLow[localIdx] = 0xFFFFFFFFu;
    sharedIdx[localIdx] = 0xFFFFFFFFu;
  }

  workgroupBarrier();

  for (var k = 2u; k <= 256u; k = k << 1u) {
    for (var j = k >> 1u; j > 0u; j = j >> 1u) {
      let ixj = localIdx ^ j;
      if (ixj > localIdx) {
        let ascending = (localIdx & k) == 0u;
        let aHi = sharedHigh[localIdx];
        let aLo = sharedLow[localIdx];
        let bHi = sharedHigh[ixj];
        let bLo = sharedLow[ixj];
        let aLessThanB = lessThanU64(aHi, aLo, bHi, bLo);
        let aGreaterThanB = greaterThanU64(aHi, aLo, bHi, bLo);
        // ascending  → swap when a > b
        // descending → swap when a < b
        let shouldSwap = select(aLessThanB, aGreaterThanB, ascending);
        if (shouldSwap) {
          sharedHigh[localIdx] = bHi;
          sharedLow[localIdx] = bLo;
          sharedHigh[ixj] = aHi;
          sharedLow[ixj] = aLo;
          let tmpIdx = sharedIdx[localIdx];
          sharedIdx[localIdx] = sharedIdx[ixj];
          sharedIdx[ixj] = tmpIdx;
        }
      }
      workgroupBarrier();
    }
  }

  if (globalIdx < params.elementCount) {
    sortKeysHigh[globalIdx] = sharedHigh[localIdx];
    sortKeysLow[globalIdx] = sharedLow[localIdx];
    commandIndices[globalIdx] = sharedIdx[localIdx];
  }
}

// ═══════════════════════════════════════════════════════════
// GLOBAL MERGE — One step of the bitonic merge across workgroups
// ═══════════════════════════════════════════════════════════

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

  if (ixj <= idx) {
    return;
  }
  if (ixj >= params.elementCount) {
    return;
  }

  let ascending = (idx & k) == 0u;
  let aHi = sortKeysHigh[idx];
  let aLo = sortKeysLow[idx];
  let bHi = sortKeysHigh[ixj];
  let bLo = sortKeysLow[ixj];
  let aLessThanB = lessThanU64(aHi, aLo, bHi, bLo);
  let aGreaterThanB = greaterThanU64(aHi, aLo, bHi, bLo);
  let shouldSwap = select(aLessThanB, aGreaterThanB, ascending);
  if (shouldSwap) {
    sortKeysHigh[idx] = bHi;
    sortKeysLow[idx] = bLo;
    sortKeysHigh[ixj] = aHi;
    sortKeysLow[ixj] = aLo;
    let aIdx = commandIndices[idx];
    commandIndices[idx] = commandIndices[ixj];
    commandIndices[ixj] = aIdx;
  }
}
