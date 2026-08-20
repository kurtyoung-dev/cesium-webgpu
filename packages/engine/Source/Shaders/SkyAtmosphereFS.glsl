// Paired shader: Shaders/WebGPU/Environment/SkyAtmosphere.wgsl
// A change here must land with the matching change there.
// See SHADER_PAIRS_LOCKSTEP.md.
//
// - C12-31 light-direction selection is MATCHED, not divergent: this file
//   calls `czm_getSkyAtmosphereLightDirection`; the WGSL inlines the same
//   four-arm selection as its `isLegacyOverhead` block.
//
// Structural divergence summary (full ledger in the WGSL counterpart):
// - 16-step adaptive ray-march (`rayStepLengthIncrease` in
//   AtmosphereCommon.glsl) vs WGSL's 64-step uniform-stride ray-march.
//   Same visual result.
// - GLSL has `#ifdef PER_FRAGMENT_ATMOSPHERE` branch that selects
//   between vertex-interpolated colors and per-fragment evaluation.
//   WGSL is always per-fragment.
// - GLSL has NO LUT fast-path; WGSL has a `useLut > 0.5` branch that
//   replaces the ray-march with a single inscatter LUT sample
//   (WebGL2 has no compute shaders, so no LUT bake exists).
// - GLSL has NO dual-light (sun+moon) scattering; WGSL adds moon
//   inscatter contribution scaled by phase × intensity.
// - GLSL has NO debug magenta bypass; WGSL has Tier 1 debug at
//   `u.debug.x > 0.5`.
// - Tonemap chain: GLSL gates `czm_pbrNeutralTonemapping` +
//   `czm_inverseGamma` on `#ifndef HDR` and HSB shift on `#ifdef
//   COLOR_CORRECT`. WGSL always applies the tonemap + sRGB encode and
//   gates HSB shift on |hsbShift| > 0.001 (HDR is handled via the
//   WebGPU post-process pipeline, not the sky shader).
// - GLSL has a `#ifdef GLOBE_TRANSLUCENT` brightening path in
//   SkyAtmosphereCommon; WGSL ports it as a runtime gate
//   (`u.atmosControl.w`, GLOBE-TRANSLUCENCY-ALPHA) inside `skyColorForRay`.
// - C12-29 S6 360-degree horizon twilight is present in BOTH, with the same
//   constants and the same position in the pipeline (linear scatter space,
//   before the tonemap): `u_eclipseHorizonTwilight` here,
//   `u.eclipseControl.x` in the WGSL.

in vec3 v_outerPositionWC;

uniform vec3 u_hsbShift;

// C12-29 S6 — 360-degree horizon twilight. Gain on a warm, horizon-hugging
// band added during totality, as a MULTIPLE OF THE SKY'S OWN LUMINANCE along
// the same ray (so it rides the S2 dimming, the tonemap and the user's
// atmosphereLightIntensity with nothing to calibrate). Exactly 0.0 in every
// frame that is not the last ~2% of a total eclipse's obscuration seen from
// inside the atmosphere, and the term is multiplied by it, so the historical
// sky is untouched. Derivation of the two constants below and of the tint
// lives in `Scene/EclipseState.js`; WGSL twin: `SkyAtmosphere.wgsl`'s
// `eclipseControl.x` block.
uniform float u_eclipseHorizonTwilight;

// atan(25 km / 60 km) — the elevation the sunlit penumbral atmosphere
// subtends from the middle of a ~120 km umbral track. Above it the observer
// is looking at umbral sky, so the band ends there.
const float ECLIPSE_TWILIGHT_ELEVATION = 0.394791119699762;
// Rayleigh transmission exp(-0.5 * (550/lambda)^4) at 650/550/450 nm,
// normalised to a peak of 1 — the same physics that reddens a sunset, over
// the long slant path out to the penumbra.
const vec3 ECLIPSE_TWILIGHT_TINT = vec3(1.0, 0.784, 0.424);

