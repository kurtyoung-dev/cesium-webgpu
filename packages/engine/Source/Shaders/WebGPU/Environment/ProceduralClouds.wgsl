// Procedural Volumetric Clouds — WebGPU
//
// Ray-marches through a spherical cloud shell around the planet to render
// physically-inspired volumetric clouds. Uses layered FBM noise for cloud
// density and lighting with beer-powder approximation for light absorption.
//
// Architecture:
//   - Rendered as a full-screen pass after the globe but before post-processing
//   - Uses depth buffer to stop rays at terrain
//   - Cloud shell defined by inner/outer radius above ellipsoid surface
//   - Multiple noise octaves for detail at different scales
//   - Phase function for silver lining and forward scattering
//   - Temporal reprojection for performance (render at half-res, blend)
//
// References:
//   - "The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn" (Schneider, SIGGRAPH 2015)
//   - "Nubis: Authoring Real-Time Volumetric Cloudscapes" (Schneider, SIGGRAPH 2017)
//
// The module carries exactly one compile-time variant. Every
// `//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION` block below is deleted by
// `WebGPUShaderPreprocessor.preprocess(source, 0, definesHi)` unless the caller
// sets `ShaderDefineHi.CLOUD_MARCH_EMIT_RECONSTRUCTION`, and each such block
// keeps the non-emitting code as its `//>>else`, so at `definesHi = 0` the
// emitted WGSL differs from the non-emitting module only by the removed
// directive lines. `cloud-march-emission.spec.mjs` executes that equality
// rather than assuming it.
//
// WGSL register allocation is static, so code added unconditionally to this
// module inflates the register footprint of the full-resolution march, the
// beer-shadow map, the cascade atlas and the god-ray mask, none of which
// produce a reconstruction attachment. Only the half-resolution march pipeline
// compiles the bit, so anything added outside a variant block is paid by all
// five.

// Field order and byte offsets are locked to the packer in
// WebGPUProceduralCloudRenderer.ts: new fields take a fresh 16-byte row at the
// end and existing offsets never move. The number in each trailing comment is
// that field's float index in the packer's write order.
struct CloudUniforms {
  // Camera
  inverseProjection: mat4x4<f32>,
  inverseView: mat4x4<f32>,
  cameraPosition: vec3<f32>,
  time: f32,
  // Sun
  sunDirection: vec3<f32>,
  sunIntensity: f32,
  // Cloud layer definition
  cloudLayerBottom: f32,    // meters above surface (default 1500)
  cloudLayerTop: f32,       // meters above surface (default 4000)
  planetRadius: f32,        // earth radius in meters
  coverage: f32,            // 0-1, global cloud coverage
  // Quality
  maxSteps: f32,            // ray march steps (default 64)
  lightSteps: f32,          // light march steps (default 6)
  densityMultiplier: f32,   // density scale (default 0.3)
  absorptionCoeff: f32,     // light absorption (default 0.04)
  // Visual
  windDirection: vec2<f32>, // normalized wind XZ direction
  windSpeed: f32,           // meters/sec
  silverLiningIntensity: f32,
  // Colors
  cloudBaseColor: vec3<f32>,
  _pad0: f32,
  cloudTopColor: vec3<f32>,
  _pad1: f32,
  // Screen info
  resolution: vec2<f32>,
  // These two occupy the aligned vec2 pad that preceded them, so the uniform's
  // byte size and every later field offset are unchanged.
  planetPolarRadius: f32,        // WGS84 semi-minor axis (6356752.314245179 m)
  cameraGeodeticHeight: f32,     // CPU-f64 Cartographic height, stored as f32
  // Weather-map seam, floats 64-79.
  weatherMapEnabled: f32,        // 64 — >0.5 → sample the weather map per position
  weatherStrength: f32,          // 65 — per-cell coverage multiplier (folds in cloudCoverage)
  phaseG2: f32,                  // 66 — dual-lobe back-scatter g
  phaseBlend: f32,               // 67 — forward/back lobe blend weight
  weatherTexBounds: vec4<f32>,   // 68-71 — minLon, minLat, lonRange, latRange (radians)
  // Scalar pads rather than a vec3, so 72-75 stay byte-exact: a vec3 here takes
  // 16-byte alignment and would jump to float 76, breaking the packer lock.
  phaseG1: f32,                  // 72 — dual-lobe forward-scatter g (silver lining)
  ambientIntensity: f32,         // 73 — sky/ground ambient intensity
  qualityFlags: f32,             // 74 — tier bitfield (read via u32())
  // 0 skips the baked-path detail-erosion curl warp entirely, which is the
  // default; above 0 it is the amplitude of the analytic curl-noise domain warp
  // applied to the detail sample position.
  curlAmplitude: f32,            // 75 — curl warp amplitude (0 = off, default)
  // 76-79 are four scalars on one 16-byte stride, occupying the bytes a single
  // vec4 would.
  frameCounter: f32,             // 76 — Bayer/cone 16-phase + IGN 64-phase
  curlFrequency: f32,            // 77 — curl-noise swirl wavelength (noise-space scale)
  lightSampleScale: f32,         // 78 — light-march step-count and cone-radius scale
  erosionStrength: f32,          // 79 — mean-preserving erosion strength
  skyAmbientColor: vec3<f32>,    // 80-82 — blue-sky ambient (lights cloud tops)
  _padB: f32,                    // 83
  groundAmbientColor: vec3<f32>, // 84-86 — ground-bounce ambient (lights cloud bottoms)
  _padC: f32,                    // 87
  sunLightColor: vec3<f32>,      // 88-90 — time-of-day sun color (warm low / neutral noon)
  aerialStrength: f32,           // 91 — aerial-perspective strength
  aerialColor: vec3<f32>,        // 92-94 — horizon inscatter haze tint (time-of-day keyed)
  _padD: f32,                    // 95
  // Live dials for quantities that would otherwise be shader constants: all
  // scalar f32 across one 16-byte row 96-99 and a second 100-103. The packer
  // supplies a nominal default for each, so an untouched dial is a no-op.
  puffSize: f32,                 // 96 — baked base puff size (shape-domain scale)
  exposure: f32,                 // 97 — Reinhard tone-map exposure
  msDecayA: f32,                 // 98 — multi-scatter contribution per octave
  msDecayB: f32,                 // 99 — multi-scatter extinction per octave
  msDecayC: f32,                 // 100 — multi-scatter eccentricity per octave
  // Per-genus vertical-density profile, 101-104. The default genus is CUMULUS,
  // whose profileShape is BILLOWY and whose scales are 1.0, so the neutral
  // setting is the plain height gradient.
  profileShape: f32,             // 101 — 0=SLAB / 1=BILLOWY / 2=TOWERING_ANVIL
  profileDensityScale: f32,      // 102 — per-genus density vs CUMULUS (1.0 = neutral)
  profileExtinction: f32,        // 103 — per-genus optical extinction scale vs CUMULUS (1.0 = neutral); scales absorptionCoeff in the light march + view-ray transmittance
  anvilBias: f32,                // 104 — TOWERING_ANVIL upper-flare bias (0 = none)
  // Depth occlusion needs the frustum planes to reverse the log depth.
  nearPlane: f32,                // 105 — camera frustum near
  farPlane: f32,                 // 106 — camera frustum far
  // Scales how strongly the weather map's G (genus), B (base) and A
  // (density-bias) channels modulate the cloud model. A neutral map cell
  // (G=0.5, B=0, A=0.5) is a no-op at any strength, so either a neutral map or
  // weatherMapEnabled=0 leaves the model driven by coverage alone.
  weatherChannelStrength: f32,   // 107 — G/B/A influence scale (0 = R channel only)
  // Atmosphere-LUT coupling, 108-111:
  //   aerialLutMode=0  → heuristic ~60 km LDR aerial lerp
  //   ambientLutMode=0 → constant sky/ground ambient lerp
  // Both self-heal: even with the mode flag set, the WGSL falls back to the
  // constant branch when the sampled LUT radiance is ~0, which is what an
  // unbaked LUT reads as (skyAtmosphere off, for instance), so a stray
  // "physical" flag cannot black out the clouds.
  aerialLutMode: f32,            // 108 — 0 heuristic / 1 physical (sky-view inscatter + transmittance)
  ambientLutMode: f32,           // 109 — 0 constant / 1 sky-LUT (up/down hemispheres of the multiple-scattering LUT)
  atmosphereThickness: f32,      // 110 — m; must equal the LUT bake's ATMOSPHERE_THICKNESS (111e3)
  _padE: f32,                    // 111 — pad to the 16-byte row
  // Multi-deck shell march, 112-119. At multiDeck=0 the fragment marches exactly
  // one shell from cloudLayerBottom/Top and these deck-bounds floats are never
  // read. Above 0 it marches up to three shells (low, mid, high) from these
  // bounds and composites them front-to-back, near deck over far, premultiplied.
  // Bounds come from CloudTypeProfile.CloudDeck.bounds — low [0,2 km], mid
  // [2,7 km], high [5,13 km] — packed by the JS renderer.
  multiDeck: f32,                // 112 — 0 single shell (default) / >0 march low/mid/high
  _padF: f32,                    // 113 — pad
  deckBoundsLow: vec2<f32>,      // 114-115 — LOW deck [bottom, top] (m above surface)
  deckBoundsMid: vec2<f32>,      // 116-117 — MID deck [bottom, top]
  deckBoundsHigh: vec2<f32>,     // 118-119 — HIGH deck [bottom, top]
  // Camera-relative high-precision march, 120-127: the relative-to-eye high/low
  // split of the camera world position, from which the planet centre relative to
  // the camera is -(high + low). Read only inside the high-precision branch,
  // which is active unless `globe.cloudHighPrecision` is explicitly false. The
  // .xyz carry the split and the pads keep each on a 16-byte (vec4) stride.
  encodedCameraHigh: vec3<f32>,  // 120-122 — high part of the camera world position
  _padG: f32,                    // 123 — pad to the 16-byte row
  encodedCameraLow: vec3<f32>,   // 124-126 — low part (refinement) of the camera position
  _padH: f32,                    // 127 — pad to the 16-byte row
  // Pendulous "mamma" pouches on the cloud underside, 128-131. At
  // mammatusStrength=0 mammatusFactor() early-returns 1.0, so density is
  // untouched and these floats are never read past the guard. The factor is a
  // per-position multiplier in [0,1] applied identically in the full density and
  // in the cloudBaseDensity oracle, which is what keeps the `base >= full`
  // empty-space-skip invariant true.
  mammatusStrength: f32,         // 128 — 0 off (default) / >0 underside pouch carve depth
  mammatusScale: f32,            // 129 — horizontal lobe frequency (pouch size; 1.0 neutral)
  mammatusDepth: f32,            // 130 — underside band height fraction the pouches occupy
  _padI: f32,                    // 131 — pad to the 16-byte row
  // Species and varieties as bounded density shaping over the baked density
  // field, 132-135. At speciesMode=0 speciesFactor() early-returns 1.0, so
  // density is untouched and these floats are never read past the guard. The
  // factor is a per-position multiplier in [0,1] applied identically in the full
  // density and in the cloudBaseDensity oracle, preserving `base >= full`. A
  // per-genus gate lives in JS, so the shader sees a non-zero mode only when the
  // user opts a deck into a species.
  speciesMode: f32,              // 132 — 0 off / 1 lenticularis / 2 fibratus-uncinus
  speciesStrength: f32,          // 133 — shaping depth (0 off → 1.0 factor; clamped 0..1)
  speciesScale: f32,             // 134 — feature frequency (lens/filament size; 1.0 neutral)
  speciesParam: f32,             // 135 — mode extra: uncinus fallstreak hook shear (mode 2)
  // Supplementary features, the sibling of the mammatus and species dials above,
  // 136-139; each is a bounded density-shaping mode. At featureMode=0
  // featureFactor() early-returns 1.0, so density is untouched and these floats
  // are never read past the guard. The factor is a per-position [0,1] multiplier
  // applied identically in the full density and in the cloudBaseDensity oracle,
  // preserving `base >= full`. A per-genus gate lives in JS, so the shader sees a
  // non-zero mode only when the user opts a deck into a feature.
  featureMode: f32,              // 136 — 0 off / 1 asperitas / 2 fluctus / 3 arcus / 4 virga
  featureStrength: f32,          // 137 — shaping depth (0 off → 1.0 factor; clamped 0..1)
  featureScale: f32,             // 138 — feature frequency (wave/streak size; 1.0 neutral)
  featureParam: f32,             // 139 — mode extra (fluctus shear / arcus width / virga reach)
  // Special clouds, 140-143. Unlike the mammatus, species and feature dials,
  // which multiply density, this multiplies the per-sample cloud colour by an
  // iridescent tint, rendering the two "shining" high-altitude forms:
  // noctilucent (mesospheric, an electric silvery-blue billow shell) and
  // nacreous (stratospheric mother-of-pearl, pastel iridescent bands keyed to
  // the sun/view scattering angle). The deck is placed at mesospheric or
  // stratospheric altitude through the multi-deck deckBoundsHigh bounds; these
  // fields supply only the shading. At specialShadeMode=0 specialShadeTint()
  // early-returns vec3(1.0), so the colour is multiplied by the IEEE 754
  // identity and these floats are never read past the guard. The tint applies to
  // the view-ray radiance in marchDeck only, not to density or to the
  // cloudBaseDensity oracle, so `base >= full` is untouched.
  specialShadeMode: f32,         // 140 — 0 off / 1 noctilucent / 2 nacreous
  specialShadeStrength: f32,     // 141 — tint blend depth (0 off → vec3(1.0); clamped 0..1)
  specialShadeScale: f32,        // 142 — band/iridescence spatial frequency (1.0 neutral)
  specialShadeParam: f32,        // 143 — mode extra (nacreous spectral cycling frequency)
  // Two orbit-cost dials for the view-ray march in marchDeck, 144-147. Both
  // default to a no-op:
  //   marchStepGrowth=1.0 → the `> 1.0` guard is false, so the pow is never
  //     evaluated and curStep equals fineStep exactly.
  //   maxRayDistance=0.0  → the `> 0.0` far-cap guard is false, so tEnd is
  //     untouched.
  // When opted in, the fixed sampling comb grows geometrically along the ray so
  // far shell samples, which subtend one or two pixels, coarsen; and the march
  // stops past maxRayDistance, where clouds are sub-pixel. There is no WebGL
  // twin: this is a cost/quality dial with no visual-parity requirement.
  marchStepGrowth: f32,          // 144 — geometric per-fine-step growth (1.0 = off, uniform comb)
  maxRayDistance: f32,           // 145 — far cap on the view march in meters (0 = off, infinite)
  _padJ: f32,                    // 146 — pad to the 16-byte row
  _padK: f32,                    // 147 — pad to the 16-byte row
  // CPU-f64 density-domain phases at the current camera origin. The primary
  // march adds only camera-relative metre offsets in f32, keeping a raw
  // full-ECEF conversion out of the density hot path. Three independent rows
  // carry the seeded shape, warp and detail coordinate transforms.
  densityShapeOriginPhase: vec3<f32>, // 148-150
  _padL: f32,                         // 151
  densityWarpOriginPhase: vec3<f32>,  // 152-154
  _padM: f32,                         // 155
  densityDetailOriginPhase: vec3<f32>,// 156-158
  _padN: f32,                         // 159
  // Unwrapped canonical morphology origin, encoded high/low after CPU-f64 wind
  // advection. The analytic species and feature factors build their wind frame
  // from the unrotated x/z plane, so they must read this rather than a wrapped
  // texture coordinate.
  densityMorphologyOriginHigh: vec3<f32>, // 160-162
  _padO: f32,                              // 163
  densityMorphologyOriginLow: vec3<f32>,  // 164-166
  _padP: f32,                              // 167
  // Per-genus cloud morphology, 168-171. These carry the two axes of
  // Scene/CloudTypeProfile.js that shape an ice genus — the fibrous/puffy
  // `erosion` style and the per-genus Henyey-Greenstein `phaseG` — so a cirrus
  // genus reads as sheared filaments with a forward-peaked phase rather than as
  // a faint scaled-down cumulus.
  //
  // The default genus is CUMULUS, which is puffy and whose phaseG is the
  // baseline, so genusFibreStrength and genusPhaseDelta are both exactly 0:
  // genusFibreFactor early-returns 1.0, genusErosionHeightWeight early-returns
  // `1.0 - h`, genusForwardG early-returns cloud.phaseG1, and neither anisotropy
  // nor shear is read past those guards. The fibre factor is a per-position
  // multiplier in [0,1] applied identically in the full density and in the
  // cloudBaseDensity oracle, preserving `base >= full`.
  genusFibreStrength: f32,       // 168 — 0 PUFFY/off (default) .. 1 fully fibrous carve
  genusFibreAnisotropy: f32,     // 169 — filament length:width aspect along the wind (>= 1)
  genusFibreShear: f32,          // 170 — fallstreak along-wind lag per unit shell height
  genusPhaseDelta: f32,          // 171 — per-genus HG forward-lobe g offset vs CUMULUS (0 neutral)
};

@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> cloud: CloudUniforms;
// Global lat/lon weather field (R = coverage, G = type, B = base, A =
// density-bias). Declared texture_2d_array with depth 1 so per-deck layers can
// be added later without changing the binding.
@group(0) @binding(4) var weatherTex: texture_2d_array<f32>;
@group(0) @binding(5) var weatherSampler: sampler;
// Baked 3D noise — shape 128³ and detail 32³ — with their shared sampler. The
// density evaluation reads these instead of the live fbmNoise/worleyF1 pair
// whenever the baked-noise quality bit is set.
@group(0) @binding(6) var cloudShapeTex: texture_3d<f32>;
@group(0) @binding(7) var cloudDetailTex: texture_3d<f32>;
@group(0) @binding(8) var cloudNoiseSampler: sampler;
// Precomputed atmosphere LUTs, shared with SkyAtmosphere. Bound unconditionally
// so the pipeline and bind-group layout never fork; the renderer binds 1×1
// placeholders when the LUTs are not allocated. The shader samples them only
// when the corresponding mode flag is set and the sampled radiance is non-zero,
// because an unbaked LUT reads all-zero and the constant fallback runs instead.
// Same 256×128 sun-relative sky-view domain as SkyAtmosphere's bindings 5 and 6;
// the transmittance LUT is 256×64.
//   9  — sun-relative sky-view single-scatter inscatter (the air light)
//   10 — sun-relative multiple-scattering sky radiance (ambient hemispheres)
//   11 — transmittance (altitude × cosZenith) for cloud-color attenuation
//   12 — linear LUT sampler (clamp-to-edge)
@group(0) @binding(9) var cloudSkyViewLut: texture_2d<f32>;
@group(0) @binding(10) var cloudMultipleScatterLut: texture_2d<f32>;
@group(0) @binding(11) var cloudTransmittanceLut: texture_2d<f32>;
@group(0) @binding(12) var cloudLutSampler: sampler;
// Sun-view beer-shadow-map pass uniforms, bound only in the dedicated shadow
// pipeline's bind group at binding 13. The main cloud color pass never declares
// it: WebGPU validates bindings per entry point, so a fragment that does not
// reference one does not need it in the pipeline layout. The shadow pass reuses
// the same `CloudUniforms` at binding 3 and the same weather and noise bindings
// 4-8, so its density evaluation is the code the visible march runs and the cast
// shadow tracks the rendered cloud field exactly.
struct CloudShadowUniforms {
  // Inverse of the sun-view orthographic view-projection, expressed relative to
  // the camera (clip → camera-relative world). `WebGPUCloudShadowFrame` cancels
  // the planet-scale translation in CPU `f64`, so reconstructing a shadow-map
  // column here yields a small camera-relative vector rather than a full-ECEF
  // `f32` position. Every downstream quantity — shell roots, height fraction,
  // density domains — then stays in the same relative-to-eye frame the visible
  // march uses: `encodedCameraHigh/Low` plus the CPU-`f64` density origin phases.
  sunViewInvVpRelativeToEye: mat4x4<f32>,
  // xyz = normalized sun direction (world); w = light-march step count for the
  // optical-depth accumulation along the sun ray (kept low — this is a coarse map).
  sunDirAndSteps: vec4<f32>,
};
@group(0) @binding(13) var<uniform> cloudShadow: CloudShadowUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

