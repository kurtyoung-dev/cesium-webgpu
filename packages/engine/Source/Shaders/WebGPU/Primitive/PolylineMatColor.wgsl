// PolylineMatColor.wgsl
//
// A polyline `Primitive` with `PolylineMaterialAppearance` over a
// `PolylineGeometry` using the default plain `Color` material. WGSL port of
// Appearances/PolylineMaterialAppearanceVS.glsl + PolylineFS.glsl with the
// `Color` material's `czm_getMaterial` (diffuse = color.rgb, alpha = color.a).
//
// The vertex stage is shared byte-for-byte across every PolylineMat* variant;
// only the fragment stage and MaterialUniforms struct differ. It expands the 4 coincident quad
// vertices into a screen-space ribbon (csm_getPolylineWindowCoordinatesWithAngle)
// and forwards v_st / v_width / v_polylineAngle to the material FS.
//
// The 88-byte (22-float) vertex layout is shared by these helpers:
//   WebGPUPrimitiveShaders.js#getPolylineMaterialVertexLayout
//   WebGPUPrimitiveCommands.js
//   loc0 positionHigh     vec3 @0
//   loc1 positionLow      vec3 @12
//   loc2 prevPositionHigh vec3 @24
//   loc3 prevPositionLow  vec3 @36
//   loc4 nextPositionHigh vec3 @48
//   loc5 nextPositionLow  vec3 @60
//   loc6 expandAndWidth   vec2 @72
//   loc7 st               vec2 @80
//
// RTE positions subtract the encoded camera first.

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) prevPositionHigh: vec3<f32>,
    @location(3) prevPositionLow: vec3<f32>,
    @location(4) nextPositionHigh: vec3<f32>,
    @location(5) nextPositionLow: vec3<f32>,
    @location(6) expandAndWidth: vec2<f32>,
    @location(7) st: vec2<f32>,
    // Projected 2D positions, blended with 3D by camera.morph.x.
    @location(8) position2DHigh: vec3<f32>,
    @location(9) position2DLow: vec3<f32>,
    @location(10) prevPosition2DHigh: vec3<f32>,
    @location(11) prevPosition2DLow: vec3<f32>,
    @location(12) nextPosition2DHigh: vec3<f32>,
    @location(13) nextPosition2DLow: vec3<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) v_st: vec2<f32>,
    @location(1) v_width: f32,
    @location(2) v_polylineAngle: f32,
    //>>ifdef LOG_DEPTH
    @location(3) v_logDepth: f32,
    //>>endif
}

// CameraUniforms — byte-locked to writeRTEUniformsPolyline in
// WebGPUPrimitiveCommands.js, using the color-material layout.
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
    // Logarithmic-depth parameters (near, far, factor, reserved) at floats 92-95.
    logDepth: vec4<f32>,
    // morph.x = morphTime (3D=1, 2D/CV=0) at float 96.
    morph: vec4<f32>,
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

    // Blend 3D and 2D positions by morphTime.
    let p: vec4<f32> = csm_computePolylinePosition(
        input.positionHigh, input.positionLow,
        input.position2DHigh, input.position2DLow,
        camera.encodedCameraHigh, camera.encodedCameraLow, camera.morph.x);
    let prev: vec4<f32> = csm_computePolylinePosition(
        input.prevPositionHigh, input.prevPositionLow,
        input.prevPosition2DHigh, input.prevPosition2DLow,
        camera.encodedCameraHigh, camera.encodedCameraLow, camera.morph.x);
    let next: vec4<f32> = csm_computePolylinePosition(
        input.nextPositionHigh, input.nextPositionLow,
        input.nextPosition2DHigh, input.nextPosition2DLow,
        camera.encodedCameraHigh, camera.encodedCameraLow, camera.morph.x);

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

    //>>ifdef LOG_DEPTH
    output.v_logDepth = csm_vertexLogDepth(output.position, camera.logDepth.x);
    output.position = csm_updatePositionDepth(output.position);
    //>>endif

    return output;
}

struct FragOutput {
    @location(0) color: vec4<f32>,
    //>>ifdef LOG_DEPTH
    @builtin(frag_depth) depth: f32,
    //>>endif
}

@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
    // Color material: diffuse = color.rgb, alpha = color.a.
    // out_FragColor = vec4(diffuse + emission, alpha); emission is 0 here.
    var out: FragOutput;
    out.color = material.color;
    //>>ifdef LOG_DEPTH
    out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepth.z);
    //>>endif
    return out;
}
