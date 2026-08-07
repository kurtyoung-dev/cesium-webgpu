// StarFieldVS.glsl — WebGL Yale Bright Star Catalog point starfield.
//
// GLSL parity port of Shaders/WebGPU/Catalog/StarField.wgsl (vertexMain).
// Each catalog entry is drawn as a view-facing point sprite (two
// triangles, 6 indices) per instance. The instanced attributes (star
// inertial/J2000 direction, Pogson HDR intensity, blackbody RGB, bright-
// star size boost) are packed by the backend-neutral Scene/StarFieldMath
// (buildStarInstanceData) — the SAME records the WebGPU renderer uploads.
//
// The inertial direction is rotated into the Earth-fixed frame with the
// czm_temeToPseudoFixed automatic uniform (identical to how SkyBox orients
// its star cubemap), so constellations land at the correct RA/Dec for the
// scene clock — matching WebGPU which bakes the same TEME→fixed rotation.
//
// Depth handling: like the SkyBox cubemap, the star geometry is placed at
// the far-frustum distance in EYE space (czm_entireFrustum.y) and projected
// normally, so the clip-space z stays safely inside the frustum (no
// far-plane clipping of the dead-ahead star, which WebGL's [-1,1] NDC z
// range is prone to when pinning clip.z = clip.w). The render state
// disables the depth test (the stars run in the ENVIRONMENT pass BEFORE the
// globe/opaque passes, which then overwrite the stars wherever solid
// geometry is present) — again matching the SkyBox.
//
// Output is HDR and additively blended into the scene framebuffer so the
// existing bloom post-process makes the brightest stars glow.

// Per-vertex: quad corner in [-1, 1] (attribute 0 — must NOT be instanced,
// per VertexArray's "attribute zero cannot have an instanceDivisor" rule).
in vec2 corner;

// Per-instance star record (instanceDivisor = 1).
in vec3 directionFixed;  // unit vector, inertial/TEME frame (pre-rotation)
in float intensity;      // Pogson-scaled HDR brightness
in vec3 starColor;       // blackbody RGB (B−V derived)
in float sizeBoost;      // extra radius for bright stars

// Point-sprite half-size in NDC (x = horizontal, y = vertical;
// aspect-corrected on the CPU from the projection focal terms).
uniform vec2 u_pointSize;
// Global intensity multiplier (folds in the day/twilight fade).
uniform float u_intensityScale;
// Minimum NDC half-extent floor → keeps faint stars from sub-pixel flicker.
uniform float u_minPointSize;
// C7-SUN-STARS-EXTINCTION — zenith atmospheric transmittance (per channel)
// and the camera's local-up direction in the Earth-fixed frame. Each star's
// slant transmittance is zenithTransmittance^airmass(elevation). Default
// (1,1,1) up leaves the field byte-identical (pow(1, x) === 1).
uniform vec3 u_zenithTransmittance;
uniform vec3 u_cameraUpFixed;
// C12-27 — angular solar-glare star washout. Resolved once per frame on the
// CPU by Scene/SolarGlareAppearance.js and published on
// frameState.solarGlareAppearance; the WGSL twin (Shaders/WebGPU/Catalog/
// StarField.wgsl) reads byte-identical values from its uniform buffer.
//   u_solarGlare.xyz  = Sun direction in the TEME instance frame (unit)
//   u_solarGlare.w    = washout strength; EXACTLY 0 disables the whole block
//   u_solarGlareCurve = (angular core rad, pedestal, support rad, reserved)
// The curve numbers arrive as uniforms rather than shader literals so this
// file carries NO numeric copy of them at all — the C12-15/16 convention.
uniform vec4 u_solarGlare;
uniform vec4 u_solarGlareCurve;

out vec2 v_corner;     // [-1, 1] quad-local coordinate
out vec3 v_color;      // HDR color (already intensity-weighted)
// C12-06 — the quad enlargement factor (1 + sizeBoost). The fragment
// profile multiplies the core's radius by this so the core keeps a
// constant on-screen size while the enlarged quad carries the halo.
out float v_coreScale;

