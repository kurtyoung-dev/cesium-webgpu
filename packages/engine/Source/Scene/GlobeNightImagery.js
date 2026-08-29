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
 * The texel counts, measured across one terrain tile, between which the night
 * layer fades out.
 *
 * A bundled pyramid stops at a fixed deepest level, so every terrain tile below
 * that level resolves to the same imagery texel spread over a smaller and
 * smaller footprint. Tile selection holds a rendered terrain tile at roughly a
 * constant size on screen, so the texel count across a tile is also the texel
 * size on screen: around eight texels the layer still carries structure within
 * the tile, and at one texel it is a single flat colour covering the whole
 * tile, which replaces the scene beneath it instead of lighting it.
 *
 * The pair is expressed in texels rather than in levels so that it does not
 * change meaning when the pyramid is rebaked deeper or when a caller supplies a
 * provider whose tiles are not 256 pixels: a deeper pyramid moves the same
 * texel counts to a lower altitude, which is exactly the effect a deeper bake
 * is bought for.
 *
 * @private
 */
export const NIGHT_IMAGERY_FADE_FULL_TEXELS = 8.0;

/**
 * The lower end of the same pair: one texel across the tile, which is the
 * magnification at which the layer stops being an image of anything.
 *
 * @private
 */
export const NIGHT_IMAGERY_FADE_ZERO_TEXELS = 1.0;

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
 * Smoothstep over log2 of the texel count, because magnification is halving:
 * a linear ramp in texels would spend most of its travel in the first level and
 * step hard through the last.
 *
 * A non-finite count returns full strength rather than zero — an unmeasurable
 * magnification must leave the layer exactly as it renders today, not erase it.
 *
 * @param {number} texelsAcrossTile Imagery texels spanning the terrain tile.
 * @returns {number} A factor in <code>[0, 1]</code> for the layer's night alpha.
 * @private
 */
export function nightImageryMagnificationFade(texelsAcrossTile) {
  // Written as a negated comparison so a NaN count takes this arm.
  if (!(texelsAcrossTile < NIGHT_IMAGERY_FADE_FULL_TEXELS)) {
    return 1.0;
  }
  if (texelsAcrossTile <= NIGHT_IMAGERY_FADE_ZERO_TEXELS) {
    return 0.0;
  }
  const t =
    Math.log2(texelsAcrossTile / NIGHT_IMAGERY_FADE_ZERO_TEXELS) /
    Math.log2(NIGHT_IMAGERY_FADE_FULL_TEXELS / NIGHT_IMAGERY_FADE_ZERO_TEXELS);
  return t * t * (3.0 - 2.0 * t);
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
 * The fade factor to apply to one layer's resolved night alpha on one tile.
 *
 * <code>textureTranslationAndScale</code> holds the terrain tile's extent as a
 * fraction of the imagery tile's, in whichever coordinate space the bound
 * texture is sampled in, so multiplying it by the source tile's pixel count
 * gives the texel count across the terrain tile on that axis without reading
 * the GPU texture — which the two backends hold in different places. The more
 * magnified axis governs, so a layer is never credited with structure it only
 * has in one direction.
 *
 * @param {ImageryLayer} layer The layer being packed.
 * @param {TileImagery} tileImagery The tile/imagery association being packed.
 * @returns {number} A factor in <code>[0, 1]</code>; exactly 1.0 for every
 *          layer the globe did not attach itself.
 * @private
 */
export function resolveNightImageryFade(layer, tileImagery) {
  if (!isNightImageryLayer(layer)) {
    return 1.0;
  }
  const translationAndScale = tileImagery?.textureTranslationAndScale;
  if (!defined(translationAndScale)) {
    return 1.0;
  }
  const provider = layer.imageryProvider;
  const tilePixelsX = tilePixels(provider?.tileWidth);
  const tilePixelsY = tilePixels(provider?.tileHeight);
  return nightImageryMagnificationFade(
    Math.min(
      translationAndScale.z * tilePixelsX,
      translationAndScale.w * tilePixelsY,
    ),
  );
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