const PI: f32 = 3.14159265358979;
// Cloud-base normalization band; must equal CLOUD_BASE_NORM_METERS in
// WeatherTexPacker.ts. The packer stores B = baseMetres / 12000 and the shader
// reverses it to metres before converting to a shell-thickness fraction.
const CLOUD_BASE_NORM_METERS: f32 = 12000.0;

// Bit layout of `qualityFlags`, float 74. Unpack with `u32(cloud.qualityFlags)`.
const QF_NOISE_BAKED: u32 = 1u;     // bit 0
const QF_HALF_RES: u32 = 2u;        // bit 1
const QF_TEMPORAL: u32 = 4u;        // bit 2
const QF_JITTER: u32 = 8u;          // bit 3
const QF_OCTAVES_SHIFT: u32 = 4u;   // bits 4-6
const QF_PROFILE_ON: u32 = 128u;    // bit 7
// Atmosphere-LUT coupling. The JS renderer sets these only when the
// corresponding mode flag is 'physical' or 'sky-lut'; the shader additionally
// gates each on a non-zero LUT radiance, so an unbaked LUT falls back to the
// constant path.
const QF_AERIAL_LUT: u32 = 256u;    // bit 8 — physical aerial (sky-view + transmittance)
const QF_AMBIENT_LUT: u32 = 512u;   // bit 9 — sky-LUT cloud ambient (multiple-scattering LUT)
const QF_LIGHT_CONE: u32 = 1024u;   // bit 10 — cone-sampled light march
const QF_MULTI_DECK: u32 = 2048u;   // bit 11 — multi-deck shell march
// Set unless `globe.cloudHighPrecision` is explicitly false, which keeps the
// world-coordinate branch available as a comparison route.
const QF_HIGH_PRECISION: u32 = 4096u; // bit 12 — camera-relative high-precision march (1<<12)
const QF_PLANET_DENSITY: u32 = 8192u; // bit 13 — planet-anchored baked density

// Ordered 4×4 Bayer matrix, normalized 0..1 — the standard recursive dither
// pattern. It jitters the half-res sample point by a sub-pixel offset within
// each 2×2 full-res footprint, cycled per frame on `cloud.frameCounter`
// (float 76). Decorrelating the half-res grid (Wronski, "Volumetric Atmospheric
// Scattering", GDC 2014) breaks up the blocky 2× under-sampling so the bilateral
// upscale reconstructs soft volumetric forms instead of a hard checkerboard. The
// 16-tap table is indexed by `frameCounter mod 16`.
const BAYER4: array<f32, 16> = array<f32, 16>(
   0.0 / 16.0,  8.0 / 16.0,  2.0 / 16.0, 10.0 / 16.0,
  12.0 / 16.0,  4.0 / 16.0, 14.0 / 16.0,  6.0 / 16.0,
   3.0 / 16.0, 11.0 / 16.0,  1.0 / 16.0,  9.0 / 16.0,
  15.0 / 16.0,  7.0 / 16.0, 13.0 / 16.0,  5.0 / 16.0
);

// Jimenez 2014 analytic interleaved-gradient noise (IGN), shared with this
// repository's volumetric-fog renderer. This is blue-noise-like screen noise,
// not spatiotemporal blue noise, and it needs no texture, sampler, bind group or
// external asset. The golden-ratio frame rotation gives the temporally-resolved
// tiers a 64-frame decorrelated sequence; the full-resolution path stays at
// frame zero, where there is no history to average the variation away.
fn interleavedGradientNoise(
  pixelCoord: vec2<f32>,
  frameIndex: f32,
) -> f32 {
  let temporalOffset =
    5.588238 * fract(frameIndex * 0.6180339887);
  let p = floor(pixelCoord) + vec2<f32>(temporalOffset);
  return fract(
    52.9829189 *
    fract(0.06711056 * p.x + 0.00583715 * p.y)
  );
}

fn cloudRaySamplePhase(pixelCoord: vec2<f32>) -> f32 {
  let flags = u32(cloud.qualityFlags);
  if ((flags & QF_JITTER) == 0u) {
    return 0.5;
  }

  // Animate only where a temporal history exists to filter the variation. The
  // full-resolution path, and the fallback taken when the temporal targets
  // cannot be allocated, use a deterministic spatial phase instead, so the ray
  // phase never introduces unfiltered frame-to-frame sparkle.
  var frameIndex = 0.0;
  if ((flags & QF_TEMPORAL) != 0u) {
    frameIndex = cloud.frameCounter;
  }
  return interleavedGradientNoise(pixelCoord, frameIndex);
}

// Full-screen triangle
@vertex
fn vertexMain(@builtin(vertex_index) vid: u32) -> VertexOutput {
  var out: VertexOutput;
  // Oversized fullscreen triangle — vertices (-1,-1), (3,-1), (-1,3) — so the
  // whole [-1,1] clip square sits inside the triangle and every screen pixel is
  // shaded. An exact-fit triangle (-1,-1), (1,-1), (-1,1) coincides with three
  // NDC corners and covers only the lower-left half, x + y <= 0, leaving the
  // upper-right half unrasterized behind a hard corner-to-corner diagonal. `uv`
  // is an affine function of the clip xy, so it interpolates 0..1 across the
  // visible square either way.
  let x = f32((vid << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vid & 2u) * 2.0 - 1.0;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
  return out;
}

// Hash functions for noise
fn hash3(p: vec3<f32>) -> f32 {
  var q = fract(p * 0.1031);
  q += dot(q, q.zyx + 31.32);
  return fract((q.x + q.y) * q.z);
}

fn hash33(p: vec3<f32>) -> vec3<f32> {
  var q = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yxx) * q.zyx);
}

// Value noise 3D
fn valueNoise(p: vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f); // smoothstep

  return mix(
    mix(mix(hash3(i + vec3<f32>(0, 0, 0)), hash3(i + vec3<f32>(1, 0, 0)), u.x),
        mix(hash3(i + vec3<f32>(0, 1, 0)), hash3(i + vec3<f32>(1, 1, 0)), u.x), u.y),
    mix(mix(hash3(i + vec3<f32>(0, 0, 1)), hash3(i + vec3<f32>(1, 0, 1)), u.x),
        mix(hash3(i + vec3<f32>(0, 1, 1)), hash3(i + vec3<f32>(1, 1, 1)), u.x), u.y),
    u.z
  );
}

// FBM (fractal Brownian motion) noise — 5 octaves
fn fbmNoise(p: vec3<f32>) -> f32 {
  var val: f32 = 0.0;
  var amp: f32 = 0.5;
  var freq: f32 = 1.0;
  var pos = p;
  for (var i: i32 = 0; i < 5; i++) {
    val += amp * valueNoise(pos * freq);
    freq *= 2.0;
    amp *= 0.5;
    pos += vec3<f32>(0.0, 0.0, 0.13);
  }
  return val;
}

// Worley (cellular) noise 3D — F1 distance.
// Distance to the nearest feature point, one per cell and hashed, over the 3×3×3
// neighbourhood. High between cells and low at feature points, so subtracting it
// carves the inter-lobe gaps and leaves the rounded cauliflower lobes that value
// noise alone cannot produce. 27 taps; reuses hash33.
//
// The result is used only as subtractive erosion. Remapping the base shape by
// Worley instead — `remap(perlin, worleyLow - 1, 1, 0, 1)` — raises the density
// floor and over-densifies the deck; erosion can carve detail but never add
// density, so it cannot reach that failure.
fn worleyF1(p: vec3<f32>) -> f32 {
  let id = floor(p);
  let fd = fract(p);
  var minDistSq: f32 = 1.0;
  for (var x: i32 = -1; x <= 1; x++) {
    for (var y: i32 = -1; y <= 1; y++) {
      for (var z: i32 = -1; z <= 1; z++) {
        let offset = vec3<f32>(f32(x), f32(y), f32(z));
        let featurePoint = offset + hash33(id + offset);
        let diff = featurePoint - fd;
        minDistSq = min(minDistSq, dot(diff, diff));
      }
    }
  }
  return sqrt(min(minDistSq, 1.0));
}

// Analytic curl-noise domain warp.
// Curl of a three-component value-noise vector potential, evaluated by central
// differences. curl(F) = (∂Fz/∂y − ∂Fy/∂z, ∂Fx/∂z − ∂Fz/∂x, ∂Fy/∂x − ∂Fx/∂y) is
// divergence-free, so warping a sample position by it produces the swirling,
// incompressible, tendril-like advection that gives Schneider/Nubis cloud edges
// their wispy, turbulent character instead of fBm's blobby erosion. The
// potential is `valueNoise`, already periodic-friendly here, offset by large
// constants per component so the three scalar fields decorrelate. The call sites
// guard on curlAmplitude > 0, so this is not evaluated at all when the warp is
// off; at amplitude 0 the offset would be exactly vec3(0) in any case.
fn curlPotential(p: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    valueNoise(p),
    valueNoise(p + vec3<f32>(31.41, 17.27, 47.53)),
    valueNoise(p + vec3<f32>(-19.13, 83.71, -5.29)),
  );
}

fn curlNoise3(p: vec3<f32>) -> vec3<f32> {
  let e = 0.35; // finite-difference epsilon (noise-space units)
  let dx = vec3<f32>(e, 0.0, 0.0);
  let dy = vec3<f32>(0.0, e, 0.0);
  let dz = vec3<f32>(0.0, 0.0, e);
  let px0 = curlPotential(p - dx);
  let px1 = curlPotential(p + dx);
  let py0 = curlPotential(p - dy);
  let py1 = curlPotential(p + dy);
  let pz0 = curlPotential(p - dz);
  let pz1 = curlPotential(p + dz);
  let inv2e = 1.0 / (2.0 * e);
  let curl = vec3<f32>(
    (py1.z - py0.z) - (pz1.y - pz0.y),
    (pz1.x - pz0.x) - (px1.z - px0.z),
    (px1.y - px0.y) - (py1.x - py0.x),
  ) * inv2e;
  return curl;
}

// ECEF world position to weather-map UV.
// Equirectangular geodetic lon/lat under a spherical approximation, since a
// coarse weather field does not need ellipsoidal exactness. lon = atan2(y, x)
// ∈ [-PI, PI]; lat = asin(z / r). Mapped onto [0,1]² through weatherTexBounds; v
// is flipped so texture row 0, the top, is the north pole.
//
// The seam contract has two halves: the CPU twin is `weatherUVFromLonLat` in
// Scene/Weather/WeatherMapSeam.ts, and the producers write texel centres,
// ((tx + 0.5) / texW, (ty + 0.5) / texH). `weather-map-seam.spec.mjs` pins them
// together, so neither can be edited alone. Across the dateline the sampler is
// addressModeU="repeat", filtering texel texW-1 against texel 0 at ±180°, which
// is seam-free only because the producers are periodic in longitude. At the
// poles the sampler is addressModeV="clamp-to-edge" and the producers collapse
// the polar-cap rows to one longitude value, so the pole is single-valued.
fn worldToWeatherUV(worldPos: vec3<f32>) -> vec2<f32> {
  let r = max(length(worldPos), 1.0);
  // Pole guard: on the spin axis (x = y = 0) atan2 is indeterminate in WGSL and
  // may yield NaN, and a NaN texture coordinate propagates into coverage and
  // then into density for a straight-down polar view. The polar rows are
  // longitude-constant, so any finite longitude reads the same texel there and 0
  // is a safe substitute.
  let axial = worldPos.x * worldPos.x + worldPos.y * worldPos.y;
  let lon = select(0.0, atan2(worldPos.y, worldPos.x), axial > 1e-12);
  let lat = asin(clamp(worldPos.z / r, -1.0, 1.0));
  let b = cloud.weatherTexBounds;
  let u = (lon - b.x) / b.z;
  let v = 1.0 - (lat - b.y) / b.w;
  return vec2<f32>(u, v);
}

// Cloud density at a world-space point
fn remap(v: f32, lo: f32, hi: f32, a: f32, b: f32) -> f32 {
  return a + (v - lo) * (b - a) / (hi - lo);
}

// Is the baked-3D-texture density core active? (qualityFlags bit 0)
fn noiseBakedEnabled() -> bool {
  return (u32(cloud.qualityFlags) & QF_NOISE_BAKED) != 0u;
}

fn planetDensityEnabled() -> bool {
  return (u32(cloud.qualityFlags) & QF_PLANET_DENSITY) != 0u;
}

// Is the half-res render path active? (qualityFlags bit 1). When set, the
// raymarch renders into a 0.5× rgba16float offscreen target and emits
// premultiplied cloud radiance and alpha, leaving the scene-color composite to
// the bilateral upscale pass. When clear, the full-res draw(3) composites
// straight to the canvas. The bit gates which return branch fragmentMain takes,
// and the JS renderer keys the pipeline's color-target format — canvas format
// against rgba16float — on the same tier resolve.
fn halfResEnabled() -> bool {
  return (u32(cloud.qualityFlags) & QF_HALF_RES) != 0u;
}

// Convert the ray interval one density sample represents into an explicit
// 3D-texture mip. The rotated density domains are orthonormal, so their scalar
// world-to-domain scale is sufficient. A footprint covering at most one level-0
// voxel returns exactly LOD 0. The internal oracle and the live-noise path stay
// exact mip-0 routes; only the planet-domain baked branch may select
// lower-frequency levels.
fn cloudNoiseMipLevel(
  footprintMeters: f32,
  domainUnitsPerMeter: f32,
  baseResolution: u32,
  levelCount: u32,
) -> f32 {
  let coveredLevel0Voxels =
    max(footprintMeters, 0.0) *
    abs(domainUnitsPerMeter) *
    f32(baseResolution);
  let maxMip = f32(max(i32(levelCount) - 1, 0));
  // Bias one mip toward detail: filtering starts only once the integration
  // interval spans more than two level-0 voxels. This limits over-blur before
  // the nonlinear coverage threshold while still suppressing undersampling.
  return clamp(
    log2(max(coveredLevel0Voxels, 1.0)) - 1.0,
    0.0,
    maxMip,
  );
}

struct CloudNoiseMipLevels {
  shape: f32,
  warp: f32,
  detail: f32,
}

fn cloudDensityMipLevels(footprintMeters: f32) -> CloudNoiseMipLevels {
  if (!planetDensityEnabled() || !noiseBakedEnabled()) {
    return CloudNoiseMipLevels(0.0, 0.0, 0.0);
  }

  // Query each bound texture's descriptor metadata once per macro sample.
  // Both detail-domain consumers share the same resolution/level count.
  let shapeResolution = textureDimensions(cloudShapeTex).x;
  let shapeLevelCount = textureNumLevels(cloudShapeTex);
  let detailResolution = textureDimensions(cloudDetailTex).x;
  let detailLevelCount = textureNumLevels(cloudDetailTex);
  return CloudNoiseMipLevels(
    cloudNoiseMipLevel(
      footprintMeters,
      CLOUD_DENSITY_WORLD_TO_NOISE * cloud.puffSize,
      shapeResolution,
      shapeLevelCount,
    ),
    cloudNoiseMipLevel(
      footprintMeters,
      CLOUD_DENSITY_WORLD_TO_NOISE *
        cloud.puffSize *
        CLOUD_DENSITY_WARP_RATIO,
      detailResolution,
      detailLevelCount,
    ),
    cloudNoiseMipLevel(
      footprintMeters,
      CLOUD_DENSITY_WORLD_TO_NOISE * CLOUD_DENSITY_DETAIL_RATIO,
      detailResolution,
      detailLevelCount,
    ),
  );
}

// Baked cloud base shape: one trilinear fetch of the shape texture's R channel,
// the contrast-stretched Perlin fBm the bake wrote. It stands in for the live
// `fbmNoise` base and is not Worley-remapped, because a remap raises the mean
// and over-densifies the deck; the Worley stays subtractive erosion through
// the detail texture in the full density. Shared by the full density and
// the cloudBaseDensity skip oracle so the two agree before erosion, which is
// what makes `base >= full` hold — the full density subtracts erosion, the
// oracle does not. The `repeat` sampler tiles the periodic bake through world
// space.
fn bakedBase(
  coordinates: CloudDensityCoordinates,
  mipLevels: CloudNoiseMipLevels,
) -> f32 {
  // Domain-warp the lookup by a slow low-frequency offset, sampled from the
  // detail texture at a large period, so the baked texture's ~3.3 km tiling grid
  // bends into organic shapes instead of reading as a repeating lattice. A
  // spatially-varying weather map normally masks the repeat; this keeps it
  // hidden when the weather map is off. The warp preserves the single-sample
  // contrast — there is no octave-blend smoothing — so the billowy puffs
  // survive. A puffSize below 1 enlarges the base puffs, because the texture
  // then covers more world per tile, so the deck reads as fluffy cumulus rather
  // than fine dapple; the detail erosion stays fine, giving big lobes with
  // cauliflower edges. The warp and its sample scale track puffSize so the
  // de-tiling stays proportional.
  let w = textureSampleLevel(
    cloudDetailTex,
    cloudNoiseSampler,
    coordinates.warp,
    mipLevels.warp,
  ).rgb;
  let uvw = coordinates.shape + (w - vec3<f32>(0.5)) * 0.5;
  return textureSampleLevel(
    cloudShapeTex,
    cloudNoiseSampler,
    uvw,
    mipLevels.shape,
  ).r;
}

// Baked lookup for the routes that do not use the planet-anchored domain: the
// live-noise path and the bit-13-off baked path. Keeping it separate from
// `bakedBase` guarantees those never observe a generated mip or a rotated
// domain, which is also what makes them a usable same-build oracle.
fn legacyBakedBase(samplePos: vec3<f32>) -> f32 {
  let SHAPE_SCALE = cloud.puffSize;
  let s = samplePos * SHAPE_SCALE;
  let w = textureSampleLevel(
    cloudDetailTex, cloudNoiseSampler, s * 0.32, 0.0
  ).rgb;
  let uvw = s + (w - vec3<f32>(0.5)) * 0.5;
  return textureSampleLevel(
    cloudShapeTex, cloudNoiseSampler, uvw, 0.0
  ).r;
}

// The unrotated harmonic coordinate construction, used by the same-build oracle
// and the live-noise fallback. It is kept separate from CloudDensityDomain.wgsl
// so the bit-13-off route stays exact.
fn legacyCloudDensityCoordinates(worldNoise: vec3<f32>) -> CloudDensityCoordinates {
  let shape = worldNoise * cloud.puffSize;
  return CloudDensityCoordinates(
    worldNoise,
    shape,
    shape * 0.32,
    worldNoise * 5.0,
  );
}

fn cloudDensityCoordinatesAtWorld(
  worldPos: vec3<f32>,
  windOffset: vec3<f32>,
) -> CloudDensityCoordinates {
  let worldNoise =
    (worldPos + windOffset) * CLOUD_DENSITY_WORLD_TO_NOISE;
  if (planetDensityEnabled() && noiseBakedEnabled()) {
    return cloudDensityCoordinatesFromWorldNoise(worldNoise, cloud.puffSize);
  }
  return legacyCloudDensityCoordinates(worldNoise);
}

