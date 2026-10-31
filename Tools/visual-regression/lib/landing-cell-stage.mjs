/**
 * Stages any landing-cell rig on a CesiumViewer page, on either renderer: its
 * clock, its camera and every dial it declares, each read back.
 * @purpose Stage piece for the landing program's Edge cells: turns a rig into a JSON-safe payload (Node side, refusing a dial it does not know before a browser is involved), and applies it in the page on WebGL or WebGPU - pinned clock, camera (or the page's own), scene and globe dials (including the globe material), the water flags and the water tier, clouds on or off - reading every dial back as {requested, observed, applied}, with the cloud* dials handed to the cloud probe harness so their round trip stays in one place; plus the ocean's pinned wave epoch, the opt-in FFT ocean (read back by its primitive), the globe's own show flag, the SSR scene switches, the WebGPU render pipeline cache's pending count, and an opt-in wait that drives frames until no pipeline is pending; plus the scene mode (3D, 2D, Columbus view, morphed with duration 0 and read back) and the FFT ocean's inverse-FFT kernel (stockham or pingpong, read back on the facade and on the primitive); plus the WebGPU globe's fragment-debug mode (its names in lib/globe-fragment-debug-dial.mjs), set before the first frame and read back against the registry.
 * @status ACTIVE
 *
 * WHY A NEW STAGE AND NOT `lib/cloud-rig-stage.mjs`. The landing cells span a
 * saved view on both renderers (E-D, E-D-HDR), cloud scenes (E-O, E-F, E-G),
 * a clouds-off sky (R-14) and a water scene on both renderers (E-T). The cloud
 * stage requires WebGPU (`requireWebGPU: true`), always turns the volumetric
 * collection on, needs a camera, applies five show dials and refuses the rest,
 * and reads its frame from the canvas in the task of the last render; changing
 * any of that would move the W-series cloud gates that stand on it. The globe
 * stages (`lib/globe-clip-scene.mjs`, `lib/cloud-march-mechanism.mjs`'s
 * `pageBuildScene`) each apply their own family's dials and black the scene
 * out. None applies a rig as declared on both renderers and says, per dial,
 * whether the tree under test took it. That is this piece; the overlap with
 * the three is named here and belongs to the kit's capture-stager work
 * (`NEW-CAPTURE-DOES-NOT-STAGE-THE-RIG`), not to a landing cell.
 *
 * READ BACK, NOT REFUSED, IN THE PAGE. A dial this module knows is applied when
 * its target property exists and re-read afterwards: `applied` is true only
 * when the target exists and the value read back equals the one requested.
 * A tree without the property (the water flags at a base before the water
 * batch) reads `applied: false` with the reason, and the cell still runs: that
 * is how a BEFORE arm answers for a feature it does not have. A dial this
 * module does NOT know is refused in Node (`rig-dial-unsupported`), because
 * that is a rig the probe cannot stage, not a tree that lacks a feature.
 *
 * CLOUDS. Every `cloud[A-Z]...` dial goes to `__cloudProbe.configure` (the
 * page needs `installCloudProbeHarness` as an init script), which throws on a
 * key `CloudVolumetrics` lacks and on a value that did not round-trip; this
 * module records that answer. `cloudsEnabled` sets the collection's
 * `enableVolumetric`; a rig with `cloud*` dials and no `cloudsEnabled` turns
 * the collection on, as the cloud stage does.
 *
 * THE RENDER LOOP IS STOPPED. The viewer's own loop is switched off and
 * `scene.requestRenderMode` cleared, so the probe's frames are the only frames:
 * the settle, the startup timeline and the performance windows all render
 * explicitly at the pinned clock. A rig's `useDefaultRenderLoop` dial is
 * recorded but cannot turn the loop back on.
 *
 * GLOBE MATERIAL. `globeMaterial` sets `globe.material` to a built-in
 * material type (`"WaterMask"`) or clears it (`"none"`), read back as the
 * material's type: the dial that makes a material reading the tile water
 * mask (`materialInput.waterMask`) the picture, with `globeShowWaterEffect`
 * off so the water effect does not paint over it.
 *
 * STEP DIALS. `resizeLadder`, `settleFramesPerStep`, `swaps`, `clockSteps` and
 * `tierSwitch` belong to step pieces (`lib/globe-resize-steps.mjs`,
 * `lib/skybox-swap-steps.mjs`, `lib/clock-steps.mjs`,
 * `lib/device-loss-steps.mjs`); this module passes over them.
 *
 * THE WAVE EPOCH (round 5, K5-1). `waterSimulationEpoch` is an ISO-8601 UTC
 * instant (the rig clock's form; anything else is refused in Node) applied as
 * `scene.globe.water.ocean.simulationEpoch`, a JulianDate, by the stage, i.e.
 * before the probe renders its first frame, so every timed frame and capture
 * shows the sea of that epoch at the pinned clock. It reads back as the ISO
 * instant observed; a tree without the property reads `applied: false` (a
 * water dial, so that is an answer, not a NOT RUN).
 *
 * THE FFT OCEAN (DX-KIT-WATER-OCEAN-DIAL). `waterOceanEnabled` (a boolean;
 * anything else is refused in Node) sets `scene.globe.water.ocean.enabled`,
 * the product's own switch for the opt-in spectral ocean
 * (`Scene/GlobeWaterOcean.js`), whose setter creates one
 * `OceanSurfacePrimitive` and adds it to `scene.primitives` when turned on and
 * removes it when turned off. The dial reads back the flag and
 * `ocean.primitive`: it is applied only when the flag reads the value asked
 * for AND a primitive exists exactly when the ocean is on, so a facade that
 * keeps the flag but builds nothing reads applied: false. The primitive draws
 * on WebGPU only; on WebGL the dial still applies and the leg shows no FFT
 * sea. A tree without `water.ocean.enabled` reads applied: false (a water
 * dial: an answer, not a NOT RUN).
 *
 * THE IFFT KERNEL. `waterOceanIfftKernel` (`"stockham"` or `"pingpong"`;
 * anything else is refused in Node, because the facade silently ignores any
 * other value and a dial that reads back unchanged would look applied) sets
 * `scene.globe.water.ocean.ifftKernel`, which forwards to the primitive's
 * own `ifftKernel` (`Scene/GlobeWaterOcean.js`, `OceanSurfacePrimitive.js`).
 * It is applied after every other water dial whatever the rig's key order, so
 * `waterOceanEnabled` has already built the primitive: the dial reads back
 * the facade and `primitiveKernel`, and is applied only when both read the
 * value and a primitive exists. The kernel-identity check compares the two
 * kernels' output and needs this dial to say which one a leg ran.
 *
 * THE SCENE MODE. `sceneMode` (`"SCENE3D"`, `"SCENE2D"` or
 * `"COLUMBUS_VIEW"`) calls the matching `scene.morphTo*(0)`; a morph of
 * duration 0 completes synchronously, so `scene.mode` is read back at once
 * and compared with `SceneMode[value]` (reported by name). A morph that
 * throws or leaves the mode unchanged reads applied: false, and the scene dial
 * is blocking. The camera is placed after the mode, in the mode it landed in.
 *
 * THE GLOBE FRAGMENT DEBUG MODE. `globeFragmentDebug` (a mode name from
 * `lib/globe-fragment-debug-dial.mjs`, or `"none"`; anything else is refused
 * in Node) sets `globalThis._webgpuGlobeDebugMode`, the global the WebGPU globe
 * tile packer turns into a shader sentinel every frame, before the stage
 * returns, so every settle frame draws the one term. It reads the global back
 * and requires the mode in `__webgpuGlobeFragmentDebugRegistry`; an absent
 * registry (a pragma-stripped build) reads applied: false and blocks the cell,
 * because the page would silently draw the plain frame. On WebGL the globe has
 * no such registry: the dial reads applied: true, observed `not-applicable`,
 * and the page captures the plain frame (the reference of a cross-renderer
 * pair).
 *
 * PENDING PIPELINES (round 5, K5-2). A WebGPU page can draw nothing while the
 * pipelines a pass needs are still compiling, and a capture taken then
 * measures the compile, not the scene. `readPendingPipelines` reads the render
 * pipeline cache's pending count the page already exposes; the opt-in
 * `waitForPendingPipelines` stage option drives frames until it reads 0.
 *
 * @module Tools/visual-regression/lib/landing-cell-stage
 */

