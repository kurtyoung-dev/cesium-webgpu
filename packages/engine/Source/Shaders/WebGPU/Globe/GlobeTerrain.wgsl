// Globe Terrain Shader — WebGPU
//
// Renders terrain tiles with RTE (Relative-To-Eye) positioning.
// Supports up to MAX_TEXTURES imagery layers per tile.
// Uses tile-center-relative vertex positions + u_center3D for full ECEF.
//
// References for the atmosphere terms:
//   - Eric Bruneton and Fabrice Neyret, "Precomputed Atmospheric Scattering",
//     Computer Graphics Forum 27(4), 1079 (2008) —
//     https://hal.inria.fr/inria-00288758
//     The transmittance and inscatter lookup tables the ground pass samples,
//     and the Rayleigh and Mie coefficients they are built from.
//   - Sean O'Neil, "Accurate Atmospheric Scattering", GPU Gems 2 (2005) — the
//     analytic fallback the non-lookup path follows, which is also the model
//     this project's WebGL globe uses.
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

// Camera uniforms (group 0, binding 0).
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
  ellipsoidInverseRadiiX: f32,
  encodedCameraLow: vec3<f32>,
  ellipsoidInverseRadiiY: f32,
  // Tile encoding center in ECEF, emulated f64 via high/low split.
  // Raw f32 center3D (up to ~6.4e6 m for Earth) loses ~0.5 m of precision
  // per component, which defeats the RTE emulation when combined with
  // tile-local positions. Keeping the split lets the SCENE3D branch do
  // proper (center3DHigh - encodedCameraHigh) + (center3DLow - encodedCameraLow)
  // subtraction and preserve sub-meter precision at orbital altitudes.
  center3DHigh: vec3<f32>,
  ellipsoidInverseRadiiZ: f32,
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
  // 2D / Columbus View support.
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
  // Last frame's viewProjection, captured by `UniformState.update()` before
  // it overwrites `_viewProjection` with the new camera state. Motion-vector
  // passes read this to reproject the current fragment into the previous
  // frame's NDC. On the first frame it holds `Matrix4.IDENTITY`
  // (`UniformState` constructor default), which is indistinguishable from a
  // real identity view, so motion-vector output gates on a separate
  // valid-history flag rather than on matrix contents.
  previousViewProjection: mat4x4<f32>,
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
  // Mirrors WebGL's `czm_lightColor` automatic uniform. Read by the Lambert
  // diffuse path so a scene-provided custom light color (`scene.light.color`)
  // reaches the globe. White (1,1,1) when no custom light is set. `.w` is
  // reserved.
  lightColor: vec4<f32>,
  // Custom Lambert coefficients, supplied by the tile provider.
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
  //       when <= 0.5, the Lambert path runs WebGL's ENABLE_DAYNIGHT_SHADING
  //       formula `mix(1, clamp(NdotL × 5 + 0.3, 0, 1), fade)`.
  //   w = zoomedOutOceanSpecularIntensity. Mirrors WebGL's
  //       `u_zoomedOutOceanSpecularIntensity`, which `Globe.beginFrame` sets
  //       per-frame: 0.4 when showGroundAtmosphere (the default), 0.5
  //       otherwise, 0.0 outside SCENE3D. Consumed by `computeEnhancedOcean`'s
  //       specular surfaceReflectance.
  // The day/night camera-distance fade is not carried here; it is a
  // per-tile-UB scalar, `TileUniforms.lightingFade`, packed in the same pass
  // as `nightFade*Distance`.
  lighting: vec4<f32>,
  // Renderer-wide log depth.
  //   x = frustum near, y = frustum far,
  //   z = oneOverLog2FarDepthFromNearPlusOne (the log-depth factor),
  //   w = reserved.
  // Packed unconditionally by WebGPUGlobeSurfaceCameraUB from the live
  // frustum; the `//>>ifdef LOG_DEPTH` blocks below are the only readers, and
  // that define is set only when `isWebGPULogDepthActive(context, frameState)`
  // holds (master switch AND `frameState.useLogDepth`). When it does not — 2D,
  // Columbus View, any orthographic frustum, or `logarithmicDepthBuffer` off —
  // no `@builtin(frag_depth)` member exists in FragOutput and the globe writes
  // the rasterizer's hyperbolic NDC z, matching every sibling producer sharing
  // the attachment. See WebGPULogDepth.ts.
  logDepth: vec4<f32>,
  // The globe's registered pick-ID color, read only by `fragmentPickMain`.
  // Packed at the camera-UB tail by WebGPUGlobeSurfaceCameraUB, so it shifts
  // no existing offset. (0,0,0,0) unless `globe.pickable` is set: the pick
  // framebuffer still receives globe depth — which is what
  // `scene.pickPosition` needs, matching WebGL's `updateForPick` re-push —
  // but writes a zero pick color, leaving `scene.pick` undefined over the
  // globe as on WebGL. With `globe.pickable` set this carries the real
  // pick-ID color and `scene.pick` returns the Globe.
  pickColor: vec4<f32>,
  // Sun-view cloud beer-shadow-map projection. `cloudShadowVP` maps a world
  // (ECEF) position into the sun's orthographic clip space; the fragment
  // shader projects the fragment, reads the cloud optical-depth column from
  // `cloudShadowMap` (group 2 binding 9), and darkens the lit ground by
  // transmittance = exp(-depth·absorption). `cloudShadowControl`: x = enabled
  // (1.0 when globe.cloudCastShadows is set and a real map was rendered), y =
  // absorptionCoeff, so exp() matches the cloud render, z = strength (0..1
  // darkening scale), w = reserved. (identity, 0,0,0,0) by default, keeping
  // the fragment gate (`x > 0.5`) closed and the render unchanged.
  cloudShadowVP: mat4x4<f32>,
  cloudShadowControl: vec4<f32>,
  // Underground tint, the twin of GlobeFS' UNDERGROUND_COLOR path.
  // Mirrors WebGL's `u_undergroundColor` + `u_undergroundColorAlphaByDistance`
  // (GlobeFS.glsl lines 123-126, applied at lines 735-744).
  //   undergroundColor — globe.undergroundColor RGBA.
  //   undergroundColorAlphaByDistance — NearFarScalar packed as
  //     (near, nearValue, far, farValue).
  //   undergroundControl:
  //     x = show flag. Mirrors WebGL's `showUndergroundColor` compile-time
  //         gate: isUndergroundVisible(tileProvider, frameState) && SCENE3D
  //         && undergroundColor.alpha > 0 && (nearValue > 0 || farValue > 0).
  //     y = max(czm_eyeHeight, 0) — camera height above the ellipsoid
  //         (WebGL reads the `czm_eyeHeight` automatic uniform in the FS;
  //         the clamped value is packed CPU-side).
  //     z, w = reserved.
  // All-zero by default, keeping the fragment gate
  // (`undergroundControl.x > 0.5`) closed and the render unchanged when the
  // feature is off.
  undergroundColor: vec4<f32>,
  undergroundColorAlphaByDistance: vec4<f32>,
  undergroundControl: vec4<f32>,
  // Per-fragment translucent-globe alpha.
  // Mirrors WebGL's `u_frontFaceAlphaByDistance` / `u_backFaceAlphaByDistance`
  // (GlobeFS.glsl lines 112-114, applied at lines 746-751 under `#ifdef
  // TRANSLUCENT`). Each is a NearFarScalar packed (near, nearValue, far,
  // farValue) — globe.translucency.frontFaceAlpha × frontFaceAlphaByDistance
  // resolved CPU-side by GlobeTranslucencyState.update, with WebGL's
  // camera-underground front/back swap pre-applied
  // (GlobeSurfaceTileProviderRendering.js:1487-1492).
  //   translucencyControl.x = enable flag — mirrors the WebGL TRANSLUCENT
  //     compile-time define, emitted exactly when
  //     `globeTranslucencyState.translucent` (front faces translucent).
  //     y, z, w = reserved.
  // All-zero by default, keeping the fragment gate
  // (`translucencyControl.x > 0.5`) closed and the render unchanged when
  // globe.translucency is disabled.
  translucencyFrontAlphaByDistance: vec4<f32>,
  translucencyBackAlphaByDistance: vec4<f32>,
  translucencyControl: vec4<f32>,
  // `czm_gammaCorrect` gate.
  // x = 1.0 when `scene.highDynamicRange` is on (`frameState.useHDR`),
  //     mirroring WebGL's single `HDR` define, which
  //     `DerivedCommand.createHdrCommand` pushes on `scene._hdr` alone rather
  //     than on the presence of an HDR canvas. Under HDR, `czm_gammaCorrect`
  //     decodes sRGB to linear as WebGL's `#ifdef HDR` path does, so the
  //     post-process Tonemap stage — enabled on the same `highDynamicRange`
  //     flag — can tonemap and re-encode the linear radiance. Gating instead
  //     on an actual HDR canvas leaves imagery un-decoded while Tonemap still
  //     gamma-encodes it, which double-encodes into a twice-bright globe.
  //     Matches the globe's own atmosphere/fog gate
  //     (`groundAtmosphereControl.w`, also `frameState.useHDR`).
  // y = czm_gamma (uniformState.gamma, default 2.2).
  // z, w = reserved.
  // All-zero by default, which leaves `czm_gammaCorrect` an identity no-op
  // and the SDR render unchanged.
  hdrControl: vec4<f32>,
  // Cloud-shadow cascade tail.
  // When the opt-in `cloudShadowCascades` tier is active, the cloud beer-shadow-
  // map is rendered as three cascades (near/mid/far, geometric ÷3 footprints)
  // stacked into a 512×1536 atlas bound at `cloudShadowMap`. `cloudShadowVP` (the
  // existing mid-struct field) is the NEAR cascade's world→sun-clip matrix;
  // `cloudShadowVP1`/`cloudShadowVP2` are the mid/far ones. `cloudShadowControl.w`
  // carries the cascade count (3.0 when active, 0 otherwise). The fragment
  // shader picks the finest cascade whose footprint contains the fragment.
  // All-zero with count 0 by default, so `sampleCloudGroundShadow` takes the
  // single-map branch and the render is unchanged when the tier is off.
  cloudShadowVP1: mat4x4<f32>,
  cloudShadowVP2: mat4x4<f32>,
  // x = atlas tile count (3.0 when the cascade atlas is bound, else 0).
  // y = eye-relative flag: > 0.5 means every `cloudShadowVP*` above is
  //     `worldToSunClip * translate(camera)`, so the fragment shader must
  //     project `v_positionRTE`. 0 keeps the absolute matrices and
  //     `v_positionMC` for the planar scene modes. z, w reserved.
  cloudShadowCascadeParams: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// Eclipse uniforms (group 0, binding 2).
//
// Dedicated terrain-global carrier, prepared once per logical View/frame and
// reused by every tile/pass. It deliberately does not live in CameraUniforms:
// camera UBs are per tile/pass, while this 64-byte payload changes only with
// the eclipse geometry/View. The two body vectors are geocentric so capture
// cameras can reuse the same carrier:
//   sunDirectionAndInvRange.xyz       = normalize(S_ECEF)
//   sunDirectionAndInvRange.w         = 1 / length(S_ECEF)
//   moonDirectionDeltaAndInvRange.xyz = normalize(M_ECEF) - normalize(S_ECEF)
//   moonDirectionDeltaAndInvRange.w   = 1 / length(M_ECEF)
// params.x is the five-state gate (0 inert, 1 active/custom light,
// 2 active/SunLight, 3 correction-only/SunLight, 4 correction-only/custom);
// params.y is the reciprocal of the camera-anchored eclipse factor already
// applied at the uniform source, so a fragment-local factor can divide it back
// out; params.zw and params2.w are the limb-darkening fit. params2.x is the
// radiometric floor; params2.yz carry the exposure exponent and antumbral lift.
struct EclipseUniforms {
  sunDirectionAndInvRange: vec4<f32>,
  moonDirectionDeltaAndInvRange: vec4<f32>,
  params: vec4<f32>,
  params2: vec4<f32>,
};

@group(0) @binding(2) var<uniform> eclipseUniforms: EclipseUniforms;

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

// Tile imagery uniforms (group 0, binding 1).
//
// The per-layer struct carries hue, oneOverGamma, split, colorToAlpha
// (vec4 = rgb + threshold; threshold < 0 disables) and cutoutRectangle (vec4
// in tile-UV space; zero-area disables). The layout is alignment-driven: vec4
// fields first, then a 4-scalar slot, then a second 4-scalar slot for the
// remaining per-layer scalars. 24 floats / 96 bytes per layer × 16 = 1536 B.
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
  // Night and ocean enhancement parameters. Every slot in these two vec4s
  // uses a negative value as the "CPU supplied nothing, use the shader
  // default" marker (see the getters below and
  // `WebGPUGlobeTunables.GLOBE_UB_UNSET`); a zero here is a real, honoured
  // zero.
  // oceanParams: x=deepR, y=deepG, z=deepB, w=fresnelPower
  oceanParams: vec4<f32>,
  // nightOceanParams: x=nightIntensity, y=oceanReflectivity, z=foamThreshold, w=oceanDarkening
  nightOceanParams: vec4<f32>,
  time: f32,
  // Modulates the fog exponential to match WebGL's
  // `czm_fog(dist, color, fogColor, scalar)`. Default 0.15.
  fogVisualDensityScalar: f32,
  // splitPosition in framebuffer pixels (matches @builtin(position).x).
  // CPU side multiplies `frameState.splitPosition` (a 0..1 fraction) by
  // `drawingBufferWidth`, mirroring WebGL's `czm_splitPosition` auto-uniform.
  splitPosition: f32,
  // WebGL's day/night camera-distance fade, `GlobeFS.glsl:642`:
  //   fade = clamp((cameraDist - fadeOutDist) / (fadeInDist - fadeOutDist), 0, 1)
  // Computed CPU-side from `globe.lightingFadeOutDistance` /
  // `lightingFadeInDistance`, because the WGSL has neither `czm_view` nor
  // `czm_frustumPlanes` to reproduce GLSL's per-scene-mode `cameraDist`.
  // 0 near the ground, where the day/night diffuse is mixed to full brightness
  // and the globe renders flat-lit as it does on WebGL; 1 at orbit, where the
  // ramp applies in full. Distinct from `groundAtmosphereControl.y`, which
  // carries the same clamp but is forced to zero whenever the
  // ground-atmosphere drape is off; the lighting fade has no such gate on
  // WebGL, so it needs its own slot.
  lightingFade: f32,
  // Per-tile controls. The first two fields are diagnostics; the third is an
  // explicit Globe appearance control:
  //   x = tileLevel — LOD depth integer (read by fragmentDebugLod)
  //   y = isolateImageryLayer — index 0..15 to render alone, or -1 for all
  //                              (read by fragmentMain when set)
  //   z = optional terminator-glow strength; 0 is the natural/parity identity
  //   w = reserved
  tileControls: vec4<f32>,
  // Globe hue/saturation/brightness shift. When any channel
  // is non-zero (|shift| > 0.001) the final composite color is
  // converted to HSB, shifted, and converted back. Matches the
  // WebGL path's `u_hsbShift` in GlobeFS.glsl.
  //   x = hueShift (-inf..+inf, wrapped via fract)
  //   y = saturationShift (-1..+1, clamped)
  //   z = brightnessShift (-1..+1, clamped)
  //   w = padding
  hsbShift: vec4<f32>,
  // Ground-atmosphere drape control. WebGL delivers atmospheric color over
  // the planet disk through two paths: the fog branch close to the ground,
  // and the `#else` `lightingFade` branch far from it. This slot drives the
  // far-from-ground one; without it, above roughly 800 km — where fog is
  // disabled — the disk carries no drape at all and only the SkyAtmosphere
  // shell at the limb remains visible.
  //   x = enable flag (1.0 if showGroundAtmosphere AND fade > 0)
  //   y = fade scalar (pre-computed CPU-side; same formula as
  //       GlobeFS.glsl line 391 — drives the final mix factor between
  //       imagery and atmosphere color)
  //   z = atmosphereLightIntensity
  //   w = reserved
  groundAtmosphereControl: vec4<f32>,
  // WebGL's `u_initialColor`: `globe.baseColor` on the first pass, which is
  // what shows where no imagery is available, and transparent black on
  // subsequent multi-pass imagery passes (WebGL's `otherPassesInitialColor`).
  initialColor: vec4<f32>,
  // WebGL's `u_translucencyRectangle`
  // (GlobeFS.glsl `inTranslucencyRectangle()`): `globe.translucency.rectangle`
  // antimeridian-clipped and localized to this tile's UV space
  // (west, south, east, north), packed by WebGPUGlobeSurfaceTileUB. The
  // translucency alpha multiply only applies to fragments STRICTLY inside
  // this rectangle (matches WebGL's `>` / `<` tests). The default
  // Rectangle.MAX_VALUE localizes to a rect containing [0,1]² so every
  // fragment qualifies. All-zero when translucency is off — inert because
  // the `camera.translucencyControl.x` gate is closed then anyway.
  localizedTranslucencyRectangle: vec4<f32>,
  // Ocean-wave relative-to-eye phase decomposition. The f64-computed per-tile,
  // per-octave phase offsets fract(rectOriginNorm × Rᵢ) keep the sampled
  // ellipsoid-UV coordinate small: the absolute `euv × Rᵢ` reaches ~2.7e6 for
  // the 15 m ripple, where an f32 ulp is ~0.25 of a repeat, which stair-steps
  // the wave into bands and freezes its advection.
  // See WebGPUGlobeSurfaceTypes.ts offsets 484-491.
  //   oceanWavePhaseA: (.xy)=octave1 phase (u,v), (.zw)=octave2 phase (u,v)
  oceanWavePhaseA: vec4<f32>,
  //   oceanWavePhaseB: (.xy)=octave3 phase (u,v),
  //                    (.zw)=oceanWaveSpanNorm (normalized ellipsoid-UV tile
  //                          span: width×1/2π, height×1/π — packed to dodge the
  //                          f32 east−west cancellation that would seam scales).
  oceanWavePhaseB: vec4<f32>,
};

@group(0) @binding(1) var<uniform> tile: TileUniforms;

// Textures (group 1): day imagery, 16 slots.
// WebGPU minimum guarantee for `maxSampledTexturesPerShaderStage` is 16, so
// 16 is the safe ceiling without device-limit probing. Tiles with >16 layers
// fall back to multi-pass rendering (CPU-side, see createTileCommands).
@group(1) @binding(0)  var dayTexture0:  texture_2d<f32>;
@group(1) @binding(1)  var dayTexture1:  texture_2d<f32>;
@group(1) @binding(2)  var dayTexture2:  texture_2d<f32>;
@group(1) @binding(3)  var dayTexture3:  texture_2d<f32>;
//>>ifdef GLOBE_IMAGERY_REDUCED
// Reduced layout for default-limit adapters, where
// `maxSampledTexturesPerShaderStage` is 16 — SwiftShader CI and compat mode.
// Only dayTexture0..3 are declared; the globe's 12 non-imagery sampled
// textures bring the total to exactly 16. Multi-layer tiles multi-pass at up
// to four layers per pass, with the CPU-side slicing keyed off the renderer's
// `_imagerySlotCount`. `texSampler` stays at @binding(16) in both variants so
// the JS bind-group builder shares one shape.
//>>else
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

// Water mask and ocean normal map (group 2, merged).
@group(2) @binding(0) var waterMaskTexture: texture_2d<f32>;
@group(2) @binding(1) var waterMaskSampler: sampler;
@group(2) @binding(2) var oceanNormalMap: texture_2d<f32>;
@group(2) @binding(3) var oceanNormalSampler: sampler;
// Sun-view cloud beer-shadow map: single-channel cloud optical depth rendered
// from the sun's orthographic view. Bound unconditionally — the TypeScript
// layout always declares 9/10 — so the pipeline layout never forks; a 1×1 zero
// placeholder (optical depth 0, so transmittance 1 and no shadow) is bound when
// globe.cloudCastShadows is off. Sampled only inside the
// `cloudShadowControl.x > 0.5` gate, so the off path never reads it.
@group(2) @binding(9) var cloudShadowMap: texture_2d<f32>;
@group(2) @binding(10) var cloudShadowSampler: sampler;

// Draped vector-tile polylines: the WGSL twin of `VectorCommon.glsl`'s five
// `u_vector*` sampler2D lookup tables. The GLSL side uses `texelFetch` purely
// as WebGL2's stand-in for a buffer read — nearest sampling, integer
// coordinates, power-of-two padding, no filtering — and WebGPU has real
// read-only storage buffers, so the whole per-tile lookup set collapses into
// one binding instead of five sampled textures. The collapse is forced, not
// stylistic: group 2 already charges 5 of the 12 non-imagery fragment sampled
// textures the globe layout is allowed
// (`GLOBE_NON_IMAGERY_FRAGMENT_TEXTURES`), and on a default-limit adapter
// (`maxSampledTexturesPerShaderStage` = 16, the WebGPU spec floor — SwiftShader
// CI and compat mode) the reduced 4-slot imagery layout already lands on
// exactly 16. Five more sampled textures would take it to 21 and break the
// globe pipeline outright on those devices. A storage buffer costs nothing
// against that budget.
//
// Bound unconditionally, on the same discipline as the cloud shadow map above,
// so the pipeline layout never forks per tile: tiles with no clamped vector
// data bind a 32-byte all-zero placeholder whose `gridWidth` header word is 0,
// and `vectorPolylineRender` returns the untouched base color after a single
// u32 load. WebGL forks the shader instead (`#ifdef HAS_VECTOR_LAYER`,
// shader-set flag bit `0x400000000`); a per-tile define here would fork every
// globe pipeline variant, so the gate is a runtime header read.
//
// Word layout (see `WebGPUVectorTileResources.ts` — the packer and this reader
// are a matched pair; neither may change alone):
//   [0] gridWidth   [1] gridHeight   [2] segmentCount   [3] primitiveCount
//   [4] cellEndOffsetsBase           [5] segmentsBase
//   [6] segmentPrimitiveIndicesBase  [7] primitivesBase
//   cell end offsets : gridWidth*gridHeight u32
//   segments         : segmentCount * 4 f32 (ax, ay, bx, by) in tile UV space
//   segment→primitive: segmentCount u32
//   primitives       : primitiveCount * (f32 lineWidth, u32 packed RGBA8)
@group(2) @binding(11) var<storage, read> vectorTileData: array<u32>;

