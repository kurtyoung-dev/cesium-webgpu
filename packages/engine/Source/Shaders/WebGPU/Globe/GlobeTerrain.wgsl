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
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

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
};

@group(0) @binding(1) var<uniform> tile: TileUniforms;

// ─── Textures (Group 1): Day imagery (16 slots — Batch 58, C-R5) ───
// WebGPU minimum guarantee for `maxSampledTexturesPerShaderStage` is 16, so
// 16 is the safe ceiling without device-limit probing. Tiles with >16 layers
// fall back to multi-pass rendering (CPU-side, see createTileCommands).
@group(1) @binding(0)  var dayTexture0:  texture_2d<f32>;
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
@group(1) @binding(16) var texSampler: sampler;

// ─── Water mask + Ocean normal map (Group 2, merged) ───
@group(2) @binding(0) var waterMaskTexture: texture_2d<f32>;
@group(2) @binding(1) var waterMaskSampler: sampler;
@group(2) @binding(2) var oceanNormalMap: texture_2d<f32>;
@group(2) @binding(3) var oceanNormalSampler: sampler;

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
    //   .y/.z/.w reserved (cascade count, moon-light flag, etc).
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

// Vector form for gamma-correct on a single vec3 (matches the GLSL
// `czm_gammaCorrect` overload most material expressions use).
fn czm_gammaCorrect(color: vec3<f32>) -> vec3<f32> {
  // Default gamma = 2.2 (display sRGB-like decode is the inverse). The
  // WGSL build doesn't currently honor the runtime `scene.gamma` setter,
  // matching the WebGL path which uses the same constant via
  // `czm_inverseGamma`'s `pow(c, 1/2.2)`.
  return pow(max(color, vec3<f32>(0.0)), vec3<f32>(2.2));
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
fn raySphereIntersectionInterval(
  origin: vec3<f32>,
  dir: vec3<f32>,
  radius: f32,
) -> vec2<f32> {
  let b = 2.0 * dot(dir, origin);
  let c = dot(origin, origin) - radius * radius;
  let disc = b * b - 4.0 * c;
  if (disc < 0.0) {
    return vec2<f32>(0.0, 0.0);
  }
  let sqrtDisc = sqrt(disc);
  return vec2<f32>((-b - sqrtDisc) * 0.5, (-b + sqrtDisc) * 0.5);
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

  // Vertical exaggeration (3D mode only — 2D/Columbus use raw height)
  var exaggeratedPosition = position;
  let exaggeration = tile.verticalExaggeration;
  if (exaggeration != 1.0 && camera.sceneMode > 2.5) {
    let position3D = position + center3D;
    // DP-H25 — prefer the true geodetic surface normal (from
    // TerrainEncoding) over `normalize(position3D)` (the ellipsocentric
    // normal). On WGS84 the two diverge by up to 0.2° at mid-latitudes,
    // which drifts exaggerated terrain away from the ellipsoid surface.
    // Callers that have no geodetic normal attribute pass vec3(0) as a
    // sentinel; dot(n, n) > 0.25 rules out the zero vector AND any
    // non-unit debug noise without paying for a `length()`.
    let hasGeoNormal = dot(geodeticSurfaceNormal, geodeticSurfaceNormal) > 0.25;
    let ellipsoidNormal = select(
      normalize(position3D),
      geodeticSurfaceNormal,
      hasGeoNormal,
    );
    let ellipsoidR = select(
      EARTH_RADIUS_FALLBACK,
      camera.ellipsoidRadius,
      camera.ellipsoidRadius > 1.0,
    );
    let surfaceHeight = length(position3D) - ellipsoidR;
    let relativeHeight = tile.verticalExaggerationRelativeHeight;
    let newHeight = (surfaceHeight - relativeHeight) * exaggeration + relativeHeight;
    let clampedHeight = max(newHeight, -ellipsoidR * 0.5);
    let offset = ellipsoidNormal * (clampedHeight - surfaceHeight);
    exaggeratedPosition = position + offset;
  }

  let position3DWC = exaggeratedPosition + center3D;

  // Scene mode branching
  let mode = camera.sceneMode;

  // Resolve the height used by Morph / Columbus planar projections. Prefer
  // the caller-supplied precomputed height (exact when quantized decodes the
  // [minH, maxH] range, or when uncompressed carries height in position.w);
  // fall back to `length(position3DWC) - EARTH_RADIUS` only as a last resort
  // since that subtraction loses sub-meter precision at Earth radius.
  let useProvidedHeight = precomputedHeight > HEIGHT_SENTINEL_UNAVAILABLE + 1.0;
  let fallbackEllipsoidR = select(
    EARTH_RADIUS_FALLBACK,
    camera.ellipsoidRadius,
    camera.ellipsoidRadius > 1.0,
  );
  let resolvedHeight = select(
    length(position3DWC) - fallbackEllipsoidR,
    precomputedHeight,
    useProvidedHeight,
  );

  if (mode < 0.5) {
    // ── MORPHING ── blend between 3D and 2D positions
    // Note: planar/3D positions are NOT relative-to-eye in this mode, so we
    // use modifiedModelViewProjection (matches WebGL czm_projection * modelView).
    let morphTime = camera.morphTime;
    let planar = computePlanarPosition(resolvedHeight, textureCoordinates);
    let position2DWC = vec4<f32>(planar, 1.0);
    let position3DWC4 = vec4<f32>(position3DWC, 1.0);
    let morphPos = mix(position2DWC, position3DWC4, morphTime);
    out.position = camera.modifiedModelViewProjection * morphPos;
    out.v_positionEC = (camera.modifiedModelView * morphPos).xyz;
  } else if (mode < 1.5) {
    // ── COLUMBUS_VIEW ── planar with terrain height
    let planarPos = computePlanarPosition(resolvedHeight, textureCoordinates);
    out.position = camera.modifiedModelViewProjection * vec4<f32>(planarPos, 1.0);
    out.v_positionEC = (camera.modifiedModelView * vec4<f32>(planarPos, 1.0)).xyz;
  } else if (mode < 2.5) {
    // ── SCENE2D ── top-down orthographic, height forced to 0
    let planarPos = computePlanarPosition(0.0, textureCoordinates);
    out.position = camera.modifiedModelViewProjection * vec4<f32>(planarPos, 1.0);
    out.v_positionEC = (camera.modifiedModelView * vec4<f32>(planarPos, 1.0)).xyz;
  } else {
    // ── SCENE3D ── default RTE path
    //
    // Previous implementation computed `position3DWC = exaggeratedPosition +
    // center3D` at raw f32, which loses ~0.5 m of precision per component at
    // Earth scale, and then fed that as `posHigh` to `translateRelativeToEye`
    // with zero `posLow` — defeating the whole point of the split. The
    // reconstructed-and-then-subtracted camera pair can't recover bits that
    // were lost at the reconstruction step.
    //
    // Correct RTE assembly when the tile is encoded relative to a split
    // `center3DHigh/Low` and vertex positions are tile-local:
    //   rtePos = ((center3DHigh + center3DLow + exaggeratedPosition) - cameraWC)
    //          = (center3DHigh - encodedCameraHigh) +
    //            (center3DLow + exaggeratedPosition - encodedCameraLow)
    // The second term stays small because both `center3DLow` and
    // `encodedCameraLow` are small residuals and `exaggeratedPosition` is
    // tile-relative (~100 m to ~50 km).
    let rtePosition =
      (camera.center3DHigh - camera.encodedCameraHigh) +
      (camera.center3DLow + exaggeratedPosition - camera.encodedCameraLow);
    out.position = camera.mvpRelativeToEye * vec4<f32>(rtePosition, 1.0);
    out.v_positionEC = (camera.modifiedModelView * vec4<f32>(position, 1.0)).xyz;
    out.v_positionRTE = rtePosition;
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
    // WebGL chooses between the configured atmosphere light (sun by
    // default — `DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN`) and the
    // sceneLight direction. The CPU packer makes that choice and feeds
    // a single `atmosphereLightDirectionAndIntensity.xyz` per frame.
    // When dynamic lighting is off, GLSL substitutes
    // `normalize(positionWC)` — but we always pass the resolved light
    // direction from JS so the shader stays branch-free.
    let lightDir = camera.atmosphereLightDirectionAndIntensity.xyz;
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
  // At planetary scale, FP32 rounding in `mvpRelativeToEye * rtePosition`
  // can push clip-space z just over its w, producing an NDC z > 1 that
  // the rasterizer clips as "behind the far plane". The fragments never
  // reach the fragment shader and the globe disappears into whatever was
  // drawn before it (the skybox, which paints everything with
  // depthCompare=always). Clamping z ≤ w forces NDC z ≤ 1 exactly, so
  // these borderline fragments survive rasterization. The paired fix is
  // to use `depthCompare: less-equal` on the pipeline (not `less`) so
  // that a fragment landing exactly on the far plane still passes the
  // depth test against the cleared depth value.
  out.position.z = min(out.position.z, out.position.w);

  return out;
}

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
@vertex
fn vertexMainWebMerc(input: VertexInput) -> VertexOutput {
  let tc = input.textureCoordAndEncodedNormals;
  return processVertex(input.position3DAndHeight.xyz, tc.xy, 0.0, tc.z,
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
  return processVertex(input.position3DAndHeight.xyz, tc.xy, tc.w, tc.z,
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
  // 32896.0 = oct-encoded (0,0,1) up vector \u2014 prevents back-face culling
  return processVertex(position, uv, 32896.0, webMercT,
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
  return processVertex(position, uv, input.compressed1, webMercT,
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
                 baseUV: vec2<f32>, layer: ImageryLayer) -> vec4<f32> {
  let uv = baseUV * layer.translationAndScale.zw + layer.translationAndScale.xy;
  // Use textureSampleLevel (explicit LOD=0) instead of textureSample
  // because this function is called after non-uniform discard/return
  // (clipping planes), and textureSample requires uniform control flow.
  return textureSampleLevel(tex, samp, uv, 0.0);
}

// Select the correct V coordinate per layer based on useWebMercatorT flag
fn selectLayerUV(geoUV: vec2<f32>, webMercT: f32, useWebMerc: f32) -> vec2<f32> {
  let v = select(geoUV.y, webMercT, useWebMerc > 0.5);
  return vec2<f32>(geoUV.x, v);
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

// `boundsUV` is the GEOGRAPHIC tile-UV (always (u_geo, v_geo), independent
// of the layer's `useWebMercatorT` flag). Used for the per-layer
// `texCoordsRect` and `cutoutRectangle` bounds checks, both of which the
// CPU packer writes in geographic tile-UV space (see
// `createTileImagerySkeletons` in `ImageryLayerHelpers.js`, and the
// cutout packer in `WebGPUGlobeSurfaceTileUB.ts` which divides by
// `tile.rectangle.height` — a geographic latitude span). The legacy
// version of this function passed only the Mercator-projected `uv` for
// both sampling AND bounds, which silently zeroed `effectiveAlpha` on
// every tile whose `texCoordsRect.y > 0` (= Mercator imagery covers a
// sub-rect of a non-Mercator terrain tile), producing the wide-spread
// "dark blue at close zoom" symptom. Session 65 Batch 8 (2026-05-12) —
// Cluster 2 from the cross-backend sweep.
fn applyImageryLayer(
  prevColor: vec3<f32>,
  prevAlpha: f32,
  texSample: vec4<f32>,
  boundsUV: vec2<f32>,
  layer: ImageryLayer,
  layerMask: f32,
  fragX: f32,
  splitPositionPx: f32,
  dayNightAlpha: vec2<f32>,
  dayFade: f32,
) -> LayerComposite {
  // 1. colorToAlpha — drop alpha to 0 where the texel matches the key color.
  var sampleAlpha = texSample.a;
  // colorToAlpha.a < 0 disables (default sentinel from CPU packer).
  if (layer.colorToAlpha.a >= 0.0) {
    sampleAlpha = applyColorToAlphaKey(texSample, layer.colorToAlpha);
  }

  // 2. gamma correction (WebGL applies pow before split + brightness/contrast).
  var color = texSample.rgb;
  if (abs(layer.oneOverGamma - 1.0) > 0.0001) {
    color = pow(max(color, vec3<f32>(0.0)), vec3<f32>(layer.oneOverGamma));
  }

  // 3. split — mask the layer's contribution to one half of the screen.
  let splitMask = applySplitMask(layer.split, fragX, splitPositionPx);

  // 4. cutout — drop the layer inside its cutoutRectangle.
  let cutoutMask = applyCutoutMask(boundsUV, layer.cutoutRectangle);

  // 5. brightness → contrast → hue → saturation. Matches WebGL ordering in
  // GlobeFS.glsl `sampleAndBlend` (which applies the four shifts in that
  // exact sequence). Brightness and contrast match `adjustColor` semantics
  // but we inline them here so the hue rotation slots between contrast and
  // saturation (rather than at the very end as in `adjustColor`).
  var adjusted = color * layer.brightness;
  adjusted = (adjusted - 0.5) * layer.contrast + 0.5;
  if (abs(layer.hue) > 0.0001) {
    adjusted = applyHueShift(adjusted, layer.hue);
  }
  let gray = dot(adjusted, vec3<f32>(0.2126, 0.7152, 0.0722));
  adjusted = mix(vec3<f32>(gray), adjusted, layer.saturation);
  adjusted = clamp(adjusted, vec3<f32>(0.0), vec3<f32>(1.0));

  // Compose final alpha contribution: layer alpha × tex alpha × tile-coord
  // mask × day/night mix × isolate mask × split mask × cutout mask.
  let texCoordsMask = texCoordsAlpha(boundsUV, layer.texCoordsRect);
  let dayNightAlphaValue = mix(dayNightAlpha.y, dayNightAlpha.x, dayFade);
  let effectiveAlpha = layerMask
                       * layer.alpha
                       * sampleAlpha
                       * texCoordsMask
                       * dayNightAlphaValue
                       * splitMask
                       * cutoutMask;

  let outColor = mix(prevColor, adjusted, effectiveAlpha);
  let outAlpha = max(prevAlpha, effectiveAlpha);

  return LayerComposite(outColor, outAlpha, adjusted);
}

// ─── Perceptual luminance ───
fn luminance(color: vec3<f32>) -> f32 {
  return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
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
fn computeEnhancedOcean(
  baseColor: vec3<f32>,
  positionEC: vec3<f32>,
  normalEC: vec3<f32>,
  sunDirEC: vec3<f32>,
  uv: vec2<f32>,
  waterMaskValue: f32,
  dayFade: f32,
  distance: f32,
) -> vec3<f32> {
  let viewDir = normalize(-positionEC);
  let deepColor = getOceanDeepColor();
  let darkening = getOceanDarkening();

  // Perturbed normal from multi-octave wave normals
  var waterNormal = normalEC;
  var foamFactor: f32 = 0.0;
  if (tile.flags.z > 0.5) {
    let t = tile.time;
    let waveN = sampleOceanWaveNormals(uv, t);
    // Scale wave intensity with distance (calmer at distance)
    let waveStrength = mix(0.25, 0.05, smoothstep(10000.0, 500000.0, distance));
    waterNormal = normalize(normalEC + waveN * waveStrength);
    foamFactor = computeFoam(waveN, distance);
  }

  // Deep water base color blend
  var oceanColor = mix(baseColor * darkening, deepColor, 0.6);

  // Fresnel reflectivity: more reflective at grazing angles
  let NdotV = max(dot(waterNormal, viewDir), 0.0);
  let fresnel = fresnelSchlick(NdotV, getOceanReflectivity());

  // Session 65 Batch 23 — orbit-altitude limb attenuation (orbit
  // polish §13.2). Real orbital photography shows essentially no
  // ocean sun glint from space — the BRDF-relevant solid angle of
  // the specular highlight subtends a small fraction of a pixel at
  // orbit altitudes. Bruneton & Neyret 2008 derive this from the
  // microfacet distribution: at near-vertical NdotV the visible
  // highlight area shrinks proportional to camera distance.
  //
  // We approximate this with a smoothstep curve from full intensity
  // at <= 100 km altitude (where helicopter / aerial views still
  // show ocean glint) to zero at >= 1 Earth radius (orbit). Both
  // the GGX specular highlight AND the subsurface-scattering rim
  // get the same attenuation factor so the limb sun-glare patch
  // disappears at orbit without breaking ground-level reflections.
  let cameraWC = camera.encodedCameraHigh + camera.encodedCameraLow;
  let altitudeMeters = max(0.0, length(cameraWC) - 6378137.0);
  let orbitGateMin: f32 = 100000.0;     // 100 km — start fading
  let orbitGateMax: f32 = 6378137.0;    // 1 Earth radius — fully gated
  let orbitGateT = clamp(
    (altitudeMeters - orbitGateMin) / max(1.0, orbitGateMax - orbitGateMin),
    0.0, 1.0,
  );
  let orbitSmooth = orbitGateT * orbitGateT * (3.0 - 2.0 * orbitGateT);
  let orbitAttenuation = 1.0 - orbitSmooth;

  if (camera.enableLighting > 0.5) {
    // GGX specular for sun reflection on water
    let halfDir = normalize(viewDir + sunDirEC);
    let NdotH = max(dot(waterNormal, halfDir), 0.0);
    let NdotL = max(dot(waterNormal, sunDirEC), 0.0);
    let specular = distributionGGX(NdotH, 0.08) * fresnel * NdotL;

    // Sun specular highlight (bright, tight) — orbit-attenuated.
    oceanColor += vec3<f32>(1.0, 0.95, 0.85) * min(specular, 8.0) * orbitAttenuation;

    // Subsurface scattering — orbit-attenuated.
    oceanColor += computeSubsurfaceScattering(viewDir, sunDirEC, waterNormal) * orbitAttenuation;
  }

  // Environment/sky reflection blended via Fresnel
  let skyReflection = computeAtmosphereColor(positionEC, waterNormal, sunDirEC);
  oceanColor = mix(oceanColor, skyReflection, fresnel * 0.5);

  // Foam: white overlay on steep wave crests
  let foamColor = vec3<f32>(0.85, 0.9, 0.92);
  oceanColor = mix(oceanColor, foamColor, foamFactor);

  // Night-side ocean: darker, moonlit
  let nightDarkening = mix(0.08, 1.0, dayFade);
  oceanColor *= nightDarkening;

  // Smooth water mask transition at coastlines
  let coastBlend = smoothstep(0.3, 0.7, waterMaskValue);
  return mix(baseColor, oceanColor, coastBlend);
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
  return textureSampleCompareLevel(
    cascadeDepthArray,
    shadowCompSampler,
    uv,
    i32(cascadeIdx),
    depth,
  );
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
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let geoUV = input.v_textureCoordinates.xy;
  let webMercT = input.v_textureCoordinates.z;

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
  if (tile.time > 1.0e9) {
    return vec4<f32>(geoUV.x, geoUV.y, webMercT, 1.0);
  }

  // Compute shadow factor early — textureSampleCompare must be called
  // from uniform control flow (before any non-uniform discard/return).
  // camera.enableLighting is a uniform value so this branch is uniform.
  // CSM Slice 1: route through the cascaded-shadow path when enabled.
  // Reconstruct world-space fragment position via the atmosphere LUT
  // convention (`v_positionMC + cameraWC`); view-space depth is the
  // magnitude of `v_positionEC.z` (right-handed view, camera at origin
  // looking -Z).
  var shadowFactor: f32 = 1.0;
  if (camera.enableLighting > 0.5) {
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
      return effects.clippingEdgeColor;
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
        return effects.clippingEdgeColor;
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

  // Base color: dark for first pass (night side will be very dark),
  // transparent for subsequent multi-pass imagery.
  var color: vec3<f32>;
  var alpha: f32;
  if (isSubsequentPass) {
    color = vec3<f32>(0.0, 0.0, 0.0);
    alpha = 0.0;
  } else {
    color = vec3<f32>(0.04, 0.04, 0.06);
    alpha = 1.0;
  }

  let normal = normalize(input.v_normalEC);
  let sunDir = normalize(camera.sunDirectionEC);

  // Day/night fade factor: 0 = night, 1 = day
  let dayFade = computeDayNightFade(normal, sunDir);
  // Inverse for night-side effects
  let nightBlend = 1.0 - dayFade;

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
    let uv = selectLayerUV(geoUV, webMercT, tile.useWebMercatorTLayer[0].x);
    let tex = sampleImagery(dayTexture0, texSampler, uv, layer);
    let dna = tile.dayNightAlpha[0].xy;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 0);
    let r = applyImageryLayer(color, alpha, tex, geoUV, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 2u) {
    let layer = tile.layers[1];
    let uv = selectLayerUV(geoUV, webMercT, tile.useWebMercatorTLayer[0].y);
    let tex = sampleImagery(dayTexture1, texSampler, uv, layer);
    let dna = tile.dayNightAlpha[0].zw;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 1);
    let r = applyImageryLayer(color, alpha, tex, geoUV, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 3u) {
    let layer = tile.layers[2];
    let uv = selectLayerUV(geoUV, webMercT, tile.useWebMercatorTLayer[0].z);
    let tex = sampleImagery(dayTexture2, texSampler, uv, layer);
    let dna = tile.dayNightAlpha[1].xy;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 2);
    let r = applyImageryLayer(color, alpha, tex, geoUV, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 4u) {
    let layer = tile.layers[3];
    let uv = selectLayerUV(geoUV, webMercT, tile.useWebMercatorTLayer[0].w);
    let tex = sampleImagery(dayTexture3, texSampler, uv, layer);
    let dna = tile.dayNightAlpha[1].zw;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 3);
    let r = applyImageryLayer(color, alpha, tex, geoUV, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 5u) {
    let layer = tile.layers[4];
    let uv = selectLayerUV(geoUV, webMercT, tile.useWebMercatorTLayer[1].x);
    let tex = sampleImagery(dayTexture4, texSampler, uv, layer);
    let dna = tile.dayNightAlpha[2].xy;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 4);
    let r = applyImageryLayer(color, alpha, tex, geoUV, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 6u) {
    let layer = tile.layers[5];
    let uv = selectLayerUV(geoUV, webMercT, tile.useWebMercatorTLayer[1].y);
    let tex = sampleImagery(dayTexture5, texSampler, uv, layer);
    let dna = tile.dayNightAlpha[2].zw;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 5);
    let r = applyImageryLayer(color, alpha, tex, geoUV, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 7u) {
    let layer = tile.layers[6];
    let uv = selectLayerUV(geoUV, webMercT, tile.useWebMercatorTLayer[1].z);
    let tex = sampleImagery(dayTexture6, texSampler, uv, layer);
    let dna = tile.dayNightAlpha[3].xy;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 6);
    let r = applyImageryLayer(color, alpha, tex, geoUV, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 8u) {
    let layer = tile.layers[7];
    let uv = selectLayerUV(geoUV, webMercT, tile.useWebMercatorTLayer[1].w);
    let tex = sampleImagery(dayTexture7, texSampler, uv, layer);
    let dna = tile.dayNightAlpha[3].zw;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 7);
    let r = applyImageryLayer(color, alpha, tex, geoUV, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 9u) {
    let layer = tile.layers[8];
    let uv = selectLayerUV(geoUV, webMercT, tile.useWebMercatorTLayer[2].x);
    let tex = sampleImagery(dayTexture8, texSampler, uv, layer);
    let dna = tile.dayNightAlpha[4].xy;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 8);
    let r = applyImageryLayer(color, alpha, tex, geoUV, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 10u) {
    let layer = tile.layers[9];
    let uv = selectLayerUV(geoUV, webMercT, tile.useWebMercatorTLayer[2].y);
    let tex = sampleImagery(dayTexture9, texSampler, uv, layer);
    let dna = tile.dayNightAlpha[4].zw;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 9);
    let r = applyImageryLayer(color, alpha, tex, geoUV, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 11u) {
    let layer = tile.layers[10];
    let uv = selectLayerUV(geoUV, webMercT, tile.useWebMercatorTLayer[2].z);
    let tex = sampleImagery(dayTexture10, texSampler, uv, layer);
    let dna = tile.dayNightAlpha[5].xy;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 10);
    let r = applyImageryLayer(color, alpha, tex, geoUV, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 12u) {
    let layer = tile.layers[11];
    let uv = selectLayerUV(geoUV, webMercT, tile.useWebMercatorTLayer[2].w);
    let tex = sampleImagery(dayTexture11, texSampler, uv, layer);
    let dna = tile.dayNightAlpha[5].zw;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 11);
    let r = applyImageryLayer(color, alpha, tex, geoUV, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 13u) {
    let layer = tile.layers[12];
    let uv = selectLayerUV(geoUV, webMercT, tile.useWebMercatorTLayer[3].x);
    let tex = sampleImagery(dayTexture12, texSampler, uv, layer);
    let dna = tile.dayNightAlpha[6].xy;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 12);
    let r = applyImageryLayer(color, alpha, tex, geoUV, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 14u) {
    let layer = tile.layers[13];
    let uv = selectLayerUV(geoUV, webMercT, tile.useWebMercatorTLayer[3].y);
    let tex = sampleImagery(dayTexture13, texSampler, uv, layer);
    let dna = tile.dayNightAlpha[6].zw;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 13);
    let r = applyImageryLayer(color, alpha, tex, geoUV, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 15u) {
    let layer = tile.layers[14];
    let uv = selectLayerUV(geoUV, webMercT, tile.useWebMercatorTLayer[3].z);
    let tex = sampleImagery(dayTexture14, texSampler, uv, layer);
    let dna = tile.dayNightAlpha[7].xy;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 14);
    let r = applyImageryLayer(color, alpha, tex, geoUV, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }
  if (count >= 16u) {
    let layer = tile.layers[15];
    let uv = selectLayerUV(geoUV, webMercT, tile.useWebMercatorTLayer[3].w);
    let tex = sampleImagery(dayTexture15, texSampler, uv, layer);
    let dna = tile.dayNightAlpha[7].zw;
    let mask = select(0.0, 1.0, isolate < 0 || isolate == 15);
    let r = applyImageryLayer(color, alpha, tex, geoUV, layer, mask, fragX, splitPositionPx, dna, dayFade);
    color = r.color; alpha = r.alpha;
    color = applyNightLightsEmission(color, r.adjustedColor, nightBlend, dna.y, dna.x);
  }

  // Subsequent passes only apply imagery — skip all effects
  if (isSubsequentPass) {
    return vec4<f32>(color, alpha);
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
  matInput.normalEC = normalize(input.v_normalEC);
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

  // ─── Enhanced Water mask + ocean rendering ───
  if (tile.flags.x > 0.5) {
    let wmTS = tile.waterMaskTranslationAndScale;
    let waterUV = geoUV * wmTS.zw + wmTS.xy;
    let waterMask = textureSampleLevel(waterMaskTexture, waterMaskSampler, waterUV, 0.0).r;

    if (waterMask > 0.01) {
      color = computeEnhancedOcean(
        color, input.v_positionEC, normal, sunDir,
        geoUV, waterMask, dayFade, input.v_distance
      );
    }
  }

  // ─── Lambert diffuse lighting + shadow receive ───
  if (camera.enableLighting > 0.5) {
    let NdotL = max(dot(normal, sunDir), 0.0);
    let ambient = 0.12;
    // shadowFactor was pre-computed at the top of fragmentMain
    let dayDiffuse = NdotL * 0.88 * shadowFactor + ambient;
    let nightAmbient = 0.025;
    let diffuse = mix(nightAmbient, dayDiffuse, dayFade);
    color = color * diffuse;

    // Terminator glow: warm atmosphere color right at the day-night boundary
    color += computeTerminatorGlow(normal, sunDir);
  }

  // ─── Fog blending ───
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

    // ─── Session 65 Batch 9 (Cluster 2b/5): proper per-vertex
    // Rayleigh+Mie scattering, applied with per-fragment phase functions
    // and PBR Neutral tonemap + inverse gamma encode. Prefers per-vertex
    // data over the dim analytic fallback / LUT — only falls through to
    // the latter when the atmosphere wasn't enabled CPU-side.
    var groundAtmoColor: vec3<f32>;
    var groundAtmoOpacity: f32 = atmosphereOpacity;
    if (camera.atmosphereParams.w > 0.5) {
      // Per-fragment view direction (camera → fragment, world space).
      let cameraWC = camera.encodedCameraHigh + camera.encodedCameraLow;
      let fragmentWorldPos = input.v_positionMC + cameraWC;
      let viewDir = normalize(fragmentWorldPos - cameraWC);
      let lightDir = camera.atmosphereLightDirectionAndIntensity.xyz;
      groundAtmoColor = computeGroundAtmosphereColor(
        viewDir,
        lightDir,
        input.v_atmosphereRayleighColor,
        input.v_atmosphereMieColor,
      );
      groundAtmoOpacity = input.v_atmosphereOpacity;
    } else {
      groundAtmoColor = atmosphereColor;
    }

    if (fogDensity > 0.0) {
      // FOG branch — close to the ground. Mirrors GlobeFS.glsl lines
      // 519-533: `czm_fog(distance, color, fogColor, scalar)` mixes
      // imagery toward atmosphere color by a distance-driven scalar.
      let fogAmount = computeFog(input.v_distance, fogDensity, tile.fogVisualDensityScalar);
      // Daytime atmosphere darken-by-view: when dynamic lighting is on
      // the WebGL path mixes a viewer-direction × light-direction
      // brightness factor (`u_minimumBrightness` floor). Matches GLSL
      // lines 522-526. Defaults to 1.0 when lighting isn't dynamic.
      var fogColor = groundAtmoColor;
      let nightFogDimming = mix(0.05, 1.0, dayFade);
      fogColor = max(fogColor * nightFogDimming, vec3<f32>(tile.fogMinimumBrightness));
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
      let finalAtmosphereColor = color + groundAtmoColor * transmittance;
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

  return vec4<f32>(color, alpha);
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
