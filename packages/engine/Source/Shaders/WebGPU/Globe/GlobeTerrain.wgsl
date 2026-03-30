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
//   - Lambert diffuse lighting from sun direction
//   - Fog blending (distance-based atmosphere fade)
//   - Atmosphere integration (Rayleigh-approximated horizon glow)
//   - Water mask support (ocean specular and darkening)
//   - Cartographic limit rectangle clipping (discard-based)
//   - Log depth for multi-frustum precision
//   - Quantized terrain vertex decoding (TerrainQuantization.BITS12)
//
// Vertex data format (uncompressed, TerrainQuantization.NONE):
//   position3DAndHeight: vec4 (posX, posY, posZ, height) — relative to tile center
//   textureCoordAndEncodedNormals: vec4 (u, v, encodedNormal, webMercatorT)
//
// Vertex data format (quantized, TerrainQuantization.BITS12):
//   compressed0: vec4 (compressedXY, compressedZH, compressedUV, encodedNormal)
//   Each compressed float packs two 12-bit values via compressTextureCoordinates:
//     compressedXY = floor(x*4095)*4096 + floor(y*4095)
//     compressedZH = floor(z*4095)*4096 + floor(h*4095)
//     compressedUV = floor(u*4095)*4096 + floor(v*4095)
//   Position x,y,z are in [0,1] scaled ENU space.
//   scaleAndBias matrix transforms [0,1]^3 → tile-center-relative ECEF.
//
// RTE approach:
//   position3DWC = position + center3D
//   eyeOffset = translateRelativeToEye(position3DWC, vec3(0), camHigh, camLow)
//   clipPos = mvpRelativeToEye * eyeOffset

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
  // Quantized mesh decompression matrix: [0,1]^3 scaled ENU → tile-center-relative ECEF
  scaleAndBias: mat4x4<f32>,
  // x = minimumHeight, y = maximumHeight (for quantized height reconstruction)
  minMaxHeight: vec2<f32>,
  _pad3: vec2<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// ─── Tile Imagery Uniforms (Group 0, Binding 1) ───
// Per-tile imagery layer parameters (up to 4 layers)
struct ImageryLayer {
  translationAndScale: vec4<f32>,  // xy=translation, zw=scale
  texCoordsRect: vec4<f32>,        // min/max tex coord rectangle
  alpha: f32,
  brightness: f32,
  contrast: f32,
  saturation: f32,
};

struct TileUniforms {
  layers: array<ImageryLayer, 4>,
  layerCount: u32,
  fogDensity: f32,
  fogOffset: f32,
  fogMinimumBrightness: f32,
  // Water mask transform: xy=translation, zw=scale
  waterMaskTranslationAndScale: vec4<f32>,
  // Cartographic limit rectangle (localized 0-1 range): x=west, y=south, z=east, w=north
  cartographicLimitRect: vec4<f32>,
  // Night fade distance: x=fadeOutDist, y=fadeInDist
  nightFadeDistance: vec2<f32>,
  // Day/night alpha per layer (packed): x=layer0 dayAlpha, y=layer0 nightAlpha, ...
  dayNightAlpha0: vec2<f32>,
  dayNightAlpha1: vec2<f32>,
  dayNightAlpha2: vec2<f32>,
  dayNightAlpha3: vec2<f32>,
  // Flags: x=hasWaterMask, y=enableClipping, z=showOceanWaves, w=isSubsequentPass
  flags: vec4<f32>,
  // Vertical exaggeration: x=exaggeration factor, y=relative height
  verticalExaggeration: vec2<f32>,
  // Animation time (seconds) for ocean wave normal map
  time: f32,
  _pad4: f32,
};

@group(0) @binding(1) var<uniform> tile: TileUniforms;

// ─── Textures (Group 1): Day imagery ───
@group(1) @binding(0) var dayTexture0: texture_2d<f32>;
@group(1) @binding(1) var dayTexture1: texture_2d<f32>;
@group(1) @binding(2) var dayTexture2: texture_2d<f32>;
@group(1) @binding(3) var dayTexture3: texture_2d<f32>;
@group(1) @binding(4) var texSampler: sampler;

// ─── Water mask texture (Group 2) ───
@group(2) @binding(0) var waterMaskTexture: texture_2d<f32>;
@group(2) @binding(1) var waterMaskSampler: sampler;

// ─── Ocean wave normal map (Group 3) ───
// Animated normal map for ocean surface wave detail.
// UV scrolled by tile.time to animate waves.
@group(3) @binding(0) var oceanNormalMap: texture_2d<f32>;
@group(3) @binding(1) var oceanNormalSampler: sampler;

