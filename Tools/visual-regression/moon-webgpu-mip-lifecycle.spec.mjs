// C12-33 — pins the WebGPU Moon's frame-owned mip-chain realization.
// Run: node --test Tools/visual-regression/moon-webgpu-mip-lifecycle.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

const contextSource = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts",
);
const stubSource = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUContextWebGLStubInit.ts",
);
const rendererSource = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
);
const lifecycleSource = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUMoonTextureLifecycle.js",
);

function functionSlice(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const end = source.indexOf(nextSignature, start + signature.length);
  assert.ok(end > start, `missing boundary ${nextSignature}`);
  return source.slice(start, end);
}

test("context exposes a canonical texture-mip enqueue while retaining the imagery alias", () => {
  const canonical = functionSlice(
    contextSource,
    "enqueueTextureMipGeneration(",
    "enqueueImageryMipGeneration(",
  );
  const alias = functionSlice(
    contextSource,
    "enqueueImageryMipGeneration(",
    "noteInlineTextureDestroy(",
  );

  assert.match(canonical, /_pendingTextureMipJobs\.push\(/);
  assert.doesNotMatch(
    contextSource,
    /_pendingImageryMipJobs|_encodePendingImageryMipJobs|ImageryMipPreparation/,
    "the shared queue internals must not retain renderer-specific naming",
  );
  assert.doesNotMatch(
    canonical,
    /queue\.submit|createCommandEncoder/,
    "enqueue must remain a pure frame-owned queue operation",
  );
  assert.match(alias, /this\.enqueueTextureMipGeneration\(/);
  assert.match(
    stubSource,
    /enqueueMipGeneration:[\s\S]*host\.enqueueTextureMipGeneration\(/,
    "the WebGL compatibility bridge must consume the canonical API",
  );
});

test("each real Moon candidate allocates and exposes its exact full mip chain", () => {
  const hooks = functionSlice(
    rendererSource,
    "function createMoonTextureRequestHooks(",
    "function invalidateMoonTextureBindings(",
  );

  assert.match(
    hooks,
    /Math\.floor\(Math\.log2\(Math\.max\(width, height\)\)\) \+ 1/,
  );
  assert.match(hooks, /createTexture\(\{[\s\S]*mipLevelCount,/);
  assert.match(
    hooks,
    /usage:[\s\S]*GPUTextureUsage\.TEXTURE_BINDING[\s\S]*GPUTextureUsage\.COPY_DST[\s\S]*GPUTextureUsage\.RENDER_ATTACHMENT/,
  );
  assert.match(
    hooks,
    /createView\(\{[\s\S]*baseMipLevel:\s*0,[\s\S]*mipLevelCount:\s*candidate\.mipLevelCount/,
  );
});

test("Moon publication enqueues mips on the frame owner before publishing the exact candidate", () => {
  const callbacks = functionSlice(
    rendererSource,
    "function createMoonTexturePublicationCallbacks(",
    "function createFlatNormalPlaceholderTexture(",
  );
  const prepareIndex = callbacks.indexOf("prepareCandidate:");
  const publishIndex = callbacks.indexOf("publish:");

  assert.ok(prepareIndex >= 0 && prepareIndex < publishIndex);
  assert.match(
    callbacks.slice(prepareIndex, publishIndex),
    /enqueueTextureMipGeneration[\s\S]*candidate\.texture[\s\S]*candidate\.format[\s\S]*candidate\.mipLevelCount/,
  );
  assert.doesNotMatch(
    callbacks,
    /queue\.submit|createCommandEncoder/,
    "Moon publication must not privately encode or submit mip work",
  );
  assert.match(
    lifecycleSource,
    /callbacks\.prepareCandidate\?\.[\s\S]*isWebGPUMoonTextureLifecycleCurrent\(lifecycle\)[\s\S]*callbacks\.invalidate/,
    "the lifecycle must revalidate its exact tuple after mip enqueue and before publication",
  );
});

test("Moon sampling is trilinear and periodic only across longitude", () => {
  const update = functionSlice(
    rendererSource,
    "function updateWebGPUMoon(",
    "function _packMoonUniforms(",
  );
  assert.match(update, /mipmapFilter:\s*"linear"/);
  assert.match(update, /addressModeU:\s*"repeat"/);
  assert.match(update, /addressModeV:\s*"clamp-to-edge"/);
});

test("every candidate destruction cancels a rare same-frame pending mip job", () => {
  const hooks = functionSlice(
    rendererSource,
    "function createMoonTextureRequestHooks(",
    "function invalidateMoonTextureBindings(",
  );
  assert.match(
    hooks,
    /destroyCandidate:[\s\S]*noteInlineTextureDestroy\?\.\(texture\)[\s\S]*texture\?\.destroy\(\)/,
  );
  assert.match(
    rendererSource,
    /destroyTextureOnce\(texture\)[\s\S]*noteInlineTextureDestroy\?\.\(texture\)[\s\S]*destroyOnce\(texture\)/,
    "cache teardown must cancel pending jobs before destroying published texture handles",
  );
});
