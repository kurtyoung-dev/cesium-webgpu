// C12-33 — renderer-neutral texture-mip queue ownership and cube-layer safety.
// Run: node --test Tools/visual-regression/texture-mip-queue-safety.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

const context = read("packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts");
const generator = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUMipmapGenerator.ts",
);
const stub = read(
  "packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubTexture.ts",
);
const model = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts",
);
const globe = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTextures.ts",
);
const texture = read("packages/engine/Source/Renderer/WebGPU/WebGPUTexture.ts");
const cubeMap = read("packages/engine/Source/Renderer/WebGPU/WebGPUCubeMap.ts");
const environment = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
);

function between(source, startText, endText) {
  const start = source.indexOf(startText);
  assert.ok(start >= 0, `missing ${startText}`);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(end > start, `missing ${endText}`);
  return source.slice(start, end);
}

test("queued jobs carry an exact device-generation tuple and clear before recovery caches", () => {
  const enqueue = between(
    context,
    "enqueueTextureMipGeneration(",
    "enqueueImageryMipGeneration(",
  );
  const encode = between(
    context,
    "private _encodePendingTextureMipJobs()",
    "flushPendingTextureMipJobs()",
  );
  const clear = between(
    context,
    "public _clearAllCaches(",
    "public _rollbackRecoveredDevice(",
  );
  assert.match(enqueue, /device,/);
  assert.match(
    enqueue,
    /resourceGeneration:\s*this\._deviceResourceGeneration/,
  );
  assert.match(encode, /job\.device\s*!==\s*device/);
  assert.match(encode, /job\.resourceGeneration\s*!==\s*resourceGeneration/);
  assert.ok(
    clear.indexOf("this._pendingTextureMipJobs.length = 0") <
      clear.indexOf("this._cacheRegistry.clearAll()"),
  );
  const getter = between(
    context,
    "get mipmapGenerator()",
    "private _renderBundleManager",
  );
  assert.doesNotMatch(getter, /onDeviceInvalidated/);
});

test("exact duplicates coalesce while layer ranges remain part of the key", () => {
  const enqueue = between(
    context,
    "enqueueTextureMipGeneration(",
    "enqueueImageryMipGeneration(",
  );
  assert.match(enqueue, /_pendingTextureMipJobKeys\.get\(texture\)/);
  assert.match(
    enqueue,
    /format.*mipLevelCount.*dimension.*baseArrayLayer.*arrayLayerCount/s,
  );
  assert.match(enqueue, /if \(textureJobKeys\.has\(jobKey\)\)/);
  assert.match(context, /_pendingTextureMipJobKeys = new WeakMap/g);
});

test("cube generation encodes one 2D source and destination per face and mip", () => {
  assert.match(generator, /for \(let layerOffset = 0;/);
  assert.match(generator, /baseArrayLayer:\s*arrayLayer/);
  assert.match(generator, /arrayLayerCount:\s*1/);
  assert.match(generator, /dimension:\s*"2d"/);
  assert.match(stub, /dimension:[\s\S]*=== 6 \? "cube" : "2d"/);
  assert.match(stub, /arrayLayerCount:\s*realization\.depthOrArrayLayers/);
  assert.match(texture, /this\.isCubeMap[\s\S]*dimension:\s*"cube"/);
});

test("stub replacement and destruction cancel independently before native destroy", () => {
  assert.match(stub, /cancelMipGeneration\(previous\.texture\)/);
  assert.match(
    stub,
    /cancelMipGeneration\(native\.texture\)[\s\S]*native\.destroy\(\)/,
  );
  assert.match(
    stub,
    /logical\.mipLevelCount\s*===\s*allocation\.mipLevelCount/,
  );
});

test("model fallback owners retain stable queue sinks and cancel on every rebuild teardown", () => {
  assert.match(
    model,
    /_enqueueTextureMipGeneration:[\s\S]*enqueueTextureMipGeneration\.bind\(context\)/,
  );
  assert.match(
    model,
    /destroyPrimitiveCacheResources\([\s\S]*cancelMip\(tex\)[\s\S]*tex\.destroy\(\)/,
  );
  assert.match(
    model,
    /destroyPrimitiveCacheResources\([\s\S]*cache\._cancelTextureMipGeneration/,
  );
});

test("globe publication rolls back queued unpublished candidates", () => {
  const upload = between(globe, "export function uploadImageSource(", "}\n");
  assert.match(globe, /let unpublishedTexture: GPUTexture \| null = null/);
  assert.match(globe, /unpublishedTexture = texture/);
  assert.match(
    globe,
    /function destroyUnpublishedTexture\([\s\S]*cancelTextureMipGeneration\(texture\)[\s\S]*texture\.destroy\(\)/,
  );
  assert.match(globe, /table\.register\([\s\S]*unpublishedTexture = null/);
  assert.ok(upload.length > 0);
});

test("WebGPUCubeMap reserves a full immutable chain and uses the frame queue", () => {
  assert.match(cubeMap, /Math\.floor\(Math\.log2\(size\)\) \+ 1/);
  assert.match(
    cubeMap,
    /enqueueTextureMipGeneration\([\s\S]*dimension:\s*"cube"[\s\S]*arrayLayerCount:\s*6/,
  );
  assert.match(
    cubeMap,
    /else \{[\s\S]*texture\.generateMipmaps\(\)/,
    "standalone callers retain an explicit immediate fallback",
  );
  assert.match(cubeMap, /if \(accepted !== false\)[\s\S]*_hasMipmap = true/);
  assert.match(
    cubeMap,
    /cancelTextureMipGeneration\?\.\(texture\.texture\)[\s\S]*texture\.destroy\(\)/,
  );
  const sizeGetter = between(
    cubeMap,
    "get sizeInBytes()",
    "get preMultiplyAlpha()",
  );
  assert.doesNotMatch(sizeGetter, /_hasMipmap/);
  assert.match(cubeMap, /for \(let level = 0; level < mipLevelCount;/);
});

test("context image helpers enqueue frame-owned work without private mip submits", () => {
  const sync = between(
    context,
    "createTextureFromImage(",
    "async createTextureFromImageAsync(",
  );
  const asyncPath = between(
    context,
    "async createTextureFromImageAsync(",
    "createStagingBuffer(",
  );
  for (const source of [sync, asyncPath]) {
    assert.match(source, /enqueueTextureMipGeneration\(/);
    assert.match(source, /_deviceResourceGeneration !== resourceGeneration/);
    assert.doesNotMatch(source, /texture\.generateMipmaps|queue\.submit/);
  }
});

test("Moon owners cannot strand destruction when cancellation bookkeeping throws", () => {
  const hooks = between(
    environment,
    "function createMoonTextureRequestHooks(",
    "function invalidateMoonTextureBindings(",
  );
  const publication = between(
    environment,
    "function createMoonTexturePublicationCallbacks(",
    "function createFlatNormalPlaceholderTexture(",
  );
  assert.match(
    hooks,
    /cancelTextureMipGeneration\(texture\)[\s\S]*catch[\s\S]*texture\?\.destroy\(\)/,
  );
  assert.match(
    publication,
    /cancelTextureMipGeneration\(previous\)[\s\S]*catch[\s\S]*previous\.destroy\(\)/,
  );
});
