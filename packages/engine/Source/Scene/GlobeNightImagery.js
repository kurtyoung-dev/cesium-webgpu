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
 * The screen footprints, in imagery texels per screen pixel, between which the
 * night layer fades out.
 *
 * A bundled pyramid stops at a fixed deepest level, so descending past it
 * spreads one of its texels over more and more screen pixels. Past some
 * magnification the layer is no longer an image of anything: it is a flat wash
 * that replaces the scene beneath it instead of lighting it. Both numbers below
 * are read off that transition rather than chosen - a regional view at sixteen
 * screen pixels per texel still reads as a map of city lights, and at
 * sixty-four the frame is a featureless smear over a scene that is sharp with
 * the layer switched off.
 *
 * The pair is a SCREEN footprint, not a count of texels across a terrain tile.
 * A tile's texel count is blind to how large that tile is on screen, and two
 * adjacent tiles one level apart differ by exactly a factor of two in that
 * size - so a texel count reports two different magnifications for the same
 * one, and the seam between the tiles becomes a step. Texels per screen pixel
 * is the same number on both sides of that seam, because it is a property of
 * the imagery and the camera rather than of the terrain tessellation. It also
 * varies continuously WITHIN a tile, which is why the weight is evaluated per
 * fragment in the two globe shaders rather than once per tile here.
 *
 * @private
 */
export const NIGHT_IMAGERY_FADE_FULL_TEXELS_PER_PIXEL = 1.0 / 16.0;

/**
 * The far end of the same pair: one texel per sixty-four screen pixels, the
 * magnification at which the layer stops being an image of anything.
 *
 * @private
 */
export const NIGHT_IMAGERY_FADE_ZERO_TEXELS_PER_PIXEL = 1.0 / 64.0;

/**
 * The width of the band, in octaves of magnification, which is what the ramp
 * below travels in. Derived from the pair rather than chosen independently, so
 * moving either knee cannot leave the ramp reaching its endpoint early or late.
 *
 * @private
 */
export const NIGHT_IMAGERY_FADE_BAND_OCTAVES = Math.log2(
  NIGHT_IMAGERY_FADE_FULL_TEXELS_PER_PIXEL /
    NIGHT_IMAGERY_FADE_ZERO_TEXELS_PER_PIXEL,
);

/**
 * How many texels a terrain tile must still span before the layer is retired
 * for that tile outright.
 *
 * This is a culling bound, not the fade's zero point: the fade itself is a
 * per-fragment weight the shaders evaluate, and a tile dropped here takes no
 * texture slot at all, so it packs exactly as it would with no night layer
 * attached. The bound has to be conservative in one direction only - it must
 * never drop a tile whose fragments would still carry weight, because a dropped
 * tile beside a weighted one is the seam the per-fragment weight exists to
 * remove.
 *
 * One texel across the tile is that bound. A fragment's footprint is the tile's
 * texel count divided by the tile's size on screen, and terrain selection holds
 * a rendered tile at hundreds of pixels across for any screen-space-error
 * target an application plausibly sets; at one texel across the tile the
 * footprint is therefore already past the far knee by a wide margin, on every
 * fragment of that tile.
 *
 * @private
 */
export const NIGHT_IMAGERY_RETIRE_TEXELS_ACROSS_TILE = 1.0;

/**
 * Tile size assumed for a provider that does not report one. Every tiling
 * scheme this fork ships with uses it, and guessing low would fade a layer out
 * earlier than its own resolution warrants.
 *
 * @private
 */
const NIGHT_IMAGERY_ASSUMED_TILE_PIXELS = 256;

/**
 * The night layer's share of its own night alpha at a given magnification.
 *
 * Smoothstep over log2 of the footprint, because magnification travels in
 * halvings: a ramp linear in texels would spend most of its travel in the first
 * octave and step hard through the last.
 *
 * The clamp is what makes both endpoints exact. At the near knee the ratio is
 * the band width, so `t` is exactly 1 and the weight is exactly 1.0 - anything
 * less re-renders every view the layer is composed for. At the far knee `t` is
 * exactly 0 and the weight is exactly 0.0; a weight that merely approaches zero
 * leaves an opaque layer opaque and the wash survives, dimmer.
 *
 * A footprint that is not a positive number returns full strength rather than
 * zero - an unmeasurable magnification must leave the layer exactly as it
 * renders today, not erase it. The comparison is written on the positive side
 * so a NaN footprint takes that arm.
 *
 * Exact twin of `nightImageryMagnificationFade` in
 * `Shaders/WebGPU/Globe/GlobeTerrain.wgsl` and in `Shaders/GlobeFS.glsl`; the
 * three are executed against each other numerically rather than compared by
 * eye.
 *
 * @param {number} texelsPerPixel Imagery texels spanned by one screen pixel.
 * @returns {number} A factor in <code>[0, 1]</code> for the layer's night alpha.
 * @private
 */
