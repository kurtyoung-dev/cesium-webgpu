// PolylineMatArrow.wgsl
//
// MATERIAL slice of NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU — `PolylineArrow`
// material on a polyline `Primitive` with `PolylineMaterialAppearance`. WGSL
// port of Materials/PolylineArrowMaterial.glsl fed by the shared polyline VS.
//
// Draws the line as a solid bar that flares into an arrow head at st.s == 1
// (the end of the line). Uses fwidth(st.s) to size the head ~2.5% of the line
// and czm_antialias to soften the head/bar edges. Writes material.diffuse.
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
}

// PolylineArrow uniforms — byte-locked to the material's `_uniformBuffer.gpuData`:
//   color: vec4 @ float 0
struct MaterialUniforms {
    color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

// @chunk functions/csm_polylineCommon

const CSM_INFINITY: f32 = 5906376272000.0; // czm_infinity

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - camera.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - camera.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

// Port of czm_antialias (fuzzFactor 0.1 default).
fn csm_antialiasArrow(
    color1: vec4<f32>, color2: vec4<f32>, currentColor: vec4<f32>, dist: f32
) -> vec4<f32> {
    let fuzz: f32 = 0.1;
    let val1: f32 = clamp(dist / fuzz, 0.0, 1.0);
    let val2: f32 = clamp((dist - 0.5) / fuzz, 0.0, 1.0);
    let val3: f32 = val1 * (1.0 - val2);
    return mix(currentColor, mix(color1, color2, val2), val3);
}

fn getPointOnLine(p0: vec2<f32>, p1: vec2<f32>, x: f32) -> f32 {
    let slope: f32 = (p0.y - p1.y) / (p0.x - p1.x);
    return slope * (x - p0.x) + p0.y;
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
    let st: vec2<f32> = input.v_st;

    let base: f32 = 1.0 - abs(fwidth(st.x)) * 10.0 * camera.pixelRatio;

    let center: vec2<f32> = vec2<f32>(1.0, 0.5);
    let ptOnUpperLine: f32 = getPointOnLine(vec2<f32>(base, 1.0), center, st.x);
    let ptOnLowerLine: f32 = getPointOnLine(vec2<f32>(base, 0.0), center, st.x);

    let halfWidth: f32 = 0.15;
    var s: f32 = step(0.5 - halfWidth, st.y);
    s = s * (1.0 - step(0.5 + halfWidth, st.y));
    s = s * (1.0 - step(base, st.x));

    var t: f32 = step(base, st.x);
    t = t * (1.0 - step(ptOnUpperLine, st.y));
    t = t * step(ptOnLowerLine, st.y);

    // Distance from the closest separator (region between two colors).
    var dist: f32;
    if (st.x < base) {
        let d1: f32 = abs(st.y - (0.5 - halfWidth));
        let d2: f32 = abs(st.y - (0.5 + halfWidth));
        dist = min(d1, d2);
    } else {
        var d1: f32 = CSM_INFINITY;
        if (st.y < 0.5 - halfWidth && st.y > 0.5 + halfWidth) {
            d1 = abs(st.x - base);
        }
        let d2: f32 = abs(st.y - ptOnUpperLine);
        let d3: f32 = abs(st.y - ptOnLowerLine);
        dist = min(min(d1, d2), d3);
    }

    let outsideColor: vec4<f32> = vec4<f32>(0.0);
    let currentColor: vec4<f32> =
        mix(outsideColor, material.color, clamp(s + t, 0.0, 1.0));
    let outColor: vec4<f32> =
        csm_antialiasArrow(outsideColor, material.color, currentColor, dist);

    // material.diffuse = outColor.rgb; material.alpha = outColor.a;
    // out_FragColor = vec4(diffuse + emission(0), alpha).
    var out: FragOutput;
    out.color = outColor;
    //>>ifdef LOG_DEPTH
    out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepth.z);
    //>>endif
    return out;
}
