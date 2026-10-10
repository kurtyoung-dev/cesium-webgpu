/**
 * Pure-Node spec for when the WebGPU renderer releases two kinds of texture:
 * the single-sample depth-conversion texture a multisampled render target
 * owns, and the cube textures a cube-map panorama creates when its sources
 * change.
 *
 * It runs the REAL `WebGPURenderTarget` and the REAL
 * `WebGPUCubeMapPanoramaRenderer` against a recording fake device. Every
 * `createTexture` gets an id and every `destroy()` is counted, so the spec
 * answers the only question that matters for a leak: for each texture the
 * code made, was it destroyed exactly once, and was it still alive whenever a
 * command that samples it was handed out.
 *
 * Each engine module is bundled with esbuild (its whole graph real, nothing
 * stubbed) and loaded from the bundle, because the render target's
 * dependencies use TypeScript syntax Node cannot strip. Setting
 * CESIUM_TEXTURE_LIFETIME_MUTANT to one of the names in MUTANTS rewrites the
 * named engine file while it is bundled, making one fix unreachable, so a run
 * can show every assertion group go red. The shipped files are never touched.
 *
 * Run: node --test packages/engine/Specs/Renderer/WebGPU/WebGPUTextureLifetimeSpec.mjs
 */
import assert from "node:assert/strict";
import console from "node:console";
import { dirname, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { setImmediate } from "node:timers";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SOURCE = resolve(HERE, "../../../Source");

// Node has no WebGPU. The fake device never interprets these values, so any
// distinct bits will do.
globalThis.GPUTextureUsage = globalThis.GPUTextureUsage ?? {
  RENDER_ATTACHMENT: 0x10,
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
};
globalThis.GPUBufferUsage = globalThis.GPUBufferUsage ?? {
  COPY_DST: 0x08,
  COPY_SRC: 0x04,
  MAP_READ: 0x01,
  VERTEX: 0x20,
  INDEX: 0x10,
  UNIFORM: 0x40,
  STORAGE: 0x80,
};
globalThis.GPUMapMode = globalThis.GPUMapMode ?? { READ: 0x01 };
globalThis.GPUShaderStage = globalThis.GPUShaderStage ?? {
  VERTEX: 1,
  FRAGMENT: 2,
  COMPUTE: 4,
};
globalThis.HTMLImageElement = globalThis.HTMLImageElement ?? class {};

const RENDER_TARGET_FILE = "Renderer/WebGPU/WebGPURenderTarget.ts";
const PANORAMA_FILE = "Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js";

// Each mutant makes one release unreachable ("if (false && ...)" or removal of
// the line), in the file that carries it. `from` must occur exactly once.
const NL = String.fromCharCode(10);
const lines = (...parts) => parts.join(NL);
const MUTANTS = {
  "target-skip-conversion-destroy": {
    file: RENDER_TARGET_FILE,
    from: "this._msaaDepthResolveTexture?.destroy();",
    to: "if (false) this._msaaDepthResolveTexture?.destroy();",
  },
  "target-resize-always-rebuilds": {
    file: RENDER_TARGET_FILE,
    from: "if (width === this.descriptor.width && height === this.descriptor.height) {",
    to: "if (false) {",
  },
  "target-destroy-twice": {
    file: RENDER_TARGET_FILE,
    edits: [
      { from: "if (this.destroyed) {", to: "if (false) {" },
      { from: "this._msaaDepthResolveTexture = null;", to: "" },
    ],
  },
  "target-conversion-for-single-sample": {
    file: RENDER_TARGET_FILE,
    from: "if (wantSampleable && isMSAA) {",
    to: "if (wantSampleable) {",
  },
  "target-conversion-without-samplable-depth": {
    file: RENDER_TARGET_FILE,
    from: "if (wantSampleable && isMSAA) {",
    to: "if (isMSAA) {",
  },
  "target-keep-views-after-destroy": {
    file: RENDER_TARGET_FILE,
    from: "    this._msaaDepthResolveSampleableView = null;",
    to: "",
  },
  "panorama-skip-late-load-guard": {
    file: PANORAMA_FILE,
    from: "if (_instanceState.get(panorama) !== state) {",
    to: "if (false && _instanceState.get(panorama) !== state) {",
  },
  "panorama-skip-retired-destroy-on-update": {
    file: PANORAMA_FILE,
    from: lines(
      "    state.retiredCubeMapTexture?.destroy();",
      "    state.retiredCubeMapTexture = undefined;",
    ),
    to: "    state.retiredCubeMapTexture = undefined;",
  },
  "panorama-skip-retired-destroy-on-teardown": {
    file: PANORAMA_FILE,
    from: lines(
      "  state.retiredCubeMapTexture?.destroy();",
      "",
      "  _instanceState.delete(panorama);",
    ),
    to: "  _instanceState.delete(panorama);",
  },
  "panorama-destroy-before-rebind": {
    file: PANORAMA_FILE,
    from: "state.retiredCubeMapTexture = state.cubeMapTexture;",
    to: lines(
      "state.cubeMapTexture?.destroy();",
      "      state.retiredCubeMapTexture = undefined;",
    ),
  },
  "panorama-keep-stale-command": {
    file: PANORAMA_FILE,
    from: lines(
      "      state.retiredCubeMapTexture = state.cubeMapTexture;",
      "      state.command = undefined;",
    ),
    to: "      state.retiredCubeMapTexture = state.cubeMapTexture;",
  },
};

const mutantName = process.env.CESIUM_TEXTURE_LIFETIME_MUTANT;
if (mutantName !== undefined) {
  assert.ok(MUTANTS[mutantName], `unknown mutant ${mutantName}`);
}

async function loadEngineModule(relativePath) {
  const entry = resolve(ENGINE_SOURCE, relativePath);
  const mutant = mutantName ? MUTANTS[mutantName] : undefined;
  let mutated = false;
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "es2022",
    logLevel: "silent",
    plugins: [
      {
        name: "apply-mutant",
        setup(pluginBuild) {
          if (!mutant) {
            return;
          }
          pluginBuild.onLoad({ filter: /\.(js|ts)$/ }, (args) => {
            if (resolve(args.path) !== resolve(ENGINE_SOURCE, mutant.file)) {
              return undefined;
            }
            const text = readFileSync(args.path, "utf8")
              .split(String.fromCharCode(13, 10))
              .join(NL);
            let contents = text;
            for (const edit of mutant.edits ?? [mutant]) {
              assert.equal(
                contents.split(edit.from).length,
                2,
                `mutant ${mutantName} anchor must occur exactly once`,
              );
              contents = contents.replace(edit.from, () => edit.to);
            }
            mutated = true;
            return {
              contents,
              loader: args.path.endsWith(".ts") ? "ts" : "js",
            };
          });
        },
      },
    ],
  });
  if (mutant && mutant.file === relativePath) {
    assert.ok(mutated, `mutant ${mutantName} was not applied`);
  }
  const code = result.outputFiles[0].text;
  return import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
}

