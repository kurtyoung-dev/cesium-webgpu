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
    // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — the pick pipeline reuses the
    // color camera UB (`cache.uniformBuffer`, sized for the color struct's
    // logDepth tail), so floats 44-47 already carry (near, far, factor,
    // reserved). Struct tail add-only; only the `//>>ifdef LOG_DEPTH` pick
    // module reads it. Mirrors PointPrimitiveColor.wgsl.
    logDepth: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) pickColor: vec4<f32>,
    @location(2) pixelDistance: f32,
    //>>ifdef SPLIT_ENABLED
    @location(3) splitDirection: f32,
    //>>endif
    //>>ifdef LOG_DEPTH
    // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH — interpolated linear depthFromNearPlusOne;
    // the pick FS converts it to frag_depth (matches the color sibling).
    @location(4) v_logDepth: f32,
    //>>endif
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

//>>ifdef LOG_DEPTH
// NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — renderer-wide log depth, canonical
// inline copies matching the color sibling (PointPrimitiveColor.wgsl). Compiled
// into the pick module ONLY when the pick-fleet gate is active; the //>>else
// path is byte-identical to today.
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

    // POINT-SPRITE-SHAPE — same WebGL-parity sizing as the color VS
    // (scaleByDistance on the TOTAL size, +3 AA padding, floor 1.0) so
    // the pick footprint matches the rendered footprint.
    // AUDIT_2026_05_02 A.14 (Batch 136) — apply EYE_DISTANCE_SCALING
    // before quad expansion. Same contract as color path.
    var totalSize: f32 = basePixelSize + 2.0 * outlineWidth;
    //>>ifdef EYE_DISTANCE_SCALING
    let distScale = czm_nearFarScalar(scaleByDistance, camDistSq);
    totalSize = totalSize * distScale;
    if (distScale == 0.0) {
        clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    //>>endif
    if (totalSize > 0.0) {
        totalSize = totalSize + 3.0;
    }
    if (totalSize < 1.0) {
        totalSize = 1.0;
    }
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
    // POINT-SPRITE-SHAPE — WebGL parity: v_pixelDistance = 2 / totalSize.
    output.pixelDistance = 2.0 / totalSize;

    //>>ifdef SPLIT_ENABLED
    output.splitDirection = perInstanceFlags.y;
    //>>endif

    //>>ifdef LOG_DEPTH
    // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH — mirror the color sibling's block
    // (PointPrimitiveColor.wgsl vertexMain). Computed AFTER every clipPos
    // override above. A forced z == 0 maps to v_logDepth = 1.0 (near plane).
    if (output.position.z == 0.0) {
        output.v_logDepth = 1.0;
    } else {
        output.v_logDepth = csm_vertexLogDepth(output.position, camera.logDepth.x);
    }
    output.position = csm_updatePositionDepth(output.position);
    //>>endif

    return output;
}

// NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — shared pick output. At defines=0
// (pick-fleet gate OFF) this is a single-field `@location(0)` struct,
// output-byte-identical to the historical bare `-> @location(0) vec4<f32>`
// return. When the gate is active the struct also carries the log-encoded
// `@builtin(frag_depth)` so the converted pick fleet depth-tests coherently in
// the shared pick FBO.
struct PickFragOutput {
    @location(0) color: vec4<f32>,
    //>>ifdef LOG_DEPTH
    @builtin(frag_depth) depth: f32,
    //>>endif
}

@fragment
fn fragmentMain(input: VertexOutput) -> PickFragOutput {
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

    var out: PickFragOutput;
    out.color = input.pickColor;
    //>>ifdef LOG_DEPTH
    out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepth.z);
    //>>endif
    return out;
}
