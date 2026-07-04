// Point Primitive Color Shader — WebGPU (with RTE precision)
// Renders points as instanced screen-space quads with circle + outline.
// WebGPU has no gl_PointSize/gl_PointCoord, so each point is a quad
// expanded in the vertex shader using vertex_index (0-5) for 2 triangles.
//
// Uses RTE (Relative-To-Eye) emulated 64-bit precision to eliminate
// jittering at planetary scale. Positions are encoded as high/low
// 32-bit float pairs and the encoded camera position is subtracted
// on the GPU to produce a small eye-relative offset.
//
// Batch 21 — unified CameraUniforms merges the former `MaterialUniforms`
// (bound at a non-existent @group(1)) with the existing CameraUniforms
// at @group(0). Pre-existing bug: the JS side only bound group 0, so any
// access to `material.*` read through a never-bound slot. Merging into
// the real UB also makes room for DP-H42 (`minimumDisableDepthTestDistance`)
// and wires `splitPosition` to something the JS actually uploads.

struct CameraUniforms {
    mvpRelativeToEye: mat4x4<f32>,            // bytes 0-63
    viewportSize: vec2<f32>,                   // bytes 64-71
    splitPosition: f32,                        // byte 72 (DP-H40)
    minimumDisableDepthTestDistance: f32,       // byte 76 (DP-H42)
    encodedCameraPositionMCHigh: vec3<f32>,    // bytes 80-91 (+4 pad)
    _pad0: f32,
    encodedCameraPositionMCLow: vec3<f32>,     // bytes 96-107 (+4 pad)
    _pad1: f32,
    // DP-H41 (Batch 27) — previous frame's viewProjection for
    // TAA / motion-vector reprojection. Sourced from
    // `UniformState._previousViewProjection` (f32 mat4).
    previousViewProjection: mat4x4<f32>,
    // Renderer-wide log depth (NEW-COLLECTIONS-LOG-DEPTH) — (near, far,
    // oneOverLog2FarDepthFromNearPlusOne, reserved) at floats 44-47.
    // Packed unconditionally by packUniforms; only the `//>>ifdef
    // LOG_DEPTH` blocks read it. See WebGPULogDepth.ts.
    logDepth: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) outlineColor: vec4<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) innerPercent: f32,
    @location(4) pixelDistance: f32,
    //>>ifdef SPLIT_ENABLED
    @location(5) splitDirection: f32,
    //>>endif
    //>>ifdef LOG_DEPTH
    // Interpolated linear depthFromNearPlusOne; FS converts to frag_depth.
    @location(6) v_logDepth: f32,
    //>>endif
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

//>>ifdef LOG_DEPTH
// Renderer-wide log depth (NEW-COLLECTIONS-LOG-DEPTH) — canonical inline
// copies; see chunks/functions/csm_{vertexLogDepth,writeLogDepth}.wgsl.
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

