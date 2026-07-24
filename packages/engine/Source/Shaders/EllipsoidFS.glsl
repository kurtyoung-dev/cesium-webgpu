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

in vec3 v_positionEC;

vec4 computeEllipsoidColor(czm_ray ray, float intersection, float side)
{
    vec3 positionEC = czm_pointAlongRay(ray, intersection);
    vec3 positionMC = (czm_inverseModelView * vec4(positionEC, 1.0)).xyz;
    vec3 geodeticNormal = normalize(czm_geodeticSurfaceNormal(positionMC, vec3(0.0), u_oneOverEllipsoidRadiiSquared));
    vec3 sphericalNormal = normalize(positionMC / u_radii);
    vec3 normalMC = geodeticNormal * side;              // normalized surface normal (always facing the viewer) in model coordinates
    vec3 normalEC = normalize(czm_normal * normalMC);   // normalized surface normal in eye coordinates

    vec2 st = czm_ellipsoidTextureCoordinates(sphericalNormal);
    vec3 positionToEyeEC = -positionEC;

    czm_materialInput materialInput;
    materialInput.s = st.s;
    materialInput.st = st;
    materialInput.str = (positionMC + u_radii) / u_radii;
    materialInput.normalEC = normalEC;
    materialInput.tangentToEyeMatrix = czm_eastNorthUpToEyeCoordinates(positionMC, normalEC);
    materialInput.positionToEyeEC = positionToEyeEC;
    czm_material material = czm_getMaterial(materialInput);

#ifdef LUNAR_BRDF
    // C12-20 — Lommel-Seeliger lunar-regolith reflectance (Moon path).
    // I ∝ μ0 / (μ0 + μ), normalized so the sub-solar point at full phase
    // matches Lambert's peak (2·1/(1+1) = 1). At full moon μ0 ≈ μ across
    // the whole disc so the factor is ~1 everywhere — the real Moon's
    // famously FLAT full disc, where Lambert renders a limb-darkened ball.
    // Diffuse-only by design: lunar regolith has no specular lobe (the
    // Moon material's specular is 0 anyway). Keep the WGSL twin in
    // Moon.wgsl character-consistent with this block.
#ifdef ONLY_SUN_LIGHTING
    vec3 lunarLightDirEC = czm_sunDirectionEC;
#else
    vec3 lunarLightDirEC = czm_lightDirectionEC;
#endif
    float mu0 = max(dot(material.normal, lunarLightDirEC), 0.0);
    float mu = max(dot(material.normal, normalize(positionToEyeEC)), 0.0);
    float lommelSeeliger = 2.0 * mu0 / (mu0 + mu + 1.0e-4);
    vec4 lunarColor = vec4(material.diffuse * lommelSeeliger, material.alpha);
#ifdef OPPOSITION_SURGE
    // C12-23 — Hapke-SHOE opposition surge, computed CPU-side from the
    // true phase angle (constant across the distant disc).
    lunarColor.rgb *= u_oppositionSurge;
#endif
    return lunarColor;
#elif defined(ONLY_SUN_LIGHTING)
    vec4 litColor = czm_private_phong(normalize(positionToEyeEC), material, czm_sunDirectionEC);
#ifdef OPPOSITION_SURGE
    litColor.rgb *= u_oppositionSurge;
#endif
    return litColor;
#else
    vec4 litColor = czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC);
#ifdef OPPOSITION_SURGE
    litColor.rgb *= u_oppositionSurge;
#endif
    return litColor;
#endif
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

    if (t1 < 0.0 && t2 < 0.0) {
        discard;
    }

    float t = min(t1, t2);
    if (t < 0.0) {
        t = 0.0;
    }

    // March ray forward to intersection with larger sphere and find
    czm_ray ray = czm_ray(t * direction, direction);

    vec3 ellipsoid_inverseRadii = vec3(1.0 / u_radii.x, 1.0 / u_radii.y, 1.0 / u_radii.z);

    czm_raySegment intersection = czm_rayEllipsoidIntersectionInterval(ray, ellipsoidCenter, ellipsoid_inverseRadii);

    if (czm_isEmpty(intersection))
    {
        discard;
    }

    // If the viewer is outside, compute outsideFaceColor, with normals facing outward.
    vec4 outsideFaceColor = (intersection.start != 0.0) ? computeEllipsoidColor(ray, intersection.start, 1.0) : vec4(0.0);

    // If the viewer either is inside or can see inside, compute insideFaceColor, with normals facing inward.
    vec4 insideFaceColor = (outsideFaceColor.a < 1.0) ? computeEllipsoidColor(ray, intersection.stop, -1.0) : vec4(0.0);

    out_FragColor = mix(insideFaceColor, outsideFaceColor, outsideFaceColor.a);
    out_FragColor.a = 1.0 - (1.0 - insideFaceColor.a) * (1.0 - outsideFaceColor.a);

#ifdef ATMOSPHERE_EXTINCTION
    // NS-MOON-ATMOSPHERE-EXTINCTION — attenuate + redden by the atmospheric
    // transmittance along the view ray (exactly vec3(1.0) from orbit → no-op).
    out_FragColor.rgb *= u_atmosphereExtinction;
#endif

#ifdef ATMOSPHERE_INSCATTER
    // C12-30 — add the in-scattered sky radiance (sky-wash) along the view
    // ray: disc = disc × extinction + inscatter, the full radiative-transfer
    // composite. Exactly vec3(0.0) from orbit / wash disabled → no-op. The
    // wash is what makes a daytime disc pale and sky-blended instead of a
    // dark cutout against the bright sky the disc overdraws.
    out_FragColor.rgb += u_atmosphereInscatter;
#endif

#if (defined(WRITE_DEPTH) && (__VERSION__ == 300 || defined(GL_EXT_frag_depth)))
    t = (intersection.start != 0.0) ? intersection.start : intersection.stop;
    vec3 positionEC = czm_pointAlongRay(ray, t);
    vec4 positionCC = czm_projection * vec4(positionEC, 1.0);
#ifdef LOG_DEPTH
    czm_writeLogDepth(1.0 + positionCC.w);
#else
    float z = positionCC.z / positionCC.w;

    float n = czm_depthRange.near;
    float f = czm_depthRange.far;

    gl_FragDepth = (z * (f - n) + f + n) * 0.5;
#endif
#endif
}
