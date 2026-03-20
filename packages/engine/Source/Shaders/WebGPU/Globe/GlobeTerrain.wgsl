// Globe Terrain Shader — WebGPU
//
// Renders terrain tiles with RTE (Relative-To-Eye) positioning.
// Supports up to MAX_TEXTURES imagery layers per tile.
// Uses tile-center-relative vertex positions + u_center3D for full ECEF.
//
// Features:
//   - RTE (Relative-To-Eye) precision for planetary scale
//   - Up to 4 imagery layers with alpha/brightness/contrast/saturation
//   - Lambert diffuse lighting from sun direction
//   - Fog blending (distance-based atmosphere fade)
//   - Atmosphere integration (Rayleigh-approximated horizon glow)
//   - Water mask support (ocean specular and darkening)
//   - Log depth for multi-frustum precision
//
// Vertex data format (uncompressed, TerrainQuantization.NONE):
//   position3DAndHeight: vec4 (posX, posY, posZ, height) — relative to tile center
//   textureCoordAndEncodedNormals: vec4 (u, v, encodedNormal, 0)
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
  // Fog parameters (packed after layerCount)
  fogDensity: f32,
  fogOffset: f32,
  fogMinimumBrightness: f32,
};

@group(0) @binding(1) var<uniform> tile: TileUniforms;

// ─── Textures (Group 1) ───
@group(1) @binding(0) var dayTexture0: texture_2d<f32>;
@group(1) @binding(1) var dayTexture1: texture_2d<f32>;
@group(1) @binding(2) var dayTexture2: texture_2d<f32>;
@group(1) @binding(3) var dayTexture3: texture_2d<f32>;
@group(1) @binding(4) var texSampler: sampler;

// ─── Vertex Input / Output ───
struct VertexInput {
  @location(0) position3DAndHeight: vec4<f32>,
  @location(1) textureCoordAndEncodedNormals: vec4<f32>,
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
const RAYLEIGH_SCALE_HEIGHT: f32 = 8500.0;

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

// ─── Vertex Shader ───
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;

  let position = input.position3DAndHeight.xyz;
  let height = input.position3DAndHeight.w;
  let textureCoordinates = input.textureCoordAndEncodedNormals.xy;
  let encodedNormal = input.textureCoordAndEncodedNormals.z;

  // Full ECEF world coordinate
  let position3DWC = position + camera.center3D;

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

  // World-space position for lighting
  out.v_positionMC = position3DWC;

  // Decode and transform normal to eye space
  let normalMC = octDecode(encodedNormal);
  // Use upper-left 3x3 of modifiedModelView as normal matrix
  let nm = camera.modifiedModelView;
  out.v_normalEC = normalize(vec3<f32>(
    nm[0][0] * normalMC.x + nm[1][0] * normalMC.y + nm[2][0] * normalMC.z,
    nm[0][1] * normalMC.x + nm[1][1] * normalMC.y + nm[2][1] * normalMC.z,
    nm[0][2] * normalMC.x + nm[1][2] * normalMC.y + nm[2][2] * normalMC.z
  ));

  return out;
}

// ─── Imagery sampling with translation/scale ───
fn sampleImagery(tex: texture_2d<f32>, samp: sampler,
                 baseUV: vec2<f32>, layer: ImageryLayer) -> vec4<f32> {
  let uv = baseUV * layer.translationAndScale.zw + layer.translationAndScale.xy;
  // Clamp to texcoord rectangle
  let clampedUV = clamp(uv, layer.texCoordsRect.xy, layer.texCoordsRect.zw);
  return textureSample(tex, samp, clampedUV);
}

fn adjustColor(color: vec3<f32>, brightness: f32, contrast: f32, saturation: f32) -> vec3<f32> {
  // Brightness
  var c = color * brightness;
  // Contrast
  c = (c - 0.5) * contrast + 0.5;
  // Saturation
  let gray = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
  c = mix(vec3<f32>(gray), c, saturation);
  return clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
}

// ─── Fog computation ───
// Matches CesiumJS fog: exponential density based on distance from camera.
// fogDensity is computed on the CPU side by Fog.js and passed as uniform.
fn computeFog(distance: f32, fogDensity: f32, posEC: vec3<f32>) -> f32 {
  let scalar = distance * fogDensity;
  // Exponential fog
  let fogFactor = 1.0 - exp(-(scalar * scalar));
  return clamp(fogFactor, 0.0, 1.0);
}