import { isGlobeFragmentDebugValue } from "./globe-fragment-debug-dial.mjs";
import { ProbeRefusal } from "./probe-refusal.mjs";

/** Where the page imports the Cesium namespace from. */
export const LANDING_STAGE_MODULE_URL = "/Build/CesiumUnminified/index.js";

/** Dials this module applies on the scene. */
export const LANDING_SCENE_DIALS = Object.freeze([
  "highDynamicRange",
  "msaaSamples",
  "skyBoxShow",
  "skyAtmosphereShow",
  "skyAtmosphereMultipleScattering",
  "sunShow",
  "moonShow",
  "backgroundColor",
  "useDefaultRenderLoop",
  "pinClock",
  "cameraInputs",
  "enableSSR",
  "deferredLighting",
  "ssrReflectionStrength",
  "sceneMode",
]);

/** Dials this module applies on the globe and its imagery and terrain. */
export const LANDING_GLOBE_DIALS = Object.freeze([
  "globeEnableLighting",
  "globeShow",
  "globeBaseColor",
  "globeShowWaterEffect",
  "showGroundAtmosphere",
  "removeImageryLayers",
  "imagery",
  "terrain",
  "globeMaterial",
  "globeFragmentDebug",
]);

/**
 * Dials this module applies on the water (globe flags, the water tier and the
 * ocean's pinned wave epoch).
 */