// ─── Vertex Input / Output ───
// Uncompressed terrain (TerrainQuantization.NONE)
struct VertexInput {
  @location(0) position3DAndHeight: vec4<f32>,
  @location(1) textureCoordAndEncodedNormals: vec4<f32>,
};

// Quantized terrain (TerrainQuantization.BITS12)
// compressed0.xyz = [compressedXY, compressedZH, compressedUV]
// compressed0.w   = encodedNormal (when hasVertexNormals && !hasWebMercatorT)
//                    or webMercatorT (when hasWebMercatorT)
//                    or unused (when neither)
struct VertexInputQuantized {
  @location(0) compressed0: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) v_textureCoordinates: vec2<f32>,
  @location(1) v_positionEC: vec3<f32>,
  @location(2) v_normalEC: vec3<f32>,
  @location(3) v_positionMC: vec3<f32>,
  @location(4) v_distance: f32,
};

// ─── Constants ───
const EARTH_RADIUS: f32 = 6378137.0;

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
// Matches CesiumJS AttributeCompression.decompressTextureCoordinates:
//   compressed = floor(a * 4095) * 4096 + floor(b * 4095)
fn decompressTextureCoordinates(compressed: f32) -> vec2<f32> {
  let temp = compressed / 4096.0;
  let xZeroTo4095 = floor(temp);
  return vec2<f32>(
    xZeroTo4095 / 4095.0,
    (compressed - xZeroTo4095 * 4096.0) / 4095.0
  );
}

// ─── Shared vertex processing (both uncompressed and quantized paths use this) ───
fn processVertex(position: vec3<f32>, textureCoordinates: vec2<f32>,
                 encodedNormal: f32) -> VertexOutput {
  var out: VertexOutput;

  // ─── Vertical exaggeration ───
  // Matches GlobeVS.glsl: offset position along geodetic surface normal
  // by (height - relativeHeight) * (exaggeration - 1.0).
  // The geodetic surface normal is approximated from the ECEF position direction.
  var exaggeratedPosition = position;
  let exaggeration = tile.verticalExaggeration.x;
  if (exaggeration != 1.0) {
    let position3D = position + camera.center3D;
    let ellipsoidNormal = normalize(position3D);
    // Height is along the surface normal; approximate from position length
    let surfaceHeight = length(position3D) - EARTH_RADIUS;
    let relativeHeight = tile.verticalExaggeration.y;
    let newHeight = (surfaceHeight - relativeHeight) * exaggeration + relativeHeight;
    // Prevent going through earth center
    let clampedHeight = max(newHeight, -EARTH_RADIUS * 0.5);
    let offset = ellipsoidNormal * (clampedHeight - surfaceHeight);
    exaggeratedPosition = position + offset;
  }

  // Full ECEF world coordinate
  let position3DWC = exaggeratedPosition + camera.center3D;

  // RTE: subtract camera position split into high/low
  let rtePosition = translateRelativeToEye(
    position3DWC, vec3<f32>(0.0),
    camera.encodedCameraHigh, camera.encodedCameraLow
  );

  // Clip-space position via RTE MVP
  out.position = camera.mvpRelativeToEye * rtePosition;

  // Eye-space position via modified model-view (has tile center baked in)
  out.v_positionEC = (camera.modifiedModelView * vec4<f32>(position, 1.0)).xyz;

  // Distance from camera (for fog computation)
  out.v_distance = length(out.v_positionEC);

  // Texture coordinates
  out.v_textureCoordinates = textureCoordinates;

  // World-space position for lighting and water mask
  out.v_positionMC = position3DWC;

  // Decode and transform normal to eye space
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
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  let position = input.position3DAndHeight.xyz;
  let textureCoordinates = input.textureCoordAndEncodedNormals.xy;
  let encodedNormal = input.textureCoordAndEncodedNormals.z;

  return processVertex(position, textureCoordinates, encodedNormal);
}

// ─── Vertex Shader: Quantized Terrain (BITS12) ───
// Decompresses packed 12-bit position, tex coords, and normal from compressed floats.
// Uses scaleAndBias matrix to transform [0,1]^3 scaled ENU to tile-center-relative ECEF.
@vertex
fn vertexMainQuantized(input: VertexInputQuantized) -> VertexOutput {
  // Decompress packed position
  let xy = decompressTextureCoordinates(input.compressed0.x);
  let zh = decompressTextureCoordinates(input.compressed0.y);

  // Position in scaled ENU space [0,1]^3
  let scaledPos = vec3<f32>(xy.x, xy.y, zh.x);

  // Transform to tile-center-relative ECEF using the decompression matrix
  let position = (camera.scaleAndBias * vec4<f32>(scaledPos, 1.0)).xyz;

  // Decompress texture coordinates
  let uv = decompressTextureCoordinates(input.compressed0.z);

  // Normal is in the 4th component (when hasVertexNormals)
  let encodedNormal = input.compressed0.w;

  return processVertex(position, uv, encodedNormal);
}

