// PrimitiveMatNormalMapFlat.wgsl
// Normal map material, no lighting
// Normal mapping requires lighting to be visible — flat variant shows
// the normal map as a colorized visualization
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + st(2) = 8 floats = 32 bytes
// Matches CesiumJS Material.NormalMapType: image, channels, strength, repeat

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

struct Uniforms {
    mvpRelativeToEye: mat4x4<f32>,
    encodedCameraHigh: vec3<f32>,
    _pad0: f32,
    encodedCameraLow: vec3<f32>,
    _pad1: f32,
    // Material params
    repeat: vec2<f32>,
    strength: f32,
    _pad2: f32,
    channels: vec3<f32>,  // swizzle indices: e.g. (0,1,2) = rgb
    _pad3: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(0) var textureSampler: sampler;
@group(1) @binding(1) var normalTexture: texture_2d<f32>;

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - uniforms.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - uniforms.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

// WGF-5: collapse the per-channel branch into a dynamic vector subscript.
fn swizzleChannel(texColor: vec4<f32>, idx: f32) -> f32 {
    return texColor[clamp(i32(idx), 0, 3)];
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let posRTE = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.position = uniforms.mvpRelativeToEye * posRTE;
    output.texCoord = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // Without lighting, show the normal map as a color visualization
    let uv = fract(input.texCoord * uniforms.repeat);
    let texColor = textureSample(normalTexture, textureSampler, uv);
    let nx = swizzleChannel(texColor, uniforms.channels.x);
    let ny = swizzleChannel(texColor, uniforms.channels.y);
    let nz = swizzleChannel(texColor, uniforms.channels.z);
    // Normal maps store values in [0,1], remap to show as colors
    return vec4<f32>(nx, ny, nz, 1.0);
}
