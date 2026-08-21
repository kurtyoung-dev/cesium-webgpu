#!/usr/bin/env node
/**
 * C11-196 browser discriminator: model pick resources stay cold during color
 * rendering, realize synchronously on first pick demand, and remain stable.
 * @purpose Discriminator that model pick resources stay cold during color rendering, realize synchronously on first pick demand, then remain stable.
 * @status ACTIVE
 *
 * Run: node Tools/visual-regression/probe-c11-196-lazy-pick-demand.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUTPUT = path.resolve(
  "Tools/visual-regression/output/c11-196-model-lazy-pick-demand.json",
);
const FIRST_RED = path.resolve(
  "Tools/visual-regression/output/c11-196-model-lazy-pick-demand.first-red.json",
);
const TILESET =
  "/Apps/SampleData/Cesium3DTiles/Hierarchy/BatchTableHierarchy/tileset.json";
const WATCHDOG_MS = 420_000;
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
          error: `${label} close failed: ${error?.message ?? error}`,
        })),
      new Promise((resolve) => {
        timeout = setTimeout(
          () =>
            resolve({
              attempted: true,
              closed: false,
              timedOut: true,
              error: `${label} close exceeded ${CLOSE_TIMEOUT_MS} ms`,
            }),
          CLOSE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function runLaneInPage(options) {
  return (async () => {
    const { allowPicking, tileset: tilesetUrl } = options;
    const C = await import("/Build/CesiumUnminified/index.js");
    const viewer = window.viewer;
    const scene = viewer.scene;
    const context = scene.context;
    const device = context?._device ?? context?.device;
    if (!device) {
      throw new Error("WebGPU device is unavailable");
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
        id = `o${nextObjectId++}`;
        objectIds.set(value, id);
      }
      return id;
    };
    const models = new Set();
    const blankCounters = () => ({
      createTextures: 0,
      batchTextures: 0,
      featurePickTextures: 0,
      createBuffers: 0,
      featureUniformBuffers: 0,
      createBindGroups: 0,
      mergedMaterialBindGroups: 0,
      createPipelines: 0,
      modelPickPipelines: 0,
      writeBuffers: 0,
      featureFlagZeroWrites: 0,
      featureFlagEnableWrites: 0,
      writeTextures: 0,
      createPickIds: 0,
      genericModelPickIds: 0,
      tileFeaturePickIds: 0,
      commandExecutions: 0,
      pickDerivedMax: 0,
      pickDerivedLast: 0,
      labels: [],
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
    const noteLabel = (label) => {
      if (
        label &&
        bucket().labels.length < 24 &&
        !bucket().labels.includes(label)
      ) {
        bucket().labels.push(label);
      }
    };
    const patchMethod = (host, name, observe) => {
      const original = host?.[name];
      if (typeof original !== "function") return;
      host[name] = function (...args) {
        observe(args);
        return original.apply(this, args);
      };
    };

    const devicePrototype = Object.getPrototypeOf(device);
    patchMethod(devicePrototype, "createTexture", ([descriptor]) => {
      const b = bucket();
      const label = descriptor?.label ?? "";
      b.createTextures++;
      if (label.startsWith("Batch texture")) b.batchTextures++;
      if (label.startsWith("Feature pick texture")) b.featurePickTextures++;
      if (label.includes("Batch") || label.includes("Feature"))
        noteLabel(label);
    });
    patchMethod(devicePrototype, "createBuffer", ([descriptor]) => {
      const b = bucket();
      const label = descriptor?.label ?? "";
      b.createBuffers++;
      if (label === "Feature ID uniforms") b.featureUniformBuffers++;
      if (label.includes("Feature")) noteLabel(label);
    });
    patchMethod(devicePrototype, "createBindGroup", ([descriptor]) => {
      const b = bucket();
      const label = descriptor?.label ?? "";
      b.createBindGroups++;
      if (label === "Model merged material bind group") {
        b.mergedMaterialBindGroups++;
      }
      if (label.includes("Model merged")) noteLabel(label);
    });
    const observePipeline = ([descriptor]) => {
      const b = bucket();
      const label = descriptor?.label ?? "";
      b.createPipelines++;
      if (/^Model PBR pick \[/.test(label)) b.modelPickPipelines++;
      if (label.startsWith("Model PBR")) noteLabel(label);
    };
    patchMethod(devicePrototype, "createRenderPipeline", observePipeline);
    patchMethod(devicePrototype, "createRenderPipelineAsync", observePipeline);

    const queuePrototype = Object.getPrototypeOf(device.queue);
    patchMethod(queuePrototype, "writeTexture", () => bucket().writeTextures++);
    patchMethod(queuePrototype, "writeBuffer", (args) => {
      const b = bucket();
      b.writeBuffers++;
      const [buffer, bufferOffset, data, dataOffset = 0] = args;
      if (
        buffer?.label !== "Feature ID uniforms" ||
        !ArrayBuffer.isView(data)
      ) {
        return;
      }
      const start = data.byteOffset + Number(dataOffset || 0);
      const bytes = data.byteLength - Number(dataOffset || 0);
      const flagByte = Number(bufferOffset || 0) === 0 ? 40 : 0;
      if (bytes < flagByte + 4) return;
      const flag = new DataView(data.buffer, start, bytes).getFloat32(
        flagByte,
        true,
      );
      if (Number(bufferOffset || 0) === 0 && flag === 0) {
        b.featureFlagZeroWrites++;
      }
      if (Number(bufferOffset || 0) === 40 && flag === 1) {
        b.featureFlagEnableWrites++;
      }
    });

    const originalCreatePickId = context.createPickId;
    context.createPickId = function (target, kind) {
      const b = bucket();
      b.createPickIds++;
      if (kind === "tile-feature") b.tileFeaturePickIds++;
      if (kind === "primitive" && models.has(target?.primitive)) {
        b.genericModelPickIds++;
      }
      return originalCreatePickId.call(this, target, kind);
    };

    const originalExecute = scene.updateAndExecuteCommands;
    scene.updateAndExecuteCommands = function (...args) {
      const result = originalExecute.apply(this, args);
      const b = bucket();
      let derived = 0;
      for (const command of scene.frameState?.commandList ?? []) {
        if (
          models.has(command?.owner) &&
          command?.derivedCommands?.picking?.pickCommand
        ) {
          derived++;
        }
      }
      b.commandExecutions++;
      b.pickDerivedLast = derived;
      b.pickDerivedMax = Math.max(b.pickDerivedMax, derived);
      return result;
    };

    device.onuncapturederror = (event) => {
      monitor.deviceErrors.push(
        String(event?.error?.message ?? event).slice(0, 500),
      );
    };
    device.lost.then((info) => {
      monitor.deviceErrors.push(
        `device-lost: ${info?.reason}: ${info?.message}`,
      );
    });
    scene.renderError.addEventListener((_scene, error) => {
      monitor.deviceErrors.push(`render-error: ${String(error).slice(0, 500)}`);
    });
    device.pushErrorScope("validation");

    const fixedTime = C.JulianDate.fromIso8601("2026-08-10T12:00:00Z");
    const renderFrame = async () => {
      scene.render(fixedTime);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    };
    const collectModels = (tile) => {
      if (!tile) return;
      const collectContent = (content) => {
        if (!content) return;
        if (content._model) models.add(content._model);
        for (const inner of content.innerContents ?? []) collectContent(inner);
      };
      collectContent(tile.content);
      for (const child of tile.children ?? []) collectModels(child);
    };
    const mapSize = (value) => value?.size ?? 0;
    const snapshot = () => {
      const modelRows = [];
      let genericPickIds = 0;
      let denseFeaturePickIds = 0;
      let featurePickTextures = 0;
      let stylePrimitives = 0;
      let fallbackPrimitives = 0;
      let promotedPrimitives = 0;
      let defaultPickPipelines = 0;
      for (const model of models) {
        const cache = model?._webgpuCache;
        if (!cache) continue;
        const generic = Object.values(cache.pickIds ?? {});
        const dense = [...(cache._featurePickIds?.values?.() ?? [])];
        genericPickIds += generic.length;
        denseFeaturePickIds += dense.length;
        featurePickTextures += cache._featurePickGPUTexture ? 1 : 0;
        const primitiveRows = [];
        for (const key of Object.keys(cache.primitives ?? {}).sort()) {
          const primitive = cache.primitives[key];
          const binding31 = primitive?._featureIdEntries?.find(
            (entry) => entry.binding === 31,
          );
          const styled = Boolean(
            primitive?._featureIdEntries &&
            primitive?._featureUniformBuffer &&
            primitive?._batchGPUTexture,
          );
          if (styled) stylePrimitives++;
          if (styled && !primitive?._featurePickBoundGPUTexture)
            fallbackPrimitives++;
          if (primitive?._featurePickBoundGPUTexture) promotedPrimitives++;
          primitiveRows.push({
            key,
            entries: objectId(primitive?._featureIdEntries),
            uniformBuffer: objectId(primitive?._featureUniformBuffer),
            batchTexture: objectId(primitive?._batchGPUTexture),
            boundPickTexture: objectId(primitive?._featurePickBoundGPUTexture),
            binding31: objectId(binding31?.resource),
            pickPipeline: objectId(primitive?.pickPipeline),
            mergedBindGroup: objectId(
              primitive?._mergedMaterialBindGroupCache?.bindGroup,
            ),
          });
        }
        const pipelines = cache.pipelineCache;
        defaultPickPipelines += mapSize(pipelines?._pickPipelines);
        modelRows.push({
          model: objectId(model),
          cache: objectId(cache),
          genericPickIds: generic.map(objectId),
          denseFeaturePickIds: dense.map(objectId),
          featurePickTexture: objectId(cache._featurePickGPUTexture),
          featurePickFeaturesLength: cache._featurePickFeaturesLength ?? null,
          pipelineMaps: {
            pick: mapSize(pipelines?._pickPipelines),
            snap: mapSize(pipelines?._snapPipelines),
            hover: mapSize(pipelines?._pickHoverPipelines),
            precise1: mapSize(pipelines?._pickPrecisePass1Pipelines),
            precise2: mapSize(pipelines?._pickPrecisePass2Pipelines),
            metadata: mapSize(pipelines?._pickMetadataPipelines),
          },
          primitives: primitiveRows,
        });
      }
      return {
        modelCount: modelRows.length,
        genericPickIds,
        denseFeaturePickIds,
        featurePickTextures,
        stylePrimitives,
        fallbackPrimitives,
        promotedPrimitives,
        defaultPickPipelines,
        models: modelRows,
      };
    };
    const signature = (snap, fields) =>
      snap.models
        .flatMap((model) =>
          model.primitives.map((primitive) =>
            [
              model.model,
              primitive.key,
              ...fields.map((field) => primitive[field]),
            ].join(":"),
          ),
        )
        .sort()
        .join("|");
    const retainedSignature = (snap) =>
      JSON.stringify(
        snap.models.map((model) => ({
          model: model.model,
          generic: model.genericPickIds,
          dense: model.denseFeaturePickIds,
          texture: model.featurePickTexture,
          primitives: model.primitives.map((primitive) => ({
            key: primitive.key,
            entries: primitive.entries,
            uniformBuffer: primitive.uniformBuffer,
            boundPickTexture: primitive.boundPickTexture,
            binding31: primitive.binding31,
            pickPipeline: primitive.pickPipeline,
          })),
        })),
      );

    setPhase("coldColor");
    const tileset = await C.Cesium3DTileset.fromUrl(tilesetUrl, {
      maximumScreenSpaceError: 1,
    });
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
      orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
    });

    let warmFrames = 0;
    let readyStreak = 0;
    const warmDeadline = performance.now() + 60_000;
    while (warmFrames < 900 && performance.now() < warmDeadline) {
      await renderFrame();
      warmFrames++;
      collectModels(tileset.root);
      const current = snapshot();
      const pending = context.asyncResources?.pendingForegroundCount ?? 0;
      const ready =
        tileset.tilesLoaded === true &&
        pending === 0 &&
        current.modelCount > 0 &&
        current.stylePrimitives > 0 &&
        current.models.some((model) =>
          model.primitives.some((primitive) => primitive.pickPipeline === null),
        );
      readyStreak = ready ? readyStreak + 1 : 0;
      if (readyStreak >= 4) break;
    }
    await renderFrame();
    const cold = snapshot();

    const findTarget = () => {
      scene.render(fixedTime);
      const source = scene.canvas;
      const scratch = document.createElement("canvas");
      scratch.width = source.width;
      scratch.height = source.height;
      const ctx = scratch.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(source, 0, 0);
      const image = ctx.getImageData(0, 0, scratch.width, scratch.height);
      const binary = new Uint8Array(scratch.width * scratch.height);
      let nonBlackPixels = 0;
      for (let i = 0, p = 0; i < binary.length; i++, p += 4) {
        const lit =
          image.data[p] > 12 ||
          image.data[p + 1] > 12 ||
          image.data[p + 2] > 12;
        binary[i] = lit ? 1 : 0;
        nonBlackPixels += binary[i];
      }
      let bestX = Math.floor(scratch.width / 2);
      let bestY = Math.floor(scratch.height / 2);
      let bestScore = -Infinity;
      for (let y = 6; y < scratch.height - 6; y += 2) {
        for (let x = 6; x < scratch.width - 6; x += 2) {
          if (!binary[y * scratch.width + x]) continue;
          let neighborhood = 0;
          for (let dy = -5; dy <= 5; dy += 2) {
            for (let dx = -5; dx <= 5; dx += 2) {
              neighborhood += binary[(y + dy) * scratch.width + x + dx];
            }
          }
          const centerPenalty =
            (Math.abs(x - scratch.width / 2) +
              Math.abs(y - scratch.height / 2)) /
            Math.max(scratch.width, scratch.height);
          const score = neighborhood - centerPenalty;
          if (score > bestScore) {
            bestScore = score;
            bestX = x;
            bestY = y;
          }
        }
      }
      return {
        x: bestX / (source.width / (source.clientWidth || source.width)),
        y: bestY / (source.height / (source.clientHeight || source.height)),
        backing: [bestX, bestY],
        nonBlackPixels,
        neighborhoodScore: bestScore,
      };
    };
    const target = findTarget();
    const describeHit = (hit) => {
      if (!hit) return { found: false };
      const ids =
        typeof hit.getPropertyIds === "function" ? hit.getPropertyIds() : [];
      const properties = {};
      for (const id of ids.slice(0, 8)) {
        properties[id] = String(hit.getProperty(id)).slice(0, 100);
      }
      return {
        found: true,
        identity: objectId(hit),
        ctor: hit.constructor?.name ?? null,
        isTileFeature: typeof hit.getProperty === "function",
        featureId: hit.featureId ?? hit._batchId ?? null,
        propertyIds: ids,
        properties,
      };
    };
    const cursor = new C.Cartesian2(target.x, target.y);
    let first;
    let repeat;
    let laterColor;
    if (allowPicking) {
      setPhase("firstPick");
      const firstHit = await scene.pickAsync(cursor, 7, 7);
      first = { snapshot: snapshot(), hit: describeHit(firstHit) };

      setPhase("repeatPick");
      const repeatHit = await scene.pickAsync(cursor, 7, 7);
      repeat = { snapshot: snapshot(), hit: describeHit(repeatHit) };

      setPhase("laterColor");
      for (let i = 0; i < 4; i++) await renderFrame();
      laterColor = { snapshot: snapshot() };
    } else {
      // Model.allowPicking is intentionally readonly; this is the same
      // constructor-owned backing slot populated by options.allowPicking.
      // Tile content constructs its Model internally, so set the backing slot
      // before the first pick traversal to exercise the false policy.
      for (const model of models) model._allowPicking = false;
      setPhase("disabledPick");
      const disabledHit = await scene.pickAsync(cursor, 7, 7);
      first = { snapshot: snapshot(), hit: describeHit(disabledHit) };
    }

    const scopedError = await device.popErrorScope();
    if (scopedError)
      monitor.deviceErrors.push(`validation: ${scopedError.message}`);
    await device.queue.onSubmittedWorkDone();

    const failures = [];
    const requireGate = (condition, message) => {
      if (!condition) failures.push(message);
    };
    requireGate(
      warmFrames < 900 && readyStreak >= 4,
      "cold scene did not settle",
    );
    requireGate(cold.modelCount > 0, "cold lane found no WebGPU model cache");
    requireGate(
      cold.stylePrimitives > 0,
      "cold lane created no styling resources",
    );
    requireGate(
      cold.fallbackPrimitives === cold.stylePrimitives,
      "cold styling resources did not all bind the fallback pick texture",
    );
    requireGate(
      cold.genericPickIds === 0,
      "cold lane allocated generic pick IDs",
    );
    requireGate(
      cold.denseFeaturePickIds === 0,
      "cold lane allocated dense feature IDs",
    );
    requireGate(
      cold.featurePickTextures === 0,
      "cold lane retained a feature-pick texture",
    );
    requireGate(
      cold.defaultPickPipelines === 0,
      "cold lane retained a pick pipeline",
    );
    requireGate(
      monitor.buckets.coldColor.genericModelPickIds === 0,
      "cold event stream created generic model IDs",
    );
    requireGate(
      monitor.buckets.coldColor.tileFeaturePickIds === 0,
      "cold event stream created tile-feature IDs",
    );
    requireGate(
      monitor.buckets.coldColor.featurePickTextures === 0,
      "cold event stream created a feature-pick texture",
    );
    requireGate(
      monitor.buckets.coldColor.modelPickPipelines === 0,
      "cold event stream created a model pick pipeline",
    );
    requireGate(
      monitor.buckets.coldColor.featureFlagEnableWrites === 0,
      "cold event stream enabled feature picking",
    );
    requireGate(
      target.nonBlackPixels > 100,
      "cold model render was visually vacuous",
    );

    if (allowPicking) {
      const firstSnap = first.snapshot;
      const repeatSnap = repeat.snapshot;
      const laterSnap = laterColor.snapshot;
      requireGate(
        first.hit.isTileFeature,
        "first pick did not return Cesium3DTileFeature semantics",
      );
      requireGate(
        firstSnap.genericPickIds > 0,
        "first pick created no generic IDs",
      );
      requireGate(
        firstSnap.denseFeaturePickIds > 0,
        "first pick created no dense feature IDs",
      );
      requireGate(
        firstSnap.featurePickTextures > 0,
        "first pick created no feature lookup texture",
      );
      requireGate(
        firstSnap.defaultPickPipelines > 0,
        "first pick created no model pick pipeline",
      );
      requireGate(
        firstSnap.promotedPrimitives > 0,
        "first pick promoted no primitive binding",
      );
      const firstEvents = monitor.buckets.firstPick;
      requireGate(
        firstEvents.genericModelPickIds > 0,
        "first pick event stream has no generic IDs",
      );
      requireGate(
        firstEvents.tileFeaturePickIds > 0,
        "first pick event stream has no tile-feature IDs",
      );
      requireGate(
        firstEvents.featurePickTextures > 0,
        "first pick event stream has no lookup texture",
      );
      requireGate(
        firstEvents.modelPickPipelines > 0,
        "first pick event stream has no pick pipeline",
      );
      requireGate(
        firstEvents.featureFlagEnableWrites > 0,
        "first pick event stream has no byte-40 enable write",
      );
      requireGate(
        firstEvents.mergedMaterialBindGroups > 0,
        "first pick rebuilt no material bind group",
      );
      requireGate(
        firstEvents.pickDerivedMax > 0,
        "first pick emitted no derived pick command",
      );
      requireGate(
        signature(cold, ["uniformBuffer"]) ===
          signature(firstSnap, ["uniformBuffer"]),
        "first pick replaced the retained feature uniform buffer",
      );
      requireGate(
        signature(cold, ["entries"]) !== signature(firstSnap, ["entries"]),
        "first pick did not publish a new entries-array identity",
      );
      const repeatEvents = monitor.buckets.repeatPick;
      requireGate(
        first.hit.identity === repeat.hit.identity,
        "repeat pick returned a different feature object",
      );
      requireGate(
        retainedSignature(firstSnap) === retainedSignature(repeatSnap),
        "repeat pick changed retained pick identities",
      );
      requireGate(
        repeatEvents.genericModelPickIds === 0 &&
          repeatEvents.tileFeaturePickIds === 0,
        "repeat pick allocated IDs",
      );
      requireGate(
        repeatEvents.featurePickTextures === 0 &&
          repeatEvents.modelPickPipelines === 0,
        "repeat pick allocated texture/pipeline resources",
      );
      requireGate(
        repeatEvents.featureFlagEnableWrites === 0 &&
          repeatEvents.mergedMaterialBindGroups === 0,
        "repeat pick rewrote promotion resources",
      );
      const colorEvents = monitor.buckets.laterColor;
      requireGate(
        retainedSignature(repeatSnap) === retainedSignature(laterSnap),
        "later color frames changed retained pick identities",
      );
      requireGate(
        colorEvents.genericModelPickIds === 0 &&
          colorEvents.tileFeaturePickIds === 0,
        "later color frames allocated IDs",
      );
      requireGate(
        colorEvents.featurePickTextures === 0 &&
          colorEvents.modelPickPipelines === 0,
        "later color frames allocated pick texture/pipeline resources",
      );
      requireGate(
        colorEvents.featureFlagEnableWrites === 0 &&
          colorEvents.mergedMaterialBindGroups === 0,
        "later color frames rebuilt promotion resources",
      );
      requireGate(
        colorEvents.pickDerivedMax === 0,
        "later color frame emitted a derived pick command",
      );
    } else {
      const disabled = monitor.buckets.disabledPick;
      requireGate(
        !first.hit.isTileFeature,
        "allowPicking=false returned a tile feature",
      );
      requireGate(
        first.snapshot.genericPickIds === 0 &&
          first.snapshot.denseFeaturePickIds === 0,
        "allowPicking=false retained pick IDs",
      );
      requireGate(
        first.snapshot.featurePickTextures === 0 &&
          first.snapshot.defaultPickPipelines === 0,
        "allowPicking=false retained pick GPU resources",
      );
      requireGate(
        disabled.genericModelPickIds === 0,
        "allowPicking=false allocated native model IDs",
      );
      requireGate(
        disabled.featurePickTextures === 0 && disabled.modelPickPipelines === 0,
        "allowPicking=false allocated pick GPU resources",
      );
      requireGate(
        disabled.featureFlagEnableWrites === 0 && disabled.pickDerivedMax === 0,
        "allowPicking=false promoted or emitted pick commands",
      );
    }
    requireGate(
      monitor.deviceErrors.length === 0,
      "WebGPU/render error gate is non-empty",
    );

    const scoredPhase = allowPicking ? "firstPick" : "disabledPick";
    const scoredEvents = monitor.buckets[scoredPhase];
    const nativeDenseIdDelta =
      first.snapshot.denseFeaturePickIds - cold.denseFeaturePickIds;
    return {
      allowPicking,
      renderer: context.rendererType ?? null,
      warmFrames,
      readyStreak,
      pendingForegroundCount:
        context.asyncResources?.pendingForegroundCount ?? 0,
      tilesLoaded: tileset.tilesLoaded,
      featuresLoaded: tileset.statistics?.numberOfFeaturesLoaded ?? null,
      target,
      cold,
      first,
      repeat,
      laterColor,
      counters: monitor.buckets,
      registryAttribution: {
        phase: scoredPhase,
        allTileFeatureCreatePickIdCalls: scoredEvents.tileFeaturePickIds,
        nativeDenseIdsRetainedDelta: nativeDenseIdDelta,
        legacyBatchTextureCreatePickIdCalls: Math.max(
          0,
          scoredEvents.tileFeaturePickIds - nativeDenseIdDelta,
        ),
        note: "BatchTexture.update runs before Model.submitDrawCommands; its backend-neutral pick-pass IDs are C11-202 debt, not C11-196 native renderer resources.",
      },
      deviceErrors: monitor.deviceErrors,
      failures,
    };
  })();
}

async function runLane(browser, allowPicking, cleanupLog) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const pageErrors = [];
  page.on("pageerror", (error) =>
    pageErrors.push(`pageerror: ${error.message}`),
  );
  page.on("console", (message) => {
    const text = message.text();
    if (
      message.type() === "error" ||
      (message.type() === "warning" &&
        /validation|uncaptured|device.?lost/i.test(text))
    ) {
      pageErrors.push(`${message.type()}: ${text.slice(0, 500)}`);
    }
  });
  let result;
  let pageCleanup;
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
      { waitUntil: "networkidle", timeout: 90_000 },
    );
    await page.waitForFunction(() => !!window.viewer?.scene, {
      timeout: 90_000,
    });
    result = await page.evaluate(runLaneInPage, {
      allowPicking,
      tileset: TILESET,
    });
    result.pageErrors = pageErrors;
    if (pageErrors.length)
      result.failures.push("page console/error gate is non-empty");
  } finally {
    pageCleanup = await closeOperationBounded(() => page.close(), "page");
    cleanupLog.push({
      lane: allowPicking ? "enabled" : "allowPickingFalse",
      ...pageCleanup,
    });
    if (result) {
      result.cleanup = { page: pageCleanup };
    }
  }
  if (!pageCleanup.closed) {
    throw new Error(pageCleanup.error);
  }
  return result;
}

const artifact = {
  campaignItem: "C11-196",
  generatedAt: new Date().toISOString(),
  status: "RUNNING",
  pass: false,
  exitCode: 2,
  base: BASE,
  fixture: TILESET,
  browser: "msedge",
  diagnosticOnly: true,
  cleanup: {
    orderlyDeadlineFired: false,
    hardStopArmed: false,
    pages: [],
    browser: null,
  },
  lanes: {},
  failures: [],
};

function publishArtifact() {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  fs.writeFileSync(OUTPUT, serialized);
  if (artifact.exitCode !== 0 && !fs.existsSync(FIRST_RED)) {
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
        `[c11-196] hard-stop fired after ${HARD_STOP_GRACE_MS} ms grace\n`,
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
    artifact.failures.push(`watchdog: exceeded ${WATCHDOG_MS} ms`);
    armHardStop();
    reject(new Error(`watchdog exceeded ${WATCHDOG_MS} ms`));
  }, WATCHDOG_MS);
  watchdog.unref?.();
});

let browser;
let exitCode = 2;
async function executeProbe() {
  browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  artifact.lanes.enabled = await runLane(browser, true, artifact.cleanup.pages);
  artifact.lanes.allowPickingFalse = await runLane(
    browser,
    false,
    artifact.cleanup.pages,
  );
  for (const [lane, result] of Object.entries(artifact.lanes)) {
    for (const failure of result.failures) {
      artifact.failures.push(`${lane}: ${failure}`);
    }
  }
  return artifact.failures.length === 0 ? 0 : 1;
}

try {
  exitCode = await Promise.race([executeProbe(), orderlyDeadline]);
} catch (error) {
  artifact.failures.push(`harness: ${error?.stack ?? error}`);
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
  publishArtifact();
  if (browserCleanup.closed) {
    clearTimeout(hardStop);
  }
}

console.log(JSON.stringify(artifact, null, 2));
console.log(`Artifact: ${OUTPUT}`);
process.exitCode = exitCode;
