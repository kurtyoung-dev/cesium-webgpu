/**
 * @module WebGPUPickManager
 *
 * Manages object picking via color-based identification for the WebGPU renderer.
 * Each pickable object is assigned a unique 24-bit color ID (encoded in RGB).
 * During the pick pass, objects are rendered with their pick color, and the
 * resulting pixel is read back to identify which object was under the cursor.
 *
 * Extracted from WebGPUContext to keep the main context file focused on
 * frame lifecycle and rendering.
 *
 * @see WebGPUContext
 */

// ============================================================================
// Pick Manager
// ============================================================================

/**
 * Manages pick IDs and the mapping from pick colors back to objects.
 *
 * @example
 * const pick = new WebGPUPickManager();
 * const pickId = pick.createPickId(myEntity);
 * // pickId.color = { red, green, blue, alpha }
 * // pickId.normalizedRgba = Float32Array [r/255, g/255, b/255, 1.0]
 *
 * // After rendering pick pass and reading back pixel:
 * const obj = pick.getObjectByPickColor({ red: 1, green: 0, blue: 0 });
 */
export class WebGPUPickManager {
  private _pickObjects: Map<number, any> = new Map();
  private _nextPickColor: Uint32Array = new Uint32Array(1);

  /**
   * Create a pick ID for an object.
   *
   * Pick IDs encode a unique 24-bit key into RGB channels.
   * The returned object includes both byte-range (0–255) and
   * normalized (0.0–1.0) color values for use in shaders.
   *
   * @param object - The object to create a pick ID for
   * @returns Pick ID with unique color and a destroy() function
   */
  createPickId(object: any): any {
    const key = this._nextPickColor[0]++;

    this._pickObjects.set(key, object);

    const red = key & 0xff;
    const green = (key >> 8) & 0xff;
    const blue = (key >> 16) & 0xff;

    return {
      key,
      color: { red, green, blue, alpha: 255 },
      normalizedRgba: new Float32Array([
        red / 255.0,
        green / 255.0,
        blue / 255.0,
        1.0,
      ]),
      destroy: () => {
        this._pickObjects.delete(key);
      },
    };
  }

  /**
   * Get an object by its pick color.
   *
   * @param pickColor - Color object with `red`, `green`, `blue` (0–255)
   * @returns The picked object, or undefined if not found
   */
  getObjectByPickColor(pickColor: any): any {
    if (!pickColor) return undefined;
    const key = pickColor.red | (pickColor.green << 8) | (pickColor.blue << 16);
    return this._pickObjects.get(key);
  }

  /**
   * Number of registered pick objects.
   */
  get count(): number {
    return this._pickObjects.size;
  }

  /**
   * Clear all pick registrations.
   */
  clear(): void {
    this._pickObjects.clear();
    this._nextPickColor[0] = 0;
  }
}

export default WebGPUPickManager;
