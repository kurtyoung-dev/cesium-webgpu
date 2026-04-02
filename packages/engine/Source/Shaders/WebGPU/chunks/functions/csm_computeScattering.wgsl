/**
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
