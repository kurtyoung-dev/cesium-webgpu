/**
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
