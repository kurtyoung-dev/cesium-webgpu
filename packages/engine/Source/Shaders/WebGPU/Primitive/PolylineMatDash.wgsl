// PolylineMatDash.wgsl
//
// MATERIAL slice of NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU — `PolylineDash`
// material on a polyline `Primitive` with `PolylineMaterialAppearance`. WGSL
// port of Materials/PolylineDashMaterial.glsl fed by the shared polyline VS.
//
// The dash pattern is a 16-bit bitmask sampled along the line in screen space:
// gl_FragCoord.xy is rotated by the quantized polyline angle so the dash runs
// along the line regardless of screen orientation, then the fragment's x is
// folded into a [0,1) dash cycle and tested against the bitmask.
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

// PolylineDash uniforms — byte-locked to the material's `_uniformBuffer.gpuData`
// (declaration order: color, gapColor, dashLength, dashPattern):
//   color:       vec4 @ float 0
//   gapColor:    vec4 @ float 4
//   dashLength:  f32  @ float 8
//   dashPattern: f32  @ float 9
struct MaterialUniforms {
    color: vec4<f32>,
    gapColor: vec4<f32>,
    dashLength: f32,
    dashPattern: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

// @chunk functions/csm_polylineCommon

const MASK_LENGTH: f32 = 16.0;

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
    // rotate(v_polylineAngle) * gl_FragCoord.xy, where rotate(rad) builds the
    // GLSL column-major mat2(c, s, -s, c):
    //   pos.x = c*x - s*y, pos.y = s*x + c*y
    let rad: f32 = input.v_polylineAngle;
    let c: f32 = cos(rad);
    let s: f32 = sin(rad);
    let frag: vec2<f32> = input.position.xy;
    let posX: f32 = c * frag.x - s * frag.y;

    // Relative position within the dash from 0 to 1.
    let dashPosition: f32 =
        fract(posX / (material.dashLength * camera.pixelRatio));
    let maskIndex: f32 = floor(dashPosition * MASK_LENGTH);
    let maskTest: f32 = floor(material.dashPattern / pow(2.0, maskIndex));
    var fragColor: vec4<f32>;
    if ((maskTest % 2.0) < 1.0) {
        fragColor = material.gapColor;
    } else {
        fragColor = material.color;
    }
    if (fragColor.a < 0.005) {
        discard;
    }
    // out_FragColor = vec4(diffuse + emission, alpha); dash sets emission.
    return fragColor;
}
