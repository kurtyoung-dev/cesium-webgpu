// Forward+ clustered-lighting fragment chunk.
//
// Declares the effects-group resources, record layouts, cluster lookup, and
// punctual and area-light evaluation used by consuming fragment shaders. The
// cluster-bounds and cluster-assignment compute passes populate the storage
// resources before consumer draws.
//
// Supported Windows D3D12 and Vulkan devices expose four bind groups, so these
// resources share the existing effects group. `__CL_GROUP__` is replaced with
// the consuming pipeline's effects-group index before this chunk is prepended.
// Model PBR uses group 3; primitive lit materials use group 2 or 3 depending on
// whether a texture group is present.
//
// Effects bindings:
//   18  punctual-light records
//   19  cluster AABBs available to diagnostic consumers
//   20  per-cluster light counts
//   21  per-cluster light indices
//   22  viewport, frustum planes, and active counts
//   23  LTC lookup texture
//   25  area-light records
//
// Binding 24 is unused because LTC sampling uses `textureLoad` and manual
// bilinear interpolation without a sampler. The matching layout entries live
// in `WebGPUClusteredLightingBGL.ts`.
//
// Each fragment derives its cluster from screen position and logarithmic
// eye-space depth:
//   tileX  = floor(fragCoord.x / tileSizeX)
//   tileY  = floor(fragCoord.y / tileSizeY)
//   sliceZ = clampedLogDepth(viewZ, near, far)
//   index  = tileX + tileY * 16 + sliceZ * 16 * 9
//
// The fragment then traverses `perClusterLightCount[index]` entries through
// `perClusterLightIndices[index * 256 + k]`. Punctual lights use Lambert
// diffuse and Cook-Torrance specular so their additive contribution matches the
// Model PBR direct-lighting shape.

// Grid constants — must match WebGPUClusterBoundsRenderer.ts.
const CL_TILE_COUNT_X: u32 = 16u;
const CL_TILE_COUNT_Y: u32 = 9u;
const CL_SLICE_COUNT_Z: u32 = 24u;
const CL_MAX_LIGHTS_PER_CLUSTER: u32 = 256u;

// Light type enum (matches LightType in LightTypes.ts +
// ClusterAssign.wgsl).
const CL_LIGHT_TYPE_DIRECTIONAL: i32 = 0;
const CL_LIGHT_TYPE_POINT: i32 = 1;
const CL_LIGHT_TYPE_SPOT: i32 = 2;

// Per-light record — must match ClusteredLight in ClusterAssign.wgsl.
struct ClusteredLight {
  posOrDirEC: vec4<f32>,
  colorAndIntensity: vec4<f32>,
  rangeAndAtten: vec4<f32>,
  coneAngles: vec4<f32>,
  spotDirEC: vec4<f32>,
};

struct ClusteredAABB {
  minPos: vec4<f32>,
  maxPos: vec4<f32>,
};

// Per-frame uniform: viewport dims + frustum near/far (for the cluster
// Z-slice mapping). 32 bytes; padded to 256-byte alignment at the
// buffer-allocation site.
struct ClusteredParams {
  // .xy = viewport (width, height), .zw = (near, far)
  viewportAndPlanes: vec4<f32>,
  // `.x` is the punctual-light count, `.y` is the area-light count, and
  // `.zw` are reserved. Consumers gate storage and texture reads on the counts.
  activeLightCount: vec4<f32>,
};

// Rectangular and disk area lights use linearly transformed cosines. The
// `rgba16float` array texture contains inverse-matrix terms in layer 0 and
// magnitude, Fresnel, and sphere terms in layer 1. A zero area-light count
// returns before reading the LUT or storage buffer.
//
// Reference: Heitz, Dupuy, Hill, and Neubelt, "Real-Time Polygonal-Light
// Shading with Linearly Transformed Cosines," ACM TOG 35(4), 2016. The LUTs
// and edge and cubic routines are adapted from the authors' reference
// implementation at https://github.com/selfshadow/ltc_code; its BSD-style
// license is reproduced in LICENSE.md.

const LTC_LUT_SIZE_F: f32 = 64.0;
const LTC_LUT_SCALE: f32 = 63.0 / 64.0;
const LTC_LUT_BIAS: f32 = 0.5 / 64.0;
const LTC_MAX_AREA_LIGHTS: u32 = 8u;
const LTC_TYPE_RECT: i32 = 3;
const LTC_TYPE_DISK: i32 = 4;

