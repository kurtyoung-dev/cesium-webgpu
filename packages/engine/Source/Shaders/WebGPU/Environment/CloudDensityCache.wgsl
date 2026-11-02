//>>ifdef CLOUD_DENSITY_SAMPLE_CACHE
struct CloudDensityCacheFrame {
  originHigh: vec3<f32>, enabled: f32,
  originLow: vec3<f32>, cellSize: f32,
  control: vec4<f32>,
}
@group(0) @binding(20) var cloudDensityCacheTexture: texture_3d<f32>;
@group(0) @binding(21) var<uniform> cloudDensityCacheFrame: CloudDensityCacheFrame;

fn cloudCachedDensity(relative: vec3<f32>, bottom: f32, top: f32, footprint: f32, height: f32) -> vec2<f32> {
  let frame = cloudDensityCacheFrame;
  if (frame.enabled < 0.5 || footprint < frame.cellSize * 0.5 || height <= 0.0 || height >= 1.0) {
    return vec2<f32>(0.0);
  }
  let high = frame.originHigh - cloud.encodedCameraHigh;
  let low = frame.originLow - cloud.encodedCameraLow;
  let grid = ((relative - high) - low) / frame.cellSize;
  let edge = min(grid, vec3<f32>(frame.control.x) - grid);
  let border = min(edge.x, min(edge.y, edge.z));
  if (border <= 1.0) { return vec2<f32>(0.0); }
  var deck = 0u;
  if (multiDeckEnabled()) {
    if (bottom == cloud.deckBoundsMid.x && top == cloud.deckBoundsMid.y) { deck = 1u; }
    if (bottom == cloud.deckBoundsHigh.x && top == cloud.deckBoundsHigh.y) { deck = 2u; }
  }
  let value = textureSampleLevel(cloudDensityCacheTexture, cloudNoiseSampler, grid / frame.control.x, 0.0);
  // Finite quadrature cannot prove absence. Clear or incomplete cells leave
  // the direct density path responsible for thin and sparsely sampled clouds.
  if (!(value[deck] > 0.0) || value.a < 0.999) { return vec2<f32>(0.0); }
  let weight = smoothstep(1.0, 3.0, border) * smoothstep(0.5, 1.5, footprint / frame.cellSize);
  return vec2<f32>(value[deck], weight);
}
//>>else
//>>endif
