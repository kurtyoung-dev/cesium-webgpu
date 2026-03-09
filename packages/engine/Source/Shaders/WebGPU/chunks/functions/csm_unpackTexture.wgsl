// csm_unpackTexture.wgsl — WGSL equivalent of czm_unpackTexture
//
// Reinterprets texture data as higher-precision unsigned integer values.
// WebGPU supports u32 and bitwise operations natively (unlike WebGL 1).
//
// Useful for unpacking packed data from texture lookups where normalized
// [0.0, 1.0] float channels represent raw byte values.
//
// Byte order: LITTLE-ENDIAN (matches GLSL czm_unpackTexture)
// Component x = byte 0 (LSB), y = byte 1, z = byte 2, w = byte 3 (MSB)

// Unpack a single normalized float channel to u32 (8-bit value)
fn csm_unpackTexture1(channel: f32) -> u32 {
  return u32(channel * 255.0 + 0.5);
}

// Unpack two normalized float channels to u32 (16-bit value, little-endian)
fn csm_unpackTexture2(channels: vec2<f32>) -> u32 {
  let bytes = vec2<u32>(channels * 255.0 + vec2<f32>(0.5));
  return bytes.x | (bytes.y << 8u);
}

// Unpack three normalized float channels to u32 (24-bit value, little-endian)
fn csm_unpackTexture3(channels: vec3<f32>) -> u32 {
  let bytes = vec3<u32>(channels * 255.0 + vec3<f32>(0.5));
  return bytes.x | (bytes.y << 8u) | (bytes.z << 16u);
}

// Unpack four normalized float channels to u32 (32-bit value, little-endian)
fn csm_unpackTexture4(channels: vec4<f32>) -> u32 {
  let bytes = vec4<u32>(channels * 255.0 + vec4<f32>(0.5));
  return bytes.x | (bytes.y << 8u) | (bytes.z << 16u) | (bytes.w << 24u);
}
