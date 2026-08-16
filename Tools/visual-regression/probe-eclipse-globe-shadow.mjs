#!/usr/bin/env node
// C12-29 S5 browser proof: the lunar shadow is evaluated per globe fragment,
// is visible and spatially local during the 2024-04-08 eclipse, is inert one
// day later, and behaves that way on both renderer backends. A second,
// lighting-enabled lane keeps one orbital camera position fixed while aiming
// first outside, then inside, then outside the selected-terrain penumbra. It
// certifies the correction-only gates and their one-View WebGPU carrier.
// @purpose C12-29 S5 browser proof: lunar shadow evaluated per globe fragment — visible/local during the 2024-04-08 eclipse, inert a day later, both backends.
// @status ACTIVE
//
// This is deliberately a small isolation probe. The whole-disc lane disables
// globe lighting; its only pairwise difference is `enableEclipseGlobeShadow`.
// The selected-terrain lane enables lighting so correction-only work is
// observable. Atmosphere controls, fog, celestial billboards, clouds,
// temporal AA, and animated water stay fixed across every pair. The globe
// keeps deterministic repository-local NaturalEarthII imagery so a black
// clear or a missing tile cannot masquerade as an umbra.
//
// Usage:
//   node Tools/visual-regression/probe-eclipse-globe-shadow.mjs
// Env:
//   PROBE_BASE=http://localhost:8080
//   PROBE_HEADED=1
// Output (gitignored):
//   Tools/visual-regression/output/eclipse-globe-shadow-*.png
//   Tools/visual-regression/output/eclipse-globe-shadow-report.json

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const HEADED = process.env.PROBE_HEADED === "1";
const OUT_DIR = path.join(__dirname, "output");
const ECLIPSE_ISO = "2024-04-08T18:17:16Z";
const CONTROL_ISO = "2024-04-09T18:17:16Z";
const VIEWPORT = { width: 960, height: 960 };
// Whole-disc framing leaves sunlit pixels outside the broad penumbra, making
// "spatial shadow" distinguishable from a uniform scene-light multiplier.
const CAMERA_HEIGHT = 8_000_000.0;
const SOLAR_RADIUS = 6.957e8;
const LUNAR_RADIUS = 1_737_400.0;
const WATCHDOG_MS = 300_000;

fs.mkdirSync(OUT_DIR, { recursive: true });

const watchdog = setTimeout(() => {
  console.error(
    "[probe-eclipse-globe-shadow] watchdog fired after 300 seconds",
  );
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

function collectJavaScriptFiles(directory, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectJavaScriptFiles(absolute, result);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      result.push(absolute);
    }
  }
  return result;
}

function verifyBuildContainsS5() {
  const buildDir = path.resolve("Build/CesiumUnminified");
  const required = new Set([
    "enableEclipseGlobeShadow",
    "u_eclipseGlobeShadow",
    "eclipseSunDirectionAndInvRange",
  ]);
  const foundIn = {};
  if (!fs.existsSync(buildDir)) {
    return { ok: false, missing: [...required], foundIn };
  }
  for (const file of collectJavaScriptFiles(buildDir)) {
    if (required.size === 0) {
      break;
    }
    const source = fs.readFileSync(file, "utf8");
    for (const token of [...required]) {
      if (source.includes(token)) {
        foundIn[token] = path
          .relative(process.cwd(), file)
          .replaceAll("\\", "/");
        required.delete(token);
      }
    }
  }
  return { ok: required.size === 0, missing: [...required], foundIn };
}