export const LANDING_WATER_DIALS = Object.freeze([
  "globalWaterMask",
  "lakeWaterMask",
  "riverWaterMask",
  "enableEnhancedOcean",
  "waterQualityPreset",
  "waterSimulationEpoch",
  "waterOceanEnabled",
  "waterOceanIfftKernel",
]);

/** The instant form `waterSimulationEpoch` takes (the rig clock's form). */
export const WATER_SIMULATION_EPOCH_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * The defaults of the `waitForPendingPipelines` stage option (round 5, K5-2):
 * give up after `deadlineMs` of page time or `maxFrames` frames, and call the
 * cache drained only after `settleReads` consecutive reads of 0 pending with at
 * least one frame rendered (a cache that has not been asked for a pipeline yet
 * also reads 0).
 */
export const PIPELINE_WAIT_DEFAULTS = Object.freeze({
  deadlineMs: 60_000,
  maxFrames: 3600,
  settleReads: 3,
});

/** Dials step pieces consume; the stage passes over them. */
export const LANDING_STEP_DIALS = Object.freeze([
  "resizeLadder",
  "settleFramesPerStep",
  "swaps",
  "clockSteps",
  "tierSwitch",
]);

/** The values `imagery` and `terrain` accept. */
export const LANDING_IMAGERY_VALUES = Object.freeze(["naturalEarth", "none"]);
export const LANDING_TERRAIN_VALUES = Object.freeze(["ellipsoid"]);
/** The values `globeMaterial` accepts: a built-in material type, or none. */
export const LANDING_GLOBE_MATERIAL_VALUES = Object.freeze([
  "WaterMask",
  "none",
]);

/** The values `waterOceanIfftKernel` accepts: the facade's own two kernels. */
export const LANDING_IFFT_KERNEL_VALUES = Object.freeze([
  "stockham",
  "pingpong",
]);
/** The values `sceneMode` accepts: `SceneMode` names the dial can morph to. */
export const LANDING_SCENE_MODE_VALUES = Object.freeze([
  "SCENE3D",
  "SCENE2D",
  "COLUMBUS_VIEW",
]);

const CLOUD_DIAL_RE = /^cloud[A-Z]/;

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

/**
 * The payload `stageLandingCellInPage` takes. Pure; JSON-safe.
 *
 * @param {object} rig A rig record.
 * @returns {{rigId: string, moduleUrl: string, camera: object|null,
 *   clock: string|null, scene: object, globe: object, water: object,
 *   volumetric: object, cloudsEnabled: boolean|null, needsCloudHarness: boolean,
 *   stepDials: string[]}}
 * @throws {ProbeRefusal} `rig-dial-unsupported` for a dial no list above names
 *   and that is not a `cloud*` property, or an `imagery` / `terrain` /
 *   `globeMaterial` value the stage cannot build.
 * @throws {TypeError} For a camera that is neither null nor the degrees form
 *   with finite lon, lat and height.
 */
