// Point Primitive Pick Shader — WebGPU (with RTE precision)
// Same quad expansion as color shader, but outputs a uniform pick color
// for GPU-based object picking (readback pixel → identify object).
//
// Uses RTE (Relative-To-Eye) emulated 64-bit precision to eliminate
// jittering at planetary scale.
//
// Batch 21 — unified CameraUniforms (see PointPrimitiveColor.wgsl for the
// pre-existing-bug rationale) and the DP-H42 / DP-H40 per-instance +
// frame-wide integration. Pick must apply both features the same way as
// color so the picked region exactly matches the rendered region.

struct CameraUniforms {
    mvpRelativeToEye: mat4x4<f32>,             // bytes 0-63
    viewportSize: vec2<f32>,                    // bytes 64-71
    splitPosition: f32,                         // byte 72 (DP-H40)
    minimumDisableDepthTestDistance: f32,        // byte 76 (DP-H42)
    encodedCameraPositionMCHigh: vec3<f32>,     // bytes 80-91 (+4 pad)
    _pad0: f32,
    encodedCameraPositionMCLow: vec3<f32>,      // bytes 96-107 (+4 pad)
    _pad1: f32,
    // DP-H41 (Batch 27) — previous frame's viewProjection for
    // TAA / motion-vector reprojection. Sourced from
    // `UniformState._previousViewProjection` (f32 mat4).
    previousViewProjection: mat4x4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) pickColor: vec4<f32>,
    @location(2) pixelDistance: f32,
    //>>ifdef SPLIT_ENABLED
    @location(3) splitDirection: f32,
    //>>endif
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

const QUAD_CORNERS = array<vec2<f32>, 6>(
    vec2<f32>(-0.5, -0.5),
    vec2<f32>( 0.5, -0.5),
    vec2<f32>( 0.5,  0.5),
    vec2<f32>(-0.5, -0.5),
    vec2<f32>( 0.5,  0.5),
    vec2<f32>(-0.5,  0.5),
);

