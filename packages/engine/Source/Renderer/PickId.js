// @ts-check

/** @import Color from "../Core/Color.js"; */
/** @import {Destroyable} from "../Core/globalTypes.js"; */

/**
 * Represents a unique pick identifier for an object in the scene.
 *
 * Each pickable object gets a unique sequential integer key. The key is
 * encoded as a color in two formats to support both WebGL and WebGPU:
 * - `.color` — CesiumJS `Color` via `Color.fromRgba(key)` (big-endian RGBA, for WebGL)
 * - `.normalizedRgba` — Float32Array in little-endian RGBA (for WebGPU)
 *
 * During pick rendering passes, fragments output this color instead of
 * the visual appearance. Reading back the pixel gives the key to look
 * up the picked object.
 *
 * This class is renderer-agnostic — used by both WebGL and WebGPU backends.
 * Pick IDs are allocated by {@link GraphicsContext.createPickId} and stored
 * in the base class's `_pickObjects` Map.
 *
 * @implements {Destroyable}
 * @private
 * @ignore
 */
class PickId {
  /**
   * @param {Map<number, object>} pickObjects - The shared pick objects map
   * @param {number} key - The unique sequential integer key
   * @param {Color} color - The RGBA color for WebGL (via Color.fromRgba)
   * @param {Map<number, string>} [pickKinds] - Optional parallel map
   *   tracking the registered {@link PickKind}. Kept alongside
   *   `pickObjects` so `destroy()` can clean both.
   */
  constructor(pickObjects, key, color, pickKinds) {
    this._pickObjects = pickObjects;
    this._pickKinds = pickKinds;

    /** @type {number} */
    this.key = key;

    /** @type {Color} */
    this.color = color;

    // Pre-compute normalized RGBA for WebGPU (little-endian RGBA encoding),
    // byte-for-byte the same four bytes `Color.fromRgba(key)` produces above:
    // key → R=byte 0, G=byte 1, B=byte 2, A=byte 3.
    //
    // Alpha carries bits 24-31 of the key; it is NOT a constant opacity. The
    // WebGPU pick readback rebuilds the key from all four bytes
    // (`Color.bytesToRgba(r, g, b, a)` in WebGPUPickFramebuffer), so pinning
    // alpha to 1.0 here encoded a 24-bit key that the 32-bit decoder would
    // read back as `key | 0xff000000` — unresolvable for every id.
    const r = (key & 0xff) / 255.0;
    const g = ((key >>> 8) & 0xff) / 255.0;
    const b = ((key >>> 16) & 0xff) / 255.0;
    const a = ((key >>> 24) & 0xff) / 255.0;
    this.normalizedRgba = new Float32Array([r, g, b, a]);
  }

  /**
   * The object associated with this pick ID.
   * @type {object}
   */
  get object() {
    return this._pickObjects.get(this.key);
  }

  set object(value) {
    this._pickObjects.set(this.key, value);
  }

  /**
   * Remove this pick ID from the map, freeing the association.
   * Deletes from both the target map and the parallel kind map so
   * neither accumulates orphan entries across the scene's lifetime.
   * @returns {void}
   */
  destroy() {
    this._pickObjects.delete(this.key);
    this._pickKinds?.delete(this.key);
    return undefined;
  }
}

export default PickId;
