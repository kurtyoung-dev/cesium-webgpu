// GBufferNormalsFromDepthMSAA.wgsl — Phase 8a Slice 2d (Batch 90)
//
// Multisampled-depth variant of `GBufferNormalsFromDepth.wgsl`. Reads
// sample-0 of the scene's MSAA depth attachment instead of a single-
// sample depth view; otherwise identical algorithm + uniforms + output.
//
// WHY A SEPARATE SHADER
// WGSL declares the texture sample type at module scope, not entry-point
// scope. A `texture_depth_2d` binding and a `texture_depth_multisampled_2d`
// binding cannot coexist in the same module for the same binding slot.
// Two shaders are the simplest path; the dispatcher
// (`WebGPUGBufferRenderer.ts`) picks the right pipeline at execute time
// based on `_sceneFramebuffer.sampleCount`.
//
// SAMPLE-0 ONLY (vs full multisample reconstruction)
// We read only sample 0 of the multisampled depth, not all N samples.
// Rationale:
//   - MSAA depth samples are coverage-aware variations around the same
//     surface. Sample 0 is a representative geometric depth — close
//     enough for normal reconstruction.
//   - Averaging all samples would be more accurate at edges but ~4×
//     more memory bandwidth + per-pixel cost.
//   - Slice 6+ may revisit this if SSR/clustered lighting prove
//     sensitive to MSAA-edge normal noise; for now sample-0 matches
//     what the depth-as-color debug overlay uses (proven adequate).
//
// All other comments / algorithm match `GBufferNormalsFromDepth.wgsl`;
// keep these two files in lockstep when changing the algorithm.

