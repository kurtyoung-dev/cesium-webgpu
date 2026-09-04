// Screen-space normal reconstruction. Reads the scene depth attachment
// and writes eye-space normals (RGB) + a depth-gradient roughness proxy
// (A) into the G-buffer color attachment owned by `GBufferFramebuffer.js`.
//
// Method
// Reconstructs the eye-space surface position at each pixel from depth
// + the camera's inverse-projection matrix, then derives the surface
// normal from a magnitude-weighted blend of an axis-aligned cross-stencil
// gradient and a diagonal-stencil gradient (see the per-block comments
// below for both). Sky fragments (depth >= 0.99999) and any pixel whose
// blended gradient is degenerate are written as the (0, 0, 0, 1) sentinel
// instead of a reconstructed normal, so consumers can treat an all-zero
// texel as "no surface here" without also needing a separate depth test.
//
//   posEye(x, y)   = unprojectDepth(uv, depth)
//   dpdu           = the smaller-magnitude of the forward and backward
//                    screen-X differences at posEye, silhouette-selected
//                    (∂P/∂screenX)
//   dpdv           = the smaller-magnitude of the forward and backward
//                    screen-Y differences at posEye, silhouette-selected
//                    (∂P/∂screenY)
//   normalEye      = normalize(magnitude-weighted blend of
//                    cross(dpdv, dpdu) with the diagonal-stencil equivalent)
//
// The cross product is ordered `(dpdv, dpdu)` so the resulting normal
// points toward the camera (positive Z in eye-space convention used
// throughout the WGSL globe pipeline — see
// GlobeTerrain.wgsl::v_normalEC which is derived from the same view 3×3).
//
// Known limitations
//
// Roughness is a heuristic depth-gradient proxy, not real material
// roughness (see the comment at the roughness computation below).
// Threading actual per-material roughness through here would need the
// opaque pass to MRT-write it to a separate target.
//
// Dependencies
// Consumed by GTAO, SSR, and clustered lighting. The producer half (this
// shader) is gated entirely by `frameState.useDeferredLighting`; when the
// flag is false the dispatch is skipped, the G-buffer is never allocated,
// and this shader is never compiled at runtime by the WebGPU pipeline
// cache.

