/**
 * @purpose Decode a voxel pick-coordinate readback (the four RGBA bytes of the pick framebuffer) into tile, sample and Z-up cell, derive the expected sample index of a cell, map WebGPU atlas slots back to octree tiles, and compare picked cell colours.
 * @status ACTIVE
 *
 * WHERE THESE CAME FROM. Four voxel pick probes carried private copies:
 * `probe-voxel-cell-pick.mjs` (`decode`, `expectedSampleIndex`, `isCleared`,
 * `bytesEq`, the Part B slot-to-octant arithmetic and Part D's `gpL3Tile`),
 * `probe-voxel-pick.mjs` and `probe-voxel-pick-logdepth.mjs`
 * (`expectedSampleIndex`), and `probe-voxel-refined-pick.mjs`
 * (`expectedSampleIndex` specialised to a 4 x 4 x 4 tile, and `colorsEq`).
 *
 * THE BYTE LAYOUT. `Picking.pickVoxelCoordinate` reads one pixel of the voxel
 * pick framebuffer: bytes 0-1 carry the tile (megatexture) index and bytes 2-3
 * the sample index, each as `255 * high + low` — the base the probes decoded
 * with, kept exactly. A cleared pixel `[0, 0, 0, 0]` is byte-indistinguishable
 * from tile 0 / sample 0, which is why the probes treat "cleared" as its own
 * predicate rather than decoding it.
 *
 * THE CELL FRAME. The sample index addresses the metadata in its INPUT
 * orientation (glTF Y-up for these assets): a Z-up shape-frame cell
 * `(x, y, z)` sits at input `(x, z, dimsY - 1 - y)`, so over input extents
 * `(dimsX, dimsZ, dimsY)` the sample index is
 * `x + dimsX * (z + dimsZ * (dimsY - 1 - y))` — the inverse of Octree.glsl's
 * `Y_UP_METADATA_ORDER` plus `SHAPE_BOX` swap and flip, with no padding.
 */

/**
 * Whether a readback is the cleared pixel `[0, 0, 0, 0]`.
 *
 * @param {unknown} bytes
 * @returns {boolean}
 */
export function isClearedPick(bytes) {
  return (
    Array.isArray(bytes) &&
    bytes.length === 4 &&
    bytes.every((value) => value === 0)
  );
}

/**
 * Whether two readbacks are four equal bytes.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function pickBytesEqual(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === 4 &&
    b.length === 4 &&
    a.every((value, index) => value === b[index])
  );
}

/**
 * Whether two readbacks carry the same SAMPLE bytes (2 and 3), regardless of
 * their tile bytes.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function pickSampleBytesEqual(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === 4 &&
    b.length === 4 &&
    a[2] === b[2] &&
    a[3] === b[3]
  );
}

/**
 * The input-orientation sample index of a Z-up cell.
 *
 * @param {{x: number, y: number, z: number}} cell Z-up shape-frame cell.
 * @param {{x: number, y: number, z: number}} dims Z-up cell dimensions.
 * @returns {number}
 */
export function expectedVoxelSampleIndex(cell, dims) {
  return cell.x + dims.x * (cell.z + dims.z * (dims.y - 1 - cell.y));
}

/**
 * Decode a readback into its tile index, sample index and Z-up cell, or
 * `null` when there are no bytes.
 *
 * @param {number[]|null|undefined} bytes The four readback bytes.
 * @param {{x: number, y: number, z: number}} dims Z-up cell dimensions of the tile.
 * @returns {{tile: number, sample: number, cell: {x: number, y: number, z: number}}|null}
 */
export function decodeVoxelPickBytes(bytes, dims) {
  if (!bytes) {
    return null;
  }
  const tile = 255 * bytes[0] + bytes[1];
  const sample = 255 * bytes[2] + bytes[3];
  const inputX = dims.x;
  const inputY = dims.z;
  const ix = sample % inputX;
  const iy = Math.floor(sample / inputX) % inputY;
  const iz = Math.floor(sample / (inputX * inputY));
  return {
    tile,
    sample,
    cell: { x: ix, y: dims.y - 1 - iz, z: iy },
  };
}

/**
 * The level-1 octant a WebGPU atlas slot holds: slots 1 to 8 are the eight
 * level-1 children in `childIndex = x + 2y + 4z` order, slot 0 is the root.
 * Any other slot is not a level-1 child and maps to `null`.
 *
 * @param {number} slot
 * @returns {{x: number, y: number, z: number}|null}
 */
export function levelOneOctantFromSlot(slot) {
  if (!(slot >= 1 && slot <= 8)) {
    return null;
  }
  const child = slot - 1;
  return { x: child & 1, y: (child >> 1) & 1, z: (child >> 2) & 1 };
}

/**
 * Invert a WebGPU level-3 atlas slot (73 and above) through the uploaded
 * `l3Slots` table, whose index is the level-3 tile's `x + 8y + 64z`.
 *
 * @param {number} slot
 * @param {number[]|null|undefined} l3Slots
 * @returns {{level: 3, x: number, y: number, z: number}|null}
 */
export function levelThreeTileFromSlot(slot, l3Slots) {
  if (!(slot >= 73) || !Array.isArray(l3Slots)) {
    return null;
  }
  const index = l3Slots.indexOf(slot);
  if (index < 0) {
    return null;
  }
  return {
    level: 3,
    x: index % 8,
    y: Math.floor(index / 8) % 8,
    z: Math.floor(index / 64),
  };
}

/**
 * Whether two picked cell colours (a `VoxelCell`'s `getProperty("color")`)
 * agree component-wise within `epsilon`.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @param {number} epsilon
 * @returns {boolean}
 */
export function pickedColourMatches(a, b, epsilon) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => Math.abs(value - b[index]) <= epsilon);
}
