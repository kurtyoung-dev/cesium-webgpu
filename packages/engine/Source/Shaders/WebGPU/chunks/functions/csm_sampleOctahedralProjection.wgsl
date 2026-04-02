/**
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
