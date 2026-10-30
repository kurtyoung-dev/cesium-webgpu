@group(0) @binding(0) var sceneColor: texture_2d<f32>;
@group(0) @binding(1) var cloudColor: texture_2d<f32>;

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let position = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4<f32>(position * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let pixel = vec2<i32>(position.xy);
  let scene = textureLoad(sceneColor, pixel, 0);
  let cloud = textureLoad(cloudColor, pixel, 0);
  return vec4<f32>(scene.rgb * (1.0 - cloud.a) + cloud.rgb, scene.a);
}
