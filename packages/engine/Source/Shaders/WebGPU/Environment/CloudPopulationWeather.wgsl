//>>ifdef CLOUD_WEATHER_POPULATIONS
struct CloudPopulationWeather {
  control: vec4<f32>,
  heights: vec3<f32>,
  coverageSupport: f32,
};

fn cloudPopulationFallbackBounds(population: i32) -> vec2<f32> {
  if (population == 1) { return vec2<f32>(2000.0, 7000.0); }
  if (population == 2) { return vec2<f32>(5000.0, 13000.0); }
  return vec2<f32>(0.0, 2000.0);
}

fn cloudPopulationBounds(population: i32) -> vec2<f32> {
  if (population == 1) { return cloud.deckBoundsMid; }
  if (population == 2) { return cloud.deckBoundsHigh; }
  return cloud.deckBoundsLow;
}

fn cloudPopulationTap(
  source: texture_2d_array<f32>, texel: vec2<i32>, population: i32,
) -> CloudPopulationWeather {
  let size = vec2<i32>(textureDimensions(source, 0));
  let position = vec2<i32>(((texel.x % size.x) + size.x) % size.x, clamp(texel.y, 0, size.y - 1));
  let plane = 2 + population * 3;
  let support = textureLoad(source, position, plane + 2, 0).rg;
  let encoded = round(textureLoad(source, position, plane + 1, 0) * 255.0);
  let heights = vec2<f32>(dot(encoded.rg, vec2<f32>(0.5, 128.0)),
    dot(encoded.ba, vec2<f32>(0.5, 128.0)));
  let heightSupport = support.y * select(0.0, 1.0, heights.y >= heights.x + 1.0);
  return CloudPopulationWeather(textureLoad(source, position, plane, 0) * support.x,
    vec3<f32>(heights * heightSupport, heightSupport), support.x);
}

fn cloudPopulationFromTexture(
  source: texture_2d_array<f32>, uv: vec2<f32>, population: i32,
) -> CloudPopulationWeather {
  var fallback = textureSampleLevel(source, weatherSampler, uv, 0, 0.0);
  if (textureNumLayers(source) < 11u) { return CloudPopulationWeather(fallback, vec3<f32>(0.0), 0.0); }
  let position = vec2<f32>(fract(uv.x), clamp(uv.y, 0.0, 1.0)) *
    vec2<f32>(textureDimensions(source, 0)) - vec2<f32>(0.5);
  let low = vec2<i32>(floor(position));
  let fraction = fract(position);
  let a = cloudPopulationTap(source, low, population);
  let b = cloudPopulationTap(source, low + vec2<i32>(1, 0), population);
  let c = cloudPopulationTap(source, low + vec2<i32>(0, 1), population);
  let d = cloudPopulationTap(source, low + vec2<i32>(1, 1), population);
  let support = mix(mix(a.coverageSupport, b.coverageSupport, fraction.x),
    mix(c.coverageSupport, d.coverageSupport, fraction.x), fraction.y);
  let controlMoment = mix(mix(a.control, b.control, fraction.x), mix(c.control, d.control, fraction.x), fraction.y);
  let heights = mix(mix(a.heights, b.heights, fraction.x), mix(c.heights, d.heights, fraction.x), fraction.y);
  let control = mix(fallback, controlMoment / max(support, 1e-6), clamp(support, 0.0, 1.0));
  return CloudPopulationWeather(control, heights, support);
}

fn cloudPopulationWeather(worldPos: vec3<f32>, population: i32) -> CloudPopulationWeather {
  let uv = worldToWeatherUV(worldPos);
  let current = cloudPopulationFromTexture(weatherTex, uv, population);
//>>ifdef CLOUD_WEATHER_TRANSITION
  let weight = clamp(cloud.weatherTransitionWeight, 0.0, 1.0);
  if (weight >= 1.0) { return current; }
  let previous = cloudPopulationFromTexture(previousWeatherTex, uv, population);
  return CloudPopulationWeather(mix(previous.control, current.control, weight),
    mix(previous.heights, current.heights, weight), mix(previous.coverageSupport, current.coverageSupport, weight));
//>>else
  return current;
//>>endif
}

