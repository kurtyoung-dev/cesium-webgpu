import { getOrCreateShadowCastBindGroup } from "../../../Source/Renderer/WebGPU/WebGPUShadowCastBindGroupCache.js";

describe("Renderer/WebGPU/WebGPUShadowCastBindGroupCache", function () {
  function makeDevice() {
    const descriptors = [];
    return {
      descriptors: descriptors,
      device: {
        createBindGroup(descriptor) {
          const bindGroup = { descriptor: descriptor };
          descriptors.push(descriptor);
          return bindGroup;
        },
      },
    };
  }

  it("reuses a group for an exact persistent resource tuple", function () {
    const { device, descriptors } = makeDevice();
    const host = {};
    const layout = {};
    const sharedBuffer = {};
    const modelBuffer = {};
    const jointBuffer = {};
    const bindings = [{ binding: 1 }, { binding: 2 }];
    const fields = ["model", "joints"];
    const command = {
      model: { buffer: modelBuffer },
      joints: jointBuffer,
    };

    const first = getOrCreateShadowCastBindGroup(
      device,
      host,
      "shadow",
      layout,
      sharedBuffer,
      bindings,
      fields,
      command,
    );
    const second = getOrCreateShadowCastBindGroup(
      device,
      host,
      "shadow",
      layout,
      sharedBuffer,
      bindings,
      fields,
      command,
    );

    expect(second).toBe(first);
    expect(descriptors.length).toBe(1);
    expect(
      descriptors[0].entries.map((entry) => entry.resource.buffer),
    ).toEqual([sharedBuffer, modelBuffer, jointBuffer]);
  });

  it("reuses a persistent host across rebuilt command objects", function () {
    const { device, descriptors } = makeDevice();
    const host = {};
    const layout = {};
    const sharedBuffer = {};
    const modelBuffer = {};
    const bindings = [{ binding: 1 }];
    const fields = ["model"];

    const first = getOrCreateShadowCastBindGroup(
      device,
      host,
      "shadow",
      layout,
      sharedBuffer,
      bindings,
      fields,
      { model: { buffer: modelBuffer } },
    );
    const second = getOrCreateShadowCastBindGroup(
      device,
      host,
      "shadow",
      layout,
      sharedBuffer,
      bindings,
      fields,
      { model: modelBuffer },
    );

    expect(second).toBe(first);
    expect(descriptors.length).toBe(1);
  });

  it("rebuilds for changed shared or per-command buffer identity", function () {
    const { device, descriptors } = makeDevice();
    const host = {};
    const layout = {};
    const firstShared = {};
    const secondShared = {};
    const firstModel = {};
    const secondModel = {};
    const bindings = [{ binding: 1 }];
    const fields = ["model"];
    const command = { model: firstModel };

    const first = getOrCreateShadowCastBindGroup(
      device,
      host,
      "shadow",
      layout,
      firstShared,
      bindings,
      fields,
      command,
    );
    const second = getOrCreateShadowCastBindGroup(
      device,
      host,
      "shadow",
      layout,
      secondShared,
      bindings,
      fields,
      command,
    );
    command.model = secondModel;
    const third = getOrCreateShadowCastBindGroup(
      device,
      host,
      "shadow",
      layout,
      secondShared,
      bindings,
      fields,
      command,
    );

    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
    expect(descriptors.length).toBe(3);
  });

  it("includes device, layout, and binding number in cache identity", function () {
    const firstDevice = makeDevice();
    const secondDevice = makeDevice();
    const host = {};
    const firstLayout = {};
    const secondLayout = {};
    const sharedBuffer = {};
    const modelBuffer = {};
    const fields = ["model"];
    const command = { model: modelBuffer };

    const first = getOrCreateShadowCastBindGroup(
      firstDevice.device,
      host,
      "shadow",
      firstLayout,
      sharedBuffer,
      [{ binding: 1 }],
      fields,
      command,
    );
    const differentLayout = getOrCreateShadowCastBindGroup(
      firstDevice.device,
      host,
      "shadow",
      secondLayout,
      sharedBuffer,
      [{ binding: 1 }],
      fields,
      command,
    );
    const differentBinding = getOrCreateShadowCastBindGroup(
      firstDevice.device,
      host,
      "shadow",
      firstLayout,
      sharedBuffer,
      [{ binding: 2 }],
      fields,
      command,
    );
    const differentDevice = getOrCreateShadowCastBindGroup(
      secondDevice.device,
      host,
      "shadow",
      firstLayout,
      sharedBuffer,
      [{ binding: 1 }],
      fields,
      command,
    );

    expect(differentLayout).not.toBe(first);
    expect(differentBinding).not.toBe(first);
    expect(differentDevice).not.toBe(first);
    expect(firstDevice.descriptors.length).toBe(3);
    expect(secondDevice.descriptors.length).toBe(1);
  });

  it("does not create a group when a required resource is absent", function () {
    const { device, descriptors } = makeDevice();

    expect(
      getOrCreateShadowCastBindGroup(
        device,
        {},
        "shadow",
        {},
        {},
        [{ binding: 1 }],
        ["missing"],
        {},
      ),
    ).toBeUndefined();
    expect(descriptors.length).toBe(0);
  });

  it("fails closed for malformed binding metadata or destroyed wrappers", function () {
    const { device, descriptors } = makeDevice();
    const sharedBuffer = {};

    expect(
      getOrCreateShadowCastBindGroup(
        device,
        {},
        "shadow",
        {},
        sharedBuffer,
        [{ binding: 1 }, { binding: 2 }],
        ["model"],
        { model: {} },
      ),
    ).toBeUndefined();
    expect(
      getOrCreateShadowCastBindGroup(
        device,
        {},
        "shadow",
        {},
        sharedBuffer,
        [{ binding: 1 }],
        ["model"],
        {
          model: {
            buffer: {},
            isDestroyed: true,
          },
        },
      ),
    ).toBeUndefined();
    expect(
      getOrCreateShadowCastBindGroup(
        device,
        {},
        "shadow",
        {},
        sharedBuffer,
        [{ binding: 1 }],
        ["model"],
        { model: { buffer: undefined } },
      ),
    ).toBeUndefined();
    expect(descriptors.length).toBe(0);
  });
});
