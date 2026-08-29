uniform vec4 u_initialColor;

#if TEXTURE_UNITS > 0
uniform sampler2D u_dayTextures[TEXTURE_UNITS];
uniform vec4 u_dayTextureTranslationAndScale[TEXTURE_UNITS];
uniform bool u_dayTextureUseWebMercatorT[TEXTURE_UNITS];

#ifdef APPLY_ALPHA
uniform float u_dayTextureAlpha[TEXTURE_UNITS];
#endif

#ifdef APPLY_DAY_NIGHT_ALPHA
uniform float u_dayTextureNightAlpha[TEXTURE_UNITS];
uniform float u_dayTextureDayAlpha[TEXTURE_UNITS];
// The imagery tile size, in pixels, each layer's magnification fade is measured
// against, and zero for every layer that does not fade. Multiplied by the
// layer's own translation and scale it gives imagery texels per unit of tile
// texture coordinate, which is what turns a screen-space UV derivative into a
// texel footprint. Zero is the sentinel for a layer that never fades, and it
// agrees with the arithmetic it short-circuits: a zero tile size makes the
// footprint zero, and a footprint that is not positive is the unmeasurable case
// the law already answers with full strength.
uniform float u_dayTextureNightFadeTilePixels[TEXTURE_UNITS];

// Screen footprints, in imagery texels per screen pixel, between which a night
// layer fades out, and the width of that band in octaves. Exact twins of the
// three constants in Shaders/WebGPU/Globe/GlobeTerrain.wgsl and of the ones
// Scene/GlobeNightImagery.js exports, which is what the packers and the specs
// read.
const float NIGHT_IMAGERY_FADE_FULL_TEXELS_PER_PIXEL = 1.0 / 16.0;
const float NIGHT_IMAGERY_FADE_ZERO_TEXELS_PER_PIXEL = 1.0 / 64.0;
const float NIGHT_IMAGERY_FADE_BAND_OCTAVES = 2.0;

// The magnification weight the last sampleAndBlend call resolved. Same carrier
// pattern, and the same reason, as g_nightLightsLayerColor below: the emission
// is applied on the statement after the composite call that wrote it, and
// widening the composite's return would rewrite every generated call site
// including the ones that never emit.
float g_nightImageryFade = 1.0;

// A night layer's share of its own night alpha at a given magnification.
//
// Smoothstep over log2 of the footprint, because magnification travels in
// halvings: a ramp linear in texels would spend most of its travel in the first
// octave and step hard through the last.
//
// The clamp is what makes both endpoints exact. At the near knee the ratio is
// the band width, so t is exactly 1 and the weight is exactly 1.0 — anything
// less re-renders every view the layer is composed for. At the far knee t is
// exactly 0 and the weight is exactly 0.0; a weight that merely approaches zero
// leaves an opaque layer opaque and the wash survives, dimmer.
//
// A footprint that is not a positive number returns full strength rather than
// zero: an unmeasurable magnification must leave the layer exactly as it renders
// today, not erase it. The comparison is written on the positive side so a NaN
// footprint takes that arm.
//
// Exact twin of GlobeTerrain.wgsl's nightImageryMagnificationFade, term for term
// and constant for constant, and of the JavaScript the packers and the specs
// read; the three are executed against each other numerically rather than
// compared by eye.
float nightImageryMagnificationFade(float texelsPerPixel)
{
    float clamped = clamp(texelsPerPixel, NIGHT_IMAGERY_FADE_ZERO_TEXELS_PER_PIXEL, NIGHT_IMAGERY_FADE_FULL_TEXELS_PER_PIXEL);
    float t = log2(clamped / NIGHT_IMAGERY_FADE_ZERO_TEXELS_PER_PIXEL) / NIGHT_IMAGERY_FADE_BAND_OCTAVES;
    float weight = t * t * (3.0 - 2.0 * t);
    if (texelsPerPixel > 0.0)
    {
        return weight;
    }
    return 1.0;
}

// The weight for one layer on one fragment, from that fragment's own footprint.
//
// The footprint is the screen-space Jacobian of the layer's texel coordinates,
// and it is the same number on both sides of a terrain LOD seam: a tile one
// level finer carries half the texels across twice the terrain detail but is
// also half the size on screen, so texels per screen pixel cancels the level
// out. That is what makes this weight continuous where a texel count per tile
// steps.
//
// The RAW tile UV is differentiated, not the seam-clamped one. The clamp moves
// UVs by about 1e-6, but it can collapse both lanes of an edge quad onto the
// same value, and a zero footprint reads as unmeasurable and returns the layer
// at full strength — a bright hairline around every tile in the band.
//
// The more magnified direction governs, so a layer is never credited with
// structure it only has in one direction.
//
// A layer that does not fade carries a zero tile size and takes the early
// return. Its footprint would be zero, which the law already answers with full
// strength, so the branch changes no pixel - it keeps two square roots and a
// logarithm off every layer of every globe that has no night imagery, in the
// hottest fragment shader the engine has.
//
// Twin of GlobeTerrain.wgsl's nightImageryFadeWeight. The one divergence the
// two shading languages force: WGSL must take its derivatives at fragment entry
// while control flow is still uniform and receives them as parameters, where
// this function may differentiate in place.
float nightImageryFadeWeight(vec2 rawTileTextureCoordinates, vec2 scale, float tilePixels)
{
    if (tilePixels <= 0.0)
    {
        return 1.0;
    }
    vec2 texelScale = scale * tilePixels;
    float footprintX = length(dFdx(rawTileTextureCoordinates) * texelScale);
    float footprintY = length(dFdy(rawTileTextureCoordinates) * texelScale);
    return nightImageryMagnificationFade(min(footprintX, footprintY));
}
#endif

#ifdef APPLY_SPLIT
uniform float u_dayTextureSplit[TEXTURE_UNITS];
#endif

#ifdef APPLY_BRIGHTNESS
uniform float u_dayTextureBrightness[TEXTURE_UNITS];
#endif

#ifdef APPLY_CONTRAST
uniform float u_dayTextureContrast[TEXTURE_UNITS];
#endif

#ifdef APPLY_HUE
uniform float u_dayTextureHue[TEXTURE_UNITS];
#endif

#ifdef APPLY_SATURATION
uniform float u_dayTextureSaturation[TEXTURE_UNITS];
#endif

#ifdef APPLY_GAMMA
uniform float u_dayTextureOneOverGamma[TEXTURE_UNITS];
#endif

#ifdef APPLY_IMAGERY_CUTOUT
uniform vec4 u_dayTextureCutoutRectangles[TEXTURE_UNITS];
#endif

#ifdef APPLY_COLOR_TO_ALPHA
uniform vec4 u_colorsToAlpha[TEXTURE_UNITS];
#endif

uniform vec4 u_dayTextureTexCoordsRectangle[TEXTURE_UNITS];
#endif

#if defined(HAS_WATER_MASK) && (defined(SHOW_REFLECTIVE_OCEAN) || defined(APPLY_MATERIAL))
uniform sampler2D u_waterMask;
uniform vec4 u_waterMaskTranslationAndScale;
uniform float u_zoomedOutOceanSpecularIntensity;
#endif

#ifdef SHOW_OCEAN_WAVES
uniform sampler2D u_oceanNormalMap;
#endif

#if defined(ENABLE_DAYNIGHT_SHADING) || defined(GROUND_ATMOSPHERE)
uniform vec2 u_lightingFadeDistance;
#endif

#ifdef TILE_LIMIT_RECTANGLE
uniform vec4 u_cartographicLimitRectangle;
#endif

#ifdef GROUND_ATMOSPHERE
uniform vec2 u_nightFadeDistance;
#endif

#ifdef ENABLE_CLIPPING_PLANES
uniform highp sampler2D u_clippingPlanes;
uniform mat4 u_clippingPlanesMatrix;
uniform vec4 u_clippingPlanesEdgeStyle;
#endif

#ifdef ENABLE_CLIPPING_POLYGONS
uniform highp sampler2D u_clippingDistance;
in vec2 v_clippingPosition;
flat in int v_regionIndex;
#endif

#if defined(GROUND_ATMOSPHERE) || defined(FOG) && defined(DYNAMIC_ATMOSPHERE_LIGHTING) && (defined(ENABLE_VERTEX_LIGHTING) || defined(ENABLE_DAYNIGHT_SHADING))
uniform float u_minimumBrightness;
#endif

// Based on colorCorrect
// The colorCorrect flag can only be true when tileProvider.hue/saturation/brightnessShift
// are nonzero AND when (applyFog || showGroundAtmosphere) in the tile provider
// - The tileProvider.hue/saturation/brightnessShift are just passed through
//   from the Globe hue/saturation/brightness, like atmosphereBrightnessShift
// - The applyFog depends on enableFog, and some tile distance from the viewer
// - The showGroundAtmosphere is a flag that is passed through from the Globe,
//   and is true by default when the ellipsoid is WGS84
#ifdef COLOR_CORRECT
uniform vec3 u_hsbShift; // Hue, saturation, brightness
#endif

// Based on highlightFillTile
// This is set for terrain tiles when they are "fill" tiles, and
// the terrainProvider.fillHighlightColor was set to a value with
// nonzero alpha
#ifdef HIGHLIGHT_FILL_TILE
uniform vec4 u_fillHighlightColor;
#endif

// Based on translucent
// This is set depending on the GlobeTranslucencyState
#ifdef TRANSLUCENT
uniform vec4 u_frontFaceAlphaByDistance;
uniform vec4 u_backFaceAlphaByDistance;
uniform vec4 u_translucencyRectangle;
#endif

// Based on showUndergroundColor
// This is set when GlobeSurfaceTileProvider.isUndergroundVisible
// returns true, AND the tileProvider.undergroundColor had a value with
// nonzero alpha, and the tileProvider.undergroundColorAlphaByDistance
// was in the right range
#ifdef UNDERGROUND_COLOR
uniform vec4 u_undergroundColor;
uniform vec4 u_undergroundColorAlphaByDistance;
#endif

