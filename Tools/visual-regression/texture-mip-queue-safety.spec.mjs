// C12-33 — renderer-neutral texture-mip queue ownership and cube-layer safety.
//
// Two halves:
//
//   1. BEHAVIORAL. The queue itself (`enqueueTextureMipGeneration`,
//      `cancelTextureMipGeneration`, `flushPendingTextureMipJobs` and the
//      private encode/submit/requeue path they drive) lives on
//      `WebGPUContext`, a TypeScript module bundled only into the combined
//      engine barrel. It is bundled here with esbuild and imported from a
//      data: URL, then driven on a fake GPUDevice / queue / mipmap generator.
//      The three load-bearing behaviors — exact `(device, generation)` job
//      stamping, per-batch dedupe, and TRANSACTIONAL requeue when encode or
//      submit fails — are asserted by executing the real code, so an
//      implementation that merely still LOOKS right cannot pass.
//
//   2. STRUCTURAL. Source-shape assertions for the cross-file wiring a fake
//      context cannot reach: cube-layer slicing in the generator/stub/cubemap,
//      cancel-before-destroy ordering in the texture owners (globe publication
//      rollback, model rebuild teardown, Moon publication), and the
//      clear-before-recovery ordering inside `_clearAllCaches`.
//
// Run: node --test Tools/visual-regression/texture-mip-queue-safety.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
// Normalize CRLF to LF at the reader. The repo checks out with
// core.autocrlf=true, so every engine source on a Windows clone has Windows
// line endings while these anchors are written with bare newlines — a
// close-brace-plus-newline anchor cannot match a close-brace-plus-CRLF file.
// Before this, the spec only passed while a freshly applied patch happened to
// leave LF bytes in the working copy, and went RED after any clean checkout:
// a false-green that hid whichever contract the anchor guards. Line endings
// are never what these source-shape pins are testing.
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");

const contextPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts",
);

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

// ── Behavioral bundle ───────────────────────────────────────────────────────
//
// `Source/Shaders/**.js` are build-generated string modules that only exist
// after `gulp build`, and the mip queue never reads shader text, so they are
// stubbed to empty strings. Everything else — including the real accept/reject
// gate in WebGPUMipmapGenerator — is the shipped code.
const shaderStubPlugin = {
  name: "shader-stub",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\/Shaders\// }, (args) => ({
      path: args.path,
      namespace: "texture-mip-shader-stub",
    }));
    pluginBuild.onLoad(
      { filter: /.*/, namespace: "texture-mip-shader-stub" },
      () => ({ contents: 'export default "";', loader: "js" }),
    );
  },
};
const contextBundle = await build({
  entryPoints: [contextPath],
  bundle: true,
  format: "esm",
  target: "es2022",
  write: false,
  logLevel: "silent",
  plugins: [shaderStubPlugin],
});
const { WebGPUContext } = await import(
  `data:text/javascript;base64,${Buffer.from(
    contextBundle.outputFiles[0].text,
  ).toString("base64")}`
);

// ── Test doubles ────────────────────────────────────────────────────────────

const LAYERED = "core-features-and-limits";

function makeDevice({ features = [LAYERED], failSubmit = false } = {}) {
  const encoders = [];
  const submits = [];
  const device = {
    encoders,
    submits,
    // Read through the object so a test can clear it between attempts.
    failSubmit,
    features: new Set(features),
    createCommandEncoder(descriptor) {
      const encoder = {
        label: descriptor?.label,
        finished: false,
        finish() {
          this.finished = true;
          return { __kind: "commandBuffer", encoder: this };
        },
      };
      encoders.push(encoder);
      return encoder;
    },
    queue: {
      submit: (buffers) => {
        if (device.failSubmit) {
          throw new Error("submit rejected");
        }
        submits.push(buffers);
      },
    },
  };
  return device;
}

/**
 * Mipmap-generator double. `failOn(callIndex)` throwing mid-batch is what
 * exercises the transactional requeue; `onCall` lets a test re-enter the queue
 * while a batch is draining.
 */
