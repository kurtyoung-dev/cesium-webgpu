// CubeMapPanorama.wgsl — WebGPU cubemap panorama shader for CesiumJS
//
// Renders a cubemap panorama (used by both SkyBox and CubeMapPanorama).
// Replaces the older SkyBox.wgsl with panorama transform support.
//
// NOTE: Does NOT need RTE precision because:
// - The box is always centered on the camera (view rotation only, no translation)
// - Positions are just direction vectors for cubemap lookup
//
// Uniform layout (240 bytes, buffer 256-aligned):
//   projection:         mat4x4<f32>  (offset 0,   64 bytes)
//   viewRotation:       mat4x4<f32>  (offset 64,  64 bytes) — camera view rotation (3x3 in 4x4)
//   panoramaTransform:  mat4x4<f32>  (offset 128, 64 bytes) — panorama orientation (identity for SkyBox)
//   params:             vec4<f32>    (offset 192, 16 bytes) — x=far, y=morphTime, z=debugCubeFace, w=skyBrightness
//   starModulation:     vec4<f32>    (offset 208, 16 bytes) — x=inflection, y=steepness, z=enableFlag, w=cloudCover
//   hdr:                vec4<f32>    (offset 224, 16 bytes) — x=gamma in HDR, 0 in SDR
//
// Phase 1.3b — Star brightness modulation. The cubemap panorama doubles
// as the starfield. When the sky is bright (sun above horizon, full moon
// overhead) the stars need to dim toward black so the texture doesn't
// "punch through" the daytime atmosphere. The modulation curve is a
// smoothstep with two B4-locked tunables (inflection + steepness) so
// dark-sky and light-pollution presets can both be expressed without
// shader changes.
//
// Phase 1.4 — Cloud cover star occlusion. `starModulation.w` (formerly
// pad) carries `atmosphericConditions.weather.cloudCover` 0..1. The
// fragment shader multiplies the modulated star color by `(1 - cloudCover)`
// so a fully overcast sky hides stars completely without requiring a
// separate occlusion pass or weather-particle layer.

struct CubeMapPanoramaUniforms {
  projection: mat4x4<f32>,
  viewRotation: mat4x4<f32>,
  panoramaTransform: mat4x4<f32>,
  params: vec4<f32>,
  starModulation: vec4<f32>,
  hdr: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: CubeMapPanoramaUniforms;
@group(1) @binding(0) var cubeMapSampler: sampler;
@group(1) @binding(1) var cubeMapTexture: texture_cube<f32>;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec3<f32>,
};

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  let far = uniforms.params.x;
  let scaledPos = far * input.position;

  // Extract 3x3 panorama transform from 4x4 (identity for SkyBox)
  let pt = mat3x3<f32>(
    uniforms.panoramaTransform[0].xyz,
    uniforms.panoramaTransform[1].xyz,
    uniforms.panoramaTransform[2].xyz,
  );
  let transformed = pt * scaledPos;

  // Extract 3x3 view rotation from 4x4
  let vr = mat3x3<f32>(
    uniforms.viewRotation[0].xyz,
    uniforms.viewRotation[1].xyz,
    uniforms.viewRotation[2].xyz,
  );
  let rotated = vr * transformed;

  let clipPos = uniforms.projection * vec4<f32>(rotated, 1.0);

  // Force the skybox to sit exactly on the far plane (z/w = 1). Combined
  // with `depthCompare: "less-equal"` + `depthWriteEnabled: false` on
  // the pipeline, this lets the skybox be drawn at ANY point in the
  // frame (before or after opaque geometry) and it will only fill
  // pixels where no closer geometry has drawn. Without this clamp the
  // skybox pipeline had to rely on `depthCompare: "always"` and strict
  // draw order — a footgun that broke globe rendering at orbit.
  output.position = vec4<f32>(clipPos.x, clipPos.y, clipPos.w, clipPos.w);

  // Pass original position as cubemap lookup direction
  output.texCoord = input.position;

  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let dir = normalize(input.texCoord);

  // Tier 1 debug — isolate one natural cubemap face without changing the
  // production path (params.z = 0). Face ids: +X, -X, +Y, -Y, +Z, -Z.
  let requested = i32(uniforms.params.z + 0.5);
  if (requested != 0) {
    let absDir = abs(dir);
    let maxAxis = max(absDir.x, max(absDir.y, absDir.z));
    var face: i32 = 0;
    if (absDir.x >= maxAxis) {
      if (dir.x > 0.0) { face = 1; } else { face = 2; }
    } else if (absDir.y >= maxAxis) {
      if (dir.y > 0.0) { face = 3; } else { face = 4; }
    } else {
      if (dir.z > 0.0) { face = 5; } else { face = 6; }
    }
    if (face != requested) {
      discard;
    }
  }

  let color = textureSample(cubeMapTexture, cubeMapSampler, dir);

  let morphTime = uniforms.params.y;

  // Phase 1.3b — Star brightness modulation. When enabled, dim the
  // sampled cubemap by a smoothstep over sky brightness so stars fade
  // out as the sky brightens. C12-29 S6 / ruling E3: the flag now defaults
  // ON, with the derived curve documented in `Scene/StarFieldMath.ts` and
  // mirrored line for line by WebGL's `SkyBoxFS.glsl`. (The JS-embedded
  // shader in WebGPUCubeMapPanoramaRenderer.js is the production path; this
  // file is kept in sync for documentation, debug pages, and build flows.)
  // Phase 1.4 — Multiply by `(1 - cloudCover)` so heavy cloud cover
  // hides stars even at night.
  let skyBrightness = uniforms.params.w;
  let inflection = uniforms.starModulation.x;
  let steepness = uniforms.starModulation.y;
  let enableMod = uniforms.starModulation.z > 0.5;
  let cloudCover = clamp(uniforms.starModulation.w, 0.0, 1.0);

  var modulated = color.rgb;
  if (enableMod) {
    let t = clamp((skyBrightness - inflection) * steepness, 0.0, 1.0);
    let factor = 1.0 - smoothstep(0.0, 1.0, t);
    modulated = modulated * factor;
  }
  modulated = modulated * (1.0 - cloudCover);

  // Match WebGL czm_gammaCorrect (Builtin/Functions/gammaCorrect.glsl):
  // no-op when HDR is off (the default). Cubemap PNG data is sRGB and
  // the canvas color space is sRGB, so the sampled value goes straight
  // through. The previous unconditional pow(color, 1/2.2) re-encoded
  // sRGB on top of sRGB, brightening dark pixels (star backgrounds
  // appearing like concrete) and washing out the visible cubemap.
  let hdrGamma = uniforms.hdr.x;
  if (hdrGamma > 0.5) {
    modulated = pow(modulated, vec3<f32>(hdrGamma));
  }
  return vec4<f32>(modulated, morphTime);
}
