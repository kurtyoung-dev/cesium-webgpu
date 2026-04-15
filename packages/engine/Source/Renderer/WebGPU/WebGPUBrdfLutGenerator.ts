/**
 * WebGPU BRDF LUT Generator
 *
 * Generates a 256x256 BRDF integration lookup table texture using a WebGPU
 * compute shader. This is a one-time operation — the texture is generated once
 * and reused for all PBR rendering.
 *
 * The BRDF LUT stores pre-integrated environment BRDF terms:
 * - R channel: scale factor for F0 (Fresnel reflectance at normal incidence)
 * - G channel: bias term for F0
 *
 * Input: (NdotV, roughness) → Output: (scale, bias)
 *
 * @module WebGPUBrdfLutGenerator
 */

import {
  makeBindGroupLayout,
  storageTexture,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

// Inline WGSL compute shader for BRDF LUT generation
const BRDF_LUT_WGSL = /* wgsl */ `
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
  let a = roughness;
  let k = (a * a) / 2.0;
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

  let NdotV = (f32(gid.x) + 0.5) / f32(dims.x);
  let roughness = (f32(gid.y) + 0.5) / f32(dims.y);

  let result = integrateBRDF(max(NdotV, 0.001), roughness);

  textureStore(outputTex, vec2<i32>(gid.xy), vec4<f32>(result, 0.0, 1.0));
}
`;

// Fallback fragment shader for devices without storage texture write support
const BRDF_LUT_FRAGMENT_WGSL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 4>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0,  1.0)
  );
  var output: VertexOutput;
  let pos = positions[vertexIndex];
  output.position = vec4<f32>(pos, 0.0, 1.0);
  output.uv = pos * 0.5 + 0.5;
  return output;
}

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
  let a = roughness;
  let k = (a * a) / 2.0;
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

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let NdotV = max(input.uv.x, 0.001);
  let roughness = input.uv.y;
  let result = integrateBRDF(NdotV, roughness);
  return vec4<f32>(result, 0.0, 1.0);
}
`;

interface BrdfLutCache {
  texture: GPUTexture | null;
  textureView: GPUTextureView | null;
  sampler: GPUSampler | null;
  generated: boolean;
}

/**
 * Update (generate) the BRDF LUT texture for WebGPU.
 * Called from BrdfLutGenerator.update() when context.isWebGPU is true.
 *
 * @param generator - The BrdfLutGenerator instance
 * @param frameState - The current frame state
 */
function updateWebGPUBrdfLut(
  generator: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;

  if (!generator._webgpuCache) {
    generator._webgpuCache = {
      texture: null,
      textureView: null,
      sampler: null,
      generated: false,
    } as BrdfLutCache;
  }

  const cache = generator._webgpuCache as BrdfLutCache;

  // Only generate once
  if (cache.generated) {
    return;
  }

  const size = 256;

  // Create output texture
  cache.texture = device.createTexture({
    size: { width: size, height: size },
    format: "rg32float",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  cache.textureView = cache.texture.createView();

  cache.sampler = device.createSampler({
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  // Try compute shader path first (requires storage texture write)
  let useCompute = true;
  try {
    const computeModule = device.createShaderModule({ code: BRDF_LUT_WGSL });

    const bindGroupLayout = makeBindGroupLayout(device, "BrdfLut-BGL", [
      storageTexture(0, Stage.COMPUTE, "rg32float"),
    ]);

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });

    const computePipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: computeModule,
        entryPoint: "main",
      },
    });

    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: cache.textureView!,
        },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(computePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(size / 16), Math.ceil(size / 16));
    pass.end();
    device.queue.submit([encoder.finish()]);
  } catch (_e) {
    useCompute = false;
  }

  // Fallback: use fragment shader render pass
  if (!useCompute) {
    const fragModule = device.createShaderModule({
      code: BRDF_LUT_FRAGMENT_WGSL,
    });

    const renderPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: fragModule,
        entryPoint: "vertexMain",
      },
      fragment: {
        module: fragModule,
        entryPoint: "fragmentMain",
        targets: [{ format: "rg32float" as GPUTextureFormat }],
      },
      primitive: {
        topology: "triangle-strip",
        stripIndexFormat: "uint32",
      },
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: cache.textureView!,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(renderPipeline);
    pass.draw(4);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  // Store texture reference on the generator for external access
  generator._colorTexture = {
    _webgpuTexture: cache.texture,
    _webgpuTextureView: cache.textureView,
    _webgpuSampler: cache.sampler,
    width: size,
    height: size,
  };

  cache.generated = true;
}

/**
 * Destroy WebGPU BRDF LUT resources.
 */
function destroyWebGPUBrdfLutResources(
  generator: CesiumObjectWithWebGPUCache,
): void {
  const cache = generator._webgpuCache as BrdfLutCache | undefined;
  if (!cache) {
    return;
  }

  if (cache.texture) {
    cache.texture.destroy();
  }

  generator._webgpuCache = undefined;
}

export { updateWebGPUBrdfLut, destroyWebGPUBrdfLutResources };
export default { updateWebGPUBrdfLut, destroyWebGPUBrdfLutResources };
