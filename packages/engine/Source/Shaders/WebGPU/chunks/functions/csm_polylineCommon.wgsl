// csm_polylineCommon.wgsl
//
// WGSL port of Shaders/PolylineCommon.glsl — the screen-space width
// expansion + miter-join math that turns the 4 coincident quad vertices
// of a polyline segment (emitted by PolylineGeometry) into a ribbon of
// the requested pixel width. The WebGPU primitive path uses these helpers
// for color and material polyline appearances.
//
// GLSL uses `out` params; WGSL has none, so the window-coordinate helpers
// return structs. The near-plane clip, the per-end selection and the joint
// step are also exposed as pure helpers that return vectors, with the clip
// status as an f32 (0.0 unclipped, 1.0 clipped, 2.0 culled), so a vertex stage
// that keeps its own quad expansion can apply the same clip to its segment
// ends.
//
// Consumers: the primitive polyline shaders (prepended by
// WebGPUPrimitiveShaders.js), the six PolylineCollection shaders (prepended by
// WebGPUCollectionShaders.js), and BufferPolylineMaterial.wgsl (through the
// buffer renderer's chunk table).
//
// WebGPU depth range:
//   WebGL clip-z is [-1, 1]; WebGPU clip-z is [0, 1]. The original GLSL
//   relied on `czm_viewportTransformation` to remap NDC-z [-1,1] -> [0,1]
//   (window.z = 0.5*ndc.z + 0.5) and `czm_viewportOrthographic` to map it
//   back. A WebGPU projection already yields ndc.z in [0,1], so reapplying
//   the 0.5*z+0.5 remap would squeeze the final depth into [0.5, 1].
//   Keeping the raw WebGPU ndc.z in `csm_polylineWindowZ` lets the round-trip
//   through `viewportOrthographic` land the final ndc.z back in [0, 1]. The
//   owning context builds that matrix with the WebGPU clip-space convention.
//   The x/y window math is identical to GLSL: raw NDC passes through
//   `viewportTransformation`, which carries the half-width and half-height.
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
// the raw WebGPU ndc.z in window.z (see the depth-range note above). window.w
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
    let window: vec4<f32> = viewportTransformation * vec4<f32>(ndc, 1.0);
    // Replace the z that the viewport transform produced (the WebGL
    // 0.5*ndc.z+0.5 remap) with the raw WebGPU depth so the final
    // round-trip stays in [0,1], and carry the clip w.
    return vec4<f32>(window.xy, ndc.z, clip.w);
}

// The near-plane test of clipLineSegmentToNearPlane (PolylineCommon.glsl) for
// the segment p0 -> p1 in eye coordinates. Returns (t, status): status 0.0
// when p0 is in front of the near plane, 1.0 when the segment crosses it, and
// 2.0 when the whole segment is behind it or p0 is behind it on a segment
// nearly parallel to it. When the status is 1.0, t is the distance from p0
// along the segment's unit direction to the plane. Same operations, in the
// same order, as the GLSL.
fn csm_polylineNearClipT(p0: vec3<f32>, p1: vec3<f32>, near: f32) -> vec2<f32> {
    let p0ToP1: vec3<f32> = p1 - p0;
    let magnitude: f32 = length(p0ToP1);
    let direction: vec3<f32> = normalize(p0ToP1);
    // Distance that p0 is behind the near plane (positive => behind).
    let endPoint0Distance: f32 = near + p0.z;
    // Positive denominator: -Z, becoming more visible.
    let denominator: f32 = -direction.z;
    if (endPoint0Distance <= 0.0) {
        return vec2<f32>(0.0, 0.0);
    }
    if (abs(denominator) < CSM_POLYLINE_EPSILON7) {
        return vec2<f32>(0.0, 2.0);
    }
    let t: f32 = endPoint0Distance / denominator;
    if (t < 0.0 || t > magnitude) {
        return vec2<f32>(t, 2.0);
    }
    return vec2<f32>(t, 1.0);
}

// The clipped p0 for a status from csm_polylineNearClipT: p0 moved by t along
// the segment's unit direction, with its z held on the near side of the plane
// against rounding, when the status is 1.0; p0 itself otherwise. The move is
// selected rather than scaled by zero because a zero-length segment has a NaN
// direction.
fn csm_polylineNearClipPoint(
    p0: vec3<f32>,
    p1: vec3<f32>,
    near: f32,
    t: f32,
    status: f32
) -> vec3<f32> {
    let moved: vec3<f32> = p0 + t * normalize(p1 - p0);
    let onPlane: vec3<f32> = vec3<f32>(moved.x, moved.y, min(moved.z, -near));
    return select(p0, onPlane, status == 1.0);
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
    let clip: vec2<f32> = csm_polylineNearClipT(p0In, p1, near);
    let p0: vec3<f32> = csm_polylineNearClipPoint(p0In, p1, near, clip.x, clip.y);

    var result: CsmClipResult;
    result.clipped = clip.y == 1.0;
    result.culledByNearPlane = clip.y == 2.0;
    result.clippedPositionEC = vec4<f32>(p0, 1.0);
    result.positionWC = csm_polylineEyeToWindow(
        result.clippedPositionEC, projection, viewportTransformation);
    return result;
}