// Effects bind group (group 3): shadow receive and clipping planes.
// The `clipPlaneEqHW` slots hold the precomputed
// `dPrime[i] = d + dot(n, camera)` values for the hardware clip-distances
// pipeline variant. Slots beyond `clippingPlaneCount` (or beyond 8) carry
// +Infinity so the rasterizer never clips against them. The
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
    // Each entry is (n.xyz, dPrime); unused slots are (0,0,0,+inf).
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
    // Cascaded shadow map control:
    //   .x = csmEnabled flag (>0.5 → sample cascade depth array at
    //        bindings 10/11 via `sampleCascadeShadow`; otherwise use
    //        the single shadow map at bindings 1/2)
    //   .y = PCF kernel radius in shadow texels.
    //        >0 → `sampleOneCascade` runs a 3x3 PCF box kernel (soft
    //        edges, matches WebGL czm_shadowVisibility USE_SOFT_SHADOWS);
    //        0 → single hardware-comparison tap (hard edge).
    //   .z/.w reserved (cascade count, moon-light flag, etc).
    // Matches `CSM_CONTROL_OFFSET` on the JS side.
    csmControl: vec4<f32>,
    // Inline edge-detection slots at offsets 272/288. The globe shader does
    // not run that stage; these two vec4s exist to keep byte-parity with the
    // shared 480-byte effects UBO packed by `WebGPUEffectsBindGroup.js`, which
    // the model fragment shader consumes. Omitting them slides
    // `pointLightControl` below onto offset 272 — the edgeControl slot, always
    // zero for globe bind groups — instead of 304, which silently disables
    // globe point-light receive.
    edgeControl: vec4<f32>,
    edgeViewport: vec4<f32>,
    // Point-light cube shadow control. Laid out identically to the model
    // shader's EffectsUniforms tail so both shaders read the same bytes from
    // the shared effects uniform buffer, which is what lets globe terrain
    // receive point-light shadows without a buffer of its own.
    //   .x = pointLightActive flag (>0.5 → sample binding 17 via
    //        `globeSamplePointShadow`)
    //   .y = far plane (light radius)
    //   .z = near plane (typically 1.0)
    //   .w = depth bias
    // Matches model shader's `pointLightControl` at offset 304.
    pointLightControl: vec4<f32>,
    // .xyz = light position relative to the active camera origin, in world
    // axes (ECEF axes for SCENE3D).
    // .w = PCF radius in cube-face texels (0 → hard sampling). Matches
    // model shader's `pointLightPositionRTE` at offset 320.
    pointLightPositionRTE: vec4<f32>,
    // Polygon-clipping atlas control and merged-extent UV remap at offsets
    // 336/352 — see the model shader's EffectsUniforms tail and
    // `WebGPUEffectsBindGroup.js`:
    //   clippingPolygonControl = (extentsCount, 1/atlasDim, inverseFlag, _)
    //   clippingPolygonExtents[i] = (south, west, invLatRange, invLonRange)
    // in spherical fastApproximateAtan2 coordinates (matches the CPU pack
    // in `ClippingPolygonCollection.packPolygonsAsFloats`).
    clippingPolygonControl: vec4<f32>,
    clippingPolygonExtents: array<vec4<f32>, 8>,
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
// Atmosphere lookup tables for fog color. The transmittance LUT gives
// Beer-Lambert attenuation for a view ray's altitude and zenith angle; the
// inscatter LUT gives the scattered sky color along that ray. Both are
// precomputed by the AtmosphereLUT compute pass from the same scattering
// parameters the SkyAtmosphere shell uses, which is what keeps terrain fog
// matching the visible atmosphere dome. Gated on
// `effects.atmosphereLutControl.x > 0.5`; placeholder 1×1 float
// textures bind here when the LUT isn't ready yet, producing a
// transmittance of 0 that makes the LUT path a no-op (falls through
// to the inline atmosphere color).
@group(3) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(3) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(3) @binding(9) var atmosphereLutSampler: sampler;
// Cascaded shadow map bindings. Always present in the layout, zero-filled
// with placeholders when cascades are disabled, so no second pipeline variant
// is needed. Sampled only when `effects.csmControl.x > 0.5` via
// `sampleCascadeShadow`.
@group(3) @binding(10) var<uniform> csmParams: CSMParams;
@group(3) @binding(11) var cascadeDepthArray: texture_depth_2d_array;
// Point-light cube depth target, shared with the model receive path. The
// shared `EffectsBindGroupLayout` in WebGPUEffectsBindGroup declares this at
// binding 17. Bound to a 1×1×6 placeholder cleared to depth 1.0 when no point
// light is active, so the bind group always validates; the
// `effects.pointLightControl.x > 0.5` gate skips sampling in that case.
@group(3) @binding(17) var pointLightCubeDepth: texture_depth_cube;

// Globe material slots, a group 2 extension. The material uniform buffer and
// its textures live at bindings 4-8 of group 2, alongside the water-mask and
// ocean-normal bindings 0-3. That keeps the total bind-group count at the
// WebGPU spec floor of 4, which matters because some implementations — Edge's
// adapter among them — report `maxBindGroups: 4` exactly. The layout matches
// the JS-side `_bindGroupLayout2` declaration.
//
// When MATERIAL_APPLY is not set, the JS side still binds placeholder
// resources to these slots so the pipeline layout does not drift between
// material and non-material pipelines. The WGSL declarations are emitted
// unconditionally; only the fragment shader's use of them is gated, via
// `//>>ifdef MATERIAL_APPLY` at the call site.
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

// Vertex input and output.
//
// The `@location(2) geodeticSurfaceNormal` slot is conditionally declared in
// all three input structs via the `GEODETIC_NORMAL` preprocessor define. When
// active, the TypeScript pipeline builder adds the matching attribute over the
// trailing 12 bytes of each tile's vertex stride, so the exaggeration branch
// in `processVertex` can use the true WGS84 geodetic normal. When inactive the
// attribute is absent and callers pass `vec3<f32>(0.0)` as the sentinel, on
// which the exaggeration branch falls back to `normalize(position3D)`.
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
// at location 1 — see TerrainEncoding.getAttributes:683-691. The WebGPU
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
  // Output of the vertex-stage ground-atmosphere ray-march. The fragment
  // shader owns the production ground-atmosphere integration and runs it per
  // fragment unconditionally, so these varyings feed only the per-vertex debug
  // visualizers (`tile.time ∈ [13.5e9,15.5e9]`); the vertex-stage march runs
  // only in that debug window and otherwise leaves them zero. Even when
  // active, the fragment shader still applies the Rayleigh and Mie phase
  // functions per fragment — the Mie phase varies sharply with view angle, so
  // it has to be evaluated per pixel — and modulates by the global light
  // intensity.
  @location(6) v_atmosphereRayleighColor: vec3<f32>,
  @location(7) v_atmosphereMieColor: vec3<f32>,
  @location(8) v_atmosphereOpacity: f32,
  // Per-vertex slope, height and aspect for globe materials, mirroring the
  // WebGL GlobeVS outputs `v_slope` / `v_aspect` / `v_height` gated by
  // `#ifdef APPLY_MATERIAL`. Emitted unconditionally: 3 floats per vertex is
  // cheaper than a separate vertex shader variant per material. Consumers:
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

// Fallback used only if the CPU never uploads a real ellipsoid radius. WGS84
// equatorial radius. Shader code should prefer `camera.ellipsoidRadius`.
const EARTH_RADIUS_FALLBACK: f32 = 6378137.0;
const PI: f32 = 3.14159265358979;

// Default ocean and night parameters, substituted when the CPU supplied no
// value. "Unset" is a negative slot, never `0.0`: every tunable below has a
// legitimate zero — `Globe.nightIntensity = 0` is documented as no emission, a
// foam threshold of 0 is foam everywhere, a darkening of 0 is no darkening —
// so reading zero as "unset" makes the real zero unreachable and aliases every
// off path that writes 0.0 onto default-on.
//
// The domains are all non-negative magnitudes, so the negative half-line is
// unreachable from the API and carries "unset" without colliding with anything
// a caller can ask for. `WebGPUGlobeTunables.GLOBE_UB_UNSET` (-1.0) is the
// CPU twin of this test; the two must move together.
fn getOceanDeepColor() -> vec3<f32> {
  let p = tile.oceanParams;
  // Negative red channel = unset (the packer writes the marker to all three).
  if (p.x < 0.0) {
    return vec3<f32>(0.008, 0.045, 0.12);
  }
  return vec3<f32>(p.x, p.y, p.z);
}

fn getFresnelPower() -> f32 {
  let p = tile.oceanParams.w;
  return select(p, 5.0, p < 0.0);
}

fn getNightIntensity() -> f32 {
  let n = tile.nightOceanParams.x;
  return select(n, 2.5, n < 0.0);
}

fn getOceanReflectivity() -> f32 {
  let r = tile.nightOceanParams.y;
  return select(r, 0.04, r < 0.0);
}

fn getFoamThreshold() -> f32 {
  let f = tile.nightOceanParams.z;
  return select(f, 0.35, f < 0.0);
}

fn getOceanDarkening() -> f32 {
  let d = tile.nightOceanParams.w;
  return select(d, 0.6, d < 0.0);
}

// Relative-to-eye translation.
fn translateRelativeToEye(posHigh: vec3<f32>, posLow: vec3<f32>,
                          camHigh: vec3<f32>, camLow: vec3<f32>) -> vec4<f32> {
  let highDiff = posHigh - camHigh;
  let lowDiff = posLow - camLow;
  return vec4<f32>(highDiff + lowDiff, 1.0);
}

// Sanitizes a per-vertex `webMercatorT` against NaN, substituting the
// geographic V — the same value WebGL falls back to when `useWebMercatorT` is
// false. The CPU-side formula in
// `HeightmapTessellator.geodeticLatitudeToMercatorAngle` produces ±Infinity at
// latitude ±90°, and Cesium's per-tile normalization
// (`(mercY − southMercY) × oneOverMercatorHeight`) turns that into NaN for
// polar-spanning tiles whose south or north edge sits exactly at ±90°. WGSL's
// `step()` and `select()` follow strict IEEE on NaN and return false, which
// collapses the imagery `texCoordsAlpha` mask to zero and renders the pole as
// a black hole. WebGL's GLSL drivers deviate from strict IEEE here and treat
// NaN as always in range, so polar imagery rasterizes there despite the NaN.
// Tiles entirely within ±85° arrive finite and pass through unchanged.
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

// Decompresses two 12-bit values packed into a single float.
fn decompressTextureCoordinates(compressed: f32) -> vec2<f32> {
  let temp = compressed / 4096.0;
  let xZeroTo4095 = floor(temp);
  return vec2<f32>(
    xZeroTo4095 / 4095.0,
    (compressed - xZeroTo4095 * 4096.0) / 4095.0
  );
}

// Web Mercator latitude conversion.
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

// Shared vertex processing.
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

// Vector form of gamma-correct on a single vec3.
//
// The GLSL `czm_gammaCorrect` (gammaCorrect.glsl) is gated on `#ifdef HDR` and
// is a no-op on the default SDR path. This mirrors that branch at runtime via
// `camera.hdrControl` (x = gate, y = czm_gamma). The gate is raised whenever
// `scene.highDynamicRange` is on (`frameState.useHDR`), matching WebGL's
// single HDR define and the WebGPU post-process Tonemap stage, which is
// enabled on the same flag; under HDR the sRGB-to-linear decode hands linear
// radiance to the post-process chain to tonemap and re-encode. Applying the
// decode unconditionally instead darkens every globe fragment by roughly 4.2x
// against WebGL.
fn czm_gammaCorrect(color: vec3<f32>) -> vec3<f32> {
  if (camera.hdrControl.x > 0.5) {
    return pow(max(color, vec3<f32>(0.0)), vec3<f32>(camera.hdrControl.y));
  }
  return color;
}

// vec4 overload preserves alpha unchanged. Some material `source` blocks
// call gammaCorrect on a vec4 (like the GLSL ElevationContour does);
// matching that here keeps the WGSL ports byte-clean.
fn czm_gammaCorrect4(color: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(czm_gammaCorrect(color.rgb), color.a);
}

// Nishita-style ground atmosphere ray-march.
//
// Direct port of `computeScattering` from `Source/Shaders/AtmosphereCommon.glsl`
// and `computeAtmosphereScattering` from `Source/Shaders/GroundAtmosphere.glsl`.
// Runs in the vertex shader, following the WebGL pattern: per-vertex
// accumulation outputs interpolate cleanly when combined with per-fragment
// Rayleigh and Mie phase functions in the fragment shader. Interpolating after
// the phase would be wrong, because the Mie phase is sharply forward-peaked.
//
// A fixed sky-blue tint in place of this integral is not an adequate
// substitute: it has neither the right magnitude nor the
// view-direction-dependent thickness term, so the fog color collapses to the
// same value at every view angle and drags imagery toward it at low altitudes.
//
// Constants match `Source/Shaders/AtmosphereCommon.glsl`:
//   PRIMARY_STEPS_MAX = 16   — number of primary-ray sample positions
//   LIGHT_STEPS_MAX   =  4   — number of light-ray sample positions per primary
//   ATMOSPHERE_THICKNESS = 111e3, matching the GLSL; packed CPU-side.

const ATMOSPHERE_PRIMARY_STEPS_MAX: i32 = 16;
const ATMOSPHERE_LIGHT_STEPS_MAX: i32 = 4;

struct AtmosphereScattering {
  rayleigh: vec3<f32>,
  mie: vec3<f32>,
  opacity: f32,
};

// Tangent approximation matching czm_approximateTanh — quintic polynomial
// good over the |x| <= 2 range it is used in (`x` is a normalized ratio).
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
// The formulation is precision-stable. The naive
//   `c = dot(origin, origin) - radius*radius`
// loses about 10 m for a Cesium-scale camera at 1.6e7 m, because 1.6e7 squared
// is 2.56e14, past the integer range of an f32 24-bit mantissa. WebGL carries
// the same imprecision in `czm_raySphereIntersectionInterval` and still
// renders correctly at orbit, so this is not what makes the orbital view work
// — the per-fragment ground-atmosphere path is. It is kept because it is
// cheap, and because ray-sphere intersection also serves the sky atmosphere
// LUT, the volumetric clouds and planetary collision, where the precision loss
// can matter on its own.
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
    // shell. The segment length sizes each LIGHT_STEPS sub-step.
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

  // Vertical exaggeration.
  //
  // WebGL applies exaggeration in every scene mode (GlobeVS.glsl:245-258): it
  // exaggerates the vertex height attribute
  // (`newHeight = (height − rel)*exag + rel`), offsets the 3D position along
  // the ellipsoid normal by `(newHeight − height)`, and feeds `newHeight` to
  // the planar `getPositionPlanarEarth`, which uses height as the projected X
  // axis. Mirroring it exactly is what keeps SCENE3D, COLUMBUS_VIEW and
  // MORPHING consistent; gating the position offset to `sceneMode > 2.5` and
  // feeding the planar legs raw height renders CV and morph terrain flat and
  // pops a morph between an exaggerated 3D leg and a flat planar one.
  //
  // The exaggeration applies to the height attribute (`resolvedHeight`), not
  // to `length(position3D) − radius`. Skirt vertices carry a reduced height
  // attribute (edgeHeight − skirtHeight, HeightmapTessellator.js:399), so a
  // taller skirt quad still points down below the surface and stays occluded
  // by the adjacent tile as it does in WebGL. Exaggerating the geometric
  // `length()` height instead shatters the skirts into visible vertical walls.
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

  // Exaggerated height (WebGL `newHeight`), clamped so it cannot pass through
  // the earth's centre. Equals `resolvedHeight` when verticalExaggeration is
  // 1.0. Consumed by the planar legs and by the 3D position offset.
  let exaggeratedHeight =
    (resolvedHeight - exagRelativeHeight) * exaggeration + exagRelativeHeight;
  let planarHeight = max(exaggeratedHeight, -fallbackEllipsoidR);

  // 3D position offset along the geodetic ellipsoid normal. Applied whenever
  // exaggeration is active: the SCENE3D leg and the MORPHING 3D component both
  // consume `exaggeratedPosition`, while CV and 2D do not use it for
  // out.position, so the offset is harmless there.
  var exaggeratedPosition = position;
  if (exaggeration != 1.0) {
    // Prefer the true geodetic surface normal over the ellipsocentric
    // `normalize(rawPosition3D)`; they diverge up to 0.2° at mid-latitudes.
    // Callers with no geodetic normal pass vec3(0); dot(n,n) > 0.25 rules out
    // the zero vector AND non-unit debug noise without paying for a `length()`.
    let hasGeoNormal = dot(geodeticSurfaceNormal, geodeticSurfaceNormal) > 0.25;
    let ellipsoidNormal = select(
      normalize(rawPosition3D),
      geodeticSurfaceNormal,
      hasGeoNormal,
    );
    // WebGL's attribute-based `offset = ellipsoidNormal * (newHeight − height)`.
    // For non-skirt vertices the attribute is the terrain height, so this
    // matches a `length()`-based offset; skirts differ, but are hidden in 3D.
    exaggeratedPosition =
      position + ellipsoidNormal * (planarHeight - resolvedHeight);
  }

  let position3DWC = exaggeratedPosition + center3D;

  if (mode < 0.5) {
    // MORPHING: blend between 3D and 2D positions.
    // Planar and 3D positions are not relative-to-eye in this mode, so this
    // uses modifiedModelViewProjection, matching WebGL's
    // czm_projection * modelView.
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
    // COLUMBUS_VIEW: planar with terrain height.
    let planarPos = computePlanarPosition(planarHeight, textureCoordinates);
    out.position = camera.modifiedModelViewProjection * vec4<f32>(planarPos, 1.0);
    out.v_positionEC = (camera.modifiedModelView * vec4<f32>(planarPos, 1.0)).xyz;
  } else if (mode < 2.5) {
    // SCENE2D: top-down orthographic, height forced to 0.
    let planarPos = computePlanarPosition(0.0, textureCoordinates);
    out.position = camera.modifiedModelViewProjection * vec4<f32>(planarPos, 1.0);
    out.v_positionEC = (camera.modifiedModelView * vec4<f32>(planarPos, 1.0)).xyz;
  } else {
    // SCENE3D: relative-to-centre transform, mirroring WebGL
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

  // Per-vertex ground-atmosphere ray-march. Gated on
  // `camera.atmosphereParams.w > 0.5`, set CPU-side when fog or ground
  // atmosphere is enabled, and confined to SCENE3D — 2D, Columbus View and
  // Morph use planar positions, so the world-coordinate math does not apply.
  // When skipped, the v_atmosphere* outputs stay at zero and the fragment
  // shader's additive contribution evaluates to a no-op.
  out.v_atmosphereRayleighColor = vec3<f32>(0.0);
  out.v_atmosphereMieColor = vec3<f32>(0.0);
  out.v_atmosphereOpacity = 0.0;
  // The fragment shader owns the production ground-atmosphere integration:
  // `fragmentMain` recomputes scattering per fragment via
  // `computeAtmosphereScatteringGround` unconditionally, because the
  // per-vertex fast path produces a mesh-pattern artifact at orbit altitude.
  // The only consumers of these v_atmosphere* varyings are the two per-vertex
  // debug visualizers in `fragmentMain` (`tile.time ∈ [13.5e9, 15.5e9]`,
  // written debug-build-only by `WebGPUGlobeFragmentDebug`), so marching the
  // up-to-16×4 per-vertex ray every production frame would compute a result
  // nothing reads. Gating the march on the same debug window leaves exactly
  // one stage owning the work per path: production marches per fragment only,
  // while the per-vertex debug modes still march here so the visualizers show
  // real per-vertex scattering.
  let perVertexAtmoDebugActive = tile.time > 13.5e9 && tile.time < 15.5e9;
  if (perVertexAtmoDebugActive && camera.atmosphereParams.w > 0.5 && mode > 2.5) {
    // `atmosphereParams.w` carries the lighting mode:
    //   1.0 → dynamic lighting OFF → substitute normalize(positionWC)
    //   2.0 → dynamic lighting ON  → use the packed light direction
    // Mirrors WebGL GlobeFS.glsl line 494:
    //   lightDirection = czm_branchFreeTernary(
    //       dynamicLighting, atmosphereLightDirection, normalize(positionWC));
    // Without the fallback the march traces toward the real sun direction in
    // both modes, producing 7-10× more scattering on the dayside than the
    // WebGL no-dynamic-lighting reference.
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

  // Per-vertex slope, aspect and height for globe materials.
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

  // Far-plane clip-space z clamp, required at orbit altitude. FP32 rounding in
  // the SCENE3D clip transform can push a front fragment's clip-space z just
  // past its w, giving NDC z > 1, which the rasterizer clips as behind the far
  // plane and which shows on screen as radial wedge-gaps through to the
  // skybox. Clamping z to w holds NDC z at or below 1 so those borderline
  // front fragments survive. Paired with `depthCompare: less-equal`, so a
  // fragment landing exactly on the far plane still passes against the cleared
  // depth.
  //
  // The clamp is load-bearing independently of the SCENE3D relative-to-centre
  // transform: removing it reintroduces the whole-globe wedge-gap tear at
  // 12 Mm. It also pins genuinely far back-limb level-0 fragments to z = 1 at
  // extreme zoom-out, which contributes to — but does not cause — the
  // far-camera ring residual; that residual is a level-0 vertex precision warp
  // inside the frustum and survives the clamp's removal.
  out.position.z = min(out.position.z, out.position.w);

  return out;
}

// Vertex shader entry points. The GLSL counterpart is
// `Shaders/GlobeVS.glsl`, a single `void main()` with `#ifdef` variants for
// every terrain encoding; a change to these entry points has to land with a
// matching change there. See SHADER_PAIRS_LOCKSTEP.md.
//
// The two backends split the work differently, and this is the widest
// structural divergence in the globe shader pair.
//
// - WebGL `GlobeVS.glsl` is one `void main()` of roughly 286 lines that
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
//   The WebGL pipeline cache compiles a different shader variant per tile
//   based on the active defines.
//
// - WGSL has six explicit `@vertex` entry points, all routed through a
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
// - WGSL uses the custom `//>>ifdef FLAG_NAME / //>>else / //>>endif`
//   preprocessor implemented in `WebGPUShaderPreprocessor.ts` for
//   define-bit-driven variants such as `GEODETIC_NORMAL`. Its surface is far
//   smaller than GLSL's full preprocessor: boolean ifdefs against a uint32
//   `ShaderDefine` bitmask registered in `WebGPUShaderDefines.ts`, and the
//   define bits are stable and add-only.
//
// The split follows from those two facts. GLSL's preprocessor is rich enough
// to handle every variant inline and the WebGL pipeline cache compiles a fresh
// shader per define-set, so a new variant there costs a few `#ifdef` lines.
// WGSL has no equivalent preprocessor and WebGPU pipeline creation wants a
// single shader module with multiple entry points, so the six-entry split
// makes vertex-attribute layout an entry-point property rather than a
// preprocessor result, which fits WGSL's typed `@location` model.
//
// Both backends produce the same varyings downstream of `main()` /
// `processVertex()`:
//   position (built-in clip-space)
//   v_textureCoordinates (vec3: u, v, webMercatorT)
//   v_positionEC, v_positionMC, v_normalEC, v_normalMC
//   v_distance (when fog, atmosphere or underground is active)
//   v_atmosphereRayleighColor, v_atmosphereMieColor, v_atmosphereOpacity
//     (WGSL keeps these varyings even though per-fragment atmosphere is the
//     active path)
//   v_slope, v_aspect, v_height (when APPLY_MATERIAL is active)
// The per-fragment math downstream consumes the same varyings on both
// backends, so fragment-stage parity holds despite the vertex-stage split.
//
// Vertex shader for uncompressed terrain, used when hasWebMercatorT is false.
// The normal, if present, is in the .z component; with no normals .z is 0, the
// default fill from the float32x2 format. webMercatorT defaults to the
// geographic V (textureCoordinates.y).
//
// Every entry point routes the geodetic normal into `processVertex` through
// the same conditional expression: with `GEODETIC_NORMAL` active the real
// per-vertex attribute flows through, and otherwise the `vec3<f32>(0.0)`
// sentinel engages the ellipsocentric fallback in the exaggeration branch.
// Keeping the dispatch inline is what removes the need for six parallel
// `*_Geo` entry points.

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

// Vertex shader for uncompressed terrain with webMercatorT and no normals.
// Vertex data is [u, v, webMercatorT], with webMercatorT in .z.
//
// `sanitizeWebMercatorT` replaces the NaN that
// `HeightmapTessellator.js:325` produces for vertices exactly at ±90°
// latitude: `0.5 * log((1+sin(±π/2))/(1-sin(±π/2)))` is ±Infinity in
// JavaScript, and the CPU formula then computes `±Infinity * (1 /
// mercatorHeight)`. WebGL's GLSL propagates the NaN through the per-fragment
// `step()` mask, which most drivers resolve to 1.0 against the spec, so the
// imagery still renders. WGSL is stricter: a NaN comparison in `step()`
// returns 0, which zeroes `texCoordsAlpha`, then `effectiveAlpha`, leaving the
// imagery composite contributing nothing and the pole rendered as a black hole.
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

// Vertex shader for uncompressed terrain with webMercatorT and normals.
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

// Vertex shader for quantized terrain (BITS12).
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

// Vertex shader for quantized terrain with webMercatorT and no normals.
// When hasWebMercatorT=true but hasNormals=false, compressed0.w stores the
// COMPRESSED webMercatorT. No normal available — use a hardcoded up vector.
@vertex
fn vertexMainQuantizedWebMerc(input: VertexInputQuantized) -> VertexOutput {
  let xy = decompressTextureCoordinates(input.compressed0.x);
  let zh = decompressTextureCoordinates(input.compressed0.y);
  let scaledPos = vec3<f32>(xy.x, xy.y, zh.x);
  let position = (camera.scaleAndBias * vec4<f32>(scaledPos, 1.0)).xyz;
  let uv = decompressTextureCoordinates(input.compressed0.z);
  let webMercT = decompressTextureCoordinates(input.compressed0.w).x;
  let safeWebMercT = sanitizeWebMercatorT(webMercT, uv.y);
  // 32896.0 = oct-encoded (0,0,1) up vector — prevents back-face culling
  return processVertex(position, uv, 32896.0, safeWebMercT,
                       decodeQuantizedHeight(zh.y),
                       //>>ifdef GEODETIC_NORMAL
                       input.geodeticSurfaceNormal);
                       //>>else
                       vec3<f32>(0.0));
                       //>>endif
}

