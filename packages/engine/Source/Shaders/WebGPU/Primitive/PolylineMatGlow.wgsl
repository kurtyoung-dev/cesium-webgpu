// PolylineMatGlow.wgsl
//
// MATERIAL slice of NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU — `PolylineGlow`
// material on a polyline `Primitive` with `PolylineMaterialAppearance`. WGSL
// port of Materials/PolylineGlowMaterial.glsl fed by the shared polyline VS.
//
// The glow falls off from the line center (st.t == 0.5) toward the edges and,
// when taperPower < 1, also tapers along the line (st.s). The glow is written
// as material.emission, so out_FragColor = vec4(glowRGB, glowAlpha).
//
// Vertex layout (88 bytes, 22 floats) — identical to PolylineMatColor.wgsl.

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

// PolylineGlow uniforms — byte-locked to the material's `_uniformBuffer.gpuData`
// (declaration order: color, glowPower, taperPower):
//   color:      vec4 @ float 0
//   glowPower:  f32  @ float 4
//   taperPower: f32  @ float 5
struct MaterialUniforms {
    color: vec4<f32>,
    glowPower: f32,
    taperPower: f32,
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
    let st: vec2<f32> = input.v_st;
    let glowPower: f32 = material.glowPower;
    let taperPower: f32 = material.taperPower;

    var glow: f32 = glowPower / abs(st.y - 0.5) - (glowPower / 0.5);

    if (taperPower <= 0.99999) {
        glow = glow *
            min(1.0, taperPower / (0.5 - st.x * 0.5) - (taperPower / 0.5));
    }

    var fragColor: vec4<f32>;
    // GLSL `clamp(0.0, 1.0, glow)` evaluates to min(max(0.0, 1.0), glow) =
    // min(1.0, glow) — replicate that exact (quirky) ordering for parity.
    fragColor = vec4<f32>(
        max(vec3<f32>(glow - 1.0) + material.color.rgb, material.color.rgb),
        min(1.0, glow) * material.color.a
    );
    // material.emission = fragColor.rgb; material.alpha = fragColor.a;
    // out_FragColor = vec4(diffuse(0) + emission, alpha).
    return fragColor;
}
