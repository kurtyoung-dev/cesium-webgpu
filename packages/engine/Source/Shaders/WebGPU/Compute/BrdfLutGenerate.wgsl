// BrdfLutGenerate.wgsl — BRDF Integration LUT Compute Shader
//
// Generates a 256×256 lookup table for the split-sum approximation of the
// rendering equation. Each texel integrates the Cook-Torrance microfacet
// BRDF over all incoming light directions using importance-sampled GGX.
//
// U axis: NdotV (cos angle between normal and view direction)
// V axis: roughness (perceptual roughness, squared internally)
//
// Output: RG32Float texture
//   R = scale factor for F0  (Fresnel reflectance at normal incidence)
//   G = bias  factor for F0
//
// References:
//   - Brian Karis, "Real Shading in Unreal Engine 4" (SIGGRAPH 2013 Physically
//     Based Shading course) — the split-sum approximation and the scale/bias
//     environment-BRDF table this shader tabulates.
//   - Holger Dammertz, "Hammersley Points on the Hemisphere" —
//     http://holger.dammertz.org/stuff/notes_HammersleyOnHemisphere.html
//     The Van der Corput radical inverse used to generate the sample set.
//
// Usage in PBR fragment shader:
//   let brdf = textureSample(brdfLut, lutSampler, vec2(NdotV, roughness));
//   let specularIBL = (F0 * brdf.x + brdf.y) * prefilteredRadiance;

@group(0) @binding(0) var outputTex: texture_storage_2d<rg32float, write>;

const PI: f32 = 3.14159265358979323846;
const NUM_SAMPLES: u32 = 1024u;

fn radicalInverseVdC(bits_in: u32) -> f32 {
  var bits = bits_in;
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return f32(bits) * 2.3283064365386963e-10;
}

fn hammersley(i: u32, N: u32) -> vec2<f32> {
  return vec2<f32>(f32(i) / f32(N), radicalInverseVdC(i));
}

fn importanceSampleGGX(Xi: vec2<f32>, N: vec3<f32>, roughness: f32) -> vec3<f32> {
  let a = roughness * roughness;
  let phi = 2.0 * PI * Xi.x;
  let cosTheta = sqrt((1.0 - Xi.y) / (1.0 + (a * a - 1.0) * Xi.y));
  let sinTheta = sqrt(1.0 - cosTheta * cosTheta);

  let H = vec3<f32>(cos(phi) * sinTheta, sin(phi) * sinTheta, cosTheta);

  let up = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(N.z) < 0.999);
  let tangent = normalize(cross(up, N));
  let bitangent = cross(N, tangent);

  return normalize(tangent * H.x + bitangent * H.y + N * H.z);
}

fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
  let k = (roughness * roughness) / 2.0;
  return NdotV / (NdotV * (1.0 - k) + k);
}

fn geometrySmith(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32) -> f32 {
  let NdotV = max(dot(N, V), 0.0);
  let NdotL = max(dot(N, L), 0.0);
  return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);
}

fn integrateBRDF(NdotV: f32, roughness: f32) -> vec2<f32> {
  let V = vec3<f32>(sqrt(1.0 - NdotV * NdotV), 0.0, NdotV);
  var A: f32 = 0.0;
  var B: f32 = 0.0;
  let N = vec3<f32>(0.0, 0.0, 1.0);

  for (var i: u32 = 0u; i < NUM_SAMPLES; i = i + 1u) {
    let Xi = hammersley(i, NUM_SAMPLES);
    let H = importanceSampleGGX(Xi, N, roughness);
    let L = normalize(2.0 * dot(V, H) * H - V);

    let NdotL = max(L.z, 0.0);
    let NdotH = max(H.z, 0.0);
    let VdotH = max(dot(V, H), 0.0);

    if (NdotL > 0.0) {
      let G = geometrySmith(N, V, L, roughness);
      let G_Vis = (G * VdotH) / (NdotH * NdotV);
      let Fc = pow(1.0 - VdotH, 5.0);

      A = A + (1.0 - Fc) * G_Vis;
      B = B + Fc * G_Vis;
    }
  }

  return vec2<f32>(A, B) / f32(NUM_SAMPLES);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(outputTex);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }

  let NdotV = max((f32(gid.x) + 0.5) / f32(dims.x), 0.001);
  let roughness = (f32(gid.y) + 0.5) / f32(dims.y);

  let result = integrateBRDF(NdotV, roughness);

  textureStore(outputTex, vec2<i32>(gid.xy), vec4<f32>(result, 0.0, 1.0));
}