// Vertex shader for quantized terrain with webMercatorT and normals.
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

// Fragment shader helpers

// Imagery sampling with translation and scale.
// baseUV: the per-layer UV (geographic or webMercator, selected by caller)
// Note: WebGL does NOT clamp to texCoordsRect — the sampler's clamp-to-edge
// mode handles out-of-range values. texCoordsRect is for alpha edge blending
// (not UV clamping). Previous code incorrectly clamped here, causing vertical
// stripes when texCoordsRect didn't cover the full [0,1] range.
fn sampleImagery(tex: texture_2d<f32>, samp: sampler,
                 baseUV: vec2<f32>, layer: ImageryLayer,
                 baseUV_dx: vec2<f32>, baseUV_dy: vec2<f32>) -> vec4<f32> {
  let uv = baseUV * layer.translationAndScale.zw + layer.translationAndScale.xy;
  // `textureSampleGrad` uses the caller-provided per-fragment UV derivatives
  // to pick the mip level. It is required because this function is called
  // after a non-uniform discard or return from the clipping planes, which
  // `textureSample` rejects; `textureSampleLevel(uv, 0.0)` is accepted there
  // but hard-locks the sampler to mip 0, bypassing the mipmap chain and
  // dropping brightness roughly 4× at orbital altitudes, where one fragment
  // covers many texels and the alias pattern under-samples the bright ones.
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

// Picks the derivative pair matching the layer's UV space.
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

// Per-layer hue rotation in YIQ space. Mirrors `czm_hue` from
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

// Color-to-alpha keying. Matches WebGL GlobeFS.glsl:
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

// Cutout rectangle test in tile-UV space. Returns 1.0 (keep) when
// the texel is OUTSIDE the cutout rectangle, 0.0 (drop) when inside.
// Disabled (returns 1.0) when the rectangle has zero area — matches the WebGL
// CPU-side default of `Cartesian4.ZERO` for unset cutouts.
fn applyCutoutMask(tileUV: vec2<f32>, cutout: vec4<f32>) -> f32 {
  let hasCutout = (cutout.z - cutout.x) > 0.0 && (cutout.w - cutout.y) > 0.0;
  let inside = tileUV.x >= cutout.x && tileUV.x <= cutout.z &&
               tileUV.y >= cutout.y && tileUV.y <= cutout.w;
  return select(1.0, 0.0, hasCutout && inside);
}

// Split-direction screen-space mask. Mirrors WebGL GlobeFS.glsl:
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

// Composites one imagery layer onto the running color/alpha pair.
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

// The GLSL counterpart is `Shaders/GlobeFS.glsl::sampleAndBlend` (lines
// 188-334); a change to this function has to land with a matching change
// there. See SHADER_PAIRS_LOCKSTEP.md.
//
// The two differ structurally, in ways the shader language forces:
// - GLSL samples the imagery texture inside the function via
//   `texture(textureToSample, ...)`. WGSL receives the pre-sampled
//   `texSample` as a parameter, because WGSL cannot dynamically index a
//   texture array inside a function, so the 16 imagery slots are unrolled at
//   the call site in `fragmentMain`. The effect is identical.
// - GLSL returns `vec4(outColor, outAlpha)`. WGSL returns a
//   `LayerComposite { color, alpha, adjustedColor }` struct, because the
//   downstream night-lights emission path needs the post-effects color
//   separately; the GLSL backend reaches night-lights another way.
// - GLSL gates brightness, contrast, hue and saturation behind `#ifdef
//   APPLY_*` defines the pipeline cache emits per layer property. WGSL
//   evaluates all four unconditionally, with a near-1.0 fast-path skip for
//   hue and gamma, because it has no `#ifdef` preprocessor and the pipeline
//   cache keys on `ShaderDefine` bits that do not include the per-effect
//   gates. WGSL pays a few extra ops per fragment; the output matches
//   whenever the per-layer property sits at its default.
//
// Both backends use the premultiplied-alpha OVER composite:
//   sourceAlpha = effectiveAlpha
//   outAlpha    = mix(prevAlpha, 1, sourceAlpha)
//   outColor    = mix(prevColor * prevAlpha, color, sourceAlpha) / outAlpha
//
// A straight `mix(prev, color, srcA)` with `max(prevA, srcA)` is algebraically
// the same composite when `prevAlpha = 1`, but diverges on multi-frustum
// subsequent passes, where the first imagery layer arrives with
// `prevAlpha = 0` and `srcA < 1`: straight-mix attenuates that first
// contribution by srcA, while OVER gives it full brightness at
// `outAlpha = srcA`.
//
// Divide-by-zero handling differs: GLSL uses a `sign()` sentinel (L311),
// WGSL clamps the divisor to a small epsilon. The end behaviour is the same,
// because at `outAlpha = 0` the divided color is unobservable — any
// downstream blend multiplies it by zero — and the returned alpha is clamped
// to 0 via `max(outAlpha, 0.0)`.
//
// Two bounds coordinates, matching WebGL's `sampleAndBlend`:
//
// `texCoordsBoundsUV` is the per-layer selected V, the `selectLayerUV` output:
// Mercator-V (`webMercatorT`) for `useWebMercatorT=true` layers, geographic
// geoUV otherwise. It tests the `texCoordsRect` alpha mask and is the same V
// the texture sample uses. WebGL passes a single `tileTextureCoordinates`
// (`useWebMercatorT ? .xz : .xy`, `GlobeSurfaceShaderSet.js:352`) to both the
// `step()` rect test (`GlobeFS.glsl:250,253`) and the sample (`:262`). The
// cached `texCoordsRect` is Mercator-V for `useWebMercatorT=true`, since the
// CPU packer converts the rectangles to native Mercator in place before taking
// the minV/maxV fraction (`ImageryLayerHelpers.js:229-247,343-347`), so the
// test V has to be the selected V rather than the geographic one. Testing a
// Mercator-space rect against a geographic V zeroes the mask and falls back to
// the imagery base color, which reads as dark blue at the poles.
//
// `boundsUV` is the geographic geoUV, used only for the `cutoutRectangle`
// test, because the cutout packer in `WebGPUGlobeSurfaceTileUB.ts` divides by
// `tile.rectangle.height`, a geographic latitude span.
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
  // > 0.0001` to skip the pow when at default. GLOBE-HDR-GAMMA — the
  // default-gamma branch now routes through `czm_gammaCorrect` exactly
  // like the GLSL `#if !defined(APPLY_GAMMA)` arm: identity on the SDR
  // path (camera.hdrControl.x == 0), sRGB → linear decode under the B479
  // HDR canvas-output path. GLSL's vec4 overload leaves alpha untouched,
  // so the rgb-only call is equivalent.
  var color = texSample.rgb;
  if (abs(layer.oneOverGamma - 1.0) > 0.0001) {
    color = pow(max(color, vec3<f32>(0.0)), vec3<f32>(layer.oneOverGamma));
  } else {
    color = czm_gammaCorrect(color);
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

  // Premultiplied-alpha OVER composite, matching WebGL
  // GlobeFS.glsl::sampleAndBlend L309-313:
  //   sourceAlpha = effectiveAlpha
  //   outAlpha    = mix(prevAlpha, 1, sourceAlpha)
  //              = prevAlpha + (1 - prevAlpha) * sourceAlpha
  //   outColor    = mix(prevColor * prevAlpha, adjusted, sourceAlpha)
  //                / outAlpha
  //
  // At `prevAlpha = 1`, the dominant case, this reduces to
  // `mix(prevColor, adjusted, effectiveAlpha)`. At `prevAlpha = 0` — the first
  // layer of a multi-frustum subsequent pass — it reduces to `adjusted` with
  // `outAlpha = sourceAlpha`, where a straight `mix` would instead return
  // `adjusted * sourceAlpha` and attenuate that first layer.
  //
  // Divide-by-zero handling: WebGL uses a `sign()` sentinel (GlobeFS.glsl
  // L311), this clamps the divisor to a small epsilon. When outAlpha is
  // genuinely zero the divided color is unobservable, since any downstream
  // blend multiplies it by 0 or skips it, and the returned alpha is clamped to
  // 0 via `max(outAlpha, 0.0)` against floating-point underflow to negative.
  let sourceAlpha = effectiveAlpha;
  let outAlpha = mix(prevAlpha, 1.0, sourceAlpha);
  let outAlphaSafe = max(outAlpha, 1e-7);
  let outColor = mix(prevColor * prevAlpha, adjusted, sourceAlpha) / outAlphaSafe;

  return LayerComposite(outColor, max(outAlpha, 0.0), adjusted);
}

// Perceptual luminance.
fn luminance(color: vec3<f32>) -> f32 {
  return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// Samples the sun-view cloud beer-shadow map.
// Projects the fragment's world (ECEF) position into the sun's orthographic
// clip space, reads the cloud optical-depth column — the cloud thickness
// between the fragment and the sun — and returns a transmittance multiplier
// `mix(1, exp(-depth·absorption), strength)` in [0,1]. Returns 1.0, no shadow,
// when the feature is off (`cloudShadowControl.x <= 0.5`) or the fragment
// projects outside the shadow map footprint, which keeps the effect local
// rather than imposing a hard cutoff. The call site gates on
// `cloudShadowControl.x > 0.5`, so the 1×1 zero placeholder is never read in
// the default render.
// Project `worldPos` with `vp`; return the tile-local [0,1]² UV (y flipped to
// texture space) and whether it landed inside the ortho footprint.
fn cloudShadowProjectUV(vp: mat4x4<f32>, worldPos: vec3<f32>) -> vec3<f32> {
  let clip = vp * vec4<f32>(worldPos, 1.0);
  let ndc = clip.xyz / max(abs(clip.w), 1e-6);
  let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
  let inside = select(0.0, 1.0,
    uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0);
  return vec3<f32>(uv, inside);
}

// Picks the position operand matching the sun-view matrices the CPU published
// this frame. `cloudShadowCascadeParams.y > 0.5` means those matrices are
// relative to the eye, so the fragment must supply `v_positionRTE`, the same
// high/low camera-relative vector the vertex stage already builds for the
// cascaded shadow map. Multiplying the full-ECEF `v_positionMC` by a
// planet-scale f32 matrix is the `mvp * vec4(position, 1.0)` form the
// relative-to-eye rule forbids. Planar scene modes zero `v_positionRTE`, so the
// CPU keeps them on the absolute matrix and this returns `v_positionMC`.
fn cloudShadowPositionOperand(
  positionRTE: vec3<f32>,
  positionMC: vec3<f32>,
) -> vec3<f32> {
  if (camera.cloudShadowCascadeParams.y > 0.5) {
    return positionRTE;
  }
  return positionMC;
}

fn sampleCloudGroundShadow(worldPos: vec3<f32>) -> f32 {
  var opticalDepth: f32 = -1.0;
  if (camera.cloudShadowControl.w >= 1.5) {
    // Cascaded atlas: 512×1536, three tiles stacked, tile 0 at the top and the
    // finest near cascade. Picks the finest cascade whose orthographic
    // footprint contains the fragment — near (VP0), then mid (VP1), then far
    // (VP2). The atlas V for tile i is (uvLocal.y + i) / 3; missing all three
    // means no shadow.
    let p0 = cloudShadowProjectUV(camera.cloudShadowVP, worldPos);
    let p1 = cloudShadowProjectUV(camera.cloudShadowVP1, worldPos);
    let p2 = cloudShadowProjectUV(camera.cloudShadowVP2, worldPos);
    let inv3 = 1.0 / 3.0;
    if (p0.z > 0.5) {
      let av = vec2<f32>(p0.x, (p0.y + 0.0) * inv3);
      opticalDepth = textureSampleLevel(cloudShadowMap, cloudShadowSampler, av, 0.0).r;
    } else if (p1.z > 0.5) {
      let av = vec2<f32>(p1.x, (p1.y + 1.0) * inv3);
      opticalDepth = textureSampleLevel(cloudShadowMap, cloudShadowSampler, av, 0.0).r;
    } else if (p2.z > 0.5) {
      let av = vec2<f32>(p2.x, (p2.y + 2.0) * inv3);
      opticalDepth = textureSampleLevel(cloudShadowMap, cloudShadowSampler, av, 0.0).r;
    } else {
      return 1.0; // outside every cascade footprint — no shadow
    }
  } else {
    // Single beer-shadow-map path (byte-identical default).
    let clip = camera.cloudShadowVP * vec4<f32>(worldPos, 1.0);
    // Ortho VP → w is 1, but guard anyway.
    let ndc = clip.xyz / max(abs(clip.w), 1e-6);
    let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      return 1.0; // outside the footprint — no shadow
    }
    opticalDepth = textureSampleLevel(cloudShadowMap, cloudShadowSampler, uv, 0.0).r;
  }
  let absorption = camera.cloudShadowControl.y;
  let strength = camera.cloudShadowControl.z;
  // Beer-Lambert transmittance, floored so even a fully overcast column reads as a
  // realistic shadow (~0.35) rather than pure black — real cloud shadows still let
  // ambient/skylight through. `strength` scales the darkening 0..1.
  let transmittance = max(exp(-opticalDepth * absorption), 0.35);
  return mix(1.0, transmittance, clamp(strength, 0.0, 1.0));
}

// Enhanced day/night rendering.
//
// The day/night ramp law: one law, two expressions, two consumers, taken from
// WebGL verbatim. `GlobeFS.glsl` carries two distinct expressions over the
// same `czm_getLambertDiffuse(L, N) * 5.0` core, and each consumer here reads
// the one its GLSL twin reads:
//
//   consumer                        GLSL                       WGSL (here)
//   imagery day/night alpha +       `1 - clamp(NdotL*5, 0, 1)` `computeDayNightFade`
//     night-lights emission gate     (GlobeFS.glsl:601)
//   ENABLE_DAYNIGHT_SHADING         `clamp(NdotL*5 + 0.3,      `computeDayNightDiffuse`
//     diffuse                         0, 1)` (GlobeFS.glsl:851)
//
// The `+ 0.3` belongs to the lighting expression alone: it is a night-side
// floor that keeps the unlit hemisphere off pitch black, not an offset on the
// alpha ramp. Collapsing both consumers onto a single
// `clamp(NdotL*5 + 0.5, 0, 1)` centres the alpha ramp on the geometric
// terminator — 0.5 night alpha at N·L = 0, where GLSL gives 1.0 — and drives
// the lighting term from a ramp WebGL does not use there. At the terminator
// that reads as 0.496 day-fade against WebGL's 0.012.
//
// `normalEC` must be the analytic geocentric surface normal in eye space
// (`dayNightNormalEC` in `fragmentMain`), never the interpolated mesh normal
// `input.v_normalEC`, which is constant on normal-less terrain and makes the
// whole term globally uniform. See the block above the call site.
//
// The imagery day/night alpha and night-lights gate is the day-side complement
// of `GlobeFS.glsl:601`'s `nightBlend`: the caller takes
// `nightBlend = 1.0 - dayFade`. Fully night at N·L <= 0; the ramp lives
// entirely on the day side and saturates at N·L = 0.2.
fn computeDayNightFade(normalEC: vec3<f32>, sunDirEC: vec3<f32>) -> f32 {
  let lambertDiffuse = max(dot(sunDirEC, normalEC), 0.0);
  return clamp(lambertDiffuse * 5.0, 0.0, 1.0);
}

// The ENABLE_DAYNIGHT_SHADING diffuse, matching `GlobeFS.glsl:851`'s
// `diffuseIntensity`. The `+ 0.3` is this expression's own night floor and
// must not leak into `computeDayNightFade` above. The caller then applies
// GLSL:852's `mix(1.0, diffuseIntensity, fade)` with the camera-distance
// `fade`, so close-camera tiles stay flat-lit.
fn computeDayNightDiffuse(normalEC: vec3<f32>, sunDirEC: vec3<f32>) -> f32 {
  let lambertDiffuse = max(dot(sunDirEC, normalEC), 0.0);
  return clamp(lambertDiffuse * 5.0 + 0.3, 0.0, 1.0);
}

// Computes the optional stylized terminator glow: a warm orange-pink tint at
// the day-night boundary. The public appearance strength defaults to zero, so
// natural atmosphere and lighting remain the default result.
//
// This term takes the raw signed `dot(N, L)` rather than either day/night
// ramp, so a change to the ramp law does not move it. GlobeFS.glsl carries the
// exact same function and evaluates it from the same analytic normal.
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

// Enhanced ocean and water rendering.

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

// East-north-up to eye-coordinates rotation matrix.
// Port of WebGL's `czm_eastNorthUpToEyeCoordinates`
// (Builtin/Functions/eastNorthUpToEyeCoordinates.glsl). Builds a 3×3
// rotation that takes a tangent-space (east, north, up) vector to eye space,
// where the local up is the ellipsoid surface normal. `computeEnhancedOcean`
// uses it to move multi-octave wave normals from tangent space into eye space
// before perturbing the surface normal. Adding a tangent-space vector directly
// to an eye-space normal instead produces waves that follow the camera rather
// than staying anchored to the surface, which reads as a subtle mesh pattern
// on close-zoom water.
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

// Ocean-wave march at physical wavelengths, with footprint-driven level of
// detail.
//
// The octaves are anchored to a global ellipsoid (longitude/latitude)
// coordinate at physical wavelengths, so they hold a constant real-world scale
// and stay resolvable down to a 50 m camera. Sampling them in tile UV instead
// is scale-invariant under terrain screen-space error — sub-pixel at every
// altitude — which turns the waves into animated mip-0 aliasing.
//
// The global coordinate is reconstructed relative-to-eye rather than used
// absolutely: `euv × Rᵢ` reaches ~2.7e6 for the 15 m ripple, where an f32 ulp
// is ~0.25 of a repeat, giving staircase bands and time advection so small it
// freezes. The CPU computes per-tile, per-octave phase offsets in f64 —
// fract(rectOriginNorm × Rᵢ) — and packs only the [0,1) remainder plus the
// normalized tile span; the shader rebuilds the coordinate from small
// quantities as `phaseᵢ + tileLocalUV × spanNorm × Rᵢ + fract(time)`. Every f32
// term then stays at or below about one tile's screen pixels while the octave
// is resolved, keeping the ulp far under 1% of a repeat.
//
//   (1) Physical-wavelength, mip- and anisotropy-aware sampling. Each octave
//       tiles the normal map Rᵢ = round(circumference / wavelengthᵢ) times per
//       globe. `textureSampleGrad` takes explicit gradients, which is legal
//       after the non-uniform coast discard, and mip-averages; with the ocean
//       sampler's maxAnisotropy of 8 it also anisotropic-filters, matching
//       WebGL's automatic LOD. Rᵢ is an integer, so the ±180° ellipsoid-UV wrap
//       is an exact repeat and the seam is invisible.
//   (2) Camera-height awareness comes from the footprint metric, repeats per
//       pixel: large on a low camera's grazing horizon, small at nadir, with no
//       hardcoded distance ramp. `waveIntensityFade` (70 km to 1 Mm) is
//       retained only for the tuned orbit sun-glint parity.
//   (3) Amplitude fade with a hard far cutoff. Each octave's tangent-space
//       `.xy` slope amplitude is scaled by its footprint weight while `.z` is
//       kept, so the perturbation fades continuously toward flat. Scaling whole
//       vectors inside `normalize` instead is a scale-invariant no-op. Once all
//       weights are negligible the march skips the fetches; the amplitude fade
//       has already driven the blend to nearly flat, so the cutoff is
//       continuous.
//
// The sampling normalizes U by 1/2π and V by 1/π, so `Rᵢ` repeats span the full
// 2π of longitude but only the π half-meridian: the meridional wavelength is
// half the zonal one, and the zonal metric wavelength shrinks further by
// cos(lat) toward the poles — the same `czm_ellipsoidTextureCoordinates`
// distortion WebGL carries. The footprint fade is computed from the actual
// per-axis UV derivatives, so it self-tracks that compression, but the
// wavelengths quoted below are equatorial zonal values: multiply by 0.5 for
// meridional, or by cos(lat) for the local zonal metric scale.
//
// The integer repeat counts and the fade band are tunable, shared with
// GlobeFS.glsl and WebGPUGlobeSurfaceTypes.OCEAN_OCTAVE_REPEATS, and pinned by
// ocean-wave-lod.spec.mjs, which extracts them from this file.
const OCEAN_CIRCUMFERENCE_M: f32 = 40075016.0; // WGS84 equatorial circumference
const OCEAN_OCTAVE_REPEATS_1: f32 = 267167.0;  // swell  ≈ 150.0 m zonal (importance 0.6)
const OCEAN_OCTAVE_REPEATS_2: f32 = 801500.0;  // medium ≈  50.0 m zonal (importance 0.3)
const OCEAN_OCTAVE_REPEATS_3: f32 = 2671668.0; // ripple ≈  15.0 m zonal (importance 0.1)
const OCEAN_OCTAVE_WEIGHT_1: f32 = 0.6;
const OCEAN_OCTAVE_WEIGHT_2: f32 = 0.3;
const OCEAN_OCTAVE_WEIGHT_3: f32 = 0.1;
// Per-octave advection velocity (repeats per unit `t`; `t` is frame-driven
// `tile.time`). fract() at the call site keeps the time offset in [0,1).
const OCEAN_ADVECT_1: vec2<f32> = vec2<f32>(0.012, 0.008);
const OCEAN_ADVECT_2: vec2<f32> = vec2<f32>(-0.008, 0.018);
const OCEAN_ADVECT_3: vec2<f32> = vec2<f32>(0.03, -0.012);
// Fade band in normal-map repeats spanned per screen pixel. Full weight at/below
// FADE_LO (repeat ≥ 2 px, resolvable); zero at/above FADE_HI (repeat ≤ 1 px,
// sub-pixel — mip has already averaged it toward flat). Spec-safe INCREASING
// smoothstep edges (WGSL leaves `smoothstep` undefined for low ≥ high).
const OCEAN_OCTAVE_FADE_LO: f32 = 0.5;
const OCEAN_OCTAVE_FADE_HI: f32 = 1.0;
// Sum-of-weights below which the whole march is skipped (perturbation ≈ flat).
const OCEAN_WAVE_MARCH_CUTOFF: f32 = 0.01;
// Must equal the maxAnisotropy of the ocean-normal sampler
// (WebGPUGlobeSurfaceLayouts.ts) - see the footprint clamp below.
const OCEAN_SAMPLER_MAX_ANISO: f32 = 8.0;

// Footprint weight for one wave octave. `repeatsPerPixel` = normal-map repeats
// spanned by one screen pixel for this octave; the octave fades as it crosses
// the sub-pixel band. MIN-axis footprint is used at the call site because, with
// anisotropic sampling on, the LIMITING resolution is the short (across-track)
// axis — the long axis is resolved by the hardware's aniso taps.
fn oceanOctaveLodWeight(repeatsPerPixel: f32) -> f32 {
  return 1.0 - smoothstep(OCEAN_OCTAVE_FADE_LO, OCEAN_OCTAVE_FADE_HI, repeatsPerPixel);
}

// Samples ocean wave normals as three physically-scaled octaves in
// relative-to-eye decomposed ellipsoid UV. `euvLocal` is geoUV × spanNorm, the
// small tile-local ellipsoid UV; `euvDx`/`euvDy` are its per-pixel derivatives;
// `phaseN` is the f64-computed per-tile, per-octave phase offset from the tile
// uniform buffer. The absolute sample coordinate `phaseN + euvLocal × Rᵢ` stays
// small enough for f32 to resolve, and adjacent tiles stay phase-continuous
// because Rᵢ is an integer and both the phase and the span come from the same
// f64 rectangle. Feeds both ocean-styling branches.
fn sampleOceanWaveNormals(
  euvLocal: vec2<f32>,
  euvDx: vec2<f32>,
  euvDy: vec2<f32>,
  phase1: vec2<f32>,
  phase2: vec2<f32>,
  phase3: vec2<f32>,
  t: f32,
) -> vec3<f32> {
  // Minimum-axis footprint, in repeats per pixel: octave repeats × UV
  // footprint. The minimum rather than the maximum, because anisotropic
  // sampling resolves the long axis and the short one sets the resolution
  // limit.
  //
  // Keying the octave weight on the pure minimum axis leaves a visible corduroy
  // aliasing band just under the horizon at extreme grazing angles: the sampler
  // resolves at most OCEAN_SAMPLER_MAX_ANISO texels of footprint elongation —
  // it is created with maxAnisotropy 8 in WebGPUGlobeSurfaceLayouts.ts, and the
  // two constants must stay in lockstep — so past that ratio the long axis
  // aliases at the min-axis LOD. The standard hardware-anisotropy clamp
  // applies: the resolvable footprint is max(minAxis, maxAxis / maxAniso).
  let footMinRaw = min(length(euvDx), length(euvDy));
  let footMaxRaw = max(length(euvDx), length(euvDy));
  let footMin = max(footMinRaw, footMaxRaw / OCEAN_SAMPLER_MAX_ANISO);
  let w1 = OCEAN_OCTAVE_WEIGHT_1 * oceanOctaveLodWeight(OCEAN_OCTAVE_REPEATS_1 * footMin);
  let w2 = OCEAN_OCTAVE_WEIGHT_2 * oceanOctaveLodWeight(OCEAN_OCTAVE_REPEATS_2 * footMin);
  let w3 = OCEAN_OCTAVE_WEIGHT_3 * oceanOctaveLodWeight(OCEAN_OCTAVE_REPEATS_3 * footMin);

  // (3) Hard far cutoff — all octaves faded, skip the three fetches. The
  // amplitude fade below has already driven the blend to ≈flat here, so the
  // early return is visually continuous.
  if (w1 + w2 + w3 < OCEAN_WAVE_MARCH_CUTOFF) {
    return vec3<f32>(0.0, 0.0, 1.0);
  }

  // Sample coord = phase (small, [0,1)) + tileLocal repeats (small when
  // resolved) + fract(time) (small). Gradients = euvD × Rᵢ (phase + time are
  // constant across the quad, so they don't enter the derivative).
  let n1 = textureSampleGrad(
    oceanNormalMap, oceanNormalSampler,
    phase1 + euvLocal * OCEAN_OCTAVE_REPEATS_1 + fract(t * OCEAN_ADVECT_1),
    euvDx * OCEAN_OCTAVE_REPEATS_1, euvDy * OCEAN_OCTAVE_REPEATS_1,
  ).xyz * 2.0 - 1.0;
  let n2 = textureSampleGrad(
    oceanNormalMap, oceanNormalSampler,
    phase2 + euvLocal * OCEAN_OCTAVE_REPEATS_2 + fract(t * OCEAN_ADVECT_2),
    euvDx * OCEAN_OCTAVE_REPEATS_2, euvDy * OCEAN_OCTAVE_REPEATS_2,
  ).xyz * 2.0 - 1.0;
  let n3 = textureSampleGrad(
    oceanNormalMap, oceanNormalSampler,
    phase3 + euvLocal * OCEAN_OCTAVE_REPEATS_3 + fract(t * OCEAN_ADVECT_3),
    euvDx * OCEAN_OCTAVE_REPEATS_3, euvDy * OCEAN_OCTAVE_REPEATS_3,
  ).xyz * 2.0 - 1.0;

  // (3) AMPLITUDE fade: scale each octave's tangent-space slope (.xy) by its
  // footprint weight while KEEPING .z, then blend by importance. As a weight →
  // 0 that octave's slope contribution vanishes but its flat .z remains, so the
  // summed perturbation attenuates CONTINUOUSLY toward (0,0,1) — a true
  // amplitude fade (not the scale-invariant no-op v1 had inside `normalize`).
  let m1 = vec3<f32>(n1.xy * w1, n1.z * OCEAN_OCTAVE_WEIGHT_1);
  let m2 = vec3<f32>(n2.xy * w2, n2.z * OCEAN_OCTAVE_WEIGHT_2);
  let m3 = vec3<f32>(n3.xy * w3, n3.z * OCEAN_OCTAVE_WEIGHT_3);
  return normalize(m1 + m2 + m3);
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

// Full enhanced ocean rendering pipeline, following WebGL
// `computeWaterColor` semantics: `color = imageryColor + diffuseHighlight +
// ... + specular`, so imagery is preserved and highlights are added to it.
// Replacing imagery with a deep-color blend such as
// `mix(baseColor * darkening, deepColor, 0.6)` instead dims aerial ocean
// imagery by roughly 5× at every ocean fragment.
//
// The path is:
//   1. Sample wave normals, only at low altitude with ocean waves enabled
//   2. Compute diffuse and specular highlights from the active scene light
//   3. Add the highlights to the imagery base color, without replacing it
//   4. Smooth the coast transition by water-mask alpha
//
// At orbit, with no waves or no lighting, the contribution is essentially
// nothing, matching WebGL at its default settings.
fn computeEnhancedOcean(
  baseColor: vec3<f32>,
  positionEC: vec3<f32>,
  positionMC: vec3<f32>,
  normalEC: vec3<f32>,
  sunDirEC: vec3<f32>,
  uv: vec2<f32>,
  // Derivatives of `uv` (= geoUV), hoisted to fragment entry, for the
  // wave-march pixel-footprint octave LOD. `fwidth` is illegal at this call
  // site, downstream of the non-uniform coast discard, so they are threaded in
  // from uniform control flow, matching the water-mask antialiasing pattern.
  uvDx: vec2<f32>,
  uvDy: vec2<f32>,
  waterMaskValue: f32,
  lightingFade: f32,
  distance: f32,
) -> vec3<f32> {
  let viewDir = normalize(-positionEC);

  // Perturbed normal from multi-octave wave normals. `waveN` is the sampled
  // tangent-space normal; its .z component — `tsPerturbationRatio` in WebGL's
  // nomenclature — is needed for the nonDiffuseHighlight below, so it is
  // captured outside the gate as well.
  //
  // `waveN` is rotated from tangent space to eye space through the ENU matrix,
  // matching WebGL's `normalEC_water = enuToEye * normalTangentSpace` at
  // GlobeFS.glsl::computeWaterColor L814. Folding it in as
  // `normalize(normalEC + waveN * waveStrength)` mixes a tangent-space vector
  // into an eye-space one without rotating it, which anchors the waves to
  // camera orientation rather than the surface and shows as a moving mesh
  // pattern when the camera orbits a coastline.
  var waterNormal = normalEC;
  var foamFactor: f32 = 0.0;
  var tsPerturbationRatio: f32 = 1.0; // 1.0 = flat, 0.0 = vertical wave
  let showOceanWaves = tile.flags.z > 0.5;
  if (showOceanWaves) {
    // Under any debug sentinel, where tile.time is hijacked past 1e9, the wave
    // clock freezes at 0 so A/B bypass captures share one wave phase instead of
    // inheriting the sentinel value. Production, at tile.time below 1e6,
    // selects the real clock.
    let t = select(tile.time, 0.0, tile.time > 1.0e9);
    // Relative-to-eye decomposed ellipsoid wave UV. The f64-computed per-tile,
    // per-octave phase offsets and the normalized tile span come from the tile
    // uniform buffer, packed to keep every f32 quantity small. The shader
    // reconstructs only tile-local quantities: euvLocal = geoUV × spanNorm, the
    // small tile-relative ellipsoid UV, and its per-pixel derivatives
    // euvD = spanNorm × geoUV-derivative, which are seam-free because they
    // avoid the f32 east-west cancellation. Planar 2D and Columbus View modes
    // pack a projected-metres span, so euvD blows up, the footprint fade
    // collapses every octave, and the ocean renders flat.
    let spanNorm = tile.oceanWavePhaseB.zw;
    let euvLocal = uv * spanNorm;
    let euvDx = uvDx * spanNorm;
    let euvDy = uvDy * spanNorm;
    let waveN = sampleOceanWaveNormals(
      euvLocal, euvDx, euvDy,
      tile.oceanWavePhaseA.xy, tile.oceanWavePhaseA.zw, tile.oceanWavePhaseB.xy,
      t,
    );
    // Fades the wave perturbation to exactly zero far from the surface,
    // matching WebGL GlobeFS.glsl L794+816:
    //   waveIntensity = waveFade(70000, 1e6, positionToEyeECLength)
    //                 = pow(1 - linearFade(70000, 1e6, dist), 5)
    //   normalTangentSpace.xy *= waveIntensity
    // A non-zero floor leaves a residual tilt at orbit, and the mip-averaged
    // wave-normal bias then tilts the whole sun-glint lobe coherently — about
    // 10 px limb-ward of WebGL at 25 Mm.
    let waveFadeLin = clamp(
      (length(positionEC) - 70000.0) / (1000000.0 - 70000.0),
      0.0,
      1.0,
    );
    let waveIntensityFade = pow(1.0 - waveFadeLin, 5.0);
    // The near-surface wave-normal strength is set so the perturbed normal —
    // and the specular sparkle and diffuse highlight riding on it — has a
    // magnitude comparable to WebGL's. WebGL's computeWaterColor applies the
    // full tangent-space wave normal near the surface (GlobeFS.glsl L818,
    // `normalTangentSpace.xy *= waveIntensity` with `waveIntensity ≈ 1` below
    // roughly 70 km), so the animated Phong glint churns visibly. A near value
    // around 0.25 mixes only about 24% toward the wave normal, leaving the
    // ocean roughly 4× flatter and its frame-driven animation nearly
    // imperceptible. The far value and `waveIntensityFade`, which reaches 0 at
    // orbit, set the orbit sun-glint parity and are independent of this.
    let waveStrength = mix(0.85, 0.05, smoothstep(10000.0, 500000.0, distance)) *
      waveIntensityFade;
    let enuToEye = eastNorthUpToEyeCoordinates(positionMC, normalEC);
    // ENU.up is normalEC, so `enuToEye * (0,0,1) = normalEC`: a flat wave
    // normal of (0, 0, 1) leaves `waterNormal` equal to `normalEC` and
    // perturbs nothing. Non-zero waveN.xy tilts the normal around the local
    // east/north tangent frame.
    let waveNormalEC = enuToEye * waveN;
    waterNormal = normalize(mix(normalEC, waveNormalEC, waveStrength));
    foamFactor = computeFoam(waveN, distance);
    // Q10-DAYTIME-OCEAN-BRIGHTNESS — `tsPerturbationRatio` MUST come from the
    // DISTANCE-FADED tangent-space wave normal, matching WebGL GlobeFS.glsl
    // L818-819: `normalTangentSpace.xy *= waveIntensity; normalize(...)` before
    // `tsPerturbationRatio = normalTangentSpace.z` (L835). As the camera pulls
    // away, `waveIntensityFade → 0`, so the faded normal → (0,0,1) and the
    // ratio → 1 → `(1 - tsPerturbationRatio) → 0`, killing `nonDiffuseHighlight`
    // at mid/orbit range exactly as WebGL does. The PRE-FIX code used the RAW
    // `waveN.z` (never faded), so the ratio stayed < 1 at orbit and the
    // low-light `nonDiffuseHighlight` (peaks as NdotL→0, i.e. the night side)
    // blew the ocean out to saturated cyan once the highlight taper was
    // corrected. Byte-identical to the raw `waveN.z` at close zoom where
    // `waveIntensityFade ≈ 1`.
    let tsFadedNormal = normalize(vec3<f32>(waveN.xy * waveIntensityFade, waveN.z));
    tsPerturbationRatio = tsFadedNormal.z;
  }

//>>ifdef ENHANCED_OCEAN
  // Wave-highlight diffuse term — matches WebGL `waveHighlightColor *
  // czm_getLambertDiffuse(...) * mask * (1 - fade)`. Runs unconditionally
  // (WebGL doesn't gate this on `enableLighting`) and contributes only a
  // narrow band of color where the surface faces the light.
  let waveHighlightColor = vec3<f32>(0.3, 0.45, 0.6);
  let NdotL = max(dot(waterNormal, sunDirEC), 0.0);
  // Q10-DAYTIME-OCEAN-BRIGHTNESS — the highlight taper MUST use WebGL's
  // atmosphere camera-distance `fade` (GlobeFS.glsl L428 = clamp((cameraDist
  // - lightingFadeOut) / (lightingFadeIn - lightingFadeOut), 0, 1)), the SAME
  // scalar passed to `computeWaterColor(..., fade)` at L502 and applied as
  // `diffuseHighlight * (1.0 - fade)` at L830. It is 0 at close/mid range
  // (full highlight) and ramps to 1 at orbit (highlight fades, glint takes
  // over). The caller now passes `tile.groundAtmosphereControl.y` — the
  // identical clamp — for `lightingFade`.
  //
  // It must not be the day/night terminator fade `dayFade`, which
  // `fragmentMain` forces to 1.0 whenever `enableLighting` is off — the
  // default. `1.0 - 1.0 = 0` zeroes the bluish `diffuseHighlight` on every
  // daytime ocean fragment, taking the ocean from bright blue to deep navy,
  // roughly 4× darker than WebGL at mid-range, while the night side stays at
  // parity because NdotL is near zero there anyway. The terminator fade and
  // the atmosphere fade are unrelated quantities.
  let highlightFade = 1.0 - clamp(lightingFade, 0.0, 1.0);
  let diffuseHighlight = waveHighlightColor * NdotL * waterMaskValue * highlightFade;

  var oceanContribution = diffuseHighlight;

  // WebGL's `nonDiffuseHighlight` (GlobeFS.glsl L822-829). Where waves are
  // perturbed and diffuse light is weak, this adds a low-light bluish
  // highlight so the ocean is not pitch black at the terminator. Gated on
  // SHOW_OCEAN_WAVES (`tile.flags.z > 0.5`), matching WebGL's
  // `#ifdef SHOW_OCEAN_WAVES`; WebGL's `#else` branch sets it to vec3(0.0),
  // which leaving the var at zero reproduces.
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

  // Specular sun-glint, ported one-to-one from WebGL
  // GlobeFS.glsl::computeWaterColor L839-842. WebGL runs it unconditionally,
  // because `czm_lightDirectionEC` is always defined — the default scene light
  // is the sun even when `globe.enableLighting` is false — and it has no
  // orbit-altitude attenuation: the broad Phong lobe at shininess 10 is the
  // zoomed-out ocean glint, modulated only by
  // `u_zoomedOutOceanSpecularIntensity`, which `Globe.beginFrame` sets. Gating
  // this on enableLighting, or fading it out above 100 km, suppresses the glint
  // entirely in default scenes; at 25 Mm the missing Pacific glint blob alone
  // accounted for 63% of the far-zoom pixel mismatch against WebGL.
  //
  //   czm_getSpecular(L, V, N, 10) = pow(max(dot(reflect(-L, N), V), 0), 10)
  //   surfaceReflectance = mix(0, mix(zoomedOutSpec, oceanSpec, waveIntensity), mask)
  //   waveIntensity = waveFade(70000, 1e6, |toEyeEC|) = pow(1 - linearFade(...), 5)
  //
  // The 26e9 debug sentinel skips this term so its share of the below-surface
  // residual can be measured in isolation. Production, below tile.time 1e6,
  // always takes it.
  if (!globe_debugBypassActive(26.0e9)) {
    let toReflectedLight = reflect(-sunDirEC, waterNormal);
    let specularIntensity = pow(max(dot(toReflectedLight, viewDir), 0.0), 10.0);
    // `camera.lighting.w` mirrors WebGL's `u_zoomedOutOceanSpecularIntensity`,
    // which is not a constant: `Globe.beginFrame` sets 0.4 when
    // showGroundAtmosphere is on — the default — 0.5 otherwise, and 0.0
    // outside SCENE3D. Hardcoding 0.5 here makes the orbit glint 25% brighter
    // than WebGL's. `nearSpec` matches the GLSL const
    // `oceanSpecularIntensity = 0.5`.
    let zoomedOutSpec: f32 = camera.lighting.w;
    let nearSpec: f32 = 0.5;
    let positionToEyeECLength = length(positionEC);
    let waveFadeY = clamp(
      (positionToEyeECLength - 70000.0) / (1000000.0 - 70000.0),
      0.0,
      1.0,
    );
    let waveIntensity = pow(1.0 - waveFadeY, 5.0);
    let surfaceReflectance =
      mix(zoomedOutSpec, nearSpec, waveIntensity) * waterMaskValue;
    oceanContribution += vec3<f32>(specularIntensity * surfaceReflectance);
  }

  // Foam: white overlay on steep wave crests (additive on top of imagery).
  let foamColor = vec3<f32>(0.85, 0.9, 0.92);

  // Match WebGL: imagery preserved, highlights added on top, foam mixed in.
  // The coastline feather, a mix against baseColor, lives at the call site,
  // where a screen-space-adaptive coverage is computed with `fwidth(mask)` in
  // uniform control flow. Returning the full effect color here keeps this
  // helper a pure ocean-over-imagery shader and leaves the caller to decide
  // how much of it survives near the coast.
  var color = baseColor + oceanContribution;
  color = mix(color, foamColor, foamFactor);
  return color;
//>>else
  // Classic WebGL-parity ocean styling, the default.
  // Faithful port of GlobeFS.glsl::computeWaterColor, non-HDR path L807-878.
  // The gate covers styling only: the shared wave march above has already
  // produced the perturbed eye-space normal (`waterNormal`, WebGL's
  // `enuToEye * normalTangentSpace`) and `tsPerturbationRatio` (WebGL's
  // `normalTangentSpace.z`), so both branches ride identical waves and differ
  // only in how they derive colour. This branch reproduces WebGL's shading
  // model — imagery preserved, with wave-diffuse, non-diffuse and Phong
  // specular added — and omits the WebGPU-only additions (foam whitecaps,
  // subsurface scattering, GGX, deep colour), so default water reads like
  // WebGL water. WebGPU tone-maps HDR downstream, so like the enhanced branch
  // this does not reproduce the WebGL `#ifdef HDR` composition. See
  // WebGPUShaderDefines.ShaderDefineHi.ENHANCED_OCEAN.
  let classicWaveHighlightColor = vec3<f32>(0.3, 0.45, 0.6);
  // czm_getLambertDiffuse(sunDirEC, waterNormal) * maskValue (GlobeFS L849).
  let classicDiffuseIntensity =
    max(dot(waterNormal, sunDirEC), 0.0) * waterMaskValue;
  // diffuseHighlight = waveHighlightColor * diffuseIntensity * (1 - fade)
  // (GlobeFS L850). `lightingFade` is WebGL's atmosphere camera-distance
  // `fade` (the SAME clamp GlobeFS L428 computes, passed by the caller).
  let classicDiffuseHighlight =
    classicWaveHighlightColor *
    classicDiffuseIntensity *
    (1.0 - clamp(lightingFade, 0.0, 1.0));
  // nonDiffuseHighlight: only under SHOW_OCEAN_WAVES (GlobeFS L852-859 #ifdef);
  // the #else path is vec3(0.0), reproduced by leaving the var at zero when
  // waves are off. Mix factor is the mask-scaled `diffuseIntensity` (GlobeFS
  // L856), NOT the raw NdotL.
  var classicNonDiffuseHighlight = vec3<f32>(0.0);
  if (showOceanWaves) {
    classicNonDiffuseHighlight = mix(
      classicWaveHighlightColor * 5.0 * (1.0 - tsPerturbationRatio),
      vec3<f32>(0.0),
      classicDiffuseIntensity,
    );
  }
  // czm_getSpecular(sunDirEC, viewDir, waterNormal, 10) (GlobeFS L862):
  //   pow(max(dot(reflect(-L, N), V), 0), 10)
  let classicToReflectedLight = reflect(-sunDirEC, waterNormal);
  let classicSpecularIntensity =
    pow(max(dot(classicToReflectedLight, viewDir), 0.0), 10.0);
  // surfaceReflectance = mix(0, mix(zoomedOut, oceanSpec, waveIntensity), mask)
  //   = mix(zoomedOut, oceanSpec, waveIntensity) * mask (GlobeFS L863).
  // waveIntensity = waveFade(70000, 1e6, |positionToEyeEC|)
  //   = pow(1 - clamp((len-70000)/(1e6-70000),0,1), 5) (GlobeFS L782-786, L816).
  let classicPositionToEyeECLength = length(positionEC);
  let classicWaveFadeLin = clamp(
    (classicPositionToEyeECLength - 70000.0) / (1000000.0 - 70000.0),
    0.0,
    1.0,
  );
  let classicWaveIntensity = pow(1.0 - classicWaveFadeLin, 5.0);
  // `camera.lighting.w` mirrors WebGL's u_zoomedOutOceanSpecularIntensity
  // (Globe.beginFrame — 0.4 with ground atmosphere, 0.5 otherwise, 0 outside
  // SCENE3D); the GLSL const oceanSpecularIntensity = 0.5 (GlobeFS L800).
  let classicSurfaceReflectance =
    mix(camera.lighting.w, 0.5, classicWaveIntensity) * waterMaskValue;
  let classicSpecular = classicSpecularIntensity * classicSurfaceReflectance;
  // Non-HDR composition: imagery + all three highlight terms (GlobeFS L875).
  return baseColor +
    classicDiffuseHighlight +
    classicNonDiffuseHighlight +
    vec3<f32>(classicSpecular);
//>>endif
}

// Fog & Atmosphere

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
  // Camera altitude and view direction drive the LUT lookup, through the
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

  // Transmittance LUT: .rgb = attenuation along the ray. Take the
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

  // Intensity scaling. The inscatter LUT is baked intensity-free —
  // `SkyAtmosphere::sampleScatteringLut` multiplies by `u.intensity` at
  // fragment time — and globe fog wants the same texel scaled by
  // `Globe.atmosphereLightIntensity`, which the CPU packs into
  // `tile.groundAtmosphereControl.z` (default 10.0).
  //
  // Scaling by that uniform rather than by a constant rescale factor is what
  // makes a customized intensity work at all: a constant tuned for the default
  // configuration keeps assuming the default globe intensity, so a scene
  // setting `globe.atmosphereLightIntensity = 20` gets ground fog half as
  // bright as it asked for, and the post-tonemap mix saturates the imagery to
  // a uniform tan.
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

// Shadow & Clipping (unchanged from previous version)

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

// Point-light cube-shadow sample, adapted from `samplePointShadow` in
// ModelPBRComplete.wgsl. The math is identical: pick the dominant cube-face
// axis, derive the depth value the cast pipeline wrote at that axis distance,
// and sample the cube with `direction = fragRTE - lightRTE`. A 5-tap cross PCF
// runs when
// `pointLightPositionRTE.w > 0` for soft shadows; zero radius drops
// to a single hardware-comparison sample.
//
// Globe-specific: `v_positionRTE` is already the camera-relative world-axis
// fragment vector. The CPU packs the light relative to the same camera origin
// in f64, so the shader never reconstructs either absolute ECEF operand.
fn globeSamplePointShadow(fragRTE: vec3<f32>) -> f32 {
  let lightRTE = effects.pointLightPositionRTE.xyz;
  let direction = fragRTE - lightRTE;
  let absDir = abs(direction);
  let lightDistanceSquared = dot(direction, direction);
  let axisDist = max(absDir.x, max(absDir.y, absDir.z));
  let nearPlane = effects.pointLightControl.z;
  let farPlane = effects.pointLightControl.y;
  let depthBias = effects.pointLightControl.w;
  // The point-light radius is spherical; axisDist is retained only for the
  // cube-camera perspective-depth reconstruction.
  if (lightDistanceSquared >= farPlane * farPlane) { return 1.0; }
  let depthRange = farPlane - nearPlane;
  let zNdcWebGpu =
    farPlane / depthRange - (farPlane * nearPlane) / (axisDist * depthRange);
  // The convention-aware shadow transform preserves WebGPU z in [0,1] —
  // compare the raw [0,1] value directly, matching ModelPBRComplete.wgsl's
  // samplePointShadow and chunks/functions/csm_samplePointShadow.wgsl.
  let zAttached = zNdcWebGpu;
  let refDepth = clamp(zAttached - depthBias, 0.0, 1.0);
  let pcfRadius = effects.pointLightPositionRTE.w;
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
  // One projected cube-face texel spans 2/N. Scale the meter-space raw
  // direction by its dominant axis so the minor-axis perturbation moves the
  // requested radius in face texels rather than vanishing at Earth scale.
  let offset =
    2.0 * axisDist * pcfRadius / max(effects.shadowMapSize.x, 1.0);
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

fn globeComputeShadowFactorPointLight(fragRTE: vec3<f32>) -> f32 {
  if (effects.shadowDarkness >= 1.0) { return 1.0; }
  let visibility = globeSamplePointShadow(fragRTE);
  return mix(effects.shadowDarkness, 1.0, visibility);
}

fn globeComputeShadowFactor(positionEC: vec3<f32>) -> f32 {
  if (effects.shadowDarkness >= 1.0) { return 1.0; }
  let shadowPos = effects.shadowMatrix * vec4<f32>(positionEC, 1.0);
  // `effects.shadowMatrix` lands DIRECTLY in WebGPU shadow-texture space —
  // `ShadowMap.getViewProjection` already folds in the NDC-to-texture
  // scale/bias and `toWebGPUShadowReceiveMatrix` applies the v-origin flip on
  // the CPU (see `WebGPUShadowReceiveTransform.ts`). Re-applying `*0.5 + 0.5`
  // here squeezes every lookup into the wrong quadrant, which leaves the globe
  // receiving no sun shadow at all. The cascade path below differs on purpose:
  // it is handed a raw clip-space cascade view-projection and does the full
  // remap itself.
  let coord = shadowPos.xyz / shadowPos.w;
  let uv = coord.xy;
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

// Polygon signed-distance-field clipping, a parity port of
// `modelClipByPolygon` in ModelPBRComplete.wgsl, which in turn folds the WebGL
// pipeline's `GlobeVS.glsl` ENABLE_CLIPPING_POLYGONS region selection (via
// `czm_approximateSphericalCoordinates`) and `Builtin/Functions/clipPolygons.glsl`
// atlas sampling into a single fragment function.
//
// The input frame is load-bearing: it is the fragment's full ECEF world-space
// position (`v_positionMC`, which the vertex stage assigns from `position3DWC`,
// the same input WebGL feeds `czm_approximateSphericalCoordinates`). The
// (lat, lon) has to be computed with the same `fastApproximateAtan2` curve used
// by the CPU pack (`ClippingPolygonCollection.packPolygonsAsFloats`) and by the
// SDF compute pass, not an exact `atan2` or geodetic conversion, or the lookup
// drifts against the precomputed extents. An exact geocentric `atan2` against a
// whole-globe equirectangular UV mapping never matches the per-extent atlas the
// SDF is authored in.

fn czm_fastApproximateAtanScalar(x: f32) -> f32 {
  // ShaderFastLibs Drobot atan over [0, 1]. Same coefficients as
  // `Builtin/Functions/fastApproximateAtan.glsl`.
  return x * (-0.1784 * x - 0.0663 * x * x + 1.0301);
}

fn czm_fastApproximateAtan2(x: f32, y: f32) -> f32 {
  // Range-reduction matches the WebGL CG reference path; keep it bit
  // identical to `Builtin/Functions/fastApproximateAtan.glsl` so the
  // fragment-side (lat, lon) lines up with the CPU-packed extents.
  let t0 = abs(x);
  let opp0 = abs(y);
  let adjacent = max(t0, opp0);
  let opposite = min(t0, opp0);
  var t = czm_fastApproximateAtanScalar(opposite / adjacent);
  let PI_2: f32 = 1.5707963267948966;
  let PI_F: f32 = 3.14159265358979;
  if (abs(y) > abs(x)) { t = PI_2 - t; }
  if (x < 0.0) { t = PI_F - t; }
  if (y < 0.0) { t = -t; }
  return t;
}

// Per-fragment lunar shadow on the globe.
//
// The CPU owns the expensive once-per-View limb-darkening fit and publishes
// geocentric body directions/inverse ranges. The fragment path reconstructs
// only the direct exaggerated ECEF varying scaled by those inverse ranges.
// Its sub-metre f32 quantization is tiny relative to the eclipse footprint,
// and no pass-camera reconstruction or near-parallel body subtraction occurs.
const GLOBE_ECLIPSE_SOLAR_RADIUS: f32 = 695700000.0;
const GLOBE_ECLIPSE_LUNAR_RADIUS: f32 = 1737400.0;
const GLOBE_ECLIPSE_F32_SAFETY_FACTOR: f32 = 0.999996185302734375;

// Uniform-disc (geometric) obscuration: exact support branches plus the
// closed-form circle/circle lens overlap in the partial regime.
fn globe_eclipseGeometricObscuration(rs: f32, ro: f32, d: f32) -> f32 {
  if (d >= rs + ro) {
    return 0.0;
  }
  if (d + rs <= ro) {
    return 1.0;
  }
  if (d + ro <= rs) {
    let ratio = ro / rs;
    return ratio * ratio;
  }

  let d2 = d * d;
  let rs2 = rs * rs;
  let ro2 = ro * ro;
  let alpha = acos(clamp((d2 + rs2 - ro2) / (2.0 * d * rs), -1.0, 1.0));
  let beta = acos(clamp((d2 + ro2 - rs2) / (2.0 * d * ro), -1.0, 1.0));
  let product = max(
    (-d + rs + ro) * (d + rs - ro) *
      (d - rs + ro) * (d + rs + ro),
    0.0,
  );
  let lens = rs2 * alpha + ro2 * beta - 0.5 * sqrt(product);
  let piF: f32 = 3.14159265358979;
  return clamp(lens / (piF * rs2), 0.0, 1.0);
}

// Geometric obscuration -> the CPU-fitted limb-darkened flux fraction.
// h(0)=0 and h(1)=1 structurally for every coefficient set.
fn globe_eclipseLimbDarken(a: f32) -> f32 {
  return a + a * (1.0 - a) * (
    eclipseUniforms.params.z +
    eclipseUniforms.params.w * a +
    eclipseUniforms.params2.w * a * a
  );
}

// Absolute per-fragment radiance factor G(O_frag). positionMC is the
// exaggerated ECEF globe position. Scaling it before astronomical subtraction
// keeps the common-ray operands conditioned while remaining pass-camera
// independent; the CPU closes params.x in every projected scene mode.
fn globe_eclipseFragmentFactor(positionMC: vec3<f32>) -> f32 {
  let sunInvRange = eclipseUniforms.sunDirectionAndInvRange.w;
  let moonInvRange = eclipseUniforms.moonDirectionDeltaAndInvRange.w;
  if (sunInvRange <= 0.0 || moonInvRange <= 0.0) {
    return 1.0;
  }

  // s = (S - P) / |S|. v_positionMC is already the exaggerated ECEF
  // position emitted by the globe VS. Its sub-metre f32 quantization is tiny
  // relative to the eclipse footprint and avoids reintroducing the retired
  // coarse-tile camera-RTE reconstruction.
  let pScaledSun = positionMC * sunInvRange;
  let s = eclipseUniforms.sunDirectionAndInvRange.xyz - pScaledSun;

  // D = m - s, where m = (M - P) / |M|. The geocentric direction delta
  // cancels the two near-parallel unit vectors on the CPU in f64; the shader
  // adds only the range-difference position term in the same RTE form.
  let invRangeDelta = sunInvRange - moonInvRange;
  let D =
    eclipseUniforms.moonDirectionDeltaAndInvRange.xyz +
    positionMC * invRangeDelta;

  // |m|² = |s + D|² and dot(s,m) = |s|² + dot(s,D). These identities
  // avoid materializing a second nearly-parallel body vector.
  let s2 = dot(s, s);
  let sDotD = dot(s, D);
  let moon2 = s2 + 2.0 * sDotD + dot(D, D);
  if (s2 <= 0.0 || moon2 <= 0.0) {
    return 1.0;
  }

  // Exact local support reject. With ks=sin(rs)|s| and km=sin(ro)|m|:
  //   |s||m|cos(rs+ro)
  //     = sqrt((s²-ks²)(m²-km²)) - ks*km.
  // Therefore overlap requires q=dot(s,m)+ks*km > 0 and q² greater than
  // the radicand. The safety factor expands support under permitted WGSL f32
  // fusion/reassociation; false positives reach the exact lens test below.
  let dotSunMoon = s2 + sDotD;
  let sunAngularScale = GLOBE_ECLIPSE_SOLAR_RADIUS * sunInvRange;
  let moonAngularScale = GLOBE_ECLIPSE_LUNAR_RADIUS * moonInvRange;
  let supportDot = dotSunMoon + sunAngularScale * moonAngularScale;
  let supportRadicand =
    max(s2 - sunAngularScale * sunAngularScale, 0.0) *
    max(moon2 - moonAngularScale * moonAngularScale, 0.0);
  if (
    supportDot <= 0.0 ||
    supportDot * supportDot <=
      GLOBE_ECLIPSE_F32_SAFETY_FACTOR * supportRadicand
  ) {
    return 1.0;
  }

  // Reject the antipodal angular overlap with an exact ray/ellipsoid limb
  // test. Transform P and the Sun ray by the rendered globe's inverse radii;
  // an inward ray is visible only if its closest point clears the unit sphere.
  // This is correct for WGS84/custom oblateness and elevated terrain.
  let ellipsoidInverseRadii = vec3<f32>(
    camera.ellipsoidInverseRadiiX,
    camera.ellipsoidInverseRadiiY,
    camera.ellipsoidInverseRadiiZ,
  );
  let ellipsoidPosition = positionMC * ellipsoidInverseRadii;
  let ellipsoidSunRay = s * ellipsoidInverseRadii;
  let ellipsoidRayLength2 = dot(ellipsoidSunRay, ellipsoidSunRay);
  let ellipsoidPositionDotRay = dot(ellipsoidPosition, ellipsoidSunRay);
  if (ellipsoidRayLength2 <= 0.0) {
    return 1.0;
  }
  if (ellipsoidPositionDotRay < 0.0) {
    let ellipsoidLimb = cross(ellipsoidPosition, ellipsoidSunRay);
    let closestEllipsoidRadius2 =
      dot(ellipsoidLimb, ellipsoidLimb) / ellipsoidRayLength2;
    if (
      closestEllipsoidRadius2 < GLOBE_ECLIPSE_F32_SAFETY_FACTOR
    ) {
      return 1.0;
    }
  }

  let sunDistanceScaled = sqrt(s2);
  let moonDistanceScaled = sqrt(moon2);
  let rs = asin(clamp(
    sunAngularScale / sunDistanceScaled,
    0.0,
    1.0,
  ));
  let ro = asin(clamp(
    moonAngularScale / moonDistanceScaled,
    0.0,
    1.0,
  ));

  // Well-conditioned signed-angle magnitude. cross(s,D) == cross(s,m), and
  // the denominator is dot(s,m). Unlike acos(dot(normalize(s),normalize(m))),
  // atan2 retains the ~1e-4-radian separation that defines the umbral edge.
  let separation = atan2(length(cross(s, D)), dotSunMoon);
  let geometric = globe_eclipseGeometricObscuration(rs, ro, separation);
  if (geometric <= 0.0) {
    return 1.0;
  }

  var obscuration: f32;
  if (geometric >= 1.0) {
    obscuration = 1.0;
  } else {
    let antumbraInner = rs - ro;
    if (antumbraInner > 0.0 && separation <= antumbraInner) {
      let t = separation / antumbraInner;
      obscuration = clamp(
        globe_eclipseLimbDarken(geometric) +
          eclipseUniforms.params2.z * (1.0 - t * t),
        0.0,
        1.0,
      );
    } else {
      obscuration = clamp(globe_eclipseLimbDarken(geometric), 0.0, 1.0);
    }
  }

  let visible = 1.0 - obscuration;
  let flux =
    visible + eclipseUniforms.params2.x * (1.0 - visible);
  return pow(flux, eclipseUniforms.params2.y);
}

fn globeClipByPolygon(positionWC: vec3<f32>) -> bool {
  let polyCount = effects.clippingPolygonCount;
  if (polyCount == 0u) { return false; }
  let extentsCount = u32(effects.clippingPolygonControl.x);
  if (extentsCount == 0u) { return false; }
  let invDim = effects.clippingPolygonControl.y;
  if (invDim <= 0.0) { return false; }

  let PI_F: f32 = 3.14159265358979;
  let TWO_PI: f32 = 6.28318530717958;
  // Project into plane with vertical-axis latitude — same form as
  // `czm_approximateSphericalCoordinates` in `Builtin/Functions`.
  let magXY = sqrt(positionWC.x * positionWC.x + positionWC.y * positionWC.y);
  let latitudeApproximation = czm_fastApproximateAtan2(magXY, positionWC.z);
  var longitudeApproximation = czm_fastApproximateAtan2(positionWC.x, positionWC.y);
  // GLSL VS does `czm_branchFreeTernary(lon < pi, lon, lon - twoPi)`.
  if (longitudeApproximation >= PI_F) {
    longitudeApproximation = longitudeApproximation - TWO_PI;
  }

  // Iterate merged-extent groups. Mirrors the GLSL VS region selection
  // (0.01 threshold avoids sampling on the extent boundary where the
  // SDF generator's edge cases behave poorly).
  var bestRegion: i32 = -1;
  var bestRectUv: vec2<f32> = vec2<f32>(0.0, 0.0);
  let regionCount = min(extentsCount, 8u);
  for (var r: u32 = 0u; r < regionCount; r = r + 1u) {
    let extents = effects.clippingPolygonExtents[r];
    // extents.xy = (south, west); extents.zw = (invLatRange, invLonRange).
    let rectUv = vec2<f32>(
      (longitudeApproximation - extents.y) * extents.w,
      (latitudeApproximation - extents.x) * extents.z,
    );
    let threshold: f32 = 0.01;
    if (rectUv.x > threshold &&
        rectUv.y > threshold &&
        rectUv.x < (1.0 - threshold) &&
        rectUv.y < (1.0 - threshold)) {
      bestRegion = i32(r);
      bestRectUv = rectUv;
      // Merged-extent coalescing means a fragment is contained in at most
      // one group, so first-match is equivalent to GLSL's last-match.
      break;
    }
  }
  // Fragments outside every region's bounding rectangle respect the
  // inverse flag — matches the GLSL `czm_clipPolygons` early-return path
  // (`#ifdef CLIPPING_INVERSE discard; #endif return;`).
  let inverseFlagEarly = effects.clippingPolygonControl.z;
  let invertedDiscardOutside = inverseFlagEarly >= 0.5;
  if (bestRegion < 0) { return invertedDiscardOutside; }
  if (bestRectUv.x <= 0.0 || bestRectUv.y <= 0.0 ||
      bestRectUv.x >= 1.0 || bestRectUv.y >= 1.0) {
    return invertedDiscardOutside;
  }

  // Atlas slot math — mirrors `czm_clipPolygons`:
  //   textureOffset = (regionIndex % dim, regionIndex / dim) / dim
  //   uv            = textureOffset + rectUv / dim
  // `invDim = 1/dim` is precomputed on the JS side.
  let dimF = 1.0 / invDim;
  let regionF = f32(bestRegion);
  let col = regionF - dimF * floor(regionF / dimF);
  let row = floor(regionF / dimF);
  let textureOffset = vec2<f32>(col, row) * invDim;
  let uv = clamp(
    textureOffset + bestRectUv * invDim,
    vec2<f32>(0.0),
    vec2<f32>(1.0),
  );

  let sdfValue = textureSampleLevel(
    polygonSDFTex, polygonSDFSampler, uv, 0.0).r;
  // SDF encoding: 0.5 = on edge, < 0.5 = inside polygon, > 0.5 = outside.
  //   default (inverse = 0): discard inside polygon (cutout — matches
  //     the non-`CLIPPING_INVERSE` branch of `czm_clipPolygons`);
  //   inverse = 1: discard outside polygon (keep only inside).
  let inverseFlag = effects.clippingPolygonControl.z;
  let discardInside = inverseFlag < 0.5;
  if (discardInside) {
    return sdfValue < 0.5;
  }
  return sdfValue > 0.5;
}

// Fragment shader.

// G-buffer multiple-render-target output struct.
//
// Slot 0 (@location(0)) is the scene framebuffer color. Slot 1 (@location(1))
// is the G-buffer normal-roughness texture: xyz = eye-space normal,
// w = roughness.
//
// The pipeline's slot-1 target is `{format: "rgba16float", writeMask: 0xf}`
// whenever MRT mode is on (see WebGPUGlobeSurfacePipelines.ts). Every return
// path in the fragment entry points below must go through `makeFragOutput` so
// the slot-1 emit is consistent: declaring a writable target slot without
// emitting the matching @location raises `GPUPipelineError: Color target has
// no corresponding fragment output` at pipeline creation time.
struct FragOutput {
  @location(0) color: vec4<f32>,
  //>>ifdef CAPTURE_MODE
  //>>else
  @location(1) normalRoughness: vec4<f32>,
  //>>endif
  //>>ifdef LOG_DEPTH
  @builtin(frag_depth) depth: f32,
  //>>endif
};

// Packs the slot-1 attachment. Roughness is a 0.5 placeholder until per-material
// roughness is piped through the globe pipeline. Debug entry points pass a
// sentinel (0,0,0,*) when no real normal is available; consumers such as
// ambient occlusion check `length(xyz) < 0.01` and fall back to the
// depth-derived path for those pixels.
fn makeFragOutput(color: vec4<f32>, normalEC: vec3<f32>) -> FragOutput {
  var out: FragOutput;
  out.color = color;
  //>>ifdef CAPTURE_MODE
  //>>else
  out.normalRoughness = vec4<f32>(normalEC, 0.5);
  //>>endif
  //>>ifdef LOG_DEPTH
  // Write logarithmic frag depth. g_fragLogDepth (the interpolated
  // depthFromNearPlusOne) is stashed at the top of fragmentMain so every
  // return path through makeFragOutput emits it without a parameter.
  // factor = camera.logDepth.z (oneOverLog2FarDepthFromNearPlusOne).
  out.depth = csm_writeLogDepth(g_fragLogDepth, camera.logDepth.z);
  //>>endif
  return out;
}

// Globe terrain pick entry point. Outputs the globe's
// pick color (packed at the camera-UB tail) into the single-target pick FBO.
// Rendered by the pick-pass pipeline, whose `buildPickPipelineDescriptor`
// strips the G-buffer slot-1 target, blend and MSAA from the color descriptor.
//
// Under the pick-fleet LOG_DEPTH module — compiled only when
// `isWebGPUPickLogDepthActive`, which is a separate master switch from the
// scene log switch — the globe pick writes the same log frag_depth its color
// sibling `makeFragOutput` writes: the interpolated `input.v_logDepth` through
// `csm_writeLogDepth` with factor `camera.logDepth.z`. Keeping the whole pick
// fleet on one encoding in the shared pick framebuffer is what lets nearer pick
// producers occlude farther ones. The `//>>else` branch is a single
// @location(0) output matching a bare vec4 return. There is no near-discard,
// because the color sibling has none.
//
// The globe pick command is dispatched only when `globe.pickable` is set — the
// globe stays out of the pick pass otherwise, see
// `GlobeSurfaceTileProviderRendering.updateWebGPUForPick` — so `scene.pick`
// stays undefined over the globe by default, matching WebGL, and returns the
// Globe only when the app opts in. `scene.pickPosition` reads the main-pass
// globe-depth texture rather than this framebuffer, so it works over terrain
// either way.
//
// The cartographic-limit and clipping-plane discards that `fragmentMain`
// applies are not mirrored here: an unclipped globe picks correctly, and pick
// over a clipped or limited globe is unimplemented.
struct PickFragOutput {
  @location(0) color: vec4<f32>,
  //>>ifdef LOG_DEPTH
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment
fn fragmentPickMain(input: VertexOutput) -> PickFragOutput {
  var out: PickFragOutput;
  out.color = camera.pickColor;
  //>>ifdef LOG_DEPTH
  out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepth.z);
  //>>endif
  return out;
}

// Draped vector-tile polylines, the WGSL twin of VectorCommon.glsl.

// Header word indices into `vectorTileData`. Mirrored by
// `VECTOR_TILE_HEADER_*` in `WebGPUVectorTileResources.ts`.
const VECTOR_TILE_GRID_WIDTH: u32 = 0u;
const VECTOR_TILE_GRID_HEIGHT: u32 = 1u;
const VECTOR_TILE_SEGMENT_COUNT: u32 = 2u;
const VECTOR_TILE_PRIMITIVE_COUNT: u32 = 3u;
const VECTOR_TILE_CELL_END_BASE: u32 = 4u;
const VECTOR_TILE_SEGMENTS_BASE: u32 = 5u;
const VECTOR_TILE_SEGMENT_PRIMITIVE_BASE: u32 = 6u;
const VECTOR_TILE_PRIMITIVES_BASE: u32 = 7u;

// UV-space offset from the closest point on the segment to p.
// Line-for-line port of `VectorCommon.glsl::vectorOffsetToLine`.
fn vectorOffsetToLine(p: vec2<f32>, lineSegment: vec4<f32>) -> vec2<f32> {
  let a = lineSegment.xy;
  let b = lineSegment.zw;
  let ab = b - a;
  let abLengthSquared = dot(ab, ab);
  if (abLengthSquared < 1.0e-8) {
    return p - a;
  }
  let t = clamp(dot(p - a, ab) / abLengthSquared, 0.0, 1.0);
  return p - (a + t * ab);
}

// mat2x2 is column-major in both WGSL and GLSL: m[0] is the first COLUMN, so
// the matrix is [[m[0].x, m[1].x], [m[0].y, m[1].y]] and
// det = m[0].x*m[1].y - m[1].x*m[0].y.
fn vectorDeterminant2x2(m: mat2x2<f32>) -> f32 {
  return m[0].x * m[1].y - m[1].x * m[0].y;
}

// Largest UV-Jacobian condition number (ratio of singular values) this shader
// will still invert. Above it the matrix carries no usable pixel metric and the
// fragment is abandoned. See `vectorPolylineRender` for why an exactly-zero
// determinant is not a sufficient test. Must match
// `VectorCommon.glsl::VECTOR_UV_JACOBIAN_MAX_CONDITION`.
const VECTOR_UV_JACOBIAN_MAX_CONDITION: f32 = 1.0e3;

// ‖m‖_F² — the squared Frobenius norm, i.e. σmax² + σmin². Paired with
// `vectorDeterminant2x2` (= σmax·σmin) it gives the condition number as
// ‖m‖_F² / |det| = κ + 1/κ, with no square root and no dependence on the
// matrix's overall scale.
fn vectorNormSquared2x2(m: mat2x2<f32>) -> f32 {
  return dot(m[0], m[0]) + dot(m[1], m[1]);
}

// WGSL has no `inverse()` builtin (GLSL does — `VectorCommon.glsl` line 37).
//
// PRECONDITION: `det` is the caller's `vectorDeterminant2x2(m)` and is already
// known non-singular. `vectorPolylineRender` tests it and abandons the whole
// vector path when it is zero — the test CANNOT live in here.
//
// This function has no way to say "no line is ever within range", so any matrix
// it could return for a singular input is wrong. The zero matrix — the obvious
// safe-looking choice — is the worst of them: `screenFromUv * offsetUv` becomes
// the zero vector, so `length(...) < lineWidth` is true for the first segment
// in the cell however far away that segment is, and the fragment gets painted.
// Terrain skirt quads have an exactly singular UV Jacobian, so that fallback
// paints every skirt fragment of a vector-carrying tile with the tile's first
// segment colour.
fn vectorInverse2x2(m: mat2x2<f32>, det: f32) -> mat2x2<f32> {
  let invDet = 1.0 / det;
  return mat2x2<f32>(
    vec2<f32>(m[1].y * invDet, -m[0].y * invDet),
    vec2<f32>(-m[1].x * invDet, m[0].x * invDet),
  );
}

// Drape clamped vector polylines onto the terrain surface. The fragment's
// tile UV picks a grid cell, then only that cell's line segments (packed in
// tile-local UV space) are tested for proximity. Within the line width, the
// vector color is alpha-composited over the terrain (no discard).
//
// Port of `VectorCommon.glsl::vectorPolylineRender`, with two deliberate
// deviations, both forced by WGSL rules rather than by choice:
//
//   1. The screen-space Jacobian is passed IN (`uvDx`/`uvDy`) instead of taken
//      with `dFdx`/`dFdy` inside the function. WGSL's uniformity analysis
//      rejects a derivative builtin reached through non-uniform control flow,
//      and every read from a `var<storage>` is non-uniform by definition — so
//      the header gate below would make an inline `dpdx` a shader-creation
//      error. The caller takes them at fragment entry while control flow is
//      still uniform (the same discipline `geoUV_dx`/`geoUV_dy` already use
//      for `textureSampleGrad`).
//   2. The five texelFetch tables are one storage buffer (see the binding
//      comment at the top of this file).
//
// The loop bound is clamped against the header's own `segmentCount`: a
// corrupt or stale offset must not turn a per-fragment loop unbounded.
fn vectorPolylineRender(
  vectorUv: vec2<f32>,
  uvDx: vec2<f32>,
  uvDy: vec2<f32>,
  baseColor: vec4<f32>,
) -> vec4<f32> {
  let gridWidth = vectorTileData[VECTOR_TILE_GRID_WIDTH];
  let gridHeight = vectorTileData[VECTOR_TILE_GRID_HEIGHT];
  // Placeholder buffer (or a tile with no clamped vector geometry): one load,
  // one compare, done. This is the default path on every globe fragment.
  if (gridWidth == 0u || gridHeight == 0u) {
    return baseColor;
  }

  let segmentCount = vectorTileData[VECTOR_TILE_SEGMENT_COUNT];
  let primitiveCount = vectorTileData[VECTOR_TILE_PRIMITIVE_COUNT];
  if (segmentCount == 0u || primitiveCount == 0u) {
    return baseColor;
  }

  let cellEndBase = vectorTileData[VECTOR_TILE_CELL_END_BASE];
  let segmentsBase = vectorTileData[VECTOR_TILE_SEGMENTS_BASE];
  let segmentPrimitiveBase = vectorTileData[VECTOR_TILE_SEGMENT_PRIMITIVE_BASE];
  let primitivesBase = vectorTileData[VECTOR_TILE_PRIMITIVES_BASE];

  // Inverse UV-per-pixel Jacobian: measures line distance in screen pixels so
  // width stays constant under anisotropic (oblique) foreshortening.
  //
  // A SINGULAR Jacobian has no inverse and therefore no pixel-space distance at
  // all, so the only correct answer for the fragment is "no line is in range".
  // This is not a theoretical case: terrain SKIRT quads hit it on every tile.
  // `HeightmapTessellator` computes a skirt vertex's `u`/`v` from the UNMOVED
  // edge latitude/longitude (the skirt offset is applied to the position
  // afterwards), so a north/south skirt quad carries a bit-identical `v` at all
  // four corners — both screen derivatives of `v` are exactly 0 and so is the
  // determinant. GLSL's `inverse()` divides by that zero, every comparison
  // against the resulting Inf/NaN is false, and WebGL silently drapes nothing;
  // the WGSL twin has to say so explicitly.
  //
  // A zero-matrix fallback collapses the distance to 0, which is `< lineWidth`
  // for the first segment in the cell regardless of where that segment is, so
  // the entire skirt ring of every vector-carrying tile gets painted with that
  // tile's first segment colour, drawn as faint lines along the tile-row
  // boundaries.
  //
  // An exactly-zero determinant is not a sufficient test on either backend. The
  // shader never sees the skirt's exact algebra; it sees `dpdx`/`dpdy` of a
  // perspective-interpolated varying, and interpolating a bit-identical
  // attribute still divides by the interpolated 1/w, so the recovered `v` lands
  // within an ulp or so of the edge value rather than on it. On a skirt seen
  // edge-on at nadir the quad's screen footprint collapses, which amplifies
  // that residue and inflates the `u` derivatives, so the determinant is small
  // but non-zero, the exact test lets it through, and the inverted matrix
  // reports a pixel distance far shorter than the true one — painting the
  // fragment with a segment tens or hundreds of pixels away.
  //
  // The rejection is therefore on the condition number, which is what "this
  // matrix carries no usable pixel metric" actually means. ‖M‖_F² / |det| is
  // exactly κ + 1/κ for
  // a 2x2: scale-invariant, sqrt-free, and unmovable by tile size, zoom or line
  // width. A skirt lands in the 1e4..1e6 band because its small singular value
  // is pure interpolation residue; legitimate grazing foreshortening on a drawn
  // tile stays under ~100 (past ~1e3 the tile is thinner than a pixel and has
  // nothing to drape). The determinant term still catches the exactly-singular
  // case, including the all-zero matrix that the ratio test cannot see.
  let uvJacobian = mat2x2<f32>(uvDx, uvDy);
  let uvJacobianDet = vectorDeterminant2x2(uvJacobian);
  let uvJacobianNormSquared = vectorNormSquared2x2(uvJacobian);
  if (abs(uvJacobianDet) < 1.0e-20 ||
      uvJacobianNormSquared > VECTOR_UV_JACOBIAN_MAX_CONDITION * abs(uvJacobianDet)) {
    return baseColor;
  }
  let screenFromUv = vectorInverse2x2(uvJacobian, uvJacobianDet);

  // `i32(f32)` truncates toward zero, matching GLSL's `int(float)`.
  let cellX = u32(clamp(i32(vectorUv.x * f32(gridWidth)), 0, i32(gridWidth) - 1));
  let cellY = u32(clamp(i32(vectorUv.y * f32(gridHeight)), 0, i32(gridHeight) - 1));
  let cellIndex = cellX + cellY * gridWidth;

  // GLSL reads the packed header (gridW, gridH, end0, end1, …) with a +2 / +1
  // bias; here the end-offset array is its own run, so cell i's end is
  // `cellEnd[i]` and its start is `cellEnd[i - 1]` (0 for cell 0).
  var indexEnd = vectorTileData[cellEndBase + cellIndex];
  var indexStart = 0u;
  if (cellIndex != 0u) {
    indexStart = vectorTileData[cellEndBase + cellIndex - 1u];
  }
  indexEnd = min(indexEnd, segmentCount);
  indexStart = min(indexStart, indexEnd);

  var result = baseColor;
  for (var i = indexStart; i < indexEnd; i = i + 1u) {
    let s = segmentsBase + i * 4u;
    let segment = vec4<f32>(
      bitcast<f32>(vectorTileData[s]),
      bitcast<f32>(vectorTileData[s + 1u]),
      bitcast<f32>(vectorTileData[s + 2u]),
      bitcast<f32>(vectorTileData[s + 3u]),
    );

    let primitiveIndex = min(
      vectorTileData[segmentPrimitiveBase + i],
      primitiveCount - 1u,
    );
    let p = primitivesBase + primitiveIndex * 2u;
    // GLSL stores width in an r8unorm texel and multiplies the normalized
    // read by 255; the packer writes the same byte value directly as f32.
    let lineWidth = bitcast<f32>(vectorTileData[p]);

    let offsetUv = vectorOffsetToLine(vectorUv, segment);
    if (length(screenFromUv * offsetUv) < lineWidth) {
      // Alpha-composite vector over terrain.
      // `unpack4x8unorm` yields (r, g, b, a) from the low byte upward, which
      // is the order the packer writes.
      let vectorColor = unpack4x8unorm(vectorTileData[p + 1u]);
      result = vectorColor * vec4<f32>(vectorColor.aaa, 1.0)
        + result * (1.0 - vectorColor.a);
      break;
    }
  }

  return result;
}

// GLOBE-UNDERGROUND-COLOR — port of GlobeFS.glsl `interpolateByDistance`
// (lines 159-167). nearFarScalar packs (near, nearValue, far, farValue);
// returns the value interpolated by the clamped distance ramp. Prefixed
// `globe_` (like globe_rgbToHsb) to avoid collisions if this shader ends up
// in a module graph with other WGSL that ports the same GLSL helper.
fn globe_interpolateByDistance(nearFarScalar: vec4<f32>, distance: f32) -> f32 {
  let startDistance = nearFarScalar.x;
  let startValue = nearFarScalar.y;
  let endDistance = nearFarScalar.z;
  let endValue = nearFarScalar.w;
  let t = clamp((distance - startDistance) / (endDistance - startDistance), 0.0, 1.0);
  return mix(startValue, endValue, t);
}

// Debug-only per-term bypass predicate.
// `CesiumDebug.globeFragmentDebug('bypass-*')` writes sentinels 21e9..27e9
// into `tile.time` (registry: WebGPUGlobeFragmentDebug.ts). Unlike the
// visualization modes, the bypass modes do not short-circuit
// fragmentMain — the full shading path runs with exactly ONE term skipped,
// so `diag-globe-belowsurface-decomp.mjs` can attribute the WebGL↔WebGPU
// signed-dRGB residual per term. Production output is untouched: the
// sentinel writer is pragma-stripped and the real `tile.time` is
// < 1e6, so every predicate is false (one uniform compare per site).
fn globe_debugBypassActive(sentinel: f32) -> bool {
  return tile.time > sentinel - 0.5e9 && tile.time < sentinel + 0.5e9;
}

@fragment
fn fragmentMain(
  input: VertexOutput,
  // GLOBE-UNDERGROUND-COLOR — rasterizer facing (gl_FrontFacing analogue).
  // The underground tint applies to BACK-facing fragments only (the inside
  // of the globe seen from below), matching GlobeFS.glsl `czm_backFacing()`.
  // The globe pipeline uses frontFace: "ccw" (WebGL default winding), so the
  // builtin's semantics match gl_FrontFacing exactly.
  @builtin(front_facing) frontFacing: bool,
) -> FragOutput {
  // Hoisted to the top of the function so every return path, including the
  // roughly 30 early debug returns below, has a real eye-space normal to emit
  // on slot 1. The vertex shader always writes v_normalEC, so the read is safe
  // regardless of the hasNormals pipeline variant.
  let normalEC = normalize(input.v_normalEC);
  // Clamp the interpolated texture coordinates to [0,1], matching WebGL
  // GlobeFS.glsl line 396:
  //   `computeDayColor(u_initialColor, clamp(v_textureCoordinates, 0.0, 1.0), ...)`
  // (upstream's workaround for rasterizer interpolation overshoot at tile
  // edges: fragments on shared tile boundaries can see UVs epsilon-outside
  // [0,1] even though the VS emits exactly 0/1). Without the clamp the
  // overshoot fails the `texCoordsAlpha` step-mask (rect is typically
  // (0,0,1,1)), zeroing every imagery layer for that fragment and exposing
  // the dark-blue `initialColor` (0, 0, 0.5), which draws as dashed tile-seam
  // grid lines and accounts for 62% of the mid-zoom residual against WebGL.
  // The clamp moves UVs by at most ~1e-6, invisible everywhere except the seam
  // mask.
  var geoUV = clamp(input.v_textureCoordinates.xy, vec2<f32>(0.0), vec2<f32>(1.0));
  var webMercT = clamp(input.v_textureCoordinates.z, 0.0, 1.0);
  // The 'bypass-seam-clamp' debug mode (25e9) reverts to
  // the raw, unclamped interpolated UVs so the seam-clamp delta can be
  // measured in isolation. `tile.time` is uniform, so control flow stays
  // uniform and the dpdx/dpdy below remain valid. Never taken in production.
  if (globe_debugBypassActive(25.0e9)) {
    geoUV = input.v_textureCoordinates.xy;
    webMercT = input.v_textureCoordinates.z;
  }

  //>>ifdef LOG_DEPTH
  // Stash the interpolated log-depth varying so makeFragOutput (called from
  // ~15 return sites, including the early debug returns) can write frag_depth.
  g_fragLogDepth = input.v_logDepth;
  //>>endif

  // Per-fragment UV derivatives, computed at fragment entry
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
  // Screen-space Jacobian of the raw, unclamped tile UV, for the
  // draped vector-polyline width test near the end of this function.
  // GlobeFS.glsl passes `v_textureCoordinates.xy` unclamped to
  // `vectorPolylineRender`, so the derivative is taken on the raw varying too
  // (the seam clamp moves UVs by ~1e-6 but would zero the derivative on a
  // fragment whose whole quad clamps to the same edge value).
  // Taken HERE, at fragment entry, because WGSL forbids a derivative builtin
  // under non-uniform control flow and the vector path is gated on a
  // storage-buffer read, which is non-uniform by definition. Same reason
  // `geoUV_dx`/`geoUV_dy` are hoisted.
  let vectorUV_dx = dpdx(input.v_textureCoordinates.xy);
  let vectorUV_dy = dpdy(input.v_textureCoordinates.xy);

  // Helper: select geographic V or webMercatorT per layer.
  // Matches WebGL's u_dayTextureUseWebMercatorT. Packed 4 layers
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
  // texCoordsAlpha debug. Trigger via tile.time in [1.5e9, 2.5e9].
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
  // layerCount debug. Trigger via tile.time in [2.5e9, 3.5e9].
  // Red = layer count / 16. Green = layer 0 alpha. Blue = layer 1 alpha
  // (if it exists). Each visible non-magenta tile should show layer 0
  // OR layer 1 alpha=1 for any given V, but never both 0.
  if (tile.time > 2.5e9 && tile.time < 3.5e9) {
    let lc = u32(tile.layerCount);
    let a0 = select(0.0, texCoordsAlpha(geoUV, tile.layers[0].texCoordsRect), lc >= 1u);
    let a1 = select(0.0, texCoordsAlpha(geoUV, tile.layers[1].texCoordsRect), lc >= 2u);
    return makeFragOutput(vec4<f32>(f32(lc) / 16.0, a0, a1, 1.0), normalEC);
  }
  // Direct imagery sample debug. Trigger via tile.time in
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
  // Explicit mip level debug. Forces sampling at mip 4 to
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
  // Visualize derivative magnitude as grayscale.
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
  // Direct imagery sample for layer 1.
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
  // texSample.a debug. Visualize the imagery's alpha channel
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
  // tex.a for layer 1. Used to discriminate which texture
  // upload path has alpha=0. Reprojected layers force alpha=1; direct uploads
  // via uploadImageSource for opaque JPEGs may have alpha=0.
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

  // Compute shadow factor early — textureSampleCompare must be called
  // from uniform control flow (before any non-uniform discard/return).
  // camera.enableLighting is a uniform value so this branch is uniform.
  // Routes through the cascaded-shadow path when enabled. The world-space
  // fragment position follows the atmosphere LUT convention
  // (`v_positionMC + cameraWC`); view-space depth is the magnitude of
  // `v_positionEC.z`, for a right-handed view with the camera at the origin
  // looking down -Z.
  //
  // Shadow receive is applied independently of `enableLighting`, matching
  // WebGL's `ShadowMapShader.js`, which injects
  // `out_FragColor.rgb *= visibility;` unconditionally and never wraps the
  // shadow multiply in the lighting `#ifdef`. Gating this block on
  // `camera.enableLighting > 0.5` instead leaves a scene with directional
  // lighting disabled — a common isolation setup — showing no cast shadow at
  // all, even with the cast depth map populated. The shadow factor is computed
  // whenever any shadow mode is active (point-light, cascaded or single-map)
  // and applied once to the final color below, at `color *= shadowFactor`.
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
      // Point-light cube-shadow path. `v_positionRTE` and the packed light are
      // camera-relative in the same world-axis frame, which preserves
      // point-shadow direction and distance without an absolute f32 ECEF
      // reconstruction. Takes priority over the cascaded path when both are
      // enabled; combining point and sun shadows would need an OR-combine,
      // which is unimplemented.
      shadowFactor = globeComputeShadowFactorPointLight(input.v_positionRTE);
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

  // Clipping planes discard.
  if (globeClipByPlanes(input.v_positionMC)) { discard; }

  // Clipping edge highlight.
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

  // Polygon SDF clipping, matching czm_clipPolygons.
  // GLOBE-CLIPPOLY-GEODETIC — full atlas-aware port shared with the model
  // path; see `globeClipByPolygon` above. `v_positionMC` is the fragment's
  // full ECEF world position (GlobeVS feeds the same `position3DWC` into
  // `czm_approximateSphericalCoordinates`). WebGL has no polygon edge
  // highlight on the globe (discard only), so none is applied here.
  if (effects.clippingPolygonCount > 0u) {
    if (globeClipByPolygon(input.v_positionMC)) { discard; }
  }

  // Cartographic limit rectangle clipping.
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
  // multi-pass imagery, where the CPU packer zeroes the slot.
  // previously hardcoded vec3(0.04, 0.04, 0.06), which rendered
  // rgb(10,10,15) where WebGL rendered the configured baseColor.
  var color: vec3<f32> = tile.initialColor.rgb;
  var alpha: f32 = tile.initialColor.a;

  // `normalEC` is hoisted to the top of the
  // function for the G-buffer emit. Reuse it here instead of normalizing
  // again.
  let normal = normalEC;
  let sunDir = normalize(camera.sunDirectionEC);

  // The day/night family — the imagery day/night alpha (`dayFade`), the
  // night-lights emission gate (`nightBlend`), the DAYNIGHT_SHADING Lambert
  // term and `computeTerminatorGlow` — reads the analytic geocentric surface
  // normal recomputed here per fragment, not the interpolated mesh normal
  // `input.v_normalEC`.
  //
  // `v_normalEC` is `octDecode(encodedNormal)` pushed through the view 3×3. On
  // terrain with no vertex normals the encoded normal is not a normal at all:
  // `vertexMain` reads it from the `.z` of a `float32x2`-declared attribute
  // (`WebGPUGlobeSurfacePipelines.ts:270-289`), so it holds the WebGPU default
  // 0.0 and `octDecode(0.0)` is (0, 0, -1); the quantized webMercatorT entry
  // point passes the literal 32896.0, or (0, 0, +1), purely to keep faces from
  // being culled. Both are constant model-space vectors along the spin axis, so
  // `dot(N, L)` collapses to one number for the whole globe and every day/night
  // term goes globally uniform — measurable as a day-fade slope of 0.000 across
  // the terminator. Every provider this fork can stand up offline reports
  // `hasVertexNormals === false` (`EllipsoidTerrainProvider.js:154`,
  // `CustomHeightmapTerrainProvider.js:216`,
  // `ArcGISTiledElevationTerrainProvider.js:425`), so that is the default path.
  //
  // The recompute is unconditional because WebGL's law leaves no arm for which
  // the mesh normal is right. `GlobeSurfaceShaderSet.js:435-442` emits
  // `ENABLE_VERTEX_LIGHTING` and `ENABLE_DAYNIGHT_SHADING` as mutually
  // exclusive arms of `if (hasVertexNormals)`:
  //   • no vertex normals → `ENABLE_DAYNIGHT_SHADING`, and `GlobeFS.glsl:595-597`
  //     computes `normalMC = czm_geodeticSurfaceNormal(v_positionMC, vec3(0),
  //     vec3(1))` — which with `oneOverRadiiSquared = (1,1,1)` is exactly
  //     `normalize(v_positionMC)` — then `normalEC = czm_normal3D * normalMC`,
  //     per fragment. The day/night alpha at `:600` and the day/night diffuse
  //     both consume that analytic normal.
  //   • vertex normals → `ENABLE_VERTEX_LIGHTING`, and the day/night term does
  //     not exist at all: `GlobeFS.glsl:600`'s `#if defined(APPLY_DAY_NIGHT_ALPHA)
  //     && defined(ENABLE_DAYNIGHT_SHADING)` fails, so `nightBlend = 0.0`.
  // Recomputing analytically without a gate needs no new `ShaderDefine` bit:
  // the expression sits at `//>>ifdef` depth 0 and expands identically under
  // every define set.
  //
  // One divergence remains open: on vertex-normal terrain this still applies
  // the ramp where WebGL gates it off entirely. Feeding the analytic normal
  // there keeps that divergence to a single axis — whether the term exists at
  // all — rather than compounding it with a normal WebGL never computes. The
  // VERTEX_LIGHTING Lambert below keeps `normal`, because that term really is
  // WebGL's mesh-normal term.
  //
  // SPACE. `camera.modifiedModelView`'s upper-3×3 is the view rotation (RTE
  // only offsets the translation column), so a `w = 0` transform reproduces
  // `czm_normal3D` for the identity-model globe — the same reduction the ocean
  // path documents at its `sphereNormalMC` derivation below, and the same 3×3
  // the vertex stage already uses to build `v_normalEC`. `sunDir` is eye-space
  // (`camera.sunDirectionEC`), so both operands share a frame. `v_positionMC`
  // is the absolute ECEF position in every scene mode (the vertex stage assigns
  // it from `position3DWC`), matching GLSL's `v_positionMC` exactly.
  let dayNightNormalEC = normalize(
    (camera.modifiedModelView *
      vec4<f32>(normalize(input.v_positionMC), 0.0)).xyz,
  );

  // Day/night fade factor: 0 = night, 1 = day.
  // Gated on `camera.enableLighting`. The WebGL GlobeFS
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
    dayFade = computeDayNightFade(dayNightNormalEC, sunDir);
    nightBlend = 1.0 - dayFade;
  } else {
    dayFade = 1.0;
    nightBlend = 0.0;
  }

  // Composite imagery layers.
  // Sixteen layer slots. Each layer block applies the same effect chain via
  // `applyImageryLayer`:
  //   colorToAlpha → gamma → split → cutout → brightness/contrast/saturation/hue
  // The 16 blocks are unrolled because WGSL forbids dynamic indexing of
  // texture bindings; the per-pass `count` gate skips inactive slots so
  // the cost of the unused branches is one comparison + a structurally-zero
  // mask in the helper.
  let count = u32(tile.layerCount);

  // Debug: imagery layer isolation. Negative => all layers render
  // (production). 0..15 => only that layer's slot in the current pass
  // contributes to the composite.
  let isolate = i32(tile.tileControls.y);

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
  //>>ifdef GLOBE_IMAGERY_REDUCED
  // Reduced layout
  // carries four imagery slots per pass; slots 4..15 don't exist. The CPU
  // multi-pass slicer caps `tile.layerCount` at four, so the blocks above
  // still composite every layer in this pass without feature loss.
  //>>else
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

  // Post-composite color debug. Trigger via tile.time in
  // [7.5e9, 8.5e9]. Returns the imagery-composited color BEFORE all
  // material/atmosphere/HSB/fog effects. If this shows clean imagery
  // but production shows black, the bug is in the subsequent effects.
  if (tile.time > 7.5e9 && tile.time < 8.5e9) {
    return makeFragOutput(vec4<f32>(color, 1.0), normalEC);
  }
  // Post-composite alpha debug. Trigger via [8.5e9, 9.5e9].
  // Returns the accumulated alpha as grayscale. If alpha is 0 here,
  // the imagery composite produced no contribution.
  if (tile.time > 8.5e9 && tile.time < 9.5e9) {
    return makeFragOutput(vec4<f32>(alpha, alpha, alpha, 1.0), normalEC);
  }

  // Subsequent passes only apply imagery — skip all effects
  if (isSubsequentPass) {
    return makeFragOutput(vec4<f32>(color, alpha), normalEC);
  }

  // Globe material composite.
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
  // Reuse the `normalEC` hoisted at the top of the function.
  matInput.normalEC = normalEC;
  matInput.positionToEyeEC = -input.v_positionEC;
  // tangentToEyeMatrix: east-north-up frame at the fragment, transformed
  // to eye space. WebGL builds it via `czm_eastNorthUpToEyeCoordinates`;
  // the substitution here is the identity, because none of the in-tree globe
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

  // Water mask and ocean rendering. The GLSL counterpart is called from
  // `Shaders/GlobeFS.glsl` around lines 433-495 and implemented at
  // `GlobeFS.glsl` L777-849 as `computeWaterColor`, gated by
  // `#ifdef SHOW_REFLECTIVE_OCEAN`. A change to this block has to land with a
  // matching change there. See SHADER_PAIRS_LOCKSTEP.md.
  //
  // Both backends use an additive blend:
  //   `color = imageryColor + diffuseHighlight + nonDiffuseHighlight + specular`
  // Imagery is preserved as the base and ocean highlights are added to it. A
  // replacement blend such as `mix(imagery, deepColor × darkening, 0.6)` dims
  // aerial ocean imagery by roughly 5× at orbit altitudes.
  //
  // `computeWaterColor` is hand-written GLSL, not output of Cesium's
  // material-system codegen, so both halves of this pair need manual
  // line-by-line edits.
  //
  // `computeEnhancedOcean` is `//>>ifdef ENHANCED_OCEAN`-gated at the styling
  // boundary: the shared wave march (`sampleOceanWaveNormals` feeding
  // `waterNormal`, `tsPerturbationRatio` and `foamFactor`) runs unconditionally
  // for both branches, and only the colour derivation is gated. The
  // `//>>ifdef` branch is the enhanced look; the `//>>else` branch is a
  // faithful port of WebGL's classic `computeWaterColor` and is the default,
  // with the hi word clear. Divergences 5-7 below are therefore
  // enhanced-branch only, and the default branch matches WebGL. The bit is
  // `ShaderDefineHi.ENHANCED_OCEAN`, OR'd in when `Globe.enableEnhancedOcean`
  // (default false) is set.
  //
  // Structural divergences, separate from the matched algorithm:
  //
  // 1. **Gating**. GLSL: `#if defined(HAS_WATER_MASK) && (defined(SHOW_
  //    REFLECTIVE_OCEAN) || defined(APPLY_MATERIAL))`. WGSL: runtime
  //    `tile.flags.x > 0.5` (CPU-side: `showReflectiveOcean =
  //    hasWaterMask && tileProvider.showWaterEffect === true`).
  // 2. **Water-mask resource realization**. Both shaders apply the same
  //    post-translation UV Y-flip. On WebGPU the globe borrows the native
  //    GPUTexture already realized by Texture/WebGLStubTexture whenever it
  //    belongs to the same GPUDevice; the rare cross-device fallback upload
  //    preserves the same source-row order.
  // 3. **Function home**. GLSL `computeWaterColor` is hand-written in
  //    GlobeFS.glsl L777-849 behind `#ifdef SHOW_REFLECTIVE_OCEAN`.
  //    WGSL `computeEnhancedOcean` is hand-inlined in this shader
  //    (lines 1861-1933). Both require manual line-by-line edits;
  //    neither is generated.
  // 4. **Wave-normal source**. GLSL uses `czm_getWaterNoise(
  //    u_oceanNormalMap, textureCoordinates × oceanFrequency*, time, 0)`
  //    with two altitude layers and `czm_ellipsoidTextureCoordinates(
  //    normalMC)` for globe-consistent wrapping. The WGSL march samples in the
  //    same global ellipsoid (lon/lat) UV, at integer repeat counts
  //    (`OCEAN_OCTAVE_REPEATS_*`, about 150/50/15 m), decomposed
  //    relative-to-eye through CPU-packed f64 phase offsets for f32 precision.
  //    Both backends mip-average — WGSL through `textureSampleGrad` plus a
  //    sampler maxAnisotropy of 8, GLSL through `texture()` auto-LOD — and
  //    apply a footprint amplitude fade with a hard cutoff. The fade band, in
  //    repeats per pixel, and the cutoff are shared and pinned by
  //    ocean-wave-lod.spec.mjs. The per-layer scale is deliberately not
  //    shared: WGSL picks physical wavelengths, while GLSL keeps
  //    czm_getWaterNoise with its fade keyed on the effective divisor. Wave
  //    appearance is therefore similar but not identical, and strict pixel
  //    parity is not a goal here.
  // 5. **Specular model**. Matched in both branches: each uses the
  //    `czm_getSpecular` Phong lobe
  //    (`pow(max(dot(reflect(-L, N), V), 0), 10)`) times the
  //    waveIntensity-modulated `surfaceReflectance`, unconditionally, with no
  //    enableLighting gate and no orbit fade. A GGX lobe with an orbit fade
  //    suppresses the zoomed-out sun glint WebGL shows at orbital altitudes.
  //    `distributionGGX` remains defined but unused.
  // 6. **Foam (whitecaps)**. Enhanced branch only. WGSL's `computeFoam`
  //    overlays white pixels where wave normals are steep; GLSL has no
  //    equivalent, and the classic `//>>else` default branch omits it, so foam
  //    renders only when `Globe.enableEnhancedOcean` is set.
  // 7. **Subsurface scattering**. WGSL has `computeSubsurfaceScattering`
  //    defined but currently unused (neither branch calls it) — scaffolding
  //    for future enhancement; GLSL has no equivalent.
  //
  // Enhanced water mask and ocean rendering.
    if (tile.flags.x > 0.5) {
      let wmTS = tile.waterMaskTranslationAndScale;
      let waterUVUnflipped = geoUV * wmTS.zw + wmTS.xy;
      let waterUV = vec2<f32>(waterUVUnflipped.x, 1.0 - waterUVUnflipped.y);
      let waterMask = textureSampleLevel(waterMaskTexture, waterMaskSampler, waterUV, 0.0).r;

    // NS-WATER-MASK-COAST-AA — screen-space anti-aliased coast coverage.
    // The water mask is a low-resolution bitmap; a single bilinear sample
    // resolves the coastline at texel granularity, so at low zoom (a mask
    // texel spanning ~1 screen pixel) the water/land boundary aliases into
    // a jagged staircase and, at high zoom, kinks at each bilinear-patch
    // seam. The coverage smoothstep is widened by the mask's screen-space
    // rate of change so the boundary feathers over ~1 screen pixel (killing
    // the staircase), while the 0.2 floor keeps the high-zoom bilinear ramp
    // soft. This never moves the 0.5 isoline, so the coast stays spatially
    // accurate and both land (mask≈0 → coverage 0) and open-ocean (mask≈1 →
    // coverage 1) interiors are byte-identical to a hard step.
    //
    // WGSL forbids `fwidth` here (this is downstream of non-uniform
    // discards), so the mask's per-pixel footprint is reconstructed from the
      // UV derivatives hoisted to fragment entry (geoUV_dx/geoUV_dy, computed
      // in uniform control flow). The post-transform Y flip reverses one
      // derivative component's sign, which does not change the vector lengths
      // below. One screen pixel therefore still steps
      // `geoUV_d* * wmTS.zw * wmDim` texels; near a coast the bilinear mask
      // changes ≈1.0 per texel, making this the fwidth(mask) analogue. Twin of
      // the GLSL fwidth path in GlobeFS.glsl.
    let wmDim = vec2<f32>(textureDimensions(waterMaskTexture, 0));
    let maskTexelDx = geoUV_dx * wmTS.zw * wmDim;
    let maskTexelDy = geoUV_dy * wmTS.zw * wmDim;
    let maskScreenGrad = length(maskTexelDx) + length(maskTexelDy);
    // Cap the band at 0.5: at band=0.5 the smoothstep spans the full [0,1]
    // mask range, so open ocean (mask=1 → coverage 1) and land (mask=0 →
    // coverage 0) interiors stay EXACTLY unchanged — a wider band would clip
    // `smoothstep(0.5-band, 0.5+band, 1.0)` below 1 and dim the open-ocean
    // effect. The 0.2 floor reproduces the prior smoothstep(0.3,0.7) feather
    // at close zoom (byte-identical there); the band only grows for AA as the
    // mask footprint per pixel increases at lower zoom.
    let coastBand = clamp(maskScreenGrad * 1.5, 0.2, 0.5);
    let coastCoverage = smoothstep(0.5 - coastBand, 0.5 + coastBand, waterMask);

    if (coastCoverage > 0.0) {
      // GLOBE-POLAR-STRETCH-POLISH — WebGL's computeWaterColor receives
      // the ANALYTIC sphere normal, not the terrain mesh vertex normal:
      // GlobeFS.glsl L382-383 computes
      //   normalMC = czm_geodeticSurfaceNormal(v_positionMC, vec3(0), vec3(1))
      //            = normalize(v_positionMC)
      //   normalEC = czm_normal3D * normalMC
      // and feeds THAT into the enuToEye frame + specular. Passing the
      // interpolated mesh normal instead tilted the orbit sun-glint lobe
      // ~10 px limb-ward vs WebGL. The upper-3x3 of modifiedModelView is
      // the view rotation (RTE only offsets the translation column), so
      // a w=0 transform reproduces czm_normal3D for the identity-model
      // globe.
      let sphereNormalMC = normalize(input.v_positionMC);
      let oceanNormalEC = normalize(
        (camera.modifiedModelView * vec4<f32>(sphereNormalMC, 0.0)).xyz,
      );
      // Q10-DAYTIME-OCEAN-BRIGHTNESS — pass WebGL's atmosphere camera-distance
      // `fade` (packed as `groundAtmosphereControl.y` = the lightingFade clamp,
      // identical to GlobeFS.glsl L428) for the ocean highlight taper, NOT the
      // day/night `dayFade` (which is 1.0 when enableLighting is off → would
      // zero the daytime diffuseHighlight). See computeEnhancedOcean header.
      let oceanColor = computeEnhancedOcean(
        color, input.v_positionEC, input.v_positionMC, oceanNormalEC, sunDir,
        geoUV, geoUV_dx, geoUV_dy, waterMask, tile.groundAtmosphereControl.y,
        input.v_distance
      );
      // Feather the ocean effect in over the anti-aliased coast band.
      color = mix(color, oceanColor, coastCoverage);
    }
  }

  // Lighting and shadow receive. The GLSL counterpart is
  // `Shaders/GlobeFS.glsl` around lines 515-524 for lighting; shadows are
  // injected by the WebGL pipeline cache via `ShadowMapShader.js` and are not
  // present in the GlobeFS.glsl source. A change to this block has to land
  // with a matching change there. See SHADER_PAIRS_LOCKSTEP.md.
  //
  // The day/night arm runs WebGL's law verbatim; the coefficients are not
  // reinterpreted here.
  //
  // - WebGL has three mutually exclusive lighting variants gated by
  //   #ifdef:
  //     ENABLE_VERTEX_LIGHTING — diffuse with `u_lambertDiffuseMultiplier`
  //       and `u_vertexShadowDarkness` uniforms; multiplies by
  //       `czm_lightColor`. Used for tile-provider-driven custom
  //       lighting.
  //     ENABLE_DAYNIGHT_SHADING — `clamp(NdotL × 5 + 0.3, 0, 1)`, mixed with
  //       full brightness by the camera-distance `fade` so close-camera tiles
  //       are flat-lit and orbit tiles get full day/night.
  //     (neither) — pass-through, no shading.
  //
  // - WGSL has one runtime gate (`camera.enableLighting > 0.5`) selecting
  //   between the same two arms via `camera.lighting.z` (hasVertexNormals):
  //     lighting.z > 0.5 → `clamp(NdotL × lighting.x + lighting.y, 0, 1)`
  //       (WebGL's ENABLE_VERTEX_LIGHTING formula, mesh normal)
  //     lighting.z ≤ 0.5 → `mix(1.0, computeDayNightDiffuse(dayNightNormalEC,
  //       sunDir), tile.lightingFade)` (WebGL's ENABLE_DAYNIGHT_SHADING
  //       formula, analytic normal, same camera-distance mix)
  //   Then optionally adds `computeTerminatorGlow(dayNightNormalEC, sunDir)`,
  //   the same explicit appearance contribution as GlobeFS.glsl.
  //
  // Both backends run `clamp(NdotL × 5 + 0.3, 0, 1)` on the DAYNIGHT arm,
  // mixed toward 1.0 by the camera-distance fade, and the imagery day/night
  // alpha ramp is the separate `clamp(NdotL × 5, 0, 1)` on both. Both feed the
  // day/night term the analytic geocentric normal recomputed per fragment and
  // the VERTEX_LIGHTING term the interpolated mesh normal. `tile.lightingFade`
  // carries WebGL's camera-distance clamp (GlobeFS.glsl:620-644, :852), packed
  // CPU-side in `WebGPUGlobeSurfaceTileUB.ts` because the WGSL has neither
  // `czm_view` nor `czm_frustumPlanes`; without it the night side stays dark at
  // every altitude.
  //
  // Structural divergences:
  //
  // 1. **Gating mechanism.** GLSL uses three #ifdef variants, WGSL a single
  //    runtime gate. Shape only — the same three outcomes are reachable.
  // 2. **Custom light color.** GLSL multiplies by `czm_lightColor`; WGSL
  //    multiplies by `camera.lightColor.rgb`, packed from
  //    `uniformState.lightColor`. The default white (1,1,1) leaves scenes
  //    without a custom `scene.light` unaffected.
  // 3. **Terminator glow.** Both backends add the same optional warm colour
  //    band at the day/night boundary; WGSL reads its strength at runtime.
  // 4. **Shadow receive.** GLSL carries no shadow code: the WebGL pipeline
  //    cache injects shadow-sampling GLSL through `ShadowMapShader.js` per
  //    pipeline, from the shadow-map config. WGSL inlines three shadow paths
  //    directly —
  //      `globeComputeShadowFactorPointLight` (cube-shadow point light)
  //      `globeComputeShadowFactorCSM` (cascaded shadow maps)
  //      `globeComputeShadowFactor` (single-map default)
  //    gated at the top of `fragmentMain`. The pipeline-cache model forces the
  //    difference: WebGL injects per-config GLSL strings, WebGPU compiles a
  //    fixed shader with runtime gates.
  // 5. **Vertex-normal gating.** WebGL emits ENABLE_VERTEX_LIGHTING instead of
  //    ENABLE_DAYNIGHT_SHADING, so its day/night imagery alpha does not exist
  //    at all on vertex-normal terrain, where WGSL still applies the ramp.
  // 6. **Vertex-lighting customization.** The GLSL ENABLE_VERTEX_LIGHTING path
  //    uses `u_lambertDiffuseMultiplier` and `u_vertexShadowDarkness` for
  //    tile-provider-driven shading. WGSL bridges those through
  //    `camera.lighting.x/y` and gates between the WebGL
  //    ENABLE_VERTEX_LIGHTING formula (a direct `NdotL × mult + darkness`) and
  //    the DAYNIGHT_SHADING analogue via `camera.lighting.z`, the
  //    hasVertexNormals flag from `terrainProvider.hasVertexNormals`.
  //
  // Fragment-local eclipse factors. A camera-anchored factor has already been
  // applied at the uniform source to selected radiance producers: the absolute
  // factor is for an undimmed term, while the relative one divides that camera
  // factor back out before applying this fragment's. The uniform gate is zero
  // in ordinary and non-3D frames, leaving both exact identities.
  var eclipseAbsolute: f32 = 1.0;
  var eclipseRelative: f32 = 1.0;
  if (eclipseUniforms.params.x > 0.5) {
    // Gates 3 and 4 restore only the producers the uniform-source factor
    // dimmed, without paying common-ray, ellipsoid-horizon, overlap or
    // limb-fit arithmetic.
    if (eclipseUniforms.params.x < 2.5) {
      eclipseAbsolute = globe_eclipseFragmentFactor(input.v_positionMC);
    }
    eclipseRelative = eclipseAbsolute * eclipseUniforms.params.y;
  }

  // Lambert diffuse lighting and shadow receive.
  if (camera.enableLighting > 0.5) {
    // WebGL's two lighting arms read two different normals, as the normal-source
    // block above sets out: ENABLE_VERTEX_LIGHTING is the mesh-normal term and
    // ENABLE_DAYNIGHT_SHADING is the analytic-normal term. Each branch below
    // takes the one its WebGL twin takes — this one the mesh normal, the
    // DAYNIGHT arm the analytic `dayNightNormalEC`, inside
    // `computeDayNightDiffuse`.
    let NdotL = max(dot(normal, sunDir), 0.0);
    var diffuse: f32;
    if (camera.lighting.z > 0.5) {
      // VERTEX_LIGHTING path: terrain has vertex normals.
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
      // DAYNIGHT_SHADING arm: terrain has no vertex normals.
      //
      // CLT-B4 (CO-18) — WebGL's law verbatim, GlobeFS.glsl:851-852:
      //   diffuseIntensity = clamp(czm_getLambertDiffuse(L, N) * 5.0 + 0.3, 0, 1);
      //   diffuseIntensity = mix(1.0, diffuseIntensity, fade);
      // It reads the ANALYTIC normal (GlobeFS.glsl:595-597), it is a DIFFERENT
      // expression from the imagery-alpha ramp (`+ 0.3`, not the bare ramp),
      // and it is mixed toward FULL brightness by the camera-distance `fade` —
      // so a close camera renders a flat-lit globe on both backends and only at
      // orbit does the terminator appear in the lighting term.
      //
      // WHAT THIS REPLACED, and what the replacement is worth. The previous
      // expression was `mix(0.025, dayNightNdotL * 0.88 + 0.12, dayFade)`: a
      // second law, driven by the imagery-alpha ramp, with no camera-distance
      // term at all. `probe-daynight-terminator-law.mjs` run 2 (tip
      // `679cbf5173`) measured lane D's night/day luminance ratio at two
      // altitudes; WebGL read 1.000 (3 Mm) and 0.300 (25 Mm), which are EXACTLY
      // this expression's closed form — `mix(1, 0.3, 0) / 1` and `0.3 / 1` —
      // because 3 Mm sits below `lightingFadeOutDistance` (π/2 × Rmin ≈
      // 9.98 Mm ⇒ fade 0) and 25 Mm above `lightingFadeInDistance` (π × Rmin ≈
      // 19.97 Mm ⇒ fade 1). WebGPU read 0.312 / 0.0896 against it.
      //
      // Shadow is applied to the FINAL color below, not folded into this term
      // (matching WebGL's `out_FragColor.rgb *= visibility`).
      let dayNightDiffuse = computeDayNightDiffuse(dayNightNormalEC, sunDir);
      diffuse = mix(1.0, dayNightDiffuse, clamp(tile.lightingFade, 0.0, 1.0));
    }
    // `camera.lightColor` mirrors WebGL's `czm_lightColor`
    // automatic uniform. Scene-provided custom light colors (e.g.
    // `scene.light.color = Color.ORANGE`) now propagate to the globe
    // diffuse term on WebGPU, matching GlobeFS.glsl ENABLE_VERTEX_LIGHTING
    // and ENABLE_DAYNIGHT_SHADING which both multiply by `czm_lightColor`.
    // Default is (1,1,1) so non-customized scenes are unchanged.
    color = color * diffuse * camera.lightColor.rgb;

    // The surface product carries S2 only for active/correction SunLight
    // gates 2/3. Custom-light gates 1/4 keep the absolute surface factor;
    // dividing a factor it never carried would invert the eclipse.
    color = color * select(
      eclipseAbsolute,
      eclipseRelative,
      eclipseUniforms.params.x > 1.5 &&
        eclipseUniforms.params.x < 3.5,
    );

    // The additive terminator glow contains no S2-scaled light quantity. It
    // peaks at N·L ≈ 0 and therefore uses the geocentric analytic normal, not
    // local terrain slope. Zero is the default identity and branches before
    // computeTerminatorGlow's exp(); enabled values use the same law and
    // eclipseAbsolute factor as GlobeFS.glsl.
    let terminatorGlowStrength = max(tile.tileControls.z, 0.0);
    if (terminatorGlowStrength > 0.0) {
      color +=
        computeTerminatorGlow(dayNightNormalEC, sunDir) *
        terminatorGlowStrength *
        eclipseAbsolute;
    }
  } else {
    // Raw imagery/ocean surface: S2 never reached it.
    color = color * eclipseAbsolute;
  }

  // Apply the shadow receive
  // ONCE to the final color, independent of `enableLighting`. Mirrors
  // WebGL's `ShadowMapShader.js`: `out_FragColor.rgb *= visibility;` runs
  // outside the lighting branch, so cast shadows darken the surface even
  // when directional lighting is off. `shadowFactor` is 1.0 (no-op) when no
  // shadow mode is active, so lighting-only scenes are unchanged.
  color = color * shadowFactor;

  // Darken lit ground under the procedural clouds by
  // the sun-view beer shadow map. Gated on `cloudShadowControl.x` so the default
  // (globe.cloudCastShadows off) leaves `color` byte-identical (the placeholder is
  // never read). The position operand follows the frame the CPU
  // published: eye-relative `v_positionRTE` in SCENE3D, absolute `v_positionMC`
  // in the planar modes.
  if (camera.cloudShadowControl.x > 0.5) {
    color =
      color *
      sampleCloudGroundShadow(
        cloudShadowPositionOperand(input.v_positionRTE, input.v_positionMC),
      );
  }

  // Ground atmosphere and fog. The GLSL counterpart is
  // `Shaders/GlobeFS.glsl` around lines 512-603; a change to this block has to
  // land with a matching change there. See SHADER_PAIRS_LOCKSTEP.md.
  //
  // Structural divergences, all intentional:
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
  //    `cameraDist > nightFadeOutDistance` ≈ 10 Mm). WGSL always goes
  //    per-fragment, through `computeAtmosphereScatteringGround`, because the
  //    per-vertex path produces a mesh-pattern artifact at orbit altitudes:
  //    interpolated optical depths diverge across triangles spanning the limb.
  //    The per-vertex varyings remain in the WGSL vertex shader in case the
  //    close-camera optimization is reintroduced.
  //
  // 3. **LUT integration.** WGSL adds a path that samples a
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
  // Fog blending and ground atmosphere.
  // Matches WebGL `czm_fog(distance, color, fogColor)`: mixes color toward
  // fogColor by the fog amount and leaves alpha alone. Upstream does not drop
  // alpha at high fog, and dropping it turns distant terrain transparent,
  // exposing the black skybox behind it whenever the camera tilts toward the
  // horizon — the opposite of what fog should do.
  //
  // When the atmosphere LUT is available — compute is supported and the
  // SkyAtmosphere feature renderer has dispatched the compute pass at least
  // once — sample the inscatter
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
      // A single-precision subtract is enough here, because it feeds into
      // a texture sample, not a transform.
      let cameraWC = camera.encodedCameraHigh + camera.encodedCameraLow;
      // v_positionMC is already the absolute ECEF position used by the
      // ground-atmosphere path below. Adding cameraWC a second time displaces
      // LUT sampling by the camera's ECEF vector and makes fog camera-relative.
      let fragmentWorldPos = input.v_positionMC;
      let lut = sampleAtmosphereFogLut(fragmentWorldPos, cameraWC);
      // Use the LUT's inscatter directly when it returns meaningful
      // magnitude; the placeholder texture produces zero, which falls
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

    // Ground atmosphere: per-fragment ray-march at orbit
    // distances. WebGL `GlobeFS.glsl` switches between per-vertex and
    // per-fragment scattering via `#ifdef PER_FRAGMENT_GROUND_ATMOSPHERE`
    // (defined CPU-side when `cameraDist > nightFadeOutDistance`). At
    // orbit the per-vertex path produces wildly different Rayleigh / Mie
    // values across the tile mesh — short marches (~110m of atmosphere)
    // on near-side vertices vs ~13Mm marches on far-side limb vertices,
    // interpolated linearly across the triangle → mesh-pattern artifact
    // overwriting imagery via `mix(color, draped, fadeAmount=1.0)`.
    // This path is per-fragment unconditionally, for parity at orbit. The
    // vertex-stage march runs only when the per-vertex debug visualizers are
    // active (`tile.time ∈ [13.5e9,15.5e9]`); in production the v_atmosphere*
    // varyings stay zero and are never read outside those debug returns, so
    // this is the sole owner of the production integration.
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

    // The air column above the surface shadow is solar radiance too. The
    // Nishita ground-scattering producer already carries the scene-scaled
    // atmosphere intensity, while the analytic fallback and the LUT do not, so
    // the relative or absolute factor is selected at the producer boundary and
    // the geometric opacity is left untouched.
    let atmoCarriesSceneFactor = camera.atmosphereParams.w > 0.5;
    groundAtmoColor = groundAtmoColor * select(
      eclipseAbsolute,
      eclipseRelative,
      atmoCarriesSceneFactor,
    );

    if (fogDensity > 0.0) {
      // FOG branch — close to the ground. Mirrors GlobeFS.glsl lines
      // 519-533: `czm_fog(distance, color, fogColor, scalar)` mixes
      // imagery toward atmosphere color by a distance-driven scalar.
      let fogAmount = computeFog(input.v_distance, fogDensity, tile.fogVisualDensityScalar);
      var fogColor = groundAtmoColor;
      // The night-fog darken factor follows WebGL's gating.
      // WebGL `GlobeFS.glsl` lines 522-526:
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
      // The gate is load-bearing. An ungated
      // `nightFogDimming = mix(0.05, 1.0, dayFade)` with a
      // `max(fogColor * nightFogDimming, fogMinimumBrightness)` floor dims fog
      // to `fogMinimumBrightness` (default 0.03) in scenes with the default
      // `enableLighting = false`, where WebGL leaves fog at full brightness so
      // the dim ground-atmosphere contribution still lets imagery through.
      // That floor tonemaps and gamma-encodes to about 24 sRGB and overwrites
      // every imagery pixel at high fog density, flattening the whole
      // below-horizon area to a uniform (24, 24, 24) grey.
      //
      // `camera.atmosphereParams.w > 1.5` mirrors the WebGL `dynamicLighting`
      // bool, encoded 0 off, 1 static, 2 lit. With dynamic lighting active the
      // multiplier is `clamp(dot(viewerNormalized, lightDir),
      // minimumBrightness, 1.0)`; otherwise the fog color stays at full
      // brightness, matching WebGL's ungated path.
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
      // The 'bypass-fog' debug mode (27e9) skips the fog
      // mix so the near-ground atmosphere term (the branch below-surface
      // scenes actually take — v_distance is megameters underground, so
      // fogAmount saturates) can be measured in isolation.
      if (!globe_debugBypassActive(27.0e9)) {
        color = mix(color, fogColor, fogAmount);
      }
      // Alpha intentionally untouched — terrain stays opaque through fog.
    } else if (groundAtmosphereEnabled) {
      // Far-from-ground drape — mirrors the WebGL `#else` branch of
      // `#if defined(GROUND_ATMOSPHERE) || defined(FOG)` in GlobeFS.glsl
      // (lines 535-563). FOG is undefined whenever the camera is above
      // Fog.maxHeight (default 800 km), but GROUND_ATMOSPHERE may still
      // be enabled. Without this branch the entire atmospheric drape goes
      // missing at orbital altitudes and only the SkyAtmosphere shell at the
      // limb remains visible.
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
      // Use the per-vertex opacity from the Nishita march when atmosphere is
      // enabled, falling through to the LUT-sampled opacity, or the 0 default,
      // when it is disabled.
      let opacityForDrape = select(
        atmosphereOpacity,
        clamp(1.0 - groundAtmoOpacity, 0.0, 1.0),
        camera.atmosphereParams.w > 0.5,
      );
      let transmittance = transmittanceModifier + opacityForDrape;
      // The drape math here is WebGL's, unscaled:
      // `color + atmoColor * transmittance`, combined with the `darken` and
      // `sunlitAtmosphereIntensity` mixes from GlobeFS.glsl lines 546-554.
      // There are no empirical correction factors in this branch, because the
      // light direction is corrected at the source instead — see the vertex
      // path and the CPU `atmosphereParams.w` packing. Tracing toward the
      // packed sun direction in both lighting modes over-accumulates radiance,
      // since WebGL under the default DynamicAtmosphereLighting.NONE
      // substitutes `normalize(positionWC)` per vertex: every vertex then sees
      // a straight-up light ray, optical depth stays uniform, and the
      // integrated radiance lands in the 0.3-0.6 range that matches orbital
      // photography. Capping and rescaling the radiance downstream treats the
      // symptom; the ray-march itself is equivalent to
      // `AtmosphereCommon.glsl::computeScattering`.
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
      // GlobeFS.glsl line 302; when on, the post-process receives the
      // raw linear-HDR color and let it tonemap downstream.
      var draped: vec3<f32>;
      if (tile.groundAtmosphereControl.w > 0.5) {
        draped = finalAtmosphereColor;
      } else {
        let exposure: f32 = 2.0;
        draped = vec3<f32>(1.0) - exp(-exposure * finalAtmosphereColor);
      }
      let fadeAmount = tile.groundAtmosphereControl.y;
      // Visualize per-vertex v_atmosphereRayleighColor via [13.5e9, 14.5e9].
      if (tile.time > 13.5e9 && tile.time < 14.5e9) {
        return makeFragOutput(vec4<f32>(input.v_atmosphereRayleighColor, 1.0), normalEC);
      }
      // Visualize per-vertex v_atmosphereMieColor via [14.5e9, 15.5e9].
      if (tile.time > 14.5e9 && tile.time < 15.5e9) {
        return makeFragOutput(vec4<f32>(input.v_atmosphereMieColor, 1.0), normalEC);
      }
      // Visualize viewDir via [15.5e9, 16.5e9]. Maps from [-1,1] to [0,1].
      if (tile.time > 15.5e9 && tile.time < 16.5e9) {
        let cameraWC2 = camera.encodedCameraHigh + camera.encodedCameraLow;
        let positionWC2 = input.v_positionMC;
        let viewDir2 = normalize(positionWC2 - cameraWC2);
        return makeFragOutput(vec4<f32>(viewDir2 * 0.5 + 0.5, 1.0), normalEC);
      }
      // Debug: visualize fadeAmount as grayscale via [9.5e9, 10.5e9].
      // If fadeAmount = 1 (white), the imagery is fully replaced by drape.
      if (tile.time > 9.5e9 && tile.time < 10.5e9) {
        return makeFragOutput(vec4<f32>(fadeAmount, fadeAmount, fadeAmount, 1.0), normalEC);
      }
      // Debug: visualize draped color via [10.5e9, 11.5e9].
      if (tile.time > 10.5e9 && tile.time < 11.5e9) {
        return makeFragOutput(vec4<f32>(draped, 1.0), normalEC);
      }
      // Debug: visualize groundAtmoColor only via [11.5e9, 12.5e9].
      if (tile.time > 11.5e9 && tile.time < 12.5e9) {
        return makeFragOutput(vec4<f32>(groundAtmoColor, 1.0), normalEC);
      }
      // Debug: visualize transmittance via [12.5e9, 13.5e9].
      if (tile.time > 12.5e9 && tile.time < 13.5e9) {
        return makeFragOutput(vec4<f32>(transmittance / 5.0, transmittance / 5.0, transmittance / 5.0, 1.0), normalEC);
      }
      // The 'bypass-drape' debug mode (24e9) skips the
      // far-from-ground ground-atmosphere drape replacement so the drape /
      // limb-width term can be measured in isolation.
      if (!globe_debugBypassActive(24.0e9)) {
        color = mix(color, draped, fadeAmount);
      }
    }
  }

  // Underground tint blend.
  // Mirrors GlobeFS.glsl lines 735-744 (`#ifdef UNDERGROUND_COLOR`): when
  // the camera can see under the surface and the fragment is back-facing
  // (the inside of the globe), alpha-blend `undergroundColor` over the
  // shaded terrain color, with the blend alpha ramped by the fragment's
  // distance beyond the camera's height above the ellipsoid
  // (`undergroundColorAlphaByDistance` NearFarScalar). The show flag
  // (`undergroundControl.x`) is computed CPU-side with the exact WebGL
  // `showUndergroundColor` condition, so above-ground / default renders
  // never enter this branch (byte-identical off path).
  // The 'bypass-underground' debug mode (22e9) skips the
  // underground tint blend so its residual share can be measured.
  if (camera.undergroundControl.x > 0.5 && !frontFacing &&
      !globe_debugBypassActive(22.0e9)) {
    // WebGL: distanceFromEllipsoid = max(czm_eyeHeight, 0.0) — packed
    // pre-clamped in undergroundControl.y.
    let distanceFromEllipsoid = camera.undergroundControl.y;
    let undergroundDistance = max(input.v_distance - distanceFromEllipsoid, 0.0);
    let blendAmount = globe_interpolateByDistance(
      camera.undergroundColorAlphaByDistance,
      undergroundDistance,
    );
    let undergroundColor = vec4<f32>(
      camera.undergroundColor.rgb,
      camera.undergroundColor.a * blendAmount,
    );
    // czm_alphaBlend(source, dest) = source×vec4(source.aaa, 1) + dest×(1 − source.a)
    let blended = undergroundColor * vec4<f32>(
      undergroundColor.a, undergroundColor.a, undergroundColor.a, 1.0,
    ) + vec4<f32>(color, alpha) * (1.0 - undergroundColor.a);
    color = blended.rgb;
    alpha = blended.a;
  }

  // Draped clamped vector polylines.
  // Mirrors GlobeFS.glsl lines 1018-1020 (`#ifdef HAS_VECTOR_LAYER`):
  // alpha-composite the tile's clamped vector polylines over the shaded
  // terrain, AFTER the underground tint and BEFORE the translucency alpha
  // ramp — the ordering matters, because a draped line over a translucent
  // globe must fade with the globe rather than punch through it.
  // Unconditional call: `vectorPolylineRender` early-outs on the placeholder
  // buffer's zero `gridWidth` header word, so the no-vector-data path costs
  // one u32 load.
  let vectorComposited = vectorPolylineRender(
    input.v_textureCoordinates.xy,
    vectorUV_dx,
    vectorUV_dy,
    vec4<f32>(color, alpha),
  );
  color = vectorComposited.rgb;
  alpha = vectorComposited.a;

  // Per-fragment translucent-globe alpha.
  // Mirrors GlobeFS.glsl lines 746-751 (`#ifdef TRANSLUCENT`): inside the
  // translucency rectangle, scale the fragment's alpha by the front- or
  // back-face NearFarScalar ramp (`interpolateByDistance`) evaluated at the
  // fragment's eye distance. The translucent multi-pass pipelines — depth-only
  // pre-pass, translucent back-face, translucent front-face — supply the alpha
  // blend state; this alpha value is what makes the blend actually
  // translucent. The gate stays closed (control.x = 0) unless
  // `globeTranslucencyState.translucent`, leaving the default render unchanged.
  // The 'bypass-translucency' debug mode (23e9) skips the
  // per-fragment translucency alpha ramp so its residual share can be
  // measured (the multi-pass blend pipelines still run; only the FS alpha
  // multiply is bypassed).
  if (camera.translucencyControl.x > 0.5 &&
      !globe_debugBypassActive(23.0e9)) {
    let tRect = tile.localizedTranslucencyRectangle;
    if (geoUV.x > tRect.x && geoUV.x < tRect.z &&
        geoUV.y > tRect.y && geoUV.y < tRect.w) {
      var alphaByDistance = camera.translucencyBackAlphaByDistance;
      if (frontFacing) {
        alphaByDistance = camera.translucencyFrontAlphaByDistance;
      }
      alpha = alpha * globe_interpolateByDistance(alphaByDistance, input.v_distance);
    }
  }

  // Globe hue, saturation and brightness shift. Matches the
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

  // End-of-fragment force-bright debug. Trigger via
  // [18.5e9, 19.5e9]. Forces output to (1,0,0,1) regardless of any
  // prior shading. If the displayed canvas pixel is dim red instead of
  // bright red, something between FS output and display is dimming
  // (canvas format, color space, post-process). If bright red, the
  // dimming is in the fragment shading path.
  if (tile.time > 18.5e9 && tile.time < 19.5e9) {
    return makeFragOutput(vec4<f32>(1.0, 0.0, 0.0, 1.0), normalEC);
  }
  // Water-effect-trigger debug. Trigger via [19.5e9, 20.5e9].
  // Renders ocean fragments RED, land fragments GREEN. Verifies the
  // `flags.x` gate is correctly identifying water against land tiles.
  if (tile.time > 19.5e9 && tile.time < 20.5e9) {
      if (tile.flags.x > 0.5) {
        let wmTS = tile.waterMaskTranslationAndScale;
        let waterUVUnflipped = geoUV * wmTS.zw + wmTS.xy;
        let waterUV = vec2<f32>(waterUVUnflipped.x, 1.0 - waterUVUnflipped.y);
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

// RGB and HSB conversion helpers for the hue/saturation/brightness
// globe-level tonal shift. Module-scoped and prefixed `globe_` so they
// don't collide with the rgbToHsb/hsbToRgb pair in SkyAtmosphere.wgsl
// (WGSL doesn't have namespaces — the globe + sky shaders can end up
// in the same module graph via shared pipelines).
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
