/**
 * Atmosphere lighting effects (sky atmosphere, ground atmosphere, fog) can be
 * further modified with dynamic lighting from the sun or other light source
 * that changes over time. This enum determines which light source to use.
 *
 * @enum {number}
 */
const DynamicAtmosphereLightingType = {
  /**
   * Do not select a scene light source for dynamic atmosphere lighting.
   * <p>
   * The <b>sky atmosphere</b> is lit by the astronomical sun in this mode
   * (C12-31): terrain lighting and natural sky lighting are separate concerns,
   * so turning <code>globe.enableLighting</code> off must not replace the sky's
   * sun. The day/night alpha ramp still stays disabled here, exactly as before
   * — only the color's light direction is affected.
   * </p>
   * <p>
   * The ground-atmosphere/fog stage on models and the dynamic environment map
   * still use the historical "lit from directly above" direction in this mode;
   * those consumers migrate under their own tracked work items. Use
   * {@link DynamicAtmosphereLightingType.LEGACY_OVERHEAD} to get the overhead
   * direction everywhere, including the sky.
   * </p>
   *
   * @type {number}
   * @constant
   */
  NONE: 0,
  /**
   * Use the scene's current light source for dynamic atmosphere lighting.
   *
   * @type {number}
   * @constant
   */
  SCENE_LIGHT: 1,
  /**
   * Force the dynamic atmosphere lighting to always use the sunlight direction,
   * even if the scene uses a different light source.
   *
   * @type {number}
   * @constant
   */
  SUNLIGHT: 2,
  /**
   * Light every atmosphere effect from directly above the sample being shaded
   * &mdash; the historical appearance of
   * {@link DynamicAtmosphereLightingType.NONE} before C12-31, kept as an
   * explicit, named compatibility mode.
   * <p>
   * The substituted direction is a different "sun overhead" at every sample, so
   * the Mie forward-scattering peak follows the viewer rather than the sun. That
   * is not physical; it is offered only so an application that depends on the
   * old look can opt back into it.
   * </p>
   *
   * @type {number}
   * @constant
   */
  LEGACY_OVERHEAD: 3,
};

/**
 * Get the lighting enum from the older globe flags
 *
 * @param {Globe} globe The globe
 * @return {DynamicAtmosphereLightingType} The corresponding enum value
 *
 * @private
 */
DynamicAtmosphereLightingType.fromGlobeFlags = function (globe) {
  const lightingOn = globe.enableLighting && globe.dynamicAtmosphereLighting;
  if (!lightingOn) {
    return DynamicAtmosphereLightingType.NONE;
  }

  // Force sunlight
  if (globe.dynamicAtmosphereLightingFromSun) {
    return DynamicAtmosphereLightingType.SUNLIGHT;
  }

  return DynamicAtmosphereLightingType.SCENE_LIGHT;
};

Object.freeze(DynamicAtmosphereLightingType);

export default DynamicAtmosphereLightingType;