// The clip position of one end of a segment for a vertex stage that projects
// its ends itself. `ownEC` is this end and `otherEC` the segment's other end,
// both in eye coordinates, and `historical` is the clip position the stage
// computed for `ownEC`. Returns `historical` unchanged when this end is in
// front of the near plane, the projection of the end clipped onto the plane
// when the segment crosses it, and (0, 0, 0, 1) when the segment is culled,
// as getPolylineWindowCoordinatesEC returns for a culled segment.
fn csm_polylineClipEnd(
    ownEC: vec3<f32>,
    otherEC: vec3<f32>,
    near: f32,
    projection: mat4x4<f32>,
    historical: vec4<f32>
) -> vec4<f32> {
    let clip: vec2<f32> = csm_polylineNearClipT(ownEC, otherEC, near);
    let status: f32 = clip.y;
    let clippedEC: vec3<f32> =
        csm_polylineNearClipPoint(ownEC, otherEC, near, clip.x, status);
    let clippedClip: vec4<f32> = projection * vec4<f32>(clippedEC, 1.0);
    let kept: vec4<f32> = select(historical, clippedClip, status == 1.0);
    return select(kept, vec4<f32>(0.0, 0.0, 0.0, 1.0), status == 2.0);
}

// The previous-frame clip position of the point csm_polylineClipEnd clipped
// to. `prevOwn` and `prevOther` are the previous-frame clip positions of this
// end and of the segment's other end, and `t` and `status` come from
// csm_polylineNearClipT over the current eye-space ends, whose distance apart
// is `magnitude`. Clip coordinates are linear in the world point, so the
// clipped point's previous clip position lies the same fraction t / magnitude
// of the way from `prevOwn` to `prevOther`. Returns `prevOwn` unchanged unless
// the status is 1.0.
fn csm_polylinePreviousClip(
    prevOwn: vec4<f32>,
    prevOther: vec4<f32>,
    t: f32,
    magnitude: f32,
    status: f32
) -> vec4<f32> {
    let moved: vec4<f32> = prevOwn + (prevOther - prevOwn) * (t / magnitude);
    return select(prevOwn, moved, status == 1.0);
}

// A varying the fragment stage reads linearly in screen space, as WebGL reads
// the across-line coordinate v_st.t through czm_writeNonPerspective and
// czm_readNonPerspective (PolylineVS.glsl:98, PolylineFS.glsl:12). The
// rasterizer interpolates (value * w, w) with perspective, and the ratio of the
// two is the screen-linear interpolation of value. It matters once an end is
// clipped: the clipped end's clip w is about the near distance while the other
// end keeps the segment's far distance, and a perspective-interpolated
// across-line coordinate then leans to the near end's corner over most of
// each triangle of the quad, so the edge fade erased the line toward the eye.
// clipW is the w of the vertex's final clip position.
fn csm_polylineWriteScreenLinear(value: f32, clipW: f32) -> vec2<f32> {
    return vec2<f32>(value * clipW, clipW);
}

// The fragment-stage read of csm_polylineWriteScreenLinear.
fn csm_polylineReadScreenLinear(written: vec2<f32>) -> f32 {
    return written.x / written.y;
}

// The joint of getPolylineWindowCoordinatesEC (PolylineCommon.glsl) at a
// vertex: the window-space left direction the vertex is extruded along, in xy,
// and the extrusion half-width before the pixel ratio, in z. `coincident` is
// true when this position coincides with its previous or next position (an
// anti-meridian split); then, as at a joint whose two left directions cancel
// (a 180-degree turn), the vertex takes its own segment's left direction.
fn csm_polylineJoin(
    thisSegmentForwardWC: vec2<f32>,
    otherSegmentForwardWC: vec2<f32>,
    width: f32,
    coincident: bool
) -> vec3<f32> {
    let thisSegmentLeftWC: vec2<f32> =
        vec2<f32>(-thisSegmentForwardWC.y, thisSegmentForwardWC.x);
    if (coincident) {
        return vec3<f32>(thisSegmentLeftWC, width * 0.5);
    }
    let otherSegmentLeftWC: vec2<f32> =
        vec2<f32>(-otherSegmentForwardWC.y, otherSegmentForwardWC.x);
    let leftSumWC: vec2<f32> = thisSegmentLeftWC + otherSegmentLeftWC;
    let leftSumLength: f32 = length(leftSumWC);
    let leftWC: vec2<f32> = select(
        leftSumWC / leftSumLength,
        thisSegmentLeftWC,
        leftSumLength < CSM_POLYLINE_EPSILON6);
    // sinAngle = |u x v| where u = -thisSegmentForwardWC, v = leftWC.
    // Both have z=0, so the cross product reduces to the z component.
    let u: vec2<f32> = vec2<f32>(-thisSegmentForwardWC.x, -thisSegmentForwardWC.y);
    let sinAngle: f32 = abs(u.x * leftWC.y - u.y * leftWC.x);
    let expandWidth: f32 = clamp(width * 0.5 / sinAngle, 0.0, width * 2.0);
    return vec3<f32>(leftWC, expandWidth);
}