fn cloudPopulationProfile(
  altitude: f32, channels: WeatherChannels, weather: CloudPopulationWeather, population: i32,
) -> vec2<f32> {
  let bounds = cloudPopulationFallbackBounds(population);
  let fallbackHeight = (altitude - bounds.x) / max(bounds.y - bounds.x, 1.0);
  let shifted = clamp((fallbackHeight - channels.baseShiftFrac) / max(1.0 - channels.baseShiftFrac, 1e-3), 0.0, 1.0);
  let fallback = vec2<f32>(clamp(fallbackHeight, 0.0, 1.0),
    cloudVerticalGradient(shifted, channels.perGenusShape, cloud.anvilBias) *
    select(0.0, 1.0, fallbackHeight >= 0.0 && fallbackHeight <= 1.0));
  if (weather.heights.z <= 0.0) { return fallback; }
  let heights = weather.heights.xy / weather.heights.z;
  let localHeight = (altitude - heights.x) / max(heights.y - heights.x, 1.0);
  let local = vec2<f32>(clamp(localHeight, 0.0, 1.0),
    cloudVerticalGradient(localHeight, channels.perGenusShape, cloud.anvilBias));
  return mix(fallback, local, clamp(weather.heights.z, 0.0, 1.0));
}

fn cloudCoordinatesForPopulation(coordinates: CloudDensityCoordinates, population: i32) -> CloudDensityCoordinates {
  var result = advanceCloudDensityCoordinates(coordinates, vec3<f32>(17.0, 53.0, 97.0) * f32(population), cloud.puffSize);
  result.population = population;
  return result;
}

fn cloudPopulationMacro(relative: vec3<f32>, population: i32, footprint: f32) -> CloudMacroSample {
  let bounds = cloudPopulationBounds(population);
  let centerHigh = -cloud.encodedCameraHigh;
  let centerLow = -cloud.encodedCameraLow;
  let worldPos = (relative - centerHigh) - centerLow;
  var height: f32;
  if (highPrecisionEnabled()) {
    height = ellipsoidShellHeightFractionRTE(relative, centerHigh, centerLow,
      vec3<f32>(1.0) / cloudShellAxes(bounds.x), vec3<f32>(1.0) / cloudShellAxes(bounds.y));
  } else {
    height = ellipsoidShellHeightFraction(worldPos, vec3<f32>(1.0) / cloudShellAxes(bounds.x),
      vec3<f32>(1.0) / cloudShellAxes(bounds.y));
  }
  let innerScaled = worldPos / cloudShellAxes(bounds.x);
  let outerScaled = worldPos / cloudShellAxes(bounds.y);
  if (dot(innerScaled, innerScaled) < 1.0 || dot(outerScaled, outerScaled) > 1.0) {
    return CloudMacroSample(0.0, 0.0, cloudCoordinatesForPopulation(cloudDensityCoordinatesAtRelative(relative), population),
      vec3<f32>(0.0), 0.0, 0.0);
  }
  var coordinates = cloudDensityCoordinatesAtRelative(relative);
  var morphology = cloudMorphologyCoordinateAtRelative(relative);
  if (!planetDensityEnabled() || !noiseBakedEnabled()) {
    coordinates = cloudDensityCoordinatesAtWorld(worldPos, cloudWindOffset());
    morphology = cloudMorphologyCoordinateAtWorld(worldPos, cloudWindOffset());
  }
  coordinates = cloudCoordinatesForPopulation(coordinates, population);
  return cloudMacroSampleAt(worldPos, coordinates,
    morphology + vec3<f32>(17.0, 53.0, 97.0) * f32(population),
    height, bounds.x, bounds.y, footprint);
}

fn cloudPopulationDensity(relative: vec3<f32>, population: i32, footprint: f32) -> f32 {
  let macroSample = cloudPopulationMacro(relative, population, footprint);
  return cloudDensityFromMacro(macroSample, macroSample.profileHeight);
}

fn cloudPopulationTotalDensity(relative: vec3<f32>, footprint: f32) -> f32 {
  var density = 0.0;
  for (var population = 0; population < 3; population++) {
    density += cloudPopulationDensity(relative, population, footprint);
  }
  return density;
}
 //>>else
 //>>endif