const { WebGPURenderTarget } = await loadEngineModule(RENDER_TARGET_FILE);
const panoramaRenderer = await loadEngineModule(PANORAMA_FILE);
const { updateCubeMapPanorama, destroyCubeMapPanorama } = panoramaRenderer;
const { getCubeMapPanoramaResource } = panoramaRenderer;

// The renderer logs load progress in debug builds; keep that out of the report.
const realLog = console.log;
console.log = () => {};
process.on("exit", () => {
  console.log = realLog;
});

class FakeTexture {
  constructor(device, descriptor) {
    this.device = device;
    this.descriptor = descriptor;
    this.id = device.textures.length;
    this.destroyCount = 0;
  }

  createView(descriptor = {}) {
    return { texture: this, descriptor };
  }

  destroy() {
    this.destroyCount += 1;
  }

  get destroyed() {
    return this.destroyCount > 0;
  }

  get width() {
    const size = this.descriptor.size;
    return Array.isArray(size) ? size[0] : size.width;
  }

  get height() {
    const size = this.descriptor.size;
    return Array.isArray(size) ? size[1] : size.height;
  }

  get layers() {
    const size = this.descriptor.size;
    return Array.isArray(size)
      ? (size[2] ?? 1)
      : (size.depthOrArrayLayers ?? 1);
  }

  get sampleCount() {
    return this.descriptor.sampleCount ?? 1;
  }
}

class FakeBuffer {
  constructor(descriptor) {
    this.descriptor = descriptor;
    this.size = descriptor.size;
  }

  getMappedRange() {
    return new ArrayBuffer(this.size);
  }

  unmap() {}

  destroy() {}
}

