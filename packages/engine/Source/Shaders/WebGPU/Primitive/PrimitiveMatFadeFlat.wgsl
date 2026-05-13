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
    // DP-H41 (Batch 27) — previous frame's viewProjection for
    // TAA / motion-vector reprojection. Sourced from
    // `UniformState._previousViewProjection` (f32 mat4).
    previousViewProjection: mat4x4<f32>,
}

// Material.FadeType fabric: { fadeInColor, fadeOutColor, maximumDistance,
// repeat: bool, fadeDirection: {x,y:bool}, time: Cart2 }. Fabric order
// is preserved here; `repeat` is packed as f32 (0.0/1.0) and
// `fadeDirection` as vec2<f32> (0.0/1.0). Matches upstream FadeMaterial.glsl.
struct MaterialUniforms {
    fadeInColor: vec4<f32>,
    fadeOutColor: vec4<f32>,
    maximumDistance: f32,
    fadeRepeat: f32,
    fadeDirection: vec2<f32>,
    time: vec2<f32>,
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

// Mirrors getTime() in Shaders/Materials/FadeMaterial.glsl — measures
// the distance between the animation time axis-coordinate and the
// per-texel st coord, optionally wrapping when `repeat` is on.
fn getFadeTime(t: f32, coord: f32) -> f32 {
    let scalar = 1.0 / max(material.maximumDistance, 0.001);
    var q = abs(t - coord) * scalar;
    if (material.fadeRepeat > 0.5) {
        let r = abs(t - (coord + 1.0)) * scalar;
        let s = abs(t - (coord - 1.0)) * scalar;
        q = min(min(r, s), q);
    }
    return clamp(q, 0.0, 1.0);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let st = input.texCoord;
    let s = getFadeTime(material.time.x, st.x) * material.fadeDirection.x;
    let tAxis = getFadeTime(material.time.y, st.y) * material.fadeDirection.y;
    let u = length(vec2<f32>(s, tAxis));
    return mix(material.fadeInColor, material.fadeOutColor, u);
}
