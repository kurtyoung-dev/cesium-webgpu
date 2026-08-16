// NEW-VOXEL-OCTREE-L2-ASSET-PROBE — 3-level CUSTOM box voxel provider asset.
// @purpose Self-contained 3-level CUSTOM box voxel provider whose self-similar gy==gz diagonal yields per-level traversal-depth discriminators for octree probes.
// @status ACTIVE
//
// A deep-octree test asset advertising `availableLevels = 3`:
//
//   level 0 (root):        1 tile,  4x4x4 cells  → combined  4x4x4
//   level 1 (8 children):  8 tiles, 4x4x4 cells  → combined  8x8x8
//   level 2 (64 children): 64 tiles, 4x4x4 cells → combined 16x16x16
//
// Fill truth (finest, 16^3): the THIN diagonal gy == gz in the (y,z) plane,
// extruded along x. The pattern is exactly self-similar under conservative
// downsampling ("coarse cell filled iff ANY contained fine cell is filled"):
// the honest downsample of gy==gz@16 is gy==gz@8 is gy==gz@4. So EVERY level's
// tile data is `globalY === globalZ` at that level's combined resolution —
// which gives two independent discriminator families:
//
//   L1 discriminators: 8-cells with y8 != z8 but floor(y8/2) == floor(z8/2)
//     — EMPTY at level 1+, FILLED at root. Black once traversal reaches
//     depth >= 1 (shipped, B501/Batch 501).
//   L2 discriminators: 16-cells with y16 != z16 but floor(y16/2) == floor(z16/2)
//     — EMPTY at level 2, FILLED at level 1. Black only once traversal
//     reaches depth 2 (B17 NEW-VOXEL-OCTREE-DEEP-TRAVERSAL). At HEAD the
//     WebGPU march clamps to depth-1, so these read FILLED (spurious) on
//     WebGPU — that is the documented expected-fail this asset exists to
//     measure.
//
// `createVoxelOctreeL3Provider` is fully self-contained (no closures over
// module scope) so probes can inject it into a Playwright page via
// `.toString()` — same pattern as probe-voxel-parity's in-page authoring.

/**
 * Cell fill truth at any octree level. Level L has combined resolution
 * (4 << L) per axis; a cell is filled iff its global y === global z at that
 * level. Valid for levels 0..2 of this asset (and any deeper conservative
 * downsample chain of the 16^3 diagonal truth).
 */
export function voxelOctreeL3Filled(level, gx, gy, gz) {
  return gy === gz;
}

/** Cells per tile edge (every tile at every level is 4x4x4). */
export const TILE = 4;

/** Levels advertised by the asset (0, 1, 2). */
export const AVAILABLE_LEVELS = 3;

/**
 * Build the 3-level CUSTOM voxel provider. Self-contained by design — inject
 * into the page with `createVoxelOctreeL3Provider.toString()` and call as
 * `factory(CesiumModule, earthRadiusScale)`.
 *
 * Tile data is authored in INPUT (glTF Y-up) order: Z-up cell (x,y,z) lands
 * at input index x + T*(z + T*(T-1-y)) — the inverse of Octree.glsl's
 * Y_UP_METADATA_ORDER + SHAPE_BOX swap/flip (same authoring as
 * probe-voxel-parity Part B). Tile coordinates follow the Z-up shape-frame
 * convention (childIndex = z*4 + y*2 + x at level 1, and its radix-2
 * extension at level 2).
 */
export function createVoxelOctreeL3Provider(C, R) {
  const T = 4;
  function filled(gx, gy, gz) {
    return gy === gz;
  }
  function makeTile(level, tx, ty, tz) {
    const data = new Float32Array(T * T * T * 4);
    for (let z = 0; z < T; z++) {
      for (let y = 0; y < T; y++) {
        for (let x = 0; x < T; x++) {
          const idx = x + T * (z + T * (T - 1 - y));
          const d = idx * 4;
          data[d] = 0.7;
          data[d + 1] = 0.7;
          data[d + 2] = 0.7;
          data[d + 3] = filled(tx * T + x, ty * T + y, tz * T + z) ? 1.0 : 0.0;
        }
      }
    }
    return data;
  }
  return {
    shape: C.VoxelShapeType.BOX,
    minBounds: new C.Cartesian3(-1, -1, -1),
    maxBounds: new C.Cartesian3(1, 1, 1),
    dimensions: new C.Cartesian3(T, T, T),
    names: ["color"],
    types: [C.MetadataType.VEC4],
    componentTypes: [C.MetadataComponentType.FLOAT32],
    globalTransform: C.Matrix4.fromScale(new C.Cartesian3(R, R, R)),
    availableLevels: 3,
    metadataOrder: C.VoxelMetadataOrder.Y_UP,
    requestData: function (options) {
      const level = options.tileLevel ?? 0;
      if (level >= 0 && level < 3) {
        return Promise.resolve(
          C.VoxelContent.fromMetadataArray([
            makeTile(
              level,
              options.tileX ?? 0,
              options.tileY ?? 0,
              options.tileZ ?? 0,
            ),
          ]),
        );
      }
      return Promise.reject(`no tiles beyond level 2 (asked ${level})`);
    },
  };
}
