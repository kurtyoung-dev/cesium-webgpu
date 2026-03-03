/**
 * Translates a position encoded as high/low 32-bit float pairs
 * relative to the camera position (also encoded as high/low).
 *
 * This is the WGSL equivalent of the GLSL czm_translateRelativeToEye function.
 * It implements GPU-side emulated 64-bit precision (RTE — Relative To Eye)
 * to eliminate jitter at planetary scale.
 *
 * The technique:
 *   1. JS splits 64-bit position into two 32-bit floats (high + low)
 *   2. Camera position is similarly split (via EncodedCartesian3)
 *   3. This function subtracts camera from position in the split domain
 *   4. Result is a small eye-relative offset that fits precisely in f32
 *
 * Unlike GLSL (which uses automatic uniforms / globals), WGSL requires
 * explicit parameters — the encoded camera position must be passed in.
 *
 * @param positionHigh - High-order bits of the encoded position
 * @param positionLow  - Low-order bits of the encoded position
 * @param encodedCameraPositionMCHigh - High-order bits of encoded camera position (model coords)
 * @param encodedCameraPositionMCLow  - Low-order bits of encoded camera position (model coords)
 * @returns Eye-relative position as vec4 with w=1.0
 *
 * @chunk functions/csm_translateRelativeToEye
 */
fn csm_translateRelativeToEye(
    positionHigh: vec3<f32>,
    positionLow: vec3<f32>,
    encodedCameraPositionMCHigh: vec3<f32>,
    encodedCameraPositionMCLow: vec3<f32>,
) -> vec4<f32> {
    // Subtract camera high from position high
    var highDifference = positionHigh - encodedCameraPositionMCHigh;

    // NaN guard: on some devices (notably iOS), when high equals camera high
    // exactly, the subtraction can produce NaN due to floating-point quirks.
    // A zero-length check catches this and resets to zero.
    if (length(highDifference) == 0.0) {
        highDifference = vec3<f32>(0.0, 0.0, 0.0);
    }

    // Subtract camera low from position low
    let lowDifference = positionLow - encodedCameraPositionMCLow;

    // Combine: the sum of the two differences gives the eye-relative position
    // with sub-meter precision anywhere on Earth
    return vec4<f32>(highDifference + lowDifference, 1.0);
}
