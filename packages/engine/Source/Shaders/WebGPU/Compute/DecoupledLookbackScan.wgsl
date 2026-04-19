// DecoupledLookbackScan.wgsl — single-pass parallel prefix sum (u32).
//
// FEAT-SURVEY-06 — Based on the "decoupled lookback" pattern from
// Merrill & Garland 2016 (NVIDIA CUB) and the Vello `pathtag_scan`
// port. One compute dispatch computes an inclusive prefix sum of N
// u32s in a single kernel by having each workgroup publish its
// aggregate to a global "partition" array, then walk backward through
// prior partitions to find the inclusive prefix — without a separate
// global barrier pass.
//
// Replaces the two-pass (reduce + downsweep) approach currently used
// for draw-command visibility compaction. For Cesium's scale (~10-50k
// commands/frame) the win is modest (~20-30%), but the larger benefit
// is algorithmic: pairs with `GPUSortKeys` + indirect draws to avoid
// CPU roundtrips.
//
// Algorithm per workgroup:
//   1. Load segment into shared memory
//   2. Brent-Kung sweep (upsweep + downsweep) — produces EXCLUSIVE
//      scan within the workgroup
//   3. Lane 0 publishes the segment aggregate to partitions[wgId]
//      with flag = AGGREGATE
//   4. Lane 0 walks backward through prior partitions. For each:
//      - PREFIX: accumulate its value, stop walking
//      - AGGREGATE: accumulate its value, continue back
//      - EMPTY: spin-wait (or yield with storageBarrier)
//   5. Lane 0 publishes (exclusivePrefix + segmentAggregate) to
//      partitions[wgId] with flag = PREFIX
//   6. Broadcast exclusivePrefix to all lanes via shared memory
//   7. Write output[gid] = exclusivePrefix + localScan[lid] + input[gid]
//      (inclusive scan = exclusivePrefix + localExclusive + selfValue)
//
// @ref https://research.nvidia.com/publication/2016-03_single-pass-parallel-prefix-scan-decoupled-look-back

