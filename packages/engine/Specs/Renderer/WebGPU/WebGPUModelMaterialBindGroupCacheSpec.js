import {
  createGPUTextureFromReader,
  createMaterialTextures,
  createPackedMaterialUploadState,
  destroyWebGPUModelResources,
  getOrCreateMergedMaterialBindGroup,
  getOrCreateModelIBLEntries,
  ensurePrimitiveCache,
  refreshDeferredModelTextures,
  shouldPrepareModelCustomShaderResources,
  uploadPackedMaterialUniformsIfChanged,
} from "../../../Source/Renderer/WebGPU/WebGPUModelRenderer.js";
import {
  destroyMetadataResources,
  ensureMetadataResources,
  ensurePropertyTableResources,
  ensurePropertyTextureResources,
} from "../../../Source/Renderer/WebGPU/WebGPUModelMetadata.js";

// C9-17 Slice A — certifies the per-primitive merged group-1 (material +
// textures + featureId + IBL) bind-group cache and the memoized IBL entries
// resolution. Mirrors WebGPUModelInstanceBindGroupCacheSpec's mock-device
// pattern: no real GPUDevice, just identity bookkeeping.
//
// C11-195 — the light UB left this group for the group-0 arena, so it is no
// longer a key component here. That is deliberate: a per-frame ring slice in
// this per-primitive cache would have forced the rotating ring page into the
// key and multiplied every primitive's resident bind groups by the page count.

const SLOT_PRIMARY = 0;
const SLOT_SILHOUETTE = 1;
const SLOT_TRANSLUCENT = 2;

const MATERIAL_LABEL = "Model merged material bind group";

