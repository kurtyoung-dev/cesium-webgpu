import {
  dispatchClusteredLighting,
  getClusteredLightingBuffers,
} from "../../../Source/Renderer/WebGPU/WebGPUSceneRendererClusteredLighting.js";

// C9-16-CLUSTERED-LIGHT-ZERO-WORK-CONTRACT — direct unit coverage for the
// disabled/no-light zero-work state machine and the single enabled->disabled
// transition params write. Mock-device based (no navigator.gpu): the hook is
// exercised over fake host/context/dispatcher surfaces so it runs in headless
// CI where a real WebGPU device is unavailable. The lazy real-dispatcher
// construction on the FIRST enabled frame is covered end-to-end by the
// Playwright gates (probe-clustered-per-frame.mjs etc.); here every case that
// needs a dispatcher injects a recording fake, per the sanctioned pattern.

function makeBuffer(label) {
  return { label: label };
}

// A recording stand-in for WebGPUClusteredLightingDispatcher. Records every
// dispatch() call with its inputs and exposes identity-stable buffer getters so
// the hook's stash-publication path (invariant 4) can be asserted.
function makeFakeDispatcher(lastActiveLightCount) {
  const buffers = {
    clusterLights: makeBuffer("clusterLights"),
    clusterAABBs: makeBuffer("clusterAABBs"),
    perClusterLightCount: makeBuffer("perClusterLightCount"),
    perClusterLightIndices: makeBuffer("perClusterLightIndices"),
    params: makeBuffer("params"),
    areaLights: makeBuffer("areaLights"),
  };
  return {
    dispatchCalls: [],
    lastActiveLightCount: lastActiveLightCount ?? 0,
    dispatch: function (encoder, inputs) {
      this.dispatchCalls.push({ encoder: encoder, inputs: inputs });
      return this.lastActiveLightCount;
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
    const dispatcher = makeFakeDispatcher(0);
    const host = makeHost(dispatcher);
    const context = makeContext();
    const scene = makeScene(false);

    // First disabled frame after the dispatcher already existed: one sync.
    dispatchClusteredLighting(host, { scene: scene, context: context });
    expect(dispatcher.dispatchCalls.length).toBe(1);
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

  it("enabled with zero effective lights publishes identity-stable buffers and marks inactive", function () {
    const dispatcher = makeFakeDispatcher(0); // lastActiveLightCount 0
    const host = makeHost(dispatcher);
    const context = makeContext();
    const scene = makeScene(true, []); // enabled, no lights

    dispatchClusteredLighting(host, { scene: scene, context: context });

    expect(dispatcher.dispatchCalls.length).toBe(1);
    expect(dispatcher.dispatchCalls[0].inputs.enabled).toBe(true);
    expect(dispatcher.dispatchCalls[0].inputs.lights).toEqual([]);
    // Enabled path ends+resumes the pass around the compute hook.
    expect(context._calls.endCurrentRenderPass).toBe(1);
    expect(context._calls.resumeDefaultRenderPass).toBe(1);
    // Invariant 4: buffers are published (stable handles) even with 0 lights,
    // but the "contributing this frame" flag is false.
    const firstBuffers = context._clusteredLightingBuffers;
    expect(firstBuffers).toBeDefined();
    expect(firstBuffers.params).toBe(dispatcher._buffers.params);
    expect(context._clusteredLightingActive).toBe(false);

    // A second enabled/zero-light frame keeps the SAME buffer identities.
    dispatchClusteredLighting(host, { scene: scene, context: context });
    expect(context._clusteredLightingBuffers.params).toBe(firstBuffers.params);
    expect(context._clusteredLightingBuffers.clusterLights).toBe(
      firstBuffers.clusterLights,
    );
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
  });
});