// Per-area-light record — must match LTCAreaLight packing in
// WebGPUClusteredLightingDispatcher._packAreaLights (96 B / 6 vec4).
struct LTCAreaLight {
  centerEC: vec4<f32>,          // .xyz center (eye-space), .w = lightType
  colorAndIntensity: vec4<f32>, // .rgb color, .w = intensity (radiance)
  axisXEC: vec4<f32>,           // .xyz half-width vector (eye-space), .w = halfW
  axisYEC: vec4<f32>,           // .xyz half-height vector, .w = halfH
  paramsA: vec4<f32>,           // .x = twoSided, .y = cullRadius, .zw reserved
  paramsB: vec4<f32>,           // reserved
};

// This source is never compiled alone. The prepend site replaces
// `__CL_GROUP__` with the consuming pipeline's effects-group index before
// shader-module creation.
@group(__CL_GROUP__) @binding(18) var<storage, read> clusterLights: array<ClusteredLight>;
@group(__CL_GROUP__) @binding(19) var<storage, read> clusterAABBs: array<ClusteredAABB>;
@group(__CL_GROUP__) @binding(20) var<storage, read> perClusterLightCount: array<u32>;
@group(__CL_GROUP__) @binding(21) var<storage, read> perClusterLightIndices: array<u32>;
@group(__CL_GROUP__) @binding(22) var<uniform> clusterParams: ClusteredParams;
// The Model PBR fragment stage already consumes 16 samplers, so the LTC LUT
// uses `textureLoad` and manual bilinear interpolation instead of a sampler.
@group(__CL_GROUP__) @binding(23) var ltcLUT: texture_2d_array<f32>;
@group(__CL_GROUP__) @binding(25) var<storage, read> areaLights: array<LTCAreaLight>;

// Compute the cluster index for a fragment.
//
// `fragCoord` is the fragment-stage `@builtin(position)` value in window
// space. `abs(viewZ)` makes the depth distribution independent of the
// projection's eye-space Z sign convention.
fn clusterIndexFor(fragCoord: vec2<f32>, viewZ: f32) -> u32 {
  let viewport = clusterParams.viewportAndPlanes.xy;
  let near = clusterParams.viewportAndPlanes.z;
  let far = clusterParams.viewportAndPlanes.w;

  let tileSizeX = viewport.x / f32(CL_TILE_COUNT_X);
  let tileSizeY = viewport.y / f32(CL_TILE_COUNT_Y);
  let tileX = u32(clamp(floor(fragCoord.x / tileSizeX), 0.0, f32(CL_TILE_COUNT_X - 1u)));
  let tileY = u32(clamp(floor(fragCoord.y / tileSizeY), 0.0, f32(CL_TILE_COUNT_Y - 1u)));

  // Exponential slice mapping (matches ClusterBounds.wgsl):
  //   eye-z(slice) = near * (far/near)^(slice/N)
  // Solve for slice:
  //   slice = N * log(z/near) / log(far/near)
  let absZ = max(abs(viewZ), near);
  let logZ = log(absZ / near);
  let logRatio = log(far / near);
  let sliceFloat = (logZ / logRatio) * f32(CL_SLICE_COUNT_Z);
  let sliceZ = u32(clamp(sliceFloat, 0.0, f32(CL_SLICE_COUNT_Z - 1u)));

  return tileX + tileY * CL_TILE_COUNT_X + sliceZ * CL_TILE_COUNT_X * CL_TILE_COUNT_Y;
}

// Diagnostic helper: returns the number of lights affecting a
// fragment. Used by ClusterDebug.wgsl visualization.
fn clusterLightCountAt(fragCoord: vec2<f32>, viewZ: f32) -> u32 {
  let idx = clusterIndexFor(fragCoord, viewZ);
  return perClusterLightCount[idx];
}

