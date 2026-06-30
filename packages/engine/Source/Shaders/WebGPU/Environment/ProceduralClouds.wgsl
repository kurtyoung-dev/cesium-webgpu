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
  _pad2: vec2<f32>,
  // Weather Phase 1 — weather-map seam (floats 64-79). Byte-locked to the JS
  // packer in WebGPUProceduralCloudRenderer.ts.
  weatherMapEnabled: f32,        // 64 — >0.5 → sample the weather map per position
  weatherStrength: f32,          // 65 — per-cell coverage multiplier (folds in cloudCoverage)
  phaseG2: f32,                  // 66 — W1 dual-lobe back-scatter g
  phaseBlend: f32,               // 67 — W1 forward/back lobe blend weight
  weatherTexBounds: vec4<f32>,   // 68-71 — minLon, minLat, lonRange, latRange (radians)
  // NOTE: scalar pads (NOT a vec3) so 72-75 stay byte-exact — a vec3 here has
  // 16-byte alignment and would jump to float 76, breaking the packer lock.
  phaseG1: f32,                  // 72 — W1 dual-lobe forward-scatter g (silver lining)
  ambientIntensity: f32,         // 73 — W2 sky/ground ambient intensity
  qualityFlags: f32,             // 74 — V1 tier bitfield (read via u32())
  // Batch 439 (4.7 CLOUD-CURL) — reserved slot 75 ACTIVATED in place (add-only;
  // byte-layout unchanged). 0 → the BAKED-path detail-erosion curl warp is
  // skipped entirely (default render byte-identical). >0 → amplitude of the
  // analytic curl-noise domain warp on the detail sample position.
  curlAmplitude: f32,            // 75 — 4.7 curl warp amplitude (0 = off, default)
  // 76-79 — split from the old `_padA` vec4 (byte-identical: 4 scalars on the
  // same 16-byte stride). Each named per the ratified D-2 table.
  frameCounter: f32,             // 76 — reserved (V6 jitter/temporal)
  curlFrequency: f32,            // 77 — 4.7 curl-noise swirl wavelength (noise-space scale)
  lightSampleScale: f32,         // 78 — reserved (V5 lighting)
  erosionStrength: f32,          // 79 — V4 mean-preserving erosion strength
  skyAmbientColor: vec3<f32>,    // 80-82 — W2 blue-sky ambient (lights cloud tops)
  _padB: f32,                    // 83
  groundAmbientColor: vec3<f32>, // 84-86 — W2 ground-bounce ambient (lights cloud bottoms)
  _padC: f32,                    // 87
  sunLightColor: vec3<f32>,      // 88-90 — W3 time-of-day sun color (warm low / neutral noon)
  aerialStrength: f32,           // 91 — W4 aerial-perspective strength
  aerialColor: vec3<f32>,        // 92-94 — W4 horizon inscatter haze tint (time-of-day keyed)
  _padD: f32,                    // 95
  // ── Batch 407 (promoted shader consts → live dials; all scalar f32, one
  // 16-byte row 96-99 + a second 100-103). Default-byte-identical: the JS packer
  // writes the former const values, so an unset dial reproduces today's render. ──
  puffSize: f32,                 // 96 — promoted SHAPE_SCALE (baked base puff size)
  exposure: f32,                 // 97 — promoted CLOUD_EXPOSURE (Reinhard tone-map)
  msDecayA: f32,                 // 98 — MS_SCATTER_DECAY (per-octave contribution)
  msDecayB: f32,                 // 99 — MS_EXTINCTION_DECAY (per-octave extinction)
  msDecayC: f32,                 // 100 — MS_PHASE_DECAY (per-octave eccentricity)
  // ── Batch 408 (V11 per-genus vertical-density profile; slots 101-103 were the
  // Batch-407 reserved pads, renamed in place — add-only). Default CUMULUS keeps
  // the render byte-identical: profileShape=BILLOWY uses the LITERAL original
  // height gradient and profileDensityScale=1.0. ──
  profileShape: f32,             // 101 — 0=SLAB / 1=BILLOWY / 2=TOWERING_ANVIL
  profileDensityScale: f32,      // 102 — per-genus density vs CUMULUS (1.0 = neutral)
  profileExtinction: f32,        // 103 — per-genus optical extinction (scaffolding; not yet sampled)
  anvilBias: f32,                // 104 — TOWERING_ANVIL upper-flare bias (0 = none)
  // ── Batch 409 (depth occlusion; slots 105-106 were Batch-408 pads) ──
  nearPlane: f32,                // 105 — camera frustum near (reverse the log depth)
  farPlane: f32,                 // 106 — camera frustum far
  // ── Batch 424 (Weather Phase 3 — weather-map G/B/A channel reads). Slot 107
  // was the Batch-409 reserved pad, renamed in place (add-only). Scales how
  // strongly the weather map's G (genus), B (base) and A (density-bias) channels
  // modulate the cloud model. Default 1.0; a NEUTRAL map cell (G=0.5, B=0, A=0.5)
  // is a no-op at ANY strength, so weatherMapEnabled=0 OR a neutral map is
  // byte-identical to the pre-424 render. ──
  weatherChannelStrength: f32,   // 107 — G/B/A influence scale (0 = R-only legacy)
  // ── Batch 434 (3.3 CLOUD-AERIAL-LUT + 3.4 CLOUD-AMBIENT-LUT) — atmosphere-LUT
  // coupling. Slots 108-111 are one new 16-byte row, appended ADD-ONLY. All four
  // default to the legacy path so an unset render is byte-identical:
  //   aerialLutMode=0  → heuristic ~60 km LDR aerial lerp (unchanged)
  //   ambientLutMode=0 → constant sky/ground ambient lerp (unchanged)
  // Both also self-heal: even with the mode flag set, the WGSL falls back to the
  // legacy branch when the sampled LUT radiance is ~0 (the LUTs are unbaked, e.g.
  // skyAtmosphere off), so a stray "physical" flag never blacks-out the clouds. ──
  aerialLutMode: f32,            // 108 — 0 heuristic / 1 physical (sky-view inscatter + transmittance)
  ambientLutMode: f32,           // 109 — 0 constant / 1 sky-LUT (MS sky LUT up/down hemispheres)
  atmosphereThickness: f32,      // 110 — m; MUST equal the LUT bake's ATMOSPHERE_THICKNESS (111e3)
  _padE: f32,                    // 111 — pad to the 16-byte row
  // ── Batch 443 (4.9 CLOUD-MULTIDECK) — multi-deck shell march. Slots 112-119 are
  // two new 16-byte rows, appended ADD-ONLY. Default OFF is byte-identical: when
  // multiDeck=0 the fragment marches EXACTLY ONE shell with cloudLayerBottom/Top
  // (today's bounds + composite), and these deck-bounds floats are never read.
  // When >0 the fragment marches up to 3 shells (LOW/MID/HIGH) from these bounds
  // and composites them FRONT-TO-BACK (near deck over far deck, premultiplied).
  // Bounds source: CloudTypeProfile.CloudDeck.bounds (LOW [0,2km], MID [2,7km],
  // HIGH [5,13km]) packed by the JS renderer. ──
  multiDeck: f32,                // 112 — 0 single shell (default) / >0 march LOW/MID/HIGH
  _padF: f32,                    // 113 — pad
  deckBoundsLow: vec2<f32>,      // 114-115 — LOW deck [bottom, top] (m above surface)
  deckBoundsMid: vec2<f32>,      // 116-117 — MID deck [bottom, top]
  deckBoundsHigh: vec2<f32>,     // 118-119 — HIGH deck [bottom, top]
  // ── Batch 445 (4.12 CLOUD-RTE) — camera-relative high-precision march. Slots
  // 120-127, two new 16-byte rows appended ADD-ONLY (existing field offsets above
  // are UNCHANGED). The RTE high/low split of the camera world position; the planet
  // center relative to the camera is -(high+low). READ ONLY inside the
  // CLOUD_QF_HIGH_PRECISION branch — when the bit is clear these floats are never
  // touched, so the default render is byte-identical. The .xyz carry the split; the
  // packed pad keeps each on a 16-byte (vec4) stride so the struct length is 128. ──
  encodedCameraHigh: vec3<f32>,  // 120-122 — high part of the camera world position
  _padG: f32,                    // 123 — pad to the 16-byte row
  encodedCameraLow: vec3<f32>,   // 124-126 — low part (refinement) of the camera position
  _padH: f32,                    // 127 — pad to the 16-byte row
};

