// gsplat-multifrustum-framing.mjs — C15-G6 tower/globe topology precondition.
// @purpose Pure far-nadir camera planning and real-PVS multi-frustum anti-vacuity/control logic for the Gaussian-splat parity probe's C15-G6 lane.
// @status ACTIVE
//
// This module does not score occlusion pixels.  It proves the topology that
// gives such a number standing, then (and only then) invokes the caller's lazy
// occlusion reader.  The split is intentional: B889's bounding-volume repair
// reduced the old scene to one frustum, so code that read the pixel number
// first could certify a branch the renderer never reached.

export const GSPLAT_MULTIFRUSTUM_SCHEMA =
  "cesium.c15-g6.gsplat-multifrustum-framing.v1";

export const GSPLAT_MULTIFRUSTUM_CONFIG = Object.freeze({
  assetUrl: "/Specs/Data/Cesium3DTiles/GaussianSplats/tower/tileset.json",
  headingRadians: 0,
  pitchRadians: -Math.PI / 2,
  towerViewportHeightFraction: 0.1,
  logarithmicDepthFarToNearRatio: 2,
  minimumActiveFrusta: 2,
});

/**
 * Camera range that makes a sphere radius occupy the requested fraction of
 * viewport height at a vertical field of view.  This is a runtime geometric
 * derivation, not a hand-tuned distance for one machine's viewport.
 */
export function deriveFarNadirRange(
  radius,
  fovyRadians,
  viewportHeightFraction = GSPLAT_MULTIFRUSTUM_CONFIG.towerViewportHeightFraction,
) {
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new RangeError("tower radius must be finite and positive");
  }
  if (
    !Number.isFinite(fovyRadians) ||
    fovyRadians <= 0 ||
    fovyRadians >= Math.PI
  ) {
    throw new RangeError("vertical field of view must be in (0, pi)");
  }
  if (
    !Number.isFinite(viewportHeightFraction) ||
    viewportHeightFraction <= 0 ||
    viewportHeightFraction >= 1
  ) {
    throw new RangeError("tower viewport fraction must be in (0, 1)");
  }
  const angularRadius = Math.atan(
    viewportHeightFraction * Math.tan(fovyRadians / 2),
  );
  return radius / Math.sin(angularRadius);
}

/** Serializable camera/config plan consumed inside `probe-gsplat-parity`. */
export function createGsplatMultifrustumPlan(options) {
  const radius = options?.radius;
  const fovyRadians = options?.fovyRadians;
  const viewportHeightFraction =
    options?.viewportHeightFraction ??
    GSPLAT_MULTIFRUSTUM_CONFIG.towerViewportHeightFraction;
  return Object.freeze({
    headingRadians: GSPLAT_MULTIFRUSTUM_CONFIG.headingRadians,
    pitchRadians: GSPLAT_MULTIFRUSTUM_CONFIG.pitchRadians,
    range: deriveFarNadirRange(radius, fovyRadians, viewportHeightFraction),
    viewportHeightFraction,
    logarithmicDepthFarToNearRatio:
      GSPLAT_MULTIFRUSTUM_CONFIG.logarithmicDepthFarToNearRatio,
  });
}

/**
 * Serialize only the production band fields the G6 standing test needs.
 * This function is browser-free but accepts the live `FrustumCommands` shape,
 * so a probe can execute the same code in its page before returning evidence.
 */
export function summarizeGsplatFrustumBands(
  frustumCommandsList,
  globePass,
  gaussianSplatPass,
) {
  if (!Array.isArray(frustumCommandsList)) return [];
  return frustumCommandsList.map((band, index) => ({
    index,
    near: band?.near ?? band?.frustum?.near,
    far: band?.far ?? band?.frustum?.far,
    globeIndex: band?.indices?.[globePass],
    splatIndex: band?.indices?.[gaussianSplatPass],
  }));
}

/**
 * Diagnostic negative-control acquisition against the REAL View PVS method.
 *
 * Call only after a settled normal render.  The function never renders the
 * BV-less command: it snapshots clean bins, suppresses every current-frame
 * splat command's BV, invokes the bound production PVS method, snapshots the
 * resulting indices, and restores both BVs and clean PVS bins in `finally`.
 */