// Based on enableLighting && hasVertexNormals
// The enableLighting flag is passed in directly from the Globe.
// The hasVertexNormals flag is from the tileProvider
#ifdef ENABLE_VERTEX_LIGHTING
uniform float u_lambertDiffuseMultiplier;
uniform float u_vertexShadowDarkness;
#endif

#if defined(ENABLE_VERTEX_LIGHTING) || defined(ENABLE_DAYNIGHT_SHADING)
uniform float u_terminatorGlowStrength;
#endif

#ifdef APPLY_NIGHT_DARKNESS
uniform float u_nightDarkness;
#endif

// The largest night-side opacity any imagery layer resolved on this fragment.
//
// The procedural night darkening is the complement of the layer path: it
// supplies the share of the night side the layers leave uncovered, so the night
// side is darkened once whether the darkening comes from a layer or from the
// fallback. That share is a per-FRAGMENT quantity because the magnification
// fade producing it is one: two adjacent terrain tiles a level apart carry the
// same magnification and must hand over at the same rate, which a per-tile
// scalar cannot express — it reports two values a factor of two apart and the
// seam between the tiles steps. Initialized because a fill tile with no imagery
// layers writes it nowhere.
float g_nightImageryCoverage = 0.0;

#ifdef APPLY_CELESTIAL_WATER
// The moonglade's three resolved controls.
//   x = base microfacet roughness of the near water, already clamped
//   y = multiplier on the reflected lunar disc, already floored at 0
//   z = illuminated fraction of the lunar disc, 0 on a frame with no Moon
//   w = reserved
// Resolved CPU-side by Scene/CelestialWaterReflection, the same law the WebGPU
// camera uniform buffer packs its tail from, so the two backends cannot drift
// in what "off" or "unset" means. The direction to the Moon is not carried
// here: czm_moonDirectionEC is an ephemeris quantity UniformState recomputes
// every frame, so it is never stale, and z closes the term on a frame that
// draws no Moon.
uniform vec4 u_oceanCelestialMoon;

#endif
#ifdef APPLY_NIGHT_LIGHTS
uniform float u_nightIntensity;

// The post-effects colour of the layer `sampleAndBlend` was last called with.
//
// Emission needs the layer's own colour, not the composite it was blended into,
// and it needs it after the per-layer effects chain rather than as sampled. The
// WGSL twin returns that colour as a third struct member; this function already
// returns its one vec4, and widening its signature would rewrite every
// generated call site including the ones that never emit. A file-scope carrier
// written under this define keeps the emitting variant's cost to the variant
// that emits, and the value is consumed on the next statement after the call
// that wrote it. Initialized because a global without one has no defined value
// until the first composite writes it, and a fill tile with no imagery layers
// generates no write at all.
vec3 g_nightLightsLayerColor = vec3(0.0);
#endif

// Per-fragment lunar shadow on the globe. The two body vectors are a
// geocentric, range-normalized differential:
//   sun.xyz  = normalize(S), sun.w = 1 / length(S)
//   moon.xyz = normalize(M) - normalize(S), moon.w = 1 / length(M)
// where S/M are ECEF body positions. This preserves the tiny Sun/Moon angular
// difference through the f64->f32 boundary and is independent of whichever
// pass camera executes the command. The inactive WebGL shader variant omits
// this block entirely; active gates 1-4 use one manual mat4 per terrain draw.
// Matrix columns preserve the logical 4xvec4 block shared with WebGPU's
// dedicated 64-byte UBO.
#ifdef ENABLE_ECLIPSE_GLOBE_SHADOW
uniform mat4 u_eclipseGlobeShadow;
#define u_eclipseSunDirectionAndInvRange u_eclipseGlobeShadow[0]
#define u_eclipseMoonDirectionDeltaAndInvRange u_eclipseGlobeShadow[1]
#define u_eclipseParams u_eclipseGlobeShadow[2]
#define u_eclipseParams2 u_eclipseGlobeShadow[3]
#endif

in vec3 v_positionMC;
in vec3 v_positionEC;
in vec3 v_textureCoordinates;
in vec3 v_normalMC;
in vec3 v_normalEC;

#ifdef APPLY_MATERIAL
in float v_height;
in float v_slope;
in float v_aspect;
#endif

#if defined(FOG) || defined(GROUND_ATMOSPHERE) || defined(UNDERGROUND_COLOR) || defined(TRANSLUCENT)
in float v_distance;
#endif

#if defined(GROUND_ATMOSPHERE) || defined(FOG)
in vec3 v_atmosphereRayleighColor;
in vec3 v_atmosphereMieColor;
in float v_atmosphereOpacity;
#endif

#if defined(UNDERGROUND_COLOR) || defined(TRANSLUCENT)
float interpolateByDistance(vec4 nearFarScalar, float distance)
{
    float startDistance = nearFarScalar.x;
    float startValue = nearFarScalar.y;
    float endDistance = nearFarScalar.z;
    float endValue = nearFarScalar.w;
    float t = clamp((distance - startDistance) / (endDistance - startDistance), 0.0, 1.0);
    return mix(startValue, endValue, t);
}
#endif

#ifdef APPLY_NIGHT_LIGHTS
// Resolves the emission multiplier the CPU packed.
//
// Exact twin of `GlobeTerrain.wgsl`'s `getNightIntensity()`: a negative slot
// means the CPU supplied no value and the shader's own default stands, while
// zero is a real value - Globe.nightIntensity is documented as "no emission" at
// zero - and must survive. The enable travels separately for that reason.
float nightLightsIntensity()
{
    return u_nightIntensity < 0.0 ? 2.5 : u_nightIntensity;
}

// Emissive night lights: a layer whose night alpha exceeds its day alpha is
// city lights, and is added on top of the composite in proportion to its own
// luminance so that bright cores glow more than their outskirts.
//
// Exact twin of `Shaders/WebGPU/Globe/GlobeTerrain.wgsl`'s
// `applyNightLightsEmission`, term for term and constant for constant; the two
// are executed against each other numerically rather than compared by eye. The
// luminance weights are written out rather than taken from `czm_luminance`,
// whose weights are the older (0.2125, 0.7154, 0.0721) triple and would put the
// two backends a fraction of a percent apart on every emitting texel.
// The alpha pair the gate reads is the layer's own, before magnification: what
// makes a layer city lights is how it was configured, not how close the camera
// is. The magnification weight scales the emission instead, so the lights thin
// out with the layer that carries them rather than snapping off when the faded
// alpha crosses the gate.
vec3 applyNightLightsEmission(
    vec3 color,
    vec3 layerColor,
    float nightBlend,
    float nightAlpha,
    float dayAlpha,
    float magnificationFade)
{
    float isNightLayer = step(dayAlpha + 0.01, nightAlpha);
    float lum = dot(layerColor, vec3(0.2126, 0.7152, 0.0722));
    float nightIntensity = nightLightsIntensity();
    vec3 emission = layerColor * lum * nightBlend * nightIntensity * isNightLayer * magnificationFade;
    return color + emission;
}
#endif

#if defined(UNDERGROUND_COLOR) || defined(TRANSLUCENT) || defined(APPLY_MATERIAL)
vec4 alphaBlend(vec4 sourceColor, vec4 destinationColor)
{
    return sourceColor * vec4(sourceColor.aaa, 1.0) + destinationColor * (1.0 - sourceColor.a);
}
#endif

#ifdef TRANSLUCENT
bool inTranslucencyRectangle()
{
    return
        v_textureCoordinates.x > u_translucencyRectangle.x &&
        v_textureCoordinates.x < u_translucencyRectangle.z &&
        v_textureCoordinates.y > u_translucencyRectangle.y &&
        v_textureCoordinates.y < u_translucencyRectangle.w;
}
#endif