export function landingStagePayload(rig) {
  const id = rig?.id ?? "(unnamed)";
  let camera = null;
  if (rig?.camera !== null && rig?.camera !== undefined) {
    camera = { heading: 0, pitch: 0, roll: 0, ...rig.camera };
    for (const key of ["lon", "lat", "height", "heading", "pitch", "roll"]) {
      if (!isFiniteNumber(camera[key])) {
        throw new TypeError(
          `rig ${id}: the landing stage needs a finite camera.${key} (or camera: null), got ${String(camera[key])}`,
        );
      }
    }
  }
  const scene = {};
  const globe = {};
  const water = {};
  const volumetric = {};
  let cloudsEnabled = null;
  const stepDials = [];
  const unsupported = [];
  for (const [key, value] of Object.entries(rig?.dials ?? {})) {
    if (LANDING_SCENE_DIALS.includes(key)) {
      scene[key] = value;
    } else if (LANDING_GLOBE_DIALS.includes(key)) {
      globe[key] = value;
    } else if (LANDING_WATER_DIALS.includes(key)) {
      water[key] = value;
    } else if (LANDING_STEP_DIALS.includes(key)) {
      stepDials.push(key);
    } else if (key === "cloudsEnabled") {
      if (typeof value !== "boolean") {
        unsupported.push(`${key}=${JSON.stringify(value)}`);
      }
      cloudsEnabled = value;
    } else if (CLOUD_DIAL_RE.test(key)) {
      volumetric[key] = value;
    } else {
      unsupported.push(key);
    }
  }
  if (
    globe.imagery !== undefined &&
    !LANDING_IMAGERY_VALUES.includes(globe.imagery)
  ) {
    unsupported.push(`imagery=${JSON.stringify(globe.imagery)}`);
  }
  if (
    globe.terrain !== undefined &&
    !LANDING_TERRAIN_VALUES.includes(globe.terrain)
  ) {
    unsupported.push(`terrain=${JSON.stringify(globe.terrain)}`);
  }
  if (
    globe.globeMaterial !== undefined &&
    !LANDING_GLOBE_MATERIAL_VALUES.includes(globe.globeMaterial)
  ) {
    unsupported.push(`globeMaterial=${JSON.stringify(globe.globeMaterial)}`);
  }
  if (
    globe.globeFragmentDebug !== undefined &&
    !isGlobeFragmentDebugValue(globe.globeFragmentDebug)
  ) {
    unsupported.push(
      `globeFragmentDebug=${JSON.stringify(globe.globeFragmentDebug)}`,
    );
  }
  if (
    water.waterSimulationEpoch !== undefined &&
    !(
      typeof water.waterSimulationEpoch === "string" &&
      WATER_SIMULATION_EPOCH_RE.test(water.waterSimulationEpoch)
    )
  ) {
    unsupported.push(
      `waterSimulationEpoch=${JSON.stringify(water.waterSimulationEpoch)}`,
    );
  }
  if (
    water.waterOceanEnabled !== undefined &&
    typeof water.waterOceanEnabled !== "boolean"
  ) {
    unsupported.push(
      `waterOceanEnabled=${JSON.stringify(water.waterOceanEnabled)}`,
    );
  }
  if (
    water.waterOceanIfftKernel !== undefined &&
    !LANDING_IFFT_KERNEL_VALUES.includes(water.waterOceanIfftKernel)
  ) {
    unsupported.push(
      `waterOceanIfftKernel=${JSON.stringify(water.waterOceanIfftKernel)}`,
    );
  }
  if (
    scene.sceneMode !== undefined &&
    !LANDING_SCENE_MODE_VALUES.includes(scene.sceneMode)
  ) {
    unsupported.push(`sceneMode=${JSON.stringify(scene.sceneMode)}`);
  }
  if (unsupported.length > 0) {
    throw new ProbeRefusal(
      "rig-dial-unsupported",
      `rig ${id}: the landing stage cannot apply ${unsupported.join(", ")}`,
      { rigId: id, unsupported },
    );
  }
  const needsCloudHarness =
    Object.keys(volumetric).length > 0 || cloudsEnabled !== null;
  return {
    rigId: id,
    moduleUrl: LANDING_STAGE_MODULE_URL,
    camera,
    clock: rig?.clock ?? null,
    scene,
    globe,
    water,
    volumetric,
    cloudsEnabled:
      cloudsEnabled ?? (Object.keys(volumetric).length > 0 ? true : null),
    needsCloudHarness,
    stepDials,
  };
}

/**
 * PAGE SIDE. Apply a payload to `window.viewer`. Self-contained.
 *
 * @param {object} payload From {@link landingStagePayload}.
 * @returns {Promise<{rigId: string, rendererType: string, clock: object,
 *   camera: object, dials: Record<string, {requested: unknown,
 *   observed: unknown, applied: boolean, reason?: string}>,
 *   notApplied: string[], cloud: object|null}>}
 */
