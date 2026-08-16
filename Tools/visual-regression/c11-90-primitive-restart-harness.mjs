// @purpose Browser-side harness loading primitive-restart strip/fan GLB models per backend, recording pipeline recreation history for the C11-90 probe.
// @status ACTIVE

import * as Cesium from "cesium";

const renderer = new URLSearchParams(window.location.search).get("renderer");
const validRenderers = new Set(["webgl", "webgpu"]);
const topologies = Object.freeze({
  "triangle-strips": Object.freeze({
    label: "Triangle Strips",
    url: "/Apps/SampleData/models/PrimitiveRestart/primitive-restart-triangle-strip.glb",
    primitiveType: 5,
  }),
  "triangle-fans": Object.freeze({
    label: "Triangle Fans",
    url: "/Apps/SampleData/models/PrimitiveRestart/primitive-restart-triangle-fan.glb",
    primitiveType: 6,
  }),
});

const state = {
  status: "BOOTING",
  renderer,
  generation: 0,
  recreationHistory: [],
  activeTopology: null,
  errors: [],
};

let viewer;
let model;

function textOf(value) {
  return value?.stack ?? value?.message ?? String(value);
}

function requireRenderer() {
  if (!validRenderers.has(renderer)) {
    throw new Error(
      `STRUCTURAL: renderer query must be exactly webgl or webgpu; got ${renderer}`,
    );
  }
}

function settleFrames(frameCount) {
  return new Promise((resolve) => {
    let remaining = frameCount;
    function next() {
      viewer?.scene.requestRender();
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(next);
    }
    requestAnimationFrame(next);
  });
}

async function waitForModelReady(candidate) {
  if (candidate.ready) {
    return;
  }
  await new Promise((resolve, reject) => {
    let removeReady;
    let removeError;
    const timer = setTimeout(() => {
      removeReady?.();
      removeError?.();
      reject(new Error("STRUCTURAL: model readyEvent did not fire in 30s"));
    }, 30_000);
    const finish = (callback, value) => {
      clearTimeout(timer);
      removeReady?.();
      removeError?.();
      callback(value);
    };
    removeReady = candidate.readyEvent.addEventListener(() => finish(resolve));
    removeError = candidate.errorEvent.addEventListener((error) =>
      finish(reject, error),
    );
  });
}

function collectAuthority() {
  const context = viewer?.scene?.context;
  const canvas = viewer?.scene?.canvas;
  const gl = context?._gl;
  const device = context?.device;
  return {
    requestedRenderer: renderer,
    rendererType: context?.rendererType ?? null,
    isWebGL: context?.isWebGL === true,
    isWebGPU: context?.isWebGPU === true,
    webgl2: context?.webgl2 === true,
    nativeWebGL2:
      typeof WebGL2RenderingContext !== "undefined" &&
      gl instanceof WebGL2RenderingContext,
    nativeDevice:
      typeof GPUDevice !== "undefined" && device instanceof GPUDevice,
    nativeCanvasContext:
      typeof GPUCanvasContext !== "undefined" &&
      context?._context instanceof GPUCanvasContext,
    contextId: context?.id ?? null,
    rendererString:
      typeof context?.getRendererString === "function"
        ? context.getRendererString()
        : null,
    canvasCount: document.querySelectorAll("#cesiumContainer canvas").length,
    canvasWidth: canvas?.width ?? 0,
    canvasHeight: canvas?.height ?? 0,
  };
}

function collectModelEvidence() {
  if (!model) {
    return null;
  }
  const runtimePrimitiveTypes = [];
  const commandPrimitiveTypes = [];
  for (const node of model._sceneGraph?._runtimeNodes ?? []) {
    for (const runtimePrimitive of node.runtimePrimitives ?? []) {
      const primitive =
        runtimePrimitive.primitive ?? runtimePrimitive._primitive;
      const primitiveType = primitive?.primitiveType ?? primitive?.mode;
      if (Number.isInteger(primitiveType)) {
        runtimePrimitiveTypes.push(primitiveType);
      }
      const commandPrimitiveType =
        runtimePrimitive.drawCommand?.primitiveType ??
        runtimePrimitive.drawCommand?._command?.primitiveType;
      if (Number.isInteger(commandPrimitiveType)) {
        commandPrimitiveTypes.push(commandPrimitiveType);
      }
    }
  }
  const nativePrimitives = Object.values(
    model._webgpuCache?.primitives ?? {},
  ).map((primitive) => ({
    topology: primitive.topology ?? null,
    stripIndexFormat: primitive.stripIndexFormat ?? null,
    indexFormat: primitive.indexFormat ?? null,
    indexCount: primitive.indexCount ?? null,
    vertexCount: primitive.vertexCount ?? null,
    hasIndexBuffer: Boolean(primitive.indexBuffer),
    hasPipeline: Boolean(primitive.pipeline),
  }));
  return {
    ready: model.ready === true,
    show: model.show === true,
    activeTopology: state.activeTopology,
    runtimePrimitiveTypes,
    commandPrimitiveTypes,
    nativePrimitives,
    boundingSphere: {
      radius: model.boundingSphere?.radius ?? null,
      center: model.boundingSphere?.center
        ? [
            model.boundingSphere.center.x,
            model.boundingSphere.center.y,
            model.boundingSphere.center.z,
          ]
        : null,
    },
  };
}

