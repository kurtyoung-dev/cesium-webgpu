//>>ifdef CLOUD_WEATHER_TRANSITION
@group(0) @binding(29) var previousWeatherTex: texture_2d_array<f32>;

fn cloudWeatherTransitionSample(uv: vec2<f32>) -> vec4<f32> {
  let weight = clamp(cloud.weatherTransitionWeight, 0.0, 1.0);
  if (weight <= 0.0) {
    return textureSampleLevel(previousWeatherTex, weatherSampler, uv, 0, 0.0);
  }
  let current = textureSampleLevel(weatherTex, weatherSampler, uv, 0, 0.0);
  if (weight >= 1.0) { return current; }
  let previous = textureSampleLevel(previousWeatherTex, weatherSampler, uv, 0, 0.0);
  return mix(previous, current, weight);
}
//>>else
//>>endif
