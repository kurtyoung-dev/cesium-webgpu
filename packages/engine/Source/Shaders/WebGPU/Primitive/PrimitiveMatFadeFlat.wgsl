// PrimitiveMatFadeFlat.wgsl
// Fade (gradient) material, no lighting
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + st(2) = 8 floats = 32 bytes
// Matches CesiumJS Material.FadeType: fadeInColor, fadeOutColor, maximumDistance, repeat, offset, time

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
}

struct MaterialUniforms {
    fadeInColor: vec4<f32>,
    fadeOutColor: vec4<f32>,
    maximumDistance: f32,
    fadeRepeat: f32,
    fadeOffset: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - camera.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - camera.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let eyePos = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.position = camera.mvpRelativeToEye * eyePos;
    output.texCoord = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // Distance-based gradient from center of UV space
    let dist = length(input.texCoord - vec2<f32>(0.5));
    var t = (dist + material.fadeOffset) / max(material.maximumDistance, 0.001);

    // Repeat wraps the gradient when > 1.0
    if (material.fadeRepeat > 0.5) {
        t = fract(t);
    } else {
        t = clamp(t, 0.0, 1.0);
    }

    return mix(material.fadeInColor, material.fadeOutColor, vec4<f32>(t));
}