// Paired with `applyImageryLayer` in
// Shaders/WebGPU/Globe/GlobeTerrain.wgsl; a change to either half has to land
// with a matching change to the other.
//
// Divergences the two shading languages force:
// - This function samples the imagery texture inline via `texture()`. The
//   WGSL counterpart takes a pre-sampled `texSample` parameter, because WGSL
//   cannot dynamically index a texture array inside a function; its 16
//   imagery slots are unrolled at the call site in `fragmentMain`.
// - This function returns `vec4(outColor, outAlpha)`; the WGSL returns a
//   `LayerComposite { color, alpha, adjustedColor }` struct, because its
//   night-lights emission path needs the post-effects color separately. Both
//   backends now carry that path; this one hands the post-effects color to it
//   through the `g_nightLightsLayerColor` carrier rather than by widening the
//   return, so the non-emitting variants keep the signature they had.
// - Per-effect gating is `#ifdef APPLY_*` here and `if (abs(...) > eps)` in
//   WGSL: this file relies on the pipeline cache to emit defines from which
//   per-layer properties are non-default, while WGSL evaluates every effect
//   with fast-path skips for default values. Both agree at the defaults.
//
// The final blend also differs. WGSL uses a straight mix,
//   outColor = mix(prevColor, adjusted, effectiveAlpha)
//   outAlpha = max(prevAlpha, effectiveAlpha)
// against the premultiplied-alpha OVER composite below. For opaque imagery
// (textureAlpha = 1) the two are identical. For partial alpha — a day/night
// terminator with both dayAlpha and nightAlpha below 1, say — this function
// preserves source brightness where the WGSL attenuates it by the source
// alpha.
vec4 sampleAndBlend(
    vec4 previousColor,
    sampler2D textureToSample,
    vec2 tileTextureCoordinates,
    vec4 textureCoordinateRectangle,
    vec4 textureCoordinateTranslationAndScale,
    float textureAlpha,
    float textureNightAlpha,
    float textureDayAlpha,
    vec2 rawTileTextureCoordinates,
    float nightFadeTilePixels,
    float textureBrightness,
    float textureContrast,
    float textureHue,
    float textureSaturation,
    float textureOneOverGamma,
    float split,
    vec4 colorToAlpha,
    float nightBlend)
{
    // Captured before the rectangle mask below, because the fallback's coverage
    // is the layer's own night-side opacity rather than its coverage of this
    // fragment's rectangle — the same product the packers folded on the CPU
    // before the weight became a per-fragment quantity.
    float layerAlpha = textureAlpha;

    // This crazy step stuff sets the alpha to 0.0 if this following condition is true:
    //    tileTextureCoordinates.s < textureCoordinateRectangle.s ||
    //    tileTextureCoordinates.s > textureCoordinateRectangle.p ||
    //    tileTextureCoordinates.t < textureCoordinateRectangle.t ||
    //    tileTextureCoordinates.t > textureCoordinateRectangle.q
    // In other words, the alpha is zero if the fragment is outside the rectangle
    // covered by this texture.  Would an actual 'if' yield better performance?
    vec2 alphaMultiplier = step(textureCoordinateRectangle.st, tileTextureCoordinates);
    textureAlpha = textureAlpha * alphaMultiplier.x * alphaMultiplier.y;

    alphaMultiplier = step(vec2(0.0), textureCoordinateRectangle.pq - tileTextureCoordinates);
    textureAlpha = textureAlpha * alphaMultiplier.x * alphaMultiplier.y;

#ifdef APPLY_DAY_NIGHT_ALPHA
    // A night layer retires with magnification, per fragment: past the deepest
    // level its pyramid contains one of its texels spreads over more and more of
    // the screen, and beyond a point it is a flat wash replacing the scene rather
    // than an image of it. Every other layer packs a zero tile size, which makes
    // the footprint zero and the weight exactly 1.0, so this is the identity for
    // them and the blend is the one they had.
    g_nightImageryFade = nightImageryFadeWeight(
        rawTileTextureCoordinates,
        textureCoordinateTranslationAndScale.zw,
        nightFadeTilePixels);
    float effectiveNightAlpha = textureNightAlpha * g_nightImageryFade;
    textureAlpha *= mix(textureDayAlpha, effectiveNightAlpha, nightBlend);

    // Only a layer that asked for a day/night pair covers the night side; a pair
    // still at (1, 1) is an ordinary layer covering day and night alike, which is
    // not what the procedural fallback is the complement of.
    if (textureDayAlpha != 1.0 || textureNightAlpha != 1.0)
    {
        g_nightImageryCoverage = max(g_nightImageryCoverage, effectiveNightAlpha * layerAlpha);
    }
#endif

    vec2 translation = textureCoordinateTranslationAndScale.xy;
    vec2 scale = textureCoordinateTranslationAndScale.zw;
    vec2 textureCoordinates = tileTextureCoordinates * scale + translation;
    vec4 value = texture(textureToSample, textureCoordinates);
    vec3 color = value.rgb;
    float alpha = value.a;

#ifdef APPLY_COLOR_TO_ALPHA
    vec3 colorDiff = abs(color.rgb - colorToAlpha.rgb);
    colorDiff.r = czm_maximumComponent(colorDiff);
    alpha = czm_branchFreeTernary(colorDiff.r < colorToAlpha.a, 0.0, alpha);
#endif

#if !defined(APPLY_GAMMA)
    vec4 tempColor = czm_gammaCorrect(vec4(color, alpha));
    color = tempColor.rgb;
    alpha = tempColor.a;
#else
    color = pow(color, vec3(textureOneOverGamma));
#endif

#ifdef APPLY_SPLIT
    float splitPosition = czm_splitPosition;
    // Split to the left
    if (split < 0.0 && gl_FragCoord.x > splitPosition) {
       alpha = 0.0;
    }
    // Split to the right
    else if (split > 0.0 && gl_FragCoord.x < splitPosition) {
       alpha = 0.0;
    }
#endif

#ifdef APPLY_BRIGHTNESS
    color = mix(vec3(0.0), color, textureBrightness);
#endif

#ifdef APPLY_CONTRAST
    color = mix(vec3(0.5), color, textureContrast);
#endif

#ifdef APPLY_HUE
    color = czm_hue(color, textureHue);
#endif

#ifdef APPLY_SATURATION
    color = czm_saturation(color, textureSaturation);
#endif

#ifdef APPLY_NIGHT_LIGHTS
    // Clamped, matching the WGSL twin's `adjusted`, which clamps here and feeds
    // the clamped value to its emission. The clamp is emission-local: the
    // composite below keeps reading the unclamped `color` it always read, so
    // this line changes no pixel of the non-emitting path.
    g_nightLightsLayerColor = clamp(color, 0.0, 1.0);
#endif

    float sourceAlpha = alpha * textureAlpha;
    float outAlpha = mix(previousColor.a, 1.0, sourceAlpha);
    outAlpha += sign(outAlpha) - 1.0;

    vec3 outColor = mix(previousColor.rgb * previousColor.a, color, sourceAlpha) / outAlpha;

    // When rendering imagery for a tile in multiple passes,
    // some GPU/WebGL implementation combinations will not blend fragments in
    // additional passes correctly if their computation includes an unmasked
    // divide-by-zero operation,
    // even if it's not in the output or if the output has alpha zero.
    //
    // For example, without sanitization for outAlpha,
    // this renders without artifacts:
    //   if (outAlpha == 0.0) { outColor = vec3(0.0); }
    //
    // but using czm_branchFreeTernary will cause portions of the tile that are
    // alpha-zero in the additional pass to render as black instead of blending
    // with the previous pass:
    //   outColor = czm_branchFreeTernary(outAlpha == 0.0, vec3(0.0), outColor);
    //
    // So instead, sanitize against divide-by-zero,
    // store this state on the sign of outAlpha, and correct on return.

    return vec4(outColor, max(outAlpha, 0.0));
}

vec4 computeDayColor(vec4 initialColor, vec3 textureCoordinates, float nightBlend);
vec4 computeWaterColor(vec3 positionEyeCoordinates, vec2 textureCoordinates, vec2 tcDx, vec2 tcDy, mat3 enuToEye, vec4 imageryColor, float specularMapValue, float fade);

const float fExposure = 2.0;

vec3 computeEllipsoidPosition()
{
    float mpp = czm_metersPerPixel(vec4(0.0, 0.0, -czm_currentFrustum.x, 1.0), 1.0);
    vec2 xy = gl_FragCoord.xy / czm_viewport.zw * 2.0 - vec2(1.0);
    xy *= czm_viewport.zw * mpp * 0.5;

    vec3 direction;
    if (czm_orthographicIn3D == 1.0)
    {
        direction = vec3(0.0, 0.0, -1.0);
    }
    else
    {
        direction = normalize(vec3(xy, -czm_currentFrustum.x));
    }

    czm_ray ray = czm_ray(vec3(0.0), direction);

    vec3 ellipsoid_center = czm_view[3].xyz;

    czm_raySegment intersection = czm_rayEllipsoidIntersectionInterval(ray, ellipsoid_center, czm_ellipsoidInverseRadii);

    vec3 ellipsoidPosition = czm_pointAlongRay(ray, intersection.start);
    return (czm_inverseView * vec4(ellipsoidPosition, 1.0)).xyz;
}

#ifdef ENABLE_ECLIPSE_GLOBE_SHADOW
// Paired with the eclipse globe shadow in
// Shaders/WebGPU/Globe/GlobeTerrain.wgsl; a change to either half has to land
// with a matching change to the other.
//
// Exact support comes from the analytic circle-overlap branches. A small
// per-frame cubic maps uniform-disc overlap to the same limb-darkened flux
// law used by EclipseState without putting its quadrature in the hot shader.
float eclipseGeometricObscuration(float rs, float ro, float d)
{
    if (d >= rs + ro)
    {
        return 0.0;
    }
    if (d + rs <= ro)
    {
        return 1.0;
    }
    if (d + ro <= rs)
    {
        float ratio = ro / rs;
        return ratio * ratio;
    }

    float d2 = d * d;
    float rs2 = rs * rs;
    float ro2 = ro * ro;
    float alpha = acos(clamp((d2 + rs2 - ro2) / (2.0 * d * rs), -1.0, 1.0));
    float beta = acos(clamp((d2 + ro2 - rs2) / (2.0 * d * ro), -1.0, 1.0));
    float product = max(
        (-d + rs + ro) * (d + rs - ro) *
        (d - rs + ro) * (d + rs + ro),
        0.0
    );
    float lens = rs2 * alpha + ro2 * beta - 0.5 * sqrt(product);
    return clamp(lens / (czm_pi * rs2), 0.0, 1.0);
}

float eclipseLimbDarken(float geometricObscuration)
{
    float a = geometricObscuration;
    return a + a * (1.0 - a) *
        (u_eclipseParams.z + u_eclipseParams.w * a +
         u_eclipseParams2.w * a * a);
}

// Absolute per-fragment factor G(O_fragment). positionMC is the exaggerated
// ECEF globe varying. Its sub-metre f32 quantization is tiny relative to the
// footprint, and multiplying it by each inverse astronomical range before the
// common-ray subtraction keeps all operands conditioned and pass-camera-free.
const float eclipseF32SafetyFactor = 0.999996185302734375;