// Port of getPolylineWindowCoordinatesEC (PolylineCommon.glsl). Color
// appearances do not need the `POLYLINE_DASH` angle output. Material
// appearances get it from the `...WithAngle` variants below, which reuse this
// function for positionWC.
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

    // Anti-meridian split safety: when this position coincides with prev or
    // next, the miter math produces NaNs — fall back to the segment left.
    let prevDelta: vec3<f32> = prevEC.xyz - positionEC.xyz;
    let nextDelta: vec3<f32> = nextEC.xyz - positionEC.xyz;
    let prevCoincident: bool =
        all(abs(prevDelta) < vec3<f32>(CSM_POLYLINE_EPSILON1));
    let nextCoincident: bool =
        all(abs(nextDelta) < vec3<f32>(CSM_POLYLINE_EPSILON1));

    let joint: vec3<f32> = csm_polylineJoin(
        thisSegmentForwardWC, otherSegmentForwardWC, width,
        prevCoincident || nextCoincident);
    let leftWC: vec2<f32> = joint.xy;
    let expandWidth: f32 = joint.z;

    let offset: vec2<f32> = leftWC * expandDirection * expandWidth * pixelRatio;
    // Re-homogenize: multiply by the clip-w so the perspective divide in the
    // ortho transform recovers the right pixel position. `-clippedPositionWC.z`
    // keeps the WebGPU-correct depth (see the depth-range note and
    // csm_polylineWindowZ).
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

// Material slice: angle-returning variants.
//
// Material appearances such as PolylineDash need the screen-space polyline
// angle omitted by color appearances. These variants reuse
// csm_getPolylineWindowCoordinatesEC for positionWC and add only the angle
// computation, returning both in a struct. The angle math ports the
// `POLYLINE_DASH` block in PolylineCommon.glsl: it quantizes the window-space
// line direction to the nearest pi/4. The dash fragment shader uses
// v_polylineAngle to rotate gl_FragCoord so the pattern follows the line.

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

    // Window coords of the unclipped endpoints match the GLSL `POLYLINE_DASH`
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

// Scene-mode position blend.
//
// WGSL port of `czm_computePosition` from
// `PrimitiveShaderHelpers.modifyShaderPosition`. It blends 3D and 2D RTE
// positions by `morphTime`: 3D at 1, 2D/CV at 0, and a Columbus View lerp in
// between. The 2D attributes are .zxy-swizzled into the Columbus View frame
// because the projection stores easting, northing, height while CV expects
// height, easting, northing. This matches the WebGL appearance vertex shader.
// In 2D/CV, `camera.encodedCameraHigh/Low` already holds the CV-frame camera
// position, so the same RTE subtraction handles both branches.
fn csm_polylineRTE(
    high: vec3<f32>, low: vec3<f32>,
    camHigh: vec3<f32>, camLow: vec3<f32>
) -> vec4<f32> {
    var highDiff = high - camHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    return vec4<f32>(highDiff + (low - camLow), 1.0);
}

fn csm_computePolylinePosition(
    high3D: vec3<f32>, low3D: vec3<f32>,
    high2D: vec3<f32>, low2D: vec3<f32>,
    camHigh: vec3<f32>, camLow: vec3<f32>,
    morphTime: f32
) -> vec4<f32> {
    let p3D = csm_polylineRTE(high3D, low3D, camHigh, camLow);
    if (morphTime >= 1.0) {
        return p3D;
    }
    let p2D = csm_polylineRTE(high2D.zxy, low2D.zxy, camHigh, camLow);
    if (morphTime <= 0.0) {
        return p2D;
    }
    // Manual lerp avoids mix() jitter and matches csm_columbusViewMorph.
    let pm = p2D.xyz * (1.0 - morphTime) + p3D.xyz * morphTime;
    return vec4<f32>(pm, 1.0);
}

// Log-depth helpers.
//
// Renderer-wide logarithmic depth for every polyline-family shader: the
// primitive polyline shaders, the six PolylineCollection shaders and
// BufferPolylineMaterial.wgsl all take these three helpers from this chunk and
// declare no copy of their own. The leaf chunks
// chunks/functions/csm_{vertexLogDepth,writeLogDepth}.wgsl carry the same
// functions for the non-polyline consumers and must remain identical. The
// `//>>ifdef LOG_DEPTH` gate omits these functions from modules that do not
// enable logarithmic depth.
//
// The appearance VS multiplies its screen-space window position by
// `viewportOrthographic`, whose bottom row is [0,0,0,1]; because
// `csm_getPolylineWindowCoordinates*` re-homogenizes by the eye-space clip-w,
// the resulting `output.position.w` equals that clip-w (the positive eye
// distance) — exactly what `csm_vertexLogDepth` expects. This mirrors WebGL's
// `czm_vertexLogDepth()` reading `gl_Position.w` after
// `czm_viewportOrthographic`.
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
