uniform vec3 u_radii;
uniform vec3 u_oneOverEllipsoidRadiiSquared;
#ifdef ATMOSPHERE_EXTINCTION
uniform vec3 u_atmosphereExtinction;
#endif
#ifdef ATMOSPHERE_INSCATTER
uniform vec3 u_atmosphereInscatter;
#endif
#ifdef OPPOSITION_SURGE
uniform float u_oppositionSurge;
#endif
#ifdef LUNAR_NORMAL_MAP
uniform sampler2D u_lunarNormalMap;
uniform float u_lunarNormalStrength;
#endif
#ifdef EARTHSHINE
uniform float u_earthshinePhaseScale;
#endif
#ifdef SOFT_TERMINATOR
uniform float u_terminatorSoftness;

// Cosine-weighted irradiance from a solar disc of angular radius
// `softness`, replacing the hard `max(nDotL, 0)` horizon clip. Character-
// identical twin of softTerminatorMu0 in Moon.wgsl; the JS reference (and the
// derivation) live in Scene/MoonPhaseAppearance.js.
//
//     f(c) = 0                       c <= -w
//     f(c) = (c + w)^2 / (4w)        -w < c < w
//     f(c) = c                       c >= w
//
// C1-continuous at both seams and exactly the legacy value outside the band,
// so `softness == 0.0` is a true identity rather than an approximation of one.
float softTerminatorMu0(float nDotL, float hardMu0, float softness)
{
    if (softness <= 0.0) {
        return hardMu0;
    }
    float clamped = clamp(nDotL, -softness, softness);
    float t = clamped + softness;
    return max(nDotL - softness, 0.0) + t * t / (4.0 * softness);
}
#endif

#ifdef LUNAR_ECLIPSE
uniform vec3 u_lunarShadowAxis;
uniform vec3 u_lunarShadowOffset;
uniform float u_lunarUmbraRadius;
uniform float u_lunarPenumbraRadius;

// Fraction of the solar disc that Earth hides, at `radius` metres from the
// shadow axis in this body's plane. Character-identical twin of
// lunarShadowCoverage in Moon.wgsl; the JS reference and the derivation live
// in Scene/LunarEclipseState.js.
//
// Written in units of the penumbral radius, where the projected solar disc has
// radius (1 - u) / 2 and the projected Earth disc (1 + u) / 2 for an umbral
// radius u. Their sum is 1 and their difference is u, so first contact falls
// exactly on the penumbral radius and totality exactly on the umbral one.
float lunarShadowCoverage(float radius, float umbraRadius, float penumbraRadius)
{
    if (penumbraRadius <= 0.0) {
        return 0.0;
    }
    float inv = 1.0 / penumbraRadius;
    float u = umbraRadius * inv;
    float d = radius * inv;
    float rs = 0.5 * (1.0 - u);
    float re = 0.5 * (1.0 + u);
    if (rs <= 0.0) {
        return 0.0;
    }
    if (d >= 1.0) {
        return 0.0;
    }
    if (d <= u) {
        return 1.0;
    }
    // Reachable only for a negative umbral radius, i.e. a body beyond the tip
    // of the umbral cone. Kept so the function is total.
    if (d <= rs - re) {
        return (re * re) / (rs * rs);
    }
    float dd = max(d, 1.0e-6);
    float cosA = clamp((dd * dd + rs * rs - re * re) / (2.0 * dd * rs), -1.0, 1.0);
    float cosB = clamp((dd * dd + re * re - rs * rs) / (2.0 * dd * re), -1.0, 1.0);
    float a = acos(cosA);
    float b = acos(cosB);
    float area = rs * rs * (a - sin(a) * cosA) + re * re * (b - sin(b) * cosB);
    return clamp(area / (3.141592653589793 * rs * rs), 0.0, 1.0);
}