// Lambert + Cook-Torrance per-light evaluation. Returns the additive
// RGB contribution from one light. The caller iterates with
// clusterLightCountAt + perClusterLightIndices indirection.
//
// All inputs are in eye space:
//   posEC      : fragment position in eye-space
//   N          : surface normal (unit length) in eye-space
//   V          : view direction (unit length) in eye-space — i.e.,
//                normalize(-posEC) for perspective scenes
//   F0         : Fresnel reflectance at normal incidence (per-material)
//   roughness  : material roughness ∈ [0, 1]
//   baseColor  : diffuse albedo ∈ RGB
//   light      : the per-cluster ClusteredLight record
fn evalSingleClusteredLight(
  posEC: vec3<f32>,
  N: vec3<f32>,
  V: vec3<f32>,
  F0: vec3<f32>,
  roughness: f32,
  baseColor: vec3<f32>,
  light: ClusteredLight,
) -> vec3<f32> {
  let lightType = i32(light.posOrDirEC.w);

  // Light direction (unit, from fragment to light).
  var L: vec3<f32>;
  var attenuation: f32 = 1.0;

  if (lightType == CL_LIGHT_TYPE_DIRECTIONAL) {
    // `posOrDirEC.xyz` is the direction, normalized by the CPU packing
    // contract. Light arrives from that direction, so `L = -dir`.
    L = -light.posOrDirEC.xyz;
  } else {
    // Point and spot records contain a world-space position transformed to
    // eye space.
    let toLight = light.posOrDirEC.xyz - posEC;
    let dist = length(toLight);
    if (dist < 1e-4) {
      // Coincident with light — undefined direction. Skip.
      return vec3<f32>(0.0);
    }
    L = toLight / dist;

    // Distance attenuation. glTF KHR_lights_punctual smooth falloff:
    //   atten = (1 - (d/range)^4)^2 / (max(d, 0.01)^2)
    let range = light.rangeAndAtten.x;
    if (range > 0.0) {
      if (dist > range) {
        return vec3<f32>(0.0);
      }
      let falloff = pow(1.0 - pow(dist / range, 4.0), 2.0);
      attenuation = falloff / max(dist * dist, 1e-4);
    } else {
      attenuation = 1.0 / max(dist * dist, 1e-4);
    }

    // Spot cone gate.
    if (lightType == CL_LIGHT_TYPE_SPOT) {
      let spotDir = normalize(light.spotDirEC.xyz);
      // Angle between the spot's forward axis and direction to the fragment
      // (= -L since L points fragment→light). spot-forward.dot(-L) is
      // cosAngle from the cone axis to the fragment ray.
      let cosAngle = dot(spotDir, -L);
      let cosInner = cos(light.coneAngles.x);
      let cosOuter = cos(light.coneAngles.y);
      // Smoothstep from outer (full attenuation) to inner (full intensity).
      let coneFalloff = clamp(
        (cosAngle - cosOuter) / max(cosInner - cosOuter, 1e-4),
        0.0,
        1.0,
      );
      attenuation = attenuation * coneFalloff;
      if (attenuation <= 0.0) {
        return vec3<f32>(0.0);
      }
    }
  }

  let NdotL = max(dot(N, L), 0.0);
  if (NdotL <= 0.0) {
    return vec3<f32>(0.0);
  }

  // Lambert diffuse.
  let diffuse = baseColor * (1.0 / 3.141592653589793);

  // Cook-Torrance specular (GGX / Trowbridge-Reitz NDF + Schlick
  // Fresnel + Smith geometry).
  let H = normalize(L + V);
  let NdotH = max(dot(N, H), 0.0);
  let NdotV = max(dot(N, V), 0.0);
  let VdotH = max(dot(V, H), 0.0);

  let alpha = roughness * roughness;
  let alphaSq = alpha * alpha;

  // GGX NDF
  let denom = NdotH * NdotH * (alphaSq - 1.0) + 1.0;
  let D = alphaSq / (3.141592653589793 * denom * denom);

  // Schlick Fresnel
  let F = F0 + (vec3<f32>(1.0) - F0) * pow(1.0 - VdotH, 5.0);

  // Smith geometry (separable, GGX)
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let G_V = NdotV / max(NdotV * (1.0 - k) + k, 1e-4);
  let G_L = NdotL / max(NdotL * (1.0 - k) + k, 1e-4);
  let G = G_V * G_L;

  let specular = (D * G * F) / max(4.0 * NdotV * NdotL, 1e-4);

  let radiance = light.colorAndIntensity.xyz * light.colorAndIntensity.w * attenuation;
  // Energy-conserving diffuse: scale by (1 - F) to avoid double-
  // counting specular reflection in the diffuse term.
  let kD = (vec3<f32>(1.0) - F);
  return (kD * diffuse + specular) * radiance * NdotL;
}

