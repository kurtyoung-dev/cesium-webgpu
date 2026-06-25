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
  _pad4c: f32,                   // 75 — reserved (V8 curlAmplitude)
  // 76-79 — split from the old `_padA` vec4 (byte-identical: 4 scalars on the
  // same 16-byte stride). Each named per the ratified D-2 table.
  frameCounter: f32,             // 76 — reserved (V6 jitter/temporal)
  curlFrequency: f32,            // 77 — reserved (V8 curl)
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

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

const PI: f32 = 3.14159265358979;
// W1 — exposure feeding the Reinhard tone-map at the cloud composite. Calibrated
// against sunIntensity~10 + the dual-lobe forward peak so the silver lining is a
// gradient, not a white-out. (A future batch may promote this to a uniform.)
const CLOUD_EXPOSURE: f32 = 0.22;

// V1 — `qualityFlags`@74 bit layout (declared; no path reads them yet — feature
// batches wire each: V3 noiseSource, V9 halfRes, V10 temporal, V6 jitter, V5
// octaves, V11 profile). Unpack with `u32(cloud.qualityFlags)`.
const QF_NOISE_BAKED: u32 = 1u;     // bit 0
const QF_HALF_RES: u32 = 2u;        // bit 1
const QF_TEMPORAL: u32 = 4u;        // bit 2
const QF_JITTER: u32 = 8u;          // bit 3
const QF_OCTAVES_SHIFT: u32 = 4u;   // bits 4-6
const QF_PROFILE_ON: u32 = 128u;    // bit 7

// ─── Full-screen triangle ───
@vertex
fn vertexMain(@builtin(vertex_index) vid: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32(i32(vid & 1u) * 2 - 1);
  let y = f32(i32(vid >> 1u) * 2 - 1);
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
  let SHAPE_SCALE = 0.45;
  let s = samplePos * SHAPE_SCALE;
  let w = textureSampleLevel(cloudDetailTex, cloudNoiseSampler, s * 0.32, 0.0).rgb;
  let uvw = s + (w - vec3<f32>(0.5)) * 0.5;
  return textureSampleLevel(cloudShapeTex, cloudNoiseSampler, uvw, 0.0).r;
}

