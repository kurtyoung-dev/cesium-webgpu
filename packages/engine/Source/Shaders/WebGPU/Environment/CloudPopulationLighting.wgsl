//>>ifdef CLOUD_WEATHER_POPULATIONS
fn cloudPopulationUnionBounds() -> vec2<f32> {
  return vec2<f32>(min(cloud.deckBoundsLow.x, min(cloud.deckBoundsMid.x, cloud.deckBoundsHigh.x)),
    max(cloud.deckBoundsLow.y, max(cloud.deckBoundsMid.y, cloud.deckBoundsHigh.y)));
}

fn cloudPopulationLightDepth(relative: vec3<f32>, sunDir: vec3<f32>) -> f32 {
  let bounds = cloudPopulationUnionBounds();
  let exit = rayEllipsoidIntersectRTE(sunDir, -cloud.encodedCameraHigh,
    -cloud.encodedCameraLow - relative, cloudShellAxes(bounds.y));
  if (exit.y <= 0.0) { return 0.0; }
  let steps = clamp(i32(cloud.lightSteps * cloud.lightSampleScale), 1, 16);
  var depth = 0.0;
  for (var i = 0; i < steps; i++) {
    let a = cloudMarchIntervalBoundary(f32(i), f32(steps), exit.y, 0.0, bounds.y - bounds.x, 3.0);
    let b = cloudMarchIntervalBoundary(f32(i + 1), f32(steps), exit.y, 0.0, bounds.y - bounds.x, 3.0);
    depth += cloudPopulationTotalDensity(relative + sunDir * ((a + b) * 0.5), b - a) * (b - a);
  }
  return depth;
}

fn cloudPopulationAmbientColors(worldPos: vec3<f32>, sunDir: vec3<f32>) -> array<vec3<f32>, 2> {
  var sky = cloud.skyAmbientColor;
  var ground = cloud.groundAmbientColor;
  if ((u32(cloud.qualityFlags) & QF_AMBIENT_LUT) != 0u) {
    let up = normalize(worldPos);
    let weight = cloudAmbientSkyViewWeight(up, sunDir);
    if (weight > 0.0) {
      let skyHDR = cloudSampleSkyViewLut(up, up, sunDir) + cloudSampleMultipleScatterLut(up, up, sunDir);
      let skyLum = cloudLutLuminance(skyHDR);
      if (skyLum > 1e-5) {
        let groundHDR = cloudSampleSkyViewLut(up, -up, sunDir) + cloudSampleMultipleScatterLut(up, -up, sunDir);
        sky = mix(sky, skyHDR / skyLum * cloudLutLuminance(cloud.skyAmbientColor), weight);
        ground = mix(ground, groundHDR / max(cloudLutLuminance(groundHDR), 1e-5) *
          cloudLutLuminance(cloud.groundAmbientColor), weight);
      }
    }
  }
  return array<vec3<f32>, 2>(ground, sky);
}

fn cloudIntegratePopulationMedium(medium: vec4<f32>, distance: f32, transmission: f32) -> vec4<f32> {
  if (medium.a <= 0.0 || distance <= 0.0) { return vec4<f32>(0.0); }
  let weight = (1.0 - exp(-medium.a * distance)) * transmission;
  return vec4<f32>(medium.rgb * (weight / medium.a), weight);
}

fn cloudPopulationShadowDepth(input: VertexOutput) -> f32 {
  let bounds = cloudPopulationUnionBounds();
  let ndc = vec3<f32>(input.uv.x * 2.0 - 1.0, 1.0 - input.uv.y * 2.0, 0.0);
  let columnH = cloudShadow.sunViewInvVpRelativeToEye * vec4<f32>(ndc, 1.0);
  let column = columnH.xyz / columnH.w;
  let direction = -normalize(cloudShadow.sunDirAndSteps.xyz);
  let centerHigh = -cloud.encodedCameraHigh;
  let centerLow = -cloud.encodedCameraLow - column;
  let outer = rayEllipsoidIntersectRTE(direction, centerHigh, centerLow, cloudShellAxes(bounds.y));
  let inner = rayEllipsoidIntersectRTE(direction, centerHigh, centerLow, cloudShellAxes(bounds.x));
  let start = max(outer.x, 0.0);
  let end = select(outer.y, min(outer.y, inner.x), inner.x > start);
  if (end <= start) { return 0.0; }
  let steps = max(2, i32(cloudShadow.sunDirAndSteps.w));
  let distance = (end - start) / f32(steps);
  var depth = 0.0;
  for (var i = 0; i < steps; i++) {
    depth += cloudPopulationTotalDensity(column + direction * (start + (f32(i) + 0.5) * distance), distance) * distance;
  }
  return clamp(depth, 0.0, 8000.0);
}
//>>else
//>>endif
