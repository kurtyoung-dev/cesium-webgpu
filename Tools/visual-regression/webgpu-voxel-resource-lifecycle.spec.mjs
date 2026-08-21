// @purpose Drives real WebGPUVoxelResourceLifecycle exports (retain/release, atlas slot publish/retire/LRU, async-failure capture) plus structural pins.
// @status ACTIVE

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  VOXEL_PICK_SLOT_REUSE_GUARD_FRAMES,
  captureVoxelResourceLifecycleToken,
  createVoxelAsyncFailureState,
  createVoxelResourceLifecycle,
  detachVoxelResourceLifecycle,
  disposeAllVoxelContents,
  disposeVoxelContentOnce,
  ensureVoxelAtlasSlotCapacity,
  isVoxelAtlasSlotPickSafe,
  isVoxelResourceLifecycleCurrent,
  publishVoxelAtlasSlot,
  recordVoxelAsyncFailure,
  releaseVoxelContent,
  retireVoxelAtlasSlot,
  retainVoxelContent,
  resetVoxelAsyncFailure,
  selectVoxelAtlasLruVictim,
  stampVoxelAtlasDemandFrame,
  takeVoxelAsyncFailure,
  tryRetainVoxelContentForToken,
} from "../../packages/engine/Source/Renderer/WebGPU/WebGPUVoxelResourceLifecycle.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const read = (relativePath) =>
  readFileSync(path.join(ROOT, relativePath), "utf8").replaceAll("\r\n", "\n");