// Per-channel brightness multiplier for a point `radius` metres from the
// shadow axis. Twin of lunarShadowFactor in Moon.wgsl.
//
// The direct term is the unblocked fraction of the solar disc, achromatic
// because nothing has filtered it. The copper term is sunlight refracted
// through Earth's atmosphere: one Rayleigh optical depth that grows from the
// umbral rim inward, applied per channel through the (550 / lambda)^4 ratios
// at 650 / 550 / 450 nm, and faded in through the penumbra by the coverage
// cube so the two terms hand over continuously at the rim.
vec3 lunarShadowFactor(float radius, float umbraRadius, float penumbraRadius)
{
    float coverage = lunarShadowCoverage(radius, umbraRadius, penumbraRadius);
    float illumination = 1.0 - coverage;
    float depth = clamp(1.0 - radius / max(umbraRadius, 1.0), 0.0, 1.0);
    float tau = 1.2 + (4.0 - 1.2) * depth;
    float weight = 0.25 * coverage * coverage * coverage;
    return vec3(illumination) + weight * exp(-tau * vec3(0.512622, 1.0, 2.23152));
}
#endif

in vec3 v_positionEC;

#ifdef LUNAR_EXPLICIT_GRADIENTS
// Moon mip LOD must not depend on implicit derivatives after a
// fragment-varying discard or on the raw 0/1 longitude discontinuity. These
// values are populated for both front and back hits in main before either
// exact-miss discard, then consumed by the private Moon image material and
// optional normal map. Generic ellipsoids never define this block.
vec2 webGLMoonTextureCoordinates;
vec2 webGLMoonTextureCoordinateDx;
vec2 webGLMoonTextureCoordinateDy;

vec2 computeWebGLMoonTextureCoordinates(czm_ray ray, float intersection)
{
    vec3 positionEC = czm_pointAlongRay(ray, intersection);
    vec3 positionMC = (czm_inverseModelView * vec4(positionEC, 1.0)).xyz;
    return czm_ellipsoidTextureCoordinates(normalize(positionMC / u_radii));
}

vec2 unwrapWebGLMoonLongitudeGradient(vec2 gradient)
{
    // Longitude is periodic; latitude is not. floor(x + 0.5) is the GLSL ES
    // 1.00-compatible equivalent of round(x) for the seam delta range.
    gradient.x -= floor(gradient.x + 0.5);
    return gradient;
}

vec4 sampleWebGLMoonTexture(
    sampler2D textureSampler,
    vec2 textureCoordinates,
    vec2 textureCoordinateScale)
{
    vec2 dx = webGLMoonTextureCoordinateDx * textureCoordinateScale;
    vec2 dy = webGLMoonTextureCoordinateDy * textureCoordinateScale;
#if (__VERSION__ == 300)
    return textureGrad(textureSampler, textureCoordinates, dx, dy);
#elif defined(GL_EXT_shader_texture_lod)
    return texture2DGradEXT(textureSampler, textureCoordinates, dx, dy);
#else
    // The shared CPU capability predicate prevents a Moon gradient define
    // from reaching this fallback. Keep it compile-safe for defensive use.
    return texture(textureSampler, textureCoordinates);
#endif
}
#endif