function getEvidence() {
  return {
    status: state.status,
    renderer: state.renderer,
    generation: state.generation,
    recreationHistory: structuredClone(state.recreationHistory),
    activeTopology: state.activeTopology,
    errors: [...state.errors],
    authority: viewer ? collectAuthority() : null,
    model: collectModelEvidence(),
  };
}

async function createViewer() {
  const oldViewer = viewer;
  const oldCanvas = oldViewer?.scene?.canvas;
  const oldContext = oldViewer?.scene?.context;
  if (model && oldViewer && !oldViewer.isDestroyed()) {
    oldViewer.scene.primitives.remove(model);
  }
  model = undefined;
  if (oldViewer && !oldViewer.isDestroyed()) {
    oldViewer.destroy();
  }
  document.querySelector("#cesiumContainer").replaceChildren();

  viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
    contextOptions: {
      renderer,
      strictRenderer: true,
    },
    baseLayer: false,
    baseLayerPicker: false,
    globe: false,
    skyAtmosphere: false,
    skyBox: false,
    animation: false,
    timeline: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    sceneModePicker: false,
    selectionIndicator: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    creditContainer: "creditContainer",
  });
  viewer.scene.backgroundColor = Cesium.Color.BLACK;
  viewer.scene.highDynamicRange = false;
  viewer.scene.fog.enabled = false;
  if (viewer.scene.sun) {
    viewer.scene.sun.show = false;
  }
  if (viewer.scene.moon) {
    viewer.scene.moon.show = false;
  }

  state.generation += 1;
  if (oldViewer) {
    state.recreationHistory.push({
      fromGeneration: state.generation - 1,
      toGeneration: state.generation,
      oldViewerDestroyed: oldViewer.isDestroyed(),
      canvasReplaced: oldCanvas !== viewer.scene.canvas,
      contextReplaced: oldContext !== viewer.scene.context,
      oldCanvasDisconnected: oldCanvas?.isConnected === false,
    });
  }
  await settleFrames(4);
  state.status = "READY";
  return getEvidence();
}

async function recreateViewer() {
  state.status = "RECREATING";
  return createViewer();
}

async function loadTopology(key) {
  const topology = topologies[key];
  if (!topology) {
    throw new Error(`STRUCTURAL: unknown topology ${key}`);
  }
  state.status = "LOADING_MODEL";
  globalThis.__c1190RuntimeGate?.resetObservations?.();
  if (model) {
    viewer.scene.primitives.remove(model);
    model = undefined;
  }

  const origin = Cesium.Cartesian3.fromDegrees(-75.152408, 39.946975, 50.0);
  const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(
    origin,
    Cesium.HeadingPitchRoll.ZERO,
  );
  model = viewer.scene.primitives.add(
    await Cesium.Model.fromGltfAsync({
      url: topology.url,
      modelMatrix,
      shadows: Cesium.ShadowMode.DISABLED,
      incrementallyLoadTextures: false,
    }),
  );
  model.color = Cesium.Color.WHITE;
  model.colorBlendMode = Cesium.ColorBlendMode.REPLACE;
  model.colorBlendAmount = 1.0;
  await waitForModelReady(model);

  const radius = Math.max(model.boundingSphere.radius, 1.0);
  viewer.camera.lookAt(
    model.boundingSphere.center,
    new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(-90.0),
      0.0,
      radius * 2.25,
    ),
  );
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  state.activeTopology = key;
  await settleFrames(12);
  state.status = "READY";
  return getEvidence();
}

globalThis.__c1190Harness = {
  state,
  recreateViewer,
  loadTopology,
  getEvidence,
};

async function boot() {
  try {
    requireRenderer();
    await createViewer();
  } catch (error) {
    state.status = "ERROR";
    state.errors.push(textOf(error));
  }
}

await boot();
