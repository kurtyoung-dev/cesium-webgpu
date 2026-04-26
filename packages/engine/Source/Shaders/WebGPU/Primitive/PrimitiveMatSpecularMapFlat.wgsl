// PrimitiveMatSpecularMapFlat.wgsl
// Specular map material, flat variant (no lighting)
// Without lighting, specular has no effect — outputs base color only.
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + st(2) = 8 floats = 32 bytes
// Matches CesiumJS Material.SpecularMapType: image, channel, repeat

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

struct CameraUniforms {
    mvpRelativeToEye: mat4x4<f32>,
    encodedCameraHigh: vec3<f32>,
    _pad0: f32,
    encodedCameraLow: vec3<f32>,
    _pad1: f32,
    _pad2: f32,
    // DP-H41 (Batch 27) — previous frame's viewProjection for
    // TAA / motion-vector reprojection. Sourced from
    // `UniformState._previousViewProjection` (f32 mat4).
    previousViewProjection: mat4x4<f32>,
}

// Material.SpecularMapType fabric: { image: str, channel: "r", repeat: Cart2 }.
// `channel` is packed as an f32 index by MaterialUniformBuffer
// (r=0, g=1, b=2, a=3). Fabric order: channel, repeat.
struct MaterialUniforms {
    channel: f32,
    repeat: vec2<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(2) @binding(0) var textureSampler: sampler;
@group(2) @binding(1) var specularTexture: texture_2d<f32>;

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - camera.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - camera.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let posRTE = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.position = camera.mvpRelativeToEye * posRTE;
    output.texCoord = input.texCoord;
    return output;
}

fn extractChannel(c: vec4<f32>, idx: f32) -> f32 {
    return c[clamp(i32(idx), 0, 3)];
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // Flat variant: specular map has no visible effect without lighting.
    // SpecularMap fabric has no `color` — render a grayscale
    // visualization of the spec intensity channel.
    let uv = input.texCoord * material.repeat;
    let texColor = textureSample(specularTexture, textureSampler, uv);
    let spec = extractChannel(texColor, material.channel);
    return vec4<f32>(spec, spec, spec, 1.0);
}