// Iterates the cluster's light list and sums contributions. Returns
// vec3<f32>(0) when the cluster has no lights or the early-out
// `activeLightCount` is zero — cheap pass-through for scenes without
// clustered lighting.
fn evalClusteredLights(
  posEC: vec3<f32>,
  N: vec3<f32>,
  V: vec3<f32>,
  F0: vec3<f32>,
  roughness: f32,
  baseColor: vec3<f32>,
  fragCoord: vec2<f32>,
  viewZ: f32,
) -> vec3<f32> {
  if (clusterParams.activeLightCount.x < 0.5) {
    return vec3<f32>(0.0);
  }

  let clusterIdx = clusterIndexFor(fragCoord, viewZ);
  let count = perClusterLightCount[clusterIdx];

  var sum = vec3<f32>(0.0);
  let indexBase = clusterIdx * CL_MAX_LIGHTS_PER_CLUSTER;
  for (var k: u32 = 0u; k < count; k = k + 1u) {
    let lightIdx = perClusterLightIndices[indexBase + k];
    let light = clusterLights[lightIdx];
    sum = sum + evalSingleClusteredLight(
      posEC, N, V, F0, roughness, baseColor, light,
    );
  }
  return sum;
}

// Fitted rational-polynomial replacement for the analytic edge integral
// (avoids acos). The 1/(2*pi) normalization is baked into the fit.
fn ltcIntegrateEdgeVec(v1: vec3<f32>, v2: vec3<f32>) -> vec3<f32> {
  let x = dot(v1, v2);
  let y = abs(x);
  let a = 0.8543985 + (0.4965155 + 0.0145206 * y) * y;
  let b = 3.4175940 + (4.1616724 + y) * y;
  let v = a / b;
  var theta_sintheta: f32;
  if (x > 0.0) {
    theta_sintheta = v;
  } else {
    theta_sintheta = 0.5 * inverseSqrt(max(1.0 - x * x, 1e-7)) - v;
  }
  return cross(v1, v2) * theta_sintheta;
}

fn ltcIntegrateEdge(v1: vec3<f32>, v2: vec3<f32>) -> f32 {
  return ltcIntegrateEdgeVec(v1, v2).z;
}

// Bilinear LUT fetch via textureLoad (no sampler). `uv` is the normalized
// [0,1] texture coordinate already carrying the reference LUT_SCALE/BIAS
// half-texel correction; this replicates a linear clamp-to-edge sampler:
// texel-space = uv*64 - 0.5, then lerp the 4 neighbors.
fn ltcSampleLUT(uv: vec2<f32>, layer: i32) -> vec4<f32> {
  let px = uv * LTC_LUT_SIZE_F - vec2<f32>(0.5);
  let ip = floor(px);
  let f = px - ip;
  let x0 = clamp(i32(ip.x), 0, 63);
  let y0 = clamp(i32(ip.y), 0, 63);
  let x1 = min(x0 + 1, 63);
  let y1 = min(y0 + 1, 63);
  let c00 = textureLoad(ltcLUT, vec2<i32>(x0, y0), layer, 0);
  let c10 = textureLoad(ltcLUT, vec2<i32>(x1, y0), layer, 0);
  let c01 = textureLoad(ltcLUT, vec2<i32>(x0, y1), layer, 0);
  let c11 = textureLoad(ltcLUT, vec2<i32>(x1, y1), layer, 0);
  let cx0 = mix(c00, c10, f.x);
  let cx1 = mix(c01, c11, f.x);
  return mix(cx0, cx1, f.y);
}

