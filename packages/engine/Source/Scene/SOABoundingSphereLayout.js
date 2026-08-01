import defined from "../Core/defined.js";

/**
 * Structure-of-Arrays (SOA) layout for bounding sphere data, designed for
 * WASM SIMD batch processing. Instead of an array of objects (AOS), stores
 * each component in a separate contiguous Float32Array.
 *
 * SOA enables SIMD (4-wide float32) batch operations:
 * - 4 sphere-plane tests per SIMD instruction
 * - Cache-friendly sequential access patterns
 * - Direct SharedArrayBuffer compatibility with WASM
 *
 * Layout:
 *   centerX[N]  — Float32Array, sphere center X (ECEF)
 *   centerY[N]  — Float32Array, sphere center Y (ECEF)
 *   centerZ[N]  — Float32Array, sphere center Z (ECEF)
 *   radius[N]   — Float32Array, sphere radius
 *
 * Note: float32 is used for the SOA buffers because WASM SIMD operates
 * on f32x4. The float64→float32 conversion is acceptable for culling
 * (we need "is it inside the frustum?", not sub-meter precision).
 * The JS-side distance sort still uses full float64.
 *
 * @param {number} capacity Maximum number of bounding spheres.
 * @param {boolean} [useSharedMemory=false] Use SharedArrayBuffer for
 *   cross-thread WASM access.
 *
 * @alias SOABoundingSphereLayout
 * @constructor
 * @private
 */
/**
 * Resolve the center Cartesian3 of a bounding volume. BoundingSphere and
 * OrientedBoundingBox both expose `.center` directly. Tile wrappers
 * (TileOrientedBoundingBox / TileBoundingSphere / TileBoundingRegion) do
 * NOT — they expose the underlying volume via `.boundingVolume`, so unwrap
 * one level when `.center` is absent.
 *
 * @param {object} bv A bounding volume or tile-volume wrapper.
 * @returns {Cartesian3|undefined} The center, or undefined if unresolvable.
 * @private
 */
function boundingVolumeCenter(bv) {
  if (defined(bv.center)) {
    return bv.center;
  }
  if (defined(bv.boundingVolume) && defined(bv.boundingVolume.center)) {
    return bv.boundingVolume.center;
  }
  return undefined;
}

/**
 * Derive an enclosing-sphere radius for a bounding volume.
 *
 * - BoundingSphere: returns `.radius` directly.
 * - OrientedBoundingBox: no `.radius` field — computes the half-diagonal
 *   length `|u + v + w|` where u,v,w are the box's three half-axis columns
 *   (the tight enclosing-sphere radius). This matches the convention used
 *   by {@link BoundingSphere.fromOrientedBoundingBox}.
 * - Tile-volume wrappers: unwrap one level to the underlying volume.
 *
 * @param {object} bv A bounding volume or tile-volume wrapper.
 * @returns {number} The enclosing-sphere radius, or NaN if unresolvable.
 * @private
 */
function boundingVolumeRadius(bv) {
  if (typeof bv.radius === "number") {
    return bv.radius;
  }
  const halfAxes = bv.halfAxes;
  if (defined(halfAxes)) {
    // Matrix3 is column-major, 9 elements: column0 = [0,1,2],
    // column1 = [3,4,5], column2 = [6,7,8]. The half-diagonal is the
    // vector sum of the three half-axis columns.
    const sx = halfAxes[0] + halfAxes[3] + halfAxes[6];
    const sy = halfAxes[1] + halfAxes[4] + halfAxes[7];
    const sz = halfAxes[2] + halfAxes[5] + halfAxes[8];
    return Math.sqrt(sx * sx + sy * sy + sz * sz);
  }
  // Tile-volume wrapper — unwrap one level and retry on the underlying volume.
  if (defined(bv.boundingVolume) && bv.boundingVolume !== bv) {
    return boundingVolumeRadius(bv.boundingVolume);
  }
  return NaN;
}

class SOABoundingSphereLayout {
  constructor(capacity, useSharedMemory) {
    /**
     * Maximum number of spheres this layout can hold.
     * @type {number}
     */
    this.capacity = capacity;

    /**
     * Current number of spheres stored.
     * @type {number}
     */
    this.count = 0;

    const BufferType = useSharedMemory ? SharedArrayBuffer : ArrayBuffer;
    const byteLength = capacity * 4; // 4 bytes per float32

    /**
     * Sphere center X coordinates (ECEF, float32).
     * @type {Float32Array}
     */
    this.centerX = new Float32Array(new BufferType(byteLength));

    /**
     * Sphere center Y coordinates (ECEF, float32).
     * @type {Float32Array}
     */
    this.centerY = new Float32Array(new BufferType(byteLength));

    /**
     * Sphere center Z coordinates (ECEF, float32).
     * @type {Float32Array}
     */
    this.centerZ = new Float32Array(new BufferType(byteLength));

    /**
     * Sphere radii (float32).
     * @type {Float32Array}
     */
    this.radius = new Float32Array(new BufferType(byteLength));

    /**
     * Command index mapping — maps SOA index back to original command index.
     * @type {Uint32Array}
     */
    this.commandIndices = new Uint32Array(new BufferType(capacity * 4));

    /**
     * Visibility result buffer — written by WASM culler.
     * 0 = occluded/culled, 1 = visible.
     * @type {Uint8Array}
     */
    this.visibility = new Uint8Array(new BufferType(capacity));

    /**
     * Whether SharedArrayBuffer is used (enables cross-thread WASM).
     * @type {boolean}
     */
    this.isShared = useSharedMemory === true;
  }

