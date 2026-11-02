//>>ifdef CLOUD_DEEP_SHADOW_CACHE
struct CloudDeepShadowFrame {
  originHigh: vec3<f32>, enabled: f32,
  originLow: vec3<f32>, halfExtent: f32,
  right: vec3<f32>, rowStart: u32,
  up: vec3<f32>, rowCount: u32,
  sun: vec3<f32>, nodes: u32,
  control: vec4<f32>,
  rowValidity: vec4<f32>,
}
@group(0) @binding(22) var cloudDeepShadowTexture: texture_3d<f32>;
@group(0) @binding(23) var<uniform> cloudDeepShadowFrame: CloudDeepShadowFrame;

fn cloudDeepShadowOriginRelative() -> vec3<f32> {
  return (cloudDeepShadowFrame.originHigh - cloud.encodedCameraHigh) +
    (cloudDeepShadowFrame.originLow - cloud.encodedCameraLow);
}
fn cloudDeepShadowShell(origin: vec3<f32>, bounds: vec2<f32>) -> vec2<f32> {
  let high = -cloud.encodedCameraHigh;
  let low = -cloud.encodedCameraLow - origin;
  let outer = rayEllipsoidIntersectRTE(cloudDeepShadowFrame.sun, high, low, cloudShellAxes(bounds.y));
  let inner = rayEllipsoidIntersectRTE(cloudDeepShadowFrame.sun, high, low, cloudShellAxes(bounds.x));
  return vec2<f32>(inner.y, outer.y);
}
fn cloudDeepShadowCoordinate(uv: vec2<f32>, fraction: f32, deck: f32) -> vec3<f32> {
  let dims = vec3<f32>(textureDimensions(cloudDeepShadowTexture));
  let nodes = f32(cloudDeepShadowFrame.nodes);
  return vec3<f32>((uv * (dims.xy - vec2<f32>(1.0)) + .5) / dims.xy,
    (deck * nodes + clamp(fraction, 0.0, 1.0) * (nodes - 1.0) + .5) / dims.z);
}
fn cloudDeepShadowRead(relative: vec3<f32>, bottom: f32, top: f32, prefix: f32) -> vec3<f32> {
  if (cloudDeepShadowFrame.enabled < .5) { return vec3<f32>(0.0); }
  let delta = relative - cloudDeepShadowOriginRelative();
  let uv = vec2<f32>(dot(delta, cloudDeepShadowFrame.right), dot(delta, cloudDeepShadowFrame.up)) /
    (2.0 * cloudDeepShadowFrame.halfExtent) + .5;
  if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return vec3<f32>(0.0); }
  var deck = 0.0;
  if (multiDeckEnabled()) {
    if (bottom == cloud.deckBoundsMid.x && top == cloud.deckBoundsMid.y) { deck = 1.0; }
    if (bottom == cloud.deckBoundsHigh.x && top == cloud.deckBoundsHigh.y) { deck = 2.0; }
  }
  let header = textureSampleLevel(cloudDeepShadowTexture, cloudNoiseSampler,
    cloudDeepShadowCoordinate(uv, 0.0, deck), 0.0);
  if (header.a <= 1e-6 || header.z <= 0.0) { return vec3<f32>(0.0); }
  let span = header.z * 1000.0 / header.a;
  let distance = header.y * 1000.0 / header.a - dot(delta, cloudDeepShadowFrame.sun);
  // The stored geometry is half precision; admit its bounded rounding margin
  // before clipping a point at an exact shell boundary.
  let margin = max(1.0, .0015 * max(span, abs(header.y * 1000.0 / header.a)));
  if (distance < -margin || distance > span + margin) { return vec3<f32>(0.0); }
  let remaining = clamp(distance, 0.0, span);
  let near = min(max(prefix, 0.0), remaining);
  let value = textureSampleLevel(cloudDeepShadowTexture, cloudNoiseSampler,
    cloudDeepShadowCoordinate(uv, (remaining - near) / span, deck), 0.0);
  if (value.a <= 1e-6) { return vec3<f32>(0.0); }
  let edge = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
  let world = (relative - -cloud.encodedCameraHigh) - -cloud.encodedCameraLow;
  let sunlight = smoothstep(.2, .3, dot(normalize(world), cloudDeepShadowFrame.sun));
  let support = sunlight * smoothstep(0.0, 1.0, value.a) *
    smoothstep(0.0, 2.0 / f32(textureDimensions(cloudDeepShadowTexture).x), edge);
  return vec3<f32>(max(value.x, 0.0) * 1000.0 / value.a, support, near);
}
//>>else
//>>endif
