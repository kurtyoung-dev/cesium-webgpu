/**
 * Decode a unit vector from octahedral encoding.
 * See "Survey of Efficient Representations for Independent Unit Vectors" by Cigolle et al.
 *
 * @chunk functions/csm_octDecode
 */
fn csm_signNotZero(value: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(
        select(-1.0, 1.0, value.x >= 0.0),
        select(-1.0, 1.0, value.y >= 0.0)
    );
}

fn csm_octDecode_single(encoded: vec2<f32>) -> vec3<f32> {
    let e = encoded / 255.0 * 2.0 - 1.0;
    var v = vec3<f32>(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
    if (v.z < 0.0) {
        let s = csm_signNotZero(v.xy);
        v = vec3<f32>((1.0 - abs(v.yx)) * s, v.z);
    }
    return normalize(v);
}

fn csm_octDecode(encoded: vec2<f32>, result: ptr<function, vec3<f32>>) {
    *result = csm_octDecode_single(encoded);
}

fn csm_octDecode_rangeX(x: f32, rangeMax: f32) -> vec3<f32> {
    let ix = x / rangeMax;
    let temp = ix * 65536.0;
    let ex = floor(temp / 256.0);
    let ey = temp - ex * 256.0;
    return csm_octDecode_single(vec2<f32>(ex, ey));
}
