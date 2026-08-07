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

// C12-29 S5 — per-fragment lunar shadow on the globe. The two body vectors
// are a geocentric, range-normalized differential:
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

// ┌─────────────────────────────────────────────────────────────────────┐
// │ PAIR-SECTION: sampleAndBlend (GLSL) ↔ applyImageryLayer (WGSL)       │
// │   WGSL: Shaders/WebGPU/Globe/GlobeTerrain.wgsl::applyImageryLayer    │
// │ Last lockstep audit: 2026-05-18, Batch 68                            │
// └─────────────────────────────────────────────────────────────────────┘
// Any change to this function MUST land with a matching change in the
// WGSL counterpart. See migration_doc/SHADER_PAIRS_LOCKSTEP.md.
//
// STRUCTURAL DIVERGENCE (documented, not fixable in shader)
// - This function samples the imagery texture inline via `texture()`.
//   The WGSL counterpart receives a pre-sampled `texSample` as a
//   parameter because WGSL cannot dynamically index a texture array
//   inside a function — the 16 imagery slots are unrolled at the call
//   site in WGSL's fragmentMain.
// - This function returns `vec4(outColor, outAlpha)`. The WGSL returns
//   a struct `LayerComposite { color, alpha, adjustedColor }` because
//   the WGSL night-lights emission path needs the post-effects color
//   separately. WebGL handles night-lights in a different code path
//   downstream of `computeDayColor`.
// - Per-effect gates (`#ifdef APPLY_*` here, `if (abs(...) > eps)` in
//   WGSL): GLSL relies on the pipeline-cache to emit defines based on
//   which per-layer properties are non-default; WGSL evaluates all
//   effects unconditionally with fast-path skips for default values.
//   Both produce identical output for default values.
//
// KNOWN ALGORITHMIC DIVERGENCE (deferred to follow-up batch)
// The WGSL counterpart uses a simpler straight-mix final blend:
//   outColor = mix(prevColor, adjusted, effectiveAlpha)
//   outAlpha = max(prevAlpha, effectiveAlpha)
// vs this function's premultiplied-alpha OVER composite at lines
// 272-296. For opaque imagery (textureAlpha = 1), both formulas
// produce identical output. For partial alpha (e.g., day/night
// terminator with both dayAlpha and nightAlpha < 1) this function
// preserves source brightness while the WGSL math attenuates it by
// the source alpha. A Batch 68 attempt to align the WGSL math
// regressed midlat-mid from 1.09% to 7.01% diff — root cause not yet
// isolated. Documented here for future bisection-led alignment.
vec4 sampleAndBlend(
    vec4 previousColor,
    sampler2D textureToSample,
    vec2 tileTextureCoordinates,
    vec4 textureCoordinateRectangle,
    vec4 textureCoordinateTranslationAndScale,
    float textureAlpha,
    float textureNightAlpha,
    float textureDayAlpha,
    float textureBrightness,
    float textureContrast,
    float textureHue,
    float textureSaturation,
    float textureOneOverGamma,
    float split,
    vec4 colorToAlpha,
    float nightBlend)
{
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

#if defined(APPLY_DAY_NIGHT_ALPHA) && defined(ENABLE_DAYNIGHT_SHADING)
    textureAlpha *= mix(textureDayAlpha, textureNightAlpha, nightBlend);
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
// ┌─────────────────────────────────────────────────────────────────────┐
// │ PAIR-SECTION: Eclipse globe shadow (GLSL) ↔ WGSL                     │
// │   WGSL: Shaders/WebGPU/Globe/GlobeTerrain.wgsl                       │
// │ Last lockstep audit: 2026-07-26, C12-29 S5                           │
// └─────────────────────────────────────────────────────────────────────┘
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

#if defined(SHOW_REFLECTIVE_OCEAN) || defined(ENABLE_DAYNIGHT_SHADING) || defined(HDR)
    vec3 normalMC = czm_geodeticSurfaceNormal(v_positionMC, vec3(0.0), vec3(1.0));   // normalized surface normal in model coordinates
    vec3 normalEC = czm_normal3D * normalMC;                                         // normalized surface normal in eye coordinates
#endif

#if defined(APPLY_DAY_NIGHT_ALPHA) && defined(ENABLE_DAYNIGHT_SHADING)
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

// ┌─────────────────────────────────────────────────────────────────────┐
// │ PAIR-SECTION: Water mask + Ocean rendering (GLSL) ↔ WGSL             │
// │   WGSL: Shaders/WebGPU/Globe/GlobeTerrain.wgsl ~lines 2806-2880      │
// │         (call site) + `computeEnhancedOcean` at lines 1759-1831      │
// │ Last lockstep audit: 2026-05-20, Batch 78                            │
// └─────────────────────────────────────────────────────────────────────┘
// Any change to this block MUST land with a matching change in the
// WGSL counterpart. See migration_doc/SHADER_PAIRS_LOCKSTEP.md.
//
// ALGORITHM (matched across backends since Batch 58 + Batch 78)
// Both backends use an **additive** blend:
//   `color = imageryColor + diffuseHighlight + nonDiffuseHighlight + specular`
// Imagery is preserved as the base color; ocean highlights are added.
//
// Pre-Batch-58 the WGSL incorrectly used a `mix(imagery, deepColor ×
// darkening, 0.6)` REPLACEMENT blend, which dimmed Bing aerial ocean
// by ~5× at orbit altitudes — the dominant source of the historical
// WebGL/WebGPU brightness gap. Batch 58 rewrote the WGSL to match this
// file's additive intent. Batch 78 then closed remaining gaps:
// `nonDiffuseHighlight` (low-light wave highlight) and the
// waveIntensity-modulated surfaceReflectance pattern are now bridged
// to WGSL too. See WEBGPU_DEBUGGING_LOG.md Batch 58 + Batch 78.
//
// STRUCTURAL DIVERGENCES (separate from the now-matched algorithm)
// - This file gates the whole block with `#if defined(HAS_WATER_MASK)
//   && (defined(SHOW_REFLECTIVE_OCEAN) || defined(APPLY_MATERIAL))`.
//   WGSL gates at runtime via `tile.flags.x > 0.5`.
// - Both files apply `waterMaskTextureCoordinates.y = 1.0 - .y` after
//   translation/scale. WebGPU preserves this source-row convention so its
//   globe path can borrow the GPUTexture already realized by Texture instead
//   of allocating and uploading a second, vertically reversed copy.
// - `computeWaterColor` is hand-written GLSL in this file (NOT
//   runtime-generated by material codegen — earlier audit notes that
//   claimed otherwise were incorrect; the actual source is
//   GlobeFS.glsl L777-849, gated by `#ifdef SHOW_REFLECTIVE_OCEAN`).
//   The WGSL counterpart `computeEnhancedOcean` is hand-inlined in the
//   WGSL source (GlobeTerrain.wgsl L1861-1933). Adding water features
//   requires editing both files (the lockstep discipline).
//
// WGSL-ONLY ENHANCEMENTS (documented, not bugs)
// - 3-octave wave-normal sampling (vs this file's 2-octave high/low
//   altitude blend with `czm_getWaterNoise`).
// - `computeFoam` whitecaps on steep waves (no equivalent here).
// - `computeSubsurfaceScattering` helper present in WGSL but currently
//   unused — scaffolding for future enhancement.
//
// SPECULAR: matched since GLOBE-POLAR-STRETCH-POLISH. The WGSL now uses
// this file's `czm_getSpecular` Phong lobe (shininess 10) × waveIntensity-
// modulated surfaceReflectance, unconditionally (no enableLighting gate,
// no orbit-altitude fade). The earlier WGSL-only GGX + orbit-fade variant
// suppressed the zoomed-out ocean sun glint this file renders at orbit.
#if defined(HAS_WATER_MASK) && (defined(SHOW_REFLECTIVE_OCEAN) || defined(APPLY_MATERIAL))
    vec2 waterMaskTranslation = u_waterMaskTranslationAndScale.xy;
    vec2 waterMaskScale = u_waterMaskTranslationAndScale.zw;
    vec2 waterMaskTextureCoordinates = v_textureCoordinates.xy * waterMaskScale + waterMaskTranslation;
    waterMaskTextureCoordinates.y = 1.0 - waterMaskTextureCoordinates.y;

    float mask = texture(u_waterMask, waterMaskTextureCoordinates).r;

    #ifdef SHOW_REFLECTIVE_OCEAN
    // NS-WATER-MASK-COAST-AA — screen-space anti-aliased coast coverage.
    // The water mask is a low-resolution bitmap; a single bilinear sample
    // resolves the coastline at texel granularity, so at low zoom (a mask
    // texel spanning ~1 screen pixel) the water/land boundary aliases into
    // a jagged staircase. fwidth(mask) measures how fast the mask crosses
    // in SCREEN space; widening the smoothstep band by that amount feathers
    // the boundary over ~1 screen pixel while the 0.2 floor keeps the
    // high-zoom bilinear ramp soft. The 0.5 isoline never moves, so the
    // coast stays spatially accurate and land (mask~0 -> coverage 0) plus
    // open-ocean (mask~1 -> coverage 1) interiors are unchanged vs the
    // previous hard `mask > 0.0` gate. Twin of the WGSL path in
    // GlobeTerrain.wgsl (fragmentMain water-mask block).
    // Cap the band at 0.5 so open ocean (mask=1 -> coverage 1) and land
    // (mask=0 -> coverage 0) interiors stay exactly unchanged; a wider band
    // would clip smoothstep(0.5-band, 0.5+band, 1.0) below 1 and dim the
    // open-ocean effect.
    float coastBand = clamp(fwidth(mask) * 1.5, 0.2, 0.5);
    float coastCoverage = smoothstep(0.5 - coastBand, 0.5 + coastBand, mask);
    // HOISTED TO UNIFORM CONTROL FLOW, deliberately — do not move these back
    // inside the `coastCoverage > 0.0` branch. C11-172's footprint LOD needs
    // `dFdx`/`dFdy` of these coordinates, and GLSL ES 3.00 §8.13 leaves
    // derivatives UNDEFINED in non-uniform control flow: on a coast quad where
    // 1-3 of the 4 lanes fail the coverage test, the helper lanes never
    // evaluated `textureCoordinates`, so an unhoisted derivative reads garbage.
    // That is not a cosmetic mip-level error since Batch 757 — `uvFootprint`
    // above `OCEAN_OCTAVE_FADE_HI / highEffRate` (~7.5e-3) trips the HARD
    // `OCEAN_WAVE_MARCH_CUTOFF` branch, collapsing the wave normal to flat and
    // skipping the `waveIntensity` scale entirely, i.e. a 1-2 px specular
    // discontinuity along exactly the coastline the feather two lines above
    // exists to smooth. The WGSL twin hoists for the same reason (`geoUV`,
    // `geoUV_dx`, `geoUV_dy` at fragment entry, threaded into
    // `computeEnhancedOcean`). The VALUES are unchanged for every lane that
    // takes the branch — same inputs, same expression — so fully-covered
    // quads are byte-identical.
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

// ┌─────────────────────────────────────────────────────────────────────┐
// │ PAIR-SECTION: Lighting + Shadow Receive (GLSL) ↔ WGSL                │
// │   WGSL: Shaders/WebGPU/Globe/GlobeTerrain.wgsl ~lines 2881-2960      │
// │         (lighting); shadow-receive paths in same file at             │
// │         `globeComputeShadowFactor*` (lines 2092-2230)                │
// │ Last lockstep audit: 2026-08-07, Batch 925 (CO-18 ramp-law           │
// │         reconciliation)                                              │
// └─────────────────────────────────────────────────────────────────────┘
// Any change to this block MUST land with a matching change in the
// WGSL counterpart. See migration_doc/SHADER_PAIRS_LOCKSTEP.md.
//
// THIS FILE IS THE REFERENCE. As of CLT-B4 (CO-18) the WGSL runs the two
// expressions below verbatim; the earlier "intentional algorithmic rewrite"
// note here was describing a measured visual divergence, and it is closed.
// The two expressions are DISTINCT ON PURPOSE and must stay distinct:
//
//   consumer                         expression
//   imagery day/night alpha +        `1.0 - clamp(NdotL × 5, 0, 1)`
//     night-lights emission gate       (line ~601, `nightBlend`)
//   ENABLE_DAYNIGHT_SHADING diffuse  `clamp(NdotL × 5 + 0.3, 0, 1)`,
//                                      then `mix(1.0, that, fade)` (below)
//
// The `+ 0.3` is the LIGHTING expression's night floor only. Folding it (or
// any other offset) into the alpha ramp moves the terminator; the WGSL did
// exactly that with a `+ 0.5` until CO-18, measured at +0.485 night-alpha at
// the geometric terminator by `probe-daynight-terminator-law.mjs` run 2.
//
// - This file: three #ifdef variants below — ENABLE_VERTEX_LIGHTING
//   (tile-provider-driven with `u_lambertDiffuseMultiplier` +
//   `u_vertexShadowDarkness` uniforms × `czm_lightColor`),
//   ENABLE_DAYNIGHT_SHADING (`NdotL × 5 + 0.3` × `czm_lightColor`,
//   mixed with full brightness by `fade`), or pass-through.
// - WGSL: one runtime gate (`camera.enableLighting > 0.5`) selecting the
//   same two arms via `camera.lighting.z` (hasVertexNormals). The DAYNIGHT
//   arm is `mix(1.0, computeDayNightDiffuse(dayNightNormalEC, sunDir),
//   tile.lightingFade)` — the same expression and the same camera-distance
//   mix, with `fade` packed CPU-side because the WGSL has no `czm_view` /
//   `czm_frustumPlanes` to form `cameraDist`. Multiplies by
//   `camera.lightColor.rgb` packed from `uniformState.lightColor`
//   (Batch 76). Adds `computeTerminatorGlow` at the day/night boundary
//   — a warm orange/pink band this file doesn't have (CLT-B3).
//
// STRUCTURAL DIVERGENCES
//
// - Variant gating: this file's three #ifdef branches; WGSL's single
//   runtime gate. Shape only — the same three outcomes are reachable.
// - Day/night imagery-alpha applicability: this file emits
//   ENABLE_VERTEX_LIGHTING *instead of* ENABLE_DAYNIGHT_SHADING when the
//   terrain has vertex normals (`GlobeSurfaceShaderSet.js:435-442`), so the
//   day/night alpha does not exist at all there; WGSL still applies the ramp.
//   Open as CLT-B1 finding (c) — it needs a vertex-normal provider to decide
//   at pixels and is NOT closed by CO-18.
// - Custom light color: this file multiplies by `czm_lightColor`;
//   WGSL multiplies by `camera.lightColor.rgb` (Batch 76 — matched).
// - Vertex-lighting uniforms (`u_lambertDiffuseMultiplier`,
//   `u_vertexShadowDarkness`): bridged to WGSL via `camera.lighting.x/y`
//   (Batch 77). The `camera.lighting.z` flag mirrors the WebGL
//   ENABLE_VERTEX_LIGHTING define — set to 1.0 when the terrain
//   provider exposes vertex normals — and gates the WGSL Lambert path
//   between the direct (NdotL × mult + darkness) formula (matching
//   this file's ENABLE_VERTEX_LIGHTING branch) and the existing
//   WGSL aesthetic for DAYNIGHT_SHADING-equivalent scenes.
// - **Shadow receive is NOT present in this file.** The WebGL
//   pipeline cache injects shadow-sampling GLSL via
//   `ShadowMapShader.js` per-pipeline based on the shadow-map config.
//   WGSL inlines three shadow paths directly in the source
//   (`globeComputeShadowFactor` / `*PointLight` / `*CSM`) gated at
//   runtime in fragmentMain. Architecture difference is forced by the
//   pipeline-cache model.
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

#ifdef ENABLE_ECLIPSE_GLOBE_SHADOW
    // S2 applies a camera-anchored factor to some globe terms. S5 replaces it
    // with the fragment's factor without double-counting:
    //   absolute = G(O_fragment)
    //   relative = G(O_fragment) / G(O_camera)
    float eclipseAbsolute = 1.0;
    float eclipseRelative = 1.0;
    if (u_eclipseParams.x > 0.5)
    {
        // Gates 3/4 are correction-only: the selected terrain bound proves no
        // globe fragment can be shadowed. Restore only the producers S2
        // actually dimmed without executing the local eclipse geometry.
        if (u_eclipseParams.x < 2.5)
        {
            eclipseAbsolute = eclipseFragmentFactor(v_positionMC);
        }
        eclipseRelative = eclipseAbsolute * u_eclipseParams.y;
    }
#if defined(ENABLE_VERTEX_LIGHTING) || defined(ENABLE_DAYNIGHT_SHADING)
    // Gates 2/3 mean SunLight already carried S2 through czm_lightColor.
    // Gates 1/4 use a custom DirectionalLight and keep the absolute surface.
    finalColor.rgb *=
        u_eclipseParams.x > 1.5 && u_eclipseParams.x < 3.5
            ? eclipseRelative
            : eclipseAbsolute;
#else
    finalColor.rgb *= eclipseAbsolute;
#endif
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

// ┌─────────────────────────────────────────────────────────────────────┐
// │ PAIR-SECTION: Ground Atmosphere + Fog (GLSL) ↔ WGSL                  │
// │   WGSL: Shaders/WebGPU/Globe/GlobeTerrain.wgsl ~lines 2849-3170      │
// │ Last lockstep audit: 2026-05-19, Batch 72                            │
// └─────────────────────────────────────────────────────────────────────┘
// Any change to this block MUST land with a matching change in the
// WGSL counterpart. See migration_doc/SHADER_PAIRS_LOCKSTEP.md for the
// full structural divergence inventory; the highlights:
//
// - This file gates with `#if defined(GROUND_ATMOSPHERE) || defined(FOG)`
//   and inner `#ifdef PER_FRAGMENT_GROUND_ATMOSPHERE`. WGSL gates at
//   runtime via UBO scalars (`tile.fogDensity > 0`,
//   `tile.groundAtmosphereControl.x > 0.5`, `camera.atmosphereParams.w
//   > 1.5`). Same semantics, different mechanism.
//
// - WGSL ALWAYS does per-fragment ray-march (`computeAtmosphereScattering
//   Ground` in `GlobeTerrain.wgsl`); this file switches between per-
//   vertex varyings and per-fragment based on the
//   `PER_FRAGMENT_GROUND_ATMOSPHERE` define set CPU-side when
//   `cameraDist > nightFadeOutDistance` ≈ 10 Mm. WGSL chose
//   per-fragment-always (Batch 56) to avoid the mesh-pattern artifact at
//   orbit altitudes; this file retains the per-vertex fast-path because
//   the GLSL pipeline cache can emit the right variant per-tile.
//
// - WGSL has an optional LUT-sampled atmosphere path (Phase 4) that this
//   file doesn't and can't (no WebGL2 compute). WGSL falls back to the
//   inline analytic when the LUT isn't available, producing output
//   identical to this file.
//
// - HDR gating: this file uses `#ifndef HDR`; WGSL uses
//   `tile.groundAtmosphereControl.w > 0.5`. Same toggle, different gate.
//
// - Exposure constant matches: both use `fExposure = 2.0` for the
//   `1 - exp(-exposure × finalAtmoColor)` tonemap.
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
        // Ground-atmosphere radiance and fog already carry S2 through
        // u_atmosphereLightIntensity, so replace that camera factor with the
        // per-fragment factor. Alpha is geometric opacity and remains intact.
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

// ─── C11-172 — Ocean-wave footprint LOD (v2, 2026-07-24) ───
// Twin of the physical-wavelength shared march in
// GlobeTerrain.wgsl::sampleOceanWaveNormals. WebGL is NOT broken here: it
// already mip-averages (czm_getWaterNoise uses texture(), auto-LOD) AND is
// physically anchored (ellipsoid textureCoordinates), so the WebGPU LOD-0 /
// tile-UV sparkle the maintainer screenshotted is a WebGPU-ONLY defect. This
// block therefore adds only a CONSERVATIVE per-layer footprint fade + hard
// cutoff — engaging at extreme footprint (far / orbit) — to skip the wave
// fetches and collapse the far field, WITHOUT regressing WebGL's proven near/mid
// appearance.
//
// SHARED vs MAPPED (Principle 5): the fade BAND (OCEAN_OCTAVE_FADE_LO/HI, in
// normal-map repeats spanned per screen pixel) and OCEAN_WAVE_MARCH_CUTOFF are
// shared VERBATIM with the WGSL march (pinned by ocean-wave-lod.spec.mjs). The
// per-layer SCALE is backend-native and does NOT match: WGSL picks explicit
// physical wavelengths (OCEAN_WAVELENGTH_*_M) for the WebGPU look, whereas WebGL
// keeps czm_getWaterNoise's scale. czm_getWaterNoise divides the incoming UV by
// 103/107/(897,983)/(991,877) across its 4 taps (Builtin/Functions/
// getWaterNoise.glsl), so the map's EFFECTIVE repeat rate is oceanFrequency /
// (~divisor), NOT the raw oceanFrequency — v1's bug (D2). We key the fade on the
// COARSEST tap divisor (the last structure to go sub-pixel), so a layer only
// fades once even its largest content is sub-pixel — the safe, WebGL-preserving
// calibration. Footprint uses the MAX screen axis here (WebGL's texture() is
// isotropic — no anisotropy — so the long axis is the limiter; the WGSL twin
// uses MIN because its sampler has maxAnisotropy 8).
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

vec4 computeWaterColor(vec3 positionEyeCoordinates, vec2 textureCoordinates, vec2 tcDx, vec2 tcDy, mat3 enuToEye, vec4 imageryColor, float maskValue, float fade)
{
    vec3 positionToEyeEC = -positionEyeCoordinates;
    float positionToEyeECLength = length(positionToEyeEC);

    // The double normalize below works around a bug in Firefox on Android devices.
    vec3 normalizedPositionToEyeEC = normalize(normalize(positionToEyeEC));

    // Fade out the waves as the camera moves far from the surface.
    float waveIntensity = waveFade(70000.0, 1000000.0, positionToEyeECLength);

#ifdef SHOW_OCEAN_WAVES
    // C11-172 v2 — conservative footprint LOD (see the block above computeWaterColor).
    // Per-pixel change of the (global) ellipsoid wave UV, then a fade weight per
    // altitude layer keyed on its EFFECTIVE repeat rate (oceanFrequency divided by
    // czm_getWaterNoise's coarsest tap divisor — the D2 recalibration; keying on
    // the raw oceanFrequency, as v1 did, over-stated the rate ~3 orders of
    // magnitude and fired the fade far too early). `tcDx`/`tcDy` are PASSED IN:
    // GLSL ES 3.00 §8.13 leaves derivatives undefined in non-uniform control
    // flow, and this function is only ever called from inside the
    // `coastCoverage > 0.0` branch, so the caller takes them in uniform flow
    // and threads them here — the same shape as the WGSL twin's `uvDx`/`uvDy`.
    // MAX-axis footprint: WebGL's texture() is isotropic (no anisotropy), so the
    // long axis is the resolution limiter (the WGSL twin uses MIN because its
    // sampler has maxAnisotropy 8).
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

    return vec4(color, imageryColor.a);
}

#endif // #ifdef SHOW_REFLECTIVE_OCEAN