function assessVoxelFailureSafety(upload) {
  const failures = [];
  const cleanupStart = upload.indexOf(
    "function destroyVoxelTextureBestEffort(",
  );
  const cleanupEnd = upload.indexOf(
    "function releaseTileContent(",
    cleanupStart,
  );
  const cleanup = upload.slice(cleanupStart, cleanupEnd);
  if (
    cleanupStart < 0 ||
    cleanupEnd <= cleanupStart ||
    !/try \{[\s\S]*?texture\?\.destroy\(\);[\s\S]*?\} catch \{/.test(cleanup)
  ) {
    failures.push(
      "root texture cleanup must be attempted behind an exception barrier",
    );
  }

  const gpuStart = upload.indexOf("view = texture.createView();");
  const gpuEnd = upload.indexOf("state.texture = texture;", gpuStart);
  const gpuCatch = upload.slice(gpuStart, gpuEnd);
  const recordIndex = gpuCatch.indexOf("failRootVoxelTile(");
  const cleanupIndex = gpuCatch.indexOf("destroyVoxelTextureBestEffort(");
  if (
    gpuStart < 0 ||
    gpuEnd <= gpuStart ||
    recordIndex < 0 ||
    cleanupIndex <= recordIndex ||
    gpuCatch.includes("texture?.destroy()")
  ) {
    failures.push(
      "root upload failure must be recorded before nonthrowing cleanup",
    );
  }

  const staticStart = upload.indexOf("function driveTileLevelUploads(");
  const staticEnd = upload.indexOf(
    "function driveDynamicL2Uploads(",
    staticStart,
  );
  const staticDrive = upload.slice(staticStart, staticEnd);
  if (
    !/if \(child\.phase === "idle"\) \{[\s\S]*?try \{[\s\S]*?provider\.requestData\([\s\S]*?\} catch \{[\s\S]*?failTile\(state, child\);[\s\S]*?settled\+\+;[\s\S]*?continue;/.test(
      staticDrive,
    )
  ) {
    failures.push(
      "static descendant synchronous failure must settle to ancestor fallback",
    );
  }

  const dynamicStart = upload.indexOf("function driveDynamicL2Uploads(");
  const dynamicDrive = upload.slice(dynamicStart);
  if (
    !/if \(tile\.phase === "idle"\) \{[\s\S]*?try \{[\s\S]*?provider\.requestData\([\s\S]*?\} catch \{[\s\S]*?failTile\(state, tile\);[\s\S]*?continue;/.test(
      dynamicDrive,
    )
  ) {
    failures.push(
      "dynamic descendant synchronous failure must retain ancestor fallback",
    );
  }
  return failures;
}

function createFakeContent() {
  let destroyed = false;
  let destroyCalls = 0;
  return {
    get destroyCalls() {
      return destroyCalls;
    },
    isDestroyed() {
      return destroyed;
    },
    destroy() {
      destroyCalls++;
      destroyed = true;
    },
  };
}

test("voxel resource lifecycle is anchored to exact device and generation", () => {
  const deviceA = { label: "device-a" };
  const deviceB = { label: "device-b" };
  const lifecycle = createVoxelResourceLifecycle(deviceA, 7);

  assert.equal(isVoxelResourceLifecycleCurrent(lifecycle, deviceA, 7), true);
  assert.equal(isVoxelResourceLifecycleCurrent(lifecycle, deviceB, 7), false);
  assert.equal(isVoxelResourceLifecycleCurrent(lifecycle, deviceA, 8), false);

  detachVoxelResourceLifecycle(lifecycle);
  assert.equal(isVoxelResourceLifecycleCurrent(lifecycle, deviceA, 7), false);
});

test("pending content completion after teardown is destroyed and never retained", async () => {
  const lifecycle = createVoxelResourceLifecycle({ label: "device" }, 1);
  const token = captureVoxelResourceLifecycleToken(lifecycle);
  const content = createFakeContent();
  let resolveContent;
  const pending = new Promise((resolve) => {
    resolveContent = resolve;
  }).then((resolved) =>
    tryRetainVoxelContentForToken(lifecycle, token, resolved),
  );

  detachVoxelResourceLifecycle(lifecycle);
  disposeAllVoxelContents(lifecycle);
  resolveContent(content);

  assert.equal(await pending, false);
  assert.equal(content.destroyCalls, 1);
  assert.equal(lifecycle.contentRefCounts.size, 0);

  // A duplicated late completion cannot destroy the same loader twice.
  assert.equal(tryRetainVoxelContentForToken(lifecycle, token, content), false);
  assert.equal(content.destroyCalls, 1);
  assert.equal(lifecycle.contentRefCounts.size, 0);
});

test("pipeline rejection is terminal for one tuple and resettable for recovery", () => {
  const device = { label: "device" };
  const lifecycle = createVoxelResourceLifecycle(device, 2);
  const token = captureVoxelResourceLifecycleToken(lifecycle);
  const failure = createVoxelAsyncFailureState();

  const first = recordVoxelAsyncFailure(
    lifecycle,
    token,
    failure,
    new Error("shader rejected"),
  );
  assert.equal(first?.message, "shader rejected");
  assert.equal(failure.error, first);
  assert.equal(
    takeVoxelAsyncFailure(failure),
    first,
    "the failure surface must preserve the exact recorded Error identity",
  );
  assert.equal(
    takeVoxelAsyncFailure(failure),
    null,
    "one terminal failure must surface at most once",
  );
  assert.equal(
    recordVoxelAsyncFailure(lifecycle, token, failure, "retry"),
    null,
    "one tuple must log/store only its first terminal failure",
  );

  detachVoxelResourceLifecycle(lifecycle);
  resetVoxelAsyncFailure(failure);
  assert.equal(
    recordVoxelAsyncFailure(lifecycle, token, failure, "late rejection"),
    null,
  );

  const recovered = createVoxelResourceLifecycle(device, 3);
  const recoveredFailure = createVoxelAsyncFailureState();
  assert.equal(
    recordVoxelAsyncFailure(
      recovered,
      captureVoxelResourceLifecycleToken(recovered),
      recoveredFailure,
      "new-generation rejection",
    )?.message,
    "new-generation rejection",
  );
});

test("non-Error asynchronous reasons preserve their exact cause", () => {
  const lifecycle = createVoxelResourceLifecycle({ label: "device" }, 1);
  const token = captureVoxelResourceLifecycleToken(lifecycle);
  const objectReason = { code: "sentinel" };
  const objectFailure = createVoxelAsyncFailureState();
  const normalized = recordVoxelAsyncFailure(
    lifecycle,
    token,
    objectFailure,
    objectReason,
  );
  assert.equal(
    normalized?.message,
    "Unknown WebGPU voxel asynchronous failure",
  );
  assert.equal(normalized?.cause, objectReason);

  const stringFailure = createVoxelAsyncFailureState();
  const stringReason = "provider rejected";
  const normalizedString = recordVoxelAsyncFailure(
    lifecycle,
    token,
    stringFailure,
    stringReason,
  );
  assert.equal(normalizedString?.message, stringReason);
  assert.equal(normalizedString?.cause, stringReason);
});

test("throwing content cleanup is isolated and every sibling is drained", () => {
  const lifecycle = createVoxelResourceLifecycle({ label: "device" }, 1);
  let throwingDestroyCalls = 0;
  let siblingDestroyCalls = 0;
  const throwing = {
    isDestroyed() {
      throw new Error("status failed");
    },
    destroy() {
      throwingDestroyCalls++;
      throw new Error("destroy failed");
    },
  };
  const sibling = {
    isDestroyed: () => false,
    destroy() {
      siblingDestroyCalls++;
    },
  };
  retainVoxelContent(lifecycle, throwing);
  retainVoxelContent(lifecycle, sibling);

  assert.doesNotThrow(() => disposeAllVoxelContents(lifecycle));
  assert.equal(throwingDestroyCalls, 1);
  assert.equal(siblingDestroyCalls, 1);
  assert.equal(lifecycle.contentRefCounts.size, 0);
  assert.doesNotThrow(() => releaseVoxelContent(lifecycle, throwing));
  assert.equal(
    throwingDestroyCalls,
    1,
    "cleanup remains exact-once after failure",
  );
});

test("root cleanup ordering and descendant synchronous fallbacks fail closed", () => {
  const upload = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUVoxelDataUpload.ts",
  );
  assert.deepEqual(assessVoxelFailureSafety(upload), []);

  const reversedCleanup = upload.replace(
    /failRootVoxelTile\(state, state\.requestLifecycleToken, reason\);\s*destroyVoxelTextureBestEffort\(texture\);/,
    "destroyVoxelTextureBestEffort(texture);\n    failRootVoxelTile(state, state.requestLifecycleToken, reason);",
  );
  assert.notEqual(reversedCleanup, upload);
  assert.ok(assessVoxelFailureSafety(reversedCleanup).length > 0);

  const unguardedCleanup = upload.replace(
    /function destroyVoxelTextureBestEffort\(texture: GPUTexture \| null\): void \{[\s\S]*?\n\}/,
    "function destroyVoxelTextureBestEffort(texture: GPUTexture | null): void {\n  texture?.destroy();\n}",
  );
  assert.notEqual(unguardedCleanup, upload);
  assert.ok(assessVoxelFailureSafety(unguardedCleanup).length > 0);

  const skippedCleanup = upload.replace("texture?.destroy();", "void texture;");
  assert.notEqual(skippedCleanup, upload);
  assert.ok(assessVoxelFailureSafety(skippedCleanup).length > 0);

  const staticWithoutCatch = upload.replace(
    "try {\n        promise = provider.requestData({\n          tileLevel: level,",
    "if (true) {\n        promise = provider.requestData({\n          tileLevel: level,",
  );
  assert.notEqual(staticWithoutCatch, upload);
  assert.ok(assessVoxelFailureSafety(staticWithoutCatch).length > 0);

  const dynamicWithoutCatch = upload.replace(
    "try {\n        promise = provider.requestData({\n          tileLevel: 2,",
    "if (true) {\n        promise = provider.requestData({\n          tileLevel: 2,",
  );
  assert.notEqual(dynamicWithoutCatch, upload);
  assert.ok(assessVoxelFailureSafety(dynamicWithoutCatch).length > 0);
});

test("mandatory root upload failures retain their reason and surface once", () => {
  const upload = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUVoxelDataUpload.ts",
  );
  const renderer = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts",
  );

  assert.match(upload, /rootFailure: VoxelAsyncFailureState/);
  assert.match(upload, /rootFailure: createVoxelAsyncFailureState\(\)/);
  assert.match(
    upload,
    /function failRootVoxelTile[\s\S]*?recordVoxelAsyncFailure\([\s\S]*?state\.rootFailure,[\s\S]*?reason,[\s\S]*?state\.phase = "failed";/,
    "the root state machine must record the exact terminal reason before entering failed",
  );
  const rootStart = upload.indexOf("export function tryUploadRootVoxelTile(");
  const rootEnd = upload.indexOf("function driveTileLevelUploads(", rootStart);
  const rootUpload = upload.slice(rootStart, rootEnd);
  assert.ok(rootStart >= 0 && rootEnd > rootStart);
  assert.match(rootUpload, /provider\.requestData\([\s\S]*?catch \(reason\)/);
  assert.match(rootUpload, /\.catch\(\(reason\) =>/);
  assert.match(rootUpload, /content\.update\([\s\S]*?catch \(reason\)/);
  assert.match(rootUpload, /expandToRGBA\([\s\S]*?catch \(reason\)/);
  assert.match(rootUpload, /device\.createTexture\([\s\S]*?catch \(reason\)/);
  assert.equal(
    (rootUpload.match(/failRootVoxelTile\(/g) ?? []).length,
    7,
    "every mandatory request/process/metadata/upload failure must enter the recorded root failure path",
  );
  assert.doesNotMatch(
    rootUpload,
    /catch\s*\{[\s\S]*?state\.phase = "failed"/,
    "a caught root failure may not discard its reason",
  );

  const rootFailureReportStart = renderer.indexOf(
    "function reportVoxelRootUploadFailure(",
  );
  const rootFailureReportEnd = renderer.indexOf(
    "function createVoxelCache(",
    rootFailureReportStart,
  );
  const rootFailureReport = renderer.slice(
    rootFailureReportStart,
    rootFailureReportEnd,
  );
  assert.ok(
    rootFailureReportStart >= 0 &&
      rootFailureReportEnd > rootFailureReportStart,
  );
  const rootFailureReportPattern =
    /takeVoxelAsyncFailure\(cache\.dataUpload\.rootFailure\)[\s\S]*?const message = failure instanceof Error \? failure\.message : String\(failure\);[\s\S]*?cache\.context\.log\([\s\S]*?`VoxelPrimitive root tile upload failed: \$\{message\}`[\s\S]*?tileFailed\?\.raiseEvent\?\.\(\);/;
  assert.match(rootFailureReport, rootFailureReportPattern);
  assert.doesNotMatch(rootFailureReport, /\bthrow\b/u);
  const repeatedRootFailure = rootFailureReport.replace(
    "takeVoxelAsyncFailure(cache.dataUpload.rootFailure)",
    "peekVoxelAsyncFailure(cache.dataUpload.rootFailure)",
  );
  assert.notEqual(repeatedRootFailure, rootFailureReport);
  assert.doesNotMatch(repeatedRootFailure, rootFailureReportPattern);
  const uploadDrive = renderer.indexOf("tryUploadRootVoxelTile(");
  const uploadReport = renderer.indexOf(
    "reportVoxelRootUploadFailure(cache, primitive)",
    uploadDrive,
  );
  assert.ok(uploadDrive >= 0 && uploadReport > uploadDrive);
});

test("retained aliases release their shared VoxelContent exactly once", () => {
  const lifecycle = createVoxelResourceLifecycle({ label: "device" }, 1);
  const content = createFakeContent();

  assert.equal(retainVoxelContent(lifecycle, content), true);
  assert.equal(retainVoxelContent(lifecycle, content), true);
  assert.equal(lifecycle.contentRefCounts.get(content), 2);

  releaseVoxelContent(lifecycle, content);
  assert.equal(content.destroyCalls, 0);
  assert.equal(lifecycle.contentRefCounts.get(content), 1);

  releaseVoxelContent(lifecycle, content);
  releaseVoxelContent(lifecycle, content);
  assert.equal(content.destroyCalls, 1);
  assert.equal(lifecycle.contentRefCounts.size, 0);
});

test("disposeAll drops strong refs and deduplicates aliases and pre-destroyed content", () => {
  const lifecycle = createVoxelResourceLifecycle({ label: "device" }, 1);
  const alias = createFakeContent();
  const alreadyDestroyed = {
    destroyCalls: 0,
    isDestroyed: () => true,
    destroy() {
      this.destroyCalls++;
    },
  };
  retainVoxelContent(lifecycle, alias);
  retainVoxelContent(lifecycle, alias);
  retainVoxelContent(lifecycle, alreadyDestroyed);

  detachVoxelResourceLifecycle(lifecycle);
  disposeAllVoxelContents(lifecycle);
  disposeAllVoxelContents(lifecycle);

  assert.equal(alias.destroyCalls, 1);
  assert.equal(alreadyDestroyed.destroyCalls, 0);
  assert.equal(lifecycle.contentRefCounts.size, 0);
  disposeVoxelContentOnce(lifecycle, alias);
  assert.equal(alias.destroyCalls, 1);
});

test("dynamic atlas identity accepts the first matching read and rejects ABA", () => {
  const lifecycle = createVoxelResourceLifecycle({ label: "device" }, 1, 3);
  assert.ok(lifecycle.slotGenerations instanceof Float64Array);
  assert.equal(lifecycle.slotGenerations.length, 3);
  ensureVoxelAtlasSlotCapacity(lifecycle, 10);
  assert.equal(lifecycle.slotGenerations.length, 10);
  assert.equal(publishVoxelAtlasSlot(lifecycle, 10, 0), 0);
  const first = publishVoxelAtlasSlot(lifecycle, 9, 10);
  assert.equal(first, 1);
  assert.equal(lifecycle.atlasReuseEpoch, 0);
  assert.equal(lifecycle.contentRevision, 1);
  assert.equal(isVoxelAtlasSlotPickSafe(lifecycle, 9, first, 10), true);

  const reused = publishVoxelAtlasSlot(lifecycle, 9, 20);
  assert.equal(reused, 2);
  assert.equal(lifecycle.atlasReuseEpoch, 1);
  assert.equal(lifecycle.contentRevision, 2);
  assert.equal(isVoxelAtlasSlotPickSafe(lifecycle, 9, first, 20), false);
  assert.equal(isVoxelAtlasSlotPickSafe(lifecycle, 9, reused, 20), true);
  assert.equal(VOXEL_PICK_SLOT_REUSE_GUARD_FRAMES, 0);

  // Crossing the old Uint32 wrap boundary remains a distinct safe integer.
  lifecycle.slotGenerations[8] = 0xffffffff;
  const beyondUint32 = publishVoxelAtlasSlot(lifecycle, 8);
  assert.equal(beyondUint32, 0x100000000);
  assert.equal(isVoxelAtlasSlotPickSafe(lifecycle, 8, 1), false);
  assert.equal(isVoxelAtlasSlotPickSafe(lifecycle, 8, beyondUint32), true);

  // Exhaustion fails closed instead of wrapping into an old identity.
  lifecycle.slotGenerations[7] = Number.MAX_SAFE_INTEGER;
  assert.throws(
    () => publishVoxelAtlasSlot(lifecycle, 7),
    /generation space exhausted/,
  );
});

test("the complete dynamic L2 demand set is protected before victim selection", () => {
  const frameIndex = 12;
  const states = Array.from({ length: 4 }, () => ({ lastDemandFrame: 1 }));
  const slots = new Float32Array([-1, 10, 11, 12]);
  const demandMask = new Uint8Array([1, 0, 0, 1]);

  assert.equal(
    stampVoxelAtlasDemandFrame(states, 2, demandMask, frameIndex),
    2,
  );
  assert.equal(states[3].lastDemandFrame, frameIndex);
  assert.equal(
    selectVoxelAtlasLruVictim(slots, states, frameIndex),
    1,
    "a later-index resident demanded this frame must not be evicted by an earlier upload",
  );

  const lifecycle = createVoxelResourceLifecycle({ label: "device" }, 1, 13);
  const generation = publishVoxelAtlasSlot(lifecycle, 10);
  const revision = lifecycle.contentRevision;
  assert.equal(retireVoxelAtlasSlot(lifecycle, 10, generation), true);
  assert.equal(lifecycle.contentRevision, revision + 1);
  assert.equal(
    retireVoxelAtlasSlot(lifecycle, 10, generation),
    false,
    "the same slot generation must retire at most once",
  );
});

test("renderer and upload state wire lifecycle guards at every publication boundary", () => {
  const renderer = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts",
  );
  const upload = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUVoxelDataUpload.ts",
  );
  const primitive = read("packages/engine/Source/Scene/VoxelPrimitive.js");
  const registry = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts",
  );
  const contract = read("packages/engine/Source/Renderer/GraphicsContext.ts");

  const updateStart = renderer.indexOf("function updateWebGPUVoxelPrimitive(");
  const tupleCheck = renderer.indexOf(
    "!isVoxelResourceLifecycleCurrent(",
    updateStart,
  );
  const showReturn = renderer.indexOf("if (!primitive.show)", updateStart);
  assert.ok(tupleCheck > updateStart && tupleCheck < showReturn);
  assert.match(renderer, /cache &&\s*isVoxelCacheLive\(cache\)/);
  assert.equal(
    (renderer.match(/isVoxelResourceLifecycleTokenCurrent\(/g) ?? []).length >=
      6,
    true,
  );
  assert.match(renderer, /destroyVoxelDataUploadState\(cache\.dataUpload\)/);
  assert.match(
    renderer,
    /function destroyVoxelInitializationResources[\s\S]*?cache\.uniformBuffer\?\.destroy\(\);[\s\S]*?cache\.voxelTexture\?\.destroy\(\);/,
  );
  assert.match(
    renderer,
    /destroyVoxelInitializationResources\(cache\);[\s\S]*?cache\.pipeline = null;/,
    "format/MSAA invalidation must dispose replaced owner resources",
  );
  assert.match(
    renderer,
    /cache\.voxelTextureView !== realDataView[\s\S]*?resource: realDataView/,
    "format rebuild must rebind the retained real atlas instead of the placeholder",
  );
  assert.match(renderer, /isVoxelDataUploadSlotPickSafe\(/);
  assert.equal(
    (renderer.match(/recordVoxelPipelineFailure\(/g) ?? []).length >= 7,
    true,
    "primary, cell-pick, and velocity async/sync failures must be terminal",
  );
  assert.match(renderer, /if \(cache\.pipelineFailure\.error\)/);
  const resolveStart = renderer.indexOf("function tryResolveVoxelPipelines(");
  const terminalGate = renderer.indexOf(
    "if (cache.pipelineFailure.error)",
    resolveStart,
  );
  const primaryRequest = renderer.indexOf(
    "pipelineCache.getPipeline(colorDesc)",
    resolveStart,
  );
  assert.ok(
    terminalGate > resolveStart && terminalGate < primaryRequest,
    "a rejected primary pipeline must not be requested again every frame",
  );
  assert.match(
    renderer,
    /function throwUnreportedVoxelPrimaryPipelineFailure[\s\S]*?cache\.pipelineFailureReported = true;[\s\S]*?throw error;/,
    "the next owner update must observe a primary pipeline rejection once",
  );
  const updateThrow = renderer.indexOf(
    "throwUnreportedVoxelPrimaryPipelineFailure(cache)",
    updateStart,
  );
  const updateResolve = renderer.indexOf(
    "!tryResolveVoxelPipelines(",
    updateStart,
  );
  assert.ok(updateThrow > showReturn && updateThrow < updateResolve);
  assert.match(renderer, /!cache\.pickVoxelPipelineFailure\.error/);
  assert.match(renderer, /!cache\.velocityPipelineFailure\.error/);

  assert.equal(
    (upload.match(/captureVoxelResourceLifecycleToken\(/g) ?? []).length,
    3,
    "root, static descendant, and dynamic L2 requests need epoch tokens",
  );
  assert.match(
    upload,
    /function evictLruL2Slot[\s\S]*?releaseTileContent\(state, tile\)/,
  );
  const dynamicL2Start = upload.indexOf("function driveDynamicL2Uploads(");
  const demandPrepass = upload.indexOf(
    "stampVoxelAtlasDemandFrame(",
    dynamicL2Start,
  );
  const allocationLoop = upload.indexOf(
    "for (let i = 0; i < 64; i++)",
    dynamicL2Start,
  );
  assert.ok(
    demandPrepass > dynamicL2Start && demandPrepass < allocationLoop,
    "the complete demand set must be stamped before any tile can allocate or evict",
  );
  assert.match(upload, /disposeAllVoxelContents\(state\.lifecycle\)/);
  assert.match(upload, /state\.content = null;[\s\S]*?levels = \[/);
  assert.doesNotMatch(upload, /pickFrameIndex/);
  assert.match(upload, /isVoxelAtlasSlotPickSafe\(state\.lifecycle/);
  assert.match(
    primitive,
    /this\._featureRenderer === fr && fr\.isReady\(this\)/,
  );
  assert.match(primitive, /typeof fr\.isReady === "function"/);
  assert.match(primitive, /frameState\.afterRender\.push/);
  assert.match(renderer, /cache\.usingRealData/);
  assert.match(renderer, /cache\.dataUpload\?\.phase === "done"/);
  assert.match(
    renderer,
    /cache\.pipeline &&\s*cache\.pickPipeline &&\s*cache\.command/,
  );
  assert.match(registry, /isReady:\s*mod\.isWebGPUVoxelPrimitiveReady/);

  const keyframeHook = contract.indexOf("getPickKeyframeNode?(");
  const identityHook = contract.indexOf("getPickReadbackIdentity?(");
  const nextHook = contract.indexOf("prepareVectorTileData?(", identityHook);
  assert.ok(
    keyframeHook >= 0 && identityHook > keyframeHook && nextHook > identityHook,
    "the optional pick identity hook must live beside the voxel keyframe hook in the FeatureRenderer contract",
  );
  assert.match(
    contract,
    /getPickReadbackIdentity\?\(primitive: unknown\): unknown;/,
  );
  assert.match(
    primitive,
    /typeof featureRenderer\.getPickReadbackIdentity === "function"[\s\S]*?featureRenderer\.getPickReadbackIdentity\(this\)/,
  );
  assert.match(
    registry,
    /getPickKeyframeNode: mod\.getVoxelPickKeyframeNode,\s*getPickReadbackIdentity: mod\.getVoxelPickReadbackIdentity/,
  );
});
