// GPUSortKeys.wgsl — GPU compute shader for draw command sort key generation
//
// Generates packed 64-bit sort keys for >50K draw commands to enable
// GPU-driven rendering with minimal CPU overhead. Sort keys encode:
//
//   Bits 63-56: Render layer (8 bits, 0-255)
//   Bits 55-48: Sort priority (8 bits, 0-255)
//   Bits 47-32: Material sort ID (16 bits, 0-65535)
//   Bits 31-4:  Distance (top 28 bits of float-to-sortable-uint)
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
  sortMode: u32,       // 0=frontToBack (opaque), 1=backToFront (translucent)
  _pad0: u32,
  _pad1: u32,
}

// Per-command metadata in SOA layout for coalesced reads.
// Each array has commandCount elements.
struct CommandMetadata {
  // Canonical CPU bounding-volume distance for ordering
  distanceSquared: f32,
  // Pre-assigned sort properties from CPU
  renderLayer: u32,    // 0-255
  sortPriority: u32,   // 0-255
  materialSortId: u32, // 0-65535
}

@group(0) @binding(0) var<uniform> params: SortKeyParams;

// SOA input: precomputed `boundingVolume.distanceSquaredTo(camera)` values.
// Computing from a float32 center here is not equivalent for boxes/regions and
// loses Earth-scale precision before subtraction.
@group(0) @binding(1) var<storage, read> distanceSquared: array<f32>;

// SOA input: pre-assigned sort properties
@group(0) @binding(2) var<storage, read> renderLayers: array<u32>;
@group(0) @binding(3) var<storage, read> sortPriorities: array<u32>;
@group(0) @binding(4) var<storage, read> materialSortIds: array<u32>;

// Output: packed sort keys (high and low u32)
@group(0) @binding(5) var<storage, read_write> sortKeysHigh: array<u32>;
@group(0) @binding(6) var<storage, read_write> sortKeysLow: array<u32>;

// Output: command indices (initialized to identity, reordered by sort)
@group(0) @binding(7) var<storage, read_write> commandIndices: array<u32>;

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
  let dist2 = distanceSquared[cmdIndex];
  let layer = renderLayers[cmdIndex] & 0xFFu;      // Clamp to 8 bits
  let priority = sortPriorities[cmdIndex] & 0xFFu;  // Clamp to 8 bits
  let matId = materialSortIds[cmdIndex] & 0xFFFFu;  // Clamp to 16 bits

  // Convert distance to sortable uint
  var distKey = floatToSortableUint(dist2);

  // For back-to-front (translucent), invert distance so farther = lower key
  if (params.sortMode == 1u) {
    distKey = ~distKey;
  }

  // Pack into 64-bit key (two u32s)
  // High: [layer:8][priority:8][materialSortId:16]
  // Low:  [distance high-significance bits:28][sub-sort:4]
  //
  // Eight layer bits are required by the public RenderLayer.Order contract
  // (the built-in WORLD/ANNOTATIONS/OVERLAY values are 50/70/100). Keeping
  // four bits silently aliased those layers. The low four distance mantissa
  // bits are traded for the stable original-index tiebreaker.
  let highWord = (layer << 24u) |
                 (priority << 16u) |
                 matId;

  let lowWord = (distKey & 0xFFFFFFF0u) |
                (cmdIndex & 0xFu); // Sub-sort tiebreaker: original index

  sortKeysHigh[cmdIndex] = highWord;
  sortKeysLow[cmdIndex] = lowWord;

  // Initialize command index to identity (will be reordered by sort pass)
  commandIndices[cmdIndex] = cmdIndex;
}