// Primary-view relative-to-eye path: the CPU-f64 phases already include the
// camera origin and the wind, so the shader adds only the small camera-relative
// sample displacement. `cloudDensityRelativeWithFootprint`, the beer-shadow
// producer, calls this; the primary march inlines the same reconstruction per
// ray.
fn cloudDensityCoordinatesAtRelative(
  relativeWorld: vec3<f32>,
) -> CloudDensityCoordinates {
  let relativeNoise = relativeWorld * CLOUD_DENSITY_WORLD_TO_NOISE;
  return cloudDensityCoordinatesFromOriginPhases(
    relativeNoise,
    cloud.puffSize,
    cloud.densityShapeOriginPhase,
    cloud.densityWarpOriginPhase,
    cloud.densityDetailOriginPhase,
  );
}

fn advanceDensityCoordinates(
  coordinates: CloudDensityCoordinates,
  worldDelta: vec3<f32>,
) -> CloudDensityCoordinates {
  let noiseDelta = worldDelta * CLOUD_DENSITY_WORLD_TO_NOISE;
  if (planetDensityEnabled() && noiseBakedEnabled()) {
    return advanceCloudDensityCoordinates(
      coordinates, noiseDelta, cloud.puffSize
    );
  }
  return CloudDensityCoordinates(
    coordinates.canonical + noiseDelta,
    coordinates.shape + noiseDelta * cloud.puffSize,
    coordinates.warp + noiseDelta * cloud.puffSize * 0.32,
    coordinates.detail + noiseDelta * 5.0,
  );
}

// Camera-relative morphology origin, paired with
// cloudDensityCoordinatesAtRelative above.
fn cloudMorphologyCoordinateAtRelative(
  relativeWorld: vec3<f32>,
) -> vec3<f32> {
  let relativeNoise = relativeWorld * CLOUD_DENSITY_WORLD_TO_NOISE;
  return cloud.densityMorphologyOriginHigh +
    (cloud.densityMorphologyOriginLow + relativeNoise);
}

fn advanceCloudMorphologyCoordinate(
  coordinate: vec3<f32>,
  worldDelta: vec3<f32>,
) -> vec3<f32> {
  return coordinate + worldDelta * CLOUD_DENSITY_WORLD_TO_NOISE;
}

fn cloudMorphologyCoordinateAtWorld(
  worldPos: vec3<f32>,
  windOffset: vec3<f32>,
) -> vec3<f32> {
  return (worldPos + windOffset) * CLOUD_DENSITY_WORLD_TO_NOISE;
}

// Per-genus vertical density gradient, so genera read as different shapes rather
// than only as different coverage: SLAB is a flat sheet (stratus, altostratus,
// cirrostratus), BILLOWY a rounded cumulus, TOWERING_ANVIL a tall convective
// column that flares near the top (congestus, cumulonimbus). Called identically
// from the full density and from the cloudBaseDensity oracle, which is what
// preserves the `base >= full` invariant.
fn heightGradientFor(h: f32, shape: f32, anvil: f32) -> f32 {
  if (shape < 0.5) {
    // SLAB — fills most of the layer; thin soft edges top and bottom.
    return smoothstep(0.0, 0.08, h) * smoothstep(1.0, 0.92, h);
  } else if (shape < 1.5) {
    // BILLOWY — the default, and the plain gradient the other two vary from.
    return smoothstep(0.0, 0.15, h) * smoothstep(1.0, 0.7, h);
  }
  // TOWERING_ANVIL — rounded base, broad high shoulder; anvil widens the top
  // (higher anvil → density stays high through more of the column before flaring).
  let base = smoothstep(0.0, 0.12, h);
  let anvilTop = smoothstep(1.0, mix(0.85, 0.6, clamp(anvil, 0.0, 1.0)), h);
  return base * anvilTop;
}

// Per-genus fibrous (ice-crystal) morphology.
//
// Relationship to the neighbouring morphology functions: mammatusFactor,
// speciesFactor and featureFactor are opt-in user selections of a supplementary
// feature, species or variety on top of whatever genus is active. This one is
// the genus's own baseline character, taken from the CloudTypeProfile table
// rather than from a user dial, and it composes multiplicatively into the same
// [0,1] factor chain those three form — a fourth link, not a second chain. A
// user who also selects `cloudSpecies: "fibratus"` gets a finer filament
// structure layered on the genus grain, which is what the WMO genus-to-species
// hierarchy means.
//
// Physical model. Cirriform cloud is ice precipitating out of small generating
// cells near the tropopause. The crystals fall at ~0.3-1 m/s through a layer
// whose horizontal wind changes strongly with height — jet-stream shear of order
// 5-20 m/s per km — so each crystal is advected downstream as it descends and
// the cloud is drawn into a long streak trailing beneath and downwind of its
// generating head. Two consequences are modelled here: the streak's anisotropy,
// a length-to-width ratio of order 5:1 to 20:1 along the wind, and its tilt, the
// lower end lagging the head.
//
// `sp` is the wind-advected noise-space sample position and `h` the shell height
// fraction (0 base .. 1 top), matching every other factor in the chain.
fn genusFibreFactor(sp: vec3<f32>, h: f32) -> f32 {
  let strength = clamp(cloud.genusFibreStrength, 0.0, 1.0);
  if (strength <= 0.0) {
    return 1.0;
  }
  // Horizontal wind frame in noise space (same convention as speciesFactor: the
  // wind vector maps to world as vec3(windDirection.x, 0, windDirection.y), so the
  // horizontal plane is sp.xz). Fall back to +X at zero wind so the frame — and
  // therefore the streak direction — stays defined rather than degenerate.
  let windH = vec2<f32>(cloud.windDirection.x, cloud.windDirection.y);
  let wlen = length(windH);
  let windDir = select(vec2<f32>(1.0, 0.0), windH / max(wlen, 1e-5), wlen > 1e-5);
  let crossDir = vec2<f32>(-windDir.y, windDir.x);
  let horiz = vec2<f32>(sp.x, sp.z);
  // Fallstreak tilt: the generating head is at the deck top, and the falling ice
  // lags downwind of it, so the along-wind displacement grows toward the base
  // (h -> 0) and vanishes at the head (h = 1).
  let along = dot(horiz, windDir) - (1.0 - h) * cloud.genusFibreShear;
  let acr = dot(horiz, crossDir);
  // Anisotropic sampling domain. Dividing only the along-wind axis by the aspect
  // ratio makes an isotropic cell field read as filaments `aspect` times longer
  // along the wind than across it — this single division is the streak
  // signature. At aspect 1 the domain is isotropic again and the genus falls
  // back to generic rounded cells, which does not read as cirriform.
  let aspect = max(cloud.genusFibreAnisotropy, 1.0);
  // The vertical axis is compressed so cells stay columnar through a thin high
  // deck: a filament is a curtain hanging through the layer, not a floating blob.
  let fibP = vec3<f32>(along / aspect, sp.y * 0.35, acr) * 3.0;
  let streak = worleyF1(fibP); // ~0 in a filament core, ~1 between filaments
  // Keep density in the cores and carve the gaps between them.
  let carve = smoothstep(0.12, 0.72, streak) * strength;
  return clamp(1.0 - carve, 0.0, 1.0);
}

// Model-approved fibre-composition constants. These are global authored
// constants rather than new uniforms because the operating point is one
// composition law shared by every genus. The per-genus strength/aspect row is
// still the gate: CUMULUS strength 0 takes the exact identity return below.
const GENUS_BASE_FIELD_MEAN: f32 = 0.484375;
const GENUS_BASE_VARIANCE_BUDGET: f32 = 0.55;
const GENUS_BASE_VARIANCE_DOWN_WEIGHT: f32 = 0.25;
const GENUS_EROSION_COMPENSATION: f32 = 0.6;

// Spend a small, genus-conditioned variance budget after the coverage gate but
// before the height profile and fibre carve. Pulling troughs toward the gated
// field mean receives the full budget; pulling peaks down receives only 0.25 of
// it, preserving the low-coverage upper tail the North Atlantic fixture needs.
// The directionality term prevents a near-round fibrous genus from paying for
// variance reduction that cannot reveal directional structure.
fn applyGenusBaseVarianceBudget(
  gatedDensity: f32,
  coverageThreshold: f32,
) -> f32 {
  let strength = clamp(cloud.genusFibreStrength, 0.0, 1.0);
  if (strength <= 0.0) {
    return gatedDensity;
  }
  let aspect = max(cloud.genusFibreAnisotropy, 1.0);
  let directionality = 1.0 - 1.0 / aspect;
  let budgetWeight = clamp(
    GENUS_BASE_VARIANCE_BUDGET * strength * directionality,
    0.0,
    1.0,
  );
  if (budgetWeight <= 0.0) {
    return gatedDensity;
  }
  // Feeding the derived base-field mean through this coverage's own gate keeps
  // the pivot coverage-aware without adding a response LUT or a uniform slot.
  let pivot = smoothstep(
    coverageThreshold,
    1.0,
    GENUS_BASE_FIELD_MEAN,
  );
  let weight = select(
    budgetWeight,
    budgetWeight * GENUS_BASE_VARIANCE_DOWN_WEIGHT,
    pivot < gatedDensity,
  );
  return gatedDensity + (pivot - gatedDensity) * weight;
}

// The carve-before-erosion order sharpens filament gaps but removes mass. A
// genus-conditioned reduction of erosion depth restores that mass without
// moving CUMULUS or changing the existing height-dependent erosion profile.
fn genusErosionDepthScale() -> f32 {
  let strength = clamp(cloud.genusFibreStrength, 0.0, 1.0);
  if (strength <= 0.0) {
    return 1.0;
  }
  return 1.0 - GENUS_EROSION_COMPENSATION * strength;
}

// Height weighting of the subtractive detail erosion.
//
// Cumuliform erosion is base-weighted (`1 - h`): a convective water cloud has a
// soft ragged bottom and a crisp cauliflower top, so the detail octave eats the
// base and leaves the crown. Ice cloud has no such buoyant asymmetry — the deck
// is shredded uniformly through its depth — so a fibrous genus blends that
// weight toward a constant. At genusFibreStrength 0 the early return yields
// `1.0 - h` itself, not an arithmetically-equal mix.
fn genusErosionHeightWeight(h: f32) -> f32 {
  let fibre = clamp(cloud.genusFibreStrength, 0.0, 1.0);
  if (fibre <= 0.0) {
    return 1.0 - h;
  }
  return mix(1.0 - h, 1.0, fibre);
}

// Per-genus Henyey-Greenstein forward-lobe eccentricity.
//
// Ice crystals — hexagonal plates and columns — scatter far more forward-peaked
// than liquid droplets: CloudTypeProfile gives the cirrus family g ~ 0.88-0.9
// against ~0.76-0.78 for the water genera. The delta is added to the tunable
// `phaseG1` rather than replacing it, so the sun-colour and dual-lobe
// calibration carried by that uniform survives, and the sum is clamped short of
// 1 because the HG denominator `(1 + g^2 - 2g)^1.5` collapses there and the
// forward peak would diverge. genusPhaseDelta is exactly 0 for CUMULUS, which
// the early return handles without arithmetic.
const GENUS_PHASE_G_LIMIT: f32 = 0.95;
fn genusForwardG() -> f32 {
  if (cloud.genusPhaseDelta == 0.0) {
    return cloud.phaseG1;
  }
  return clamp(
    cloud.phaseG1 + cloud.genusPhaseDelta,
    -GENUS_PHASE_G_LIMIT,
    GENUS_PHASE_G_LIMIT,
  );
}

// Pendulous "mamma" pouches on the cloud underside. Returns a density multiplier
// in [0,1] that carves the underside between rounded lobe cells while keeping
// density at the cell centres, so the otherwise-flat cloud base reads as a field
// of downward-bulging pouches: the mammatus signature is an inverted height
// gradient near the base plus a lobed displacement. Guarded on mammatusStrength,
// which returns 1.0 at 0 and makes the feature opt-in. Called identically from
// the full density and from the cloudBaseDensity oracle — both multiply by the
// same in-[0,1] factor, so `base >= full` survives, since base·f >= full·f for
// f >= 0. `sp` is the wind-advected noise-space sample position, so the pouches
// drift with the deck; `h` is the shell height fraction (0 base .. 1 top).
fn mammatusFactor(sp: vec3<f32>, h: f32) -> f32 {
  if (cloud.mammatusStrength <= 0.0) {
    return 1.0;
  }
  let depth = max(cloud.mammatusDepth, 1e-3);
  // Band weight: 1 at the base (h=0), fades to 0 by h=depth → the cloud body and
  // top above the underside band are untouched.
  let band = 1.0 - smoothstep(0.0, depth, h);
  if (band <= 0.0) {
    return 1.0;
  }
  // Rounded lobe field from the horizontal sample position. worleyF1 is the cell
  // distance (≈0 at a feature point = pouch centre, ≈1 between cells). The vertical
  // axis is compressed so cells stay roughly columnar across the thin band and the
  // pouches hang straight down rather than tilt. `mammatusScale` sets pouch size.
  let lobeP = vec3<f32>(sp.x, sp.y * 0.25, sp.z) * (8.0 * max(cloud.mammatusScale, 1e-3));
  let cellDist = worleyF1(lobeP);
  // Carve between pouches, at high cellDist, and keep density at pouch centres,
  // at low cellDist; smoothstep rounds the pouch lobe. Scaled by band and
  // strength.
  let carve = smoothstep(0.15, 1.0, cellDist) * band * cloud.mammatusStrength;
  return clamp(1.0 - carve, 0.0, 1.0);
}

// Species and varieties as bounded density shaping. Returns a per-position
// density multiplier in [0,1]:
//   mode 1 LENTICULARIS — smooth, wind-aligned, vertically-stacked lens plates,
//     the orographic "flying saucer" stack. Smooth by construction, with no
//     Worley or curl term: the smoothness is what distinguishes it from the
//     lobed mammatus carve. Density is kept in elongated lens cores along the
//     wind and tapered between stacked plates.
//   mode 2 FIBRATUS / UNCINUS — wispy cirrus filaments stretched along the wind
//     for fibratus. speciesParam adds a height-sheared hook that curls the upper
//     filaments downwind, the uncinus fallstreak comma. Worley cells compressed
//     hard along-wind become long streaks; density is carved between filaments.
// Guarded on speciesMode < 0.5 or speciesStrength <= 0, which returns 1.0 and
// makes the feature opt-in. Called identically from the full density and from
// cloudBaseDensity with the same in-[0,1] factor, so `base >= full` survives.
// `sp` is the wind-advected noise-space sample position; `h` is the shell height
// fraction.
fn speciesFactor(sp: vec3<f32>, h: f32) -> f32 {
  if (cloud.speciesMode < 0.5 || cloud.speciesStrength <= 0.0) {
    return 1.0;
  }
  let strength = clamp(cloud.speciesStrength, 0.0, 1.0);
  let scale = max(cloud.speciesScale, 1e-3);
  // Horizontal wind frame in noise space. The wind vector maps to world as
  // vec3(windDirection.x, 0, windDirection.y), so the horizontal plane is sp.xz and
  // wind lies within it. Fall back to +X when the wind is ~0 so the frame is stable.
  let windH = vec2<f32>(cloud.windDirection.x, cloud.windDirection.y);
  let wlen = length(windH);
  let windDir = select(vec2<f32>(1.0, 0.0), windH / max(wlen, 1e-5), wlen > 1e-5);
  let crossDir = vec2<f32>(-windDir.y, windDir.x);
  let horiz = vec2<f32>(sp.x, sp.z);
  let along = dot(horiz, windDir);
  let acr = dot(horiz, crossDir);

  if (cloud.speciesMode < 1.5) {
    // LENTICULARIS — smooth stacked lens plates, elongated along the wind.
    // Vertical stacking: smooth cosine plates through the shell height (the layered
    // "stack of plates" look). Frequency rises gently with scale.
    let stack = 0.5 + 0.5 * cos(h * PI * (1.0 + 3.0 * scale));
    // Lens body: repeat lens cells along the wind; each cell is dense at its core
    // and tapers smoothly toward the ends (the elongated lens silhouette). The
    // along-wind coordinate is compressed (0.15) so lenses are long, not round.
    let cell = fract(along * 0.15 * scale + 0.5) - 0.5; // -0.5..0.5 within a lens
    let lensBody = 1.0 - smoothstep(0.2, 0.5, abs(cell));
    let lens = mix(1.0, stack * lensBody, strength);
    return clamp(lens, 0.0, 1.0);
  }

  // FIBRATUS / UNCINUS — wind-aligned wispy filaments. Compress the along-wind axis
  // hard so Worley cells become long streaks parallel to the wind. speciesParam
  // shears the along coordinate by height so upper filaments curl downwind (uncinus
  // hook); at param 0 the filaments stay straight (fibratus).
  let hook = (h - 0.5) * cloud.speciesParam;
  let fibP = vec3<f32>((along + hook) * 0.1, sp.y * 0.4, acr) * (4.0 * scale);
  let streak = worleyF1(fibP); // ~0 along a filament core, ~1 between filaments
  let wisp = smoothstep(0.15, 0.75, streak);
  let fib = mix(1.0, 1.0 - wisp, strength);
  return clamp(fib, 0.0, 1.0);
}