function makeGenerator({ failOn, onCall } = {}) {
  const calls = [];
  return {
    calls,
    generateMipmaps(tex, format, mipLevelCount, encoder, options) {
      calls.push({ texture: tex, format, mipLevelCount, encoder, options });
      onCall?.(calls.length, tex);
      if (failOn?.(calls.length, tex)) {
        throw new Error("generator failure");
      }
    },
  };
}

/**
 * A `WebGPUContext` whose prototype methods are the real ones but whose
 * instance state is the minimum the mip queue touches. TypeScript `private` is
 * erased at build time, so the queue's own fields are ordinary properties;
 * `_isTerminallyLost` is an accessor pair over `_terminallyLost`.
 */
function makeContext({ device, generation = 1, mipmapGenerator } = {}) {
  const ctx = Object.create(WebGPUContext.prototype);
  ctx._device = device;
  ctx._deviceResourceGeneration = generation;
  ctx._pendingTextureMipJobs = [];
  ctx._pendingTextureMipJobKeys = new WeakMap();
  ctx._inlineDestroyedTextures = new Set();
  ctx._isDestroyed = false;
  ctx._terminallyLost = false;
  // The `_isTerminallyLost` SETTER drops in-flight encoders and drains the
  // post-submit notifications, so the state is entered through the real
  // accessor rather than by poking the backing field.
  ctx._afterFrameSubmitCallbacks = [];
  ctx._currentCommandEncoder = null;
  ctx._currentRenderPassEncoder = null;
  ctx._activePassTarget = null;
  ctx._mipmapGenerator = mipmapGenerator ?? makeGenerator();
  return ctx;
}

let textureSeq = 0;
const makeTexture = (name) => ({
  __kind: "texture",
  name: name ?? `texture-${++textureSeq}`,
});

const pendingTextures = (ctx) =>
  ctx._pendingTextureMipJobs.map((job) => job.texture.name);

// ── Behavior 1: exact (device, generation) job stamping ─────────────────────

