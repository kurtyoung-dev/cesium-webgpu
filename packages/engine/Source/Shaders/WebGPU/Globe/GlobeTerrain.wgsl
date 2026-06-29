// Globe Terrain Shader — WebGPU
//
// Renders terrain tiles with RTE (Relative-To-Eye) positioning.
// Supports up to MAX_TEXTURES imagery layers per tile.
// Uses tile-center-relative vertex positions + u_center3D for full ECEF.
//
// Features:
//   - RTE (Relative-To-Eye) precision for planetary scale
//   - Up to 4 imagery layers with alpha/brightness/contrast/saturation
//   - Day/night alpha blending per imagery layer
//   - Enhanced night rendering with city lights emission and terminator glow
//   - Lambert diffuse lighting from sun direction
//   - Fog blending (distance-based atmosphere fade)
//   - Atmosphere integration (Rayleigh-approximated horizon glow)
//   - Enhanced ocean rendering: Fresnel, deep water color, multi-octave waves,
//     foam/whitecaps, environment reflection, subsurface scattering
//   - Water mask support with smooth coastline transitions
//   - Cartographic limit rectangle clipping (discard-based)
//   - Log depth for multi-frustum precision
//   - Quantized terrain vertex decoding (TerrainQuantization.BITS12)
//   - Shadow receive (PCF shadow mapping)
//   - Clipping planes with edge highlighting
//
// Vertex data format (uncompressed, TerrainQuantization.NONE):
//   position3DAndHeight: vec4 (posX, posY, posZ, height) — relative to tile center
//   textureCoordAndEncodedNormals: vec4 (u, v, encodedNormal, webMercatorT)
//
// Vertex data format (quantized, TerrainQuantization.BITS12):
//   compressed0: vec4 (compressedXY, compressedZH, compressedUV, encodedNormal)

// ─── Camera Uniforms (Group 0, Binding 0) ───
//
// Scene mode constants (matches SceneMode.js):
//   0 = MORPHING       — transitional state during mode changes
//   1 = COLUMBUS_VIEW  — 2.5D perspective with planar projection + height
//   2 = SCENE2D        — top-down orthographic, planar projection, height=0
//   3 = SCENE3D        — full 3D perspective with RTE positioning
struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  modifiedModelView: mat4x4<f32>,
  // Projection * modifiedModelView. Used by 2D / Columbus / Morphing paths
  // where positions are planar (vec3(height, lon, lat)) and the RTE/eye
  // encoding is meaningless. Matches WebGL u_modifiedModelViewProjection.
  modifiedModelViewProjection: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  // Tile encoding center in ECEF, emulated f64 via high/low split.
  // Raw f32 center3D (up to ~6.4e6 m for Earth) loses ~0.5 m of precision
  // per component, which defeats the RTE emulation when combined with
  // tile-local positions. Keeping the split lets the SCENE3D branch do
  // proper (center3DHigh - encodedCameraHigh) + (center3DLow - encodedCameraLow)
  // subtraction and preserve sub-meter precision at orbital altitudes.
  center3DHigh: vec3<f32>,
  _pad2a: f32,
  center3DLow: vec3<f32>,
  _pad2b: f32,
  sunDirectionEC: vec3<f32>,
  enableLighting: f32,
  scaleAndBias: mat4x4<f32>,
  minMaxHeight: vec2<f32>,
  // Ellipsoid mean radius (meters) — replaces the hardcoded EARTH_RADIUS
  // constant so Mars / Moon / custom ellipsoids produce correct altitude
  // calculations. `.y` stays reserved for a future oblate-ellipsoid pair.
  ellipsoidRadius: f32,
  _pad3: f32,
  // ─── 2D / Columbus View support ───
  // tileRectangle: west, south, east, north (radians)
  tileRectangle: vec4<f32>,
  // southAndNorthLatitude: x=south, y=north (radians)
  // southMercatorYAndOneOverHeight: x=southMercatorY, y=1/mercatorHeight
  southAndNorthLatitude: vec2<f32>,
  southMercatorYAndOneOverHeight: vec2<f32>,
  // sceneMode: 0=MORPH, 1=COLUMBUS, 2=2D, 3=3D
  // morphTime: 0..1 blend factor (0=2D, 1=3D)
  // useWebMercator: 1 if map projection is Web Mercator, 0 if Geographic
  // _pad4: alignment padding
  sceneMode: f32,
  morphTime: f32,
  useWebMercator: f32,
  _pad4: f32,
  // ─── DP-H41: TAA / motion-vector support ───
  // Last frame's viewProjection, captured by `UniformState.update()` before
  // it overwrites `_viewProjection` with the new camera state. Motion-vector
  // passes read this as `camera.previousViewProjection` to reproject the
  // current fragment into the previous frame's NDC. On the first frame it
  // holds `Matrix4.IDENTITY` (`UniformState` ctor default) — downstream
  // consumers should gate motion-vector output on a separate "valid
  // history" flag, not on matrix contents.
  previousViewProjection: mat4x4<f32>,
  // ─── Session 65 Batch 9: Nishita-style ground atmosphere (Cluster 2b/5) ───
  // Atmosphere parameters mirroring WebGL's `u_atmosphere*` automatic
  // uniforms (defaults from `Atmosphere.js`):
  //   xyz = light direction in WORLD coords (sun or scene light)
  //   w   = atmosphereLightIntensity (default 10.0)
  // The CPU packer writes either `czm_sunDirectionWC` (when
  // `DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN`) or `czm_lightDirectionWC`
  // (matches the WebGL `atmosphereLightDirection` choice in GlobeVS.glsl).
  atmosphereLightDirectionAndIntensity: vec4<f32>,
  // xyz = Rayleigh scattering coefficients (m^-1 per channel)
  // w   = Rayleigh scale height (meters, default 8500)
  atmosphereRayleighCoefficientAndScale: vec4<f32>,
  // xyz = Mie scattering coefficients (m^-1 per channel — usually grey)
  // w   = Mie scale height (meters, default 1200)
  atmosphereMieCoefficientAndScale: vec4<f32>,
  // x = Mie phase anisotropy (Henyey-Greenstein g, default 0.758)
  // y = Atmosphere inner radius (meters — typically planet's max
  //     ellipsoid radius)
  // z = Atmosphere outer radius (inner + ATMOSPHERE_THICKNESS where
  //     ATMOSPHERE_THICKNESS = 111e3 m). Packed here so the WGSL doesn't
  //     repeat the constant; CPU keeps the contract single-sourced.
  // w = 1.0 when ground atmosphere shading is enabled, 0.0 otherwise.
  //     The fog/atmosphere branches in the FS gate on this so disabling
  //     atmosphere from JS (`scene.fog.enabled = false`, etc.) doesn't
  //     leak into the per-vertex ray-march cost.
  atmosphereParams: vec4<f32>,
  // ─── Batch 76: czm_lightColor (custom scene light color) ───
  // Mirrors WebGL's `czm_lightColor` automatic uniform. Used by the
  // Lambert diffuse path so scene-provided custom light colors (e.g.,
  // setting `scene.light.color` to a warm sunset orange) propagate to
  // the globe. Default is white (1,1,1) when no custom light is set.
  // .w reserved for future use (e.g. ambient color scalar).
  lightColor: vec4<f32>,
  // ─── Batch 77: custom Lambert coefficients (tile-provider-driven) ───
  // Mirrors WebGL's `u_lambertDiffuseMultiplier` and
  // `u_vertexShadowDarkness` fragment uniforms (see GlobeFS.glsl L132-133,
  // L559). When the terrain provider supplies vertex normals (e.g. STK
  // World Terrain with normals), the WebGL ENABLE_VERTEX_LIGHTING path
  // uses the formula
  //   diffuse = clamp(NdotL * lambertDiffuseMultiplier + vertexShadowDarkness, 0, 1)
  // — a direct linear ramp with no per-altitude fade.
  //
  //   x = lambertDiffuseMultiplier  (default 0.9 from Globe.js:170)
  //   y = vertexShadowDarkness      (default 0.3 from Globe.js:523)
  //   z = hasVertexNormals flag — when > 0.5, the Lambert path uses the
  //       (x, y) coefficients directly (matches WebGL ENABLE_VERTEX_LIGHTING);
  //       when ≤ 0.5, the Lambert path falls back to the existing WGSL
  //       hardcoded `NdotL × 0.88 + 0.12` aesthetic that replaces
  //       WebGL's ENABLE_DAYNIGHT_SHADING path.
  //   w = reserved (future: WebGL `fade` scalar for DAYNIGHT_SHADING path
  //       exact-match if we ever bridge that too).
  lighting: vec4<f32>,
  // ─── Renderer-wide log depth (Approach A) ───
  //   x = frustum near, y = frustum far,
  //   z = oneOverLog2FarDepthFromNearPlusOne (the log-depth factor),
  //   w = reserved.
  // Carries zero until `_logDepthWriteEnabled` flips on; the `//>>ifdef
  // LOG_DEPTH` blocks below are the only readers. Packed by
  // WebGPUGlobeSurfaceCameraUB. See WebGPULogDepth.ts.
  logDepth: vec4<f32>,
  // ─── DP-H44 (Batch 360): globe terrain pick color ───
  // The globe's registered pick-ID color, read ONLY by `fragmentPickMain`
  // (the pick-pass entry point). Packed at the camera-UB TAIL by
  // WebGPUGlobeSurfaceCameraUB so the additive layout shifts no existing
  // offset. (0,0,0,0) unless `globe.pickable` is set — so by default the
  // pick FBO receives globe DEPTH (matching WebGL's `updateForPick`
  // re-push, which is what `scene.pickPosition` needs) but writes a zero
  // pick color, leaving `scene.pick` undefined over the globe (WebGL
  // parity). When `globe.pickable` is true this carries the real pick-ID
  // color and `scene.pick` returns the Globe.
  pickColor: vec4<f32>,
  // ─── Batch 437 (CLOUD-SHADOWS): sun-view beer shadow map projection ───
  // `cloudShadowVP` maps a WORLD (ECEF) position into the sun's orthographic clip
  // space; the FS projects the fragment, reads the cloud OPTICAL DEPTH column from
  // `cloudShadowMap` (group 2 binding 9), and darkens the lit ground by
  // transmittance = exp(-depth·absorption). `cloudShadowControl`: x = enabled
  // (1.0 when globe.cloudCastShadows AND a real map was rendered), y =
  // absorptionCoeff (so exp() matches the cloud render), z = strength (0..1
  // darkening scale), w = reserved. Additive tail-append — no existing offset
  // shifts; (identity, 0,0,0,0) by default so the FS gate (`x > 0.5`) stays closed
  // and the render is byte-identical.
  cloudShadowVP: mat4x4<f32>,
  cloudShadowControl: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

//>>ifdef LOG_DEPTH
// Renderer-wide log depth (Approach A). The globe shader is fully inline
// (it does not use the #import chunk system), so these mirror the canonical
// definitions in Shaders/WebGPU/chunks/functions/csm_{vertexLogDepth,
// writeLogDepth}.wgsl — keep them in sync. near/far/factor come from
// camera.logDepth (packed by WebGPUGlobeSurfaceCameraUB).
fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
  // Linear "eye distance from near, plus one" — interpolated; the FS takes log2.
  return (clipPosition.w - near) + 1.0;
}
fn csm_updatePositionDepth(clipPosition: vec4<f32>) -> vec4<f32> {
  // Clamp clip z (WebGPU NDC [0,1]) so FP rounding at huge far/near ratios
  // can't clip a vertex before the FS writes the correct log depth.
  var coords = clipPosition;
  coords.z = clamp(coords.z / coords.w, 0.0, 1.0) * coords.w;
  return coords;
}
fn csm_writeLogDepth(depthFromNearPlusOne: f32, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {
  return log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne;
}
// Per-fragment interpolated depthFromNearPlusOne, stashed by fragmentMain so
// makeFragOutput (called from ~15 sites) can write frag_depth without a param.
var<private> g_fragLogDepth: f32;
//>>endif

// ─── Tile Imagery Uniforms (Group 0, Binding 1) ───
//
// Batch 58 — C-R5 imagery layer expansion. Per-layer struct now carries
// the 5 fields previously WebGL-only: hue, oneOverGamma, split, colorToAlpha
// (vec4 = rgb + threshold; threshold < 0 disables), cutoutRectangle (vec4 in
// tile-UV space; zero-area disables). Layout below is alignment-driven:
// vec4 fields first, then a 4-scalar slot, then a second 4-scalar slot for
// the new per-layer scalars. 24 floats / 96 bytes per layer × 16 = 1536 B.
struct ImageryLayer {
  translationAndScale: vec4<f32>,
  texCoordsRect: vec4<f32>,
  // colorToAlpha.rgb = key color, .a = threshold (< 0 disables — matches
  // WebGL convention from GlobeSurfaceTileProviderRendering.js)
  colorToAlpha: vec4<f32>,
  // cutoutRectangle in tile-UV space (west, south, east, north). When any
  // component is non-zero AND the rectangle has positive area, fragments
  // INSIDE this rectangle have the layer's contribution skipped. Zero-area
  // disables the cutout (matches WebGL `u_dayTextureCutoutRectangles`).
  cutoutRectangle: vec4<f32>,
  alpha: f32,
  brightness: f32,
  contrast: f32,
  saturation: f32,
  // Per-layer hue rotation in radians (0 = no change).
  hue: f32,
  // 1.0 / layer.gamma — pre-divided on CPU. 1.0 = no change.
  oneOverGamma: f32,
  // SplitDirection: -1 = LEFT (only show when fragX < splitPosition),
  // 0 = NONE (always show), +1 = RIGHT (only show when fragX > splitPosition).
  split: f32,
  _layerPad: f32,
};

// Maximum imagery layers per draw call. WebGPU minimum guarantee for
// `maxSampledTexturesPerShaderStage` is 16, so 16 is the safe upper bound
// without device-limit probing. Tiles with >16 layers fall back to multi-pass
// rendering (handled CPU-side by WebGPUGlobeSurfaceRenderer.createTileCommands).
struct TileUniforms {
  layers: array<ImageryLayer, 16>,
  // Per-layer day/night alpha pairs (dayAlpha, nightAlpha) packed two layers
  // per vec4: dayNightAlpha[i/2].xy = layer (2i)'s pair, .zw = layer (2i+1)'s
  // pair. Array stride forced to 16 by uniform-address-space rules.
  dayNightAlpha: array<vec4<f32>, 8>,
  // Per-layer useWebMercatorT flag (>0.5 → use webMercatorT, otherwise geo V).
  // Packed 4 layers per vec4: useWebMercatorTLayer[i/4][i%4].
  useWebMercatorTLayer: array<vec4<f32>, 4>,
  layerCount: f32,
  fogDensity: f32,
  fogOffset: f32,
  fogMinimumBrightness: f32,
  waterMaskTranslationAndScale: vec4<f32>,
  cartographicLimitRect: vec4<f32>,
  nightFadeOutDistance: f32,
  nightFadeInDistance: f32,
  verticalExaggeration: f32,
  verticalExaggerationRelativeHeight: f32,
  // Flags: x=hasWaterMask, y=enableClipping, z=showOceanWaves, w=isSubsequentPass
  flags: vec4<f32>,
  // === Night & Ocean Enhancement Parameters ===
  // oceanParams: x=deepR, y=deepG, z=deepB, w=fresnelPower
  oceanParams: vec4<f32>,
  // nightOceanParams: x=nightIntensity, y=oceanReflectivity, z=foamThreshold, w=oceanDarkening
  nightOceanParams: vec4<f32>,
  time: f32,
  // OPEN-5 fix: modulates the fog exponential to match WebGL's
  // `czm_fog(dist, color, fogColor, scalar)`. Default 0.15.
  fogVisualDensityScalar: f32,
  // splitPosition in framebuffer pixels (matches @builtin(position).x).
  // CPU side multiplies `frameState.splitPosition` (a 0..1 fraction) by
  // `drawingBufferWidth`, mirroring WebGL's `czm_splitPosition` auto-uniform.
  splitPosition: f32,
  _tilePad0: f32,
  // Per-tile debug fields (Tier 2 debug). All zero in production:
  //   x = tileLevel — LOD depth integer (read by fragmentDebugLod)
  //   y = isolateImageryLayer — index 0..15 to render alone, or -1 for all
  //                              (read by fragmentMain when set)
  //   z, w = reserved for future debug toggles
  debugFields: vec4<f32>,
  // DP-H24 — Globe hue/saturation/brightness shift. When any channel
  // is non-zero (|shift| > 0.001) the final composite color is
  // converted to HSB, shifted, and converted back. Matches the
  // WebGL path's `u_hsbShift` in GlobeFS.glsl.
  //   x = hueShift (-inf..+inf, wrapped via fract)
  //   y = saturationShift (-1..+1, clamped)
  //   z = brightnessShift (-1..+1, clamped)
  //   w = padding
  hsbShift: vec4<f32>,
  // Session 65 (2026-05-11) — GroundAtmosphere drape control. WebGL has
  // TWO delivery paths for the atmospheric color over the planet disk:
  // the FOG branch (close to ground) and the `#else` `lightingFade`
  // branch (far from ground). Our WGSL shader previously only wired the
  // FOG branch, so at orbital altitudes (cam > 800 km, fog disabled) the
  // drape was missing entirely — only the SkyAtmosphere shell at the
  // limb was visible. This slot enables the far-from-ground drape:
  //   x = enable flag (1.0 if showGroundAtmosphere AND fade > 0)
  //   y = fade scalar (pre-computed CPU-side; same formula as
  //       GlobeFS.glsl line 391 — drives the final mix factor between
  //       imagery and atmosphere color)
  //   z = atmosphereLightIntensity
  //   w = reserved
  groundAtmosphereControl: vec4<f32>,
  // Batch 247 (NEW-GROUND-VIEW-ENV-DIVERGENCES) — WebGL's `u_initialColor`:
  // `globe.baseColor` on the first pass (rendered where no imagery is
  // available), transparent black on subsequent multi-pass imagery passes
  // (matching WebGL's `otherPassesInitialColor`). Replaces the previous
  // hardcoded vec3(0.04, 0.04, 0.06) first-pass base.
  initialColor: vec4<f32>,
};

@group(0) @binding(1) var<uniform> tile: TileUniforms;

// ─── Textures (Group 1): Day imagery (16 slots — Batch 58, C-R5) ───
// WebGPU minimum guarantee for `maxSampledTexturesPerShaderStage` is 16, so
// 16 is the safe ceiling without device-limit probing. Tiles with >16 layers
// fall back to multi-pass rendering (CPU-side, see createTileCommands).
@group(1) @binding(0)  var dayTexture0:  texture_2d<f32>;
//>>ifdef GLOBE_IMAGERY_REDUCED
// NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT (Batch 246) — reduced layout for
// default-limit adapters (maxSampledTexturesPerShaderStage = 16, e.g.
// SwiftShader CI / compat mode). Only dayTexture0 is declared; the full
// pipeline layout's other 15 sampled textures (4 in group 2 + 11 in the
// effects group) bring the total to exactly 16. Multi-layer tiles
// multi-pass at one layer per pass (CPU-side slicing keys off the
// renderer's `_imagerySlotCount`). `texSampler` stays at @binding(16) in
// BOTH variants so the JS bind-group builder shares one shape.
//>>else
@group(1) @binding(1)  var dayTexture1:  texture_2d<f32>;
@group(1) @binding(2)  var dayTexture2:  texture_2d<f32>;
@group(1) @binding(3)  var dayTexture3:  texture_2d<f32>;
@group(1) @binding(4)  var dayTexture4:  texture_2d<f32>;
@group(1) @binding(5)  var dayTexture5:  texture_2d<f32>;
@group(1) @binding(6)  var dayTexture6:  texture_2d<f32>;
@group(1) @binding(7)  var dayTexture7:  texture_2d<f32>;
@group(1) @binding(8)  var dayTexture8:  texture_2d<f32>;
@group(1) @binding(9)  var dayTexture9:  texture_2d<f32>;
@group(1) @binding(10) var dayTexture10: texture_2d<f32>;
@group(1) @binding(11) var dayTexture11: texture_2d<f32>;
@group(1) @binding(12) var dayTexture12: texture_2d<f32>;
@group(1) @binding(13) var dayTexture13: texture_2d<f32>;
@group(1) @binding(14) var dayTexture14: texture_2d<f32>;
@group(1) @binding(15) var dayTexture15: texture_2d<f32>;
//>>endif
@group(1) @binding(16) var texSampler: sampler;

// ─── Water mask + Ocean normal map (Group 2, merged) ───
@group(2) @binding(0) var waterMaskTexture: texture_2d<f32>;
@group(2) @binding(1) var waterMaskSampler: sampler;
@group(2) @binding(2) var oceanNormalMap: texture_2d<f32>;
@group(2) @binding(3) var oceanNormalSampler: sampler;
// ─── Batch 437 (CLOUD-SHADOWS): sun-view beer shadow map (Group 2, 9/10) ───
// Single-channel cloud OPTICAL DEPTH rendered from the sun's ortho view. Bound
// UNCONDITIONALLY (the TS layout always declares 9/10) so the pipeline layout never
// forks; a 1×1 zero placeholder (optical depth 0 → transmittance 1, no shadow) is
// bound when globe.cloudCastShadows is off. Sampled only inside the
// `cloudShadowControl.x > 0.5` gate, so the off path never reads it.
@group(2) @binding(9) var cloudShadowMap: texture_2d<f32>;
@group(2) @binding(10) var cloudShadowSampler: sampler;

// ─── Effects bind group: shadow receive + clipping planes (Group 3) ───
// Phase 5 WGF-1: trailing two vec4 slots hold the precomputed
// `dPrime[i] = d + dot(n, camera)` values for the hardware clip-distances
// pipeline variant. Slots beyond `clippingPlaneCount` (or beyond 8) carry
// +Infinity so the rasterizer never clips against them. The legacy
// fragment-discard path ignores these fields.
struct EffectsUniforms {
    shadowMatrix: mat4x4<f32>,
    shadowMapSize: vec2<f32>,
    shadowDarkness: f32,
    shadowSoftShadows: f32,
    clippingPlaneCount: u32,
    clippingUnionMode: u32,
    clippingEdgeWidth: f32,
    clippingPolygonCount: u32,
    clippingEdgeColor: vec4<f32>,
    // WGF-1: each entry is (n.xyz, dPrime); unused slots are (0,0,0,+inf).
    clipPlaneEqHW: array<vec4<f32>, 8>,
    // Atmosphere LUT control:
    //   .x = useAtmosphereLut flag (>0.5 → sample bindings 7/8 for
    //        physically-accurate transmittance + inscatter; otherwise
    //        fall back to inline Rayleigh/Mie approximation in
    //        computeAtmosphereColor)
    //   .y = innerRadius / planetRadius (meters) — used to recover
    //        altitude for LUT U/V mapping
    //   .z = atmosphere thickness (outer - inner, meters)
    //   .w = reserved
    atmosphereLutControl: vec4<f32>,
    // CSM Slice 1 — cascaded shadow map control:
    //   .x = csmEnabled flag (>0.5 → sample cascade depth array at
    //        bindings 10/11 via `sampleCascadeShadow`; otherwise use
    //        the single shadow map at bindings 1/2)
    //   .y = PCF kernel radius in shadow texels (NEW-CSM-SOFT-SHADOW-PCF).
    //        >0 → `sampleOneCascade` runs a 3x3 PCF box kernel (soft
    //        edges, matches WebGL czm_shadowVisibility USE_SOFT_SHADOWS);
    //        0 → single hardware-comparison tap (hard edge).
    //   .z/.w reserved (cascade count, moon-light flag, etc).
    // Matches `CSM_CONTROL_OFFSET` on the JS side.
    csmControl: vec4<f32>,
    // C-R10-POINT-LIGHT-RECEIVE-GLOBE (Batch 108) — point-light cube
    // shadow control. Lays out IDENTICAL to the model shader's
    // EffectsUniforms tail so both shaders read the same bytes from
    // the shared effects UB. The globe shader previously stopped at
    // csmControl; extending the struct here lets globe terrain
    // receive point-light shadows without a separate UB.
    //   .x = pointLightActive flag (>0.5 → sample binding 17 via
    //        `globeSamplePointShadow`)
    //   .y = far plane (light radius)
    //   .z = near plane (typically 1.0)
    //   .w = depth bias
    // Matches model shader's `pointLightControl` at offset 304.
    pointLightControl: vec4<f32>,
    // .xyz = light position in world coords (ECEF for SCENE3D).
    // .w = PCF radius in cube-face texels (0 → hard sampling). Matches
    // model shader's `pointLightPositionWC` at offset 320.
    pointLightPositionWC: vec4<f32>,
}

// CSM Slice 1 — cascade parameters UBO. Layout matches
// `WebGPUCSMRenderer._cascadeParamsData` (272 floats, 1088 bytes):
//   offset   0: 4 × mat4<f32> cascade VP_RTE matrices (256 floats)
//   offset 256: vec4<f32> cascadeSplits (view-space far depth per cascade)
//   offset 260: vec4<f32> blendBands (blend-band width per cascade split)
//   offset 264: vec4<f32> cascadeMinBias (per-cascade NDC minimum bias)
//   offset 268: vec4<f32> cascadeMaxSlopeBias (per-cascade slope-bias ceiling)
// The VP matrices are RTE-aware — multiply by `v_positionRTE` (NOT
// reconstructed worldPos) to sample correctly at Earth scale. Placeholder
// (zero-filled) when CSM is disabled; the `effects.csmControl.x > 0.5`
// gate keeps this from being sampled in that case.
struct CSMParams {
    cascadeVP0: mat4x4<f32>,
    cascadeVP1: mat4x4<f32>,
    cascadeVP2: mat4x4<f32>,
    cascadeVP3: mat4x4<f32>,
    cascadeSplits: vec4<f32>,
    blendBands: vec4<f32>,
    cascadeMinBias: vec4<f32>,
    cascadeMaxSlopeBias: vec4<f32>,
}

@group(3) @binding(0) var<uniform> effects: EffectsUniforms;
@group(3) @binding(1) var shadowDepthTex: texture_depth_2d;
@group(3) @binding(2) var shadowCompSampler: sampler_comparison;
@group(3) @binding(3) var clippingPlaneTex: texture_2d<f32>;
@group(3) @binding(4) var clippingPlaneSampler: sampler;
@group(3) @binding(5) var polygonSDFTex: texture_2d<f32>;
@group(3) @binding(6) var polygonSDFSampler: sampler;
// Phase 4 — AtmosphereLUT integration for fog color. The transmittance
// LUT gives Beer-Lambert attenuation for a view ray's altitude + zenith
// angle; the inscatter LUT gives the scattered sky color along that
// ray, precomputed by the AtmosphereLUT compute pass using the same
// scattering parameters the SkyAtmosphere shell uses — so terrain fog
// now matches the visible atmosphere dome. Gated on
// `effects.atmosphereLutControl.x > 0.5`; placeholder 1×1 float
// textures bind here when the LUT isn't ready yet, producing a
// transmittance of 0 that makes the LUT path a no-op (falls through
// to the inline atmosphere color).
@group(3) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(3) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(3) @binding(9) var atmosphereLutSampler: sampler;
// CSM Slice 1 — cascaded shadow map bindings. Always present in the
// layout (zero-filled placeholders when CSM disabled) so we don't need
// a second pipeline variant. Sampled only when
// `effects.csmControl.x > 0.5` via `sampleCascadeShadow`.
@group(3) @binding(10) var<uniform> csmParams: CSMParams;
@group(3) @binding(11) var cascadeDepthArray: texture_depth_2d_array;
// C-R10-POINT-LIGHT-RECEIVE-GLOBE (Batch 108) — cube depth target
// shared with the model receive path. The shared `EffectsBindGroupLayout`
// in WebGPUEffectsBindGroup declares this at binding 17; the globe
// previously didn't reference it. Bound to a 1×1×6 placeholder
// (cleared to depth=1.0) when no point light is active so the bind
// group always validates; the `effects.pointLightControl.x > 0.5`
// gate skips sampling in that case.
@group(3) @binding(17) var pointLightCubeDepth: texture_depth_cube;

// ─── Group 2 extension: Globe material slots (Session 65 Cluster 3) ───
// Material UBO + textures live at bindings 4-8 of Group 2 (alongside
// the water-mask + ocean-normal bindings 0-3). This keeps the total
// bind-group count at the WebGPU spec floor of 4, which matters because
// some implementations (e.g., Edge's adapter) report `maxBindGroups: 4`
// exactly. Layout matches the JS-side `_bindGroupLayout2` declaration.
//
// When MATERIAL_APPLY is NOT set, the JS side still binds placeholder
// resources to these slots so the pipeline layout doesn't drift between
// material and non-material pipelines. The WGSL declarations are
// emitted unconditionally — only the FS *uses* them when MATERIAL_APPLY
// is set via `//>>ifdef MATERIAL_APPLY` at the call site.
//
// The material's `MaterialUniforms` struct definition + `materialUniforms`
// var<uniform> binding are emitted by the JS-side prelude builder
// (`buildMaterialPrelude` in `WebGPUGlobeMaterial.ts`) so the per-material
// uniform shape can vary. The texture/sampler declarations are constant
// across materials (the in-tree set never exceeds two textures).
//>>ifdef MATERIAL_APPLY
@group(2) @binding(5) var image: texture_2d<f32>;
@group(2) @binding(6) var imageSampler: sampler;
@group(2) @binding(7) var heights: texture_2d<f32>;
@group(2) @binding(8) var heightsSampler: sampler;
//>>endif

// ─── Vertex Input / Output ───
// DP-H25 — the `@location(2) geodeticSurfaceNormal` slot is conditionally
// declared in all three input structs via the `GEODETIC_NORMAL` preprocessor
// define. When active, the TS pipeline builder adds the matching
// attribute over the trailing 12 bytes of each tile's vertex stride so
// the exaggeration branch in `processVertex` can use the true WGS84
// geodetic normal. When inactive, the attribute is absent and callers
// pass `vec3<f32>(0.0)` as the sentinel — the exaggeration branch
// falls back to `normalize(position3D)`.
struct VertexInput {
  @location(0) position3DAndHeight: vec4<f32>,
  @location(1) textureCoordAndEncodedNormals: vec4<f32>,
  //>>ifdef GEODETIC_NORMAL
  @location(2) geodeticSurfaceNormal: vec3<f32>,
  //>>endif
};

struct VertexInputQuantized {
  @location(0) compressed0: vec4<f32>,
  //>>ifdef GEODETIC_NORMAL
  @location(2) geodeticSurfaceNormal: vec3<f32>,
  //>>endif
};

// Separate struct for the `hasWebMercatorT && hasNormals` quantized case.
// When both are present, compressed0.w holds the compressed webMercatorT and
// the oct-encoded normal spills into a separate single-component attribute
// at location 1 \u2014 see TerrainEncoding.getAttributes:683-691. The WebGPU
// pipeline must declare location 1 as float32 so the shader can read it.
struct VertexInputQuantizedWebMercNormals {
  @location(0) compressed0: vec4<f32>,
  @location(1) compressed1: f32,
  //>>ifdef GEODETIC_NORMAL
  @location(2) geodeticSurfaceNormal: vec3<f32>,
  //>>endif
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) v_textureCoordinates: vec3<f32>,  // (u, v_geographic, webMercatorT)
  @location(1) v_positionEC: vec3<f32>,
  @location(2) v_normalEC: vec3<f32>,
  @location(3) v_positionMC: vec3<f32>,
  @location(4) v_distance: f32,
  // RTE position (camera-relative, full RTE precision — not a lossy
  // reconstruction of worldPos). Consumed by the CSM receive path to
  // feed into the RTE-aware cascade VP matrices without the ~1m FP32
  // quantization that would occur when reconstructing worldPos =
  // positionHigh + positionLow at Earth scale. Zero in non-SCENE3D modes
  // (the CSM branch is gated on SCENE3D in WebGPUContext).
  @location(5) v_positionRTE: vec3<f32>,
  // ─── Session 65 Batch 9: per-vertex ground-atmosphere scattering ───
  // Output of the vertex-stage Nishita ray-march. The fragment shader
  // applies the Rayleigh and Mie phase functions per-fragment (the Mie
  // phase varies sharply with view angle so it must be evaluated per
  // pixel) and modulates by the global light intensity. When the
  // atmosphere is disabled (`atmosphereParams.w < 0.5`), the vertex
  // shader skips the ray-march entirely and these stay zero — the
  // fragment shader gates on the same flag.
  @location(6) v_atmosphereRayleighColor: vec3<f32>,
  @location(7) v_atmosphereMieColor: vec3<f32>,
  @location(8) v_atmosphereOpacity: f32,
  // ─── Cluster 3 — per-vertex slope/height/aspect for globe materials ───
  // Mirrors the WebGL GlobeVS outputs `v_slope` / `v_aspect` / `v_height`
  // gated by `#ifdef APPLY_MATERIAL`. Always emitted by the WGSL VS
  // because we don't currently dead-strip on the WGSL preprocessor for
  // these — the cost is 3 floats per vertex and avoids needing a
  // separate vertex shader variant per material. Consumers:
  // ElevationRamp (.height), SlopeRamp (.slope), AspectRamp (.aspect),
  // ElevationContour (.height), ElevationBand (.height).
  @location(9) v_slope: f32,
  @location(10) v_aspect: f32,
  @location(11) v_height: f32,
  //>>ifdef LOG_DEPTH
  // Interpolated linear depthFromNearPlusOne; the FS converts it to frag_depth.
  @location(12) v_logDepth: f32,
  //>>endif
};

