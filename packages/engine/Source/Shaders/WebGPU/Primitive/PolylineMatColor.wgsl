// PolylineMatColor.wgsl
//
// MATERIAL slice of NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU. A polyline
// `Primitive` with `PolylineMaterialAppearance` over a `PolylineGeometry`
// using a plain `Color` material (the default). WGSL port of
// Appearances/PolylineMaterialAppearanceVS.glsl + PolylineFS.glsl with the
// `Color` material's `czm_getMaterial` (diffuse = color.rgb, alpha = color.a).
//
// The VS is shared (byte-for-byte) across every PolylineMat* variant; only
// the FS + MaterialUniforms struct differ. It expands the 4 coincident quad
// vertices into a screen-space ribbon (csm_getPolylineWindowCoordinatesWithAngle)
// and forwards v_st / v_width / v_polylineAngle to the material FS.
//
// Vertex layout (88 bytes, 22 floats — must match getPolylineMaterialVertexLayout
// in WebGPUPrimitiveShaders.js AND the packer in WebGPUPrimitiveCommands.js):
//   loc0 positionHigh     vec3 @0
//   loc1 positionLow      vec3 @12
//   loc2 prevPositionHigh vec3 @24
//   loc3 prevPositionLow  vec3 @36
//   loc4 nextPositionHigh vec3 @48
//   loc5 nextPositionLow  vec3 @60
//   loc6 expandAndWidth   vec2 @72
//   loc7 st               vec2 @80
//
// RTE: positions subtracted from the encoded camera FIRST.

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) prevPositionHigh: vec3<f32>,
    @location(3) prevPositionLow: vec3<f32>,
    @location(4) nextPositionHigh: vec3<f32>,
    @location(5) nextPositionLow: vec3<f32>,
    @location(6) expandAndWidth: vec2<f32>,
    @location(7) st: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) v_st: vec2<f32>,
    @location(1) v_width: f32,
    @location(2) v_polylineAngle: f32,
}

// CameraUniforms — byte-locked to writeRTEUniformsPolyline in
// WebGPUPrimitiveCommands.js (identical to the COLOR slice's layout).
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

// Color material — uniform color (vec4). Byte-locked to the Color material's
// `_uniformBuffer.gpuData` (single vec4 @ float 0).
struct MaterialUniforms {
    color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

// @chunk functions/csm_polylineCommon

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

    let win: CsmPolylineWindowResult = csm_getPolylineWindowCoordinatesWithAngle(
        p, prev, next,
        expandDir, width, usePrev,
        camera.modelViewRelativeToEye,
        camera.projection,
        camera.viewportTransformation,
        camera.pixelRatio,
        camera.currentFrustumNear
    );

    output.position = camera.viewportOrthographic * win.positionWC;
    output.v_st = input.st;
    output.v_width = width;
    output.v_polylineAngle = win.angle;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // Color material: diffuse = color.rgb, alpha = color.a.
    // out_FragColor = vec4(diffuse + emission, alpha); emission is 0 here.
    return material.color;
}
