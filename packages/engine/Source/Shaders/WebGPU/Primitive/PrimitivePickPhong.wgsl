// PrimitivePickPhong.wgsl
// Pick shader for phong vertex layout: posHigh(3) + posLow(3) + normal(3) + color(4)
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    //>>ifdef LOG_DEPTH
    // C10-11-PICK-FLEET-LOG-DEPTH — interpolated linear depthFromNearPlusOne;
    // the FS converts it to log-encoded @builtin(frag_depth). Present only in
    // the LOG_DEPTH-compiled pick module (the historical hyperbolic pick module
    // has no define and never carries it → byte-identical output).
    @location(0) v_logDepth: f32,
    //>>endif
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
    //>>ifdef LOG_DEPTH
    // C10-11-PICK-FLEET-LOG-DEPTH — renderer-wide log depth (Approach A) lanes:
    //   x = frustum near, y = frustum far,
    //   z = oneOverLog2FarDepthFromNearPlusOne (the log-depth factor),
    //   w = reserved.
    // These occupy floats 40-43 of the 176-byte pick camera UB — the SAME
    // offset the 176-byte FLAT color UB carries `logDepth`, written by
    // WebGPUPrimitiveCommands.writeRTEUniformsFlat (writeLogDepthTail at float
    // 40). Read ONLY inside //>>ifdef LOG_DEPTH blocks, so the hyperbolic pick
    // module (no define) keeps the struct at 160 bytes → byte-identical.
    logDepth: vec4<f32>,
    //>>endif
}

struct MaterialUniforms {
    pickColor: vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

//>>ifdef LOG_DEPTH
// C10-11-PICK-FLEET-LOG-DEPTH — renderer-wide log depth (Approach A), canonical
// inline copies (mirror of the color sibling + chunks/functions/csm_*LogDepth).
// Compiled into the pick module ONLY when the pick-fleet switch is active.
fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
    return (clipPosition.w - near) + 1.0;
}
fn csm_updatePositionDepth(clipPosition: vec4<f32>) -> vec4<f32> {
    var coords = clipPosition;
    coords.z = clamp(coords.z / coords.w, 0.0, 1.0) * coords.w;
    return coords;
}
fn csm_writeLogDepth(depthFromNearPlusOne: f32, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {
    return log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne;
}
//>>endif

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
    //>>ifdef LOG_DEPTH
    // Interpolate linear depthFromNearPlusOne and clamp clip-z so the FS-written
    // log depth isn't pre-empted (mirrors the color sibling's VS exactly).
    output.v_logDepth = csm_vertexLogDepth(output.position, camera.logDepth.x);
    output.position = csm_updatePositionDepth(output.position);
    //>>endif
    return output;
}

// C10-11-PICK-FLEET-LOG-DEPTH — pick output. At defines=0 this is a single
// @location(0) struct, byte-identical in output to the historical bare
// `-> @location(0) vec4<f32>` return. Under the pick-fleet LOG_DEPTH module it
// also carries the log-encoded @builtin(frag_depth), written from the VS
// v_logDepth varying with the SAME (near, factor) the color sibling uses — so a
// converted pick fleet depth-tests coherently in the shared pick FBO.
struct PickFragOutput {
    @location(0) color: vec4<f32>,
    //>>ifdef LOG_DEPTH
    @builtin(frag_depth) depth: f32,
    //>>endif
}

@fragment
fn fragmentMain(input: VertexOutput) -> PickFragOutput {
    var out: PickFragOutput;
    out.color = material.pickColor;
    //>>ifdef LOG_DEPTH
    out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepth.z);
    //>>endif
    return out;
}