const MEASURE = async ({
  eclipseIso,
  controlIso,
  cameraHeight,
  solarRadius,
  lunarRadius,
}) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const out = {
    rendererType: scene.context?.rendererType ?? "unknown",
    structuralError: null,
  };

  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  scene.requestRenderMode = false;
  scene.highDynamicRange = false;
  scene.sunBloom = false;
  scene.taaEnabled = false;
  scene.backgroundColor = C.Color.BLACK;
  if (scene.postProcessStages?.fxaa) {
    scene.postProcessStages.fxaa.enabled = false;
  }
  if (scene.postProcessStages?.bloom) {
    scene.postProcessStages.bloom.enabled = false;
  }
  if (scene.fog) {
    scene.fog.enabled = false;
  }
  if (scene.skyAtmosphere) {
    // Keep the environment pass populated on WebGPU. It is unchanged across
    // each S5 pair and therefore subtracts away from the shadow measurement.
    scene.skyAtmosphere.show = true;
  }
  if (scene.skyBox) {
    scene.skyBox.show = true;
  }
  if (scene.sun) {
    // Keep the command alive but outside the nadir-facing view. WebGPU's
    // environment pass currently drops its clear/composite when every
    // environment command is hidden (NEW-WEBGPU-ENV-PASS-DROP); hiding the sun
    // here would conflate that independent bug with a globe-shadow failure.
    scene.sun.show = true;
  }
  if (scene.moon) {
    scene.moon.show = false;
  }
  if (scene.volumetricClouds) {
    scene.volumetricClouds.show = false;
  }

  const globe = scene.globe;
  if (!globe) {
    return { ...out, structuralError: "viewer has no globe" };
  }
  globe.show = true;
  globe.enableLighting = false;
  globe.showGroundAtmosphere = false;
  globe.showWaterEffect = false;
  scene.terrainProvider = new C.EllipsoidTerrainProvider();

  try {
    const imagery = await C.TileMapServiceImageryProvider.fromUrl(
      C.buildModuleUrl("Assets/Textures/NaturalEarthII"),
    );
    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(imagery);
    out.imagery = "NaturalEarthII-local";
  } catch (error) {
    return {
      ...out,
      structuralError: `local NaturalEarthII failed: ${String(
        error?.message ?? error,
      )}`,
    };
  }

  const lighting = globe.atmosphericConditions?.lighting;
  if (
    !lighting ||
    !("enableEclipse" in lighting) ||
    !("enableEclipseGlobeShadow" in lighting)
  ) {
    return {
      ...out,
      structuralError: "S5 atmospheric-conditions toggles are unavailable",
    };
  }
  lighting.enableEclipse = true;
  lighting.eclipseAutoExposure = false;
  if ("enableEclipseHorizonTwilight" in lighting) {
    lighting.enableEclipseHorizonTwilight = false;
  }

  let pinnedTime = C.JulianDate.fromIso8601(eclipseIso);
  const T = () => pinnedTime;

  // SAME-TASK CAPTURE. The canonical source is checked byte-for-byte by
  // eclipse-globe-shadow-visual.spec.mjs. Never place a GPU-canvas read after
  // a browser-task yield: WebGL can clear it and WebGPU can invalidate it.
  // ==BEGIN same-task-capture==
  const makeSameTaskCapture = (scene, canvas, timeFn) => {
    const renderNow = () => scene.render(timeFn());
    const tmp = document.createElement("canvas");
    const ctx = tmp.getContext("2d", { willReadFrequently: true });
    const decodeSnapshot = async (snapshot) => {
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        const decodeFailed = "same-task PNG decode failed";
        image.onload = resolve;
        image.onerror = () => reject(new Error(decodeFailed));
      });
      image.src = snapshot;
      await loaded;
      tmp.width = image.naturalWidth;
      tmp.height = image.naturalHeight;
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, tmp.width, tmp.height);
    };
    const snapshotNow = () => {
      renderNow();
      return canvas.toDataURL("image/png");
    };
    const captureNow = () => {
      const snapshot = snapshotNow();
      return decodeSnapshot(snapshot);
    };
    const grabNow = snapshotNow;
    const settleThen = async (maxFrames, done, capture) => {
      let settled = false;
      for (let k = 0; k < maxFrames; k++) {
        if (typeof done === "function" && done() === true) {
          settled = true;
          break;
        }
        renderNow();
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (!settled && typeof done === "function") {
        settled = done() === true;
      }
      const hasCapture = typeof capture === "function";
      const result = hasCapture ? await capture() : undefined;
      return { settled, result };
    };
    return { renderNow, captureNow, grabNow, settleThen };
  };
  // ==END same-task-capture==

  const { renderNow, captureNow, grabNow, settleThen } = makeSameTaskCapture(
    scene,
    canvas,
    T,
  );

  // Prime the ephemeris at the eclipse instant. The body positions published
  // by EclipseState are geocentric, so the temporary camera does not bias the
  // ground-track search.
  scene.camera.setView({
    destination: C.Cartesian3.fromDegrees(-104.0, 25.0, cameraHeight),
    orientation: {
      heading: 0.0,
      pitch: -C.Math.PI_OVER_TWO,
      roll: 0.0,
    },
  });
  for (let i = 0; i < 8; i++) {
    renderNow();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  const initialState = scene.frameState?.eclipseState;
  if (
    !initialState?.valid ||
    !initialState.sunPositionWC ||
    !initialState.moonPositionWC
  ) {
    return {
      ...out,
      structuralError: "EclipseState did not publish valid Sun/Moon positions",
    };
  }
  const sun = C.Cartesian3.clone(initialState.sunPositionWC);
  const moon = C.Cartesian3.clone(initialState.moonPositionWC);

  const observerScore = (longitude, latitude) => {
    const p = C.Cartesian3.fromDegrees(longitude, latitude, 0.0);
    const toSun = C.Cartesian3.subtract(sun, p, new C.Cartesian3());
    const toMoon = C.Cartesian3.subtract(moon, p, new C.Cartesian3());
    const sunRange = C.Cartesian3.magnitude(toSun);
    const moonRange = C.Cartesian3.magnitude(toMoon);
    const rs = Math.asin(Math.min(1.0, solarRadius / sunRange));
    const ro = Math.asin(Math.min(1.0, lunarRadius / moonRange));
    const cross = C.Cartesian3.cross(toSun, toMoon, new C.Cartesian3());
    const separation = Math.atan2(
      C.Cartesian3.magnitude(cross),
      C.Cartesian3.dot(toSun, toMoon),
    );
    return {
      longitude,
      latitude,
      magnitude: (rs + ro - separation) / (2.0 * rs),
      totalityMargin: ro - rs - separation,
      rs,
      ro,
      separation,
    };
  };
  const improve = (best, lon0, lat0, radius, step) => {
    let candidate = best;
    for (let lat = lat0 - radius; lat <= lat0 + radius + 1e-9; lat += step) {
      if (lat < -75.0 || lat > 75.0) {
        continue;
      }
      for (let lon = lon0 - radius; lon <= lon0 + radius + 1e-9; lon += step) {
        const wrapped = ((lon + 540.0) % 360.0) - 180.0;
        const score = observerScore(wrapped, lat);
        if (!candidate || score.totalityMargin > candidate.totalityMargin) {
          candidate = score;
        }
      }
    }
    return candidate;
  };

  let track = null;
  for (let lat = -65.0; lat <= 65.0; lat += 2.0) {
    for (let lon = -180.0; lon < 180.0; lon += 2.0) {
      const score = observerScore(lon, lat);
      if (!track || score.totalityMargin > track.totalityMargin) {
        track = score;
      }
    }
  }
  track = improve(track, track.longitude, track.latitude, 3.0, 0.25);
  track = improve(track, track.longitude, track.latitude, 0.4, 0.025);
  out.track = track;
  if (!(track.magnitude > 0.95)) {
    return {
      ...out,
      structuralError: `2024 fixture is not a deep eclipse: magnitude=${track.magnitude}`,
    };
  }

  scene.camera.setView({
    destination: C.Cartesian3.fromDegrees(
      track.longitude,
      track.latitude,
      cameraHeight,
    ),
    orientation: {
      heading: 0.0,
      pitch: -C.Math.PI_OVER_TWO,
      roll: 0.0,
    },
  });
  scene.camera.frustum.fov = C.Math.toRadians(55.0);

  let loadedStreak = 0;
  let settlePolls = 0;
  const settled = await settleThen(
    480,
    () => {
      settlePolls++;
      const visibleTiles = globe._surface?._tilesToRender?.length ?? 0;
      if (globe.tilesLoaded === true && visibleTiles > 0) {
        loadedStreak++;
      } else {
        loadedStreak = 0;
      }
      // WebGPU can report `tilesLoaded` while its lazily-created globe
      // pipelines are still compiling. The established camera-track floor is
      // 120 frames; 150 leaves the same 30-frame materialization margin.
      return settlePolls >= 150 && loadedStreak >= 12;
    },
    undefined,
  );
  out.tilesSettled = settled.settled;
  out.settlePolls = settlePolls;
  out.visibleTiles = globe._surface?._tilesToRender?.length ?? 0;

  const summarizeSelectedTerrain = () => {
    const surface = globe._surface;
    const provider = surface?.tileProvider ?? surface?._tileProvider;
    const tiles = surface?._tilesToRender ?? [];
    const ids = [];
    let renderedMeshCount = 0;
    let encodedMeshCount = 0;
    let scaledEnuBoundsCount = 0;
    let skirtedMeshCount = 0;
    let skirtlessMeshCount = 0;
    let unknownSkirtMeshCount = 0;
    let totalIndices = 0;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      ids.push(`${tile?.level ?? "?"}/${tile?.x ?? "?"}/${tile?.y ?? "?"}`);
      const mesh = tile?.data?.renderedMesh;
      if (!mesh) {
        continue;
      }
      renderedMeshCount++;
      if (mesh.encoding) {
        encodedMeshCount++;
      }
      if (mesh.encoding?.fromScaledENU) {
        scaledEnuBoundsCount++;
      }
      const indexLength = mesh.indices?.length;
      const indexCountWithoutSkirts = mesh.indexCountWithoutSkirts;
      if (Number.isFinite(indexLength)) {
        totalIndices += indexLength;
      }
      if (
        Number.isFinite(indexLength) &&
        Number.isFinite(indexCountWithoutSkirts)
      ) {
        if (indexLength === indexCountWithoutSkirts) {
          skirtlessMeshCount++;
        } else {
          skirtedMeshCount++;
        }
      } else {
        unknownSkirtMeshCount++;
      }
    }
    ids.sort();
    return {
      count: tiles.length,
      ids,
      renderedMeshCount,
      encodedMeshCount,
      scaledEnuBoundsCount,
      skirtedMeshCount,
      skirtlessMeshCount,
      unknownSkirtMeshCount,
      totalIndices,
      providerSelectionRevision: provider?._eclipseSelectionRevision ?? null,
    };
  };
  const summarizeAllocator = () => {
    const stats = scene.context?.uniformAllocator?.getStats?.();
    if (!stats) {
      return null;
    }
    return {
      currentFrameAllocations: stats.currentFrameAllocations,
      currentFrameUsed: stats.currentFrameUsed,
      peakFrameUsage: stats.peakFrameUsage,
      overflowCount: stats.overflowCount,
      pageCount: stats.pageCount,
      totalCapacity: stats.totalCapacity,
    };
  };
  const summarizeState = () => {
    const state = scene.frameState?.eclipseState;
    const shadow = scene.frameState?.eclipseGlobeShadow;
    return {
      enabled: state?.enabled ?? null,
      valid: state?.valid ?? null,
      moonObscuration: state?.moonObscuration ?? null,
      eclipseMagnitude: state?.eclipseMagnitude ?? null,
      sceneLightFactor: scene.frameState?.eclipseSceneLightFactor ?? null,
      blockActive: shadow?.active ?? null,
      blockRevision: shadow?.revision ?? null,
      blockGate: shadow?.params?.x ?? null,
      anchorWeight: shadow?.anchorWeight ?? null,
      sunInvRange: shadow?.sunDirectionAndInvRange?.w ?? null,
      moonInvRange: shadow?.moonDirectionDeltaAndInvRange?.w ?? null,
      prepared: scene.frameState?.eclipseGlobeShadowPrepared ?? null,
      preparedSelectionRevision:
        scene.frameState?.eclipseGlobeShadowSelectionRevision ?? null,
      preparedSurfaceRadius:
        scene.frameState?.eclipseGlobeShadowSurfaceRadius ?? null,
      selectedTerrain: summarizeSelectedTerrain(),
      uniformAllocator: summarizeAllocator(),
    };
  };
  const capture = async (enabled) => {
    lighting.enableEclipseGlobeShadow = enabled;
    const image = await captureNow();
    const png = grabNow();
    return { image, png, state: summarizeState() };
  };
  const analyze = (image) => {
    let nonBlack = 0;
    let luminanceSum = 0.0;
    const buckets = new Set();
    for (let i = 0; i < image.data.length; i += 4) {
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (luminance > 8.0) {
        nonBlack++;
        luminanceSum += luminance;
        buckets.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      }
    }
    return {
      width: image.width,
      height: image.height,
      nonBlackPixels: nonBlack,
      nonBlackPct: nonBlack / (image.width * image.height),
      meanVisibleLuminance: nonBlack > 0 ? luminanceSum / nonBlack : 0.0,
      colorBuckets: buckets.size,
    };
  };
  const compare = (off, on) => {
    let visible = 0;
    let changed = 0;
    let darkened = 0;
    let brightened = 0;
    let strongDarkened = 0;
    let unchangedVisible = 0;
    let signedLuminanceDelta = 0.0;
    let maxChannelDelta = 0;
    let maxLuminanceDrop = 0.0;
    let minX = off.width;
    let minY = off.height;
    let maxX = -1;
    let maxY = -1;
    for (let p = 0; p < off.width * off.height; p++) {
      const i = p * 4;
      const offR = off.data[i];
      const offG = off.data[i + 1];
      const offB = off.data[i + 2];
      const onR = on.data[i];
      const onG = on.data[i + 1];
      const onB = on.data[i + 2];
      const offL = 0.2126 * offR + 0.7152 * offG + 0.0722 * offB;
      const onL = 0.2126 * onR + 0.7152 * onG + 0.0722 * onB;
      if (offL <= 8.0 && onL <= 8.0) {
        continue;
      }
      visible++;
      const channelDelta = Math.max(
        Math.abs(offR - onR),
        Math.abs(offG - onG),
        Math.abs(offB - onB),
      );
      maxChannelDelta = Math.max(maxChannelDelta, channelDelta);
      const drop = offL - onL;
      maxLuminanceDrop = Math.max(maxLuminanceDrop, drop);
      signedLuminanceDelta += drop;
      if (channelDelta > 4) {
        changed++;
        const x = p % off.width;
        const y = Math.floor(p / off.width);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      } else {
        unchangedVisible++;
      }
      if (drop > 4.0) {
        darkened++;
      } else if (drop < -4.0) {
        brightened++;
      }
      if (drop > 24.0) {
        strongDarkened++;
      }
    }
    const bboxPixels =
      maxX >= minX && maxY >= minY ? (maxX - minX + 1) * (maxY - minY + 1) : 0;
    return {
      visiblePixels: visible,
      changedPixels: changed,
      changedPctVisible: visible > 0 ? changed / visible : 0.0,
      darkenedPixels: darkened,
      brightenedPixels: brightened,
      strongDarkenedPixels: strongDarkened,
      strongDarkenedPctVisible: visible > 0 ? strongDarkened / visible : 0.0,
      unchangedVisiblePixels: unchangedVisible,
      meanLuminanceDrop: visible > 0 ? signedLuminanceDelta / visible : 0.0,
      maxLuminanceDrop,
      maxChannelDelta,
      changedBounds:
        bboxPixels > 0 ? { minX, minY, maxX, maxY, bboxPixels } : null,
      changedBoundsPctCanvas: bboxPixels / (off.width * off.height),
    };
  };
  const setEclipseConfiguration = (masterEnabled, s5Enabled) => {
    lighting.enableEclipse = masterEnabled;
    lighting.enableEclipseGlobeShadow = s5Enabled;
  };
  const captureConfiguration = async (masterEnabled, s5Enabled) => {
    setEclipseConfiguration(masterEnabled, s5Enabled);
    const image = await captureNow();
    const png = grabNow();
    return { image, png, state: summarizeState() };
  };
  const captureSettledConfiguration = async (masterEnabled, s5Enabled) => {
    setEclipseConfiguration(masterEnabled, s5Enabled);
    let previousSelection = null;
    let stableSelectionStreak = 0;
    let settleFrames = 0;
    for (; settleFrames < 18; settleFrames++) {
      renderNow();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const state = summarizeState();
      const selection = state.selectedTerrain;
      const signature = selection.ids.join(",");
      if (
        globe.tilesLoaded === true &&
        selection.renderedMeshCount > 0 &&
        signature === previousSelection
      ) {
        stableSelectionStreak++;
      } else {
        stableSelectionStreak = 0;
      }
      previousSelection = signature;
      if (stableSelectionStreak >= 3) {
        break;
      }
    }
    const captured = await captureConfiguration(masterEnabled, s5Enabled);
    return {
      ...captured,
      settle: {
        frames: Math.min(settleFrames + 1, 18),
        stableSelectionStreak,
      },
    };
  };

  pinnedTime = C.JulianDate.fromIso8601(eclipseIso);
  lighting.enableEclipseGlobeShadow = false;
  let warmupStats = null;
  let warmupCaptures = 0;
  // A lazy WebGPU globe pipeline can become ready on the first fused capture
  // after the rAF settle. Treat that frame as materialization, not evidence,
  // and require an actual nonblank globe before beginning the A/B pair.
  // A truly cold Dawn pipeline cache can take longer than six capture turns
  // even after tile residency settles. Twelve keeps the wait bounded while
  // preventing a first-run-only false RED; every individual read still uses
  // the same-task capture contract above.
  while (warmupCaptures < 12) {
    const warmup = await captureNow();
    warmupStats = analyze(warmup);
    warmupCaptures++;
    if (warmupStats.nonBlackPct > 0.2 && warmupStats.colorBuckets > 80) {
      break;
    }
  }
  out.captureWarmup = { captures: warmupCaptures, stats: warmupStats };
  if (
    !warmupStats ||
    warmupStats.nonBlackPct <= 0.2 ||
    warmupStats.colorBuckets <= 80
  ) {
    return {
      ...out,
      structuralError:
        "globe pipeline never materialized into a nonblank fused capture",
    };
  }

  const eclipseOff = await capture(false);
  const eclipseOn = await capture(true);
  out.eclipse = {
    off: { stats: analyze(eclipseOff.image), state: eclipseOff.state },
    on: { stats: analyze(eclipseOn.image), state: eclipseOn.state },
    diff: compare(eclipseOff.image, eclipseOn.image),
  };

  pinnedTime = C.JulianDate.fromIso8601(controlIso);
  const controlOff = await capture(false);
  const controlOn = await capture(true);
  out.control = {
    off: { stats: analyze(controlOff.image), state: controlOff.state },
    on: { stats: analyze(controlOn.image), state: controlOn.state },
    diff: compare(controlOff.image, controlOn.image),
  };

  // Selected-terrain transition lane. Keep the orbital observer fixed above
  // the discovered eclipse track; only the look direction changes. The wide
  // view above already materialized the local imagery and terrain pipeline.
  // A narrow view now lets the quadtree's exact selected meshes prove both
  // sides of the S5 broad/fine gate without manufacturing engine state.
  pinnedTime = C.JulianDate.fromIso8601(eclipseIso);
  globe.enableLighting = true;
  setEclipseConfiguration(true, true);
  scene.camera.frustum.fov = C.Math.toRadians(2.0);

  const fixedOrbitalPosition = C.Cartesian3.fromDegrees(
    track.longitude,
    track.latitude,
    cameraHeight,
  );
  const measureEllipsoidRayCoverage = () => {
    const columns = 9;
    const rows = 9;
    let hits = 0;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const windowPosition = new C.Cartesian2(
          ((column + 0.5) / columns) * canvas.clientWidth,
          ((row + 0.5) / rows) * canvas.clientHeight,
        );
        if (scene.camera.pickEllipsoid(windowPosition, globe.ellipsoid)) {
          hits++;
        }
      }
    }
    return {
      hits,
      samples: columns * rows,
      fraction: hits / (columns * rows),
    };
  };
  const aimTarget = (target) => {
    const targetPosition = C.Cartesian3.fromDegrees(
      target.longitude,
      target.latitude,
      0.0,
    );
    const direction = C.Cartesian3.normalize(
      C.Cartesian3.subtract(
        targetPosition,
        fixedOrbitalPosition,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    let right = C.Cartesian3.cross(
      direction,
      C.Cartesian3.UNIT_Z,
      new C.Cartesian3(),
    );
    if (C.Cartesian3.magnitudeSquared(right) < 1.0e-12) {
      right = C.Cartesian3.cross(direction, C.Cartesian3.UNIT_Y, right);
    }
    C.Cartesian3.normalize(right, right);
    const up = C.Cartesian3.normalize(
      C.Cartesian3.cross(right, direction, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    scene.camera.setView({
      destination: fixedOrbitalPosition,
      orientation: { direction, up },
    });
    return {
      longitude: target.longitude,
      latitude: target.latitude,
      cameraPositionError: C.Cartesian3.distance(
        scene.camera.positionWC,
        fixedOrbitalPosition,
      ),
    };
  };
  const destinationAt = (bearingDegrees, angularDistanceDegrees) => {
    const latitude = C.Math.toRadians(track.latitude);
    const longitude = C.Math.toRadians(track.longitude);
    const bearing = C.Math.toRadians(bearingDegrees);
    const angularDistance = C.Math.toRadians(angularDistanceDegrees);
    const destinationLatitude = Math.asin(
      Math.sin(latitude) * Math.cos(angularDistance) +
        Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
    );
    const destinationLongitude =
      longitude +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
        Math.cos(angularDistance) -
          Math.sin(latitude) * Math.sin(destinationLatitude),
      );
    return {
      bearingDegrees,
      angularDistanceDegrees,
      longitude:
        ((C.Math.toDegrees(destinationLongitude) + 540.0) % 360.0) - 180.0,
      latitude: C.Math.toDegrees(destinationLatitude),
    };
  };
  const settleAim = async (target, gatePredicate, maxFrames) => {
    const aim = aimTarget(target);
    let loadedStreakForAim = 0;
    let matchingStreak = 0;
    let stableSelectionStreak = 0;
    let previousSelection = null;
    let frames = 0;
    let state = null;
    for (; frames < maxFrames; frames++) {
      renderNow();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      state = summarizeState();
      const selected = state.selectedTerrain;
      const selectionSignature = selected.ids.join(",");
      const resident =
        globe.tilesLoaded === true &&
        selected.count > 0 &&
        selected.renderedMeshCount > 0;
      loadedStreakForAim = resident ? loadedStreakForAim + 1 : 0;
      stableSelectionStreak =
        resident && selectionSignature === previousSelection
          ? stableSelectionStreak + 1
          : 0;
      previousSelection = selectionSignature;
      matchingStreak =
        resident && gatePredicate(state) ? matchingStreak + 1 : 0;
      if (
        frames >= 11 &&
        loadedStreakForAim >= 4 &&
        matchingStreak >= 3 &&
        stableSelectionStreak >= 3
      ) {
        break;
      }
      // Once a fully resident selection has repeatedly classified to the
      // opposite gate, additional frames cannot make this candidate useful.
      if (frames >= 23 && loadedStreakForAim >= 8 && matchingStreak === 0) {
        break;
      }
    }
    return {
      target: { ...target, ...aim },
      frames: Math.min(frames + 1, maxFrames),
      settled:
        loadedStreakForAim >= 4 &&
        matchingStreak >= 3 &&
        stableSelectionStreak >= 3,
      loadedStreak: loadedStreakForAim,
      matchingStreak,
      stableSelectionStreak,
      state,
    };
  };
  const isLocalGate = (state) =>
    state.blockActive === true &&
    state.blockGate > 0.5 &&
    state.blockGate < 2.5 &&
    state.sunInvRange > 0.0 &&
    state.moonInvRange > 0.0;
  const isCorrectionGate = (state) =>
    state.blockActive === true &&
    state.blockGate > 2.5 &&
    state.sunInvRange === 0.0 &&
    state.moonInvRange === 0.0;

  const insidePreload = await settleAim(
    {
      longitude: track.longitude,
      latitude: track.latitude,
      role: "inside-penumbra",
    },
    isLocalGate,
    90,
  );
  const outsideCandidates = [];
  for (const angularDistanceDegrees of [45.0, 50.0, 55.0]) {
    for (
      let bearingDegrees = 0.0;
      bearingDegrees < 360.0;
      bearingDegrees += 45.0
    ) {
      const candidate = destinationAt(bearingDegrees, angularDistanceDegrees);
      const score = observerScore(candidate.longitude, candidate.latitude);
      outsideCandidates.push({
        ...candidate,
        observerMagnitude: score.magnitude,
        observerTotalityMargin: score.totalityMargin,
      });
    }
  }
  outsideCandidates.sort(
    (left, right) =>
      left.angularDistanceDegrees - right.angularDistanceDegrees ||
      left.observerMagnitude - right.observerMagnitude,
  );

  let outsideDiscovery = null;
  const attemptedOutsideCandidates = [];
  if (insidePreload.settled) {
    for (
      let candidateIndex = 0;
      candidateIndex < Math.min(outsideCandidates.length, 12);
      candidateIndex++
    ) {
      const attempt = await settleAim(
        outsideCandidates[candidateIndex],
        isCorrectionGate,
        54,
      );
      attempt.ellipsoidRayCoverage = measureEllipsoidRayCoverage();
      attemptedOutsideCandidates.push(attempt);
      if (attempt.settled && attempt.ellipsoidRayCoverage.fraction > 0.95) {
        outsideDiscovery = attempt;
        break;
      }
    }
  }

  const transitionPngs = {};
  out.selectedTerrainTransition = {
    fixedOrbitalPosition: {
      x: fixedOrbitalPosition.x,
      y: fixedOrbitalPosition.y,
      z: fixedOrbitalPosition.z,
    },
    insidePreload,
    attemptedOutsideCandidates,
    outsideDiscovery,
    structuralError: null,
  };
  if (!insidePreload.settled) {
    out.selectedTerrainTransition.structuralError =
      "inside selected terrain did not settle to local S5 gate 1/2";
  } else if (!outsideDiscovery) {
    out.selectedTerrainTransition.structuralError =
      "no visible selected-terrain candidate settled to correction gate 3/4";
  } else {
    out.selectedTerrainTransition.outsideEllipsoidRayCoverage =
      measureEllipsoidRayCoverage();
    const outsideIdentity = await captureSettledConfiguration(false, true);
    const outsideS2Only = await captureSettledConfiguration(true, false);
    const outsideCorrection = await captureSettledConfiguration(true, true);
    transitionPngs.transitionOutsideIdentity = outsideIdentity.png;
    transitionPngs.transitionOutsideS2Only = outsideS2Only.png;
    transitionPngs.transitionOutsideCorrection = outsideCorrection.png;

    // The inside target was deliberately preloaded before leaving it. A
    // single render after changing only orientation must therefore classify
    // the new selected list immediately rather than leaking gate 3/4.
    setEclipseConfiguration(true, true);
    const insideFirstAim = aimTarget({
      longitude: track.longitude,
      latitude: track.latitude,
    });
    renderNow();
    const insideFirstFrame = {
      ...insideFirstAim,
      state: summarizeState(),
    };
    const insideReturn = await settleAim(
      {
        longitude: track.longitude,
        latitude: track.latitude,
        role: "inside-return",
      },
      isLocalGate,
      54,
    );
    const insideIdentity = await captureSettledConfiguration(false, true);
    const insideLocal = await captureSettledConfiguration(true, true);
    transitionPngs.transitionInsideIdentity = insideIdentity.png;
    transitionPngs.transitionInsideLocal = insideLocal.png;

    // The first reverse render conservatively keeps local geometry while the
    // quadtree emits fallback/root tiles. Once the exact outside selection
    // settles, gate 3/4 with zero body ranges must replace those local rays.
    setEclipseConfiguration(true, true);
    const reverseAim = aimTarget(outsideDiscovery.target);
    renderNow();
    const outsideReverseFirstFrame = {
      ...reverseAim,
      state: summarizeState(),
    };
    const outsideReverse = await settleAim(
      {
        ...outsideDiscovery.target,
        role: "outside-reverse",
      },
      isCorrectionGate,
      54,
    );

    out.selectedTerrainTransition.outside = {
      identity: {
        stats: analyze(outsideIdentity.image),
        state: outsideIdentity.state,
        settle: outsideIdentity.settle,
      },
      s2Only: {
        stats: analyze(outsideS2Only.image),
        state: outsideS2Only.state,
        settle: outsideS2Only.settle,
      },
      correction: {
        stats: analyze(outsideCorrection.image),
        state: outsideCorrection.state,
        settle: outsideCorrection.settle,
      },
      s2OnlyVsIdentity: compare(outsideIdentity.image, outsideS2Only.image),
      s2OnlyVsCorrection: compare(outsideS2Only.image, outsideCorrection.image),
      correctionVsIdentity: compare(
        outsideIdentity.image,
        outsideCorrection.image,
      ),
    };
    out.selectedTerrainTransition.insideFirstFrame = insideFirstFrame;
    out.selectedTerrainTransition.insideReturn = insideReturn;
    out.selectedTerrainTransition.inside = {
      identity: {
        stats: analyze(insideIdentity.image),
        state: insideIdentity.state,
        settle: insideIdentity.settle,
      },
      local: {
        stats: analyze(insideLocal.image),
        state: insideLocal.state,
        settle: insideLocal.settle,
      },
    };
    const outsideIdentityAllocations =
      outsideIdentity.state.uniformAllocator?.currentFrameAllocations;
    const outsideCorrectionAllocations =
      outsideCorrection.state.uniformAllocator?.currentFrameAllocations;
    const insideIdentityAllocations =
      insideIdentity.state.uniformAllocator?.currentFrameAllocations;
    const insideLocalAllocations =
      insideLocal.state.uniformAllocator?.currentFrameAllocations;
    out.selectedTerrainTransition.uniformAllocatorDeltas = {
      outsideCorrectionVsGate0:
        Number.isFinite(outsideIdentityAllocations) &&
        Number.isFinite(outsideCorrectionAllocations)
          ? outsideCorrectionAllocations - outsideIdentityAllocations
          : null,
      insideLocalVsGate0:
        Number.isFinite(insideIdentityAllocations) &&
        Number.isFinite(insideLocalAllocations)
          ? insideLocalAllocations - insideIdentityAllocations
          : null,
    };
    out.selectedTerrainTransition.outsideReverseFirstFrame =
      outsideReverseFirstFrame;
    out.selectedTerrainTransition.outsideReverse = outsideReverse;
  }
  out.pngs = {
    eclipseOff: eclipseOff.png,
    eclipseOn: eclipseOn.png,
    controlOff: controlOff.png,
    controlOn: controlOn.png,
    ...transitionPngs,
  };
  return out;
};

async function runBackend(browser, renderer) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const errors = [];
  const ignoredErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = `console: ${message.text()}`.slice(0, 500);
      // CesiumViewer's development HTML still requests two obsolete widget
      // stylesheet paths. The server returns its HTML fallback, so Chromium
      // reports a MIME error. It is unrelated to either rendering context and
      // is retained in the report without being counted as a renderer error.
      if (
        text.includes("/engine/Source/Widget/") &&
        text.includes("MIME type")
      ) {
        ignoredErrors.push(text);
      } else {
        errors.push(text);
      }
    }
  });
  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`.slice(0, 500));
  });

  const result = { requestedRenderer: renderer, errors, ignoredErrors };
  try {
    await page.addInitScript(errorGateInit);
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`,
      { waitUntil: "domcontentloaded", timeout: 90_000 },
    );
    await page.waitForFunction(
      () => Boolean(window.viewer?.scene?.context),
      undefined,
      { timeout: 90_000 },
    );
    result.gpuGateArm = await armWebGPUDevices(page);
    result.measurement = await page.evaluate(MEASURE, {
      eclipseIso: ECLIPSE_ISO,
      controlIso: CONTROL_ISO,
      cameraHeight: CAMERA_HEIGHT,
      solarRadius: SOLAR_RADIUS,
      lunarRadius: LUNAR_RADIUS,
    });
    await page.waitForTimeout(100);
    result.gpuGate = await collectGateErrors(page);
    const pngs = result.measurement?.pngs ?? {};
    result.artifacts = [];
    for (const [lane, dataUrl] of Object.entries(pngs)) {
      if (
        typeof dataUrl !== "string" ||
        !dataUrl.startsWith("data:image/png;base64,")
      ) {
        continue;
      }
      const file = path.join(
        OUT_DIR,
        `eclipse-globe-shadow-${renderer}-${lane}.png`,
      );
      fs.writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"));
      result.artifacts.push(file.replaceAll("\\", "/"));
    }
    if (result.measurement) {
      delete result.measurement.pngs;
    }
  } catch (error) {
    result.structuralError = String(error?.stack ?? error).slice(0, 1000);
  } finally {
    await context.close().catch(() => {});
  }
  return result;
}

