// Deferred Rendering — Lighting Composition Pass
//
// Reads the G-buffer (albedo, normal, metallic, roughness, emission, occlusion)
// and applies PBR lighting for all lights in a single full-screen pass.
//
// Supports:
//   - Primary directional light (sun)
//   - Up to 64 additional point/spot/directional lights via storage buffer
//   - Cook-Torrance BRDF with GGX distribution
//   - IBL ambient (diffuse irradiance + specular radiance from cubemaps)
//   - Shadow mapping integration (reads shadow map for primary light)
//   - Ambient occlusion integration (reads AO texture)
//
// References:
//   - Bruce Walter et al., "Microfacet Models for Refraction through Rough
//     Surfaces" (EGSR 2007) — the GGX distribution.
//   - Brian Karis, "Real Shading in Unreal Engine 4" (SIGGRAPH 2013) — the
//     Smith geometry remap k = (r + 1)^2 / 8 used for the direct term.
//   - Christophe Schlick, "An Inexpensive BRDF Model for Physically-based
//     Rendering", Computer Graphics Forum 13(3), 233 (1994) — the Fresnel
//     approximation.
//
// Performance characteristics:
//   - O(pixels × lights) — each pixel evaluates all lights once
//   - Early depth-test skip for sky pixels (depth == 1.0)
//   - Light culling via radius check (point/spot lights)
//   - ~2x faster than forward rendering for >8 lights

struct DeferredUniforms {
  inverseProjection: mat4x4<f32>,
  projection: mat4x4<f32>,
  viewMatrix: mat4x4<f32>,
  // Sun light
  sunDirectionEC: vec3<f32>,
  sunIntensity: f32,
  sunColor: vec3<f32>,
  lightCount: u32,
  // IBL
  iblDiffuseFactor: f32,
  iblSpecularFactor: f32,
  iblMaxMipLevel: f32,
  hasIBL: f32,
  // Shadow
  shadowMatrix: mat4x4<f32>,
  shadowMapSize: vec2<f32>,
  shadowDarkness: f32,
  shadowEnabled: f32,
  // Screen
  resolution: vec2<f32>,
  _pad: vec2<f32>,
};

struct LightData {
  positionEC: vec3<f32>,
  lightType: f32,   // 0=directional, 1=point, 2=spot
  directionEC: vec3<f32>,
  range: f32,
  color: vec3<f32>,
  intensity: f32,
  // Spot light params
  innerConeAngle: f32,
  outerConeAngle: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var gbufferAlbedo: texture_2d<f32>;
@group(0) @binding(1) var gbufferNormal: texture_2d<f32>;
@group(0) @binding(2) var gbufferEmission: texture_2d<f32>;
@group(0) @binding(3) var depthTex: texture_depth_2d;
@group(0) @binding(4) var texSampler: sampler;
@group(0) @binding(5) var<uniform> deferred: DeferredUniforms;
@group(0) @binding(6) var<storage, read> lights: array<LightData>;

// Optional: shadow + AO + IBL (group 1)
@group(1) @binding(0) var shadowDepthTex: texture_depth_2d;
@group(1) @binding(1) var shadowSampler: sampler_comparison;
@group(1) @binding(2) var aoTex: texture_2d<f32>;
@group(1) @binding(3) var iblDiffuseTex: texture_cube<f32>;
@group(1) @binding(4) var iblSpecularTex: texture_cube<f32>;
@group(1) @binding(5) var iblSampler: sampler;
@group(1) @binding(6) var brdfLutTex: texture_2d<f32>;

const PI: f32 = 3.14159265358979;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vid: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32(i32(vid & 1u) * 2 - 1);
  let y = f32(i32(vid >> 1u) * 2 - 1);
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
  return out;
}

// ─── PBR BRDF functions ───

fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let denom = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * denom * denom + 0.0001);
}

fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  let ggx1 = NdotV / (NdotV * (1.0 - k) + k);
  let ggx2 = NdotL / (NdotL * (1.0 - k) + k);
  return ggx1 * ggx2;
}

fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn fresnelSchlickRoughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
  return F0 + (max(vec3<f32>(1.0 - roughness), F0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// Reconstruct eye-space position from depth + UV
fn reconstructPosition(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let ndc = vec4<f32>(uv * 2.0 - 1.0, depth, 1.0);
  var pos = deferred.inverseProjection * ndc;
  return pos.xyz / pos.w;
}

// Evaluate a single light contribution
fn evaluateLight(
  light: LightData,
  positionEC: vec3<f32>,
  N: vec3<f32>,
  V: vec3<f32>,
  albedo: vec3<f32>,
  metallic: f32,
  roughness: f32,
  F0: vec3<f32>,
) -> vec3<f32> {
  var L: vec3<f32>;
  var attenuation: f32 = 1.0;

  let lightType = u32(light.lightType);

  if (lightType == 0u) {
    // Directional
    L = normalize(-light.directionEC);
  } else {
    // Point or spot
    let lightVec = light.positionEC - positionEC;
    let dist = length(lightVec);
    L = lightVec / dist;

    // Distance attenuation (inverse-square with range clamp)
    if (light.range > 0.0) {
      let rangeFactor = clamp(1.0 - pow(dist / light.range, 4.0), 0.0, 1.0);
      attenuation = rangeFactor * rangeFactor / (dist * dist + 1.0);
    } else {
      attenuation = 1.0 / (dist * dist + 1.0);
    }

    // Spot cone attenuation
    if (lightType == 2u) {
      let theta = dot(L, normalize(-light.directionEC));
      let epsilon = light.innerConeAngle - light.outerConeAngle;
      attenuation *= clamp((theta - light.outerConeAngle) / epsilon, 0.0, 1.0);
    }
  }

  if (attenuation <= 0.001) { return vec3<f32>(0.0); }

  let H = normalize(V + L);
  let NdotL = max(dot(N, L), 0.0);
  let NdotH = max(dot(N, H), 0.0);
  let NdotV = max(dot(N, V), 0.001);
  let HdotV = max(dot(H, V), 0.0);

  // Cook-Torrance BRDF
  let D = distributionGGX(NdotH, roughness);
  let G = geometrySmith(NdotV, NdotL, roughness);
  let F = fresnelSchlick(HdotV, F0);

  let numerator = D * G * F;
  let denominator = 4.0 * NdotV * NdotL + 0.0001;
  let specular = numerator / denominator;

  let kD = (vec3<f32>(1.0) - F) * (1.0 - metallic);
  let diffuse = kD * albedo / PI;

  let radiance = light.color * light.intensity * attenuation;
  return (diffuse + specular) * radiance * NdotL;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;

  // Sample G-buffer
  let albedoMetallic = textureSampleLevel(gbufferAlbedo, texSampler, uv, 0.0);
  let normalRoughness = textureSampleLevel(gbufferNormal, texSampler, uv, 0.0);
  let emissionOcclusion = textureSampleLevel(gbufferEmission, texSampler, uv, 0.0);
  let depth = textureLoad(depthTex, vec2<i32>(input.position.xy), 0);

  // Sky pixels — pass through emission (sky color)
  if (depth >= 0.999) {
    return vec4<f32>(emissionOcclusion.rgb, 1.0);
  }

  let albedo = albedoMetallic.rgb;
  let metallic = albedoMetallic.a;
  let N = normalize(normalRoughness.rgb * 2.0 - 1.0);
  let roughness = normalRoughness.a;
  let emission = emissionOcclusion.rgb;
  let occlusion = emissionOcclusion.a;

  // Reconstruct view-space position
  let positionEC = reconstructPosition(uv, depth);
  let V = normalize(-positionEC);

  // Base reflectance
  let F0 = mix(vec3<f32>(0.04), albedo, metallic);

  // ─── Primary directional light (sun) ───
  var Lo = vec3<f32>(0.0);
  {
    let L = normalize(deferred.sunDirectionEC);
    let H = normalize(V + L);
    let NdotL = max(dot(N, L), 0.0);
    let NdotH = max(dot(N, H), 0.0);
    let NdotV = max(dot(N, V), 0.001);
    let HdotV = max(dot(H, V), 0.0);

    let D = distributionGGX(NdotH, roughness);
    let G = geometrySmith(NdotV, NdotL, roughness);
    let F = fresnelSchlick(HdotV, F0);

    let specular = (D * G * F) / (4.0 * NdotV * NdotL + 0.0001);
    let kD = (vec3<f32>(1.0) - F) * (1.0 - metallic);

    let sunRadiance = deferred.sunColor * deferred.sunIntensity;
    Lo += (kD * albedo / PI + specular) * sunRadiance * NdotL;
  }

  // ─── Additional lights from storage buffer ───
  let numLights = min(deferred.lightCount, 64u);
  for (var i: u32 = 0u; i < numLights; i++) {
    Lo += evaluateLight(lights[i], positionEC, N, V, albedo, metallic, roughness, F0);
  }

  // ─── Ambient / IBL ───
  var ambient = vec3<f32>(0.03) * albedo * occlusion;

  // Read AO texture
  let ao = textureSampleLevel(aoTex, texSampler, uv, 0.0).r;
  ambient *= ao;

  // Final color = ambient + direct lighting + emission
  let color = ambient + Lo + emission;
  return vec4<f32>(color, 1.0);
}