// ─── Imagery sampling with translation/scale ───
fn sampleImagery(tex: texture_2d<f32>, samp: sampler,
                 baseUV: vec2<f32>, layer: ImageryLayer) -> vec4<f32> {
  let uv = baseUV * layer.translationAndScale.zw + layer.translationAndScale.xy;
  let clampedUV = clamp(uv, layer.texCoordsRect.xy, layer.texCoordsRect.zw);
  return textureSample(tex, samp, clampedUV);
}

fn adjustColor(color: vec3<f32>, brightness: f32, contrast: f32, saturation: f32) -> vec3<f32> {
  var c = color * brightness;
  c = (c - 0.5) * contrast + 0.5;
  let gray = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
  c = mix(vec3<f32>(gray), c, saturation);
  return clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
}

// ─── Day/Night fade ───
// Computes a blend factor (0=night, 1=day) based on the sun angle at the surface.
fn computeDayNightFade(positionMC: vec3<f32>, sunDirEC: vec3<f32>,
                       normalEC: vec3<f32>) -> f32 {
  // Use the dot product of the surface normal with the sun direction
  // Positive = sun-facing (day), negative = away from sun (night)
  let sunAngle = dot(normalEC, sunDirEC);
  // Smooth transition from day to night over a range of -0.1 to 0.1
  return smoothstep(-0.1, 0.1, sunAngle);
}

// ─── Fog computation ───
fn computeFog(distance: f32, fogDensity: f32, posEC: vec3<f32>) -> f32 {
  let scalar = distance * fogDensity;
  let fogFactor = 1.0 - exp(-(scalar * scalar));
  return clamp(fogFactor, 0.0, 1.0);
}

// ─── Atmosphere color approximation ───
fn computeAtmosphereColor(
  positionEC: vec3<f32>,
  normalEC: vec3<f32>,
  sunDirEC: vec3<f32>,
) -> vec3<f32> {
  let viewDir = normalize(-positionEC);
  let cosAngle = dot(viewDir, normalEC);
  let rayleighPhase = 0.75 * (1.0 + cosAngle * cosAngle);
  let skyBlue = vec3<f32>(0.16, 0.36, 0.72) * rayleighPhase;
  let sunGlow = vec3<f32>(0.95, 0.65, 0.35) * pow(max(dot(viewDir, sunDirEC), 0.0), 8.0) * 0.4;
  return skyBlue * 0.3 + sunGlow;
}

// ─── Water specular ───
// Simple Phong specular for water surface to simulate sun reflection on ocean.
fn computeWaterSpecular(positionEC: vec3<f32>, normalEC: vec3<f32>,
                        sunDirEC: vec3<f32>) -> f32 {
  let viewDir = normalize(-positionEC);
  let reflectDir = reflect(-sunDirEC, normalEC);
  let spec = pow(max(dot(viewDir, reflectDir), 0.0), 64.0);
  return spec * 0.6;
}

