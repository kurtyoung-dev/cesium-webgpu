//>>ifdef CLOUD_DENSITY_MOMENTS
@group(0) @binding(14) var cloudDensityMomentsTex: texture_3d<f32>;

struct CloudDistantDensity {
  moments: vec4<f32>,
  densityFactor: f32,
  blend: f32,
}

fn cloudDistantDensityAt(
  worldPos: vec3<f32>, heightFraction: f32,
  deckBottom: f32, deckTop: f32,
  footprintMeters: f32, rayDir: vec3<f32>,
) -> CloudDistantDensity {
  let period = 1.0 / max(CLOUD_DENSITY_WORLD_TO_NOISE * cloud.puffSize, 1e-8);
  let up = normalize(worldPos / (cloudShellAxes(0.0) * cloudShellAxes(0.0)));
  var blend = cloudDistantDensityWeight(footprintMeters, period, dot(rayDir, up));
  var coverage = cloud.coverage;
  var weather = WeatherChannels(1.0, 0.0, cloud.profileShape);
  if (blend <= 0.0) {
    return CloudDistantDensity(vec4<f32>(0.0), 0.0, 0.0);
  }
  if (cloud.weatherMapEnabled > 0.5) {
    let sample = textureSampleLevel(
      weatherTex, weatherSampler, worldToWeatherUV(worldPos), 0, 0.0
    );
    coverage = clamp(sample.r * cloud.weatherStrength, 0.0, 1.0);
    weather = decodeWeatherChannels(sample.gba, deckTop - deckBottom);
  }
  let height = clamp(
    (heightFraction - weather.baseShiftFrac) / max(1.0 - weather.baseShiftFrac, 1e-3),
    0.0, 1.0
  );
  let gradient = heightGradientFor(height, weather.perGenusShape, cloud.anvilBias);
  let erosionDepth = cloud.erosionStrength * (1.0 - heightFraction);
  // Values outside the prepared material domain retain the detailed field.
  if (erosionDepth < 0.0 || erosionDepth > 1.0) { blend = 0.0; }
  let size = vec3<f32>(textureDimensions(cloudDensityMomentsTex));
  let parameters = clamp(vec3<f32>(coverage, gradient, erosionDepth), vec3<f32>(0.0), vec3<f32>(1.0));
  let uvw = (parameters * (size - vec3<f32>(1.0)) + vec3<f32>(0.5)) / size;
  let moments = textureSampleLevel(cloudDensityMomentsTex, cloudNoiseSampler, uvw, 0.0);
  return CloudDistantDensity(
    moments, cloud.densityMultiplier * cloud.profileDensityScale * weather.densityScale, blend
  );
}
//>>else
//>>endif