export function nightImageryMagnificationFade(texelsPerPixel) {
  const clamped = Math.min(
    Math.max(texelsPerPixel, NIGHT_IMAGERY_FADE_ZERO_TEXELS_PER_PIXEL),
    NIGHT_IMAGERY_FADE_FULL_TEXELS_PER_PIXEL,
  );
  const t =
    Math.log2(clamped / NIGHT_IMAGERY_FADE_ZERO_TEXELS_PER_PIXEL) /
    NIGHT_IMAGERY_FADE_BAND_OCTAVES;
  const weight = t * t * (3.0 - 2.0 * t);
  return texelsPerPixel > 0.0 ? weight : 1.0;
}

/**
 * Marks a layer as the one the globe attached on its own behalf.
 *
 * The magnification fade is a property of the default night layer, not of the
 * day/night alpha pair: an application that hand-builds a layer with the same
 * pair has chosen its own resolution and its own alphas, and must keep
 * rendering exactly what it asks for.
 *
 * @param {ImageryLayer} layer
 * @returns {ImageryLayer} The same layer.
 * @private
 */
export function markNightImageryLayer(layer) {
  layer._isGlobeNightImagery = true;
  return layer;
}

/**
 * @param {ImageryLayer} [layer]
 * @returns {boolean}
 * @private
 */
export function isNightImageryLayer(layer) {
  return defined(layer) && layer._isGlobeNightImagery === true;
}

/**
 * The imagery tile size, in pixels, one layer's magnification fade is measured
 * against on this globe - and zero for every layer the globe did not attach
 * itself.
 *
 * The shaders need one number per layer to turn a screen-space UV derivative
 * into a texel footprint, and this is it: multiplied by the layer's own
 * translation and scale it gives texels per unit of tile texture coordinate, in
 * whichever coordinate space the bound texture is sampled in. Zero is the
 * sentinel for a layer that never fades; the shaders short-circuit on it to keep
 * two square roots and a logarithm off a layer that cannot fade, and the
 * shortcut agrees with the arithmetic - a zero tile size makes the footprint
 * zero, and a footprint that is not positive is exactly the unmeasurable case
 * the law already answers with full strength.
 *
 * The magnification fade is a property of the default night layer, not of the
 * day/night alpha pair: an application that hand-builds a layer with the same
 * pair has chosen its own resolution and its own alphas, and must keep
 * rendering exactly what it asks for.
 *
 * The smaller of the two tile dimensions governs, so a layer is never credited
 * with structure it only has in one direction.
 *
 * @param {ImageryLayer} layer The layer being packed.
 * @returns {number} A tile size in pixels, or <code>0</code>.
 * @private
 */
export function resolveNightImageryFadeTilePixels(layer) {
  if (!isNightImageryLayer(layer)) {
    return 0.0;
  }
  const provider = layer.imageryProvider;
  return Math.min(
    tilePixels(provider?.tileWidth),
    tilePixels(provider?.tileHeight),
  );
}

/**
 * Whether one layer has magnified past carrying anything at all on one tile, so
 * the tile can be packed as though the layer were not attached.
 *
 * <code>textureTranslationAndScale</code> holds the terrain tile's extent as a
 * fraction of the imagery tile's, in whichever coordinate space the bound
 * texture is sampled in, so multiplying it by the source tile's pixel count
 * gives the texel count across the terrain tile on that axis without reading
 * the GPU texture - which the two backends hold in different places. The more
 * magnified axis governs.
 *
 * The comparison is written so a NaN count keeps the layer: an unmeasurable
 * magnification must leave the tile exactly as it renders today.
 *
 * @param {ImageryLayer} layer The layer being packed.
 * @param {TileImagery} tileImagery The tile/imagery association being packed.
 * @returns {boolean} <code>true</code> when the layer contributes nothing here.
 * @private
 */
