import * as Cesium from "cesium";

import {
  AVAILABLE_LEVELS,
  TILE,
  createVoxelOctreeL3Provider,
} from "./fixtures/voxel-octree-l3.mjs";

const renderer = new URLSearchParams(window.location.search).get("renderer");
const validRenderers = new Set(["webgl", "webgpu"]);
const EARTH_RADIUS = 6378137.0;
const PROBE_SCREEN_SPACE_ERROR = 1.0e12;
const COMMAND_FIRST_INDEX_OUTSIDE = 0;
const COMMAND_FIRST_INDEX_INSIDE = 36;

const WAYPOINTS = Object.freeze([
  Object.freeze({
    id: "outside-positive-initial",
    factor: 1.05,
    inside: false,
  }),
  Object.freeze({ id: "inside-positive-near", factor: 0.9, inside: true }),
  Object.freeze({ id: "inside-positive-deep", factor: 0.55, inside: true }),
  Object.freeze({ id: "inside-negative-deep", factor: -0.55, inside: true }),
  Object.freeze({ id: "inside-negative-near", factor: -0.9, inside: true }),
  Object.freeze({ id: "outside-negative", factor: -1.05, inside: false }),
  Object.freeze({ id: "outside-positive-return", factor: 1.05, inside: false }),
]);

const GLSL_FRAGMENT = `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
{
    material.diffuse = vec3(0.20, 0.80, 0.35);
    material.alpha = fsInput.metadata.color.a;
}`;

const WGSL_FRAGMENT = `fn czm_voxelCustomFragmentMain(
    fsInput: czm_voxelCustomFragmentInput,
    material: ptr<function, czm_voxelCustomMaterial>) {
  (*material).diffuse = vec3<f32>(0.20, 0.80, 0.35);
  (*material).alpha = fsInput.metadata.color.a;
}`;

const state = {
  status: "BOOTING",
  renderer,
  nextWaypointIndex: 0,
  history: [],
  errors: [],
  materializationFrames: 0,
};

let viewer;
let provider;
let primitive;

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

function nextEventTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderFrames(frameCount) {
  for (let frame = 0; frame < frameCount; frame += 1) {
    viewer.scene.render();
    await nextEventTurn();
  }
}

function commandEvidence(command) {
  if (!command) {
    return {
      present: false,
      firstIndex: null,
      indexCount: null,
      indexFormat: null,
      indexed: false,
    };
  }
  return {
    present: true,
    firstIndex: command.firstIndex ?? null,
    indexCount: command.indexCount ?? null,
    indexFormat: command.indexFormat ?? null,
    indexed: Boolean(command.indexBuffer),
  };
}

function collectWebGPUCommands() {
  if (renderer !== "webgpu") {
    return null;
  }
  const cache = primitive?._webgpuCache;
  const color = cache?.command;
  const objectPick = cache?.pickCommand;
  const cellPick = cache?.pickVoxelCommand;
  const velocity = color?.velocityCommand;
  const picking = color?.derivedCommands?.picking;
  const commands = {
    color: commandEvidence(color),
    objectPick: commandEvidence(objectPick),
    cellPick: commandEvidence(cellPick),
    velocity: commandEvidence(velocity),
  };
  return {
    commands,
    allMaterialized: Object.values(commands).every(
      (command) => command.present === true,
    ),
    objectPickAttached: picking?.pickCommand === objectPick,
    cellPickAttached: picking?.pickVoxelCommand === cellPick,
    velocityAttached: color?.velocityCommand === velocity && Boolean(velocity),
    usingRealData: cache?.usingRealData === true,
    uploadPhase: cache?.dataUpload?.phase ?? null,
    colorDescriptorName: cache?.colorDescriptor?.name ?? null,
    materializationFrames: state.materializationFrames,
  };
}

