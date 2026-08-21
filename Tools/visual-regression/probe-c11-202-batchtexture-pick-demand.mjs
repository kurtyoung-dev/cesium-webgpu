#!/usr/bin/env node
/**
 * C11-202 browser gate: ordinary native model picking must not realize the
 * legacy BatchTexture pick registry/texture first. WebGL remains authoritative;
 * @purpose Gate that ordinary model picking does not realize the legacy BatchTexture pick registry/texture first; verifies picked feature properties.
 * @status ACTIVE
 *
 * focused source-policy checks protect post-process and classifier ownership.
 *
 * Run after rebuilding:
 *   node Tools/visual-regression/probe-c11-202-batchtexture-pick-demand.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUTPUT = path.resolve(
  "Tools/visual-regression/output/c11-202-batchtexture-pick-demand.json",
);
const FIRST_RED = path.resolve(
  "Tools/visual-regression/output/c11-202-batchtexture-pick-demand.first-red.json",
);
const TILESET =
  "/Apps/SampleData/Cesium3DTiles/Hierarchy/BatchTableHierarchy/tileset.json";
const WATCHDOG_MS = 720_000;
const HARD_STOP_GRACE_MS = 15_000;
const CLOSE_TIMEOUT_MS = 10_000;

async function closeOperationBounded(closeOperation, label) {
  if (typeof closeOperation !== "function") {
    return { attempted: false, closed: true, timedOut: false, error: null };
  }
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(closeOperation)
        .then(() => ({
          attempted: true,
          closed: true,
          timedOut: false,
          error: null,
        }))
        .catch((error) => ({
          attempted: true,
          closed: false,
          timedOut: false,
          error: label + " close failed: " + (error?.message ?? error),
        })),
      new Promise((resolve) => {
        timeout = setTimeout(
          () =>
            resolve({
              attempted: true,
              closed: false,
              timedOut: true,
              error: label + " close exceeded " + CLOSE_TIMEOUT_MS + " ms",
            }),
          CLOSE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
const EXPECTED_FEATURE = {
  featureId: 28,
  propertyIds: [
    "area",
    "building_area",
    "building_name",
    "height",
    "roof_name",
    "roof_paint",
    "zone_buildings",
    "zone_name",
  ],
  properties: {
    area: 12,
    building_area: 39.3,
    building_name: "building2",
    height: 6,
    roof_name: "roof2",
    roof_paint: "yellow",
    zone_buildings: 3,
    zone_name: "zone0",
  },
};

function inspectSourcePolicy() {
  const sourcePaths = {
    batchTexture: path.resolve("packages/engine/Source/Scene/BatchTexture.js"),
    modelFeatureTable: path.resolve(
      "packages/engine/Source/Scene/Model/ModelFeatureTable.js",
    ),
    model: path.resolve("packages/engine/Source/Scene/Model/Model.js"),
    classicBatchTable: path.resolve(
      "packages/engine/Source/Scene/Cesium3DTileBatchTable.js",
    ),
    nativeRenderer: path.resolve(
      "packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts",
    ),
  };
  const compact = (value) => value.replace(/\s+/g, " ");
  const source = Object.fromEntries(
    Object.entries(sourcePaths).map(([key, filename]) => [
      key,
      compact(fs.readFileSync(filename, "utf8")),
    ]),
  );
  const checks = {
    batchTextureOverrideKeepsDefault: source.batchTexture.includes(
      "legacyPickTextureDemand ?? (passes.pick || passes.postProcess)",
    ),
    modelUsesExactRendererOwnership: source.model.includes(
      "defined(modelFeatureRenderer) && !defined(this.classificationType)",
    ),
    modelPreservesPostProcess: source.model.includes(
      "passes.postProcess === true || (passes.pick === true && !nativeOwnsDensePick)",
    ),
    featureTableThreadsExplicitDemand: source.modelFeatureTable.includes(
      "this._batchTexture.update(undefined, frameState, legacyPickTextureDemand)",
    ),
    webglAndOtherCallersKeepDefault: source.classicBatchTable.includes(
      "this._batchTexture.update(tileset, frameState)",
    ),
    nativePickRequiresPermission: source.nativeRenderer.includes(
      "passes?.pick === true && !isClassifier && model.allowPicking !== false",
    ),
    resolvedRendererIsReused:
      source.model.includes(
        "buildDrawCommands( this, frameState, modelFeatureRenderer, )",
      ) &&
      source.model.includes(
        "submitDrawCommands(this, frameState, modelFeatureRenderer)",
      ),
  };
  const failures = Object.entries(checks)
    .filter(([, pass]) => !pass)
    .map(([name]) => name + " source policy check failed");
  const pass = failures.length === 0;
  return {
    status: pass ? "PASS" : "FAIL",
    pass,
    checks,
    failures,
    files: sourcePaths,
  };
}

function runFixtureLaneInPage(options) {
  return (async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const viewer = window.viewer;
    const scene = viewer.scene;
    const context = scene.context;
    const device = context?._device ?? context?.device;
    const expectsWebGPU = options.renderer === "webgpu";
    if (expectsWebGPU !== Boolean(device)) {
      throw new Error(
        "renderer mismatch: expected " +
          options.renderer +
          ", device=" +
          Boolean(device),
      );
    }

    viewer.useDefaultRenderLoop = false;
    scene.requestRenderMode = false;
    scene.rethrowRenderErrors = true;
    viewer.terrainProvider = new C.EllipsoidTerrainProvider();
    if (scene.globe) scene.globe.show = false;
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.backgroundColor = C.Color.BLACK.clone();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const objectIds = new WeakMap();
    let nextObjectId = 1;
    const objectId = (value) => {
      if (
        (typeof value !== "object" && typeof value !== "function") ||
        !value
      ) {
        return null;
      }
      let id = objectIds.get(value);
      if (!id) {
        id = "o" + nextObjectId++;
        objectIds.set(value, id);
      }
      return id;
    };
    const models = new Set();
    const contents = new Set();
    const batchTextures = new Set();
    const featureTargets = new WeakSet();
    const activeBatchUpdates = [];
    const blankCounters = () => ({
      nativeFeaturePickTextures: 0,
      nativeFeaturePickTextureUploads: 0,
      createPickIds: 0,
      genericModelPickIds: 0,
      nativeTileFeaturePickIds: 0,
      legacyTileFeaturePickIds: 0,
      unscopedPickIds: 0,
      batchTextureUpdates: 0,
      legacyPickIdArrayGrowth: 0,
      legacyPickTexturePublications: 0,
      legacyPickTextureUploads: 0,
      legacyPickTextureReplacements: 0,
    });
    const monitor = {
      phase: "bootstrap",
      buckets: { bootstrap: blankCounters() },
      deviceErrors: [],
    };
    const bucket = () => monitor.buckets[monitor.phase];
    const setPhase = (name) => {
      monitor.phase = name;
      monitor.buckets[name] = blankCounters();
    };
    const patchMethod = (host, name, observe) => {
      const original = host?.[name];
      if (typeof original !== "function") return;
      host[name] = function (...args) {
        observe(args);
        return original.apply(this, args);
      };
    };

    if (device) {
      const devicePrototype = Object.getPrototypeOf(device);
      patchMethod(devicePrototype, "createTexture", ([descriptor]) => {
        const current = bucket();
        const label = descriptor?.label ?? "";
        if (label.startsWith("Feature pick texture")) {
          current.nativeFeaturePickTextures++;
        }
      });

      const queuePrototype = Object.getPrototypeOf(device.queue);
      patchMethod(queuePrototype, "writeTexture", (args) => {
        const current = bucket();
        const label = args[0]?.texture?.label ?? "";
        if (label.startsWith("Feature pick texture")) {
          current.nativeFeaturePickTextureUploads++;
        }
      });
    }

    const batchTexturePrototype = C.BatchTexture?.prototype;
    const originalBatchTextureUpdate = batchTexturePrototype?.update;
    if (typeof originalBatchTextureUpdate !== "function") {
      throw new Error("BatchTexture.update instrumentation is unavailable");
    }
    batchTexturePrototype.update = function (...args) {
      const relevant = batchTextures.has(this);
      const beforeTexture = this._pickTexture;
      const beforePickIds = (this._pickIds ?? []).filter(Boolean).length;
      activeBatchUpdates.push({ texture: this, relevant });
      try {
        return originalBatchTextureUpdate.apply(this, args);
      } finally {
        activeBatchUpdates.pop();
        if (relevant) {
          const current = bucket();
          const afterPickIds = (this._pickIds ?? []).filter(Boolean).length;
          current.batchTextureUpdates++;
          current.legacyPickIdArrayGrowth += Math.max(
            0,
            afterPickIds - beforePickIds,
          );
          if (this._pickTexture && this._pickTexture !== beforeTexture) {
            current.legacyPickTexturePublications++;
            current.legacyPickTextureUploads++;
            if (beforeTexture) current.legacyPickTextureReplacements++;
          }
        }
      }
    };

    const originalCreatePickId = context.createPickId;
    context.createPickId = function (target, kind) {
      const current = bucket();
      current.createPickIds++;
      const active = activeBatchUpdates[activeBatchUpdates.length - 1];
      let attributed = false;
      if (kind === "tile-feature" && active?.relevant) {
        current.legacyTileFeaturePickIds++;
        attributed = true;
      } else if (kind === "tile-feature" && featureTargets.has(target)) {
        current.nativeTileFeaturePickIds++;
        attributed = true;
      } else if (kind === "primitive" && models.has(target?.primitive)) {
        current.genericModelPickIds++;
        attributed = true;
      }
      if (!attributed) current.unscopedPickIds++;
      return originalCreatePickId.call(this, target, kind);
    };

    if (device) {
      device.onuncapturederror = (event) => {
        monitor.deviceErrors.push(
          String(event?.error?.message ?? event).slice(0, 500),
        );
      };
      device.lost.then((info) => {
        monitor.deviceErrors.push(
          "device-lost: " + info?.reason + ": " + info?.message,
        );
      });
      device.pushErrorScope("validation");
    }
    scene.renderError.addEventListener((_scene, error) => {
      monitor.deviceErrors.push("render-error: " + String(error).slice(0, 500));
    });

    let tileset;
    const collectModelFeatures = (model) => {
      if (!model) return;
      models.add(model);
      for (const table of model.featureTables ?? []) {
        const texture = table?.batchTexture;
        if (texture) batchTextures.add(texture);
        const length = table?.featuresLength ?? 0;
        for (let featureId = 0; featureId < length; featureId++) {
          const feature = table.getFeature?.(featureId);
          if (feature) featureTargets.add(feature);
        }
      }
    };
    const collectContent = (content) => {
      if (!content) return;
      contents.add(content);
      collectModelFeatures(content._model);
      const table = content.batchTable;
      if (table?.batchTexture) {
        batchTextures.add(table.batchTexture);
        for (let featureId = 0; featureId < table.featuresLength; featureId++) {
          const feature = content.getFeature?.(featureId);
          if (feature) featureTargets.add(feature);
        }
      }
      for (const inner of content.innerContents ?? []) collectContent(inner);
    };
    const collectModels = (tile) => {
      if (!tile) return;
      collectContent(tile.content);
      for (const child of tile.children ?? []) collectModels(child);
    };
    const fixedTime = C.JulianDate.fromIso8601("2026-08-10T12:00:00Z");
    const renderFrame = async () => {
      scene.render(fixedTime);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (tileset) collectModels(tileset.root);
    };
    const snapshot = () => {
      const batchRows = [];
      let legacyPickIds = 0;
      let legacyPickTextures = 0;
      let legacySemanticTargets = 0;
      for (const texture of batchTextures) {
        const pickIds = (texture?._pickIds ?? []).filter(Boolean);
        let semanticTargets = 0;
        for (let featureId = 0; featureId < pickIds.length; featureId++) {
          const expectedTarget = texture._owner?.getFeature?.(featureId);
          if (pickIds[featureId]?.object === expectedTarget) semanticTargets++;
        }
        legacyPickIds += pickIds.length;
        legacyPickTextures += texture?._pickTexture ? 1 : 0;
        legacySemanticTargets += semanticTargets;
        batchRows.push({
          texture: objectId(texture),
          owner: objectId(texture?._owner),
          featuresLength: texture?._featuresLength ?? null,
          dimensions: [
            texture?._textureDimensions?.x ?? null,
            texture?._textureDimensions?.y ?? null,
          ],
          pickIds: pickIds.map(objectId),
          pickIdKeys: pickIds.map((pickId) => pickId?.key ?? null),
          semanticTargets,
          pickTexture: objectId(texture?._pickTexture),
          byteLength: texture?.byteLength ?? null,
        });
      }

      const modelRows = [];
      let nativeGenericPickIds = 0;
      let nativeDenseFeaturePickIds = 0;
      let nativeFeaturePickTextures = 0;
      let nativeSemanticTargets = 0;
      let nativeCacheCount = 0;
      for (const model of models) {
        const cache = model?._webgpuCache;
        if (cache) nativeCacheCount++;
        const generic = Object.values(cache?.pickIds ?? {});
        const denseEntries = [
          ...(cache?._featurePickIds?.entries?.() ?? []),
        ].sort((left, right) => left[0] - right[0]);
        let modelSemanticTargets = 0;
        const featureTable = model.featureTables?.[model.featureTableId];
        for (const [featureId, pickId] of denseEntries) {
          if (pickId?.object === featureTable?.getFeature?.(featureId)) {
            modelSemanticTargets++;
          }
        }
        nativeGenericPickIds += generic.length;
        nativeDenseFeaturePickIds += denseEntries.length;
        nativeFeaturePickTextures += cache?._featurePickGPUTexture ? 1 : 0;
        nativeSemanticTargets += modelSemanticTargets;
        modelRows.push({
          model: objectId(model),
          cache: objectId(cache),
          nativeGenericPickIds: generic.map(objectId),
          nativeDenseFeaturePickIds: denseEntries.map(([, pickId]) =>
            objectId(pickId),
          ),
          nativeDenseFeaturePickIdKeys: denseEntries.map(
            ([featureId, pickId]) => [featureId, pickId?.key ?? null],
          ),
          nativeSemanticTargets: modelSemanticTargets,
          nativeFeaturePickTexture: objectId(cache?._featurePickGPUTexture),
          nativeFeaturePickFeaturesLength:
            cache?._featurePickFeaturesLength ?? null,
        });
      }
      return {
        modelCount: models.size,
        batchTextureCount: batchTextures.size,
        nativeCacheCount,
        legacyPickIds,
        legacyPickTextures,
        legacySemanticTargets,
        nativeGenericPickIds,
        nativeDenseFeaturePickIds,
        nativeFeaturePickTextures,
        nativeSemanticTargets,
        batchRows,
        models: modelRows,
      };
    };
    const retainedSignature = (snap) =>
      JSON.stringify({
        legacy: snap.batchRows.map((row) => ({
          texture: row.texture,
          ids: row.pickIds,
          pickTexture: row.pickTexture,
        })),
        native: snap.models.map((model) => ({
          model: model.model,
          generic: model.nativeGenericPickIds,
          dense: model.nativeDenseFeaturePickIds,
          texture: model.nativeFeaturePickTexture,
        })),
      });

    setPhase("coldColor");
    const tilesetOptions = { maximumScreenSpaceError: 1 };
    tileset = await C.Cesium3DTileset.fromUrl(options.tileset, tilesetOptions);
    scene.primitives.add(tileset);
    tileset.tileVisible.addEventListener((tile) => collectModels(tile));
    const sphere = tileset.boundingSphere;
    const cartographic = C.Cartographic.fromCartesian(sphere.center);
    viewer.camera.setView({
      destination: C.Cartesian3.fromRadians(
        cartographic.longitude,
        cartographic.latitude,
        cartographic.height + sphere.radius * 2.5,
      ),
      orientation: {
        heading: 0,
        pitch: -C.Math.PI_OVER_TWO,
        roll: 0,
      },
    });

    let warmFrames = 0;
    let readyStreak = 0;
    const warmDeadline = performance.now() + 60_000;
    while (warmFrames < 900 && performance.now() < warmDeadline) {
      await renderFrame();
      warmFrames++;
      const current = snapshot();
      const pending = context.asyncResources?.pendingForegroundCount ?? 0;
      const nativeReady = !expectsWebGPU || current.nativeCacheCount === 1;
      const ready =
        tileset.tilesLoaded === true &&
        pending === 0 &&
        current.modelCount === 1 &&
        current.batchTextureCount === 1 &&
        current.batchRows[0]?.featuresLength === 30 &&
        nativeReady;
      readyStreak = ready ? readyStreak + 1 : 0;
      if (readyStreak >= 4) break;
    }
    await renderFrame();
    const cold = snapshot();

    const findExpectedFeature = () => {
      for (const content of contents) {
        const feature = content.getFeature?.(options.expected.featureId);
        if (feature) return feature;
      }
      for (const model of models) {
        const table = model.featureTables?.[model.featureTableId];
        const feature = table?.getFeature?.(options.expected.featureId);
        if (feature) return feature;
      }
      return undefined;
    };
    const expectedFeature = findExpectedFeature();
    const findTarget = () => {
      scene.render(fixedTime);
      const sourceCanvas = scene.canvas;
      const scratch = document.createElement("canvas");
      scratch.width = sourceCanvas.width;
      scratch.height = sourceCanvas.height;
      const scratchContext = scratch.getContext("2d", {
        willReadFrequently: true,
      });
      scratchContext.drawImage(sourceCanvas, 0, 0);
      const image = scratchContext.getImageData(
        0,
        0,
        scratch.width,
        scratch.height,
      );
      let nonBlackPixels = 0;
      for (
        let index = 0, pixel = 0;
        index < scratch.width * scratch.height;
        index++, pixel += 4
      ) {
        const lit =
          image.data[pixel] > 12 ||
          image.data[pixel + 1] > 12 ||
          image.data[pixel + 2] > 12;
        nonBlackPixels += lit ? 1 : 0;
      }
      const bestX = Math.floor(scratch.width / 2);
      const bestY = Math.floor(scratch.height / 2);
      return {
        x:
          bestX /
          (sourceCanvas.width /
            (sourceCanvas.clientWidth || sourceCanvas.width)),
        y:
          bestY /
          (sourceCanvas.height /
            (sourceCanvas.clientHeight || sourceCanvas.height)),
        backing: [bestX, bestY],
        nonBlackPixels,
      };
    };
    const target = findTarget();
    const describeHit = (hit) => {
      if (!hit) return { found: false };
      const propertyIds =
        typeof hit.getPropertyIds === "function"
          ? hit.getPropertyIds().slice().sort()
          : [];
      const properties = {};
      for (const id of propertyIds) properties[id] = hit.getProperty(id);
      return {
        found: true,
        identity: objectId(hit),
        expectedIdentity: objectId(expectedFeature),
        matchesExpectedObject: hit === expectedFeature,
        ctor: hit.constructor?.name ?? null,
        isTileFeature: typeof hit.getProperty === "function",
        featureId: hit.featureId ?? hit._batchId ?? null,
        propertyIds,
        properties,
      };
    };
    const cursor = new C.Cartesian2(target.x, target.y);
    // WebGPU's public async pick waits for its command submission/readback.
    // WebGL has an exact synchronous pick path; using pickAsync there can wait
    // for a cache bridge that this backend does not need and makes the control
    // lane a harness timeout rather than a renderer comparison.
    const pickAtCursor = () =>
      expectsWebGPU ? scene.pickAsync(cursor, 7, 7) : scene.pick(cursor, 7, 7);
    let first;
    let repeat;
    let later;
    if (options.mode === "enabled" || options.mode === "webglControl") {
      setPhase("firstPick");
      const firstHit = await pickAtCursor();
      first = { snapshot: snapshot(), hit: describeHit(firstHit) };

      setPhase("repeatPick");
      const repeatHit = await pickAtCursor();
      repeat = { snapshot: snapshot(), hit: describeHit(repeatHit) };

      setPhase("laterColor");
      for (let index = 0; index < 4; index++) await renderFrame();
      later = { snapshot: snapshot() };
    } else if (options.mode === "allowPickingFalse") {
      for (const model of models) model._allowPicking = false;
      setPhase("disabledPick");
      const disabledHit = await pickAtCursor();
      first = { snapshot: snapshot(), hit: describeHit(disabledHit) };

      setPhase("laterColor");
      for (let index = 0; index < 3; index++) await renderFrame();
      later = { snapshot: snapshot() };
    } else {
      throw new Error("unknown lane mode: " + options.mode);
    }

    if (device) {
      const scopedError = await device.popErrorScope();
      if (scopedError) {
        monitor.deviceErrors.push("validation: " + scopedError.message);
      }
      await device.queue.onSubmittedWorkDone();
    }

    const checks = {};
    const failures = [];
    const check = (name, condition, failure) => {
      const pass = Boolean(condition);
      checks[name] = pass;
      if (!pass) failures.push(failure);
    };
    const checkNoPickWork = (prefix, snap, events) => {
      check(
        prefix + "LegacyIds",
        snap.legacyPickIds === 0,
        prefix + " retained legacy IDs",
      );
      check(
        prefix + "LegacyTexture",
        snap.legacyPickTextures === 0,
        prefix + " retained a legacy pick texture",
      );
      check(
        prefix + "NativeGenericIds",
        snap.nativeGenericPickIds === 0,
        prefix + " retained native generic IDs",
      );
      check(
        prefix + "NativeDenseIds",
        snap.nativeDenseFeaturePickIds === 0,
        prefix + " retained native dense IDs",
      );
      check(
        prefix + "NativeTexture",
        snap.nativeFeaturePickTextures === 0,
        prefix + " retained a native pick texture",
      );
      check(
        prefix + "EventIds",
        events.createPickIds === 0,
        prefix + " event stream created pick IDs",
      );
      check(
        prefix + "LegacyPublication",
        events.legacyPickTexturePublications === 0 &&
          events.legacyPickTextureUploads === 0,
        prefix + " event stream published a legacy pick texture",
      );
      check(
        prefix + "NativePublication",
        events.nativeFeaturePickTextures === 0 &&
          events.nativeFeaturePickTextureUploads === 0,
        prefix + " event stream published a native pick texture",
      );
    };
    const checkNoNewPickWork = (prefix, events) => {
      check(
        prefix + "EventIds",
        events.createPickIds === 0,
        prefix + " event stream created pick IDs",
      );
      check(
        prefix + "LegacyPublication",
        events.legacyPickIdArrayGrowth === 0 &&
          events.legacyPickTexturePublications === 0 &&
          events.legacyPickTextureUploads === 0,
        prefix + " event stream realized legacy pick resources",
      );
      check(
        prefix + "NativePublication",
        events.nativeFeaturePickTextures === 0 &&
          events.nativeFeaturePickTextureUploads === 0,
        prefix + " event stream realized native pick resources",
      );
    };
    const checkExactHit = (prefix, hit) => {
      check(prefix + "Found", hit.found, prefix + " returned no feature");
      check(
        prefix + "TileFeature",
        hit.isTileFeature,
        prefix + " did not return tile-feature semantics",
      );
      check(
        prefix + "Identity",
        hit.matchesExpectedObject,
        prefix + " did not return content.getFeature(28)",
      );
      check(
        prefix + "FeatureId",
        hit.featureId === options.expected.featureId,
        prefix + " returned the wrong feature ID",
      );
      check(
        prefix + "PropertyIds",
        JSON.stringify(hit.propertyIds) ===
          JSON.stringify(options.expected.propertyIds),
        prefix + " returned the wrong property ID set",
      );
      check(
        prefix + "Properties",
        JSON.stringify(hit.properties) ===
          JSON.stringify(options.expected.properties),
        prefix + " returned the wrong inherited properties",
      );
    };
    check(
      "sceneSettled",
      warmFrames < 900 && readyStreak >= 4,
      "cold scene did not settle",
    );
    check(
      "fixtureModelCount",
      cold.modelCount === 1,
      "fixture did not expose exactly one model",
    );
    check(
      "fixtureBatchTextureCount",
      cold.batchTextureCount === 1,
      "fixture did not expose exactly one BatchTexture",
    );
    check(
      "fixtureFeatureCount",
      cold.batchRows[0]?.featuresLength === 30 &&
        tileset.statistics?.numberOfFeaturesLoaded === 30,
      "fixture did not expose exactly 30 features",
    );
    check(
      "expectedFeatureExists",
      Boolean(expectedFeature),
      "fixture feature 28 is unavailable",
    );
    checkNoPickWork("cold", cold, monitor.buckets.coldColor);
    check(
      "visualFixture",
      target.nonBlackPixels > 100,
      "fixture color render was visually vacuous",
    );

    if (options.mode === "enabled") {
      const firstSnap = first.snapshot;
      const firstEvents = monitor.buckets.firstPick;
      checkExactHit("firstPick", first.hit);
      check(
        "firstPickExactNativeGenericIds",
        firstSnap.nativeGenericPickIds === 1 &&
          firstEvents.genericModelPickIds === 1,
        "first pick did not create exactly one intentional generic model ID",
      );
      check(
        "firstPickExactNativeDenseIds",
        firstSnap.nativeDenseFeaturePickIds === 30 &&
          firstEvents.nativeTileFeaturePickIds === 30,
        "first pick did not create exactly 30 native tile-feature IDs",
      );
      check(
        "firstPickNativeSemanticTargets",
        firstSnap.nativeSemanticTargets === 30,
        "native pick IDs do not all target their exact feature objects",
      );
      check(
        "firstPickNoLegacyIds",
        firstSnap.legacyPickIds === 0 &&
          firstEvents.legacyTileFeaturePickIds === 0 &&
          firstEvents.legacyPickIdArrayGrowth === 0,
        "ordinary WebGPU pick realized legacy BatchTexture IDs",
      );
      check(
        "firstPickNoLegacyTextureOrUpload",
        firstSnap.legacyPickTextures === 0 &&
          firstEvents.legacyPickTexturePublications === 0 &&
          firstEvents.legacyPickTextureUploads === 0,
        "ordinary WebGPU pick realized a legacy BatchTexture texture/upload",
      );
      check(
        "firstPickExactRegistryTotal",
        firstEvents.createPickIds === 31 && firstEvents.unscopedPickIds === 0,
        "ordinary WebGPU pick registry work was not exactly 1 + 30",
      );
      check(
        "firstPickOneNativeDenseTexture",
        firstSnap.nativeFeaturePickTextures === 1 &&
          firstEvents.nativeFeaturePickTextures === 1 &&
          firstEvents.nativeFeaturePickTextureUploads === 1,
        "first pick did not create/upload exactly one native dense texture",
      );
      checkExactHit("repeatPick", repeat.hit);
      check(
        "repeatPickSameFeatureIdentity",
        first.hit.identity === repeat.hit.identity,
        "repeat pick returned a different feature object",
      );
      check(
        "repeatPickStableResources",
        retainedSignature(firstSnap) === retainedSignature(repeat.snapshot),
        "repeat pick changed retained resources",
      );
      checkNoNewPickWork("repeatPick", monitor.buckets.repeatPick);
      check(
        "laterColorStableResources",
        retainedSignature(repeat.snapshot) ===
          retainedSignature(later.snapshot),
        "later color frames changed retained pick resources",
      );
      check(
        "laterColorNoNewWork",
        monitor.buckets.laterColor.createPickIds === 0 &&
          monitor.buckets.laterColor.legacyPickTexturePublications === 0 &&
          monitor.buckets.laterColor.nativeFeaturePickTextures === 0,
        "later color frames performed pick-only work",
      );
    } else if (options.mode === "allowPickingFalse") {
      check(
        "allowPickingFalseNoHit",
        !first.hit.found,
        "allowPicking=false returned a hit",
      );
      checkNoPickWork(
        "allowPickingFalse",
        first.snapshot,
        monitor.buckets.disabledPick,
      );
      checkNoPickWork(
        "allowPickingFalseLater",
        later.snapshot,
        monitor.buckets.laterColor,
      );
      check(
        "allowPickingFalseStableCold",
        retainedSignature(cold) === retainedSignature(later.snapshot),
        "allowPicking=false changed retained pick state",
      );
    } else if (options.mode === "webglControl") {
      const firstSnap = first.snapshot;
      const firstEvents = monitor.buckets.firstPick;
      checkExactHit("webglFirstPick", first.hit);
      check(
        "webglExactLegacyIds",
        firstSnap.legacyPickIds === 30 &&
          firstEvents.legacyTileFeaturePickIds === 30 &&
          firstEvents.legacyPickIdArrayGrowth === 30,
        "WebGL did not realize exactly 30 legacy BatchTexture IDs",
      );
      check(
        "webglLegacySemanticTargets",
        firstSnap.legacySemanticTargets === 30,
        "WebGL legacy IDs do not all target their exact feature objects",
      );
      check(
        "webglOneLegacyTexture",
        firstSnap.legacyPickTextures === 1 &&
          firstEvents.legacyPickTexturePublications === 1 &&
          firstEvents.legacyPickTextureUploads === 1,
        "WebGL did not realize exactly one legacy pick texture/upload",
      );
      check(
        "webglNoNativeWork",
        firstSnap.nativeGenericPickIds === 0 &&
          firstSnap.nativeDenseFeaturePickIds === 0 &&
          firstSnap.nativeFeaturePickTextures === 0 &&
          firstEvents.nativeTileFeaturePickIds === 0 &&
          firstEvents.nativeFeaturePickTextures === 0,
        "WebGL performed native model pick work",
      );
      check(
        "webglExactRegistryTotal",
        firstEvents.createPickIds === 30 && firstEvents.unscopedPickIds === 0,
        "WebGL registry work was not exactly 30 legacy feature IDs",
      );
      checkExactHit("webglRepeatPick", repeat.hit);
      check(
        "webglRepeatSameFeatureIdentity",
        first.hit.identity === repeat.hit.identity,
        "WebGL repeat pick returned a different feature object",
      );
      check(
        "webglRepeatStableResources",
        retainedSignature(firstSnap) === retainedSignature(repeat.snapshot),
        "WebGL repeat pick changed retained resources",
      );
      check(
        "webglRepeatNoNewWork",
        monitor.buckets.repeatPick.createPickIds === 0 &&
          monitor.buckets.repeatPick.legacyPickTexturePublications === 0 &&
          monitor.buckets.repeatPick.legacyPickIdArrayGrowth === 0,
        "WebGL repeat pick allocated legacy resources",
      );
      check(
        "webglLaterColorStable",
        retainedSignature(repeat.snapshot) ===
          retainedSignature(later.snapshot),
        "WebGL later color frames changed retained pick resources",
      );
      check(
        "webglLaterColorNoNewWork",
        monitor.buckets.laterColor.createPickIds === 0 &&
          monitor.buckets.laterColor.legacyPickTexturePublications === 0,
        "WebGL later color frames allocated legacy pick resources",
      );
    }
    check(
      "deviceAndRenderErrorsEmpty",
      monitor.deviceErrors.length === 0,
      "device/render error gate is non-empty",
    );

    const pass = failures.length === 0;
    return {
      status: pass ? "PASS" : "FAIL",
      pass,
      renderer: options.renderer,
      mode: options.mode,
      rendererType: context.rendererType ?? null,
      warmFrames,
      readyStreak,
      pendingForegroundCount:
        context.asyncResources?.pendingForegroundCount ?? 0,
      tilesLoaded: tileset.tilesLoaded,
      featuresLoaded: tileset.statistics?.numberOfFeaturesLoaded ?? null,
      target,
      expectedFeatureIdentity: objectId(expectedFeature),
      cold,
      first,
      repeat,
      later,
      counters: monitor.buckets,
      deviceErrors: monitor.deviceErrors,
      checks,
      failures,
    };
  })();
}

async function runLane(browser, lane, cleanupLog) {
  process.stdout.write(
    `[c11-202] starting ${lane.name} (${lane.renderer}/${lane.mode})\n`,
  );
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const pageErrors = [];
  let pageCleanup;
  page.on("pageerror", (error) => {
    pageErrors.push("pageerror: " + error.message);
  });
  page.on("console", (message) => {
    const value = message.text();
    if (
      message.type() === "error" ||
      (message.type() === "warning" &&
        /validation|uncaptured|device.?lost/i.test(value))
    ) {
      pageErrors.push(message.type() + ": " + value.slice(0, 500));
    }
  });
  let result;
  try {
    await page.goto(
      BASE +
        "/Apps/CesiumViewer/index.html?renderer=" +
        lane.renderer +
        "&offline=true",
      { waitUntil: "networkidle", timeout: 90_000 },
    );
    await page.waitForFunction(() => Boolean(window.viewer?.scene), {
      timeout: 90_000,
    });
    let laneTimeout;
    try {
      result = await Promise.race([
        page.evaluate(runFixtureLaneInPage, {
          renderer: lane.renderer,
          mode: lane.mode,
          expected: EXPECTED_FEATURE,
          tileset: TILESET,
        }),
        new Promise((_, reject) => {
          laneTimeout = setTimeout(
            () => reject(new Error(`${lane.name} exceeded 120 seconds`)),
            120_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(laneTimeout);
    }
    result.pageErrors = pageErrors;
    result.checks.pageErrorGate = pageErrors.length === 0;
    if (pageErrors.length > 0) {
      result.failures.push("page console/error gate is non-empty");
      result.pass = false;
      result.status = "FAIL";
    }
    process.stdout.write(
      `[c11-202] finished ${lane.name}: ${result.status} (${result.failures.length} failures)\n`,
    );
  } finally {
    pageCleanup = await closeOperationBounded(
      () => page.close(),
      lane.name + " page",
    );
    cleanupLog.push({ lane: lane.name, ...pageCleanup });
    if (result) {
      result.cleanup = { page: pageCleanup };
    }
  }
  if (!pageCleanup.closed) {
    throw new Error(pageCleanup.error);
  }
  return result;
}

const laneDefinitions = [
  { name: "webgpuEnabled", renderer: "webgpu", mode: "enabled" },
  {
    name: "webgpuAllowPickingFalse",
    renderer: "webgpu",
    mode: "allowPickingFalse",
  },
  { name: "webglControl", renderer: "webgl", mode: "webglControl" },
];
const artifact = {
  campaignItem: "C11-202",
  generatedAt: new Date().toISOString(),
  status: "RUNNING",
  pass: false,
  exitCode: 2,
  base: BASE,
  fixture: TILESET,
  expectedFeature: EXPECTED_FEATURE,
  browser: "msedge",
  diagnosticOnly: true,
  firstRed: {
    path: FIRST_RED,
    policy: "write-once",
    existedBefore: fs.existsSync(FIRST_RED),
    written: false,
    preserved: false,
  },
  sourcePolicy: undefined,
  cleanup: {
    orderlyDeadlineFired: false,
    hardStopArmed: false,
    pages: [],
    browser: null,
  },
  lanes: {},
  checks: {},
  failures: [],
};

function publishArtifact() {
  artifact.firstRed.preserved = artifact.firstRed.existedBefore;
  if (artifact.exitCode !== 0 && !artifact.firstRed.existedBefore) {
    artifact.firstRed.written = true;
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  const serialized = JSON.stringify(artifact, null, 2) + "\n";
  fs.writeFileSync(OUTPUT, serialized);
  if (artifact.firstRed.written) {
    fs.writeFileSync(FIRST_RED, serialized);
  }
}

let hardStop;
function armHardStop() {
  if (hardStop) {
    return;
  }
  artifact.cleanup.hardStopArmed = true;
  hardStop = setTimeout(() => {
    artifact.exitCode = 2;
    artifact.pass = false;
    artifact.status = "ERROR";
    try {
      publishArtifact();
    } finally {
      process.stderr.write(
        "[c11-202] hard-stop fired after " + HARD_STOP_GRACE_MS + " ms grace\n",
      );
      process.exit(2);
    }
  }, HARD_STOP_GRACE_MS);
  hardStop.unref?.();
}

let watchdog;
const orderlyDeadline = new Promise((_, reject) => {
  watchdog = setTimeout(() => {
    artifact.cleanup.orderlyDeadlineFired = true;
    artifact.failures.push("watchdog: exceeded " + WATCHDOG_MS + " ms");
    armHardStop();
    reject(new Error("watchdog exceeded " + WATCHDOG_MS + " ms"));
  }, WATCHDOG_MS);
  watchdog.unref?.();
});

let browser;
let exitCode = 2;
async function executeProbe() {
  artifact.sourcePolicy = inspectSourcePolicy();
  for (const failure of artifact.sourcePolicy.failures) {
    artifact.failures.push("sourcePolicy: " + failure);
  }
  browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  for (const lane of laneDefinitions) {
    artifact.lanes[lane.name] = await runLane(
      browser,
      lane,
      artifact.cleanup.pages,
    );
  }
  for (const [laneName, result] of Object.entries(artifact.lanes)) {
    for (const failure of result.failures) {
      artifact.failures.push(laneName + ": " + failure);
    }
  }
  return artifact.failures.length === 0 ? 0 : 1;
}

try {
  exitCode = await Promise.race([executeProbe(), orderlyDeadline]);
} catch (error) {
  artifact.failures.push("harness: " + (error?.stack ?? error));
  exitCode = 2;
} finally {
  const browserCleanup = await closeOperationBounded(
    browser ? () => browser.close() : null,
    "browser",
  );
  artifact.cleanup.browser = browserCleanup;
  clearTimeout(watchdog);
  if (artifact.cleanup.orderlyDeadlineFired) {
    exitCode = 2;
  }
  if (!browserCleanup.closed) {
    artifact.failures.push(browserCleanup.error);
    exitCode = 2;
    armHardStop();
  }
  artifact.exitCode = exitCode;
  artifact.pass = exitCode === 0;
  artifact.status = exitCode === 0 ? "PASS" : exitCode === 1 ? "FAIL" : "ERROR";
  artifact.checks = {
    sourcePolicy: artifact.sourcePolicy?.pass === true,
    ...Object.fromEntries(
      laneDefinitions.map((lane) => [
        lane.name,
        artifact.lanes[lane.name]?.pass === true,
      ]),
    ),
    noFailures: artifact.failures.length === 0,
  };
  publishArtifact();
  if (browserCleanup.closed) {
    clearTimeout(hardStop);
  }
}

console.log(JSON.stringify(artifact, null, 2));
console.log("Artifact: " + OUTPUT);
process.exitCode = exitCode;
