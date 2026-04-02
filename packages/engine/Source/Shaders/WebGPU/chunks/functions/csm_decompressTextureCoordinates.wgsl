/**
 * Decompress texture coordinates from a single float.
 * CesiumJS quantized mesh format encodes UV as a single 32-bit float:
 * floor(u * 4096) * 4096 + floor(v * 4096)
 *
 * @chunk functions/csm_decompressTextureCoordinates
 */
fn csm_decompressTextureCoordinates(encoded: f32) -> vec2<f32> {
    let temp = encoded / 4096.0;
    let xZeroTo4095 = floor(temp);
    let stx = xZeroTo4095 / 4095.0;
    let sty = (encoded - xZeroTo4095 * 4096.0) / 4095.0;
    return vec2<f32>(stx, sty);
}
