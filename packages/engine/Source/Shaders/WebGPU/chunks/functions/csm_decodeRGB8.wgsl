// csm_decodeRGB8.wgsl — WGSL equivalent of czm_decodeRGB8
//
// Decodes RGB values packed into a single float at 8-bit precision.
// Encoded representation is equivalent to 0xFFFFFF in JavaScript.
//
// @param encoded Float-encoded RGB values.
// @returns Decoded RGBA color with alpha = 1.0, components in [0.0, 1.0].

fn csm_decodeRGB8(encoded: f32) -> vec4<f32> {
  let SHIFT_RIGHT16: f32 = 1.0 / 65536.0;
  let SHIFT_RIGHT8: f32 = 1.0 / 256.0;
  let SHIFT_LEFT16: f32 = 65536.0;
  let SHIFT_LEFT8: f32 = 256.0;

  let r = floor(encoded * SHIFT_RIGHT16);
  let g = floor((encoded - r * SHIFT_LEFT16) * SHIFT_RIGHT8);
  let b = floor(encoded - r * SHIFT_LEFT16 - g * SHIFT_LEFT8);

  return vec4<f32>(r, g, b, 255.0) / 255.0;
}