// The eclipse band is defined relative to the observer's local geodetic
// horizon, not the geocentric/radial horizon. `czm_ellipsoidInverseRadii`
// follows the active frame ellipsoid; squaring it gives the gradient weights
// for that ellipsoid's implicit surface. The two fallbacks keep a malformed
// or origin-centred camera from feeding normalize(vec3(0.0)) into asin().
vec3 getEclipseObserverUp(vec3 positionWC)
{
    vec3 radialUp = vec3(0.0, 0.0, 1.0);
    float radialMagnitudeSquared = dot(positionWC, positionWC);
    if (radialMagnitudeSquared > 0.0)
    {
        radialUp = positionWC * inversesqrt(radialMagnitudeSquared);
    }

    vec3 ellipsoidInverseRadiiSquared =
        czm_ellipsoidInverseRadii * czm_ellipsoidInverseRadii;
    vec3 geodeticGradient = positionWC * ellipsoidInverseRadiiSquared;
    float gradientMagnitudeSquared = dot(geodeticGradient, geodeticGradient);
    if (gradientMagnitudeSquared > 0.0)
    {
        return geodeticGradient * inversesqrt(gradientMagnitudeSquared);
    }
    return radialUp;
}

#ifndef PER_FRAGMENT_ATMOSPHERE
in vec3 v_mieColor;
in vec3 v_rayleighColor;
in float v_opacity;
in float v_translucent;
#endif

void main (void)
{
    float lightEnum = u_radiiAndDynamicAtmosphereColor.z;
    // C12-31 — the NATURAL-SKY selector. Its NONE arm is the astronomical sun;
    // only the explicit LEGACY_OVERHEAD mode still substitutes local up. See
    // `Builtin/Functions/getSkyAtmosphereLightDirection.glsl` for the root
    // cause (view-locked Mie forward peak, 4869.9x at the default g = 0.9).
    // WGSL twin: the `isLegacyOverhead` block in SkyAtmosphere.wgsl.
    vec3 lightDirection = czm_getSkyAtmosphereLightDirection(v_outerPositionWC, lightEnum);

    vec3 mieColor;
    vec3 rayleighColor;
    float opacity;
    float translucent;

    #ifdef PER_FRAGMENT_ATMOSPHERE
        computeAtmosphereScattering(
            v_outerPositionWC,
            lightDirection,
            rayleighColor,
            mieColor,
            opacity,
            translucent
        );
    #else
        mieColor = v_mieColor;
        rayleighColor = v_rayleighColor;
        opacity = v_opacity;
        translucent = v_translucent;
    #endif

    vec4 color = computeAtmosphereColor(v_outerPositionWC, lightDirection, rayleighColor, mieColor, opacity);

    // C12-29 S6 — 360-degree horizon twilight, added in LINEAR scatter space
    // (before the tonemap) so it composites exactly like the scattering it
    // augments. Azimuth-independent by construction: nothing in the band
    // profile references the sun direction, which is the whole point — inside
    // the umbra the surrounding penumbra lights the horizon all the way round.
    // `translucent == 0.0` mirrors the WGSL, whose translucent-globe branch
    // returns before this point.
    if (u_eclipseHorizonTwilight > 0.0 && translucent == 0.0)
    {
        vec3 upWC = getEclipseObserverUp(czm_viewerPositionWC);
        vec3 rayDirWC = normalize(v_outerPositionWC - czm_viewerPositionWC);
        float elevation = asin(clamp(dot(rayDirWC, upWC), -1.0, 1.0));
        float band = max(0.0, 1.0 - max(elevation, 0.0) / ECLIPSE_TWILIGHT_ELEVATION);
        band *= band;
        float skyLuminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
        color.rgb += skyLuminance * ECLIPSE_TWILIGHT_TINT * (u_eclipseHorizonTwilight * band);
    }

    #ifndef HDR
        color.rgb = czm_pbrNeutralTonemapping(color.rgb);
        color.rgb = czm_inverseGamma(color.rgb);
    #endif

    #ifdef COLOR_CORRECT
        const bool ignoreBlackPixels = true;
        color.rgb = czm_applyHSBShift(color.rgb, u_hsbShift, ignoreBlackPixels);
    #endif

    // For the parts of the sky atmosphere that are not behind a translucent globe,
    // we mix in the default opacity so that the sky atmosphere still appears at distance.
    // This is needed because the opacity in the sky atmosphere is initially adjusted based
    // on the camera height.
    if (translucent == 0.0) {
        color.a = mix(color.b, 1.0, color.a) * smoothstep(0.0, 1.0, czm_morphTime);
    }

    out_FragColor = color;
}