// C12-27 — veiling-glare weight as a function of angular separation from the
// Sun. Character-identical to `solarGlareVeil` in
// `Shaders/WebGPU/Catalog/StarField.wgsl`,
// `Shaders/WebGPU/CubeMapPanorama.wgsl` and `Shaders/SkyBoxFS.glsl`, and a
// line-for-line translation of `angularGlareVeil` in
// `Scene/SolarDiscModel.js`; `Tools/visual-regression/solar-glare-star-washout.spec.mjs`
// extracts all four texts, compiles each body as JavaScript, and requires them
// to agree with the JS reference to 1e-15.
//
//   raw(theta)  = 1 / (1 + (theta/core)^2)      -> ~ 1/theta^2 far field
//   veil(theta) = (raw - pedestal) / (1 - pedestal), clamped to [0, 1]
//
// The `1/theta^2` tail is the Stiles-Holladay / CIE disability-glare form. The
// pedestal subtraction makes the veil reach EXACTLY 0 at the support angle
// (90 deg), and the `cosSeparation <= 0.0` early-out is the same half-space,
// so a star at or beyond 90 deg from the Sun is multiplied by exactly 1.0 —
// byte-identical to the no-Sun frame, which is the C12-27 acceptance criterion.
float solarGlareVeil(float cosSeparation, float core, float pedestal, float support)
{
    if (cosSeparation <= 0.0) { return 0.0; }
    float theta = acos(min(cosSeparation, 1.0));
    if (theta >= support) { return 0.0; }
    float t = theta / core;
    float raw = 1.0 / (1.0 + t * t);
    float v = (raw - pedestal) / (1.0 - pedestal);
    return clamp(v, 0.0, 1.0);
}

void main()
{
    // Rotate the inertial star direction into the Earth-fixed frame, then
    // into eye space (rotation only — stars are directional/at infinity).
    vec3 dirFixed = czm_temeToPseudoFixed * directionFixed;
    vec3 dirEye = czm_viewRotation * dirFixed;

    // Place the star at the far-frustum distance along its eye-space
    // direction and project. clip.z < clip.w here, so the dead-ahead star
    // isn't clipped by the far plane (depth test is disabled in the render
    // state, so the exact depth value only needs to be inside the frustum).
    vec4 clip = czm_projection * vec4(dirEye * czm_entireFrustum.y, 1.0);

    // Behind-camera cull: collapse the quad off-screen so the rasterizer
    // discards it. Without this, stars behind the camera wrap around and
    // smear across the frame.
    if (clip.w <= 0.0)
    {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        v_corner = vec2(0.0);
        v_color = vec3(0.0);
        v_coreScale = 1.0;
        return;
    }

    // Per-instance point radius: base size + a brightness-driven boost so
    // first-magnitude stars read as visibly larger discs than fourth-
    // magnitude pinpoints, then a floor so nothing sub-pixels out.
    float halfX = max(u_pointSize.x * (1.0 + sizeBoost), u_minPointSize);
    float halfY = max(u_pointSize.y * (1.0 + sizeBoost), u_minPointSize);

    // Offset the clip-space corner. Multiplying by clip.w keeps the sprite
    // a constant NDC size regardless of depth (the perspective divide
    // restores .x/.y after this).
    clip.x += corner.x * halfX * clip.w;
    clip.y += corner.y * halfY * clip.w;

    gl_Position = clip;
    v_corner = corner;
    v_coreScale = 1.0 + sizeBoost;

    // C7-SUN-STARS-EXTINCTION — per-star atmospheric extinction. Bouguer's law
    // with a plane-parallel airmass X ≈ 1/sin(elevation), capped near the
    // horizon at ~38 (the Kasten-Young limit) to stay finite; slant
    // transmittance = zenithTransmittance^X. u_zenithTransmittance is (1,1,1)
    // from orbit / atmosphere-hidden, so this is a byte-identical no-op there.
    float sinElev = dot(dirFixed, u_cameraUpFixed);
    float airmass = 1.0 / max(sinElev, 0.02631579);
    vec3 extinction = pow(u_zenithTransmittance, vec3(airmass));

    // C12-27 — angular solar-glare washout, per star (a star is a point
    // source, so its separation from the Sun is constant across its whole
    // quad). Dotted against the RAW `directionFixed` attribute, not `dirFixed`:
    // the attribute is the TEME catalogue direction and the published Sun
    // vector is resolved into TEME, so this is the same dot the WGSL twin takes
    // — one published vector serves all four consumers. Appended LAST in the
    // multiply chain so the disabled position (`glare == 1.0`) is exact:
    // `x * 1.0 === x`.
    float glare = 1.0;
    if (u_solarGlare.w > 0.0)
    {
        glare = 1.0 - u_solarGlare.w * solarGlareVeil(
            dot(directionFixed, u_solarGlare.xyz),
            u_solarGlareCurve.x,
            u_solarGlareCurve.y,
            u_solarGlareCurve.z
        );
    }
    v_color = starColor * intensity * u_intensityScale * extinction * glare;
}
