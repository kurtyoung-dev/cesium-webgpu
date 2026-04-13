// Point Primitive Pick Shader — WebGPU (with RTE precision)
// Same quad expansion as color shader, but outputs a uniform pick color
// for GPU-based object picking (readback pixel → identify object).
//
// Uses RTE (Relative-To-Eye) emulated 64-bit precision to eliminate
// jittering at planetary scale.

struct CameraUniforms {
    mvpRelativeToEye: mat4x4<f32>,           // model-view-projection (RTE, translation zeroed),
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
    _pad3: f32,
}

struct MaterialUniforms {
    viewportSize: vec2<f32>,                  // width, height in pixels,
    encodedCameraPositionMCHigh: vec3<f32>,   // RTE: camera position high bits (model coords),
    encodedCameraPositionMCLow: vec3<f32>,    // RTE: camera position low bits (model coords),
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) pickColor: vec4<f32>,
    @location(2) pixelDistance: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

const QUAD_CORNERS = array<vec2<f32>, 6>(
    vec2<f32>(-0.5, -0.5),
    vec2<f32>( 0.5, -0.5),
    vec2<f32>( 0.5,  0.5),
    vec2<f32>(-0.5, -0.5),
    vec2<f32>( 0.5,  0.5),
    vec2<f32>(-0.5,  0.5),
);

// RTE: Translate position relative to eye using emulated 64-bit precision
fn translateRelativeToEye(
    posHigh: vec3<f32>,
    posLow: vec3<f32>,
) -> vec4<f32> {
    var highDiff = posHigh - material.encodedCameraPositionMCHigh;
    // NaN guard for devices where identical subtraction produces NaN (iOS)
    if (length(highDiff) == 0.0) {
        highDiff = vec3<f32>(0.0, 0.0, 0.0);
    }
    let lowDiff = posLow - material.encodedCameraPositionMCLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

@vertex
fn vertexMain(
    @builtin(vertex_index) vertexIndex: u32,
    @location(0) posHighAndSize: vec4<f32>,     // positionHigh.xyz, pixelSize
    @location(1) posLowAndOutline: vec4<f32>,   // positionLow.xyz, outlineWidth
    @location(2) pickColorIn: vec4<f32>,         // pick color rgba
    @location(3) showVec: vec4<f32>,             // show in .x, rest unused
) -> VertexOutput {
    var output: VertexOutput;

    let show = showVec.x;
    if (show < 0.5) {
        output.position = vec4<f32>(0.0, 0.0, -2.0, 1.0);
        output.uv = vec2<f32>(0.0);
        output.pickColor = vec4<f32>(0.0);
        output.pixelDistance = 0.0;
        return output;
    }

    let posHigh = posHighAndSize.xyz;
    let posLow = posLowAndOutline.xyz;
    let pixelSize = posHighAndSize.w;
    let outlineWidth = posLowAndOutline.w;
    let totalSize = max(pixelSize + 2.0 * outlineWidth, 1.0);

    let corner = QUAD_CORNERS[vertexIndex % 6u];

    // RTE: compute eye-relative position with emulated 64-bit precision
    let eyeRelativePos = translateRelativeToEye(posHigh, posLow);
    let clipPos = camera.mvpRelativeToEye * eyeRelativePos;

    let ndcOffset = vec2<f32>(
        corner.x * totalSize * 2.0 / material.viewportSize.x,
        corner.y * totalSize * 2.0 / material.viewportSize.y,
    );

    output.position = vec4<f32>(
        clipPos.x + ndcOffset.x * clipPos.w,
        clipPos.y + ndcOffset.y * clipPos.w,
        clipPos.z,
        clipPos.w,
    );

    output.uv = corner;
    output.pickColor = pickColorIn;
    output.pixelDistance = select(0.0, 1.0 / totalSize, totalSize > 0.0);

    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let distanceToCenter = length(input.uv);
    let maxDistance = max(0.0, 0.5 - input.pixelDistance);
    let alpha = 1.0 - smoothstep(maxDistance, 0.5, distanceToCenter);

    if (alpha < 0.005) {
        discard;
    }

    return input.pickColor;
}
