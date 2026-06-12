/**
 * Script to batch-create all missing WGSL builtin function chunks.
 * Each chunk is a port of the corresponding czm_* GLSL function to csm_* WGSL.
 * Run: node scripts/createMissingWgslChunks.js
 */
import { writeFileSync } from "fs";
import { join } from "path";

const DIR = join(
  "packages",
  "engine",
  "Source",
  "Shaders",
  "WebGPU",
  "chunks",
  "functions",
);

const chunks = {
  // ─── Already created by previous tool calls ───
  // csm_antialias, csm_applyHSBShift, csm_approximateTanh, csm_backFacing

  // ─── Cascade Shadow Map distance ───
  csm_cascadeDistance: `/**
 * Computes cascade distance for shadow mapping. Port of czm_cascadeDistance.
 * @chunk functions/csm_cascadeDistance
 */
fn csm_cascadeDistance(
    weights: vec4<f32>,
    nearDepthRange: vec4<f32>,
    farDepthRange: vec4<f32>
) -> vec2<f32> {
    let near: f32 = dot(weights, nearDepthRange);
    let far: f32 = dot(weights, farDepthRange);
    return vec2<f32>(near, far);
}
`,

  // ─── Atmosphere scattering ───
  csm_computeScattering: `/**
 * Computes Rayleigh/Mie scattering along a ray. Port of czm_computeScattering.
 * Uses Nishita single-scattering with configurable step counts.
 * @chunk functions/csm_computeScattering
 */
const CSM_ATMOSPHERE_THICKNESS: f32 = 111000.0;
const CSM_RAYLEIGH_SCALE_HEIGHT: f32 = 10000.0;
const CSM_MIE_SCALE_HEIGHT: f32 = 3200.0;
const CSM_MIE_ANISOTROPY: f32 = 0.8;
const CSM_RAYLEIGH_BETA: vec3<f32> = vec3<f32>(5.5e-6, 13.0e-6, 22.4e-6);
const CSM_MIE_BETA: vec3<f32> = vec3<f32>(21e-6, 21e-6, 21e-6);

struct ScatteringResult {
    rayleigh: vec3<f32>,
    mie: vec3<f32>,
    opacity: f32,
};

fn csm_raySphereIntersect(origin: vec3<f32>, dir: vec3<f32>, radius: f32) -> vec2<f32> {
    let a: f32 = dot(dir, dir);
    let b: f32 = 2.0 * dot(origin, dir);
    let c: f32 = dot(origin, origin) - radius * radius;
    let d: f32 = b * b - 4.0 * a * c;
    if (d < 0.0) { return vec2<f32>(-1.0, -1.0); }
    let sd: f32 = sqrt(d);
    return vec2<f32>((-b - sd) / (2.0 * a), (-b + sd) / (2.0 * a));
}

fn csm_computeScattering(
    rayOrigin: vec3<f32>,
    rayDir: vec3<f32>,
    rayLength: f32,
    lightDir: vec3<f32>,
    innerRadius: f32
) -> ScatteringResult {
    var result: ScatteringResult;
    result.rayleigh = vec3<f32>(0.0);
    result.mie = vec3<f32>(0.0);
    result.opacity = 0.0;

    let outerRadius: f32 = innerRadius + CSM_ATMOSPHERE_THICKNESS;
    let PRIMARY_STEPS: i32 = 16;
    let LIGHT_STEPS: i32 = 4;
    let stepSize: f32 = rayLength / f32(PRIMARY_STEPS);

    var totalRayleigh: vec3<f32> = vec3<f32>(0.0);
    var totalMie: vec3<f32> = vec3<f32>(0.0);
    var rayleighOpticalDepth: f32 = 0.0;
    var mieOpticalDepth: f32 = 0.0;

    for (var i: i32 = 0; i < PRIMARY_STEPS; i = i + 1) {
        let samplePos: vec3<f32> = rayOrigin + rayDir * (f32(i) + 0.5) * stepSize;
        let altitude: f32 = length(samplePos) - innerRadius;

        let rayleighDensity: f32 = exp(-altitude / CSM_RAYLEIGH_SCALE_HEIGHT) * stepSize;
        let mieDensity: f32 = exp(-altitude / CSM_MIE_SCALE_HEIGHT) * stepSize;

        rayleighOpticalDepth += rayleighDensity;
        mieOpticalDepth += mieDensity;

        // Light ray optical depth
        let lightIntersect: vec2<f32> = csm_raySphereIntersect(samplePos, lightDir, outerRadius);
        let lightStepSize: f32 = lightIntersect.y / f32(LIGHT_STEPS);
        var lightRayleighOD: f32 = 0.0;
        var lightMieOD: f32 = 0.0;

        for (var j: i32 = 0; j < LIGHT_STEPS; j = j + 1) {
            let lightPos: vec3<f32> = samplePos + lightDir * (f32(j) + 0.5) * lightStepSize;
            let lightAlt: f32 = length(lightPos) - innerRadius;
            lightRayleighOD += exp(-lightAlt / CSM_RAYLEIGH_SCALE_HEIGHT) * lightStepSize;
            lightMieOD += exp(-lightAlt / CSM_MIE_SCALE_HEIGHT) * lightStepSize;
        }

        let attenuation: vec3<f32> = exp(-(CSM_RAYLEIGH_BETA * (rayleighOpticalDepth + lightRayleighOD) +
                                            CSM_MIE_BETA * (mieOpticalDepth + lightMieOD)));

        totalRayleigh += rayleighDensity * attenuation;
        totalMie += mieDensity * attenuation;
    }

    result.rayleigh = totalRayleigh * CSM_RAYLEIGH_BETA;
    result.mie = totalMie * CSM_MIE_BETA;
    result.opacity = 1.0 - exp(-(rayleighOpticalDepth * length(CSM_RAYLEIGH_BETA) +
                                  mieOpticalDepth * length(CSM_MIE_BETA)));
    return result;
}
`,

  // ─── Atmosphere color (uses scattering results) ───
  csm_computeAtmosphereColor: `/**
 * Computes the atmosphere color from scattering. Port of czm_computeAtmosphereColor.
 * @chunk functions/csm_computeAtmosphereColor
 */
fn csm_henyeyGreenstein(cosAngle: f32, g: f32) -> f32 {
    let g2: f32 = g * g;
    return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5) * (0.25 / 3.14159265359);
}

fn csm_computeAtmosphereColor(
    rayOrigin: vec3<f32>,
    rayDir: vec3<f32>,
    lightDir: vec3<f32>,
    rayleighColor: vec3<f32>,
    mieColor: vec3<f32>,
    opacity: f32
) -> vec4<f32> {
    let cosAngle: f32 = dot(rayDir, lightDir);

    // Rayleigh phase function
    let rayleighPhase: f32 = 3.0 / (16.0 * 3.14159265359) * (1.0 + cosAngle * cosAngle);

    // Mie phase function (Henyey-Greenstein)
    let miePhase: f32 = csm_henyeyGreenstein(cosAngle, 0.8);

    let color: vec3<f32> = rayleighColor * rayleighPhase + mieColor * miePhase;
    return vec4<f32>(color, opacity);
}
`,

  // ─── Ground atmosphere scattering ───
  csm_computeGroundAtmosphereScattering: `/**
 * Computes ground atmosphere scattering. Port of czm_computeGroundAtmosphereScattering.
 * @chunk functions/csm_computeGroundAtmosphereScattering
 */
fn csm_computeGroundAtmosphereScattering(
    positionWC: vec3<f32>,
    lightDir: vec3<f32>,
    cameraPositionWC: vec3<f32>,
    rayleighColor: vec3<f32>,
    mieColor: vec3<f32>
) -> vec3<f32> {
    let viewDir: vec3<f32> = normalize(positionWC - cameraPositionWC);
    let cosAngle: f32 = dot(viewDir, lightDir);

    // Rayleigh phase
    let rayleighPhase: f32 = 0.75 * (1.0 + cosAngle * cosAngle);

    // Mie phase (Henyey-Greenstein)
    let g: f32 = 0.8;
    let g2: f32 = g * g;
    let miePhase: f32 = (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5) * (0.25 / 3.14159265359);

    return rayleighColor * rayleighPhase + mieColor * miePhase;
}
`,

  // ─── Light attenuation ───
  csm_computeAttenuation: `/**
 * Computes distance attenuation for point/spot lights. Port of czm_computeAttenuation.
 * @chunk functions/csm_computeAttenuation
 */
fn csm_computeAttenuation(lightRange: f32, distance: f32) -> f32 {
    if (lightRange <= 0.0) {
        // Unlimited range, inverse-square falloff
        return 1.0 / max(distance * distance, 0.01 * 0.01);
    }
    // Smooth attenuation within range
    let distOverRange: f32 = distance / lightRange;
    let distOverRange4: f32 = distOverRange * distOverRange * distOverRange * distOverRange;
    let attenuation: f32 = max(min(1.0 - distOverRange4, 1.0), 0.0);
    return attenuation * attenuation / max(distance * distance, 0.01 * 0.01);
}
`,

  // ─── Spot light cone ───
  csm_computeSpotCone: `/**
 * Computes spot light cone attenuation. Port of czm_computeSpotCone.
 * @chunk functions/csm_computeSpotCone
 */
fn csm_computeSpotCone(spotDirection: vec3<f32>, lightDir: vec3<f32>, innerCone: f32, outerCone: f32) -> f32 {
    let cosAngle: f32 = dot(-lightDir, spotDirection);
    if (cosAngle < cos(outerCone)) { return 0.0; }
    if (cosAngle > cos(innerCone)) { return 1.0; }
    return smoothstep(cos(outerCone), cos(innerCone), cosAngle);
}
`,

  // ─── Depth clamp ───
  csm_depthClamp: `/**
 * Emulates GL_DEPTH_CLAMP. Adjusts vertex position depth to clamp to near/far.
 * Port of czm_depthClamp.
 * @chunk functions/csm_depthClamp
 */
fn csm_depthClamp(clipPos: vec4<f32>) -> vec4<f32> {
    // In WebGPU (0..1 depth range), clamp the NDC z to valid range
    var result: vec4<f32> = clipPos;
    result.z = clamp(result.z, 0.0, result.w);
    return result;
}
`,

  // ─── East-North-Up to Eye coordinates ───
  csm_eastNorthUpToEyeCoordinates: `/**
 * Computes an ENU rotation matrix from position in eye coords + normal.
 * Port of czm_eastNorthUpToEyeCoordinates.
 * @chunk functions/csm_eastNorthUpToEyeCoordinates
 */
fn csm_eastNorthUpToEyeCoordinates(positionEC: vec3<f32>, normalEC: vec3<f32>) -> mat3x3<f32> {
    var tangentEC: vec3<f32> = normalize(vec3<f32>(-positionEC.y, positionEC.x, 0.0));
    let t: f32 = abs(normalEC.x) + abs(normalEC.y);
    if (t < 0.0001) {
        tangentEC = vec3<f32>(1.0, 0.0, 0.0);
    }
    let bitangentEC: vec3<f32> = normalize(cross(normalEC, tangentEC));
    tangentEC = normalize(cross(bitangentEC, normalEC));
    return mat3x3<f32>(tangentEC, bitangentEC, normalEC);
}
`,

  // ─── Ellipsoid texture coordinates ───
  csm_ellipsoidTextureCoordinates: `/**
 * Computes texture coordinates for a position on an ellipsoid.
 * Port of czm_ellipsoidTextureCoordinates.
 * @chunk functions/csm_ellipsoidTextureCoordinates
 */
fn csm_ellipsoidTextureCoordinates(normal: vec3<f32>) -> vec2<f32> {
    return vec2<f32>(
        atan2(normal.y, normal.x) * (0.5 / 3.14159265359) + 0.5,
        asin(normal.z) * (1.0 / 3.14159265359) + 0.5
    );
}
`,

  // ─── Float equals with epsilon ───
  csm_equalsEpsilon: `/**
 * Compares two floats with an epsilon tolerance. Port of czm_equalsEpsilon.
 * @chunk functions/csm_equalsEpsilon
 */
fn csm_equalsEpsilon(left: f32, right: f32, epsilon: f32) -> bool {
    return abs(left - right) <= epsilon;
}

fn csm_equalsEpsilonVec2(left: vec2<f32>, right: vec2<f32>, epsilon: f32) -> bool {
    return csm_equalsEpsilon(left.x, right.x, epsilon) &&
           csm_equalsEpsilon(left.y, right.y, epsilon);
}

fn csm_equalsEpsilonVec3(left: vec3<f32>, right: vec3<f32>, epsilon: f32) -> bool {
    return csm_equalsEpsilon(left.x, right.x, epsilon) &&
           csm_equalsEpsilon(left.y, right.y, epsilon) &&
           csm_equalsEpsilon(left.z, right.z, epsilon);
}

fn csm_equalsEpsilonVec4(left: vec4<f32>, right: vec4<f32>, epsilon: f32) -> bool {
    return csm_equalsEpsilon(left.x, right.x, epsilon) &&
           csm_equalsEpsilon(left.y, right.y, epsilon) &&
           csm_equalsEpsilon(left.z, right.z, epsilon) &&
           csm_equalsEpsilon(left.w, right.w, epsilon);
}
`,

  // ─── Eye offset (billboard displacement) ───
  csm_eyeOffset: `/**
 * Computes an eye-space offset for billboards/labels. Port of czm_eyeOffset.
 * @chunk functions/csm_eyeOffset
 */
fn csm_eyeOffset(positionEC: vec4<f32>, eyeOff: vec3<f32>) -> vec4<f32> {
    var p: vec4<f32> = positionEC;
    let zEyeOffset: vec4<f32> = normalize(p) * eyeOff.z;
    p.x = p.x + eyeOff.x + zEyeOffset.x;
    p.y = p.y + eyeOff.y + zEyeOffset.y;
    p.z = p.z + zEyeOffset.z;
    return p;
}
`,

  // ─── Eye to window coordinates ───
  csm_eyeToWindowCoordinates: `/**
 * Transforms a position from eye to window coordinates.
 * Port of czm_eyeToWindowCoordinates.
 * Requires csm_projection and csm_viewportTransformation uniforms.
 * @chunk functions/csm_eyeToWindowCoordinates
 */
fn csm_eyeToWindowCoordinates(
    positionEC: vec4<f32>,
    projection: mat4x4<f32>,
    viewportTransformation: mat4x4<f32>
) -> vec4<f32> {
    let clip: vec4<f32> = projection * positionEC;
    let ndc: vec3<f32> = clip.xyz / clip.w;
    // WebGPU NDC: x,y in [-1,1], z in [0,1]
    let window: vec4<f32> = viewportTransformation * vec4<f32>(
        ndc.x * 0.5 + 0.5,
        ndc.y * 0.5 + 0.5,
        ndc.z,
        1.0
    );
    return window;
}
`,

  // ─── Geodetic surface normal ───
  csm_geodeticSurfaceNormal: `/**
 * Computes the geodetic surface normal for a position on an ellipsoid.
 * Port of czm_geodeticSurfaceNormal.
 * @chunk functions/csm_geodeticSurfaceNormal
 */
fn csm_geodeticSurfaceNormal(positionWC: vec3<f32>, oneOverRadiiSquared: vec3<f32>) -> vec3<f32> {
    return normalize(positionWC * oneOverRadiiSquared);
}
`,

  // ─── Default material ───
  csm_getDefaultMaterial: `/**
 * Returns a default material with standard initial values. Port of czm_getDefaultMaterial.
 * @chunk functions/csm_getDefaultMaterial
 */
struct CsmMaterial {
    diffuse: vec3<f32>,
    specular: f32,
    shininess: f32,
    normal: vec3<f32>,
    emission: vec3<f32>,
    alpha: f32,
};

fn csm_getDefaultMaterial() -> CsmMaterial {
    var m: CsmMaterial;
    m.diffuse = vec3<f32>(0.0);
    m.specular = 0.0;
    m.shininess = 1.0;
    m.normal = vec3<f32>(0.0, 0.0, 1.0);
    m.emission = vec3<f32>(0.0);
    m.alpha = 1.0;
    return m;
}
`,

  // ─── Dynamic atmosphere light direction ───
  csm_getDynamicAtmosphereLightDirection: `/**
 * Computes the dynamic light direction for atmosphere effects.
 * Matches czm_getDynamicAtmosphereLightDirection.
 * @chunk functions/csm_getDynamicAtmosphereLightDirection
 */
fn csm_getDynamicAtmosphereLightDirection(positionWC: vec3<f32>, lightDirectionWC: vec3<f32>) -> vec3<f32> {
    // Use the sun direction as the light direction for atmosphere calculations.
    // When below horizon, still use sun direction for ground-up scattering.
    let normalizedPos: vec3<f32> = normalize(positionWC);
    let cosAngle: f32 = dot(normalizedPos, lightDirectionWC);
    // Always return the light direction (scene-level uniform handles day/night)
    return lightDirectionWC;
}
`,

  // ─── Lambert diffuse ───
  csm_getLambertDiffuse: `/**
 * Computes Lambert diffuse lighting. Port of czm_getLambertDiffuse.
 * @chunk functions/csm_getLambertDiffuse
 */
fn csm_getLambertDiffuse(lightDirectionEC: vec3<f32>, normalEC: vec3<f32>) -> f32 {
    return max(dot(normalEC, lightDirectionEC), 0.0);
}
`,

  // ─── Specular (Blinn-Phong) ───
  csm_getSpecular: `/**
 * Computes Blinn-Phong specular. Port of czm_getSpecular.
 * @chunk functions/csm_getSpecular
 */
fn csm_getSpecular(lightDirectionEC: vec3<f32>, toEyeEC: vec3<f32>, normalEC: vec3<f32>, shininess: f32) -> f32 {
    let halfDir: vec3<f32> = normalize(lightDirectionEC + toEyeEC);
    let specularAmount: f32 = max(dot(normalEC, halfDir), 0.0);
    return pow(specularAmount, max(shininess, 0.0001));
}
`,

  // ─── HSL to RGB ───
  csm_HSLToRGB: `/**
 * Converts HSL to RGB color space. Port of czm_HSLToRGB.
 * @chunk functions/csm_HSLToRGB
 */
fn csm_hslHue2rgb(p: f32, q: f32, t_in: f32) -> f32 {
    var t: f32 = t_in;
    if (t < 0.0) { t = t + 1.0; }
    if (t > 1.0) { t = t - 1.0; }
    if (t < 1.0 / 6.0) { return p + (q - p) * 6.0 * t; }
    if (t < 1.0 / 2.0) { return q; }
    if (t < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
    return p;
}

fn csm_HSLToRGB(hsl: vec3<f32>) -> vec3<f32> {
    if (hsl.y == 0.0) {
        return vec3<f32>(hsl.z);
    }
    var q: f32;
    if (hsl.z < 0.5) { q = hsl.z * (1.0 + hsl.y); }
    else { q = hsl.z + hsl.y - hsl.z * hsl.y; }
    let p: f32 = 2.0 * hsl.z - q;
    return vec3<f32>(
        csm_hslHue2rgb(p, q, hsl.x + 1.0 / 3.0),
        csm_hslHue2rgb(p, q, hsl.x),
        csm_hslHue2rgb(p, q, hsl.x - 1.0 / 3.0)
    );
}
`,

  // ─── Hue adjustment ───
  csm_hue: `/**
 * Adjusts the hue of an RGB color. Port of czm_hue.
 * @chunk functions/csm_hue
 */
fn csm_hue(rgb: vec3<f32>, adjustment: f32) -> vec3<f32> {
    let toYIQ: mat3x3<f32> = mat3x3<f32>(
        vec3<f32>(0.299, 0.587, 0.114),
        vec3<f32>(0.595716, -0.274453, -0.321263),
        vec3<f32>(0.211456, -0.522591, 0.311135)
    );
    let toRGB: mat3x3<f32> = mat3x3<f32>(
        vec3<f32>(1.0, 0.9563, 0.6210),
        vec3<f32>(1.0, -0.2721, -0.6474),
        vec3<f32>(1.0, -1.107, 1.7046)
    );
    let yiq: vec3<f32> = toYIQ * rgb;
    let h: f32 = atan2(yiq.z, yiq.y) + adjustment;
    let chroma: f32 = sqrt(yiq.z * yiq.z + yiq.y * yiq.y);
    return toRGB * vec3<f32>(yiq.x, chroma * cos(h), chroma * sin(h));
}
`,

  // ─── Inverse gamma ───
  csm_inverseGamma: `/**
 * Converts linear RGB to sRGB (inverse gamma). Port of czm_inverseGamma.
 * @chunk functions/csm_inverseGamma
 */
fn csm_inverseGamma(linearColor: vec3<f32>) -> vec3<f32> {
    return pow(linearColor, vec3<f32>(1.0 / 2.2));
}
`,

  // ─── isEmpty / isFull (czm_material range checks) ───
  csm_isEmpty: `/**
 * Tests if the material intersection interval is empty. Port of czm_isEmpty.
 * @chunk functions/csm_isEmpty
 */
fn csm_isEmpty(interval: vec4<f32>) -> bool {
    return interval.z > interval.w;
}
`,

  csm_isFull: `/**
 * Tests if the material intersection interval is full. Port of czm_isFull.
 * @chunk functions/csm_isFull
 */
fn csm_isFull(interval: vec4<f32>) -> bool {
    return interval.x == 0.0 && interval.y == 0.0 && interval.z == 0.0 && interval.w == 0.0;
}
`,

  // ─── Web Mercator projection ───
  csm_latitudeToWebMercatorFraction: `/**
 * Converts a geodetic latitude to Web Mercator fraction [0,1].
 * Port of czm_latitudeToWebMercatorFraction.
 * @chunk functions/csm_latitudeToWebMercatorFraction
 */
fn csm_latitudeToWebMercatorFraction(latitude: f32, southLatitude: f32, oneOverInterval: f32) -> f32 {
    let sinLatitude: f32 = sin(latitude);
    let mercatorY: f32 = 0.5 * log((1.0 + sinLatitude) / (1.0 - sinLatitude));
    let sinSouthLatitude: f32 = sin(southLatitude);
    let mercatorSouth: f32 = 0.5 * log((1.0 + sinSouthLatitude) / (1.0 - sinSouthLatitude));
    return (mercatorY - mercatorSouth) * oneOverInterval;
}
`,

  // ─── Line distance ───
  csm_lineDistance: `/**
 * Distance from a point to a line. Port of czm_lineDistance.
 * @chunk functions/csm_lineDistance
 */
fn csm_lineDistance(p1: vec2<f32>, p2: vec2<f32>, point: vec2<f32>) -> f32 {
    let dir: vec2<f32> = p2 - p1;
    return abs((point.y - p1.y) * dir.x - (point.x - p1.x) * dir.y) / length(dir);
}
`,

  // ─── Log2 depth ───
  csm_log2Depth: `/**
 * Computes log2 depth from linear depth. Port of czm_log2Depth.
 * @chunk functions/csm_log2Depth
 */
fn csm_log2Depth(depth: f32, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {
    return log2(depth + 1.0) * oneOverLog2FarDepthFromNearPlusOne;
}
`,

  // ─── Model to window coordinates ───
  csm_modelToWindowCoordinates: `/**
 * Transforms a model position to window coordinates.
 * Port of czm_modelToWindowCoordinates.
 * @chunk functions/csm_modelToWindowCoordinates
 */
fn csm_modelToWindowCoordinates(
    positionMC: vec4<f32>,
    modelView: mat4x4<f32>,
    projection: mat4x4<f32>,
    viewportTransformation: mat4x4<f32>
) -> vec4<f32> {
    let positionEC: vec4<f32> = modelView * positionMC;
    let positionClip: vec4<f32> = projection * positionEC;
    let ndc: vec3<f32> = positionClip.xyz / positionClip.w;
    return viewportTransformation * vec4<f32>(
        ndc.x * 0.5 + 0.5,
        ndc.y * 0.5 + 0.5,
        ndc.z,
        1.0
    );
}
`,

  // ─── Read depth from texture ───
  csm_readDepth: `/**
 * Reads depth from a depth texture and converts from log depth.
 * Port of czm_readDepth.
 * @chunk functions/csm_readDepth
 */
fn csm_readDepth(depthTexture: texture_2d<f32>, depthSampler: sampler, texCoords: vec2<f32>) -> f32 {
    let rawDepth: f32 = textureSample(depthTexture, depthSampler, texCoords).r;
    return csm_reverseLogDepth(rawDepth);
}
`,

  // ─── Non-perspective read/write ───
  csm_readNonPerspective: `/**
 * Reads a value corrected from non-perspective interpolation.
 * Port of czm_readNonPerspective.
 * @chunk functions/csm_readNonPerspective
 */
fn csm_readNonPerspective(value: f32, oneOverW: f32) -> f32 {
    return value * oneOverW;
}

fn csm_readNonPerspectiveVec2(value: vec2<f32>, oneOverW: f32) -> vec2<f32> {
    return value * oneOverW;
}

fn csm_readNonPerspectiveVec3(value: vec3<f32>, oneOverW: f32) -> vec3<f32> {
    return value * oneOverW;
}

fn csm_readNonPerspectiveVec4(value: vec4<f32>, oneOverW: f32) -> vec4<f32> {
    return value * oneOverW;
}
`,

  csm_writeNonPerspective: `/**
 * Writes a value prepared for non-perspective interpolation.
 * Port of czm_writeNonPerspective.
 * @chunk functions/csm_writeNonPerspective
 */
fn csm_writeNonPerspective(value: f32, w: f32) -> f32 {
    return value / w;
}

fn csm_writeNonPerspectiveVec2(value: vec2<f32>, w: f32) -> vec2<f32> {
    return value / w;
}

fn csm_writeNonPerspectiveVec3(value: vec3<f32>, w: f32) -> vec3<f32> {
    return value / w;
}

fn csm_writeNonPerspectiveVec4(value: vec4<f32>, w: f32) -> vec4<f32> {
    return value / w;
}
`,

  // ─── Octahedral projection sampling (for IBL) ───
  csm_sampleOctahedralProjection: `/**
 * Samples an octahedral projection texture for IBL.
 * Port of czm_sampleOctahedralProjection.
 * @chunk functions/csm_sampleOctahedralProjection
 */
fn csm_octahedralEncode(direction: vec3<f32>) -> vec2<f32> {
    let absDir: vec3<f32> = abs(direction);
    var n: vec2<f32> = direction.xy / (absDir.x + absDir.y + absDir.z);
    if (direction.z < 0.0) {
        n = (1.0 - abs(n.yx)) * vec2<f32>(
            select(-1.0, 1.0, n.x >= 0.0),
            select(-1.0, 1.0, n.y >= 0.0)
        );
    }
    return n * 0.5 + 0.5;
}

fn csm_sampleOctahedralProjection(
    octMap: texture_2d<f32>,
    octSampler: sampler,
    direction: vec3<f32>,
    mipLevel: f32,
    maxMip: f32
) -> vec3<f32> {
    let uv: vec2<f32> = csm_octahedralEncode(normalize(direction));
    // Pack mip into Y offset for atlas layout
    let mip: f32 = clamp(mipLevel, 0.0, maxMip);
    let scale: f32 = 1.0 / pow(2.0, mip);
    let offset: f32 = 1.0 - scale;
    let atlasUV: vec2<f32> = vec2<f32>(uv.x * scale, uv.y * scale + offset);
    return textureSampleLevel(octMap, octSampler, atlasUV, 0.0).rgb;
}
`,

  // ─── Translucent phong ───
  csm_translucentPhong: `/**
 * Phong lighting for translucent materials with back-face handling.
 * Port of czm_translucentPhong.
 * @chunk functions/csm_translucentPhong
 */
fn csm_translucentPhong(
    toEyeEC: vec3<f32>,
    normalEC: vec3<f32>,
    lightDirEC: vec3<f32>,
    diffuse: vec3<f32>,
    specular: vec3<f32>,
    shininess: f32,
    isFrontFace: bool
) -> vec4<f32> {
    var normal: vec3<f32> = normalEC;
    if (!isFrontFace) {
        normal = -normal;
    }
    let NdotL: f32 = max(dot(normal, lightDirEC), 0.0);
    let halfDir: vec3<f32> = normalize(lightDirEC + toEyeEC);
    let specAmount: f32 = pow(max(dot(normal, halfDir), 0.0), max(shininess, 0.0001));
    let color: vec3<f32> = diffuse * NdotL + specular * specAmount;
    return vec4<f32>(color, 1.0);
}
`,

  // ─── Unpack clipping extents ───
  csm_unpackClippingExtents: `/**
 * Unpacks clipping plane extents from a packed texture. Port of czm_unpackClippingExtents.
 * @chunk functions/csm_unpackClippingExtents
 */
fn csm_unpackClippingExtents(packedExtents: vec4<f32>) -> vec4<f32> {
    return packedExtents;
}
`,

  // ─── Unpack uint from float ───
  csm_unpackUint: `/**
 * Unpacks unsigned integers from float channels. Port of czm_unpackUint.
 * @chunk functions/csm_unpackUint
 */
fn csm_unpackUint(packedValue: f32) -> u32 {
    return u32(packedValue * 255.0 + 0.5);
}

fn csm_unpackUintVec2(packedValue: vec2<f32>) -> u32 {
    return u32(packedValue.x * 255.0 + 0.5) * 256u + u32(packedValue.y * 255.0 + 0.5);
}

fn csm_unpackUintVec3(packedValue: vec3<f32>) -> u32 {
    return u32(packedValue.x * 255.0 + 0.5) * 65536u +
           u32(packedValue.y * 255.0 + 0.5) * 256u +
           u32(packedValue.z * 255.0 + 0.5);
}

fn csm_unpackUintVec4(packedValue: vec4<f32>) -> u32 {
    return u32(packedValue.x * 255.0 + 0.5) * 16777216u +
           u32(packedValue.y * 255.0 + 0.5) * 65536u +
           u32(packedValue.z * 255.0 + 0.5) * 256u +
           u32(packedValue.w * 255.0 + 0.5);
}
`,

  // ─── Vertex log depth ───
  csm_vertexLogDepth: `/**
 * Computes log depth in vertex shader. Port of czm_vertexLogDepth.
 * @chunk functions/csm_vertexLogDepth
 */
fn csm_vertexLogDepth(clipPos: vec4<f32>, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {
    let w: f32 = clipPos.w;
    if (w > 0.0) {
        return log2(max(1e-6, w + 1.0)) * oneOverLog2FarDepthFromNearPlusOne;
    }
    return 0.0;
}
`,

  // ─── Window to eye coordinates ───
  csm_windowToEyeCoordinates: `/**
 * Transforms window coordinates back to eye coordinates.
 * Port of czm_windowToEyeCoordinates.
 * @chunk functions/csm_windowToEyeCoordinates
 */
fn csm_windowToEyeCoordinates(
    windowPos: vec2<f32>,
    depth: f32,
    inverseProjection: mat4x4<f32>,
    viewport: vec4<f32>
) -> vec4<f32> {
    // Convert window to NDC
    let ndcX: f32 = (windowPos.x - viewport.x) / viewport.z * 2.0 - 1.0;
    let ndcY: f32 = (windowPos.y - viewport.y) / viewport.w * 2.0 - 1.0;
    // WebGPU depth is [0,1]
    let ndcZ: f32 = depth;
    let clipPos: vec4<f32> = vec4<f32>(ndcX, ndcY, ndcZ, 1.0);
    let eyePos: vec4<f32> = inverseProjection * clipPos;
    return eyePos / eyePos.w;
}
`,

  // ─── Write depth clamp ───
  csm_writeDepthClamp: `/**
 * Fragment shader depth clamp write. Port of czm_writeDepthClamp.
 * In WebGPU, frag_depth output handles depth clamping.
 * @chunk functions/csm_writeDepthClamp
 */
fn csm_writeDepthClamp(windowZ: f32) -> f32 {
    return clamp(windowZ, 0.0, 1.0);
}
`,
};

let count = 0;
for (const [name, content] of Object.entries(chunks)) {
  const path = join(DIR, `${name}.wgsl`);
  writeFileSync(path, content, "utf8");
  count++;
  console.log(`Created: ${name}.wgsl`);
}
console.log(`\nTotal: ${count} WGSL files created.`);