// Supplementary features, the sibling of the mammatus and species factors above.
// Returns a per-position density multiplier in [0,1]:
//   mode 1 ASPERITAS — chaotic wavy underside. A domain-warped
//     multi-directional sine field carves the base band into an undulating,
//     non-repeating wavy surface, the storm-tossed sea seen from below.
//   mode 2 FLUCTUS (Kelvin-Helmholtz) — breaking-wave billows. Density
//     concentrates at periodic wind-aligned crests, and a height shear from
//     featureParam leans the crest downwind so the band reads as a row of
//     curling waves.
//   mode 3 ARCUS — shelf or roll at the leading edge. Keeps a dense wind-leading
//     roll and carves a trough just behind it so a shelf stands proud of the
//     lower and mid body; featureParam widens the shelf.
//   mode 4 VIRGA / PRAECIPITATIO — fallstreak tail below the body. Carves the
//     lower band into vertical across-wind streaks so density hangs down in
//     fibrous trails; featureParam toward 1 gives praecipitatio, denser streaks
//     reaching further toward the base.
// Guarded on featureMode < 0.5 or featureStrength <= 0, which returns 1.0 and
// makes the feature opt-in. Called identically from the full density and from
// cloudBaseDensity with the same in-[0,1] factor, so `base >= full` survives.
// `sp` is the wind-advected noise-space sample position; `h` is the shell height
// fraction, 0 to 1.
fn featureFactor(sp: vec3<f32>, h: f32) -> f32 {
  if (cloud.featureMode < 0.5 || cloud.featureStrength <= 0.0) {
    return 1.0;
  }
  let strength = clamp(cloud.featureStrength, 0.0, 1.0);
  let scale = max(cloud.featureScale, 1e-3);
  // Horizontal wind frame in noise space (same convention as speciesFactor).
  let windH = vec2<f32>(cloud.windDirection.x, cloud.windDirection.y);
  let wlen = length(windH);
  let windDir = select(vec2<f32>(1.0, 0.0), windH / max(wlen, 1e-5), wlen > 1e-5);
  let crossDir = vec2<f32>(-windDir.y, windDir.x);
  let horiz = vec2<f32>(sp.x, sp.z);
  let along = dot(horiz, windDir);
  let acr = dot(horiz, crossDir);

  if (cloud.featureMode < 1.5) {
    // ASPERITAS — chaotic wavy underside. Band peaks at the base and fades up.
    let band = 1.0 - smoothstep(0.0, 0.55, h);
    if (band <= 0.0) {
      return 1.0;
    }
    // Domain-warped multi-directional sine field → an undulating, non-repeating
    // wavy surface. The warp meanders the phase so waves are irregular, not a grid.
    let f = 6.0 * scale;
    let warp = valueNoise(vec3<f32>(along, acr, sp.y) * (2.0 * scale)) - 0.5;
    let wave = 0.5 + 0.5 * sin(along * f + warp * 4.0)
                    * cos(acr * f * 0.75 - warp * 3.0);
    // Carve the troughs (low `wave`) so the underside billows into rolling waves.
    let carve = (1.0 - smoothstep(0.35, 0.85, wave)) * band * strength;
    return clamp(1.0 - carve, 0.0, 1.0);
  }

  if (cloud.featureMode < 2.5) {
    // FLUCTUS (Kelvin-Helmholtz) — breaking-wave billows along a shear
    // interface. The wave forms at a shear layer in the cloud body, so the
    // billows are anchored in the mid and lower body where the deck carries
    // density; an anvil top carries little, and a top-only band would read as no
    // change. The periodic wind-aligned crest is the fluctus signature, against
    // the chaotic asperitas and streaked virga carves.
    let band = 1.0 - smoothstep(0.5, 0.9, h);
    if (band <= 0.0) {
      return 1.0;
    }
    // Periodic wind-aligned crests; a height shear leans the crest downwind so it
    // reads as a curling / breaking wave. featureParam sets the shear amount.
    let shear = h * (2.0 + 3.0 * cloud.featureParam);
    let crest = 0.5 + 0.5 * sin(along * (3.0 * scale) + shear);
    // Keep density at the crests, carve the troughs between billows.
    let carve = (1.0 - smoothstep(0.25, 0.9, crest)) * band * strength;
    return clamp(1.0 - carve, 0.0, 1.0);
  }

  if (cloud.featureMode < 3.5) {
    // ARCUS — a dense roll or shelf at the wind-leading edge. A slowly-repeating
    // along-wind cell places a roll, the dense front lip, with a carved trough
    // just behind it so the shelf stands proud. featureParam widens the shelf.
    let cell = fract(along * 0.06 * scale);
    let width = 0.25 + 0.35 * clamp(cloud.featureParam, 0.0, 1.0);
    let gap = smoothstep(width, width + 0.18, cell)
            * (1.0 - smoothstep(0.72, 0.9, cell));
    // Confine the shelf carve to the lower/mid body so the top is untouched.
    let band = 1.0 - smoothstep(0.6, 0.95, h);
    let carve = gap * band * strength;
    return clamp(1.0 - carve, 0.0, 1.0);
  }

  // VIRGA / PRAECIPITATIO — fallstreak tail below the body. Carve the lower band
  // into vertical across-wind streaks so density hangs down in fibrous trails.
  // featureParam, the praecipitatio dial, makes the streaks finer and more
  // numerous and reaches them further toward the base, so it reads as heavier
  // precipitation than plain virga.
  let param = clamp(cloud.featureParam, 0.0, 1.0);
  // param deepens the affected band (streaks reach further down toward the base).
  let bandDepth = 0.5 + 0.3 * param;
  let band = 1.0 - smoothstep(0.0, bandDepth, h);
  if (band <= 0.0) {
    return 1.0;
  }
  // Across-wind streak field: Worley cells compressed along-wind + vertically so the
  // kept cores form vertical curtains (the fallstreak look). param raises the
  // horizontal frequency → finer, more numerous fallstreaks (praecipitatio).
  let vScale = scale * (1.0 + 0.8 * param);
  let streakP = vec3<f32>(acr * 4.0 * vScale, sp.y * 0.15, along * 0.5 * vScale);
  let streak = worleyF1(streakP); // ~0 in a streak core, ~1 between
  let gaps = smoothstep(0.2, 0.7, streak);
  let carve = gaps * band * strength;
  return clamp(1.0 - carve, 0.0, 1.0);
}

// Smooth pastel spectral palette — an Iñigo Quilez cosine gradient. Maps a
// scalar phase t (any real; only fract(t) matters) to a mother-of-pearl
// iridescent color. The high DC term (a ≈ 0.83) and low amplitude (b ≈ 0.16)
// keep the colors pastel — unsaturated and high-value, the nacreous look —
// rather than a saturated rainbow. The phase offsets d are spaced 0, ⅓, ⅔ so R,
// G and B peak at different t, giving the smooth spectral cycle.
fn iridescentHue(t: f32) -> vec3<f32> {
  let a = vec3<f32>(0.83, 0.83, 0.86);
  let b = vec3<f32>(0.16, 0.15, 0.14);
  let c = vec3<f32>(1.0, 1.0, 1.0);
  let d = vec3<f32>(0.0, 0.33, 0.67);
  return a + b * cos(2.0 * PI * (c * t + d));
}

// Iridescent color tint for the two "shining" special-cloud forms. Returns a
// multiplier on the per-sample cloud color:
//   mode 1 NOCTILUCENT — mesospheric. A cool electric silvery-blue modulated by
//     the fine herringbone billow banding these clouds are known for. They glow
//     by high-altitude sunlight after local sunset, so the tint is keyed to the
//     billow structure — position — rather than to the sun-facing term.
//   mode 2 NACREOUS — stratospheric mother-of-pearl. Pastel spectral bands keyed
//     to the sun/view scattering angle in cosTheta, like a diffraction corona,
//     plus a slow spatial phase, so adjacent cloud regions show different pastel
//     hues and the colors shift as the sun/view geometry changes.
//     specialShadeParam sets the spectral cycling frequency.
// Guarded on specialShadeMode < 0.5 or specialShadeStrength <= 0, which returns
// vec3(1.0) and makes the feature opt-in. `sp` is the noise-space sample
// position, `h` the shell height fraction (0 base .. 1 top), and `cosTheta` is
// dot(view, sun).
fn specialShadeTint(sp: vec3<f32>, h: f32, cosTheta: f32) -> vec3<f32> {
  if (cloud.specialShadeMode < 0.5 || cloud.specialShadeStrength <= 0.0) {
    return vec3<f32>(1.0);
  }
  let strength = clamp(cloud.specialShadeStrength, 0.0, 1.0);
  let scale = max(cloud.specialShadeScale, 1e-3);
  if (cloud.specialShadeMode < 1.5) {
    // NOCTILUCENT — electric silvery-blue with fine herringbone billow bands.
    // The tint pulls red and green down and holds blue at ~1.0 rather than
    // boosting any channel: boosting pushes the sample into the Reinhard
    // tone-map knee, where the warm sun washes the hue back toward white, so
    // attenuating the warm channels is what lets blue survive tone-mapping as
    // the dominant channel. The billow bands ripple brightness downward only
    // (<= 1) so they never re-enter the knee. `nlc` is cool electric blue with
    // strongly-suppressed red and green.
    let band = 0.85 + 0.15 * sin((sp.x + sp.z) * 60.0 * scale + sp.y * 20.0);
    let nlc = vec3<f32>(0.42, 0.60, 1.0);
    return mix(vec3<f32>(1.0), nlc * band, strength);
  }
  // NACREOUS — mother-of-pearl iridescence keyed to the scattering angle + a slow
  // spatial phase (so the pastel bands vary across the shell and shift with the
  // sun/view geometry, like a diffraction corona on a lens-wave cloud).
  let freq = 1.0 + 3.0 * clamp(cloud.specialShadeParam, 0.0, 1.0);
  let spatial = (sp.x - sp.z) * 8.0 * scale + h * 2.0;
  let phase = (cosTheta * 0.5 + 0.5) * freq + spatial * 0.15;
  return mix(vec3<f32>(1.0), iridescentHue(phase), strength);
}

// Per-position G/B/A channel decode.
// Decodes the weather sample's three secondary channels into model-space
// modifiers, and is neutral-safe: a neutral cell (G=0.5, B=0, A=0.5) yields the
// identity — densityScale 1, baseShift 0, shape cloud.profileShape — at any
// `weatherChannelStrength`, so an R-only map behaves as if the channels were not
// read. Returns:
//   .x = densityScale      — A density-bias multiplier (1.0 neutral)
//   .y = baseShiftFrac     — B cloud-base height shift in shell fractions (0 neutral)
//   .z = perGenusShape     — G-biased height-gradient shape index (cloud.profileShape neutral)
struct WeatherChannels {
  densityScale: f32,
  baseShiftFrac: f32,
  perGenusShape: f32,
};
fn decodeWeatherChannels(gba: vec3<f32>, deckThickness: f32) -> WeatherChannels {
  let s = cloud.weatherChannelStrength;
  // A — density bias (0.5 neutral). Remap to a multiplier around 1.0: A=0.5→1.0,
  // A=1→1+s, A=0→1-s. Clamp at 0 so a fully-thin cell can't drive density negative.
  let densityScale = max(0.0, 1.0 + (gba.z - 0.5) * 2.0 * s);
  // B — cloud base, normalized over CLOUD_BASE_NORM_METERS (12 km), 0 neutral.
  // The raw value is base-metres / 12000; convert it to a fraction of the cloud
  // shell thickness so the height gradient lifts off that base. `deckThickness`
  // is the active deck's own span, so a per-deck base shift stays in that deck's
  // shell fraction; the single-shell call passes cloudLayerTop - cloudLayerBottom.
  let layerThickness = max(deckThickness, 1.0);
  let baseShiftFrac = clamp(
    gba.y * CLOUD_BASE_NORM_METERS / layerThickness * s, 0.0, 0.9);
  // G — genus/type index packed as genus/10 (0..1 → 0..10). 0.5 (the packer's
  // neutral mid, genus ≈ 5) → no change: blend cloud.profileShape toward
  // SLAB(0) below mid and TOWERING_ANVIL(2) above mid by the signed deviation, so
  // a low-G cell flattens (stratus-like) and a high-G cell towers (cumulonimbus-
  // like). |G-0.5| small → ≈ the global shape. This is a best-effort shape bias,
  // not a full per-pixel genus profile.
  let gDev = (gba.x - 0.5) * 2.0 * s; // -s..+s, 0 at neutral
  let genusTarget = select(0.0, 2.0, gDev > 0.0); // SLAB below mid, TOWER above
  let perGenusShape = mix(cloud.profileShape, genusTarget, clamp(abs(gDev), 0.0, 1.0));
  return WeatherChannels(densityScale, baseShiftFrac, perGenusShape);
}

// Same-build control. These two functions carry the density evaluation for the
// live-noise and bit-13-off baked routes in full, and are not routed through the
// macro and domain helpers, so comparing against them detects a regression in
// those helpers as well as in the rotated texture coordinates.
fn legacyCloudDensity(
  worldPos: vec3<f32>,
  heightFraction: f32,
  deckBottom: f32,
  deckTop: f32,
) -> f32 {
  let windOffset =
    vec3<f32>(cloud.windDirection.x, 0.0, cloud.windDirection.y) *
    cloud.windSpeed *
    cloud.time;
  let samplePos = (worldPos + windOffset) * 0.0003;

  var effectiveCoverage = cloud.coverage;
  var wch = WeatherChannels(1.0, 0.0, cloud.profileShape);
  if (cloud.weatherMapEnabled > 0.5) {
    let wuv = worldToWeatherUV(worldPos);
    let wsample = textureSampleLevel(
      weatherTex, weatherSampler, wuv, 0, 0.0
    );
    effectiveCoverage = clamp(
      wsample.r * cloud.weatherStrength, 0.0, 1.0
    );
    wch = decodeWeatherChannels(wsample.gba, deckTop - deckBottom);
  }

  var density: f32;
  if (noiseBakedEnabled()) {
    density = legacyBakedBase(samplePos);
  } else {
    density = fbmNoise(samplePos);
  }
  let coverageThreshold = 1.0 - cloudEffectiveCoverage(effectiveCoverage);
  density = smoothstep(coverageThreshold, 1.0, density);
  density = applyGenusBaseVarianceBudget(density, coverageThreshold);

  let hForGradient = clamp(
    (heightFraction - wch.baseShiftFrac) /
      max(1.0 - wch.baseShiftFrac, 1e-3),
    0.0,
    1.0,
  );
  let heightGradient = heightGradientFor(
    hForGradient, wch.perGenusShape, cloud.anvilBias
  );
  density *= heightGradient;
  let genusFibre = genusFibreFactor(samplePos, heightFraction);
  density *= genusFibre;

  if (noiseBakedEnabled()) {
    var detailPos = samplePos * 5.0;
    if (cloud.curlAmplitude > 0.0) {
      let warp =
        curlNoise3(samplePos * cloud.curlFrequency) *
        (cloud.curlAmplitude * 2.0);
      detailPos = detailPos + warp;
    }
    let detail = textureSampleLevel(
      cloudDetailTex, cloudNoiseSampler, detailPos, 0.0
    );
    let worleyDetail = 1.0 - detail.r;
    let erosionLo =
      worleyDetail * cloud.erosionStrength *
      genusErosionDepthScale() *
      genusErosionHeightWeight(heightFraction);
    density = clamp(
      remap(density, erosionLo, 1.0, 0.0, 1.0), 0.0, 1.0
    );
  } else {
    let worleyDetail = worleyF1(
      samplePos * 5.0 + windOffset * 0.001
    );
    density -= worleyDetail * 0.18 * genusErosionDepthScale() *
      genusErosionHeightWeight(heightFraction);
    density = max(density, 0.0);
  }

  return density *
    cloud.densityMultiplier *
    cloud.profileDensityScale *
    wch.densityScale *
    mammatusFactor(samplePos, heightFraction) *
    speciesFactor(samplePos, heightFraction) *
    featureFactor(samplePos, heightFraction);
}

fn legacyCloudBaseDensity(
  worldPos: vec3<f32>,
  heightFraction: f32,
  deckBottom: f32,
  deckTop: f32,
) -> f32 {
  let windOffset =
    vec3<f32>(cloud.windDirection.x, 0.0, cloud.windDirection.y) *
    cloud.windSpeed *
    cloud.time;
  let samplePos = (worldPos + windOffset) * 0.0003;

  var effectiveCoverage = cloud.coverage;
  var wch = WeatherChannels(1.0, 0.0, cloud.profileShape);
  if (cloud.weatherMapEnabled > 0.5) {
    let wuv = worldToWeatherUV(worldPos);
    let wsample = textureSampleLevel(
      weatherTex, weatherSampler, wuv, 0, 0.0
    );
    effectiveCoverage = clamp(
      wsample.r * cloud.weatherStrength, 0.0, 1.0
    );
    wch = decodeWeatherChannels(wsample.gba, deckTop - deckBottom);
  }

  var density: f32;
  if (noiseBakedEnabled()) {
    density = legacyBakedBase(samplePos);
  } else {
    density = fbmNoise(samplePos);
  }
  let coverageThreshold = 1.0 - cloudEffectiveCoverage(effectiveCoverage);
  density = smoothstep(coverageThreshold, 1.0, density);
  density = applyGenusBaseVarianceBudget(density, coverageThreshold);
  let hForGradient = clamp(
    (heightFraction - wch.baseShiftFrac) /
      max(1.0 - wch.baseShiftFrac, 1e-3),
    0.0,
    1.0,
  );
  let heightGradient = heightGradientFor(
    hForGradient, wch.perGenusShape, cloud.anvilBias
  );
  density *= heightGradient;
  let genusFibre = genusFibreFactor(samplePos, heightFraction);
  density *= genusFibre;
  return density *
    cloud.densityMultiplier *
    cloud.profileDensityScale *
    wch.densityScale *
    mammatusFactor(samplePos, heightFraction) *
    speciesFactor(samplePos, heightFraction) *
    featureFactor(samplePos, heightFraction);
}

// One evaluation of coverage, base noise, vertical profile and every morphology
// factor. The adaptive fine path reuses this same macro sample for both the
// conservative base oracle and the eroded full density, so the weather, noise
// and morphology work is paid once rather than twice, and `base >= full` becomes
// structural instead of a convention two call sites have to keep.
struct CloudMacroSample {
  preErosion: f32,
  densityFactor: f32,
  coordinates: CloudDensityCoordinates,
  morphologyCoordinate: vec3<f32>,
  detailMipLevel: f32,
};

fn cloudWindOffset() -> vec3<f32> {
  return vec3<f32>(cloud.windDirection.x, 0.0, cloud.windDirection.y)
       * cloud.windSpeed * cloud.time;
}

fn cloudMacroSampleAt(
  worldPos: vec3<f32>,
  coordinates: CloudDensityCoordinates,
  morphologyCoordinate: vec3<f32>,
  heightFraction: f32,
  deckBottom: f32,
  deckTop: f32,
  footprintMeters: f32,
) -> CloudMacroSample {
  // Weather stays geographically anchored to worldPos: the equirectangular seam
  // and bounds handling live in worldToWeatherUV, and the density coordinates
  // never advect it.
  var effectiveCoverage = cloud.coverage;
  var wch = WeatherChannels(1.0, 0.0, cloud.profileShape);
  if (cloud.weatherMapEnabled > 0.5) {
    let wuv = worldToWeatherUV(worldPos);
    let wsample = textureSampleLevel(weatherTex, weatherSampler, wuv, 0, 0.0);
    effectiveCoverage = clamp(wsample.r * cloud.weatherStrength, 0.0, 1.0);
    wch = decodeWeatherChannels(wsample.gba, deckTop - deckBottom);
  }

  var mipLevels = CloudNoiseMipLevels(0.0, 0.0, 0.0);
  var density: f32;
  if (noiseBakedEnabled()) {
    mipLevels = cloudDensityMipLevels(footprintMeters);
    density = bakedBase(coordinates, mipLevels);
  } else {
    density = fbmNoise(coordinates.canonical);
  }
  let coverageThreshold = 1.0 - cloudEffectiveCoverage(effectiveCoverage);
  density = smoothstep(coverageThreshold, 1.0, density);
  density = applyGenusBaseVarianceBudget(density, coverageThreshold);

  let hForGradient = clamp(
    (heightFraction - wch.baseShiftFrac) /
      max(1.0 - wch.baseShiftFrac, 1e-3),
    0.0,
    1.0,
  );
  density *= heightGradientFor(
    hForGradient, wch.perGenusShape, cloud.anvilBias
  );
  let genusFibre = genusFibreFactor(morphologyCoordinate, heightFraction);
  density *= genusFibre;

  let factor =
    cloud.densityMultiplier *
    cloud.profileDensityScale *
    wch.densityScale *
    mammatusFactor(morphologyCoordinate, heightFraction) *
    speciesFactor(morphologyCoordinate, heightFraction) *
    featureFactor(morphologyCoordinate, heightFraction);
  return CloudMacroSample(
    density,
    factor,
    coordinates,
    morphologyCoordinate,
    mipLevels.detail,
  );
}

fn cloudBaseFromMacro(sample: CloudMacroSample) -> f32 {
  return sample.preErosion * sample.densityFactor;
}

fn cloudDensityFromMacro(
  sample: CloudMacroSample,
  heightFraction: f32,
) -> f32 {
  var density = sample.preErosion;
  var detailPos = sample.coordinates.detail;
  if (cloud.curlAmplitude > 0.0) {
    let warp = curlNoise3(
      sample.morphologyCoordinate * cloud.curlFrequency
    ) * (cloud.curlAmplitude * 2.0);
    detailPos = detailPos + warp;
  }
  let detail = textureSampleLevel(
    cloudDetailTex,
    cloudNoiseSampler,
    detailPos,
    sample.detailMipLevel,
  );
  let worleyDetail = 1.0 - detail.r;
  let erosionLo =
    worleyDetail * cloud.erosionStrength *
    genusErosionDepthScale() *
    genusErosionHeightWeight(heightFraction);
  density = clamp(remap(density, erosionLo, 1.0, 0.0, 1.0), 0.0, 1.0);
  return density * sample.densityFactor;
}

