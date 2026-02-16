/**
 * Blinn-Phong lighting calculation
 * Provides ambient + diffuse (Lambert) + specular (Blinn-Phong) lighting
 * 
 * @chunk functions/csm_phong
 */

struct CsmPhongResult {
    ambient: vec3<f32>,
    diffuse: vec3<f32>,
    specular: vec3<f32>,
    combined: vec3<f32>,
}

fn csm_phong(
    N: vec3<f32>,
    V: vec3<f32>,
    L: vec3<f32>,
    lightColor: vec3<f32>,
    lightIntensity: f32,
    ambientColor: vec3<f32>,
    diffuseColor: vec3<f32>,
    specularColor: vec3<f32>,
    shininess: f32,
) -> CsmPhongResult {
    var result: CsmPhongResult;

    // Ambient component
    result.ambient = ambientColor * diffuseColor;

    // Diffuse component (Lambert)
    let NdotL = max(dot(N, L), 0.0);
    result.diffuse = diffuseColor * lightColor * NdotL * lightIntensity;

    // Specular component (Blinn-Phong)
    let H = normalize(L + V);
    let NdotH = max(dot(N, H), 0.0);
    let spec = pow(NdotH, shininess);
    result.specular = specularColor * lightColor * spec * lightIntensity;

    // Combined
    result.combined = result.ambient + result.diffuse + result.specular;

    return result;
}

fn csm_phongSimple(
    N: vec3<f32>,
    V: vec3<f32>,
    L: vec3<f32>,
    baseColor: vec3<f32>,
    shininess: f32,
) -> vec3<f32> {
    let ambient = 0.15 * baseColor;
    let NdotL = max(dot(N, L), 0.0);
    let diffuse = 0.7 * baseColor * NdotL;
    let H = normalize(L + V);
    let NdotH = max(dot(N, H), 0.0);
    let specular = 0.15 * pow(NdotH, shininess);

    return ambient + diffuse + vec3<f32>(specular);
}