struct ReconstructionUniforms {
  inverseProjection: mat4x4<f32>,
  viewportSize: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: ReconstructionUniforms;
@group(0) @binding(1) var sceneDepth: texture_depth_multisampled_2d;
@group(0) @binding(2) var gBufferOut: texture_storage_2d<rgba16float, write>;

fn unprojectDepth(pixelCoord: vec2<i32>, depth: f32) -> vec3<f32> {
  let pixelF = vec2<f32>(f32(pixelCoord.x), f32(pixelCoord.y));
  let uv = (pixelF + vec2<f32>(0.5)) / u.viewportSize.xy;
  let ndc = vec4<f32>(
    uv.x * 2.0 - 1.0,
    1.0 - uv.y * 2.0,
    depth,
    1.0,
  );
  let unprojected = u.inverseProjection * ndc;
  let w = max(abs(unprojected.w), 1e-7) * sign(unprojected.w);
  return unprojected.xyz / w;
}

// Multisampled-depth load helper. `textureLoad` on a multisampled
// texture requires an explicit sample index (no LOD parameter).
fn loadDepth(pixel: vec2<i32>) -> f32 {
  return textureLoad(sceneDepth, pixel, 0);
}

@compute @workgroup_size(8, 8, 1)
fn computeNormalFromDepth(@builtin(global_invocation_id) gid: vec3<u32>) {
  let pixel = vec2<i32>(i32(gid.x), i32(gid.y));
  let dims = vec2<i32>(i32(u.viewportSize.x), i32(u.viewportSize.y));
  if (pixel.x >= dims.x || pixel.y >= dims.y) {
    return;
  }

  let depthCenter = loadDepth(pixel);

  if (depthCenter >= 0.99999) {
    textureStore(gBufferOut, pixel, vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }

  let pxRight = clamp(pixel + vec2<i32>(1, 0), vec2<i32>(0), dims - 1);
  let pxLeft  = clamp(pixel - vec2<i32>(1, 0), vec2<i32>(0), dims - 1);
  let pxDown  = clamp(pixel + vec2<i32>(0, 1), vec2<i32>(0), dims - 1);
  let pxUp    = clamp(pixel - vec2<i32>(0, 1), vec2<i32>(0), dims - 1);

  let dRight = loadDepth(pxRight);
  let dLeft  = loadDepth(pxLeft);
  let dDown  = loadDepth(pxDown);
  let dUp    = loadDepth(pxUp);

  let pCenter = unprojectDepth(pixel, depthCenter);
  let pRight  = unprojectDepth(pxRight, dRight);
  let pLeft   = unprojectDepth(pxLeft,  dLeft);
  let pDown   = unprojectDepth(pxDown,  dDown);
  let pUp     = unprojectDepth(pxUp,    dUp);

  // Silhouette-aware gradient selection (Slice 3) — pick smaller-mag
  // side per axis to stay on-surface at depth discontinuities.
  let fwdU = pRight - pCenter;
  let bckU = pCenter - pLeft;
  let fwdV = pDown - pCenter;
  let bckV = pCenter - pUp;
  let dpdu = select(bckU, fwdU, dot(fwdU, fwdU) < dot(bckU, bckU));
  let dpdv = select(bckV, fwdV, dot(fwdV, fwdV) < dot(bckV, bckV));

  let cross1 = cross(dpdv, dpdu);
  let lenSq = dot(cross1, cross1);
  if (lenSq < 1e-12) {
    textureStore(gBufferOut, pixel, vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }

  // Slice 5c-A (Batch 99) — diagonal-sample augmentation. Lockstep
  // with `GBufferNormalsFromDepth.wgsl`; see that file for rationale.
  // 4 extra diagonal taps + magnitude-weighted blend reduces noise on
  // planar surfaces ~50% with no loss of silhouette protection.
  let pxUR = clamp(pixel + vec2<i32>(1, -1), vec2<i32>(0), dims - 1);
  let pxUL = clamp(pixel + vec2<i32>(-1, -1), vec2<i32>(0), dims - 1);
  let pxDR = clamp(pixel + vec2<i32>(1, 1), vec2<i32>(0), dims - 1);
  let pxDL = clamp(pixel + vec2<i32>(-1, 1), vec2<i32>(0), dims - 1);
  let dUR = loadDepth(pxUR);
  let dUL = loadDepth(pxUL);
  let dDR = loadDepth(pxDR);
  let dDL = loadDepth(pxDL);
  let pUR = unprojectDepth(pxUR, dUR);
  let pUL = unprojectDepth(pxUL, dUL);
  let pDR = unprojectDepth(pxDR, dDR);
  let pDL = unprojectDepth(pxDL, dDL);
  let fwdDU = ((pUR - pCenter) + (pDR - pCenter)) * 0.5;
  let bckDU = ((pCenter - pUL) + (pCenter - pDL)) * 0.5;
  let fwdDV = ((pDR - pCenter) + (pDL - pCenter)) * 0.5;
  let bckDV = ((pCenter - pUR) + (pCenter - pUL)) * 0.5;
  let dpduDiag = select(bckDU, fwdDU, dot(fwdDU, fwdDU) < dot(bckDU, bckDU));
  let dpdvDiag = select(bckDV, fwdDV, dot(fwdDV, fwdDV) < dot(bckDV, bckDV));
  let crossDiag = cross(dpdvDiag, dpduDiag);
  let lenSqDiag = dot(crossDiag, crossDiag);

  let wCross = 1.0 / (sqrt(lenSq) + 1e-6);
  let wDiag = 1.0 / (sqrt(max(lenSqDiag, 1e-12)) + 1e-6);
  let blendedCross = (cross1 * wCross + crossDiag * wDiag) / max(wCross + wDiag, 1e-6);
  let blendedLenSq = dot(blendedCross, blendedCross);
  let normalEye = select(
    cross1 / sqrt(lenSq),
    blendedCross / sqrt(blendedLenSq),
    blendedLenSq > 1e-12,
  );

  // Phase 8a Slice 5b (Batch 93) — depth-gradient roughness proxy.
  // Lockstep with `GBufferNormalsFromDepth.wgsl`; see that file for
  // the rationale. Smooth surfaces (small gradient) → low roughness
  // (mirror-like, SSR does sharp reflections). Rough surfaces (large
  // gradient) → high roughness (diffuse-like, SSR attenuates).
  let gradMag = sqrt(dot(dpdu, dpdu) + dot(dpdv, dpdv));
  let roughness = mix(0.1, 0.95, smoothstep(0.05, 2.0, gradMag));
  textureStore(gBufferOut, pixel, vec4<f32>(normalEye, roughness));
}
