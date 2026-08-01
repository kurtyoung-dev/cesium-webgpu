import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const managerPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
);
const capturePath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapCapture.ts",
);
const globeProviderPath = path.join(
  root,
  "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js",
);
const tileProviderPath = path.join(
  root,
  "packages/engine/Source/Scene/GlobeSurfaceTileProvider.js",
);
const frameStatePath = path.join(
  root,
  "packages/engine/Source/Scene/FrameState.js",
);
const scenePath = path.join(root, "packages/engine/Source/Scene/Scene.js");
const managerSource = fs
  .readFileSync(managerPath, "utf8")
  .replace(/\r\n/g, "\n");
const captureSource = fs
  .readFileSync(capturePath, "utf8")
  .replace(/\r\n/g, "\n");
const globeProviderSource = fs
  .readFileSync(globeProviderPath, "utf8")
  .replace(/\r\n/g, "\n");
const tileProviderSource = fs
  .readFileSync(tileProviderPath, "utf8")
  .replace(/\r\n/g, "\n");
const frameStateSource = fs
  .readFileSync(frameStatePath, "utf8")
  .replace(/\r\n/g, "\n");
const sceneSource = fs.readFileSync(scenePath, "utf8").replace(/\r\n/g, "\n");

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source anchor: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source anchor: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("dynamic environment caches are owned by one device generation", () => {
  const cacheShape = sourceSection(
    managerSource,
    "interface DynEnvMapCache {",
    "/**\n * Update WebGPU dynamic environment map resources.",
  );
  assert.match(cacheShape, /\bdevice:\s*GPUDevice;/);
  assert.match(cacheShape, /\bresourceGeneration:\s*number;/);

  const update = sourceSection(
    managerSource,
    "function updateWebGPUDynamicEnvironmentMap(",
    "// Audit re-review (Batch 134)",
  );
  const mismatchIndex = update.indexOf("existingCache.device !== device ||");
  const generationIndex = update.indexOf(
    "existingCache.resourceGeneration !== resourceGeneration",
  );
  const supportGateIndex = update.indexOf("// Check basic support conditions");
  const initializationIndex = update.indexOf(
    "manager._webgpuCache = {\n      device,\n      resourceGeneration,",
  );

  assert.ok(mismatchIndex >= 0, "device identity mismatch must invalidate");
  assert.ok(
    generationIndex > mismatchIndex,
    "the recovery generation must participate in invalidation",
  );
  assert.ok(
    supportGateIndex > generationIndex,
    "invalidation must precede enabled/update early returns",
  );
  assert.ok(
    initializationIndex > supportGateIndex,
    "new caches must record the current device generation",
  );
  assert.match(
    update.slice(mismatchIndex, supportGateIndex),
    /destroyWebGPUDynamicEnvironmentMapResources\(manager\);/,
  );
});

test("identity and recovery epochs reject every stale cache case", () => {
  const currentDevice = {};
  const replacementDevice = {};
  const requiresInvalidation = (
    cacheDevice,
    cacheGeneration,
    device,
    generation,
  ) => cacheDevice !== device || cacheGeneration !== generation;

  assert.equal(
    requiresInvalidation(currentDevice, 7, currentDevice, 7),
    false,
    "the current cache must stay reusable",
  );
  assert.equal(
    requiresInvalidation(currentDevice, 7, replacementDevice, 7),
    true,
    "a replacement device must reject the old cache",
  );
  assert.equal(
    requiresInvalidation(currentDevice, 7, currentDevice, 8),
    true,
    "a recovery epoch change must reject the old cache",
  );
  assert.equal(
    requiresInvalidation(undefined, undefined, currentDevice, 0),
    true,
    "a cache created before ownership tracking must be rebuilt",
  );
});

