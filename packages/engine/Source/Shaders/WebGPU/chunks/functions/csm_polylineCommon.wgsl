// csm_polylineCommon.wgsl
//
// WGSL port of Shaders/PolylineCommon.glsl — the screen-space width
// expansion + miter-join math that turns the 4 coincident quad vertices
// of a polyline segment (emitted by PolylineGeometry) into a ribbon of
// the requested pixel width. Used by the WebGPU primitive path for the
// COLOR slice of NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU.
//
// GLSL uses `out` params; WGSL has none, so each helper returns a struct.
//
// DEPTH RANGE (WebGPU vs WebGL):
//   WebGL clip-z is [-1, 1]; WebGPU clip-z is [0, 1]. The original GLSL
//   relied on `czm_viewportTransformation` to remap NDC-z [-1,1] -> [0,1]
//   (window.z = 0.5*ndc.z + 0.5) and `czm_viewportOrthographic` to map it
//   back. On WebGPU the projection already yields ndc.z in [0,1], so we
//   must NOT re-apply the 0.5*z+0.5 remap or the final depth squishes into
//   [0.5, 1]. `csm_polylineWindowZ` keeps the raw WebGPU ndc.z so the
//   round-trip through the WebGPU `viewportOrthographic` (built with
//   Matrix4.setDepthRangeType("webgpu")) lands the final ndc.z back in
//   [0, 1]. The x/y window math is identical to GLSL — raw NDC fed through
//   `viewportTransformation` (which carries the halfWidth/halfHeight scale).
//
// Requires (passed in, not global): projection, viewportTransformation,
// modelViewRTE, viewportOrthographic, pixelRatio, near.
//
// @chunk functions/csm_polylineCommon

const CSM_POLYLINE_EPSILON1: f32 = 0.1;
const CSM_POLYLINE_EPSILON6: f32 = 0.000001;
const CSM_POLYLINE_EPSILON7: f32 = 0.0000001;

struct CsmClipResult {
    positionWC: vec4<f32>,
    clipped: bool,
    culledByNearPlane: bool,
    clippedPositionEC: vec4<f32>,
}

// Eye -> window coordinates. Mirrors czm_eyeToWindowCoordinates but keeps
// the raw WebGPU ndc.z in window.z (see DEPTH RANGE note above). window.w
// is the original clip-w, used to re-homogenize the final clip position.
fn csm_polylineEyeToWindow(
    positionEC: vec4<f32>,
    projection: mat4x4<f32>,
    viewportTransformation: mat4x4<f32>
) -> vec4<f32> {
    let clip: vec4<f32> = projection * positionEC;
    let ndc: vec3<f32> = clip.xyz / clip.w;
    // Feed raw NDC (x,y in [-1,1]) through the viewport transform exactly
    // as GLSL czm_eyeToWindowCoordinates does. The transform's halfWidth/
    // halfHeight + center translation produce pixel coordinates.
    var window: vec4<f32> = viewportTransformation * vec4<f32>(ndc, 1.0);
    // Override the z that the viewport transform produced (the WebGL
    // 0.5*ndc.z+0.5 remap) with the raw WebGPU depth so the final
    // round-trip stays in [0,1].
    window.z = ndc.z;
    window.w = clip.w;
    return window;
}