  /**
   * Resets the count to 0 for a new frame. Does NOT clear the arrays
   * (overwritten during populate).
   */
  reset() {
    this.count = 0;
  }

  /**
   * Populates the SOA layout from a command list. Extracts bounding sphere
   * data into contiguous float32 arrays suitable for SIMD processing.
   *
   * @param {Array} commands Array of DrawCommands with boundingVolume.
   * @returns {number} Number of spheres populated.
   */
  populate(commands) {
    const length = Math.min(commands.length, this.capacity);
    let writeIndex = 0;

    for (let i = 0; i < length; i++) {
      const cmd = commands[i];
      if (!defined(cmd.boundingVolume)) {
        continue;
      }

      // The bounding volume may be a BoundingSphere (has `.center` +
      // `.radius`) or an OrientedBoundingBox (has `.center` + `.halfAxes`,
      // NO `.radius`). 3D-tile DrawCommands frequently carry the raw
      // OrientedBoundingBox — reading `.radius` off it yields `undefined`,
      // which stores as NaN in the Float32Array and NaN-propagates through
      // the Hi-Z occlusion test (silent mis-cull / never-cull). Derive an
      // enclosing-sphere radius for OBBs to match WebGL's screen-space
      // culling behavior.
      const center = boundingVolumeCenter(cmd.boundingVolume);
      const r = boundingVolumeRadius(cmd.boundingVolume);
      if (center === undefined) {
        // Unknown/degenerate bounding volume — skip rather than poison
        // the SOA with NaN. C11-187 keeps every unrepresented command
        // conservative-visible in OcclusionCulling.
        continue;
      }

      // Validate the exact f32 values consumed by the SIMD path. A finite f64
      // can overflow to Infinity during Float32Array assignment, and a zero or
      // negative radius is not a useful conservative sphere. Leave all such
      // commands unrepresented so OcclusionCulling passes them through.
      const centerX = Math.fround(center.x);
      const centerY = Math.fround(center.y);
      const centerZ = Math.fround(center.z);
      const radius = Math.fround(r);
      if (
        !Number.isFinite(centerX) ||
        !Number.isFinite(centerY) ||
        !Number.isFinite(centerZ) ||
        !Number.isFinite(radius) ||
        radius <= 0.0
      ) {
        continue;
      }

      this.centerX[writeIndex] = centerX;
      this.centerY[writeIndex] = centerY;
      this.centerZ[writeIndex] = centerZ;
      this.radius[writeIndex] = radius;
      this.commandIndices[writeIndex] = i;
      writeIndex++;
    }

    this.count = writeIndex;
    return writeIndex;
  }

  /**
   * Resizes the layout if needed. Creates new arrays if capacity is insufficient.
   *
   * @param {number} newCapacity The new capacity.
   */
  resize(newCapacity) {
    if (newCapacity <= this.capacity) {
      return;
    }

    const BufferType = this.isShared ? SharedArrayBuffer : ArrayBuffer;
    const byteLength = newCapacity * 4;

    this.centerX = new Float32Array(new BufferType(byteLength));
    this.centerY = new Float32Array(new BufferType(byteLength));
    this.centerZ = new Float32Array(new BufferType(byteLength));
    this.radius = new Float32Array(new BufferType(byteLength));
    this.commandIndices = new Uint32Array(new BufferType(newCapacity * 4));
    this.visibility = new Uint8Array(new BufferType(newCapacity));
    this.capacity = newCapacity;
  }

  /**
   * Returns the underlying buffers for WASM interop.
   * @returns {object} Object with buffer references.
   */
  getBuffers() {
    return {
      centerX: this.centerX.buffer,
      centerY: this.centerY.buffer,
      centerZ: this.centerZ.buffer,
      radius: this.radius.buffer,
      commandIndices: this.commandIndices.buffer,
      visibility: this.visibility.buffer,
      count: this.count,
    };
  }
}

export default SOABoundingSphereLayout;