// Clip the quad to the upper hemisphere (z > 0). Returns the resulting
// vertex count n ∈ {0,3,4,5}; L is rewritten in place. The 16-case
// configuration table is adapted from the cited reference implementation.
fn ltcClipQuadToHorizon(L: ptr<function, array<vec3<f32>, 5>>) -> u32 {
  var config: i32 = 0;
  if ((*L)[0].z > 0.0) { config += 1; }
  if ((*L)[1].z > 0.0) { config += 2; }
  if ((*L)[2].z > 0.0) { config += 4; }
  if ((*L)[3].z > 0.0) { config += 8; }

  var n: u32 = 0u;

  if (config == 0) {
    n = 0u;
  } else if (config == 1) {
    n = 3u;
    (*L)[1] = -(*L)[1].z * (*L)[0] + (*L)[0].z * (*L)[1];
    (*L)[2] = -(*L)[3].z * (*L)[0] + (*L)[0].z * (*L)[3];
  } else if (config == 2) {
    n = 3u;
    (*L)[0] = -(*L)[0].z * (*L)[1] + (*L)[1].z * (*L)[0];
    (*L)[2] = -(*L)[2].z * (*L)[1] + (*L)[1].z * (*L)[2];
  } else if (config == 3) {
    n = 4u;
    (*L)[2] = -(*L)[2].z * (*L)[1] + (*L)[1].z * (*L)[2];
    (*L)[3] = -(*L)[3].z * (*L)[0] + (*L)[0].z * (*L)[3];
  } else if (config == 4) {
    n = 3u;
    (*L)[0] = -(*L)[3].z * (*L)[2] + (*L)[2].z * (*L)[3];
    (*L)[1] = -(*L)[1].z * (*L)[2] + (*L)[2].z * (*L)[1];
  } else if (config == 5) {
    n = 0u;
  } else if (config == 6) {
    n = 4u;
    (*L)[0] = -(*L)[0].z * (*L)[1] + (*L)[1].z * (*L)[0];
    (*L)[3] = -(*L)[3].z * (*L)[2] + (*L)[2].z * (*L)[3];
  } else if (config == 7) {
    n = 5u;
    (*L)[4] = -(*L)[3].z * (*L)[0] + (*L)[0].z * (*L)[3];
    (*L)[3] = -(*L)[3].z * (*L)[2] + (*L)[2].z * (*L)[3];
  } else if (config == 8) {
    n = 3u;
    (*L)[0] = -(*L)[0].z * (*L)[3] + (*L)[3].z * (*L)[0];
    (*L)[1] = -(*L)[2].z * (*L)[3] + (*L)[3].z * (*L)[2];
    (*L)[2] = (*L)[3];
  } else if (config == 9) {
    n = 4u;
    (*L)[1] = -(*L)[1].z * (*L)[0] + (*L)[0].z * (*L)[1];
    (*L)[2] = -(*L)[2].z * (*L)[3] + (*L)[3].z * (*L)[2];
  } else if (config == 10) {
    n = 0u;
  } else if (config == 11) {
    n = 5u;
    (*L)[4] = (*L)[3];
    (*L)[3] = -(*L)[2].z * (*L)[3] + (*L)[3].z * (*L)[2];
    (*L)[2] = -(*L)[2].z * (*L)[1] + (*L)[1].z * (*L)[2];
  } else if (config == 12) {
    n = 4u;
    (*L)[1] = -(*L)[1].z * (*L)[2] + (*L)[2].z * (*L)[1];
    (*L)[0] = -(*L)[0].z * (*L)[3] + (*L)[3].z * (*L)[0];
  } else if (config == 13) {
    n = 5u;
    (*L)[4] = (*L)[3];
    (*L)[3] = (*L)[2];
    (*L)[2] = -(*L)[1].z * (*L)[2] + (*L)[2].z * (*L)[1];
    (*L)[1] = -(*L)[1].z * (*L)[0] + (*L)[0].z * (*L)[1];
  } else if (config == 14) {
    n = 5u;
    (*L)[4] = -(*L)[0].z * (*L)[3] + (*L)[3].z * (*L)[0];
    (*L)[0] = -(*L)[0].z * (*L)[1] + (*L)[1].z * (*L)[0];
  } else if (config == 15) {
    n = 4u;
  }

  if (n == 3u) { (*L)[3] = (*L)[0]; }
  if (n == 4u) { (*L)[4] = (*L)[0]; }
  return n;
}

