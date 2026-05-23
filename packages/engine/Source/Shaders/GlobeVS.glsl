// ┌─────────────────────────────────────────────────────────────────────┐
// │ PAIR-SECTION: Vertex Shader (GLSL) ↔ WGSL                            │
// │   WGSL: Shaders/WebGPU/Globe/GlobeTerrain.wgsl ~lines 1190-1340      │
// │         (6 explicit @vertex entry points) + `processVertex()` helper │
// │         (~line 976) for shared math.                                 │
// │ Last lockstep audit: 2026-05-19, Batch 75                            │
// └─────────────────────────────────────────────────────────────────────┘
// Any change to this VS MUST land with a matching change in the WGSL
// counterpart. See migration_doc/SHADER_PAIRS_LOCKSTEP.md.
//
// ARCHITECTURAL DIVERGENCE (largest in the globe shader pair)
//
// - This file is a SINGLE `void main()` (~286 lines) that handles every
//   terrain encoding via `#ifdef` preprocessor variants:
//     QUANTIZATION_BITS12 (quantized vertex format)
//     INCLUDE_WEB_MERCATOR_Y (per-vertex Mercator-T)
//     ENABLE_VERTEX_LIGHTING / GENERATE_POSITION_AND_NORMAL / APPLY_MATERIAL
//     GEODETIC_SURFACE_NORMALS
//     EXAGGERATION
//     ENABLE_CLIPPING_POLYGONS
//     FOG / GROUND_ATMOSPHERE / UNDERGROUND_COLOR / TRANSLUCENT
//     2D modes (runtime-generated `getPosition` / `get2DYPositionFraction`)
//   The WebGL pipeline cache compiles a fresh shader per define-set.
//
// - The WGSL counterpart has SIX explicit `@vertex` entry points, each
//   handling one specific terrain-encoding combination:
//     vertexMain                        (uncompressed, no Mercator-T)
//     vertexMainWebMerc                 (uncompressed + Mercator-T)
//     vertexMainWebMercNormals          (uncompressed + Mercator-T + normal)
//     vertexMainQuantized               (BITS12, no Mercator-T)
//     vertexMainQuantizedWebMerc        (BITS12 + Mercator-T)
//     vertexMainQuantizedWebMercNormals (BITS12 + Mercator-T + normal)
//   Each decodes its specific vertex layout, then hands off to a shared
//   `processVertex()` helper for layout-agnostic math (position
//   transformation, ellipsoid normal, exaggeration, varying setup).
//
// WHY THE TWO BACKENDS SPLIT DIFFERENTLY
//
// - GLSL's preprocessor is rich enough to encode every variant inline.
//   This file relies on it heavily. Adding a new variant costs a few
//   `#ifdef` lines.
// - WGSL has only a minimal custom preprocessor (`//>>ifdef`, bit-flag
//   driven from `WebGPUShaderDefines.ts`); it can't reproduce all of
//   GLSL's variants. AND WebGPU pipeline creation wants a single shader
//   module with multiple entry points. So the WGSL splits variants
//   across entry points instead of preprocessor branches — closer fit
//   to WGSL's typed `@location` attribute model.
//
// SHARED VARYING CONTRACT
//
// Despite the architectural split, both backends emit the SAME
// downstream varyings consumed by the FS pair-sections:
//   gl_Position / @builtin(position) — clip-space position
//   v_textureCoordinates (vec3: u, v, webMercatorT)
//   v_positionEC, v_positionMC, v_normalEC, v_normalMC
//   v_distance (when FOG/GROUND_ATMOSPHERE/UNDERGROUND_COLOR/TRANSLUCENT)
//   v_atmosphereRayleighColor, v_atmosphereMieColor, v_atmosphereOpacity
//     (when FOG and non-per-fragment ground-atmosphere)
//   v_slope, v_aspect, v_height (when APPLY_MATERIAL)
// The FS pair-sections (Phases 2.1-2.4) consume these same varyings on
// both backends, so per-fragment parity is preserved despite the VS
// split.

#ifdef QUANTIZATION_BITS12
in vec4 compressed0;
in float compressed1;
#else
in vec4 position3DAndHeight;
in vec4 textureCoordAndEncodedNormals;
#endif

#ifdef GEODETIC_SURFACE_NORMALS
in vec3 geodeticSurfaceNormal;
#endif