fn cloudDensity(worldPos: vec3<f32>, heightFraction: f32) -> f32 {
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
  var effectiveCoverage = cloud.coverage;
  if (cloud.weatherMapEnabled > 0.5) {
    let wuv = worldToWeatherUV(worldPos);
    let wsample = textureSampleLevel(weatherTex, weatherSampler, wuv, 0, 0.0);
    effectiveCoverage = clamp(wsample.r * cloud.weatherStrength, 0.0, 1.0);
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

  // Height-based shaping: rounder tops, flat bottoms (anvil shape)
  let heightGradient = smoothstep(0.0, 0.15, heightFraction)
                     * smoothstep(1.0, 0.7, heightFraction);
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
    let detail = textureSampleLevel(cloudDetailTex, cloudNoiseSampler, samplePos * 5.0, 0.0);
    let worleyDetail = 1.0 - detail.r;
    let erosionLo = worleyDetail * cloud.erosionStrength * (1.0 - heightFraction);
    density = clamp(remap(density, erosionLo, 1.0, 0.0, 1.0), 0.0, 1.0);
  } else {
    // LIVE path FROZEN (W5): literal subtractive erosion, unchanged.
    let worleyDetail = worleyF1(samplePos * 5.0 + windOffset * 0.001);
    density -= worleyDetail * 0.18 * (1.0 - heightFraction);
    density = max(density, 0.0);
  }

  return density * cloud.densityMultiplier;
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
fn cloudBaseDensity(worldPos: vec3<f32>, heightFraction: f32) -> f32 {
  let windOffset = vec3<f32>(cloud.windDirection.x, 0.0, cloud.windDirection.y)
                   * cloud.windSpeed * cloud.time;
  let samplePos = (worldPos + windOffset) * 0.0003;

  var effectiveCoverage = cloud.coverage;
  if (cloud.weatherMapEnabled > 0.5) {
    let wuv = worldToWeatherUV(worldPos);
    let wsample = textureSampleLevel(weatherTex, weatherSampler, wuv, 0, 0.0);
    effectiveCoverage = clamp(wsample.r * cloud.weatherStrength, 0.0, 1.0);
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
  let heightGradient = smoothstep(0.0, 0.15, heightFraction)
                     * smoothstep(1.0, 0.7, heightFraction);
  density *= heightGradient;
  return density * cloud.densityMultiplier;
}

// ─── Ray-sphere intersection ───
fn raySphereIntersect(ro: vec3<f32>, rd: vec3<f32>, radius: f32) -> vec2<f32> {
  let b = dot(ro, rd);
  let c = dot(ro, ro) - radius * radius;
  let discriminant = b * b - c;
  if (discriminant < 0.0) { return vec2<f32>(-1.0); }
  let sqrtD = sqrt(discriminant);
  return vec2<f32>(-b - sqrtD, -b + sqrtD);
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

// ─── Light march: compute optical depth toward sun ───
fn lightMarch(pos: vec3<f32>, heightFraction: f32) -> f32 {
  let sunDir = normalize(cloud.sunDirection);
  // V5 — scale the light-march step count by the tier's lightSampleScale (T3 = 1.0
  // → unchanged; lower tiers march fewer, bigger steps for ~the same optical depth
  // at lower cost). lightSteps is the EXPONENTIAL cost knob, so this is the cheap
  // lever for the low tiers.
  let steps = max(1, i32(cloud.lightSteps * cloud.lightSampleScale));
  let innerR = cloud.planetRadius + cloud.cloudLayerBottom;
  let outerR = cloud.planetRadius + cloud.cloudLayerTop;
  let layerThickness = outerR - innerR;

  // March toward sun through remaining cloud
  let stepSize = layerThickness / f32(steps);
  var opticalDepth: f32 = 0.0;

  for (var i: i32 = 0; i < steps; i++) {
    let samplePos = pos + sunDir * f32(i + 1) * stepSize;
    let altitude = length(samplePos) - cloud.planetRadius;
    let hf = clamp((altitude - cloud.cloudLayerBottom) / layerThickness, 0.0, 1.0);
    opticalDepth += cloudDensity(samplePos, hf) * stepSize;
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
  let a = 0.5;  // MS_SCATTER_DECAY  — contribution per octave
  let b = 0.5;  // MS_EXTINCTION_DECAY — extinction per octave
  let c = 0.85; // MS_PHASE_DECAY — eccentricity per octave (gentle: keeps T3 ≈ prior)
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

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  let sceneColor = textureSample(colorTex, texSampler, uv);
  let sceneDepth = textureSampleLevel(depthTex, texSampler, uv, 0.0).r;

  let rayOrigin = cloud.cameraPosition;
  let rayDir = getWorldRay(uv);

  // Cloud shell radii
  let innerR = cloud.planetRadius + cloud.cloudLayerBottom;
  let outerR = cloud.planetRadius + cloud.cloudLayerTop;

  // Intersect ray with cloud shell
  let tInner = raySphereIntersect(rayOrigin, rayDir, innerR);
  let tOuter = raySphereIntersect(rayOrigin, rayDir, outerR);

  // No intersection with cloud shell
  if (tOuter.x < 0.0 && tOuter.y < 0.0) {
    return sceneColor;
  }

  // Determine march start/end
  let cameraAltitude = length(rayOrigin) - cloud.planetRadius;
  var tStart: f32;
  var tEnd: f32;

  if (cameraAltitude < cloud.cloudLayerBottom) {
    // Below clouds: start at inner sphere, end at outer
    tStart = max(tInner.y, 0.0);
    tEnd = tOuter.y;
  } else if (cameraAltitude > cloud.cloudLayerTop) {
    // Above clouds: start at outer sphere front, end at inner
    tStart = max(tOuter.x, 0.0);
    tEnd = tInner.x;
  } else {
    // Inside cloud layer
    tStart = 0.0;
    tEnd = tOuter.y;
  }

  if (tStart >= tEnd || tEnd <= 0.0) {
    return sceneColor;
  }

  // Cloud march
  let steps = i32(cloud.maxSteps);
  let sunDir = normalize(cloud.sunDirection);
  let cosTheta = dot(rayDir, sunDir);
  // V5 — multi-scatter octave count from qualityFlags bits 4-6 (tier-driven:
  // T1=2, T2/T3=3). The dual-lobe phase is now folded PER-OCTAVE inside
  // multiScatterLight, so it is no longer applied separately here.
  let msOctaves = i32((u32(cloud.qualityFlags) >> QF_OCTAVES_SHIFT) & 7u);
  let layerThickness = cloud.cloudLayerTop - cloud.cloudLayerBottom;

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
    let altitude = length(samplePos) - cloud.planetRadius;
    let heightFraction = clamp(
      (altitude - cloud.cloudLayerBottom) / layerThickness, 0.0, 1.0
    );

    // Cheap conservative presence test (base >= full, so this never skips real
    // cloud) drives the coarse/fine state.
    let base = cloudBaseDensity(samplePos, heightFraction);

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
    let density = cloudDensity(samplePos, heightFraction);
    if (density > 0.001) {
      // Light contribution. V5 — Frostbite multi-scatter octaves with the phase
      // folded per-octave (softer lit-from-within interiors; deeper octaves more
      // isotropic) so the returned value already carries the phase.
      let lightOpticalDepth = lightMarch(samplePos, heightFraction);
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
      let ambient = mix(cloud.groundAmbientColor, cloud.skyAmbientColor, heightFraction)
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
  let exposed = weightedColor * CLOUD_EXPOSURE;
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
  let hazed = mix(toneMapped, cloud.aerialColor, aerial);

  // Composite clouds over scene
  let cloudAlpha = 1.0 - transmittance;
  let finalColor = mix(sceneColor.rgb, hazed, cloudAlpha);

  return vec4<f32>(finalColor, sceneColor.a);
}
