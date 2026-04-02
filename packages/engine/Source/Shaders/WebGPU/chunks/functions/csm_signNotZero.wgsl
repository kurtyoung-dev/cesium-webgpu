/**
 * Return the sign of the value, mapping zero to 1.0.
 * Useful for octahedral encoding and other sign-preserving operations.
 *
 * @chunk functions/csm_signNotZero
 */
fn csm_signNotZero_f32(value: f32) -> f32 {
    return select(-1.0, 1.0, value >= 0.0);
}

fn csm_signNotZero_vec2(value: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(
        select(-1.0, 1.0, value.x >= 0.0),
        select(-1.0, 1.0, value.y >= 0.0)
    );
}
