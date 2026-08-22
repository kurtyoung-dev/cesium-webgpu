import {
  dispatchClusteredLighting,
  getClusteredLightingBuffers,
} from "../../../Source/Renderer/WebGPU/WebGPUSceneRendererClusteredLighting.js";

// The hook is exercised over recording host, context, and dispatcher surfaces
// so its state machine does not require a real WebGPU device.

function makeBuffer(label) {
  return { label: label };
}

// The stand-in snapshots inputs because the real dispatcher copies them before
// the scene hook reuses its module-level arrays on the next frame.
function makeFakeDispatcher(lastActiveLightCount, lastAreaLightCount) {
  const buffers = {
    clusterLights: makeBuffer("clusterLights"),
    clusterAABBs: makeBuffer("clusterAABBs"),
    perClusterLightCount: makeBuffer("perClusterLightCount"),
    perClusterLightIndices: makeBuffer("perClusterLightIndices"),
    params: makeBuffer("params"),
    areaLights: makeBuffer("areaLights"),
  };
  const initialActiveCount = lastActiveLightCount ?? 0;
  const initialAreaCount = lastAreaLightCount ?? 0;
  return {
    dispatchCalls: [],
    paramsWriteBufferCalls: 0,
    lastActiveLightCount: initialActiveCount,
    lastAreaLightCount: initialAreaCount,
    _lastWrittenActiveLightCount: initialActiveCount,
    _lastWrittenAreaLightCount: initialAreaCount,
    get paramsAreAllZero() {
      return (
        this._lastWrittenActiveLightCount === 0 &&
        this._lastWrittenAreaLightCount === 0
      );
    },
    dispatch: function (encoder, inputs) {
      const lights = Array.from(inputs.lights);
      const areaLights = Array.from(inputs.areaLights ?? []);
      const activeCount = inputs.enabled ? lights.length : 0;
      const areaCount = inputs.enabled ? areaLights.length : 0;
      this.dispatchCalls.push({
        encoder: encoder,
        inputs: { ...inputs, lights: lights, areaLights: areaLights },
      });
      this.lastActiveLightCount = activeCount;
      this.lastAreaLightCount = areaCount;
      if (activeCount === 0 && areaCount === 0 && this.paramsAreAllZero) {
        return 0;
      }
      this.paramsWriteBufferCalls++;
      this._lastWrittenActiveLightCount = activeCount;
      this._lastWrittenAreaLightCount = areaCount;
      return activeCount;
    },
    get clusterLightsBuffer() {
      return buffers.clusterLights;
    },
    get clusterAABBsBuffer() {
      return buffers.clusterAABBs;
    },
    get perClusterLightCountBuffer() {
      return buffers.perClusterLightCount;
    },
    get perClusterLightIndicesBuffer() {
      return buffers.perClusterLightIndices;
    },
    get paramsBuffer() {
      return buffers.params;
    },
    get areaLightsBuffer() {
      return buffers.areaLights;
    },
    get ltcLUTView() {
      return null;
    },
    _buffers: buffers,
  };
}

// A recording context surface with the fields the hook reads.
function makeContext(options) {
  const opts = options ?? {};
  const calls = { endCurrentRenderPass: 0, resumeDefaultRenderPass: 0 };
  return {
    _device: "device" in opts ? opts.device : {},
    _currentCommandEncoder: "encoder" in opts ? opts.encoder : {},
    uniformState:
      "uniformState" in opts
        ? opts.uniformState
        : {
            projection: new Float32Array(16),
            inverseProjection: new Float32Array(16),
            view: new Float32Array(16),
          },
    _clusteredLightingBuffers: undefined,
    _clusteredLightingActive: undefined,
    endCurrentRenderPass: function () {
      calls.endCurrentRenderPass++;
    },
    resumeDefaultRenderPass: function () {
      calls.resumeDefaultRenderPass++;
    },
    _calls: calls,
  };
}

function makeScene(enabled, lights) {
  return {
    clusteredLightingEnabled: enabled,
    camera: { frustum: { near: 1.0, far: 10000.0 } },
    lights: {
      length: lights ? lights.length : 0,
      get: function (i) {
        return lights[i];
      },
    },
  };
}

function makeHost(dispatcher) {
  return {
    _clusteredLightingDispatcher: dispatcher ?? null,
    _viewportWidth: 800,
    _viewportHeight: 600,
  };
}