float eclipseFragmentFactor(vec3 positionMC)
{
    float invSunRange = u_eclipseSunDirectionAndInvRange.w;
    float invMoonRange = u_eclipseMoonDirectionDeltaAndInvRange.w;

    // v_positionMC is the exaggerated ECEF globe position. Its Earth-scale
    // f32 quantization is sub-metre, while scaling before the astronomical
    // subtraction keeps the common-ray operands O(1). This is independent of
    // render/capture cameras and avoids rebuilding P through camera RTE terms.
    vec3 positionScaledForSun =
        positionMC * invSunRange;
    vec3 toSunScaled =
        u_eclipseSunDirectionAndInvRange.xyz - positionScaledForSun;

    float rangeDelta = invSunRange - invMoonRange;
    vec3 positionScaledForDelta =
        positionMC * rangeDelta;
    vec3 moonMinusSunScaled =
        u_eclipseMoonDirectionDeltaAndInvRange.xyz +
        positionScaledForDelta;

    float sunLength2 = dot(toSunScaled, toSunScaled);
    float sunDeltaDot = dot(toSunScaled, moonMinusSunScaled);
    float moonLength2 = max(
        sunLength2 + 2.0 * sunDeltaDot +
        dot(moonMinusSunScaled, moonMinusSunScaled),
        1.0e-30
    );
    if (!(sunLength2 > 0.0))
    {
        return 1.0;
    }

    // Exact local disc-support rejection without inverse trig or square roots.
    // Let ks=sin(rs)|s| and km=sin(ro)|m|. Then:
    //   |s||m|cos(rs+ro)
    //     = sqrt((s²-ks²)(m²-km²)) - ks*km.
    // A fragment can overlap only when q=dot(s,m)+ks*km is positive and
    // q² exceeds the radicand. The safety factor rounds the comparison
    // outward under permitted f32 fusion/reassociation; false positives fall
    // through to the exact analytic lens test below.
    float dotSunMoon = sunLength2 + sunDeltaDot;
    float sunAngularScale = czm_solarRadius * invSunRange;
    const float lunarRadius = 1737400.0;
    float moonAngularScale = lunarRadius * invMoonRange;
    float supportDot =
        dotSunMoon + sunAngularScale * moonAngularScale;
    float supportRadicand =
        max(sunLength2 - sunAngularScale * sunAngularScale, 0.0) *
        max(moonLength2 - moonAngularScale * moonAngularScale, 0.0);
    if (supportDot <= 0.0 ||
        supportDot * supportDot <=
            eclipseF32SafetyFactor * supportRadicand)
    {
        return 1.0;
    }

    // Angular overlap also exists through the solid body from the antipode.
    // Transform the ray to the globe ellipsoid's unit sphere. An inward ray
    // is visible only when its closest point clears that sphere, which handles
    // WGS84/custom oblateness and elevated terrain without a spherical-normal
    // terminator error.
    vec3 ellipsoidPosition =
        positionMC * czm_ellipsoidInverseRadii;
    vec3 ellipsoidSunRay =
        toSunScaled * czm_ellipsoidInverseRadii;
    float ellipsoidRayLength2 =
        dot(ellipsoidSunRay, ellipsoidSunRay);
    float ellipsoidPositionDotRay =
        dot(ellipsoidPosition, ellipsoidSunRay);
    if (!(ellipsoidRayLength2 > 0.0))
    {
        return 1.0;
    }
    if (ellipsoidPositionDotRay < 0.0)
    {
        vec3 ellipsoidLimb =
            cross(ellipsoidPosition, ellipsoidSunRay);
        float closestEllipsoidRadius2 =
            dot(ellipsoidLimb, ellipsoidLimb) / ellipsoidRayLength2;
        if (closestEllipsoidRadius2 < eclipseF32SafetyFactor)
        {
            return 1.0;
        }
    }

    float invSunLength = inversesqrt(sunLength2);
    float invMoonLength = inversesqrt(moonLength2);
    float rs = asin(clamp(
        sunAngularScale * invSunLength,
        0.0,
        1.0
    ));
    float ro = asin(clamp(
        moonAngularScale * invMoonLength,
        0.0,
        1.0
    ));

    // atan(|cross|, dot), evaluated from the common-ray differential, is
    // well-conditioned at umbral angles. Do not replace with acos(dot) or
    // normalize two independently-rounded near-parallel vectors.
    float separation = atan(
        length(cross(toSunScaled, moonMinusSunScaled)),
        dotSunMoon
    );
    float geometric = eclipseGeometricObscuration(rs, ro, separation);
    if (geometric <= 0.0)
    {
        return 1.0;
    }

    float obscuration;
    if (geometric >= 1.0)
    {
        obscuration = 1.0;
    }
    else
    {
        float inner = rs - ro;
        if (inner > 0.0 && separation <= inner)
        {
            float t = separation / inner;
            obscuration = clamp(
                eclipseLimbDarken(geometric) +
                u_eclipseParams2.z * (1.0 - t * t),
                0.0,
                1.0
            );
        }
        else
        {
            obscuration = clamp(eclipseLimbDarken(geometric), 0.0, 1.0);
        }
    }

    float visible = 1.0 - obscuration;
    float flux =
        visible + u_eclipseParams2.x * (1.0 - visible);
    return pow(flux, u_eclipseParams2.y);
}
#endif

// Optional stylized appearance term shared exactly with GlobeTerrain.wgsl.
// The caller branches on the default-zero strength before evaluating exp().
vec3 computeTerminatorGlow(vec3 normalEC, vec3 sunDirEC)
{
    float NdotL = dot(normalEC, sunDirEC);
    float terminatorFactor = exp(-NdotL * NdotL * 40.0);
    vec3 warmColor = vec3(0.95, 0.45, 0.15);
    return warmColor * terminatorFactor * 0.15;
}

void main()
{
#ifdef TILE_LIMIT_RECTANGLE
    if (v_textureCoordinates.x < u_cartographicLimitRectangle.x || u_cartographicLimitRectangle.z < v_textureCoordinates.x ||
        v_textureCoordinates.y < u_cartographicLimitRectangle.y || u_cartographicLimitRectangle.w < v_textureCoordinates.y)
        {
            discard;
        }
#endif

#ifdef ENABLE_CLIPPING_PLANES
    float clipDistance = clip(gl_FragCoord, u_clippingPlanes, u_clippingPlanesMatrix);
#endif

#if defined(SHOW_REFLECTIVE_OCEAN) || defined(ENABLE_DAYNIGHT_SHADING) || defined(HDR) || defined(APPLY_DAY_NIGHT_ALPHA) || defined(APPLY_NIGHT_DARKNESS)
    vec3 normalMC = czm_geodeticSurfaceNormal(v_positionMC, vec3(0.0), vec3(1.0));   // normalized surface normal in model coordinates
    vec3 normalEC = czm_normal3D * normalMC;                                         // normalized surface normal in eye coordinates
#endif

// The day/night imagery alpha is gated on APPLY_DAY_NIGHT_ALPHA alone, and
// deliberately not on either lighting define. The two answer different
// questions: the lighting defines say whether the globe is SHADED, while a
// layer carrying a day/night alpha pair is asking to be VISIBLE on one side of
// the terminator. Conjoining them made a night layer invisible on any terrain
// that reports vertex normals, because that terrain takes ENABLE_VERTEX_LIGHTING
// and never emits ENABLE_DAYNIGHT_SHADING — and it made the pair inert on the
// default unlit globe, where neither define is emitted at all.
//
// `normalEC` above is the analytic geocentric normal, per fragment, in every
// arm. The mesh normal is not a substitute: it is absent on normal-less terrain
// and, where it exists, carries terrain relief the terminator must not follow.
// The second alternative is the procedural night fallback, which needs the
// same terminator position wherever the layers leave part of the night side
// uncovered — every tile that carries no day/night layer, and also the tiles
// where one has faded out with magnification. Both alternatives can be present
// on the same tile, and the ramp is one expression rather than two, so the two
// consumers read the same terminator position.
#if defined(APPLY_DAY_NIGHT_ALPHA) || defined(APPLY_NIGHT_DARKNESS)
    float nightBlend = 1.0 - clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * 5.0, 0.0, 1.0);
#else
    float nightBlend = 0.0;
#endif

    // The clamp below works around an apparent bug in Chrome Canary v23.0.1241.0
    // where the fragment shader sees textures coordinates < 0.0 and > 1.0 for the
    // fragments on the edges of tiles even though the vertex shader is outputting
    // coordinates strictly in the 0-1 range.
    vec4 color = computeDayColor(u_initialColor, clamp(v_textureCoordinates, 0.0, 1.0), nightBlend);

#ifdef SHOW_TILE_BOUNDARIES
    if (v_textureCoordinates.x < (1.0/256.0) || v_textureCoordinates.x > (255.0/256.0) ||
        v_textureCoordinates.y < (1.0/256.0) || v_textureCoordinates.y > (255.0/256.0))
    {
        color = vec4(1.0, 0.0, 0.0, 1.0);
    }
#endif

#if defined(ENABLE_DAYNIGHT_SHADING) || defined(GROUND_ATMOSPHERE)
    float cameraDist;
    if (czm_sceneMode == czm_sceneMode2D)
    {
        cameraDist = max(czm_frustumPlanes.x - czm_frustumPlanes.y, czm_frustumPlanes.w - czm_frustumPlanes.z) * 0.5;
    }
    else if (czm_sceneMode == czm_sceneModeColumbusView)
    {
        cameraDist = -czm_view[3].z;
    }
    else
    {
        cameraDist = length(czm_view[3]);
    }
    float fadeOutDist = u_lightingFadeDistance.x;
    float fadeInDist = u_lightingFadeDistance.y;
    if (czm_sceneMode != czm_sceneMode3D) {
        vec3 radii = czm_ellipsoidRadii;
        float maxRadii = max(radii.x, max(radii.y, radii.z));
        fadeOutDist -= maxRadii;
        fadeInDist -= maxRadii;
    }
    float fade = clamp((cameraDist - fadeOutDist) / (fadeInDist - fadeOutDist), 0.0, 1.0);
#else
    float fade = 0.0;
#endif

