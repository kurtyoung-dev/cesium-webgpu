import Check from "../Core/Check.js";
import defined from "../Core/defined.js";

/**
 * Path, relative to the module URL root, of the night imagery pyramid bundled
 * with the library. Laid out exactly like <code>Assets/Textures/NaturalEarthII</code>,
 * so {@link TileMapServiceImageryProvider} reads the level range out of the
 * accompanying <code>tilemapresource.xml</code> and never requests a level the
 * pyramid does not contain.
 *
 * @private
 */
export const BUNDLED_NIGHT_IMAGERY_PATH = "Assets/Textures/BlackMarble";

/**
 * The alpha pair that makes an imagery layer a night layer: absent in daylight,
 * fully covering past the terminator. Both backends raise their day/night ramp
 * from these resolved values, so the pair is what turns the ramp on as well as
 * what the ramp interpolates.
 *
 * @private
 */
export const NIGHT_IMAGERY_LAYER_OPTIONS = Object.freeze({
  dayAlpha: 0.0,
  nightAlpha: 1.0,
});

/**
 * Where the night layer, if any, comes from.
 *
 * @private
 */
export const NightImagerySource = Object.freeze({
  NONE: "none",
  BUNDLED: "bundled",
  PROVIDED: "provided",
});

/**
 * Whether the globe may attach a night layer of its own at all.
 *
 * A default-on night layer is a divergence from upstream, so it is bounded to
 * the case where nothing else owns the imagery stack: the widget that built the
 * default base layer says so, and an application that supplied its own base
 * layer or assembled the stack itself says nothing. An explicit assignment to
 * the property is a request rather than an injection and arms it either way.
 *
 * @param {object} options
 * @param {boolean} options.ownsDefaultImageryStack Whether this globe's imagery
 *        stack was created by the default base-layer path.
 * @param {boolean} options.explicitlyRequested Whether the property has been
 *        assigned, whatever the value assigned.
 * @returns {boolean}
 * @private
 */
export function nightImageryIsArmed(options) {
  return (
    options.ownsDefaultImageryStack === true ||
    options.explicitlyRequested === true
  );
}

/**
 * Normalizes the public property value into the source the globe should hold.
 *
 * @param {boolean|ImageryProvider|Promise<ImageryProvider>} value
 * @param {boolean} isArmed
 * @returns {{source: string, provider: (object|undefined)}}
 * @private
 */
export function resolveNightImageryRequest(value, isArmed) {
  if (isArmed !== true || value === false || !defined(value)) {
    return { source: NightImagerySource.NONE, provider: undefined };
  }
  if (value === true) {
    return { source: NightImagerySource.BUNDLED, provider: undefined };
  }
  //>>includeStart('debug', pragmas.debug);
  Check.typeOf.object("globe.nightImagery", value);
  //>>includeEnd('debug');
  return { source: NightImagerySource.PROVIDED, provider: value };
}

/**
 * What has to happen to the auto-managed layer to reach the requested state.
 *
 * Kept apart from the layer manipulation so the whole state space can be
 * executed rather than described: an unchanged provider must not churn a layer
 * every frame, and a changed one must destroy the old layer instead of stacking
 * a second one on top of it.
 *
 * @param {{source: string, provider: (object|undefined)}} current
 * @param {{source: string, provider: (object|undefined)}} requested
 * @returns {string} One of <code>none</code>, <code>attach</code>,
 *          <code>detach</code>, <code>replace</code>.
 * @private
 */
export function nightImageryAction(current, requested) {
  const has = current.source !== NightImagerySource.NONE;
  const wants = requested.source !== NightImagerySource.NONE;
  if (!has) {
    return wants ? "attach" : "none";
  }
  if (!wants) {
    return "detach";
  }
  if (
    current.source === requested.source &&
    current.provider === requested.provider
  ) {
    return "none";
  }
  return "replace";
}