#ifdef EXAGGERATION
uniform vec2 u_verticalExaggerationAndRelativeHeight;
#endif

uniform vec3 u_center3D;
uniform mat4 u_modifiedModelView;
uniform mat4 u_modifiedModelViewProjection;
uniform vec4 u_tileRectangle;

// Uniforms for 2D Mercator projection
uniform vec2 u_southAndNorthLatitude;
uniform vec2 u_southMercatorYAndOneOverHeight;

out vec3 v_positionMC;
out vec3 v_positionEC;

out vec3 v_textureCoordinates;
out vec3 v_normalMC;
out vec3 v_normalEC;

#ifdef APPLY_MATERIAL
out float v_slope;
out float v_aspect;
out float v_height;
#endif

#if defined(FOG) || defined(GROUND_ATMOSPHERE) || defined(UNDERGROUND_COLOR) || defined(TRANSLUCENT)
out float v_distance;
#endif

#if defined(FOG) || defined(GROUND_ATMOSPHERE)
out vec3 v_atmosphereRayleighColor;
out vec3 v_atmosphereMieColor;
out float v_atmosphereOpacity;
#endif

#ifdef ENABLE_CLIPPING_POLYGONS
uniform highp sampler2D u_clippingExtents;
out vec2 v_clippingPosition;
flat out int v_regionIndex;
#endif

// These functions are generated at runtime.
vec4 getPosition(vec3 position, float height, vec2 textureCoordinates);
float get2DYPositionFraction(vec2 textureCoordinates);

vec4 getPosition3DMode(vec3 position, float height, vec2 textureCoordinates)
{
    return u_modifiedModelViewProjection * vec4(position, 1.0);
}

float get2DMercatorYPositionFraction(vec2 textureCoordinates)
{
    // The width of a tile at level 11, in radians and assuming a single root tile, is
    //   2.0 * czm_pi / pow(2.0, 11.0)
    // We want to just linearly interpolate the 2D position from the texture coordinates
    // when we're at this level or higher.  The constant below is the expression
    // above evaluated and then rounded up at the 4th significant digit.
    const float maxTileWidth = 0.003068;
    float positionFraction = textureCoordinates.y;
    float southLatitude = u_southAndNorthLatitude.x;
    float northLatitude = u_southAndNorthLatitude.y;
    if (northLatitude - southLatitude > maxTileWidth)
    {
        float southMercatorY = u_southMercatorYAndOneOverHeight.x;
        float oneOverMercatorHeight = u_southMercatorYAndOneOverHeight.y;

        float currentLatitude = mix(southLatitude, northLatitude, textureCoordinates.y);
        currentLatitude = clamp(currentLatitude, -czm_webMercatorMaxLatitude, czm_webMercatorMaxLatitude);
        positionFraction = czm_latitudeToWebMercatorFraction(currentLatitude, southMercatorY, oneOverMercatorHeight);
    }
    return positionFraction;
}

float get2DGeographicYPositionFraction(vec2 textureCoordinates)
{
    return textureCoordinates.y;
}

vec4 getPositionPlanarEarth(vec3 position, float height, vec2 textureCoordinates)
{
    float yPositionFraction = get2DYPositionFraction(textureCoordinates);
    vec4 rtcPosition2D = vec4(height, mix(u_tileRectangle.st, u_tileRectangle.pq, vec2(textureCoordinates.x, yPositionFraction)), 1.0);
    return u_modifiedModelViewProjection * rtcPosition2D;
}

vec4 getPosition2DMode(vec3 position, float height, vec2 textureCoordinates)
{
    return getPositionPlanarEarth(position, 0.0, textureCoordinates);
}

vec4 getPositionColumbusViewMode(vec3 position, float height, vec2 textureCoordinates)
{
    return getPositionPlanarEarth(position, height, textureCoordinates);
}

vec4 getPositionMorphingMode(vec3 position, float height, vec2 textureCoordinates)
{
    // We do not do RTC while morphing, so there is potential for jitter.
    // This is unlikely to be noticeable, though.
    vec3 position3DWC = position + u_center3D;
    float yPositionFraction = get2DYPositionFraction(textureCoordinates);
    vec4 position2DWC = vec4(height, mix(u_tileRectangle.st, u_tileRectangle.pq, vec2(textureCoordinates.x, yPositionFraction)), 1.0);
    vec4 morphPosition = czm_columbusViewMorph(position2DWC, vec4(position3DWC, 1.0), czm_morphTime);
    vec4 morphPositionEC = czm_modelView * morphPosition;
    return czm_projection * morphPositionEC;
}