// Port of clipLineSegmentToNearPlane (PolylineCommon.glsl). Clips p0->p1 to
// the near plane and returns the clipped p0 in window coordinates.
fn csm_clipLineSegmentToNearPlane(
    p0In: vec3<f32>,
    p1: vec3<f32>,
    near: f32,
    projection: mat4x4<f32>,
    viewportTransformation: mat4x4<f32>
) -> CsmClipResult {
    var result: CsmClipResult;
    result.culledByNearPlane = false;
    result.clipped = false;

    var p0: vec3<f32> = p0In;

    let p0ToP1: vec3<f32> = p1 - p0;
    let magnitude: f32 = length(p0ToP1);
    let direction: vec3<f32> = normalize(p0ToP1);

    // Distance that p0 is behind the near plane (positive => behind).
    let endPoint0Distance: f32 = near + p0.z;

    // Positive denominator: -Z, becoming more visible.
    let denominator: f32 = -direction.z;

    if (endPoint0Distance > 0.0 && abs(denominator) < CSM_POLYLINE_EPSILON7) {
        // p0 behind near plane, segment nearly parallel — cull entirely.
        result.culledByNearPlane = true;
    } else if (endPoint0Distance > 0.0) {
        let t: f32 = endPoint0Distance / denominator;
        if (t < 0.0 || t > magnitude) {
            result.culledByNearPlane = true;
        } else {
            p0 = p0 + t * direction;
            // Guard against numerical noise pushing us past the near plane.
            p0.z = min(p0.z, -near);
            result.clipped = true;
        }
    }

    result.clippedPositionEC = vec4<f32>(p0, 1.0);
    result.positionWC = csm_polylineEyeToWindow(
        result.clippedPositionEC, projection, viewportTransformation);
    return result;
}

// Port of getPolylineWindowCoordinatesEC (PolylineCommon.glsl). The
// POLYLINE_DASH `angle` out-param is dropped here — the COLOR slice doesn't
// need it. The MATERIAL slice gets the angle from the
// `...WithAngle` variants below, which reuse this function for positionWC.
fn csm_getPolylineWindowCoordinatesEC(
    positionEC: vec4<f32>,
    prevEC: vec4<f32>,
    nextEC: vec4<f32>,
    expandDirection: f32,
    width: f32,
    usePrevious: bool,
    projection: mat4x4<f32>,
    viewportTransformation: mat4x4<f32>,
    pixelRatio: f32,
    near: f32
) -> vec4<f32> {
    let prevClip: CsmClipResult = csm_clipLineSegmentToNearPlane(
        prevEC.xyz, positionEC.xyz, near, projection, viewportTransformation);
    let nextClip: CsmClipResult = csm_clipLineSegmentToNearPlane(
        nextEC.xyz, positionEC.xyz, near, projection, viewportTransformation);

    var otherEnd: vec3<f32> = nextEC.xyz;
    if (usePrevious) {
        otherEnd = prevEC.xyz;
    }
    let positionClip: CsmClipResult = csm_clipLineSegmentToNearPlane(
        positionEC.xyz, otherEnd, near, projection, viewportTransformation);

    if (positionClip.culledByNearPlane) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    let clippedPositionWC: vec4<f32> = positionClip.positionWC;
    let clippedPositionEC: vec4<f32> = positionClip.clippedPositionEC;

    var directionToPrevWC: vec2<f32> =
        normalize(prevClip.positionWC.xy - clippedPositionWC.xy);
    var directionToNextWC: vec2<f32> =
        normalize(nextClip.positionWC.xy - clippedPositionWC.xy);

    // If a segment was culled, reuse the opposite direction.
    if (prevClip.culledByNearPlane) {
        directionToPrevWC = -directionToNextWC;
    } else if (nextClip.culledByNearPlane) {
        directionToNextWC = -directionToPrevWC;
    }

    var thisSegmentForwardWC: vec2<f32>;
    var otherSegmentForwardWC: vec2<f32>;
    if (usePrevious) {
        thisSegmentForwardWC = -directionToPrevWC;
        otherSegmentForwardWC = directionToNextWC;
    } else {
        thisSegmentForwardWC = directionToNextWC;
        otherSegmentForwardWC = -directionToPrevWC;
    }

    let thisSegmentLeftWC: vec2<f32> =
        vec2<f32>(-thisSegmentForwardWC.y, thisSegmentForwardWC.x);

    var leftWC: vec2<f32> = thisSegmentLeftWC;
    var expandWidth: f32 = width * 0.5;

    // Anti-meridian split safety: when this position coincides with prev or
    // next, the miter math produces NaNs — fall back to the segment left.
    let prevDelta: vec3<f32> = prevEC.xyz - positionEC.xyz;
    let nextDelta: vec3<f32> = nextEC.xyz - positionEC.xyz;
    let prevCoincident: bool =
        all(abs(prevDelta) < vec3<f32>(CSM_POLYLINE_EPSILON1));
    let nextCoincident: bool =
        all(abs(nextDelta) < vec3<f32>(CSM_POLYLINE_EPSILON1));

    if (!prevCoincident && !nextCoincident) {
        let otherSegmentLeftWC: vec2<f32> =
            vec2<f32>(-otherSegmentForwardWC.y, otherSegmentForwardWC.x);

        let leftSumWC: vec2<f32> = thisSegmentLeftWC + otherSegmentLeftWC;
        let leftSumLength: f32 = length(leftSumWC);
        if (leftSumLength < CSM_POLYLINE_EPSILON6) {
            leftWC = thisSegmentLeftWC;
        } else {
            leftWC = leftSumWC / leftSumLength;
        }

        // sinAngle = |u x v| where u = -thisSegmentForwardWC, v = leftWC.
        // Both have z=0, so the cross product reduces to the z component.
        let u: vec2<f32> = -thisSegmentForwardWC;
        let v: vec2<f32> = leftWC;
        let sinAngle: f32 = abs(u.x * v.y - u.y * v.x);
        expandWidth = clamp(expandWidth / sinAngle, 0.0, width * 2.0);
    }

    let offset: vec2<f32> = leftWC * expandDirection * expandWidth * pixelRatio;
    // Re-homogenize: multiply by the clip-w so the perspective divide in the
    // ortho transform recovers the right pixel position. `-clippedPositionWC.z`
    // keeps the WebGPU-correct depth (see DEPTH RANGE note + csm_polylineWindowZ).
    let clipW: f32 = (projection * clippedPositionEC).w;
    return vec4<f32>(
        clippedPositionWC.xy + offset,
        -clippedPositionWC.z,
        1.0
    ) * clipW;
}

