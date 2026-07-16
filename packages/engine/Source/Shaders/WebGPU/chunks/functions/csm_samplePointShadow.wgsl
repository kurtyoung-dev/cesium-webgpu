// csm_samplePointShadow.wgsl - Point-light cube depth comparison sample
//
// Mirrors the algorithm in ModelPBRComplete.wgsl:samplePointShadow:
// dominant cube-face axis -> perspective-Z + scaleBias remap -> comparison
// sample against the 6-face cube depth target. Optional 5-tap cross PCF
// when pcfRadius > 0 (kernel scaled by texelStep = 1.0 / shadowMapSize).
//
// Returns a visibility factor in [0, 1] — 1.0 = fully lit, 0.0 = fully
// shadowed. Caller mixes against effects.shadowDarkness to get the
// final shadow factor.
//
// Used by primitive lit shaders (Batch 165) and the inlined Model FS
// implementation. Texture and comparison-sampler are passed as function
// parameters so the chunk has no global-symbol dependency on the
// caller's binding layout.
//
// @chunk functions/csm_samplePointShadow

fn csm_samplePointShadow(
  cubeDepth: texture_depth_cube,
  compSampler: sampler_comparison,
  fragWC: vec3<f32>,
  lightWC: vec3<f32>,
  nearPlane: f32,
  farPlane: f32,
  depthBias: f32,
  pcfRadius: f32,
  shadowMapSize: f32,
) -> f32 {
  let direction = fragWC - lightWC;
  let absDir = abs(direction);
  // Dominant cube-face axis distance — what the per-face camera saw as
  // |z_eye| for this fragment; converted to depth via the perspective-Z
  // formula below.
  let axisDist = max(absDir.x, max(absDir.y, absDir.z));
  // Outside the cube far plane → cleared depth (1.0); treat as fully lit.
  if (axisDist >= farPlane) { return 1.0; }
  let depthRange = farPlane - nearPlane;
  // WebGPU [0,1] depth convention. The cast projection is constructed with
  // the owning context's convention, so it wrote values in this range too.
  let zNdcWebGpu =
    farPlane / depthRange - (farPlane * nearPlane) / (axisDist * depthRange);
  // The convention-aware shadow transform preserves WebGPU z in [0,1].
  let zAttached = zNdcWebGpu;
  let refDepth = clamp(zAttached - depthBias, 0.0, 1.0);
  // pcfRadius == 0 → single hard tap (Batch 57 behavior).
  if (pcfRadius <= 0.0) {
    return textureSampleCompareLevel(
      cubeDepth, compSampler, direction, refDepth,
    );
  }
  // 5-tap cross PCF along the two MINOR axes (axes that aren't the
  // dominant face axis) — keeps all samples on the same cube face so
  // depth comparisons stay coherent (no cross-face perspective-Z mismatch
  // at face seams). Axis-aligned tangents make the kernel rotation-
  // invariant across viewing angles.
  var minorA: vec3<f32>;
  var minorB: vec3<f32>;
  if (absDir.x >= absDir.y && absDir.x >= absDir.z) {
    minorA = vec3<f32>(0.0, 1.0, 0.0);
    minorB = vec3<f32>(0.0, 0.0, 1.0);
  } else if (absDir.y >= absDir.z) {
    minorA = vec3<f32>(1.0, 0.0, 0.0);
    minorB = vec3<f32>(0.0, 0.0, 1.0);
  } else {
    minorA = vec3<f32>(1.0, 0.0, 0.0);
    minorB = vec3<f32>(0.0, 1.0, 0.0);
  }
  let texelStep = 1.0 / max(shadowMapSize, 1.0);
  let offset = pcfRadius * texelStep;
  var sum = textureSampleCompareLevel(
    cubeDepth, compSampler, direction, refDepth,
  );
  sum = sum + textureSampleCompareLevel(
    cubeDepth, compSampler, direction + minorA * offset, refDepth,
  );
  sum = sum + textureSampleCompareLevel(
    cubeDepth, compSampler, direction - minorA * offset, refDepth,
  );
  sum = sum + textureSampleCompareLevel(
    cubeDepth, compSampler, direction + minorB * offset, refDepth,
  );
  sum = sum + textureSampleCompareLevel(
    cubeDepth, compSampler, direction - minorB * offset, refDepth,
  );
  return sum * 0.2;
}