// ─── Constants ───
// Fallback used only if the CPU never uploads a real ellipsoid radius. WGS84
// equatorial radius. Shader code should prefer `camera.ellipsoidRadius`.
const EARTH_RADIUS_FALLBACK: f32 = 6378137.0;
const PI: f32 = 3.14159265358979;

// ─── Default ocean parameters (used when uniforms are zero/unset) ───
fn getOceanDeepColor() -> vec3<f32> {
  let p = tile.oceanParams;
  // If all zero, use sensible defaults
  if (p.x == 0.0 && p.y == 0.0 && p.z == 0.0) {
    return vec3<f32>(0.008, 0.045, 0.12);
  }
  return vec3<f32>(p.x, p.y, p.z);
}

fn getFresnelPower() -> f32 {
  let p = tile.oceanParams.w;
  return select(p, 5.0, p == 0.0);
}

fn getNightIntensity() -> f32 {
  let n = tile.nightOceanParams.x;
  return select(n, 2.5, n == 0.0);
}

fn getOceanReflectivity() -> f32 {
  let r = tile.nightOceanParams.y;
  return select(r, 0.04, r == 0.0);
}

fn getFoamThreshold() -> f32 {
  let f = tile.nightOceanParams.z;
  return select(f, 0.35, f == 0.0);
}

fn getOceanDarkening() -> f32 {
  let d = tile.nightOceanParams.w;
  return select(d, 0.6, d == 0.0);
}

// ─── RTE Translation ───
fn translateRelativeToEye(posHigh: vec3<f32>, posLow: vec3<f32>,
                          camHigh: vec3<f32>, camLow: vec3<f32>) -> vec4<f32> {
  let highDiff = posHigh - camHigh;
  let lowDiff = posLow - camLow;
  return vec4<f32>(highDiff + lowDiff, 1.0);
}

// ─── Oct-decode normal from single float ───
// Batch 61 — sanitize per-vertex `webMercatorT` against NaN. The
// CPU-side formula in `HeightmapTessellator.geodeticLatitudeToMercatorAngle`
// produces ±Infinity at latitude=±90°, and Cesium's per-tile
// normalization (`(mercY − southMercY) × oneOverMercatorHeight`) turns
// that into NaN for polar-spanning tiles whose south or north edge IS
// at ±90°. WGSL's `step()` and `select()` with NaN follow strict IEEE
// (false), which collapses the imagery `texCoordsAlpha` mask to zero
// and produces the polar-black-hole rendering. WebGL's GLSL drivers
// historically deviate from strict IEEE and treat NaN as "always in
// range," so polar imagery rasterizes despite the NaN.
//
// We replace NaN with the geographic V (the same as the WebGL fallback
// when `useWebMercatorT == false`). For tiles entirely within ±85° the
// input is already a valid finite number — passed through unchanged.
fn sanitizeWebMercatorT(webMercT: f32, geoV: f32) -> f32 {
  // `x != x` is `true` iff `x` is NaN.
  return select(webMercT, geoV, webMercT != webMercT);
}

fn octDecode(encoded: f32) -> vec3<f32> {
  let temp = encoded / 256.0;
  let x01 = floor(temp) / 255.0;
  let y01 = fract(temp) * 256.0 / 255.0;
  let v2 = vec2<f32>(x01, y01) * 2.0 - 1.0;
  let vz = 1.0 - abs(v2.x) - abs(v2.y);
  var result: vec3<f32>;
  if (vz < 0.0) {
    let sx = select(-1.0, 1.0, v2.x >= 0.0);
    let sy = select(-1.0, 1.0, v2.y >= 0.0);
    result = vec3<f32>(
      (1.0 - abs(v2.y)) * sx,
      (1.0 - abs(v2.x)) * sy,
      vz
    );
  } else {
    result = vec3<f32>(v2.x, v2.y, vz);
  }
  return normalize(result);
}

// ─── Decompress two 12-bit values packed into a single float ───
fn decompressTextureCoordinates(compressed: f32) -> vec2<f32> {
  let temp = compressed / 4096.0;
  let xZeroTo4095 = floor(temp);
  return vec2<f32>(
    xZeroTo4095 / 4095.0,
    (compressed - xZeroTo4095 * 4096.0) / 4095.0
  );
}

// ─── Web Mercator latitude conversion ───
// Maps a geographic latitude (radians) to the Y position fraction in
// Web Mercator-projected texture space, given the south Mercator Y and
// 1/mercatorHeight uniforms (computed CPU-side from the tile rectangle).
const WEB_MERCATOR_MAX_LATITUDE: f32 = 1.4844222297453324; // ±85.05113°
fn latitudeToWebMercatorFraction(latitude: f32, southMercatorY: f32, oneOverHeight: f32) -> f32 {
  let sinLat = sin(latitude);
  let mercatorY = 0.5 * log((1.0 + sinLat) / (1.0 - sinLat));
  return (mercatorY - southMercatorY) * oneOverHeight;
}

// Returns the Y fraction (0..1) along the tile rectangle for a given
// vertex texture coordinate. When tile spans large latitude range and
// Web Mercator projection is in use, the latitude is reprojected.
fn get2DYPositionFraction(textureCoordinates: vec2<f32>) -> f32 {
  if (camera.useWebMercator < 0.5) {
    // Geographic projection — direct linear V coordinate
    return textureCoordinates.y;
  }

  // Web Mercator: linear interpolation when tile is small enough
  let southLatitude = camera.southAndNorthLatitude.x;
  let northLatitude = camera.southAndNorthLatitude.y;
  let maxTileWidth: f32 = 0.003068;
  if (northLatitude - southLatitude < maxTileWidth) {
    return textureCoordinates.y;
  }

  // Reproject latitude into Mercator fraction
  let southMercatorY = camera.southMercatorYAndOneOverHeight.x;
  let oneOverHeight = camera.southMercatorYAndOneOverHeight.y;
  var lat = mix(southLatitude, northLatitude, textureCoordinates.y);
  lat = clamp(lat, -WEB_MERCATOR_MAX_LATITUDE, WEB_MERCATOR_MAX_LATITUDE);
  return latitudeToWebMercatorFraction(lat, southMercatorY, oneOverHeight);
}

// Compute planar earth position for 2D / Columbus view modes.
// Returns world-space position vec3 with X=height, Y=longitude, Z=latitude
// (matches CesiumJS WebGL convention from getPositionPlanarEarth).
fn computePlanarPosition(height: f32, textureCoordinates: vec2<f32>) -> vec3<f32> {
  let yFrac = get2DYPositionFraction(textureCoordinates);
  let west = camera.tileRectangle.x;
  let south = camera.tileRectangle.y;
  let east = camera.tileRectangle.z;
  let north = camera.tileRectangle.w;
  let lon = mix(west, east, textureCoordinates.x);
  let lat = mix(south, north, yFrac);
  return vec3<f32>(height, lon, lat);
}

// ─── Shared vertex processing ───
// webMercatorT: Web Mercator vertical texture coordinate. When no Mercator
// data is present in the vertex buffer, callers pass textureCoordinates.y
// (geographic V) as a fallback — the fragment shader's per-layer
// useWebMercatorT flag selects which one to use for sampling.
// `precomputedHeight` is the tile-local height above the ellipsoid in meters.
// Uncompressed terrain carries it directly in `position3DAndHeight.w`;
// quantized terrain reconstructs it as `zh.y * (maxH - minH) + minH` from
// the stored minMaxHeight range. Using this precomputed height in the
// Morph / Columbus branches avoids `length(position3DWC) - EARTH_RADIUS` at
// f32 precision, which is a big-minus-big cancellation at Earth scale.
// If the caller can't supply a height (mode-agnostic fallback), pass a
// negative sentinel so processVertex knows to fall back to the length-based
// computation instead of producing zero-height planar positions.
const HEIGHT_SENTINEL_UNAVAILABLE: f32 = -999999.0;

// ═══════════════════════════════════════════════════════════════════════
// czm_Material fabric API surface — Cluster 3 (parallel WGSL fabric)
//
// These types + helpers mirror the GLSL `czm_material`, `czm_materialInput`,
// `czm_getDefaultMaterial`, `czm_gammaCorrect` API surface. The fabric
// assembler in `MaterialHelpers.js::createWGSLMethodDefinition` produces
// a `czm_getMaterial(materialInput) -> czm_Material` function which the
// Globe pipeline cache appends to the WGSL source per-material at
// pipeline-creation time.
//
// The Globe FS calls `czm_getMaterial(materialInput)` after the imagery
// composite when `MATERIAL_APPLY` is set (the pipeline cache toggles
// this via the WGSL preprocessor on `//>>ifdef MATERIAL_APPLY`).
//
// czm_MaterialInput: per-fragment scalar inputs the material samples
//   from. Mirrors `czm_materialInput` from GlobeFS — `st`, `normalEC`,
//   `positionToEyeEC`, `tangentToEyeMatrix`, `slope`, `height`, `aspect`,
//   `waterMask`.
//
// czm_Material: per-fragment color outputs the material returns to the
//   compositor. Mirrors `czm_material`.
// ═══════════════════════════════════════════════════════════════════════

struct czm_MaterialInput {
  st: vec2<f32>,
  normalEC: vec3<f32>,
  positionToEyeEC: vec3<f32>,
  tangentToEyeMatrix: mat3x3<f32>,
  slope: f32,
  height: f32,
  aspect: f32,
  waterMask: f32,
};

struct czm_Material {
  diffuse: vec3<f32>,
  specular: f32,
  shininess: f32,
  normal: vec3<f32>,
  emission: vec3<f32>,
  alpha: f32,
};

fn czm_getDefaultMaterial(input: czm_MaterialInput) -> czm_Material {
  var m: czm_Material;
  m.diffuse = vec3<f32>(0.0, 0.0, 0.0);
  m.specular = 0.0;
  m.shininess = 1.0;
  m.normal = input.normalEC;
  m.emission = vec3<f32>(0.0, 0.0, 0.0);
  m.alpha = 1.0;
  return m;
}

// Vector form for gamma-correct on a single vec3.
// Batch 54 — match the GLSL `czm_gammaCorrect` (gammaCorrect.glsl) which
// is GATED on `#ifdef HDR` and acts as a NO-OP in the default SDR path.
// The pre-Batch-54 WGSL unconditionally applied `pow(c, 2.2)` (sRGB →
// linear decode), making every globe fragment ~4.2x darker than WebGL
// — verified via probe-saved-view.mjs (meanBrightnessRatio 4.221 on
// default-3D between WebGL and WebGPU).
//
// The HDR path is not yet wired through the WGSL fragment pipeline. When
// it lands, this should switch back to `pow(c, czm_gamma)` (decode).
// Until then, identity matches what every published WebGL view produces.
fn czm_gammaCorrect(color: vec3<f32>) -> vec3<f32> {
  return color;
}

// vec4 overload preserves alpha unchanged. Some material `source` blocks
// call gammaCorrect on a vec4 (like the GLSL ElevationContour does);
// matching that here keeps the WGSL ports byte-clean.
fn czm_gammaCorrect4(color: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(czm_gammaCorrect(color.rgb), color.a);
}

// ═══════════════════════════════════════════════════════════════════════
// Nishita-style ground atmosphere ray-march
// (Session 65 Batch 9 — Cluster 2b/5 fog/atmosphere parity)
//
// Direct port of `computeScattering` from `Source/Shaders/AtmosphereCommon.glsl`
// + `computeAtmosphereScattering` from `Source/Shaders/GroundAtmosphere.glsl`.
// Runs in the vertex shader per the WebGL pattern: per-vertex accumulation
// outputs interpolate cleanly when combined with per-fragment Rayleigh/Mie
// phase functions in the fragment shader (interpolating *after* phase would
// be wrong because the Mie phase is sharply forward-peaked).
//
// The previous WGSL fragment-side `computeAtmosphereColor` used fixed
// (0.18, 0.38, 0.72) skyBlue scaled by 0.3 — qualitatively wrong magnitude
// AND missing the view-direction-dependent thickness integral. That made
// the fog color collapse to ~(0.04, 0.07, 0.10) at all view angles, which
// in turn dragged imagery toward the same dark blue at low altitudes
// (the Cluster 2b "dark-blue close-zoom" symptom).
//
// Constants match `Source/Shaders/AtmosphereCommon.glsl`:
//   PRIMARY_STEPS_MAX = 16   ← number of primary-ray sample positions
//   LIGHT_STEPS_MAX   =  4   ← number of light-ray sample positions per primary
//   ATMOSPHERE_THICKNESS = 111e3 (matches GLSL — kept in CPU side packing)
// ═══════════════════════════════════════════════════════════════════════

const ATMOSPHERE_PRIMARY_STEPS_MAX: i32 = 16;
const ATMOSPHERE_LIGHT_STEPS_MAX: i32 = 4;

struct AtmosphereScattering {
  rayleigh: vec3<f32>,
  mie: vec3<f32>,
  opacity: f32,
};

// Tangent approximation matching czm_approximateTanh — quintic polynomial
// good for the |x| <= 2 range we use it in (`x` is a normalized ratio).
fn approximateTanh(x: f32) -> f32 {
  let x2 = x * x;
  return clamp(
    x * (27.0 + x2) / (27.0 + 9.0 * x2),
    -1.0,
    1.0,
  );
}

// Ray-sphere intersection at sphere centered on origin, radius r.
// Returns vec2(tStart, tStop) — tStart < tStop when intersecting,
// vec2(0, 0) when missing (the GLSL `czm_emptyRaySegment` sentinel).
// Callers check that `stop > start` to detect intersection.
//
// Batch 56 — precision-stable formulation: the naive
//   `c = dot(origin, origin) - radius*radius`
// for a Cesium-scale camera at 1.6e7 m loses ~10m of precision (1.6e7
// squared = 2.56e14, beyond f32's 24-bit mantissa integer range).
//
// Defensive correctness fix only: this did NOT visibly resolve the WGS84
// orbit catastrophe on its own (the per-vertex-vs-per-fragment ground-
// atmosphere switch did — see fragmentMain below). WebGL has the same
// imprecision in its `czm_raySphereIntersectionInterval` and renders
// correctly via per-fragment scattering at orbit. We keep this fix
// because (a) it's correct, (b) it's cheap, and (c) ray-sphere
// intersection shows up in other render paths (sky atmosphere LUT,
// volumetric clouds, planetary collision) where the precision loss
// could matter independently.
//
// Scaling the origin by 1/radius keeps all intermediate quantities in
// the [-10, 10] range where f32 precision is ~1e-6.
fn raySphereIntersectionInterval(
  origin: vec3<f32>,
  dir: vec3<f32>,
  radius: f32,
) -> vec2<f32> {
  let invR = 1.0 / max(radius, 1e-6);
  let originScaled = origin * invR;
  let b = 2.0 * dot(dir, originScaled);
  let c = dot(originScaled, originScaled) - 1.0;
  let disc = b * b - 4.0 * c;
  if (disc < 0.0) {
    return vec2<f32>(0.0, 0.0);
  }
  let sqrtDisc = sqrt(disc);
  // Scale t-values back to world units.
  return vec2<f32>((-b - sqrtDisc) * 0.5 * radius, (-b + sqrtDisc) * 0.5 * radius);
}

// Per-vertex Rayleigh/Mie/opacity accumulation. Mirrors
// `Source/Shaders/AtmosphereCommon.glsl::computeScattering` — same
// PRIMARY/LIGHT step counts, same soft sky/horizon split, same
// optical-depth weighting and attenuation. Returns the *unmodulated*
// per-color scattering — the fragment shader's `computeAtmosphereColor`
// multiplies by the Rayleigh/Mie PHASE functions (per-fragment, view-
// direction-dependent) and the global light intensity.
fn computeScatteringGround(
  rayOrigin: vec3<f32>,
  rayDir: vec3<f32>,
  rayLength: f32,
  lightDirection: vec3<f32>,
  atmosphereInnerRadius: f32,
) -> AtmosphereScattering {
  var out: AtmosphereScattering;
  out.rayleigh = vec3<f32>(0.0);
  out.mie = vec3<f32>(0.0);
  out.opacity = 0.0;

  // Outer shell = inner + thickness (kept in atmosphereParams.z so CPU
  // controls the constant; WebGL's value is 111 km).
  let atmosphereOuterRadius = camera.atmosphereParams.z;

  // Primary ray's intersection with the outer atmosphere shell.
  var primaryIntersect = raySphereIntersectionInterval(
    rayOrigin, rayDir, atmosphereOuterRadius,
  );
  if (primaryIntersect.y <= primaryIntersect.x) {
    // No atmosphere intersection — return zero scattering.
    return out;
  }

  // Soft horizon-vs-sky weight. Matches GLSL: `1e-7 * stop / rayLength`
  // → tanh blend. Close to 0 = near horizon (long path), close to 1 =
  // near zenith (short path).
  let xHoriz = 1e-7 * primaryIntersect.y / max(rayLength, 1.0);
  let wStopGtLprl = 0.5 * (1.0 + approximateTanh(xHoriz));

  let start0 = primaryIntersect.x;
  primaryIntersect.x = max(primaryIntersect.x, 0.0);
  primaryIntersect.y = min(primaryIntersect.y, rayLength);

  // Inside-atmosphere weight: 1 when camera is inside the shell, 0 when
  // outside. Drives step-count reduction (cheaper march when inside)
  // and ramped step length.
  let xOA = start0 - 111000.0;  // ATMOSPHERE_THICKNESS
  let wInsideAtm = 1.0 - 0.5 * (1.0 + approximateTanh(xOA));
  let primarySteps = ATMOSPHERE_PRIMARY_STEPS_MAX - i32(wInsideAtm * 12.0);
  let lightSteps = ATMOSPHERE_LIGHT_STEPS_MAX - i32(wInsideAtm * 2.0);

  var rayPositionLength = primaryIntersect.x;
  let totalRayLength = primaryIntersect.y - rayPositionLength;
  let denom = max(7.0 * wInsideAtm, f32(primarySteps));
  var rayStepLength = max(1.0 - wInsideAtm, wStopGtLprl) * totalRayLength / denom;
  // Step length grows over the march when inside-atmosphere — compensates
  // for the reduced step count at low altitudes.
  let triangleSum = f32(primarySteps * (primarySteps + 1)) * 0.5;
  let rayStepLengthIncrease = wInsideAtm *
    ((1.0 - wStopGtLprl) * totalRayLength / max(triangleSum, 1.0));

  var rayleighAccum = vec3<f32>(0.0);
  var mieAccum = vec3<f32>(0.0);
  var opticalDepth = vec2<f32>(0.0);
  let rayleighScaleHeight = camera.atmosphereRayleighCoefficientAndScale.w;
  let mieScaleHeight = camera.atmosphereMieCoefficientAndScale.w;
  let rayleighCoeff = camera.atmosphereRayleighCoefficientAndScale.rgb;
  let mieCoeff = camera.atmosphereMieCoefficientAndScale.rgb;

  for (var i: i32 = 0; i < ATMOSPHERE_PRIMARY_STEPS_MAX; i = i + 1) {
    if (i >= primarySteps) { break; }

    // Sample position along primary ray (note: GLSL increments
    // `rayPositionLength` AFTER computing samplePosition with +rayStepLength,
    // matching that subtle offset by sampling at the segment's *end*).
    let samplePosition = rayOrigin + rayDir * (rayPositionLength + rayStepLength);
    let sampleHeight = max(0.0, length(samplePosition) - atmosphereInnerRadius);

    // Density accumulation × step length (Rayleigh.x, Mie.y).
    let sampleDensity = vec2<f32>(
      exp(-sampleHeight / rayleighScaleHeight) * rayStepLength,
      exp(-sampleHeight / mieScaleHeight) * rayStepLength,
    );
    opticalDepth = opticalDepth + sampleDensity;

    // Light ray from samplePosition to its intersection with the outer
    // shell. We use the segment length to size each LIGHT_STEPS sub-step.
    let lightIntersect = raySphereIntersectionInterval(
      samplePosition, lightDirection, atmosphereOuterRadius,
    );
    let lightStepLength = lightIntersect.y / max(f32(lightSteps), 1.0);
    var lightOpticalDepth = vec2<f32>(0.0);
    var lightPositionLength: f32 = 0.0;
    for (var j: i32 = 0; j < ATMOSPHERE_LIGHT_STEPS_MAX; j = j + 1) {
      if (j >= lightSteps) { break; }
      let lightPos = samplePosition + lightDirection *
        (lightPositionLength + lightStepLength * 0.5);
      let lightH = max(0.0, length(lightPos) - atmosphereInnerRadius);
      lightOpticalDepth = lightOpticalDepth + vec2<f32>(
        exp(-lightH / rayleighScaleHeight) * lightStepLength,
        exp(-lightH / mieScaleHeight) * lightStepLength,
      );
      lightPositionLength = lightPositionLength + lightStepLength;
    }

    // Attenuation along both rays — Beer-Lambert with combined optical
    // depth (Rayleigh + Mie). Each channel attenuates independently.
    let attenuation = exp(
      -((mieCoeff * (opticalDepth.y + lightOpticalDepth.y)) +
        (rayleighCoeff * (opticalDepth.x + lightOpticalDepth.x))),
    );

    rayleighAccum = rayleighAccum + sampleDensity.x * attenuation;
    mieAccum = mieAccum + sampleDensity.y * attenuation;

    rayStepLength = rayStepLength + rayStepLengthIncrease;
    rayPositionLength = rayPositionLength + rayStepLength;
  }

  out.rayleigh = rayleighCoeff * rayleighAccum;
  out.mie = mieCoeff * mieAccum;
  // Transmittance: how much light passes through the atmosphere on the
  // primary ray. WebGL: `length(exp(-(Mie*tau_m + Rayleigh*tau_r)))`.
  out.opacity = length(
    exp(-((mieCoeff * opticalDepth.y) + (rayleighCoeff * opticalDepth.x))),
  );
  return out;
}