function judge(side) {
  const measurement = side.measurement ?? {};
  const eclipse = measurement.eclipse ?? {};
  const control = measurement.control ?? {};
  const transition = measurement.selectedTerrainTransition ?? {};
  const outside = transition.outside ?? {};
  const outsideIdentity = outside.identity ?? {};
  const outsideS2Only = outside.s2Only ?? {};
  const outsideCorrection = outside.correction ?? {};
  const insideIdentity = transition.inside?.identity ?? {};
  const insideLocal = transition.inside?.local ?? {};
  const insideFirst = transition.insideFirstFrame?.state ?? {};
  const outsideReverseFirst = transition.outsideReverseFirstFrame?.state ?? {};
  const outsideReverse = transition.outsideReverse?.state ?? {};
  const eclipseDiff = eclipse.diff ?? {};
  const controlDiff = control.diff ?? {};
  const s2OnlyDiff = outside.s2OnlyVsIdentity ?? {};
  const s2RecoveryDiff = outside.s2OnlyVsCorrection ?? {};
  const correctionDiff = outside.correctionVsIdentity ?? {};
  const sameSelectedIds = (...states) => {
    const signatures = states.map((state) =>
      state?.selectedTerrain?.ids?.join(","),
    );
    return (
      signatures.length > 1 &&
      typeof signatures[0] === "string" &&
      signatures[0].length > 0 &&
      signatures.every((signature) => signature === signatures[0])
    );
  };
  const selectionIsPrepared = (state) =>
    state?.prepared === true &&
    Number.isFinite(state?.preparedSurfaceRadius) &&
    state.preparedSurfaceRadius > 0.0 &&
    Number.isFinite(state?.preparedSelectionRevision) &&
    state.preparedSelectionRevision ===
      state?.selectedTerrain?.providerSelectionRevision &&
    (state?.selectedTerrain?.count ?? 0) > 0 &&
    (state?.selectedTerrain?.renderedMeshCount ?? 0) > 0 &&
    (state?.selectedTerrain?.ids?.length ?? 0) ===
      state?.selectedTerrain?.count;
  const isLocalState = (state) =>
    state?.blockActive === true &&
    state.blockGate > 0.5 &&
    state.blockGate < 2.5 &&
    state.sunInvRange > 0.0 &&
    state.moonInvRange > 0.0;
  const isCorrectionState = (state) =>
    state?.blockActive === true &&
    state.blockGate > 2.5 &&
    state.blockGate < 4.5 &&
    state.sunInvRange === 0.0 &&
    state.moonInvRange === 0.0;
  const verdict = {
    rendererResolved:
      measurement.rendererType === side.requestedRenderer &&
      !side.structuralError,
    noStructuralError: !side.structuralError && !measurement.structuralError,
    noBrowserErrors: side.errors.length === 0,
    gpuErrorGateClean:
      (side.gpuGate?.errors?.length ?? 0) === 0 &&
      !side.gpuGate?.deviceLost &&
      (side.requestedRenderer !== "webgpu" ||
        (side.gpuGate?.armedDevices ?? 0) > 0),
    offlineGlobeReady:
      measurement.imagery === "NaturalEarthII-local" &&
      measurement.tilesSettled === true &&
      measurement.visibleTiles > 0,
    fixtureIsDeep: (measurement.track?.magnitude ?? 0.0) > 0.95,
    capturesAreNonblank:
      (eclipse.off?.stats?.nonBlackPct ?? 0.0) > 0.2 &&
      (eclipse.on?.stats?.nonBlackPct ?? 0.0) > 0.2 &&
      (eclipse.off?.stats?.colorBuckets ?? 0) > 80,
    s5ToggleReachedBlock:
      eclipse.off?.state?.blockActive === false &&
      eclipse.on?.state?.blockActive === true &&
      (eclipse.on?.state?.blockGate ?? 0.0) > 0.5,
    umbraVisiblyDarkens:
      (eclipseDiff.changedPixels ?? 0) > 500 &&
      (eclipseDiff.darkenedPixels ?? 0) >
        10 * Math.max(1, eclipseDiff.brightenedPixels ?? 0) &&
      (eclipseDiff.strongDarkenedPixels ?? 0) > 100 &&
      (eclipseDiff.maxLuminanceDrop ?? 0.0) > 40.0 &&
      (eclipseDiff.meanLuminanceDrop ?? 0.0) > 0.1,
    umbraIsLocalized:
      (eclipseDiff.strongDarkenedPctVisible ?? 1.0) > 0.0001 &&
      (eclipseDiff.strongDarkenedPctVisible ?? 1.0) < 0.8 &&
      (eclipseDiff.unchangedVisiblePixels ?? 0) > 1000,
    nonEclipseIsIdentity:
      control.on?.state?.blockActive === false &&
      (controlDiff.changedPixels ?? Number.POSITIVE_INFINITY) <= 8 &&
      (controlDiff.maxChannelDelta ?? Number.POSITIVE_INFINITY) <= 4,
    selectedTerrainTransitionDiscovered:
      !transition.structuralError &&
      transition.insidePreload?.settled === true &&
      transition.outsideDiscovery?.settled === true &&
      (transition.outsideDiscovery?.target?.cameraPositionError ??
        Number.POSITIVE_INFINITY) < 1.0e-3,
    selectedTerrainEvidenceIsPrepared:
      selectionIsPrepared(outsideCorrection.state) &&
      selectionIsPrepared(insideFirst) &&
      selectionIsPrepared(insideLocal.state) &&
      selectionIsPrepared(outsideReverse),
    comparedCapturesKeepExactSelection:
      sameSelectedIds(
        outsideIdentity.state,
        outsideS2Only.state,
        outsideCorrection.state,
      ) &&
      sameSelectedIds(insideIdentity.state, insideLocal.state) &&
      outsideIdentity.settle?.stableSelectionStreak >= 3 &&
      outsideS2Only.settle?.stableSelectionStreak >= 3 &&
      outsideCorrection.settle?.stableSelectionStreak >= 3 &&
      insideIdentity.settle?.stableSelectionStreak >= 3 &&
      insideLocal.settle?.stableSelectionStreak >= 3,
    correctionOnlyHasNoBodyGeometry:
      outsideIdentity.state?.blockActive === false &&
      outsideS2Only.state?.blockActive === false &&
      isCorrectionState(outsideCorrection.state),
    correctionRestoresS2OutsideFootprint:
      (outsideCorrection.state?.moonObscuration ?? 0.0) > 0.001 &&
      (outsideCorrection.state?.sceneLightFactor ?? 1.0) < 0.999 &&
      (transition.outsideEllipsoidRayCoverage?.fraction ?? 0.0) > 0.95 &&
      (correctionDiff.changedPctVisible ?? Number.POSITIVE_INFINITY) < 0.005 &&
      (correctionDiff.maxChannelDelta ?? Number.POSITIVE_INFINITY) <= 8 &&
      Math.abs(correctionDiff.meanLuminanceDrop ?? Number.POSITIVE_INFINITY) <
        0.2 &&
      Math.abs(correctionDiff.meanLuminanceDrop) <
        0.85 * Math.abs(s2OnlyDiff.meanLuminanceDrop ?? 0.0) &&
      (s2RecoveryDiff.meanLuminanceDrop ?? 0.0) < -0.02,
    s2OnlyIsNonVacuousNegativeControl:
      (s2OnlyDiff.meanLuminanceDrop ?? 0.0) > 0.02 &&
      (s2OnlyDiff.maxChannelDelta ?? 0.0) >= 1.0 &&
      (s2RecoveryDiff.meanLuminanceDrop ?? 0.0) < -0.02,
    firstInsideFrameActivatesLocalGeometry:
      (transition.insideFirstFrame?.cameraPositionError ??
        Number.POSITIVE_INFINITY) < 1.0e-3 &&
      isLocalState(insideFirst) &&
      Number.isFinite(insideFirst.blockRevision) &&
      insideFirst.blockRevision !== outsideCorrection.state?.blockRevision,
    reverseFirstFrameIsConservativeFallback:
      (transition.outsideReverseFirstFrame?.cameraPositionError ??
        Number.POSITIVE_INFINITY) < 1.0e-3 &&
      isLocalState(outsideReverseFirst) &&
      (outsideReverseFirst.selectedTerrain?.count ?? 0) > 0,
    reverseSettlesAndClearsLocalGeometry:
      transition.outsideReverse?.settled === true &&
      transition.outsideReverse?.stableSelectionStreak >= 3 &&
      isCorrectionState(outsideReverse) &&
      Number.isFinite(outsideReverse.blockRevision) &&
      outsideReverse.blockRevision !== insideLocal.state?.blockRevision,
    correctionCarrierIsOneViewAllocation:
      side.requestedRenderer !== "webgpu" ||
      ((outsideCorrection.state?.selectedTerrain?.count ?? 0) > 1 &&
        (insideLocal.state?.selectedTerrain?.count ?? 0) > 1 &&
        transition.uniformAllocatorDeltas?.outsideCorrectionVsGate0 === 1 &&
        transition.uniformAllocatorDeltas?.insideLocalVsGate0 === 1),
    transitionCapturesAreNonblank:
      (outsideIdentity.stats?.nonBlackPct ?? 0.0) > 0.2 &&
      (outsideS2Only.stats?.nonBlackPct ?? 0.0) > 0.2 &&
      (outsideCorrection.stats?.nonBlackPct ?? 0.0) > 0.2,
  };
  return { ...verdict, PASS: Object.values(verdict).every(Boolean) };
}

