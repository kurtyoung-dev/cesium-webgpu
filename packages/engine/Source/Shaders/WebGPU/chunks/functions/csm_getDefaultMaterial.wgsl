/**
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