// Wraps `computeScatteringGround` for the ground-shading case. Mirrors
// `Source/Shaders/GroundAtmosphere.glsl::computeAtmosphereScattering`:
// `atmosphereInnerRadius` = length(positionWC). The light direction
// optionally falls back to `normalize(positionWC)` when dynamic-lighting
// is disabled (matches the WebGL `czm_branchFreeTernary` choice).
fn computeAtmosphereScatteringGround(
  positionWC: vec3<f32>,
  lightDirection: vec3<f32>,
) -> AtmosphereScattering {
  let cameraWC = camera.encodedCameraHigh + camera.encodedCameraLow;
  let cameraToPosition = positionWC - cameraWC;
  let rayLength = length(cameraToPosition);
  let rayDir = select(
    vec3<f32>(0.0, 0.0, 1.0),
    cameraToPosition / max(rayLength, 1e-6),
    rayLength > 1e-6,
  );
  let innerRadius = length(positionWC);
  return computeScatteringGround(
    cameraWC,
    rayDir,
    rayLength,
    lightDirection,
    innerRadius,
  );
}

// Per-fragment phase-function combination of the per-vertex Rayleigh + Mie
// values. Mirrors `Source/Shaders/AtmosphereCommon.glsl::computeAtmosphereColor`:
// applies the Rayleigh phase (cos²θ) and the Mie phase (Henyey-Greenstein)
// then scales by the global light intensity. Returns linear HDR — the
// caller is responsible for tonemap + gamma encoding before mix.
fn computeGroundAtmosphereColor(
  cameraToPositionDir: vec3<f32>,
  lightDirection: vec3<f32>,
  rayleighColor: vec3<f32>,
  mieColor: vec3<f32>,
) -> vec3<f32> {
  let cosAngle = dot(cameraToPositionDir, lightDirection);
  let cosAngleSq = cosAngle * cosAngle;

  // Phase normalization constants match the GLSL builtins
  // (3 / (16π) for Rayleigh, 3 / (8π) for the Mie HG variant).
  let rayleighPhase = 3.0 / (50.2654824574) * (1.0 + cosAngleSq);

  let G = camera.atmosphereParams.x;  // Mie anisotropy
  let GSq = G * G;
  let denom = pow(max(1.0 + GSq - 2.0 * cosAngle * G, 1e-6), 1.5) * (2.0 + GSq);
  let miePhase = 3.0 / (25.1327412287) *
    ((1.0 - GSq) * (cosAngleSq + 1.0)) / denom;

  let rayleigh = rayleighPhase * rayleighColor;
  let mie = miePhase * mieColor;
  return (rayleigh + mie) * camera.atmosphereLightDirectionAndIntensity.w;
}

fn processVertex(position: vec3<f32>, textureCoordinates: vec2<f32>,
                 encodedNormal: f32, webMercatorT: f32,
                 precomputedHeight: f32,
                 geodeticSurfaceNormal: vec3<f32>) -> VertexOutput {
  var out: VertexOutput;

  // Reconstruct full-precision center as f32 for uses that don't participate
  // in RTE (exaggeration calc, fragment passthrough). The SCENE3D branch
  // below consumes the split directly so it stays in the RTE domain.
  let center3D = camera.center3DHigh + camera.center3DLow;

  // Scene mode branching
  let mode = camera.sceneMode;

  // ── Vertical exaggeration ──
  // MORPH-EXAG-SKIRTS (Batch 362) — WebGL applies exaggeration in ALL scene
  // modes (GlobeVS.glsl:245-258): it exaggerates the vertex HEIGHT ATTRIBUTE
  // (`newHeight = (height − rel)*exag + rel`), offsets the 3D position along the
  // ellipsoid normal by `(newHeight − height)`, and feeds `newHeight` to the
  // planar `getPositionPlanarEarth` (which uses height as the projected X axis).
  // We mirror that exactly so SCENE3D, COLUMBUS_VIEW, and MORPHING all exaggerate
  // CONSISTENTLY — the previous code gated the position offset to `sceneMode >
  // 2.5` and fed the planar legs RAW height, so CV/morph terrain rendered flat
  // and a morph would have popped between an exaggerated 3D leg and a flat planar
  // leg. **Crux of the skirt fix:** exaggerate the ATTRIBUTE (`resolvedHeight`),
  // NOT `length(position3D) − radius`. Skirt vertices carry a REDUCED height
  // attribute (edgeHeight − skirtHeight, HeightmapTessellator.js:399), so the
  // (now-taller) skirt quad still points DOWN below the surface and stays
  // occluded by the adjacent tile exactly as in WebGL; the Batch-216 attempt
  // exaggerated the geometric `length()` height and shattered skirts into
  // visible vertical walls.
  let exaggeration = tile.verticalExaggeration;
  let exagRelativeHeight = tile.verticalExaggerationRelativeHeight;
  let fallbackEllipsoidR = select(
    EARTH_RADIUS_FALLBACK,
    camera.ellipsoidRadius,
    camera.ellipsoidRadius > 1.0,
  );

  // RAW (un-exaggerated) height attribute. Prefer the caller-supplied precomputed
  // height (exact when quantized decodes [minH,maxH], or when uncompressed
  // carries height in position.w); fall back to `length(rawPosition3D) − R` only
  // as a last resort (loses sub-meter precision at Earth radius). Computed from
  // the RAW position so exaggeration never feeds back into its own input.
  let rawPosition3D = position + center3D;
  let useProvidedHeight = precomputedHeight > HEIGHT_SENTINEL_UNAVAILABLE + 1.0;
  let resolvedHeight = select(
    length(rawPosition3D) - fallbackEllipsoidR,
    precomputedHeight,
    useProvidedHeight,
  );

  // Exaggerated height (WebGL `newHeight`), clamped to not pass through earth
  // center. `== resolvedHeight` when verticalExaggeration == 1.0 (byte-identical
  // to the pre-fix path). Consumed by the planar legs AND the 3D position offset.
  let exaggeratedHeight =
    (resolvedHeight - exagRelativeHeight) * exaggeration + exagRelativeHeight;
  let planarHeight = max(exaggeratedHeight, -fallbackEllipsoidR);

  // 3D position offset along the (geodetic, DP-H25) ellipsoid normal. Applied
  // whenever exaggeration is active — the SCENE3D leg and the MORPHING 3D
  // component both consume `exaggeratedPosition`; CV/2D don't use it for
  // out.position so the offset is harmless there.
  var exaggeratedPosition = position;
  if (exaggeration != 1.0) {
    // DP-H25 — prefer the true geodetic surface normal over the ellipsocentric
    // `normalize(rawPosition3D)` (they diverge up to 0.2° at mid-latitudes).
    // Callers with no geodetic normal pass vec3(0); dot(n,n) > 0.25 rules out
    // the zero vector AND non-unit debug noise without paying for a `length()`.
    let hasGeoNormal = dot(geodeticSurfaceNormal, geodeticSurfaceNormal) > 0.25;
    let ellipsoidNormal = select(
      normalize(rawPosition3D),
      geodeticSurfaceNormal,
      hasGeoNormal,
    );
    // WebGL `offset = ellipsoidNormal * (newHeight − height)` — attribute-based.
    // For non-skirt vertices this equals the prior `length()`-based offset (the
    // attribute IS the terrain height); skirts differ but are hidden in 3D, so
    // the SCENE3D look is unchanged.
    exaggeratedPosition =
      position + ellipsoidNormal * (planarHeight - resolvedHeight);
  }

  let position3DWC = exaggeratedPosition + center3D;

  if (mode < 0.5) {
    // ── MORPHING ── blend between 3D and 2D positions
    // Note: planar/3D positions are NOT relative-to-eye in this mode, so we
    // use modifiedModelViewProjection (matches WebGL czm_projection * modelView).
    let morphTime = camera.morphTime;
    let planar = computePlanarPosition(planarHeight, textureCoordinates);
    let position2DWC = vec4<f32>(planar, 1.0);
    let position3DWC4 = vec4<f32>(position3DWC, 1.0);
    // Manual lerp (not the builtin `mix`) — mirrors WebGL `czm_columbusViewMorph`
    // (columbusViewMorph.glsl), which deliberately avoids `mix` because on some
    // GPUs (NVidia 3070 Ti, Intel Arc A750) mix does not return exactly the
    // endpoint at morphTime 0/1, shimmering the settled globe. Exact at the
    // endpoints by construction. The unused `csm_columbusViewMorph.wgsl` chunk
    // holds the same formula for a future chunk-include refactor.
    let morphPos = vec4<f32>(
      position2DWC.xyz * (1.0 - morphTime) + position3DWC4.xyz * morphTime,
      1.0,
    );
    out.position = camera.modifiedModelViewProjection * morphPos;
    out.v_positionEC = (camera.modifiedModelView * morphPos).xyz;
  } else if (mode < 1.5) {
    // ── COLUMBUS_VIEW ── planar with terrain height
    let planarPos = computePlanarPosition(planarHeight, textureCoordinates);
    out.position = camera.modifiedModelViewProjection * vec4<f32>(planarPos, 1.0);
    out.v_positionEC = (camera.modifiedModelView * vec4<f32>(planarPos, 1.0)).xyz;
  } else if (mode < 2.5) {
    // ── SCENE2D ── top-down orthographic, height forced to 0
    let planarPos = computePlanarPosition(0.0, textureCoordinates);
    out.position = camera.modifiedModelViewProjection * vec4<f32>(planarPos, 1.0);
    out.v_positionEC = (camera.modifiedModelView * vec4<f32>(planarPos, 1.0)).xyz;
  } else {
    // ── SCENE3D ── RTC (Relative-To-Center) transform, mirroring WebGL
    // getPosition3DMode (GlobeVS.glsl:122-124) and the SCENE2D/COLUMBUS
    // branches above. The big Earth-radius center→eye offset is cancelled in
    // f64 ON THE CPU: vertices are encoded tile-local (encoding.center
    // pre-subtracted) and view*center is baked into the translation column of
    // camera.modifiedModelViewProjection (computeModifiedModelView in
    // WebGPUGlobeSurfaceCameraUB). The GPU does ONE f32 mat4×vec4 over the
    // tile-LOCAL (exaggerated) position — no multi-megameter f32 op survives.
    //
    // The previous in-shader RTE assembly built `(center3DHigh-encodedCameraHigh)
    // + (center3DLow + exaggeratedPosition - encodedCameraLow)` and fed it
    // through `mvpRelativeToEye`. That decomposition only holds when
    // `exaggeratedPosition` is tile-local-SMALL. On COARSE far-LOD tiles
    // (level 0-3) the tile-local corner reaches ~5e6 m, NOT the ~50 km the old
    // comment assumed: the big residual-term add swamped the sub-meter
    // center3DLow/encodedCameraLow residuals (f32 ULP ~0.5 m at 5e6 m), and the
    // ~5e6 m rtePosition then rounded inconsistently through the matrix — so
    // adjacent coarse far/limb tiles disagreed on shared-edge clip positions
    // and the mesh tore (radial wedge-gaps → a detached upper-hemisphere ring
    // at 35-50 Mm). The RTC matrix moves the cancellation to f64-on-CPU.
    // exaggeratedPosition == position when verticalExaggeration == 1.0.
    out.position =
      camera.modifiedModelViewProjection * vec4<f32>(exaggeratedPosition, 1.0);
    out.v_positionEC =
      (camera.modifiedModelView * vec4<f32>(exaggeratedPosition, 1.0)).xyz;
    // v_positionRTE retained for CSM cascade sampling / motion-vector consumers
    // (Principle 7 scaffolding); NOT used for out.position now.
    out.v_positionRTE =
      (camera.center3DHigh - camera.encodedCameraHigh) +
      (camera.center3DLow + exaggeratedPosition - camera.encodedCameraLow);
  }
  // 2D / Columbus / Morph fall through without touching v_positionRTE;
  // initialize it to zero so the shader stays deterministic. CSM is
  // SCENE3D-only so this never participates in cascade sampling there.
  if (mode < 2.5) {
    out.v_positionRTE = vec3<f32>(0.0);
  }

  out.v_distance = length(out.v_positionEC);
  out.v_textureCoordinates = vec3<f32>(textureCoordinates, webMercatorT);
  out.v_positionMC = position3DWC;

  //>>ifdef LOG_DEPTH
  // Renderer-wide log depth: interpolate the linear depthFromNearPlusOne and
  // clamp clip-z so the FS-written log depth isn't pre-empted by clipping.
  // Computed from out.position BEFORE the clamp (the clamp only touches .z;
  // depthFromNearPlusOne uses .w). near = camera.logDepth.x.
  out.v_logDepth = csm_vertexLogDepth(out.position, camera.logDepth.x);
  out.position = csm_updatePositionDepth(out.position);
  //>>endif

  // ─── Session 65 Batch 9: per-vertex ground atmosphere ray-march ───
  // Gated on `camera.atmosphereParams.w > 0.5` (set CPU-side when fog
  // OR ground atmosphere is enabled). Inside SCENE3D only — 2D /
  // Columbus / Morph use planar positions so the WC math doesn't apply.
  // When skipped, the v_atmosphere* outputs stay at zero so the FS
  // additive contribution evaluates to a no-op.
  out.v_atmosphereRayleighColor = vec3<f32>(0.0);
  out.v_atmosphereMieColor = vec3<f32>(0.0);
  out.v_atmosphereOpacity = 0.0;
  if (camera.atmosphereParams.w > 0.5 && mode > 2.5) {
    // Session 65 Batch 38 — proper ground-atmosphere integration.
    // `atmosphereParams.w` carries the lighting mode:
    //   1.0 → dynamic lighting OFF → substitute normalize(positionWC)
    //   2.0 → dynamic lighting ON  → use the packed light direction
    // Mirrors WebGL GlobeFS.glsl line 494:
    //   lightDirection = czm_branchFreeTernary(
    //       dynamicLighting, atmosphereLightDirection, normalize(positionWC));
    // Without this fallback the WGSL march was always tracing toward the
    // real sun direction, producing 7-10× more scattering on the dayside
    // than the WebGL no-dynamic-lighting reference and forcing the
    // empirical cap=1.5 × scale=0.15 in the FS drape branch (now removed).
    let dynamicLightingActive = camera.atmosphereParams.w > 1.5;
    let lightDir = select(
      normalize(position3DWC),
      camera.atmosphereLightDirectionAndIntensity.xyz,
      dynamicLightingActive,
    );
    let scattering = computeAtmosphereScatteringGround(position3DWC, lightDir);
    out.v_atmosphereRayleighColor = scattering.rayleigh;
    out.v_atmosphereMieColor = scattering.mie;
    out.v_atmosphereOpacity = scattering.opacity;
  }

  let normalMC = octDecode(encodedNormal);
  let nm = camera.modifiedModelView;
  out.v_normalEC = normalize(vec3<f32>(
    nm[0][0] * normalMC.x + nm[1][0] * normalMC.y + nm[2][0] * normalMC.z,
    nm[0][1] * normalMC.x + nm[1][1] * normalMC.y + nm[2][1] * normalMC.z,
    nm[0][2] * normalMC.x + nm[1][2] * normalMC.y + nm[2][2] * normalMC.z
  ));

  // ─── Cluster 3 — per-vertex slope/aspect/height for globe materials ───
  // Mirrors the WebGL GlobeVS `#ifdef APPLY_MATERIAL` block (lines
  // 272-285). Slope is the angle between the surface normal and the
  // ellipsoid normal; aspect is the heading of the surface normal
  // projected onto the local east/up plane; height is the terrain
  // elevation in meters above the ellipsoid surface. Materials like
  // ElevationRamp / SlopeRamp / AspectRamp / ElevationContour /
  // ElevationBand sample these via `materialInput.height` etc.
  let ellipsoidNormal = normalize(position3DWC);
  let northPoleZ = select(
    EARTH_RADIUS_FALLBACK,
    camera.ellipsoidRadius,
    camera.ellipsoidRadius > 1.0,
  );
  let northPolePositionMC = vec3<f32>(0.0, 0.0, northPoleZ);
  let vectorEastMC = normalize(cross(northPolePositionMC - position3DWC, ellipsoidNormal));
  let dotProd = abs(dot(ellipsoidNormal, normalMC));
  out.v_slope = acos(clamp(dotProd, -1.0, 1.0));
  let normalRejected = ellipsoidNormal * dotProd;
  let normalProjected = normalMC - normalRejected;
  let aspectVector = normalize(normalProjected);
  var aspectAng = acos(clamp(dot(aspectVector, vectorEastMC), -1.0, 1.0));
  let determ = dot(cross(vectorEastMC, aspectVector), ellipsoidNormal);
  let TWO_PI: f32 = 6.283185307179586;
  aspectAng = select(aspectAng, TWO_PI - aspectAng, determ < 0.0);
  out.v_aspect = aspectAng;
  out.v_height = resolvedHeight;

  // ── Far-plane clip-space Z clamp (CRITICAL for orbit altitude) ──
  // FP32 rounding in the SCENE3D clip transform can push a FRONT fragment's
  // clip-space z just over its w → NDC z > 1 → the rasterizer clips it as
  // "behind the far plane" → the globe shows radial wedge-gaps (the skybox
  // shows through). Clamping z ≤ w forces NDC z ≤ 1 so these borderline FRONT
  // fragments survive. Paired with `depthCompare: less-equal` so a fragment
  // landing exactly on the far plane still passes against the cleared depth.
  //
  // VERIFIED LOAD-BEARING (2026-06-22): removing this clamp AFTER the SCENE3D
  // RTC switch reintroduced the whole-globe wedge-gap tear at 12 Mm — so the
  // RTC change did NOT eliminate the spurious overflow and the clamp is still
  // required. (It also pins genuinely-far back-limb L0 fragments to z=1 at
  // extreme zoom-out, a contributor to the far-cam ring residual — but it is
  // NOT that residual's root cause: removing it leaves the ring while breaking
  // 12 Mm, so the ring is an L0-tile vertex PRECISION warp within the frustum,
  // tracked separately.)
  out.position.z = min(out.position.z, out.position.w);

  return out;
}

// ┌─────────────────────────────────────────────────────────────────────┐
// │ PAIR-SECTION: Vertex Shader entry points (WGSL) ↔ GLSL               │
// │   GLSL: Shaders/GlobeVS.glsl (single `void main()` with #ifdef       │
// │         variants for all terrain encodings)                          │
// │ Last lockstep audit: 2026-05-19, Batch 75                            │
// └─────────────────────────────────────────────────────────────────────┘
// Any change to these entry points MUST land with a matching change in
// the GLSL counterpart. See migration_doc/SHADER_PAIRS_LOCKSTEP.md.
//
// ARCHITECTURAL DIVERGENCE (largest in the globe shader pair)
//
// - WebGL `GlobeVS.glsl` is a SINGLE `void main()` (~286 lines) that
//   handles every terrain encoding via `#ifdef` preprocessor variants:
//     QUANTIZATION_BITS12 — quantized vertex format
//     INCLUDE_WEB_MERCATOR_Y — per-vertex Mercator-T
//     ENABLE_VERTEX_LIGHTING / GENERATE_POSITION_AND_NORMAL / APPLY_MATERIAL
//       — per-vertex normal
//     GEODETIC_SURFACE_NORMALS — separate normal attribute
//     EXAGGERATION — vertical-exaggeration uniform path
//     ENABLE_CLIPPING_POLYGONS — per-vertex polygon-clip extents
//     FOG / GROUND_ATMOSPHERE / UNDERGROUND_COLOR / TRANSLUCENT
//       — per-vertex atmosphere ray-march + distance varyings
//     2D modes (Mercator / Geographic / Planar / Columbus / Morphing)
//       — runtime-generated `getPosition` / `get2DYPositionFraction`
//   The WebGL pipeline cache compiles a different shader variant per-
//   tile based on the active defines.
//
// - WGSL has SIX explicit `@vertex` entry points, all routed through a
//   single `processVertex()` helper that contains the shared math:
//     vertexMain                       — uncompressed, no Mercator-T
//     vertexMainWebMerc                — uncompressed + Mercator-T
//     vertexMainWebMercNormals         — uncompressed + Mercator-T + normal
//     vertexMainQuantized              — BITS12, no Mercator-T
//     vertexMainQuantizedWebMerc       — BITS12 + Mercator-T
//     vertexMainQuantizedWebMercNormals — BITS12 + Mercator-T + normal
//   The pipeline cache selects the entry point based on terrain
//   encoding. Each entry decodes its specific vertex layout, then hands
//   off to `processVertex()` for the layout-agnostic math.
//
// - WGSL uses a CUSTOM `//>>ifdef FLAG_NAME / //>>else / //>>endif`
//   preprocessor implemented in `WebGPUShaderPreprocessor.ts` (Batch 23)
//   for define-bit-driven variants like `GEODETIC_NORMAL`. This is a
//   MUCH smaller surface than GLSL's full preprocessor — it only
//   handles boolean ifdefs against a uint32 `ShaderDefine` bitmask
//   registered in `WebGPUShaderDefines.ts`. Define bits are stable and
//   add-only (Batch 22 onward).
//
// WHY THE TWO BACKENDS SPLIT DIFFERENTLY
//
// - GLSL's preprocessor is rich enough to handle every variant inline,
//   AND the WebGL pipeline cache compiles a fresh shader per
//   define-set. Adding a new variant costs a few `#ifdef` lines and
//   the cache picks it up automatically.
// - WGSL doesn't have an equivalent preprocessor (the `//>>ifdef`
//   subset is intentionally limited). And WebGPU pipeline creation
//   wants a single shader module with multiple entry points. The
//   6-entry split makes vertex-attribute layout an entry-point
//   property, not a preprocessor result — which is a closer fit to
//   WGSL's typed `@location` model.
//
// SHARED VARYING CONTRACT
// Both backends produce the SAME `VertexOutput` / out-variables
// downstream of `main()` / `processVertex()`:
//   position (built-in clip-space)
//   v_textureCoordinates (vec3: u, v, webMercatorT)
//   v_positionEC, v_positionMC, v_normalEC, v_normalMC
//   v_distance (when fog / atmosphere / underground active)
//   v_atmosphereRayleighColor, v_atmosphereMieColor, v_atmosphereOpacity
//     (when fog + non-per-fragment ground-atmosphere — WGSL keeps the
//     varyings even when per-fragment atmosphere is the active path
//     per Batch 56's decision)
//   v_slope, v_aspect, v_height (when APPLY_MATERIAL active)
// The downstream FS / per-fragment math (covered by Phases 2.1-2.4
// pair-sections) consumes the same varyings on both backends, so the
// fragment-stage parity holds despite the VS architectural split.
//
// ─── Vertex Shader: Uncompressed Terrain ───
// Used when hasWebMercatorT=false. Normal (if present) is in .z component.
// When no normals, .z = 0 (default fill from float32x2 format).
// webMercatorT defaults to geographic V (textureCoordinates.y).
// DP-H25 — every entry point routes the geodetic normal into
// `processVertex` through the same conditional expression. When
// `GEODETIC_NORMAL` is active the real per-vertex attribute flows
// through; otherwise the `vec3<f32>(0.0)` sentinel engages the
// ellipsocentric fallback in the exaggeration branch. Keeping this
// dispatch conditional inline removes the 6 parallel `*_Geo` entry
// points that existed before Batch 20.

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  let tc = input.textureCoordAndEncodedNormals;
  // Uncompressed vertex carries the height directly in position.w.
  return processVertex(input.position3DAndHeight.xyz, tc.xy, tc.z, tc.y,
                       input.position3DAndHeight.w,
                       //>>ifdef GEODETIC_NORMAL
                       input.geodeticSurfaceNormal);
                       //>>else
                       vec3<f32>(0.0));
                       //>>endif
}

// ─── Vertex Shader: Uncompressed Terrain with WebMercatorT (no normals) ───
// Vertex data: [u, v, webMercatorT] — webMercatorT is in .z, no normal.
//
// Batch 61 — `sanitizeWebMercatorT` replaces NaN values produced by
// `HeightmapTessellator.js:325` for vertices exactly at ±90° latitude.
// `0.5 * log((1+sin(±π/2))/(1-sin(±π/2)))` is `±Infinity` in JS; the
// CPU formula then computes `±Infinity * (1 / mercatorHeight)` which is
// `NaN`. WebGL's GLSL silently propagates the NaN through the per-
// fragment `step()` mask (returning 1.0 in most drivers — non-spec
// behavior), so the imagery still renders. WGSL is stricter: NaN
// comparisons in `step()` return 0, which zeroes `texCoordsAlpha`,
// which zeroes `effectiveAlpha`, which makes the imagery composite
// contribute nothing — producing a black hole at the pole.
@vertex
fn vertexMainWebMerc(input: VertexInput) -> VertexOutput {
  let tc = input.textureCoordAndEncodedNormals;
  let safeWebMercT = sanitizeWebMercatorT(tc.z, tc.y);
  return processVertex(input.position3DAndHeight.xyz, tc.xy, 0.0, safeWebMercT,
                       input.position3DAndHeight.w,
                       //>>ifdef GEODETIC_NORMAL
                       input.geodeticSurfaceNormal);
                       //>>else
                       vec3<f32>(0.0));
                       //>>endif
}

