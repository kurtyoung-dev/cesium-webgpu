import {
  WebGPUEnvironmentDemand,
  WebGPUEnvironmentDemandReason,
  WebGPUEnvironmentDemandRegistry,
} from "../../../Source/Renderer/WebGPU/WebGPUEnvironmentDemandRegistry.js";

describe("Renderer/WebGPU/WebGPUEnvironmentDemandRegistry", function () {
  it("coalesces consumer evidence conservatively without gating work", function () {
    const registry = new WebGPUEnvironmentDemandRegistry();
    const manager = {};
    registry.beginFrame(4);

    registry.registerProvenNoDemand(
      manager,
      WebGPUEnvironmentDemandReason.TILESET_SELECTION,
    );
    expect(registry.classify(manager)).toBe(
      WebGPUEnvironmentDemand.PROVEN_NONE,
    );

    registry.registerUnknown(
      manager,
      WebGPUEnvironmentDemandReason.STANDALONE_OWNER,
      1,
    );
    expect(registry.classify(manager)).toBe(WebGPUEnvironmentDemand.UNKNOWN);

    registry.registerDemand(
      manager,
      WebGPUEnvironmentDemandReason.TILESET_SELECTION,
      3,
    );
    registry.registerProvenNoDemand(
      manager,
      WebGPUEnvironmentDemandReason.TILESET_SELECTION,
    );
    expect(registry.classify(manager)).toBe(WebGPUEnvironmentDemand.DEMANDED);

    expect(registry.getRecord(manager)).toEqual({
      demand: WebGPUEnvironmentDemand.DEMANDED,
      reasonMask:
        WebGPUEnvironmentDemandReason.TILESET_SELECTION |
        WebGPUEnvironmentDemandReason.STANDALONE_OWNER,
      consumerCount: 4,
      registrationCount: 4,
      updateReadCount: 0,
    });
    expect(registry.getTelemetry()).toEqual({
      frameId: 1,
      resourceGeneration: 4,
      registrations: 4,
      registeredConsumers: 4,
      uniqueManagers: 1,
      demanded: 1,
      provenNone: 0,
      unknown: 0,
      updateReads: 0,
      updateReadsDemanded: 0,
      updateReadsProvenNone: 0,
      updateReadsUnknown: 0,
      unregisteredUpdateReads: 0,
    });
  });

  it("treats absent and prior-frame registrations as unknown", function () {
    const registry = new WebGPUEnvironmentDemandRegistry();
    const registered = {};
    const absent = {};
    registry.beginFrame(2);
    registry.registerDemand(
      registered,
      WebGPUEnvironmentDemandReason.TILESET_SELECTION,
      1,
    );

    expect(registry.observeUpdate(absent)).toBe(
      WebGPUEnvironmentDemand.UNKNOWN,
    );
    registry.beginFrame(2);
    expect(registry.classify(registered)).toBe(WebGPUEnvironmentDemand.UNKNOWN);
    expect(registry.getTelemetry().uniqueManagers).toBe(0);
  });

  it("clears current-frame evidence on resource-generation reset", function () {
    const registry = new WebGPUEnvironmentDemandRegistry();
    const manager = {};
    registry.beginFrame(7);
    registry.registerDemand(
      manager,
      WebGPUEnvironmentDemandReason.TILESET_SELECTION,
      2,
    );

    registry.reset(8);

    expect(registry.classify(manager)).toBe(WebGPUEnvironmentDemand.UNKNOWN);
    expect(registry.getTelemetry().resourceGeneration).toBe(8);
    expect(registry.getTelemetry().uniqueManagers).toBe(0);
  });
});
