/// <reference types="@webgpu/types" />
/**
 * 3D cloud-noise texture bake.
 *
 * Allocates and bakes the two tileable 3D noise textures the volumetric-cloud
 * raymarcher samples, and hands back sample views plus a `repeat` 3D sampler.
 * The bake runs once, in a one-shot compute encoder, which also extends each
 * level-0 bake into a complete box-filtered mip chain.
 *
 *   • shape  — 128³ RGBA8: R = Perlin-Worley billow, G/B/A = inverted Worley at
 *              increasing frequency, which the erosion fBm combines to remap R.
 *   • detail — 32³  RGBA8: R/G/B = high-frequency inverted Worley.
 *
 * The textures are bound into the cloud bind-group layout at bindings 6, 7 and
 * 8 whenever they exist, but whether the fragment shader reads them is a
 * separate decision: `cloudDensity` and `cloudBaseDensity` sample them only
 * when the resolved tier selects the baked noise source (`CLOUD_QF_NOISE_BAKED`
 * in the quality flags). Otherwise the live `fbmNoise` and `worleyF1` march
 * produces every pixel and these textures are resident but unread.
 *
 * Modeled on `WebGPUVolumetricFogResources.ts`: a 3D `texture_storage_3d` write
 * target filled by a compute bake. `device.createComputePipeline` is called
 * directly because the bake is a per-context singleton, so routing it through
 * the central pipeline cache would buy nothing.
 *
 * @module WebGPUCloudNoiseResources
 */

import CloudNoiseBakeSource from "../../Shaders/WebGPU/Compute/CloudNoiseBake.js";
import CloudNoiseMipmapSource from "../../Shaders/WebGPU/Compute/CloudNoiseMipmap.js";

export interface CloudNoiseResources {
  shapeTexture: GPUTexture;
  shapeSampleView: GPUTextureView; // texture_3d<f32> for the cloud FS
  // The Perlin-Worley shape variant, baked into its own texture only when
  // `perlinWorley` is requested and null otherwise. The renderer binds this
  // view at binding 6 in place of `shapeSampleView` when the flag is on, which
  // leaves the value-FBM bake output undisturbed.
  shapePWTexture: GPUTexture | null;
  shapePWSampleView: GPUTextureView | null;
  detailTexture: GPUTexture;
  detailSampleView: GPUTextureView;
  sampler3d: GPUSampler; // trilinear + repeat (tileable)
  shapeRes: number;
  detailRes: number;
  /** Full 3D mip-chain length, including level 0. Shared by shapePWTexture. */
  shapeMipLevelCount: number;
  /** Full 3D mip-chain length, including level 0. */
  detailMipLevelCount: number;
}

function cloudNoiseMipLevelCount(resolution: number): number {
  return Math.floor(Math.log2(Math.max(1, resolution))) + 1;
}

/**
 * Encode one full 3D mip chain after its level-0 bake.
 *
 * Each level gets explicit, non-overlapping one-mip source/destination views and
 * its own compute pass. The passes stay in the caller's one-shot bake encoder,
 * so command-buffer order supplies every level-to-level dependency without a
 * queue round trip.
 */
function encodeCloudNoiseMipChain(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  pipeline: GPUComputePipeline,
  bindGroupLayout: GPUBindGroupLayout,
  texture: GPUTexture,
  baseResolution: number,
  mipLevelCount: number,
  label: string,
): void {
  for (let mipLevel = 1; mipLevel < mipLevelCount; mipLevel++) {
    const sourceView = texture.createView({
      label: `${label}_Mip${mipLevel - 1}_SourceView`,
      dimension: "3d",
      baseMipLevel: mipLevel - 1,
      mipLevelCount: 1,
    });
    const destinationView = texture.createView({
      label: `${label}_Mip${mipLevel}_DestinationView`,
      dimension: "3d",
      baseMipLevel: mipLevel,
      mipLevelCount: 1,
    });
    const bindGroup = device.createBindGroup({
      label: `${label}_Mip${mipLevel}_BindGroup`,
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: destinationView },
      ],
    });
    const pass = encoder.beginComputePass({
      label: `${label}_Mip${mipLevel}_Pass`,
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    const destinationResolution = Math.max(
      1,
      Math.floor(baseResolution / 2 ** mipLevel),
    );
    const workgroups = Math.ceil(destinationResolution / 4);
    pass.dispatchWorkgroups(workgroups, workgroups, workgroups);
    pass.end();
  }
}

/**
 * Allocate the two 3D textures, bake level 0 once, then build their complete mip
 * chains in the same command encoder. `shapeRes`/`detailRes` are the cube edge
 * lengths (full = 128 / 32; low band = 64 / 16). Returns null if the device can't
 * be used (caller falls back to the 1×1×1 white view + keeps the live-noise
 * march).
 *
 * When `perlinWorley` is true, a second shape texture is allocated and baked
 * through the `bakeShapePW` entry point, which applies the Perlin-Worley remap.
 * The value-FBM `shapeTexture` is baked identically whatever this flag is, so
 * the default output is unchanged and the renderer only chooses which view to
 * bind. The Perlin-Worley texture is allocated only when requested, so the
 * default path carries no cost for it.
 */
