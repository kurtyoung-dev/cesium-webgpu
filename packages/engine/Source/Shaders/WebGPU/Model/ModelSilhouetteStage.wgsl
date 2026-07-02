// Model Silhouette Stage — WGSL equivalent of ModelSilhouetteStageVS/FS.glsl
// (WIRE-MODEL-SILHOUETTE). Prepended to `ModelPBRComplete.wgsl` by
// `WebGPUModelPipelineCache._getOrCreateShaderModule` when the
// `MODEL_SILHOUETTE` define bit is set; the `//>>ifdef MODEL_SILHOUETTE`
// call sites in that file are the only consumers. When the bit is clear
// (the default) this chunk is not prepended and the call sites are
// stripped, so the module source is byte-identical to the
// pre-silhouette path.
//
// WebGL reference math (ModelSilhouetteStageVS.glsl):
//   vec3 normal = normalize(czm_normal3D * attributes.normalMC);
//   normal.x *= czm_projection[0][0];
//   normal.y *= czm_projection[1][1];
//   positionClip.xy += normal.xy * positionClip.w
//                    * model_silhouetteSize * czm_pixelRatio / czm_viewport.z;
// The WebGPU camera UB carries no standalone projection matrix or
// viewport, so the scalar chain
//   (proj[0][0], proj[1][1]) * silhouetteSize * pixelRatio / viewportWidth
// is pre-folded on the CPU (WebGPUModelRenderer) into the 2-lane
// `expand` argument — per-vertex math is otherwise identical.

// Vertex: inflate the clip-space position along the eye-space normal so
// the silhouette-colour pass draws a `silhouetteSize`-pixel rim around
// the model. `normalMatrix` is the camera UB's model→eye normal matrix
// (the same one vertexMain uses for `output.normalEC`), matching
// WebGL's `czm_normal3D` in 3D scene mode. The near-zero-normal guard
// covers primitives without a real NORMAL attribute (WebGL strips the
// inflation via `#ifdef HAS_NORMALS`; here the default normal buffer
// feeds zeros which would otherwise normalize to NaN).
fn modelSilhouetteStageVS(
  positionClip: vec4<f32>,
  normalMC: vec3<f32>,
  normalMatrix: mat4x4<f32>,
  expand: vec2<f32>,
) -> vec4<f32> {
  let normalEC = (normalMatrix * vec4<f32>(normalMC, 0.0)).xyz;
  let len = length(normalEC);
  if (!(len > 1e-6)) {
    return positionClip;
  }
  let n = normalEC / len;
  return vec4<f32>(
    positionClip.xy + n.xy * expand * positionClip.w,
    positionClip.zw,
  );
}

// Fragment: the silhouette-colour pass replaces the shaded colour with
// the model's silhouetteColor. WebGL applies `czm_gammaCorrect`, which
// is the identity outside HDR (`#ifndef HDR` → pass-through), so the
// LDR path emits the colour untouched.
fn modelSilhouetteStageFS(silhouetteColor: vec4<f32>) -> vec4<f32> {
  return silhouetteColor;
}