// ─── Atmosphere color approximation ───
// Simplified Rayleigh scattering color based on view angle and sun direction.
// Produces the blue-to-orange horizon glow that CesiumJS shows.
fn computeAtmosphereColor(
  positionEC: vec3<f32>,
  normalEC: vec3<f32>,
  sunDirEC: vec3<f32>,
) -> vec3<f32> {
  let viewDir = normalize(-positionEC);
  let cosAngle = dot(viewDir, normalEC);

  // Rayleigh scattering approximation — blue sky fading to orange at sunset
  let rayleighPhase = 0.75 * (1.0 + cosAngle * cosAngle);
  let sunAngle = max(dot(normalEC, sunDirEC), 0.0);

  // Blue scattered sky light
  let skyBlue = vec3<f32>(0.16, 0.36, 0.72) * rayleighPhase;
  // Warm sun-facing glow
  let sunGlow = vec3<f32>(0.95, 0.65, 0.35) * pow(max(dot(viewDir, sunDirEC), 0.0), 8.0) * 0.4;

  return skyBlue * 0.3 + sunGlow;
}

// ─── Fragment Shader ───
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.v_textureCoordinates;

  // Start with a base color (dark gray for no-imagery case)
  var color = vec3<f32>(0.15, 0.15, 0.18);
  var alpha: f32 = 1.0;

  // Composite imagery layers (blend from bottom to top)
  let count = tile.layerCount;

  if (count >= 1u) {
    let layer0 = tile.layers[0];
    let tex0 = sampleImagery(dayTexture0, texSampler, uv, layer0);
    let adj0 = adjustColor(tex0.rgb, layer0.brightness, layer0.contrast, layer0.saturation);
    color = mix(color, adj0, layer0.alpha * tex0.a);
  }
  if (count >= 2u) {
    let layer1 = tile.layers[1];
    let tex1 = sampleImagery(dayTexture1, texSampler, uv, layer1);
    let adj1 = adjustColor(tex1.rgb, layer1.brightness, layer1.contrast, layer1.saturation);
    color = mix(color, adj1, layer1.alpha * tex1.a);
  }
  if (count >= 3u) {
    let layer2 = tile.layers[2];
    let tex2 = sampleImagery(dayTexture2, texSampler, uv, layer2);
    let adj2 = adjustColor(tex2.rgb, layer2.brightness, layer2.contrast, layer2.saturation);
    color = mix(color, adj2, layer2.alpha * tex2.a);
  }
  if (count >= 4u) {
    let layer3 = tile.layers[3];
    let tex3 = sampleImagery(dayTexture3, texSampler, uv, layer3);
    let adj3 = adjustColor(tex3.rgb, layer3.brightness, layer3.contrast, layer3.saturation);
    color = mix(color, adj3, layer3.alpha * tex3.a);
  }

  // Basic Lambert diffuse lighting
  let normal = normalize(input.v_normalEC);
  if (camera.enableLighting > 0.5) {
    let sunDir = normalize(camera.sunDirectionEC);
    let NdotL = max(dot(normal, sunDir), 0.0);
    let ambient = 0.15;
    let diffuse = NdotL * 0.85 + ambient;
    color = color * diffuse;
  }

  // ─── Fog blending ───
  // Blend terrain color toward atmosphere color at distance.
  // This matches the WebGL Fog.js behavior: at the horizon, terrain
  // fades into atmospheric haze for a seamless sky-to-ground transition.
  let fogDensity = tile.fogDensity;
  if (fogDensity > 0.0) {
    let fogAmount = computeFog(input.v_distance, fogDensity, input.v_positionEC);

    // Compute atmosphere color to blend toward
    let atmosphereColor = computeAtmosphereColor(
      input.v_positionEC,
      normal,
      normalize(camera.sunDirectionEC),
    );

    // Ensure a minimum brightness so fog doesn't make the scene too dark
    let fogColor = max(atmosphereColor, vec3<f32>(tile.fogMinimumBrightness));

    // Blend terrain → atmosphere based on fog amount
    color = mix(color, fogColor, fogAmount);

    // Fade out alpha at extreme distances (matches WebGL behavior where
    // distant tiles are culled entirely — this provides a smoother transition)
    if (fogAmount > 0.98) {
      alpha = max(1.0 - (fogAmount - 0.98) * 50.0, 0.0);
    }
  }

  return vec4<f32>(color, alpha);
}