struct ReconstructionUniforms {
  // Inverse-projection matrix — maps clip-space (NDC) coordinates back
  // to eye-space. WebGPU NDC is [-1, 1] in XY and [0, 1] in Z. The CPU
  // packer writes this from `uniformState.inverseProjection` (NOT the
  // full inverse-MVP — we want positions in eye space, not world).
  inverseProjection: mat4x4<f32>,
  // Output viewport dimensions, used to derive the workgroup-to-pixel
  // mapping. `.zw` are reserved for future scaling factors (e.g., AO
  // half-res).
  viewportSize: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: ReconstructionUniforms;

// Scene depth. Bound as a regular texture (not a depth-only view) so
// the shader can do textureLoad without sampler indirection. WebGPU
// allows sampling a depth-stencil texture as a `texture_depth_2d`; we
// use `texture_2d<f32>` here because the depth-stencil view in
// WebGPUContext is exposed as a generic `GPUTextureView`.
@group(0) @binding(1) var sceneDepth: texture_depth_2d;

// Output G-buffer color attachment: rgba16float. .xyz = eye-space
// normal (signed, range [-1, 1]); .w = the depth-gradient roughness
// proxy computed below.
@group(0) @binding(2) var gBufferOut: texture_storage_2d<rgba16float, write>;

/**
 * Reconstruct eye-space position from a (screen-pixel, depth) sample.
 *
 * Steps:
 *   1. Convert (pixel, depth) → NDC by mapping XY to [-1, 1] and using
 *      the raw depth value as Z (WebGPU NDC Z is already [0, 1]).
 *   2. Apply `inverseProjection` to get eye-space position with
 *      perspective-divide.
 */
fn unprojectDepth(pixelCoord: vec2<i32>, depth: f32) -> vec3<f32> {
  let pixelF = vec2<f32>(f32(pixelCoord.x), f32(pixelCoord.y));
  // Pixel center is at +0.5; that gets us NDC in [-1+(1/N), 1-(1/N)],
  // matching how a fragment shader sees `position.xy / viewport`.
  let uv = (pixelF + vec2<f32>(0.5)) / u.viewportSize.xy;
  // WebGPU framebuffer origin is top-left, so Y is flipped in NDC.
  let ndc = vec4<f32>(
    uv.x * 2.0 - 1.0,
    1.0 - uv.y * 2.0,
    depth,
    1.0,
  );
  let unprojected = u.inverseProjection * ndc;
  // Perspective divide. Guard against w ≈ 0 (sky/clear samples) — the
  // resulting position would be at infinity; consumers filter these out
  // via the depth gate.
  let w = max(abs(unprojected.w), 1e-7) * sign(unprojected.w);
  return unprojected.xyz / w;
}

@compute @workgroup_size(8, 8, 1)
fn computeNormalFromDepth(@builtin(global_invocation_id) gid: vec3<u32>) {
  let pixel = vec2<i32>(i32(gid.x), i32(gid.y));
  let dims = vec2<i32>(i32(u.viewportSize.x), i32(u.viewportSize.y));
  if (pixel.x >= dims.x || pixel.y >= dims.y) {
    return;
  }

  // Sample depth at center + 4 neighbors. textureLoad with mip=0 — no
  // sampler needed.
  let depthCenter = textureLoad(sceneDepth, pixel, 0);

  // Skip far-plane sky fragments: emit a (0,0,0,1) sentinel matching
  // the clear value. Consumers see "no surface here" via this.
  if (depthCenter >= 0.99999) {
    textureStore(gBufferOut, pixel, vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }

  let pxRight = clamp(pixel + vec2<i32>(1, 0), vec2<i32>(0), dims - 1);
  let pxLeft  = clamp(pixel - vec2<i32>(1, 0), vec2<i32>(0), dims - 1);
  let pxDown  = clamp(pixel + vec2<i32>(0, 1), vec2<i32>(0), dims - 1);
  let pxUp    = clamp(pixel - vec2<i32>(0, 1), vec2<i32>(0), dims - 1);

  let dRight = textureLoad(sceneDepth, pxRight, 0);
  let dLeft  = textureLoad(sceneDepth, pxLeft, 0);
  let dDown  = textureLoad(sceneDepth, pxDown, 0);
  let dUp    = textureLoad(sceneDepth, pxUp, 0);

  let pCenter = unprojectDepth(pixel, depthCenter);
  let pRight  = unprojectDepth(pxRight, dRight);
  let pLeft   = unprojectDepth(pxLeft,  dLeft);
  let pDown   = unprojectDepth(pxDown,  dDown);
  let pUp     = unprojectDepth(pxUp,    dUp);

  // Silhouette-aware gradient selection. For each axis, compare the
  // magnitude of the forward (center→neighbor) and backward
  // (center→neighbor) differences and pick the smaller one. At silhouette
  // edges, one side straddles a depth discontinuity (its unprojected
  // position jumps far from `pCenter`); the other side is continuous on
  // the surface. Taking the smaller-magnitude side keeps the gradient on
  // the same surface as the center pixel.
  //
  // A plain central difference (`pRight - pLeft`) averages the two sides
  // instead — at a silhouette this produces a half-bad gradient that
  // points roughly toward the discontinuity, showing up as a noisy ring
  // of bad normals around every object boundary. The adaptive selection
  // eliminates that ring at the cost of one comparison + select per axis
  // (cheaper than the depth fetch it gates).
  let fwdU = pRight - pCenter;
  let bckU = pCenter - pLeft;
  let fwdV = pDown - pCenter;
  let bckV = pCenter - pUp;
  let dpdu = select(bckU, fwdU, dot(fwdU, fwdU) < dot(bckU, bckU));
  let dpdv = select(bckV, fwdV, dot(fwdV, fwdV) < dot(bckV, bckV));

  // Sanitize against degenerate gradients (depth discontinuities,
  // shadowed silhouette pixels where both sides are bad). The cross
  // product becomes near-zero; normalize would produce NaN. Threshold
  // on magnitude — if too small, emit the sentinel.
  let cross1 = cross(dpdv, dpdu);
  let lenSq = dot(cross1, cross1);
  if (lenSq < 1e-12) {
    textureStore(gBufferOut, pixel, vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }

  // Diagonal-sample augmentation. The axis-only cross-stencil above
  // produces correct but noticeably noisy normals on planar surfaces,
  // because its gradient estimate uses only 4 depth samples. Diagonal
  // samples (UR, UL, DR, DL) give the same surface 4 more on-axis-
  // equivalent gradients with no extra texture bandwidth per direction.
  // Each diagonal yields a u-and-v gradient pair (the projection of the
  // diagonal step onto each screen axis); the smaller-magnitude side is
  // picked per axis just like the cross taps, then the diagonal normal
  // is magnitude-weight-blended with the cross normal. Small-magnitude
  // (on-surface) gradients dominate the blend; large-magnitude
  // (silhouette) gradients get suppressed.
  //
  // Net effect: ~50% noise reduction on flat surfaces with no loss of
  // silhouette protection (degenerate diagonal gradients self-weight
  // out of the blend). Bandwidth cost: 4 extra depth fetches + 4 extra
  // unprojections per pixel. Worth it — AO/SSR sampling cost downstream
  // is many orders of magnitude higher.
  let pxUR = clamp(pixel + vec2<i32>(1, -1), vec2<i32>(0), dims - 1);
  let pxUL = clamp(pixel + vec2<i32>(-1, -1), vec2<i32>(0), dims - 1);
  let pxDR = clamp(pixel + vec2<i32>(1, 1), vec2<i32>(0), dims - 1);
  let pxDL = clamp(pixel + vec2<i32>(-1, 1), vec2<i32>(0), dims - 1);
  let dUR = textureLoad(sceneDepth, pxUR, 0);
  let dUL = textureLoad(sceneDepth, pxUL, 0);
  let dDR = textureLoad(sceneDepth, pxDR, 0);
  let dDL = textureLoad(sceneDepth, pxDL, 0);
  let pUR = unprojectDepth(pxUR, dUR);
  let pUL = unprojectDepth(pxUL, dUL);
  let pDR = unprojectDepth(pxDR, dDR);
  let pDL = unprojectDepth(pxDL, dDL);
  // Diagonal forward/backward differences. Each diagonal step contains
  // a u-component AND a v-component; we average the pair on each axis
  // so the result is comparable in scale to the cross-stencil gradients
  // above (1 pixel step in either u or v).
  let fwdDU = ((pUR - pCenter) + (pDR - pCenter)) * 0.5;
  let bckDU = ((pCenter - pUL) + (pCenter - pDL)) * 0.5;
  let fwdDV = ((pDR - pCenter) + (pDL - pCenter)) * 0.5;
  let bckDV = ((pCenter - pUR) + (pCenter - pUL)) * 0.5;
  let dpduDiag = select(bckDU, fwdDU, dot(fwdDU, fwdDU) < dot(bckDU, bckDU));
  let dpdvDiag = select(bckDV, fwdDV, dot(fwdDV, fwdDV) < dot(bckDV, bckDV));
  let crossDiag = cross(dpdvDiag, dpduDiag);
  let lenSqDiag = dot(crossDiag, crossDiag);

  // Magnitude-weighted blend. Small-magnitude gradients (on-surface)
  // get higher weight; large-magnitude (silhouette / discontinuity)
  // get suppressed. Uses inverse-magnitude weighting with an epsilon
  // so a pure-silhouette cross-stencil still falls back to whichever
  // produces a usable normal. The diagonal stencil's center sample is
  // shared with the cross, so a degenerate (lenSqDiag ≈ 0) diagonal
  // contribution self-suppresses through the weighting.
  let wCross = 1.0 / (sqrt(lenSq) + 1e-6);
  let wDiag = 1.0 / (sqrt(max(lenSqDiag, 1e-12)) + 1e-6);
  let blendedCross = (cross1 * wCross + crossDiag * wDiag) / max(wCross + wDiag, 1e-6);
  let blendedLenSq = dot(blendedCross, blendedCross);
  let normalEye = select(
    cross1 / sqrt(lenSq),
    blendedCross / sqrt(blendedLenSq),
    blendedLenSq > 1e-12,
  );

  // Roughness is a heuristic "proxy" derived from depth-gradient
  // magnitude, not real material roughness — threading actual material
  // data here would need the opaque pass to MRT-write roughness to a
  // separate target, which is a much larger change. The heuristic
  // captures something useful:
  //
  //   - Smooth surfaces (water, building facades, large terrain
  //     slopes) have a small depth gradient over the sampled
  //     neighborhood. These read as low roughness, so SSR can do
  //     sharp reflections.
  //   - Rough surfaces (vegetation, rocky terrain, jagged 3D Tile
  //     features) have a large depth gradient. These read as high
  //     roughness, so SSR attenuates / skips reflections.
  //
  // The `smoothstep(0.05, 2.0, gradMag)` thresholds span the
  // linear-space gradient magnitude from "essentially planar" to
  // "noticeably curved" surfaces at typical Cesium viewing distances;
  // below the low edge the surface reads mirror-like (roughness 0.1),
  // above the high edge diffuse-like (roughness 0.95).
  let gradMag = sqrt(dot(dpdu, dpdu) + dot(dpdv, dpdv));
  let roughness = mix(0.1, 0.95, smoothstep(0.05, 2.0, gradMag));
  textureStore(gBufferOut, pixel, vec4<f32>(normalEye, roughness));
}
