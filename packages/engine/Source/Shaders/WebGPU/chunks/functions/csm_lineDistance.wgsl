/**
 * Distance from a point to a line. Port of czm_lineDistance.
 * @chunk functions/csm_lineDistance
 */
fn csm_lineDistance(p1: vec2<f32>, p2: vec2<f32>, point: vec2<f32>) -> f32 {
    let dir: vec2<f32> = p2 - p1;
    return abs((point.y - p1.y) * dir.x - (point.x - p1.x) * dir.y) / length(dir);
}
