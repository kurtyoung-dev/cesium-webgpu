/**
 * Resolves an {@link ImageryLayer} property that the public API documents as
 * either a scalar or a callback <code>(frameState, layer, x, y, level)</code>.
 *
 * Both uniform packs go through here. Writing a Function straight into a
 * Float32Array yields NaN, which propagates through the multiplicative imagery
 * blend and takes the whole layer with it, so a documented API silently
 * produces a blank layer instead of a fade.
 *
 * A callback that throws, or returns something that is not a finite number,
 * falls back to the property's default rather than to NaN: one bad frame of a
 * user callback must not be able to erase the layer.
 *
 * @param {number|Function} value The property value, or a callback returning one.
 * @param {number} defaultValue The value to use when nothing usable is produced.
 * @param {FrameState} frameState The current frame state, passed to the callback.
 * @param {ImageryLayer} layer The layer being packed, passed to the callback.
 * @param {{level: number, x: number, y: number}} [tile] The tile the value is
 *        wanted for. Absent coordinates are passed to the callback as zero.
 * @returns {number} The resolved value.
 * @private
 */
export default function resolveImageryLayerValue(
  value,
  defaultValue,
  frameState,
  layer,
  tile,
) {
  if (typeof value === "function") {
    try {
      const resolved = value(
        frameState,
        layer,
        tile?.x ?? 0,
        tile?.y ?? 0,
        tile?.level ?? 0,
      );
      return typeof resolved === "number" && isFinite(resolved)
        ? resolved
        : defaultValue;
    } catch {
      return defaultValue;
    }
  }
  return typeof value === "number" && isFinite(value) ? value : defaultValue;
}
