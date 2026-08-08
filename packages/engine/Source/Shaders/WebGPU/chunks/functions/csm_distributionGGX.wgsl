/**
 * Normal Distribution Function (GGX/Trowbridge-Reitz)
 * Used in PBR rendering for microfacet specular BRDF
 * 
 * Reference: Bruce Walter, Stephen Marschner, Hongsong Li and Kenneth
 * Torrance, "Microfacet Models for Refraction through Rough Surfaces"
 * (EGSR 2007), where the distribution is introduced as GGX; the
 * alpha = roughness^2 remap follows Brian Karis, "Real Shading in Unreal
 * Engine 4" (SIGGRAPH 2013).
 *
 * @chunk functions/csm_distributionGGX
 * @requires functions/csm_constants
 */

// #import "functions/csm_constants"

fn csm_distributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let NdotH = max(dot(N, H), 0.0);
    let NdotH2 = NdotH * NdotH;

    let nom = a2;
    var denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = CSM_PI * denom * denom;

    return nom / denom;
}
