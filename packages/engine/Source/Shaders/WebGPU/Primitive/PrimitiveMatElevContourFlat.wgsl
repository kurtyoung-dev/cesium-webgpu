// PrimitiveMatElevContourFlat.wgsl
// Elevation contour material, no lighting
// Draws contour lines based on height above the ellipsoid
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + st(2) = 8 floats = 32 bytes
// Matches CesiumJS Material.ElevationContourType: color, spacing, width

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
    @location(1) height: f32,
}

struct CameraUniforms {
    mvpRelativeToEye: mat4x4<f32>,
    encodedCameraHigh: vec3<f32>,
    _pad0: f32,
    encodedCameraLow: vec3<f32>,
    _pad1: f32,
        previousViewProjection: mat4x4<f32>,
}

// MaterialUniforms field order must match Material.ElevationContourType
// fabric: { spacing: f32, color: Color, width: f32 }.
struct MaterialUniforms {
    spacing: f32,
    color: vec4<f32>,
    width: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

const EARTH_RADIUS: f32 = 6371000.0;

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
    // Approximate height above ellipsoid from world position
    let worldPos = input.positionHigh + input.positionLow;
    output.height = length(worldPos) - EARTH_RADIUS;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let distToContour = input.height % material.spacing;
    // Use screen-space derivatives for width-independent contour lines
    let dxc = abs(dpdx(input.height));
    let dyc = abs(dpdy(input.height));
    let dF = max(dxc, dyc) * material.width;
    let alpha = select(0.0, 1.0, distToContour < dF);
    return vec4<f32>(material.color.rgb, material.color.a * alpha);
}
