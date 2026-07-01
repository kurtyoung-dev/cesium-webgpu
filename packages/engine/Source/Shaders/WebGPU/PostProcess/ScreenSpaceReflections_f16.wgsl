// Screen-Space Reflections (SSR) — f16 variant
// (PARITY-F16-POSTPROCESS). Hand-tuned half-precision version of
// `ScreenSpaceReflections.wgsl`. Selected when `context.useShaderF16`
// is true. Keep in sync with the f32 reference.
//
// f16 policy — DELIBERATELY CONSERVATIVE. SSR is end-to-end precision-
// critical: view-space position reconstruction (inverse-projection
// matrix multiply + perspective divide), clip-space projection, screen-
// space ray marching, and binary refinement all depend on full f32
// precision. Doing ANY of that in f16 would break the ray hits (wrong
// depths, drifting UVs). So the trace + reconstruction stay F32 and
// match the f32 reference bit-for-bit; only the final Fresnel/roughness-
// weighted COLOR blend narrows to f16 (both inputs SDR/bounded). The
// file exists so the f16-enabled pipeline has a variant for every stage
// via the uniform selection path.

enable f16;

struct SSRUniforms {
  projection: mat4x4<f32>,
  inverseProjection: mat4x4<f32>,
  resolution: vec4<f32>,
  params: vec4<f32>,
  params2: vec4<f32>,
  flags: vec4<f32>,
};

@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_2d<f32>;
@group(0) @binding(2) var normalTex: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;
@group(0) @binding(4) var<uniform> ssr: SSRUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 2 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 2 - 1);
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
  return out;
}

fn reconstructViewPosition(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let ndc = vec4<f32>(uv * 2.0 - 1.0, depth, 1.0);
  var viewPos = ssr.inverseProjection * ndc;
  viewPos /= viewPos.w;
  return viewPos.xyz;
}

fn projectToScreen(viewPos: vec3<f32>) -> vec3<f32> {
  var clipPos = ssr.projection * vec4<f32>(viewPos, 1.0);
  clipPos /= clipPos.w;
  let screenUV = clipPos.xy * 0.5 + 0.5;
  return vec3<f32>(screenUV.x, 1.0 - screenUV.y, clipPos.z);
}

fn screenEdgeFade(uv: vec2<f32>) -> f32 {
  let fadeWidth = ssr.params2.x;
  let edgeDist = min(
    min(uv.x, 1.0 - uv.x),
    min(uv.y, 1.0 - uv.y)
  );
  return smoothstep(0.0, fadeWidth, edgeDist);
}

fn fresnelFade(NdotV: f32) -> f32 {
  let power = ssr.params2.w;
  return pow(1.0 - clamp(NdotV, 0.0, 1.0), power);
}

fn traceRay(
  origin: vec3<f32>,
  direction: vec3<f32>,
) -> vec4<f32> {
  let maxDist = ssr.params.x;
  let thickness = ssr.params.y;
  let maxSteps = i32(ssr.params.z);
  let stride = ssr.params.w;

  var rayPos = origin;
  let step = direction * stride;

  var hitUV = vec2<f32>(0.0);
  var hit = false;

  for (var i: i32 = 0; i < maxSteps; i++) {
    rayPos += step;

    if (length(rayPos - origin) > maxDist) { break; }

    let screenCoord = projectToScreen(rayPos);
    let uv = screenCoord.xy;

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { break; }

    let sampleDepth = textureSampleLevel(depthTex, texSampler, uv, 0.0).r;
    let sampleViewPos = reconstructViewPosition(uv, sampleDepth);

    let depthDiff = rayPos.z - sampleViewPos.z;

    if (depthDiff > 0.0 && depthDiff < thickness) {
      hitUV = uv;
      hit = true;

      var refinedPos = rayPos;
      var refinedStep = step * 0.5;
      for (var r: i32 = 0; r < 5; r++) {
        refinedPos -= refinedStep;
        refinedStep *= 0.5;

        let rScreen = projectToScreen(refinedPos);
        let rDepth = textureSampleLevel(depthTex, texSampler, rScreen.xy, 0.0).r;
        let rViewPos = reconstructViewPosition(rScreen.xy, rDepth);
        let rDiff = refinedPos.z - rViewPos.z;

        if (rDiff > 0.0) {
          refinedPos += refinedStep * 2.0;
        }
      }

      hitUV = projectToScreen(refinedPos).xy;
      break;
    }
  }

  if (!hit) { return vec4<f32>(0.0); }

  let reflectedColor = textureSampleLevel(colorTex, texSampler, hitUV, 0.0).rgb;
  let edgeFade = screenEdgeFade(hitUV);
  let distFade = 1.0 - smoothstep(maxDist * 0.5, maxDist, length(rayPos - origin));

  return vec4<f32>(reflectedColor, edgeFade * distFade);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  let originalColor = textureSample(colorTex, texSampler, uv).rgb;

  let depth = textureSampleLevel(depthTex, texSampler, uv, 0.0).r;

  if (depth >= 0.999 || depth <= 0.001) {
    return vec4<f32>(originalColor, 1.0);
  }

  let viewPos = reconstructViewPosition(uv, depth);

  var normal: vec3<f32>;
  if (ssr.flags.x < 0.5) {
    let invRes = ssr.resolution.zw;
    let depthDx = textureSampleLevel(
      depthTex, texSampler, uv + vec2<f32>(invRes.x, 0.0), 0.0,
    ).r;
    let depthDy = textureSampleLevel(
      depthTex, texSampler, uv + vec2<f32>(0.0, invRes.y), 0.0,
    ).r;
    let viewPosDx = reconstructViewPosition(
      uv + vec2<f32>(invRes.x, 0.0), depthDx,
    );
    let viewPosDy = reconstructViewPosition(
      uv + vec2<f32>(0.0, invRes.y), depthDy,
    );
    let dPosDx = viewPosDx - viewPos;
    let dPosDy = viewPosDy - viewPos;
    let n = cross(dPosDy, dPosDx);
    let nLenSq = dot(n, n);
    if (nLenSq < 1.0e-8) {
      return vec4<f32>(originalColor, 1.0);
    }
    normal = n * inverseSqrt(nLenSq);
  } else {
    let normalRoughness = textureSampleLevel(normalTex, texSampler, uv, 0.0);
    let normalSample = normalRoughness.xyz;
    if (length(normalSample) < 0.1) {
      return vec4<f32>(originalColor, 1.0);
    }
    normal = normalize(normalSample);
    if (normalRoughness.w > 0.6) {
      return vec4<f32>(originalColor, 1.0);
    }
  }
  let viewDir = normalize(viewPos);
  let NdotV = abs(dot(normal, -viewDir));

  let reflectDir = reflect(viewDir, normal);

  let result = traceRay(viewPos, reflectDir);

  let reflectionStrength = ssr.params2.z;
  let fresnel = fresnelFade(NdotV);
  var roughness: f32 = 0.0;
  if (ssr.flags.x > 0.5) {
    roughness = textureSampleLevel(normalTex, texSampler, uv, 0.0).w;
  }
  let roughnessAttenuation = 1.0 - clamp(roughness / 0.6, 0.0, 1.0);
  let blendFactor = result.a * fresnel * reflectionStrength * roughnessAttenuation;

  // Final Fresnel/roughness-weighted color blend in F16 (both inputs are
  // bounded scene colors; blendFactor is in [0, 1]).
  let finalColor = mix(
    vec3<f16>(originalColor), vec3<f16>(result.rgb), f16(blendFactor),
  );
  return vec4<f32>(vec3<f32>(finalColor), 1.0);
}
