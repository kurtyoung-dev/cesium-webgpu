/**
 * Computes Blinn-Phong specular. Port of czm_getSpecular.
 * @chunk functions/csm_getSpecular
 */
fn csm_getSpecular(lightDirectionEC: vec3<f32>, toEyeEC: vec3<f32>, normalEC: vec3<f32>, shininess: f32) -> f32 {
    let halfDir: vec3<f32> = normalize(lightDirectionEC + toEyeEC);
    let specularAmount: f32 = max(dot(normalEC, halfDir), 0.0);
    return pow(specularAmount, max(shininess, 0.0001));
}
