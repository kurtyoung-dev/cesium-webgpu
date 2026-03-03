/**
 * Geometry Function (Smith's Schlick-GGX)
 * Used in PBR rendering for microfacet geometric occlusion
 * 
 * @chunk functions/csm_geometrySmith
 */

fn csm_geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = (r * r) / 8.0;

    let nom = NdotV;
    let denom = NdotV * (1.0 - k) + k;

    return nom / denom;
}

fn csm_geometrySmith(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32) -> f32 {
    let NdotV = max(dot(N, V), 0.0);
    let NdotL = max(dot(N, L), 0.0);
    let ggx2 = csm_geometrySchlickGGX(NdotV, roughness);
    let ggx1 = csm_geometrySchlickGGX(NdotL, roughness);

    return ggx1 * ggx2;
}
