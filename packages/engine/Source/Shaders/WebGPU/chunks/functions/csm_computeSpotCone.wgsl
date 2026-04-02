/**
 * Computes spot light cone attenuation. Port of czm_computeSpotCone.
 * @chunk functions/csm_computeSpotCone
 */
fn csm_computeSpotCone(spotDirection: vec3<f32>, lightDir: vec3<f32>, innerCone: f32, outerCone: f32) -> f32 {
    let cosAngle: f32 = dot(-lightDir, spotDirection);
    if (cosAngle < cos(outerCone)) { return 0.0; }
    if (cosAngle > cos(innerCone)) { return 1.0; }
    return smoothstep(cos(outerCone), cos(innerCone), cosAngle);
}
