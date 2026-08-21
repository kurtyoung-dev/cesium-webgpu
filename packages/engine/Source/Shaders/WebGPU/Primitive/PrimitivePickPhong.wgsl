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
    // Interpolated linear depth from the near plane plus one. The fragment
    // stage converts it to logarithmic `@builtin(frag_depth)` only in a
    // `LOG_DEPTH` module.
    @location(0) v_logDepth: f32,
    //>>endif
}

struct CameraUniforms {
    mvpRelativeToEye: mat4x4<f32>,
    encodedCameraHigh: vec3<f32>,
    _pad0: f32,
    encodedCameraLow: vec3<f32>,
    _pad1: f32,
    // Previous frame's view-projection matrix for temporal antialiasing and
    // motion-vector reprojection, supplied by
    // `UniformState._previousViewProjection`.
    previousViewProjection: mat4x4<f32>,
    //>>ifdef LOG_DEPTH
    // Renderer-wide log-depth parameters:
    //   x = frustum near, y = frustum far,
    //   z = oneOverLog2FarDepthFromNearPlusOne,
    //   w = reserved.
    // These occupy floats 40-43 of the 176-byte pick camera uniform buffer,
    // matching the flat-color buffer's `logDepth` tail written by
    // `WebGPUPrimitiveCommands.writeRTEUniformsFlat`. Without `LOG_DEPTH`,
    // the struct ends at 160 bytes.
    logDepth: vec4<f32>,
    //>>endif
}

struct MaterialUniforms {
    pickColor: vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

//>>ifdef LOG_DEPTH
// Inline log-depth helpers matching the color sibling and
// chunks/functions/csm_*LogDepth. They are compiled only for `LOG_DEPTH`.
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

// Pick output always stores color at location 0. `LOG_DEPTH` variants also
// write logarithmic fragment depth from the same near plane and factor as the
// color sibling, keeping depth tests coherent in the shared pick framebuffer.
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
