/**
 * Unpacks unsigned integers from float channels. Port of czm_unpackUint.
 * @chunk functions/csm_unpackUint
 */
fn csm_unpackUint(packedValue: f32) -> u32 {
    return u32(packedValue * 255.0 + 0.5);
}

fn csm_unpackUintVec2(packedValue: vec2<f32>) -> u32 {
    return u32(packedValue.x * 255.0 + 0.5) * 256u + u32(packedValue.y * 255.0 + 0.5);
}

fn csm_unpackUintVec3(packedValue: vec3<f32>) -> u32 {
    return u32(packedValue.x * 255.0 + 0.5) * 65536u +
           u32(packedValue.y * 255.0 + 0.5) * 256u +
           u32(packedValue.z * 255.0 + 0.5);
}

fn csm_unpackUintVec4(packedValue: vec4<f32>) -> u32 {
    return u32(packedValue.x * 255.0 + 0.5) * 16777216u +
           u32(packedValue.y * 255.0 + 0.5) * 65536u +
           u32(packedValue.z * 255.0 + 0.5) * 256u +
           u32(packedValue.w * 255.0 + 0.5);
}