@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> cloud: CloudUniforms;
// Weather Phase 1 — global lat/lon weather field (R=coverage, G=type, B=base,
// A=density-bias). Declared texture_2d_array (depth 1) so the multi-deck slice
// (Phase 2) can add deck layers without changing the binding.
@group(0) @binding(4) var weatherTex: texture_2d_array<f32>;
@group(0) @binding(5) var weatherSampler: sampler;
// V2 — baked 3D noise (shape 128³ + detail 32³) + sampler. DECLARED but NOT
// sampled yet (no path reads them → byte-identical); V3 switches cloudDensity /
// cloudBaseDensity to sample these instead of the live fbmNoise/worleyF1.
@group(0) @binding(6) var cloudShapeTex: texture_3d<f32>;
@group(0) @binding(7) var cloudDetailTex: texture_3d<f32>;
@group(0) @binding(8) var cloudNoiseSampler: sampler;
// Batch 434 (3.3 + 3.4) — precomputed atmosphere LUTs (shared with SkyAtmosphere).
// Bound UNCONDITIONALLY so the pipeline/BGL never forks; the renderer binds 1×1
// placeholders when the LUTs aren't allocated. The shader only samples them when
// the corresponding mode flag is set AND the sampled radiance is non-zero (the
// unbaked LUTs read all-zero → the legacy fallback runs). Same 256×128 sun-relative
// sky-view domain as SkyAtmosphere's bindings 5/6; the transmittance LUT is 256×64.
//   9  — sun-relative SKY-VIEW single-scatter inscatter (3.3 air light)
//   10 — sun-relative MULTIPLE-SCATTERING sky radiance (3.4 ambient hemispheres)
//   11 — TRANSMITTANCE (altitude × cosZenith) for the 3.3 cloud-color attenuation
//   12 — linear LUT sampler (clamp-to-edge)
@group(0) @binding(9) var cloudSkyViewLut: texture_2d<f32>;
@group(0) @binding(10) var cloudMultipleScatterLut: texture_2d<f32>;
@group(0) @binding(11) var cloudTransmittanceLut: texture_2d<f32>;
@group(0) @binding(12) var cloudLutSampler: sampler;
// Batch 437 (CLOUD-SHADOWS) — sun-view "beer shadow map" pass uniforms. Bound ONLY
// in the dedicated shadow pipeline's bind group (binding 13); the main cloud color
// pass never declares it (a fragment that doesn't reference a binding doesn't need
// it in the pipeline layout, WebGPU validates per-entry-point). The shadow pass
// reuses the SAME `CloudUniforms` (binding 3) + weather/noise bindings (4-8) so its
// `cloudDensity`/`cloudBaseDensity` oracle is byte-identical to the visible march —
// the cast shadow therefore tracks exactly the rendered cloud field.
struct CloudShadowUniforms {
  // Inverse of the sun-view orthographic view-projection (clip → world). Used to
  // reconstruct, for each shadow-map texel, the world point on the shell mid-plane
  // that the column passes through; the march walks the sun ray from that point.
  sunViewInvVP: mat4x4<f32>,
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
// Weather Phase 3 — cloud-base normalization band (MUST equal CLOUD_BASE_NORM_METERS
// in WeatherTexPacker.ts). The packer stores B = baseMetres / 12000; the shader
// reverses it to metres before converting to a shell-thickness fraction.
const CLOUD_BASE_NORM_METERS: f32 = 12000.0;
// W1 — exposure feeding the Reinhard tone-map at the cloud composite. Calibrated
// against sunIntensity~10 + the dual-lobe forward peak so the silver lining is a
// gradient, not a white-out. Promoted to the `cloud.exposure` uniform (Batch 407,
// default 0.22) so it can be tuned live; the const is gone.

// V1 — `qualityFlags`@74 bit layout (declared; no path reads them yet — feature
// batches wire each: V3 noiseSource, V9 halfRes, V10 temporal, V6 jitter, V5
// octaves, V11 profile). Unpack with `u32(cloud.qualityFlags)`.
const QF_NOISE_BAKED: u32 = 1u;     // bit 0
const QF_HALF_RES: u32 = 2u;        // bit 1
const QF_TEMPORAL: u32 = 4u;        // bit 2
const QF_JITTER: u32 = 8u;          // bit 3
const QF_OCTAVES_SHIFT: u32 = 4u;   // bits 4-6
const QF_PROFILE_ON: u32 = 128u;    // bit 7
// Batch 434 — atmosphere-LUT coupling (add-only). The JS renderer sets these only
// when the corresponding mode flag is 'physical'/'sky-lut'; the shader additionally
// gates each on a non-zero LUT radiance (unbaked LUT → legacy fallback).
const QF_AERIAL_LUT: u32 = 256u;    // bit 8 — 3.3 physical aerial (sky-view + transmittance)
const QF_AMBIENT_LUT: u32 = 512u;   // bit 9 — 3.4 sky-LUT cloud ambient (MS sky LUT)
const QF_LIGHT_CONE: u32 = 1024u;   // bit 10 — 3.6 cone-sampled light march (Batch 436)
const QF_MULTI_DECK: u32 = 2048u;   // bit 11 — 4.9 multi-deck shell march (Batch 443)
// Batch 445 (4.12 CLOUD-RTE) — add-only. The JS renderer sets this only when
// globe.cloudHighPrecision is opted in; when clear the closest-point f32 march below
// runs verbatim (byte-identical).
const QF_HIGH_PRECISION: u32 = 4096u; // bit 12 — 4.12 camera-relative high-precision march (1<<12)

// V9 (Batch 432) — ordered 4×4 Bayer matrix (normalized 0..1, the standard
// recursive dither pattern). Used to JITTER the half-res sample point by a
// sub-pixel offset within each 2×2 full-res footprint, cycled per frame on
// `cloud.frameCounter` (float 76). Decorrelating the half-res grid per Wronski
// ("Volumetric Atmospheric Scattering", GDC 2014; "Temporal Supersampling")
// breaks up the blocky 2× under-sampling so the bilateral upscale reconstructs
// soft volumetric forms instead of a hard checkerboard. The 16-tap LUT is a const
// array indexed by `(frameCounter mod 16)`.
const BAYER4: array<f32, 16> = array<f32, 16>(
   0.0 / 16.0,  8.0 / 16.0,  2.0 / 16.0, 10.0 / 16.0,
  12.0 / 16.0,  4.0 / 16.0, 14.0 / 16.0,  6.0 / 16.0,
   3.0 / 16.0, 11.0 / 16.0,  1.0 / 16.0,  9.0 / 16.0,
  15.0 / 16.0,  7.0 / 16.0, 13.0 / 16.0,  5.0 / 16.0
);

// ─── Full-screen triangle ───
@vertex
fn vertexMain(@builtin(vertex_index) vid: u32) -> VertexOutput {
  var out: VertexOutput;
  // OVERSIZED fullscreen triangle — verts (-1,-1), (3,-1), (-1,3) so the whole
  // [-1,1] clip square sits INSIDE the triangle and every screen pixel is shaded.
  // The previous exact-fit triangle (-1,-1),(1,-1),(-1,1) coincided with three
  // NDC corners and covered ONLY the lower-left half (x+y<=0) — the upper-right
  // half was never rasterized, so clouds appeared only in the bottom-left of the
  // screen behind a hard corner-to-corner diagonal. (That diagonal was long
  // misfiled as a "frustum-edge artifact"; it was a non-oversized fullscreen
  // triangle.) `uv` is an affine function of the clip xy, so it still
  // interpolates 0..1 across the visible square unchanged.
  let x = f32((vid << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vid & 2u) * 2.0 - 1.0;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
  return out;
}

// ─── Hash functions for noise ───
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

// ─── Value noise 3D ───
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

// ─── FBM (Fractal Brownian Motion) noise — 5 octaves ───
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

// ─── Worley (cellular) noise 3D — F1 distance (379a, minimal re-land) ───
// Distance to the nearest feature point (one per cell, hashed) over the 3×3×3
// neighborhood. HIGH between cells, low at feature points — so subtracting it
// carves the inter-lobe gaps, leaving rounded cauliflower lobes (the billowy
// cloud-edge character value-noise can't produce). 27 taps; reuses hash33.
//
// NOTE on the prior 379a revert: that attempt remapped the BASE shape by Worley
// (`remap(perlin, worleyLow-1, 1, 0, 1)`), which raised the density floor and
// over-densified the clouds. This re-land swaps ONLY the subtractive erosion —
// it can carve detail but never ADD density, so it cannot reproduce that failure.
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

// ─── Batch 439 (4.7 CLOUD-CURL) — analytic curl-noise domain warp ───
// Curl of a 3-component value-noise vector potential, evaluated analytically by
// central differences. curl(F) = (∂Fz/∂y − ∂Fy/∂z, ∂Fx/∂z − ∂Fz/∂x,
// ∂Fy/∂x − ∂Fx/∂y) is DIVERGENCE-FREE, so warping a sample position by it produces
// the swirling, incompressible, tendril-like advection that gives Schneider/Nubis
// cloud edges their wispy, turbulent character (instead of fbm's blobby erosion).
// The potential is `valueNoise` (already periodic-friendly here) offset by large
// constants per component so the three scalar fields decorrelate. Computed ONLY
// when curlAmplitude>0 (the call site guards it), so the default path never runs
// this — and at amplitude 0 the warp offset is exactly vec3(0) anyway.
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

// ─── ECEF world position → weather-map UV (Weather Phase 1) ───
// Equirectangular geodetic lon/lat (spherical approximation — a coarse weather
// field doesn't need ellipsoidal exactness). lon = atan2(y, x) ∈ [-PI, PI];
// lat = asin(z / r). Mapped onto [0,1]² via weatherTexBounds; v is flipped so
// texture row 0 (top) is the north pole.
fn worldToWeatherUV(worldPos: vec3<f32>) -> vec2<f32> {
  let r = max(length(worldPos), 1.0);
  let lon = atan2(worldPos.y, worldPos.x);
  let lat = asin(clamp(worldPos.z / r, -1.0, 1.0));
  let b = cloud.weatherTexBounds;
  let u = (lon - b.x) / b.z;
  let v = 1.0 - (lat - b.y) / b.w;
  return vec2<f32>(u, v);
}

// ─── Cloud density at a world-space point ───
fn remap(v: f32, lo: f32, hi: f32, a: f32, b: f32) -> f32 {
  return a + (v - lo) * (b - a) / (hi - lo);
}

// V3 — is the baked-3D-texture density core active? (qualityFlags bit 0)
fn noiseBakedEnabled() -> bool {
  return (u32(cloud.qualityFlags) & QF_NOISE_BAKED) != 0u;
}

// V9 (Batch 432) — is the half-res render path active? (qualityFlags bit 1). When
// set, the raymarch renders into a 0.5× rgba16float offscreen target and emits
// PREMULTIPLIED cloud radiance + alpha (NO scene-color composite — that moves to
// the bilateral upscale pass). When clear, the legacy full-res draw(3)→canvas
// composite runs UNCHANGED (byte-identical). The qualityFlags bit gates which
// return branch fragmentMain takes; the JS renderer also keys the pipeline's
// color-target format (canvasFormat vs rgba16float) on the same tier resolve.
fn halfResEnabled() -> bool {
  return (u32(cloud.qualityFlags) & QF_HALF_RES) != 0u;
}

// V3 — baked cloud BASE shape (one trilinear fetch of the shape texture's R: the
// contrast-stretched Perlin fBM the bake wrote). Drop-in for the live `fbmNoise`
// base — NOT Worley-remapped (a remap raises the mean + over-densifies, the
// 379a-revert lesson the live code warns about); the Worley stays SUBTRACTIVE
// erosion via the detail texture in cloudDensity. SHARED by cloudDensity + the
// cloudBaseDensity skip-oracle so they stay identical BEFORE erosion — that
// preserves W5's `base >= full` invariant (cloudDensity subtracts erosion; the
// oracle does not). The `repeat` sampler tiles the periodic bake through world space.
fn bakedBase(samplePos: vec3<f32>) -> f32 {
  // Domain-warp the lookup by a SLOW low-frequency offset (sampled from the
  // detail texture at a large period) so the baked texture's ~3.3 km tiling grid
  // bends into organic shapes instead of reading as an obvious repeating lattice.
  // (Normally the spatially-varying weather map masks the repeat; this keeps it
  // hidden when the weather map is off.) Warp preserves the single-sample
  // contrast — no octave-blend smoothing — so the billowy puffs survive.
  // SHAPE_SCALE < 1 enlarges the base puffs (the texture covers more world per
  // tile) so the default deck reads as bigger, fluffier cumulus instead of fine
  // dapple; the detail erosion (cloudDensity, samplePos*5) stays fine, giving big
  // lobes with cauliflower edges. Warp + warp-sample scale track SHAPE_SCALE so
  // the de-tiling stays proportional.
  let SHAPE_SCALE = cloud.puffSize; // Batch 407 dial (default 0.45)
  let s = samplePos * SHAPE_SCALE;
  let w = textureSampleLevel(cloudDetailTex, cloudNoiseSampler, s * 0.32, 0.0).rgb;
  let uvw = s + (w - vec3<f32>(0.5)) * 0.5;
  return textureSampleLevel(cloudShapeTex, cloudNoiseSampler, uvw, 0.0).r;
}

// V11 — per-genus vertical density gradient. Replaces the single hardcoded
// `smoothstep(0,0.15,h)*smoothstep(1,0.7,h)` so genera read as different SHAPES,
// not just different coverage: SLAB = flat sheet (stratus/altostratus/cirro-
// stratus), BILLOWY = rounded cumulus (the historical default), TOWERING_ANVIL =
// tall convective column that flares near the top (congestus/cumulonimbus).
// CRITICAL: BILLOWY returns the EXACT original expression so the default CUMULUS
// path is byte-identical; and this is called IDENTICALLY in cloudDensity and the
// cloudBaseDensity oracle so the W5 `base >= full` invariant is preserved.
fn heightGradientFor(h: f32, shape: f32, anvil: f32) -> f32 {
  if (shape < 0.5) {
    // SLAB — fills most of the layer; thin soft edges top and bottom.
    return smoothstep(0.0, 0.08, h) * smoothstep(1.0, 0.92, h);
  } else if (shape < 1.5) {
    // BILLOWY — the literal historical gradient (keep byte-identical).
    return smoothstep(0.0, 0.15, h) * smoothstep(1.0, 0.7, h);
  }
  // TOWERING_ANVIL — rounded base, broad high shoulder; anvil widens the top
  // (higher anvil → density stays high through more of the column before flaring).
  let base = smoothstep(0.0, 0.12, h);
  let anvilTop = smoothstep(1.0, mix(0.85, 0.6, clamp(anvil, 0.0, 1.0)), h);
  return base * anvilTop;
}

// ─── Weather Phase 3 — per-position G/B/A channel decode ───
// Decodes the weather sample's three scaffolding channels into model-space
// modifiers, NEUTRAL-SAFE: a neutral cell (G=0.5, B=0, A=0.5) yields the
// identity (densityScale=1, baseShift=0, shape=cloud.profileShape) at ANY
// `weatherChannelStrength`, so existing R-only maps + weatherMapEnabled=0 stay
// byte-identical. Returns:
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
  // B — cloud base, normalized over CLOUD_BASE_NORM_METERS (12 km). 0 neutral. The
  // raw value is base-metres/12000; convert to a fraction of the cloud SHELL
  // thickness so the height gradient lifts off that base. layerThickness is the
  // shell span (top-bottom). B=0 → no shift → today's behaviour. Batch 443 — the
  // active DECK's thickness is passed in so per-deck base shifts stay in the deck's
  // own shell fraction; the default single-shell call passes cloudLayerTop-Bottom
  // so the value is byte-identical to pre-443.
  let layerThickness = max(deckThickness, 1.0);
  let baseShiftFrac = clamp(
    gba.y * CLOUD_BASE_NORM_METERS / layerThickness * s, 0.0, 0.9);
  // G — genus/type index packed as genus/10 (0..1 → 0..10). 0.5 (the packer's
  // neutral mid, genus≈5) → no change: blend the GLOBAL cloud.profileShape toward
  // SLAB(0) below mid and TOWERING_ANVIL(2) above mid by the signed deviation, so
  // a low-G cell flattens (stratus-like) and a high-G cell towers (cumulonimbus-
  // like). |G-0.5| small → ≈ the global shape. This is a best-effort shape bias,
  // not a full per-pixel genus profile.
  let gDev = (gba.x - 0.5) * 2.0 * s; // -s..+s, 0 at neutral
  let genusTarget = select(0.0, 2.0, gDev > 0.0); // SLAB below mid, TOWER above
  let perGenusShape = mix(cloud.profileShape, genusTarget, clamp(abs(gDev), 0.0, 1.0));
  return WeatherChannels(densityScale, baseShiftFrac, perGenusShape);
}

// Batch 443 (4.9 CLOUD-MULTIDECK) — `deckBottom`/`deckTop` are the active deck's
// shell bounds (m above surface). The default single-shell call passes
// cloud.cloudLayerBottom/Top, so the weather-base-shift fraction (the only place
// the bounds enter cloudDensity) is byte-identical to pre-443; multi-deck calls
// pass each deck's own bounds so per-deck base shifts stay in that deck's fraction.
fn cloudDensity(worldPos: vec3<f32>, heightFraction: f32, deckBottom: f32, deckTop: f32) -> f32 {
  // Animate with wind
  let windOffset = vec3<f32>(cloud.windDirection.x, 0.0, cloud.windDirection.y)
                   * cloud.windSpeed * cloud.time;
  let samplePos = (worldPos + windOffset) * 0.0003; // scale to noise space

  // Weather Phase 1 (KEYSTONE) — per-position coverage from the weather map's
  // R channel, so cloud cover varies SPATIALLY (distinct regions) instead of one
  // global scalar. `cloud.coverage` folds into `weatherStrength` as a global
  // multiplier. weatherMapEnabled=0 → byte-identical to the old global-scalar
  // path. The weather UV uses the RAW world position (geographic), not the
  // wind-scaled noise-space `samplePos`.
  // Weather Phase 3 — G/B/A channels (genus, base, density-bias). Neutral
  // (G=0.5,B=0,A=0.5) → identity, so the R-only / disabled paths stay byte-exact.
  var effectiveCoverage = cloud.coverage;
  var wch = WeatherChannels(1.0, 0.0, cloud.profileShape);
  if (cloud.weatherMapEnabled > 0.5) {
    let wuv = worldToWeatherUV(worldPos);
    let wsample = textureSampleLevel(weatherTex, weatherSampler, wuv, 0, 0.0);
    effectiveCoverage = clamp(wsample.r * cloud.weatherStrength, 0.0, 1.0);
    wch = decodeWeatherChannels(wsample.gba, deckTop - deckBottom);
  }

  // Base shape. V3 — BAKED: the Nubis Perlin-Worley combine from the baked 3D
  // shape texture (one trilinear fetch + remap — better-looking AND cheaper than
  // the ~30 live evals). LIVE: the historical value-noise FBM (kept as the
  // fallback / low tier so the default never regresses).
  var density: f32;
  if (noiseBakedEnabled()) {
    density = bakedBase(samplePos);
  } else {
    density = fbmNoise(samplePos);
  }

  // Coverage threshold — shapes the clouds (per-position when the weather map is on)
  density = smoothstep(1.0 - effectiveCoverage, 1.0, density);

  // V11 — per-genus vertical gradient (default CUMULUS=BILLOWY == the old expr).
  // Weather B/G — shift the height-gradient base up by baseShiftFrac (B) and use
  // the per-position genus shape (G). At neutral both collapse to the old call.
  let hForGradient = clamp(
    (heightFraction - wch.baseShiftFrac) / max(1.0 - wch.baseShiftFrac, 1e-3),
    0.0, 1.0);
  let heightGradient = heightGradientFor(hForGradient, wch.perGenusShape, cloud.anvilBias);
  density *= heightGradient;

  // High-frequency WORLEY edge erosion (carves billowy lobes; fades toward the top).
  if (noiseBakedEnabled()) {
    // V4 — MEAN-PRESERVING erosion remap (Nubis). The detail texture's R is
    // INVERTED Worley (high AT features), so `1 - detail.r` is the Worley DISTANCE
    // (high BETWEEN features). `remap(density, erosionLo, 1, 0, 1)` carves where
    // density falls below the erosion floor but stretches the survivors back up,
    // so dense cloud CORES stay solid (no lumpy-with-holes deck at high coverage —
    // the V3 dapple) while edges still erode. remap(v, lo, 1, 0, 1) <= v for
    // v in [0,1], lo >= 0, so cloudDensity <= cloudBaseDensity (W5 `base >= full`)
    // STILL holds — the oracle just omits this erosion step entirely.
    // Batch 439 (4.7 CLOUD-CURL) — curl-noise domain warp on the DETAIL erosion
    // lookup. The divergence-free curl field swirls the high-frequency Worley
    // erosion sample into turbulent, advected filaments — wispy tendril edges
    // (Schneider/Nubis) instead of the static dapple. GUARDED on curlAmplitude>0
    // so the default render skips the curl evaluation AND the warp entirely; at
    // amplitude 0 the warp offset is exactly vec3(0) → the detail sample position
    // is byte-identical to pre-439. curlFrequency scales the swirl wavelength.
    var detailPos = samplePos * 5.0;
    if (cloud.curlAmplitude > 0.0) {
      // The detail lookup lives in `samplePos*5` space; the analytic curl is ~O(1)
      // per component. A gain of ~2 makes the dial's nominal 1.0 read as a clear,
      // tendril-forming swirl in that space (still bounded — the warp only moves
      // WHERE the subtractive erosion samples, never adds density).
      let warp = curlNoise3(samplePos * cloud.curlFrequency) * (cloud.curlAmplitude * 2.0);
      detailPos = detailPos + warp;
    }
    let detail = textureSampleLevel(cloudDetailTex, cloudNoiseSampler, detailPos, 0.0);
    let worleyDetail = 1.0 - detail.r;
    let erosionLo = worleyDetail * cloud.erosionStrength * (1.0 - heightFraction);
    density = clamp(remap(density, erosionLo, 1.0, 0.0, 1.0), 0.0, 1.0);
  } else {
    // LIVE path FROZEN (W5): literal subtractive erosion, unchanged.
    let worleyDetail = worleyF1(samplePos * 5.0 + windOffset * 0.001);
    density -= worleyDetail * 0.18 * (1.0 - heightFraction);
    density = max(density, 0.0);
  }

  // V11 — per-genus density scale (CUMULUS = 1.0, so default is byte-identical;
  // cirrus thins, nimbostratus thickens). Applied identically in the oracle below.
  // Weather A — per-position density-bias multiplier (1.0 neutral) folded last so
  // the deck is visibly denser/thinner where the map's A varies.
  return density * cloud.densityMultiplier * cloud.profileDensityScale * wch.densityScale;
}

// ─── W5: cheap low-detail presence test for empty-space skipping ───
// Returns the cloud BASE shape (fbm + coverage threshold + height gradient)
// WITHOUT the 27-tap Worley erosion or detail. Two properties make it the right
// skip oracle: (1) CONSERVATIVE — Worley only SUBTRACTS from density, so
// base >= full everywhere; base ≈ 0 guarantees full ≈ 0, so the coarse phase
// never skips real cloud. (2) SMOOTH — no internal erosion pockets, so the
// coarse→fine handoff never false-triggers inside a cloud the way the eroded
// full density does. And it is much cheaper (no Worley, no detail), so coarse
// probing of empty space is a real tap-cost win, not just a step-count one.
fn cloudBaseDensity(worldPos: vec3<f32>, heightFraction: f32, deckBottom: f32, deckTop: f32) -> f32 {
  let windOffset = vec3<f32>(cloud.windDirection.x, 0.0, cloud.windDirection.y)
                   * cloud.windSpeed * cloud.time;
  let samplePos = (worldPos + windOffset) * 0.0003;

  // Weather Phase 3 — decode G/B/A IDENTICALLY to cloudDensity so the oracle's
  // density scale + base/genus shaping match, preserving W5's `base >= full`
  // invariant per-position (the oracle just omits the Worley erosion).
  var effectiveCoverage = cloud.coverage;
  var wch = WeatherChannels(1.0, 0.0, cloud.profileShape);
  if (cloud.weatherMapEnabled > 0.5) {
    let wuv = worldToWeatherUV(worldPos);
    let wsample = textureSampleLevel(weatherTex, weatherSampler, wuv, 0, 0.0);
    effectiveCoverage = clamp(wsample.r * cloud.weatherStrength, 0.0, 1.0);
    wch = decodeWeatherChannels(wsample.gba, deckTop - deckBottom);
  }

  // SAME base as cloudDensity (baked or live), then coverage + height gradient,
  // and crucially NO erosion — so this oracle is >= cloudDensity everywhere
  // (W5's conservative `base >= full` invariant), in both the baked and live paths.
  var density: f32;
  if (noiseBakedEnabled()) {
    density = bakedBase(samplePos);
  } else {
    density = fbmNoise(samplePos);
  }
  density = smoothstep(1.0 - effectiveCoverage, 1.0, density);
  // V11 — IDENTICAL per-genus gradient + density scale as cloudDensity (no
  // erosion here), so the W5 `base >= full` invariant still holds per-genus.
  // Weather B/G — same base-shift + genus shape as cloudDensity.
  let hForGradient = clamp(
    (heightFraction - wch.baseShiftFrac) / max(1.0 - wch.baseShiftFrac, 1e-3),
    0.0, 1.0);
  let heightGradient = heightGradientFor(hForGradient, wch.perGenusShape, cloud.anvilBias);
  density *= heightGradient;
  // Weather A — same per-position density scale as cloudDensity.
  return density * cloud.densityMultiplier * cloud.profileDensityScale * wch.densityScale;
}

// ─── Ray-sphere intersection (sphere centered at the planet origin) ───
// RTE precision (Batch 412). The naive form `c = dot(ro,ro) - radius*radius`
// subtracts two ~4e13 f32 values (camera + shell are both ~6.4e6 m from the
// planet center), so the discriminant loses ~7 significant digits — a fuzzy /
// shimmering cloud-layer silhouette at grazing angles from altitude. This stable
// form (Haines et al., "Precision Improvements for Ray/Sphere Intersection",
// Ray Tracing Gems ch. 7) builds the closest-approach (perpendicular) vector
// FIRST and squares THAT, so dot(cp,cp) carries the small perpendicular distance
// without the big-number cancellation; the roots come back as tClosest ±
// halfChord (no -b + sqrtD cancellation). It returns the IDENTICAL (near, far)
// pair as the old form, just computed more precisely — every grazing ray wins,
// no view regresses.
//
// RESIDUAL (deferred): for near-RADIAL rays the geometry still needs
// `radius - |ro|` (a ~1e3 m difference of two ~6.4e6 m magnitudes), which f32
// can't fully resolve — removing THAT needs RTE high/low camera (DP emulation in
// WGSL). The residual is ~1 m and not visibly observed, so the full DP path
// stays deferred (NEW-WEBGPU-CLOUD-RTE) until a shimmer artifact is seen.
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

// Batch 445 (4.12 CLOUD-RTE) — is the camera-relative high-precision march active?
// (qualityFlags bit 12). When clear (DEFAULT), the closest-point f32 march runs
// verbatim → byte-identical. Set only when globe.cloudHighPrecision is opted in.
fn highPrecisionEnabled() -> bool {
  return (u32(cloud.qualityFlags) & QF_HIGH_PRECISION) != 0u;
}

// Batch 445 (4.12 CLOUD-RTE) — camera-relative ray/sphere intersection. The camera
// sits at the ORIGIN and the sphere center is supplied as a high/low f32 split
// (`centerHigh + centerLow` == the planet center relative to the camera, i.e.
// -cameraWorldPos). Same closest-point formulation as `raySphereIntersect`, but the
// closest-point vector is formed by subtracting the LARGE `centerHigh` term BEFORE
// the small `centerLow` refinement — this removes the residual near-radial f32
// cancellation that the world-space form suffers (`radius - |ro|` differencing two
// ~6.4e6 m magnitudes). Returns the SAME (near, far) t pair the world-space form
// would, just computed with reduced cancellation.
fn raySphereIntersectRTE(
  rd: vec3<f32>,
  centerHigh: vec3<f32>,
  centerLow: vec3<f32>,
  radius: f32,
) -> vec2<f32> {
  // t at the ray's closest approach to the center: dot(rd, center).
  let tClosest = dot(rd, centerHigh) + dot(rd, centerLow);
  // Closest-point offset from the center, formed RTE: subtract the big high term
  // first, then refine with the low term, so the large magnitudes cancel in f32
  // before the small residual is added.
  let cp = (rd * tClosest - centerHigh) - centerLow;
  let halfChordSq = radius * radius - dot(cp, cp);
  if (halfChordSq < 0.0) {
    return vec2<f32>(-1.0);
  }
  let halfChord = sqrt(halfChordSq);
  return vec2<f32>(tClosest - halfChord, tClosest + halfChord);
}

// Batch 445 (4.12 CLOUD-RTE) — radial distance |rd*t - center| computed RTE with the
// high/low center split, so the camera altitude / sample altitude (`length(...) -
// planetRadius`, the term that loses precision near-radially) is resolved with the
// large `centerHigh` subtracted before the small `centerLow` refinement.
fn rteRadialDistance(
  point: vec3<f32>,        // rd*t — the along-ray position relative to the camera
  centerHigh: vec3<f32>,
  centerLow: vec3<f32>,
) -> f32 {
  return length((point - centerHigh) - centerLow);
}

// ─── Henyey-Greenstein phase function ───
fn hgPhase(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

// ─── Dual-lobe phase function (forward + back scatter) ───
// W1 — uniform-driven so the lobes are tunable (and W3 can modulate them by
// time-of-day). The forward lobe (phaseG1) is the silver lining toward the sun;
// the back lobe (phaseG2) fills the anti-sun side; phaseBlend mixes them.
fn cloudPhase(cosTheta: f32) -> f32 {
  let forward = hgPhase(cosTheta, cloud.phaseG1);
  let back = hgPhase(cosTheta, cloud.phaseG2);
  return mix(back, forward, cloud.phaseBlend);
}

// Batch 436 (3.6 CLOUD-CONE-LIGHT) — is the Schneider/Nubis cone-sampled light
// march active? (qualityFlags bit 10). T1/T2 set it; T3 cinematic + the escape
// hatch leave it clear → the straight march below runs verbatim (byte-identical).
fn lightConeEnabled() -> bool {
  return (u32(cloud.qualityFlags) & QF_LIGHT_CONE) != 0u;
}

// Batch 436 — fixed 6-tap cone kernel (Schneider, "Real-Time Volumetric
// Cloudscapes of Horizon Zero Dawn", SIGGRAPH 2015 / Nubis 2017). Five short
// taps marching toward the sun, each pushed sideways by a UNIT offset so the
// sampled positions FAN OUT into a cone — the cone captures more of the occluding
// cloud body (the parts that shadow the sample but don't lie on the exact
// sun ray) with far fewer taps than a dense straight march. The offsets are a
// small irregular set on the unit sphere; they're scaled per-tap by an
// increasing radius and jittered per-pixel (see lightMarchCone) so the sparse
// taps don't band. The 6th step is ONE LONG far tap (handled separately) using
// the cheap `cloudBaseDensity` oracle to fold in distant self-shadowing.
const CONE_KERNEL: array<vec3<f32>, 5> = array<vec3<f32>, 5>(
  vec3<f32>( 0.38051787,  0.92453268,  0.02111722),
  vec3<f32>( 0.35578787, -0.55155486, -0.75555583),
  vec3<f32>(-0.52047277,  0.05818154,  0.65454095),
  vec3<f32>( 0.11607481, -0.81293669,  0.51585301),
  vec3<f32>(-0.85181792, -0.15296098,  0.34155418)
);

// Batch 436 — per-pixel/per-frame cone jitter. Pairs cleanly with the half-res
// temporal accumulation: rotating the cone slightly each frame (frameCounter) and
// per screen position decorrelates the sparse 5-tap pattern so the temporal
// resolve averages out the under-sampling instead of locking in a fixed bias.
// Returns a small unit-length vector used to perturb the kernel offsets.
fn coneJitter(pos: vec3<f32>) -> vec3<f32> {
  let seed = pos * 0.013 + vec3<f32>(cloud.frameCounter * 0.61803399);
  return hash33(seed) - vec3<f32>(0.5);
}

// Batch 436 — Schneider 6-tap cone light march. Sums optical depth from 5 short
// cone-offset taps (full eroded `cloudDensity`) plus 1 long far tap (cheap
// `cloudBaseDensity` oracle) toward the sun. Returns an optical depth in the SAME
// units as the straight march (density × marched-length), so it feeds the SAME
// beer-powder / multi-scatter / HG lighting model unchanged — only the SAMPLING
// PATTERN differs. ~½ the cost: 6 taps (5 full + 1 cheap) vs the straight march's
// `lightSteps` full taps per cone radius.
fn lightMarchCone(pos: vec3<f32>, heightFraction: f32, deckBottom: f32, deckTop: f32) -> f32 {
  let sunDir = normalize(cloud.sunDirection);
  let innerR = cloud.planetRadius + deckBottom;
  let outerR = cloud.planetRadius + deckTop;
  let layerThickness = outerR - innerR;

  // Base step toward the sun. The straight march walked `steps` of `layerThickness/
  // steps`; the cone covers the same near-shadow span with 5 geometrically-growing
  // steps. lightSampleScale stays the tier cost lever (T1/T2 = 0.5 → tighter cone).
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
  // 5 short cone taps. Step distance and cone radius BOTH grow with i, so the taps
  // sweep a widening cone toward the sun. Each tap reads the FULL density.
  for (var i: i32 = 0; i < 5; i = i + 1) {
    let fi = f32(i);
    let marchDist = coneStepBase * (fi + 1.0);
    let k = CONE_KERNEL[i] + jit * 0.4;          // per-pixel jittered offset
    let coneRadius = coneStepBase * (fi + 0.5);  // widening cone
    let lateral = (k.x * tangent + k.y * bitangent) * coneRadius;
    let samplePos = pos + sunDir * marchDist + lateral;
    let altitude = length(samplePos) - cloud.planetRadius;
    let hf = clamp((altitude - deckBottom) / layerThickness, 0.0, 1.0);
    // Weight each tap by its marched extent so the summed optical depth is
    // dimensionally the same as the straight march's Σ density·stepSize.
    opticalDepth += cloudDensity(samplePos, hf, deckBottom, deckTop) * coneStepBase;
  }

  // ONE LONG FAR TAP — captures distant self-shadowing the short cone can't reach,
  // using the CHEAP base-density oracle (no Worley / detail fetches). `cloudBaseDensity`
  // is conservative (base >= full), so this slightly OVER-shadows the far term —
  // exactly the desired soft far self-occlusion at a fraction of a full tap's cost.
  let farDist = layerThickness * 1.5;
  let farPos = pos + sunDir * farDist;
  let farAlt = length(farPos) - cloud.planetRadius;
  let farHf = clamp((farAlt - deckBottom) / layerThickness, 0.0, 1.0);
  opticalDepth += cloudBaseDensity(farPos, farHf, deckBottom, deckTop) * coneStepBase * 3.0;

  return opticalDepth;
}

// ─── Light march: compute optical depth toward sun ───
// Batch 436 — dispatch: the cone path (T1/T2) when QF_LIGHT_CONE is set, else the
// STRAIGHT N-step march below, kept VERBATIM so the default / cinematic / escape
// hatch render byte-identical to pre-436.
fn lightMarch(pos: vec3<f32>, heightFraction: f32, deckBottom: f32, deckTop: f32) -> f32 {
  if (lightConeEnabled()) {
    return lightMarchCone(pos, heightFraction, deckBottom, deckTop);
  }
  let sunDir = normalize(cloud.sunDirection);
  // V5 — scale the light-march step count by the tier's lightSampleScale (T3 = 1.0
  // → unchanged; lower tiers march fewer, bigger steps for ~the same optical depth
  // at lower cost). lightSteps is the EXPONENTIAL cost knob, so this is the cheap
  // lever for the low tiers.
  let steps = max(1, i32(cloud.lightSteps * cloud.lightSampleScale));
  let innerR = cloud.planetRadius + deckBottom;
  let outerR = cloud.planetRadius + deckTop;
  let layerThickness = outerR - innerR;

  // March toward sun through remaining cloud
  let stepSize = layerThickness / f32(steps);
  var opticalDepth: f32 = 0.0;

  for (var i: i32 = 0; i < steps; i++) {
    let samplePos = pos + sunDir * f32(i + 1) * stepSize;
    let altitude = length(samplePos) - cloud.planetRadius;
    let hf = clamp((altitude - deckBottom) / layerThickness, 0.0, 1.0);
    opticalDepth += cloudDensity(samplePos, hf, deckBottom, deckTop) * stepSize;
  }

  return opticalDepth;
}

// ─── Beer-Powder approximation for cloud lighting ───
fn beerPowder(opticalDepth: f32, powder: f32) -> f32 {
  let beer = exp(-opticalDepth * cloud.absorptionCoeff);
  let powderEffect = 1.0 - exp(-opticalDepth * cloud.absorptionCoeff * 2.0);
  return mix(beer, beer * powderEffect, powder);
}

// ─── Cheap multi-octave multi-scatter (379c) ───
// Schneider/Nubis approximation: sum N Beer-Powder octaves with progressively
// LESS extinction and lower contribution, so deep cloud interiors receive a soft
// residual glow instead of going pure black (single-scatter Beer alone). The sum
// is NORMALIZED by the total contribution so a THIN cloud (every octave ≈ 1)
// returns ≈ 1.0 — this CANNOT over-brighten (the analogue of the 379a
// over-densification failure); it only lifts the dark deep-cloud tail.
// V5 — Frostbite art-directable multiple scattering. N octaves with GEOMETRIC
// decay of scattering (a^i), extinction (b^i), and phase eccentricity (c^i), with
// the dual-lobe phase FOLDED PER-OCTAVE: deeper octaves are dimmer, less
// extinguished (so interiors keep a residual glow instead of going black), AND
// more ISOTROPIC (the phase peak relaxes) — the soft lit-from-within look. The
// returned value already includes the phase (the caller no longer multiplies by
// it). Normalized by the scattering sum so a THIN cloud returns ≈ the phase
// (cannot over-brighten). `octaves` is tier-driven (qualityFlags bits 4-6).
fn multiScatterLight(opticalDepth: f32, cosTheta: f32, powder: f32, octaves: i32) -> f32 {
  let a = cloud.msDecayA; // MS_SCATTER_DECAY — contribution per octave (Batch 407 dial, default 0.5)
  let b = cloud.msDecayB; // MS_EXTINCTION_DECAY — extinction per octave (default 0.5)
  let c = cloud.msDecayC; // MS_PHASE_DECAY — eccentricity per octave (default 0.85, gentle: keeps T3 ≈ prior)
  let n = max(octaves, 1);
  var luminance: f32 = 0.0;
  var total: f32 = 0.0;
  var scat: f32 = 1.0;
  var ext: f32 = 1.0;
  var ecc: f32 = 1.0;
  for (var i: i32 = 0; i < n; i = i + 1) {
    let beer = exp(-opticalDepth * cloud.absorptionCoeff * ext);
    let powderEffect = 1.0 - exp(-opticalDepth * cloud.absorptionCoeff * 2.0 * ext);
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

// ─── Reconstruct world-space ray from UV ───
fn getWorldRay(uv: vec2<f32>) -> vec3<f32> {
  let ndc = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
  var viewDir = cloud.inverseProjection * ndc;
  viewDir.w = 0.0;
  let worldDir = cloud.inverseView * viewDir;
  return normalize(worldDir.xyz);
}

// Batch 409 — reverse the renderer-wide LOGARITHMIC depth to a positive
// eye-space distance along the view ray (metres). Byte-compatible with
// csm_reverseLogDepthToEyeDistance / AerialPerspective.wgsl::logDepthToEyeDistance.
fn logDepthToEyeDistance(logZ: f32, near: f32, far: f32) -> f32 {
  let log2FarDepthFromNearPlusOne = log2((far - near) + 1.0);
  let depthFromNear = exp2(logZ * log2FarDepthFromNearPlusOne) - 1.0;
  return depthFromNear + near;
}

// ─── Batch 434 — atmosphere-LUT coupling helpers ───
// 3.3 + 3.4 sample the SAME precomputed LUTs the SkyAtmosphere shader uses, with
// the IDENTICAL (U, V) parameterization (so the cloud air-light / ambient agree
// with the visible sky dome). The two sky-domain helpers are copied verbatim from
// SkyAtmosphere.wgsl::sampleSkyViewLut / sampleMultipleScatterLut; the transmittance
// helper mirrors AerialPerspective.wgsl::sampleTransmittance.

// 3.3 physical aerial — sun-relative SKY-VIEW single-scatter inscatter (the
// in-between air light). U = relativeAzimuth(view, sun)/π; V = Hillaire horizon
// warp of cosViewZenith. `up` is the local vertical at the sample point.
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

// 3.4 sky-coupled ambient — sun-relative MULTIPLE-SCATTERING sky radiance, same
// sun-relative sky-view domain as cloudSampleSkyViewLut (Batch 429 re-baked the MS
// LUT onto that domain). Sampling the UP hemisphere gives the diffuse sky fill that
// lights cloud TOPS; the DOWN hemisphere gives the ground-bounce fill for BOTTOMS.
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

// 3.3 transmittance — Bruneton TRANSMITTANCE LUT (altitude × cosZenith). Mirrors
// AerialPerspective.wgsl::sampleTransmittance: u = (cosZenith+1)/2, v = altitude /
// thickness. Returns the multiplicative extinction along the path to the top of
// atmosphere from a point at `altitude` looking along `cosZenith` (cos angle to up).
fn cloudSampleTransmittance(altitude: f32, cosZenith: f32) -> vec3<f32> {
  let thickness = cloud.atmosphereThickness;
  let u = clamp(cosZenith * 0.5 + 0.5, 0.0, 1.0);
  let v = clamp(altitude / max(thickness, 1.0), 0.0, 1.0);
  return textureSampleLevel(cloudTransmittanceLut, cloudLutSampler, vec2<f32>(u, v), 0.0).rgb;
}

// Cheap luminance — used as the unbaked-LUT sentinel (an all-zero LUT reads ~0, so
// the physical/sky-LUT branches self-heal to the legacy path).
fn cloudLutLuminance(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// Batch 443 (4.9 CLOUD-MULTIDECK) — per-deck march result. `hazed` is the LDR
// tone-mapped + aerial-hazed cloud color for THIS deck; `alpha` = 1 - transmittance
// (the deck's coverage). For the default single shell these are byte-identical to
// the legacy fragmentMain locals of the same name; the front-to-back composite then
// reproduces the legacy `mix(sceneColor, hazed, cloudAlpha)` exactly.
struct DeckResult {
  hazed: vec3<f32>,
  alpha: f32,
};

// Batch 443 — march ONE cloud shell [deckBottom, deckTop] along the view ray and
// return its tone-mapped + aerial-hazed color + alpha. This is the LEGACY
// fragmentMain march body, verbatim, with the hardcoded `cloud.cloudLayerBottom/
// Top` replaced by the `deckBottom/Top` parameters (so a call with the default
// bounds is byte-identical to pre-443) and the scene-composite tail lifted out to
// the caller (the caller composites — single shell or front-to-back). A ray that
// misses the shell, or whose layer is fully occluded by depth, returns alpha 0
// (transparent → contributes nothing to the composite).
fn marchDeck(
  rayOrigin: vec3<f32>,
  rayDir: vec3<f32>,
  sceneDepth: f32,
  deckBottom: f32,
  deckTop: f32,
  msOctaves: i32,
  centerHigh: vec3<f32>,
  centerLow: vec3<f32>,
) -> DeckResult {
  var result: DeckResult;
  result.hazed = vec3<f32>(0.0);
  result.alpha = 0.0;

  // Cloud shell radii
  let innerR = cloud.planetRadius + deckBottom;
  let outerR = cloud.planetRadius + deckTop;

  // Intersect ray with cloud shell. Batch 445 (4.12 CLOUD-RTE): the high-precision
  // branch intersects spheres about the camera-relative center (high/low split) so
  // the large camera magnitude cancels before the small refinement; the default
  // branch is the verbatim world-space form (byte-identical when the bit is clear).
  var tInner: vec2<f32>;
  var tOuter: vec2<f32>;
  if (highPrecisionEnabled()) {
    tInner = raySphereIntersectRTE(rayDir, centerHigh, centerLow, innerR);
    tOuter = raySphereIntersectRTE(rayDir, centerHigh, centerLow, outerR);
  } else {
    tInner = raySphereIntersect(rayOrigin, rayDir, innerR);
    tOuter = raySphereIntersect(rayOrigin, rayDir, outerR);
  }

  // No intersection with the shell — transparent (no contribution).
  if (tOuter.x < 0.0 && tOuter.y < 0.0) {
    return result;
  }

  // Determine march start/end. Batch 445: the high-precision branch computes the
  // camera altitude from the RTE radial distance (camera at the origin → point 0).
  var cameraAltitude: f32;
  if (highPrecisionEnabled()) {
    cameraAltitude = rteRadialDistance(vec3<f32>(0.0), centerHigh, centerLow) - cloud.planetRadius;
  } else {
    cameraAltitude = length(rayOrigin) - cloud.planetRadius;
  }
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

  // Batch 409 — DEPTH OCCLUSION. Stop the march at opaque scene geometry (the
  // globe / terrain / tiles) so clouds don't render THROUGH the Earth. sceneDepth
  // is the renderer-wide log depth; reverse it to an along-ray eye distance and
  // clamp tEnd. Sky pixels carry the cleared far depth (>= skyCutoff) → tSceneHit
  // ≈ far → no clamp, so the full sky shell still marches. If terrain sits in
  // front of the whole layer, tEnd clamps below tStart and the early-out below
  // returns transparent (clouds fully occluded). No depth WRITE — clouds are a
  // translucent over-composite.
  if (sceneDepth < 0.999999) {
    let tSceneHit = logDepthToEyeDistance(sceneDepth, cloud.nearPlane, cloud.farPlane);
    tEnd = min(tEnd, tSceneHit);
  }

  if (tStart >= tEnd || tEnd <= 0.0) {
    return result; // transparent (this deck contributes nothing)
  }

  // Cloud march
  let steps = i32(cloud.maxSteps);
  let sunDir = normalize(cloud.sunDirection);
  let cosTheta = dot(rayDir, sunDir);
  let layerThickness = deckTop - deckBottom;

  // W5 — adaptive coarse→fine march (empty-space skipping). A CHEAP, smooth,
  // conservative low-detail density (`cloudBaseDensity` — no Worley, no detail)
  // is the skip oracle: march coarse jumps through empty space probing ONLY the
  // base shape; on the first base hit, back up one coarse step and refine to
  // FINE_RATIO-smaller steps; snap back to coarse only once the BASE shape is
  // gone — never inside an erosion pocket (where full density is 0 but the cloud
  // continues), which is what truncated clouds when a full-density test drove the
  // skip. Fine samples integrate the FULL eroded density at the SAME cadence and
  // grid as the old fixed march (fineStep == old stepSize, and the back-up keeps
  // the fine grid aligned to tStart + k·fineStep), so the image is preserved; the
  // win is replacing full taps over empty space with cheap base taps at 1/4 the
  // count. `maxSteps` still governs the fine budget.
  let fineStep = (tEnd - tStart) / f32(steps); // == old fixed stepSize (preserves image)
  let coarseStep = fineStep * 4.0;             // FINE_RATIO = 4

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

  loop {
    if (t >= tEnd) { break; }
    if (transmittance < 0.01) { break; }
    guard = guard + 1;
    if (guard > maxIter) { break; }

    let curStep = select(coarseStep, fineStep, fine);
    let samplePos = rayOrigin + rayDir * (t + 0.5 * curStep);
    // Batch 445 (4.12 CLOUD-RTE): resolve the SAMPLE altitude (the precision-sensitive
    // `length(...) - planetRadius` term) in camera-relative RTE space when on. The
    // along-ray offset from the camera is `rayDir * (t + 0.5*curStep)`. `samplePos`
    // (the world-space noise-domain coordinate) is left UNCHANGED so the noise lookups
    // stay byte-identical — only the altitude math gains precision.
    var altitude: f32;
    if (highPrecisionEnabled()) {
      altitude = rteRadialDistance(rayDir * (t + 0.5 * curStep), centerHigh, centerLow) - cloud.planetRadius;
    } else {
      altitude = length(samplePos) - cloud.planetRadius;
    }
    let heightFraction = clamp(
      (altitude - deckBottom) / layerThickness, 0.0, 1.0
    );

    // Cheap conservative presence test (base >= full, so this never skips real
    // cloud) drives the coarse/fine state.
    let base = cloudBaseDensity(samplePos, heightFraction, deckBottom, deckTop);

    if (!fine) {
      // Coarse skip. On the first base hit, step back one coarse step (clamped to
      // tStart so the near cloud edge isn't read before the layer) and refine.
      if (base > 0.0001) {
        fine = true;
        emptyRun = 0;
        // Back up one coarse step to catch the cloud edge the coarse sample
        // stepped over — but never below tProcessed, so the march can't stall by
        // re-entering an already-examined span (the cause of early-out + empty).
        t = max(t - coarseStep, tProcessed);
        continue;
      }
      t = t + coarseStep;
      continue;
    }

    // Fine phase. Snap back to coarse only once the BASE shape has been gone for
    // EMPTY_RUN samples — base is smooth, so this fires when we truly leave the
    // cloud, not inside an erosion pocket (base>0, full density 0).
    if (base <= 0.0001) {
      emptyRun = emptyRun + 1;
      if (emptyRun >= 2) { // EMPTY_RUN = 2 (base is reliable; no long confirm needed)
        fine = false;
        emptyRun = 0;
      }
      t = t + fineStep;
      tProcessed = t;
      continue;
    }
    emptyRun = 0;

    // Inside the cloud shape — integrate the FULL (eroded) density. An erosion
    // pocket (full density 0) contributes nothing but keeps us in the fine phase.
    let density = cloudDensity(samplePos, heightFraction, deckBottom, deckTop);
    if (density > 0.001) {
      // Light contribution. V5 — Frostbite multi-scatter octaves with the phase
      // folded per-octave (softer lit-from-within interiors; deeper octaves more
      // isotropic) so the returned value already carries the phase.
      let lightOpticalDepth = lightMarch(samplePos, heightFraction, deckBottom, deckTop);
      let msLight = multiScatterLight(lightOpticalDepth, cosTheta, 0.5, msOctaves);

      // Silver lining: enhanced scattering at cloud edges
      let silverLining = cloud.silverLiningIntensity
                       * pow(clamp(1.0 - density * 3.0, 0.0, 1.0), 2.0);

      let scatteredLight = (msLight + silverLining) * cloud.sunIntensity;

      // Height-based color gradient (darker base, brighter top)
      let cloudColor = mix(cloud.cloudBaseColor, cloud.cloudTopColor, heightFraction);

      // Accumulate
      let sampleTransmittance = exp(-density * fineStep * cloud.absorptionCoeff);
      let sampleWeight = (1.0 - sampleTransmittance) * transmittance;

      // W2 — sky-ambient gradient + ground bounce. The blue sky lights the cloud
      // TOPS (heightFraction -> 1) and the warm ground bounce lights the BOTTOMS
      // (-> 0), so the anti-sun shadow side reads as soft grey-blue instead of
      // near-black. Part of the HDR radiance, so it tone-maps with the sun term.
      //
      // Batch 434 (3.4 CLOUD-AMBIENT-LUT) — when `ambientLutMode` is set AND the MS
      // sky LUT is baked, REPLACE the constant blue/grey lerp with the real
      // time-of-day sky radiance: sample the multiple-scattering sky LUT in the UP
      // hemisphere for the sky fill (cloud tops) and the DOWN hemisphere for the
      // ground bounce (cloud bottoms), then lerp by heightFraction exactly as the
      // constant path does. Self-heals to the constant lerp when the LUT reads ~0.
      var skyAmbColor = cloud.skyAmbientColor;
      var groundAmbColor = cloud.groundAmbientColor;
      if ((u32(cloud.qualityFlags) & QF_AMBIENT_LUT) != 0u) {
        let localUp = normalize(samplePos);
        // Total sky radiance in each hemisphere = sun-relative single-scatter
        // sky-view + the multiple-scattering residual (both share the same
        // sky-view domain). The single-scatter term carries the WARM sunset / cool
        // noon color; MS adds the diffuse fill. The UP hemisphere lights the cloud
        // TOPS, DOWN the ground-bounce BOTTOMS.
        let skyHDR =
          cloudSampleSkyViewLut(localUp, localUp, sunDir)
          + cloudSampleMultipleScatterLut(localUp, localUp, sunDir);
        let skyLum = cloudLutLuminance(skyHDR);
        if (skyLum > 1e-5) {
          let groundHDR =
            cloudSampleSkyViewLut(localUp, -localUp, sunDir)
            + cloudSampleMultipleScatterLut(localUp, -localUp, sunDir);
          let groundLum = max(cloudLutLuminance(groundHDR), 1e-5);
          // Replace ONLY the ambient COLOR (hue/chroma) with the real sky's, keeping
          // each constant ambient's nominal BRIGHTNESS — so `ambientIntensity` stays
          // the magnitude knob (no blowout, parity-preserving energy) while the tint
          // tracks the true time-of-day sky: warm undersides at sunset, blue at noon.
          skyAmbColor = (skyHDR / skyLum) * cloudLutLuminance(cloud.skyAmbientColor);
          groundAmbColor = (groundHDR / groundLum) * cloudLutLuminance(cloud.groundAmbientColor);
        }
      }
      let ambient = mix(groundAmbColor, skyAmbColor, heightFraction)
                  * cloud.ambientIntensity;

      // W3 — tint the direct-sun term by the time-of-day sun color (warm near the
      // horizon, neutral at noon). Ambient keeps its own sky/ground color.
      weightedColor += (cloudColor * cloud.sunLightColor * scatteredLight + ambient)
                     * sampleWeight;
      lightEnergy += scatteredLight * sampleWeight;
      totalDensity += density * fineStep;
      transmittance *= sampleTransmittance;
    }

    t = t + fineStep;
    tProcessed = t;
  }

  // W1 — HDR tone-map the accumulated cloud radiance before compositing. The
  // dual-lobe phase peaks ~6x at the forward lobe and is multiplied by
  // sunIntensity (~10), so the radiance is HDR (peaks ~20-30) and was clipping
  // EVERY cloud to flat white — hiding the silver lining and, more importantly,
  // every lighting term the rest of Arc A adds (ambient, time-of-day, aerial).
  // Exposure + Reinhard maps it to [0,1) so the bright sun-facing edges read as
  // a rim over a darker body (the silver lining) instead of a white-out.
  let exposed = weightedColor * cloud.exposure;
  let toneMapped = exposed / (exposed + vec3<f32>(1.0));

  // W4 — aerial perspective. Distant clouds lose contrast and tint toward the
  // atmosphere inscatter color; without it far clouds keep their full white and
  // "pop" against the hazed horizon. Key the haze on the march MIDPOINT distance
  // (tStart + 0.5*(tEnd-tStart)), NOT tStart alone: from below the layer tStart
  // collapses to ~0 for every pixel, so keying on it would haze by view angle
  // rather than true range. Both operands are LDR (post-tonemap color vs the
  // packed horizon tint), so the lerp stays in display space. 60 km ≈ horizon
  // haze scale; cap at 0.85 so the densest near clouds never fully dissolve.
  let midDist = tStart + 0.5 * (tEnd - tStart);
  let aerial = clamp(midDist / 60000.0 * cloud.aerialStrength, 0.0, 0.85);
  // Legacy heuristic haze — the default ('heuristic') path runs this VERBATIM.
  var hazed = mix(toneMapped, cloud.aerialColor, aerial);

  // Batch 434 (3.3 CLOUD-AERIAL-LUT) — PHYSICAL aerial perspective. When
  // `aerialLutMode` is set AND the atmosphere LUTs are baked, replace the flat-tint
  // lerp with a real inscatter + transmittance lookup at the march MIDPOINT:
  //   - transmittance(midpoint altitude, view cosZenith) ATTENUATES the cloud color
  //     toward the horizon (distant clouds dim + redden like real aerial perspective),
  //   - the sun-relative SKY-VIEW inscatter LUT adds the in-between AIR LIGHT (warm
  //     toward a low sun, cooler away), scaled by the same midpoint-range fraction as
  //     the heuristic so the near deck stays crisp and the far deck dissolves into
  //     the true sky color.
  // Self-heals to the heuristic `hazed` when the sky-view LUT reads ~0 (unbaked).
  if ((u32(cloud.qualityFlags) & QF_AERIAL_LUT) != 0u) {
    let midPos = rayOrigin + rayDir * midDist;
    let midUp = normalize(midPos);
    let inscatterHDR = cloudSampleSkyViewLut(midUp, rayDir, sunDir);
    if (cloudLutLuminance(inscatterHDR) > 1e-5) {
      // Batch 445 (4.12 CLOUD-RTE): refine the midpoint altitude in RTE space when on
      // (`midPos` world coord kept for `midUp`/the LUT sun-relative domain).
      var midAltitude: f32;
      if (highPrecisionEnabled()) {
        midAltitude = rteRadialDistance(rayDir * midDist, centerHigh, centerLow) - cloud.planetRadius;
      } else {
        midAltitude = length(midPos) - cloud.planetRadius;
      }
      let midCosZenith = dot(rayDir, midUp);
      let trans = cloudSampleTransmittance(max(midAltitude, 0.0), midCosZenith);
      // The sky-view LUT radiance is in the SAME pre-tonemap HDR space the sky dome
      // uses (SkyAtmosphere tone-maps it AFTER sampling). The cloud's `toneMapped`
      // is already LDR, so bring the inscatter into the cloud's display space with
      // the SAME Reinhard+exposure operator before compositing — otherwise the HDR
      // air light blows the far clouds to white. (Hue ratios survive Reinhard, so
      // the warm-toward-sun / cool-away directionality — the whole point — is kept.)
      let inscatterExposed = inscatterHDR * cloud.exposure;
      let inscatterLDR = inscatterExposed / (inscatterExposed + vec3<f32>(1.0));
      // Energy-correct aerial perspective: the air light FILLS exactly the fraction
      // of cloud radiance lost to extinction (avgTrans), so the far target is a
      // convex blend of attenuated cloud + sky air light — BOUNDED in [0,1], never a
      // white-out. `aerial` (the same 0..0.85 midpoint-range fraction the heuristic
      // uses) ramps from crisp near cloud to fully-fogged far cloud.
      let avgTrans = (trans.r + trans.g + trans.b) / 3.0;
      let farTarget = toneMapped * trans + inscatterLDR * (1.0 - avgTrans);
      hazed = mix(toneMapped, farTarget, aerial);
    }
  }

  result.hazed = hazed;
  result.alpha = 1.0 - transmittance;
  return result;
}

// Batch 443 (4.9 CLOUD-MULTIDECK) — is the multi-deck shell march active?
// (qualityFlags bit 11). When clear (DEFAULT), fragmentMain marches EXACTLY ONE
// shell with cloud.cloudLayerBottom/Top + the legacy composite → byte-identical.
fn multiDeckEnabled() -> bool {
  return (u32(cloud.qualityFlags) & QF_MULTI_DECK) != 0u;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // V9 (Batch 432) — half-res jitter. In the half-res path each output texel
  // covers a 2×2 full-res block; offset the marched ray within that texel by a
  // per-frame Bayer pattern so consecutive frames (and neighbouring half-res
  // texels via the bilateral upscale) sample DIFFERENT sub-pixel positions,
  // decorrelating the under-sampling. `cloud.resolution` here is the HALF-RES
  // target size, so one texel = (1/halfW, 1/halfH) in UV; the Bayer offset stays
  // within ±0.5 texel. Full-res path: no jitter (resolution = full canvas, bit
  // clear), so `uv` is byte-identical to the legacy `input.uv`.
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

  // Batch 445 (4.12 CLOUD-RTE) — the planet center relative to the camera is
  // -cameraWorldPos, supplied as a high/low split so `marchDeck`'s high-precision
  // branch can subtract the large term before the small refinement. Cheap to form
  // unconditionally (a negate); `marchDeck` only READS it when the bit is set, so
  // the OFF path is byte-identical.
  let centerHigh = -cloud.encodedCameraHigh;
  let centerLow = -cloud.encodedCameraLow;

  // V5 — multi-scatter octave count from qualityFlags bits 4-6 (tier-driven:
  // T1=2, T2/T3=3). The dual-lobe phase is folded PER-OCTAVE inside
  // multiScatterLight, so it is not applied separately in the march.
  let msOctaves = i32((u32(cloud.qualityFlags) >> QF_OCTAVES_SHIFT) & 7u);

  if (!multiDeckEnabled()) {
    // ── DEFAULT single-shell path — byte-identical to pre-443. March exactly ONE
    // shell with today's bounds, then run the LEGACY composite verbatim. ──
    let r = marchDeck(
      rayOrigin, rayDir, sceneDepth,
      cloud.cloudLayerBottom, cloud.cloudLayerTop, msOctaves,
      centerHigh, centerLow,
    );
    let cloudAlpha = r.alpha;
    let hazed = r.hazed;

    // V9 (Batch 432) — half-res path: emit PREMULTIPLIED cloud radiance + alpha.
    if (halfResEnabled()) {
      return vec4<f32>(hazed * cloudAlpha, cloudAlpha);
    }
    // Full-res path — UNCHANGED legacy composite (byte-identical to pre-V9/443).
    let finalColor = mix(sceneColor.rgb, hazed, cloudAlpha);
    return vec4<f32>(finalColor, sceneColor.a);
  }

  // ── Batch 443 multi-deck path — march up to 3 shells (LOW/MID/HIGH) and
  // composite FRONT-TO-BACK with premultiplied alpha so the NEAR deck occludes the
  // FAR one (a low cumulus layer reads BENEATH a high cirrus veil). The decks are
  // ordered by their MEAN ALTITUDE relative to the camera height (front = closest
  // to the camera's vertical position) so the ordering is correct whether the
  // camera is below all decks (looking up: LOW first), between them, or above
  // (looking down: HIGH first). Front-to-back accumulation with an opaque
  // early-terminate (accAlpha >= 0.995) keeps the worst case at 3 marches and the
  // common case (a clear far deck, or full near coverage) far cheaper. The B (deck)
  // weather channel can later gate empty decks; for now each deck early-outs inside
  // marchDeck when the shell is missed / fully thin (alpha 0 → no contribution). ──
  // Batch 445 (4.12 CLOUD-RTE): refine the camera altitude (deck sort key) in RTE
  // space when on; default branch verbatim.
  var camAlt: f32;
  if (highPrecisionEnabled()) {
    camAlt = rteRadialDistance(vec3<f32>(0.0), centerHigh, centerLow) - cloud.planetRadius;
  } else {
    camAlt = length(rayOrigin) - cloud.planetRadius;
  }
  let midLow = 0.5 * (cloud.deckBoundsLow.x + cloud.deckBoundsLow.y);
  let midMid = 0.5 * (cloud.deckBoundsMid.x + cloud.deckBoundsMid.y);
  let midHigh = 0.5 * (cloud.deckBoundsHigh.x + cloud.deckBoundsHigh.y);

  // Distance of each deck's mid-altitude from the camera altitude = front-to-back
  // sort key (smaller = nearer the camera's vertical band = composited FIRST).
  let dLow = abs(camAlt - midLow);
  let dMid = abs(camAlt - midMid);
  let dHigh = abs(camAlt - midHigh);

  // Bounds + sort keys packed per deck so we can order them without dynamic arrays
  // of structs. index 0 = LOW, 1 = MID, 2 = HIGH.
  var bottoms = array<f32, 3>(cloud.deckBoundsLow.x, cloud.deckBoundsMid.x, cloud.deckBoundsHigh.x);
  var tops = array<f32, 3>(cloud.deckBoundsLow.y, cloud.deckBoundsMid.y, cloud.deckBoundsHigh.y);
  var keys = array<f32, 3>(dLow, dMid, dHigh);
  // Insertion-sort order[] by key ascending (front-to-back). 3 elements → trivial.
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
  // with running transmittance T *= (1-αᵢ). Premultiplied so a far deck seen
  // THROUGH a partly-covered near deck is attenuated by exactly (1 - nearAlpha) —
  // no double-darkening seam at the deck boundary.
  var accColor = vec3<f32>(0.0);
  var accAlpha: f32 = 0.0;
  var trans: f32 = 1.0;
  for (var k: i32 = 0; k < 3; k = k + 1) {
    if (trans < 0.005) { break; } // opaque — far decks fully occluded, early-out
    let di = order[k];
    let r = marchDeck(rayOrigin, rayDir, sceneDepth, bottoms[di], tops[di], msOctaves, centerHigh, centerLow);
    if (r.alpha <= 0.0) { continue; } // empty deck (missed shell / fully thin) — skip
    accColor += trans * r.alpha * r.hazed;
    accAlpha += trans * r.alpha;
    trans = trans * (1.0 - r.alpha);
  }

  // V9 (Batch 432) — half-res path: emit the PREMULTIPLIED multi-deck radiance +
  // composited alpha (same contract as the single-shell path; the bilateral
  // upscale over-composites against the scene). accColor is already premultiplied.
  if (halfResEnabled()) {
    return vec4<f32>(accColor, accAlpha);
  }
  // Full-res path — over-composite the premultiplied cloud stack onto the scene.
  let finalColor = sceneColor.rgb * (1.0 - accAlpha) + accColor;
  return vec4<f32>(finalColor, sceneColor.a);
}

// ─── Batch 437 (CLOUD-SHADOWS) — sun-view beer shadow map ───
// Rasterized from the SUN's orthographic view into a low-res single-channel target.
// For each shadow-map texel we reconstruct the world point on the cloud-shell
// MID plane that the texel's column passes through (via the sun-view inverse VP),
// then march the cloud DENSITY along the sun ray across the full shell thickness,
// accumulating OPTICAL DEPTH (Σ density·stepSize). Consumers project a world point
// into this map and read transmittance = exp(-opticalDepth·absorption): the cloud
// thickness between that point and the sun. Reuses `cloudDensity` so the cast
// shadow tracks the EXACT rendered cloud field (no separate fbm approximation).
//
// Clamp the accumulated optical depth (f16 target — keep it well under 65504 and in
// a range that exp() resolves; absorption is applied in the consumers so this stores
// the raw density·length integral).
@fragment
fn cloudShadowMain(input: VertexOutput) -> @location(0) f32 {
  let innerR = cloud.planetRadius + cloud.cloudLayerBottom;
  let outerR = cloud.planetRadius + cloud.cloudLayerTop;
  let layerThickness = max(outerR - innerR, 1.0);

  // Reconstruct the shell mid-plane world point this shadow texel covers. NDC z=0
  // is an arbitrary plane in the ortho frustum; we only need a ray ORIGIN on the
  // column, then we re-anchor it onto the shell by intersecting the sun ray with
  // the outer shell sphere. UV (0..1) → NDC (-1..1), WebGPU y-down → flip.
  let ndc = vec3<f32>(input.uv.x * 2.0 - 1.0, 1.0 - input.uv.y * 2.0, 0.0);
  let worldH = cloudShadow.sunViewInvVP * vec4<f32>(ndc, 1.0);
  let columnPoint = worldH.xyz / worldH.w;

  let sunDir = normalize(cloudShadow.sunDirAndSteps.xyz);
  // The sun ray travels TOWARD the surface as -sunDir (sunDir points to the sun).
  // March from the column's entry at the OUTER shell down through to the INNER shell.
  let rayDir = -sunDir;
  let tOuter = raySphereIntersect(columnPoint, rayDir, outerR);
  let tInner = raySphereIntersect(columnPoint, rayDir, innerR);
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
    let samplePos = columnPoint + rayDir * t;
    let altitude = length(samplePos) - cloud.planetRadius;
    let hf = clamp((altitude - cloud.cloudLayerBottom) / layerThickness, 0.0, 1.0);
    // Batch 443 — the shadow map stays SINGLE-SHELL (the cast shadow tracks the
    // primary cloud layer). Pass cloudLayerBottom/Top as the deck bounds so the
    // density evaluation is byte-identical to the pre-443 hardcoded call.
    opticalDepth += cloudDensity(samplePos, hf, cloud.cloudLayerBottom, cloud.cloudLayerTop) * stepSize;
  }
  // Clamp to keep the f16 store finite and the consumer's exp() in range. The
  // raw integral over a dense ~2.5 km shell with densityMultiplier~0.3 is O(10²-10³);
  // cap well under f16 max so a runaway density can't NaN the map.
  return clamp(opticalDepth, 0.0, 8000.0);
}
