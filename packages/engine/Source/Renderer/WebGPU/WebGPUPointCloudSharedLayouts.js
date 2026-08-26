// A GPUDevice is the lifetime boundary for immutable WebGPU layout objects.
// `resourceGeneration` is context-local: two pooled contexts can share one
// live device while advancing their recovery epochs independently. Keying the
// device cache by that number made alternating contexts continually replace
// each other's map and recreate otherwise-valid layouts. Device replacement
// itself is the recovery boundary, so retain one effects-layout map per exact
// GPUDevice.
const sharedLayoutsByDevice = new WeakMap();

function createStorageLayout(device, label, bindingCount) {
  const entries = [];
  for (let binding = 0; binding < bindingCount; binding++) {
    entries.push({
      binding,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: "read-only-storage" },
    });
  }
  return device.createBindGroupLayout({ label, entries });
}

/**
 * Immutable point-cloud layout bundle for one exact device and effects BGL.
 * Pipeline-cache keys include pipeline-layout object identity, so every owner
 * must receive these same objects rather than structurally identical clones.
 */
function getWebGPUPointCloudSharedLayouts(
  device,
  _resourceGeneration,
  effectsBindGroupLayout,
) {
  let byEffectsLayout = sharedLayoutsByDevice.get(device);
  if (!byEffectsLayout) {
    byEffectsLayout = new WeakMap();
    sharedLayoutsByDevice.set(device, byEffectsLayout);
  }
  const existing = byEffectsLayout.get(effectsBindGroupLayout);
  if (existing) {
    return existing;
  }

  const uniformBindGroupLayout = device.createBindGroupLayout({
    label: "PointCloud shared uniform BGL",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });
  const defaultPipelineLayout = device.createPipelineLayout({
    label: "PointCloud shared default pipeline layout",
    bindGroupLayouts: [uniformBindGroupLayout, effectsBindGroupLayout],
  });
  let lodStorageBindGroupLayout;
  let lodVelocityStorageBindGroupLayout;
  let lodPipelineLayout;
  let lodVelocityPipelineLayout;

  const created = {
    device,
    effectsBindGroupLayout,
    uniformBindGroupLayout,
    defaultPipelineLayout,
    get lodStorageBindGroupLayout() {
      lodStorageBindGroupLayout ??= createStorageLayout(
        device,
        "PointCloud shared LOD storage BGL",
        2,
      );
      return lodStorageBindGroupLayout;
    },
    get lodVelocityStorageBindGroupLayout() {
      lodVelocityStorageBindGroupLayout ??= createStorageLayout(
        device,
        "PointCloud shared LOD velocity storage BGL",
        3,
      );
      return lodVelocityStorageBindGroupLayout;
    },
    get lodPipelineLayout() {
      lodPipelineLayout ??= device.createPipelineLayout({
        label: "PointCloud shared LOD pipeline layout",
        bindGroupLayouts: [
          uniformBindGroupLayout,
          created.lodStorageBindGroupLayout,
          effectsBindGroupLayout,
        ],
      });
      return lodPipelineLayout;
    },
    get lodVelocityPipelineLayout() {
      lodVelocityPipelineLayout ??= device.createPipelineLayout({
        label: "PointCloud shared LOD velocity pipeline layout",
        bindGroupLayouts: [
          uniformBindGroupLayout,
          created.lodVelocityStorageBindGroupLayout,
          effectsBindGroupLayout,
        ],
      });
      return lodVelocityPipelineLayout;
    },
  };
  byEffectsLayout.set(effectsBindGroupLayout, created);
  return created;
}

export { getWebGPUPointCloudSharedLayouts };
export default { getWebGPUPointCloudSharedLayouts };