// Port of getPolylineWindowCoordinates (PolylineCommon.glsl). Transforms the
// RTE model positions to eye space via modelViewRTE, then computes the
// width-expanded window position. The caller multiplies the result by
// viewportOrthographic to produce the final clip-space position.
fn csm_getPolylineWindowCoordinates(
    position: vec4<f32>,
    previous: vec4<f32>,
    next: vec4<f32>,
    expandDirection: f32,
    width: f32,
    usePrevious: bool,
    modelViewRTE: mat4x4<f32>,
    projection: mat4x4<f32>,
    viewportTransformation: mat4x4<f32>,
    pixelRatio: f32,
    near: f32
) -> vec4<f32> {
    let positionEC: vec4<f32> = modelViewRTE * position;
    let prevEC: vec4<f32> = modelViewRTE * previous;
    let nextEC: vec4<f32> = modelViewRTE * next;
    return csm_getPolylineWindowCoordinatesEC(
        positionEC, prevEC, nextEC,
        expandDirection, width, usePrevious,
        projection, viewportTransformation, pixelRatio, near);
}

// ---------------------------------------------------------------------------
// MATERIAL slice — angle-returning variants
// ---------------------------------------------------------------------------
//
// The MATERIAL slice (PolylineDash, etc.) needs the screen-space polyline
// angle that the COLOR-slice functions above intentionally dropped. Rather
// than fork the whole expansion math, these variants reuse
// csm_getPolylineWindowCoordinatesEC for the positionWC and only add the
// angle computation, returning both in a struct. The angle math is a port
// of the `#ifdef POLYLINE_DASH` block in PolylineCommon.glsl
// getPolylineWindowCoordinatesEC: window-space line direction quantized to
// the nearest pi/4. v_polylineAngle is consumed by the dash FS to rotate
// gl_FragCoord so the dash pattern runs along the line.

const CSM_POLYLINE_PI_OVER_FOUR: f32 = 0.785398163397448;
// atan(1.0, 0.0) — the GLSL precomputed `1.570796327` offset.
const CSM_POLYLINE_HALF_PI: f32 = 1.5707963267948966;