vec4 computeEllipsoidColor(czm_ray ray, float intersection, float side)
{
    vec3 positionEC = czm_pointAlongRay(ray, intersection);
    vec3 positionMC = (czm_inverseModelView * vec4(positionEC, 1.0)).xyz;
    vec3 geodeticNormal = normalize(czm_geodeticSurfaceNormal(positionMC, vec3(0.0), u_oneOverEllipsoidRadiiSquared));
    vec3 sphericalNormal = normalize(positionMC / u_radii);
    vec3 normalMC = geodeticNormal * side;              // normalized surface normal (always facing the viewer) in model coordinates
    vec3 normalEC = normalize(czm_normal * normalMC);   // normalized surface normal in eye coordinates

#ifdef LUNAR_EXPLICIT_GRADIENTS
    vec2 st = webGLMoonTextureCoordinates;
#else
    vec2 st = czm_ellipsoidTextureCoordinates(sphericalNormal);
#endif
    vec3 positionToEyeEC = -positionEC;

    czm_materialInput materialInput;
    materialInput.s = st.s;
    materialInput.st = st;
    materialInput.str = (positionMC + u_radii) / u_radii;
    materialInput.normalEC = normalEC;
    materialInput.tangentToEyeMatrix = czm_eastNorthUpToEyeCoordinates(positionMC, normalEC);
    materialInput.positionToEyeEC = positionToEyeEC;
    czm_material material = czm_getMaterial(materialInput);

#ifdef LUNAR_NORMAL_MAP
    // LOLA-derived terminator relief (Moon path).
    //
    // The stored map is tangent-space in a geographic east-north-up frame:
    // x = east, y = north, z = up (the geodetic surface normal). That frame
    // is rebuilt here, in model space, rather than read from
    // `materialInput.tangentToEyeMatrix`, so that this block and its WGSL
    // twin in Moon.wgsl are the same expression on the same vectors — the
    // WGSL side has no `czm_normal` to lean on and does all of its lighting
    // in model space. (`czm_eastNorthUpToEyeCoordinates` builds the identical
    // basis: column 0 = normalize(-y, x, 0) = east, column 1 = up × east =
    // north, column 2 = up. The only difference here is the explicit
    // degenerate-axis guard at the poles, where (-y, x, 0) vanishes and the
    // builtin would normalize a zero vector.)
    //
    // Perturbing `material.normal` — not the UV normal — is what makes this
    // modulate the Lommel-Seeliger term below and the Phong fallback alike:
    // both light against `material.normal`, so the relief rides whichever
    // disc law is selected. It shows up near the terminator, where N·L is
    // near zero and a few degrees of tilt flips a facet between lit and
    // unlit, and is nearly invisible at full phase where the cosine is flat.
    //
    // `u_lunarNormalStrength` is exactly 0 when the feature is off or the
    // variant ships no map, which drives nTS to (0, 0, z) and the whole
    // block to the exact identity. Keep the WGSL twin character-consistent.
#ifdef LUNAR_NORMAL_EXPLICIT_GRADIENTS
    vec3 nTS = sampleWebGLMoonTexture(u_lunarNormalMap, st, vec2(1.0)).xyz * 2.0 - 1.0;
#else
    vec3 nTS = texture(u_lunarNormalMap, st).xyz * 2.0 - 1.0;
#endif
    nTS.xy *= u_lunarNormalStrength;
    vec3 upMC = normalMC;
    vec3 eastMC = vec3(-positionMC.y, positionMC.x, 0.0);
    float eastLenMC = length(eastMC);
    eastMC = (eastLenMC > 1.0e-6) ? (eastMC / eastLenMC) : vec3(1.0, 0.0, 0.0);
    vec3 northMC = cross(upMC, eastMC);
    vec3 perturbedMC = normalize(eastMC * nTS.x + northMC * nTS.y + upMC * nTS.z);
    material.normal = normalize(czm_normal * perturbedMC);
#endif

#ifdef LUNAR_BRDF
    // Lommel-Seeliger lunar-regolith reflectance (Moon path).
    // I ∝ μ0 / (μ0 + μ), normalized so the sub-solar point at full phase
    // matches Lambert's peak (2·1/(1+1) = 1). At full moon μ0 ≈ μ across
    // the whole disc so the factor is ~1 everywhere — the real Moon's
    // famously flat full disc, where Lambert renders a limb-darkened ball.
    // Diffuse-only by design: lunar regolith has no specular lobe (the
    // Moon material's specular is 0 anyway). Keep the WGSL twin in
    // Moon.wgsl character-consistent with this block.
#ifdef ONLY_SUN_LIGHTING
    vec3 lunarLightDirEC = czm_sunDirectionEC;
#else
    vec3 lunarLightDirEC = czm_lightDirectionEC;
#endif
    float mu0 = max(dot(material.normal, lunarLightDirEC), 0.0);
#ifdef SOFT_TERMINATOR
    // The Sun is not a point. From the Moon it subtends an angular radius
    // of ~4.649e-3 rad, so within that band around the geometric terminator
    // the solar disc is partially below the local horizon and the
    // irradiance rolls off instead of being clipped. `u_terminatorSoftness`
    // is that radius, resolved CPU-side from the true Sun->Moon distance by
    // Scene/MoonPhaseAppearance.js and shared with the WGSL twin, which
    // applies it at exactly this point in Moon.wgsl's Lommel-Seeliger branch.
    //
    // Deliberately not applied to the czm_private_phong / czm_phong fallbacks
    // below: those are shared builtins used by every lit primitive in the
    // engine and must not grow a moon-specific term. Leaving the fallback
    // hard-clipped on both backends is what keeps the pair in parity.
    mu0 = softTerminatorMu0(dot(material.normal, lunarLightDirEC), mu0, u_terminatorSoftness);
#endif
    float mu = max(dot(material.normal, normalize(positionToEyeEC)), 0.0);
    float lommelSeeliger = 2.0 * mu0 / (mu0 + mu + 1.0e-4);
    vec4 litColor = vec4(material.diffuse * lommelSeeliger, material.alpha);
#elif defined(ONLY_SUN_LIGHTING)
    vec4 litColor = czm_private_phong(normalize(positionToEyeEC), material, czm_sunDirectionEC);
#else
    vec4 litColor = czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC);
