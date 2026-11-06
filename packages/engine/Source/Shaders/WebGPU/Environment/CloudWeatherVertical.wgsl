//>>ifdef CLOUD_WEATHER_VERTICAL
// Heights occupy a separate weather-array plane. Decode before interpolation:
// packed byte carries and missing intervals cannot be filtered as color data.
fn cloudVerticalTap(source: texture_2d_array<f32>, texel: vec2<i32>) -> vec3<f32> {
  let dimensions = vec2<i32>(textureDimensions(source, 0));
  let position = vec2<i32>(
    ((texel.x % dimensions.x) + dimensions.x) % dimensions.x,
    clamp(texel.y, 0, dimensions.y - 1),
  );
  let packed = round(textureLoad(source, position, 1, 0) * 255.0);
  let base = dot(packed.rg, vec2<f32>(0.5, 128.0));
  let top = dot(packed.ba, vec2<f32>(0.5, 128.0));
  let support = select(0.0, 1.0, top >= base + 1.0);
  return vec3<f32>(base * support, top * support, support);
}

fn cloudVerticalMoments(source: texture_2d_array<f32>, uv: vec2<f32>) -> vec3<f32> {
  if (textureNumLayers(source) < 2u) { return vec3<f32>(0.0); }
  let dimensions = vec2<f32>(textureDimensions(source, 0));
  let position = vec2<f32>(fract(uv.x), clamp(uv.y, 0.0, 1.0)) * dimensions - vec2<f32>(0.5);
  let low = vec2<i32>(floor(position));
  let fraction = fract(position);
  let north = mix(cloudVerticalTap(source, low),
    cloudVerticalTap(source, low + vec2<i32>(1, 0)), fraction.x);
  let south = mix(cloudVerticalTap(source, low + vec2<i32>(0, 1)),
    cloudVerticalTap(source, low + vec2<i32>(1, 1)), fraction.x);
  return mix(north, south, fraction.y);
}

fn cloudRegionalVerticalMoments(worldPos: vec3<f32>) -> vec3<f32> {
  if (cloud.weatherMapEnabled <= 0.5) { return vec3<f32>(0.0); }
  let uv = worldToWeatherUV(worldPos);
//>>ifdef CLOUD_WEATHER_TRANSITION
  let weight = clamp(cloud.weatherTransitionWeight, 0.0, 1.0);
  if (weight <= 0.0) { return cloudVerticalMoments(previousWeatherTex, uv); }
  let current = cloudVerticalMoments(weatherTex, uv);
  if (weight >= 1.0) { return current; }
  return mix(cloudVerticalMoments(previousWeatherTex, uv), current, weight);
//>>else
  return cloudVerticalMoments(weatherTex, uv);
//>>endif
}

// Return normalized material height and vertical density gradient. Unknown
// observations preserve the configured shell instead of becoming clear sky.
fn cloudVerticalGradient(height: f32, shape: f32, anvil: f32) -> f32 {
  if (height < 0.0 || height > 1.0) { return 0.0; }
  return heightGradientFor(height, shape, anvil);
}

fn cloudRegionalProfileFromMoments(
  altitude: f32, channels: WeatherChannels, moments: vec3<f32>,
) -> vec2<f32> {
  let fallbackHeight = (altitude - cloud.cloudLayerBottom) /
    max(cloud.cloudLayerTop - cloud.cloudLayerBottom, 1.0);
  let shiftedHeight = clamp((fallbackHeight - channels.baseShiftFrac) /
    max(1.0 - channels.baseShiftFrac, 1e-3), 0.0, 1.0);
  let fallbackGradient = cloudVerticalGradient(shiftedHeight, channels.perGenusShape, cloud.anvilBias) *
    select(0.0, 1.0, fallbackHeight >= 0.0 && fallbackHeight <= 1.0);
  if (moments.z <= 0.0) { return vec2<f32>(clamp(fallbackHeight, 0.0, 1.0), fallbackGradient); }
  let heights = moments.xy / moments.z;
  let localHeight = (altitude - heights.x) / max(heights.y - heights.x, 1.0);
  let localGradient = cloudVerticalGradient(localHeight, channels.perGenusShape, cloud.anvilBias);
  return mix(vec2<f32>(clamp(fallbackHeight, 0.0, 1.0), fallbackGradient),
    vec2<f32>(clamp(localHeight, 0.0, 1.0), localGradient), clamp(moments.z, 0.0, 1.0));
}

fn cloudRegionalProfile(worldPos: vec3<f32>, altitude: f32, channels: WeatherChannels) -> vec2<f32> {
  return cloudRegionalProfileFromMoments(altitude, channels, cloudRegionalVerticalMoments(worldPos));
}
//>>else
//>>endif
