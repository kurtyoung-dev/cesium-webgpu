/// <reference types="@webgpu/types" />

import {
  makeBindGroupLayout,
  storageBuffer,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import {
  MODEL_CAMERA_UNIFORM_BYTES,
  MODEL_LIGHT_UNIFORM_BYTES,
} from "./WebGPUModelCameraArena.js";

export interface WebGPUModelDeviceResources {
  /**
   * Group-0 view layout: camera at binding 0, model/view light at binding 1.
   * Both declare `hasDynamicOffset`, so every bind group built
   * against it must be bound with a two-element dynamic-offset array ordered
   * by binding index (`[cameraOffset, lightOffset]`).
   * `WebGPUModelCameraArena` is the only sanctioned producer; see its module
   * docs for why the offsets are dynamic and why the light lives here rather
   * than in the merged per-primitive group 1.
   */
  readonly cameraBGL: GPUBindGroupLayout;
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

// One physical GPUDevice can survive a recovery boundary in test harnesses or
// embedding layers that rebuild the context-owned resource graph in place.
// Native objects from the previous resource generation are still invalid in
// that case, so device identity alone is not a sufficient pool key.
const resourcesByDevice = new WeakMap<GPUDevice, Map<number, PoolEntry>>();

function createDefaultTexture(
  device: GPUDevice,
  rgba: Uint8Array,
  label: string,
  own: <T extends GPUTexture | GPUBuffer>(resource: T) => T,
): GPUTexture {
  const texture = own(
    device.createTexture({
      label,
      size: [1, 1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    }),
  );
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
  own: <T extends GPUTexture | GPUBuffer>(resource: T) => T,
): GPUBuffer {
  const buffer = own(
    device.createBuffer({
      label,
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    }),
  );
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

function createResources(device: GPUDevice): WebGPUModelDeviceResources {
  // Construction is intentionally transactional. Device loss and adapter-limit
  // failures can surface after several defaults have already been allocated;
  // never publish that partial graph and never leave its destroyable natives
  // behind. Layouts, samplers, views, and bind groups have no destroy API.
  const ownedNativeResources: Array<GPUTexture | GPUBuffer> = [];
  const own = <T extends GPUTexture | GPUBuffer>(resource: T): T => {
    ownedNativeResources.push(resource);
    return resource;
  };

  try {
    // Dynamic-offset group 0. One bind group per ring page serves
    // every model, node, IDL and capture camera and light block on this
    // device; the
    // per-draw slices are selected by the offsets supplied at setBindGroup time.
    // `minBindingSize` makes a short binding a layout-creation error instead of
    // a silent out-of-range read in the vertex stage.
    //
    // Binding 1 is the model/view light block. It is FRAGMENT-only (no vertex
    // stage in ModelPBRComplete.wgsl reads `light`) and it is per (model, view)
    // exactly like the camera — which is why it belongs here and not in the
    // per-primitive merged group 1. See WebGPUModelCameraArena's module docs.
    const cameraBGL = makeBindGroupLayout(device, "Model Camera BGL", [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT, {
        hasDynamicOffset: true,
        minBindingSize: MODEL_CAMERA_UNIFORM_BYTES,
      }),
      uniformBuffer(1, Stage.FRAGMENT, {
        hasDynamicOffset: true,
        minBindingSize: MODEL_LIGHT_UNIFORM_BYTES,
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
      own,
    );
    const defaultNormalTexture = createDefaultTexture(
      device,
      new Uint8Array([128, 128, 255, 255]),
      "default-normal",
      own,
    );
    const defaultBlackTexture = createDefaultTexture(
      device,
      new Uint8Array([0, 0, 0, 255]),
      "default-black",
      own,
    );
    const defaultSampler = device.createSampler({
      label: "Model default sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });

    const defaultIBLCubemap = own(
      device.createTexture({
        label: "default-ibl-cubemap",
        size: [1, 1, 6],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      }),
    );
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
    const defaultSHBuffer = own(
      device.createBuffer({
        label: "default-ibl-sh",
        size: 160,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
    );
    device.queue.writeBuffer(defaultSHBuffer, 0, new Float32Array(40));

    const defaultBrdfLut = own(
      device.createTexture({
        label: "default-brdf-lut",
        size: [1, 1],
        format: "rg32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      }),
    );
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
      own,
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
      own,
    );
    const defaultTangentBuffer = createDefaultVertexBuffer(
      device,
      new Float32Array([1, 0, 0, 1]),
      "default-tangent-vb",
      own,
    );
    const defaultUVBuffer = createDefaultVertexBuffer(
      device,
      new Float32Array([0, 0]),
      "default-uv-vb",
      own,
    );
    const defaultColorBuffer = createDefaultVertexBuffer(
      device,
      new Float32Array([1, 1, 1, 1]),
      "default-color-vb",
      own,
    );
    const defaultJointsBuffer = createDefaultVertexBuffer(
      device,
      new Uint32Array([0, 0, 0, 0]),
      "default-joints-vb",
      own,
    );
    const defaultWeightsBuffer = createDefaultVertexBuffer(
      device,
      new Float32Array([0, 0, 0, 0]),
      "default-weights-vb",
      own,
    );
    const defaultFeatureIdBuffer = createDefaultVertexBuffer(
      device,
      new Float32Array([0]),
      "default-featureId-vb",
      own,
    );

    const identityData = new Float32Array(16);
    identityData[0] = 1;
    identityData[5] = 1;
    identityData[10] = 1;
    identityData[15] = 1;
    const defaultJointBuffer = own(
      device.createBuffer({
        label: "default-joint-matrices",
        size: 64,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
    );
    device.queue.writeBuffer(defaultJointBuffer, 0, identityData);

    const defaultMorphDeltaBuffer = own(
      device.createBuffer({
        label: "default-morph-deltas",
        size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
    );
    const defaultMorphWeightBuffer = own(
      device.createBuffer({
        label: "default-morph-weights",
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
    );
    device.queue.writeBuffer(defaultMorphWeightBuffer, 0, new Float32Array(12));

    const instanceIdentityData = new Float32Array(24);
    instanceIdentityData[0] = 1;
    instanceIdentityData[5] = 1;
    instanceIdentityData[10] = 1;
    instanceIdentityData[15] = 1;
    const defaultInstancingBuffer = own(
      device.createBuffer({
        label: "default-instance-transforms",
        size: 96,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
    );
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

    const defaultFeatureUniformBuffer = own(
      device.createBuffer({
        label: "default-feature-uniforms",
        size: 56,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
    );
    device.queue.writeBuffer(
      defaultFeatureUniformBuffer,
      0,
      new Float32Array(14),
    );

    return {
      cameraBGL,
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
  } catch (error) {
    for (let i = ownedNativeResources.length - 1; i >= 0; i--) {
      try {
        ownedNativeResources[i].destroy();
      } catch {
        // Preserve the construction error; a lost device may also reject
        // best-effort destruction of an already-created native object.
      }
    }
    throw error;
  }
}

export function acquireWebGPUModelDeviceResources(
  device: GPUDevice,
  resourceGeneration: number,
): WebGPUModelDeviceResources {
  let generations = resourcesByDevice.get(device);
  if (!generations) {
    generations = new Map();
    resourcesByDevice.set(device, generations);
  }

  const existing = generations.get(resourceGeneration);
  if (existing) {
    existing.refCount++;
    return existing.resources;
  }

  const resources = createResources(device);
  generations.set(resourceGeneration, { resources, refCount: 1 });
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
  resourceGeneration: number,
  resources: WebGPUModelDeviceResources,
): void {
  const generations = resourcesByDevice.get(device);
  const entry = generations?.get(resourceGeneration);
  if (!entry || entry.resources !== resources) {
    return;
  }

  entry.refCount--;
  if (entry.refCount > 0) {
    return;
  }

  generations.delete(resourceGeneration);
  if (generations.size === 0) {
    resourcesByDevice.delete(device);
  }

  let firstDestroyError: unknown;
  let hasDestroyError = false;
  const destroyBestEffort = (destroy: () => void): void => {
    try {
      destroy();
    } catch (error) {
      if (!hasDestroyError) {
        firstDestroyError = error;
        hasDestroyError = true;
      }
    }
  };

  // Device-loss implementations may throw from destroy(). The pool lease is
  // already detached above; drain every sibling owner before preserving the
  // first failure for the caller.
  destroyBestEffort(() => resources.defaultWhiteTexture.destroy());
  destroyBestEffort(() => resources.defaultNormalTexture.destroy());
  destroyBestEffort(() => resources.defaultBlackTexture.destroy());
  destroyBestEffort(() => resources.defaultIBLCubemap.destroy());
  destroyBestEffort(() => resources.defaultBrdfLut.destroy());
  destroyBestEffort(() => resources.defaultPropertyTexture.destroy());
  destroyBestEffort(() => resources.defaultSHBuffer.destroy());
  destroyBestEffort(() => resources.defaultNormalBuffer.destroy());
  destroyBestEffort(() => resources.defaultTangentBuffer.destroy());
  destroyBestEffort(() => resources.defaultUVBuffer.destroy());
  destroyBestEffort(() => resources.defaultColorBuffer.destroy());
  destroyBestEffort(() => resources.defaultJointsBuffer.destroy());
  destroyBestEffort(() => resources.defaultWeightsBuffer.destroy());
  destroyBestEffort(() => resources.defaultFeatureIdBuffer.destroy());
  destroyBestEffort(() => resources.defaultJointBuffer.destroy());
  destroyBestEffort(() => resources.defaultMorphDeltaBuffer.destroy());
  destroyBestEffort(() => resources.defaultMorphWeightBuffer.destroy());
  destroyBestEffort(() => resources.defaultInstancingBuffer.destroy());
  destroyBestEffort(() => resources.defaultFeatureUniformBuffer.destroy());
  resources.samplerCache.clear();
  resources.materialBGLCache.clear();

  if (hasDestroyError) {
    throw firstDestroyError;
  }
}