// Rect area-light form factor via horizon-clipped polygon integration.
fn ltcEvaluateRect(
  N: vec3<f32>, V: vec3<f32>, P: vec3<f32>, MinvIn: mat3x3<f32>,
  p0: vec3<f32>, p1: vec3<f32>, p2: vec3<f32>, p3: vec3<f32>,
  twoSided: bool,
) -> f32 {
  let T1 = normalize(V - N * dot(V, N));
  let T2 = cross(N, T1);
  let Minv = MinvIn * transpose(mat3x3<f32>(T1, T2, N));

  var L: array<vec3<f32>, 5>;
  L[0] = Minv * (p0 - P);
  L[1] = Minv * (p1 - P);
  L[2] = Minv * (p2 - P);
  L[3] = Minv * (p3 - P);
  L[4] = vec3<f32>(0.0);

  let n = ltcClipQuadToHorizon(&L);
  if (n == 0u) {
    return 0.0;
  }
  L[0] = normalize(L[0]);
  L[1] = normalize(L[1]);
  L[2] = normalize(L[2]);
  L[3] = normalize(L[3]);
  L[4] = normalize(L[4]);

  var sum = ltcIntegrateEdge(L[0], L[1]);
  sum += ltcIntegrateEdge(L[1], L[2]);
  sum += ltcIntegrateEdge(L[2], L[3]);
  if (n >= 4u) { sum += ltcIntegrateEdge(L[3], L[4]); }
  if (n == 5u) { sum += ltcIntegrateEdge(L[4], L[0]); }

  if (twoSided) {
    return abs(sum);
  }
  return max(0.0, sum);
}

// Solve c3 x^3 + c2 x^2 + c1 x + c0 (coeff = vec4(c0,c1,c2,c3)) for the
// three real roots. `SolveCubic` is adapted from the cited reference
// implementation's extended Blinn/Peters form. WGSL's two-argument `atan` is
// `atan2`.
fn ltcSolveCubic(coeffIn: vec4<f32>) -> vec3<f32> {
  var Coefficient = coeffIn;
  let cx = Coefficient.x;
  let cy = Coefficient.y / 3.0 / Coefficient.w;
  let cz = Coefficient.z / 3.0 / Coefficient.w;
  let cw = 1.0;
  Coefficient = vec4<f32>(cx / coeffIn.w, cy, cz, cw);

  let B = Coefficient.z;
  let C = Coefficient.y;
  let D = Coefficient.x;

  let Delta = vec3<f32>(
    -Coefficient.z * Coefficient.z + Coefficient.y,
    -Coefficient.y * Coefficient.z + Coefficient.x,
    dot(vec2<f32>(Coefficient.z, -Coefficient.y), Coefficient.xy)
  );

  let Discriminant = dot(vec2<f32>(4.0 * Delta.x, -Delta.y), Delta.zy);

  var xlc: vec2<f32>;
  var xsc: vec2<f32>;

  // Algorithm A
  {
    let A_a = 1.0;
    let C_a = Delta.x;
    let D_a = -2.0 * B * Delta.x + Delta.y;
    let Theta = atan2(sqrt(max(Discriminant, 0.0)), -D_a) / 3.0;
    let x_1a = 2.0 * sqrt(max(-C_a, 0.0)) * cos(Theta);
    let x_3a = 2.0 * sqrt(max(-C_a, 0.0)) * cos(Theta + (2.0 / 3.0) * 3.14159265);
    var xl: f32;
    if ((x_1a + x_3a) > 2.0 * B) {
      xl = x_1a;
    } else {
      xl = x_3a;
    }
    xlc = vec2<f32>(xl - B, A_a);
  }

  // Algorithm D
  {
    let A_d = D;
    let C_d = Delta.z;
    let D_d = -D * Delta.y + 2.0 * C * Delta.z;
    let Theta = atan2(D * sqrt(max(Discriminant, 0.0)), -D_d) / 3.0;
    let x_1d = 2.0 * sqrt(max(-C_d, 0.0)) * cos(Theta);
    let x_3d = 2.0 * sqrt(max(-C_d, 0.0)) * cos(Theta + (2.0 / 3.0) * 3.14159265);
    var xs: f32;
    if (x_1d + x_3d < 2.0 * C) {
      xs = x_1d;
    } else {
      xs = x_3d;
    }
    xsc = vec2<f32>(-D, xs + C);
  }

  let E = xlc.y * xsc.y;
  let F = -xlc.x * xsc.y - xlc.y * xsc.x;
  let G = xlc.x * xsc.x;

  let xmc = vec2<f32>(C * F - B * G, -B * F + C * E);

  var Root = vec3<f32>(xsc.x / xsc.y, xmc.x / xmc.y, xlc.x / xlc.y);

  if (Root.x < Root.y && Root.x < Root.z) {
    Root = Root.yxz;
  } else if (Root.z < Root.x && Root.z < Root.y) {
    Root = Root.xzy;
  }
  return Root;
}