export async function stageLandingCellInPage(payload) {
  const C = await import(payload.moduleUrl);
  const root = /** @type {any} */ (globalThis);
  const viewer = root.viewer;
  const scene = viewer.scene;
  const globe = scene.globe;
  const context = scene.context;
  const rendererType = String(
    (context && context.rendererType) ||
      (context && context.isWebGPU ? "webgpu" : "webgl"),
  ).toLowerCase();
  const dials = {};
  const note = (key, requested, observed, applied, reason) => {
    dials[key] = { requested, observed, applied };
    if (reason) {
      dials[key].reason = reason;
    }
  };
  const same = (a, b) => Object.is(a, b);
  // Assign `value` to `target[property]` when the property exists, and read it
  // back. `property in target` covers accessors on the prototype.
  const assign = (key, target, property, value, read = (v) => v) => {
    if (!target || !(property in target)) {
      note(key, value, undefined, false, `${property} is not a property here`);
      return;
    }
    try {
      target[property] = value;
    } catch (error) {
      note(
        key,
        value,
        read(target[property]),
        false,
        `assignment threw: ${String(error && error.message ? error.message : error)}`,
      );
      return;
    }
    const observed = read(target[property]);
    note(key, value, observed, same(observed, value));
  };
  const cssOf = (color) =>
    color && typeof color.toCssColorString === "function"
      ? color.toCssColorString()
      : null;

  // The probe renders every frame; nothing else may.
  const loopWas = viewer.useDefaultRenderLoop;
  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;

  // The clock: always frozen, set when the rig names an instant.
  viewer.clock.shouldAnimate = false;
  if (payload.clock !== null) {
    viewer.clock.currentTime = C.JulianDate.fromIso8601(payload.clock);
  }
  const clock = {
    requested: payload.clock,
    observed: C.JulianDate.toIso8601(viewer.clock.currentTime, 0),
    frozen: viewer.clock.shouldAnimate === false,
  };

  // Scene dials.
  const s = payload.scene;
  for (const [key, value] of Object.entries(s)) {
    if (key === "highDynamicRange") {
      assign(key, scene, "highDynamicRange", value);
    } else if (key === "msaaSamples") {
      assign(key, scene, "msaaSamples", value);
    } else if (key === "skyBoxShow") {
      assign(key, scene.skyBox, "show", value);
    } else if (key === "skyAtmosphereShow") {
      assign(key, scene.skyAtmosphere, "show", value);
    } else if (key === "skyAtmosphereMultipleScattering") {
      assign(key, scene.skyAtmosphere, "multipleScattering", value);
    } else if (key === "sunShow") {
      assign(key, scene.sun, "show", value);
    } else if (key === "moonShow") {
      assign(key, scene.moon, "show", value);
    } else if (key === "backgroundColor") {
      scene.backgroundColor = C.Color.fromCssColorString(value);
      const observed = cssOf(scene.backgroundColor);
      note(
        key,
        value,
        observed,
        C.Color.fromCssColorString(value).equals(scene.backgroundColor),
      );
    } else if (key === "useDefaultRenderLoop") {
      note(
        key,
        value,
        viewer.useDefaultRenderLoop,
        value === false,
        value === false
          ? undefined
          : "the landing stage keeps the viewer's own loop off",
      );
    } else if (key === "pinClock") {
      note(key, value, clock.frozen, value !== true || clock.frozen);
    } else if (key === "cameraInputs") {
      assign(key, scene.screenSpaceCameraController, "enableInputs", value);
    } else if (key === "enableSSR") {
      assign(key, scene, "enableSSR", value);
    } else if (key === "deferredLighting") {
      assign(key, scene, "deferredLighting", value);
    } else if (key === "sceneMode") {
      // Morph with duration 0 (synchronous), then read the mode back by name.
      const morph = {
        SCENE3D: "morphTo3D",
        SCENE2D: "morphTo2D",
        COLUMBUS_VIEW: "morphToColumbusView",
      }[value];
      const modes = C.SceneMode;
      const nameOf = (mode) => {
        const hit =
          modes &&
          Object.keys(modes).find(
            (name) => typeof modes[name] === "number" && modes[name] === mode,
          );
        return hit === undefined ? mode : hit;
      };
      try {
        scene[morph](0);
        note(
          key,
          value,
          nameOf(scene.mode),
          !!modes && same(scene.mode, modes[value]),
          modes ? undefined : "the Cesium build exports no SceneMode",
        );
      } catch (error) {
        note(
          key,
          value,
          nameOf(scene.mode),
          false,
          `scene mode morph failed: ${String(error && error.message ? error.message : error)}`,
        );
      }
    } else if (key === "ssrReflectionStrength") {
      // Scene declares no such property: the WebGPU SSR effect reads
      // `scene.ssrReflectionStrength ?? 0.5` (WebGPUSSREffect.ts), so the
      // dial sets the field it reads and reads it back.
      scene.ssrReflectionStrength = value;
      note(
        key,
        value,
        scene.ssrReflectionStrength,
        same(scene.ssrReflectionStrength, value),
      );
    }
  }

  // Globe, imagery and terrain dials.
  const g = payload.globe;
  for (const [key, value] of Object.entries(g)) {
    if (key === "globeEnableLighting") {
      assign(key, globe, "enableLighting", value);
    } else if (key === "globeShow") {
      assign(key, globe, "show", value);
    } else if (key === "globeShowWaterEffect") {
      assign(key, globe, "showWaterEffect", value);
    } else if (key === "showGroundAtmosphere") {
      assign(key, globe, "showGroundAtmosphere", value);
    } else if (key === "globeBaseColor") {
      if (value !== null) {
        globe.baseColor = C.Color.fromCssColorString(value);
      }
      note(
        key,
        value,
        cssOf(globe.baseColor),
        value === null ||
          C.Color.fromCssColorString(value).equals(globe.baseColor),
      );
    } else if (key === "removeImageryLayers") {
      if (value === true) {
        scene.imageryLayers.removeAll(false);
      }
      note(
        key,
        value,
        scene.imageryLayers.length,
        value !== true || scene.imageryLayers.length === 0,
      );
    } else if (key === "imagery") {
      scene.imageryLayers.removeAll(false);
      if (value === "none") {
        note(
          key,
          value,
          scene.imageryLayers.length,
          scene.imageryLayers.length === 0,
        );
        continue;
      }
      try {
        const provider = await C.TileMapServiceImageryProvider.fromUrl(
          "/Build/CesiumUnminified/Assets/Textures/NaturalEarthII",
        );
        scene.imageryLayers.addImageryProvider(provider);
        note(
          key,
          value,
          scene.imageryLayers.length,
          scene.imageryLayers.length === 1,
        );
      } catch (error) {
        note(
          key,
          value,
          scene.imageryLayers.length,
          false,
          `imagery failed to load: ${String(error && error.message ? error.message : error)}`,
        );
      }
    } else if (key === "globeMaterial") {
      try {
        globe.material =
          value === "none" ? undefined : C.Material.fromType(value);
        const observed = globe.material ? globe.material.type : "none";
        note(key, value, observed, observed === value);
      } catch (error) {
        note(
          key,
          value,
          globe.material ? globe.material.type : "none",
          false,
          `globe material failed to build: ${String(error && error.message ? error.message : error)}`,
        );
      }
    } else if (key === "globeFragmentDebug") {
      // Set on both renderers (harmless on WebGL), then read back.
      const mode = value === "none" ? null : value;
      root._webgpuGlobeDebugMode = mode;
      const registry = root.__webgpuGlobeFragmentDebugRegistry;
      const hasRegistry = Array.isArray(registry);
      const listed =
        mode === null || (hasRegistry && registry.some((m) => m.name === mode));
      const observed = root._webgpuGlobeDebugMode ?? "none";
      if (rendererType !== "webgpu") {
        note(
          key,
          value,
          "not-applicable",
          true,
          "the WebGL globe has no fragment-debug registry; the page captures the plain frame",
        );
      } else {
        note(
          key,
          value,
          observed,
          observed === value && listed,
          !hasRegistry && mode !== null
            ? "the fragment-debug registry is absent (a pragma-stripped build)"
            : !listed
              ? `${value} is not in the fragment-debug registry`
              : undefined,
        );
      }
    } else if (key === "terrain") {
      globe.terrainProvider = new C.EllipsoidTerrainProvider();
      const observed =
        globe.terrainProvider && globe.terrainProvider.constructor
          ? globe.terrainProvider.constructor.name
          : null;
      note(
        key,
        value,
        observed,
        globe.terrainProvider instanceof C.EllipsoidTerrainProvider,
      );
    }
  }

  // Water dials: globe flags, and the tier on the water facade.
  // The kernel dial goes last whatever the rig's key order: it reads the
  // primitive `waterOceanEnabled` creates.
  const w = payload.water;
  const waterEntries = Object.entries(w).sort(
    ([a], [b]) =>
      (a === "waterOceanIfftKernel") - (b === "waterOceanIfftKernel"),
  );
  for (const [key, value] of waterEntries) {
    if (key === "waterQualityPreset") {
      assign(key, globe.water, "qualityPreset", value, (v) =>
        typeof v === "string" ? v.toUpperCase() : v,
      );
    } else if (key === "waterSimulationEpoch") {
      // K5-1. The ocean's wave epoch, pinned before the probe renders any
      // frame, read back as an ISO instant. Both sides go through the page's
      // own JulianDate round trip, so the comparison is instant equality, not
      // string formatting. The ocean facade is created on access; a tree with
      // no `water.ocean.simulationEpoch` reads applied: false.
      const water = globe && globe.water;
      const ocean = water && "ocean" in water ? water.ocean : undefined;
      const isoOf = (v) =>
        v && typeof v === "object" ? C.JulianDate.toIso8601(v) : v;
      const canonical = C.JulianDate.toIso8601(C.JulianDate.fromIso8601(value));
      assign(
        key,
        ocean,
        "simulationEpoch",
        C.JulianDate.fromIso8601(value),
        isoOf,
      );
      const entry = dials[key];
      entry.requested = value;
      if (entry.observed !== undefined && entry.reason === undefined) {
        entry.applied = entry.observed === canonical;
      }
    } else if (key === "waterOceanEnabled") {
      // DX-KIT-WATER-OCEAN-DIAL. The product's switch for the FFT ocean; the
      // facade creates or removes its primitive in the setter, so the
      // primitive is read straight back.
      const water = globe && globe.water;
      const ocean = water && "ocean" in water ? water.ocean : undefined;
      assign(key, ocean, "enabled", value);
      const entry = dials[key];
      if (entry.reason === undefined) {
        const primitive = ocean.primitive;
        const hasPrimitive = primitive !== undefined && primitive !== null;
        entry.primitive = hasPrimitive;
        if (hasPrimitive !== value) {
          entry.applied = false;
          entry.reason = value
            ? "ocean.enabled reads true but no ocean primitive exists"
            : "ocean.enabled reads false but an ocean primitive remains";
        }
      }
    } else if (key === "waterOceanIfftKernel") {
      // The facade forwards to the primitive; read both, and require a primitive.
      const water = globe && globe.water;
      const ocean = water && "ocean" in water ? water.ocean : undefined;
      assign(key, ocean, "ifftKernel", value);
      const entry = dials[key];
      if (entry.reason === undefined) {
        const primitive = ocean.primitive;
        const hasPrimitive = primitive !== undefined && primitive !== null;
        entry.primitiveKernel = hasPrimitive ? primitive.ifftKernel : undefined;
        if (!hasPrimitive) {
          entry.applied = false;
          entry.reason =
            "no ocean primitive exists to read the kernel from (turn waterOceanEnabled on)";
        } else if (!same(entry.primitiveKernel, value)) {
          entry.applied = false;
          entry.reason = `the ocean primitive reads kernel ${String(entry.primitiveKernel)}, not ${value}`;
        } else if (!entry.applied) {
          entry.reason = `the ocean facade reads kernel ${String(entry.observed)}, not ${value}`;
        }
      }
    } else {
      assign(key, globe, key, value);
    }
  }

  // Clouds, through the harness's round trip.
  let cloud = null;
  if (payload.needsCloudHarness) {
    const harness = root.__cloudProbe;
    const enable = payload.cloudsEnabled !== false;
    if (!harness || typeof harness.configure !== "function") {
      cloud = {
        ok: false,
        reason: "the cloud probe harness is not installed on this page",
      };
    } else {
      try {
        const truth = harness.configure({
          volumetric: payload.volumetric,
          enableVolumetric: enable,
          requireWebGPU: false,
        });
        cloud = { ok: truth && truth.ok === true, truth };
      } catch (error) {
        cloud = {
          ok: false,
          reason: String(error && error.message ? error.message : error),
        };
      }
      // The harness clears requestRenderMode; keep the probe's own loop rule.
      viewer.useDefaultRenderLoop = false;
    }
    const collection = globe && globe.defaultCloudCollection;
    note(
      "cloudsEnabled",
      enable,
      collection ? collection.enableVolumetric : undefined,
      !!collection && collection.enableVolumetric === enable && !!cloud.ok,
      cloud.ok ? undefined : cloud.reason,
    );
  }

  // The camera: the page's own view, or the rig's.
  const cameraRecord = { requested: payload.camera, applied: true };
  if (payload.camera !== null) {
    const cam = payload.camera;
    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(cam.lon, cam.lat, cam.height),
      orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll },
    });
    const carto = viewer.camera.positionCartographic;
    cameraRecord.observed = {
      lon: C.Math.toDegrees(carto.longitude),
      lat: C.Math.toDegrees(carto.latitude),
      height: carto.height,
    };
  }

  return {
    rigId: payload.rigId,
    rendererType,
    defaultRenderLoopWas: loopWas,
    clock,
    camera: cameraRecord,
    dials,
    notApplied: Object.keys(dials).filter((key) => dials[key].applied !== true),
    cloud,
  };
}