fn cloudDensityAtCoordinates(
  worldPos: vec3<f32>,
  coordinates: CloudDensityCoordinates,
  morphologyCoordinate: vec3<f32>,
  heightFraction: f32,
  deckBottom: f32,
  deckTop: f32,
  footprintMeters: f32,
) -> f32 {
  let macroSample = cloudMacroSampleAt(
    worldPos, coordinates, morphologyCoordinate,
    heightFraction, deckBottom, deckTop, footprintMeters
  );
  return cloudDensityFromMacro(macroSample, heightFraction);
}

// Raw-world wrappers keep the non-relative-to-eye route on the same mathematical
// density field. They are the explicit `cloudHighPrecision = false` escape path
// and the same-build oracle for the camera-relative twin below, which is what
// the shadow producer reads through. `cloudDensity` itself has no caller —
// `cloudDensityWithFootprint` is the one the escape path reaches — and is kept
// as the zero-footprint entry point of that pair; the shader compiler strips an
// uncalled function, so it costs nothing at runtime.
fn cloudDensity(
  worldPos: vec3<f32>,
  heightFraction: f32,
  deckBottom: f32,
  deckTop: f32,
) -> f32 {
  if (!planetDensityEnabled() || !noiseBakedEnabled()) {
    return legacyCloudDensity(
      worldPos, heightFraction, deckBottom, deckTop
    );
  }
  let windOffset = cloudWindOffset();
  let coordinates = cloudDensityCoordinatesAtWorld(worldPos, windOffset);
  let morphologyCoordinate =
    cloudMorphologyCoordinateAtWorld(worldPos, windOffset);
  return cloudDensityAtCoordinates(
    worldPos, coordinates, morphologyCoordinate,
    heightFraction, deckBottom, deckTop, 0.0
  );
}

fn cloudDensityWithFootprint(
  worldPos: vec3<f32>,
  heightFraction: f32,
  deckBottom: f32,
  deckTop: f32,
  footprintMeters: f32,
) -> f32 {
  if (!planetDensityEnabled() || !noiseBakedEnabled()) {
    return legacyCloudDensity(
      worldPos, heightFraction, deckBottom, deckTop
    );
  }
  let windOffset = cloudWindOffset();
  let coordinates = cloudDensityCoordinatesAtWorld(worldPos, windOffset);
  let morphologyCoordinate =
    cloudMorphologyCoordinateAtWorld(worldPos, windOffset);
  return cloudDensityAtCoordinates(
    worldPos, coordinates, morphologyCoordinate,
    heightFraction, deckBottom, deckTop, footprintMeters
  );
}

// The camera-relative twin of cloudDensityWithFootprint, and the density entry
// point the beer-shadow-map producer uses.
//
// The visible march reconstructs its domains from CPU-`f64` origin phases plus a
// small camera-relative displacement. Reconstructing a full-ECEF `vec3<f32>`
// sample and rebuilding the periodic texture domains from that instead is a
// different approximation of the same field, and a shadow cast from a
// differently-approximated field does not line up with the rendered cloud, so
// both go through this one owner.
//
// `relativePos` is the sample position relative to the camera — the frame
// `encodedCameraHigh/Low` and the origin phases are anchored at. The world
// position is reconstructed in high-then-low order for the geographic weather
// lookup alone.
fn cloudDensityRelativeWithFootprint(
  relativePos: vec3<f32>,
  centerHigh: vec3<f32>,
  centerLow: vec3<f32>,
  heightFraction: f32,
  deckBottom: f32,
  deckTop: f32,
  footprintMeters: f32,
) -> f32 {
  let worldPos = (relativePos - centerHigh) - centerLow;
  if (!planetDensityEnabled() || !noiseBakedEnabled()) {
    return legacyCloudDensity(
      worldPos, heightFraction, deckBottom, deckTop
    );
  }
  let coordinates = cloudDensityCoordinatesAtRelative(relativePos);
  let morphologyCoordinate = cloudMorphologyCoordinateAtRelative(relativePos);
  return cloudDensityAtCoordinates(
    worldPos, coordinates, morphologyCoordinate,
    heightFraction, deckBottom, deckTop, footprintMeters
  );
}

// The cheap no-erosion base oracle in standalone form, for empty-space skipping
// in a shadow march. It has no caller: the visible march reaches the same
// quantity through `cloudBaseFromMacro`, and the shadow map does not yet skip
// empty space. It is kept because that skipping needs this shape rather than the
// macro-sample one, and the shader compiler strips an uncalled function.
fn cloudBaseDensity(
  worldPos: vec3<f32>,
  heightFraction: f32,
  deckBottom: f32,
  deckTop: f32,
) -> f32 {
  if (!planetDensityEnabled() || !noiseBakedEnabled()) {
    return legacyCloudBaseDensity(
      worldPos, heightFraction, deckBottom, deckTop
    );
  }
  let windOffset = cloudWindOffset();
  let coordinates = cloudDensityCoordinatesAtWorld(worldPos, windOffset);
  let morphologyCoordinate =
    cloudMorphologyCoordinateAtWorld(worldPos, windOffset);
  let macroSample = cloudMacroSampleAt(
    worldPos, coordinates, morphologyCoordinate,
    heightFraction, deckBottom, deckTop, 0.0
  );
  return cloudBaseFromMacro(macroSample);
}

// Ray-sphere intersection, sphere centred at the planet origin.
// The naive form `c = dot(ro,ro) - radius*radius` subtracts two ~4e13 f32
// values, since camera and shell are both ~6.4e6 m from the planet centre, so
// the discriminant loses about seven significant digits and the cloud-layer
// silhouette reads as fuzzy and shimmering at grazing angles from altitude. This
// stable form builds the closest-approach (perpendicular) vector first and
// squares that, so dot(cp,cp) carries the small perpendicular distance without
// the big-number cancellation, and the roots come back as tClosest ± halfChord
// with no -b + sqrtD cancellation. It returns the same (near, far) pair as the
// naive form, computed more precisely.
//
// Reference: Haines et al., "Precision Improvements for Ray/Sphere
// Intersection", Ray Tracing Gems ch. 7.
//
// A residual remains: near-radial rays still need `radius - |ro|`, a ~1e3 m
// difference of two ~6.4e6 m magnitudes that f32 cannot fully resolve, and
// removing it needs double-precision emulation from a high/low camera split.
// That residual is about a metre and has not been observed as an artifact.
//
// This spherical form has no caller in this module: the visible march and the
// beer-shadow producer both intersect the oblate `rayEllipsoidIntersect` pair.
// It is kept as the numerically-stable primitive to reach for when a true sphere
// is the right model — the environment-capture march keeps its own copy,
// `cloudShellIntersect` in ProceduralSkyCubemap.wgsl, for that reason — and the
// shader compiler strips an uncalled function, so it costs nothing at runtime.
fn raySphereIntersect(ro: vec3<f32>, rd: vec3<f32>, radius: f32) -> vec2<f32> {
  let tClosest = -dot(ro, rd);
  let cp = ro + rd * tClosest; // closest point on the ray to the planet center
  let halfChordSq = radius * radius - dot(cp, cp);
  if (halfChordSq < 0.0) {
    return vec2<f32>(-1.0);
  }
  let halfChord = sqrt(halfChordSq);
  return vec2<f32>(tClosest - halfChord, tClosest + halfChord);
}

// Is the camera-relative high-precision march active? (qualityFlags bit 12).
// This is the automatic path; explicit cloudHighPrecision=false selects the
// closest-point f32 route instead.
fn highPrecisionEnabled() -> bool {
  return (u32(cloud.qualityFlags) & QF_HIGH_PRECISION) != 0u;
}

// WGS84 oblate shell helpers. A cloud boundary at height h is represented by
// axes (a+h, a+h, b+h). Treating the shell as an equatorial-radius sphere at
// every latitude instead puts a 20 km polar camera below the deck.
fn cloudShellAxes(height: f32) -> vec3<f32> {
  return vec3<f32>(
    cloud.planetRadius + height,
    cloud.planetRadius + height,
    cloud.planetPolarRadius + height,
  );
}

// Stable ray/ellipsoid intersection in scaled space. The returned roots remain in
// world metres because the scaled ray keeps the original t parameter.
fn rayEllipsoidIntersect(
  ro: vec3<f32>,
  rd: vec3<f32>,
  axes: vec3<f32>,
) -> vec2<f32> {
  let roScaled = ro / axes;
  let rdScaled = rd / axes;
  let a = max(dot(rdScaled, rdScaled), 1e-20);
  let tClosest = -dot(roScaled, rdScaled) / a;
  let closest = roScaled + rdScaled * tClosest;
  let halfChordSq = (1.0 - dot(closest, closest)) / a;
  if (halfChordSq < 0.0) {
    return vec2<f32>(-1.0);
  }
  let halfChord = sqrt(halfChordSq);
  return vec2<f32>(tClosest - halfChord, tClosest + halfChord);
}

// Camera-relative counterpart. Scale high and low independently, then cancel the
// large high component before applying the low refinement.
fn rayEllipsoidIntersectRTE(
  rd: vec3<f32>,
  centerHigh: vec3<f32>,
  centerLow: vec3<f32>,
  axes: vec3<f32>,
) -> vec2<f32> {
  let rdScaled = rd / axes;
  let centerHighScaled = centerHigh / axes;
  let centerLowScaled = centerLow / axes;
  let a = max(dot(rdScaled, rdScaled), 1e-20);
  let tClosest =
    (dot(rdScaled, centerHighScaled) + dot(rdScaled, centerLowScaled)) / a;
  let closest =
    (rdScaled * tClosest - centerHighScaled) - centerLowScaled;
  let halfChordSq = (1.0 - dot(closest, closest)) / a;
  if (halfChordSq < 0.0) {
    return vec2<f32>(-1.0);
  }
  let halfChord = sqrt(halfChordSq);
  return vec2<f32>(tClosest - halfChord, tClosest + halfChord);
}

// A normalized coordinate between the two oblate boundaries. It is exactly 0 at
// the inner ellipsoid and 1 at the outer ellipsoid, avoiding `length(p)-a` at
// every latitude without an iterative geodetic conversion in the hot loop.
fn ellipsoidShellHeightFraction(
  worldPos: vec3<f32>,
  innerInverseAxes: vec3<f32>,
  outerInverseAxes: vec3<f32>,
) -> f32 {
  let innerScaled = worldPos * innerInverseAxes;
  let outerScaled = worldPos * outerInverseAxes;
  // Squared implicit-surface residuals avoid two square roots per density tap.
  // Their ratio is monotonic through this thin shell and exact at both bounds.
  let fromInner = max(dot(innerScaled, innerScaled) - 1.0, 0.0);
  let toOuter = max(1.0 - dot(outerScaled, outerScaled), 0.0);
  return clamp(fromInner / max(fromInner + toOuter, 1e-7), 0.0, 1.0);
}

fn ellipsoidShellHeightFractionRTE(
  point: vec3<f32>,
  centerHigh: vec3<f32>,
  centerLow: vec3<f32>,
  innerInverseAxes: vec3<f32>,
  outerInverseAxes: vec3<f32>,
) -> f32 {
  // Form the relative-to-eye world point once, then use precomputed reciprocals.
  // This keeps the high-then-low cancellation order and keeps vector division
  // out of the inner density and light loops.
  let worldPos = (point - centerHigh) - centerLow;
  let innerScaled = worldPos * innerInverseAxes;
  let outerScaled = worldPos * outerInverseAxes;
  let fromInner = max(dot(innerScaled, innerScaled) - 1.0, 0.0);
  let toOuter = max(1.0 - dot(outerScaled, outerScaled), 0.0);
  return clamp(fromInner / max(fromInner + toOuter, 1e-7), 0.0, 1.0);
}