const provenance = verifyBuildContainsS5();
if (!provenance.ok) {
  console.error(
    "[probe-eclipse-globe-shadow] stale/missing S5 build:",
    JSON.stringify(provenance, null, 2),
  );
  process.exit(2);
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: !HEADED,
  args: ["--enable-unsafe-webgpu"],
});
let webgl;
let webgpu;
try {
  webgl = await runBackend(browser, "webgl");
  webgpu = await runBackend(browser, "webgpu");
} finally {
  await browser.close().catch(() => {});
}

const verdicts = {
  webgl: judge(webgl),
  webgpu: judge(webgpu),
};
const glDiff = webgl.measurement?.eclipse?.diff ?? {};
const gpuDiff = webgpu.measurement?.eclipse?.diff ?? {};
const glBounds = glDiff.changedBounds;
const gpuBounds = gpuDiff.changedBounds;
const boundsEdgeDelta =
  glBounds && gpuBounds
    ? Math.max(
        Math.abs(glBounds.minX - gpuBounds.minX),
        Math.abs(glBounds.minY - gpuBounds.minY),
        Math.abs(glBounds.maxX - gpuBounds.maxX),
        Math.abs(glBounds.maxY - gpuBounds.maxY),
      )
    : Number.POSITIVE_INFINITY;