/**
 * PAGE SIDE. The render pipeline cache's pending count, read from the
 * renderer statistics `CesiumDebug.cacheStats()` reports (`pipelineCache`,
 * `detail: pending=`). Read through `context.getRendererStatistics()` rather
 * than `cacheStats()` itself, because `cacheStats()` prints a console table on
 * every call and the probe reads the page console for errors. Self-contained.
 *
 * @returns {{available: boolean, rendererType: string|null,
 *   pending: number|null, created: number|null, reason?: string}}
 */
export function pageReadPendingPipelines() {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const context = viewer && viewer.scene && viewer.scene.context;
  const rendererType = context
    ? String(
        context.rendererType || (context.isWebGPU ? "webgpu" : "webgl"),
      ).toLowerCase()
    : null;
  if (!context || !context.isWebGPU) {
    return {
      available: false,
      rendererType,
      pending: null,
      created: null,
      reason: "the render pipeline cache is WebGPU-only",
    };
  }
  if (typeof context.getRendererStatistics !== "function") {
    return {
      available: false,
      rendererType,
      pending: null,
      created: null,
      reason: "the context exposes no getRendererStatistics",
    };
  }
  try {
    const cache = context.getRendererStatistics().pipelineCache;
    const pending =
      cache && Number.isFinite(cache.pending) ? cache.pending : null;
    return {
      available: true,
      rendererType,
      pending,
      created: cache && Number.isFinite(cache.created) ? cache.created : null,
      ...(pending === null
        ? { reason: "no pipeline cache statistics yet (no frame rendered)" }
        : {}),
    };
  } catch (error) {
    return {
      available: false,
      rendererType,
      pending: null,
      created: null,
      reason: String(error && error.message ? error.message : error),
    };
  }
}