// ─── Vertex Shader: Uncompressed Terrain with WebMercatorT + Normals ───
// Vertex data: [u, v, webMercatorT, encodedNormal] — normal in .w, webMercT in .z.
@vertex
fn vertexMainWebMercNormals(input: VertexInput) -> VertexOutput {
  let tc = input.textureCoordAndEncodedNormals;
  let safeWebMercT = sanitizeWebMercatorT(tc.z, tc.y);
  return processVertex(input.position3DAndHeight.xyz, tc.xy, tc.w, safeWebMercT,
                       input.position3DAndHeight.w,
                       //>>ifdef GEODETIC_NORMAL
                       input.geodeticSurfaceNormal);
                       //>>else
                       vec3<f32>(0.0));
                       //>>endif
}

// Decode the quantized-terrain normalized height (`zh.y` in [0, 1]) back
// into meters using the tile's per-encoding minMaxHeight range. Matches
// WebGL's `GlobeVS.glsl:135`: `height = height * (max - min) + min`.
fn decodeQuantizedHeight(normalizedHeight: f32) -> f32 {
  let minH = camera.minMaxHeight.x;
  let maxH = camera.minMaxHeight.y;
  return normalizedHeight * (maxH - minH) + minH;
}

// ─── Vertex Shader: Quantized Terrain (BITS12) ───
// No webMercatorT: compressed0.w = encodedNormal (or default 1.0 if no normals).
// webMercatorT defaults to geographic V.
@vertex
fn vertexMainQuantized(input: VertexInputQuantized) -> VertexOutput {
  let xy = decompressTextureCoordinates(input.compressed0.x);
  let zh = decompressTextureCoordinates(input.compressed0.y);
  let scaledPos = vec3<f32>(xy.x, xy.y, zh.x);
  let position = (camera.scaleAndBias * vec4<f32>(scaledPos, 1.0)).xyz;
  let uv = decompressTextureCoordinates(input.compressed0.z);
  return processVertex(position, uv, input.compressed0.w, uv.y,
                       decodeQuantizedHeight(zh.y),
                       //>>ifdef GEODETIC_NORMAL
                       input.geodeticSurfaceNormal);
                       //>>else
                       vec3<f32>(0.0));
                       //>>endif
}

// ─── Vertex Shader: Quantized Terrain with WebMercatorT (no normals) ───
// When hasWebMercatorT=true but hasNormals=false, compressed0.w stores the
// COMPRESSED webMercatorT. No normal available \u2014 use a hardcoded up vector.
@vertex
fn vertexMainQuantizedWebMerc(input: VertexInputQuantized) -> VertexOutput {
  let xy = decompressTextureCoordinates(input.compressed0.x);
  let zh = decompressTextureCoordinates(input.compressed0.y);
  let scaledPos = vec3<f32>(xy.x, xy.y, zh.x);
  let position = (camera.scaleAndBias * vec4<f32>(scaledPos, 1.0)).xyz;
  let uv = decompressTextureCoordinates(input.compressed0.z);
  let webMercT = decompressTextureCoordinates(input.compressed0.w).x;
  let safeWebMercT = sanitizeWebMercatorT(webMercT, uv.y);
  // 32896.0 = oct-encoded (0,0,1) up vector \u2014 prevents back-face culling
  return processVertex(position, uv, 32896.0, safeWebMercT,
                       decodeQuantizedHeight(zh.y),
                       //>>ifdef GEODETIC_NORMAL
                       input.geodeticSurfaceNormal);
                       //>>else
                       vec3<f32>(0.0));
                       //>>endif
}

// ─── Vertex Shader: Quantized Terrain with WebMercatorT AND Normals ───
// Both present: compressed0.w = compressed webMercatorT; oct-encoded normal
// lives in a separate single-float attribute at location 1 (compressed1).
// This is the common production configuration for Cesium ion + Bing: this
// case previously hardcoded normal=32896.0 which flat-shaded the terrain
// (wrong Lambert, wrong terminator, wrong water mask illumination).
@vertex
fn vertexMainQuantizedWebMercNormals(
  input: VertexInputQuantizedWebMercNormals,
) -> VertexOutput {
  let xy = decompressTextureCoordinates(input.compressed0.x);
  let zh = decompressTextureCoordinates(input.compressed0.y);
  let scaledPos = vec3<f32>(xy.x, xy.y, zh.x);
  let position = (camera.scaleAndBias * vec4<f32>(scaledPos, 1.0)).xyz;
  let uv = decompressTextureCoordinates(input.compressed0.z);
  let webMercT = decompressTextureCoordinates(input.compressed0.w).x;
  let safeWebMercT = sanitizeWebMercatorT(webMercT, uv.y);
  return processVertex(position, uv, input.compressed1, safeWebMercT,
                       decodeQuantizedHeight(zh.y),
                       //>>ifdef GEODETIC_NORMAL
                       input.geodeticSurfaceNormal);
                       //>>else
                       vec3<f32>(0.0));
                       //>>endif
}

// ═══════════════════════════════════════════════════════════════════════
// Fragment shader helpers
// ═══════════════════════════════════════════════════════════════════════

// ─── Imagery sampling with translation/scale ───
// baseUV: the per-layer UV (geographic or webMercator, selected by caller)
// Note: WebGL does NOT clamp to texCoordsRect — the sampler's clamp-to-edge
// mode handles out-of-range values. texCoordsRect is for alpha edge blending
// (not UV clamping). Previous code incorrectly clamped here, causing vertical
// stripes when texCoordsRect didn't cover the full [0,1] range.
fn sampleImagery(tex: texture_2d<f32>, samp: sampler,
                 baseUV: vec2<f32>, layer: ImageryLayer,
                 baseUV_dx: vec2<f32>, baseUV_dy: vec2<f32>) -> vec4<f32> {
  let uv = baseUV * layer.translationAndScale.zw + layer.translationAndScale.xy;
  // Batch 57 — textureSampleGrad uses the caller-provided per-fragment UV
  // derivatives to pick the correct mip level. Required because this
  // function is called after non-uniform discard/return (clipping planes),
  // and `textureSample` rejects that, while `textureSampleLevel(uv, 0.0)`
  // (the previous formulation) hard-locks the sampler to mip 0 — bypassing
  // the mipmap chain entirely. The latter produced ~4× brightness drop at
  // orbital altitudes where one fragment covers many texels and the
  // alias pattern under-samples bright pixels.
  //
  // Derivatives are pre-computed at fragmentMain entry (uniform CF) and
  // scaled by the per-layer `translationAndScale.zw` so each layer's
  // gradient matches its own sampling rate.
  let uv_dx = baseUV_dx * layer.translationAndScale.zw;
  let uv_dy = baseUV_dy * layer.translationAndScale.zw;
  return textureSampleGrad(tex, samp, uv, uv_dx, uv_dy);
}

// Select the correct V coordinate per layer based on useWebMercatorT flag
fn selectLayerUV(geoUV: vec2<f32>, webMercT: f32, useWebMerc: f32) -> vec2<f32> {
  let v = select(geoUV.y, webMercT, useWebMerc > 0.5);
  return vec2<f32>(geoUV.x, v);
}

// Batch 57 — pick the derivative pair matching the layer's UV space.
// Geographic-sampled layers use the `geoUV` derivative; webMercator-
// sampled layers use the `webMercUV` derivative (their V is the
// per-vertex webMercatorT, not geoUV.y, so the derivative differs).
fn selectLayerUVDerivative(
  geoDeriv: vec2<f32>,
  webMercDeriv: vec2<f32>,
  useWebMerc: f32,
) -> vec2<f32> {
  return select(geoDeriv, webMercDeriv, useWebMerc > 0.5);
}

// Compute texCoordsRect alpha mask — matches WebGL sampleAndBlend behavior.
// Returns 0.0 if tileUV is outside the texCoordsRect, 1.0 if inside.
// tileUV: the per-layer UV (geographic or webMercator) BEFORE translationAndScale.
// rect: texCoordsRect (x=west, y=south, z=east, w=north)
fn texCoordsAlpha(tileUV: vec2<f32>, rect: vec4<f32>) -> f32 {
  let inMin = step(rect.xy, tileUV);
  let inMax = step(vec2<f32>(0.0), rect.zw - tileUV);
  return inMin.x * inMin.y * inMax.x * inMax.y;
}

fn adjustColor(color: vec3<f32>, brightness: f32, contrast: f32, saturation: f32) -> vec3<f32> {
  var c = color * brightness;
  c = (c - 0.5) * contrast + 0.5;
  let gray = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
  c = mix(vec3<f32>(gray), c, saturation);
  return clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
}

// Batch 58 — per-layer hue rotation in YIQ space. Mirrors `czm_hue` from
// the WebGL builtin functions (`Source/Shaders/Builtin/Functions/hue.glsl`)
// — same matrices, same atan2 + chroma decomposition. `adjustment` is in
// radians; 0 returns the input unchanged.
fn applyHueShift(rgb: vec3<f32>, adjustment: f32) -> vec3<f32> {
  let toYIQ = mat3x3<f32>(
    vec3<f32>(0.299,    0.595716,  0.211456),
    vec3<f32>(0.587,   -0.274453, -0.522591),
    vec3<f32>(0.114,   -0.321263,  0.311135),
  );
  let toRGB = mat3x3<f32>(
    vec3<f32>(1.0,  1.0,    1.0),
    vec3<f32>(0.9563, -0.2721, -1.107),
    vec3<f32>(0.6210, -0.6474,  1.7046),
  );
  let yiq = toYIQ * rgb;
  let h = atan2(yiq.z, yiq.y) + adjustment;
  let chroma = sqrt(yiq.z * yiq.z + yiq.y * yiq.y);
  let outYIQ = vec3<f32>(yiq.x, chroma * cos(h), chroma * sin(h));
  return toRGB * outYIQ;
}

// Batch 58 — color-to-alpha keying. Matches WebGL GlobeFS.glsl:
//   colorDiff = abs(color.rgb - colorToAlpha.rgb);
//   colorDiff.r = max-component(colorDiff);
//   alpha = (colorDiff.r < threshold) ? 0 : alpha
// `colorToAlpha.a` carries the threshold; threshold < 0 (CPU-side default)
// disables the effect cleanly (no negative threshold can mask anything since
// `colorDiff.r >= 0`).
fn applyColorToAlphaKey(texColor: vec4<f32>, colorToAlpha: vec4<f32>) -> f32 {
  let diff = abs(texColor.rgb - colorToAlpha.rgb);
  let maxComp = max(diff.r, max(diff.g, diff.b));
  return select(texColor.a, 0.0, maxComp < colorToAlpha.a);
}

// Batch 58 — cutout rectangle test in tile-UV space. Returns 1.0 (keep) when
// the texel is OUTSIDE the cutout rectangle, 0.0 (drop) when inside.
// Disabled (returns 1.0) when the rectangle has zero area — matches the WebGL
// CPU-side default of `Cartesian4.ZERO` for unset cutouts.
fn applyCutoutMask(tileUV: vec2<f32>, cutout: vec4<f32>) -> f32 {
  let hasCutout = (cutout.z - cutout.x) > 0.0 && (cutout.w - cutout.y) > 0.0;
  let inside = tileUV.x >= cutout.x && tileUV.x <= cutout.z &&
               tileUV.y >= cutout.y && tileUV.y <= cutout.w;
  return select(1.0, 0.0, hasCutout && inside);
}

// Batch 58 — split-direction screen-space mask. Mirrors WebGL GlobeFS.glsl:
//   if (split < 0 && fragX > splitPos) alpha = 0;
//   else if (split > 0 && fragX < splitPos) alpha = 0;
// Both `fragX` and `splitPositionPx` are framebuffer pixel coords. The CPU
// packer writes `frameState.splitPosition * drawingBufferWidth` into
// `tile.splitPosition` so it matches `@builtin(position).x` (gl_FragCoord).
fn applySplitMask(splitDir: f32, fragX: f32, splitPositionPx: f32) -> f32 {
  // splitDir == 0 → no split, always show.
  if (splitDir == 0.0) {
    return 1.0;
  }
  // splitDir < 0 (LEFT): keep when fragX <= splitPositionPx.
  // splitDir > 0 (RIGHT): keep when fragX >= splitPositionPx.
  if (splitDir < 0.0) {
    return select(0.0, 1.0, fragX <= splitPositionPx);
  }
  return select(0.0, 1.0, fragX >= splitPositionPx);
}

// Batch 58 — composite ONE imagery layer onto the running color/alpha pair.
// Effect application order matches WebGL `sampleAndBlend` in GlobeFS.glsl:
//   1. colorToAlpha          (key-color → alpha=0)
//   2. gamma                 (color = pow(color, 1/gamma))
//   3. split                 (alpha=0 outside the active half)
//   4. cutout                (alpha=0 inside cutout rectangle — applied as
//                             an alpha mask here vs WebGL's branchFreeTernary
//                             at the call site; effect is identical)
//   5. brightness → contrast → hue → saturation (WebGL sequence)
// Returns updated (color, alpha) and the post-effects "adjusted" color so
// callers can route it through `applyNightLightsEmission` for emission.
struct LayerComposite {
  color: vec3<f32>,
  alpha: f32,
  adjustedColor: vec3<f32>,  // post-effects, used for night-lights emission
};

// ┌─────────────────────────────────────────────────────────────────────┐
// │ PAIR-SECTION: applyImageryLayer (WGSL) ↔ sampleAndBlend (GLSL)       │
// │   GLSL: Shaders/GlobeFS.glsl::sampleAndBlend (lines 188-334)         │
// │ Last lockstep audit: 2026-05-20, Batch 79                            │
// └─────────────────────────────────────────────────────────────────────┘
// Any change to this function MUST land with a matching change in the
// GLSL counterpart. See migration_doc/SHADER_PAIRS_LOCKSTEP.md.
//
// STRUCTURAL DIVERGENCE (documented, not fixable in shader)
// - GLSL samples the imagery texture INSIDE the function via
//   `texture(textureToSample, ...)`. WGSL receives the pre-sampled
//   `texSample` as a parameter because WGSL cannot dynamically index a
//   texture array inside a function — the 16 imagery slots must be
//   unrolled at the call site in `fragmentMain`. Effect is identical.
// - GLSL returns `vec4(outColor, outAlpha)`. WGSL returns a struct
//   `LayerComposite { color, alpha, adjustedColor }` because the
//   downstream night-lights emission path needs the post-effects color
//   separately. The GLSL backend handles night-lights via a different
//   code path.
// - GLSL gates brightness/contrast/hue/saturation behind `#ifdef
//   APPLY_*` defines emitted by the pipeline cache based on
//   per-layer-property usage. WGSL evaluates them all unconditionally
//   (with a near-1.0 fast-path skip for hue and gamma), because WGSL
//   has no `#ifdef` preprocessor and the pipeline cache is keyed on
//   bitmask `ShaderDefine` values that don't currently include the
//   per-effect gates. Net result: WGSL pays a few extra ops per
//   fragment on average; visible output is identical when the
//   per-layer property is at the default value.
//
// BLEND FORMULA (matched across backends since Batch 79)
// Both backends use the premultiplied-alpha OVER composite:
//   sourceAlpha = effectiveAlpha
//   outAlpha    = mix(prevAlpha, 1, sourceAlpha)
//   outColor    = mix(prevColor * prevAlpha, color, sourceAlpha) / outAlpha
//
// Pre-Batch-79 the WGSL used a straight `mix(prev, color, srcA)` +
// `max(prevA, srcA)` formula. That was algebraically identical to the
// OVER composite when `prevAlpha = 1` (Batch 69 proved this pixel-
// equivalent at the default midlat-mid view), but diverged on
// multi-frustum subsequent passes where the first imagery layer hits
// with `prevAlpha = 0` and `srcA < 1`. Under straight-mix the first
// contribution was attenuated by srcA; under OVER it contributes at
// full brightness with `outAlpha = srcA`. Batch 68 attempted this
// switch and saw an apparent 1.09 → 7.01% regression that turned out
// to be probe-level clock-noise (Batch 69). With clock pinning landed
// in Batch 70 the regression test is now reliable, so the switch is
// applied here.
//
// Divide-by-zero handling differs: GLSL uses a `sign()` sentinel trick
// (L311); WGSL clamps the divisor to a tiny epsilon. End behavior is
// the same — when `outAlpha = 0` the divided color is unobservable
// (multiplied by 0 in any downstream blend), and the returned alpha
// is clamped to 0 via `max(outAlpha, 0.0)`.
//
// Two bounds coordinates, matching WebGL's `sampleAndBlend`:
//
// `texCoordsBoundsUV` is the per-layer SELECTED V (`selectLayerUV` output):
// Mercator-V (`webMercatorT`) for `useWebMercatorT=true` layers, geographic
// geoUV otherwise. It tests the `texCoordsRect` alpha mask AND is the SAME V
// the texture sample uses — WebGL passes a single `tileTextureCoordinates`
// (`useWebMercatorT ? .xz : .xy`, `GlobeSurfaceShaderSet.js:352`) to BOTH the
// `step()` rect test (`GlobeFS.glsl:250,253`) and the sample (`:262`). The
// cached `texCoordsRect` is Mercator-V for `useWebMercatorT=true` (the CPU
// packer converts the rectangles to native/Mercator in-place before taking
// the minV/maxV fraction — `ImageryLayerHelpers.js:229-247,343-347`), so the
// test V MUST be the selected (Mercator) V, not geographic.
//
// `boundsUV` is the GEOGRAPHIC geoUV, used ONLY for the `cutoutRectangle`
// test (the cutout packer in `WebGPUGlobeSurfaceTileUB.ts` divides by
// `tile.rectangle.height` — a geographic latitude span).
//
// HISTORY: Session 65 Batch 8 fed geoUV (geographic-V) to the texCoordsRect
// test to fix "dark blue at close zoom." That was correct ONLY under the then
// single-texture model (one geographic reprojected texture, but
// `useWebMercatorT` still true → Mercator-V test vs a geographic-bound rect
// zeroed the mask → imagery-base fallback = the dark blue). Batch 65's
// dual-texture model superseded it: the rect now tracks the bound texture's
// space, so the correct test V is the per-layer selected V (= the sample V),
// NOT a global geographic-V. For `useWebMercatorT=false` layers `selectLayerUV`
// returns geoUV, so this is byte-identical to Batch-8 on the polar/reprojected
// tiles that were the dark-blue victims — dark-blue cannot return. See
// migration_doc/IMAGERY_PROJECTION.md "Imagery alpha-mask V-space".
fn applyImageryLayer(
  prevColor: vec3<f32>,
  prevAlpha: f32,
  texSample: vec4<f32>,
  boundsUV: vec2<f32>,
  texCoordsBoundsUV: vec2<f32>,
  layer: ImageryLayer,
  layerMask: f32,
  fragX: f32,
  splitPositionPx: f32,
  dayNightAlpha: vec2<f32>,
  dayFade: f32,
) -> LayerComposite {
  // texCoordsRect bounds mask. GLSL: vec2 `step()` × textureAlpha at
  // lines 213-217 of sampleAndBlend. The mask is 0 outside the per-
  // layer rectangle, 1 inside.
  let texCoordsMask = texCoordsAlpha(texCoordsBoundsUV, layer.texCoordsRect);

  // Day/night alpha. GLSL gates this on `APPLY_DAY_NIGHT_ALPHA &&
  // ENABLE_DAYNIGHT_SHADING` defines (line 219-221). WGSL evaluates
  // unconditionally; CPU-side packer writes (1, 1) when day/night
  // alpha isn't enabled per layer, making the mix a no-op (always 1.0).
  let dayNightAlphaValue = mix(dayNightAlpha.y, dayNightAlpha.x, dayFade);

  // colorToAlpha key. GLSL line 230-234: `#ifdef APPLY_COLOR_TO_ALPHA`
  // zeros alpha where (R, G, B) ≈ key color. WGSL evaluates unconditionally
  // with a runtime sentinel (`colorToAlpha.a < 0` means disabled).
  var sampleAlpha = texSample.a;
  if (layer.colorToAlpha.a >= 0.0) {
    sampleAlpha = applyColorToAlphaKey(texSample, layer.colorToAlpha);
  }

  // Gamma correction. GLSL line 236-242: `#if !defined(APPLY_GAMMA)` →
  // `czm_gammaCorrect` (which is a no-op when HDR is off, otherwise a
  // pow(czm_gamma) — typically 2.2). `#else` → `pow(color, oneOverGamma)`
  // when per-layer gamma is set. WGSL gates on `abs(oneOverGamma - 1.0)
  // > 0.0001` to skip the pow when at default. NOTE: WGSL currently
  // does NOT apply czm_gammaCorrect when HDR is on; this is a known
  // gap to be addressed when the HDR pipeline is finalized.
  var color = texSample.rgb;
  if (abs(layer.oneOverGamma - 1.0) > 0.0001) {
    color = pow(max(color, vec3<f32>(0.0)), vec3<f32>(layer.oneOverGamma));
  }

  // Split mask. GLSL line 244-254: `#ifdef APPLY_SPLIT` zeros alpha on
  // the wrong half of the screen. WGSL evaluates unconditionally with
  // a layer.split sentinel (0 means disabled).
  let splitMask = applySplitMask(layer.split, fragX, splitPositionPx);

  // Cutout mask. GLSL handles cutout at the call site in `computeDayColor`
  // (which is runtime-generated by the WebGL pipeline-cache for the
  // active layer count). WGSL handles it here as part of the
  // effectiveAlpha product because the per-tile cutoutRectangle is
  // packed into the per-layer UBO struct.
  let cutoutMask = applyCutoutMask(boundsUV, layer.cutoutRectangle);

  // Per-layer effects chain: brightness → contrast → hue → saturation.
  // Matches GLSL ordering at lines 256-270 (where each is guarded by an
  // APPLY_* define). WGSL evaluates all four unconditionally; defaults
  // (brightness=1, contrast=1, hue=0, saturation=1) make each a no-op.
  var adjusted = color * layer.brightness;
  adjusted = (adjusted - 0.5) * layer.contrast + 0.5;
  if (abs(layer.hue) > 0.0001) {
    adjusted = applyHueShift(adjusted, layer.hue);
  }
  let gray = dot(adjusted, vec3<f32>(0.2126, 0.7152, 0.0722));
  adjusted = mix(vec3<f32>(gray), adjusted, layer.saturation);
  adjusted = clamp(adjusted, vec3<f32>(0.0), vec3<f32>(1.0));

  // Effective alpha — product of all per-layer masks. GLSL: each mask
  // is multiplied into `textureAlpha` separately; same arithmetic.
  let effectiveAlpha = layerMask
                       * layer.alpha
                       * sampleAlpha
                       * texCoordsMask
                       * dayNightAlphaValue
                       * splitMask
                       * cutoutMask;

  // Batch 79 — premultiplied-alpha OVER composite, matching WebGL
  // GlobeFS.glsl::sampleAndBlend L309-313. The previous straight-mix
  // formula was algebraically identical when `prevAlpha = 1` (the
  // dominant case, verified pixel-equivalent in Batch 69), but diverged
  // on multi-frustum subsequent passes where `prevAlpha = 0` and the
  // first layer's `effectiveAlpha < 1`. Under straight-mix the first
  // contribution gets attenuated by `effectiveAlpha`; under OVER it
  // contributes at full brightness with `outAlpha = effectiveAlpha`.
  //
  // Formula:
  //   sourceAlpha = effectiveAlpha
  //   outAlpha    = mix(prevAlpha, 1, sourceAlpha)
  //              = prevAlpha + (1 - prevAlpha) * sourceAlpha
  //   outColor    = mix(prevColor * prevAlpha, adjusted, sourceAlpha)
  //                / outAlpha
  //
  // Verification (prevAlpha = 1, no-op case):
  //   outAlpha = mix(1, 1, sourceAlpha) = 1
  //   outColor = mix(prevColor * 1, adjusted, sourceAlpha) / 1
  //            = mix(prevColor, adjusted, effectiveAlpha)
  //   → identical to the prior WGSL straight-mix output.
  //
  // Verification (prevAlpha = 0, subsequent-pass first layer):
  //   outAlpha = mix(0, 1, sourceAlpha) = sourceAlpha
  //   outColor = mix(0, adjusted, sourceAlpha) / sourceAlpha
  //            = adjusted   (when sourceAlpha > 0)
  //   → matches GLSL; the prior WGSL straight-mix would have returned
  //     `adjusted * sourceAlpha`, attenuating the first layer.
  //
  // Divide-by-zero handling: WebGL uses a `sign()` sentinel trick
  // (GlobeFS.glsl L311). WGSL just clamps the divisor to a tiny epsilon
  // — when outAlpha is genuinely zero, the resulting color is
  // multiplied by 0 (or skipped entirely) in any downstream blend stage,
  // so the divided value is unobservable. The returned alpha is still
  // clamped to 0 via `max(outAlpha, 0.0)` to handle floating-point
  // underflow into negative.
  let sourceAlpha = effectiveAlpha;
  let outAlpha = mix(prevAlpha, 1.0, sourceAlpha);
  let outAlphaSafe = max(outAlpha, 1e-7);
  let outColor = mix(prevColor * prevAlpha, adjusted, sourceAlpha) / outAlphaSafe;

  return LayerComposite(outColor, max(outAlpha, 0.0), adjusted);
}

// ─── Perceptual luminance ───
fn luminance(color: vec3<f32>) -> f32 {
  return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// ─── Batch 437 (CLOUD-SHADOWS): sample the sun-view beer shadow map ───
// Projects the fragment's WORLD (ECEF) position into the sun's ortho clip space,
// reads the cloud OPTICAL DEPTH column (the cloud thickness between the fragment and
// the sun), and returns a transmittance multiplier `mix(1, exp(-depth·absorption),
// strength)` in [0,1]. Returns 1.0 (no shadow) when: the feature is off
// (`cloudShadowControl.x <= 0.5`), or the fragment projects outside the shadow map
// footprint (far terrain) — soft local effect, no hard cutoff. The off path never
// calls this (the call site gates on `cloudShadowControl.x > 0.5`), so the 1×1 zero
// placeholder is never read in the default render.
fn sampleCloudGroundShadow(worldPos: vec3<f32>) -> f32 {
  let clip = camera.cloudShadowVP * vec4<f32>(worldPos, 1.0);
  // Ortho VP → w is 1, but guard anyway.
  let ndc = clip.xyz / max(abs(clip.w), 1e-6);
  let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return 1.0; // outside the footprint — no shadow
  }
  let opticalDepth = textureSampleLevel(cloudShadowMap, cloudShadowSampler, uv, 0.0).r;
  let absorption = camera.cloudShadowControl.y;
  let strength = camera.cloudShadowControl.z;
  // Beer-Lambert transmittance, floored so even a fully overcast column reads as a
  // realistic shadow (~0.35) rather than pure black — real cloud shadows still let
  // ambient/skylight through. `strength` scales the darkening 0..1.
  let transmittance = max(exp(-opticalDepth * absorption), 0.35);
  return mix(1.0, transmittance, clamp(strength, 0.0, 1.0));
}

// ═══════════════════════════════════════════════════════════════════════
// Enhanced Day/Night Rendering
// ═══════════════════════════════════════════════════════════════════════