test("cache destruction releases capture depth and clears published handles", () => {
  const destroy = sourceSection(
    managerSource,
    "function destroyWebGPUDynamicEnvironmentMapResources(",
    "\nexport {",
  );

  assert.match(
    destroy,
    /if \(cache\.captureDepthTexture\) \{\s*cache\.captureDepthTexture\.destroy\(\);\s*\}/,
  );

  const destroyDepthIndex = destroy.indexOf(
    "cache.captureDepthTexture.destroy();",
  );
  const nullTextureIndex = destroy.indexOf("cache.captureDepthTexture = null;");
  const nullViewIndex = destroy.indexOf("cache.captureDepthView = null;");
  const resetSizeIndex = destroy.indexOf("cache.captureDepthSize = 0;");
  const discardCacheIndex = destroy.indexOf(
    "manager._webgpuCache = undefined;",
  );

  assert.ok(
    destroyDepthIndex < nullTextureIndex &&
      nullTextureIndex < nullViewIndex &&
      nullViewIndex < resetSizeIndex &&
      resetSizeIndex < discardCacheIndex,
    "capture depth must be destroyed and detached before the cache is discarded",
  );

  for (const clear of [
    "manager._radianceMap = null;",
    "manager._webgpuIBLDiffuseView = null;",
    "manager._webgpuIBLSpecularView = null;",
    "manager._webgpuIBLSampler = null;",
    "manager._webgpuSHBuffer = null;",
  ]) {
    assert.ok(
      destroy.includes(clear),
      `destroy must clear the published old-device handle: ${clear}`,
    );
  }
});

