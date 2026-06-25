/// <reference types="@webgpu/types" />
/**
 * Campaign 3 v2 — 3D cloud-noise texture bake (V2).
 *
 * **What's shipped (V2):** allocate + bake the two tileable 3D noise textures
 * the volumetric-cloud raymarcher will sample, and hand back sample views + a
 * `repeat` 3D sampler. The bake runs ONCE (a one-shot compute encoder, like the
 * VolumetricFog shadow-placeholder init).
 *
 *   • shape  — 128³ RGBA8: R = Perlin-Worley billow, G/B/A = inverted Worley at
 *              increasing frequency (the erosion fBm V3 combines to remap R).
 *   • detail — 32³  RGBA8: R/G/B = high-frequency inverted Worley.
 *
 * **What's a NO-OP until V3:** nothing here samples the textures. V2 binds them
 * into the cloud BGL (bindings 6/7/8) but the shader keeps `noiseSource = 0` and
 * the live `fbmNoise`/`worleyF1` march still produces every pixel — so V2 is
 * byte-identical. V3 flips `cloudDensity`/`cloudBaseDensity` to sample these.
 *
 * Modeled on `WebGPUVolumetricFogResources.ts` (3D `texture_storage_3d` write
 * target + compute bake). Uses `device.createComputePipeline` directly (the bake
 * is a per-context singleton, so central pipeline-cache dedup buys nothing).
 *
 * @module WebGPUCloudNoiseResources
 */

import CloudNoiseBakeSource from "../../Shaders/WebGPU/Compute/CloudNoiseBake.js";

export interface CloudNoiseResources {
  shapeTexture: GPUTexture;
  shapeSampleView: GPUTextureView; // texture_3d<f32> for the cloud FS
  detailTexture: GPUTexture;
  detailSampleView: GPUTextureView;
  sampler3d: GPUSampler; // linear + repeat (tileable)
  shapeRes: number;
  detailRes: number;
}

/**
 * Allocate the two 3D textures and bake them once. `shapeRes`/`detailRes` are the
 * cube edge lengths (full = 128 / 32; low band = 64 / 16). Returns null if the
 * device can't be used (caller falls back to the 1×1×1 white view + keeps the
 * live-noise march).
 */
export function buildCloudNoiseResources(
  device: GPUDevice,
  shapeRes: number = 128,
  detailRes: number = 32,
): CloudNoiseResources | null {
  const usage =
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;

  const shapeTexture = device.createTexture({
    label: "CloudNoise_Shape",
    size: { width: shapeRes, height: shapeRes, depthOrArrayLayers: shapeRes },
    format: "rgba8unorm",
    dimension: "3d",
    usage,
  });
  const detailTexture = device.createTexture({
    label: "CloudNoise_Detail",
    size: {
      width: detailRes,
      height: detailRes,
      depthOrArrayLayers: detailRes,
    },
    format: "rgba8unorm",
    dimension: "3d",
    usage,
  });

  const shapeStorageView = shapeTexture.createView({
    label: "CloudNoise_Shape_StorageView",
    dimension: "3d",
  });
  const detailStorageView = detailTexture.createView({
    label: "CloudNoise_Detail_StorageView",
    dimension: "3d",
  });
  const shapeSampleView = shapeTexture.createView({
    label: "CloudNoise_Shape_SampleView",
    dimension: "3d",
  });
  const detailSampleView = detailTexture.createView({
    label: "CloudNoise_Detail_SampleView",
    dimension: "3d",
  });

  const module = device.createShaderModule({
    label: "CloudNoiseBake",
    code: CloudNoiseBakeSource,
  });

  // One BGL with both write targets; each pipeline uses one (the other is an
  // unused-by-entry-point layout entry, which is valid under an explicit layout).
  const bakeBGL = device.createBindGroupLayout({
    label: "CloudNoise_BakeBGL",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: "write-only",
          format: "rgba8unorm",
          viewDimension: "3d",
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: "write-only",
          format: "rgba8unorm",
          viewDimension: "3d",
        },
      },
    ],
  });
  const bakeLayout = device.createPipelineLayout({
    label: "CloudNoise_BakeLayout",
    bindGroupLayouts: [bakeBGL],
  });
  const bakeBindGroup = device.createBindGroup({
    label: "CloudNoise_BakeBindGroup",
    layout: bakeBGL,
    entries: [
      { binding: 0, resource: shapeStorageView },
      { binding: 1, resource: detailStorageView },
    ],
  });

  const shapePipeline = device.createComputePipeline({
    label: "CloudNoise_BakeShapePipeline",
    layout: bakeLayout,
    compute: { module, entryPoint: "bakeShape" },
  });
  const detailPipeline = device.createComputePipeline({
    label: "CloudNoise_BakeDetailPipeline",
    layout: bakeLayout,
    compute: { module, entryPoint: "bakeDetail" },
  });

  // One-shot bake (workgroup_size 4³ → ceil(res/4) groups per axis).
  const wgShape = Math.ceil(shapeRes / 4);
  const wgDetail = Math.ceil(detailRes / 4);
  const encoder = device.createCommandEncoder({ label: "CloudNoise_Bake" });
  const pass = encoder.beginComputePass({ label: "CloudNoise_BakePass" });
  pass.setPipeline(shapePipeline);
  pass.setBindGroup(0, bakeBindGroup);
  pass.dispatchWorkgroups(wgShape, wgShape, wgShape);
  pass.setPipeline(detailPipeline);
  pass.setBindGroup(0, bakeBindGroup);
  pass.dispatchWorkgroups(wgDetail, wgDetail, wgDetail);
  pass.end();
  device.queue.submit([encoder.finish()]);

  const sampler3d = device.createSampler({
    label: "CloudNoise_Sampler3D",
    magFilter: "linear",
    minFilter: "linear",
    // Repeat so the raymarcher can tile world space through the textures
    // seamlessly (the bake is periodic).
    addressModeU: "repeat",
    addressModeV: "repeat",
    addressModeW: "repeat",
  });

  return {
    shapeTexture,
    shapeSampleView,
    detailTexture,
    detailSampleView,
    sampler3d,
    shapeRes,
    detailRes,
  };
}