function collectAuthority() {
  const context = viewer?.scene?.context;
  const canvas = viewer?.scene?.canvas;
  const gl = context?._gl;
  const device = context?.device ?? context?._device;
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

function collectProviderEvidence() {
  return {
    fixture: "voxel-octree-l3",
    availableLevelsConstant: AVAILABLE_LEVELS,
    tileConstant: TILE,
    availableLevels: provider?.availableLevels ?? null,
    dimensions: provider?.dimensions
      ? [provider.dimensions.x, provider.dimensions.y, provider.dimensions.z]
      : null,
    names: provider?.names ? [...provider.names] : null,
    types: provider?.types ? [...provider.types] : null,
    componentTypes: provider?.componentTypes
      ? [...provider.componentTypes]
      : null,
    shape: provider?.shape ?? null,
    metadataOrder: provider?.metadataOrder ?? null,
    earthRadius: EARTH_RADIUS,
  };
}

function collectPrimitiveEvidence() {
  return {
    ready: primitive?.ready === true,
    show: primitive?.show === true,
    nearestSampling: primitive?.nearestSampling === true,
    screenSpaceError: primitive?.screenSpaceError ?? null,
    customShaderHasGlsl:
      primitive?.customShader?.fragmentShaderText === GLSL_FRAGMENT,
    customShaderHasWgsl:
      primitive?.customShader?.wgslFragmentShaderText === WGSL_FRAGMENT,
  };
}

function collectEvidence() {
  return {
    status: state.status,
    renderer,
    nextWaypointIndex: state.nextWaypointIndex,
    history: structuredClone(state.history),
    errors: [...state.errors],
    authority: viewer ? collectAuthority() : null,
    provider: collectProviderEvidence(),
    primitive: collectPrimitiveEvidence(),
    liveWebGPUCommands: collectWebGPUCommands(),
  };
}

function setDiagonalCamera(factor) {
  const scene = viewer.scene;
  const destination = new Cesium.Cartesian3(
    factor * EARTH_RADIUS,
    factor * EARTH_RADIUS,
    factor * EARTH_RADIUS,
  );
  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.negate(destination, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const right = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(
      direction,
      Cesium.Cartesian3.UNIT_Z,
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  );
  const up = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  viewer.camera.setView({
    destination,
    orientation: { direction, up },
  });
  if ("near" in viewer.camera.frustum) {
    viewer.camera.frustum.near = 1.0;
    viewer.camera.frustum.far = EARTH_RADIUS * 20.0;
  }
  scene.requestRender();
}

async function waitForPrimitiveReady() {
  for (let frame = 0; frame < 900; frame += 1) {
    await renderFrames(1);
    if (primitive?.ready === true) {
      return frame + 1;
    }
  }
  throw new Error(
    "STRUCTURAL: voxel primitive did not become ready in 900 frames",
  );
}

async function waitForWebGPUCommands() {
  if (renderer !== "webgpu") {
    return 0;
  }
  for (let frame = 0; frame < 900; frame += 1) {
    await renderFrames(1);
    state.materializationFrames += 1;
    if (collectWebGPUCommands()?.allMaterialized === true) {
      return frame + 1;
    }
  }
  throw new Error(
    "STRUCTURAL: WebGPU color/object-pick/cell-pick/velocity commands did not all materialize in 900 frames",
  );
}

async function prepareWaypoint(id) {
  const expected = WAYPOINTS[state.nextWaypointIndex];
  if (!expected || id !== expected.id) {
    throw new Error(
      `STRUCTURAL: waypoint order mismatch; expected ${expected?.id ?? "end"}, got ${id}`,
    );
  }
  state.status = "MOVING";
  setDiagonalCamera(expected.factor);

  // The velocity command is lazy and exists only while TAA demand is active.
  // Capture the four-command snapshot in that phase, then disable TAA before
  // the screenshot so repeated outside pixel bytes are deterministic.
  viewer.scene.taaEnabled = renderer === "webgpu";
  await renderFrames(12);
  await waitForWebGPUCommands();
  const commandSnapshot = collectWebGPUCommands();

  viewer.scene.taaEnabled = false;
  await renderFrames(16);
  const record = {
    id: expected.id,
    factor: expected.factor,
    inside: expected.inside,
    expectedFirstIndex: expected.inside
      ? COMMAND_FIRST_INDEX_INSIDE
      : COMMAND_FIRST_INDEX_OUTSIDE,
    cameraWorld: [
      viewer.camera.positionWC.x,
      viewer.camera.positionWC.y,
      viewer.camera.positionWC.z,
    ],
    cameraProxyExpected: [
      expected.factor * 0.5,
      expected.factor * 0.5,
      expected.factor * 0.5,
    ],
    commandSnapshot,
    taaEnabledForCommandSnapshot: renderer === "webgpu",
    taaEnabledForPixelCapture: viewer.scene.taaEnabled === true,
  };
  state.history.push(record);
  state.nextWaypointIndex += 1;
  state.status = "READY";
  return {
    ...collectEvidence(),
    waypoint: structuredClone(record),
  };
}

async function settlePixels(frameCount = 8) {
  if (state.history.length === 0) {
    throw new Error("STRUCTURAL: settlePixels called before a waypoint");
  }
  if (viewer.scene.taaEnabled === true) {
    throw new Error("STRUCTURAL: deterministic pixel capture requires TAA off");
  }
  await renderFrames(frameCount);
  return collectEvidence();
}

async function capturePixels(frameCount = 8) {
  if (state.history.length === 0) {
    throw new Error("STRUCTURAL: capturePixels called before a waypoint");
  }
  if (viewer.scene.taaEnabled === true) {
    throw new Error("STRUCTURAL: deterministic pixel capture requires TAA off");
  }
  if (!Number.isInteger(frameCount) || frameCount < 1) {
    throw new Error("STRUCTURAL: capturePixels requires at least one frame");
  }

  // Yield only while settling. The final render and immutable PNG snapshot
  // must stay in this same task: WebGL may clear a non-preserved drawing
  // buffer after compositing, and WebGPU invalidates the presented swap-chain
  // texture. Reading either canvas from a later Playwright task is undefined.
  await renderFrames(frameCount - 1);
  viewer.scene.render();
  const canvas = viewer.scene.canvas;
  const rectangle = canvas.getBoundingClientRect();
  let dataUrl;
  try {
    dataUrl = canvas.toDataURL("image/png");
  } catch (error) {
    throw new Error(
      `STRUCTURAL: same-task canvas capture failed: ${textOf(error)}`,
      { cause: error },
    );
  }
  const gl = viewer.scene.context?._gl;
  return {
    evidence: collectEvidence(),
    capture: {
      dataUrl,
      drawingBufferWidth: canvas.width,
      drawingBufferHeight: canvas.height,
      nativeDrawingBufferWidth: gl?.drawingBufferWidth ?? canvas.width,
      nativeDrawingBufferHeight: gl?.drawingBufferHeight ?? canvas.height,
      clip: {
        x: rectangle.left,
        y: rectangle.top,
        width: rectangle.width,
        height: rectangle.height,
      },
    },
  };
}

async function boot() {
  try {
    requireRenderer();
    viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
      contextOptions: { renderer, strictRenderer: true },
      useDefaultRenderLoop: false,
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
    const scene = viewer.scene;
    scene.backgroundColor = Cesium.Color.BLACK;
    scene.highDynamicRange = false;
    scene.fog.enabled = false;
    scene.requestRenderMode = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    viewer.clock.shouldAnimate = false;
    viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(
      "2024-01-01T00:00:00Z",
    );

    provider = createVoxelOctreeL3Provider(Cesium, EARTH_RADIUS);
    const customShader = new Cesium.CustomShader({
      fragmentShaderText: GLSL_FRAGMENT,
      wgslFragmentShaderText: WGSL_FRAGMENT,
    });
    primitive = scene.primitives.add(
      new Cesium.VoxelPrimitive({ provider, customShader }),
    );
    primitive.nearestSampling = true;
    primitive.screenSpaceError = PROBE_SCREEN_SPACE_ERROR;
    primitive.customShaderCompilationEvent.addEventListener((error) => {
      state.errors.push(textOf(error));
    });

    setDiagonalCamera(WAYPOINTS[0].factor);
    await waitForPrimitiveReady();
    await renderFrames(12);
    state.status = "READY";
  } catch (error) {
    state.status = "ERROR";
    state.errors.push(textOf(error));
  }
}

globalThis.__c1113VoxelInsideHarness = {
  state,
  waypoints: WAYPOINTS,
  prepareWaypoint,
  capturePixels,
  settlePixels,
  getEvidence: collectEvidence,
};

await boot();