test("recovered scene capture wakes from a frame/content-stamped producer edge", () => {
  const readiness = sourceSection(
    captureSource,
    "export function hasRenderableSceneCaptureSources(",
    "\n/**\n * Run the 6-face globe scene capture",
  );
  assert.match(readiness, /sources\.frameNumber === frameNumber/);
  assert.match(readiness, /sources\.frameNumber === frameNumber - 1/);
  assert.match(readiness, /tiles\.length > 0/);
  assert.match(readiness, /frameState\.globeVisible === false/);
  assert.match(
    readiness,
    /sources\.contentRevision ===\s*\(sources\.tileProvider\._sceneCaptureContentRevision \?\? 0\)/,
  );
  assert.match(
    captureSource,
    /export function getRenderableSceneCaptureSourceRevision\(/,
  );

  const capture = sourceSection(
    captureSource,
    "export function runSceneCapture(",
    "\n}",
  );
  assert.match(capture, /\): SceneCaptureResultValue \{/);
  assert.match(capture, /!hasRenderableSceneCaptureSources\(frameState\)/);
  assert.match(capture, /return SceneCaptureResult\.FAILED;/);
  assert.match(capture, /return SceneCaptureResult\.SKY_ONLY;/);
  assert.match(
    capture,
    /if \(!encoder \|\| globeDrawCount \+ modelDrawCount === 0\)/,
  );
  assert.match(capture, /device\.queue\.submit\(\[encoder\.finish\(\)\]\);/);
  assert.match(capture, /return SceneCaptureResult\.SUBMITTED;/);

  const publication = sourceSection(
    globeProviderSource,
    "function publishWebGPUSceneCaptureSources(",
    "\n}\n\n// ═",
  );
  assert.match(
    publication,
    /let sources = context\._webgpuSceneCaptureSources;/,
  );
  assert.match(
    publication,
    /sources\.publicationRevision =\s*\(sources\.publicationRevision \?\? 0\) \+ 1;/,
  );
  assert.match(publication, /sources\.contentRevision === contentRevision/);
  assert.match(
    publication,
    /sources\.frameNumber = frameNumber;\s*sources\.globeRenderer = globeRenderer;\s*sources\.tileProvider = tileProvider;\s*sources\.contentRevision = contentRevision;/,
  );
  assert.match(
    publication,
    /frameState\.afterRender\.push\(requestRenderForSceneCapturePublication\);/,
  );

  const update = sourceSection(
    managerSource,
    "function updateWebGPUDynamicEnvironmentMap(",
    "// Audit re-review (Batch 134)",
  );
  assert.match(
    update,
    /shouldRefreshSceneCapture\(cache, manager\._position, captureSourceRevision\)/,
  );
  assert.match(
    managerSource,
    /captureSourceRevision !== cache\.lastCaptureAttemptSourceRevision \|\|\s*captureMoved \|\|\s*cache\.framesSinceCaptureAttempt >= CAPTURE_EVERY_K_FRAMES/,
  );
  assert.match(
    update,
    /sceneCaptureResult = runSceneCapture\([\s\S]*?updateSceneCaptureAttemptBookkeeping\([\s\S]*?updateSceneCaptureBookkeeping\([\s\S]*?sceneCaptureResult === SceneCaptureResult\.SUBMITTED/,
  );
  assert.match(
    update,
    /shouldResetSceneCaptureHistory\([\s\S]*?cache\.historyValid = false;/,
  );
  assert.match(update, /if \(wantTemporal\) \{\s*runEnvCubeTemporalBlend/);
  assert.match(
    update,
    /cache\.needsUpdate = false;/,
    "a miss must settle on the sky fallback instead of spinning requestRenderMode",
  );
});

test("hidden and opt-out transitions erase retained globe state without a retry loop", () => {
  assert.match(frameStateSource, /this\.globeVisible = false;/);
  assert.match(
    sceneSource,
    /frameState\.globeVisible = defined\(this\.globe\) && this\.globe\.show;/,
  );

  const update = sourceSection(
    managerSource,
    "function updateWebGPUDynamicEnvironmentMap(",
    "// Audit re-review (Batch 134)",
  );
  assert.match(
    update,
    /const captureModeChanged =\s*sceneCaptureMode !== cache\.lastSceneCaptureMode;/,
  );
  assert.match(
    update,
    /cloudMarchPathChanged \|\|\s*captureModeChanged \|\|\s*captureSourceStateChanged \|\|\s*captureRefresh/,
    "capture mode/source changes must force one fresh sky fill",
  );
  assert.match(
    update,
    /runProceduralSkyFill\([\s\S]*?if \(wantCapture\) \{/,
    "opt-out must fill sky but skip scene replay",
  );

  const publication = sourceSection(
    globeProviderSource,
    "function publishWebGPUSceneCaptureSources(",
    "\n}\n\n// ═",
  );
  const wakeMatches = publication.match(
    /frameState\.afterRender\.push\(requestRenderForSceneCapturePublication\);/g,
  );
  assert.equal(
    wakeMatches?.length,
    1,
    "the producer owns exactly one wake site",
  );
  assert.doesNotMatch(
    managerSource,
    /afterRender\.push\([^)]*SceneCapture/,
    "the manager must not schedule capture retries",
  );
});

test("stable-provider selection and resource changes advance one content epoch", () => {
  const contentUpdate = sourceSection(
    tileProviderSource,
    "function updateSceneCaptureContentRevision(",
    // The v1.144 merge restored upstream's @import JSDoc block between the
    // final scene-capture helper and the class JSDoc.
    "/** @import",
  );
  assert.match(
    contentUpdate,
    /frameState\.context\.sceneCaptureReflections !== true/,
    "the selection scan must remain opt-in",
  );
  assert.match(
    contentUpdate,
    /const tiles = tileProvider\._quadtree\._tilesToRender;/,
  );
  assert.match(contentUpdate, /surfaceTile\?\.renderedMesh/);
  assert.match(contentUpdate, /readyImagery\?\.texture \?\? readyImagery/);
  assert.match(
    contentUpdate,
    /markSceneCaptureContentChanged\(tileProvider\);/,
  );
  assert.match(
    tileProviderSource,
    /this\._sceneCaptureResourceIds = undefined;/,
  );
  assert.match(
    tileProviderSource,
    /this\._terrainProvider = terrainProvider;\s*markSceneCaptureContentChanged\(this\);/,
  );
  assert.match(
    tileProviderSource,
    /updateSceneCaptureContentRevision\(this, frameState\);/,
  );
  assert.ok(
    tileProviderSource.match(/markSceneCaptureContentChanged\(this\);/g)
      ?.length >= 4,
    "terrain, exaggeration, and imagery mutations must feed the epoch",
  );
  assert.doesNotMatch(
    contentUpdate,
    /\.map\(|\.slice\(|\[\.\.\./,
    "the selected-resource scan must not allocate per-tile collections",
  );
});

test("source/provider changes and failed replay explicitly reset temporal history", () => {
  const historyPolicy = sourceSection(
    managerSource,
    "function shouldResetSceneCaptureHistory(",
    "\n}\n\n/**\n * Decide whether a renderable source publication",
  );
  assert.match(
    historyPolicy,
    /sceneCaptureMode !== cache\.lastSceneCaptureMode/,
  );
  assert.match(
    historyPolicy,
    /captureSourceRevision !== cache\.lastSceneCaptureSourceRevision/,
  );
  assert.match(
    historyPolicy,
    /sceneCaptureResult !== cache\.lastSceneCaptureResult/,
  );
  assert.match(
    historyPolicy,
    /sceneCaptureResult !== SceneCaptureResult\.SUBMITTED/,
  );
});
