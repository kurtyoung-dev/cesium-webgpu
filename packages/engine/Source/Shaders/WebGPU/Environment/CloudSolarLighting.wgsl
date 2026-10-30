fn cloudSolarDiskVisibility(clearance: f32, angularRadius: f32) -> f32 {
  let x = clearance / max(angularRadius, 1e-6);
  if (x <= -1.0) { return 0.0; }
  if (x >= 1.0) { return 1.0; }
  return (acos(-x) + x * sqrt(max(1.0 - x * x, 0.0))) / PI;
}

fn cloudSunVisibility(worldPos: vec3<f32>, sunDir: vec3<f32>) -> f32 {
  let axes = cloudShellAxes(0.0);
  let scaledPos = worldPos / axes;
  let radius = length(scaledPos);
  let scaledUp = scaledPos / max(radius, 1.0);
  let direction = sunDir / axes;
  let scaledSun = normalize(direction);
  let mu = dot(scaledUp, scaledSun);
  if (mu > 0.01) { return 1.0; }
  let dipSine = sqrt(max(1.0 - 1.0 / max(radius * radius, 1.0), 0.0));
  if (mu < -dipSine - 0.01) { return 0.0; }
  let clearance = asin(clamp(mu, -1.0, 1.0)) +
    acos(clamp(1.0 / max(radius, 1.0), 0.0, 1.0));
  // The ellipsoid transform stretches the disk along its local horizon normal.
  let gradient = ((scaledUp - mu * scaledSun) / axes) / length(direction);
  let angularScale = length(gradient) / sqrt(max(1.0 - mu * mu, 1e-6));
  return cloudSolarDiskVisibility(clearance, 0.00465 * angularScale);
}

fn cloudLocalDaylight(worldPos: vec3<f32>, sunDir: vec3<f32>) -> f32 {
  let axes = cloudShellAxes(0.0);
  let mu = dot(normalize(worldPos / (axes * axes)), sunDir);
  return mix(0.002, 1.0, smoothstep(-0.07, 0.035, mu));
}

fn cloudLocalSunlight(worldPos: vec3<f32>, sunDir: vec3<f32>) -> vec3<f32> {
  let axes = cloudShellAxes(0.0);
  let mu = dot(normalize(worldPos / (axes * axes)), sunDir);
  let noon = smoothstep(0.0, 0.35, mu);
  return mix(vec3<f32>(1.0, 0.55, 0.25), vec3<f32>(1.0, 1.0, 0.98), noon) *
    cloudSunVisibility(worldPos, sunDir);
}