// ─── Fragment Shader ───
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.v_textureCoordinates;

  // ─── Cartographic limit rectangle clipping ───
  if (tile.flags.y > 0.5) {
    let clampRect = tile.cartographicLimitRect;
    // UV coordinates map to tile rectangle — 0 to 1 range
    if (uv.x < clampRect.x || uv.x > clampRect.z ||
        uv.y < clampRect.y || uv.y > clampRect.w) {
      discard;
    }
  }

  // Subsequent passes (multi-pass imagery >4 layers) blend on top of existing color.
  // First pass starts with a dark base; subsequent passes use transparent black.
  let isSubsequentPass = tile.flags.w > 0.5;

  // Start with a base color (dark gray for no-imagery first pass, transparent for subsequent)
  var color: vec3<f32>;
  var alpha: f32;
  if (isSubsequentPass) {
    color = vec3<f32>(0.0, 0.0, 0.0);
    alpha = 0.0;
  } else {
    color = vec3<f32>(0.15, 0.15, 0.18);
    alpha = 1.0;
  }

  let normal = normalize(input.v_normalEC);
  let sunDir = normalize(camera.sunDirectionEC);

  // Compute day/night fade factor for imagery blending
  let dayFade = computeDayNightFade(input.v_positionMC, sunDir, normal);

  // Composite imagery layers (blend from bottom to top)
  let count = tile.layerCount;

  if (count >= 1u) {
    let layer0 = tile.layers[0];
    let tex0 = sampleImagery(dayTexture0, texSampler, uv, layer0);
    let adj0 = adjustColor(tex0.rgb, layer0.brightness, layer0.contrast, layer0.saturation);
    let dna0 = tile.dayNightAlpha0;
    let effectiveAlpha0 = layer0.alpha * tex0.a * mix(dna0.y, dna0.x, dayFade);
    color = mix(color, adj0, effectiveAlpha0);
    alpha = max(alpha, effectiveAlpha0);
  }
  if (count >= 2u) {
    let layer1 = tile.layers[1];
    let tex1 = sampleImagery(dayTexture1, texSampler, uv, layer1);
    let adj1 = adjustColor(tex1.rgb, layer1.brightness, layer1.contrast, layer1.saturation);
    let dna1 = tile.dayNightAlpha1;
    let effectiveAlpha1 = layer1.alpha * tex1.a * mix(dna1.y, dna1.x, dayFade);
    color = mix(color, adj1, effectiveAlpha1);
    alpha = max(alpha, effectiveAlpha1);
  }
  if (count >= 3u) {
    let layer2 = tile.layers[2];
    let tex2 = sampleImagery(dayTexture2, texSampler, uv, layer2);
    let adj2 = adjustColor(tex2.rgb, layer2.brightness, layer2.contrast, layer2.saturation);
    let dna2 = tile.dayNightAlpha2;
    let effectiveAlpha2 = layer2.alpha * tex2.a * mix(dna2.y, dna2.x, dayFade);
    color = mix(color, adj2, effectiveAlpha2);
    alpha = max(alpha, effectiveAlpha2);
  }
  if (count >= 4u) {
    let layer3 = tile.layers[3];
    let tex3 = sampleImagery(dayTexture3, texSampler, uv, layer3);
    let adj3 = adjustColor(tex3.rgb, layer3.brightness, layer3.contrast, layer3.saturation);
    let dna3 = tile.dayNightAlpha3;
    let effectiveAlpha3 = layer3.alpha * tex3.a * mix(dna3.y, dna3.x, dayFade);
    color = mix(color, adj3, effectiveAlpha3);
    alpha = max(alpha, effectiveAlpha3);
  }

  // Subsequent passes only apply imagery — skip lighting, fog, water
  if (isSubsequentPass) {
    return vec4<f32>(color, alpha);
  }

  // ─── Water mask + ocean wave normal map ───
  if (tile.flags.x > 0.5) {
    let wmTS = tile.waterMaskTranslationAndScale;
    let waterUV = uv * wmTS.zw + wmTS.xy;
    let waterMask = textureSample(waterMaskTexture, waterMaskSampler, waterUV).r;

    if (waterMask > 0.5) {
      color = color * 0.7;

      // Perturbed normal from ocean wave normal map (animated)
      var waterNormal = normal;
      if (tile.flags.z > 0.5) {
        // Two scrolling UV layers for wave animation (matches WebGL oceanFS.glsl)
        let t = tile.time;
        let waveUV1 = uv * 500.0 + vec2<f32>(t * 0.02, t * 0.015);
        let waveUV2 = uv * 250.0 + vec2<f32>(-t * 0.01, t * 0.025);
        let n1 = textureSample(oceanNormalMap, oceanNormalSampler, waveUV1).xyz * 2.0 - 1.0;
        let n2 = textureSample(oceanNormalMap, oceanNormalSampler, waveUV2).xyz * 2.0 - 1.0;
        let waveN = normalize(n1 + n2);
        // Blend wave detail with surface normal (0.15 strength)
        waterNormal = normalize(normal + waveN * 0.15);
      }

      if (camera.enableLighting > 0.5) {
        let specular = computeWaterSpecular(input.v_positionEC, waterNormal, sunDir);
        color = color + vec3<f32>(specular);
      }
    }
  }

  // ─── Lambert diffuse lighting ───
  if (camera.enableLighting > 0.5) {
    let NdotL = max(dot(normal, sunDir), 0.0);
    let ambient = 0.15;
    let diffuse = NdotL * 0.85 + ambient;
    color = color * diffuse;
  }

  // ─── Fog blending ───
  let fogDensity = tile.fogDensity;
  if (fogDensity > 0.0) {
    let fogAmount = computeFog(input.v_distance, fogDensity, input.v_positionEC);

    let atmosphereColor = computeAtmosphereColor(
      input.v_positionEC, normal, sunDir,
    );

    let fogColor = max(atmosphereColor, vec3<f32>(tile.fogMinimumBrightness));
    color = mix(color, fogColor, fogAmount);

    // Fade alpha at extreme distances
    if (fogAmount > 0.98) {
      alpha = max(1.0 - (fogAmount - 0.98) * 50.0, 0.0);
    }
  }

  return vec4<f32>(color, alpha);
}
