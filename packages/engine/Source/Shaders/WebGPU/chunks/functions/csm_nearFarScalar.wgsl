/**
 * Linearly interpolate a scalar based on distance (near/far range).
 * Maps czm_nearFarScalar: x=near, y=nearValue, z=far, w=farValue.
 *
 * @chunk functions/csm_nearFarScalar
 */
fn csm_nearFarScalar(nearFar: vec4<f32>, cameraDistSq: f32) -> f32 {
    let cameraDist = sqrt(cameraDistSq);
    let t = clamp((cameraDist - nearFar.x) / (nearFar.z - nearFar.x), 0.0, 1.0);
    return mix(nearFar.y, nearFar.w, t);
}