struct ScanParams {
  elementCount: u32,
  // Reserved — padded to 16 bytes so the UBO layout matches WebGPU
  // minimum uniform-buffer binding alignment.
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

@group(0) @binding(0) var<uniform> params: ScanParams;
@group(0) @binding(1) var<storage, read> inputBuffer: array<u32>;
@group(0) @binding(2) var<storage, read_write> outputBuffer: array<u32>;

// Global partition state. Each entry packs { flag, value }:
//   flag = bits 30..31 (0=empty, 1=aggregate, 2=prefix, 3=reserved)
//   value = bits 0..29 (the aggregate OR inclusive prefix)
// Host must zero this buffer before dispatch. Size must be at least
// ceil(elementCount / WORKGROUP_SIZE) u32 entries.
@group(0) @binding(3) var<storage, read_write> partitions: array<atomic<u32>>;

const WORKGROUP_SIZE: u32 = 256u;
const FLAG_EMPTY: u32 = 0u;
const FLAG_AGGREGATE: u32 = 1u;
const FLAG_PREFIX: u32 = 2u;
const FLAG_SHIFT: u32 = 30u;
const VALUE_MASK: u32 = 0x3FFFFFFFu;

// Shared memory for the workgroup-local Brent-Kung scan + prefix broadcast.
//   Slot [0..WORKGROUP_SIZE):    scratch for the scan
//   Slot [WORKGROUP_SIZE]:       broadcast slot for the exclusive prefix
var<workgroup> scratch: array<u32, 257>; // WORKGROUP_SIZE + 1

fn packPartition(flag: u32, value: u32) -> u32 {
  return (flag << FLAG_SHIFT) | (value & VALUE_MASK);
}
fn partitionFlag(packed: u32) -> u32 {
  return packed >> FLAG_SHIFT;
}
fn partitionValue(packed: u32) -> u32 {
  return packed & VALUE_MASK;
}

@compute @workgroup_size(256)
fn scan(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(workgroup_id) wid: vec3<u32>,
) {
  let globalIdx = gid.x;
  let localIdx = lid.x;
  let wgIdx = wid.x;

  // Load element (0 for out-of-bounds).
  let selfValue = select(
    0u,
    inputBuffer[globalIdx],
    globalIdx < params.elementCount,
  );
  scratch[localIdx] = selfValue;
  workgroupBarrier();

  // ── Brent-Kung upsweep ──
  // After the loop, scratch[WG-1] holds the total sum. Intermediate
  // slots hold partial sums at power-of-two strides.
  var offset: u32 = 1u;
  var d: u32 = WORKGROUP_SIZE >> 1u;
  while (d > 0u) {
    workgroupBarrier();
    if (localIdx < d) {
      let ai = offset * (2u * localIdx + 1u) - 1u;
      let bi = offset * (2u * localIdx + 2u) - 1u;
      scratch[bi] = scratch[bi] + scratch[ai];
    }
    offset = offset << 1u;
    d = d >> 1u;
  }

  // Remember the segment aggregate before the downsweep clears root.
  workgroupBarrier();
  let segmentAggregate = scratch[WORKGROUP_SIZE - 1u];

  // ── Brent-Kung downsweep ──
  // Produces an EXCLUSIVE scan in scratch[0..WG).
  if (localIdx == 0u) {
    scratch[WORKGROUP_SIZE - 1u] = 0u;
  }
  d = 1u;
  while (d < WORKGROUP_SIZE) {
    offset = offset >> 1u;
    workgroupBarrier();
    if (localIdx < d) {
      let ai = offset * (2u * localIdx + 1u) - 1u;
      let bi = offset * (2u * localIdx + 2u) - 1u;
      let t = scratch[ai];
      scratch[ai] = scratch[bi];
      scratch[bi] = scratch[bi] + t;
    }
    d = d << 1u;
  }
  workgroupBarrier();

  // localExclusive = exclusive scan of the workgroup-local segment.
  let localExclusive = scratch[localIdx];

  // ── Lane 0: publish aggregate + run decoupled lookback ──
  if (localIdx == 0u) {
    // Publish segment aggregate. Other workgroups walking back will
    // see this as AGGREGATE and continue their lookback.
    atomicStore(
      &partitions[wgIdx],
      packPartition(FLAG_AGGREGATE, segmentAggregate),
    );

    // Decoupled lookback: scan backward until we find a PREFIX entry.
    //   - PREFIX  → add its value, we have the complete prefix, stop.
    //   - AGGREGATE → add its value, continue walking further back.
    //   - EMPTY   → spin until the worker behind us publishes.
    //
    // Because wgIdx 0 has no predecessors, it skips this loop entirely
    // and its exclusive prefix is 0.
    var exclusivePrefix: u32 = 0u;
    if (wgIdx > 0u) {
      var lookback = i32(wgIdx) - 1;
      while (lookback >= 0) {
        // Spin until the partition is non-empty.
        var packed: u32 = 0u;
        loop {
          packed = atomicLoad(&partitions[u32(lookback)]);
          if (partitionFlag(packed) != FLAG_EMPTY) {
            break;
          }
          // `storageBarrier` here ensures we re-read fresh state rather
          // than CSE-ing the atomicLoad out of the loop on aggressive
          // drivers.
          storageBarrier();
        }
        exclusivePrefix = exclusivePrefix + partitionValue(packed);
        if (partitionFlag(packed) == FLAG_PREFIX) {
          // Found the complete prefix — aggregate of everything before.
          break;
        }
        // FLAG_AGGREGATE → continue walking back.
        lookback = lookback - 1;
      }
    }

    // Publish PREFIX = exclusivePrefix + segmentAggregate (inclusive
    // prefix up through THIS workgroup). Workers behind us can stop
    // walking as soon as they hit this entry.
    atomicStore(
      &partitions[wgIdx],
      packPartition(FLAG_PREFIX, exclusivePrefix + segmentAggregate),
    );

    // Stash exclusivePrefix in the broadcast slot so other lanes can
    // read it after the barrier below.
    scratch[WORKGROUP_SIZE] = exclusivePrefix;
  }
  workgroupBarrier();

  let exclusivePrefix = scratch[WORKGROUP_SIZE];

  // ── Write output ──
  // Inclusive scan: globalPrefix + localExclusive + selfValue.
  if (globalIdx < params.elementCount) {
    outputBuffer[globalIdx] = exclusivePrefix + localExclusive + selfValue;
  }
}