#endif

    // Single exit from here down. The three lighting laws above used to
    // return independently, which forced every post-lighting term to be
    // written out once per branch — the opposition surge already carried
    // three identical copies. One tail keeps the WGSL twin's shape (Moon.wgsl
    // also composes into a single `color`) and means a new term is added in
    // one place, not three.

#ifdef OPPOSITION_SURGE
    // Hapke-SHOE opposition surge, computed CPU-side from the true phase
    // angle (constant across the distant disc). Applies to the lunar BRDF
    // and to both phong fallbacks, exactly as before.
    litColor.rgb *= u_oppositionSurge;
#endif

#ifdef EARTHSHINE
    // Earthshine: sunlight reflected off Earth onto the Moon's night side,
    // the "ashen light". Twin of the earthshine block in Moon.wgsl; this is
    // the GLSL counterpart that keeps the two backends in parity.
    //
    // Keyed on raw N.L so the shadowed hemisphere still receives it during
    // crescent phases, and scaled by `u_earthshinePhaseScale` = Earth's
    // illuminated fraction seen from the Moon, the exact complement of the
    // Moon's phase seen from Earth. Earthshine therefore peaks at new moon
    // and is exactly zero at full. The scale is exactly 1.0 when the phase
    // term is disabled, reproducing the historical constant bit-for-bit.
#ifdef ONLY_SUN_LIGHTING
    vec3 earthshineLightDirEC = czm_sunDirectionEC;
#else
    vec3 earthshineLightDirEC = czm_lightDirectionEC;
#endif
    float rawNdotL = max(dot(material.normal, earthshineLightDirEC), 0.0);
    litColor.rgb += vec3(0.4, 0.5, 0.7) * 0.08 * (1.0 - rawNdotL) * u_earthshinePhaseScale;
#endif

#ifdef LUNAR_ECLIPSE
    // Earth's shadow, projected onto this fragment.
    //
    // The shadow is a pair of cones about one axis, so the only thing that
    // varies across the disc is a fragment's perpendicular distance from that
    // axis. Drop the along-axis component of the surface point, add the offset
    // from the axis to the body's centre, and the length of what remains is
    // that distance — the whole projection in three lines, in model space,
    // where the centre is the origin.
    //
    // Applied to the composed colour rather than to the direct term alone.
    // Earthshine is very nearly zero during a lunar eclipse anyway (the Moon
    // is full, so Earth as seen from it is new), but with moon-phase modelling
    // switched off it is a constant, and leaving it unshadowed would lift the
    // umbra with a blue-grey haze instead of the copper that belongs there.
    //
    // Twin of the same block in Moon.wgsl. The state, both twins of the two
    // functions above, and every constant in them live in
    // Scene/LunarEclipseState.js.
    vec3 shadowPositionMC = positionMC - dot(positionMC, u_lunarShadowAxis) * u_lunarShadowAxis;
    float shadowRadius = length(u_lunarShadowOffset + shadowPositionMC);
    litColor.rgb *= lunarShadowFactor(shadowRadius, u_lunarUmbraRadius, u_lunarPenumbraRadius);
#endif

    return litColor;
}