// Quad corners for 2 triangles (6 vertices per instance)
const QUAD_CORNERS = array<vec2<f32>, 6>(
    vec2<f32>(-0.5, -0.5),  // BL
    vec2<f32>( 0.5, -0.5),  // BR
    vec2<f32>( 0.5,  0.5),  // TR
    vec2<f32>(-0.5, -0.5),  // BL
    vec2<f32>( 0.5,  0.5),  // TR
    vec2<f32>(-0.5,  0.5),  // TL
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

// AUDIT_2026_05_02 A.14 (Batch 136) — WGSL port of `czm_nearFarScalar`.
// See `BillboardCollection.wgsl` for the canonical comment block.
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
    // Per-instance attributes (step_mode = instance):
    @location(0) posHighAndSize: vec4<f32>,     // positionHigh.xyz, pixelSize
    @location(1) posLowAndOutline: vec4<f32>,   // positionLow.xyz, outlineWidth
    @location(2) pointColor: vec4<f32>,          // color rgba
    @location(3) outColorAndShow: vec4<f32>,     // outlineColor.rgb, show (0/1)
    // DP-H42 / DP-H40 / A.14 perInstanceFlags. Same contract as Billboard:
    //   x = disableDepthTestDistance (meters; squared in shader)
    //   y = splitDirection (-1 / 0 / +1)
    //   z = distanceDisplayCondition.near^2 (Batch 136)
    //   w = distanceDisplayCondition.far^2 (Batch 136)
    @location(4) perInstanceFlags: vec4<f32>,
    // AUDIT_2026_05_02 A.14 (Batch 136) — translucencyByDistance + scaleByDistance
    // NearFarScalars (near, nearValue, far, farValue). Point has no
    // pixelOffset attribute, so the EYE_DISTANCE_PIXEL_OFFSET gate is
    // not consumed here.
    @location(5) translucencyByDistance: vec4<f32>,
    @location(6) scaleByDistance: vec4<f32>,
) -> VertexOutput {
    var output: VertexOutput;

    let show = outColorAndShow.w;
    if (show < 0.5) {
        output.position = vec4<f32>(0.0, 0.0, -2.0, 1.0);
        output.color = vec4<f32>(0.0);
        output.outlineColor = vec4<f32>(0.0);
        output.uv = vec2<f32>(0.0);
        output.innerPercent = 0.0;
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
    // This eliminates jittering at planetary-scale coordinates
    let eyeRelativePos = translateRelativeToEye(posHigh, posLow);
    // AUDIT_2026_05_02 A.14 (Batch 136) — squared eye distance, hoisted
    // for use by DDC + DISABLE_DEPTH + the two NearFarScalar gates.
    let camDistSq = dot(eyeRelativePos.xyz, eyeRelativePos.xyz);
    var clipPos = camera.mvpRelativeToEye * eyeRelativePos;

    // POINT-SPRITE-SHAPE — mirror PointPrimitiveCollectionVS sizing
    // exactly: outlinePercent from the UNPADDED size, scaleByDistance
    // applied to the TOTAL size (outline included, like WebGL), +3.0
    // anti-aliasing padding, floor at 1.0. Before this the WebGPU
    // sprite was 3px smaller with a thinner outline ring than WebGL.
    // (czm_pixelRatio and u_maxTotalPointSize are not plumbed into this
    // UB; probes run at DPR 1 and WebGPU has no aliased-point clamp.)
    let outlineBothSides = 2.0 * outlineWidth;
    var totalSize: f32 = basePixelSize + outlineBothSides;
    var outlinePercent: f32 = 0.0;
    if (totalSize > 0.0) {
        outlinePercent = outlineBothSides / totalSize;
    }
    // AUDIT_2026_05_02 A.14 (Batch 136) — apply EYE_DISTANCE_SCALING
    // before the quad expansion so scale=0 collapses the quad to a
    // point and the DDC clip-pos override doesn't fight the size
    // calculation.
    //>>ifdef EYE_DISTANCE_SCALING
    let distScale = czm_nearFarScalar(scaleByDistance, camDistSq);
    totalSize = totalSize * distScale;
    if (distScale == 0.0) {
        clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    //>>endif
    if (totalSize > 0.0) {
        totalSize = totalSize + 3.0; // WebGL AA padding
    }
    if (totalSize < 1.0) {
        totalSize = 1.0;
    }

    // Quad corner from vertex index (0-5)
    let corner = QUAD_CORNERS[vertexIndex % 6u];

    // Screen-space offset: corner * totalSize pixels → NDC offset
    let ndcOffset = vec2<f32>(
        corner.x * totalSize * 2.0 / camera.viewportSize.x,
        corner.y * totalSize * 2.0 / camera.viewportSize.y,
    );

    // Apply offset in clip space (multiply by w to maintain after perspective divide)
    clipPos = vec4<f32>(
        clipPos.x + ndcOffset.x * clipPos.w,
        clipPos.y + ndcOffset.y * clipPos.w,
        clipPos.z,
        clipPos.w,
    );

    //>>ifdef DISTANCE_DISPLAY_CONDITION
    // AUDIT_2026_05_02 A.14 (Batch 136) — gate visibility by squared
    // eye distance against the per-instance `[nearSq, farSq]` window
    // packed into `perInstanceFlags.zw`.
    let nearSqDDC = perInstanceFlags.z;
    let farSqDDC = perInstanceFlags.w;
    if (camDistSq < nearSqDDC || camDistSq > farSqDDC) {
        clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    //>>endif

    //>>ifdef DISABLE_DEPTH_DISTANCE
    // DP-H42 — override depth when within the per-instance or frame-wide
    // `disableDepthTestDistance`. Batch 140 — raw-sentinel pattern (see
    // BillboardCollection.wgsl). Pre-fix the squaring step killed the
    // sign on the `-1` "always disable" sentinel.
    //
    // Set `clipPos.z = 0.0` → NDC z = 0 = the WebGPU NEAR plane, so the point
    // always passes the `less-equal` depth test (renders ON TOP). The previous
    // `clipPos.z = clipPos.w` → NDC z = 1 = the FAR plane, which under
    // `less-equal` fails against the closer globe — pushing the point BEHIND
    // everything. WebGPU clip-z is [0,1] (near→far), not WebGL's [-1,1]; "on
    // top" is the near plane (0), not far. Mirrors the same fix in
    // BillboardCollection.wgsl.
    let disableRawDP = perInstanceFlags.x;
    if (disableRawDP < 0.0) {
        clipPos.z = 0.0;
    } else if (disableRawDP != 0.0) {
        let disableDepthSqDP = disableRawDP * disableRawDP;
        if (camDistSq < disableDepthSqDP) {
            clipPos.z = 0.0;
        }
    } else if (camera.minimumDisableDepthTestDistance != 0.0) {
        let frameMinSqDP =
            camera.minimumDisableDepthTestDistance *
            camera.minimumDisableDepthTestDistance;
        if (camDistSq < frameMinSqDP) {
            clipPos.z = 0.0;
        }
    }
    //>>endif

    output.position = clipPos;

    output.uv = corner;

    // AUDIT_2026_05_02 A.14 (Batch 136) — translucencyByDistance ramp
    // applied to both the fill (pointColor) and outline alpha so the
    // point fades coherently under camera distance changes.
    var effectiveAlpha: f32 = pointColor.a;
    //>>ifdef EYE_DISTANCE_TRANSLUCENCY
    let translucency = czm_nearFarScalar(translucencyByDistance, camDistSq);
    effectiveAlpha = effectiveAlpha * translucency;
    if (translucency == 0.0) {
        output.position = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    //>>endif
    output.color = vec4<f32>(pointColor.rgb, effectiveAlpha);
    output.outlineColor = vec4<f32>(outColorAndShow.xyz, effectiveAlpha);
    // POINT-SPRITE-SHAPE — WebGL parity: v_innerPercent = 1 - outlinePercent,
    // v_pixelDistance = 2 / totalSize (was 1/totalSize, halving the AA band).
    output.innerPercent = 1.0 - outlinePercent;
    output.pixelDistance = 2.0 / totalSize;

    //>>ifdef SPLIT_ENABLED
    // DP-H40 — forward split direction for per-fragment discard.
    output.splitDirection = perInstanceFlags.y;
    //>>endif

    //>>ifdef LOG_DEPTH
    // Computed AFTER every clipPos override above (DDC/translucency hide
    // collapse, DISABLE_DEPTH_DISTANCE z = 0 near-plane trick). Forced
    // z == 0 maps to v_logDepth = 1.0 -> frag_depth 0 (near plane),
    // mirroring WebGL's v_depthFromNearPlusOne = 1.0 convention.
    if (output.position.z == 0.0) {
        output.v_logDepth = 1.0;
    } else {
        output.v_logDepth = csm_vertexLogDepth(output.position, camera.logDepth.x);
    }
    output.position = csm_updatePositionDepth(output.position);
    //>>endif

    return output;
}

struct FragOutput {
    @location(0) color: vec4<f32>,
    //>>ifdef LOG_DEPTH
    // Written for the depth TEST as well (frag_depth replaces the
    // rasterized z), so the translucent point pass tests correctly
    // against the globe's log depth.
    @builtin(frag_depth) depth: f32,
    //>>endif
}

@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
    //>>ifdef SPLIT_ENABLED
    // DP-H40 — discard pixels on the wrong side of the split cutoff.
    if (input.splitDirection < 0.0 && input.position.x > camera.splitPosition) {
        discard;
    }
    if (input.splitDirection > 0.0 && input.position.x < camera.splitPosition) {
        discard;
    }
    //>>endif

    // Distance from center of the point (0 at center, ~0.707 at corner)
    let distanceToCenter = length(input.uv);

    // Anti-aliasing: stop 1 pixel shy of edge
    let maxDistance = max(0.0, 0.5 - input.pixelDistance);
    let wholeAlpha = 1.0 - smoothstep(maxDistance, 0.5, distanceToCenter);
    let innerAlpha = 1.0 - smoothstep(
        maxDistance * input.innerPercent,
        0.5 * input.innerPercent,
        distanceToCenter
    );

    // Mix outline and fill colors
    var color = mix(input.outlineColor, input.color, innerAlpha);
    color = vec4<f32>(color.rgb, color.a * wholeAlpha);

    // Q13-PLAIN-HDR-GAMMA-CORE — mirror WebGL PointPrimitiveCollectionFS.glsl's
    // `out_FragColor = czm_gammaCorrect(color)` (gated on `#ifdef HDR`, identity
    // in SDR). `camera.logDepth.w` holds czm_gamma when `scene.highDynamicRange`
    // is on, else 0 → skipped, so the default SDR path is byte-identical.
    if (camera.logDepth.w > 0.5) {
        color = vec4<f32>(
            pow(max(color.rgb, vec3<f32>(0.0)), vec3<f32>(camera.logDepth.w)),
            color.a
        );
    }

    if (color.a < 0.005) {
        discard;
    }

    var out: FragOutput;
    out.color = color;
    //>>ifdef LOG_DEPTH
    out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepth.z);
    //>>endif
    return out;
}

// AUDIT_2026_05_02 B.10 (Batch 148, NEW-COLLECTIONS-MOTION-VECTORS) —
// per-pixel velocity emission for animated points. Mirrors the
// Billboard pattern from Batch 143; see `BillboardCollection.wgsl`
// for the full design notes (center-only delta, prev-instance VB at
// slot 1, w<=0 fallback).
//
// Point's instance buffer uses locations 0-6 (7 vec4 / 28 floats);
// prev-position locations are 7 (high+_) and 8 (low+_).

struct VelocityVertexInput {
  @builtin(vertex_index) vertexIndex: u32,
  // Slot 0: current instance data (mirrors regular VS attributes).
  @location(0) posHighAndSize: vec4<f32>,
  @location(1) posLowAndOutline: vec4<f32>,
  @location(2) pointColor: vec4<f32>,
  @location(3) outColorAndShow: vec4<f32>,
  @location(4) perInstanceFlags: vec4<f32>,
  @location(5) translucencyByDistance: vec4<f32>,
  @location(6) scaleByDistance: vec4<f32>,
  // Slot 1: prev-frame instance data — only positions matter.
  @location(7) prevPosHighAndSize: vec4<f32>,
  @location(8) prevPosLowAndOutline: vec4<f32>,
};

struct VelocityVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) currentCenterClip: vec4<f32>,
  @location(1) prevCenterClip: vec4<f32>,
  //>>ifdef LOG_DEPTH
  // Velocity pass shares scene depth read-only — test in log space.
  @location(2) v_logDepth: f32,
  //>>endif
};