/**
 * PAGE SIDE (round 5, K5-2). Render frame by frame at the frozen clock until
 * the render pipeline cache has read 0 pending on `settleReads` consecutive
 * reads after at least one frame, or until `deadlineMs` / `maxFrames`. On a
 * page without the cache (WebGL) it renders nothing and says so. Self-contained
 * apart from its argument and the reader passed in as source text.
 *
 * @param {{deadlineMs: number, maxFrames: number, settleReads: number,
 *   readerSource: string}} args
 * @returns {Promise<{requested: true, available: boolean,
 *   pendingAtStart: number|null, pendingAtEnd: number|null,
 *   pendingMax: number|null, createdAtEnd: number|null, framesWaited: number,
 *   waitedMs: number, timedOut: boolean, reason?: string}>}
 */
export async function pageWaitForPendingPipelines({
  deadlineMs,
  maxFrames,
  settleReads,
  readerSource,
}) {
  // eslint-disable-next-line no-new-func
  const read = new Function(`return (${readerSource})();`);
  const viewer = /** @type {any} */ (globalThis).viewer;
  const started = performance.now();
  const first = read();
  const out = {
    requested: true,
    available: first.available,
    pendingAtStart: first.pending,
    pendingAtEnd: first.pending,
    pendingMax: first.pending,
    createdAtEnd: first.created,
    framesWaited: 0,
    waitedMs: 0,
    timedOut: false,
  };
  if (!first.available) {
    out.reason = first.reason;
    return out;
  }
  let zeroReads = 0;
  for (;;) {
    const now = read();
    out.pendingAtEnd = now.pending;
    out.createdAtEnd = now.created;
    if (now.pending !== null) {
      out.pendingMax = Math.max(out.pendingMax ?? 0, now.pending);
    }
    zeroReads = now.pending === 0 && out.framesWaited > 0 ? zeroReads + 1 : 0;
    if (zeroReads >= settleReads) {
      break;
    }
    if (
      out.framesWaited >= maxFrames ||
      performance.now() - started >= deadlineMs
    ) {
      out.timedOut = true;
      break;
    }
    viewer.scene.render(viewer.clock.currentTime);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    out.framesWaited++;
  }
  out.waitedMs = performance.now() - started;
  return out;
}

