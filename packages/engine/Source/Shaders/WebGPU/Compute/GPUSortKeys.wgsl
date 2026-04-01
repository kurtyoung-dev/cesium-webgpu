// GPUSortKeys.wgsl — GPU compute shader for draw command sort key generation
//
// Generates packed 64-bit sort keys for >50K draw commands to enable
// GPU-driven rendering with minimal CPU overhead. Sort keys encode:
//
//   Bits 63-60: Render layer (4 bits, 0-15)
//   Bits 59-52: Sort priority (8 bits, 0-255)
//   Bits 51-36: Material sort ID (16 bits, 0-65535)
//   Bits 35-4:  Distance (32 bits, float-to-sortable-uint)
//   Bits 3-0:   Sub-sort tiebreaker (4 bits)
//
// The packed key is stored as two u32 values (high, low) per command.
// After key generation, a GPU bitonic sort (PointCloudSort.wgsl or
// dedicated radix sort) reorders the command indices by key.
//
// This replaces the CPU-side multi-level comparator in Scene.js for
// large command counts (>50K) where JS sort becomes the bottleneck.
//
// Workgroup size: 256 threads, one command per thread.
// Dispatch: ceil(commandCount / 256) workgroups.

struct SortKeyParams {
  commandCount: u32,
  cameraPositionX: f32,
  cameraPositionY: f32,
  cameraPositionZ: f32,
  // Sort mode flags
  sortMode: u32,       // 0=frontToBack (opaque), 1=backToFront (translucent)
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

// Per-command metadata in SOA layout for coalesced reads.
// Each array has commandCount elements.
struct CommandMetadata {
  // Bounding sphere center for distance calculation
  centerX: f32,
  centerY: f32,
  centerZ: f32,
  // Pre-assigned sort properties from CPU
  renderLayer: u32,    // 0-15
  sortPriority: u32,   // 0-255
  materialSortId: u32, // 0-65535
}

@group(0) @binding(0) var<uniform> params: SortKeyParams;

// SOA input: command bounding sphere centers
@group(0) @binding(1) var<storage, read> centerX: array<f32>;
@group(0) @binding(2) var<storage, read> centerY: array<f32>;
@group(0) @binding(3) var<storage, read> centerZ: array<f32>;

// SOA input: pre-assigned sort properties
@group(0) @binding(4) var<storage, read> renderLayers: array<u32>;
@group(0) @binding(5) var<storage, read> sortPriorities: array<u32>;
@group(0) @binding(6) var<storage, read> materialSortIds: array<u32>;

// Output: packed sort keys (high and low u32)
@group(0) @binding(7) var<storage, read_write> sortKeysHigh: array<u32>;
@group(0) @binding(8) var<storage, read_write> sortKeysLow: array<u32>;

// Output: command indices (initialized to identity, reordered by sort)
@group(0) @binding(9) var<storage, read_write> commandIndices: array<u32>;

// Float-to-sortable-uint for correct unsigned comparison
fn floatToSortableUint(f: f32) -> u32 {
  let bits = bitcast<u32>(f);
  let mask = select(0x80000000u, 0xFFFFFFFFu, (bits & 0x80000000u) != 0u);
  return bits ^ mask;
}

@compute @workgroup_size(256)
fn computeMain(
  @builtin(global_invocation_id) gid: vec3<u32>,
) {
  let cmdIndex = gid.x;
  if (cmdIndex >= params.commandCount) {
    return;
  }

  // Read command metadata
  let cx = centerX[cmdIndex];
  let cy = centerY[cmdIndex];
  let cz = centerZ[cmdIndex];
  let layer = renderLayers[cmdIndex] & 0xFu;       // Clamp to 4 bits
  let priority = sortPriorities[cmdIndex] & 0xFFu;  // Clamp to 8 bits
  let matId = materialSortIds[cmdIndex] & 0xFFFFu;  // Clamp to 16 bits

  // Compute squared distance to camera
  let dx = cx - params.cameraPositionX;
  let dy = cy - params.cameraPositionY;
  let dz = cz - params.cameraPositionZ;
  let dist2 = dx * dx + dy * dy + dz * dz;

  // Convert distance to sortable uint
  var distKey = floatToSortableUint(dist2);

  // For back-to-front (translucent), invert distance so farther = lower key
  if (params.sortMode == 1u) {
    distKey = ~distKey;
  }

  // Pack into 64-bit key (two u32s)
  // High word: layer(4) | priority(8) | materialSortId_high(4) = 16 bits
  //            + materialSortId_low(12) | distance_high(4) = 16 bits
  // Low word:  distance(28) | tiebreaker(4)
  //
  // Simplified packing:
  //   High: [layer:4][priority:8][matId:16][distHigh:4]
  //   Low:  [distLow:28][subSort:4]

  let highWord = (layer << 28u) |
                 (priority << 20u) |
                 (matId << 4u) |
                 ((distKey >> 28u) & 0xFu);

  let lowWord = ((distKey & 0x0FFFFFFFu) << 4u) |
                (cmdIndex & 0xFu); // Sub-sort tiebreaker: original index

  sortKeysHigh[cmdIndex] = highWord;
  sortKeysLow[cmdIndex] = lowWord;

  // Initialize command index to identity (will be reordered by sort pass)
  commandIndices[cmdIndex] = cmdIndex;
}
