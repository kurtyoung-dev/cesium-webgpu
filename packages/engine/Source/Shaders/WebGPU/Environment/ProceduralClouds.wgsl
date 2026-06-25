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
  _pad4a: f32,                   // 73 — reserved (W2 ambientIntensity)
  _pad4b: f32,                   // 74 — reserved (W9 curlAmplitude)
  _pad4c: f32,                   // 75 — reserved (W9 curlFrequency)
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

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

const PI: f32 = 3.14159265358979;
// W1 — exposure feeding the Reinhard tone-map at the cloud composite. Calibrated
// against sunIntensity~10 + the dual-lobe forward peak so the silver lining is a
// gradient, not a white-out. (A future batch may promote this to a uniform.)
const CLOUD_EXPOSURE: f32 = 0.22;

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

  // Base shape (large-scale FBM) — UNCHANGED value-noise base (the 379a-revert
  // lesson: do not Worley-remap the base; it over-densifies).
  var density = fbmNoise(samplePos);

  // Coverage threshold — shapes the clouds (per-position when the weather map is on)
  density = smoothstep(1.0 - effectiveCoverage, 1.0, density);

  // Height-based shaping: rounder tops, flat bottoms (anvil shape)
  let heightGradient = smoothstep(0.0, 0.15, heightFraction)
                     * smoothstep(1.0, 0.7, heightFraction);
  density *= heightGradient;

  // 379a (minimal) — high-frequency WORLEY edge erosion (was value-noise).
  // Subtractive only: carves billowy cauliflower lobes into the cloud edges
  // without raising the density floor. Erosion fades toward the cloud top so
  // bases stay detailed while tops round off.
  let worleyDetail = worleyF1(samplePos * 5.0 + windOffset * 0.001);
  density -= worleyDetail * 0.18 * (1.0 - heightFraction);
  density = max(density, 0.0);

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
  let steps = i32(cloud.lightSteps);
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
fn multiScatterLight(opticalDepth: f32, powder: f32) -> f32 {
  var luminance: f32 = 0.0;
  var total: f32 = 0.0;
  var atten: f32 = 1.0;   // extinction multiplier per octave (×0.5 each)
  var contrib: f32 = 1.0; // contribution per octave (×0.5 each)
  for (var i: i32 = 0; i < 3; i++) {
    let beer = exp(-opticalDepth * cloud.absorptionCoeff * atten);
    let powderEffect = 1.0 - exp(-opticalDepth * cloud.absorptionCoeff * 2.0 * atten);
    luminance += contrib * mix(beer, beer * powderEffect, powder);
    total += contrib;
    atten *= 0.5;
    contrib *= 0.5;
  }
  return luminance / total;
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
  let stepSize = (tEnd - tStart) / f32(steps);
  let sunDir = normalize(cloud.sunDirection);
  let cosTheta = dot(rayDir, sunDir);
  let phase = cloudPhase(cosTheta);
  let layerThickness = cloud.cloudLayerTop - cloud.cloudLayerBottom;

  var transmittance: f32 = 1.0;
  var lightEnergy: f32 = 0.0;
  var weightedColor = vec3<f32>(0.0);
  var totalDensity: f32 = 0.0;

  for (var i: i32 = 0; i < steps; i++) {
    if (transmittance < 0.01) { break; }

    let t = tStart + (f32(i) + 0.5) * stepSize;
    let samplePos = rayOrigin + rayDir * t;
    let altitude = length(samplePos) - cloud.planetRadius;
    let heightFraction = clamp(
      (altitude - cloud.cloudLayerBottom) / layerThickness, 0.0, 1.0
    );

    let density = cloudDensity(samplePos, heightFraction);
    if (density <= 0.001) { continue; }

    // Light contribution at this point — 379c cheap multi-scatter (was a single
    // Beer-Powder octave) so deep cloud interiors keep a soft glow.
    let lightOpticalDepth = lightMarch(samplePos, heightFraction);
    let lightTransmittance = multiScatterLight(lightOpticalDepth, 0.5);

    // Silver lining: enhanced scattering at cloud edges
    let silverLining = cloud.silverLiningIntensity
                     * pow(clamp(1.0 - density * 3.0, 0.0, 1.0), 2.0);

    let scatteredLight = (lightTransmittance * phase + silverLining)
                       * cloud.sunIntensity;

    // Height-based color gradient (darker base, brighter top)
    let cloudColor = mix(cloud.cloudBaseColor, cloud.cloudTopColor, heightFraction);

    // Accumulate
    let sampleTransmittance = exp(-density * stepSize * cloud.absorptionCoeff);
    let sampleWeight = (1.0 - sampleTransmittance) * transmittance;

    weightedColor += cloudColor * scatteredLight * sampleWeight;
    lightEnergy += scatteredLight * sampleWeight;
    totalDensity += density * stepSize;
    transmittance *= sampleTransmittance;
  }

  // Ambient light contribution (sky color bleeding through)
  let ambientColor = mix(
    vec3<f32>(0.4, 0.5, 0.7),  // blue sky ambient
    vec3<f32>(0.9, 0.5, 0.2),  // sunset ambient
    pow(max(1.0 - sunDir.y, 0.0), 3.0)
  );
  let ambientContribution = ambientColor * (1.0 - transmittance) * 0.15;
  weightedColor += ambientContribution;

  // W1 — HDR tone-map the accumulated cloud radiance before compositing. The
  // dual-lobe phase peaks ~6x at the forward lobe and is multiplied by
  // sunIntensity (~10), so the radiance is HDR (peaks ~20-30) and was clipping
  // EVERY cloud to flat white — hiding the silver lining and, more importantly,
  // every lighting term the rest of Arc A adds (ambient, time-of-day, aerial).
  // Exposure + Reinhard maps it to [0,1) so the bright sun-facing edges read as
  // a rim over a darker body (the silver lining) instead of a white-out.
  let exposed = weightedColor * CLOUD_EXPOSURE;
  let toneMapped = exposed / (exposed + vec3<f32>(1.0));

  // Composite clouds over scene
  let cloudAlpha = 1.0 - transmittance;
  let finalColor = mix(sceneColor.rgb, toneMapped, cloudAlpha);

  return vec4<f32>(finalColor, sceneColor.a);
}
