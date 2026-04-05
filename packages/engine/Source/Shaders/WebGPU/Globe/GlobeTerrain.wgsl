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
struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  modifiedModelView: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  center3D: vec3<f32>,
  _pad2: f32,
  sunDirectionEC: vec3<f32>,
  enableLighting: f32,
  scaleAndBias: mat4x4<f32>,
  minMaxHeight: vec2<f32>,
  _pad3: vec2<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// ─── Tile Imagery Uniforms (Group 0, Binding 1) ───
struct ImageryLayer {
  translationAndScale: vec4<f32>,
  texCoordsRect: vec4<f32>,
  alpha: f32,
  brightness: f32,
  contrast: f32,
  saturation: f32,
};

struct TileUniforms {
  layers: array<ImageryLayer, 4>,
  layerCount: f32,
  fogDensity: f32,
  fogOffset: f32,
  fogMinimumBrightness: f32,
  waterMaskTranslationAndScale: vec4<f32>,
  cartographicLimitRect: vec4<f32>,
  nightFadeDistance: vec2<f32>,
  dayNightAlpha0: vec2<f32>,
  dayNightAlpha1: vec2<f32>,
  dayNightAlpha2: vec2<f32>,
  dayNightAlpha3: vec2<f32>,
  // Flags: x=hasWaterMask, y=enableClipping, z=showOceanWaves, w=isSubsequentPass
  flags: vec4<f32>,
  verticalExaggeration: vec2<f32>,
  time: f32,
  _pad4: f32,
  // === Night & Ocean Enhancement Parameters ===
  // oceanParams: x=deepR, y=deepG, z=deepB, w=fresnelPower
  oceanParams: vec4<f32>,
  // nightOceanParams: x=nightIntensity, y=oceanReflectivity, z=foamThreshold, w=oceanDarkening
  nightOceanParams: vec4<f32>,
  // Per-layer flag: >0.5 means use webMercatorT (.z of v_textureCoordinates)
  // instead of geographic V (.y) for imagery sampling. Matches WebGL's
  // u_dayTextureUseWebMercatorT. x=layer0, y=layer1, z=layer2, w=layer3.
  useWebMercatorTLayer: vec4<f32>,
};

@group(0) @binding(1) var<uniform> tile: TileUniforms;

// ─── Textures (Group 1): Day imagery ───
@group(1) @binding(0) var dayTexture0: texture_2d<f32>;
@group(1) @binding(1) var dayTexture1: texture_2d<f32>;
@group(1) @binding(2) var dayTexture2: texture_2d<f32>;
@group(1) @binding(3) var dayTexture3: texture_2d<f32>;
@group(1) @binding(4) var texSampler: sampler;

// ─── Water mask + Ocean normal map (Group 2, merged) ───
@group(2) @binding(0) var waterMaskTexture: texture_2d<f32>;
@group(2) @binding(1) var waterMaskSampler: sampler;
@group(2) @binding(2) var oceanNormalMap: texture_2d<f32>;
@group(2) @binding(3) var oceanNormalSampler: sampler;

// ─── Effects bind group: shadow receive + clipping planes (Group 3) ───
struct EffectsUniforms {
    shadowMatrix: mat4x4<f32>,
    shadowMapSize: vec2<f32>,
    shadowDarkness: f32,
    shadowSoftShadows: f32,
    clippingPlaneCount: u32,
    clippingUnionMode: u32,
    clippingEdgeWidth: f32,
    _pad5: f32,
    clippingEdgeColor: vec4<f32>,
}

@group(3) @binding(0) var<uniform> effects: EffectsUniforms;
@group(3) @binding(1) var shadowDepthTex: texture_depth_2d;
@group(3) @binding(2) var shadowCompSampler: sampler_comparison;
@group(3) @binding(3) var clippingPlaneTex: texture_2d<f32>;
@group(3) @binding(4) var clippingPlaneSampler: sampler;

// ─── Vertex Input / Output ───
struct VertexInput {
  @location(0) position3DAndHeight: vec4<f32>,
  @location(1) textureCoordAndEncodedNormals: vec4<f32>,
};

struct VertexInputQuantized {
  @location(0) compressed0: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) v_textureCoordinates: vec3<f32>,  // (u, v_geographic, webMercatorT)
  @location(1) v_positionEC: vec3<f32>,
  @location(2) v_normalEC: vec3<f32>,
  @location(3) v_positionMC: vec3<f32>,
  @location(4) v_distance: f32,
};

// ─── Constants ───
const EARTH_RADIUS: f32 = 6378137.0;
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

