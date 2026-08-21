// CubeMapPanorama.wgsl — WebGPU cubemap panorama shader for CesiumJS
//
// Renders a cubemap panorama (used by both SkyBox and CubeMapPanorama).
// The panorama transform supports arbitrary cube-map orientations.
//
// RTE precision is unnecessary because the box is centered on the camera and
// uses view rotation without translation. Its positions are only direction
// vectors for cube-map lookup.
//
// Uniform layout (272 bytes, buffer 288 bytes):
//   projection:         mat4x4<f32>  (offset 0,   64 bytes)
//   viewRotation:       mat4x4<f32>  (offset 64,  64 bytes)
//     Camera view rotation, stored as a 3x3 matrix in a 4x4 slot.
//   panoramaTransform:  mat4x4<f32>  (offset 128, 64 bytes)
//     Panorama orientation, or identity for SkyBox.
//   params:             vec4<f32>    (offset 192, 16 bytes)
//     x=far, y=morphTime, z=debugCubeFace, w=skyBrightness.
//   starModulation:     vec4<f32>    (offset 208, 16 bytes)
//     x=inflection, y=steepness, z=enableFlag, w=cloudCover.
//   hdr:                vec4<f32>    (offset 224, 16 bytes)
//     x=gamma in HDR, or 0 in SDR.
//   solarGlare:         vec4<f32>    (offset 240, 16 bytes)
//     xyz=sun direction in the cube-map TEME frame, w=strength.
//   solarGlareCurve:    vec4<f32>    (offset 256, 16 bytes)
//     x=angular core rad, y=pedestal, z=support rad, w=reserved.
//
// The cubemap panorama doubles as the star field. When the sky is bright, the
// stars dim toward black so the texture does not punch through the daytime
// atmosphere. A smoothstep curve with inflection and steepness tunables
// supports both dark-sky and light-pollution presets without shader changes.
//
// `starModulation.w` carries `atmosphericConditions.weather.cloudCover` in
// [0, 1]. Multiplying the modulated star color by `(1 - cloudCover)` lets a
// fully overcast sky hide stars without a separate occlusion pass or weather
// particle layer.
//
// The solar-glare fields occupy the tail so every preceding uniform offset
// remains stable. `solarGlare` carries the sun direction in this shader's
// lookup frame and a strength; `solarGlareCurve` carries the veiling-glare
// parameters. `Scene/SolarGlareAppearance.js` resolves both once per frame.
// WebGL's `SkyBoxFS.glsl` reads byte-identical values through
// `u_solarGlare` and `u_solarGlareCurve`. `CubeMapPanorama.isStarMap` limits
// the effect to star maps, so generic and Street View panoramas resolve zero
// strength and remain unchanged.

struct CubeMapPanoramaUniforms {
  projection: mat4x4<f32>,
  viewRotation: mat4x4<f32>,
  panoramaTransform: mat4x4<f32>,
  params: vec4<f32>,
  starModulation: vec4<f32>,
  hdr: vec4<f32>,
  solarGlare: vec4<f32>,
  solarGlareCurve: vec4<f32>,
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
  // the pipeline, this lets the skybox be drawn at any point in the
  // frame (before or after opaque geometry) and it will only fill
  // pixels where no closer geometry has drawn. Using `depthCompare: "always"`
  // would make strict draw order load-bearing and could overwrite globe
  // geometry at orbit.
  output.position = vec4<f32>(clipPos.x, clipPos.y, clipPos.w, clipPos.w);

  // Pass original position as cubemap lookup direction
  output.texCoord = input.position;

  return output;
}

// Veiling-glare weight as a function of angular separation from the sun. This
// must remain character-identical to `solarGlareVeil` in
// `Shaders/SkyBoxFS.glsl`, `Shaders/WebGPU/Catalog/StarField.wgsl`, and
// `Shaders/StarFieldVS.glsl`, and line-for-line equivalent to
// `angularGlareVeil` in `Scene/SolarDiscModel.js`.
// `solar-glare-star-washout.spec.mjs` compiles all four shader bodies as
// JavaScript and requires agreement with the JavaScript reference to 1e-15.
//
//   raw(theta)  = 1 / (1 + (theta/core)^2)      -> ~ 1/theta^2 far field
//   veil(theta) = (raw - pedestal) / (1 - pedestal), clamped to [0, 1]
//
// The `1/theta^2` tail is the Stiles-Holladay / CIE disability-glare form. The
// pedestal subtraction makes the veil reach exactly 0 at the support angle
// (90 deg), and the `cosSeparation <= 0.0` early-out is the same half-space,
// so a direction at or beyond 90 deg from the sun is multiplied by exactly
// 1.0, byte-identical to a frame without the sun contribution.
fn solarGlareVeil(cosSeparation: f32, core: f32, pedestal: f32, support: f32) -> f32 {
  if (cosSeparation <= 0.0) { return 0.0; }
  let theta = acos(min(cosSeparation, 1.0));
  if (theta >= support) { return 0.0; }
  let t = theta / core;
  let raw = 1.0 / (1.0 + t * t);
  let v = (raw - pedestal) / (1.0 - pedestal);
  return clamp(v, 0.0, 1.0);
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

  // When enabled by default, a smoothstep over sky brightness dims the
  // sampled cube map so stars fade as the sky brightens. The derived curve in
  // `Scene/StarFieldMath.ts` is mirrored line for line by WebGL's
  // `SkyBoxFS.glsl`. The inline shader in WebGPUCubeMapPanoramaRenderer.js is
  // the production path; this file must stay synchronized for documentation,
  // debug pages, and build flows. Multiplication by `(1 - cloudCover)` hides
  // stars under heavy cloud cover even at night.
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

  // Order is load-bearing and mirrored exactly by `SkyBoxFS.glsl`: star
  // modulation, cloud occlusion, solar glare, then gamma. The first three
  // operations must precede gamma because `czm_gammaCorrect` is an
  // sRGB-to-linear decode under HDR and `k*x^g != (k*x)^g`; moving a multiply
  // across it would desynchronize the backends. Both `dir` and
  // `solarGlare.xyz` use the cube-map lookup frame, which is TEME for
  // `SkyBox` because its `panoramaTransform` is `temeToPseudoFixed`.
  if (uniforms.solarGlare.w > 0.0) {
    let veil = solarGlareVeil(
      dot(dir, uniforms.solarGlare.xyz),
      uniforms.solarGlareCurve.x,
      uniforms.solarGlareCurve.y,
      uniforms.solarGlareCurve.z
    );
    modulated = modulated * (1.0 - uniforms.solarGlare.w * veil);
  }

  // Match WebGL czm_gammaCorrect (Builtin/Functions/gammaCorrect.glsl):
  // no-op when HDR is off (the default). Cubemap PNG data is sRGB and
  // the canvas color space is sRGB, so the sampled value goes straight
  // through. An unconditional pow(color, 1/2.2) would encode sRGB a second
  // time, brightening dark pixels until star backgrounds resemble concrete
  // and washing out the visible cube map.
  let hdrGamma = uniforms.hdr.x;
  if (hdrGamma > 0.5) {
    modulated = pow(modulated, vec3<f32>(hdrGamma));
  }
  return vec4<f32>(modulated, morphTime);
}
