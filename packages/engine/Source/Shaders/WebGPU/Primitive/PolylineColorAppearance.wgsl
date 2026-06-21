// PolylineColorAppearance.wgsl
//
// COLOR slice of NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU. WGSL port of
// Appearances/PolylineColorAppearanceVS.glsl + PerInstanceFlatColorAppearanceFS.
//
// Renders a `Primitive` with `PolylineColorAppearance` over a
// `PolylineGeometry`. The geometry emits 4 coincident quad vertices per
// segment endpoint that carry prev/next positions + an expandAndWidth
// attribute; the VS expands them into a screen-space ribbon of the
// requested pixel width via the ported PolylineCommon window-coordinate
// math (csm_getPolylineWindowCoordinates).
//
// Vertex layout (96 bytes, 24 floats — must match getPolylineAppearanceVertexLayout
// in WebGPUPrimitiveShaders.js AND the packer in WebGPUPrimitiveCommands.js):
//   loc0 positionHigh   vec3 @0
//   loc1 positionLow    vec3 @12
//   loc2 prevPositionHigh vec3 @24
//   loc3 prevPositionLow  vec3 @36
//   loc4 nextPositionHigh vec3 @48
//   loc5 nextPositionLow  vec3 @60
//   loc6 expandAndWidth  vec2 @72
//   loc7 color           vec4 @80
//
// RTE: positions are subtracted from the encoded camera FIRST
// (translateRelativeToEye), never posHigh+posLow directly.

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) prevPositionHigh: vec3<f32>,
    @location(3) prevPositionLow: vec3<f32>,
    @location(4) nextPositionHigh: vec3<f32>,
    @location(5) nextPositionLow: vec3<f32>,
    @location(6) expandAndWidth: vec2<f32>,
    @location(7) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
}

// CameraUniforms — extends the flat camera layout with the matrices the
// polyline window-coordinate math needs. Field order + padding are
// byte-locked to writeRTEUniformsPolyline in WebGPUPrimitiveCommands.js.
//
//   float 0-15  mvpRelativeToEye        (parity; VS uses the ortho path)
//   float 16-19 encodedCameraHigh + pad
//   float 20-23 encodedCameraLow  + pad
//   float 24-39 projection
//   float 40-55 viewportTransformation
//   float 56-71 viewportOrthographic
//   float 72-87 modelViewRelativeToEye
//   float 88    pixelRatio
//   float 89    currentFrustumNear
//   float 90-91 pad
struct CameraUniforms {
    mvpRelativeToEye: mat4x4<f32>,
    encodedCameraHigh: vec3<f32>,
    _pad0: f32,
    encodedCameraLow: vec3<f32>,
    _pad1: f32,
    projection: mat4x4<f32>,
    viewportTransformation: mat4x4<f32>,
    viewportOrthographic: mat4x4<f32>,
    modelViewRelativeToEye: mat4x4<f32>,
    pixelRatio: f32,
    currentFrustumNear: f32,
    _pad2: vec2<f32>,
}

struct MaterialUniforms {
    _placeholder: vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

// @chunk functions/csm_polylineCommon

// RTE: subtract the encoded camera FIRST. Mirrors translateRelativeToEye in
// the other primitive shaders / czm_translateRelativeToEye.
fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - camera.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - camera.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    let expandDir: f32 = input.expandAndWidth.x;
    let width: f32 = abs(input.expandAndWidth.y) + 0.5;
    let usePrev: bool = input.expandAndWidth.y < 0.0;

    let p: vec4<f32> =
        translateRelativeToEye(input.positionHigh, input.positionLow);
    let prev: vec4<f32> =
        translateRelativeToEye(input.prevPositionHigh, input.prevPositionLow);
    let next: vec4<f32> =
        translateRelativeToEye(input.nextPositionHigh, input.nextPositionLow);

    let positionWC: vec4<f32> = csm_getPolylineWindowCoordinates(
        p, prev, next,
        expandDir, width, usePrev,
        camera.modelViewRelativeToEye,
        camera.projection,
        camera.viewportTransformation,
        camera.pixelRatio,
        camera.currentFrustumNear
    );

    output.position = camera.viewportOrthographic * positionWC;
    output.color = input.color;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // PerInstanceFlatColorAppearanceFS — emit the interpolated (flat) color.
    return input.color;
}