void main()
{
    // PERFORMANCE_TODO: When dynamic branching is available, compute ratio of maximum and minimum radii
    // in the vertex shader. Only when it is larger than some constant, march along the ray.
    // Otherwise perform one intersection test which will be the common case.

    // Test if the ray intersects a sphere with the ellipsoid's maximum radius.
    // For very oblate ellipsoids, using the ellipsoid's radii for an intersection test
    // may cause false negatives. This will discard fragments before marching the ray forward.
    float maxRadius = max(u_radii.x, max(u_radii.y, u_radii.z)) * 1.5;
    vec3 direction = normalize(v_positionEC);
    vec3 ellipsoidCenter = czm_modelView[3].xyz;

    float t1 = -1.0;
    float t2 = -1.0;

    float b = -2.0 * dot(direction, ellipsoidCenter);
    float c = dot(ellipsoidCenter, ellipsoidCenter) - maxRadius * maxRadius;

    float discriminant = b * b - 4.0 * c;
    if (discriminant >= 0.0) {
        t1 = (-b - sqrt(discriminant)) * 0.5;
        t2 = (-b + sqrt(discriminant)) * 0.5;
    }

#ifdef LUNAR_EXPLICIT_GRADIENTS
    bool missesBoundingSphere = t1 < 0.0 && t2 < 0.0;
#else
    if (t1 < 0.0 && t2 < 0.0) {
        discard;
    }
#endif

    float t = min(t1, t2);
    if (t < 0.0) {
        t = 0.0;
    }

    // March ray forward to intersection with larger sphere and find
    czm_ray ray = czm_ray(t * direction, direction);

    vec3 ellipsoid_inverseRadii = vec3(1.0 / u_radii.x, 1.0 / u_radii.y, 1.0 / u_radii.z);

    czm_raySegment intersection = czm_rayEllipsoidIntersectionInterval(ray, ellipsoidCenter, ellipsoid_inverseRadii);

#ifdef LUNAR_EXPLICIT_GRADIENTS
    bool missesEllipsoid = czm_isEmpty(intersection);

    // Miss lanes adjacent to the limb need continuous helper coordinates so
    // their values participate meaningfully in the 2x2 derivative quad. The
    // closest point on the scaled-space ray converges to the tangent hit as
    // the discriminant approaches zero; a fixed sentinel would not.
    vec3 scaledOrigin = ellipsoid_inverseRadii *
        (czm_inverseModelView * vec4(ray.origin, 1.0)).xyz;
    scaledOrigin -= ellipsoid_inverseRadii *
        (czm_inverseModelView * vec4(ellipsoidCenter, 1.0)).xyz;
    vec3 scaledDirection = ellipsoid_inverseRadii *
        (czm_inverseModelView * vec4(ray.direction, 0.0)).xyz;
    float scaledDirectionSquared = dot(scaledDirection, scaledDirection);
    float closestIntersection = max(
        -dot(scaledOrigin, scaledDirection) / max(scaledDirectionSquared, 1.0e-12),
        0.0);
    float outsideTextureIntersection =
        (missesEllipsoid || intersection.start == 0.0)
        ? closestIntersection
        : intersection.start;
    float insideTextureIntersection = missesEllipsoid
        ? closestIntersection
        : intersection.stop;

    vec2 outsideTextureCoordinates = computeWebGLMoonTextureCoordinates(
        ray,
        outsideTextureIntersection);
    vec2 insideTextureCoordinates = computeWebGLMoonTextureCoordinates(
        ray,
        insideTextureIntersection);
    vec2 outsideTextureCoordinateDx = unwrapWebGLMoonLongitudeGradient(
        dFdx(outsideTextureCoordinates));
    vec2 outsideTextureCoordinateDy = unwrapWebGLMoonLongitudeGradient(
        dFdy(outsideTextureCoordinates));
    vec2 insideTextureCoordinateDx = unwrapWebGLMoonLongitudeGradient(
        dFdx(insideTextureCoordinates));
    vec2 insideTextureCoordinateDy = unwrapWebGLMoonLongitudeGradient(
        dFdy(insideTextureCoordinates));

    if (missesBoundingSphere || missesEllipsoid)
    {
        discard;
    }
#else
    if (czm_isEmpty(intersection))
    {
        discard;
    }
#endif

    // If the viewer is outside, compute outsideFaceColor, with normals facing outward.
#ifdef LUNAR_EXPLICIT_GRADIENTS
    webGLMoonTextureCoordinates = outsideTextureCoordinates;
    webGLMoonTextureCoordinateDx = outsideTextureCoordinateDx;
    webGLMoonTextureCoordinateDy = outsideTextureCoordinateDy;
#endif
    vec4 outsideFaceColor = (intersection.start != 0.0) ? computeEllipsoidColor(ray, intersection.start, 1.0) : vec4(0.0);

    // If the viewer either is inside or can see inside, compute insideFaceColor, with normals facing inward.
#ifdef LUNAR_EXPLICIT_GRADIENTS
    webGLMoonTextureCoordinates = insideTextureCoordinates;
    webGLMoonTextureCoordinateDx = insideTextureCoordinateDx;
    webGLMoonTextureCoordinateDy = insideTextureCoordinateDy;
#endif
    vec4 insideFaceColor = (outsideFaceColor.a < 1.0) ? computeEllipsoidColor(ray, intersection.stop, -1.0) : vec4(0.0);

    out_FragColor = mix(insideFaceColor, outsideFaceColor, outsideFaceColor.a);
    out_FragColor.a = 1.0 - (1.0 - insideFaceColor.a) * (1.0 - outsideFaceColor.a);

#ifdef ATMOSPHERE_EXTINCTION
    // Attenuate + redden by the atmospheric transmittance along the view ray
    // (exactly vec3(1.0) from orbit → no-op).
    out_FragColor.rgb *= u_atmosphereExtinction;
#endif

#ifdef ATMOSPHERE_INSCATTER
    // Add the in-scattered sky radiance (sky-wash) along the view ray:
    // disc = disc × extinction + inscatter, the full radiative-transfer
    // composite. Exactly vec3(0.0) from orbit / wash disabled → no-op. The
    // wash is what makes a daytime disc pale and sky-blended instead of a
    // dark cutout against the bright sky the disc overdraws.
    out_FragColor.rgb += u_atmosphereInscatter;
#endif

#if (defined(WRITE_DEPTH) && (__VERSION__ == 300 || defined(GL_EXT_frag_depth)))
    t = (intersection.start != 0.0) ? intersection.start : intersection.stop;
    vec3 positionEC = czm_pointAlongRay(ray, t);
    vec4 positionCC = czm_projection * vec4(positionEC, 1.0);
#ifdef MOON_PHYSICAL_DEPTH
    // The physical command is binned into every intersecting frustum so a
    // camera inside the Moon can reach the slice containing the visible exit
    // surface. Reject non-owning slices with the current projection before
    // computing the canonical depth value; exactly one slice can shade/write.
    if (positionCC.w <= 0.0)
    {
        discard;
    }
    float sliceZ = positionCC.z / positionCC.w;
    float sliceNear = czm_depthRange.near;
    float sliceFar = czm_depthRange.far;
    float sliceDepth =
        (sliceZ * (sliceFar - sliceNear) + sliceFar + sliceNear) * 0.5;
    if (sliceDepth < 0.0 || sliceDepth > 1.0)
    {
        discard;
    }

    // Recreate the exact canonical depth value once. When the ordinary OPAQUE
    // attachment has been cleared after terrain, also compare it with the
    // packed pre-clear globe depth. Earth wins an exact/quantized tie so the
    // two limbs cannot form a one-pixel Moon-over-Earth halo.
    float moonDepth;
#ifdef LOG_DEPTH
    float depthFromNearPlusOne =
        (positionCC.w - czm_currentFrustum.x) + 1.0;
    if (depthFromNearPlusOne <= 0.9999999 ||
        depthFromNearPlusOne > czm_farDepthFromNearPlusOne)
    {
        discard;
    }
    moonDepth = log2(depthFromNearPlusOne) *
        czm_oneOverLog2FarDepthFromNearPlusOne;
#else
    moonDepth = sliceDepth;
#endif
#ifdef MOON_PHYSICAL_GLOBE_DEPTH
    float globeDepth = czm_unpackDepth(texture(
        czm_globeDepthTexture,
        gl_FragCoord.xy / czm_viewport.zw));
    if (globeDepth != 0.0 && moonDepth >= globeDepth)
    {
        discard;
    }
#endif
    gl_FragDepth = moonDepth;
#else
#ifdef LOG_DEPTH
    czm_writeLogDepth(1.0 + positionCC.w);
#else
    float z = positionCC.z / positionCC.w;

    float n = czm_depthRange.near;
    float f = czm_depthRange.far;

    gl_FragDepth = (z * (f - n) + f + n) * 0.5;
#endif
#endif
#endif
}