// Paired with the water-mask call site and `computeEnhancedOcean` in
// Shaders/WebGPU/Globe/GlobeTerrain.wgsl; a change to either half has to land
// with a matching change to the other.
//
// Both backends blend additively:
//   `color = imageryColor + diffuseHighlight + nonDiffuseHighlight + specular`
// Imagery stays the base color and the ocean highlights are added to it. A
// replacement blend such as `mix(imagery, deepColor × darkening, 0.6)` dims
// aerial imagery over ocean by roughly 5× at orbit altitude.
//
// Divergences in shape rather than in result:
// - This file gates the whole block with `#if defined(HAS_WATER_MASK)
//   && (defined(SHOW_REFLECTIVE_OCEAN) || defined(APPLY_MATERIAL))`; WGSL
//   gates at runtime on `tile.flags.x > 0.5`.
// - Both apply `waterMaskTextureCoordinates.y = 1.0 - .y` after the
//   translation and scale. WebGPU keeps this source-row convention so its
//   globe path can borrow the GPUTexture that Texture already realized rather
//   than allocate and upload a second, vertically reversed copy.
// - `computeWaterColor` below is hand-written GLSL, not material codegen, and
//   its counterpart `computeEnhancedOcean` is likewise hand-written in the
//   WGSL source. Adding a water feature means editing both.
//
// WGSL carries enhancements this file does not: three-octave wave-normal
// sampling against the two-octave high/low altitude blend through
// `czm_getWaterNoise`, `computeFoam` whitecaps on steep waves, and an as yet
// unused `computeSubsurfaceScattering` helper.
//
// The specular term matches. WGSL uses this file's `czm_getSpecular` Phong
// lobe (shininess 10) × the waveIntensity-modulated surfaceReflectance,
// unconditionally — no enableLighting gate and no orbit-altitude fade. A GGX
// lobe with an orbit fade suppresses the zoomed-out ocean sun glint this file
// renders at orbit.
#if defined(HAS_WATER_MASK) && (defined(SHOW_REFLECTIVE_OCEAN) || defined(APPLY_MATERIAL))
    vec2 waterMaskTranslation = u_waterMaskTranslationAndScale.xy;
    vec2 waterMaskScale = u_waterMaskTranslationAndScale.zw;
    vec2 waterMaskTextureCoordinates = v_textureCoordinates.xy * waterMaskScale + waterMaskTranslation;
    waterMaskTextureCoordinates.y = 1.0 - waterMaskTextureCoordinates.y;

    float mask = texture(u_waterMask, waterMaskTextureCoordinates).r;

    #ifdef SHOW_REFLECTIVE_OCEAN
    // Screen-space anti-aliased coast coverage. The water mask is a
    // low-resolution bitmap and a single bilinear sample resolves the
    // coastline at texel granularity, so at low zoom — a mask texel spanning
    // about one screen pixel — the water/land boundary aliases into a jagged
    // staircase. fwidth(mask) measures how fast the mask crosses in screen
    // space, so widening the smoothstep band by that amount feathers the
    // boundary over roughly one screen pixel, while the 0.2 floor keeps the
    // high-zoom bilinear ramp soft. The 0.5 isoline never moves, so the coast
    // stays spatially accurate. The band is capped at 0.5 so that land
    // (mask ~ 0 -> coverage 0) and open-ocean (mask ~ 1 -> coverage 1)
    // interiors come out exactly as a hard `mask > 0.0` gate leaves them: a
    // wider band clips smoothstep(0.5 - band, 0.5 + band, 1.0) below 1 and
    // dims open ocean. Twinned by the water-mask block in GlobeTerrain.wgsl's
    // fragmentMain.
    float coastBand = clamp(fwidth(mask) * 1.5, 0.2, 0.5);
    float coastCoverage = smoothstep(0.5 - coastBand, 0.5 + coastBand, mask);
    // Evaluated in uniform control flow, outside the `coastCoverage > 0.0`
    // branch, because the wave footprint LOD needs `dFdx`/`dFdy` of these
    // coordinates and GLSL ES 3.00 §8.13 leaves derivatives undefined in
    // non-uniform control flow: on a coast quad where 1-3 of the 4 lanes fail
    // the coverage test the helper lanes never evaluated `textureCoordinates`,
    // and the derivative reads garbage. The consequence is not a cosmetic
    // mip-level error — a `uvFootprint` above
    // `OCEAN_OCTAVE_FADE_HI / highEffRate` (~7.5e-3) trips the hard
    // `OCEAN_WAVE_MARCH_CUTOFF` branch, collapsing the wave normal to flat and
    // skipping the `waveIntensity` scale, which puts a 1-2 px specular
    // discontinuity along exactly the coastline the feather above exists to
    // smooth. The WGSL twin hoists `geoUV`, `geoUV_dx` and `geoUV_dy` to
    // fragment entry for the same reason and threads them into
    // `computeEnhancedOcean`. Same inputs and same expression, so every lane
    // that takes the branch sees unchanged values.
    vec2 ellipsoidTextureCoordinates = czm_ellipsoidTextureCoordinates(normalMC);
    vec2 ellipsoidFlippedTextureCoordinates = czm_ellipsoidTextureCoordinates(normalMC.zyx);

    vec2 textureCoordinates = mix(ellipsoidTextureCoordinates, ellipsoidFlippedTextureCoordinates, czm_morphTime * smoothstep(0.9, 0.95, normalMC.z));

    vec2 tcDx = dFdx(textureCoordinates);
    vec2 tcDy = dFdy(textureCoordinates);

    if (coastCoverage > 0.0)
    {
        mat3 enuToEye = czm_eastNorthUpToEyeCoordinates(v_positionMC, normalEC);

        vec4 oceanColor = computeWaterColor(v_positionEC, textureCoordinates, tcDx, tcDy, enuToEye, color, mask, fade);
        // Feather the ocean effect in over the anti-aliased coast band.
        color = mix(color, oceanColor, coastCoverage);
    }
    #endif
#endif

#ifdef APPLY_MATERIAL
    czm_materialInput materialInput;
    materialInput.st = v_textureCoordinates.st;
    materialInput.normalEC = normalize(v_normalEC);
    materialInput.positionToEyeEC = -v_positionEC;
    materialInput.tangentToEyeMatrix = czm_eastNorthUpToEyeCoordinates(v_positionMC, normalize(v_normalEC));
    materialInput.slope = v_slope;
    materialInput.height = v_height;
    materialInput.aspect = v_aspect;
    #ifdef HAS_WATER_MASK
        materialInput.waterMask = mask;
    #endif

    czm_material material = czm_getMaterial(materialInput);
    vec4 materialColor = vec4(material.diffuse, material.alpha);
    color = alphaBlend(materialColor, color);
#endif

// Paired with the lighting block and the `globeComputeShadowFactor*` paths in
// Shaders/WebGPU/Globe/GlobeTerrain.wgsl; a change to either half has to land
// with a matching change to the other. This file is the reference, and the
// WGSL runs the two expressions below verbatim.
//
// Those two expressions are distinct on purpose and must stay distinct:
//
//   consumer                         expression
//   imagery day/night alpha +        `1.0 - clamp(NdotL × 5, 0, 1)`
//     night-lights emission gate       (`nightBlend`, above)
//   ENABLE_DAYNIGHT_SHADING diffuse  `clamp(NdotL × 5 + 0.3, 0, 1)`,
//                                      then `mix(1.0, that, fade)` (below)
//
// The `+ 0.3` is the lighting expression's night floor and nothing else.
// Folding it, or any other offset, into the alpha ramp moves the terminator:
// a `+ 0.5` fold measures +0.485 night alpha at the geometric terminator.
//
// This file offers the three `#ifdef` variants below — ENABLE_VERTEX_LIGHTING,
// driven by the tile provider through `u_lambertDiffuseMultiplier` and
// `u_vertexShadowDarkness` × `czm_lightColor`; ENABLE_DAYNIGHT_SHADING,
// `NdotL × 5 + 0.3` × `czm_lightColor` mixed with full brightness by `fade`;
// or pass-through. WGSL reaches the same three outcomes through one runtime
// gate (`camera.enableLighting > 0.5`) selecting the arms via
// `camera.lighting.z` (hasVertexNormals). Its day/night arm is
// `mix(1.0, computeDayNightDiffuse(dayNightNormalEC, sunDir),
// tile.lightingFade)` — the same expression and the same camera-distance mix,
// with `fade` packed CPU-side because the WGSL has no `czm_view` or
// `czm_frustumPlanes` from which to form `cameraDist`. It multiplies by
// `camera.lightColor.rgb`, packed from `uniformState.lightColor`, where this
// file multiplies by `czm_lightColor`, and it reads the vertex-lighting
// uniforms as `camera.lighting.x` / `.y`.
//
// The day/night imagery alpha is deliberately NOT one of the three variants
// above. It is gated on APPLY_DAY_NIGHT_ALPHA alone, reads the analytic
// geocentric normal in every arm, and therefore exists on vertex-normal terrain
// and on the unlit default globe alike. WGSL matches that with a runtime
// disjunction, `camera.enableLighting > 0.5 || tile.tileControls.w > 0.5 ||
// tile.hsbShift.w < 1.0`, whose second term is packed from the same per-tile
// condition that raises this file's define and whose third is the procedural
// night fallback below, which needs the same ramp wherever the layers leave the
// night side uncovered. Conjoining the alpha with a lighting define is what
// previously made a dayAlpha = 0 night layer invisible everywhere WebGL took
// the vertex-lighting arm.
// The optional terminator appearance term below is now an exact GLSL/WGSL
// twin, dynamically controlled by Globe.terminatorGlowStrength.
//
// Shadow receive is not present in this file: the WebGL pipeline cache
// injects shadow-sampling GLSL through `ShadowMapShader.js` per pipeline,
// from the shadow-map configuration. WGSL has no such cache, so it inlines
// its three shadow paths (`globeComputeShadowFactor`, `*PointLight`, `*CSM`)
// in the source and gates them at runtime in fragmentMain.

// Procedural night darkening, for the share of the night side that no imagery
// layer covers. `u_nightDarkness` is the floor the fallback aims at; the share
// the layers actually cover is `g_nightImageryCoverage`, resolved per fragment
// while the layers were composited, so full coverage leaves this term at the
// multiplicative identity, a layer faded out by magnification gives back the
// full darkness, and the two hand over continuously in between — including
// across a terrain LOD seam, which a coverage folded from one tile's texel
// count could not. It scales the composited surface, so it goes ahead of the
// lighting arms rather than after them: every arm below is a multiply, and the
// terminator glow that follows is an ADD, which is scattered light and must not
// be dimmed by ground albedo. Placed here the term is the same product on both
// backends, and the WGSL twin sits immediately ahead of its own lighting branch
// for the same reason.
//
// Deliberately not mixed by the camera-distance fade. The
// ENABLE_DAYNIGHT_SHADING diffuse below is flat-lit near the ground by design,
// matching upstream; this term is what makes the night side dark at street
// altitude, and a camera-distance fade would defeat its whole purpose.
#ifdef APPLY_NIGHT_DARKNESS
    // Written as a mix rather than as `1 + (floor - 1) * (1 - coverage)`
    // because only this form is EXACT at both ends in f32. That one reaches the
    // floor through a subtract and a multiply, and at the shipped 0.15 the round
    // trip lands two units in the last place low - on every fragment no night
    // layer covers, which is every street-altitude frame and every globe that
    // switched the night imagery off. This returns the floor's own bits at zero
    // coverage and exactly 1.0 at full coverage, so the uncovered path is the
    // identity of what the packer sent and the covered path is the identity of
    // the colour underneath it.
    float effectiveNightDarkness = mix(u_nightDarkness, 1.0, clamp(g_nightImageryCoverage, 0.0, 1.0));
    color.rgb *= mix(1.0, effectiveNightDarkness, nightBlend);