test("a queued job records the exact device and generation that accepted it", () => {
  const device = makeDevice();
  const ctx = makeContext({ device, generation: 7 });
  const tex = makeTexture("a");

  assert.equal(ctx.enqueueTextureMipGeneration(tex, "rgba8unorm", 5), true);
  assert.equal(ctx._pendingTextureMipJobs.length, 1);

  const job = ctx._pendingTextureMipJobs[0];
  assert.equal(job.texture, tex);
  assert.equal(job.format, "rgba8unorm");
  assert.equal(job.mipLevelCount, 5);
  assert.equal(job.device, device);
  assert.equal(job.resourceGeneration, 7);
  // Options are normalized at enqueue time, not at encode time, so the job key
  // and the encode both see the same canonical range.
  assert.deepEqual(job.options, {
    dimension: "2d",
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
});

test("a matching ownership tuple encodes into one labelled prep buffer", () => {
  const device = makeDevice();
  const gen = makeGenerator();
  const ctx = makeContext({ device, mipmapGenerator: gen });
  const tex = makeTexture("a");

  ctx.enqueueTextureMipGeneration(tex, "rgba8unorm", 5);
  ctx.flushPendingTextureMipJobs();

  assert.equal(gen.calls.length, 1);
  assert.equal(gen.calls[0].texture, tex);
  assert.equal(gen.calls[0].mipLevelCount, 5);
  assert.equal(device.encoders.length, 1);
  assert.equal(device.encoders[0].label, "TextureMipPreparation");
  assert.equal(device.encoders[0].finished, true);
  assert.equal(device.submits.length, 1);
  assert.equal(device.submits[0][0].encoder, device.encoders[0]);
  assert.equal(ctx._pendingTextureMipJobs.length, 0);
});

test("mutation guard: each half of the ownership tuple is load-bearing", () => {
  // 2x2 matrix over (device matches?, generation matches?). Only the exact
  // tuple may encode. Deleting EITHER comparison in the encode loop flips one
  // of the three skip rows into an encode, which is precisely the bug the
  // stamping exists to prevent: replaying a dead texture's mip pass against a
  // recovered device's resources.
  const cases = [
    { swapDevice: false, rollGeneration: false, encoded: 1 },
    { swapDevice: false, rollGeneration: true, encoded: 0 },
    { swapDevice: true, rollGeneration: false, encoded: 0 },
    { swapDevice: true, rollGeneration: true, encoded: 0 },
  ];
  for (const { swapDevice, rollGeneration, encoded } of cases) {
    const device = makeDevice();
    const gen = makeGenerator();
    const ctx = makeContext({ device, generation: 3, mipmapGenerator: gen });
    ctx.enqueueTextureMipGeneration(makeTexture(), "rgba8unorm", 5);

    if (swapDevice) {
      ctx._device = makeDevice();
    }
    if (rollGeneration) {
      ctx._deviceResourceGeneration = 4;
    }
    ctx.flushPendingTextureMipJobs();

    const label = `swapDevice=${swapDevice} rollGeneration=${rollGeneration}`;
    assert.equal(gen.calls.length, encoded, label);
    // A skipped batch never opens an encoder and never submits...
    assert.equal(device.encoders.length, encoded, label);
    assert.equal(
      (swapDevice ? ctx._device : device).submits.length,
      encoded,
      label,
    );
    // ...and is still drained: the work is dead, not deferred.
    assert.equal(ctx._pendingTextureMipJobs.length, 0, label);
  }
});

test("an unavailable device drains the queue without touching it", () => {
  for (const kill of ["_isDestroyed", "_isTerminallyLost"]) {
    const device = makeDevice();
    const gen = makeGenerator();
    const ctx = makeContext({ device, mipmapGenerator: gen });
    ctx.enqueueTextureMipGeneration(makeTexture(), "rgba8unorm", 5);
    ctx[kill] = true;

    // Nothing new is accepted once the device is gone.
    assert.equal(
      ctx.enqueueTextureMipGeneration(makeTexture(), "rgba8unorm", 5),
      false,
      kill,
    );
    ctx.flushPendingTextureMipJobs();
    assert.equal(gen.calls.length, 0, kill);
    assert.equal(device.encoders.length, 0, kill);
    assert.equal(device.submits.length, 0, kill);
    assert.equal(ctx._pendingTextureMipJobs.length, 0, kill);
  }
});

// ── Behavior 2: per-batch dedupe ────────────────────────────────────────────

test("an exact duplicate coalesces yet still reports acceptance", () => {
  const ctx = makeContext({ device: makeDevice() });
  const tex = makeTexture("a");

  assert.equal(ctx.enqueueTextureMipGeneration(tex, "rgba8unorm", 5), true);
  // The second caller must still be told the queue owns the work, or it will
  // fall back to its own private submit.
  assert.equal(ctx.enqueueTextureMipGeneration(tex, "rgba8unorm", 5), true);
  assert.equal(ctx.enqueueTextureMipGeneration(tex, "rgba8unorm", 5), true);
  assert.equal(ctx._pendingTextureMipJobs.length, 1);
});

test("mutation guard: every field of the dedupe key is load-bearing", () => {
  // Each variant differs from the base in EXACTLY one key field and must
  // therefore queue its own job; re-enqueueing any variant must add nothing.
  // Dropping any single field from the job key collapses one of these pairs,
  // which would silently discard a real mip request (e.g. face 3 of a cube
  // swallowed by face 0's job).
  const base = makeTexture("base");
  const other = makeTexture("other");
  const variants = [
    ["baseline", base, "rgba8unorm", 5, { arrayLayerCount: 1 }],
    ["format", base, "bgra8unorm", 5, { arrayLayerCount: 1 }],
    ["mipLevelCount", base, "rgba8unorm", 4, { arrayLayerCount: 1 }],
    [
      "dimension",
      base,
      "rgba8unorm",
      5,
      { dimension: "2d-array", arrayLayerCount: 1 },
    ],
    ["baseArrayLayer", base, "rgba8unorm", 5, { baseArrayLayer: 1 }],
    ["arrayLayerCount", base, "rgba8unorm", 5, { arrayLayerCount: 2 }],
    ["texture", other, "rgba8unorm", 5, { arrayLayerCount: 1 }],
  ];

  const ctx = makeContext({ device: makeDevice() });
  for (const [, tex, format, levels, options] of variants) {
    assert.equal(
      ctx.enqueueTextureMipGeneration(tex, format, levels, options),
      true,
    );
  }
  assert.equal(ctx._pendingTextureMipJobs.length, variants.length);

  for (const [name, tex, format, levels, options] of variants) {
    assert.equal(
      ctx.enqueueTextureMipGeneration(tex, format, levels, options),
      true,
      name,
    );
  }
  assert.equal(
    ctx._pendingTextureMipJobs.length,
    variants.length,
    "a repeat of any variant must coalesce",
  );
});

test("dedupe is scoped to the pending batch, not to the texture forever", () => {
  const device = makeDevice();
  const gen = makeGenerator();
  const ctx = makeContext({ device, mipmapGenerator: gen });
  const tex = makeTexture("a");

  ctx.enqueueTextureMipGeneration(tex, "rgba8unorm", 5);
  ctx.enqueueTextureMipGeneration(tex, "rgba8unorm", 5);
  ctx.flushPendingTextureMipJobs();
  assert.equal(gen.calls.length, 1);

  // The same texture re-uploaded later must get mips again. A dedupe key set
  // that outlived the drain would leave every re-upload with stale mips.
  assert.equal(ctx.enqueueTextureMipGeneration(tex, "rgba8unorm", 5), true);
  assert.equal(ctx._pendingTextureMipJobs.length, 1);
  ctx.flushPendingTextureMipJobs();
  assert.equal(gen.calls.length, 2);
});

test("layer options are normalized before they enter the key", () => {
  const ctx = makeContext({ device: makeDevice() });
  const cube = makeTexture("cube");
  ctx.enqueueTextureMipGeneration(cube, "rgba8unorm", 5, {
    dimension: "cube",
  });
  // A cube defaults to its six faces; negative/zero ranges clamp into legal
  // WebGPU values rather than reaching createView().
  assert.deepEqual(ctx._pendingTextureMipJobs[0].options, {
    dimension: "cube",
    baseArrayLayer: 0,
    arrayLayerCount: 6,
  });

  const clamped = makeTexture("clamped");
  ctx.enqueueTextureMipGeneration(clamped, "rgba8unorm", 5, {
    dimension: "2d-array",
    baseArrayLayer: -4,
    arrayLayerCount: 0,
  });
  assert.deepEqual(ctx._pendingTextureMipJobs[1].options, {
    dimension: "2d-array",
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
  // Normalization happens BEFORE the key, so the clamped request and an
  // explicit legal request for the same range are one job.
  assert.equal(
    ctx.enqueueTextureMipGeneration(clamped, "rgba8unorm", 5, {
      dimension: "2d-array",
      baseArrayLayer: 0,
      arrayLayerCount: 1,
    }),
    true,
  );
  assert.equal(ctx._pendingTextureMipJobs.length, 2);
});

test("the accept gate rejects work the generator cannot legally do", () => {
  const ctx = makeContext({ device: makeDevice() });
  const tex = makeTexture("a");
  for (const [name, args] of [
    ["null texture", [null, "rgba8unorm", 5]],
    ["single level", [tex, "rgba8unorm", 1]],
    ["zero levels", [tex, "rgba8unorm", 0]],
    // Not filterable-and-renderable: authored chains must survive untouched.
    ["integer format", [tex, "rgba8uint", 5]],
    ["float32 without the feature", [tex, "rgba32float", 5]],
    ["tier1 without the feature", [tex, "rgba8snorm", 5]],
  ]) {
    assert.equal(ctx.enqueueTextureMipGeneration(...args), false, name);
  }
  assert.equal(ctx._pendingTextureMipJobs.length, 0);

  // Layered generation additionally needs core view semantics.
  const compat = makeContext({ device: makeDevice({ features: [] }) });
  assert.equal(
    compat.enqueueTextureMipGeneration(tex, "rgba8unorm", 5, {
      dimension: "cube",
    }),
    false,
  );
  assert.equal(compat.enqueueTextureMipGeneration(tex, "rgba8unorm", 5), true);
});

// ── Behavior 3: transactional requeue on failure ────────────────────────────

test("an encode failure restores the ENTIRE batch, including encoded jobs", () => {
  const device = makeDevice();
  // Fails while encoding the second of three jobs.
  const gen = makeGenerator({ failOn: (n) => n === 2 });
  const ctx = makeContext({ device, mipmapGenerator: gen });
  for (const name of ["a", "b", "c"]) {
    ctx.enqueueTextureMipGeneration(makeTexture(name), "rgba8unorm", 5);
  }

  assert.throws(() => ctx.flushPendingTextureMipJobs(), /generator failure/);

  // Nothing reached the queue, so nothing is owned by the GPU.
  assert.equal(device.submits.length, 0);
  // MUTATION GUARD — a requeue that restored only the not-yet-encoded tail
  // would give ["b","c"] (or ["c"]). The prep command buffer is invalid as a
  // whole, so job "a" must come back too or its mips are lost forever while
  // its owner has already recorded queue acceptance.
  assert.deepEqual(pendingTextures(ctx), ["a", "b", "c"]);
});

test("a submit failure restores the whole drained batch", () => {
  const device = makeDevice({ failSubmit: true });
  const gen = makeGenerator();
  const ctx = makeContext({ device, mipmapGenerator: gen });
  for (const name of ["a", "b", "c"]) {
    ctx.enqueueTextureMipGeneration(makeTexture(name), "rgba8unorm", 5);
  }

  assert.throws(() => ctx.flushPendingTextureMipJobs(), /submit rejected/);
  // Every job encoded successfully; only the submit failed.
  assert.equal(gen.calls.length, 3);
  assert.deepEqual(pendingTextures(ctx), ["a", "b", "c"]);
});

test("the requeue drops inline-destroyed textures and dead generations", () => {
  const device = makeDevice({ failSubmit: true });
  const gen = makeGenerator();
  const ctx = makeContext({ device, generation: 1, mipmapGenerator: gen });

  const stale = makeTexture("stale");
  ctx.enqueueTextureMipGeneration(stale, "rgba8unorm", 5);
  // A device-resource roll strands `stale` on generation 1.
  ctx._deviceResourceGeneration = 2;

  const live = makeTexture("live");
  const destroyed = makeTexture("destroyed");
  const alsoLive = makeTexture("alsoLive");
  for (const tex of [live, destroyed, alsoLive]) {
    ctx.enqueueTextureMipGeneration(tex, "rgba8unorm", 5);
  }
  // Its owner freed it inline before the prep encoder ran.
  ctx.cancelTextureMipGeneration(destroyed);

  assert.throws(() => ctx.flushPendingTextureMipJobs(), /submit rejected/);

  // Encoding skipped both the stale generation and the dead texture...
  assert.deepEqual(
    gen.calls.map((call) => call.texture.name),
    ["live", "alsoLive"],
  );
  // ...and the requeue must not resurrect either of them. Restoring `stale`
  // would replay it against generation 2's resources; restoring `destroyed`
  // would encode a pass over freed memory.
  assert.deepEqual(pendingTextures(ctx), ["live", "alsoLive"]);
});

test("re-entrant enqueues merge after the restored batch, still deduped", () => {
  const device = makeDevice();
  const extra = makeTexture("extra");
  let reentered = false;
  const gen = makeGenerator({
    onCall: (n) => {
      if (reentered) {
        return;
      }
      reentered = true;
      // An owner reacting to the in-flight encode (e.g. a texture realized by
      // a callback) enqueues both a NEW job and an exact duplicate of one
      // already in the draining batch.
      ctx.enqueueTextureMipGeneration(extra, "rgba8unorm", 5);
      ctx.enqueueTextureMipGeneration(first, "rgba8unorm", 5);
    },
    failOn: (n) => n === 3,
  });
  const ctx = makeContext({ device, mipmapGenerator: gen });
  const first = makeTexture("a");
  ctx.enqueueTextureMipGeneration(first, "rgba8unorm", 5);
  for (const name of ["b", "c"]) {
    ctx.enqueueTextureMipGeneration(makeTexture(name), "rgba8unorm", 5);
  }

  assert.throws(() => ctx.flushPendingTextureMipJobs(), /generator failure/);

  // FIFO is preserved for the original batch and the re-entrant job lands
  // after it; the re-entrant duplicate of "a" is coalesced away.
  assert.deepEqual(pendingTextures(ctx), ["a", "b", "c", "extra"]);
  assert.equal(device.submits.length, 0);
});

test("mutation guard: a SUCCESSFUL flush never requeues", () => {
  const device = makeDevice();
  const gen = makeGenerator();
  const ctx = makeContext({ device, mipmapGenerator: gen });
  for (const name of ["a", "b", "c"]) {
    ctx.enqueueTextureMipGeneration(makeTexture(name), "rgba8unorm", 5);
  }

  ctx.flushPendingTextureMipJobs();

  assert.equal(gen.calls.length, 3);
  assert.equal(device.submits.length, 1);
  // A requeue that ran unconditionally (rather than only from the catch
  // blocks) would replay every batch forever.
  assert.deepEqual(pendingTextures(ctx), []);
  ctx.flushPendingTextureMipJobs();
  assert.equal(gen.calls.length, 3);
  assert.equal(device.submits.length, 1);
});

test("a retry after a failed flush drains exactly the restored batch", () => {
  const device = makeDevice({ failSubmit: true });
  const gen = makeGenerator();
  const ctx = makeContext({ device, mipmapGenerator: gen });
  for (const name of ["a", "b", "c"]) {
    ctx.enqueueTextureMipGeneration(makeTexture(name), "rgba8unorm", 5);
  }
  assert.throws(() => ctx.flushPendingTextureMipJobs(), /submit rejected/);

  device.failSubmit = false;
  ctx.flushPendingTextureMipJobs();

  // Three encodes from the failed attempt plus three from the retry, one
  // submit, nothing left pending — the point of making the drain transactional.
  assert.equal(gen.calls.length, 6);
  assert.deepEqual(
    gen.calls.slice(3).map((call) => call.texture.name),
    ["a", "b", "c"],
  );
  assert.equal(device.submits.length, 1);
  assert.deepEqual(pendingTextures(ctx), []);
});

// ── Structural contracts ────────────────────────────────────────────────────

function between(source, startText, endText) {
  const start = source.indexOf(startText);
  assert.ok(start >= 0, `missing ${startText}`);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(end > start, `missing ${endText}`);
  return source.slice(start, end);
}

test("the queue is cleared before recovery rebuilds the caches", () => {
  // Ordering inside `_clearAllCaches` is not reachable from a fake context:
  // the rest of that method touches every subsystem registry.
  const clear = between(
    context,
    "public _clearAllCaches(",
    "public _rollbackRecoveredDevice(",
  );
  assert.ok(
    clear.indexOf("this._pendingTextureMipJobs.length = 0") <
      clear.indexOf("this._cacheRegistry.clearAll()"),
  );
  // The generator is a plain lazy singleton — a device-invalidation hook here
  // would race the queue's own generation check.
  const getter = between(
    context,
    "get mipmapGenerator()",
    "private _renderBundleManager",
  );
  assert.doesNotMatch(getter, /onDeviceInvalidated/);
  // The key table must not keep textures alive; only a WeakMap is acceptable.
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