// Disk (ellipse) area-light form factor. `points` = 3 corners of the
// ellipse bounding rect (p0,p1,p2). The analytic path is adapted from the
// cited reference implementation's disk `LTC_Evaluate`; its Monte Carlo path
// is not needed here.
fn ltcEvaluateDisk(
  N: vec3<f32>, V: vec3<f32>, P: vec3<f32>, Minv: mat3x3<f32>,
  p0: vec3<f32>, p1: vec3<f32>, p2: vec3<f32>,
  twoSided: bool,
) -> f32 {
  let T1 = normalize(V - N * dot(V, N));
  let T2 = cross(N, T1);
  let R = transpose(mat3x3<f32>(T1, T2, N));

  let l0 = R * (p0 - P);
  let l1 = R * (p1 - P);
  let l2 = R * (p2 - P);

  var Cc = 0.5 * (l0 + l2);
  var V1 = 0.5 * (l1 - l2);
  var V2 = 0.5 * (l1 - l0);

  Cc = Minv * Cc;
  V1 = Minv * V1;
  V2 = Minv * V2;

  if (!twoSided && dot(cross(V1, V2), Cc) < 0.0) {
    return 0.0;
  }

  var a: f32;
  var b: f32;
  let d11 = dot(V1, V1);
  let d22 = dot(V2, V2);
  let d12 = dot(V1, V2);
  if (abs(d12) / sqrt(max(d11 * d22, 1e-12)) > 0.0001) {
    let tr = d11 + d22;
    var det = -d12 * d12 + d11 * d22;
    det = sqrt(max(det, 0.0));
    let u = 0.5 * sqrt(max(tr - 2.0 * det, 0.0));
    let v = 0.5 * sqrt(max(tr + 2.0 * det, 0.0));
    let e_max = (u + v) * (u + v);
    let e_min = (u - v) * (u - v);
    var V1_: vec3<f32>;
    var V2_: vec3<f32>;
    if (d11 > d22) {
      V1_ = d12 * V1 + (e_max - d11) * V2;
      V2_ = d12 * V1 + (e_min - d11) * V2;
    } else {
      V1_ = d12 * V2 + (e_max - d22) * V1;
      V2_ = d12 * V2 + (e_min - d22) * V1;
    }
    a = 1.0 / e_max;
    b = 1.0 / e_min;
    V1 = normalize(V1_);
    V2 = normalize(V2_);
  } else {
    a = 1.0 / dot(V1, V1);
    b = 1.0 / dot(V2, V2);
    V1 = V1 * sqrt(a);
    V2 = V2 * sqrt(b);
  }

  var V3 = cross(V1, V2);
  if (dot(Cc, V3) < 0.0) {
    V3 = V3 * -1.0;
  }

  let Ldist = dot(V3, Cc);
  let x0 = dot(V1, Cc) / Ldist;
  let y0 = dot(V2, Cc) / Ldist;

  a *= Ldist * Ldist;
  b *= Ldist * Ldist;

  let c0 = a * b;
  let c1 = a * b * (1.0 + x0 * x0 + y0 * y0) - a - b;
  let c2 = 1.0 - a * (1.0 + x0 * x0) - b * (1.0 + y0 * y0);
  let c3 = 1.0;

  let roots = ltcSolveCubic(vec4<f32>(c0, c1, c2, c3));
  let e1 = roots.x;
  let e2 = roots.y;
  let e3 = roots.z;

  var avgDir = vec3<f32>(a * x0 / (a - e2), b * y0 / (b - e2), 1.0);
  let rotate = mat3x3<f32>(V1, V2, V3);
  avgDir = rotate * avgDir;
  avgDir = normalize(avgDir);

  let L1 = sqrt(max(-e2 / e3, 0.0));
  let L2 = sqrt(max(-e2 / e1, 0.0));

  let formFactor = L1 * L2 * inverseSqrt((1.0 + L1 * L1) * (1.0 + L2 * L2));

  var uv = vec2<f32>(avgDir.z * 0.5 + 0.5, formFactor);
  uv = uv * LTC_LUT_SCALE + LTC_LUT_BIAS;
  let scale = ltcSampleLUT(uv, 1).w;

  return formFactor * scale;
}