function makeFakeDevice() {
  const device = {
    textures: [],
    bindGroups: [],
    queue: {
      writeBuffer() {},
      copyExternalImageToTexture() {},
    },
    createTexture(descriptor) {
      const texture = new FakeTexture(device, descriptor);
      device.textures.push(texture);
      return texture;
    },
    createBuffer: (descriptor) => new FakeBuffer(descriptor),
    createBindGroup(descriptor) {
      const group = { descriptor };
      device.bindGroups.push(group);
      return group;
    },
    createSampler: (descriptor) => ({ descriptor }),
    createShaderModule: (descriptor) => ({ descriptor }),
    createBindGroupLayout: (descriptor) => ({ descriptor }),
    createPipelineLayout: (descriptor) => ({ descriptor }),
    createRenderPipeline: (descriptor) => ({ descriptor }),
  };
  return device;
}

function isCubeTexture(texture) {
  return texture.layers === 6;
}

// ── WebGPURenderTarget ──────────────────────────────────────────────────────

function makeTarget(overrides = {}) {
  const device = makeFakeDevice();
  const target = new WebGPURenderTarget(device, {
    name: "lifetime",
    width: 64,
    height: 32,
    colorFormats: ["rgba8unorm"],
    depthStencilFormat: "depth24plus-stencil8",
    depthSamplable: true,
    sampleCount: 4,
    ...overrides,
  });
  return { device, target };
}

function destroyCounts(device) {
  return device.textures.map((texture) => texture.destroyCount);
}

test("a multisampled target with a samplable depth hands out a single-sample view of its own texture", () => {
  const { device, target } = makeTarget();
  const view = target.getDepthSampleableView();
  assert.ok(view, "an alive MSAA target with depthSamplable has a view");
  assert.ok(device.textures.includes(view.texture));
  assert.equal(view.texture.sampleCount, 1);
  assert.equal(view.texture.destroyed, false);
});

test("resize to a new size destroys every texture made for the old size exactly once, depth conversion included", () => {
  const { device, target } = makeTarget();
  const oldTextures = [...device.textures];
  const oldView = target.getDepthSampleableView();
  assert.ok(oldView);
  assert.ok(oldTextures.includes(oldView.texture));

  target.resize(128, 96);

  for (const texture of oldTextures) {
    assert.equal(
      texture.destroyCount,
      1,
      `${texture.descriptor.label} made for 64x32 is destroyed exactly once`,
    );
  }
  const newTextures = device.textures.filter(
    (texture) => !oldTextures.includes(texture),
  );
  assert.ok(newTextures.length > 0);
  for (const texture of newTextures) {
    assert.equal(
      texture.destroyCount,
      0,
      "textures for the new size are alive",
    );
    assert.equal(texture.width, 128);
    assert.equal(texture.height, 96);
  }

  const newView = target.getDepthSampleableView();
  assert.ok(newView, "a samplable depth view exists after the resize");
  assert.notEqual(newView, oldView);
  assert.ok(newTextures.includes(newView.texture));
  assert.equal(newView.texture.sampleCount, 1);
});

test("repeated resizes leave exactly one generation of textures alive", () => {
  const { device, target } = makeTarget();
  const perGeneration = device.textures.length;
  const sizes = [
    [100, 50],
    [200, 120],
    [64, 32],
    [300, 300],
    [10, 10],
  ];
  for (const [w, h] of sizes) {
    target.resize(w, h);
  }
  assert.equal(device.textures.length, perGeneration * (sizes.length + 1));
  const alive = device.textures.filter((texture) => !texture.destroyed);
  assert.equal(alive.length, perGeneration);
  for (const texture of device.textures) {
    assert.ok(texture.destroyCount <= 1);
  }
});

test("resize to the size it already has destroys nothing and creates nothing", () => {
  const { device, target } = makeTarget();
  const before = device.textures.length;
  const view = target.getDepthSampleableView();
  target.resize(64, 32);
  assert.equal(device.textures.length, before);
  assert.deepEqual(destroyCounts(device), new Array(before).fill(0));
  assert.equal(target.getDepthSampleableView(), view);
});

test("destroying the target destroys every texture it ever made exactly once and leaves no samplable depth view", () => {
  const { device, target } = makeTarget();
  target.resize(128, 96);
  target.resize(32, 16);
  assert.ok(target.getDepthSampleableView());

  target.destroy();

  assert.ok(device.textures.length > 0);
  for (const texture of device.textures) {
    assert.equal(
      texture.destroyCount,
      1,
      `${texture.descriptor.label} (${texture.width}x${texture.height}) destroyed exactly once`,
    );
  }
  assert.equal(target.getDepthSampleableView(), undefined);
  assert.equal(target.isDestroyed(), true);
});

test("destroying a target twice destroys nothing more", () => {
  const { device, target } = makeTarget();
  target.destroy();
  const counts = destroyCounts(device);
  target.destroy();
  assert.deepEqual(destroyCounts(device), counts);
  assert.equal(device.textures.length, counts.length);
});