// RTE: Translate position relative to eye using emulated 64-bit precision
fn translateRelativeToEye(
    posHigh: vec3<f32>,
    posLow: vec3<f32>,
) -> vec4<f32> {
    var highDiff = posHigh - camera.encodedCameraPositionMCHigh;
    // NaN guard for devices where identical subtraction produces NaN (iOS)
    if (length(highDiff) == 0.0) {
        highDiff = vec3<f32>(0.0, 0.0, 0.0);
    }
    let lowDiff = posLow - camera.encodedCameraPositionMCLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

// AUDIT_2026_05_02 A.14 (Batch 136) — czm_nearFarScalar helper for the
// pick path so picked pixels respect the same distance-aware visibility
// gates as color (a translucency=0 or scale=0 point should not pick).
fn czm_nearFarScalar(scalar: vec4<f32>, distSq: f32) -> f32 {
    let nearDistSq = scalar.x * scalar.x;
    let farDistSq = scalar.z * scalar.z;
    let denom = farDistSq - nearDistSq;
    if (denom <= 0.0) {
        return scalar.y;
    }
    let t = clamp((distSq - nearDistSq) / denom, 0.0, 1.0);
    return mix(scalar.y, scalar.w, t);
}

@vertex
fn vertexMain(
    @builtin(vertex_index) vertexIndex: u32,
    @location(0) posHighAndSize: vec4<f32>,     // positionHigh.xyz, pixelSize
    @location(1) posLowAndOutline: vec4<f32>,   // positionLow.xyz, outlineWidth
    @location(2) pickColorIn: vec4<f32>,         // pick color rgba
    @location(3) showVec: vec4<f32>,             // show in .x, rest unused
    // DP-H42 / DP-H40 / A.14 perInstanceFlags. Same contract as color path:
    //   x = disableDepthTestDistance, y = splitDirection,
    //   z = ddcNearSq, w = ddcFarSq (Batch 136).
    @location(4) perInstanceFlags: vec4<f32>,
    // AUDIT_2026_05_02 A.14 (Batch 136) — translucencyByDistance + scaleByDistance
    // mirror the color path's slots so a point that's invisible to color
    // is also invisible to picking.
    @location(5) translucencyByDistance: vec4<f32>,
    @location(6) scaleByDistance: vec4<f32>,
) -> VertexOutput {
    var output: VertexOutput;

    let show = showVec.x;
    if (show < 0.5) {
        output.position = vec4<f32>(0.0, 0.0, -2.0, 1.0);
        output.uv = vec2<f32>(0.0);
        output.pickColor = vec4<f32>(0.0);
        output.pixelDistance = 0.0;
        //>>ifdef SPLIT_ENABLED
        output.splitDirection = 0.0;
        //>>endif
        return output;
    }

    let posHigh = posHighAndSize.xyz;
    let posLow = posLowAndOutline.xyz;
    let basePixelSize = posHighAndSize.w;
    let outlineWidth = posLowAndOutline.w;

    // RTE: compute eye-relative position with emulated 64-bit precision
    let eyeRelativePos = translateRelativeToEye(posHigh, posLow);
    let camDistSq = dot(eyeRelativePos.xyz, eyeRelativePos.xyz);
    var clipPos = camera.mvpRelativeToEye * eyeRelativePos;

    // AUDIT_2026_05_02 A.14 (Batch 136) — apply EYE_DISTANCE_SCALING
    // before quad expansion. Same contract as color path.
    var pixelSize: f32 = basePixelSize;
    //>>ifdef EYE_DISTANCE_SCALING
    let distScale = czm_nearFarScalar(scaleByDistance, camDistSq);
    pixelSize = pixelSize * distScale;
    if (distScale == 0.0) {
        clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    //>>endif

    let totalSize = max(pixelSize + 2.0 * outlineWidth, 1.0);
    let corner = QUAD_CORNERS[vertexIndex % 6u];

    let ndcOffset = vec2<f32>(
        corner.x * totalSize * 2.0 / camera.viewportSize.x,
        corner.y * totalSize * 2.0 / camera.viewportSize.y,
    );

    clipPos = vec4<f32>(
        clipPos.x + ndcOffset.x * clipPos.w,
        clipPos.y + ndcOffset.y * clipPos.w,
        clipPos.z,
        clipPos.w,
    );

    //>>ifdef DISTANCE_DISPLAY_CONDITION
    let nearSqDDC = perInstanceFlags.z;
    let farSqDDC = perInstanceFlags.w;
    if (camDistSq < nearSqDDC || camDistSq > farSqDDC) {
        clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    //>>endif

    //>>ifdef DISABLE_DEPTH_DISTANCE
    // Batch 140 — raw-sentinel pattern (see PointPrimitiveColor.wgsl).
    let disableRawDP = perInstanceFlags.x;
    if (disableRawDP < 0.0) {
        clipPos.z = clipPos.w;
    } else if (disableRawDP != 0.0) {
        let disableDepthSqDP = disableRawDP * disableRawDP;
        if (camDistSq < disableDepthSqDP) {
            clipPos.z = clipPos.w;
        }
    } else if (camera.minimumDisableDepthTestDistance != 0.0) {
        let frameMinSqDP =
            camera.minimumDisableDepthTestDistance *
            camera.minimumDisableDepthTestDistance;
        if (camDistSq < frameMinSqDP) {
            clipPos.z = clipPos.w;
        }
    }
    //>>endif

    output.position = clipPos;

    // AUDIT_2026_05_02 A.14 (Batch 136) — translucency=0 → kill pick.
    //>>ifdef EYE_DISTANCE_TRANSLUCENCY
    let translucency = czm_nearFarScalar(translucencyByDistance, camDistSq);
    if (translucency == 0.0) {
        output.position = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    //>>endif

    output.uv = corner;
    output.pickColor = pickColorIn;
    output.pixelDistance = select(0.0, 1.0 / totalSize, totalSize > 0.0);

    //>>ifdef SPLIT_ENABLED
    output.splitDirection = perInstanceFlags.y;
    //>>endif

    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    //>>ifdef SPLIT_ENABLED
    if (input.splitDirection < 0.0 && input.position.x > camera.splitPosition) {
        discard;
    }
    if (input.splitDirection > 0.0 && input.position.x < camera.splitPosition) {
        discard;
    }
    //>>endif

    let distanceToCenter = length(input.uv);
    let maxDistance = max(0.0, 0.5 - input.pixelDistance);
    let alpha = 1.0 - smoothstep(maxDistance, 0.5, distanceToCenter);

    if (alpha < 0.005) {
        discard;
    }

    return input.pickColor;
}