// ─── Shared vertex processing ───
// webMercatorT: Web Mercator vertical texture coordinate. When no Mercator
// data is present in the vertex buffer, callers pass textureCoordinates.y
// (geographic V) as a fallback — the fragment shader's per-layer
// useWebMercatorT flag selects which one to use for sampling.
fn processVertex(position: vec3<f32>, textureCoordinates: vec2<f32>,
                 encodedNormal: f32, webMercatorT: f32) -> VertexOutput {
  var out: VertexOutput;

  // Vertical exaggeration
  var exaggeratedPosition = position;
  let exaggeration = tile.verticalExaggeration.x;
  if (exaggeration != 1.0) {
    let position3D = position + camera.center3D;
    let ellipsoidNormal = normalize(position3D);
    let surfaceHeight = length(position3D) - EARTH_RADIUS;
    let relativeHeight = tile.verticalExaggeration.y;
    let newHeight = (surfaceHeight - relativeHeight) * exaggeration + relativeHeight;
    let clampedHeight = max(newHeight, -EARTH_RADIUS * 0.5);
    let offset = ellipsoidNormal * (clampedHeight - surfaceHeight);
    exaggeratedPosition = position + offset;
  }

  let position3DWC = exaggeratedPosition + camera.center3D;

  let rtePosition = translateRelativeToEye(
    position3DWC, vec3<f32>(0.0),
    camera.encodedCameraHigh, camera.encodedCameraLow
  );

  out.position = camera.mvpRelativeToEye * rtePosition;
  out.v_positionEC = (camera.modifiedModelView * vec4<f32>(position, 1.0)).xyz;
  out.v_distance = length(out.v_positionEC);
  out.v_textureCoordinates = vec3<f32>(textureCoordinates, webMercatorT);
  out.v_positionMC = position3DWC;

  let normalMC = octDecode(encodedNormal);
  let nm = camera.modifiedModelView;
  out.v_normalEC = normalize(vec3<f32>(
    nm[0][0] * normalMC.x + nm[1][0] * normalMC.y + nm[2][0] * normalMC.z,
    nm[0][1] * normalMC.x + nm[1][1] * normalMC.y + nm[2][1] * normalMC.z,
    nm[0][2] * normalMC.x + nm[1][2] * normalMC.y + nm[2][2] * normalMC.z
  ));

  return out;
}

// ─── Vertex Shader: Uncompressed Terrain ───
// Used when hasWebMercatorT=false. Normal (if present) is in .z component.
// When no normals, .z = 0 (default fill from float32x2 format).
// webMercatorT defaults to geographic V (textureCoordinates.y).
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  let tc = input.textureCoordAndEncodedNormals;
  return processVertex(input.position3DAndHeight.xyz, tc.xy, tc.z, tc.y);
}

// ─── Vertex Shader: Uncompressed Terrain with WebMercatorT (no normals) ───
// Vertex data: [u, v, webMercatorT] — webMercatorT is in .z, no normal.
@vertex
fn vertexMainWebMerc(input: VertexInput) -> VertexOutput {
  let tc = input.textureCoordAndEncodedNormals;
  return processVertex(input.position3DAndHeight.xyz, tc.xy, 0.0, tc.z);
}

// ─── Vertex Shader: Uncompressed Terrain with WebMercatorT + Normals ───
// Vertex data: [u, v, webMercatorT, encodedNormal] — normal in .w, webMercT in .z.
@vertex
fn vertexMainWebMercNormals(input: VertexInput) -> VertexOutput {
  let tc = input.textureCoordAndEncodedNormals;
  return processVertex(input.position3DAndHeight.xyz, tc.xy, tc.w, tc.z);
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
  return processVertex(position, uv, input.compressed0.w, uv.y);
}

