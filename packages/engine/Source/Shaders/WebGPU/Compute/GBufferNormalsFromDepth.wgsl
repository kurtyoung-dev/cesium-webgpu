// GBufferNormalsFromDepth.wgsl — Phase 8a Slice 2 (Batch 85)
//
// Screen-space normal reconstruction. Reads the scene depth attachment
// and writes eye-space normals (RGB) + a default roughness of 1.0 (A)
// into the G-buffer color attachment owned by `GBufferFramebuffer.js`
// (Phase 8a Slice 1, Batch 80).
//
// METHOD
// Reconstructs the eye-space surface position at each pixel from depth
// + the camera's inverse-projection matrix, then takes central
// differences of the position field to derive the surface normal:
//
//   posEye(x, y)   = unprojectDepth(uv, depth)
//   dpdu           = posEye(x+1, y) - posEye(x-1, y)   (∂P/∂screenX)
//   dpdv           = posEye(x, y+1) - posEye(x, y-1)   (∂P/∂screenY)
//   normalEye      = normalize(cross(dpdv, dpdu))
//
// The cross product is ordered `(dpdv, dpdu)` so the resulting normal
// points TOWARD the camera (positive Z in eye-space convention used
// throughout the WGSL globe pipeline — see
// GlobeTerrain.wgsl::v_normalEC which is derived from the same view 3×3).
//
// LIMITATIONS — current state (Slice 3 closes #1; #2 and #3 are Slice 4+):
//
// 1. **(Closed in Slice 3, Batch 86.)** Normals at silhouette /
//    depth-discontinuity edges are noisy because the central difference
//    straddles the discontinuity. Slice 3 adds an adaptive gradient
//    selector: for each axis, the shader compares the magnitude of the
//    forward and backward differences and picks the smaller one (which
//    is necessarily on the same surface as the center pixel — the
//    larger one straddles the discontinuity). The combined fallback
//    is approximately as cheap as the original central-difference
//    formula (5 depth samples instead of 4) and produces clean edges
//    on silhouette boundaries.
//
// 2. Roughness is a constant 1.0. Slice 4+ will thread per-material
//    roughness through a separate render-pass that writes only the
//    .w channel (or use MRT from the opaque pass when that lands).
//
// 3. Skies and other "no-depth-hit" fragments (depth = 1.0) still get
//    a reconstructed normal here — it's whatever the gradient of the
//    cleared depth produces. Consumers MUST gate on `depth < 1.0`
//    before treating the normal as meaningful. The G-buffer color
//    attachment is cleared to (0, 0, 0, 1) at the start of the frame
//    (per `GBufferFramebuffer.clear()`), so consumers can also use the
//    "all zero" sentinel as a "no normal here" gate.
//
// DEPENDENCIES
// Consumed in Slice 3+ by GTAO, SSR, and clustered lighting. The producer
// half (this shader) is gated entirely by `frameState.useDeferredLighting`;
// when the flag is false the dispatch is skipped, the G-buffer is never
// allocated, and this shader is never compiled at runtime by the WebGPU
// pipeline cache.

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
// normal (signed, range [-1, 1]); .w = roughness (Slice 2 hardcodes 1.0).
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

  // Silhouette-aware gradient selection (Slice 3). For each axis,
  // compare the magnitude of the forward (center→neighbor) and
  // backward (center→neighbor) differences and pick the smaller one.
  // At silhouette edges, one side straddles a depth discontinuity (its
  // unprojected position jumps far from `pCenter`); the other side is
  // continuous on the surface. Taking the smaller-magnitude side keeps
  // the gradient on the SAME surface as the center pixel.
  //
  // Pre-Slice-3 the shader used `pRight - pLeft` (a central difference),
  // which averages the two sides — at a silhouette this produces a
  // half-bad gradient that points roughly toward the discontinuity,
  // showing up as a noisy ring of bad normals around every object
  // boundary. The adaptive selection eliminates that ring at the cost
  // of one comparison + select per axis (cheaper than the depth fetch
  // it gates).
  let fwdU = pRight - pCenter;
  let bckU = pCenter - pLeft;
  let fwdV = pDown - pCenter;
  let bckV = pCenter - pUp;
  let dpdu = select(bckU, fwdU, dot(fwdU, fwdU) < dot(bckU, bckU));
  let dpdv = select(bckV, fwdV, dot(fwdV, fwdV) < dot(bckV, bckV));

  // Sanitize against degenerate gradients (depth discontinuities,
  // shadowed silhouette pixels where BOTH sides are bad). The cross
  // product becomes near-zero; normalize would produce NaN. Threshold
  // on magnitude — if too small, emit the sentinel.
  let cross1 = cross(dpdv, dpdu);
  let lenSq = dot(cross1, cross1);
  if (lenSq < 1e-12) {
    textureStore(gBufferOut, pixel, vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }

  let normalEye = cross1 / sqrt(lenSq);

  // Phase 8a Slice 5b (Batch 93) — derive a "roughness proxy" from
  // depth-gradient magnitude. This is a heuristic, not real material
  // roughness; threading actual material data here requires the
  // opaque pass to MRT-write roughness to a separate target, which is
  // a much larger change. The heuristic captures something useful:
  //
  //   - Smooth surfaces (water, building facades, large terrain
  //     slopes) have a SMALL depth gradient over the 3-pixel
  //     neighborhood we sampled. We interpret these as "low
  //     roughness" → SSR can do sharp reflections.
  //   - Rough surfaces (vegetation, rocky terrain, jagged 3D Tile
  //     features) have a LARGE depth gradient. We interpret these as
  //     "high roughness" → SSR attenuates / skips reflections.
  //
  // The threshold `0.5 m` is the linear-space gradient magnitude that
  // separates "essentially planar" from "noticeably curved" surfaces
  // at typical Cesium viewing distances. Values inside the threshold
  // are mirror-like (roughness ≈ 0.1); outside are diffuse-like
  // (roughness ≈ 0.95).
  //
  // Slice 5c (future) will replace this with material-driven roughness
  // via opaque-pass MRT.
  let gradMag = sqrt(dot(dpdu, dpdu) + dot(dpdv, dpdv));
  let roughness = mix(0.1, 0.95, smoothstep(0.05, 2.0, gradMag));
  textureStore(gBufferOut, pixel, vec4<f32>(normalEye, roughness));
}
