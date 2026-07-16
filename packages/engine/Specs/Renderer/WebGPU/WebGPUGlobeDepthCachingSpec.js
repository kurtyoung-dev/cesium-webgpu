import { WebGPUGlobeDepth } from "../../../Source/Renderer/WebGPU/WebGPUGlobeDepth.js";

function makeDevice() {
  const bindGroups = [];
  const device = {
    createBindGroup(descriptor) {
      const bindGroup = { descriptor };
      bindGroups.push(bindGroup);
      return bindGroup;
    },
  };
  return { device, bindGroups };
}

function makeDepthTexture(sampleCount = 1) {
  const views = [];
  return {
    sampleCount,
    views,
    createView(descriptor) {
      const view = { descriptor };
      views.push(view);
      return view;
    },
  };
}

function prepareGlobeDepth(device) {
  const globeDepth = new WebGPUGlobeDepth();
  globeDepth._device = device;
  globeDepth._depthCopyBindGroupLayout = {};
  globeDepth._depthCopyMSAABindGroupLayout = {};
  globeDepth._depthCopySampler = {};
  return globeDepth;
}

describe("Renderer/WebGPU/WebGPUGlobeDepth bind-group caching", function () {
  it("reuses the depth view and bind group for a stable source texture", function () {
    const { device, bindGroups } = makeDevice();
    const globeDepth = prepareGlobeDepth(device);
    const depthTexture = makeDepthTexture();

    expect(globeDepth._updateDepthCopyBindGroup(depthTexture)).toBe(false);
    const firstBindGroup = globeDepth._depthCopyBindGroup;
    expect(globeDepth._updateDepthCopyBindGroup(depthTexture)).toBe(false);

    expect(depthTexture.views.length).toBe(1);
    expect(bindGroups.length).toBe(1);
    expect(globeDepth._depthCopyBindGroup).toBe(firstBindGroup);
  });

  it("creates a new binding for a new source texture", function () {
    const { device, bindGroups } = makeDevice();
    const globeDepth = prepareGlobeDepth(device);
    const first = makeDepthTexture();
    const second = makeDepthTexture();

    globeDepth._updateDepthCopyBindGroup(first);
    globeDepth._updateDepthCopyBindGroup(second);

    expect(first.views.length).toBe(1);
    expect(second.views.length).toBe(1);
    expect(bindGroups.length).toBe(2);
  });

  it("keeps single-sample and multisample bindings distinct", function () {
    const { device, bindGroups } = makeDevice();
    const globeDepth = prepareGlobeDepth(device);
    const singleSample = makeDepthTexture(1);
    const multisample = makeDepthTexture(4);

    expect(globeDepth._updateDepthCopyBindGroup(singleSample)).toBe(false);
    expect(globeDepth._depthCopyMSAABindGroup).toBeNull();
    expect(globeDepth._updateDepthCopyBindGroup(multisample)).toBe(true);
    expect(globeDepth._depthCopyBindGroup).toBeNull();
    expect(globeDepth._depthCopyMSAABindGroup).toBeDefined();
    expect(bindGroups.length).toBe(2);
  });

  it("invalidates cached bindings when render targets are destroyed", function () {
    const { device, bindGroups } = makeDevice();
    const globeDepth = prepareGlobeDepth(device);
    const depthTexture = makeDepthTexture();

    globeDepth._updateDepthCopyBindGroup(depthTexture);
    globeDepth._destroyTargets();
    globeDepth._device = device;
    globeDepth._depthCopyBindGroupLayout = {};
    globeDepth._depthCopySampler = {};
    globeDepth._updateDepthCopyBindGroup(depthTexture);

    expect(depthTexture.views.length).toBe(2);
    expect(bindGroups.length).toBe(2);
  });

  it("packs an explicit pick depth checkpoint into the caller-owned view", function () {
    const { device } = makeDevice();
    const globeDepth = prepareGlobeDepth(device);
    const depthTexture = makeDepthTexture();
    const destinationView = {};
    const pipeline = {};
    const calls = [];
    let descriptor;
    globeDepth._depthCopyPipeline = pipeline;
    // The normal update path creates this target together with the depth-copy
    // pipelines. The explicit pick checkpoint does not otherwise read it.
    globeDepth._outputTarget = {};

    const pass = {
      setScissorRect(...args) {
        calls.push(["scissor", ...args]);
      },
      setPipeline(value) {
        calls.push(["pipeline", value]);
      },
      setBindGroup(index, value) {
        calls.push(["bindGroup", index, value]);
      },
      draw(count) {
        calls.push(["draw", count]);
      },
      end() {
        calls.push(["end"]);
      },
    };
    const encoder = {
      beginRenderPass(value) {
        descriptor = value;
        return pass;
      },
    };

    globeDepth.executeCopyDepthToView(encoder, destinationView, depthTexture, {
      x: 10,
      y: 20,
      width: 3,
      height: 5,
    });

    expect(descriptor.colorAttachments[0]).toEqual(
      jasmine.objectContaining({
        view: destinationView,
        loadOp: "clear",
        storeOp: "store",
      }),
    );
    expect(calls[0]).toEqual(["scissor", 10, 20, 3, 5]);
    expect(calls[1]).toEqual(["pipeline", pipeline]);
    expect(calls[2][0]).toBe("bindGroup");
    expect(calls[3]).toEqual(["draw", 3]);
    expect(calls[4]).toEqual(["end"]);
  });
});
