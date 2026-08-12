// C11-193C — same-frame dynamic-environment demand ordering.
//
// GPU-free executable policy plus narrow source contracts for the Scene/WebGPU
// integration seams. Browser submission/pass-count acceptance remains in the
// dedicated probe lane.
//
// Run: node --test Tools/visual-regression/environment-refresh-priority.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const webgpuDir = path.join(root, "packages/engine/Source/Renderer/WebGPU");

async function importTs(relativePath) {
  const source = await readFile(path.join(webgpuDir, relativePath), "utf8");
  const { code } = await transform(source, {
    loader: "ts",
    format: "esm",
    target: "es2022",
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
}

const { WebGPUEnvironmentRefreshCoordinator } = await importTs(
  "WebGPUEnvironmentRefreshCoordinator.ts",
);

function createClassifier() {
  const demands = new WeakMap();
  return {
    set(manager, demand) {
      demands.set(manager, demand);
    },
    classify(manager) {
      return demands.get(manager) ?? "unknown";
    },
  };
}

function collect(coordinator, generation, offers) {
  assert.equal(coordinator.beginCollection(generation), true);
  try {
    for (const offer of offers) {
      assert.equal(
        coordinator.enqueue(
          offer.manager,
          offer.frameState ?? {},
          offer.update,
          generation,
          offer.expectedContext,
        ),
        true,
      );
    }
  } finally {
    coordinator.endCollection(generation);
  }
}

test("off-frame calls are rejected for the historical raw fallback", () => {
  const coordinator = new WebGPUEnvironmentRefreshCoordinator();
  coordinator.beginFrame(4);
  let updates = 0;
  assert.equal(
    coordinator.enqueue({}, {}, () => updates++, 4),
    false,
  );
  assert.equal(updates, 0);
  assert.equal(coordinator.pendingCount, 0);
});

test("final demand drains HIGH stably before earlier NORMAL work", () => {
  const coordinator = new WebGPUEnvironmentRefreshCoordinator();
  const classifier = createClassifier();
  const normalA = {};
  const highA = {};
  const highB = {};
  const normalB = {};
  classifier.set(normalA, "proven-none");
  classifier.set(highA, "demanded");
  classifier.set(highB, "unknown");
  classifier.set(normalB, "proven-none");
  const order = [];

  coordinator.beginFrame(2);
  collect(coordinator, 2, [
    { manager: normalA, update: () => order.push("normal-a") },
    { manager: highA, update: () => order.push("high-a") },
    { manager: highB, update: () => order.push("high-b") },
    { manager: normalB, update: () => order.push("normal-b") },
  ]);

  assert.equal(coordinator.drain(classifier, 2, true), 4);
  assert.deepEqual(order, ["high-a", "high-b", "normal-a", "normal-b"]);
  assert.equal(coordinator.pendingCount, 0);
});

test("NORMAL-only work still runs in the same ordinary viewport", () => {
  const coordinator = new WebGPUEnvironmentRefreshCoordinator();
  const classifier = createClassifier();
  const manager = {};
  classifier.set(manager, "proven-none");
  let updates = 0;

  coordinator.beginFrame(0);
  collect(coordinator, 0, [{ manager, update: () => updates++ }]);
  assert.equal(coordinator.drain(classifier, 0, true), 1);
  assert.equal(updates, 1);
});

test("split first viewport retains NORMAL and final demand can promote it", () => {
  const coordinator = new WebGPUEnvironmentRefreshCoordinator();
  const classifier = createClassifier();
  const manager = {};
  classifier.set(manager, "proven-none");
  let updates = 0;
  const update = () => updates++;

  coordinator.beginFrame(3);
  collect(coordinator, 3, [{ manager, update }]);
  assert.equal(coordinator.drain(classifier, 3, false), 0);
  assert.equal(coordinator.pendingCount, 1);

  classifier.set(manager, "demanded");
  collect(coordinator, 3, [{ manager, update }]);
  assert.equal(coordinator.pendingCount, 1, "the second offer must coalesce");
  assert.equal(coordinator.drain(classifier, 3, true), 1);
  assert.equal(updates, 1);

  collect(coordinator, 3, [{ manager, update }]);
  assert.equal(
    coordinator.drain(classifier, 3, true),
    0,
    "one raw updater per exact manager and logical frame",
  );
  assert.equal(updates, 1);
});

test("recurring managers reuse entries and scratch arrays without frame churn", () => {
  const coordinator = new WebGPUEnvironmentRefreshCoordinator();
  const classifier = createClassifier();
  const manager = {};
  classifier.set(manager, "demanded");

  const entriesIdentity = coordinator._entries;
  const jobsIdentity = coordinator._jobs;
  const highIdentity = coordinator._highScratch;
  const normalIdentity = coordinator._normalScratch;

  coordinator.beginFrame(0);
  collect(coordinator, 0, [{ manager, update() {} }]);
  const entryIdentity = coordinator._entries.get(manager);
  assert.equal(coordinator.drain(classifier, 0, true), 1);
  assert.equal(coordinator._highScratch.length, 0);
  assert.equal(coordinator._normalScratch.length, 0);

  coordinator.beginFrame(0);
  assert.equal(coordinator._entries, entriesIdentity);
  assert.equal(coordinator._jobs, jobsIdentity);
  assert.equal(coordinator._highScratch, highIdentity);
  assert.equal(coordinator._normalScratch, normalIdentity);
  collect(coordinator, 0, [{ manager, update() {} }]);
  assert.equal(coordinator._entries.get(manager), entryIdentity);
  assert.equal(coordinator.drain(classifier, 0, true), 1);

  coordinator.beginFrame(0);
  assert.equal(coordinator.pendingCount, 0);
  assert.equal(coordinator._entries, entriesIdentity);
});

test("destroyed managers are released without backend resurrection", () => {
  const coordinator = new WebGPUEnvironmentRefreshCoordinator();
  const classifier = createClassifier();
  let destroyed = false;
  const manager = { isDestroyed: () => destroyed };
  classifier.set(manager, "demanded");
  let updates = 0;
  let nativeAllocations = 0;

  coordinator.beginFrame(1);
  collect(coordinator, 1, [
    {
      manager,
      update() {
        updates++;
        nativeAllocations++;
      },
    },
  ]);
  destroyed = true;

  assert.equal(coordinator.drain(classifier, 1, true), 0);
  assert.equal(updates, 0);
  assert.equal(nativeAllocations, 0);
  assert.equal(coordinator.pendingCount, 0);
});

test("generation reset drops stale jobs and permits a fresh exact tuple", () => {
  const coordinator = new WebGPUEnvironmentRefreshCoordinator();
  const classifier = createClassifier();
  const manager = {};
  classifier.set(manager, "demanded");
  let updates = 0;

  coordinator.beginFrame(6);
  collect(coordinator, 6, [{ manager, update: () => updates++ }]);
  const oldEntries = coordinator._entries;
  coordinator.reset(7);
  assert.notEqual(coordinator._entries, oldEntries);
  assert.equal(coordinator.pendingCount, 0);
  assert.equal(coordinator.drain(classifier, 7, true), 0);

  coordinator.beginFrame(7);
  collect(coordinator, 7, [{ manager, update: () => updates++ }]);
  assert.equal(coordinator.drain(classifier, 7, true), 1);
  assert.equal(updates, 1);
});

test("a mutable frameState cannot migrate a queued job to another context", () => {
  const coordinator = new WebGPUEnvironmentRefreshCoordinator();
  const classifier = createClassifier();
  const manager = {};
  const contextA = {};
  const contextB = {};
  const frameState = { context: contextA };
  classifier.set(manager, "demanded");
  let updates = 0;

  coordinator.beginFrame(9);
  collect(coordinator, 9, [
    {
      manager,
      frameState,
      expectedContext: contextA,
      update: () => updates++,
    },
  ]);
  frameState.context = contextB;
  assert.equal(coordinator.drain(classifier, 9, true), 0);
  assert.equal(updates, 0);
  assert.equal(coordinator.pendingCount, 0);

  coordinator.beginFrame(9);
  frameState.context = contextA;
  collect(coordinator, 9, [
    {
      manager,
      frameState,
      expectedContext: contextA,
      update: () => updates++,
    },
  ]);
  assert.equal(coordinator.drain(classifier, 9, true), 1);
  assert.equal(updates, 1);
});

test("a thrown updater commits no stamp and retries on the next frame", () => {
  const coordinator = new WebGPUEnvironmentRefreshCoordinator();
  const classifier = createClassifier();
  const manager = {};
  classifier.set(manager, "demanded");
  let attempts = 0;

  coordinator.beginFrame(0);
  collect(coordinator, 0, [
    {
      manager,
      update() {
        attempts++;
        throw new Error("intentional encode failure");
      },
    },
  ]);
  assert.throws(
    () => coordinator.drain(classifier, 0, true),
    /intentional encode failure/,
  );

  coordinator.beginFrame(0);
  collect(coordinator, 0, [{ manager, update: () => attempts++ }]);
  assert.equal(coordinator.drain(classifier, 0, true), 1);
  assert.equal(attempts, 2);
});

test("Scene and backend source seams preserve exact collection ownership", async () => {
  const [viewport, context, renderers, tileset, manager, model] =
    await Promise.all([
      readFile(
        path.join(root, "packages/engine/Source/Scene/ViewportExecutor.js"),
        "utf8",
      ),
      readFile(path.join(webgpuDir, "WebGPUContext.ts"), "utf8"),
      readFile(path.join(webgpuDir, "WebGPUFeatureRenderers.ts"), "utf8"),
      readFile(
        path.join(root, "packages/engine/Source/Scene/Cesium3DTileset.js"),
        "utf8",
      ),
      readFile(
        path.join(webgpuDir, "WebGPUDynamicEnvironmentMapManager.ts"),
        "utf8",
      ),
      readFile(
        path.join(root, "packages/engine/Source/Scene/Model/Model.js"),
        "utf8",
      ),
    ]);

  const updateStart = viewport.indexOf("function updateAndRenderPrimitives(");
  const updateEnd = viewport.indexOf(
    "const scratchEyeTranslation",
    updateStart,
  );
  const updateBody = viewport.slice(updateStart, updateEnd);
  const collectionBegin = updateBody.indexOf(
    "beginEnvironmentMapUpdateCollection?.()",
  );
  const groundUpdate = updateBody.indexOf("scene._groundPrimitives.update");
  const primitiveUpdate = updateBody.indexOf("scene._primitives.update");
  const collectionEnd = updateBody.indexOf(
    "endEnvironmentMapUpdateCollection()",
  );
  const drain = updateBody.indexOf("drainEnvironmentMapUpdates(");
  const shadowUpdate = updateBody.indexOf("updateShadowMaps(scene)");
  const globeDraw = updateBody.indexOf("scene._globe.render(frameState)");
  assert.ok(
    collectionBegin < groundUpdate &&
      groundUpdate < primitiveUpdate &&
      primitiveUpdate < collectionEnd &&
      collectionEnd < drain &&
      drain < shadowUpdate &&
      shadowUpdate < globeDraw,
    "collection must surround traversal and drain before shadow/globe/PVS draw",
  );
  const webVrStart = viewport.indexOf("function executeWebVRCommands(");
  const webVrEnd = viewport.indexOf(
    "const scratch2DViewportCartographic",
    webVrStart,
  );
  const webVrBody = viewport.slice(webVrStart, webVrEnd);
  assert.match(webVrBody, /updateAndRenderPrimitives\(scene\);/);
  assert.doesNotMatch(webVrBody, /firstViewport/);

  const executeStart = viewport.indexOf("function executeCommandsInViewport(");
  const executeEnd = viewport.indexOf(
    "function beginSecondaryViewportSegment(",
    executeStart,
  );
  const executeBody = viewport.slice(executeStart, executeEnd);
  assert.match(
    executeBody,
    /updateAndRenderPrimitives\([\s\S]*?!scene\._is2DViewportSplit \|\| !firstViewport/,
  );

  assert.match(context, /queueEnvironmentMapUpdate<TManager extends object>/);
  assert.match(context, /frameState\.context !== this/);
  assert.match(context, /this\.hasActiveRenderPass/);
  const contextQueueStart = context.indexOf(
    "queueEnvironmentMapUpdate<TManager extends object>",
  );
  const contextQueueEnd = context.indexOf(
    "drainEnvironmentMapUpdates(",
    contextQueueStart,
  );
  assert.match(
    context.slice(contextQueueStart, contextQueueEnd),
    /this\._deviceResourceGeneration,[\s\S]*?this,[\s\S]*?\);/,
  );
  assert.ok(
    (context.match(/_environmentRefreshCoordinator\.reset\(/g) ?? []).length >=
      2,
    "destroy and recovery must both reset the coordinator",
  );

  assert.match(
    renderers,
    /update: updateSceneQueuedWebGPUDynamicEnvironmentMap/,
  );
  const wrapperStart = renderers.indexOf(
    "function updateSceneQueuedWebGPUDynamicEnvironmentMap(",
  );
  const wrapperEnd = renderers.indexOf(
    "/**\n * Registers all WebGPU feature renderers",
    wrapperStart,
  );
  const wrapper = renderers.slice(wrapperStart, wrapperEnd);
  const preflightIndex = wrapper.indexOf(
    "preflightWebGPUDynamicEnvironmentMap(manager, frameState)",
  );
  const offerIndex = wrapper.indexOf("queueEnvironmentMapUpdate(");
  const fallbackIndex = wrapper.lastIndexOf(
    "updatePreflightedWebGPUDynamicEnvironmentMap(manager, frameState)",
  );
  assert.ok(
    preflightIndex >= 0 &&
      preflightIndex < offerIndex &&
      offerIndex < fallbackIndex,
    "old-device aliases must detach synchronously before queue/fallback",
  );
  assert.match(
    wrapper,
    /queueEnvironmentMapUpdate\([\s\S]*?updateWebGPUDynamicEnvironmentMap/,
  );

  const updateForPassStart = tileset.indexOf(
    "  updateForPass(frameState, tilesetPassState) {",
  );
  const updateForPassEnd = tileset.indexOf(
    "  hasExtension(extensionName) {",
    updateForPassStart,
  );
  assert.ok(
    updateForPassStart >= 0 && updateForPassEnd > updateForPassStart,
    "updateForPass source slice must be nonempty",
  );
  const updateForPass = tileset.slice(updateForPassStart, updateForPassEnd);
  const managerUpdate = updateForPass.indexOf(
    "environmentMapManager.update(frameState)",
  );
  const explicitNone = updateForPass.indexOf(
    "recordEnvironmentMapNoDemandForSkippedTraversal(this, frameState)",
  );
  const traversalGate = updateForPass.indexOf(
    "if (this.show || ignoreCommands)",
  );
  assert.ok(
    managerUpdate >= 0 &&
      managerUpdate < explicitNone &&
      explicitNone < traversalGate,
    "manager offer must precede explicit-none classification and traversal",
  );
  assert.match(
    tileset,
    /function recordEnvironmentMapNoDemandForSkippedTraversal\([\s\S]*?!tileset\.show \|\|[\s\S]*?!defined\(tileset\._root\) \|\|[\s\S]*?frameState\.mode === SceneMode\.MORPHING[\s\S]*?updateEnvironmentMapForSelectedConsumers\(tileset, frameState, 0\)/,
  );

  assert.equal(
    (manager.match(/_shouldRegenerateShaders\s*=\s*true/g) ?? []).length,
    0,
    "delayed WebGPU manager execution must not move a true shader-reset edge past Model.update",
  );
  assert.match(
    manager,
    /function preflightWebGPUDynamicEnvironmentMap\([\s\S]*?!isDynamicEnvironmentCacheCurrent\([\s\S]*?destroyWebGPUDynamicEnvironmentMapResources\(manager\)/,
  );
  assert.match(model, /if \(environmentMapManager\.shouldRegenerateShaders\)/);
});