const changedCoverageDelta = Math.abs(
  (glDiff.changedPctVisible ?? 0.0) - (gpuDiff.changedPctVisible ?? 0.0),
);
const strongCoverageDelta = Math.abs(
  (glDiff.strongDarkenedPctVisible ?? 0.0) -
    (gpuDiff.strongDarkenedPctVisible ?? 0.0),
);
const meanDropRelativeDelta =
  (glDiff.meanLuminanceDrop ?? 0.0) > 0.0
    ? Math.abs(
        (glDiff.meanLuminanceDrop ?? 0.0) - (gpuDiff.meanLuminanceDrop ?? 0.0),
      ) / glDiff.meanLuminanceDrop
    : Number.POSITIVE_INFINITY;
const parity = {
  changedCoverageDelta,
  strongCoverageDelta,
  meanDropRelativeDelta,
  boundsEdgeDelta,
  coverageAligned: changedCoverageDelta < 0.03,
  strongCoreAligned: strongCoverageDelta < 0.02,
  meanDarkeningAligned: meanDropRelativeDelta < 0.1,
  footprintAligned: boundsEdgeDelta <= 8,
};
parity.PASS =
  parity.coverageAligned &&
  parity.strongCoreAligned &&
  parity.meanDarkeningAligned &&
  parity.footprintAligned;
const pass = verdicts.webgl.PASS && verdicts.webgpu.PASS && parity.PASS;
const report = {
  probe: "probe-eclipse-globe-shadow",
  task: "C12-29 S5 per-fragment globe-surface umbra",
  date: new Date().toISOString(),
  fixture: {
    eclipseIso: ECLIPSE_ISO,
    controlIso: CONTROL_ISO,
    cameraHeight: CAMERA_HEIGHT,
    viewport: VIEWPORT,
  },
  provenance,
  verdicts,
  parity,
  raw: { webgl, webgpu },
  GATE: pass
    ? "PASS — both backends render a localized S5 umbra, certify selected-terrain correction/local transitions, and keep inactive controls identity"
    : "FAIL — S5 browser evidence did not satisfy every renderer/identity/transition gate",
};
const reportFile = path.join(OUT_DIR, "eclipse-globe-shadow-report.json");
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

console.log(JSON.stringify({ verdicts, parity, raw: report.raw }, null, 2));
console.log(`report: ${reportFile.replaceAll("\\", "/")}`);
console.log(`RESULT: ${pass ? "PASS" : "FAIL"}`);
clearTimeout(watchdog);
process.exit(pass ? 0 : 1);