export function nightImageryTileIsRetired(layer, tileImagery) {
  if (!isNightImageryLayer(layer)) {
    return false;
  }
  const translationAndScale = tileImagery?.textureTranslationAndScale;
  if (!defined(translationAndScale)) {
    return false;
  }
  const provider = layer.imageryProvider;
  const texelsAcrossTile = Math.min(
    translationAndScale.z * tilePixels(provider?.tileWidth),
    translationAndScale.w * tilePixels(provider?.tileHeight),
  );
  return texelsAcrossTile <= NIGHT_IMAGERY_RETIRE_TEXELS_ACROSS_TILE;
}

function tilePixels(value) {
  return typeof value === "number" && isFinite(value) && value > 0
    ? value
    : NIGHT_IMAGERY_ASSUMED_TILE_PIXELS;
}

/**
 * The night-side floor the procedural darkening fallback aims at on the fork's
 * own default path.
 *
 * Measured rather than chosen: it is the street-altitude darkness that reads as
 * night over a bright city without crushing the detail underneath it. It is the
 * companion of default-on night imagery rather than an independent default,
 * because the two hand over to each other continuously - the layer covers the
 * night side from orbit, magnification retires it on the way down, and this
 * floor is what the fallback supplies in its place.
 *
 * @private
 */
export const NIGHT_DARKNESS_DEFAULT = 0.15;

/**
 * The floor that leaves the surface exactly as upstream renders it.
 *
 * `mix(1.0, 1.0, t)` is `1.0` for every finite `t` in IEEE 754, so this value
 * makes the whole darkening term the multiplicative identity rather than merely
 * a small change - which is what lets an opt-out be called byte-identical.
 *
 * @private
 */
export const NIGHT_DARKNESS_IDENTITY = 1.0;

/**
 * The night-side floor one globe renders with this frame.
 *
 * Two separate questions meet here, and conflating them is what would break the
 * opt-out guarantee:
 *
 * <ul>
 *   <li>An assigned value is a request, and is honoured whatever else the globe
 *       is doing - including on a globe with night imagery switched off, which
 *       is the procedural-only configuration this property exists for.</li>
 *   <li>An unassigned value is the fork choosing on the application's behalf.
 *       The fork chooses a dark night side while its own night appearance is in
 *       play, and chooses upstream's while it is not. What counts as declining
 *       that appearance is exactly what makes
 *       {@link resolveNightImageryRequest} attach nothing on its own account -
 *       <code>false</code>, or an absent value - so the two halves of the night
 *       appearance switch off together instead of one outliving the other. An
 *       application that merely builds its own imagery stack, and so is never
 *       injected into, has said nothing about the night side and still gets the
 *       fork's default.</li>
 * </ul>
 *
 * @param {number} value The public property value.
 * @param {boolean} explicit Whether the property has been assigned.
 * @param {boolean|ImageryProvider|Promise<ImageryProvider>} nightImagery The
 *        night-imagery request this globe holds.
 * @returns {number} A floor in <code>[0, 1]</code>.
 * @private
 */
export function resolveNightDarkness(value, explicit, nightImagery) {
  if (explicit !== true) {
    return nightImageryIsDeclined(nightImagery)
      ? NIGHT_DARKNESS_IDENTITY
      : NIGHT_DARKNESS_DEFAULT;
  }
  return typeof value === "number" && isFinite(value)
    ? Math.min(Math.max(value, 0.0), 1.0)
    : NIGHT_DARKNESS_IDENTITY;
}

/**
 * Whether a night-imagery request is the application declining the fork's night
 * appearance rather than configuring it.
 *
 * The same two values {@link resolveNightImageryRequest} treats as "attach
 * nothing", read here so a request that switches the layer off cannot leave the
 * procedural half of the same appearance running.
 *
 * @param {boolean|ImageryProvider|Promise<ImageryProvider>} nightImagery
 * @returns {boolean}
 * @private
 */
export function nightImageryIsDeclined(nightImagery) {
  return nightImagery === false || !defined(nightImagery);
}

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
