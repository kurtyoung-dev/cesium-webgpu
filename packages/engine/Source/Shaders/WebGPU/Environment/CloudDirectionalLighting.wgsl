//>>ifdef CLOUD_DIRECTIONAL_LIGHTING
fn cloudDirectionalExit(relative: vec3<f32>, direction: vec3<f32>, bottom: f32, top: f32) -> f32 {
  let high = -cloud.encodedCameraHigh;
  let low = -cloud.encodedCameraLow - relative;
  let outer = rayEllipsoidIntersectRTE(direction, high, low, cloudShellAxes(top));
  let inner = rayEllipsoidIntersectRTE(direction, high, low, cloudShellAxes(bottom));
  let distance = max(outer.y, 0.0);
  return min(distance, select(distance, inner.x, inner.x > 0.0));
}
fn cloudDirectionalLight(
  height: f32, bottom: f32, top: f32,
  coordinates: CloudDensityCoordinates, morphology: vec3<f32>,
) -> f32 {
  let relative = coordinates.canonical / CLOUD_DENSITY_WORLD_TO_NOISE;
  let sunLength = length(cloud.sunDirection);
  if (!(sunLength > 0.0) || height <= 0.0 || height >= 1.0) { return 0.0; }
  let sun = cloud.sunDirection / sunLength;
  let exit = cloudDirectionalExit(relative, sun, bottom, top);
  if (exit <= 0.0) { return 0.0; }
  var cached = vec3<f32>(0.0);
//>>ifdef CLOUD_DEEP_SHADOW_CACHE
  cached = cloudDeepShadowRead(relative, bottom, top, cloudDeepShadowFrame.control.x);
//>>else
//>>endif
  let prefix = cached.y > 0.0;
  let passes = select(1, 2, prefix && cached.y < 1.0);
  let requested = max(1, i32(cloud.lightSteps * cloud.lightSampleScale));
  let inner = vec3<f32>(1.0) / cloudShellAxes(bottom);
  let outer = vec3<f32>(1.0) / cloudShellAxes(top);
  var direct = 0.0;
  var filtered = 0.0;
  // A shared density integration site serves both the local prefix and the
  // complete fallback ray, avoiding duplicated material expansion.
  for (var iteration = 0; iteration < passes; iteration++) {
    let local = prefix && iteration == 0;
    let distance = select(exit, min(cached.z, exit), local);
    let count = select(requested, 2, local);
    let step = distance / f32(count);
    var integral = 0.0;
    for (var i = 0; i < count; i++) {
      let delta = sun * ((f32(i) + .5) * step);
      let sample = relative + delta;
      let h = ellipsoidShellHeightFractionRTE(sample, -cloud.encodedCameraHigh, -cloud.encodedCameraLow, inner, outer);
      let world = (sample - -cloud.encodedCameraHigh) - -cloud.encodedCameraLow;
      let footprint = select(step, 0.0, local);
      integral += cloudDensityAtCoordinates(world, advanceDensityCoordinates(coordinates, delta),
        advanceCloudMorphologyCoordinate(morphology, delta), h, bottom, top, footprint) * step;
    }
    if (local) {
      filtered = integral + cached.x;
      if (cached.y >= 1.0) { return filtered; }
    } else { direct = integral; }
  }
  return mix(direct, filtered, cached.y);
}
//>>else
//>>endif