#ifdef QUANTIZATION_BITS12
uniform vec2 u_minMaxHeight;
uniform mat4 u_scaleAndBias;
#endif

void main()
{
#ifdef QUANTIZATION_BITS12
    vec2 xy = czm_decompressTextureCoordinates(compressed0.x);
    vec2 zh = czm_decompressTextureCoordinates(compressed0.y);
    vec3 position = vec3(xy, zh.x);
    float height = zh.y;
    vec2 textureCoordinates = czm_decompressTextureCoordinates(compressed0.z);

    height = height * (u_minMaxHeight.y - u_minMaxHeight.x) + u_minMaxHeight.x;
    position = (u_scaleAndBias * vec4(position, 1.0)).xyz;

#if (defined(ENABLE_VERTEX_LIGHTING) || defined(GENERATE_POSITION_AND_NORMAL)) && defined(INCLUDE_WEB_MERCATOR_Y) || defined(APPLY_MATERIAL)
    float webMercatorT = czm_decompressTextureCoordinates(compressed0.w).x;
    float encodedNormal = compressed1;
#elif defined(INCLUDE_WEB_MERCATOR_Y)
    float webMercatorT = czm_decompressTextureCoordinates(compressed0.w).x;
    float encodedNormal = 0.0;
#elif defined(ENABLE_VERTEX_LIGHTING) || defined(GENERATE_POSITION_AND_NORMAL) || defined(APPLY_MATERIAL)
    float webMercatorT = textureCoordinates.y;
    float encodedNormal = compressed0.w;
#else
    float webMercatorT = textureCoordinates.y;
    float encodedNormal = 0.0;
#endif

#else
    // A single float per element
    vec3 position = position3DAndHeight.xyz;
    float height = position3DAndHeight.w;
    vec2 textureCoordinates = textureCoordAndEncodedNormals.xy;

#if (defined(ENABLE_VERTEX_LIGHTING) || defined(GENERATE_POSITION_AND_NORMAL) || defined(APPLY_MATERIAL)) && defined(INCLUDE_WEB_MERCATOR_Y)
    float webMercatorT = textureCoordAndEncodedNormals.z;
    float encodedNormal = textureCoordAndEncodedNormals.w;
#elif defined(ENABLE_VERTEX_LIGHTING) || defined(GENERATE_POSITION_AND_NORMAL) || defined(APPLY_MATERIAL)
    float webMercatorT = textureCoordinates.y;
    float encodedNormal = textureCoordAndEncodedNormals.z;
#elif defined(INCLUDE_WEB_MERCATOR_Y)
    float webMercatorT = textureCoordAndEncodedNormals.z;
    float encodedNormal = 0.0;
#else
    float webMercatorT = textureCoordinates.y;
    float encodedNormal = 0.0;
#endif

#endif

    vec3 position3DWC = position + u_center3D;

#ifdef GEODETIC_SURFACE_NORMALS
    vec3 ellipsoidNormal = geodeticSurfaceNormal;
#else
    vec3 ellipsoidNormal = normalize(position3DWC);
#endif

#if defined(EXAGGERATION) && defined(GEODETIC_SURFACE_NORMALS)
    float exaggeration = u_verticalExaggerationAndRelativeHeight.x;
    float relativeHeight = u_verticalExaggerationAndRelativeHeight.y;
    float newHeight = (height - relativeHeight) * exaggeration + relativeHeight;

    // stop from going through center of earth
    float minRadius = min(min(czm_ellipsoidRadii.x, czm_ellipsoidRadii.y), czm_ellipsoidRadii.z);
    newHeight = max(newHeight, -minRadius);

    vec3 offset = ellipsoidNormal * (newHeight - height);
    position += offset;
    position3DWC += offset;
    height = newHeight;
#endif

    gl_Position = getPosition(position, height, textureCoordinates);

    v_positionEC = (u_modifiedModelView * vec4(position, 1.0)).xyz;
    v_positionMC = position3DWC;  // position in model coordinates

    v_textureCoordinates = vec3(textureCoordinates, webMercatorT);

#if defined(ENABLE_VERTEX_LIGHTING) || defined(GENERATE_POSITION_AND_NORMAL) || defined(APPLY_MATERIAL)
    vec3 normalMC = czm_octDecode(encodedNormal);

#if defined(EXAGGERATION) && defined(GEODETIC_SURFACE_NORMALS)
    vec3 projection = dot(normalMC, ellipsoidNormal) * ellipsoidNormal;
    vec3 rejection = normalMC - projection;
    normalMC = normalize(projection + rejection * exaggeration);
#endif

    v_normalMC = normalMC;
    v_normalEC = czm_normal3D * v_normalMC;
#endif

#ifdef ENABLE_CLIPPING_POLYGONS
    vec2 sphericalLatLong = czm_approximateSphericalCoordinates(position3DWC);
    sphericalLatLong.y = czm_branchFreeTernary(sphericalLatLong.y < czm_pi, sphericalLatLong.y, sphericalLatLong.y - czm_twoPi);
    
    vec2 minDistance = vec2(czm_infinity);
    v_clippingPosition = vec2(czm_infinity);
    v_regionIndex = -1;

    for (int regionIndex = 0; regionIndex < CLIPPING_POLYGON_REGIONS_LENGTH; regionIndex++) {
        vec4 extents = unpackClippingExtents(u_clippingExtents, regionIndex);
        vec2 rectUv = (sphericalLatLong.yx - extents.yx) * extents.wz;

        vec2 clamped = clamp(rectUv, vec2(0.0), vec2(1.0));
        vec2 distance = abs(rectUv - clamped) * extents.wz;

        float threshold = 0.01;
        if (minDistance.x > distance.x || minDistance.y > distance.y) {
            minDistance = distance;
            v_clippingPosition = rectUv;
            if (rectUv.x > threshold && rectUv.y > threshold && rectUv.x < 1.0 - threshold && rectUv.y < 1.0 - threshold) {
                v_regionIndex = regionIndex;
            }
        }
    }
#endif

#if defined(FOG) || (defined(GROUND_ATMOSPHERE) && !defined(PER_FRAGMENT_GROUND_ATMOSPHERE))

    bool dynamicLighting = false;

    #if defined(DYNAMIC_ATMOSPHERE_LIGHTING) && (defined(ENABLE_DAYNIGHT_SHADING) || defined(ENABLE_VERTEX_LIGHTING))
        dynamicLighting = true;
    #endif

#if defined(DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN)
    vec3 atmosphereLightDirection = czm_sunDirectionWC;
#else
    vec3 atmosphereLightDirection = czm_lightDirectionWC;
#endif

    vec3 lightDirection = czm_branchFreeTernary(dynamicLighting, atmosphereLightDirection, normalize(position3DWC));

    computeAtmosphereScattering(
        position3DWC,
        lightDirection,
        v_atmosphereRayleighColor,
        v_atmosphereMieColor,
        v_atmosphereOpacity
    );
#endif

#if defined(FOG) || defined(GROUND_ATMOSPHERE) || defined(UNDERGROUND_COLOR) || defined(TRANSLUCENT)
    v_distance = length((czm_modelView3D * vec4(position3DWC, 1.0)).xyz);
#endif

#ifdef APPLY_MATERIAL
    float northPoleZ = czm_ellipsoidRadii.z;
    vec3 northPolePositionMC = vec3(0.0, 0.0, northPoleZ);
    vec3 vectorEastMC = normalize(cross(northPolePositionMC - v_positionMC, ellipsoidNormal));
    float dotProd = abs(dot(ellipsoidNormal, v_normalMC));
    v_slope = acos(dotProd);
    vec3 normalRejected = ellipsoidNormal * dotProd;
    vec3 normalProjected = v_normalMC - normalRejected;
    vec3 aspectVector = normalize(normalProjected);
    v_aspect = acos(dot(aspectVector, vectorEastMC));
    float determ = dot(cross(vectorEastMC, aspectVector), ellipsoidNormal);
    v_aspect = czm_branchFreeTernary(determ < 0.0, 2.0 * czm_pi - v_aspect, v_aspect);
    v_height = height;
#endif
}
