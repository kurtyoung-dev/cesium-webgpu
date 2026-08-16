// NEW-VOXEL-OCTREE-DEEP-LEVELS — 4-level CUSTOM box voxel provider asset.
// @purpose 4-level small-tile (2x2x2) CUSTOM voxel provider whose L3 discriminators detect whether the WebGPU march reaches octree depth 3.
// @status ACTIVE
//
// A deep-octree test asset advertising `availableLevels = 4`, with SMALL tiles
// (2x2x2 cells) so the full 585-slot depth-3 atlas (root + 8 level-1 + 64
// level-2 + 512 level-3 tiles) fits the device's maxTextureDimension3D
// (585 * 2 = 1170 texels of Z stack, well under the 2048 guarantee):
//
//   level 0 (root):          1 tile,  2x2x2 cells  → combined  2x2x2
//   level 1 (8 children):    8 tiles, 2x2x2 cells  → combined  4x4x4
//   level 2 (64 children):  64 tiles, 2x2x2 cells  → combined  8x8x8
//   level 3 (512 children): 512 tiles,2x2x2 cells  → combined 16x16x16
//
// Fill truth (finest, 16^3): the THIN diagonal gy == gz in the (y,z) plane,
// extruded along x. The pattern is exactly self-similar under conservative
// downsampling ("coarse cell filled iff ANY contained fine cell is filled"):
// the honest downsample of gy==gz@16 is gy==gz@8 is gy==gz@4 is gy==gz@2. So
// EVERY level's tile data is `globalY === globalZ` at that level's combined
// resolution — which gives THREE independent discriminator families:
//
//   L1 discriminators: filled at level 0 (2-grid), empty at level 1 (4-grid).
//     Black once traversal reaches depth >= 1.
//   L2 discriminators: filled at level 1 (4-grid), empty at level 2 (8-grid).
//     Black once traversal reaches depth >= 2.
//   L3 discriminators: 16-cells with y16 != z16 but floor(y16/2)==floor(z16/2)
//     — EMPTY at level 3 (16-grid), FILLED at level 2 (8-grid). Black ONLY once
//     traversal reaches depth 3 (NEW-VOXEL-OCTREE-DEEP-LEVELS). This is the
//     acceptance signal: at HEAD the WebGPU march clamped to depth 2, so these
//     read FILLED (spurious) — the gap this asset exists to close.
//
// `createVoxelOctreeL4Provider` is fully self-contained (no closures over
// module scope) so probes can inject it into a Playwright page via
// `.toString()` — same pattern as probe-voxel-octree's in-page authoring.

/** Cells per tile edge (every tile at every level is 2x2x2). */
export const TILE = 2;

/** Levels advertised by the asset (0, 1, 2, 3). */
export const AVAILABLE_LEVELS = 4;

/**
 * Build the 4-level CUSTOM voxel provider. Self-contained by design — inject
 * into the page with `createVoxelOctreeL4Provider.toString()` and call as
 * `factory(CesiumModule, earthRadiusScale)`.
 *
 * Tile data is authored in INPUT (glTF Y-up) order: Z-up cell (x,y,z) lands
 * at input index x + T*(z + T*(T-1-y)) — the inverse of Octree.glsl's
 * Y_UP_METADATA_ORDER + SHAPE_BOX swap/flip (same authoring as
 * probe-voxel-octree's fixture). Tile coordinates follow the Z-up shape-frame
 * convention (childIndex = z*edge^2 + y*edge + x, edge = 2^level).
 */
export function createVoxelOctreeL4Provider(C, R) {
  const T = 2;
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
    availableLevels: 4,
    metadataOrder: C.VoxelMetadataOrder.Y_UP,
    requestData: function (options) {
      const level = options.tileLevel ?? 0;
      if (level >= 0 && level < 4) {
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
      return Promise.reject(`no tiles beyond level 3 (asked ${level})`);
    },
  };
}