#endif

#ifdef ENABLE_VERTEX_LIGHTING
    float diffuseIntensity = clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalize(v_normalEC)) * u_lambertDiffuseMultiplier + u_vertexShadowDarkness, 0.0, 1.0);
    vec4 finalColor = vec4(color.rgb * czm_lightColor * diffuseIntensity, color.a);
#elif defined(ENABLE_DAYNIGHT_SHADING)
    float diffuseIntensity = clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * 5.0 + 0.3, 0.0, 1.0);
    diffuseIntensity = mix(1.0, diffuseIntensity, fade);
    vec4 finalColor = vec4(color.rgb * czm_lightColor * diffuseIntensity, color.a);
#else
    vec4 finalColor = color;
#endif

#if defined(ENABLE_VERTEX_LIGHTING) || defined(ENABLE_DAYNIGHT_SHADING)
    float terminatorGlowEclipse = 1.0;
#endif

#ifdef ENABLE_ECLIPSE_GLOBE_SHADOW
    // Some globe terms arrive already dimmed by a camera-anchored eclipse
    // factor. Replacing that factor with the fragment's own, rather than
    // multiplying the two, is what avoids double-counting:
    //   absolute = G(O_fragment)
    //   relative = G(O_fragment) / G(O_camera)
    float eclipseAbsolute = 1.0;
    float eclipseRelative = 1.0;
    if (u_eclipseParams.x > 0.5)
    {
        // Gates 3 and 4 are correction-only: the selected terrain bound proves
        // no globe fragment can be shadowed, so the producers the
        // camera-anchored factor dimmed are restored without evaluating the
        // local eclipse geometry.
        if (u_eclipseParams.x < 2.5)
        {
            eclipseAbsolute = eclipseFragmentFactor(v_positionMC);
        }
        eclipseRelative = eclipseAbsolute * u_eclipseParams.y;
    }
#if defined(ENABLE_VERTEX_LIGHTING) || defined(ENABLE_DAYNIGHT_SHADING)
    // Gates 2 and 3 mean a SunLight already carried the camera-anchored factor
    // through czm_lightColor. Gates 1 and 4 use a custom DirectionalLight and
    // keep the absolute surface.
    finalColor.rgb *=
        u_eclipseParams.x > 1.5 && u_eclipseParams.x < 3.5
            ? eclipseRelative
            : eclipseAbsolute;
#else
    finalColor.rgb *= eclipseAbsolute;
#endif
#if defined(ENABLE_VERTEX_LIGHTING) || defined(ENABLE_DAYNIGHT_SHADING)
    // This additive term contains no camera-anchored S2 light quantity, so it
    // receives the local absolute eclipse factor exactly once.
    terminatorGlowEclipse = eclipseAbsolute;
#endif
#endif

#if defined(ENABLE_VERTEX_LIGHTING) || defined(ENABLE_DAYNIGHT_SHADING)
    float terminatorGlowStrength = max(u_terminatorGlowStrength, 0.0);
    if (terminatorGlowStrength > 0.0)
    {
        // The terminator is geocentric, not terrain-slope dependent. Rebuild
        // the analytic normal inside the opt-in branch so the default path
        // does not pay for it in the ENABLE_VERTEX_LIGHTING variant.
        vec3 terminatorNormalMC = czm_geodeticSurfaceNormal(
            v_positionMC,
            vec3(0.0),
            vec3(1.0)
        );
        vec3 terminatorNormalEC = czm_normal3D * terminatorNormalMC;
        finalColor.rgb +=
            computeTerminatorGlow(terminatorNormalEC, czm_lightDirectionEC) *
            terminatorGlowStrength *
            terminatorGlowEclipse;
    }
#endif

#ifdef ENABLE_CLIPPING_PLANES
    vec4 clippingPlanesEdgeColor = vec4(1.0);
    clippingPlanesEdgeColor.rgb = u_clippingPlanesEdgeStyle.rgb;
    float clippingPlanesEdgeWidth = u_clippingPlanesEdgeStyle.a;

    if (clipDistance < clippingPlanesEdgeWidth)
    {
        finalColor = clippingPlanesEdgeColor;
    }
#endif

#ifdef ENABLE_CLIPPING_POLYGONS
    vec2 clippingPosition = v_clippingPosition;
    int regionIndex = v_regionIndex;
    clipPolygons(u_clippingDistance, CLIPPING_POLYGON_REGIONS_LENGTH, clippingPosition, regionIndex);
#endif

#ifdef HIGHLIGHT_FILL_TILE
    finalColor = vec4(mix(finalColor.rgb, u_fillHighlightColor.rgb, u_fillHighlightColor.a), finalColor.a);
#endif

#if defined(DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN)
    vec3 atmosphereLightDirection = czm_sunDirectionWC;
#else
    vec3 atmosphereLightDirection = czm_lightDirectionWC;
#endif

// Paired with the ground-atmosphere and fog block in
// Shaders/WebGPU/Globe/GlobeTerrain.wgsl; a change to either half has to land
// with a matching change to the other. Where the two differ:
//
// - This file gates with `#if defined(GROUND_ATMOSPHERE) || defined(FOG)` and
//   an inner `#ifdef PER_FRAGMENT_GROUND_ATMOSPHERE`; WGSL gates at runtime on
//   UBO scalars (`tile.fogDensity > 0`,
//   `tile.groundAtmosphereControl.x > 0.5`, `camera.atmosphereParams.w > 1.5`).
//   Same semantics, different mechanism.
//
// - WGSL always ray-marches per fragment; this file switches between
//   per-vertex varyings and per-fragment on the
//   `PER_FRAGMENT_GROUND_ATMOSPHERE` define, set CPU-side when
//   `cameraDist > nightFadeOutDistance` ≈ 10 Mm. Per-fragment everywhere
//   avoids a mesh-pattern artifact at orbit altitude; this file can keep the
//   per-vertex fast path because the GLSL pipeline cache emits the right
//   variant per tile.
//
// - WGSL has an optional LUT-sampled atmosphere path that WebGL2 cannot have,
//   having no compute stage. It falls back to the inline analytic form when
//   the LUT is unavailable, which produces output identical to this file.
//
// - HDR gating is `#ifndef HDR` here and
//   `tile.groundAtmosphereControl.w > 0.5` in WGSL. Same toggle.
//
// - Both use `fExposure = 2.0` in the `1 - exp(-exposure × finalAtmoColor)`
//   tonemap.
#if defined(GROUND_ATMOSPHERE) || defined(FOG)
    if (!czm_backFacing())
    {
        bool dynamicLighting = false;
        #if defined(DYNAMIC_ATMOSPHERE_LIGHTING) && (defined(ENABLE_DAYNIGHT_SHADING) || defined(ENABLE_VERTEX_LIGHTING))
            dynamicLighting = true;
        #endif

        vec3 rayleighColor;
        vec3 mieColor;
        float opacity;

        vec3 positionWC;
        vec3 lightDirection;

        // When the camera is far away (camera distance > nightFadeOutDistance), the scattering is computed in the fragment shader.
        // Otherwise, the scattering is computed in the vertex shader.
        #ifdef PER_FRAGMENT_GROUND_ATMOSPHERE
            positionWC = computeEllipsoidPosition();
            lightDirection = czm_branchFreeTernary(dynamicLighting, atmosphereLightDirection, normalize(positionWC));
            computeAtmosphereScattering(
                positionWC,
                lightDirection,
                rayleighColor,
                mieColor,
                opacity
            );
        #else
            positionWC = v_positionMC;
            lightDirection = czm_branchFreeTernary(dynamicLighting, atmosphereLightDirection, normalize(positionWC));
            rayleighColor = v_atmosphereRayleighColor;
            mieColor = v_atmosphereMieColor;
            opacity = v_atmosphereOpacity;
        #endif

        #ifdef COLOR_CORRECT
            const bool ignoreBlackPixels = true;
            rayleighColor = czm_applyHSBShift(rayleighColor, u_hsbShift, ignoreBlackPixels);
            mieColor = czm_applyHSBShift(mieColor, u_hsbShift, ignoreBlackPixels);
        #endif

        vec4 groundAtmosphereColor = computeAtmosphereColor(positionWC, lightDirection, rayleighColor, mieColor, opacity);
        // Ground-atmosphere radiance and fog already carry the camera-anchored
        // factor through u_atmosphereLightIntensity, so replace it with the
        // per-fragment factor. Alpha is geometric opacity and stays intact.
#ifdef ENABLE_ECLIPSE_GLOBE_SHADOW
        groundAtmosphereColor.rgb *= eclipseRelative;
#endif

        // Fog is applied to tiles selected for fog, close to the Earth.
        #ifdef FOG
            vec3 fogColor = groundAtmosphereColor.rgb;

            // If there is lighting, apply that to the fog.
            #if defined(DYNAMIC_ATMOSPHERE_LIGHTING) && (defined(ENABLE_VERTEX_LIGHTING) || defined(ENABLE_DAYNIGHT_SHADING))
                float darken = clamp(dot(normalize(czm_viewerPositionWC), atmosphereLightDirection), u_minimumBrightness, 1.0);
                fogColor *= darken;
            #endif

            #ifndef HDR
                fogColor.rgb = czm_pbrNeutralTonemapping(fogColor.rgb);
                fogColor.rgb = czm_inverseGamma(fogColor.rgb);
            #endif

            finalColor = vec4(czm_fog(v_distance, finalColor.rgb, fogColor.rgb, czm_fogVisualDensityScalar), finalColor.a);

        #else
            // Apply ground atmosphere. This happens when the camera is far away from the earth.

            // The transmittance is based on optical depth i.e. the length of segment of the ray inside the atmosphere.
            // This value is larger near the "circumference", as it is further away from the camera. We use it to
            // brighten up that area of the ground atmosphere.
            const float transmittanceModifier = 0.5;
            float transmittance = transmittanceModifier + clamp(1.0 - groundAtmosphereColor.a, 0.0, 1.0);

            vec3 finalAtmosphereColor = finalColor.rgb + groundAtmosphereColor.rgb * transmittance;

            #if defined(DYNAMIC_ATMOSPHERE_LIGHTING) && (defined(ENABLE_VERTEX_LIGHTING) || defined(ENABLE_DAYNIGHT_SHADING))
                float fadeInDist = u_nightFadeDistance.x;
                float fadeOutDist = u_nightFadeDistance.y;

                float sunlitAtmosphereIntensity = clamp((cameraDist - fadeOutDist) / (fadeInDist - fadeOutDist), 0.05, 1.0);
                float darken = clamp(dot(normalize(positionWC), atmosphereLightDirection), 0.0, 1.0);
                vec3 darkenendGroundAtmosphereColor = mix(groundAtmosphereColor.rgb, finalAtmosphereColor.rgb, darken);

                finalAtmosphereColor = mix(darkenendGroundAtmosphereColor, finalAtmosphereColor, sunlitAtmosphereIntensity);
            #endif

            #ifndef HDR
                finalAtmosphereColor.rgb = vec3(1.0) - exp(-fExposure * finalAtmosphereColor.rgb);
            #else
                finalAtmosphereColor.rgb = czm_saturation(finalAtmosphereColor.rgb, 1.6);
            #endif

            finalColor.rgb = mix(finalColor.rgb, finalAtmosphereColor.rgb, fade);
        #endif
    }