struct CsmPolylineWindowResult {
    positionWC: vec4<f32>,
    angle: f32,
}

fn csm_getPolylineWindowCoordinatesECWithAngle(
    positionEC: vec4<f32>,
    prevEC: vec4<f32>,
    nextEC: vec4<f32>,
    expandDirection: f32,
    width: f32,
    usePrevious: bool,
    projection: mat4x4<f32>,
    viewportTransformation: mat4x4<f32>,
    pixelRatio: f32,
    near: f32
) -> CsmPolylineWindowResult {
    var result: CsmPolylineWindowResult;

    // Window coords of the (unclipped) endpoints — matches the GLSL DASH
    // block which uses czm_eyeToWindowCoordinates directly, not the
    // near-plane-clipped positions.
    let positionWindow: vec4<f32> =
        csm_polylineEyeToWindow(positionEC, projection, viewportTransformation);
    let previousWindow: vec4<f32> =
        csm_polylineEyeToWindow(prevEC, projection, viewportTransformation);
    let nextWindow: vec4<f32> =
        csm_polylineEyeToWindow(nextEC, projection, viewportTransformation);

    var lineDir: vec2<f32>;
    if (usePrevious) {
        lineDir = normalize(positionWindow.xy - previousWindow.xy);
    } else {
        lineDir = normalize(nextWindow.xy - positionWindow.xy);
    }
    var angle: f32 = atan2(lineDir.x, lineDir.y) - CSM_POLYLINE_HALF_PI;
    // Quantize so the angle doesn't change rapidly between segments.
    angle = floor(angle / CSM_POLYLINE_PI_OVER_FOUR + 0.5) * CSM_POLYLINE_PI_OVER_FOUR;
    result.angle = angle;

    result.positionWC = csm_getPolylineWindowCoordinatesEC(
        positionEC, prevEC, nextEC,
        expandDirection, width, usePrevious,
        projection, viewportTransformation, pixelRatio, near);
    return result;
}

fn csm_getPolylineWindowCoordinatesWithAngle(
    position: vec4<f32>,
    previous: vec4<f32>,
    next: vec4<f32>,
    expandDirection: f32,
    width: f32,
    usePrevious: bool,
    modelViewRTE: mat4x4<f32>,
    projection: mat4x4<f32>,
    viewportTransformation: mat4x4<f32>,
    pixelRatio: f32,
    near: f32
) -> CsmPolylineWindowResult {
    let positionEC: vec4<f32> = modelViewRTE * position;
    let prevEC: vec4<f32> = modelViewRTE * previous;
    let nextEC: vec4<f32> = modelViewRTE * next;
    return csm_getPolylineWindowCoordinatesECWithAngle(
        positionEC, prevEC, nextEC,
        expandDirection, width, usePrevious,
        projection, viewportTransformation, pixelRatio, near);
}

// ---------------------------------------------------------------------------
// Log-depth helpers (NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU — 376c)
// ---------------------------------------------------------------------------
//
// Renderer-wide logarithmic depth for the polyline appearance/material path.
// Canonical inline copies; see chunks/functions/csm_{vertexLogDepth,
// writeLogDepth}.wgsl and the identical block in Collections/
// PolylineCollection.wgsl (lines 48-62). Gated by `//>>ifdef LOG_DEPTH` so the
// non-log variant (defines=0) is byte-identical to the historical path — these
// functions don't exist in the compiled module unless the master switch is on.
//
// The appearance VS multiplies its screen-space window position by
// `viewportOrthographic`, whose bottom row is [0,0,0,1]; because
// `csm_getPolylineWindowCoordinates*` re-homogenizes by the eye-space clip-w,
// the resulting `output.position.w` equals that clip-w (the positive eye
// distance) — exactly what `csm_vertexLogDepth` expects (mirrors WebGL's
// `czm_vertexLogDepth()` reading `gl_Position.w` after `czm_viewportOrthographic`).
//>>ifdef LOG_DEPTH
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