// ─── Vertex Shader: Quantized Terrain with WebMercatorT ───
// When hasWebMercatorT=true, compressed0.w stores the COMPRESSED webMercatorT
// (not the encodedNormal). Decompress it the same way as texture coordinates.
// encodedNormal is not available in this layout (would need separate compressed1
// attribute). We use a sentinel value (32768.0 = oct-encoded up vector) to
// produce a reasonable default normal for lighting and face culling.
@vertex
fn vertexMainQuantizedWebMerc(input: VertexInputQuantized) -> VertexOutput {
  let xy = decompressTextureCoordinates(input.compressed0.x);
  let zh = decompressTextureCoordinates(input.compressed0.y);
  let scaledPos = vec3<f32>(xy.x, xy.y, zh.x);
  let position = (camera.scaleAndBias * vec4<f32>(scaledPos, 1.0)).xyz;
  let uv = decompressTextureCoordinates(input.compressed0.z);
  let webMercT = decompressTextureCoordinates(input.compressed0.w).x;
  // 32896.0 = oct-encoded (0,0,1) up vector — prevents back-face culling
  return processVertex(position, uv, 32896.0, webMercT);
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

  if (camera.enableLighting > 0.5) {
    // GGX specular for sun reflection on water
    let halfDir = normalize(viewDir + sunDirEC);
    let NdotH = max(dot(waterNormal, halfDir), 0.0);
    let NdotL = max(dot(waterNormal, sunDirEC), 0.0);
    let specular = distributionGGX(NdotH, 0.08) * fresnel * NdotL;

    // Sun specular highlight (bright, tight)
    oceanColor += vec3<f32>(1.0, 0.95, 0.85) * min(specular, 8.0);

    // Subsurface scattering
    oceanColor += computeSubsurfaceScattering(viewDir, sunDirEC, waterNormal);
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

fn computeFog(distance: f32, fogDensity: f32) -> f32 {
  let scalar = distance * fogDensity;
  return clamp(1.0 - exp(-(scalar * scalar)), 0.0, 1.0);
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

// ═══════════════════════════════════════════════════════════════════════
// Shadow & Clipping (unchanged from previous version)
// ═══════════════════════════════════════════════════════════════════════

fn globeShadowPCF(uv: vec2<f32>, depth: f32, texelSize: vec2<f32>) -> f32 {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || depth > 1.0) {
    return 1.0;
  }
  var shadow: f32 = 0.0;
  for (var x: i32 = -1; x <= 1; x++) {
    for (var y: i32 = -1; y <= 1; y++) {
      let offset = vec2<f32>(f32(x), f32(y)) * texelSize;
      shadow += textureSampleCompare(shadowDepthTex, shadowCompSampler, uv + offset, depth);
    }
  }
  return shadow / 9.0;
}

fn globeComputeShadowFactor(positionEC: vec3<f32>) -> f32 {
  if (effects.shadowDarkness >= 1.0) { return 1.0; }
  let shadowPos = effects.shadowMatrix * vec4<f32>(positionEC, 1.0);
  let coord = shadowPos.xyz / shadowPos.w;
  let uv = vec2<f32>(coord.x * 0.5 + 0.5, 1.0 - (coord.y * 0.5 + 0.5));
  let texelSize = 1.0 / effects.shadowMapSize;
  var visibility: f32;
  if (effects.shadowSoftShadows > 0.5) {
    visibility = globeShadowPCF(uv, coord.z, texelSize);
  } else {
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || coord.z > 1.0) {
      visibility = 1.0;
    } else {
      visibility = textureSampleCompare(shadowDepthTex, shadowCompSampler, uv, coord.z);
    }
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

  // Helper: select geographic V or webMercatorT per layer
  // Matches WebGL's u_dayTextureUseWebMercatorT behavior
  let useWebMerc = tile.useWebMercatorTLayer;

  // ═══════════════════════════════════════════════════════════════════════
  // DEBUG MODE: Simplified imagery-only compositing
  // UV debug: when tile._pad4 (offset 79) > 0.5, output raw UV as color
  // to visualize whether texture coordinates interpolate correctly.
  //   R = geoUV.x (u), G = geoUV.y (v), B = webMercT
  // See: migration_doc/WEBGPU_DEBUGGING_LOG.md Session 13, 15
  // ═══════════════════════════════════════════════════════════════════════

  // UV debug visualization: Red=U, Green=V, Blue=webMercT
  if (tile.time > 99990.0) {
    return vec4<f32>(geoUV.x, geoUV.y, webMercT, 1.0);
  }

  let count = u32(tile.layerCount);
  var color = vec3<f32>(0.04, 0.04, 0.06);
  if (count >= 1) {
    let layer0 = tile.layers[0];
    let v0 = select(geoUV.y, webMercT, useWebMerc.x > 0.5);
    let uv0 = vec2<f32>(geoUV.x, v0);
    let sUV0 = uv0 * layer0.translationAndScale.zw + layer0.translationAndScale.xy;
    let tex0 = textureSampleLevel(dayTexture0, texSampler, sUV0, 0.0);
    // Alpha mask: zero out when tileUV is outside texCoordsRect (WebGL parity)
    let alpha0 = layer0.alpha * tex0.a * texCoordsAlpha(uv0, layer0.texCoordsRect);
    color = mix(color, tex0.rgb, alpha0);
  }
  if (count >= 2) {
    let layer1 = tile.layers[1];
    let v1 = select(geoUV.y, webMercT, useWebMerc.y > 0.5);
    let uv1 = vec2<f32>(geoUV.x, v1);
    let sUV1 = uv1 * layer1.translationAndScale.zw + layer1.translationAndScale.xy;
    let tex1 = textureSampleLevel(dayTexture1, texSampler, sUV1, 0.0);
    let alpha1 = layer1.alpha * tex1.a * texCoordsAlpha(uv1, layer1.texCoordsRect);
    color = mix(color, tex1.rgb, alpha1);
  }
  return vec4<f32>(color, 1.0);

  // ═══════════════════════════════════════════════════════════════════════
  // FULL SHADER CODE (temporarily disabled — restore when geometry is fixed)
  // ═══════════════════════════════════════════════════════════════════════

  // // Compute shadow factor early — textureSampleCompare must be called
  // // from uniform control flow (before any non-uniform discard/return).
  // // camera.enableLighting is a uniform value so this branch is uniform.
  // var shadowFactor: f32 = 1.0;
  // if (camera.enableLighting > 0.5) {
  //   shadowFactor = globeComputeShadowFactor(input.v_positionEC);
  // }
  //
  // // ─── Clipping planes discard ───
  // if (globeClipByPlanes(input.v_positionMC)) { discard; }
  //
  // // ─── Clipping edge highlight ───
  // if (effects.clippingPlaneCount > 0u && effects.clippingEdgeWidth > 0.0) {
  //   let clipCount = effects.clippingPlaneCount;
  //   let texW = f32(clipCount);
  //   var minClipDist: f32 = 1e10;
  //   for (var ci: u32 = 0u; ci < clipCount; ci++) {
  //     let texelU = (f32(ci) + 0.5) / texW;
  //     let planeData = textureSampleLevel(clippingPlaneTex, clippingPlaneSampler,
  //                                        vec2<f32>(texelU, 0.5), 0.0);
  //     let dist = abs(dot(input.v_positionMC, planeData.xyz) + planeData.w);
  //     minClipDist = min(minClipDist, dist);
  //   }
  //   if (minClipDist < effects.clippingEdgeWidth) {
  //     return effects.clippingEdgeColor;
  //   }
  // }
  //
  // // ─── Cartographic limit rectangle clipping ───
  // if (tile.flags.y > 0.5) {
  //   let clampRect = tile.cartographicLimitRect;
  //   if (uv.x < clampRect.x || uv.x > clampRect.z ||
  //       uv.y < clampRect.y || uv.y > clampRect.w) {
  //     discard;
  //   }
  // }
  //
  // let isSubsequentPass = tile.flags.w > 0.5;
  //
  // // Base color: dark for first pass (night side will be very dark),
  // // transparent for subsequent multi-pass imagery
  // var color: vec3<f32>;
  // var alpha: f32;
  // if (isSubsequentPass) {
  //   color = vec3<f32>(0.0, 0.0, 0.0);
  //   alpha = 0.0;
  // } else {
  //   color = vec3<f32>(0.04, 0.04, 0.06);
  //   alpha = 1.0;
  // }
  //
  // let normal = normalize(input.v_normalEC);
  // let sunDir = normalize(camera.sunDirectionEC);
  //
  // // Day/night fade factor: 0 = night, 1 = day
  // let dayFade = computeDayNightFade(normal, sunDir);
  // // Inverse for night-side effects
  // let nightBlend = 1.0 - dayFade;
  //
  // // ─── Composite imagery layers ───
  // let count = u32(tile.layerCount);
  //
  // if (count >= 1) {
  //   let layer0 = tile.layers[0];
  //   let tex0 = sampleImagery(dayTexture0, texSampler, uv, layer0);
  //   let adj0 = adjustColor(tex0.rgb, layer0.brightness, layer0.contrast, layer0.saturation);
  //   let dna0 = tile.dayNightAlpha0;
  //   let effectiveAlpha0 = layer0.alpha * tex0.a * mix(dna0.y, dna0.x, dayFade);
  //   color = mix(color, adj0, effectiveAlpha0);
  //   alpha = max(alpha, effectiveAlpha0);
  //   // Night lights emission for this layer
  //   color = applyNightLightsEmission(color, adj0, nightBlend, dna0.y, dna0.x);
  // }
  // if (count >= 2) {
  //   let layer1 = tile.layers[1];
  //   let tex1 = sampleImagery(dayTexture1, texSampler, uv, layer1);
  //   let adj1 = adjustColor(tex1.rgb, layer1.brightness, layer1.contrast, layer1.saturation);
  //   let dna1 = tile.dayNightAlpha1;
  //   let effectiveAlpha1 = layer1.alpha * tex1.a * mix(dna1.y, dna1.x, dayFade);
  //   color = mix(color, adj1, effectiveAlpha1);
  //   alpha = max(alpha, effectiveAlpha1);
  //   color = applyNightLightsEmission(color, adj1, nightBlend, dna1.y, dna1.x);
  // }
  // if (count >= 3) {
  //   let layer2 = tile.layers[2];
  //   let tex2 = sampleImagery(dayTexture2, texSampler, uv, layer2);
  //   let adj2 = adjustColor(tex2.rgb, layer2.brightness, layer2.contrast, layer2.saturation);
  //   let dna2 = tile.dayNightAlpha2;
  //   let effectiveAlpha2 = layer2.alpha * tex2.a * mix(dna2.y, dna2.x, dayFade);
  //   color = mix(color, adj2, effectiveAlpha2);
  //   alpha = max(alpha, effectiveAlpha2);
  //   color = applyNightLightsEmission(color, adj2, nightBlend, dna2.y, dna2.x);
  // }
  // if (count >= 4) {
  //   let layer3 = tile.layers[3];
  //   let tex3 = sampleImagery(dayTexture3, texSampler, uv, layer3);
  //   let adj3 = adjustColor(tex3.rgb, layer3.brightness, layer3.contrast, layer3.saturation);
  //   let dna3 = tile.dayNightAlpha3;
  //   let effectiveAlpha3 = layer3.alpha * tex3.a * mix(dna3.y, dna3.x, dayFade);
  //   color = mix(color, adj3, effectiveAlpha3);
  //   alpha = max(alpha, effectiveAlpha3);
  //   color = applyNightLightsEmission(color, adj3, nightBlend, dna3.y, dna3.x);
  // }
  //
  // // Subsequent passes only apply imagery — skip all effects
  // if (isSubsequentPass) {
  //   return vec4<f32>(color, alpha);
  // }
  //
  // // ─── Enhanced Water mask + ocean rendering ───
  // if (tile.flags.x > 0.5) {
  //   let wmTS = tile.waterMaskTranslationAndScale;
  //   let waterUV = uv * wmTS.zw + wmTS.xy;
  //   let waterMask = textureSampleLevel(waterMaskTexture, waterMaskSampler, waterUV, 0.0).r;
  //
  //   if (waterMask > 0.01) {
  //     color = computeEnhancedOcean(
  //       color, input.v_positionEC, normal, sunDir,
  //       uv, waterMask, dayFade, input.v_distance
  //     );
  //   }
  // }
  //
  // // ─── Lambert diffuse lighting + shadow receive ───
  // if (camera.enableLighting > 0.5) {
  //   let NdotL = max(dot(normal, sunDir), 0.0);
  //   let ambient = 0.12;
  //   // shadowFactor was pre-computed at the top of fragmentMain
  //   // Day side: normal Lambert diffuse with shadow
  //   let dayDiffuse = NdotL * 0.88 * shadowFactor + ambient;
  //   // Night side: very dark, only ambient light (moonlight approximation)
  //   let nightAmbient = 0.025;
  //   let diffuse = mix(nightAmbient, dayDiffuse, dayFade);
  //   color = color * diffuse;
  //
  //   // Terminator glow: warm atmosphere color right at the day-night boundary
  //   color += computeTerminatorGlow(normal, sunDir);
  // }
  //
  // // ─── Fog blending ───
  // let fogDensity = tile.fogDensity;
  // if (fogDensity > 0.0) {
  //   let fogAmount = computeFog(input.v_distance, fogDensity);
  //
  //   let atmosphereColor = computeAtmosphereColor(
  //     input.v_positionEC, normal, sunDir,
  //   );
  //
  //   // Night-side fog is darker — don't brighten with atmosphere on dark side
  //   let nightFogDimming = mix(0.05, 1.0, dayFade);
  //   let fogColor = max(atmosphereColor * nightFogDimming, vec3<f32>(tile.fogMinimumBrightness));
  //   color = mix(color, fogColor, fogAmount);
  //
  //   if (fogAmount > 0.98) {
  //     alpha = max(1.0 - (fogAmount - 0.98) * 50.0, 0.0);
  //   }
  // }
  //
  // return vec4<f32>(color, alpha);
}