/**
 * NODE SIDE. The pending count now (see {@link pageReadPendingPipelines}).
 *
 * @param {{evaluate: Function}} page
 * @returns {Promise<object>}
 */
export function readPendingPipelines(page) {
  return page.evaluate(pageReadPendingPipelines);
}

/**
 * NODE SIDE. Build the payload and stage it on the page.
 *
 * With `waitForPendingPipelines` (round 5, K5-2; default off), after the dials
 * are applied the stage drives frames until the render pipeline cache reads 0
 * pending or the deadline ({@link pageWaitForPendingPipelines}) and returns the
 * record as `pipelines`; off, `pipelines` is null and no frame is rendered.
 * The wait renders frames, so a startup timeline read after it starts from a
 * page that has already drawn: compare such a run only with runs that waited
 * too.
 *
 * @param {{page: {evaluate: Function}, rig: object,
 *   waitForPendingPipelines?: boolean|object}} args `waitForPendingPipelines`
 *   true for {@link PIPELINE_WAIT_DEFAULTS}, or an object overriding them.
 * @returns {Promise<{payload: object, staged: object,
 *   pipelines: object|null}>}
 */
export async function stageLandingCell({
  page,
  rig,
  waitForPendingPipelines = false,
}) {
  const payload = landingStagePayload(rig);
  const staged = await page.evaluate(stageLandingCellInPage, payload);
  let pipelines = null;
  if (waitForPendingPipelines) {
    const options =
      typeof waitForPendingPipelines === "object"
        ? { ...PIPELINE_WAIT_DEFAULTS, ...waitForPendingPipelines }
        : { ...PIPELINE_WAIT_DEFAULTS };
    pipelines = await page.evaluate(pageWaitForPendingPipelines, {
      ...options,
      readerSource: pageReadPendingPipelines.toString(),
    });
  }
  return { payload, staged, pipelines };
}

/**
 * Every capture taken while the pipeline cache had pipelines pending (K5-2).
 * Pure.
 *
 * @param {object[]} pages
 * @returns {Array<{page: string, capture: string, pending: number}>}
 */
export function capturesWhilePipelinesPending(pages) {
  return (pages ?? []).flatMap((record) =>
    [record.captureStart, record.capture]
      .filter((shot) => shot?.pipelinesPending > 0)
      .map((shot) => ({
        page: `${record.cell}:${record.renderer}:${record.page}:run${record.run}`,
        capture: shot.name,
        pending: shot.pipelinesPending,
      })),
  );
}
