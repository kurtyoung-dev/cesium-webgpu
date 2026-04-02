/**
 * Common atmosphere utilities shared by sky, ground, and model atmosphere.
 * Port of AtmosphereCommon.glsl.
 * @chunk functions/csm_atmosphereCommon
 */
const CSM_ATMOSPHERE_RAYLEIGH_SCALE_HEIGHT: f32 = 10000.0;
const CSM_ATMOSPHERE_MIE_SCALE_HEIGHT: f32 = 3200.0;
const CSM_ATMOSPHERE_MIE_G: f32 = 0.8;

fn csm_rayleighPhase(cosAngle: f32) -> f32 {
    return 3.0 / (16.0 * 3.14159265359) * (1.0 + cosAngle * cosAngle);
}

fn csm_miePhase(cosAngle: f32, g: f32) -> f32 {
    let g2: f32 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159265359 * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5));
}

fn csm_densityAtAltitude(altitude: f32, scaleHeight: f32) -> f32 {
    return exp(-altitude / scaleHeight);
}

fn csm_computeEllipseAtmosphereFade(posWC: vec3<f32>, lightDir: vec3<f32>, innerRadius: f32) -> f32 {
    let altitude: f32 = length(posWC) - innerRadius;
    let atmosphereThickness: f32 = 111000.0;
    return clamp(altitude / atmosphereThickness, 0.0, 1.0);
}

fn csm_nearestPointOnEllipseFast(pos: vec2<f32>, radii: vec2<f32>) -> vec2<f32> {
    let p: vec2<f32> = abs(pos);
    let invRadii: vec2<f32> = 1.0 / radii;
    let evolScale: vec2<f32> = (radii.x * radii.x - radii.y * radii.y) * vec2<f32>(1.0, -1.0) * invRadii;
    let tTrigs: vec2<f32> = vec2<f32>(0.70710678118);
    let v: vec2<f32> = radii * tTrigs;
    let evolute: vec2<f32> = evolScale * tTrigs * tTrigs * tTrigs;
    let q: vec2<f32> = normalize(p - evolute) * length(v - evolute);
    let candidateT: vec2<f32> = normalize(q * invRadii);
    let candidateP: vec2<f32> = radii * candidateT;
    return candidateP * sign(pos);
}
