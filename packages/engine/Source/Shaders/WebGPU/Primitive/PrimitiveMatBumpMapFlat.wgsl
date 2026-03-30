// PrimitiveMatBumpMapFlat.wgsl
// Bump map material, no lighting
// Bump mapping requires normals and lighting to be visible — flat variant
// outputs a subtle grayscale height visualization from the bump texture
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + st(2) = 8 floats = 32 bytes
// Matches CesiumJS Material.BumpMapType: image, channel, strength, repeat

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
    channel: f32,  // 0=r, 1=g, 2=b, 3=a
    strength: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(0) var textureSampler: sampler;
@group(1) @binding(1) var bumpTexture: texture_2d<f32>;

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - uniforms.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - uniforms.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

fn extractChannel(texColor: vec4<f32>, ch: f32) -> f32 {
    let c = i32(ch);
    if (c == 0) { return texColor.r; }
    if (c == 1) { return texColor.g; }
    if (c == 2) { return texColor.b; }
    return texColor.a;
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
    // Without lighting, bump mapping has no visible effect
    // Show a subtle height visualization as grayscale
    let uv = fract(input.texCoord * uniforms.repeat);
    let texColor = textureSample(bumpTexture, textureSampler, uv);
    let h = extractChannel(texColor, uniforms.channel);
    let gray = mix(0.5, h, uniforms.strength * 0.3);
    return vec4<f32>(gray, gray, gray, 1.0);
}