export function acquireGsplatBoundingVolumeControl(
  scene,
  globePass,
  gaussianSplatPass,
) {
  const view = scene?._view;
  const frameState = scene?.frameState;
  if (
    !view ||
    typeof view.createPotentiallyVisibleSet !== "function" ||
    !Array.isArray(frameState?.commandList)
  ) {
    return {
      ok: false,
      structural: ["pvs:live-view-or-command-list-missing"],
    };
  }
  const snapshot = () =>
    summarizeGsplatFrustumBands(
      view.frustumCommandsList ?? scene.frustumCommandsList,
      globePass,
      gaussianSplatPass,
    );
  const cleanBands = snapshot();
  const commands = frameState.commandList.filter(
    (command) => command?.pass === gaussianSplatPass,
  );
  const saved = commands.map((command) => ({
    command,
    boundingVolume: command.boundingVolume,
  }));
  const allBoundingVolumesDefined = saved.every(
    ({ boundingVolume }) =>
      boundingVolume !== undefined && boundingVolume !== null,
  );
  let suppressedBands = [];
  let restoredBands = [];
  let suppressionAppliedCount = 0;
  let restorationPvsRan = false;
  let controlError = null;
  try {
    for (const { command } of saved) {
      command.boundingVolume = undefined;
      if (command.boundingVolume === undefined) suppressionAppliedCount++;
    }
    view.createPotentiallyVisibleSet(scene);
    suppressedBands = snapshot();
  } catch (error) {
    controlError = error?.stack ?? error?.message ?? String(error);
  } finally {
    for (const { command, boundingVolume } of saved) {
      command.boundingVolume = boundingVolume;
    }
    try {
      view.createPotentiallyVisibleSet(scene);
      restorationPvsRan = true;
      restoredBands = snapshot();
    } catch (error) {
      const restorationError = error?.stack ?? error?.message ?? String(error);
      controlError = controlError
        ? `${controlError}\nRESTORATION: ${restorationError}`
        : restorationError;
    }
  }
  const structural = [];
  if (controlError) structural.push(`pvs:control-error:${controlError}`);
  if (commands.length < 1) {
    structural.push("pvs:no-current-frame-splat-command");
  }
  if (!allBoundingVolumesDefined) {
    structural.push("pvs:clean-bounding-volume-missing");
  }
  if (suppressionAppliedCount !== commands.length) {
    structural.push("pvs:suppression-not-applied-to-all");
  }
  const boundingVolumeIdentitiesRestored = saved.every(
    ({ command, boundingVolume }) => command.boundingVolume === boundingVolume,
  );
  if (!boundingVolumeIdentitiesRestored) {
    structural.push("pvs:bounding-volume-identity-not-restored");
  }
  if (!restorationPvsRan) structural.push("pvs:restoration-pvs-not-run");
  return {
    ok: structural.length === 0,
    structural,
    clean: { bands: cleanBands },
    suppressed: { bands: suppressedBands },
    restored: { bands: restoredBands },
    commandCount: commands.length,
    allBoundingVolumesDefined,
    suppressionAppliedCount,
    boundingVolumeIdentitiesRestored,
    restorationPvsRan,
  };
}

/**
 * Apply the dedicated G6 camera in a live parity-probe page.
 *
 * This function is self-contained so its exact `toString()` form can be
 * shipped through `page.evaluate`; it intentionally repeats the three small
 * numeric constants rather than closing over Node module state.
 */
export function applyGsplatMultifrustumPageFraming(C, viewer, tileset) {
  const scene = viewer?.scene;
  const radius = tileset?.boundingSphere?.radius;
  const fovyRadians = scene?.camera?.frustum?.fovy;
  const expectedAssetUrl =
    "/Specs/Data/Cesium3DTiles/GaussianSplats/tower/tileset.json";
  const loadedUrl = tileset?.resource?.url;
  let assetUrl = null;
  try {
    assetUrl = new URL(loadedUrl, "http://cesium.invalid").pathname;
  } catch {
    // The common framing error below owns malformed/missing asset identity.
  }
  if (
    !scene?.globe ||
    assetUrl !== expectedAssetUrl ||
    !Number.isFinite(radius) ||
    radius <= 0 ||
    !Number.isFinite(fovyRadians) ||
    fovyRadians <= 0 ||
    fovyRadians >= Math.PI
  ) {
    throw new Error("G6 framing requires a perspective tower/globe scene");
  }
  const viewportHeightFraction = 0.1;
  const angularRadius = Math.atan(
    viewportHeightFraction * Math.tan(fovyRadians / 2),
  );
  const range = radius / Math.sin(angularRadius);
  scene.globe.show = true;
  scene.globe.imageryLayers?.removeAll();
  scene.globe.baseColor = C.Color.fromCssColorString("#26262c");
  scene.globe.enableLighting = false;
  scene.globe.showGroundAtmosphere = false;
  scene.globe.depthTestAgainstTerrain = true;
  viewer.terrainProvider = new C.EllipsoidTerrainProvider();
  scene.logarithmicDepthFarToNearRatio = 2;
  viewer.camera.viewBoundingSphere(
    tileset.boundingSphere,
    new C.HeadingPitchRange(0, -Math.PI / 2, range),
  );
  viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
  return {
    assetUrl,
    headingRadians: 0,
    pitchRadians: -Math.PI / 2,
    range,
    radius,
    fovyRadians,
    viewportHeightFraction,
    logarithmicDepthFarToNearRatio: 2,
    globeShown: scene.globe.show === true,
  };
}

