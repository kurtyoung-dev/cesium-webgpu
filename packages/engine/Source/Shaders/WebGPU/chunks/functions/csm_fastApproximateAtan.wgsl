/**
 * Fast approximation of atan/atan2 using polynomial.
 * Max error ~0.005 radians.
 *
 * @chunk functions/csm_fastApproximateAtan
 */
fn csm_fastApproximateAtan_single(x: f32) -> f32 {
    return x * (-0.1784 * abs(x) - 0.0663 * x * x + 1.0301);
}

fn csm_fastApproximateAtan(x: f32, y: f32) -> f32 {
    let t = abs(x);
    let opposite = abs(y);
    let adjacent = max(t, opposite);
    let a = min(t, opposite) / adjacent;
    var s = csm_fastApproximateAtan_single(a);
    if (opposite > t) {
        s = 1.5707963 - s;
    }
    if (x < 0.0) {
        s = 3.1415927 - s;
    }
    if (y < 0.0) {
        s = -s;
    }
    return s;
}