#endif

#ifdef UNDERGROUND_COLOR
    if (czm_backFacing())
    {
        float distanceFromEllipsoid = max(czm_eyeHeight, 0.0);
        float distance = max(v_distance - distanceFromEllipsoid, 0.0);
        float blendAmount = interpolateByDistance(u_undergroundColorAlphaByDistance, distance);
        vec4 undergroundColor = vec4(u_undergroundColor.rgb, u_undergroundColor.a * blendAmount);
        finalColor = alphaBlend(undergroundColor, finalColor);
    }
#endif

#ifdef HAS_VECTOR_LAYER
    finalColor = vectorPolygonRender(v_textureCoordinates.xy, finalColor);
    finalColor = vectorPolylineRender(v_textureCoordinates.xy, finalColor);
#endif

#ifdef TRANSLUCENT
    if (inTranslucencyRectangle())
    {
        vec4 alphaByDistance = gl_FrontFacing ? u_frontFaceAlphaByDistance : u_backFaceAlphaByDistance;
        finalColor.a *= interpolateByDistance(alphaByDistance, v_distance);
    }
#endif

    out_FragColor =  finalColor;
}


#ifdef SHOW_REFLECTIVE_OCEAN

float waveFade(float edge0, float edge1, float x)
{
    float y = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    return pow(1.0 - y, 5.0);
}

float linearFade(float edge0, float edge1, float x)
{
    return clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
}

// Based on water rendering by Jonas Wagner:
// http://29a.ch/2012/7/19/webgl-terrain-rendering-water-fog

// low altitude wave settings
const float oceanFrequencyLowAltitude = 825000.0;
const float oceanAnimationSpeedLowAltitude = 0.004;
const float oceanOneOverAmplitudeLowAltitude = 1.0 / 2.0;
const float oceanSpecularIntensity = 0.5;

// high altitude wave settings
const float oceanFrequencyHighAltitude = 125000.0;
const float oceanAnimationSpeedHighAltitude = 0.008;
const float oceanOneOverAmplitudeHighAltitude = 1.0 / 2.0;

// Ocean-wave footprint LOD, twinned with the physical-wavelength march in
// GlobeTerrain.wgsl's `sampleOceanWaveNormals`. This path already mip-averages
// — `czm_getWaterNoise` samples through `texture()`, so the LOD is automatic —
// and is anchored to ellipsoid texture coordinates, so the fade below is a
// conservative per-layer weight plus a hard cutoff that engages only at extreme
// footprint (far field and orbit), where it skips the wave fetches and
// collapses the far field without touching near and mid appearance.
//
// The fade band (OCEAN_OCTAVE_FADE_LO / HI, in normal-map repeats spanned per
// screen pixel) and OCEAN_WAVE_MARCH_CUTOFF are shared verbatim with the WGSL
// march. The per-layer scale is backend-native and does not match: WGSL picks
// explicit physical wavelengths (OCEAN_WAVELENGTH_*_M), while this path keeps
// czm_getWaterNoise's scale. czm_getWaterNoise divides the incoming UV by
// 103, 107, (897, 983) and (991, 877) across its four taps (see
// Builtin/Functions/getWaterNoise.glsl), so the map's effective repeat rate is
// oceanFrequency divided by that divisor rather than the raw oceanFrequency;
// keying the fade on the raw frequency overstates the rate by about three
// orders of magnitude and fires the fade far too early. The fade is keyed on
// the coarsest tap divisor — the last structure to go sub-pixel — so a layer
// fades only once even its largest content is sub-pixel. Footprint uses the
// larger screen axis here, since `texture()` is isotropic and the long axis is
// therefore the limiter; the WGSL twin uses the smaller axis because its
// sampler has maxAnisotropy 8.
const float OCEAN_OCTAVE_FADE_LO = 0.5;   // repeats/pixel: full weight at/below
const float OCEAN_OCTAVE_FADE_HI = 1.0;   // repeats/pixel: zero weight at/above
const float OCEAN_WAVE_MARCH_CUTOFF = 0.01; // effective-weight sum below which the march is skipped
// czm_getWaterNoise's coarsest-tap divisor (~991/877 ≈ 940): the effective
// per-layer repeat rate is oceanFrequency / this, keeping the fade conservative.
const float OCEAN_GETWATERNOISE_DIVISOR = 940.0;

float oceanOctaveLodWeight(float repeatsPerPixel)
{
    return 1.0 - smoothstep(OCEAN_OCTAVE_FADE_LO, OCEAN_OCTAVE_FADE_HI, repeatsPerPixel);
}

#ifdef APPLY_CELESTIAL_WATER
// The reduced celestial-reflection twin: the moonglade only.
//
// The WGSL ocean in Shaders/WebGPU/Globe/GlobeTerrain.wgsl reflects both discs
// through this lobe and hands them over across the terminator. This backend
// carries the night half. The daytime glint stays the shininess-10 Phong lobe
// below, which is the classic law both backends have always drawn and which
// this function does not touch, so a scene with the feature on shows the same
// moonglade on both backends and its own familiar daytime sun path on each.
//
// Every constant and every line of arithmetic below is the twin of the WGSL
// block of the same names; celestial-water-globe-port.spec.mjs holds the two
// texts equal after a documented syntax normalisation, so an edit to one that
// is not made to the other fails rather than silently diverging.
//
// Reference: Cook and Torrance 1982 for the microfacet reflectance model,
// Walter et al. 2007 for the GGX distribution and the Smith shadowing term,
// and Karis 2013 for the Schlick approximation of Smith-GGX and the
// spherical-light roughness widening.

// Fresnel reflectance of sea water at normal incidence, refractive index 1.333.
const float CELESTIAL_WATER_F0 = 0.02;
// A light source of finite angular size cannot produce a lobe narrower than
// its own disc. The microfacet that reflects a given direction lies half way
// between the light and the view, so a spread of theta across the light
// direction is a spread of theta/2 across the half vector.
const float CELESTIAL_DISC_WIDEN = 0.5;
// Roughness floor, and the growth of roughness with distance: the wave march
// resolves less of the slope the further the fragment is, and the unresolved
// slope is what a microfacet roughness stands for.
const float CELESTIAL_MIN_ROUGHNESS = 0.02;
const float CELESTIAL_DISTANCE_ROUGHEN = 0.25;
// Warm grey of the reflected lunar disc. Moonlight only looks blue-white
// because the dark-adapted eye loses colour.
const vec3 CELESTIAL_MOON_TINT = vec3(0.95, 0.93, 0.85);
// Sine of the Moon's mean angular radius, 932.58 arcseconds.
const float CELESTIAL_MOON_SIN_ANGULAR_RADIUS = 0.0045213;
// Sine of five degrees: the Moon has to clear this much of the sky before its
// reflection is drawn.
const float CELESTIAL_MOON_RISE_SIN = 0.0871557;
// Sine of three degrees, a little wider than civil twilight, so the night term
// arrives over a few minutes of sweep instead of switching on.
const float CELESTIAL_NIGHT_BAND_SIN = 0.0523360;

// How much of the night has fallen here: 1 well after sunset, 0 well before it.
// Measured against the surface's own geodetic up rather than the wave normal,
// which tilts by tens of degrees and would flicker the terminator with the
// swell.
float celestialNightGate(vec3 up, vec3 sunDir)
{
    float sunAltitude = dot(up, sunDir);
    return 1.0 - smoothstep(-CELESTIAL_NIGHT_BAND_SIN, CELESTIAL_NIGHT_BAND_SIN, sunAltitude);
}

// GGX/Trowbridge-Reitz normal distribution.
float celestialDistributionGGX(float nDotH, float alpha)
{
    float a2 = alpha * alpha;
    float d = nDotH * nDotH * (a2 - 1.0) + 1.0;
    return a2 / max(czm_pi * d * d, 1.0e-8);
}

// Schlick approximation of the Smith-GGX masking term, one direction.
float celestialSmithG1(float nDotX, float alpha)
{
    float k = alpha * 0.5;
    return nDotX / max(nDotX * (1.0 - k) + k, 1.0e-6);
}