@vertex
fn vertexVelocityMain(input: VelocityVertexInput) -> VelocityVertexOutput {
  var output: VelocityVertexOutput;

  let show = input.outColorAndShow.w;
  if (show < 0.5) {
    output.position = vec4<f32>(0.0, 0.0, -2.0, 1.0);
    output.currentCenterClip = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    output.prevCenterClip = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    return output;
  }

  let posHigh = input.posHighAndSize.xyz;
  let posLow = input.posLowAndOutline.xyz;
  let basePixelSize = input.posHighAndSize.w;
  let outlineWidth = input.posLowAndOutline.w;

  // Current-frame center clip via RTE.
  let eyeRelativePos = translateRelativeToEye(posHigh, posLow);
  let currentCenterClip = camera.mvpRelativeToEye * eyeRelativePos;

  // Previous-frame center clip via full mat4.
  let prevPosHigh = input.prevPosHighAndSize.xyz;
  let prevPosLow = input.prevPosLowAndOutline.xyz;
  let prevWorldPos = vec4<f32>(prevPosHigh + prevPosLow, 1.0);
  let prevCenterClip = camera.previousViewProjection * prevWorldPos;

  // Rasterize the point quad at the CURRENT-frame position so the
  // velocity texture covers the same pixels the color pass touched.
  // Same QUAD_CORNERS expansion as `vertexMain`.
  var clipPos = currentCenterClip;
  // POINT-SPRITE-SHAPE — +3 AA padding matches the color VS so the
  // velocity quad stays coverage-identical to the color quad.
  var totalSize = basePixelSize + 2.0 * outlineWidth;
  if (totalSize > 0.0) {
    totalSize = totalSize + 3.0;
  }
  if (totalSize < 1.0) {
    totalSize = 1.0;
  }
  let corner = QUAD_CORNERS[input.vertexIndex % 6u];
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

  output.position = clipPos;
  output.currentCenterClip = currentCenterClip;
  output.prevCenterClip = prevCenterClip;
  //>>ifdef LOG_DEPTH
  output.v_logDepth = csm_vertexLogDepth(output.position, camera.logDepth.x);
  output.position = csm_updatePositionDepth(output.position);
  //>>endif
  return output;
}

struct VelocityFragOutput {
  @location(0) velocity: vec2<f32>,
  //>>ifdef LOG_DEPTH
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment
fn fragmentVelocityMain(input: VelocityVertexOutput) -> VelocityFragOutput {
  var out: VelocityFragOutput;
  //>>ifdef LOG_DEPTH
  out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepth.z);
  //>>endif
  let curW = input.currentCenterClip.w;
  let prevW = input.prevCenterClip.w;
  if (curW <= 0.0 || prevW <= 0.0) {
    out.velocity = vec2<f32>(0.0);
    return out;
  }
  let curNdc = input.currentCenterClip.xy / curW;
  let prevNdc = input.prevCenterClip.xy / prevW;
  out.velocity = curNdc - prevNdc;
  return out;
}