test("a single-sample target makes no depth-conversion texture and behaves as before", () => {
  const { device, target } = makeTarget({ sampleCount: 1 });
  // colour + depth only
  assert.equal(device.textures.length, 2);
  const view = target.getDepthSampleableView();
  assert.ok(view);
  assert.ok(device.textures.includes(view.texture));
  assert.equal(view.texture.descriptor.format, "depth24plus-stencil8");
  assert.equal(view.descriptor.aspect, "depth-only");

  const first = [...device.textures];
  target.resize(16, 16);
  for (const texture of first) {
    assert.equal(texture.destroyCount, 1);
  }
  assert.equal(device.textures.length, 4);
  assert.ok(target.getDepthSampleableView());

  target.destroy();
  for (const texture of device.textures) {
    assert.equal(texture.destroyCount, 1);
  }
});

test("a multisampled target without a samplable depth makes no depth-conversion texture", () => {
  const { device, target } = makeTarget({ depthSamplable: false });
  // colour + resolve + depth
  assert.equal(device.textures.length, 3);
  assert.equal(target.getDepthSampleableView(), undefined);

  target.resize(16, 16);
  for (const texture of device.textures.slice(0, 3)) {
    assert.equal(texture.destroyCount, 1);
  }
  assert.equal(device.textures.length, 6);

  target.destroy();
  for (const texture of device.textures) {
    assert.equal(texture.destroyCount, 1);
  }
  assert.equal(target.getDepthSampleableView(), undefined);
});

// ── WebGPUCubeMapPanoramaRenderer ───────────────────────────────────────────

const FACE_NAMES = [
  "positiveX",
  "negativeX",
  "positiveY",
  "negativeY",
  "positiveZ",
  "negativeZ",
];

// A set of face sources whose loads the spec releases itself, so it decides
// exactly when a load lands relative to the frames around it.
function makeSources(size = 4) {
  let release;
  const gate = new Promise((resolveGate) => {
    release = resolveGate;
  });
  const sources = {};
  for (const face of FACE_NAMES) {
    sources[face] = { gate, size };
  }
  return { sources, release };
}

globalThis.createImageBitmap = (source) =>
  source.gate.then(() => ({ width: source.size, height: source.size }));

async function flush() {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolveTick) => setImmediate(resolveTick));
  }
}

function makeScene(sources) {
  const device = makeFakeDevice();
  const identity4 = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) {
    identity4[i * 5] = 1;
  }
  const context = {
    device,
    scenePipelineFormat: "rgba8unorm",
    _msaaSamples: 1,
    _scenePipelineFormatGeneration: 0,
    uniformState: {
      projection: identity4,
      viewRotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      entireFrustum: { x: 1, y: 100 },
    },
  };
  const frameState = {
    context,
    panoramaCommandList: [],
    morphTime: 1,
    creditDisplay: { addCreditToNextFrame() {} },
  };
  const panorama = {
    sources,
    show: true,
    _transform: undefined,
    _returnCommand: true,
  };
  return { device, frameState, panorama };
}

// One render-loop update. Returns the texture the handed-out command samples
// and fails if that texture has already been destroyed.
function update(scene) {
  const command = updateCubeMapPanorama(
    scene.panorama,
    scene.frameState,
    false,
  );
  if (!command) {
    return { command, sampled: undefined };
  }
  const bindGroup = command.bindGroups[1];
  const entry = bindGroup.descriptor.entries.find((e) => e.binding === 1);
  const sampled = entry.resource.texture;
  assert.equal(
    sampled.destroyed,
    false,
    "a command was handed out that samples a destroyed texture",
  );
  return { command, sampled };
}

function cubeTextures(scene) {
  return scene.device.textures.filter(isCubeTexture);
}

function undestroyed(scene) {
  return cubeTextures(scene).filter((texture) => !texture.destroyed);
}

async function loadFirst(scene, set) {
  assert.equal(update(scene).command, undefined, "nothing to draw yet");
  set.release();
  await flush();
  const { sampled } = update(scene);
  assert.ok(sampled, "the first load produces a drawable command");
  return sampled;
}