// Matches the GLSL path: czm_getLambertDiffuse * 5.0 gives a sharp
// terminator. The 0.3 minimum keeps the night side from going pitch black
// without city light imagery. The result is a 0..1 day factor.
fn computeDayNightFade(normalEC: vec3<f32>, sunDirEC: vec3<f32>) -> f32 {
  let NdotL = dot(normalEC, sunDirEC);
  return clamp(NdotL * 5.0 + 0.5, 0.0, 1.0);
}

// Compute the terminator glow — warm orange/pink color right at the
// day-night boundary, simulating atmospheric scattering at the terminator.
fn computeTerminatorGlow(normalEC: vec3<f32>, sunDirEC: vec3<f32>) -> vec3<f32> {
  let NdotL = dot(normalEC, sunDirEC);
  // Peak at the terminator (NdotL ≈ 0), fading on both sides
  let terminatorFactor = exp(-NdotL * NdotL * 40.0);
  // Warm sunset color
  let warmColor = vec3<f32>(0.95, 0.45, 0.15);
  return warmColor * terminatorFactor * 0.15;
}

// Apply emissive night lights: when a layer has nightAlpha > dayAlpha,
// the night-side imagery is treated as emissive (city lights). The
// brightness is boosted proportional to the luminance of the texel.
fn applyNightLightsEmission(
  color: vec3<f32>,
  layerColor: vec3<f32>,
  nightBlend: f32,   // 0 = day, 1 = full night
  nightAlpha: f32,
  dayAlpha: f32,
) -> vec3<f32> {
  // Only apply emission when nightAlpha exceeds dayAlpha (night lights layer)
  let isNightLayer = step(dayAlpha + 0.01, nightAlpha);
  let lum = luminance(layerColor);
  let nightIntensity = getNightIntensity();
  // Emissive boost: brighten city lights on the night side
  // Higher luminance = stronger glow (city cores glow more)
  let emission = layerColor * lum * nightBlend * nightIntensity * isNightLayer;
  return color + emission;
}

// ═══════════════════════════════════════════════════════════════════════
// Enhanced Ocean/Water Rendering
// ═══════════════════════════════════════════════════════════════════════

// Fresnel-Schlick approximation: water reflects more at grazing angles
fn fresnelSchlick(cosTheta: f32, F0: f32) -> f32 {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), getFresnelPower());
}

// GGX/Trowbridge-Reitz normal distribution for physically-based specular
fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let NdotH2 = NdotH * NdotH;
  let denom = NdotH2 * (a2 - 1.0) + 1.0;
  return a2 / (PI * denom * denom + 0.0001);
}

// Batch 79 — east-north-up to eye-coordinates rotation matrix.
// Port of WebGL's `czm_eastNorthUpToEyeCoordinates`
// (Builtin/Functions/eastNorthUpToEyeCoordinates.glsl). Builds a 3×3
// rotation that takes a tangent-space (east, north, up) vector to
// eye-space, where the local up is the ellipsoid surface normal.
// Used by `computeEnhancedOcean` to transform multi-octave wave
// normals from tangent space into eye space before perturbing the
// surface normal — pre-Batch-79 the WGSL was adding a tangent-space
// vector directly to an eye-space normal, which produced waves that
// "follow the camera" instead of being anchored to the surface
// (visible as a subtle mesh-pattern artifact on close-zoom water).
//
// `positionMC` is the world-space position (which equals model-space
// for the globe since the model matrix is identity). The east tangent
// in model space is `(-positionMC.y, positionMC.x, 0)` — the
// z-axis cross product with the radial direction.
fn eastNorthUpToEyeCoordinates(
  positionMC: vec3<f32>,
  normalEC: vec3<f32>,
) -> mat3x3<f32> {
  let tangentMC = normalize(vec3<f32>(-positionMC.y, positionMC.x, 0.0));
  // Transform the MC tangent through the view 3×3 (upper-left of
  // `modifiedModelView`) — same upper-3×3 the WGSL VS uses to compute
  // `v_normalEC` from `normalMC` at line 1158-1162. This matches
  // WebGL's `czm_normal3D × tangentMC` (czm_normal3D is the inverse-
  // transpose of the view 3×3; for the globe the view matrix is a
  // pure rotation+translation so its 3×3 IS its own inverse-transpose).
  let nm = camera.modifiedModelView;
  let tangentEC = normalize(vec3<f32>(
    nm[0][0] * tangentMC.x + nm[1][0] * tangentMC.y + nm[2][0] * tangentMC.z,
    nm[0][1] * tangentMC.x + nm[1][1] * tangentMC.y + nm[2][1] * tangentMC.z,
    nm[0][2] * tangentMC.x + nm[1][2] * tangentMC.y + nm[2][2] * tangentMC.z,
  ));
  let bitangentEC = normalize(cross(normalEC, tangentEC));
  return mat3x3<f32>(tangentEC, bitangentEC, normalEC);
}

// Sample ocean wave normals with 3 octaves for detail at multiple scales
fn sampleOceanWaveNormals(uv: vec2<f32>, t: f32) -> vec3<f32> {
  // Large slow-moving swells
  let waveUV1 = uv * 400.0 + vec2<f32>(t * 0.012, t * 0.008);
  let n1 = textureSampleLevel(oceanNormalMap, oceanNormalSampler, waveUV1, 0.0).xyz * 2.0 - 1.0;

  // Medium waves
  let waveUV2 = uv * 200.0 + vec2<f32>(-t * 0.008, t * 0.018);
  let n2 = textureSampleLevel(oceanNormalMap, oceanNormalSampler, waveUV2, 0.0).xyz * 2.0 - 1.0;

  // Small wind ripples (higher frequency, faster)
  let waveUV3 = uv * 800.0 + vec2<f32>(t * 0.03, -t * 0.012);
  let n3 = textureSampleLevel(oceanNormalMap, oceanNormalSampler, waveUV3, 0.0).xyz * 2.0 - 1.0;

  // Blend: large swells dominate, small ripples add detail
  return normalize(n1 * 0.6 + n2 * 0.3 + n3 * 0.1);
}

// Compute foam factor: whitecaps appear where wave normals are steep
fn computeFoam(waveNormal: vec3<f32>, distFromCamera: f32) -> f32 {
  // Wave steepness as deviation from straight-up
  let steepness = 1.0 - abs(waveNormal.z);
  let threshold = getFoamThreshold();
  let foamFactor = smoothstep(threshold, threshold + 0.2, steepness);
  // Fade foam at distance (not visible far away)
  let distFade = 1.0 - smoothstep(50000.0, 200000.0, distFromCamera);
  return foamFactor * distFade * 0.7;
}

// Compute subsurface scattering approximation for ocean water.
// Light passing through waves creates a bright turquoise rim.
fn computeSubsurfaceScattering(
  viewDir: vec3<f32>,
  sunDir: vec3<f32>,
  normalEC: vec3<f32>,
) -> vec3<f32> {
  // Forward-scattering: light through waves toward viewer
  let VdotL = max(dot(viewDir, -sunDir), 0.0);
  let scatter = pow(VdotL, 4.0) * 0.15;
  // Bright turquoise subsurface color
  let sssColor = vec3<f32>(0.05, 0.25, 0.35);
  // Stronger at grazing angles where light passes through wave crests
  let rimFactor = 1.0 - max(dot(viewDir, normalEC), 0.0);
  return sssColor * scatter * rimFactor;
}

// Full enhanced ocean rendering pipeline
// Batch 58 — rewritten to match WebGL `computeWaterColor` semantics.
// WebGL's pattern is `color = imageryColor + diffuseHighlight + ... + specular`
// — imagery is PRESERVED and highlights are added. The previous WGSL
// formulation `mix(baseColor * darkening, deepColor, 0.6)` REPLACED
// imagery with a deep-color blend, dimming Bing aerial ocean by ~5×
// at every ocean fragment and dominating the WebGPU/WebGL brightness
// gap. See `migration_doc/WEBGPU_DEBUGGING_LOG.md` Batch 58.
//
// The new path:
//   1. Sample wave normals (only at low altitude with ocean waves enabled)
//   2. Compute diffuse + specular highlights from the active scene light
//   3. Add highlights to the imagery base color (no replacement)
//   4. Smooth coast transition by water-mask alpha
//
// At orbit / no-waves / no-lighting we contribute essentially nothing
// — same as WebGL with default settings.
fn computeEnhancedOcean(
  baseColor: vec3<f32>,
  positionEC: vec3<f32>,
  positionMC: vec3<f32>,
  normalEC: vec3<f32>,
  sunDirEC: vec3<f32>,
  uv: vec2<f32>,
  waterMaskValue: f32,
  dayFade: f32,
  distance: f32,
) -> vec3<f32> {
  let viewDir = normalize(-positionEC);

  // Perturbed normal from multi-octave wave normals. `waveN` is the
  // sampled tangent-space normal; .z component (tsPerturbationRatio
  // in WebGL nomenclature) is needed for the nonDiffuseHighlight below
  // so we capture it outside the gate too.
  //
  // Batch 79 — properly transform `waveN` from tangent space to eye
  // space via the ENU rotation, matching WebGL's
  //   normalEC_water = enuToEye * normalTangentSpace
  // pattern at GlobeFS.glsl::computeWaterColor L814. Pre-Batch-79 the
  // WGSL was doing `normalize(normalEC + waveN * waveStrength)` —
  // mixing a tangent-space vector into an eye-space vector without
  // rotation. Visible difference: waves were anchored to camera
  // orientation instead of the surface, producing a subtle "moving
  // mesh" pattern when the camera orbited a coastline.
  var waterNormal = normalEC;
  var foamFactor: f32 = 0.0;
  var tsPerturbationRatio: f32 = 1.0; // 1.0 = flat, 0.0 = vertical wave
  let showOceanWaves = tile.flags.z > 0.5;
  if (showOceanWaves) {
    let t = tile.time;
    let waveN = sampleOceanWaveNormals(uv, t);
    let waveStrength = mix(0.25, 0.05, smoothstep(10000.0, 500000.0, distance));
    let enuToEye = eastNorthUpToEyeCoordinates(positionMC, normalEC);
    // ENU.up = normalEC, so `enuToEye * (0,0,1) = normalEC`. A purely
    // flat wave normal (0, 0, 1) leaves `waterNormal` equal to
    // `normalEC` — no perturbation, matching the pre-Batch-79 baseline
    // when waveN.xy = 0. Non-zero waveN.xy now correctly tilts the
    // normal around the local east/north tangent frame.
    let waveNormalEC = enuToEye * waveN;
    waterNormal = normalize(mix(normalEC, waveNormalEC, waveStrength));
    foamFactor = computeFoam(waveN, distance);
    tsPerturbationRatio = waveN.z;
  }

  // Wave-highlight diffuse term — matches WebGL `waveHighlightColor *
  // czm_getLambertDiffuse(...) * mask * (1 - fade)`. Runs unconditionally
  // (WebGL doesn't gate this on `enableLighting`) and contributes only a
  // narrow band of color where the surface faces the light.
  let waveHighlightColor = vec3<f32>(0.3, 0.45, 0.6);
  let NdotL = max(dot(waterNormal, sunDirEC), 0.0);
  // `dayFade` here mirrors the WebGL `fade` scalar — at close zoom we
  // want full highlight, at orbit the highlight tapers off.
  let highlightFade = 1.0 - clamp(dayFade, 0.0, 1.0);
  let diffuseHighlight = waveHighlightColor * NdotL * waterMaskValue * highlightFade;

  var oceanContribution = diffuseHighlight;

  // Batch 78 — port WebGL's `nonDiffuseHighlight` (GlobeFS.glsl L822-829).
  // Where waves are perturbed AND diffuse light is weak, add a low-light
  // bluish highlight so the ocean isn't pitch-black at the terminator.
  // Gated on SHOW_OCEAN_WAVES (= `tile.flags.z > 0.5`) — matches WebGL's
  // `#ifdef SHOW_OCEAN_WAVES` gate; the WebGL #else branch sets it to
  // vec3(0.0), which is what we get by leaving the var at zero.
  //   formula: mix(waveHighlightColor × 5 × (1 - tsPerturbationRatio),
  //                 vec3(0.0),
  //                 diffuseIntensity)
  // → strongest when waves are vertical (tsPerturbationRatio → 0) and
  //   sun is behind the surface (diffuseIntensity → 0).
  if (showOceanWaves) {
    let nonDiffuseHighlight = mix(
      waveHighlightColor * 5.0 * (1.0 - tsPerturbationRatio),
      vec3<f32>(0.0),
      NdotL,
    );
    oceanContribution += nonDiffuseHighlight * waterMaskValue * highlightFade;
  }

  // Specular sun-glint, only when scene lighting is enabled (matches
  // WebGL's `czm_getSpecular(czm_lightDirectionEC, ...)`).
  if (camera.enableLighting > 0.5) {
    // Orbit-altitude attenuation: the specular highlight subtends < 1
    // pixel at orbit, so fade it out smoothly above ~100 km. Without
    // this the sun-glint patch persists as a bright limb point at orbit.
    let cameraWC = camera.encodedCameraHigh + camera.encodedCameraLow;
    let altitudeMeters = max(0.0, length(cameraWC) - 6378137.0);
    let orbitGateMin: f32 = 100000.0;
    let orbitGateMax: f32 = 6378137.0;
    let orbitGateT = clamp(
      (altitudeMeters - orbitGateMin) / max(1.0, orbitGateMax - orbitGateMin),
      0.0, 1.0,
    );
    let orbitSmooth = orbitGateT * orbitGateT * (3.0 - 2.0 * orbitGateT);
    let orbitAttenuation = 1.0 - orbitSmooth;

    let halfDir = normalize(viewDir + sunDirEC);
    let NdotH = max(dot(waterNormal, halfDir), 0.0);
    let specular = distributionGGX(NdotH, 0.08) * NdotL;

    // Batch 78 — port WebGL's `surfaceReflectance` modulation
    // (GlobeFS.glsl L833):
    //   surfaceReflectance = mix(0.0,
    //     mix(u_zoomedOutOceanSpecularIntensity, oceanSpecularIntensity=0.5,
    //         waveIntensity),
    //     maskValue)
    // - When waterMaskValue → 0 (land), specular → 0.
    // - When waveIntensity → 0 (far from surface), specular uses the
    //   zoomed-out intensity (default 0.5, matches WebGL's
    //   `u_zoomedOutOceanSpecularIntensity` default).
    // - When waveIntensity → 1 (close), specular uses the full
    //   `oceanSpecularIntensity` (0.5 — same default; the WebGL
    //   `mix(zoomedOut, ocean, waveIntensity)` collapses to a constant
    //   when both are 0.5, which is the case in default scenes).
    // We re-derive `waveIntensity` here from the same distance curve
    // WebGL's `waveFade(70000, 1000000, dist)` uses, so the
    // modulation has the same falloff. The result multiplies the
    // existing GGX × orbitAttenuation pipeline, preserving the WGSL
    // specular character while picking up the WebGL water-mask + wave-
    // intensity gates.
    let zoomedOutSpec = 0.5;
    let nearSpec = 0.5;
    let waveIntensity = clamp(
      (1000000.0 - distance) / max(1.0, 1000000.0 - 70000.0),
      0.0,
      1.0,
    );
    let surfaceReflectance = mix(zoomedOutSpec, nearSpec, waveIntensity);

    oceanContribution += vec3<f32>(1.0, 0.95, 0.85) *
      min(specular, 8.0) * orbitAttenuation * waterMaskValue *
      surfaceReflectance;
  }

  // Foam: white overlay on steep wave crests (additive on top of imagery).
  let foamColor = vec3<f32>(0.85, 0.9, 0.92);

  // Match WebGL: imagery preserved, highlights added on top, foam mixed in.
  var color = baseColor + oceanContribution;
  color = mix(color, foamColor, foamFactor);

  // Smooth water mask transition at coastlines — for non-water fragments
  // (coastBlend = 0) we return baseColor unchanged. For water (coastBlend
  // = 1) we return imagery + highlights.
  let coastBlend = smoothstep(0.3, 0.7, waterMaskValue);
  return mix(baseColor, color, coastBlend);
}

// ═══════════════════════════════════════════════════════════════════════
// Fog & Atmosphere
// ═══════════════════════════════════════════════════════════════════════

// OPEN-5 fix: matches WebGL's `czm_fog(distance, color, fogColor, modifier)`
// formula from `fog.glsl`. The modifier (fogVisualDensityScalar, default 0.15)
// reduces the exponential so that horizontal viewing angles at low altitude
// don't produce an opaque fog wall. Without the modifier the exponent is
// `scalar^2`, which is ~6.7x stronger than the WebGL path at low density.
fn computeFog(distance: f32, fogDensity: f32, modifier: f32) -> f32 {
  let scalar = distance * fogDensity;
  return clamp(1.0 - exp(-((modifier * scalar + modifier) * (scalar * (1.0 + modifier)))), 0.0, 1.0);
}

// LUT-sampled atmosphere color for terrain fog. Uses the same
// (cosViewZenith, altitude) U/V mapping as SkyAtmosphere.wgsl's
// `sampleScatteringLut`, so ground fog and sky atmosphere share a
// consistent color / transmittance per view direction + altitude.
//
// worldPos: fragment world-space position (tile center + relative)
// cameraWC: camera world-space position (reconstructed from
//           encodedCameraHigh + encodedCameraLow in the caller)
//
// Returns vec4(inscatterRGB, transmittanceScalar) where:
//   .rgb = additive atmosphere color that should be added to or
//          mixed-toward for fog
//   .a   = approximate transmittance along the view ray (0 = fully
//          absorbed, 1 = clear). The caller may use this to dim
//          terrain contribution through thick fog.
//
// The caller is responsible for checking `effects.atmosphereLutControl.x
// > 0.5` before consuming this result — when disabled the placeholder
// textures produce zero inscatter and zero transmittance, which the
// fog path treats as "no LUT info".
fn sampleAtmosphereFogLut(
  worldPos: vec3<f32>,
  cameraWC: vec3<f32>,
) -> vec4<f32> {
  let innerRadius = effects.atmosphereLutControl.y;
  let thickness = max(1.0, effects.atmosphereLutControl.z);
  // Camera altitude + view direction drive the LUT lookup. We use the
  // CAMERA's altitude + the camera-to-fragment view direction, which
  // matches how SkyAtmosphere samples the same table for the visible
  // shell. Ground fog then matches the sky color the user sees
  // through the same pixel.
  let viewVec = worldPos - cameraWC;
  let viewDir = normalize(viewVec);
  let upDir = normalize(cameraWC);
  let cosViewZenith = clamp(dot(viewDir, upDir), -1.0, 1.0);
  let cameraAltitude = max(0.0, length(cameraWC) - innerRadius);
  let uCoord = clamp(cosViewZenith * 0.5 + 0.5, 0.0, 1.0);
  let vCoord = clamp(cameraAltitude / thickness, 0.0, 1.0);

  // Transmittance LUT: .rgb = attenuation along the ray. We take the
  // average channel for a scalar extinction factor (most terrain fog
  // blends monochromatically along the view ray).
  let tSample = textureSampleLevel(
    atmosphereTransmittanceLut, atmosphereLutSampler,
    vec2<f32>(uCoord, vCoord), 0.0,
  );
  let transmittance = clamp((tSample.r + tSample.g + tSample.b) / 3.0, 0.0, 1.0);

  // Inscatter LUT: .rgb = sky color along the ray (Rayleigh + Mie
  // pre-integrated with the current sun direction).
  let iSample = textureSampleLevel(
    atmosphereInscatterLut, atmosphereLutSampler,
    vec2<f32>(uCoord, vCoord), 0.0,
  );

  // Orbital-falloff — atmosphere fog shouldn't apply when the camera
  // is way above the atmosphere (the sky shell handles that). Mirrors
  // the logic in SkyAtmosphere::sampleScatteringLut.
  // Orbit falloff: same fix as SkyAtmosphere::sampleScatteringLut — use
  // innerRadius instead of thickness as the scale-height so the ground
  // fog stays perceptible up to ~3 planet radii. Previous thickness-
  // scaled exp(-x/160km) collapsed to zero by LEO. Camera inside the
  // shell (cameraAltitude < thickness) gets falloff = 1, unchanged.
  let excessAltitude = max(0.0, cameraAltitude - thickness);
  let orbitScaleHeight = max(thickness, effects.atmosphereLutControl.y);
  let orbitFalloff = exp(-excessAltitude / orbitScaleHeight);

  // Intensity scaling (Session 65, 2026-05-11): the inscatter LUT is
  // baked intensity-free — `SkyAtmosphere::sampleScatteringLut` multiplies
  // by `u.intensity` at fragment time. Globe fog wants the same texel
  // scaled by `Globe.atmosphereLightIntensity` (CPU side packs it into
  // `tile.groundAtmosphereControl.z`, default 10.0).
  //
  // Previous code used a hardcoded `GROUND_INTENSITY_RESCALE = 0.2`
  // tuned for the default-config case (sky=50, globe=10, ratio=0.2).
  // That broke `Atmosphere.html`, which sets `globe.atmosphereLightIntensity
  // = 20`: the rescale stayed 0.2 (assumed globe=10), the ground fog ended
  // up half as bright as expected, and the post-tonemap mix saturated the
  // imagery to a uniform tan. Scaling by `groundAtmosphereControl.z`
  // directly closes the parity gap and is also the correct math for any
  // user-customized intensity.
  let groundIntensity = max(0.0, tile.groundAtmosphereControl.z);
  return vec4<f32>(iSample.rgb * orbitFalloff * groundIntensity, transmittance);
}