describe("Renderer/WebGPU/WebGPUModel fallback texture construction", function () {
  it("destroys an unpublished texture when the external upload throws", function () {
    const candidate = {
      destroy: jasmine.createSpy("candidate.destroy"),
    };
    const device = {
      createTexture: jasmine
        .createSpy("device.createTexture")
        .and.returnValue(candidate),
      queue: {
        copyExternalImageToTexture: jasmine
          .createSpy("copyExternalImageToTexture")
          .and.throwError("external upload failed"),
      },
    };
    const reader = {
      texture: {
        _source: { width: 2, height: 2 },
      },
    };

    expect(createGPUTextureFromReader(device, 3, reader, "linear")).toBeNull();
    expect(candidate.destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps the render-attachment usage required by external image copies", function () {
    let descriptor;
    const candidate = { destroy: function () {} };
    const device = {
      createTexture: function (value) {
        descriptor = value;
        return candidate;
      },
      queue: {
        copyExternalImageToTexture: function () {},
      },
    };
    const reader = {
      texture: {
        _source: { width: 2, height: 2 },
        _sampler: { minificationFilter: 9729 }, // LINEAR, no authored mips
      },
    };

    expect(createGPUTextureFromReader(device, 3, reader, "linear")).toBe(
      candidate,
    );
    expect(descriptor.mipLevelCount).toBe(1);
    expect(descriptor.usage & GPUTextureUsage.TEXTURE_BINDING).not.toBe(0);
    expect(descriptor.usage & GPUTextureUsage.COPY_DST).not.toBe(0);
    expect(descriptor.usage & GPUTextureUsage.RENDER_ATTACHMENT).not.toBe(0);
  });

  it("rolls back earlier material textures when a later slot throws", function () {
    const candidate = {
      createView: function () {
        return {};
      },
      destroy: jasmine.createSpy("candidate.destroy"),
    };
    const device = {
      createTexture: function () {
        return candidate;
      },
      queue: { copyExternalImageToTexture: function () {} },
    };
    const matInfo = {
      baseColorTextureReader: {
        texture: { _source: { width: 2, height: 2 } },
      },
    };
    Object.defineProperty(matInfo, "normalTextureReader", {
      get: function () {
        throw new Error("later material slot failed");
      },
    });
    const cancel = jasmine.createSpy("cancelMip");
    const pipelineCache = {
      defaultWhiteTexture: {},
      defaultNormalTexture: {},
      defaultBlackTexture: {},
    };

    expect(function () {
      createMaterialTextures(
        device,
        1,
        pipelineCache,
        matInfo,
        undefined,
        cancel,
      );
    }).toThrowError("later material slot failed");
    expect(cancel).toHaveBeenCalledOnceWith(candidate);
    expect(candidate.destroy).toHaveBeenCalledTimes(1);
  });

  it("rolls back an unpublished primitive buffer when a later upload fails", function () {
    const firstBuffer = { destroy: jasmine.createSpy("firstBuffer.destroy") };
    let allocations = 0;
    const device = {
      createBuffer: function () {
        allocations++;
        if (allocations === 2) {
          throw new Error("normal allocation failed");
        }
        return firstBuffer;
      },
      queue: { writeBuffer: function () {} },
    };
    const cache = { primitives: {}, resourceGeneration: 1 };
    const geometry = {
      primitiveType: 4,
      vertexCount: 1,
      positionData: new Float32Array(3),
      hasNormals: true,
      normalData: new Float32Array(3),
      hasTangents: false,
      hasTexCoord0: false,
      hasTexCoord1: false,
      hasColor0: false,
      hasJoints: false,
      hasFeatureId0: false,
      hasMetadata: false,
      hasPropertyTextures: false,
      hasPropertyTables: false,
    };

    expect(function () {
      ensurePrimitiveCache(device, cache, {}, "p", geometry, {
        materialFlags: 0,
      });
    }).toThrowError("normal allocation failed");
    expect(firstBuffer.destroy).toHaveBeenCalledTimes(1);
    expect(cache.primitives).toEqual({});
  });

  it("rolls back a deferred owned texture when view publication fails", function () {
    const candidate = {
      createView: function () {
        throw new Error("deferred view failed");
      },
      destroy: jasmine.createSpy("candidate.destroy"),
    };
    const device = {
      createTexture: function () {
        return candidate;
      },
      queue: { copyExternalImageToTexture: function () {} },
    };
    const primCache = {
      placeholderSlots: new Set(["baseColor"]),
      gpuTextures: [],
      textureViews: {},
    };
    const matInfo = {
      baseColorTextureReader: {
        texture: { _source: { width: 2, height: 2 } },
      },
    };
    const cancel = jasmine.createSpy("cancelMip");

    expect(function () {
      refreshDeferredModelTextures(
        device,
        1,
        primCache,
        matInfo,
        undefined,
        cancel,
      );
    }).toThrowError("deferred view failed");
    expect(cancel).toHaveBeenCalledOnceWith(candidate);
    expect(candidate.destroy).toHaveBeenCalledTimes(1);
    expect(primCache.gpuTextures).toEqual([]);
    expect(primCache.placeholderSlots.has("baseColor")).toBe(true);
  });
});

describe("Renderer/WebGPU/WebGPUModel metadata allocation transactions", function () {
  it("destroys a metadata buffer when its queue upload throws", function () {
    const buffer = { destroy: jasmine.createSpy("buffer.destroy") };
    const device = {
      createBuffer: function () {
        return buffer;
      },
      queue: {
        writeBuffer: function () {
          throw new Error("metadata upload failed");
        },
      },
    };
    const primCache = {};

    expect(function () {
      ensureMetadataResources(device, primCache, new Float32Array(4));
    }).toThrowError("metadata upload failed");
    expect(buffer.destroy).toHaveBeenCalledTimes(1);
    expect(primCache._metadataBuffer).toBeUndefined();
  });

  it("destroys a property-table texture when view publication throws", function () {
    const texture = {
      createView: function () {
        throw new Error("table view failed");
      },
      destroy: jasmine.createSpy("texture.destroy"),
    };
    const device = {
      createTexture: function () {
        return texture;
      },
      queue: { writeTexture: function () {} },
    };
    const primCache = {};
    const layout = {
      textureData: { width: 1, height: 1, data: new Uint8Array(4) },
      textureBinding: 44,
      samplerBinding: 45,
    };

    expect(function () {
      ensurePropertyTableResources(device, primCache, layout, {});
    }).toThrowError("table view failed");
    expect(texture.destroy).toHaveBeenCalledTimes(1);
    expect(primCache._propertyTableResources).toBeUndefined();
  });

  it("tracks and releases owned property textures on failure and teardown", function () {
    const first = {
      createView: function () {
        return {};
      },
      destroy: jasmine.createSpy("first.destroy"),
    };
    const second = {
      createView: function () {
        throw new Error("property view failed");
      },
      destroy: jasmine.createSpy("second.destroy"),
    };
    const releases = [];
    const layout = {
      textures: [
        { reader: {}, textureBinding: 39 },
        { reader: {}, textureBinding: 40 },
      ],
    };
    let index = 0;
    const createOwned = function () {
      const texture = index++ === 0 ? first : second;
      return {
        texture,
        owned: true,
        release: function () {
          releases.push(texture);
          texture.destroy();
        },
      };
    };

    expect(function () {
      ensurePropertyTextureResources({}, {}, layout, createOwned, {}, {});
    }).toThrowError("property view failed");
    expect(releases).toEqual([second, first]);

    const successTexture = {
      createView: function () {
        return {};
      },
      destroy: jasmine.createSpy("success.destroy"),
    };
    const primCache = {};
    ensurePropertyTextureResources(
      {},
      primCache,
      { textures: [{ reader: {}, textureBinding: 39 }] },
      function () {
        return {
          texture: successTexture,
          owned: true,
          release: function () {
            successTexture.destroy();
          },
        };
      },
      {},
      {},
    );
    destroyMetadataResources(primCache);
    expect(successTexture.destroy).toHaveBeenCalledTimes(1);
  });
});

function makeGpuBuffer(label) {
  return { label: label };
}

// A WebGPUBuffer wrapper exposes the underlying GPUBuffer via `.buffer`; the
// builder reads `materialBuffer.buffer`.
function makeUniformBuffer(label) {
  return { label: label, buffer: makeGpuBuffer(`${label}-gpu`) };
}

function makeDevice(label) {
  const bindGroups = [];
  return {
    label: label,
    bindGroups: bindGroups,
    createBindGroup: function (descriptor) {
      const bindGroup = {
        id: `${label}-${bindGroups.length}`,
        descriptor: descriptor,
      };
      bindGroups.push(bindGroup);
      return bindGroup;
    },
  };
}

function makePipelineCache() {
  return {
    _materialBGL: { label: "material-bgl" },
    getOrCreateMaterialBGL: function () {
      return this._materialBGL;
    },
    defaultFeatureIdEntries: function () {
      return [{ binding: 26, resource: { label: "default-featureid" } }];
    },
    defaultIBLCubemapView: { label: "default-ibl-cubemap" },
    defaultIBLSampler: { label: "default-ibl-sampler" },
    defaultSHBuffer: makeGpuBuffer("default-sh"),
    defaultBrdfLutView: { label: "default-brdf-lut" },
    defaultBrdfLutSampler: { label: "default-brdf-sampler" },
  };
}

function makeIblEntries(label) {
  return [{ binding: 33, resource: { label: label } }];
}

function getMaterialBindGroup(
  primCache,
  slot,
  device,
  pipelineCache,
  overrides,
) {
  const opts = overrides ?? {};
  return getOrCreateMergedMaterialBindGroup(
    primCache,
    slot,
    device,
    pipelineCache,
    opts.materialBuffer ?? makeUniformBuffer("material"),
    opts.textureEntries ?? [],
    "featureIdEntries" in opts ? opts.featureIdEntries : null,
    opts.iblEntries ?? makeIblEntries("ibl"),
    opts.materialDefines ?? 0,
    opts.frameState ?? {},
  );
}

describe("Renderer/WebGPU/WebGPUModel material bind-group cache", function () {
  it("reuses the group-1 bind group while all identities are stable", function () {
    const primCache = {};
    const device = makeDevice("device-a");
    const pipelineCache = makePipelineCache();
    const shared = {
      materialBuffer: makeUniformBuffer("material"),
      textureEntries: [{ binding: 2, resource: { label: "tex" } }],
      featureIdEntries: [{ binding: 26, resource: { label: "fid" } }],
      iblEntries: makeIblEntries("ibl"),
    };

    const first = getMaterialBindGroup(
      primCache,
      SLOT_PRIMARY,
      device,
      pipelineCache,
      shared,
    );
    const second = getMaterialBindGroup(
      primCache,
      SLOT_PRIMARY,
      device,
      pipelineCache,
      shared,
    );

    expect(second).toBe(first);
    expect(device.bindGroups.length).toBe(1);
  });

  it("labels the group-1 bind group so the probe can attribute it", function () {
    const primCache = {};
    const device = makeDevice("device-a");
    const pipelineCache = makePipelineCache();

    getMaterialBindGroup(primCache, SLOT_PRIMARY, device, pipelineCache);

    expect(device.bindGroups[0].descriptor.label).toBe(MATERIAL_LABEL);
  });

  it("no longer binds a light UB at group-1 binding 1 (C11-195)", function () {
    const primCache = {};
    const device = makeDevice("device-a");
    const pipelineCache = makePipelineCache();

    getMaterialBindGroup(primCache, SLOT_PRIMARY, device, pipelineCache, {
      textureEntries: [{ binding: 2, resource: { label: "tex" } }],
    });

    const bindings = device.bindGroups[0].descriptor.entries.map(
      (entry) => entry.binding,
    );
    // Binding 1 moved to the group-0 arena and this group's layout no longer
    // declares it; emitting an entry for it would be a validation error.
    expect(bindings).not.toContain(1);
    expect(bindings[0]).toBe(0);
  });

  it("rebuilds exactly once for each key-component identity change", function () {
    // Each entry mutates one key component off a stable baseline and asserts a
    // single fresh create.
    const mutators = [
      function (opts, pipelineCache) {
        opts.materialBuffer = makeUniformBuffer("material-2");
        return pipelineCache;
      },
      function (opts, pipelineCache) {
        opts.textureEntries = [{ binding: 2, resource: { label: "tex-2" } }];
        return pipelineCache;
      },
      function (opts, pipelineCache) {
        opts.featureIdEntries = [{ binding: 26, resource: { label: "fid-2" } }];
        return pipelineCache;
      },
      function (opts, pipelineCache) {
        opts.iblEntries = makeIblEntries("ibl-2");
        return pipelineCache;
      },
      function (opts, pipelineCache) {
        // Layout replacement (new materialBGL for a new materialDefines variant).
        pipelineCache._materialBGL = { label: "material-bgl-2" };
        return pipelineCache;
      },
    ];

    mutators.forEach(function (mutate) {
      const primCache = {};
      const device = makeDevice("device-a");
      const pipelineCache = makePipelineCache();
      const opts = {
        materialBuffer: makeUniformBuffer("material"),
        textureEntries: [{ binding: 2, resource: { label: "tex" } }],
        featureIdEntries: [{ binding: 26, resource: { label: "fid" } }],
        iblEntries: makeIblEntries("ibl"),
      };

      const first = getMaterialBindGroup(
        primCache,
        SLOT_PRIMARY,
        device,
        pipelineCache,
        opts,
      );
      mutate(opts, pipelineCache);
      const second = getMaterialBindGroup(
        primCache,
        SLOT_PRIMARY,
        device,
        pipelineCache,
        opts,
      );

      expect(second).not.toBe(first);
      expect(device.bindGroups.length).toBe(2);
    });
  });

  it("distinguishes null featureId entries from a real array", function () {
    const primCache = {};
    const device = makeDevice("device-a");
    const pipelineCache = makePipelineCache();
    const baseline = {
      materialBuffer: makeUniformBuffer("material"),
      textureEntries: [],
      featureIdEntries: null,
      iblEntries: makeIblEntries("ibl"),
    };

    const first = getMaterialBindGroup(
      primCache,
      SLOT_PRIMARY,
      device,
      pipelineCache,
      baseline,
    );
    // Re-call with null featureId — cache HIT (null is its own state).
    const second = getMaterialBindGroup(
      primCache,
      SLOT_PRIMARY,
      device,
      pipelineCache,
      baseline,
    );
    expect(second).toBe(first);
    expect(device.bindGroups.length).toBe(1);

    // A real featureId entries array must force one rebuild.
    baseline.featureIdEntries = [{ binding: 26, resource: { label: "fid" } }];
    const third = getMaterialBindGroup(
      primCache,
      SLOT_PRIMARY,
      device,
      pipelineCache,
      baseline,
    );
    expect(third).not.toBe(first);
    expect(device.bindGroups.length).toBe(2);
  });

  it("keeps primary/silhouette/translucent slots independent (no aliasing)", function () {
    const primCache = {};
    const device = makeDevice("device-a");
    const pipelineCache = makePipelineCache();
    const ibl = makeIblEntries("ibl");
    const opts = (materialLabel) => ({
      materialBuffer: makeUniformBuffer(materialLabel),
      textureEntries: [],
      featureIdEntries: null,
      iblEntries: ibl,
    });

    const primary = getMaterialBindGroup(
      primCache,
      SLOT_PRIMARY,
      device,
      pipelineCache,
      opts("material-primary"),
    );
    const silhouette = getMaterialBindGroup(
      primCache,
      SLOT_SILHOUETTE,
      device,
      pipelineCache,
      opts("material-silhouette"),
    );
    const translucent = getMaterialBindGroup(
      primCache,
      SLOT_TRANSLUCENT,
      device,
      pipelineCache,
      opts("material-translucent"),
    );

    expect(primary).not.toBe(silhouette);
    expect(silhouette).not.toBe(translucent);
    expect(primary).not.toBe(translucent);
    expect(device.bindGroups.length).toBe(3);
    expect(primCache._mergedMaterialBindGroupCache.bindGroup).toBe(primary);
    expect(primCache._mergedMaterialBindGroupCacheSilhouette.bindGroup).toBe(
      silhouette,
    );
    expect(primCache._mergedMaterialBindGroupCacheTranslucent.bindGroup).toBe(
      translucent,
    );
  });

  it("rebuilds across device generations", function () {
    const primCache = {};
    const deviceA = makeDevice("device-a");
    const deviceB = makeDevice("device-b");
    const pipelineCache = makePipelineCache();
    const shared = {
      materialBuffer: makeUniformBuffer("material"),
      textureEntries: [],
      featureIdEntries: null,
      iblEntries: makeIblEntries("ibl"),
    };

    const first = getMaterialBindGroup(
      primCache,
      SLOT_PRIMARY,
      deviceA,
      pipelineCache,
      shared,
    );
    const afterDeviceChange = getMaterialBindGroup(
      primCache,
      SLOT_PRIMARY,
      deviceB,
      pipelineCache,
      shared,
    );

    expect(afterDeviceChange).not.toBe(first);
    expect(deviceA.bindGroups.length).toBe(1);
    expect(deviceB.bindGroups.length).toBe(1);
  });
});

describe("Renderer/WebGPU/WebGPUModel material uniform uploads", function () {
  function makeDevice() {
    const writes = [];
    return {
      writes: writes,
      queue: {
        writeBuffer: function (buffer, offset, source, sourceOffset, size) {
          writes.push({
            buffer: buffer,
            offset: offset,
            source: source,
            sourceOffset: sourceOffset,
            size: size,
          });
        },
      },
    };
  }

  it("uploads the first packed block even when every byte is zero", function () {
    const device = makeDevice();
    const buffer = { label: "material" };
    const data = new Float32Array(8);
    const state = createPackedMaterialUploadState(data);

    expect(
      uploadPackedMaterialUniformsIfChanged(device, buffer, data, state),
    ).toBe(true);
    expect(device.writes.length).toBe(1);
    expect(device.writes[0].buffer).toBe(buffer);
    expect(device.writes[0].size).toBe(data.byteLength);
  });

  it("skips queue.writeBuffer when the packed bytes are unchanged", function () {
    const device = makeDevice();
    const data = new Float32Array([1.0, -0.0, Number.NaN, 4.0]);
    const state = createPackedMaterialUploadState(data);
    const currentWords = state.currentWords;
    const uploadedWords = state.uploadedWords;

    uploadPackedMaterialUniformsIfChanged(device, {}, data, state);
    expect(uploadPackedMaterialUniformsIfChanged(device, {}, data, state)).toBe(
      false,
    );

    expect(device.writes.length).toBe(1);
    expect(state.currentWords).toBe(currentWords);
    expect(state.uploadedWords).toBe(uploadedWords);
  });

  it("uploads again after any packed material byte changes", function () {
    const device = makeDevice();
    const buffer = { label: "material" };
    const data = new Float32Array([1.0, 2.0, 3.0, 4.0]);
    const state = createPackedMaterialUploadState(data);

    uploadPackedMaterialUniformsIfChanged(device, buffer, data, state);
    data[2] = 30.0;

    expect(
      uploadPackedMaterialUniformsIfChanged(device, buffer, data, state),
    ).toBe(true);
    expect(device.writes.length).toBe(2);
  });
});

describe("Renderer/WebGPU/WebGPUModel no-op preparation and lifetime", function () {
  it("skips GLSL-only custom shaders but observes native WGSL and cached retirement", function () {
    const cache = {};
    const model = {
      customShader: {
        fragmentShaderText: "void fragmentMain() {}",
      },
    };

    expect(shouldPrepareModelCustomShaderResources(model, cache)).toBe(false);

    model.customShader.wgslFragmentShaderText = "fn fragmentMain() {}";
    expect(shouldPrepareModelCustomShaderResources(model, cache)).toBe(true);

    delete model.customShader.wgslFragmentShaderText;
    cache._customShader = { uboBuffer: { destroy: function () {} } };
    expect(shouldPrepareModelCustomShaderResources(model, cache)).toBe(true);

    cache._customShader = null;
    expect(shouldPrepareModelCustomShaderResources(model, cache)).toBe(false);
  });

  it("destroys custom-shader and pipeline resources with their model", function () {
    const destroyed = [];
    const makeDestroyable = (label) => ({
      destroy: function () {
        destroyed.push(label);
      },
    });
    const model = {
      _webgpuCache: {
        primitives: {},
        nodes: {},
        pipelineCache: makeDestroyable("pipeline-cache"),
        _customShader: {
          uboBuffer: makeDestroyable("custom-ubo"),
        },
      },
    };

    destroyWebGPUModelResources(model);

    expect(destroyed).toEqual(["custom-ubo", "pipeline-cache"]);
    expect(model._webgpuCache).toBeUndefined();
  });

  it("cancels queued fallback-texture mips before owned teardown", function () {
    const events = [];
    const texture = {
      destroy: function () {
        events.push("destroy");
      },
    };
    const model = {
      _webgpuCache: {
        primitives: {
          only: {
            gpuTextures: [texture],
          },
        },
        nodes: {},
        pipelineCache: { destroy: function () {} },
        _cancelTextureMipGeneration: function (candidate) {
          expect(candidate).toBe(texture);
          events.push("cancel");
        },
      },
    };

    destroyWebGPUModelResources(model);

    expect(events).toEqual(["cancel", "destroy"]);
    expect(model._webgpuCache).toBeUndefined();
  });

  it("continues model disposal after destroy throws and returns the shared lease", function () {
    const destroyed = [];
    const makeDestroyable = (label, error) => ({
      destroy: function () {
        destroyed.push(label);
        if (error) {
          throw error;
        }
      },
    });
    const firstError = new Error("lost-device shadow destroy failed");
    const nodeCache = {
      jointBuffer: makeDestroyable("node-joint"),
      instanceCount: 3,
    };
    nodeCache.instancingBuffer = {
      destroy: function () {
        expect(nodeCache.instancingBuffer).toBeUndefined();
        expect(nodeCache.instanceCount).toBeUndefined();
        destroyed.push("node-instance");
        throw new Error("node instance destroy failed");
      },
    };
    const cache = {
      shadowCastUB: makeDestroyable("model-shadow", firstError),
      primitives: {
        first: {
          positionBuffer: makeDestroyable(
            "primitive-first",
            new Error("primitive destroy failed"),
          ),
          normalBuffer: makeDestroyable("primitive-first-later-buffer"),
          _morphStorageBuffer: makeDestroyable(
            "primitive-morph-first",
            new Error("morph destroy failed"),
          ),
          _morphWeightBufferPrev: makeDestroyable("primitive-morph-later"),
          edgeResources: {
            vertexBuffer: makeDestroyable(
              "primitive-edge-first",
              new Error("edge destroy failed"),
            ),
            indexBuffer: makeDestroyable("primitive-edge-later"),
            cameraBuffer: makeDestroyable("primitive-edge-camera"),
            edgeBuffer: makeDestroyable("primitive-edge-uniform"),
          },
          gpuTextures: [makeDestroyable("primitive-later-texture")],
        },
        second: {
          positionBuffer: makeDestroyable("primitive-second"),
          gpuTextures: [],
        },
      },
      nodes: {
        first: nodeCache,
      },
      pipelineCache: makeDestroyable("pipeline-shared-lease"),
      _customShader: {
        uboBuffer: makeDestroyable("custom-ubo"),
      },
    };
    cache._pickIdLastId = "single";
    cache._pickId = {
      destroy: function () {
        expect(cache._pickId).toBeUndefined();
        expect(cache._pickIdLastId).toBeUndefined();
        expect(cache.pickIds).toBeUndefined();
        destroyed.push("pick-single");
        throw new Error("single pick destroy failed");
      },
    };
    cache.pickIds = {
      first: makeDestroyable("pick-map-first"),
      second: makeDestroyable("pick-map-second"),
    };
    const model = { _webgpuCache: cache };

    expect(function () {
      destroyWebGPUModelResources(model);
    }).toThrow(firstError);

    expect(destroyed).toContain("model-shadow");
    expect(destroyed).toContain("pick-single");
    expect(destroyed).toContain("pick-map-first");
    expect(destroyed).toContain("pick-map-second");
    expect(destroyed).toContain("primitive-first");
    expect(destroyed).toContain("primitive-first-later-buffer");
    expect(destroyed).toContain("primitive-later-texture");
    expect(destroyed).toContain("primitive-morph-first");
    expect(destroyed).toContain("primitive-morph-later");
    expect(destroyed).toContain("primitive-edge-first");
    expect(destroyed).toContain("primitive-edge-later");
    expect(destroyed).toContain("primitive-edge-camera");
    expect(destroyed).toContain("primitive-edge-uniform");
    expect(destroyed).toContain("primitive-second");
    expect(destroyed).toContain("node-joint");
    expect(destroyed).toContain("node-instance");
    expect(destroyed).toContain("custom-ubo");
    expect(destroyed).toContain("pipeline-shared-lease");
    expect(model._webgpuCache).toBeUndefined();
    expect(cache.primitives).toEqual({});
    expect(cache.nodes).toEqual({});
    expect(cache._customShader).toBeNull();
    expect(cache._pickId).toBeUndefined();
    expect(cache.pickIds).toBeUndefined();
  });
});

describe("Renderer/WebGPU/WebGPUModel IBL entries memo", function () {
  function makeIblPipelineCache() {
    return {
      defaultIBLCubemapView: { label: "default-ibl-cubemap" },
      defaultIBLSampler: { label: "default-ibl-sampler" },
      defaultSHBuffer: makeGpuBuffer("default-sh"),
      defaultBrdfLutView: { label: "default-brdf-lut" },
      defaultBrdfLutSampler: { label: "default-brdf-sampler" },
    };
  }

  // A model whose explicit IBL is fully resolved (so the env-manager precedence
  // and the default path are both bypassed) — the clean "model path" case.
  function makeReadyModel() {
    return {
      _imageBasedLighting: {
        _webgpuSpecularView: { label: "specular" },
        _webgpuDiffuseView: { label: "diffuse" },
        _webgpuSampler: { label: "ibl-sampler" },
        _webgpuSHBuffer: makeGpuBuffer("sh"),
        _webgpuHasSH: true,
        _specularEnvironmentCubeMap: { label: "specular-cube" },
        _webgpuMaxMipLevel: 5,
      },
      environmentMapManager: undefined,
    };
  }

  it("returns a stable array while the five IBL identities are unchanged", function () {
    const cache = {};
    const model = makeReadyModel();
    const pipelineCache = makeIblPipelineCache();
    const frameState = {};

    const first = getOrCreateModelIBLEntries(
      cache,
      model,
      pipelineCache,
      frameState,
    );
    const second = getOrCreateModelIBLEntries(
      cache,
      model,
      pipelineCache,
      frameState,
    );

    expect(second).toBe(first);
    // Bindings 33-38 present and in order.
    expect(first.map((entry) => entry.binding)).toEqual([
      33, 34, 35, 36, 37, 38,
    ]);
    expect(first[33 - 33].resource).toBe(
      model._imageBasedLighting._webgpuDiffuseView,
    );
    expect(first[34 - 33].resource).toBe(
      model._imageBasedLighting._webgpuSpecularView,
    );
  });

  it("rebuilds when any of the five resolved identities changes", function () {
    const changes = [
      (model) =>
        (model._imageBasedLighting._webgpuDiffuseView = { label: "d2" }),
      (model) =>
        (model._imageBasedLighting._webgpuSpecularView = { label: "s2" }),
      (model) => (model._imageBasedLighting._webgpuSampler = { label: "smp2" }),
      (model) =>
        (model._imageBasedLighting._webgpuSHBuffer = makeGpuBuffer("sh2")),
    ];

    changes.forEach(function (mutate) {
      const cache = {};
      const model = makeReadyModel();
      const pipelineCache = makeIblPipelineCache();
      const frameState = {};

      const first = getOrCreateModelIBLEntries(
        cache,
        model,
        pipelineCache,
        frameState,
      );
      mutate(model);
      const second = getOrCreateModelIBLEntries(
        cache,
        model,
        pipelineCache,
        frameState,
      );

      expect(second).not.toBe(first);
    });
  });

  it("rebuilds exactly once on the brdf-LUT placeholder→real flip (trap #3)", function () {
    const cache = {};
    const model = makeReadyModel();
    const pipelineCache = makeIblPipelineCache();
    const frameState = {};

    const placeholder = getOrCreateModelIBLEntries(
      cache,
      model,
      pipelineCache,
      frameState,
    );
    // Placeholder LUT until the generator publishes a real view.
    expect(placeholder[37 - 33].resource).toBe(
      pipelineCache.defaultBrdfLutView,
    );

    const realLutView = { label: "real-brdf-lut" };
    frameState.brdfLutGenerator = {
      _colorTexture: { _webgpuTextureView: realLutView },
    };
    const upgraded = getOrCreateModelIBLEntries(
      cache,
      model,
      pipelineCache,
      frameState,
    );
    expect(upgraded).not.toBe(placeholder);
    expect(upgraded[37 - 33].resource).toBe(realLutView);

    // Stable again once the real LUT is bound.
    const settled = getOrCreateModelIBLEntries(
      cache,
      model,
      pipelineCache,
      frameState,
    );
    expect(settled).toBe(upgraded);
  });

  it("uses the neutral placeholder bindings when explicit IBL is not resolved", function () {
    const cache = {};
    const model = {
      _imageBasedLighting: undefined,
      environmentMapManager: undefined,
    };
    const pipelineCache = makeIblPipelineCache();
    const frameState = {};

    const entries = getOrCreateModelIBLEntries(
      cache,
      model,
      pipelineCache,
      frameState,
    );
    // Bindings 33 AND 34 both point at the default cubemap (defaultIBLEntries parity).
    expect(entries[33 - 33].resource).toBe(pipelineCache.defaultIBLCubemapView);
    expect(entries[34 - 33].resource).toBe(pipelineCache.defaultIBLCubemapView);
    expect(entries[35 - 33].resource).toBe(pipelineCache.defaultIBLSampler);
    expect(entries[36 - 33].resource.buffer).toBe(
      pipelineCache.defaultSHBuffer,
    );
  });
});
