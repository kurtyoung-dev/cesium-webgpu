// PolylineColorAppearance.wgsl
//
// WGSL port of Appearances/PolylineColorAppearanceVS.glsl and
// PerInstanceFlatColorAppearanceFS.glsl.
//
// Renders a `Primitive` with `PolylineColorAppearance` over a
// `PolylineGeometry`. The geometry emits 4 coincident quad vertices per
// segment endpoint that carry prev/next positions + an expandAndWidth
// attribute; the VS expands them into a screen-space ribbon of the
// requested pixel width via the ported PolylineCommon window-coordinate
// math (csm_getPolylineWindowCoordinates).
//
// The 96-byte (24-float) vertex layout is shared by these helpers:
//   WebGPUPrimitiveShaders.js#getPolylineAppearanceVertexLayout
//   WebGPUPrimitiveCommands.js
//   loc0 positionHigh   vec3 @0
//   loc1 positionLow    vec3 @12
//   loc2 prevPositionHigh vec3 @24
//   loc3 prevPositionLow  vec3 @36
//   loc4 nextPositionHigh vec3 @48
//   loc5 nextPositionLow  vec3 @60
//   loc6 expandAndWidth  vec2 @72
//   loc7 color           vec4 @80
//
// RTE positions subtract the encoded camera first
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
    @location(0) color: vec4<f32>,
    //>>ifdef LOG_DEPTH
    // Interpolated linear depthFromNearPlusOne; FS converts to frag_depth.
    @location(1) v_logDepth: f32,
    //>>endif
}

// CameraUniforms — extends the flat camera layout with the matrices the
// polyline window-coordinate math needs. Field order + padding are
// byte-locked to writeRTEUniformsPolyline in WebGPUPrimitiveCommands.js.
//
//   float 0-15  mvpRelativeToEye        (the vertex stage uses the ortho path)
//   float 16-19 encodedCameraHigh + pad
//   float 20-23 encodedCameraLow  + pad
//   float 24-39 projection
//   float 40-55 viewportTransformation
//   float 56-71 viewportOrthographic
//   float 72-87 modelViewRelativeToEye
//   float 88    pixelRatio
//   float 89    currentFrustumNear
//   float 90-91 pad
//   float 92-95 logDepth (near, far, factor, reserved), packed by
//               writeLogDepthTail; read only inside //>>ifdef LOG_DEPTH
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
    logDepth: vec4<f32>,
    // morph.x = morphTime (3D=1, 2D/CV=0) at float 96.
    morph: vec4<f32>,
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

    // Blend the encoded 3D and 2D positions by morphTime. Feeding 3D ECEF
    // positions directly through a 2D/CV camera collapses the projected width.
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

    //>>ifdef LOG_DEPTH
    // Renderer-wide log depth — output.position.w carries the eye-space
    // clip-w (see csm_polylineCommon log-depth note), so the standard recipe
    // applies directly with no DISABLE_DEPTH_DISTANCE / hide-collapse cases
    // (the appearance VS never pushes z to the far plane).
    output.v_logDepth = csm_vertexLogDepth(output.position, camera.logDepth.x);
    output.position = csm_updatePositionDepth(output.position);
    //>>endif

    return output;
}

struct FragOutput {
    @location(0) color: vec4<f32>,
    //>>ifdef LOG_DEPTH
    // frag_depth so the translucent polyline pass tests against log depth too.
    @builtin(frag_depth) depth: f32,
    //>>endif
}

@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
    // PerInstanceFlatColorAppearanceFS — emit the interpolated (flat) color.
    var out: FragOutput;
    out.color = input.color;
    //>>ifdef LOG_DEPTH
    out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepth.z);
    //>>endif
    return out;
}
