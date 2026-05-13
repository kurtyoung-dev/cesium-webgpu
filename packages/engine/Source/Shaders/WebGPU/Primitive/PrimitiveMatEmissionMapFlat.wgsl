// PrimitiveMatEmissionMapFlat.wgsl
// Emission map material, no lighting (self-illuminated)
// Outputs texture color directly — the surface emits light
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + st(2) = 8 floats = 32 bytes
// Matches CesiumJS Material.EmissionMapType: image, channels, repeat

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
        previousViewProjection: mat4x4<f32>,
}

// Material.EmissionMapType fabric: { image: str, channels: "rgb", repeat: Cart2 }.
// `channels` packs as vec3<f32> indices (r=0, g=1, b=2, a=3) so the
// shader can swizzle at runtime. Fabric order: channels, repeat.
struct MaterialUniforms {
    channels: vec3<f32>,
    repeat: vec2<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(2) @binding(0) var textureSampler: sampler;
@group(2) @binding(1) var emissionTexture: texture_2d<f32>;

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

fn swizzleChannel(c: vec4<f32>, idx: f32) -> f32 {
    return c[clamp(i32(idx), 0, 3)];
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // EmissionMap has no material `color` field. Emit the texture
    // swizzled by the fabric-specified channels (default "rgb").
    let uv = input.texCoord * material.repeat;
    let texColor = textureSample(emissionTexture, textureSampler, uv);
    let ex = swizzleChannel(texColor, material.channels.x);
    let ey = swizzleChannel(texColor, material.channels.y);
    let ez = swizzleChannel(texColor, material.channels.z);
    return vec4<f32>(ex, ey, ez, texColor.a);
}