/** Settle the live G6 page until real globe/splat bins and >=2 frusta exist. */
export async function settleGsplatMultifrustumPageFraming(
  C,
  viewer,
  tileset,
  timeoutMs = 90_000,
) {
  const scene = viewer.scene;
  const started = performance.now();
  const fixedTime = C.JulianDate.fromIso8601("2026-08-02T18:00:00Z");
  let latest = {
    activeFrusta: 0,
    globeCommands: 0,
    splatCommands: 0,
  };
  while (performance.now() - started < timeoutMs) {
    scene.requestRender();
    scene.render(fixedTime);
    const bands =
      scene._view?.frustumCommandsList ?? scene.frustumCommandsList ?? [];
    latest = {
      // This read is the page-side anti-vacuity anchor.  No occlusion pixel is
      // acquired anywhere in this helper.
      activeFrusta: bands.length,
      globeCommands: bands.reduce(
        (count, band) => count + (band.indices?.[C.Pass.GLOBE] ?? 0),
        0,
      ),
      splatCommands: bands.reduce(
        (count, band) => count + (band.indices?.[C.Pass.GAUSSIAN_SPLATS] ?? 0),
        0,
      ),
    };
    if (
      tileset.tilesLoaded &&
      scene.globe.tilesLoaded &&
      latest.activeFrusta >= 2 &&
      latest.globeCommands > 0 &&
      latest.splatCommands > 0
    ) {
      return {
        ready: true,
        waitedMs: Math.round(performance.now() - started),
        logDepthEnabled: scene.frameState.useLogDepth === true,
        logarithmicDepthFarToNearRatio: scene.logarithmicDepthFarToNearRatio,
        ...latest,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    ready: false,
    waitedMs: Math.round(performance.now() - started),
    logDepthEnabled: scene.frameState.useLogDepth === true,
    logarithmicDepthFarToNearRatio: scene.logarithmicDepthFarToNearRatio,
    ...latest,
  };
}

/**
 * Canonical declarations for direct embedding inside the parity probe's
 * `RUN_LANE` callback.  Consumers copy this source into the callback at author
 * time and pin it byte-for-byte in a spec; they must never evaluate the string
 * in the page.  Direct embedding keeps the helper usable under page CSP.
 */
export const GSPLAT_MULTIFRUSTUM_PAGE_INSTRUMENT_SOURCE = `
  const summarizeGsplatFrustumBands = (${summarizeGsplatFrustumBands.toString()});
  const acquireGsplatBoundingVolumeControl = (${acquireGsplatBoundingVolumeControl.toString()});
  const applyGsplatMultifrustumPageFraming = (${applyGsplatMultifrustumPageFraming.toString()});
  const settleGsplatMultifrustumPageFraming = (${settleGsplatMultifrustumPageFraming.toString()});
  const gsplatMultifrustumPageInstrument = Object.freeze({
    apply: applyGsplatMultifrustumPageFraming,
    settle: settleGsplatMultifrustumPageFraming,
    acquireBoundingVolumeControl: acquireGsplatBoundingVolumeControl,
  });
`;

function validBand(band) {
  return (
    band &&
    Number.isInteger(band.index) &&
    band.index >= 0 &&
    Number.isFinite(band.near) &&
    Number.isFinite(band.far) &&
    band.near > 0 &&
    band.far > band.near &&
    Number.isInteger(band.globeIndex) &&
    band.globeIndex >= 0 &&
    Number.isInteger(band.splatIndex) &&
    band.splatIndex >= 0
  );
}

function sameBands(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every(
      (band, index) =>
        band.index === right[index]?.index &&
        band.near === right[index]?.near &&
        band.far === right[index]?.far &&
        band.globeIndex === right[index]?.globeIndex &&
        band.splatIndex === right[index]?.splatIndex,
    )
  );
}

function inspectBackendTopology(
  backend,
  evidence,
  structural,
  readOrder,
  minimumActiveFrusta,
) {
  // This is the load-bearing read.  Do not move an occlusion access above it.
  const cleanBands = evidence?.clean?.bands;
  const activeFrusta = Array.isArray(cleanBands) ? cleanBands.length : 0;
  readOrder.push({
    ordinal: readOrder.length + 1,
    kind: "frustumCommands",
    backend,
    activeFrusta,
  });
  if (!Array.isArray(cleanBands) || !cleanBands.every(validBand)) {
    structural.push(`${backend}:clean-bands:invalid`);
    return { activeFrusta, cleanBands: [] };
  }
  if (activeFrusta < minimumActiveFrusta) {
    structural.push(`${backend}:active-frusta:${activeFrusta}-below-2`);
    return { activeFrusta, cleanBands };
  }

  const settle = evidence?.settle;
  if (
    settle?.ready !== true ||
    settle?.activeFrusta !== activeFrusta ||
    !Number.isInteger(settle?.globeCommands) ||
    settle.globeCommands < 1 ||
    !Number.isInteger(settle?.splatCommands) ||
    settle.splatCommands < 1 ||
    settle?.logDepthEnabled !== true ||
    settle?.logarithmicDepthFarToNearRatio !==
      GSPLAT_MULTIFRUSTUM_CONFIG.logarithmicDepthFarToNearRatio
  ) {
    structural.push(`${backend}:settled-tower-globe-frame-unproven`);
  }

  const suppressedBands = evidence?.suppressed?.bands;
  const restoredBands = evidence?.restored?.bands;
  if (!Array.isArray(suppressedBands) || !suppressedBands.every(validBand)) {
    structural.push(`${backend}:suppressed-bands:invalid`);
  }
  if (!Array.isArray(restoredBands) || !restoredBands.every(validBand)) {
    structural.push(`${backend}:restored-bands:invalid`);
  }
  const cleanSplatBands = cleanBands.filter(
    (band) => band.splatIndex > 0,
  ).length;
  if (cleanSplatBands < 1 || cleanSplatBands >= activeFrusta) {
    structural.push(`${backend}:bounded-splat:not-selectively-binned`);
  }
  if (!cleanBands.some((band) => band.splatIndex > 0 && band.globeIndex > 0)) {
    structural.push(`${backend}:clean:no-shared-globe-splat-band`);
  }
  if (
    !Array.isArray(suppressedBands) ||
    suppressedBands.length < minimumActiveFrusta ||
    !suppressedBands.every((band) => band.splatIndex > 0)
  ) {
    structural.push(`${backend}:negative:splat-not-in-every-band`);
  }
  if (
    !Array.isArray(suppressedBands) ||
    !suppressedBands.some(
      (band) => band.splatIndex > 0 && band.globeIndex === 0,
    )
  ) {
    structural.push(`${backend}:negative:no-splat-only-band`);
  }
  if (!Number.isInteger(evidence?.commandCount) || evidence.commandCount < 1) {
    structural.push(`${backend}:negative:no-current-frame-splat-command`);
  }
  if (evidence?.allBoundingVolumesDefined !== true) {
    structural.push(`${backend}:clean:bounding-volume-missing`);
  }
  if (evidence?.suppressionAppliedCount !== evidence?.commandCount) {
    structural.push(`${backend}:negative:suppression-not-applied-to-all`);
  }
  if (evidence?.boundingVolumeIdentitiesRestored !== true) {
    structural.push(
      `${backend}:negative:bounding-volume-identity-not-restored`,
    );
  }
  if (evidence?.restorationPvsRan !== true) {
    structural.push(`${backend}:negative:restoration-pvs-not-run`);
  }
  if (!sameBands(cleanBands, restoredBands)) {
    structural.push(`${backend}:negative:clean-bins-not-restored`);
  }
  if (evidence?.ok !== true || (evidence?.structural?.length ?? 0) > 0) {
    structural.push(`${backend}:negative:acquisition-not-clean`);
  }
  return { activeFrusta, cleanBands };
}

/**
 * Establish G6 standing before a caller can read an occlusion number.
 *
 * `readOcclusion` is deliberately lazy.  On any one-frustum or malformed
 * fixture it is never called; specs use throwing accessors to pin that order.
 */
export function evaluateGsplatMultifrustumFraming(input, readOcclusion) {
  const structural = [];
  const readOrder = [];
  if (input?.schema !== GSPLAT_MULTIFRUSTUM_SCHEMA) {
    structural.push("input:schema-invalid");
  }
  const globePass = input?.passes?.globe;
  const gaussianSplatPass = input?.passes?.gaussianSplats;
  if (
    !Number.isInteger(globePass) ||
    !Number.isInteger(gaussianSplatPass) ||
    globePass === gaussianSplatPass
  ) {
    structural.push("input:pass-identities-invalid");
  }
  if (input?.framing?.logDepthEnabled !== true) {
    structural.push("framing:log-depth-not-enabled");
  }
  if (
    input?.framing?.logarithmicDepthFarToNearRatio !==
    GSPLAT_MULTIFRUSTUM_CONFIG.logarithmicDepthFarToNearRatio
  ) {
    structural.push("framing:log-depth-ratio-not-forced-to-2");
  }
  if (
    input?.framing?.assetUrl !== GSPLAT_MULTIFRUSTUM_CONFIG.assetUrl ||
    input?.framing?.globeShown !== true
  ) {
    structural.push("framing:not-tower-over-globe");
  }
  const radius = input?.framing?.radius;
  const fovyRadians = input?.framing?.fovyRadians;
  const viewportHeightFraction = input?.framing?.viewportHeightFraction;
  let derivedRange = Number.NaN;
  try {
    derivedRange = deriveFarNadirRange(
      radius,
      fovyRadians,
      viewportHeightFraction,
    );
  } catch {
    // The shared framing reason below names the malformed derivation inputs.
  }
  if (
    input?.framing?.headingRadians !==
      GSPLAT_MULTIFRUSTUM_CONFIG.headingRadians ||
    !Number.isFinite(input?.framing?.pitchRadians) ||
    Math.abs(
      input.framing.pitchRadians - GSPLAT_MULTIFRUSTUM_CONFIG.pitchRadians,
    ) > 1e-12 ||
    !Number.isFinite(input?.framing?.range) ||
    input.framing.range <= 0 ||
    viewportHeightFraction !==
      GSPLAT_MULTIFRUSTUM_CONFIG.towerViewportHeightFraction ||
    !Number.isFinite(derivedRange) ||
    Math.abs(input.framing.range - derivedRange) >
      Math.max(1e-9, derivedRange * 1e-12)
  ) {
    structural.push("framing:not-far-nadir");
  }

  const activeFrusta = {};
  for (const backend of ["webgl", "webgpu"]) {
    const inspected = inspectBackendTopology(
      backend,
      input?.backends?.[backend],
      structural,
      readOrder,
      GSPLAT_MULTIFRUSTUM_CONFIG.minimumActiveFrusta,
    );
    activeFrusta[backend] = inspected.activeFrusta;
  }

  if (structural.length > 0) {
    return {
      eligible: false,
      structural,
      activeFrusta,
      occlusionRead: false,
      occlusion: null,
      readOrder,
    };
  }
  if (typeof readOcclusion !== "function") {
    return {
      eligible: false,
      structural: ["occlusion:lazy-reader-missing"],
      activeFrusta,
      occlusionRead: false,
      occlusion: null,
      readOrder,
    };
  }

  readOrder.push({
    ordinal: readOrder.length + 1,
    kind: "occlusion",
  });
  const occlusion = readOcclusion();
  return {
    eligible: true,
    structural: [],
    activeFrusta,
    occlusionRead: true,
    occlusion,
    readOrder,
  };
}

export default {
  GSPLAT_MULTIFRUSTUM_SCHEMA,
  GSPLAT_MULTIFRUSTUM_CONFIG,
  deriveFarNadirRange,
  createGsplatMultifrustumPlan,
  summarizeGsplatFrustumBands,
  acquireGsplatBoundingVolumeControl,
  applyGsplatMultifrustumPageFraming,
  settleGsplatMultifrustumPageFraming,
  GSPLAT_MULTIFRUSTUM_PAGE_INSTRUMENT_SOURCE,
  evaluateGsplatMultifrustumFraming,
};