// Enhanced atmosphere color with Rayleigh phase and Mie forward scattering
fn computeAtmosphereColor(
  positionEC: vec3<f32>,
  normalEC: vec3<f32>,
  sunDirEC: vec3<f32>,
) -> vec3<f32> {
  let viewDir = normalize(-positionEC);
  let cosAngle = dot(viewDir, normalEC);

  // Rayleigh scattering: blue scattered light
  let rayleighPhase = 0.75 * (1.0 + cosAngle * cosAngle);
  let skyBlue = vec3<f32>(0.18, 0.38, 0.72) * rayleighPhase;

  // Mie forward scattering: sun glow near horizon
  let cosTheta = dot(viewDir, sunDirEC);
  // Henyey-Greenstein phase function approximation (g=0.76)
  let g = 0.76;
  let g2 = g * g;
  let miePhase = (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
  let sunGlow = vec3<f32>(0.95, 0.65, 0.30) * miePhase * 0.05;

  return skyBlue * 0.3 + sunGlow;
}

// Khronos PBR Neutral tonemap — port of WebGL czm_pbrNeutralTonemapping
// (packages/engine/Source/Shaders/Builtin/Functions/pbrNeutralTonemapping.glsl).
// Identity for inputs ≤ 0.76; gentle peak compression with saturation
// preservation above. Used by the FOG branch below to bring linear-HDR
// atmosphere color into SDR display space before mixing with sRGB
// imagery, matching WebGL GlobeFS.glsl's `czm_pbrNeutralTonemapping ->
// czm_inverseGamma` pair under `#ifndef HDR`.
fn pbrNeutralTonemapAtmosphere(color: vec3<f32>) -> vec3<f32> {
  let startCompression = 0.8 - 0.04;
  let desaturation = 0.15;
  let x = min(color.r, min(color.g, color.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  var c = color - vec3<f32>(offset);
  let peak = max(c.r, max(c.g, c.b));
  if (peak < startCompression) { return c; }
  let d = 1.0 - startCompression;
  let newPeak = 1.0 - d * d / (peak + d - startCompression);
  c = c * (newPeak / peak);
  let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(c, vec3<f32>(newPeak), vec3<f32>(g));
}

// ═══════════════════════════════════════════════════════════════════════
// Shadow & Clipping (unchanged from previous version)
// ═══════════════════════════════════════════════════════════════════════

fn globeShadowPCF(uv: vec2<f32>, depth: f32, texelSize: vec2<f32>) -> f32 {
  // Sample unconditionally (uniform control flow). Use
  // textureSampleCompareLevel (explicit LOD) so it's valid even
  // when called from non-uniform branches.
  var shadow: f32 = 0.0;
  for (var x: i32 = -1; x <= 1; x++) {
    for (var y: i32 = -1; y <= 1; y++) {
      let offset = vec2<f32>(f32(x), f32(y)) * texelSize;
      shadow += textureSampleCompareLevel(shadowDepthTex, shadowCompSampler, uv + offset, depth);
    }
  }
  let pcf = shadow / 9.0;
  // Out-of-bounds → fully lit.
  let outOfBounds = uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || depth > 1.0;
  return select(pcf, 1.0, outOfBounds);
}

// CSM Slice 1 — cascade sampling helpers. Duplicated inline from
// ShadowReceiveCSM.wgsl (the WGSL preprocessor's include path isn't
// wired for this shader yet; primitive-side receivers can share the
// file via the #include path once Slice 2 lands). The logic is
// identical: pick the smallest cascade whose far split covers the
// fragment, sample its VP-reprojected position, blend across the
// split boundary to hide seams.
fn selectCascade(viewDepth: f32, splits: vec4<f32>) -> u32 {
  if (viewDepth < splits.x) { return 0u; }
  if (viewDepth < splits.y) { return 1u; }
  if (viewDepth < splits.z) { return 2u; }
  return 3u;
}

fn getCascadeVP(idx: u32) -> mat4x4<f32> {
  switch (idx) {
    case 0u: { return csmParams.cascadeVP0; }
    case 1u: { return csmParams.cascadeVP1; }
    case 2u: { return csmParams.cascadeVP2; }
    default: { return csmParams.cascadeVP3; }
  }
}

// Per-cascade slope-scaled depth bias. Scales with the angle between the
// surface normal and the light direction (grazing surfaces need more
// bias to prevent acne); floored by the per-cascade minimum bias.
fn cascadeDepthBias(cascadeIdx: u32, normal: vec3<f32>, lightDir: vec3<f32>) -> f32 {
  let nDotL = clamp(dot(normalize(normal), normalize(lightDir)), 0.0, 1.0);
  let minBias = csmParams.cascadeMinBias[cascadeIdx];
  let maxSlope = csmParams.cascadeMaxSlopeBias[cascadeIdx];
  let slopeBias = maxSlope * (1.0 - nDotL);
  return max(minBias, slopeBias);
}

// Sample one cascade. `eyePos` is the camera-relative RTE position (NOT
// reconstructed worldPos); the cascade VP is RTE-aware.
fn sampleOneCascade(eyePos: vec3<f32>, cascadeIdx: u32, depthBias: f32) -> f32 {
  let vp = getCascadeVP(cascadeIdx);
  let clipPos = vp * vec4<f32>(eyePos, 1.0);
  let ndc = clipPos.xyz / clipPos.w;
  // WebGPU viewport Y-flip: during cast, a fragment at NDC +y lands at
  // framebuffer y=0 (top). Texture coord UV.y = 0 is the top row, so
  // receive-side sampling must flip: `uv.y = (1 - ndc.y) / 2`. The
  // single-map path above (`globeComputeShadowFactor`) has the same
  // flip — matching its convention keeps the cascade behavior
  // consistent when a scene toggles between single-map and CSM.
  let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
  let depth = ndc.z - depthBias;
  // Fully lit if outside the cascade's XY footprint OR past the far
  // plane (depth > 1) OR behind the light's near plane (depth < 0 —
  // which can happen when the cascade eye sits deep in the terrain
  // and a nearby fragment projects behind the ortho near clip).
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ||
      depth > 1.0 || depth < 0.0) {
    return 1.0;
  }
  // CSM-PCF-SOFT: soften the cascade edge with a 3x3 PCF box kernel,
  // matching WebGL's czm_shadowVisibility USE_SOFT_SHADOWS path. The
  // kernel radius (in shadow texels) is effects.csmControl.y; 0 keeps
  // the original single hardware-comparison tap (hard edge).
  let csmPcfRadius = effects.csmControl.y;
  if (csmPcfRadius <= 0.0) {
    return textureSampleCompareLevel(
      cascadeDepthArray, shadowCompSampler, uv, i32(cascadeIdx), depth);
  }
  let csmDim = vec2<f32>(textureDimensions(cascadeDepthArray, 0));
  let csmTexel = csmPcfRadius / max(csmDim, vec2<f32>(1.0));
  var csmVis = 0.0;
  for (var sx: i32 = -1; sx <= 1; sx++) {
    for (var sy: i32 = -1; sy <= 1; sy++) {
      let csmOff = vec2<f32>(f32(sx), f32(sy)) * csmTexel;
      csmVis = csmVis + textureSampleCompareLevel(
          cascadeDepthArray, shadowCompSampler, uv + csmOff, i32(cascadeIdx), depth);
    }
  }
  return csmVis * (1.0 / 9.0);
}

fn sampleCascadeShadow(
  eyePos: vec3<f32>,
  viewDepth: f32,
  normal: vec3<f32>,
  lightDir: vec3<f32>,
) -> f32 {
  let cascadeIdx = selectCascade(viewDepth, csmParams.cascadeSplits);
  let bias0 = cascadeDepthBias(cascadeIdx, normal, lightDir);
  let s0 = sampleOneCascade(eyePos, cascadeIdx, bias0);

  // Blend with next cascade when inside the blend band near the split.
  let splitDist = csmParams.cascadeSplits[cascadeIdx];
  let blendBand = csmParams.blendBands[cascadeIdx];
  let blendStart = splitDist - blendBand;
  if (viewDepth > blendStart && cascadeIdx < 3u) {
    let nextIdx = cascadeIdx + 1u;
    let bias1 = cascadeDepthBias(nextIdx, normal, lightDir);
    let s1 = sampleOneCascade(eyePos, nextIdx, bias1);
    let blendT = smoothstep(blendStart, splitDist, viewDepth);
    return mix(s0, s1, blendT);
  }
  return s0;
}

// CSM shadow factor, RTE precision path. `eyePos` is v_positionRTE from
// the vertex stage — camera-relative, full RTE precision. `viewDepth` is
// |v_positionEC.z|. Normal + light dir are eye-space (both live in the
// same space, so nDotL is frame-invariant).
fn globeComputeShadowFactorCSM(
  eyePos: vec3<f32>,
  viewDepth: f32,
  normal: vec3<f32>,
  lightDir: vec3<f32>,
) -> f32 {
  if (effects.shadowDarkness >= 1.0) { return 1.0; }
  let visibility = sampleCascadeShadow(eyePos, viewDepth, normal, lightDir);
  return mix(effects.shadowDarkness, 1.0, visibility);
}

// C-R10-POINT-LIGHT-RECEIVE-GLOBE (Batch 108) — cube-shadow sample
// adapted from `samplePointShadow` in ModelPBRComplete.wgsl. Math is
// identical: pick the dominant cube-face axis, derive the depth value
// the cast pipeline wrote at that axis distance, sample the cube with
// `direction = fragWC - lightWC`. The 5-tap cross PCF runs when
// `pointLightPositionWC.w > 0` for soft shadows; zero radius drops
// to a single hardware-comparison sample.
//
// Globe-specific: `fragWC` reconstruction uses the camera high/low
// split rather than a `cameraPositionWC` field (the globe camera UB
// doesn't expose a single-precision world-space position). Adding
// `encodedCameraHigh + encodedCameraLow` reconstructs camera position
// at f32 quantization, which is fine for the light-distance comparison
// (the comparison's resolution is bounded by `farPlane`, not by the
// camera position's absolute precision).
fn globeSamplePointShadow(fragWC: vec3<f32>) -> f32 {
  let lightWC = effects.pointLightPositionWC.xyz;
  let direction = fragWC - lightWC;
  let absDir = abs(direction);
  let axisDist = max(absDir.x, max(absDir.y, absDir.z));
  let nearPlane = effects.pointLightControl.z;
  let farPlane = effects.pointLightControl.y;
  let depthBias = effects.pointLightControl.w;
  if (axisDist >= farPlane) { return 1.0; }
  let depthRange = farPlane - nearPlane;
  let zNdcWebGpu =
    farPlane / depthRange - (farPlane * nearPlane) / (axisDist * depthRange);
  let zAttached = zNdcWebGpu * 0.5 + 0.5;
  let refDepth = clamp(zAttached - depthBias, 0.0, 1.0);
  let pcfRadius = effects.pointLightPositionWC.w;
  if (pcfRadius <= 0.0) {
    return textureSampleCompareLevel(
      pointLightCubeDepth,
      shadowCompSampler,
      direction,
      refDepth,
    );
  }
  // 5-tap cross PCF — perturb along the two axes tangent to the
  // dominant cube face so all taps stay on the same face's depth
  // texels (cross-face perturbation would compare against texels
  // written by a different per-face camera and produce seam banding).
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
  let texelStep = 1.0 / max(effects.shadowMapSize.x, 1.0);
  let offset = pcfRadius * texelStep;
  var sum = 0.0;
  sum = sum + textureSampleCompareLevel(
    pointLightCubeDepth, shadowCompSampler, direction, refDepth,
  );
  sum = sum + textureSampleCompareLevel(
    pointLightCubeDepth, shadowCompSampler, direction + minorA * offset, refDepth,
  );
  sum = sum + textureSampleCompareLevel(
    pointLightCubeDepth, shadowCompSampler, direction - minorA * offset, refDepth,
  );
  sum = sum + textureSampleCompareLevel(
    pointLightCubeDepth, shadowCompSampler, direction + minorB * offset, refDepth,
  );
  sum = sum + textureSampleCompareLevel(
    pointLightCubeDepth, shadowCompSampler, direction - minorB * offset, refDepth,
  );
  return sum * 0.2;
}

fn globeComputeShadowFactorPointLight(fragWC: vec3<f32>) -> f32 {
  if (effects.shadowDarkness >= 1.0) { return 1.0; }
  let visibility = globeSamplePointShadow(fragWC);
  return mix(effects.shadowDarkness, 1.0, visibility);
}

fn globeComputeShadowFactor(positionEC: vec3<f32>) -> f32 {
  if (effects.shadowDarkness >= 1.0) { return 1.0; }
  let shadowPos = effects.shadowMatrix * vec4<f32>(positionEC, 1.0);
  let coord = shadowPos.xyz / shadowPos.w;
  let uv = vec2<f32>(coord.x * 0.5 + 0.5, 1.0 - (coord.y * 0.5 + 0.5));
  let texelSize = 1.0 / effects.shadowMapSize;
  // Sample shadow UNCONDITIONALLY to satisfy uniform control flow
  // requirement. textureSampleCompareLevel uses explicit LOD 0 so it
  // doesn't need implicit derivatives (safe from non-uniform flow).
  let rawVisibility = textureSampleCompareLevel(
    shadowDepthTex, shadowCompSampler, uv, coord.z,
  );
  // Bounds check: outside shadow map → fully lit (no shadow).
  let outOfBounds = uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || coord.z > 1.0;
  var visibility: f32;
  if (effects.shadowSoftShadows > 0.5) {
    visibility = globeShadowPCF(uv, coord.z, texelSize);
  } else {
    visibility = select(rawVisibility, 1.0, outOfBounds);
  }
  return mix(effects.shadowDarkness, 1.0, visibility);
}

fn globeClipByPlanes(positionMC: vec3<f32>) -> bool {
  let count = effects.clippingPlaneCount;
  if (count == 0u) { return false; }
  let isUnion = effects.clippingUnionMode == 1u;
  let texWidth = f32(count);
  var clippedCount: u32 = 0u;
  for (var i: u32 = 0u; i < count; i++) {
    let texelU = (f32(i) + 0.5) / texWidth;
    let planeData = textureSampleLevel(clippingPlaneTex, clippingPlaneSampler,
                                       vec2<f32>(texelU, 0.5), 0.0);
    let dist = dot(positionMC, planeData.xyz) + planeData.w;
    if (dist < 0.0) {
      clippedCount++;
      if (isUnion) { return true; }
    }
  }
  if (!isUnion && clippedCount == count) { return true; }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// Fragment Shader
// ═══════════════════════════════════════════════════════════════════════

// Slice 5c-B Batch 117 — G-buffer MRT output struct.
//
// Slot 0 (@location(0)) is the scene framebuffer color (unchanged from
// the original 1-target shape). Slot 1 (@location(1)) is the G-buffer
// normal-roughness texture: xyz = eye-space normal, w = roughness.
//
// The pipeline's slot-1 target is `{format: "rgba16float", writeMask:
// 0xf}` whenever MRT mode is on (see WebGPUGlobeSurfacePipelines.ts).
// Every return path in the fragment entry points below MUST go through
// `makeFragOutput` so the slot-1 emit is consistent — declaring a
// writable target slot without emitting the matching @location trips
// `GPUPipelineError: Color target has no corresponding fragment output`
// at pipeline creation time (the silent failure mode the original
// Sub-C dry-run hit; see migration_doc/WEBGPU_DEBUGGING_LOG.md
// Batch 116 postmortem).
struct FragOutput {
  @location(0) color: vec4<f32>,
  @location(1) normalRoughness: vec4<f32>,
  //>>ifdef LOG_DEPTH
  @builtin(frag_depth) depth: f32,
  //>>endif
};

// Helper to pack the slot-1 attachment. Roughness is a 0.5 placeholder
// until per-material roughness is piped through the globe pipeline
// (covered by NEW-GBUFFER-MRT-PRIMITIVE-EMIT material-aware work).
// Debug entry points pass a sentinel (0,0,0,*) when no real normal is
// available; consumers (AO, future SSR) check `length(xyz) < 0.01` and
// fall back to the depth-derived path for sentinel pixels.
fn makeFragOutput(color: vec4<f32>, normalEC: vec3<f32>) -> FragOutput {
  var out: FragOutput;
  out.color = color;
  out.normalRoughness = vec4<f32>(normalEC, 0.5);
  //>>ifdef LOG_DEPTH
  // Write logarithmic frag depth. g_fragLogDepth (the interpolated
  // depthFromNearPlusOne) is stashed at the top of fragmentMain so every
  // return path through makeFragOutput emits it without a parameter.
  // factor = camera.logDepth.z (oneOverLog2FarDepthFromNearPlusOne).
  out.depth = csm_writeLogDepth(g_fragLogDepth, camera.logDepth.z);
  //>>endif
  return out;
}

// DP-H44 (Batch 360) — globe terrain pick entry point. Outputs the globe's
// pick color (packed at the camera-UB tail) into the single-target pick FBO.
// Rendered by the pick-pass pick pipeline (buildPickPipelineDescriptor strips
// the G-buffer slot-1 target + blend + MSAA from the color descriptor). Writes
// STANDARD rasterizer depth (no @builtin(frag_depth)) so the pick FBO depth
// stays consistent with the model / primitive pick pipelines, which also write
// standard depth. The globe pick command is dispatched ONLY when
// `globe.pickable` is set (the globe stays out of the pick pass otherwise — see
// `GlobeSurfaceTileProviderRendering.updateWebGPUForPick`), so `scene.pick`
// stays undefined over the globe by default (WebGL parity) and returns the
// Globe only when the app opts in. `scene.pickPosition` reads the main-pass
// globe-depth texture, not this FBO, so it works over terrain regardless.
// NOTE: the cartographic-limit / clipping-plane discards that
// `fragmentMain` applies are intentionally NOT mirrored here yet — globe pick
// over a clipped/limited globe is a follow-up; the default (unclipped) globe
// picks correctly.
@fragment
fn fragmentPickMain(input: VertexOutput) -> @location(0) vec4<f32> {
  return camera.pickColor;
}

@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
  // Slice 5c-B Batch 117 — hoisted from line 2738 so every return path
  // (including the ~30 early debug returns at the top of this function)
  // has a real eye-space normal to emit on slot 1. v_normalEC is always
  // written by the vertex shader (unconditionally in vertexMain, line
  // 1158) so the read is safe regardless of the hasNormals pipeline
  // variant.
  let normalEC = normalize(input.v_normalEC);
  let geoUV = input.v_textureCoordinates.xy;
  let webMercT = input.v_textureCoordinates.z;

  //>>ifdef LOG_DEPTH
  // Stash the interpolated log-depth varying so makeFragOutput (called from
  // ~15 return sites, including the early debug returns) can write frag_depth.
  g_fragLogDepth = input.v_logDepth;
  //>>endif

  // Batch 57 — per-fragment UV derivatives computed AT FRAGMENT ENTRY
  // while control flow is still uniform. Used by `sampleImagery` calls
  // below via `textureSampleGrad`, which is the only WGSL sampling
  // function that picks a mip level (via the gradient magnitude) AND
  // is legal to call after non-uniform discard/return. The previous
  // `textureSampleLevel(uv, 0.0)` formulation hard-locked sampling to
  // mip 0 — the WebGPU/WebGL ~4× brightness gap at orbital altitudes
  // was the alias pattern under-sampling bright pixels.
  let geoUV_dx = dpdx(geoUV);
  let geoUV_dy = dpdy(geoUV);
  // For webMercatorT-sampled layers the V coordinate is the per-vertex
  // varying instead of geoUV.y, so its derivative is also needed.
  let webMercUV_dx = vec2<f32>(geoUV_dx.x, dpdx(webMercT));
  let webMercUV_dy = vec2<f32>(geoUV_dy.x, dpdy(webMercT));

  // Helper: select geographic V or webMercatorT per layer.
  // Matches WebGL's u_dayTextureUseWebMercatorT. Batch 58 — packed 4 layers
  // per vec4 (`useWebMercatorTLayer[i/4][i%4]`); read all 16 here so the
  // per-layer blocks below stay branch-light.

  // UV debug visualization: Red=U, Green=V, Blue=webMercT
  // Triggered via tile.time > 1.0e9 (debug sentinel — `waveTime` is
  // `secsSinceEpoch % 1_000_000` so any threshold below 1 000 000 is
  // hit 90 %+ of the time and silently masquerades as the production
  // render output. Bumped to 1 e9 so a JS-side caller has to push the
  // value WAY past the natural range to opt in.)
  if (tile.time > 1.0e9 && tile.time < 1.5e9) {
    return makeFragOutput(vec4<f32>(geoUV.x, geoUV.y, webMercT, 1.0), normalEC);
  }
  // Batch 56 — texCoordsAlpha debug. Trigger via tile.time in [1.5e9, 2.5e9].
  // Shows red = alpha mask for layer 0 (white means alpha=1, black=0),
  // green = the V coord clamped to [0,1], blue = layer 0 rect.y (minV).
  if (tile.time > 1.5e9 && tile.time < 2.5e9) {
    if (u32(tile.layerCount) >= 1u) {
      let r = tile.layers[0].texCoordsRect;
      let alpha = texCoordsAlpha(geoUV, r);
      return makeFragOutput(vec4<f32>(alpha, geoUV.y, r.y, 1.0), normalEC);
    }
    return makeFragOutput(vec4<f32>(1.0, 0.0, 1.0, 1.0), normalEC); // magenta = no layer
  }
  // Batch 56 — layerCount debug. Trigger via tile.time in [2.5e9, 3.5e9].
  // Red = layer count / 16. Green = layer 0 alpha. Blue = layer 1 alpha
  // (if it exists). Each visible non-magenta tile should show layer 0
  // OR layer 1 alpha=1 for any given V, but never both 0.
  if (tile.time > 2.5e9 && tile.time < 3.5e9) {
    let lc = u32(tile.layerCount);
    let a0 = select(0.0, texCoordsAlpha(geoUV, tile.layers[0].texCoordsRect), lc >= 1u);
    let a1 = select(0.0, texCoordsAlpha(geoUV, tile.layers[1].texCoordsRect), lc >= 2u);
    return makeFragOutput(vec4<f32>(f32(lc) / 16.0, a0, a1, 1.0), normalEC);
  }
  // Batch 56 — direct imagery sample debug. Trigger via tile.time in
  // [3.5e9, 4.5e9]. Shows raw sample from layer 0 (no compositing,
  // no alpha mask). Confirms whether the reprojected texture content
  // itself is black or correct.
  if (tile.time > 3.5e9 && tile.time < 4.5e9) {
    if (u32(tile.layerCount) >= 1u) {
      let useWMT = tile.useWebMercatorTLayer[0].x;
      let uv = selectLayerUV(geoUV, webMercT, useWMT);
      let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
      let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
      let tex = sampleImagery(dayTexture0, texSampler, uv, tile.layers[0], uv_dx, uv_dy);
      return makeFragOutput(vec4<f32>(tex.rgb, 1.0), normalEC);
    }
    return makeFragOutput(vec4<f32>(1.0, 0.0, 1.0, 1.0), normalEC);
  }
  // Batch 57 — explicit mip level debug. Forces sampling at mip 4 to
  // verify the mipmap chain exists and contains valid imagery. If the
  // output here matches sample0 then either mipmaps aren't generated
  // or the sampler isn't picking them. If different from sample0, the
  // chain IS valid and the issue is LOD selection / derivative magnitude.
  if (tile.time > 16.5e9 && tile.time < 17.5e9) {
    if (u32(tile.layerCount) >= 1u) {
      let useWMT = tile.useWebMercatorTLayer[0].x;
      let uv = selectLayerUV(geoUV, webMercT, useWMT);
      let scaledUV = uv * tile.layers[0].translationAndScale.zw +
        tile.layers[0].translationAndScale.xy;
      let tex = textureSampleLevel(dayTexture0, texSampler, scaledUV, 4.0);
      return makeFragOutput(vec4<f32>(tex.rgb, 1.0), normalEC);
    }
    return makeFragOutput(vec4<f32>(1.0, 0.0, 1.0, 1.0), normalEC);
  }
  // Batch 57 — visualize derivative magnitude as grayscale.
  // log2(max(|dx|, |dy|) * texSize) approximates the LOD value the
  // sampler computes. Should grow with camera distance.
  if (tile.time > 17.5e9 && tile.time < 18.5e9) {
    if (u32(tile.layerCount) >= 1u) {
      let useWMT = tile.useWebMercatorTLayer[0].x;
      let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
      let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
      let scale = tile.layers[0].translationAndScale.zw;
      let dx = uv_dx * scale;
      let dy = uv_dy * scale;
      let maxDeriv = max(max(abs(dx.x), abs(dx.y)), max(abs(dy.x), abs(dy.y)));
      // Encode log2(maxDeriv * 256) / 10 as gray (assumes 256x256 imagery).
      let lod = log2(max(maxDeriv * 256.0, 1e-6)) / 10.0 + 0.5;
      return makeFragOutput(vec4<f32>(lod, lod, lod, 1.0), normalEC);
    }
    return makeFragOutput(vec4<f32>(1.0, 0.0, 1.0, 1.0), normalEC);
  }
  // Batch 56 — direct imagery sample for layer 1.
  //>>ifdef GLOBE_IMAGERY_REDUCED
  // Reduced layout has no dayTexture1 binding — the layer-1 debug
  // sentinel is unavailable (each pass carries one layer in slot 0).
  //>>else
  if (tile.time > 4.5e9 && tile.time < 5.5e9) {
    if (u32(tile.layerCount) >= 2u) {
      let useWMT = tile.useWebMercatorTLayer[0].y;
      let uv = selectLayerUV(geoUV, webMercT, useWMT);
      let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
      let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
      let tex = sampleImagery(dayTexture1, texSampler, uv, tile.layers[1], uv_dx, uv_dy);
      return makeFragOutput(vec4<f32>(tex.rgb, 1.0), normalEC);
    }
    return makeFragOutput(vec4<f32>(0.0, 1.0, 1.0, 1.0), normalEC); // cyan = no layer 1
  }
  //>>endif
  // Batch 56 — texSample.a debug. Visualize the imagery's alpha channel
  // for layer 0. RED = layer 0's tex.a. If alpha is 0, the composite
  // multiplier kills imagery contribution → BLACK output even with
  // valid texCoordsMask.
  if (tile.time > 5.5e9 && tile.time < 6.5e9) {
    if (u32(tile.layerCount) >= 1u) {
      let useWMT = tile.useWebMercatorTLayer[0].x;
      let uv = selectLayerUV(geoUV, webMercT, useWMT);
      let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
      let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
      let tex = sampleImagery(dayTexture0, texSampler, uv, tile.layers[0], uv_dx, uv_dy);
      return makeFragOutput(vec4<f32>(tex.a, tex.a, tex.a, 1.0), normalEC);
    }
    return makeFragOutput(vec4<f32>(1.0, 0.0, 1.0, 1.0), normalEC);
  }
  // Batch 56 — tex.a for layer 1. Used to discriminate which texture
  // upload path has alpha=0. Reprojected layers force alpha=1 (after
  // Batch 56 fix); direct uploads via uploadImageSource for opaque JPEGs
  // may have alpha=0.
  //>>ifdef GLOBE_IMAGERY_REDUCED
  // Reduced layout has no dayTexture1 binding — see the layer-1 debug
  // sentinel note above.
  //>>else
  if (tile.time > 6.5e9 && tile.time < 7.5e9) {
    if (u32(tile.layerCount) >= 2u) {
      let useWMT = tile.useWebMercatorTLayer[0].y;
      let uv = selectLayerUV(geoUV, webMercT, useWMT);
      let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
      let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
      let tex = sampleImagery(dayTexture1, texSampler, uv, tile.layers[1], uv_dx, uv_dy);
      return makeFragOutput(vec4<f32>(tex.a, tex.a, tex.a, 1.0), normalEC);
    }
    return makeFragOutput(vec4<f32>(0.0, 1.0, 1.0, 1.0), normalEC); // cyan = no layer 1
  }
  //>>endif

  // Compute shadow factor early — textureSampleCompare must be called
  // from uniform control flow (before any non-uniform discard/return).
  // camera.enableLighting is a uniform value so this branch is uniform.
  // CSM Slice 1: route through the cascaded-shadow path when enabled.
  // Reconstruct world-space fragment position via the atmosphere LUT
  // convention (`v_positionMC + cameraWC`); view-space depth is the
  // magnitude of `v_positionEC.z` (right-handed view, camera at origin
  // looking -Z).
  // NEW-CSM-CAST-NO-DISPATCH-VIEWER (Batch 296) — shadow receive is
  // applied INDEPENDENT of `enableLighting`, matching WebGL's
  // `ShadowMapShader.js` which injects `out_FragColor.rgb *= visibility;`
  // unconditionally (it never wraps the shadow multiply in the lighting
  // `#ifdef`). Previously this whole block was gated on
  // `camera.enableLighting > 0.5`, so a scene with directional lighting
  // disabled (a common isolation setup, and the one the shadow probes use)
  // showed NO cast shadow on WebGPU even though the cast depth map was
  // populated. The shadow factor is now computed whenever a shadow mode is
  // active (point-light / CSM / single-map) and applied once to the final
  // color below (see the `color *= shadowFactor` after the lighting block).
  var shadowFactor: f32 = 1.0;
  // Single-shadow-map presence is signalled by `shadowDarkness < 1.0`
  // (the default 1.0 means "no darkening / no shadow map bound"; the
  // single-map self-gate at the top of `globeComputeShadowFactor` checks
  // the same value). Point-light and CSM each carry their own active flag.
  let shadowModeActive =
    effects.pointLightControl.x > 0.5 ||
    effects.csmControl.x > 0.5 ||
    effects.shadowDarkness < 1.0;
  if (shadowModeActive) {
    if (effects.pointLightControl.x > 0.5) {
      // C-R10-POINT-LIGHT-RECEIVE-GLOBE (Batch 108) — point-light
      // cube-shadow path. Reconstructs world-space fragment position
      // from the camera high/low split (the globe camera UB doesn't
      // expose a single `cameraPositionWC` field) plus v_positionRTE
      // which is camera-relative world space. The reconstruction
      // loses ~1m of f32 precision at orbital camera distances, but
      // the comparison's resolution is bounded by `farPlane`
      // (the light radius), so this only matters for fragments
      // within ~1m of `farPlane` — visually imperceptible. Takes
      // priority over CSM when both are enabled (point + sun
      // shadows together would need an OR-combine, deferred).
      let cameraWC = camera.encodedCameraHigh + camera.encodedCameraLow;
      let fragWC = cameraWC + input.v_positionRTE;
      shadowFactor = globeComputeShadowFactorPointLight(fragWC);
    } else if (effects.csmControl.x > 0.5) {
      // RTE precision path — feed the camera-relative position straight
      // into the RTE-aware cascade VP. No reconstruction of worldPos =
      // positionHigh + positionLow (which would lose ~1m at Earth scale
      // and cause acne on the tightest cascade). Normal + sun direction
      // are both in eye space, which keeps nDotL frame-invariant for
      // slope-bias calculation.
      let viewDepth = abs(input.v_positionEC.z);
      shadowFactor = globeComputeShadowFactorCSM(
        input.v_positionRTE,
        viewDepth,
        input.v_normalEC,
        camera.sunDirectionEC,
      );
    } else {
      shadowFactor = globeComputeShadowFactor(input.v_positionEC);
    }
  }

  // ─── Clipping planes discard ───
  if (globeClipByPlanes(input.v_positionMC)) { discard; }

  // ─── Clipping edge highlight ───
  if (effects.clippingPlaneCount > 0u && effects.clippingEdgeWidth > 0.0) {
    let clipCount = effects.clippingPlaneCount;
    let texW = f32(clipCount);
    var minClipDist: f32 = 1e10;
    for (var ci: u32 = 0u; ci < clipCount; ci++) {
      let texelU = (f32(ci) + 0.5) / texW;
      let planeData = textureSampleLevel(clippingPlaneTex, clippingPlaneSampler,
                                         vec2<f32>(texelU, 0.5), 0.0);
      let dist = abs(dot(input.v_positionMC, planeData.xyz) + planeData.w);
      minClipDist = min(minClipDist, dist);
    }
    if (minClipDist < effects.clippingEdgeWidth) {
      return makeFragOutput(effects.clippingEdgeColor, normalEC);
    }
  }

  // ─── Polygon SDF clipping ───
  if (effects.clippingPolygonCount > 0u) {
    let PI_SDF = 3.14159265358979;
    // Convert tile UV to geographic coordinates (radians) for SDF lookup.
    // geoUV is in [0,1] tile space — we need actual lon/lat for global SDF.
    // For now, use the position in model coordinates to derive geographic coords.
    let posWC = input.v_positionMC;
    let lon = atan2(posWC.y, posWC.x);
    let lat = atan2(posWC.z, sqrt(posWC.x * posWC.x + posWC.y * posWC.y));
    let sdfU = (lon + PI_SDF) / (2.0 * PI_SDF);
    let sdfV = (lat + PI_SDF * 0.5) / PI_SDF;
    let sdfUV = clamp(vec2<f32>(sdfU, sdfV), vec2<f32>(0.0), vec2<f32>(1.0));
    let sdfValue = textureSampleLevel(polygonSDFTex, polygonSDFSampler, sdfUV, 0.0).r;

    // SDF < 0.5 = inside polygon (keep), >= 0.5 = outside (discard)
    if (sdfValue >= 0.5) { discard; }

    // Edge highlight for polygon clipping
    if (effects.clippingEdgeWidth > 0.0) {
      let edgeDist = abs(sdfValue - 0.5) * 2.0;
      // Scale edge width from world to SDF space (approximate)
      let sdfEdgeWidth = effects.clippingEdgeWidth * 0.001;
      if (edgeDist < sdfEdgeWidth) {
        return makeFragOutput(effects.clippingEdgeColor, normalEC);
      }
    }
  }

  // ─── Cartographic limit rectangle clipping ───
  if (tile.flags.y > 0.5) {
    let clampRect = tile.cartographicLimitRect;
    if (geoUV.x < clampRect.x || geoUV.x > clampRect.z ||
        geoUV.y < clampRect.y || geoUV.y > clampRect.w) {
      discard;
    }
  }

  let isSubsequentPass = tile.flags.w > 0.5;

  // Base color: `globe.baseColor` (tile.initialColor — WebGL's
  // `u_initialColor`) for the first pass, transparent for subsequent
  // multi-pass imagery (the CPU packer zeroes the slot). Batch 247 —
  // previously hardcoded vec3(0.04, 0.04, 0.06), which rendered
  // rgb(10,10,15) where WebGL rendered the configured baseColor.
  var color: vec3<f32> = tile.initialColor.rgb;
  var alpha: f32 = tile.initialColor.a;

  // Slice 5c-B Batch 117 — `normalEC` is hoisted to the top of the
  // function for the G-buffer emit. Reuse it here instead of normalizing
  // again.
  let normal = normalEC;
  let sunDir = normalize(camera.sunDirectionEC);

  // Day/night fade factor: 0 = night, 1 = day.
  // Batch 54 — gate on `camera.enableLighting`. The WebGL GlobeFS
  // applies day/night shading inside `#ifdef ENABLE_DAYNIGHT_SHADING`,
  // which the JS-side pragma extractor only emits when
  // `globe.enableLighting === true`. With the default `enableLighting
  // = false`, WebGL skips the fade entirely and renders the globe as
  // uniformly daylit. The WGSL was applying the fade unconditionally,
  // making the night side ~4x darker than WebGL across every default-
  // configured demo (measured via probe-saved-view.mjs: WebGL/WebGPU
  // brightness ratio 4.221, mostly accounted for by the night
  // hemisphere being shaded down).
  var dayFade: f32;
  var nightBlend: f32;
  if (camera.enableLighting > 0.5) {
    dayFade = computeDayNightFade(normal, sunDir);
    nightBlend = 1.0 - dayFade;
  } else {
    dayFade = 1.0;
    nightBlend = 0.0;
  }

  // ─── Composite imagery layers ───
  // Batch 58 (C-R5): widened from 4 to 16 layer slots. Each layer block
  // applies the same effect chain via `applyImageryLayer`:
  //   colorToAlpha → gamma → split → cutout → brightness/contrast/saturation/hue
  // The 16 blocks are unrolled because WGSL forbids dynamic indexing of
  // texture bindings; the per-pass `count` gate skips inactive slots so
  // the cost of the unused branches is one comparison + a structurally-zero
  // mask in the helper.
  let count = u32(tile.layerCount);

  // Tier 2 debug: imagery layer isolation. Negative => all layers render
  // (production). 0..15 => only that layer's slot in the current pass
  // contributes to the composite.
  let isolate = i32(tile.debugFields.y);

  // Pixel-space split position (in framebuffer coords, matches @builtin(position).x).
  let splitPositionPx = tile.splitPosition;
  let fragX = input.position.x;

  // Per-layer composite block — one per binding because WGSL can't index
  // textures dynamically. The dayNightAlpha pairs are packed two per vec4:
  //   layers 0..1 → tile.dayNightAlpha[0].(xy, zw)
  //   layers 2..3 → tile.dayNightAlpha[1].(xy, zw)
  //   …
  //   layers 14..15 → tile.dayNightAlpha[7].(xy, zw)
  // useWebMercatorT packed 4-per-vec4: tile.useWebMercatorTLayer[i/4][i%4].
  if (count >= 1u) {
    let layer = tile.layers[0];
    let useWMT = tile.useWebMercatorTLayer[0].x;
    let uv = selectLayerUV(geoUV, webMercT, useWMT);
    let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
    let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
    let tex = sampleImagery(dayTexture0, texSampler, uv, layer, uv_dx, uv_dy);
    let dna = tile.dayNightAlpha[0].xy;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 0);
    let r = applyImageryLayer(color, alpha, tex, geoUV, uv, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  //>>ifdef GLOBE_IMAGERY_REDUCED
  // NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT (Batch 246) — reduced layout
  // carries exactly one imagery slot per pass; slots 1..15 don't exist.
  // The CPU multi-pass slicer caps `tile.layerCount` at 1 per pass, so
  // the composite loop above is complete.
  //>>else
  if (count >= 2u) {
    let layer = tile.layers[1];
    let useWMT = tile.useWebMercatorTLayer[0].y;
    let uv = selectLayerUV(geoUV, webMercT, useWMT);
    let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
    let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
    let tex = sampleImagery(dayTexture1, texSampler, uv, layer, uv_dx, uv_dy);
    let dna = tile.dayNightAlpha[0].zw;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 1);
    let r = applyImageryLayer(color, alpha, tex, geoUV, uv, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 3u) {
    let layer = tile.layers[2];
    let useWMT = tile.useWebMercatorTLayer[0].z;
    let uv = selectLayerUV(geoUV, webMercT, useWMT);
    let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
    let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
    let tex = sampleImagery(dayTexture2, texSampler, uv, layer, uv_dx, uv_dy);
    let dna = tile.dayNightAlpha[1].xy;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 2);
    let r = applyImageryLayer(color, alpha, tex, geoUV, uv, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 4u) {
    let layer = tile.layers[3];
    let useWMT = tile.useWebMercatorTLayer[0].w;
    let uv = selectLayerUV(geoUV, webMercT, useWMT);
    let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
    let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
    let tex = sampleImagery(dayTexture3, texSampler, uv, layer, uv_dx, uv_dy);
    let dna = tile.dayNightAlpha[1].zw;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 3);
    let r = applyImageryLayer(color, alpha, tex, geoUV, uv, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 5u) {
    let layer = tile.layers[4];
    let useWMT = tile.useWebMercatorTLayer[1].x;
    let uv = selectLayerUV(geoUV, webMercT, useWMT);
    let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
    let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
    let tex = sampleImagery(dayTexture4, texSampler, uv, layer, uv_dx, uv_dy);
    let dna = tile.dayNightAlpha[2].xy;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 4);
    let r = applyImageryLayer(color, alpha, tex, geoUV, uv, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 6u) {
    let layer = tile.layers[5];
    let useWMT = tile.useWebMercatorTLayer[1].y;
    let uv = selectLayerUV(geoUV, webMercT, useWMT);
    let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
    let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
    let tex = sampleImagery(dayTexture5, texSampler, uv, layer, uv_dx, uv_dy);
    let dna = tile.dayNightAlpha[2].zw;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 5);
    let r = applyImageryLayer(color, alpha, tex, geoUV, uv, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 7u) {
    let layer = tile.layers[6];
    let useWMT = tile.useWebMercatorTLayer[1].z;
    let uv = selectLayerUV(geoUV, webMercT, useWMT);
    let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
    let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
    let tex = sampleImagery(dayTexture6, texSampler, uv, layer, uv_dx, uv_dy);
    let dna = tile.dayNightAlpha[3].xy;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 6);
    let r = applyImageryLayer(color, alpha, tex, geoUV, uv, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 8u) {
    let layer = tile.layers[7];
    let useWMT = tile.useWebMercatorTLayer[1].w;
    let uv = selectLayerUV(geoUV, webMercT, useWMT);
    let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
    let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
    let tex = sampleImagery(dayTexture7, texSampler, uv, layer, uv_dx, uv_dy);
    let dna = tile.dayNightAlpha[3].zw;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 7);
    let r = applyImageryLayer(color, alpha, tex, geoUV, uv, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 9u) {
    let layer = tile.layers[8];
    let useWMT = tile.useWebMercatorTLayer[2].x;
    let uv = selectLayerUV(geoUV, webMercT, useWMT);
    let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
    let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
    let tex = sampleImagery(dayTexture8, texSampler, uv, layer, uv_dx, uv_dy);
    let dna = tile.dayNightAlpha[4].xy;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 8);
    let r = applyImageryLayer(color, alpha, tex, geoUV, uv, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 10u) {
    let layer = tile.layers[9];
    let useWMT = tile.useWebMercatorTLayer[2].y;
    let uv = selectLayerUV(geoUV, webMercT, useWMT);
    let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
    let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
    let tex = sampleImagery(dayTexture9, texSampler, uv, layer, uv_dx, uv_dy);
    let dna = tile.dayNightAlpha[4].zw;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 9);
    let r = applyImageryLayer(color, alpha, tex, geoUV, uv, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 11u) {
    let layer = tile.layers[10];
    let useWMT = tile.useWebMercatorTLayer[2].z;
    let uv = selectLayerUV(geoUV, webMercT, useWMT);
    let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
    let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
    let tex = sampleImagery(dayTexture10, texSampler, uv, layer, uv_dx, uv_dy);
    let dna = tile.dayNightAlpha[5].xy;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 10);
    let r = applyImageryLayer(color, alpha, tex, geoUV, uv, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 12u) {
    let layer = tile.layers[11];
    let useWMT = tile.useWebMercatorTLayer[2].w;
    let uv = selectLayerUV(geoUV, webMercT, useWMT);
    let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
    let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
    let tex = sampleImagery(dayTexture11, texSampler, uv, layer, uv_dx, uv_dy);
    let dna = tile.dayNightAlpha[5].zw;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 11);
    let r = applyImageryLayer(color, alpha, tex, geoUV, uv, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 13u) {
    let layer = tile.layers[12];
    let useWMT = tile.useWebMercatorTLayer[3].x;
    let uv = selectLayerUV(geoUV, webMercT, useWMT);
    let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
    let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
    let tex = sampleImagery(dayTexture12, texSampler, uv, layer, uv_dx, uv_dy);
    let dna = tile.dayNightAlpha[6].xy;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 12);
    let r = applyImageryLayer(color, alpha, tex, geoUV, uv, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 14u) {
    let layer = tile.layers[13];
    let useWMT = tile.useWebMercatorTLayer[3].y;
    let uv = selectLayerUV(geoUV, webMercT, useWMT);
    let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
    let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
    let tex = sampleImagery(dayTexture13, texSampler, uv, layer, uv_dx, uv_dy);
    let dna = tile.dayNightAlpha[6].zw;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 13);
    let r = applyImageryLayer(color, alpha, tex, geoUV, uv, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 15u) {
    let layer = tile.layers[14];
    let useWMT = tile.useWebMercatorTLayer[3].z;
    let uv = selectLayerUV(geoUV, webMercT, useWMT);
    let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
    let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
    let tex = sampleImagery(dayTexture14, texSampler, uv, layer, uv_dx, uv_dy);
    let dna = tile.dayNightAlpha[7].xy;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 14);
    let r = applyImageryLayer(color, alpha, tex, geoUV, uv, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 16u) {
    let layer = tile.layers[15];
    let useWMT = tile.useWebMercatorTLayer[3].w;
    let uv = selectLayerUV(geoUV, webMercT, useWMT);
    let uv_dx = selectLayerUVDerivative(geoUV_dx, webMercUV_dx, useWMT);
    let uv_dy = selectLayerUVDerivative(geoUV_dy, webMercUV_dy, useWMT);
    let tex = sampleImagery(dayTexture15, texSampler, uv, layer, uv_dx, uv_dy);
    let dna = tile.dayNightAlpha[7].zw;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 15);
    let r = applyImageryLayer(color, alpha, tex, geoUV, uv, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  //>>endif

  // Batch 56 — post-composite color debug. Trigger via tile.time in
  // [7.5e9, 8.5e9]. Returns the imagery-composited color BEFORE all
  // material/atmosphere/HSB/fog effects. If this shows clean imagery
  // but production shows black, the bug is in the subsequent effects.
  if (tile.time > 7.5e9 && tile.time < 8.5e9) {
    return makeFragOutput(vec4<f32>(color, 1.0), normalEC);
  }
  // Batch 56 — post-composite alpha debug. Trigger via [8.5e9, 9.5e9].
  // Returns the accumulated alpha as grayscale. If alpha is 0 here,
  // the imagery composite produced no contribution.
  if (tile.time > 8.5e9 && tile.time < 9.5e9) {
    return makeFragOutput(vec4<f32>(alpha, alpha, alpha, 1.0), normalEC);
  }

  // Subsequent passes only apply imagery — skip all effects
  if (isSubsequentPass) {
    return makeFragOutput(vec4<f32>(color, alpha), normalEC);
  }

  // ─── Cluster 3 — globe material composite ───
  // Builds a `czm_MaterialInput` from per-fragment values and calls
  // `czm_getMaterial`, which is either the per-material function appended
  // to the source by the pipeline cache (when a globe.material is bound)
  // or the default-material stub (when none is bound, returns
  // diffuse=0, alpha=0 — a no-op alpha blend).
  //
  // The `MATERIAL_APPLY` define is set CPU-side when `globe.material` is
  // non-null. When unset, the call site below is preprocessed out and
  // the material composite is skipped entirely (zero cost when no
  // material is bound).
  //>>ifdef MATERIAL_APPLY
  var matInput: czm_MaterialInput;
  matInput.st = geoUV;
  // Slice 5c-B Batch 117 — reuse the hoisted `normalEC` (line 2480ish).
  matInput.normalEC = normalEC;
  matInput.positionToEyeEC = -input.v_positionEC;
  // tangentToEyeMatrix: east-north-up frame at the fragment, transformed
  // to eye space. WebGL builds it via `czm_eastNorthUpToEyeCoordinates`;
  // we identity-substitute here because none of the in-tree globe
  // materials consume it (BumpMap/NormalMap target Primitive surfaces,
  // not the globe). If a future globe material needs a true tangent
  // frame, route the east/north/up basis through additional VS outputs.
  matInput.tangentToEyeMatrix = mat3x3<f32>(
    vec3<f32>(1.0, 0.0, 0.0),
    vec3<f32>(0.0, 1.0, 0.0),
    vec3<f32>(0.0, 0.0, 1.0),
  );
  matInput.slope = input.v_slope;
  matInput.height = input.v_height;
  matInput.aspect = input.v_aspect;
  matInput.waterMask = 0.0;  // TODO wire from water-mask texture path
  let m = czm_getMaterial(matInput);
  color = mix(color, m.diffuse, m.alpha);
  alpha = max(alpha, m.alpha);
  //>>endif

  // ┌─────────────────────────────────────────────────────────────────────┐
  // │ PAIR-SECTION: Water mask + Ocean rendering (WGSL) ↔ GLSL             │
  // │   GLSL call site: Shaders/GlobeFS.glsl ~lines 433-495                │
  // │   GLSL impl:      Shaders/GlobeFS.glsl L777-849 (computeWaterColor,  │
  // │                   gated by `#ifdef SHOW_REFLECTIVE_OCEAN`)           │
  // │ Last lockstep audit: 2026-05-20, Batch 78                            │
  // └─────────────────────────────────────────────────────────────────────┘
  // Any change to this block MUST land with a matching change in the
  // GLSL counterpart. See migration_doc/SHADER_PAIRS_LOCKSTEP.md.
  //
  // ALGORITHM (matched across backends since Batch 58 + Batch 78)
  // Both backends use an **additive** blend:
  //   `color = imageryColor + diffuseHighlight + nonDiffuseHighlight + specular`
  // Imagery is preserved as the base; ocean highlights are added.
  //
  // Pre-Batch-58 the WGSL incorrectly used a `mix(imagery, deepColor ×
  // darkening, 0.6)` REPLACEMENT blend, which dimmed Bing aerial ocean
  // by ~5× at orbit altitudes — the dominant source of the historical
  // WebGPU/WebGL brightness gap. Batch 58 rewrote the WGSL to match
  // WebGL's additive intent. Batch 78 then closed the remaining
  // line-by-line gaps: `nonDiffuseHighlight` (low-light wave highlight
  // under SHOW_OCEAN_WAVES) and the waveIntensity-modulated
  // surfaceReflectance specular pattern.
  //
  // CORRECTION TO PRIOR AUDIT NOTES (Batches 58 + 73 said WebGL
  // `computeWaterColor` was generated by Cesium's material-system
  // codegen — that was incorrect). The actual implementation is
  // hand-written GLSL in GlobeFS.glsl, gated by `#ifdef
  // SHOW_REFLECTIVE_OCEAN`. The "material codegen" framing leaked into
  // both pair-section headers and the convention ledger; Batch 78
  // corrects this so the lockstep discipline points reviewers at the
  // right files.
  //
  // STRUCTURAL DIVERGENCES (separate from the now-matched algorithm)
  //
  // 1. **Gating**. GLSL: `#if defined(HAS_WATER_MASK) && (defined(SHOW_
  //    REFLECTIVE_OCEAN) || defined(APPLY_MATERIAL))`. WGSL: runtime
  //    `tile.flags.x > 0.5` (CPU-side: `showReflectiveOcean =
  //    hasWaterMask && tileProvider.showWaterEffect === true`).
  // 2. **Water-mask UV Y-flip**. GLSL applies
  //    `waterMaskTextureCoordinates.y = 1.0 - .y` after the
  //    translation/scale (line 478). WGSL doesn't — the WebGPU
  //    `copyExternalImageToTexture` upload path already lands the
  //    mask data row-aligned for direct sampling at `geoUV.y`.
  // 3. **Function home**. GLSL `computeWaterColor` is hand-written in
  //    GlobeFS.glsl L777-849 behind `#ifdef SHOW_REFLECTIVE_OCEAN`.
  //    WGSL `computeEnhancedOcean` is hand-inlined in this shader
  //    (lines 1861-1933). Both require manual line-by-line edits;
  //    neither is generated.
  // 4. **Wave-normal source**. GLSL uses `czm_getWaterNoise(
  //    u_oceanNormalMap, textureCoordinates × oceanFrequency*, time,
  //    0)` with TWO octaves (high-altitude + low-altitude blend) and
  //    `czm_ellipsoidTextureCoordinates(normalMC)` for globe-consistent
  //    wrapping. WGSL uses THREE octaves (uv × 400 / 200 / 800) with
  //    direct tile UV sampling. Wave appearance differs in detail; both
  //    produce convincing ocean motion. WGSL-only enhancement: 3-octave
  //    instead of 2-octave (documented in convention ledger).
  // 5. **Specular model**. GLSL: `czm_getSpecular` (Phong-like).
  //    WGSL: GGX distribution (`distributionGGX`). Different specular
  //    falloff curves; both produce sun-glint at the correct angles.
  //    WGSL-only enhancement.
  // 6. **Foam (whitecaps)**. WGSL has `computeFoam` overlaying white
  //    pixels where wave normals are steep; GLSL has no equivalent.
  //    WGSL-only enhancement.
  // 7. **Subsurface scattering**. WGSL has `computeSubsurfaceScattering`
  //    defined but currently unused — scaffolding for future
  //    enhancement; GLSL has no equivalent.
  //
  // ─── Enhanced Water mask + ocean rendering ───
  if (tile.flags.x > 0.5) {
    let wmTS = tile.waterMaskTranslationAndScale;
    let waterUV = geoUV * wmTS.zw + wmTS.xy;
    let waterMask = textureSampleLevel(waterMaskTexture, waterMaskSampler, waterUV, 0.0).r;

    if (waterMask > 0.01) {
      color = computeEnhancedOcean(
        color, input.v_positionEC, input.v_positionMC, normal, sunDir,
        geoUV, waterMask, dayFade, input.v_distance
      );
    }
  }

  // ┌─────────────────────────────────────────────────────────────────────┐
  // │ PAIR-SECTION: Lighting + Shadow Receive (WGSL) ↔ GLSL                │
  // │   GLSL: Shaders/GlobeFS.glsl ~lines 515-524 (lighting); shadows are  │
  // │         injected by the WebGL pipeline cache via                      │
  // │         `ShadowMapShader.js`, not present in GlobeFS.glsl source.    │
  // │ Last lockstep audit: 2026-05-19, Batch 74                            │
  // └─────────────────────────────────────────────────────────────────────┘
  // Any change to this block MUST land with a matching change in the
  // GLSL counterpart. See migration_doc/SHADER_PAIRS_LOCKSTEP.md.
  //
  // INTENTIONAL ALGORITHMIC REWRITE (Batch ~25, pre-current-batch series)
  // Same overall intent (Lambert diffuse × light) but the coefficients
  // are different and WGSL adds a terminator glow that WebGL lacks.
  //
  // - WebGL has THREE mutually-exclusive lighting variants gated by
  //   #ifdef:
  //     ENABLE_VERTEX_LIGHTING — diffuse with `u_lambertDiffuseMultiplier`
  //       and `u_vertexShadowDarkness` uniforms; multiplies by
  //       `czm_lightColor`. Used for tile-provider-driven custom
  //       lighting.
  //     ENABLE_DAYNIGHT_SHADING — `NdotL × 5 + 0.3` (high-contrast),
  //       mixed with full brightness by `fade` so close-camera tiles
  //       are flat-lit and orbit tiles get full day/night.
  //     (neither) — pass-through, no shading.
  //
  // - WGSL has ONE unified path gated by `camera.enableLighting > 0.5`:
  //     Lambert diffuse `NdotL × 0.88 + ambient(0.12)` × shadowFactor
  //     for day; `nightAmbient = 0.025` for night; mixed by `dayFade`.
  //     Then adds `computeTerminatorGlow(normal, sunDir)` — a warm
  //     orange/pink contribution at the terminator that WebGL doesn't
  //     have.
  //
  // STRUCTURAL DIVERGENCES
  //
  // 1. **Gating mechanism.** GLSL: three #ifdef variants; WGSL: single
  //    runtime gate.
  // 2. **Diffuse coefficients.** GLSL ENABLE_DAYNIGHT path uses
  //    `NdotL × 5 + 0.3` (sharp transition, dark night); WGSL uses
  //    `NdotL × 0.88 + 0.12` (gentler transition, brighter ambient).
  //    Visually distinct day/night terminator shape between backends.
  // 3. **Custom light color.** GLSL multiplies by `czm_lightColor`
  //    (allows scene-provided custom light color). WGSL multiplies by
  //    `camera.lightColor.rgb` packed from `uniformState.lightColor`
  //    (Batch 76). Default white (1,1,1) preserves pre-Batch-76 behavior
  //    for scenes without a custom `scene.light`.
  // 4. **Terminator glow.** WGSL adds it (warm color band at the
  //    day/night boundary); WebGL doesn't.
  // 5. **Shadow receive.** GLSL does NOT contain shadow code; the
  //    WebGL pipeline cache injects shadow-sampling GLSL via
  //    `ShadowMapShader.js` per-pipeline based on the shadow-map
  //    config. WGSL inlines three shadow paths directly:
  //      `globeComputeShadowFactorPointLight` (cube-shadow point light)
  //      `globeComputeShadowFactorCSM` (cascaded shadow maps)
  //      `globeComputeShadowFactor` (single-map default)
  //    gated at the top of `fragmentMain` (see lines ~2380-2420).
  //    The architectural difference is forced by the pipeline-cache
  //    model: WebGL injects per-config GLSL strings; WebGPU uses a
  //    fixed shader with runtime gates.
  // 6. **Vertex-lighting customization.** GLSL ENABLE_VERTEX_LIGHTING
  //    path uses `u_lambertDiffuseMultiplier` and
  //    `u_vertexShadowDarkness` uniforms for tile-provider-driven
  //    shading. WGSL bridges these via `camera.lighting.x/y` (Batch 77),
  //    and gates between the WebGL ENABLE_VERTEX_LIGHTING formula
  //    (direct `NdotL × mult + darkness`) and the existing WGSL
  //    DAYNIGHT_SHADING-analogue path via `camera.lighting.z`
  //    (hasVertexNormals flag from `terrainProvider.hasVertexNormals`).
  //
  // ─── Lambert diffuse lighting + shadow receive ───
  if (camera.enableLighting > 0.5) {
    let NdotL = max(dot(normal, sunDir), 0.0);
    var diffuse: f32;
    if (camera.lighting.z > 0.5) {
      // Batch 77 — VERTEX_LIGHTING path: terrain has vertex normals.
      // Direct linear ramp using tile-provider-supplied coefficients,
      // matching WebGL GlobeFS.glsl ENABLE_VERTEX_LIGHTING (L559):
      //   diffuse = clamp(NdotL × lambertDiffuseMultiplier
      //                   + vertexShadowDarkness, 0, 1)
      // WebGL has no `fade`/`dayFade` mix in this path (the night-side
      // ambient is `vertexShadowDarkness` itself), so WGSL mirrors that.
      // Shadow is applied to the FINAL color after this block (matching
      // WebGL's `out_FragColor.rgb *= visibility`), NOT folded into the
      // Lambert term — so the lit term here is shadow-free.
      let lambertTerm = NdotL * camera.lighting.x;
      diffuse = clamp(lambertTerm + camera.lighting.y, 0.0, 1.0);
    } else {
      // DAYNIGHT_SHADING analogue: terrain has no vertex normals.
      // Keeps the existing WGSL aesthetic (intentional algorithmic
      // rewrite of WebGL's `NdotL × 5 + 0.3` × `fade` path — gentler
      // transition, brighter ambient, separate night ambient).
      let ambient = 0.12;
      // Shadow applied to the final color below, not the Lambert term.
      let dayDiffuse = NdotL * 0.88 + ambient;
      let nightAmbient = 0.025;
      diffuse = mix(nightAmbient, dayDiffuse, dayFade);
    }
    // Batch 76 — `camera.lightColor` mirrors WebGL's `czm_lightColor`
    // automatic uniform. Scene-provided custom light colors (e.g.
    // `scene.light.color = Color.ORANGE`) now propagate to the globe
    // diffuse term on WebGPU, matching GlobeFS.glsl ENABLE_VERTEX_LIGHTING
    // and ENABLE_DAYNIGHT_SHADING which both multiply by `czm_lightColor`.
    // Default is (1,1,1) so non-customized scenes are unchanged.
    color = color * diffuse * camera.lightColor.rgb;

    // Terminator glow: warm atmosphere color right at the day-night boundary
    color += computeTerminatorGlow(normal, sunDir);
  }

  // NEW-CSM-CAST-NO-DISPATCH-VIEWER (Batch 296) — apply the shadow receive
  // ONCE to the final color, independent of `enableLighting`. Mirrors
  // WebGL's `ShadowMapShader.js`: `out_FragColor.rgb *= visibility;` runs
  // outside the lighting branch, so cast shadows darken the surface even
  // when directional lighting is off. `shadowFactor` is 1.0 (no-op) when no
  // shadow mode is active, so lighting-only scenes are unchanged.
  color = color * shadowFactor;

  // Batch 437 (CLOUD-SHADOWS) — darken lit ground under the procedural clouds by
  // the sun-view beer shadow map. Gated on `cloudShadowControl.x` so the default
  // (globe.cloudCastShadows off) leaves `color` byte-identical (the placeholder is
  // never read). `v_positionMC` is the fragment's full ECEF world position.
  if (camera.cloudShadowControl.x > 0.5) {
    color = color * sampleCloudGroundShadow(input.v_positionMC);
  }

  // ┌─────────────────────────────────────────────────────────────────────┐
  // │ PAIR-SECTION: Ground Atmosphere + Fog (WGSL) ↔ GLSL                  │
  // │   GLSL: Shaders/GlobeFS.glsl ~lines 512-603                          │
  // │ Last lockstep audit: 2026-05-19, Batch 72                            │
  // └─────────────────────────────────────────────────────────────────────┘
  // Any change to this block MUST land with a matching change in the
  // GLSL counterpart. See migration_doc/SHADER_PAIRS_LOCKSTEP.md.
  //
  // STRUCTURAL DIVERGENCES (documented, intentional)
  //
  // 1. **Pipeline gating.** GLSL guards the whole block with
  //    `#if defined(GROUND_ATMOSPHERE) || defined(FOG)`; the per-vertex
  //    vs per-fragment scattering split with `#ifdef
  //    PER_FRAGMENT_GROUND_ATMOSPHERE`; the day/night atmo darkening with
  //    `#if defined(DYNAMIC_ATMOSPHERE_LIGHTING) && (ENABLE_VERTEX_LIGHTING
  //    || ENABLE_DAYNIGHT_SHADING)`. WGSL gates everything at runtime via
  //    UBO scalars (`tile.fogDensity > 0`, `tile.groundAtmosphereControl.x
  //    > 0.5`, `camera.atmosphereParams.w > 1.5`). Both produce identical
  //    output for matching state; the WGSL pays a few extra branches per
  //    fragment that the GLSL avoids at shader-compile time.
  //
  // 2. **Per-vertex vs per-fragment ray-march.** GLSL switches between
  //    `v_atmosphereRayleighColor` / `v_atmosphereMieColor` varyings and
  //    a per-fragment `computeAtmosphereScattering` call based on the
  //    `PER_FRAGMENT_GROUND_ATMOSPHERE` define (set CPU-side when
  //    `cameraDist > nightFadeOutDistance` ≈ 10 Mm). WGSL **always** does
  //    per-fragment via `computeAtmosphereScatteringGround` (Batch 56).
  //    The per-vertex path would produce a mesh-pattern artifact at
  //    orbit altitudes because interpolated optical depths diverge across
  //    triangles that span the limb. The per-vertex varyings remain in
  //    the WGSL VS for future use if the close-camera optimization needs
  //    re-introducing.
  //
  // 3. **LUT integration.** WGSL adds a Phase-4 path that samples a
  //    compute-shader-pre-computed atmosphere LUT when available
  //    (`effects.atmosphereLutControl.x > 0.5`) and falls back to the
  //    inline Rayleigh/Mie analytic when not. GLSL has no equivalent —
  //    always uses the inline analytic. Output is identical when the
  //    LUT is unavailable (placeholder path); when LUT is active the
  //    WGSL output is physically more accurate but WebGL has no way to
  //    match (no compute shaders in WebGL2).
  //
  // 4. **HDR gating.** Both backends skip the inline tonemap under HDR
  //    so the post-process chain can do it. GLSL: `#ifndef HDR`. WGSL:
  //    `tile.groundAtmosphereControl.w > 0.5`. Same semantics, different
  //    gate mechanism.
  //
  // 5. **Exposure constant.** Both backends use exposure = 2.0 for the
  //    `1 - exp(-exposure × finalAtmoColor)` tonemap. GLSL spells this
  //    as `fExposure = 2.0` (global const); WGSL spells it as a local
  //    `let exposure: f32 = 2.0;`. Same value.
  //
  // ─── Fog blending + ground atmosphere ───
  // Matches WebGL `czm_fog(distance, color, fogColor)` — mixes color
  // toward fogColor by the fog amount, leaves alpha alone. Upstream
  // does NOT drop alpha at high fog; a previous WGSL-only alpha drop
  // turned distant terrain transparent and exposed the black skybox
  // behind it whenever the camera was tilted toward the horizon, which
  // is the opposite of what fog should do.
  //
  // Phase 4 integration: when the atmosphere LUT is available
  // (compute supported AND the SkyAtmosphere feature renderer has
  // dispatched the compute pass at least once), sample the inscatter
  // LUT for a physically-accurate fog color that matches the visible
  // sky dome exactly. Otherwise fall back to the inline
  // Rayleigh/Mie approximation — both paths use the same `fogAmount`
  // mix factor so switching between them at runtime doesn't pop.
  let fogDensity = tile.fogDensity;
  let groundAtmosphereEnabled = tile.groundAtmosphereControl.x > 0.5;
  if (fogDensity > 0.0 || groundAtmosphereEnabled) {
    // Atmosphere color comes from the shared LUT (Rayleigh + Mie pre-
    // integrated for the current sun direction) or the cheap analytic
    // fallback when the compute LUT hasn't been dispatched yet. Same
    // sampling logic for both delivery paths so switching between fog
    // and far-from-ground drape at the 800-km fog threshold is seamless.
    var atmosphereColor: vec3<f32>;
    var atmosphereOpacity: f32 = 0.0;
    if (effects.atmosphereLutControl.x > 0.5) {
      // Reconstruct camera world position from the RTE-encoded camera.
      // Single-precision subtract is fine here — we're feeding it into
      // a texture sample, not a transform.
      let cameraWC = camera.encodedCameraHigh + camera.encodedCameraLow;
      // Reconstruct fragment world position via the tile-center + RTE.
      let fragmentWorldPos = input.v_positionMC + cameraWC;
      let lut = sampleAtmosphereFogLut(fragmentWorldPos, cameraWC);
      // Use the LUT's inscatter directly when it returns meaningful
      // magnitude; the placeholder texture produces zero so we fall
      // back cleanly in that case.
      let lutLuminance = max(lut.r, max(lut.g, lut.b));
      if (lutLuminance > 0.001) {
        atmosphereColor = lut.rgb;
        atmosphereOpacity = clamp(1.0 - lut.a, 0.0, 1.0);
      } else {
        atmosphereColor = computeAtmosphereColor(
          input.v_positionEC, normal, sunDir,
        );
      }
    } else {
      atmosphereColor = computeAtmosphereColor(
        input.v_positionEC, normal, sunDir,
      );
    }

    // Batch 56 — ground atmosphere: per-fragment ray-march at orbit
    // distances. WebGL `GlobeFS.glsl` switches between per-vertex and
    // per-fragment scattering via `#ifdef PER_FRAGMENT_GROUND_ATMOSPHERE`
    // (defined CPU-side when `cameraDist > nightFadeOutDistance`). At
    // orbit the per-vertex path produces wildly different Rayleigh / Mie
    // values across the tile mesh — short marches (~110m of atmosphere)
    // on near-side vertices vs ~13Mm marches on far-side limb vertices,
    // interpolated linearly across the triangle → mesh-pattern artifact
    // overwriting imagery via `mix(color, draped, fadeAmount=1.0)`.
    // We always do per-fragment here for parity at orbit; the per-vertex
    // varyings remain in the VS so re-introducing the distance gate is
    // a localized future optimization.
    var groundAtmoColor: vec3<f32>;
    var groundAtmoOpacity: f32 = atmosphereOpacity;
    var groundAtmoLightDir: vec3<f32> = vec3<f32>(0.0, 0.0, 1.0);
    if (camera.atmosphereParams.w > 0.5) {
      let cameraWC = camera.encodedCameraHigh + camera.encodedCameraLow;
      let positionWC = input.v_positionMC;
      let viewDir = normalize(positionWC - cameraWC);
      // `w > 1.5` → dynamic lighting active (use the resolved sun /
      // scene-light direction); `w == 1.0` → static lighting, fall
      // back to per-fragment `normalize(positionWC)` to match WebGL's
      // `czm_branchFreeTernary(dynamicLighting, …, normalize(positionWC))`
      // at GlobeFS.glsl line 494.
      let dynamicLightingActive = camera.atmosphereParams.w > 1.5;
      let lightDir = select(
        normalize(positionWC),
        camera.atmosphereLightDirectionAndIntensity.xyz,
        dynamicLightingActive,
      );
      groundAtmoLightDir = lightDir;
      // Per-fragment ray march — same function the VS uses to populate
      // the v_atmosphere* varyings, but evaluated at the fragment's
      // exact world position so neighboring fragments produce
      // numerically-consistent Rayleigh / Mie values.
      let perFragScattering = computeAtmosphereScatteringGround(positionWC, lightDir);
      groundAtmoColor = computeGroundAtmosphereColor(
        viewDir,
        lightDir,
        perFragScattering.rayleigh,
        perFragScattering.mie,
      );
      groundAtmoOpacity = perFragScattering.opacity;
    } else {
      groundAtmoColor = atmosphereColor;
    }

    if (fogDensity > 0.0) {
      // FOG branch — close to the ground. Mirrors GlobeFS.glsl lines
      // 519-533: `czm_fog(distance, color, fogColor, scalar)` mixes
      // imagery toward atmosphere color by a distance-driven scalar.
      let fogAmount = computeFog(input.v_distance, fogDensity, tile.fogVisualDensityScalar);
      var fogColor = groundAtmoColor;
      // Session 65 Batch 41 (NEW-VR2-1) — match WebGL gating for the
      // night-fog darken factor. WebGL `GlobeFS.glsl` lines 522-526:
      //
      //   #if defined(DYNAMIC_ATMOSPHERE_LIGHTING) &&
      //       (defined(ENABLE_VERTEX_LIGHTING) ||
      //        defined(ENABLE_DAYNIGHT_SHADING))
      //     float darken = clamp(dot(normalize(czm_viewerPositionWC),
      //                              atmosphereLightDirection),
      //                          u_minimumBrightness, 1.0);
      //     fogColor *= darken;
      //   #endif
      //
      // Pre-Batch-41 the WGSL applied an UNGATED
      // `nightFogDimming = mix(0.05, 1.0, dayFade)` plus a
      // `max(fogColor * nightFogDimming, fogMinimumBrightness)` floor.
      // For demos with the default `enableLighting = false`
      // (Bloom, Particle System, Lighting, Shadows at ground altitude)
      // WebGL leaves fog at full brightness so the dim ground atmo
      // contribution lets imagery still show through; WebGPU was
      // dimming fog to `fogMinimumBrightness` (default 0.03), which
      // tonemapped + gamma-encodes to ~24 sRGB and overwrote every
      // imagery pixel with that floor at high fog density. Net effect:
      // a flat uniform `(24, 24, 24)` grey across the entire below-
      // horizon area, exactly the disk-bleed-probe symptom flagged
      // under NEW-VR2-1.
      //
      // `camera.atmosphereParams.w > 1.5` mirrors the WebGL
      // `dynamicLighting` bool (Batch 38 encoding: 0 off, 1 static,
      // 2 lit). When dynamic lighting is active we apply a
      // `clamp(dot(viewerNormalized, lightDir), minimumBrightness, 1.0)`
      // multiplier; otherwise the fog color stays at full brightness
      // matching the un-gated WebGL path.
      if (camera.atmosphereParams.w > 1.5) {
        let viewerNormalized = normalize(
          camera.encodedCameraHigh + camera.encodedCameraLow,
        );
        let lightDir = camera.atmosphereLightDirectionAndIntensity.xyz;
        let minBrightness = max(tile.fogMinimumBrightness, 0.0);
        let darken = clamp(dot(viewerNormalized, lightDir), minBrightness, 1.0);
        fogColor = fogColor * darken;
      }
      // HDR-aware tonemap + gamma encode. Mirrors WebGL GlobeFS.glsl
      // `#ifndef HDR` — under HDR the inline tonemap is SKIPPED so the
      // post-process chain can compress the linear-radiance HDR pixels.
      // `tile.groundAtmosphereControl.w` carries the HDR flag.
      if (tile.groundAtmosphereControl.w < 0.5) {
        fogColor = pbrNeutralTonemapAtmosphere(fogColor);
        fogColor = pow(max(fogColor, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2));
      }
      color = mix(color, fogColor, fogAmount);
      // Alpha intentionally untouched — terrain stays opaque through fog.
    } else if (groundAtmosphereEnabled) {
      // Far-from-ground drape — mirrors the WebGL `#else` branch of
      // `#if defined(GROUND_ATMOSPHERE) || defined(FOG)` in GlobeFS.glsl
      // (lines 535-563). FOG is undefined whenever the camera is above
      // Fog.maxHeight (default 800 km), but GROUND_ATMOSPHERE may still
      // be enabled. Without this branch the entire atmospheric drape is
      // missing at orbital altitudes — only the SkyAtmosphere shell at
      // the limb shows, which is the symptom Session 65 was chasing.
      //
      //   transmittance = 0.5 + clamp(1 - opacity, 0, 1)  — brightens
      //     the rim where the view ray takes a longer path through the
      //     atmosphere (limb glow). The LUT-sampled opacity is 0 when
      //     compute isn't available, so transmittance defaults to 1.5.
      //   finalAtmosphereColor = imagery + atmosphereColor × transmittance
      //   finalAtmosphereColor = 1 - exp(-exposure × finalAtmosphereColor)
      //     — per-channel Reinhard-ish tonemap, default exposure = 1.
      //   color = mix(imagery, finalAtmosphereColor, fade)
      //     — fade scalar is pre-computed CPU-side; ramps from 0 at the
      //     fog threshold up to 1 at lightingFadeInDistance (~20 Mm).
      let transmittanceModifier: f32 = 0.5;
      // Use the per-vertex opacity from the Nishita march when atmosphere
      // is enabled (Session 65 Batch 9). Falls through to the LUT-sampled
      // opacity / 0 default when atmosphere is disabled.
      let opacityForDrape = select(
        atmosphereOpacity,
        clamp(1.0 - groundAtmoOpacity, 0.0, 1.0),
        camera.atmosphereParams.w > 0.5,
      );
      let transmittance = transmittanceModifier + opacityForDrape;
      // Session 65 Batch 38 — proper ground-atmosphere integration.
      // The previous Batches 30+31 fix capped the per-channel radiance
      // at 1.5 then scaled by 0.15 to perceptually match WebGL at
      // orbit altitudes. The root cause was NOT the ray-march — the
      // WGSL `computeScatteringGround` port is byte-equivalent to
      // `AtmosphereCommon.glsl::computeScattering`. The over-
      // accumulation came from the WGSL VS always tracing toward the
      // packed sun direction, while WebGL (with the default
      // DynamicAtmosphereLighting.NONE) substitutes
      // `normalize(positionWC)` per-vertex — every vertex sees a
      // "straight up" light ray, so optical depth stays uniform and
      // the integrated radiance lands in the 0.3-0.6 range that
      // matches real orbital photography.
      //
      // Batch 38 fixes that at the source (see VS path + CPU
      // `atmosphereParams.w` repack) so the FS can apply the
      // unscaled WebGL drape math: `color + atmoColor * transmittance`
      // combined with the WebGL `darken` and `sunlitAtmosphereIntensity`
      // mixes from GlobeFS.glsl lines 546-554. No empirical magic
      // numbers in this branch.
      var finalAtmosphereColor = color + groundAtmoColor * transmittance;

      // WebGL GlobeFS.glsl lines 546-554 — the day/night atmosphere
      // mix that produces the correct night-side darkening + day-side
      // limb glow gradient. Only applied when dynamic lighting is
      // active (matches the `#if defined(DYNAMIC_ATMOSPHERE_LIGHTING)
      // && (ENABLE_VERTEX_LIGHTING || ENABLE_DAYNIGHT_SHADING)`
      // GLSL guard).
      //
      //   darken = clamp(dot(normalize(positionWC), lightDir), 0, 1)
      //     1 on sun-facing surface → use full imagery + atmo
      //     0 on night side          → use unmodulated atmo (no imagery
      //                                contribution, terrain colors fall
      //                                back to dim Rayleigh glow)
      //   sunlitAtmosphereIntensity = camera-distance fade. At ground
      //     level the lit/unlit mix favors the unmodulated atmo (atmo
      //     is the dominant visual); at orbit it favors the lit
      //     `finalAtmosphereColor`.
      //
      // `tile.nightFadeOutDistance` / `tile.nightFadeInDistance` carry
      // the camera-distance fade ramp (Globe.js defaults:
      // π/2 × Rmin = ~10 Mm, 5π/2 × Rmin = ~50 Mm). Per-fragment
      // `cameraDist` ≈ distance from camera to surface point,
      // computed from the encoded RTE pair. Floor at 0.05 mirrors
      // GlobeFS.glsl line 550 (clamp lower bound).
      if (camera.atmosphereParams.w > 1.5) {
        let cameraWC2 = camera.encodedCameraHigh + camera.encodedCameraLow;
        let positionWC2 = input.v_positionMC;
        let darken = clamp(
          dot(normalize(positionWC2), groundAtmoLightDir),
          0.0,
          1.0,
        );
        let darkenedAtmo = mix(groundAtmoColor, finalAtmosphereColor, darken);
        let cameraDist = length(positionWC2 - cameraWC2);
        let fadeOut = tile.nightFadeOutDistance;
        let fadeIn = tile.nightFadeInDistance;
        let fadeSpan = max(fadeIn - fadeOut, 1.0);
        let sunlitIntensity = clamp(
          (cameraDist - fadeOut) / fadeSpan,
          0.05,
          1.0,
        );
        finalAtmosphereColor = mix(darkenedAtmo, finalAtmosphereColor, sunlitIntensity);
      }
      // HDR-aware output. Mirrors WebGL GlobeFS.glsl `#ifndef HDR` —
      // under HDR the inline exp tonemap is SKIPPED so the post-process
      // chain can do the compression on linear-radiance HDR pixels.
      // Without this gate, demos that enable HDR (`Atmosphere.html` sets
      // `scene.highDynamicRange = true`) collapse to a uniform tan
      // because the inline `1 - exp(-2 × x)` saturates every channel
      // before the post-process tonemap gets a chance.
      //
      // `tile.groundAtmosphereControl.w` carries the HDR flag CPU-side
      // (Scene mirrors `scene._hdr` onto `frameState.useHDR`). When
      // off, exposure = 2.0 matches the WebGL Reinhard constant from
      // GlobeFS.glsl line 302; when on, we hand the post-process the
      // raw linear-HDR color and let it tonemap downstream.
      var draped: vec3<f32>;
      if (tile.groundAtmosphereControl.w > 0.5) {
        draped = finalAtmosphereColor;
      } else {
        let exposure: f32 = 2.0;
        draped = vec3<f32>(1.0) - exp(-exposure * finalAtmosphereColor);
      }
      let fadeAmount = tile.groundAtmosphereControl.y;
      // Batch 56 — visualize per-vertex v_atmosphereRayleighColor via [13.5e9, 14.5e9].
      if (tile.time > 13.5e9 && tile.time < 14.5e9) {
        return makeFragOutput(vec4<f32>(input.v_atmosphereRayleighColor, 1.0), normalEC);
      }
      // Batch 56 — visualize per-vertex v_atmosphereMieColor via [14.5e9, 15.5e9].
      if (tile.time > 14.5e9 && tile.time < 15.5e9) {
        return makeFragOutput(vec4<f32>(input.v_atmosphereMieColor, 1.0), normalEC);
      }
      // Batch 56 — visualize viewDir via [15.5e9, 16.5e9]. Maps from [-1,1] to [0,1].
      if (tile.time > 15.5e9 && tile.time < 16.5e9) {
        let cameraWC2 = camera.encodedCameraHigh + camera.encodedCameraLow;
        let positionWC2 = input.v_positionMC;
        let viewDir2 = normalize(positionWC2 - cameraWC2);
        return makeFragOutput(vec4<f32>(viewDir2 * 0.5 + 0.5, 1.0), normalEC);
      }
      // Batch 56 — debug: visualize fadeAmount as grayscale via [9.5e9, 10.5e9].
      // If fadeAmount = 1 (white), the imagery is fully replaced by drape.
      if (tile.time > 9.5e9 && tile.time < 10.5e9) {
        return makeFragOutput(vec4<f32>(fadeAmount, fadeAmount, fadeAmount, 1.0), normalEC);
      }
      // Batch 56 — debug: visualize draped color via [10.5e9, 11.5e9].
      if (tile.time > 10.5e9 && tile.time < 11.5e9) {
        return makeFragOutput(vec4<f32>(draped, 1.0), normalEC);
      }
      // Batch 56 — debug: visualize groundAtmoColor only via [11.5e9, 12.5e9].
      if (tile.time > 11.5e9 && tile.time < 12.5e9) {
        return makeFragOutput(vec4<f32>(groundAtmoColor, 1.0), normalEC);
      }
      // Batch 56 — debug: visualize transmittance via [12.5e9, 13.5e9].
      if (tile.time > 12.5e9 && tile.time < 13.5e9) {
        return makeFragOutput(vec4<f32>(transmittance / 5.0, transmittance / 5.0, transmittance / 5.0, 1.0), normalEC);
      }
      color = mix(color, draped, fadeAmount);
    }
  }

  // DP-H24 — Globe hue / saturation / brightness shift. Matches the
  // WebGL GlobeFS.glsl `u_hsbShift` application. Applied AFTER fog so
  // the user's tonal grading touches both imagery and atmospheric
  // haze — same behavior as the reference WebGL path.
  let hsbShift = tile.hsbShift.xyz;
  if (abs(hsbShift.x) > 0.001 || abs(hsbShift.y) > 0.001 || abs(hsbShift.z) > 0.001) {
    var hsb = globe_rgbToHsb(color);
    hsb.x = fract(hsb.x + hsbShift.x);
    hsb.y = clamp(hsb.y + hsbShift.y, 0.0, 1.0);
    hsb.z = clamp(hsb.z + hsbShift.z, 0.0, 1.0);
    color = globe_hsbToRgb(hsb);
  }

  // Batch 58 — end-of-fragment force-bright debug. Trigger via
  // [18.5e9, 19.5e9]. Forces output to (1,0,0,1) regardless of any
  // prior shading. If the displayed canvas pixel is dim red instead of
  // bright red, something between FS output and display is dimming
  // (canvas format, color space, post-process). If bright red, the
  // dimming is in the FS shading path. (Used during Batch 58 to
  // confirm the canvas/display path was clean before bisecting the FS.)
  if (tile.time > 18.5e9 && tile.time < 19.5e9) {
    return makeFragOutput(vec4<f32>(1.0, 0.0, 0.0, 1.0), normalEC);
  }
  // Batch 58 — water-effect-trigger debug. Trigger via [19.5e9, 20.5e9].
  // Renders ocean fragments RED, land fragments GREEN. Verifies the
  // `flags.x` gate is correctly identifying water vs land tiles after
  // the Batch 58 showReflectiveOcean fix.
  if (tile.time > 19.5e9 && tile.time < 20.5e9) {
    if (tile.flags.x > 0.5) {
      let wmTS = tile.waterMaskTranslationAndScale;
      let waterUV = geoUV * wmTS.zw + wmTS.xy;
      let waterMask = textureSampleLevel(
        waterMaskTexture, waterMaskSampler, waterUV, 0.0,
      ).r;
      if (waterMask > 0.01) {
        return makeFragOutput(vec4<f32>(1.0, 0.0, 0.0, 1.0), normalEC); // red = water + reflective ocean enabled
      }
      return makeFragOutput(vec4<f32>(0.5, 0.5, 0.0, 1.0), normalEC); // yellow = tile has water mask but fragment is land
    }
    return makeFragOutput(vec4<f32>(0.0, 1.0, 0.0, 1.0), normalEC); // green = no reflective ocean for this tile
  }

  return makeFragOutput(vec4<f32>(color, alpha), normalEC);
}

// ═══════════════════════════════════════════════════════════════════════
// DP-H24 — RGB ↔ HSB conversion helpers for hue/saturation/brightness
// globe-level tonal shift. Module-scoped and prefixed `globe_` so they
// don't collide with the rgbToHsb/hsbToRgb pair in SkyAtmosphere.wgsl
// (WGSL doesn't have namespaces — the globe + sky shaders can end up
// in the same module graph via shared pipelines).
// ═══════════════════════════════════════════════════════════════════════
fn globe_rgbToHsb(c: vec3<f32>) -> vec3<f32> {
  let maxC = max(c.r, max(c.g, c.b));
  let minC = min(c.r, min(c.g, c.b));
  let delta = maxC - minC;
  var h: f32 = 0.0;
  var s: f32 = 0.0;
  let b = maxC;
  if (delta > 0.001) {
    s = delta / maxC;
    if (c.r >= maxC) { h = (c.g - c.b) / delta; }
    else if (c.g >= maxC) { h = 2.0 + (c.b - c.r) / delta; }
    else { h = 4.0 + (c.r - c.g) / delta; }
    h = h / 6.0;
    if (h < 0.0) { h += 1.0; }
  }
  return vec3<f32>(h, s, b);
}

fn globe_hsbToRgb(hsb: vec3<f32>) -> vec3<f32> {
  let h = fract(hsb.x) * 6.0;
  let s = clamp(hsb.y, 0.0, 1.0);
  let b = clamp(hsb.z, 0.0, 1.0);
  let i = floor(h);
  let f = h - i;
  let p = b * (1.0 - s);
  let q = b * (1.0 - s * f);
  let t = b * (1.0 - s * (1.0 - f));
  let ii = i32(i) % 6;
  if (ii == 0) { return vec3<f32>(b, t, p); }
  if (ii == 1) { return vec3<f32>(q, b, p); }
  if (ii == 2) { return vec3<f32>(p, b, t); }
  if (ii == 3) { return vec3<f32>(p, q, b); }
  if (ii == 4) { return vec3<f32>(t, p, b); }
  return vec3<f32>(b, p, q);
}
