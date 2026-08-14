import { WebGPUEdgeFramebuffer } from "../../../Source/Renderer/WebGPU/WebGPUEdgeFramebuffer.js";
import { WebGPUGlobeDepth } from "../../../Source/Renderer/WebGPU/WebGPUGlobeDepth.js";
import { WebGPUOIT } from "../../../Source/Renderer/WebGPU/WebGPUOIT.js";
import { ensureResources } from "../../../Source/Renderer/WebGPU/WebGPUSceneRendererEnsureResources.js";

describe("Renderer/WebGPU/WebGPUSceneRenderer dependent resources", function () {
  const width = 800;
  const height = 600;

  function sameTuple(left, right) {
    return (
      left.length === right.length &&
      left.every(function (value, index) {
        return value === right[index];
      })
    );
  }

  function createTrackedTarget(name, initialTuple) {
    let tuple = initialTuple.slice();
    let recreationCount = 0;
    return {
      update: jasmine.createSpy(`${name}.update`).and.callFake(function () {
        const next = Array.from(arguments);
        if (!sameTuple(tuple, next)) {
          tuple = next;
          recreationCount++;
        }
      }),
      get recreationCount() {
        return recreationCount;
      },
    };
  }

  function createHarness(options = {}) {
    const device = { label: "device" };
    const colorView = { label: "scene color" };
    const depthView = { label: "scene depth" };
    const context = {
      _device: device,
      _canvas: { width, height },
      _msaaSamples: options.samples ?? 4,
      _sceneColorFormat: options.colorFormat ?? "bgra8unorm",
      _scenePipelineFormatGeneration: 3,
      _sceneColorView: colorView,
      _depthStencilView: depthView,
      _postProcessSnapshotTexture: { label: "snapshot" },
      _postProcessSnapshotView: { label: "snapshot view" },
      _postProcessSnapshotWidth: width,
      _postProcessSnapshotHeight: height,
      _postProcessSnapshotDevice: device,
      _postProcessCacheStatsSource: null,
      presentationFormat: "bgra8unorm",
      renderBundleManager: {
        invalidateAll: jasmine.createSpy("invalidateAll"),
      },
      onDeviceInvalidated: jasmine.createSpy("onDeviceInvalidated"),
    };
    const sceneFramebuffer = {
      colorFormat: options.colorFormat ?? "bgra8unorm",
      colorTarget: {
        getColorTextureView: jasmine
          .createSpy("getColorTextureView")
          .and.returnValue(colorView),
      },
      depthSampleableView: depthView,
      update: jasmine.createSpy("sceneFramebuffer.update"),
    };
    const edge = createTrackedTarget("edge", [
      device,
      width,
      height,
      options.samples ?? 4,
      options.colorFormat ?? "bgra8unorm",
    ]);
    const classification = createTrackedTarget("classification", [
      device,
      width,
      height,
      options.colorFormat ?? "bgra8unorm",
    ]);
    const oit = createTrackedTarget("oit", [
      device,
      width,
      height,
      options.samples ?? 4,
    ]);
    const globe = createTrackedTarget("globe", [
      device,
      width,
      height,
      options.hdr ?? false,
      options.samples ?? 4,
      "bgra8unorm",
    ]);
    const scene = {
      _enableEdgeVisibility: options.edgeEnabled ?? true,
    };
    const config = {
      context,
      scene,
      useHDR: options.hdr ?? false,
      useOIT: options.oitRequested ?? true,
      useGlobeDepthFramebuffer: options.globeEnabled ?? true,
      useDepthPlane: false,
      usePostProcess: false,
    };
    const host = {
      _sceneFramebuffer: sceneFramebuffer,
      _edgeFramebuffer: options.edgeAbsent ? null : edge,
      _translucentTileClassification: classification,
      _oit: options.oitAbsent ? null : oit,
      _webgpuOITEnabled: options.oitEnabled ?? true,
      _lastOITRequested: false,
      _globeDepth: options.globeAbsent ? null : globe,
      _depthPlane: null,
      _postProcess: null,
      _debugDepthOverlay: null,
      _debugFrustumOverlay: null,
      _initialized: true,
      _width: width,
      _height: height,
      _lastHDR: options.hdr ?? false,
      _deviceInvalidationUnsub: jasmine.createSpy("unsubscribe"),
    };

    return {
      classification,
      config,
      context,
      device,
      edge,
      globe,
      host,
      oit,
      sceneFramebuffer,
    };
  }

  it("keeps the default steady state allocation-free", function () {
    const harness = createHarness();

    ensureResources(harness.host, harness.config);
    ensureResources(harness.host, harness.config);

    expect(harness.sceneFramebuffer.update).not.toHaveBeenCalled();
    expect(harness.edge.update.calls.count()).toBe(2);
    expect(harness.classification.update.calls.count()).toBe(2);
    expect(harness.oit.update.calls.count()).toBe(2);
    expect(harness.globe.update.calls.count()).toBe(2);
    expect(harness.edge.recreationCount).toBe(0);
    expect(harness.classification.recreationCount).toBe(0);
    expect(harness.oit.recreationCount).toBe(0);
    expect(harness.globe.recreationCount).toBe(0);
  });

  it("refreshes HDR-dependent targets after prepareFrame consumed the toggle", function () {
    const harness = createHarness();
    harness.host._lastHDR = true;
    harness.config.useHDR = true;
    harness.sceneFramebuffer.colorFormat = "rgba16float";
    harness.context._sceneColorFormat = "rgba16float";

    ensureResources(harness.host, harness.config);

    expect(harness.sceneFramebuffer.update).not.toHaveBeenCalled();
    expect(harness.edge.update).toHaveBeenCalledWith(
      harness.device,
      width,
      height,
      4,
      "rgba16float",
    );
    expect(harness.classification.update).toHaveBeenCalledWith(
      harness.device,
      width,
      height,
      "rgba16float",
    );
    expect(harness.oit.update).toHaveBeenCalledWith(
      harness.device,
      width,
      height,
      4,
    );
    expect(harness.globe.update).toHaveBeenCalledWith(
      harness.device,
      width,
      height,
      true,
      4,
      "bgra8unorm",
    );
    expect(harness.edge.recreationCount).toBe(1);
    expect(harness.classification.recreationCount).toBe(1);
    expect(harness.oit.recreationCount).toBe(0);
    expect(harness.globe.recreationCount).toBe(1);
  });

  it("refreshes MSAA-dependent targets in both directions", function () {
    const harness = createHarness();

    harness.context._msaaSamples = 1;
    ensureResources(harness.host, harness.config);
    expect(harness.edge.recreationCount).toBe(1);
    expect(harness.oit.recreationCount).toBe(1);
    expect(harness.globe.recreationCount).toBe(1);
    expect(harness.classification.recreationCount).toBe(0);

    harness.context._msaaSamples = 4;
    ensureResources(harness.host, harness.config);
    expect(harness.edge.recreationCount).toBe(2);
    expect(harness.oit.recreationCount).toBe(2);
    expect(harness.globe.recreationCount).toBe(2);
    expect(harness.classification.recreationCount).toBe(0);
    expect(harness.sceneFramebuffer.update).not.toHaveBeenCalled();
  });

  it("refreshes each applicable tuple on a combined HDR and MSAA toggle", function () {
    const harness = createHarness();
    harness.host._lastHDR = true;
    harness.config.useHDR = true;
    harness.context._msaaSamples = 1;
    harness.context._sceneColorFormat = "rgba16float";
    harness.sceneFramebuffer.colorFormat = "rgba16float";

    ensureResources(harness.host, harness.config);

    expect(harness.edge.recreationCount).toBe(1);
    expect(harness.classification.recreationCount).toBe(1);
    expect(harness.oit.recreationCount).toBe(1);
    expect(harness.globe.recreationCount).toBe(1);
    expect(harness.sceneFramebuffer.update).not.toHaveBeenCalled();
  });

  it("does not allocate absent targets behind disabled feature gates", function () {
    const harness = createHarness({
      edgeAbsent: true,
      edgeEnabled: false,
      globeAbsent: true,
      globeEnabled: false,
      oitAbsent: true,
      oitEnabled: false,
    });

    ensureResources(harness.host, harness.config);

    expect(harness.host._edgeFramebuffer).toBeNull();
    expect(harness.host._oit).toBeNull();
    expect(harness.host._globeDepth).toBeNull();
    expect(harness.classification.update.calls.count()).toBe(1);
  });

  it("allocates each newly enabled branch once while refreshing it every frame", function () {
    const harness = createHarness({
      edgeAbsent: true,
      globeAbsent: true,
      oitAbsent: true,
    });
    spyOn(WebGPUEdgeFramebuffer.prototype, "update");
    spyOn(WebGPUOIT.prototype, "update");
    spyOn(WebGPUGlobeDepth.prototype, "update");

    ensureResources(harness.host, harness.config);
    const edge = harness.host._edgeFramebuffer;
    const oit = harness.host._oit;
    const globe = harness.host._globeDepth;
    ensureResources(harness.host, harness.config);

    expect(harness.host._edgeFramebuffer).toBe(edge);
    expect(harness.host._oit).toBe(oit);
    expect(harness.host._globeDepth).toBe(globe);
    expect(WebGPUEdgeFramebuffer.prototype.update.calls.count()).toBe(2);
    expect(WebGPUOIT.prototype.update.calls.count()).toBe(2);
    expect(WebGPUGlobeDepth.prototype.update.calls.count()).toBe(2);
  });
});
