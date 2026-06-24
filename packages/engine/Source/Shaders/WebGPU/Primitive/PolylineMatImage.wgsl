// PolylineMatImage.wgsl
//
// MATERIAL slice of NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU (376d). A polyline
// `Primitive` with `PolylineMaterialAppearance` using an `Image` / `DiffuseMap`
// material — the texture is sampled along the line via the `st` coordinate
// (s along length, t across width). Before 376d these materials were routed to
// PolylineMatColor (which has no texture group) and rendered solid/wrong.
//
// The VS is byte-identical to the other PolylineMat* shaders (the shared
// screen-space expansion + 376b 2D/CV/morph blend + 376c log-depth). Only the
// MaterialUniforms struct, the @group(2) texture bindings, and the FS differ.
//
// Bind groups: camera@0, material@1, texture(sampler+image)@2. The polyline
// material FS does not consume the effects group, so the textured variant's
// pipeline has NO effects group (texture takes slot 2 instead).

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) prevPositionHigh: vec3<f32>,
    @location(3) prevPositionLow: vec3<f32>,
    @location(4) nextPositionHigh: vec3<f32>,
    @location(5) nextPositionLow: vec3<f32>,
    @location(6) expandAndWidth: vec2<f32>,
    @location(7) st: vec2<f32>,
    // 376b — projected 2D positions (blended with 3D by camera.morph.x).
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
    // 376c — logDepth (near, far, factor, reserved) @ floats 92-95.
    logDepth: vec4<f32>,
    // 376b — morph.x = morphTime (3D=1, 2D/CV=0) @ float 96.
    morph: vec4<f32>,
}

// Image material — byte-locked to the Image material's `_uniformBuffer.gpuData`.
// MaterialUniformBuffer packs the numeric fabric fields in declaration order,
// skipping textures: { image (tex, skipped), repeat: vec2, color: vec4 }. Same
// layout as PrimitiveMatImageFlat.wgsl.
struct MaterialUniforms {
    repeat: vec2<f32>,
    color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(2) @binding(0) var textureSampler: sampler;
@group(2) @binding(1) var colorTexture: texture_2d<f32>;

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

    // 376b — czm_computePosition: blend 3D↔2D positions by morphTime.
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
    // Image material: sample along the line (st * repeat) and tint by color.
    // diffuse = texColor.rgb * color.rgb, alpha = texColor.a * color.a.
    let uv = input.v_st * material.repeat;
    // Sample mip level 0 explicitly: a polyline is a thin screen-space ribbon,
    // so the implicit-derivative LOD picks a high (often degenerate) mip and the
    // small material texture vanishes. WebGL's polyline material has no such
    // ribbon-LOD issue; level-0 sampling matches its appearance.
    let texColor = textureSampleLevel(colorTexture, textureSampler, uv, 0.0);
    var out: FragOutput;
    out.color = texColor * material.color;
    //>>ifdef LOG_DEPTH
    out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepth.z);
    //>>endif
    return out;
}
