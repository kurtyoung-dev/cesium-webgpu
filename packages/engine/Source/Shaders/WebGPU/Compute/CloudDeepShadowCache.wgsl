@group(1) @binding(0) var cloudDeepShadowOut: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(8, 4, 1)
fn cloudDeepShadowBuildMain(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(cloudDeepShadowOut);
  let row = id.y + cloudDeepShadowFrame.rowStart;
  if (id.x >= dims.x || id.y >= cloudDeepShadowFrame.rowCount || row >= dims.y || id.z >= 3u) { return; }
  let count = cloudDeepShadowFrame.nodes;
  if (count < 2u || count > 65u) { return; }
  var bounds = vec2<f32>(cloud.cloudLayerBottom, cloud.cloudLayerTop);
  if (multiDeckEnabled()) {
    bounds = cloud.deckBoundsLow;
    if (id.z == 1u) { bounds = cloud.deckBoundsMid; }
    if (id.z == 2u) { bounds = cloud.deckBoundsHigh; }
  }
  let uv = vec2<f32>(f32(id.x), f32(row)) / vec2<f32>(dims.xy - vec2<u32>(1u));
  let plane = (uv * 2.0 - 1.0) * cloudDeepShadowFrame.halfExtent;
  let origin = cloudDeepShadowOriginRelative() + cloudDeepShadowFrame.right * plane.x + cloudDeepShadowFrame.up * plane.y;
  let shell = cloudDeepShadowShell(origin, bounds);
  let world = (origin - -cloud.encodedCameraHigh) - -cloud.encodedCameraLow;
  let supported = bounds.y > bounds.x && shell.y > shell.x &&
    dot(normalize(world), cloudDeepShadowFrame.sun) > .2 && (multiDeckEnabled() || id.z == 0u);
  let step = max(shell.y - shell.x, 0.0) / f32(count - 1u);
  var depth = 0.0;
  for (var node = 0u; node < count; node++) {
    if (supported && node > 0u) {
      let relative = origin + cloudDeepShadowFrame.sun * (shell.y - (f32(node) - .5) * step);
      let position = (relative - -cloud.encodedCameraHigh) - -cloud.encodedCameraLow;
      let height = ellipsoidShellHeightFractionRTE(relative, -cloud.encodedCameraHigh, -cloud.encodedCameraLow,
        vec3<f32>(1.0) / cloudShellAxes(bounds.x), vec3<f32>(1.0) / cloudShellAxes(bounds.y));
      let density = cloudDensityAtCoordinates(position, cloudDensityCoordinatesAtRelative(relative),
        cloudMorphologyCoordinateAtRelative(relative), height, bounds.x, bounds.y, step);
      depth = min(depth + max(density, 0.0) * step * .001, 65504.0);
    }
    textureStore(cloudDeepShadowOut, vec3<i32>(i32(id.x), i32(row), i32(id.z * count + node)),
      select(vec4<f32>(0.0), vec4<f32>(depth, shell.y * .001, (shell.y - shell.x) * .001, 1.0), supported));
  }
}