// Iterate the active LTC area lights and accumulate their contribution.
// Returns vec3(0) when `activeLightCount.y == 0` before reading area-light
// resources, leaving the caller's lighting result unchanged. All inputs are in
// eye space.
fn evalLTCAreaLights(
  posEC: vec3<f32>,
  N: vec3<f32>,
  V: vec3<f32>,
  F0: vec3<f32>,
  roughness: f32,
  baseColor: vec3<f32>,
) -> vec3<f32> {
  let count = u32(clusterParams.activeLightCount.y + 0.5);
  if (count == 0u) {
    return vec3<f32>(0.0);
  }

  // The LUT fetch stays outside the per-light loop so it runs in uniform
  // control flow. UV = (perceptualRoughness, sqrt(1 - NdotV)).
  let ndotv = clamp(dot(N, V), 0.0, 1.0);
  var uv = vec2<f32>(roughness, sqrt(1.0 - ndotv));
  uv = uv * LTC_LUT_SCALE + LTC_LUT_BIAS;
  let t1 = ltcSampleLUT(uv, 0);
  let t2 = ltcSampleLUT(uv, 1);

  let Minv = mat3x3<f32>(
    vec3<f32>(t1.x, 0.0, t1.y),
    vec3<f32>(0.0, 1.0, 0.0),
    vec3<f32>(t1.z, 0.0, t1.w),
  );
  let identity = mat3x3<f32>(
    vec3<f32>(1.0, 0.0, 0.0),
    vec3<f32>(0.0, 1.0, 0.0),
    vec3<f32>(0.0, 0.0, 1.0),
  );
  // Pre-integrated magnitude + average Schlick-Fresnel over the lobe.
  let fresnel = F0 * t2.x + (vec3<f32>(1.0) - F0) * t2.y;
  let kD = vec3<f32>(1.0) - fresnel;

  var result = vec3<f32>(0.0);
  let maxCount = min(count, LTC_MAX_AREA_LIGHTS);
  for (var i: u32 = 0u; i < maxCount; i = i + 1u) {
    let light = areaLights[i];
    let center = light.centerEC.xyz;
    let ltype = i32(light.centerEC.w + 0.5);
    let axisX = light.axisXEC.xyz;
    let axisY = light.axisYEC.xyz;
    let twoSided = light.paramsA.x > 0.5;
    let cullR = light.paramsA.y;
    if (cullR > 0.0 && distance(posEC, center) > cullR) {
      continue;
    }

    // Corner winding chosen so the polygon's geometric normal equals the
    // packed emitter normal (+direction): a one-sided light emits toward
    // the side it faces. axisX = right = cross(direction, up), axisY = up,
    // and cross(right, up) = -direction. The order (-x-y, -x+y, +x+y,
    // +x-y) flips the geometric normal back to +direction.
    let corner0 = center - axisX - axisY;
    let corner1 = center - axisX + axisY;
    let corner2 = center + axisX + axisY;

    var specSum: f32;
    var diffSum: f32;
    if (ltype == LTC_TYPE_DISK) {
      specSum = ltcEvaluateDisk(N, V, posEC, Minv, corner0, corner1, corner2, twoSided);
      diffSum = ltcEvaluateDisk(N, V, posEC, identity, corner0, corner1, corner2, twoSided);
    } else {
      let corner3 = center + axisX - axisY;
      specSum = ltcEvaluateRect(N, V, posEC, Minv, corner0, corner1, corner2, corner3, twoSided);
      diffSum = ltcEvaluateRect(N, V, posEC, identity, corner0, corner1, corner2, corner3, twoSided);
    }

    let spec = specSum * fresnel;
    let diff = baseColor * diffSum * kD;
    let radiance = light.colorAndIntensity.xyz * light.colorAndIntensity.w;
    result = result + radiance * (spec + diff);
  }

  return result;
}