describe("Renderer/WebGPU/WebGPUSceneRendererClusteredLighting", function () {
  it("disabled with no dispatcher makes zero device calls and publishes no buffers", function () {
    const host = makeHost(null);
    const context = makeContext();
    const scene = makeScene(false);

    dispatchClusteredLighting(host, { scene: scene, context: context });

    expect(context._clusteredLightingBuffers).toBeUndefined();
    expect(context._clusteredLightingActive).toBe(false);
    expect(context._calls.endCurrentRenderPass).toBe(0);
    expect(context._calls.resumeDefaultRenderPass).toBe(0);
    expect(host._clusteredLightingDispatcher).toBeNull();

    // Repeated disabled frames stay no-ops.
    dispatchClusteredLighting(host, { scene: scene, context: context });
    expect(context._clusteredLightingActive).toBe(false);
  });

  it("enabled->disabled transition writes exactly one zero-count params dispatch", function () {
    const dispatcher = makeFakeDispatcher(1);
    const host = makeHost(dispatcher);
    const context = makeContext();
    const scene = makeScene(false);

    // First disabled frame after the dispatcher already existed: one sync.
    dispatchClusteredLighting(host, { scene: scene, context: context });
    expect(dispatcher.dispatchCalls.length).toBe(1);
    expect(dispatcher.paramsWriteBufferCalls).toBe(1);
    const call = dispatcher.dispatchCalls[0];
    expect(call.inputs.enabled).toBe(false);
    expect(call.inputs.lights).toEqual([]);
    expect(call.inputs.areaLights).toEqual([]);
    // The zero-count sync must NOT churn the canvas render pass.
    expect(context._calls.endCurrentRenderPass).toBe(0);
    expect(context._calls.resumeDefaultRenderPass).toBe(0);
    expect(context._clusteredLightingBuffers).toBeUndefined();
    expect(context._clusteredLightingActive).toBe(false);

    // Subsequent settled disabled frames are no-ops (WeakSet marked).
    dispatchClusteredLighting(host, { scene: scene, context: context });
    dispatchClusteredLighting(host, { scene: scene, context: context });
    expect(dispatcher.dispatchCalls.length).toBe(1);
  });

  it("disabled transition retries next frame when the encoder is unavailable", function () {
    const dispatcher = makeFakeDispatcher(0);
    const host = makeHost(dispatcher);
    const scene = makeScene(false);

    // Frame state not ready: encoder missing. No sync, no WeakSet mark.
    const noEncoderCtx = makeContext({ encoder: undefined });
    dispatchClusteredLighting(host, { scene: scene, context: noEncoderCtx });
    expect(dispatcher.dispatchCalls.length).toBe(0);

    // Next frame with an encoder performs the single sync (retry succeeded).
    const okCtx = makeContext();
    dispatchClusteredLighting(host, { scene: scene, context: okCtx });
    expect(dispatcher.dispatchCalls.length).toBe(1);
    expect(dispatcher.dispatchCalls[0].inputs.enabled).toBe(false);
  });

  it("enabled with repeated zero effective lights performs no queue or pass work", function () {
    const dispatcher = makeFakeDispatcher(0, 0);
    const host = makeHost(dispatcher);
    const context = makeContext();
    const scene = makeScene(true, []);

    dispatchClusteredLighting(host, { scene: scene, context: context });

    expect(dispatcher.dispatchCalls.length).toBe(0);
    expect(dispatcher.paramsWriteBufferCalls).toBe(0);
    expect(context._calls.endCurrentRenderPass).toBe(0);
    expect(context._calls.resumeDefaultRenderPass).toBe(0);
    const firstBuffers = context._clusteredLightingBuffers;
    expect(firstBuffers).toBeDefined();
    expect(firstBuffers.params).toBe(dispatcher._buffers.params);
    expect(context._clusteredLightingActive).toBe(false);

    dispatchClusteredLighting(host, { scene: scene, context: context });
    expect(dispatcher.dispatchCalls.length).toBe(0);
    expect(dispatcher.paramsWriteBufferCalls).toBe(0);
    expect(context._calls.endCurrentRenderPass).toBe(0);
    expect(context._calls.resumeDefaultRenderPass).toBe(0);
    expect(context._clusteredLightingBuffers).toBe(firstBuffers);
  });

  it("writes params exactly once when enabled lighting transitions from active to zero", function () {
    const dispatcher = makeFakeDispatcher(0, 0);
    const host = makeHost(dispatcher);
    const context = makeContext();
    const light = {
      lightType: 1,
      enabled: true,
      position: { x: 10, y: 20, z: 30 },
      color: { red: 1, green: 1, blue: 1 },
      intensity: 2,
    };

    dispatchClusteredLighting(host, {
      scene: makeScene(true, [light]),
      context: context,
    });
    const activeBuffers = context._clusteredLightingBuffers;
    const writesBeforeTransition = dispatcher.paramsWriteBufferCalls;

    dispatchClusteredLighting(host, {
      scene: makeScene(true, []),
      context: context,
    });
    expect(dispatcher.paramsWriteBufferCalls - writesBeforeTransition).toBe(1);
    expect(dispatcher.dispatchCalls.length).toBe(2);
    expect(context._calls.endCurrentRenderPass).toBe(2);
    expect(context._calls.resumeDefaultRenderPass).toBe(2);
    expect(context._clusteredLightingBuffers).toBe(activeBuffers);
    expect(context._clusteredLightingActive).toBe(false);

    dispatchClusteredLighting(host, {
      scene: makeScene(true, []),
      context: context,
    });
    expect(dispatcher.paramsWriteBufferCalls - writesBeforeTransition).toBe(1);
    expect(dispatcher.dispatchCalls.length).toBe(2);
    expect(context._calls.endCurrentRenderPass).toBe(2);
    expect(context._calls.resumeDefaultRenderPass).toBe(2);
    expect(context._clusteredLightingBuffers).toBe(activeBuffers);
  });

  it("enabled with an active light marks clustered lighting contributing", function () {
    const dispatcher = makeFakeDispatcher(1); // one active light packed
    const host = makeHost(dispatcher);
    const context = makeContext();
    const light = {
      lightType: 1, // point
      enabled: true,
      position: { x: 10, y: 20, z: 30 },
      color: { red: 1, green: 1, blue: 1 },
      intensity: 2,
    };
    const scene = makeScene(true, [light]);

    dispatchClusteredLighting(host, { scene: scene, context: context });

    expect(dispatcher.dispatchCalls.length).toBe(1);
    expect(dispatcher.dispatchCalls[0].inputs.lights.length).toBe(1);
    expect(context._clusteredLightingActive).toBe(true);
    expect(context._clusteredLightingBuffers).toBeDefined();
    expect(context._calls.endCurrentRenderPass).toBe(1);
    expect(context._calls.resumeDefaultRenderPass).toBe(1);
  });

  it("balances the enabled render pass when frame state is unavailable", function () {
    const light = {
      lightType: 1,
      enabled: true,
      position: { x: 10, y: 20, z: 30 },
      color: { red: 1, green: 1, blue: 1 },
      intensity: 2,
    };
    const contexts = [
      makeContext({ encoder: undefined }),
      makeContext({ uniformState: {} }),
    ];

    for (const context of contexts) {
      const dispatcher = makeFakeDispatcher(0, 0);
      dispatchClusteredLighting(makeHost(dispatcher), {
        scene: makeScene(true, [light]),
        context: context,
      });

      expect(dispatcher.dispatchCalls.length).toBe(0);
      expect(context._calls.endCurrentRenderPass).toBe(1);
      expect(context._calls.resumeDefaultRenderPass).toBe(1);
    }
  });

  it("re-enabling after a disabled transition resumes dispatch", function () {
    const dispatcher = makeFakeDispatcher(0);
    const host = makeHost(dispatcher);

    // Disabled transition marks the host synchronized.
    dispatchClusteredLighting(host, {
      scene: makeScene(false),
      context: makeContext(),
    });
    expect(dispatcher.dispatchCalls.length).toBe(1);

    // Re-enable: the host must be cleared from the disabled set and dispatch
    // must run again on the enabled path.
    dispatcher.lastActiveLightCount = 1;
    const light = {
      lightType: 1,
      enabled: true,
      position: { x: 1, y: 2, z: 3 },
      color: { red: 1, green: 1, blue: 1 },
      intensity: 1,
    };
    const enabledCtx = makeContext();
    dispatchClusteredLighting(host, {
      scene: makeScene(true, [light]),
      context: enabledCtx,
    });
    expect(dispatcher.dispatchCalls.length).toBe(2);
    expect(dispatcher.dispatchCalls[1].inputs.enabled).toBe(true);
    expect(enabledCtx._clusteredLightingActive).toBe(true);

    // Disabling again performs exactly one fresh sync (WeakSet was cleared).
    const disableCtx = makeContext();
    dispatchClusteredLighting(host, {
      scene: makeScene(false),
      context: disableCtx,
    });
    expect(dispatcher.dispatchCalls.length).toBe(3);
    expect(dispatcher.dispatchCalls[2].inputs.enabled).toBe(false);
  });

  it("an enabled area-light-only scene routes to the area-light list", function () {
    const dispatcher = makeFakeDispatcher(0); // no punctual lights active
    const host = makeHost(dispatcher);
    const context = makeContext();
    const areaLight = {
      lightType: 3, // RECT_AREA
      enabled: true,
      position: { x: 0, y: 0, z: 5 },
      direction: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
      width: 2,
      height: 2,
      color: { red: 1, green: 1, blue: 1 },
      intensity: 1,
    };
    const scene = makeScene(true, [areaLight]);

    dispatchClusteredLighting(host, { scene: scene, context: context });

    const inputs = dispatcher.dispatchCalls[0].inputs;
    expect(inputs.lights.length).toBe(0); // no punctual
    expect(inputs.areaLights.length).toBe(1); // routed to area list
    expect(inputs.areaLights[0].lightType).toBe(3);
  });

  it("getClusteredLightingBuffers returns null before a dispatcher exists and handles after", function () {
    const host = makeHost(null);
    expect(getClusteredLightingBuffers(host)).toBeNull();

    const dispatcher = makeFakeDispatcher(0);
    host._clusteredLightingDispatcher = dispatcher;
    const buffers = getClusteredLightingBuffers(host);
    expect(buffers).not.toBeNull();
    expect(buffers.params).toBe(dispatcher._buffers.params);
    expect(buffers.clusterLights).toBe(dispatcher._buffers.clusterLights);
    expect(getClusteredLightingBuffers(host)).toBe(buffers);
  });
});
