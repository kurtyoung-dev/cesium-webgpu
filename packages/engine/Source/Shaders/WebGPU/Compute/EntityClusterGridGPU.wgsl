// EntityClusterGridGPU.wgsl — GPU screen-space bin/count for EntityCluster.
//
// Phase 10 (NEW-ENTITYCLUSTER-GPU): the data-parallel half of screen-space
// proximity declutter. The CPU path (EntityCluster.js, WebGL2) builds a
// KDBush spatial index over every visible screen-space point then runs a
// greedy range-query merge — O(N log N) build plus many range queries that
// don't scale to 50k+ markers. This shader replaces the index-build +
// neighbour-bucketing with a single O(N) compute pass: every visible point
// is hashed into a uniform screen-space grid whose cell edge equals the
// merge radius (pixelRange), and the per-cell occupancy + a per-cell
// representative point index are accumulated atomically.
//
// The SEQUENTIAL half — choosing cluster representatives and merging the
// 3×3 cell neighbourhood so two markers straddling a cell boundary still
// cluster — stays on the CPU, but now runs over the (far smaller) set of
// NON-EMPTY cells rather than every point. See the dispatcher + EntityCluster
// integration for the merge.
//
// Dispatch: ceil(pointCount / 256) workgroups of 256 threads each.
//
// Coordinate convention: `coords[i]` is the CSS-pixel screen-space position
// of point i (origin top-left, +y down — Cesium's computeScreenSpacePosition
// output). Points the CPU has already rejected (off-screen, occluded, not
// clusterable) are passed with a sentinel x < -1.0e30 and skip binning.

struct ClusterGridParams {
  pointCount: u32,
  gridCols: u32,
  gridRows: u32,
  cellSize: f32,        // pixels per cell == pixelRange
  originX: f32,         // screen-space x of grid cell (0,0) lower edge
  originY: f32,         // screen-space y of grid cell (0,0) lower edge
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> params: ClusterGridParams;

// Input: per-point screen-space coordinate (xy). z/w unused (kept vec4 for
// 16-byte stride friendliness on the JS upload side).
@group(0) @binding(1) var<storage, read> coords: array<vec4<f32>>;

// Output: per-cell occupancy count. Length == gridCols * gridRows. Atomic
// because many threads may target the same cell.
@group(0) @binding(2) var<storage, read_write> cellCounts: array<atomic<u32>>;

// Output: per-cell representative point index — the SMALLEST point index that
// landed in the cell (atomicMin gives a deterministic representative
// independent of thread scheduling). Initialized to 0xFFFFFFFF (== "empty")
// by the dispatcher before each dispatch.
@group(0) @binding(3) var<storage, read_write> cellRep: array<atomic<u32>>;

// Output: per-point cell id (== row * gridCols + col), or 0xFFFFFFFF for
// points that were skipped. Lets the CPU group points by cell without
// re-hashing.
@group(0) @binding(4) var<storage, read_write> pointCellId: array<u32>;

const EMPTY: u32 = 0xFFFFFFFFu;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let i = globalId.x;
  if (i >= params.pointCount) {
    return;
  }

  let c = coords[i];

  // Sentinel: CPU-rejected point — no cell.
  if (c.x < -1.0e30) {
    pointCellId[i] = EMPTY;
    return;
  }

  let cellSize = max(params.cellSize, 1.0);
  let fx = (c.x - params.originX) / cellSize;
  let fy = (c.y - params.originY) / cellSize;

  // Clamp into the valid grid range. Points outside the precomputed screen
  // grid (shouldn't happen — the dispatcher sizes the grid to the viewport
  // plus the cell margin) fold into the edge cells rather than corrupting
  // memory.
  let col = u32(clamp(floor(fx), 0.0, f32(params.gridCols - 1u)));
  let row = u32(clamp(floor(fy), 0.0, f32(params.gridRows - 1u)));
  let cellId = row * params.gridCols + col;

  pointCellId[i] = cellId;
  atomicAdd(&cellCounts[cellId], 1u);
  atomicMin(&cellRep[cellId], i);
}