// Henyey-Greenstein phase function
fn hgPhase(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

// Dual-lobe phase function (forward and back scatter).
// Uniform-driven so the lobes are tunable and can be modulated by time of day.
// The forward lobe, phaseG1, is the silver lining toward the sun; the back lobe,
// phaseG2, fills the anti-sun side; phaseBlend mixes them.
fn cloudPhase(cosTheta: f32) -> f32 {
  // The forward lobe carries the per-genus ice/water eccentricity.
  let forward = hgPhase(cosTheta, genusForwardG());
  let back = hgPhase(cosTheta, cloud.phaseG2);
  return mix(back, forward, cloud.phaseBlend);
}

// Is the Schneider/Nubis cone-sampled light march active? (qualityFlags bit 10).
// The lower quality tiers set it; the cinematic full-resolution tier and the
// escape hatch leave it clear, so the straight march below runs instead.
fn lightConeEnabled() -> bool {
  return (u32(cloud.qualityFlags) & QF_LIGHT_CONE) != 0u;
}

// Fixed 6-tap cone kernel (Schneider, "Real-Time Volumetric Cloudscapes of
// Horizon Zero Dawn", SIGGRAPH 2015 / Nubis 2017). Five short taps march toward
// the sun, each pushed sideways by a unit offset so the sampled positions fan
// out into a cone; the cone captures more of the occluding cloud body — the
// parts that shadow the sample without lying on the exact sun ray — with far
// fewer taps than a dense straight march. The offsets are a small irregular set
// on the unit sphere, scaled per tap by an increasing radius and jittered per
// pixel in lightMarchCone so the sparse taps do not band. The sixth step is one
// long far tap, handled separately, using the cheap base-density oracle to fold
// in distant self-shadowing.
const CONE_KERNEL: array<vec3<f32>, 5> = array<vec3<f32>, 5>(
  vec3<f32>( 0.38051787,  0.92453268,  0.02111722),
  vec3<f32>( 0.35578787, -0.55155486, -0.75555583),
  vec3<f32>(-0.52047277,  0.05818154,  0.65454095),
  vec3<f32>( 0.11607481, -0.81293669,  0.51585301),
  vec3<f32>(-0.85181792, -0.15296098,  0.34155418)
);

// Per-pixel, per-frame cone jitter. It pairs with the half-res temporal
// accumulation: rotating the cone slightly each frame, on frameCounter, and per
// screen position decorrelates the sparse 5-tap pattern so the temporal resolve
// averages out the under-sampling instead of locking in a fixed bias. Returns a
// small vector used to perturb the kernel offsets.
fn coneJitter(pos: vec3<f32>) -> vec3<f32> {
  // frameCounter runs over 64 phases for the ray noise. Masking to its low 4
  // bits keeps the cone-light sequence on the 16 phases it was tuned against.
  let coneFrame = f32(u32(cloud.frameCounter) & 15u);
  let seed = pos * 0.013 + vec3<f32>(coneFrame * 0.61803399);
  return hash33(seed) - vec3<f32>(0.5);
}

// Schneider 6-tap cone light march. Sums optical depth from five short
// cone-offset taps of the full eroded density plus one long far tap of the cheap
// base-density oracle, toward the sun. It returns an optical depth in the same
// units as the straight march — density × marched length — so it feeds the same
// beer-powder, multi-scatter and Henyey-Greenstein lighting model unchanged, and
// only the sampling pattern differs. Six taps, five full and one cheap, against
// the straight march's `lightSteps` full taps per cone radius.
fn lightMarchCone(
  pos: vec3<f32>,
  heightFraction: f32,
  deckBottom: f32,
  deckTop: f32,
  densityCoordinates: CloudDensityCoordinates,
  morphologyCoordinate: vec3<f32>,
) -> f32 {
  let sunDir = normalize(cloud.sunDirection);
  let innerAxes = cloudShellAxes(deckBottom);
  let outerAxes = cloudShellAxes(deckTop);
  let innerInverseAxes = vec3<f32>(1.0) / innerAxes;
  let outerInverseAxes = vec3<f32>(1.0) / outerAxes;
  let layerThickness = deckTop - deckBottom;

  // Base step toward the sun. Where the straight march walks `steps` of
  // `layerThickness / steps`, the cone covers the same near-shadow span with five
  // geometrically-growing steps. lightSampleScale is the tier cost lever: the
  // lower tiers pass 0.5, giving a tighter cone.
  let coneStepBase = layerThickness * 0.16 * cloud.lightSampleScale;
  // Build a sun-aligned basis so the kernel's lateral component fans across the
  // sun ray (kernel.z rides along the sun direction; x/y spread the cone).
  var tangent = normalize(cross(sunDir, vec3<f32>(0.0, 0.0, 1.0)));
  if (!(dot(tangent, tangent) > 0.5)) {
    tangent = normalize(cross(sunDir, vec3<f32>(1.0, 0.0, 0.0)));
  }
  let bitangent = cross(sunDir, tangent);
  let jit = coneJitter(pos);

  var opticalDepth: f32 = 0.0;
  // Five short cone taps. Step distance and cone radius both grow with i, so the
  // taps sweep a widening cone toward the sun. Each reads the full density.
  for (var i: i32 = 0; i < 5; i = i + 1) {
    let fi = f32(i);
    let marchDist = coneStepBase * (fi + 1.0);
    let k = CONE_KERNEL[i] + jit * 0.4;          // per-pixel jittered offset
    let coneRadius = coneStepBase * (fi + 0.5);  // widening cone
    let lateral = (k.x * tangent + k.y * bitangent) * coneRadius;
    let sampleDelta = sunDir * marchDist + lateral;
    let samplePos = pos + sampleDelta;
    let hf = ellipsoidShellHeightFraction(
      samplePos, innerInverseAxes, outerInverseAxes
    );
    // Weight each tap by its marched extent so the summed optical depth is
    // dimensionally the same as the straight march's Σ density·stepSize.
    if (planetDensityEnabled() && noiseBakedEnabled()) {
      let sampleCoordinates =
        advanceDensityCoordinates(densityCoordinates, sampleDelta);
      let sampleMorphologyCoordinate =
        advanceCloudMorphologyCoordinate(morphologyCoordinate, sampleDelta);
      opticalDepth += cloudDensityAtCoordinates(
        samplePos,
        sampleCoordinates,
        sampleMorphologyCoordinate,
        hf,
        deckBottom,
        deckTop,
        coneStepBase,
      ) * coneStepBase;
    } else {
      opticalDepth += legacyCloudDensity(
        samplePos, hf, deckBottom, deckTop
      ) * coneStepBase;
    }
  }

  // One long far tap captures distant self-shadowing the short cone cannot
  // reach, using the cheap base-density oracle with no Worley or detail fetches.
  // The oracle is conservative — base >= full — so this slightly over-shadows
  // the far term, which reads as the intended soft far self-occlusion at a
  // fraction of a full tap's cost.
  let farDist = layerThickness * 1.5;
  let farDelta = sunDir * farDist;
  let farPos = pos + farDelta;
  let farHf = ellipsoidShellHeightFraction(
    farPos, innerInverseAxes, outerInverseAxes
  );
  if (planetDensityEnabled() && noiseBakedEnabled()) {
    let farCoordinates =
      advanceDensityCoordinates(densityCoordinates, farDelta);
    let farMorphologyCoordinate =
      advanceCloudMorphologyCoordinate(morphologyCoordinate, farDelta);
    let farMacro = cloudMacroSampleAt(
      farPos,
      farCoordinates,
      farMorphologyCoordinate,
      farHf,
      deckBottom,
      deckTop,
      coneStepBase * 3.0,
    );
    opticalDepth += cloudBaseFromMacro(farMacro) * coneStepBase * 3.0;
  } else {
    opticalDepth += legacyCloudBaseDensity(
      farPos, farHf, deckBottom, deckTop
    ) * coneStepBase * 3.0;
  }

  return opticalDepth;
}

// Light march: optical depth toward the sun.
// Dispatches to the cone path when QF_LIGHT_CONE is set, otherwise to the
// straight N-step march below.
fn lightMarch(
  pos: vec3<f32>,
  heightFraction: f32,
  deckBottom: f32,
  deckTop: f32,
  densityCoordinates: CloudDensityCoordinates,
  morphologyCoordinate: vec3<f32>,
) -> f32 {
  if (lightConeEnabled()) {
    return lightMarchCone(
      pos, heightFraction, deckBottom, deckTop,
      densityCoordinates, morphologyCoordinate
    );
  }
  let sunDir = normalize(cloud.sunDirection);
  // Scale the light-march step count by the tier's lightSampleScale: 1.0 leaves
  // it alone, and lower tiers march fewer, bigger steps for roughly the same
  // optical depth at lower cost. `lightSteps` multiplies the per-view-sample
  // cost, so this is the cheapest lever the low tiers have.
  let steps = max(1, i32(cloud.lightSteps * cloud.lightSampleScale));
  let innerAxes = cloudShellAxes(deckBottom);
  let outerAxes = cloudShellAxes(deckTop);
  let innerInverseAxes = vec3<f32>(1.0) / innerAxes;
  let outerInverseAxes = vec3<f32>(1.0) / outerAxes;
  let layerThickness = deckTop - deckBottom;

  // March toward sun through remaining cloud
  let stepSize = layerThickness / f32(steps);
  var opticalDepth: f32 = 0.0;
  let usePlanetDensity = planetDensityEnabled() && noiseBakedEnabled();
  var canonicalStep = vec3<f32>(0.0);
  var shapeStep = vec3<f32>(0.0);
  var warpStep = vec3<f32>(0.0);
  var detailStep = vec3<f32>(0.0);
  if (usePlanetDensity) {
    canonicalStep =
      sunDir * stepSize * CLOUD_DENSITY_WORLD_TO_NOISE;
    shapeStep =
      CLOUD_DENSITY_SHAPE_ROTATION *
      (canonicalStep * cloud.puffSize);
    warpStep =
      CLOUD_DENSITY_WARP_ROTATION *
      (
        canonicalStep *
        cloud.puffSize *
        CLOUD_DENSITY_WARP_RATIO
      );
    detailStep =
      CLOUD_DENSITY_DETAIL_ROTATION *
      (canonicalStep * CLOUD_DENSITY_DETAIL_RATIO);
  }

  for (var i: i32 = 0; i < steps; i++) {
    let stepMultiple = f32(i + 1);
    let sampleDelta = sunDir * stepMultiple * stepSize;
    let samplePos = pos + sampleDelta;
    let hf = ellipsoidShellHeightFraction(
      samplePos, innerInverseAxes, outerInverseAxes
    );
    if (usePlanetDensity) {
      let sampleCoordinates = CloudDensityCoordinates(
        densityCoordinates.canonical + canonicalStep * stepMultiple,
        wrapCloudDensityDomain(
          densityCoordinates.shape + shapeStep * stepMultiple
        ),
        wrapCloudDensityDomain(
          densityCoordinates.warp + warpStep * stepMultiple
        ),
        wrapCloudDensityDomain(
          densityCoordinates.detail + detailStep * stepMultiple
        ),
      );
      let sampleMorphologyCoordinate =
        morphologyCoordinate + canonicalStep * stepMultiple;
      opticalDepth += cloudDensityAtCoordinates(
        samplePos,
        sampleCoordinates,
        sampleMorphologyCoordinate,
        hf,
        deckBottom,
        deckTop,
        stepSize,
      ) * stepSize;
    } else {
      opticalDepth += legacyCloudDensity(
        samplePos, hf, deckBottom, deckTop
      ) * stepSize;
    }
  }

  return opticalDepth;
}

// Per-genus optical extinction coefficient. `cloud.absorptionCoeff` carries the
// scene-wide Beer-Lambert extinction and `profileExtinction`, float 103, scales
// it, normalized so CUMULUS is 1.0: denser genera such as cumulonimbus at ~1.58×
// absorb more and read as darker, more opaque cores, while thin genera such as
// cirrus at ~0.17× absorb less and read wispier. It is applied at every
// optical-density site — the light-march beer-powder term and the view-ray
// sample transmittance — so a genus is uniformly denser or thinner. A
// profileExtinction of 0 or below falls back to 1.0, so a stray zero-packed
// uniform cannot zero the absorption and make the clouds vanish, exp(0) being 1
// and therefore fully transparent.
fn effectiveAbsorption() -> f32 {
  let scale = select(1.0, cloud.profileExtinction, cloud.profileExtinction > 0.0);
  return cloud.absorptionCoeff * scale;
}

// Beer-powder approximation for cloud lighting
fn beerPowder(opticalDepth: f32, powder: f32) -> f32 {
  let absorb = effectiveAbsorption();
  let beer = exp(-opticalDepth * absorb);
  let powderEffect = 1.0 - exp(-opticalDepth * absorb * 2.0);
  return mix(beer, beer * powderEffect, powder);
}

// Cheap multi-octave multiple scattering, in the Schneider/Nubis and Frostbite
// art-directable form: sum N beer-powder octaves with geometric decay of
// scattering (a^i), extinction (b^i) and phase eccentricity (c^i), folding the
// dual-lobe phase in per octave. Deeper octaves are dimmer, less extinguished —
// so interiors keep a residual glow instead of going black under single-scatter
// Beer alone — and more isotropic as the phase peak relaxes, which is the soft
// lit-from-within look. The returned value already carries the phase, so the
// caller does not multiply by it again. Normalizing by the scattering sum means
// a thin cloud, where every octave is ≈ 1, returns ≈ the phase: this can only
// lift the dark deep-cloud tail, never over-brighten. `octaves` comes from
// qualityFlags bits 4-6.
fn multiScatterLight(opticalDepth: f32, cosTheta: f32, powder: f32, octaves: i32) -> f32 {
  let a = cloud.msDecayA; // contribution per octave (default 0.5)
  let b = cloud.msDecayB; // extinction per octave (default 0.5)
  let c = cloud.msDecayC; // eccentricity per octave (default 0.85, a gentle relax)
  let n = max(octaves, 1);
  // Per-genus extinction scale; CUMULUS is 1.0 and a zero is guarded to 1.0.
  let absorb = effectiveAbsorption();
  var luminance: f32 = 0.0;
  var total: f32 = 0.0;
  var scat: f32 = 1.0;
  var ext: f32 = 1.0;
  var ecc: f32 = 1.0;
  for (var i: i32 = 0; i < n; i = i + 1) {
    let beer = exp(-opticalDepth * absorb * ext);
    let powderEffect = 1.0 - exp(-opticalDepth * absorb * 2.0 * ext);
    let bp = mix(beer, beer * powderEffect, powder);
    let ph = mix(hgPhase(cosTheta, cloud.phaseG2 * ecc),
                 hgPhase(cosTheta, cloud.phaseG1 * ecc),
                 cloud.phaseBlend);
    luminance += scat * bp * ph;
    total += scat;
    scat = scat * a;
    ext = ext * b;
    ecc = ecc * c;
  }
  return luminance / max(total, 1e-6);
}

// Reconstruct a world-space ray from UV
fn getWorldRay(uv: vec2<f32>) -> vec3<f32> {
  let ndc = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
  var viewDir = cloud.inverseProjection * ndc;
  viewDir.w = 0.0;
  let worldDir = cloud.inverseView * viewDir;
  return normalize(worldDir.xyz);
}

// Reverse the renderer-wide logarithmic depth to a positive eye-space distance
// along the view ray, in metres. Byte-compatible with
// csm_reverseLogDepthToEyeDistance and
// AerialPerspective.wgsl::logDepthToEyeDistance.
fn logDepthToEyeDistance(logZ: f32, near: f32, far: f32) -> f32 {
  let log2FarDepthFromNearPlusOne = log2((far - near) + 1.0);
  let depthFromNear = exp2(logZ * log2FarDepthFromNearPlusOne) - 1.0;
  return depthFromNear + near;
}

// Atmosphere-LUT coupling helpers.
// These sample the same precomputed LUTs the SkyAtmosphere shader uses, with the
// identical (U, V) parameterization, so the cloud air light and ambient agree
// with the visible sky dome. The two sky-domain helpers are copies of
// SkyAtmosphere.wgsl::sampleSkyViewLut and sampleMultipleScatterLut; the
// transmittance helper mirrors AerialPerspective.wgsl::sampleTransmittance.

// Physical aerial: sun-relative sky-view single-scatter inscatter, the
// in-between air light. U = relativeAzimuth(view, sun) / π; V is the Hillaire
// horizon warp of cosViewZenith. `up` is the local vertical at the sample point.
fn cloudSampleSkyViewLut(up: vec3<f32>, rayDir: vec3<f32>, sunDir: vec3<f32>) -> vec3<f32> {
  let cosViewZenith = clamp(dot(rayDir, up), -1.0, 1.0);
  let vCoord = clamp(0.5 + 0.5 * sign(cosViewZenith) * sqrt(abs(cosViewZenith)), 0.0, 1.0);
  let viewHoriz = rayDir - up * cosViewZenith;
  let sunHoriz = sunDir - up * dot(sunDir, up);
  let vhLen = length(viewHoriz);
  let shLen = length(sunHoriz);
  var cosRelAzimuth: f32 = 1.0;
  if (vhLen > 1e-4 && shLen > 1e-4) {
    cosRelAzimuth = clamp(dot(viewHoriz, sunHoriz) / (vhLen * shLen), -1.0, 1.0);
  }
  let relAzimuth = acos(cosRelAzimuth); // [0, π]
  let uCoord = clamp(relAzimuth * (1.0 / PI), 0.0, 1.0);
  let s = textureSampleLevel(cloudSkyViewLut, cloudLutSampler, vec2<f32>(uCoord, vCoord), 0.0);
  return max(s.rgb, vec3<f32>(0.0));
}

// Sky-coupled ambient: sun-relative multiple-scattering sky radiance, over the
// same sun-relative sky-view domain as cloudSampleSkyViewLut. Sampling the up
// hemisphere gives the diffuse sky fill that lights cloud tops; the down
// hemisphere gives the ground-bounce fill for their bottoms.
fn cloudSampleMultipleScatterLut(up: vec3<f32>, rayDir: vec3<f32>, sunDir: vec3<f32>) -> vec3<f32> {
  let cosViewZenith = clamp(dot(rayDir, up), -1.0, 1.0);
  let vCoord = clamp(0.5 + 0.5 * sign(cosViewZenith) * sqrt(abs(cosViewZenith)), 0.0, 1.0);
  let viewHoriz = rayDir - up * cosViewZenith;
  let sunHoriz = sunDir - up * dot(sunDir, up);
  let vhLen = length(viewHoriz);
  let shLen = length(sunHoriz);
  var cosRelAzimuth: f32 = 1.0;
  if (vhLen > 1e-4 && shLen > 1e-4) {
    cosRelAzimuth = clamp(dot(viewHoriz, sunHoriz) / (vhLen * shLen), -1.0, 1.0);
  }
  let relAzimuth = acos(cosRelAzimuth); // [0, π]
  let uCoord = clamp(relAzimuth * (1.0 / PI), 0.0, 1.0);
  let s = textureSampleLevel(cloudMultipleScatterLut, cloudLutSampler, vec2<f32>(uCoord, vCoord), 0.0);
  return max(s.rgb, vec3<f32>(0.0));
}

// Bruneton transmittance LUT (altitude × cosZenith). Mirrors
// AerialPerspective.wgsl::sampleTransmittance: u = (cosZenith + 1) / 2,
// v = altitude / thickness. Returns the multiplicative extinction along the path
// to the top of the atmosphere from a point at `altitude` looking along
// `cosZenith`, the cosine of the angle to up.
fn cloudSampleTransmittance(altitude: f32, cosZenith: f32) -> vec3<f32> {
  let thickness = cloud.atmosphereThickness;
  let u = clamp(cosZenith * 0.5 + 0.5, 0.0, 1.0);
  let v = clamp(altitude / max(thickness, 1.0), 0.0, 1.0);
  return textureSampleLevel(cloudTransmittanceLut, cloudLutSampler, vec2<f32>(u, v), 0.0).rgb;
}

// Cheap luminance, used as the unbaked-LUT sentinel: an all-zero LUT reads ~0, so
// the physical and sky-LUT branches fall back to the constant path.
fn cloudLutLuminance(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// Per-deck march result. `hazed` is the LDR tone-mapped and aerial-hazed cloud
// color for this deck; `alpha` is 1 - transmittance, the deck's coverage. For a
// single shell the front-to-back composite over one deck reduces to
// `mix(sceneColor, hazed, alpha)`.
struct DeckResult {
  hazed: vec3<f32>,
  alpha: f32,
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
  // Per-sample reconstruction emission, present only in the emitting variant.
  // Register footprint is a static property of the module, so these two
  // accumulators and every line that touches them are deleted by the
  // preprocessor for the full-resolution march, the shadow map, the cascade
  // atlas and the god-ray mask, none of which read them.
  //
  //   frontDistance       nearest sample distance that actually contributed
  //                       extinction, metres; -1 when the deck contributed
  //                       nothing. This is the channel a mean depth cannot
  //                       provide for separated overlapping volumes.
  //   weightedDistanceSum Σ wᵢ·tᵢ over this deck's own transmittance weights,
  //                       where wᵢ = (1 - exp(-σᵢ·Δ)) · Tᵢ is the weight the
  //                       radiance accumulation already uses. Their sum is the
  //                       deck's alpha by construction, so the
  //                       transmittance-weighted mean distance is this divided
  //                       by `alpha` — an accumulation rather than an estimate
  //                       from an assumed uniform extinction.
  frontDistance: f32,
  weightedDistanceSum: f32,
//>>endif
};

// March one cloud shell [deckBottom, deckTop] along the view ray and return its
// tone-mapped, aerial-hazed color and alpha. The scene composite is the caller's,
// since it differs between the single shell and the front-to-back stack.
// `marchSamplePhase` of 0.5 samples interval midpoints; the jitter tier supplies
// a spatial or temporal phase instead. A ray that misses the shell, or whose
// layer is fully occluded by depth, returns alpha 0 and contributes nothing to
// the composite.
fn marchDeck(
  rayOrigin: vec3<f32>,
  rayDir: vec3<f32>,
  sceneDepth: f32,
  deckBottom: f32,
  deckTop: f32,
  msOctaves: i32,
  centerHigh: vec3<f32>,
  centerLow: vec3<f32>,
  marchSamplePhase: f32,
) -> DeckResult {
  var result: DeckResult;
  result.hazed = vec3<f32>(0.0);
  result.alpha = 0.0;
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
  // -1 is the contract's "no cloud on this ray" sentinel, and it must survive
  // every early return below (shell miss, depth occlusion, degenerate interval)
  // rather than reading as distance zero.
  result.frontDistance = -1.0;
  result.weightedDistanceSum = 0.0;
//>>endif

  // Cloud shells follow WGS84's oblate figure rather than using the equatorial
  // radius as a sphere at every latitude.
  let innerAxes = cloudShellAxes(deckBottom);
  let outerAxes = cloudShellAxes(deckTop);
  let innerInverseAxes = vec3<f32>(1.0) / innerAxes;
  let outerInverseAxes = vec3<f32>(1.0) / outerAxes;

  // Intersect the ray with the two oblate shell boundaries. The high-precision
  // branch works camera-relative from a high/low centre; the other branch works
  // in world coordinates. Both use the same WGS84 geometry.
  var tInner: vec2<f32>;
  var tOuter: vec2<f32>;
  if (highPrecisionEnabled()) {
    tInner = rayEllipsoidIntersectRTE(rayDir, centerHigh, centerLow, innerAxes);
    tOuter = rayEllipsoidIntersectRTE(rayDir, centerHigh, centerLow, outerAxes);
  } else {
    tInner = rayEllipsoidIntersect(rayOrigin, rayDir, innerAxes);
    tOuter = rayEllipsoidIntersect(rayOrigin, rayDir, outerAxes);
  }

  // No intersection with the shell — transparent (no contribution).
  if (tOuter.x < 0.0 && tOuter.y < 0.0) {
    return result;
  }

  // The CPU already has the f64 WGS84 Cartographic height. Reusing it avoids a
  // per-deck GPU conversion, and avoids the polar misclassification a spherical
  // `length(p) - planetRadius` height would produce.
  let cameraAltitude = cloud.cameraGeodeticHeight;
  var tStart: f32;
  var tEnd: f32;

  if (cameraAltitude < deckBottom) {
    // Below clouds: start at inner sphere, end at outer
    tStart = max(tInner.y, 0.0);
    tEnd = tOuter.y;
  } else if (cameraAltitude > deckTop) {
    // Above clouds: start at outer sphere front, end at inner
    tStart = max(tOuter.x, 0.0);
    tEnd = tInner.x;
  } else {
    // Inside cloud layer
    tStart = 0.0;
    tEnd = tOuter.y;
  }

  // Depth occlusion. Stop the march at opaque scene geometry — globe, terrain,
  // tiles — so clouds do not render through the Earth. `sceneDepth` is the
  // renderer-wide log depth; reversing it gives an along-ray eye distance to
  // clamp tEnd against. Sky pixels carry the cleared far depth, so tSceneHit is
  // ≈ far, no clamp applies and the full sky shell still marches. If terrain
  // sits in front of the whole layer, tEnd clamps below tStart and the early-out
  // below returns transparent. Nothing writes depth: clouds are a translucent
  // over-composite.
  if (sceneDepth < 0.999999) {
    let tSceneHit = logDepthToEyeDistance(sceneDepth, cloud.nearPlane, cloud.farPlane);
    tEnd = min(tEnd, tSceneHit);
  }

  // Far cap. Stop the march past a distance where the cloud shell subtends a
  // fraction of a pixel, since those samples cost full march budget for
  // sub-pixel return. At 0 the guard is false and tEnd is untouched.
  if (cloud.maxRayDistance > 0.0) {
    tEnd = min(tEnd, cloud.maxRayDistance);
  }

  if (tStart >= tEnd || tEnd <= 0.0) {
    return result; // transparent (this deck contributes nothing)
  }

  // Cloud march
  let steps = i32(cloud.maxSteps);
  let sunDir = normalize(cloud.sunDirection);
  let cosTheta = dot(rayDir, sunDir);
  let layerThickness = deckTop - deckBottom;

  // Adaptive coarse-to-fine march with empty-space skipping. The skip oracle is
  // a cheap, smooth, conservative low-detail density — the base shape, with no
  // Worley and no detail fetch: coarse jumps probe only that through empty
  // space; on the first base hit the march backs up one coarse step and refines
  // to steps four times smaller; it snaps back to coarse only once the base
  // shape is gone. Driving the skip from the full density instead truncates
  // clouds, because an erosion pocket has zero full density while the cloud
  // continues through it. Fine samples integrate the full eroded density on the
  // same grid a fixed march would use — fineStep is that march's step size, and
  // the back-up keeps the fine grid aligned to tStart + k·fineStep — so the
  // image is the fixed march's, with cheap base taps replacing full taps over
  // empty space at a quarter of the count. `maxSteps` governs the fine budget.
  let fineStep = (tEnd - tStart) / f32(steps);
  // The coarse step is derived per iteration as curCoarseStep, so the geometric
  // step growth scales the coarse skip and the fine cadence together. At
  // marchStepGrowth 1.0, curCoarseStep is exactly fineStep * 4.0.

  var transmittance: f32 = 1.0;
  var lightEnergy: f32 = 0.0;
  var weightedColor = vec3<f32>(0.0);
  var totalDensity: f32 = 0.0;

  var t: f32 = tStart;
  var tProcessed: f32 = tStart; // furthest point already examined at fine resolution
  var fine: bool = false;
  var emptyRun: i32 = 0;
  var guard: i32 = 0;
  let maxIter: i32 = steps * 3; // permanent loop sentinel (coarse skips + fine)
  let windOffset = cloudWindOffset();
  let usePlanetDensity = planetDensityEnabled() && noiseBakedEnabled();
  // The camera-relative density coordinate is affine along this view ray.
  // Transform each per-metre increment once per pixel, rather than paying three
  // mat3 multiplies on every (often empty) march probe.
  let rayNoisePerMeter = rayDir * CLOUD_DENSITY_WORLD_TO_NOISE;
  var shapeRayPhasePerMeter = vec3<f32>(0.0);
  var warpRayPhasePerMeter = vec3<f32>(0.0);
  var detailRayPhasePerMeter = vec3<f32>(0.0);
  if (usePlanetDensity && highPrecisionEnabled()) {
    shapeRayPhasePerMeter =
      CLOUD_DENSITY_SHAPE_ROTATION *
      (rayNoisePerMeter * cloud.puffSize);
    warpRayPhasePerMeter =
      CLOUD_DENSITY_WARP_ROTATION *
      (
        rayNoisePerMeter *
        cloud.puffSize *
        CLOUD_DENSITY_WARP_RATIO
      );
    detailRayPhasePerMeter =
      CLOUD_DENSITY_DETAIL_ROTATION *
      (rayNoisePerMeter * CLOUD_DENSITY_DETAIL_RATIO);
  }

  loop {
    if (t >= tEnd) { break; }
    if (transmittance < 0.01) { break; }
    guard = guard + 1;
    if (guard > maxIter) { break; }

    // Geometric in-march step growth. A fixed sampling comb pays full detail
    // cost for far shell samples that subtend one or two pixels, so the step
    // grows geometrically with distance from the layer entry: near samples stay
    // crisp and far samples coarsen. `pow(growth, k)` with k the number of fine
    // steps travelled is stateless and exact. At marchStepGrowth 1.0 the guard
    // is false, the pow is never evaluated and curFineStep equals fineStep.
    // Growth only advances t faster, so it strictly reduces the iteration count
    // and cannot trip the maxIter sentinel.
    //
    // Reference: Shota Matsuda, Takram — `@takram/three-clouds` in
    // three-geospatial (MIT),
    // https://github.com/takram-design-engineering/three-geospatial — the
    // perspective step-growth and far ray-distance cap that this pair of dials
    // follows. Their march accumulates the scale per iteration
    // (`stepSize *= perspectiveStepScale`); the closed-form `pow` used here is
    // ours, chosen so the comb stays stateless and exactly reproducible from t.
    // Technique only — no source was copied.
    var curFineStep = fineStep;
    if (cloud.marchStepGrowth > 1.0) {
      curFineStep = fineStep * pow(cloud.marchStepGrowth, (t - tStart) / max(fineStep, 1.0));
    }
    let curCoarseStep = curFineStep * 4.0;

    let curStep = select(curCoarseStep, curFineStep, fine);
    // The sample phase shifts only the sample within the current interval. `t`,
    // `tProcessed`, the coarse backtracking and the interval bounds are
    // untouched, and the base and full density share this exact position.
    let sampleDistance = t + marchSamplePhase * curStep;
    let sampleOffset = rayDir * sampleDistance;
    let samplePos = rayOrigin + sampleOffset;
    // Resolve the vertical profile against the same oblate boundaries used for
    // intersection. The world-space noise domain remains unchanged.
    var heightFraction: f32;
    if (highPrecisionEnabled()) {
      heightFraction = ellipsoidShellHeightFractionRTE(
        sampleOffset, centerHigh, centerLow,
        innerInverseAxes, outerInverseAxes
      );
    } else {
      heightFraction = ellipsoidShellHeightFraction(
        samplePos, innerInverseAxes, outerInverseAxes
      );
    }

    // Only the baked planet domain takes the single-evaluation macro route. The
    // live-noise and bit-13-off baked routes run the standalone functions above,
    // which is what makes them a same-build functionality oracle rather than
    // just a coordinate toggle.
    var densityCoordinates = CloudDensityCoordinates(
      vec3<f32>(0.0),
      vec3<f32>(0.0),
      vec3<f32>(0.0),
      vec3<f32>(0.0),
    );
    var morphologyCoordinate = vec3<f32>(0.0);
    var macroSample = CloudMacroSample(
      0.0,
      0.0,
      densityCoordinates,
      morphologyCoordinate,
      0.0,
    );
    var base: f32;
    if (usePlanetDensity) {
      if (highPrecisionEnabled()) {
        let relativeNoise = rayNoisePerMeter * sampleDistance;
        densityCoordinates = CloudDensityCoordinates(
          relativeNoise,
          wrapCloudDensityDomain(
            cloud.densityShapeOriginPhase +
            shapeRayPhasePerMeter * sampleDistance
          ),
          wrapCloudDensityDomain(
            cloud.densityWarpOriginPhase +
            warpRayPhasePerMeter * sampleDistance
          ),
          vec3<f32>(0.0),
        );
        morphologyCoordinate =
          cloud.densityMorphologyOriginHigh +
          (cloud.densityMorphologyOriginLow + relativeNoise);
      } else {
        densityCoordinates =
          cloudDensityCoordinatesAtWorld(samplePos, windOffset);
        morphologyCoordinate =
          cloudMorphologyCoordinateAtWorld(samplePos, windOffset);
      }
      macroSample = cloudMacroSampleAt(
        samplePos,
        densityCoordinates,
        morphologyCoordinate,
        heightFraction,
        deckBottom,
        deckTop,
        curFineStep,
      );
      base = cloudBaseFromMacro(macroSample);
    } else {
      base = legacyCloudBaseDensity(
        samplePos, heightFraction, deckBottom, deckTop
      );
    }

    if (!fine) {
      // Coarse skip. On the first base hit, step back one coarse step (clamped to
      // tStart so the near cloud edge isn't read before the layer) and refine.
      if (base > 0.0001) {
        fine = true;
        emptyRun = 0;
        // Back up one coarse step to catch the cloud edge the coarse sample
        // stepped over — but never below tProcessed, so the march can't stall by
        // re-entering an already-examined span (the cause of early-out + empty).
        t = max(t - curCoarseStep, tProcessed);
        continue;
      }
      t = t + curCoarseStep;
      continue;
    }

    // Fine phase. Snap back to coarse only once the base shape has been gone for
    // two consecutive samples. Base density is smooth, so that fires on leaving
    // the cloud rather than inside an erosion pocket, where base is above 0 and
    // the full density is 0.
    if (base <= 0.0001) {
      emptyRun = emptyRun + 1;
      if (emptyRun >= 2) { // base is reliable, so no longer confirmation is needed
        fine = false;
        emptyRun = 0;
      }
      t = t + curFineStep;
      tProcessed = t;
      continue;
    }
    emptyRun = 0;

    // Inside the cloud shape — integrate the full eroded density. An erosion
    // pocket, where that is 0, contributes nothing but stays in the fine phase.
    var density: f32;
    if (usePlanetDensity) {
      // The coarse/base probe never reads erosion detail. Materialize the third
      // rotated domain only after the base oracle confirms an occupied fine
      // sample; the per-ray transformed increment was already computed above.
      if (highPrecisionEnabled()) {
        let detailCoordinate = wrapCloudDensityDomain(
          cloud.densityDetailOriginPhase +
          detailRayPhasePerMeter * sampleDistance
        );
        densityCoordinates.detail = detailCoordinate;
        macroSample.coordinates.detail = detailCoordinate;
      }
      density = cloudDensityFromMacro(macroSample, heightFraction);
    } else {
      density = legacyCloudDensity(
        samplePos, heightFraction, deckBottom, deckTop
      );
    }
    if (density > 0.001) {
      // Light contribution. The multi-scatter octaves fold the phase in per
      // octave, so the returned value already carries it.
      let lightOpticalDepth = lightMarch(
        samplePos,
        heightFraction,
        deckBottom,
        deckTop,
        densityCoordinates,
        morphologyCoordinate,
      );
      let msLight = multiScatterLight(lightOpticalDepth, cosTheta, 0.5, msOctaves);

      // Silver lining: enhanced scattering at cloud edges
      let silverLining = cloud.silverLiningIntensity
                       * pow(clamp(1.0 - density * 3.0, 0.0, 1.0), 2.0);

      let scatteredLight = (msLight + silverLining) * cloud.sunIntensity;

      // Height-based color gradient (darker base, brighter top)
      let cloudColor = mix(cloud.cloudBaseColor, cloud.cloudTopColor, heightFraction);

      // Accumulate. The view-ray extinction carries the same per-genus
      // profileExtinction the light march uses, so a genus that absorbs more is
      // also more opaque along the view ray: denser genera read consistently
      // darker and more opaque, thin genera wispier.
      let sampleTransmittance = exp(-density * curFineStep * effectiveAbsorption());
      let sampleWeight = (1.0 - sampleTransmittance) * transmittance;
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
      // Accumulate the reconstruction depth from the weight the radiance uses,
      // at the same sample position. Nothing here re-derives a distance or
      // re-samples the density: the emission is a running sum over work the
      // march already did, which is why the added cost is two fused multiply-adds
      // and a compare rather than another traversal.
      if (result.frontDistance < 0.0) {
        result.frontDistance = sampleDistance;
      }
      result.weightedDistanceSum =
        result.weightedDistanceSum + sampleWeight * sampleDistance;
//>>endif

      // Sky-ambient gradient and ground bounce. The blue sky lights the cloud
      // tops, at heightFraction 1, and the warm ground bounce lights the bottoms,
      // at 0, so the anti-sun shadow side reads as soft grey-blue instead of
      // near-black. It is part of the HDR radiance, so it tone-maps with the sun
      // term.
      //
      // When `ambientLutMode` is set and the multiple-scattering sky LUT is
      // baked, the constant blue/grey lerp is replaced by real time-of-day sky
      // radiance: the LUT is sampled in the up hemisphere for the sky fill on
      // cloud tops and in the down hemisphere for the ground bounce on their
      // bottoms, then lerped by heightFraction as the constant path does. It
      // falls back to the constant lerp when the LUT reads ~0.
      var skyAmbColor = cloud.skyAmbientColor;
      var groundAmbColor = cloud.groundAmbientColor;
      if ((u32(cloud.qualityFlags) & QF_AMBIENT_LUT) != 0u) {
        let localUp = normalize(samplePos);
        // Total sky radiance in each hemisphere is the sun-relative
        // single-scatter sky-view term plus the multiple-scattering residual,
        // which share a sky-view domain. The single-scatter term carries the
        // warm sunset and cool noon color; multiple scattering adds the diffuse
        // fill. The up hemisphere lights the cloud tops, down the bottoms.
        let skyHDR =
          cloudSampleSkyViewLut(localUp, localUp, sunDir)
          + cloudSampleMultipleScatterLut(localUp, localUp, sunDir);
        let skyLum = cloudLutLuminance(skyHDR);
        if (skyLum > 1e-5) {
          let groundHDR =
            cloudSampleSkyViewLut(localUp, -localUp, sunDir)
            + cloudSampleMultipleScatterLut(localUp, -localUp, sunDir);
          let groundLum = max(cloudLutLuminance(groundHDR), 1e-5);
          // Replace only the ambient hue and chroma with the real sky's, keeping
          // each constant ambient's nominal brightness, so `ambientIntensity`
          // remains the magnitude knob and the energy cannot blow out while the
          // tint tracks the true time-of-day sky: warm undersides at sunset,
          // blue at noon.
          skyAmbColor = (skyHDR / skyLum) * cloudLutLuminance(cloud.skyAmbientColor);
          groundAmbColor = (groundHDR / groundLum) * cloudLutLuminance(cloud.groundAmbientColor);
        }
      }
      let ambient = mix(groundAmbColor, skyAmbColor, heightFraction)
                  * cloud.ambientIntensity;

      // Tint the direct-sun term by the time-of-day sun color, warm near the
      // horizon and neutral at noon; the ambient keeps its own sky and ground
      // color. The noctilucent and nacreous iridescent tint then reshades the
      // whole sample radiance, direct sun and ambient together, rather than the
      // albedo alone — a multiplicative albedo tint is overwhelmed by the
      // additive ambient and silver-lining terms, so it would have no authority
      // over the sample color. With the mode off, specialShadeTint() returns
      // vec3(1.0). The comparison route uses the unadvected samplePos
      // coordinate; the planet-anchored route uses its stable encoded morphology
      // origin, never a wrapped or rotated texture domain.
      var specialShadeCoordinate = samplePos * 0.0003;
      if (usePlanetDensity) {
        specialShadeCoordinate = morphologyCoordinate;
      }
      let specialTint = specialShadeTint(
        specialShadeCoordinate,
        heightFraction,
        cosTheta
      );
      weightedColor += (cloudColor * cloud.sunLightColor * scatteredLight + ambient)
                     * specialTint * sampleWeight;
      lightEnergy += scatteredLight * sampleWeight;
      totalDensity += density * curFineStep;
      transmittance *= sampleTransmittance;
    }

    t = t + curFineStep;
    tProcessed = t;
  }

  // HDR tone-map the accumulated cloud radiance before compositing. The
  // dual-lobe phase peaks around 6× at the forward lobe and is multiplied by a
  // sun intensity of ~10, so the radiance peaks around 20-30 and clips every
  // cloud to flat white without this, hiding the silver lining along with the
  // ambient, time-of-day and aerial terms. Exposure plus Reinhard maps it to
  // [0,1), so the bright sun-facing edges read as a rim over a darker body.
  let exposed = weightedColor * cloud.exposure;
  let toneMapped = exposed / (exposed + vec3<f32>(1.0));

  // Aerial perspective. Distant clouds lose contrast and tint toward the
  // atmosphere inscatter color; without it far clouds keep their full white and
  // stand out against the hazed horizon. The haze is keyed on the march midpoint
  // distance, tStart + 0.5·(tEnd - tStart), rather than on tStart: from below the
  // layer tStart collapses to ~0 for every pixel, so keying on it hazes by view
  // angle rather than by true range. Both operands are LDR — the post-tonemap
  // color against the packed horizon tint — so the lerp stays in display space.
  // 60 km is roughly the horizon haze scale; the 0.85 cap keeps the densest near
  // clouds from fully dissolving.
  let midDist = tStart + 0.5 * (tEnd - tStart);
  let aerial = clamp(midDist / 60000.0 * cloud.aerialStrength, 0.0, 0.85);
  // Heuristic haze, the path taken when `aerialLutMode` is 'heuristic'.
  var hazed = mix(toneMapped, cloud.aerialColor, aerial);

  // Physical aerial perspective. When `aerialLutMode` is set and the atmosphere
  // LUTs are baked, the flat-tint lerp is replaced by an inscatter and
  // transmittance lookup at the march midpoint:
  //   - transmittance(midpoint altitude, view cosZenith) attenuates the cloud
  //     color toward the horizon, so distant clouds dim and redden,
  //   - the sun-relative sky-view inscatter LUT adds the in-between air light,
  //     warm toward a low sun and cooler away, scaled by the same midpoint-range
  //     fraction the heuristic uses, so the near deck stays crisp and the far
  //     deck dissolves into the true sky color.
  // Falls back to the heuristic `hazed` when the sky-view LUT reads ~0.
  if ((u32(cloud.qualityFlags) & QF_AERIAL_LUT) != 0u) {
    let midPos = rayOrigin + rayDir * midDist;
    let midUp = normalize(midPos);
    let inscatterHDR = cloudSampleSkyViewLut(midUp, rayDir, sunDir);
    if (cloudLutLuminance(inscatterHDR) > 1e-5) {
      // Resolve the midpoint against the same oblate boundaries as the march. Keep
      // `midPos` in the world domain for the atmosphere LUT's direction lookup.
      var midHeightFraction: f32;
      if (highPrecisionEnabled()) {
        midHeightFraction = ellipsoidShellHeightFractionRTE(
          rayDir * midDist, centerHigh, centerLow,
          innerInverseAxes, outerInverseAxes
        );
      } else {
        midHeightFraction = ellipsoidShellHeightFraction(
          midPos, innerInverseAxes, outerInverseAxes
        );
      }
      let midAltitude =
        deckBottom + midHeightFraction * (deckTop - deckBottom);
      let midCosZenith = dot(rayDir, midUp);
      let trans = cloudSampleTransmittance(max(midAltitude, 0.0), midCosZenith);
      // The sky-view LUT radiance is in the pre-tonemap HDR space the sky dome
      // uses, since SkyAtmosphere tone-maps after sampling. `toneMapped` is
      // already LDR, so the inscatter is brought into the same display space
      // with the same Reinhard and exposure operator before compositing;
      // otherwise the HDR air light blows the far clouds to white. Hue ratios
      // survive Reinhard, so the warm-toward-sun and cool-away directionality
      // that motivates the term is preserved.
      let inscatterExposed = inscatterHDR * cloud.exposure;
      let inscatterLDR = inscatterExposed / (inscatterExposed + vec3<f32>(1.0));
      // Energy-correct aerial perspective: the air light fills exactly the
      // fraction of cloud radiance lost to extinction, avgTrans, so the far
      // target is a convex blend of attenuated cloud and sky air light, bounded
      // in [0,1] and never a white-out. `aerial`, the same 0..0.85
      // midpoint-range fraction the heuristic uses, ramps from crisp near cloud
      // to fully-fogged far cloud.
      let avgTrans = (trans.r + trans.g + trans.b) / 3.0;
      let farTarget = toneMapped * trans + inscatterLDR * (1.0 - avgTrans);
      hazed = mix(toneMapped, farTarget, aerial);
    }
  }

  result.hazed = hazed;
  result.alpha = 1.0 - transmittance;
  return result;
}

// Is the multi-deck shell march active? (qualityFlags bit 11). When clear, which
// is the default, fragmentMain marches exactly one shell from
// cloud.cloudLayerBottom/Top and composites it over the scene directly.
fn multiDeckEnabled() -> bool {
  return (u32(cloud.qualityFlags) & QF_MULTI_DECK) != 0u;
}

//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
// The emitting march's multiple render targets. `@location(0)` carries exactly
// what the single-output `fragmentMain` writes; `@location(1)` is the `depth`
// attachment, slot 1, rg32float, written by the march itself rather than
// estimated afterwards. The estimating producer cannot write it in the same pass
// it reads it from, so ownership moves here rather than being duplicated.
struct CloudMarchOutput {
  @location(0) color: vec4<f32>,
  // R = front (nearest contributing) distance, G = transmittance-weighted mean
  // distance, both metres; (-1, -1) when the ray carries no cloud.
  @location(1) depth: vec2<f32>,
};

// Resolve one deck's emission into the attachment's (front, weighted) pair.
// `Σwᵢ = α` by construction, so the division is the exact weighted mean of the
// marched sample distances; the floor only keeps a zero-alpha deck, already
// screened by the sentinel, from dividing by zero.
fn deckReconstructionDepth(result: DeckResult) -> vec2<f32> {
  if (result.frontDistance < 0.0 || result.alpha <= 0.0) {
    return vec2<f32>(-1.0, -1.0);
  }
  return vec2<f32>(
    result.frontDistance,
    result.weightedDistanceSum / max(result.alpha, CLOUD_EMIT_MIN_ALPHA)
  );
}

// Alpha floor for the emission division. Well below the `transmittance < 0.01`
// early-out and below any alpha that survives `density > 0.001`, so it never
// participates in a value the attachment publishes — it exists so a deck that
// set `frontDistance` and then had its weight cancel cannot produce a NaN.
const CLOUD_EMIT_MIN_ALPHA: f32 = 1.0e-6;
//>>endif

@fragment
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
fn fragmentMain(input: VertexOutput) -> CloudMarchOutput {
//>>else
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
//>>endif
  // Half-res jitter. In the half-res path each output texel covers a 2×2
  // full-res block, so the marched ray is offset within that texel by a
  // per-frame Bayer pattern: consecutive frames, and neighbouring half-res
  // texels through the bilateral upscale, sample different sub-pixel positions
  // and the under-sampling decorrelates. `cloud.resolution` is the half-res
  // target size here, so one texel is (1/halfW, 1/halfH) in UV and the Bayer
  // offset stays within ±0.5 texel. The full-res path takes no sub-pixel UV
  // jitter — resolution is the full canvas and the bit is clear — so `uv` stays
  // `input.uv`; its separate ray sample phase is resolved below.
  var uv = input.uv;
  if (halfResEnabled()) {
    let bIndex = u32(cloud.frameCounter) & 15u;
    let bx = BAYER4[bIndex] - 0.5;            // -0.5..+0.46875 within the texel
    let by = BAYER4[(bIndex + 5u) & 15u] - 0.5; // decorrelated second axis
    let texel = vec2<f32>(1.0, 1.0) / max(cloud.resolution, vec2<f32>(1.0));
    uv = uv + vec2<f32>(bx, by) * texel;
  }
  let sceneColor = textureSample(colorTex, texSampler, uv);
  let sceneDepth = textureSampleLevel(depthTex, texSampler, uv, 0.0).r;

  let rayOrigin = cloud.cameraPosition;
  let rayDir = getWorldRay(uv);
  // One per-fragment phase is shared by every visible deck so multi-deck
  // compositing cannot introduce inter-deck sampling shimmer.
  let marchSamplePhase = cloudRaySamplePhase(input.position.xy);

  // The planet centre relative to the camera is -cameraWorldPos, supplied as a
  // high/low split so `marchDeck`'s high-precision branch can subtract the large
  // term before the small refinement. Forming it is one negate, so it is done
  // unconditionally; `marchDeck` reads it only when the bit is set.
  let centerHigh = -cloud.encodedCameraHigh;
  let centerLow = -cloud.encodedCameraLow;

  // Multi-scatter octave count, from qualityFlags bits 4-6: the lowest tier
  // passes 2 and the rest 3. The dual-lobe phase is folded in per octave inside
  // multiScatterLight, so the march does not apply it separately.
  let msOctaves = i32((u32(cloud.qualityFlags) >> QF_OCTAVES_SHIFT) & 7u);

  if (!multiDeckEnabled()) {
    // Single-shell topology: march one shell with the primary layer bounds, then
    // composite it over the scene.
    let r = marchDeck(
      rayOrigin, rayDir, sceneDepth,
      cloud.cloudLayerBottom, cloud.cloudLayerTop, msOctaves,
      centerHigh, centerLow,
      marchSamplePhase,
    );
    let cloudAlpha = r.alpha;
    let hazed = r.hazed;

    // Half-res path: emit premultiplied cloud radiance and alpha.
    if (halfResEnabled()) {
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
      return CloudMarchOutput(
        vec4<f32>(hazed * cloudAlpha, cloudAlpha),
        deckReconstructionDepth(r)
      );
//>>else
      return vec4<f32>(hazed * cloudAlpha, cloudAlpha);
//>>endif
    }
    // Full-res path — composite the cloud over the scene here.
    let finalColor = mix(sceneColor.rgb, hazed, cloudAlpha);
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
    return CloudMarchOutput(
      vec4<f32>(finalColor, sceneColor.a),
      deckReconstructionDepth(r)
    );
//>>else
    return vec4<f32>(finalColor, sceneColor.a);
//>>endif
  }

  // Multi-deck path: march up to three shells — low, mid, high — and composite
  // front-to-back with premultiplied alpha so the near deck occludes the far one
  // and a low cumulus layer reads beneath a high cirrus veil. The decks are
  // ordered by their mean altitude relative to the camera height, front being
  // closest to the camera's vertical position, so the ordering holds whether the
  // camera is below all decks and looking up (low first), between them, or above
  // and looking down (high first). Front-to-back accumulation with an opaque
  // early terminate keeps the worst case at three marches, and the common case —
  // a clear far deck, or full near coverage — much cheaper. Each deck also
  // early-outs inside marchDeck when the shell is missed or fully thin, alpha 0
  // contributing nothing.
  // The CPU-f64 WGS84 Cartographic height is the stable multi-deck sort key.
  let camAlt = cloud.cameraGeodeticHeight;
  let midLow = 0.5 * (cloud.deckBoundsLow.x + cloud.deckBoundsLow.y);
  let midMid = 0.5 * (cloud.deckBoundsMid.x + cloud.deckBoundsMid.y);
  let midHigh = 0.5 * (cloud.deckBoundsHigh.x + cloud.deckBoundsHigh.y);

  // Distance of each deck's mid-altitude from the camera altitude = front-to-back
  // sort key: smaller is nearer the camera's vertical band, so composited first.
  let dLow = abs(camAlt - midLow);
  let dMid = abs(camAlt - midMid);
  let dHigh = abs(camAlt - midHigh);

  // Bounds and sort keys packed per deck, so ordering needs no dynamic array of
  // structs. Index 0 is low, 1 mid, 2 high.
  var bottoms = array<f32, 3>(cloud.deckBoundsLow.x, cloud.deckBoundsMid.x, cloud.deckBoundsHigh.x);
  var tops = array<f32, 3>(cloud.deckBoundsLow.y, cloud.deckBoundsMid.y, cloud.deckBoundsHigh.y);
  var keys = array<f32, 3>(dLow, dMid, dHigh);
  // Insertion-sort order[] by key ascending, front-to-back; three elements.
  var order = array<i32, 3>(0, 1, 2);
  for (var i: i32 = 1; i < 3; i = i + 1) {
    let oi = order[i];
    let ki = keys[oi];
    var j: i32 = i - 1;
    loop {
      if (j < 0) { break; }
      if (keys[order[j]] <= ki) { break; }
      order[j + 1] = order[j];
      j = j - 1;
    }
    order[j + 1] = oi;
  }

  // Front-to-back premultiplied accumulation: C = Σ Tᵢ·αᵢ·colorᵢ, A = Σ Tᵢ·αᵢ,
  // with running transmittance T *= (1 - αᵢ). Premultiplied so a far deck seen
  // through a partly-covered near deck is attenuated by exactly (1 - nearAlpha),
  // leaving no double-darkening seam at the deck boundary.
  var accColor = vec3<f32>(0.0);
  var accAlpha: f32 = 0.0;
  var trans: f32 = 1.0;
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
  // Multi-deck emission. The front is the minimum contributing sample distance
  // over the visible decks, not the first deck in composite order: the composite
  // is ordered by |cameraAltitude - deckMidAltitude|, a vertical-band key that
  // is not ray order for an oblique view. The weighted mean composes exactly,
  // because each deck enters the composite with weight `trans` and its own Σwᵢ
  // sums to its alpha, so `Σₖ transₖ·Σᵢwₖᵢtₖᵢ / accAlpha` is the weighted mean
  // over the whole stack.
  var emitFront: f32 = -1.0;
  var emitWeightedSum: f32 = 0.0;
//>>endif
  for (var k: i32 = 0; k < 3; k = k + 1) {
    if (trans < 0.005) { break; } // opaque — far decks are fully occluded
    let di = order[k];
    let r = marchDeck(
      rayOrigin, rayDir, sceneDepth,
      bottoms[di], tops[di], msOctaves,
      centerHigh, centerLow,
      marchSamplePhase,
    );
    if (r.alpha <= 0.0) { continue; } // empty deck — missed shell, or fully thin
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
    if (r.frontDistance >= 0.0 &&
        (emitFront < 0.0 || r.frontDistance < emitFront)) {
      emitFront = r.frontDistance;
    }
    emitWeightedSum = emitWeightedSum + trans * r.weightedDistanceSum;
//>>endif
    accColor += trans * r.alpha * r.hazed;
    accAlpha += trans * r.alpha;
    trans = trans * (1.0 - r.alpha);
  }
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
  var emitDepth = vec2<f32>(-1.0, -1.0);
  if (emitFront >= 0.0 && accAlpha > 0.0) {
    emitDepth = vec2<f32>(
      emitFront,
      emitWeightedSum / max(accAlpha, CLOUD_EMIT_MIN_ALPHA)
    );
  }
//>>endif

  // Half-res path: emit the premultiplied multi-deck radiance and composited
  // alpha, the same contract as the single-shell path, leaving the bilateral
  // upscale to over-composite against the scene. accColor is already
  // premultiplied.
  if (halfResEnabled()) {
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
    return CloudMarchOutput(vec4<f32>(accColor, accAlpha), emitDepth);
//>>else
    return vec4<f32>(accColor, accAlpha);
//>>endif
  }
  // Full-res path — over-composite the premultiplied cloud stack onto the scene.
  let finalColor = sceneColor.rgb * (1.0 - accAlpha) + accColor;
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
  return CloudMarchOutput(vec4<f32>(finalColor, sceneColor.a), emitDepth);
//>>else
  return vec4<f32>(finalColor, sceneColor.a);
//>>endif
}

// Screen-space cloud transmittance mask, for cloud-aware god rays.
// A dedicated full-res pass that re-marches the cloud shells for the current
// camera view and emits only the per-pixel view-ray transmittance — 1 for clear
// sky, 0 for fully opaque cloud — into a single-channel r8unorm target. The
// procedural cloud renderer runs it only when cloud-aware god rays are active.
// The god-ray generate pass samples the mask to attenuate the light shaft where
// clouds block the sun, giving crepuscular rays through gaps.
//
// Reference: Shota Matsuda, Takram — `@takram/three-clouds` in three-geospatial
// (MIT), https://github.com/takram-design-engineering/three-geospatial — the
// approach of resolving cloud occlusion of light shafts from the cloud pass's
// own march rather than from scene depth. Theirs writes a shadow-length
// integral (`marchShadowLength`) to a separate target; this emits the view-ray
// transmittance product instead, which the shaft pass multiplies by directly.
// Technique only — no source was copied.
//
// This mirrors `fragmentMain`'s full-res branches, single-shell and multi-deck,
// with three differences: no half-res UV jitter, an exact midpoint sample phase
// rather than the jittered one — the mask is unfiltered, and a temporal phase
// here would shimmer the shafts frame to frame — and no scene-color composite,
// since the output is transmittance rather than radiance. Transmittance:
//   single-shell: 1 - alpha
//   multi-deck:   Πᵢ (1 - alphaᵢ)  (the running `trans` product)
@fragment
fn fragmentCloudMaskMain(input: VertexOutput) -> @location(0) f32 {
  let uv = input.uv;
  let sceneDepth = textureSampleLevel(depthTex, texSampler, uv, 0.0).r;
  let rayOrigin = cloud.cameraPosition;
  let rayDir = getWorldRay(uv);
  let centerHigh = -cloud.encodedCameraHigh;
  let centerLow = -cloud.encodedCameraLow;
  let msOctaves = i32((u32(cloud.qualityFlags) >> QF_OCTAVES_SHIFT) & 7u);

  if (!multiDeckEnabled()) {
    let r = marchDeck(
      rayOrigin, rayDir, sceneDepth,
      cloud.cloudLayerBottom, cloud.cloudLayerTop, msOctaves,
      centerHigh, centerLow,
      0.5,
    );
    return clamp(1.0 - r.alpha, 0.0, 1.0);
  }

  // Multi-deck: accumulate the running transmittance product exactly as the
  // composite path does, but keep only `trans`.
  let camAlt = cloud.cameraGeodeticHeight;
  let midLow = 0.5 * (cloud.deckBoundsLow.x + cloud.deckBoundsLow.y);
  let midMid = 0.5 * (cloud.deckBoundsMid.x + cloud.deckBoundsMid.y);
  let midHigh = 0.5 * (cloud.deckBoundsHigh.x + cloud.deckBoundsHigh.y);
  let dLow = abs(camAlt - midLow);
  let dMid = abs(camAlt - midMid);
  let dHigh = abs(camAlt - midHigh);
  var bottoms = array<f32, 3>(cloud.deckBoundsLow.x, cloud.deckBoundsMid.x, cloud.deckBoundsHigh.x);
  var tops = array<f32, 3>(cloud.deckBoundsLow.y, cloud.deckBoundsMid.y, cloud.deckBoundsHigh.y);
  var keys = array<f32, 3>(dLow, dMid, dHigh);
  var order = array<i32, 3>(0, 1, 2);
  for (var i: i32 = 1; i < 3; i = i + 1) {
    let oi = order[i];
    let ki = keys[oi];
    var j: i32 = i - 1;
    loop {
      if (j < 0) { break; }
      if (keys[order[j]] <= ki) { break; }
      order[j + 1] = order[j];
      j = j - 1;
    }
    order[j + 1] = oi;
  }
  var trans: f32 = 1.0;
  for (var k: i32 = 0; k < 3; k = k + 1) {
    if (trans < 0.005) { break; }
    let di = order[k];
    let r = marchDeck(
      rayOrigin, rayDir, sceneDepth,
      bottoms[di], tops[di], msOctaves,
      centerHigh, centerLow,
      0.5,
    );
    if (r.alpha <= 0.0) { continue; }
    trans = trans * (1.0 - r.alpha);
  }
  return clamp(trans, 0.0, 1.0);
}

// Sun-view beer shadow map.
// Rasterized from the sun's orthographic view into a low-res single-channel
// target. Each shadow-map texel reconstructs the camera-relative point on its
// column, through the frame owner's eye-relative inverse view-projection, then
// marches the cloud density along the sun ray across the full shell thickness,
// accumulating optical depth as Σ density·stepSize. Consumers project a point
// into the map and read transmittance = exp(-opticalDepth · absorption), the
// cloud thickness between that point and the sun.
//
// Both branches intersect the same expanded oblate shells `cloudShellAxes` gives
// the primary march. Treating the shell as two equatorial-radius spheres with a
// height of `length(p) - planetRadius` instead marches, at high latitude, a slab
// several deck thicknesses above the shell the visible march renders — WGS84's
// polar axis is ~21.4 km shorter — so the sun ray meets no cloud and the cast
// shadow silently vanishes.
//
// The `cloudHighPrecision = false` escape route reconstructs the column point in
// absolute coordinates as a comparison oracle, on the same WGS84 geometry,
// mirroring how `marchDeck` handles its own branch. The high-precision route
// keeps the column point and the density domains camera-relative, so the map is
// cast by the field the visible march renders; an absolute `vec3<f32>` from an
// `f32` matrix whose translation column is itself ~6.4e6 m is not.
//
// The accumulated optical depth is clamped for an f16 target: well under 65504
// and inside a range exp() resolves. Absorption is applied by the consumers, so
// what is stored is the raw density-times-length integral.
@fragment
fn cloudShadowMain(input: VertexOutput) -> @location(0) f32 {
  let deckBottom = cloud.cloudLayerBottom;
  let deckTop = cloud.cloudLayerTop;

  // The same oblate boundaries the visible march intersects. The map stays
  // single-shell — the cast shadow tracks the primary cloud layer — so the deck
  // bounds are that layer's.
  let innerAxes = cloudShellAxes(deckBottom);
  let outerAxes = cloudShellAxes(deckTop);
  let innerInverseAxes = vec3<f32>(1.0) / innerAxes;
  let outerInverseAxes = vec3<f32>(1.0) / outerAxes;
  let centerHigh = -cloud.encodedCameraHigh;
  let centerLow = -cloud.encodedCameraLow;

  // Reconstruct the column this shadow texel covers. NDC z = 0 is an arbitrary
  // plane in the orthographic frustum, and only a ray origin on the column is
  // needed: intersecting the sun ray with the boundaries re-anchors it onto the
  // shell. UV 0..1 maps to NDC -1..1, flipped for WebGPU's y-down convention.
  let ndc = vec3<f32>(input.uv.x * 2.0 - 1.0, 1.0 - input.uv.y * 2.0, 0.0);
  let columnH = cloudShadow.sunViewInvVpRelativeToEye * vec4<f32>(ndc, 1.0);
  let columnRelative = columnH.xyz / columnH.w;

  let sunDir = normalize(cloudShadow.sunDirAndSteps.xyz);
  // `sunDir` points at the sun, so the sun ray travels toward the surface as
  // -sunDir. March from the column's entry at the outer shell down to the inner.
  let rayDir = -sunDir;

  var tOuter: vec2<f32>;
  var tInner: vec2<f32>;
  if (highPrecisionEnabled()) {
    // Planet centre relative to the COLUMN point. The exact high term is kept
    // untouched and the small column displacement is folded into the low term,
    // preserving the high-then-low cancellation order.
    let columnCenterLow = centerLow - columnRelative;
    tOuter = rayEllipsoidIntersectRTE(rayDir, centerHigh, columnCenterLow, outerAxes);
    tInner = rayEllipsoidIntersectRTE(rayDir, centerHigh, columnCenterLow, innerAxes);
  } else {
    let columnPoint = cloud.cameraPosition + columnRelative;
    tOuter = rayEllipsoidIntersect(columnPoint, rayDir, outerAxes);
    tInner = rayEllipsoidIntersect(columnPoint, rayDir, innerAxes);
  }

  if (tOuter.y < 0.0) {
    // Column misses the shell entirely (sun grazing past the limb) — no shadow.
    return 0.0;
  }
  // Enter at the near outer-shell crossing (clamped to in-front), exit at the far
  // outer crossing OR the near inner crossing if the ray dips below the inner shell.
  var tStart = max(tOuter.x, 0.0);
  var tEnd = tOuter.y;
  if (tInner.x > 0.0) { tEnd = min(tEnd, tInner.x); }
  if (tEnd <= tStart) {
    return 0.0;
  }

  let steps = max(2, i32(cloudShadow.sunDirAndSteps.w));
  let stepSize = (tEnd - tStart) / f32(steps);
  var opticalDepth: f32 = 0.0;
  for (var i: i32 = 0; i < steps; i = i + 1) {
    let t = tStart + (f32(i) + 0.5) * stepSize;
    let sampleRelative = columnRelative + rayDir * t;
    if (highPrecisionEnabled()) {
      let hf = ellipsoidShellHeightFractionRTE(
        sampleRelative, centerHigh, centerLow,
        innerInverseAxes, outerInverseAxes
      );
      opticalDepth += cloudDensityRelativeWithFootprint(
        sampleRelative,
        centerHigh,
        centerLow,
        hf,
        deckBottom,
        deckTop,
        stepSize,
      ) * stepSize;
    } else {
      let samplePos = cloud.cameraPosition + sampleRelative;
      let hf = ellipsoidShellHeightFraction(
        samplePos, innerInverseAxes, outerInverseAxes
      );
      opticalDepth += cloudDensityWithFootprint(
        samplePos,
        hf,
        deckBottom,
        deckTop,
        stepSize,
      ) * stepSize;
    }
  }
  // Clamp to keep the f16 store finite and the consumer's exp() in range. The
  // raw integral over a dense ~2.5 km shell at densityMultiplier ~0.3 is of
  // order 10² to 10³, so a cap well under the f16 maximum leaves headroom while
  // stopping a runaway density from writing a NaN into the map.
  return clamp(opticalDepth, 0.0, 8000.0);
}
