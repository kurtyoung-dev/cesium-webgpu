import { getOrCreateMergedInstanceBindGroup } from "../../../Source/Renderer/WebGPU/WebGPUModelRenderer.js";

function makeBuffer(label) {
  return { label: label };
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
    instanceBGL: {},
    defaultInstanceBindGroup: { label: "default-instance-bind-group" },
    defaultJointBuffer: makeBuffer("default-joint"),
    defaultMorphDeltaBuffer: makeBuffer("default-morph-delta"),
    defaultMorphWeightBuffer: makeBuffer("default-morph-weight"),
    defaultInstancingBuffer: makeBuffer("default-instance"),
  };
}

function getBindGroup(owner, device, pipelineCache, resources) {
  return getOrCreateMergedInstanceBindGroup(
    owner,
    device,
    pipelineCache,
    resources[0],
    resources[1],
    resources[2],
    resources[3],
    resources[4],
    resources[5],
    resources[6],
  );
}

describe("Renderer/WebGPU/WebGPUModel instance bind-group cache", function () {
  it("reuses a bind group while all resolved buffer identities are stable", function () {
    const owner = {};
    const device = makeDevice("device-a");
    const pipelineCache = makePipelineCache();
    const resources = [
      makeBuffer("joint"),
      makeBuffer("morph-delta"),
      makeBuffer("morph-weight"),
      makeBuffer("instance"),
      makeBuffer("previous-joint"),
      makeBuffer("previous-morph-weight"),
      makeBuffer("previous-instance"),
    ];

    const first = getBindGroup(owner, device, pipelineCache, resources);
    const second = getBindGroup(owner, device, pipelineCache, resources);

    expect(second).toBe(first);
    expect(device.bindGroups.length).toBe(1);
    expect(
      first.descriptor.entries.map((entry) => entry.resource.buffer),
    ).toEqual(resources);
  });

  it("uses the pipeline cache's shared group for all-placeholder resources", function () {
    const owner = {};
    const device = makeDevice("device-a");
    const pipelineCache = makePipelineCache();
    const emptyResources = new Array(7).fill(null);

    const first = getBindGroup(owner, device, pipelineCache, emptyResources);
    const second = getBindGroup(owner, device, pipelineCache, emptyResources);

    expect(first).toBe(pipelineCache.defaultInstanceBindGroup);
    expect(second).toBe(first);
    expect(device.bindGroups.length).toBe(0);
  });

  it("drops a custom tuple when the primitive returns to all placeholders", function () {
    const owner = {};
    const device = makeDevice("device-a");
    const pipelineCache = makePipelineCache();
    const customResources = [
      makeBuffer("joint"),
      null,
      null,
      null,
      null,
      null,
      null,
    ];

    getBindGroup(owner, device, pipelineCache, customResources);
    expect(owner._mergedInstanceBindGroupCache).toBeDefined();

    const defaultGroup = getBindGroup(
      owner,
      device,
      pipelineCache,
      new Array(7).fill(null),
    );
    expect(defaultGroup).toBe(pipelineCache.defaultInstanceBindGroup);
    expect(owner._mergedInstanceBindGroupCache).toBeUndefined();
  });

  it("rebuilds for every current or previous buffer identity replacement", function () {
    const device = makeDevice("device-a");
    const pipelineCache = makePipelineCache();

    for (let changedIndex = 0; changedIndex < 7; changedIndex++) {
      const owner = {};
      const resources = Array.from({ length: 7 }, (_unused, index) =>
        makeBuffer(`resource-${index}`),
      );
      const first = getBindGroup(owner, device, pipelineCache, resources);
      resources[changedIndex] = makeBuffer(`replacement-${changedIndex}`);
      const second = getBindGroup(owner, device, pipelineCache, resources);

      expect(second).not.toBe(first);
      expect(second.descriptor.entries[changedIndex].resource.buffer).toBe(
        resources[changedIndex],
      );
    }

    expect(device.bindGroups.length).toBe(14);
  });

  it("rebuilds across layout and device generations", function () {
    const owner = {};
    const firstDevice = makeDevice("device-a");
    const secondDevice = makeDevice("device-b");
    const firstPipelineCache = makePipelineCache();
    const secondPipelineCache = makePipelineCache();
    const resources = [makeBuffer("joint"), null, null, null, null, null, null];

    const first = getBindGroup(
      owner,
      firstDevice,
      firstPipelineCache,
      resources,
    );
    firstPipelineCache.instanceBGL = {};
    const afterLayoutChange = getBindGroup(
      owner,
      firstDevice,
      firstPipelineCache,
      resources,
    );
    const afterDeviceChange = getBindGroup(
      owner,
      secondDevice,
      secondPipelineCache,
      resources,
    );

    expect(afterLayoutChange).not.toBe(first);
    expect(afterDeviceChange).not.toBe(afterLayoutChange);
    expect(firstDevice.bindGroups.length).toBe(2);
    expect(secondDevice.bindGroups.length).toBe(1);
  });

  it("tracks current-buffer fallbacks for previous-frame slots", function () {
    const owner = {};
    const device = makeDevice("device-a");
    const pipelineCache = makePipelineCache();
    const currentJoint = makeBuffer("joint-a");
    const currentMorph = makeBuffer("morph-a");
    const currentInstance = makeBuffer("instance-a");
    const resources = [
      currentJoint,
      null,
      currentMorph,
      currentInstance,
      null,
      null,
      null,
    ];

    const first = getBindGroup(owner, device, pipelineCache, resources);
    const firstBuffers = first.descriptor.entries.map(
      (entry) => entry.resource.buffer,
    );
    expect(firstBuffers[4]).toBe(currentJoint);
    expect(firstBuffers[5]).toBe(currentMorph);
    expect(firstBuffers[6]).toBe(currentInstance);

    resources[0] = makeBuffer("joint-b");
    const afterCurrentChange = getBindGroup(
      owner,
      device,
      pipelineCache,
      resources,
    );
    expect(afterCurrentChange.descriptor.entries[0].resource.buffer).toBe(
      resources[0],
    );
    expect(afterCurrentChange.descriptor.entries[4].resource.buffer).toBe(
      resources[0],
    );

    resources[4] = makeBuffer("previous-joint");
    const afterPreviousAppears = getBindGroup(
      owner,
      device,
      pipelineCache,
      resources,
    );
    expect(afterPreviousAppears.descriptor.entries[0].resource.buffer).toBe(
      resources[0],
    );
    expect(afterPreviousAppears.descriptor.entries[4].resource.buffer).toBe(
      resources[4],
    );
  });
});
