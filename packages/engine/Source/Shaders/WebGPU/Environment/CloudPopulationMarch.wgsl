//>>ifdef CLOUD_WEATHER_POPULATIONS
// Overlapping media share one integration step and one view transmittance.
// Their extinction-weighted source terms add before Beer integration.
fn marchPopulationClouds(
  rayOrigin: vec3<f32>, rayDir: vec3<f32>, sceneDepth: f32,
  centerHigh: vec3<f32>, centerLow: vec3<f32>, samplePhase: f32,
) -> DeckResult {
  var result: DeckResult;
  result.hazed = vec3<f32>(0.0); result.alpha = 0.0;
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
  result.frontDistance = -1.0; result.weightedDistanceSum = 0.0;
//>>else
//>>endif
  let bounds = cloudPopulationUnionBounds();
  let inner = rayEllipsoidIntersectRTE(rayDir, centerHigh, centerLow, cloudShellAxes(bounds.x));
  let outer = rayEllipsoidIntersectRTE(rayDir, centerHigh, centerLow, cloudShellAxes(bounds.y));
  if (outer.y <= 0.0) { return result; }
  var start = max(outer.x, 0.0);
  var end = outer.y;
  if (cloud.cameraGeodeticHeight < bounds.x) { start = max(inner.y, 0.0); }
  else if (inner.x > start) { end = min(end, inner.x); }
  if (sceneDepth < 0.999999) {
    let forward = normalize(-cloud.inverseView[2].xyz);
    end = min(end, logDepthToEyeDistance(sceneDepth, cloud.nearPlane, cloud.farPlane) / max(dot(rayDir, forward), 1e-6));
  }
  if (cloud.maxRayDistance > 0.0) { end = min(end, cloud.maxRayDistance); }
  if (end <= start) { return result; }
  let steps = clamp(i32(cloud.maxSteps), 1, 256);
  let sunDir = normalize(cloud.sunDirection);
  let cosTheta = dot(rayDir, sunDir);
  var transmission = 1.0;
  var color = vec3<f32>(0.0);
  var distanceMoment = 0.0;
  var altitudeMoment = 0.0;
  let thickness = bounds.y - bounds.x;
  for (var i = 0; i < steps; i++) {
    if (transmission < 0.01) { break; }
    let a = start + cloudMarchIntervalBoundary(f32(i), f32(steps), end - start, start, thickness, 0.0);
    let b = start + cloudMarchIntervalBoundary(f32(i + 1), f32(steps), end - start, start, thickness, 0.0);
    let distance = mix(a, b, samplePhase);
    let relative = rayDir * distance;
    let worldPos = (relative - centerHigh) - centerLow;
    let footprint = cloudViewPixelFootprint(distance, cloud.inverseProjection[1].y, cloud.resolution.y);
    var ambientColors = array<vec3<f32>, 2>(vec3<f32>(0.0), vec3<f32>(0.0));
    var solarSource = vec3<f32>(0.0);
    var silverSource = vec3<f32>(0.0);
    var ambientSource = vec3<f32>(0.0);
    var sigma = 0.0;
    let sampleAltitude = mix(bounds.x, bounds.y, ellipsoidShellHeightFractionRTE(relative, centerHigh, centerLow,
      vec3<f32>(1.0) / cloudShellAxes(bounds.x), vec3<f32>(1.0) / cloudShellAxes(bounds.y)));
    for (var population = 0; population < 3; population++) {
      let macroSample = cloudPopulationMacro(relative, population, footprint);
      let density = cloudDensityFromMacro(macroSample, macroSample.profileHeight);
      if (density <= 0.001) { continue; }
      if (sigma <= 0.0) { ambientColors = cloudPopulationAmbientColors(worldPos, sunDir); }
      let extinction = density * effectiveAbsorption();
      let height = macroSample.profileHeight;
      let albedo = mix(cloud.cloudBaseColor, cloud.cloudTopColor, height);
      let tint = specialShadeTint(macroSample.morphologyCoordinate, height, cosTheta);
      let ambient = max(mix(ambientColors[0], ambientColors[1], height) * cloud.ambientIntensity,
        vec3<f32>(max(cloud.ambientFloor, 0.0)));
      let silver = cloud.silverLiningIntensity * pow(clamp(1.0 - density * 3.0, 0.0, 1.0), 2.0);
      solarSource += albedo * tint * extinction;
      silverSource += albedo * tint * (extinction * silver);
      ambientSource += ambient * tint * extinction;
      sigma += extinction;

    }
    if (sigma <= 0.0) { continue; }
    let sunlight = cloudLocalSunlight(worldPos, sunDir);
    var lightDepth = 0.0;
    if (dot(sunlight, sunlight) > 0.0) { lightDepth = cloudPopulationLightDepth(relative, sunDir); }
    let scatter = multiScatterLight(lightDepth, cosTheta, cloud.powderStrength, i32((u32(cloud.qualityFlags) >> QF_OCTAVES_SHIFT) & 7u));
    let medium = vec4<f32>((solarSource * scatter + silverSource) * sunlight * cloud.sunIntensity +
      ambientSource * cloudLocalDaylight(worldPos, sunDir), sigma);
    let integrated = cloudIntegratePopulationMedium(medium, b - a, transmission);
    color += integrated.rgb;
    distanceMoment += integrated.a * distance;
    altitudeMoment += integrated.a * sampleAltitude;
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
    if (result.frontDistance < 0.0 && integrated.a > 0.0) { result.frontDistance = distance; }
    result.weightedDistanceSum += integrated.a * distance;
//>>else
//>>endif
    transmission *= exp(-sigma * (b - a));
  }
  let resolved = cloudResolveDeck(rayOrigin, rayDir, sunDir, start, end, bounds.x, bounds.y,
    color, transmission, distanceMoment, altitudeMoment);
  result.alpha = resolved.a;
  result.hazed = resolved.rgb;
  return result;
}
//>>else
//>>endif
