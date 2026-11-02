//>>ifdef CLOUD_WEATHER_VOLUME_BOUNDS
struct CloudWeatherBoundsNode {
  minimumHigh: vec3<f32>, escape: u32,
  minimumLow: vec3<f32>, leaf: u32,
  maximumHigh: vec3<f32>, maximumCoverage: f32,
  maximumLow: vec3<f32>, pad: u32,
}
struct CloudWeatherBoundsTree {
  count: u32, enabled: u32, pad0: u32, pad1: u32,
  nodes: array<CloudWeatherBoundsNode>,
}
@group(0) @binding(19) var<storage, read> cloudWeatherBounds: CloudWeatherBoundsTree;

fn cloudWeatherCoverageUpper(direction: vec3<f32>, start: f32, end: f32) -> f32 {
  if (cloudWeatherBounds.enabled == 0u || cloudWeatherBounds.count > arrayLength(&cloudWeatherBounds.nodes)) {
    return 1.0;
  }
  var maximum = 0.0;
  var index = 0u;
  for (var visits = 0u; visits < 256u && index < cloudWeatherBounds.count; visits++) {
    let node = cloudWeatherBounds.nodes[index];
    if (node.escape <= index || node.escape > cloudWeatherBounds.count) { return 1.0; }
    let lo = (node.minimumHigh - cloud.encodedCameraHigh) + (node.minimumLow - cloud.encodedCameraLow);
    let hi = (node.maximumHigh - cloud.encodedCameraHigh) + (node.maximumLow - cloud.encodedCameraLow);
    var near = start;
    var far = end;
    for (var axis = 0u; axis < 3u; axis++) {
      if (abs(direction[axis]) < 1e-20) {
        if (lo[axis] > 0.0 || hi[axis] < 0.0) { far = start - 1.0; }
      } else {
        let a = lo[axis] / direction[axis];
        let b = hi[axis] / direction[axis];
        near = max(near, min(a, b));
        far = min(far, max(a, b));
      }
    }
    if (far < near || node.maximumCoverage <= maximum) {
      index = node.escape;
    } else if (node.leaf != 0u) {
      maximum = max(maximum, node.maximumCoverage);
      if (maximum >= 1.0) { return 1.0; }
      index = node.escape;
    } else {
      index++;
    }
  }
  // A traversal budget miss is unknown, never a certificate of empty weather.
  if (index < cloudWeatherBounds.count) { return 1.0; }
  if (maximum <= 0.0) { return 0.0; }
  return min(1.0, maximum + 0.0000152587890625);
}
//>>else
//>>endif
