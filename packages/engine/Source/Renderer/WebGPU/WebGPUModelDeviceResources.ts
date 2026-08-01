/// <reference types="@webgpu/types" />

import {
  makeBindGroupLayout,
  storageBuffer,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import {
  MODEL_CAMERA_UNIFORM_BYTES,
  WebGPUModelCameraArena,
} from "./WebGPUModelCameraArena.js";

export interface WebGPUModelDeviceResources {
  /**
   * Group-0 camera layout. C11-195 — binding 0 declares `hasDynamicOffset`,
   * so EVERY bind group built against it must be bound with a one-element
   * dynamic-offset array. `WebGPUModelCameraArena` is the only sanctioned
   * producer; see its module docs for why the offset is dynamic.
   */
  readonly cameraBGL: GPUBindGroupLayout;
  /**
   * C11-195 — per-device owner of the per-frame group-0 camera arena. Shared
   * by every model on this device (main view, transformed nodes, the SCENE2D
   * IDL duplicate, and the environment-capture face replays).
   */
  readonly cameraArena: WebGPUModelCameraArena;
  readonly instanceBGL: GPUBindGroupLayout;
  readonly materialBGLCache: Map<number, GPUBindGroupLayout>;
  /**
   * Pipeline layouts are immutable and depend only on the shared camera,
   * material, and instance layouts plus the exact effects-layout identity.
   * Partition by that last identity because an effects cache may be rebuilt on
   * the same physical device after every context owner releases it.
   */
  readonly pipelineLayoutCachesByEffectsLayout: WeakMap<
    GPUBindGroupLayout,
    Map<number, GPUPipelineLayout>
  >;
  readonly defaultWhiteTexture: GPUTexture;
  readonly defaultWhiteTextureView: GPUTextureView;
  readonly defaultNormalTexture: GPUTexture;
  readonly defaultNormalTextureView: GPUTextureView;
  readonly defaultBlackTexture: GPUTexture;
  readonly defaultBlackTextureView: GPUTextureView;
  readonly defaultSampler: GPUSampler;
  readonly defaultIBLCubemap: GPUTexture;
  readonly defaultIBLCubemapView: GPUTextureView;
  readonly defaultIBLSampler: GPUSampler;
  readonly defaultSHBuffer: GPUBuffer;
  readonly defaultBrdfLut: GPUTexture;
  readonly defaultBrdfLutView: GPUTextureView;
  readonly defaultBrdfLutSampler: GPUSampler;
  readonly defaultPropertyTexture: GPUTexture;
  readonly defaultPropertyTextureView: GPUTextureView;
  readonly propertyTextureSampler: GPUSampler;
  readonly samplerCache: Map<string, GPUSampler>;
  readonly defaultNormalBuffer: GPUBuffer;
  readonly defaultTangentBuffer: GPUBuffer;
  readonly defaultUVBuffer: GPUBuffer;
  readonly defaultColorBuffer: GPUBuffer;
  readonly defaultJointsBuffer: GPUBuffer;
  readonly defaultWeightsBuffer: GPUBuffer;
  readonly defaultFeatureIdBuffer: GPUBuffer;
  readonly defaultJointBuffer: GPUBuffer;
  readonly defaultMorphDeltaBuffer: GPUBuffer;
  readonly defaultMorphWeightBuffer: GPUBuffer;
  readonly defaultInstancingBuffer: GPUBuffer;
  readonly defaultInstanceBG: GPUBindGroup;
  readonly defaultFeatureUniformBuffer: GPUBuffer;
}

interface PoolEntry {
  readonly resources: WebGPUModelDeviceResources;
  refCount: number;
}

const resourcesByDevice = new WeakMap<GPUDevice, PoolEntry>();

function createDefaultTexture(
  device: GPUDevice,
  rgba: Uint8Array,
  label: string,
): GPUTexture {
  const texture = device.createTexture({
    label,
    size: [1, 1, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    rgba,
    { bytesPerRow: 4 },
    { width: 1, height: 1 },
  );
  return texture;
}

function createDefaultVertexBuffer(
  device: GPUDevice,
  data: BufferSource,
  label: string,
): GPUBuffer {
  const buffer = device.createBuffer({
    label,
    size: data.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

function createResources(device: GPUDevice): WebGPUModelDeviceResources {
  // C11-195 — dynamic-offset group 0. One bind group per ring page serves
  // every model/node/IDL/capture camera block on this device; the per-draw
  // slice is selected by the offset supplied at setBindGroup time.
  // `minBindingSize` makes a short binding a layout-creation error instead of
  // a silent out-of-range read in the vertex stage.
  const cameraBGL = makeBindGroupLayout(device, "Model Camera BGL", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT, {
      hasDynamicOffset: true,
      minBindingSize: MODEL_CAMERA_UNIFORM_BYTES,
    }),
  ]);
  const instanceBGL = makeBindGroupLayout(device, "Model Instance BGL", [
    storageBuffer(0, Stage.VERTEX, { readOnly: true }),
    storageBuffer(1, Stage.VERTEX, { readOnly: true }),
    uniformBuffer(2, Stage.VERTEX),
    storageBuffer(3, Stage.VERTEX, { readOnly: true }),
    storageBuffer(4, Stage.VERTEX, { readOnly: true }),
    uniformBuffer(5, Stage.VERTEX),
    storageBuffer(6, Stage.VERTEX, { readOnly: true }),
  ]);

  const defaultWhiteTexture = createDefaultTexture(
    device,
    new Uint8Array([255, 255, 255, 255]),
    "default-white",
  );
  const defaultNormalTexture = createDefaultTexture(
    device,
    new Uint8Array([128, 128, 255, 255]),
    "default-normal",
  );
  const defaultBlackTexture = createDefaultTexture(
    device,
    new Uint8Array([0, 0, 0, 255]),
    "default-black",
  );
  const defaultSampler = device.createSampler({
    label: "Model default sampler",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "repeat",
  });

  const defaultIBLCubemap = device.createTexture({
    label: "default-ibl-cubemap",
    size: [1, 1, 6],
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const halfHalf = new Uint16Array([0x3800, 0x3800, 0x3800, 0x3c00]);
  for (let face = 0; face < 6; face++) {
    device.queue.writeTexture(
      { texture: defaultIBLCubemap, origin: [0, 0, face] },
      halfHalf,
      { bytesPerRow: 8 },
      { width: 1, height: 1 },
    );
  }
  const defaultIBLCubemapView = defaultIBLCubemap.createView({
    dimension: "cube",
  });
  const defaultIBLSampler = device.createSampler({
    label: "default-ibl-sampler",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  const defaultSHBuffer = device.createBuffer({
    label: "default-ibl-sh",
    size: 160,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(defaultSHBuffer, 0, new Float32Array(40));

  const defaultBrdfLut = device.createTexture({
    label: "default-brdf-lut",
    size: [1, 1],
    format: "rg32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: defaultBrdfLut },
    new Float32Array([1.0, 0.0]),
    { bytesPerRow: 8 },
    { width: 1, height: 1 },
  );
  const defaultBrdfLutView = defaultBrdfLut.createView();
  const defaultBrdfLutSampler = device.createSampler({
    label: "default-brdf-lut-sampler",
    magFilter: "nearest",
    minFilter: "nearest",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  const defaultPropertyTexture = createDefaultTexture(
    device,
    new Uint8Array([0, 0, 0, 255]),
    "default-property-texture",
  );
  const defaultPropertyTextureView = defaultPropertyTexture.createView();
  const propertyTextureSampler = device.createSampler({
    label: "property-texture-sampler",
    magFilter: "nearest",
    minFilter: "nearest",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  const defaultNormalBuffer = createDefaultVertexBuffer(
    device,
    new Float32Array([0, 1, 0]),
    "default-normal-vb",
  );
  const defaultTangentBuffer = createDefaultVertexBuffer(
    device,
    new Float32Array([1, 0, 0, 1]),
    "default-tangent-vb",
  );
  const defaultUVBuffer = createDefaultVertexBuffer(
    device,
    new Float32Array([0, 0]),
    "default-uv-vb",
  );
  const defaultColorBuffer = createDefaultVertexBuffer(
    device,
    new Float32Array([1, 1, 1, 1]),
    "default-color-vb",
  );
  const defaultJointsBuffer = createDefaultVertexBuffer(
    device,
    new Uint32Array([0, 0, 0, 0]),
    "default-joints-vb",
  );
  const defaultWeightsBuffer = createDefaultVertexBuffer(
    device,
    new Float32Array([0, 0, 0, 0]),
    "default-weights-vb",
  );
  const defaultFeatureIdBuffer = createDefaultVertexBuffer(
    device,
    new Float32Array([0]),
    "default-featureId-vb",
  );

  const identityData = new Float32Array(16);
  identityData[0] = 1;
  identityData[5] = 1;
  identityData[10] = 1;
  identityData[15] = 1;
  const defaultJointBuffer = device.createBuffer({
    label: "default-joint-matrices",
    size: 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(defaultJointBuffer, 0, identityData);

  const defaultMorphDeltaBuffer = device.createBuffer({
    label: "default-morph-deltas",
    size: 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const defaultMorphWeightBuffer = device.createBuffer({
    label: "default-morph-weights",
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(defaultMorphWeightBuffer, 0, new Float32Array(12));

  const instanceIdentityData = new Float32Array(24);
  instanceIdentityData[0] = 1;
  instanceIdentityData[5] = 1;
  instanceIdentityData[10] = 1;
  instanceIdentityData[15] = 1;
  const defaultInstancingBuffer = device.createBuffer({
    label: "default-instance-transforms",
    size: 96,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(defaultInstancingBuffer, 0, instanceIdentityData);

  const defaultInstanceBG = device.createBindGroup({
    layout: instanceBGL,
    entries: [
      { binding: 0, resource: { buffer: defaultJointBuffer } },
      { binding: 1, resource: { buffer: defaultMorphDeltaBuffer } },
      { binding: 2, resource: { buffer: defaultMorphWeightBuffer } },
      { binding: 3, resource: { buffer: defaultInstancingBuffer } },
      { binding: 4, resource: { buffer: defaultJointBuffer } },
      { binding: 5, resource: { buffer: defaultMorphWeightBuffer } },
      { binding: 6, resource: { buffer: defaultInstancingBuffer } },
    ],
  });

  const defaultFeatureUniformBuffer = device.createBuffer({
    label: "default-feature-uniforms",
    size: 56,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(
    defaultFeatureUniformBuffer,
    0,
    new Float32Array(14),
  );

  return {
    cameraBGL,
    cameraArena: new WebGPUModelCameraArena(),
    instanceBGL,
    materialBGLCache: new Map(),
    pipelineLayoutCachesByEffectsLayout: new WeakMap(),
    defaultWhiteTexture,
    defaultWhiteTextureView: defaultWhiteTexture.createView(),
    defaultNormalTexture,
    defaultNormalTextureView: defaultNormalTexture.createView(),
    defaultBlackTexture,
    defaultBlackTextureView: defaultBlackTexture.createView(),
    defaultSampler,
    defaultIBLCubemap,
    defaultIBLCubemapView,
    defaultIBLSampler,
    defaultSHBuffer,
    defaultBrdfLut,
    defaultBrdfLutView,
    defaultBrdfLutSampler,
    defaultPropertyTexture,
    defaultPropertyTextureView,
    propertyTextureSampler,
    samplerCache: new Map(),
    defaultNormalBuffer,
    defaultTangentBuffer,
    defaultUVBuffer,
    defaultColorBuffer,
    defaultJointsBuffer,
    defaultWeightsBuffer,
    defaultFeatureIdBuffer,
    defaultJointBuffer,
    defaultMorphDeltaBuffer,
    defaultMorphWeightBuffer,
    defaultInstancingBuffer,
    defaultInstanceBG,
    defaultFeatureUniformBuffer,
  };
}

export function acquireWebGPUModelDeviceResources(
  device: GPUDevice,
): WebGPUModelDeviceResources {
  const existing = resourcesByDevice.get(device);
  if (existing) {
    existing.refCount++;
    return existing.resources;
  }

  const resources = createResources(device);
  resourcesByDevice.set(device, { resources, refCount: 1 });
  return resources;
}

/**
 * Return the device-shared pipeline-layout map for one exact effects-layout
 * generation. Keeping this lookup beside the resource pool makes the identity
 * partition explicit and directly testable.
 */
export function getOrCreateWebGPUModelPipelineLayoutCache(
  resources: WebGPUModelDeviceResources,
  effectsLayout: GPUBindGroupLayout,
): Map<number, GPUPipelineLayout> {
  let cache = resources.pipelineLayoutCachesByEffectsLayout.get(effectsLayout);
  if (!cache) {
    cache = new Map();
    resources.pipelineLayoutCachesByEffectsLayout.set(effectsLayout, cache);
  }
  return cache;
}

export function releaseWebGPUModelDeviceResources(
  device: GPUDevice,
  resources: WebGPUModelDeviceResources,
): void {
  const entry = resourcesByDevice.get(device);
  if (!entry || entry.resources !== resources) {
    return;
  }

  entry.refCount--;
  if (entry.refCount > 0) {
    return;
  }

  resourcesByDevice.delete(device);
  resources.defaultWhiteTexture.destroy();
  resources.defaultNormalTexture.destroy();
  resources.defaultBlackTexture.destroy();
  resources.defaultIBLCubemap.destroy();
  resources.defaultBrdfLut.destroy();
  resources.defaultPropertyTexture.destroy();
  resources.defaultSHBuffer.destroy();
  resources.defaultNormalBuffer.destroy();
  resources.defaultTangentBuffer.destroy();
  resources.defaultUVBuffer.destroy();
  resources.defaultColorBuffer.destroy();
  resources.defaultJointsBuffer.destroy();
  resources.defaultWeightsBuffer.destroy();
  resources.defaultFeatureIdBuffer.destroy();
  resources.defaultJointBuffer.destroy();
  resources.defaultMorphDeltaBuffer.destroy();
  resources.defaultMorphWeightBuffer.destroy();
  resources.defaultInstancingBuffer.destroy();
  resources.defaultFeatureUniformBuffer.destroy();
  resources.samplerCache.clear();
  resources.materialBGLCache.clear();
  // C11-195 — the arena caches bind groups over ring pages owned by the
  // context. Releasing the last lease on this device means those pages are
  // going away with it; drop every reference and free fallback buffers.
  resources.cameraArena.invalidate();
}