export function buildCloudNoiseResources(
  device: GPUDevice,
  shapeRes: number = 128,
  detailRes: number = 32,
  perlinWorley: boolean = false,
): CloudNoiseResources | null {
  const usage =
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
  const shapeMipLevelCount = cloudNoiseMipLevelCount(shapeRes);
  const detailMipLevelCount = cloudNoiseMipLevelCount(detailRes);

  const shapeTexture = device.createTexture({
    label: "CloudNoise_Shape",
    size: { width: shapeRes, height: shapeRes, depthOrArrayLayers: shapeRes },
    format: "rgba8unorm",
    dimension: "3d",
    mipLevelCount: shapeMipLevelCount,
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
    mipLevelCount: detailMipLevelCount,
    usage,
  });

  const shapeStorageView = shapeTexture.createView({
    label: "CloudNoise_Shape_StorageView",
    dimension: "3d",
    baseMipLevel: 0,
    mipLevelCount: 1,
  });
  const detailStorageView = detailTexture.createView({
    label: "CloudNoise_Detail_StorageView",
    dimension: "3d",
    baseMipLevel: 0,
    mipLevelCount: 1,
  });
  const shapeSampleView = shapeTexture.createView({
    label: "CloudNoise_Shape_SampleView",
    dimension: "3d",
    baseMipLevel: 0,
    mipLevelCount: shapeMipLevelCount,
  });
  const detailSampleView = detailTexture.createView({
    label: "CloudNoise_Detail_SampleView",
    dimension: "3d",
    baseMipLevel: 0,
    mipLevelCount: detailMipLevelCount,
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

  // One format-specialized pipeline downsamples every shape, detail and
  // optional Perlin-Worley level. It uses `textureLoad`, so no transient
  // sampler or per-mip parameter buffer is needed.
  const mipModule = device.createShaderModule({
    label: "CloudNoiseMipmap",
    code: CloudNoiseMipmapSource,
  });
  const mipBGL = device.createBindGroupLayout({
    label: "CloudNoise_MipmapBGL",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: "float",
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
  const mipLayout = device.createPipelineLayout({
    label: "CloudNoise_MipmapLayout",
    bindGroupLayouts: [mipBGL],
  });
  const mipPipeline = device.createComputePipeline({
    label: "CloudNoise_MipmapPipeline",
    layout: mipLayout,
    compute: {
      module: mipModule,
      entryPoint: "downsampleCloudNoiseMip",
    },
  });

  // Allocate and bake the Perlin-Worley shape variant into its own texture,
  // only when requested. It reuses the same bind-group layout: binding 0 is its
  // own storage view, and binding 1 keeps the detail target that the entry
  // point ignores. The value bake above is untouched either way.
  let shapePWTexture: GPUTexture | null = null;
  let shapePWSampleView: GPUTextureView | null = null;
  let shapePWPipeline: GPUComputePipeline | null = null;
  let shapePWBindGroup: GPUBindGroup | null = null;
  if (perlinWorley) {
    shapePWTexture = device.createTexture({
      label: "CloudNoise_ShapePW",
      size: { width: shapeRes, height: shapeRes, depthOrArrayLayers: shapeRes },
      format: "rgba8unorm",
      dimension: "3d",
      mipLevelCount: shapeMipLevelCount,
      usage,
    });
    const shapePWStorageView = shapePWTexture.createView({
      label: "CloudNoise_ShapePW_StorageView",
      dimension: "3d",
      baseMipLevel: 0,
      mipLevelCount: 1,
    });
    shapePWSampleView = shapePWTexture.createView({
      label: "CloudNoise_ShapePW_SampleView",
      dimension: "3d",
      baseMipLevel: 0,
      mipLevelCount: shapeMipLevelCount,
    });
    shapePWBindGroup = device.createBindGroup({
      label: "CloudNoise_BakePWBindGroup",
      layout: bakeBGL,
      entries: [
        { binding: 0, resource: shapePWStorageView },
        { binding: 1, resource: detailStorageView }, // ignored by bakeShapePW
      ],
    });
    shapePWPipeline = device.createComputePipeline({
      label: "CloudNoise_BakeShapePWPipeline",
      layout: bakeLayout,
      compute: { module, entryPoint: "bakeShapePW" },
    });
  }

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
  if (shapePWPipeline && shapePWBindGroup) {
    pass.setPipeline(shapePWPipeline);
    pass.setBindGroup(0, shapePWBindGroup);
    pass.dispatchWorkgroups(wgShape, wgShape, wgShape);
  }
  pass.end();

  // Generate every lower level in this same one-shot command encoder. Keeping
  // each dependency in a separate pass makes the source/destination subresource
  // usage explicit to WebGPU validation.
  encodeCloudNoiseMipChain(
    device,
    encoder,
    mipPipeline,
    mipBGL,
    shapeTexture,
    shapeRes,
    shapeMipLevelCount,
    "CloudNoise_Shape",
  );
  encodeCloudNoiseMipChain(
    device,
    encoder,
    mipPipeline,
    mipBGL,
    detailTexture,
    detailRes,
    detailMipLevelCount,
    "CloudNoise_Detail",
  );
  if (shapePWTexture) {
    encodeCloudNoiseMipChain(
      device,
      encoder,
      mipPipeline,
      mipBGL,
      shapePWTexture,
      shapeRes,
      shapeMipLevelCount,
      "CloudNoise_ShapePW",
    );
  }
  device.queue.submit([encoder.finish()]);

  const sampler3d = device.createSampler({
    label: "CloudNoise_Sampler3D",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    // Repeat so the raymarcher can tile world space through the textures
    // seamlessly (the bake is periodic).
    addressModeU: "repeat",
    addressModeV: "repeat",
    addressModeW: "repeat",
  });

  return {
    shapeTexture,
    shapeSampleView,
    shapePWTexture,
    shapePWSampleView,
    detailTexture,
    detailSampleView,
    sampler3d,
    shapeRes,
    detailRes,
    shapeMipLevelCount,
    detailMipLevelCount,
  };
}