test("changing sources destroys the previous cube texture once, only after the replacement is bound by a rebuilt command", async () => {
  const first = makeSources();
  const scene = makeScene(first.sources);
  const firstTexture = await loadFirst(scene, first);
  assert.equal(cubeTextures(scene).length, 1);

  const second = makeSources();
  scene.panorama.sources = second.sources;
  const mid = update(scene);
  assert.equal(
    mid.sampled,
    firstTexture,
    "while the replacement loads, the old texture is still drawn",
  );
  assert.equal(firstTexture.destroyCount, 0, "not destroyed while loading");

  second.release();
  await flush();
  assert.equal(cubeTextures(scene).length, 2, "the replacement has loaded");
  assert.equal(
    firstTexture.destroyCount,
    0,
    "not destroyed before the next update has built a command for the replacement",
  );

  const after = update(scene);
  const secondTexture = cubeTextures(scene)[1];
  assert.equal(
    after.sampled,
    secondTexture,
    "the command samples the replacement",
  );
  assert.equal(
    firstTexture.destroyCount,
    1,
    "the previous texture is destroyed once",
  );
  assert.equal(secondTexture.destroyCount, 0);

  for (let i = 0; i < 3; i++) {
    assert.equal(update(scene).sampled, secondTexture);
  }
  assert.equal(firstTexture.destroyCount, 1);
});

test("the draw command samples the newest texture after every source change, and at most one cube texture stays undestroyed", async () => {
  const first = makeSources();
  const scene = makeScene(first.sources);
  await loadFirst(scene, first);

  for (let round = 0; round < 4; round++) {
    const next = makeSources(4 + round);
    scene.panorama.sources = next.sources;
    update(scene);
    next.release();
    await flush();
    const { sampled } = update(scene);
    const newest = cubeTextures(scene).at(-1);
    assert.equal(
      newest.width,
      4 + round,
      "the newest texture is for the newest sources",
    );
    assert.equal(
      sampled,
      newest,
      `round ${round}: the command samples the replacement`,
    );
    assert.deepEqual(
      undestroyed(scene),
      [newest],
      "only the replacement is left undestroyed",
    );
    // A further update must not touch anything or go back to an older texture.
    assert.equal(update(scene).sampled, newest);
  }
  for (const texture of cubeTextures(scene).slice(0, -1)) {
    assert.equal(texture.destroyCount, 1);
  }
  assert.equal(cubeTextures(scene).length, 5);
});

test("a load that lands after the panorama was destroyed leaves no texture undestroyed and the resource lookup reports none", async () => {
  const set = makeSources();
  const scene = makeScene(set.sources);
  assert.equal(update(scene).command, undefined);

  destroyCubeMapPanorama(scene.panorama);
  set.release();
  await flush();

  assert.deepEqual(undestroyed(scene), []);
  assert.equal(getCubeMapPanoramaResource(scene.panorama), undefined);
});

test("a replacement load that lands after the panorama was destroyed leaves no texture undestroyed", async () => {
  const first = makeSources();
  const scene = makeScene(first.sources);
  await loadFirst(scene, first);

  const second = makeSources();
  scene.panorama.sources = second.sources;
  update(scene);
  destroyCubeMapPanorama(scene.panorama);
  second.release();
  await flush();

  assert.deepEqual(undestroyed(scene), []);
  for (const texture of cubeTextures(scene)) {
    assert.equal(texture.destroyCount, 1);
  }
  assert.equal(getCubeMapPanoramaResource(scene.panorama), undefined);
});

test("destroying the panorama destroys every cube texture it made exactly once, a retired one included", async () => {
  const first = makeSources();
  const scene = makeScene(first.sources);
  await loadFirst(scene, first);

  // Replacement has loaded but no update has run since.
  const second = makeSources();
  scene.panorama.sources = second.sources;
  update(scene);
  second.release();
  await flush();
  assert.equal(cubeTextures(scene).length, 2);

  destroyCubeMapPanorama(scene.panorama);

  for (const texture of cubeTextures(scene)) {
    assert.equal(texture.destroyCount, 1);
  }
  assert.equal(getCubeMapPanoramaResource(scene.panorama), undefined);

  // Destroying again is a no-op.
  destroyCubeMapPanorama(scene.panorama);
  for (const texture of cubeTextures(scene)) {
    assert.equal(texture.destroyCount, 1);
  }
});

test("destroying a settled panorama after several swaps destroys each cube texture exactly once", async () => {
  const first = makeSources();
  const scene = makeScene(first.sources);
  await loadFirst(scene, first);
  for (let round = 0; round < 3; round++) {
    const next = makeSources();
    scene.panorama.sources = next.sources;
    update(scene);
    next.release();
    await flush();
    update(scene);
  }
  destroyCubeMapPanorama(scene.panorama);
  assert.equal(cubeTextures(scene).length, 4);
  for (const texture of cubeTextures(scene)) {
    assert.equal(texture.destroyCount, 1);
  }
});