// Reflected radiance of a celestial disc of angular radius sinAngularRadius,
// per unit source radiance. Zero wherever the source or the eye is below the
// surface's own horizon, so the caller needs no separate visibility term.
float celestialGlint(vec3 normal, vec3 viewDir, vec3 lightDir, float roughness, float sinAngularRadius)
{
    float nDotL = dot(normal, lightDir);
    float nDotV = dot(normal, viewDir);
    if (nDotL <= 0.0 || nDotV <= 0.0)
    {
        return 0.0;
    }
    vec3 halfVector = normalize(lightDir + viewDir);
    float nDotH = max(dot(normal, halfVector), 0.0);
    float vDotH = max(dot(viewDir, halfVector), 0.0);
    float alpha = roughness * roughness;
    float alphaPrime = clamp(alpha + CELESTIAL_DISC_WIDEN * sinAngularRadius, alpha, 1.0);
    float d = celestialDistributionGGX(nDotH, alphaPrime);
    float f = CELESTIAL_WATER_F0 + (1.0 - CELESTIAL_WATER_F0) * pow(1.0 - vDotH, 5.0);
    float g = celestialSmithG1(nDotV, alphaPrime) * celestialSmithG1(nDotL, alphaPrime);
    // The cosine of the reflectance equation cancels the nDotL of the
    // microfacet denominator, leaving 4 * nDotV.
    return d * f * g / max(4.0 * nDotV, 1.0e-4);
}

// The moonglade for one water fragment.
//
// upEC is the ellipsoid surface normal in eye coordinates, which the caller
// already holds as the up column of its ENU frame: enuToEye * (0, 0, 1). The
// glint itself is evaluated against the wave-perturbed normal.
//
// The illuminated fraction closes the term as the Moon goes new, the rise gate
// closes it while the Moon is on the horizon where its disc is refracted and
// extinguished, and the night gate closes it in daylight. The water mask is
// the same modulation the Phong lobe beside it carries.
vec3 computeCelestialWaterMoonSpecular(vec3 waterNormal, vec3 viewDir, vec3 sunDirEC, vec3 upEC, float waveIntensity, float maskValue)
{
    float roughness = clamp(u_oceanCelestialMoon.x + (1.0 - waveIntensity) * CELESTIAL_DISTANCE_ROUGHEN, CELESTIAL_MIN_ROUGHNESS, 1.0);
    float nightGate = celestialNightGate(upEC, sunDirEC);
    vec3 moonDir = czm_moonDirectionEC;
    float moonRiseGate = smoothstep(0.0, CELESTIAL_MOON_RISE_SIN, dot(upEC, moonDir));
    float moonGlint = celestialGlint(waterNormal, viewDir, moonDir, roughness, CELESTIAL_MOON_SIN_ANGULAR_RADIUS);
    return CELESTIAL_MOON_TINT * moonGlint * u_oceanCelestialMoon.y * u_oceanCelestialMoon.z * moonRiseGate * nightGate * maskValue;
}

#endif
vec4 computeWaterColor(vec3 positionEyeCoordinates, vec2 textureCoordinates, vec2 tcDx, vec2 tcDy, mat3 enuToEye, vec4 imageryColor, float maskValue, float fade)
{
    vec3 positionToEyeEC = -positionEyeCoordinates;
    float positionToEyeECLength = length(positionToEyeEC);

    // The double normalize below works around a bug in Firefox on Android devices.
    vec3 normalizedPositionToEyeEC = normalize(normalize(positionToEyeEC));

    // Fade out the waves as the camera moves far from the surface.
    float waveIntensity = waveFade(70000.0, 1000000.0, positionToEyeECLength);

#ifdef SHOW_OCEAN_WAVES
    // Conservative footprint LOD, calibrated in the block above this function.
    // Per-pixel change of the global ellipsoid wave UV, then a fade weight per
    // altitude layer keyed on that layer's effective repeat rate:
    // oceanFrequency divided by czm_getWaterNoise's coarsest tap divisor.
    // `tcDx` / `tcDy` are passed in rather than taken here because GLSL ES 3.00
    // §8.13 leaves derivatives undefined in non-uniform control flow and this
    // function is only ever called from inside the `coastCoverage > 0.0`
    // branch; the caller takes them in uniform flow, the same shape as the WGSL
    // twin's `uvDx` / `uvDy`. The footprint uses the larger screen axis, since
    // `texture()` is isotropic and the long axis is the resolution limiter; the
    // WGSL twin uses the smaller axis because its sampler has maxAnisotropy 8.
    float uvFootprint = max(length(tcDx), length(tcDy));
    float highEffRate = oceanFrequencyHighAltitude / OCEAN_GETWATERNOISE_DIVISOR;
    float lowEffRate = oceanFrequencyLowAltitude / OCEAN_GETWATERNOISE_DIVISOR;
    float highLodWeight = oceanOctaveLodWeight(highEffRate * uvFootprint);
    float lowLodWeight = oceanOctaveLodWeight(lowEffRate * uvFootprint);

    // blend the 2 wave layers based on distance to surface
    float highAltitudeFade = linearFade(0.0, 60000.0, positionToEyeECLength);
    float lowAltitudeFade = 1.0 - linearFade(20000.0, 60000.0, positionToEyeECLength);

    vec3 normalTangentSpace;
    // (3) Hard far cutoff — once BOTH layers' effective weights are negligible
    // the perturbation is flat; skip both czm_getWaterNoise calls (8 texture
    // taps). effective weight = altitude blend × footprint fade.
    if (highAltitudeFade * highLodWeight + lowAltitudeFade * lowLodWeight < OCEAN_WAVE_MARCH_CUTOFF)
    {
        normalTangentSpace = vec3(0.0, 0.0, 1.0);
    }
    else
    {
        // high altitude waves
        float time = czm_frameNumber * oceanAnimationSpeedHighAltitude;
        vec4 noise = czm_getWaterNoise(u_oceanNormalMap, textureCoordinates * oceanFrequencyHighAltitude, time, 0.0);
        vec3 normalTangentSpaceHighAltitude = vec3(noise.xy, noise.z * oceanOneOverAmplitudeHighAltitude);

        // low altitude waves
        time = czm_frameNumber * oceanAnimationSpeedLowAltitude;
        noise = czm_getWaterNoise(u_oceanNormalMap, textureCoordinates * oceanFrequencyLowAltitude, time, 0.0);
        vec3 normalTangentSpaceLowAltitude = vec3(noise.xy, noise.z * oceanOneOverAmplitudeLowAltitude);

        // (1) Footprint-fade each layer's perturbation (xy) toward flat as its
        // repeat nears the Nyquist limit — mirrors the WGSL per-octave weight
        // fade. `* 1.0` (weight 1) is a no-op, so the near/mid field is
        // byte-identical; z (amplitude) is kept so normalize() stays
        // well-conditioned.
        normalTangentSpaceHighAltitude.xy *= highLodWeight;
        normalTangentSpaceLowAltitude.xy *= lowLodWeight;

        normalTangentSpace =
            (highAltitudeFade * normalTangentSpaceHighAltitude) +
            (lowAltitudeFade * normalTangentSpaceLowAltitude);
        normalTangentSpace = normalize(normalTangentSpace);

        // fade out the normal perturbation as we move farther from the water surface
        normalTangentSpace.xy *= waveIntensity;
        normalTangentSpace = normalize(normalTangentSpace);
    }
#else
    vec3 normalTangentSpace = vec3(0.0, 0.0, 1.0);
#endif

    vec3 normalEC = enuToEye * normalTangentSpace;

    const vec3 waveHighlightColor = vec3(0.3, 0.45, 0.6);

    // Use diffuse light to highlight the waves
    float diffuseIntensity = czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * maskValue;
    vec3 diffuseHighlight = waveHighlightColor * diffuseIntensity * (1.0 - fade);

#ifdef SHOW_OCEAN_WAVES
    // Where diffuse light is low or non-existent, use wave highlights based solely on
    // the wave bumpiness and no particular light direction.
    float tsPerturbationRatio = normalTangentSpace.z;
    vec3 nonDiffuseHighlight = mix(waveHighlightColor * 5.0 * (1.0 - tsPerturbationRatio), vec3(0.0), diffuseIntensity);
#else
    vec3 nonDiffuseHighlight = vec3(0.0);
#endif

    // Add specular highlights in 3D, and in all modes when zoomed in.
    float specularIntensity = czm_getSpecular(czm_lightDirectionEC, normalizedPositionToEyeEC, normalEC, 10.0);
    float surfaceReflectance = mix(0.0, mix(u_zoomedOutOceanSpecularIntensity, oceanSpecularIntensity, waveIntensity), maskValue);
    float specular = specularIntensity * surfaceReflectance;

#ifdef HDR
    specular *= 1.4;

    float e = 0.2;
    float d = 3.3;
    float c = 1.7;

    vec3 color = imageryColor.rgb + (c * (vec3(e) + imageryColor.rgb * d) * (diffuseHighlight + nonDiffuseHighlight + specular));
#else
    vec3 color = imageryColor.rgb + diffuseHighlight + nonDiffuseHighlight + specular;
#endif

#ifdef APPLY_CELESTIAL_WATER
    // Added after the composition rather than inside it, for two reasons. With
    // the feature off, everything above is upstream's source unchanged, so the
    // shader the driver compiles is upstream's shader. With it on, the term
    // escapes the HDR arm's imagery-dependent amplifier — which the WGSL twin
    // does not apply to its own celestial terms either, so the two backends
    // agree on what the moonglade is worth.
    //
    // enuToEye's third column is the ellipsoid surface normal in eye
    // coordinates: the frame's own up, exactly what the WGSL twin receives as
    // normalEC. Passing the local normalEC instead would gate the terminator on
    // the wave facet, which tilts by tens of degrees and would flicker the
    // whole ocean between day and night with the swell.
    color += computeCelestialWaterMoonSpecular(normalEC, normalizedPositionToEyeEC, czm_lightDirectionEC, enuToEye[2], waveIntensity, maskValue);

#endif
    return vec4(color, imageryColor.a);
}

#endif // #ifdef SHOW_REFLECTIVE_OCEAN
