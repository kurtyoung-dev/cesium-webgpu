/**
 * Generate animated water noise for ocean rendering.
 * Uses scrolling UV-based sine wave approximation.
 *
 * @chunk functions/csm_getWaterNoise
 */
fn csm_getWaterNoise(uv: vec2<f32>, time: f32, scale: f32) -> f32 {
    let adjustedST = uv * scale;
    let a1 = sin(adjustedST.x * 12.9898 + adjustedST.y * 78.233 + time);
    let a2 = sin(adjustedST.x * 39.467 + adjustedST.y * 11.819 - time * 0.7);
    let a3 = sin(adjustedST.x * 73.156 + adjustedST.y * 52.372 + time * 1.3);
    return (a1 + a2 + a3) / 3.0;
}
