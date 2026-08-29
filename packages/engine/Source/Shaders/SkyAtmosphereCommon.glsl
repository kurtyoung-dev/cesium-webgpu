// Paired shader: Shaders/WebGPU/Environment/SkyAtmosphere.wgsl
// A change here must land with the matching change there.
// See SHADER_PAIRS_LOCKSTEP.md.
//
// Structural divergence summary (full ledger in the WGSL counterpart):
// - This file is shared between the sky atmosphere VS and FS (under
//   `#ifndef PER_FRAGMENT_ATMOSPHERE` it runs in VS; otherwise in FS).
//   WGSL has no equivalent — scattering always runs in @fragment.
// - GLSL's `distanceAdjust` math (lines 16-24) computes a runtime
//   `atmosphereInnerRadius` from camera height. WGSL precomputes
//   `innerRadius` on the CPU side and passes it via the uniform; the
//   CPU-side adjust math is in WebGPUSkyAtmosphereRenderer.
// - GLSL has a `#ifdef GLOBE_TRANSLUCENT` brightening path; WGSL ports
//   it as a runtime gate (`u.atmosControl.w`, GLOBE-TRANSLUCENCY-ALPHA)
//   inside `skyColorForRay`.
// - GLSL calls `czm_raySphereIntersectionInterval` (builtin); WGSL
//   inlines `raySphereIntersect`.
// - GLSL calls `computeScattering` from czm_* builtin (16-step adaptive
//   ray-march); WGSL inlines `computeScattering` with 64-step uniform-
//   stride.
// - GLSL ends with altitudeOpacity + nightAlpha-pow-0.5 (matches the
//   WGSL formula at lines ~520-533).

float interpolateByDistance(vec4 nearFarScalar, float distance)
{
    float startDistance = nearFarScalar.x;
    float startValue = nearFarScalar.y;
    float endDistance = nearFarScalar.z;
    float endValue = nearFarScalar.w;
    float t = clamp((distance - startDistance) / (endDistance - startDistance), 0.0, 1.0);
    return mix(startValue, endValue, t);
}

void computeAtmosphereScattering(vec3 positionWC, vec3 lightDirection, out vec3 rayleighColor, out vec3 mieColor, out float opacity, out float underTranslucentGlobe)
{
    float ellipsoidRadiiDifference = czm_ellipsoidRadii.x - czm_ellipsoidRadii.z;

    // Adjustment to the atmosphere radius applied based on the camera height.
    float distanceAdjustMin = czm_ellipsoidRadii.x / 4.0;
    float distanceAdjustMax = czm_ellipsoidRadii.x;
    float distanceAdjustModifier = ellipsoidRadiiDifference / 2.0;
    float distanceAdjust = distanceAdjustModifier * clamp((czm_eyeHeight - distanceAdjustMin) / (distanceAdjustMax - distanceAdjustMin), 0.0, 1.0);

    // Since atmosphere scattering assumes the atmosphere is a spherical shell, we compute an inner radius of the atmosphere best fit
    // for the position on the ellipsoid.
    float radiusAdjust = (ellipsoidRadiiDifference / 4.0) + distanceAdjust;
    float atmosphereInnerRadius = (length(czm_viewerPositionWC) - czm_eyeHeight) - radiusAdjust;

    // Setup the primary ray: from the camera position to the vertex position.
    vec3 cameraToPositionWC = positionWC - czm_viewerPositionWC;
    vec3 cameraToPositionWCDirection = normalize(cameraToPositionWC);
    czm_ray primaryRay = czm_ray(czm_viewerPositionWC, cameraToPositionWCDirection);

    underTranslucentGlobe = 0.0;

    // Brighten the sky atmosphere under the Earth's atmosphere when translucency is enabled.
    #if defined(GLOBE_TRANSLUCENT)

        // Check for intersection with the inner radius of the atmopshere.
        czm_raySegment primaryRayEarthIntersect = czm_raySphereIntersectionInterval(primaryRay, vec3(0.0), atmosphereInnerRadius + radiusAdjust);
        if (primaryRayEarthIntersect.start > 0.0 && primaryRayEarthIntersect.stop > 0.0) {

            // Compute position on globe.
            vec3 direction = normalize(positionWC);
            czm_ray ellipsoidRay = czm_ray(positionWC, -direction);
            czm_raySegment ellipsoidIntersection = czm_rayEllipsoidIntersectionInterval(ellipsoidRay, vec3(0.0), czm_ellipsoidInverseRadii);
            vec3 onEarth = positionWC - (direction * ellipsoidIntersection.start);

            // Control the color using the camera angle.
            float angle = dot(normalize(czm_viewerPositionWC), normalize(onEarth));

            // Control the opacity using the distance from Earth.
            opacity = interpolateByDistance(vec4(0.0, 1.0, czm_ellipsoidRadii.x, 0.0), length(czm_viewerPositionWC - onEarth));
            vec3 horizonColor = vec3(0.1, 0.2, 0.3);
            vec3 nearColor = vec3(0.0);

            rayleighColor = mix(nearColor, horizonColor, exp(-angle) * opacity);

            // Set the traslucent flag to avoid alpha adjustment in computeFinalColor funciton.
            underTranslucentGlobe = 1.0;
            return;
        }
    #endif

    computeScattering(
        primaryRay,
        length(cameraToPositionWC),
        lightDirection,
        atmosphereInnerRadius,
        rayleighColor,
        mieColor,
        opacity
    );

    // Alter the opacity based on how close the viewer is to the ground.
    // (0.0 = At edge of atmosphere, 1.0 = On ground)
    float cameraHeight = czm_eyeHeight + atmosphereInnerRadius;
    float atmosphereOuterRadius = atmosphereInnerRadius + ATMOSPHERE_THICKNESS;
    opacity = clamp((atmosphereOuterRadius - cameraHeight) / (atmosphereOuterRadius - atmosphereInnerRadius), 0.0, 1.0);

    // Alter alpha based on time of day (0.0 = night , 1.0 = day).
    //
    // The ramp reads the SAME `lightDirection` the colour above was computed
    // from, so a shell coloured by the astronomical Sun is also opened and
    // closed by it. There is deliberately no enum test here: the "lit from
    // directly above" compatibility mode passes `normalize(positionWC)` as its
    // light direction, so the dot below is 1.0 and the ramp is inert in that
    // mode, reproducing its historical permanent-day opacity exactly. Before
    // this, the natural-sky mode shared that permanent-day pin while being
    // coloured by the real Sun, so a ground camera's shell stayed opaque all
    // night and alpha-blended the star cubemap and the catalogue sprites —
    // both drawn before the atmosphere — down below one 8-bit code.
    float nightAlpha = clamp(dot(normalize(positionWC), lightDirection), 0.0, 1.0);
    opacity *= pow(nightAlpha, 0.5);
}
