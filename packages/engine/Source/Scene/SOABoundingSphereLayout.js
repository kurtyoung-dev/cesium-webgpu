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

      const center = cmd.boundingVolume.center;
      const r = cmd.boundingVolume.radius;

      this.centerX[writeIndex] = center.x;
      this.centerY[writeIndex] = center.y;
      this.centerZ[writeIndex] = center.z;
      this.radius[writeIndex] = r;
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
