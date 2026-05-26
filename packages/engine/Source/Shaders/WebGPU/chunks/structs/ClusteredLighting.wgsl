// ClusteredLighting.wgsl — Forward+ FS consumer chunk.
//
// Slice 5d Batch 149, NEW-GBUFFER-CONSUMER-CLUSTERED-LIGHTING step 5.
//
// Declares the bind group + structs + helpers a fragment shader needs
// to read the per-cluster light data produced by ClusterBounds (Batch
// 147) + ClusterAssign (Batch 148) compute passes, and evaluate the
// per-light diffuse + specular contribution.
//
// # Bind group convention
//
// Consumer pipelines bind these resources at `@group(4)` (the
// first slot after the existing Camera / Material / Instance /
// Effects groups used by Model PBR). Layout matches
// `makeClusteredLightingBGL()` in WebGPUClusteredLightingBGL.ts.
//
//   @group(4) @binding(0) clusterLights        : storage<read>
//   @group(4) @binding(1) clusterAABBs         : storage<read>  (optional — for debug)
//   @group(4) @binding(2) perClusterLightCount : storage<read>
//   @group(4) @binding(3) perClusterLightIndices: storage<read>
//   @group(4) @binding(4) clusterParams        : uniform
//
// # Cluster lookup math
//
// Each fragment computes its cluster index from screen position +
// linearized depth:
//   tileX  = floor(fragCoord.x / tileSizeX)
//   tileY  = floor(fragCoord.y / tileSizeY)
//   sliceZ = clampedLogDepth(viewZ, near, far)
//   index  = tileX + tileY * 16 + sliceZ * 16 * 9
//
// Then iterates `perClusterLightCount[index]` lights via
// `perClusterLightIndices[index * 256 + k]`.
//
// # Lighting model
//
// Cook-Torrance specular + Lambert diffuse — same shape as the Model
// PBR's existing single-sun path so the additive contribution
// composites cleanly with the sun.
//
// # Usage in a consuming shader
//
//   // @chunk structs/ClusteredLighting
//   // ... rest of shader ...
//   let clusterContribution = evalClusteredLights(
//     positionEC, normalEC, viewDir, F0, roughness, baseColor,
//   );
//   finalColor = finalColor + clusterContribution;
//
// The chunk-marker pattern matches Batch 165's csm_samplePointShadow
// pattern.

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
  // .x = lightCount (active lights this frame), .yzw = unused.
  // Kept here so consumers can early-out when no lights are active
  // without reading perClusterLightCount.
  activeLightCount: vec4<f32>,
};

@group(4) @binding(0) var<storage, read> clusterLights: array<ClusteredLight>;
@group(4) @binding(1) var<storage, read> clusterAABBs: array<ClusteredAABB>;
@group(4) @binding(2) var<storage, read> perClusterLightCount: array<u32>;
@group(4) @binding(3) var<storage, read> perClusterLightIndices: array<u32>;
@group(4) @binding(4) var<uniform> clusterParams: ClusteredParams;

// Compute the cluster index for a fragment.
//
// `fragCoord` is the @builtin(position) value in the FS (window-
// space). `viewZ` is the fragment's eye-space Z (with whatever sign
// convention the projection uses — we take abs() so the depth
// distribution math is convention-independent).
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
// RGB contribution from ONE light. Caller iterates with
// clusterLightCountAt + perClusterLightIndices indirection.
//
// All inputs in eye-space:
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
    // posOrDirEC.xyz IS the direction (already normalized at
    // CPU pack time per the LightTypes.ts contract). Light comes
    // FROM that direction → L = -dir.
    L = -light.posOrDirEC.xyz;
  } else {
    // POINT or SPOT — posOrDirEC.xyz is the world-space position
    // transformed to eye-space.
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
      // Angle between spot's forward and direction TO the fragment
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
