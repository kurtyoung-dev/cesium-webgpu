// primitive-video-material-texture.spec.mjs — a WebGPU primitive material
// whose texture uniform is a video, or a Texture, must sample the texture
// WebGL samples for it, not the placeholder.
// @purpose Pins that the WebGPU primitive material path binds the current view of `material._textures[uniform]` for an HTMLVideoElement or Texture uniform (main, depth-fail and polyline updaters), rebinds on every identity change without touching a destroyed texture or destroying a texture it did not create, follows WebGL when one uniform switches between an image and a video, and leaves image materials, the elevation band and compressed images as they were, with an inertness mutant per group.
// @status ACTIVE
//
// Node only (`node --test`). No browser, no adapter, no pixels. Needs the
// generated shader modules the engine build writes next to `Scene/Material.js`,
// because the real Material is driven.
//
// WHAT HAPPENS ON WEBGL
// ---------------------
// The sampler uniform of every material texture returns
// `material._textures[uniformId]`. For an `HTMLVideoElement` uniform
// `MaterialHelpers` creates one `Texture` from the element on the first update
// that finds `readyState >= 2` and calls `texture.copyFrom` on every later
// update; for a `Texture` uniform it stores the caller's texture. Neither ever
// reaches `material._imageSources`, the mirror the WebGPU primitive path
// builds its own texture from, so on WebGPU the draw bound the 1x1 placeholder
// and the surface rendered plain white.
//
// WHAT THIS DRIVES
// ----------------
//   * The real `Material` and `MaterialHelpers` (not edited), over the real
//     `Texture` on the real WebGL compatibility stub, through the wired
//     harness (`lib/stub-wired-harness.mjs`, which this file only imports).
//     The recording device behind it models destruction: a submit that touches
//     a texture whose `destroy()` was requested is a violation.
//   * The real `WebGPUPrimitiveCommands.ts` through `lib/engine-stub-bundler.mjs`,
//     with the texture-source companion and the globe material's view resolver
//     kept REAL (a Proxy there would be measuring nothing). A command is
//     assembled the way the builder assembles one, and the exported per-frame
//     updaters (`updateWebGPUMaterialCommandUniforms` for the main and
//     depth-fail key sets, `updateWebGPUCommandUniforms` for the polyline
//     material updater) are called each frame.
//   * What is read back is observable: the resource at binding 1 of the bind
//     group the command carries, the `createBindGroup` calls, the
//     `createTextureFromImage` calls, and which textures were destroyed while
//     the binding code ran.
//
// GROUPS
// ------
//   G0  the premise, on the unedited Material: a video never reaches
//       `_imageSources`, and `_textures` holds the per-frame Texture
//   G1  a video material binds the view of `_textures.image`
//   G3  identity changes rebind; a destroyed texture is never bound; the
//       primitive path destroys nothing it did not create
//   G4  before the video has a frame the placeholder is bound, then the video
//   G5  switching one uniform between an image and a video follows WebGL
//   G6  image materials bind exactly as before
//   G8  a caller-supplied Texture, an unfilterable Texture, the elevation
//       band and a compressed image
//   M   one inertness mutant per group: each makes one half of the behaviour
//       unreachable on a COPY of the source and requires the group to fail
//
// NOT HERE
// --------
// That the bound texture moves with the video, and that its orientation and
// content match WebGL, need a real adapter and are measured on Edge.
//
// Run: node --test Tools/visual-regression/primitive-video-material-texture.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bundle } from "./lib/engine-stub-bundler.mjs";
import {
  FakeHTMLCanvasElement,
  FakeHTMLVideoElement,
  FakeImageBitmap,
  RGBA,
  TEXTURE_2D,
  UNSIGNED_BYTE,
  makeWiredHarness,
} from "./lib/stub-wired-harness.mjs";

// Material.js tests `instanceof OffscreenCanvas` for every uniform it types,
// and Node has no such class. Declared before the engine modules are used.
globalThis.OffscreenCanvas ??= class OffscreenCanvas {};

const directory = dirname(fileURLToPath(import.meta.url));
const ENGINE_SOURCE = resolve(directory, "../../packages/engine/Source");
const CORE_DIR = resolve(ENGINE_SOURCE, "Core");
const ENTRY_PATH = resolve(
  ENGINE_SOURCE,
  "Renderer/WebGPU/WebGPUPrimitiveCommands.ts",
);
const SHADERS_PATH = resolve(
  ENGINE_SOURCE,
  "Renderer/WebGPU/WebGPUPrimitiveShaders.js",
);
const COMPANION_BASENAME = "WebGPUPrimitiveMaterialTextureSource.ts";

const [
  { default: Material },
  { default: Texture },
  { default: PixelDatatype },
  { default: Cartesian3 },
  { default: Matrix4 },
] = await Promise.all([
  import("../../packages/engine/Source/Scene/Material.js"),
  import("../../packages/engine/Source/Renderer/Texture.js"),
  import("../../packages/engine/Source/Renderer/PixelDatatype.js"),
  import("../../packages/engine/Source/Core/Cartesian3.js"),
  import("../../packages/engine/Source/Core/Matrix4.js"),
]);

// =============================================================================
// The command module under test
// =============================================================================

// Kept real: `Core/` (the RTE maths writes into Float32Arrays), the layout and
// shader helpers the module builds at load, the enums the command path
// compares against, and the two modules that make the texture choice.
const REAL = [
  "defined",
  "WebGPUBindGroupLayoutHelpers",
  "WebGPUPrimitiveShaders",
  "WebGPUTexture",
  "Pass",
  "SceneMode",
  "ShadowMode",
  "WebGPUPrimitiveMaterialTextureSource",
  "WebGPUGlobeMaterial",
];

function installWebGPUGlobals() {
  globalThis.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
  globalThis.GPUBufferUsage ??= {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
  };
  if (!globalThis.navigator?.gpu) {
    Object.defineProperty(globalThis, "navigator", {
      value: { gpu: { getPreferredCanvasFormat: () => "bgra8unorm" } },
      configurable: true,
      writable: true,
    });
  }
}

async function readLF(path) {
  return (await readFile(path, "utf8")).split("\r\n").join("\n");
}

async function loadCommands({ mutate, label, overrides } = {}) {
  installWebGPUGlobals();
  return bundle({
    path: ENTRY_PATH,
    source: await readLF(ENTRY_PATH),
    real: REAL,
    realDir: CORE_DIR,
    mutate,
    label,
    overrides,
    preseed: [SHADERS_PATH],
  });
}

let baseCommands;
function getCommands() {
  baseCommands ??= loadCommands();
  return baseCommands;
}

// =============================================================================
// The world: a real Material and Texture on the real stub over a recording
// device, and a command assembled the way the builder assembles one
// =============================================================================

const TEXTURE_SLOT = 2;

function makeVideo({ readyState = 4, width = 640, height = 360 } = {}) {
  const video = new FakeHTMLVideoElement();
  video.readyState = readyState;
  video.videoWidth = width;
  video.videoHeight = height;
  return video;
}

function makeCanvas(width = 256, height = 4) {
  const canvas = new FakeHTMLCanvasElement();
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function makeBitmap(width = 32, height = 32) {
  const bitmap = new FakeImageBitmap();
  bitmap.width = width;
  bitmap.height = height;
  return bitmap;
}

/** The WebGPU view behind a Cesium `Texture`, or null when it has none. */
function viewOf(texture) {
  return texture?._texture?._webgpuTexture?.view ?? null;
}

/**
 * @param {object} commands The bundled command module.
 * @param {object} [options]
 * @param {"main"|"depthFail"|"polyline"} [options.kind] Which per-frame
 *   updater and key set the command is driven through.
 * @param {string} [options.shaderType] The material shader type the command
 *   records.
 * @param {object} [options.material] A material to bind instead of a default
 *   Image material.
 */
function makeWorld(
  commands,
  { kind = "main", shaderType = "matImageFlat", material } = {},
) {
  const wired = makeWiredHarness();
  const { device, host, stubs } = wired;

  // A failed assertion prints both operands; a texel model of a 640x360
  // texture is not something to print.
  const createTexture = device.createTexture;
  device.createTexture = (descriptor) => {
    const texture = createTexture(descriptor);
    Object.defineProperty(texture, "data", { enumerable: false });
    return texture;
  };
  const bindGroups = [];
  device.createBindGroup = (descriptor) => {
    const group = {
      kind: "bindGroup",
      layout: descriptor.layout,
      entries: descriptor.entries,
    };
    bindGroups.push(group);
    return group;
  };
  device.createBuffer = (descriptor) => ({ kind: "buffer", ...descriptor });
  device.queue.writeBuffer = () => {};

  // Textures `createTextureFromImage` made: the only ones the primitive path
  // may destroy.
  const created = new Set();
  const imageCalls = [];
  const context = {
    device,
    _gl: stubs,
    limits: { maximumTextureSize: 16384 },
    webgl2: true,
    floatingPointTexture: true,
    graphicsCapabilities: { ktx2TranscodeTargets: undefined },
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    uniformState: {
      view: Matrix4.clone(Matrix4.IDENTITY),
      projection: Matrix4.clone(Matrix4.IDENTITY),
    },
    createTextureFromImage(source, format, flipY) {
      const texture = device.createTexture({
        size: { width: source.width ?? 4, height: source.height ?? 4 },
        format,
      });
      created.add(texture);
      const handle = {
        view: texture.createView(),
        destroys: 0,
        destroy() {
          handle.destroys++;
          texture.destroy();
        },
      };
      imageCalls.push({ source, format, flipY, handle });
      return handle;
    },
  };

  // `Material.update` hands the context's default texture to every uniform
  // that has nothing yet, and the binding code reads `.view` from it.
  const defaultTexture = new Texture({
    context,
    source: {
      width: 1,
      height: 1,
      arrayBufferView: new Uint8Array([255, 255, 255, 255]),
    },
  });
  const placeholderView = viewOf(defaultTexture);
  defaultTexture.view = placeholderView;
  context.defaultTexture = defaultTexture;

  const subject = material ?? new Material({ fabric: { type: "Image" } });
  const layout = { kind: "bindGroupLayout" };
  const layoutField =
    kind === "depthFail"
      ? "dfTextureBindGroupLayout"
      : "textureBindGroupLayout";
  const cache = { [layoutField]: layout };
  const slotPlaceholder = { kind: "bindGroup", role: "slot-placeholder" };
  const command = {
    isWebGPUDrawCommand: true,
    bindGroups:
      kind === "polyline"
        ? [{ role: "a" }, { role: "b" }, slotPlaceholder]
        : [{ role: "a" }, { role: "b" }, slotPlaceholder, { role: "d" }],
    _webgpuCameraBuffer: { kind: "buffer", label: "camera" },
    _webgpuShaderType: shaderType,
    _webgpuMatCache: cache,
    _webgpuMaterial: subject,
    _webgpuMatShaderType: shaderType,
    _webgpuMatTextureSlot: TEXTURE_SLOT,
  };
  if (kind === "depthFail") {
    command._webgpuMatTextureIsDepthFail = true;
  }
  if (kind === "polyline") {
    command._isPolylineAppearance = true;
    command._noEffectsSlot = true;
  }
  const frameState = {
    context,
    camera: { positionWC: new Cartesian3(1, 2, 3) },
    mode: 3,
    passes: {},
    shadowMaps: [],
  };

  const world = {
    commands,
    wired,
    device,
    host,
    stubs,
    context,
    material: subject,
    cache,
    command,
    layout,
    placeholderView,
    imageCalls,
    created,
    /** One `Material.update`, the head of a frame. */
    update() {
      subject.update(context);
    },
    /** The per-frame texture refresh the renderer runs for the command. */
    refresh() {
      if (kind === "polyline") {
        commands.updateWebGPUCommandUniforms(
          command,
          frameState,
          Matrix4.IDENTITY,
        );
      } else {
        commands.updateWebGPUMaterialCommandUniforms(
          command,
          frameState,
          Matrix4.IDENTITY,
        );
      }
    },
    frame() {
      world.update();
      world.refresh();
    },
    /** Bind groups built for the texture slot's layout. */
    textureBindGroupCount() {
      return bindGroups.filter((group) => group.layout === layout).length;
    },
    /** The bind group the command carries at the texture slot. */
    textureGroup() {
      const group = command.bindGroups[TEXTURE_SLOT];
      return group?.layout === layout ? group : undefined;
    },
    /** The resource at binding `binding` of that bind group. */
    bound(binding = 1) {
      return world
        .textureGroup()
        ?.entries.find((entry) => entry.binding === binding)?.resource;
    },
    /**
     * The depth-fail twin of the same primitive: its own command over the same
     * cache and material, driven through the depth-fail key set.
     */
    addDepthFailTwin() {
      const twinLayout = { kind: "bindGroupLayout" };
      cache.dfTextureBindGroupLayout = twinLayout;
      const twin = {
        ...command,
        bindGroups: [
          { role: "a" },
          { role: "b" },
          { ...slotPlaceholder },
          { role: "d" },
        ],
        _webgpuMatTextureIsDepthFail: true,
      };
      return {
        command: twin,
        refresh() {
          commands.updateWebGPUMaterialCommandUniforms(
            twin,
            frameState,
            Matrix4.IDENTITY,
          );
        },
        bound(binding = 1) {
          const group = twin.bindGroups[TEXTURE_SLOT];
          return group?.layout === twinLayout
            ? group.entries.find((entry) => entry.binding === binding)?.resource
            : undefined;
        },
      };
    },
    /** Destroy events, since a mark, for textures the path did not create. */
    mark() {
      return device.events.length;
    },
    foreignDestroysSince(mark) {
      return device.events
        .slice(mark)
        .filter((event) => event.kind === "destroy")
        .filter((event) => !created.has(event.texture))
        .map((event) => event.texture);
    },
    /**
     * Submit a draw that reads every texture the command's bind groups name.
     * The recording device records a violation for each one whose destroy()
     * was requested.
     */
    submitDraw() {
      const scratch = device.createTexture({ size: { width: 1, height: 1 } });
      const encoder = device.createCommandEncoder({ label: "draw" });
      for (const group of command.bindGroups) {
        // The effects slot the updater swaps in is outside this spec.
        const entries = Array.isArray(group?.entries) ? group.entries : [];
        for (const entry of entries) {
          const texture = entry.resource?.texture;
          if (texture) {
            encoder.copyTextureToTexture(
              { texture, origin: { x: 0, y: 0, z: 0 } },
              { texture: scratch, origin: { x: 0, y: 0, z: 0 } },
              { width: 1, height: 1, depthOrArrayLayers: 1 },
            );
          }
        }
      }
      device.queue.submit([encoder.finish()]);
    },
  };
  return world;
}

function assertNoViolation(world, message) {
  assert.deepEqual(
    world.device.violations,
    [],
    `${message}: a submitted draw touched a texture whose destroy() was requested`,
  );
}

/** No device texture had destroy() requested more than once. */
function assertNoTextureDestroyedTwice(world, message) {
  const counts = new Map();
  for (const event of world.device.events) {
    if (event.kind === "destroy") {
      counts.set(event.texture, (counts.get(event.texture) ?? 0) + 1);
    }
  }
  for (const [texture, count] of counts) {
    assert.equal(
      count,
      1,
      `${message}: a ${texture.width}x${texture.height} texture had destroy() requested ${count} times`,
    );
  }
}

// =============================================================================
// G0 - the premise, on the unedited Material
// =============================================================================

function scenarioG0VideoStaysOutOfImageSources(commands) {
  const world = makeWorld(commands);
  const video = makeVideo();
  world.material.uniforms.image = video;
  for (let frame = 0; frame < 3; frame++) {
    world.update();
    assert.equal(
      world.material._imageSources.image,
      undefined,
      "an HTMLVideoElement uniform must never be mirrored into _imageSources",
    );
  }
  const texture = world.material._textures.image;
  assert.ok(texture instanceof Texture, "_textures.image holds a Texture");
  assert.notEqual(
    texture,
    world.context.defaultTexture,
    "a video with a frame is not the default texture",
  );
  assert.deepEqual(
    [texture.width, texture.height],
    [640, 360],
    "the Texture is sized from the video frame, not from .width",
  );
  world.update();
  assert.equal(
    world.material._textures.image,
    texture,
    "later updates refresh the same Texture in place",
  );
}

function scenarioG0NoFrameYet(commands) {
  const world = makeWorld(commands);
  world.material.uniforms.image = makeVideo({ readyState: 1 });
  world.update();
  assert.equal(world.material._imageSources.image, undefined);
  assert.equal(
    world.material._textures.image,
    world.context.defaultTexture,
    "before the first frame WebGL samples the context default texture",
  );
}

test("G0 a video never reaches _imageSources and _textures holds its per-frame Texture", async () => {
  const commands = await getCommands();
  scenarioG0VideoStaysOutOfImageSources(commands);
  scenarioG0NoFrameYet(commands);
});

// =============================================================================
// G1 - a video material binds the view of _textures.image
// =============================================================================

function scenarioG1(commands, kind) {
  const world = makeWorld(commands, { kind });
  const video = makeVideo();
  world.material.uniforms.image = video;
  world.frame();
  const texture = world.material._textures.image;
  assert.ok(texture instanceof Texture);
  const expected = viewOf(texture);
  assert.ok(expected, "the video Texture has a GPU view on the stub");
  assert.ok(
    world.textureGroup(),
    `${kind}: no texture bind group reached the command`,
  );
  const bound = world.bound(1);
  assert.equal(
    bound,
    expected,
    `${kind}: binding 1 must be the view of material._textures.image`,
  );
  assert.notEqual(
    bound,
    world.placeholderView,
    `${kind}: the placeholder is bound`,
  );
  assert.deepEqual(
    [bound.texture.width, bound.texture.height],
    [640, 360],
    `${kind}: the bound texture is the 640x360 video texture`,
  );
  assert.deepEqual(
    world.imageCalls,
    [],
    `${kind}: createTextureFromImage must never be called for a video material`,
  );
  assert.notEqual(world.bound(0), undefined, `${kind}: the sampler is bound`);
  assert.equal(
    world.bound(2),
    world.placeholderView,
    `${kind}: a single-texture material keeps the placeholder in its second slot`,
  );
  world.submitDraw();
  assertNoViolation(world, kind);
  return world;
}

test("G1 a video material binds the view of material._textures.image on the main key set", async () => {
  const world = scenarioG1(await getCommands(), "main");
  assert.equal(
    world.cache.dfTextureBindGroup,
    undefined,
    "the main path must leave the depth-fail cache fields alone",
  );
});

test("G1 a video material binds the view of material._textures.image on the depth-fail key set", async () => {
  const world = scenarioG1(await getCommands(), "depthFail");
  assert.equal(
    world.cache.textureBindGroup,
    undefined,
    "the depth-fail path must leave the main cache fields alone",
  );
  assert.ok(world.cache.dfTextureBindGroup);
});

test("G1 a video material binds the view of material._textures.image on the polyline material updater", async () => {
  scenarioG1(await getCommands(), "polyline");
});

function scenarioG1Twins(commands) {
  const world = makeWorld(commands);
  world.material.uniforms.image = makeVideo();
  const twin = world.addDepthFailTwin();
  world.frame();
  twin.refresh();
  const expected = viewOf(world.material._textures.image);
  assert.ok(expected);
  assert.equal(world.bound(1), expected);
  assert.equal(
    twin.bound(1),
    expected,
    "the depth-fail twin resolves the same Material-owned texture",
  );
  assert.deepEqual(world.imageCalls, []);
}

test("G1 the main and depth-fail twins of one primitive bind the same video view", async () => {
  scenarioG1Twins(await getCommands());
});

// =============================================================================
// G3 - identity changes rebind; destroyed textures are never bound; ownership
// =============================================================================

function scenarioG3Steady(commands) {
  const world = makeWorld(commands);
  world.material.uniforms.image = makeVideo();
  const counts = [];
  const destroys = [];
  for (let frame = 0; frame < 6; frame++) {
    world.update();
    const mark = world.mark();
    world.refresh();
    destroys.push(world.foreignDestroysSince(mark).length);
    counts.push(world.textureBindGroupCount());
  }
  assert.deepEqual(
    counts,
    [1, 1, 1, 1, 1, 1],
    "a steady video must cost one createBindGroup, then none",
  );
  assert.deepEqual(destroys, [0, 0, 0, 0, 0, 0]);
  assert.equal(
    world.bound(1),
    viewOf(world.material._textures.image),
    "the same group still binds the video view after steady frames",
  );
}

function scenarioG3SecondVideo(commands) {
  const world = makeWorld(commands);
  world.material.uniforms.image = makeVideo();
  world.frame();
  const first = world.material._textures.image;
  const firstView = viewOf(first);
  world.submitDraw();

  world.material.uniforms.image = makeVideo({ width: 320, height: 180 });
  world.update();
  const second = world.material._textures.image;
  assert.notEqual(second, first, "the uniform switch built a new Texture");
  assert.equal(
    first.isDestroyed(),
    true,
    "the Material destroyed the old Texture",
  );
  const mark = world.mark();
  world.refresh();
  assert.deepEqual(
    world.foreignDestroysSince(mark),
    [],
    "binding the second video must destroy nothing",
  );
  assert.equal(world.bound(1), viewOf(second));
  assert.notEqual(world.bound(1), firstView);
  assert.equal(
    world.textureBindGroupCount(),
    2,
    "a second video costs exactly one more createBindGroup",
  );
  world.submitDraw();
  assertNoViolation(world, "second video");
  assertNoTextureDestroyedTwice(world, "second video");
}

function scenarioG3Reallocation(commands) {
  const world = makeWorld(commands);
  world.material.uniforms.image = makeVideo();
  world.frame();
  const texture = world.material._textures.image;
  const before = viewOf(texture);

  // Commit a new native for the same Texture, as a texImage2D at a new size
  // does; the stub destroys the old native itself.
  world.stubs.bindTexture(TEXTURE_2D, texture._texture);
  world.stubs.texImage2D(
    TEXTURE_2D,
    0,
    RGBA,
    320,
    180,
    0,
    RGBA,
    UNSIGNED_BYTE,
    null,
  );
  const after = viewOf(texture);
  assert.notEqual(after, before, "the harness reallocated the native");
  assert.equal(before.texture.destroyed, true);

  const mark = world.mark();
  world.refresh();
  assert.deepEqual(
    world.foreignDestroysSince(mark),
    [],
    "rebinding after a reallocation must destroy nothing",
  );
  assert.equal(
    world.bound(1),
    after,
    "the next draw binds the new native's view",
  );
  assert.equal(
    world.textureBindGroupCount(),
    2,
    "a reallocation costs exactly one more createBindGroup",
  );
  world.submitDraw();
  assertNoViolation(world, "reallocation");
  assertNoTextureDestroyedTwice(world, "reallocation");
  world.refresh();
  assert.equal(world.textureBindGroupCount(), 2, "and then none");
}

function scenarioG3DeviceGeneration(commands) {
  const world = makeWorld(commands);
  world.material.uniforms.image = makeVideo();
  world.frame();
  const texture = world.material._textures.image;
  assert.equal(world.bound(1), viewOf(texture));

  world.host.resourceGeneration += 1;
  assert.equal(
    viewOf(texture),
    null,
    "the harness left the Texture without a native in the new generation",
  );
  world.refresh();
  assert.equal(
    world.bound(1),
    world.placeholderView,
    "a Texture with no native in this generation binds the placeholder",
  );
  assert.equal(world.textureBindGroupCount(), 2);
  world.submitDraw();
  assertNoViolation(world, "device generation");
}

function scenarioG3DestroyedTexture(commands) {
  const world = makeWorld(commands);
  world.material.uniforms.image = makeVideo();
  world.frame();
  const texture = world.material._textures.image;
  const native = texture._texture._webgpuTexture.texture;
  assert.equal(world.bound(1), viewOf(texture));

  texture.destroy();
  assert.equal(native.destroyed, true, "the owner destroyed the native");
  const mark = world.mark();
  world.refresh();
  assert.deepEqual(world.foreignDestroysSince(mark), []);
  assert.equal(
    world.bound(1),
    world.placeholderView,
    "a destroyed Texture is never bound",
  );
  world.submitDraw();
  assertNoViolation(world, "owner destroy");
}

function scenarioG3Ownership(commands) {
  const world = makeWorld(commands);
  const canvas = makeCanvas();
  world.material.uniforms.image = canvas;
  world.update();
  world.update();
  world.refresh();
  assert.equal(world.imageCalls.length, 1, "the canvas is uploaded once");
  const created = world.imageCalls[0].handle;
  assert.equal(world.bound(1), created.view);

  // Image to video.
  world.material.uniforms.image = makeVideo();
  world.update();
  const foreign = [];
  let mark = world.mark();
  world.refresh();
  foreign.push(world.foreignDestroysSince(mark).length);
  assert.equal(
    created.destroys,
    1,
    "moving the slot from an image to a video destroys the texture the path created, once",
  );
  assert.equal(world.bound(1), viewOf(world.material._textures.image));
  for (let frame = 0; frame < 3; frame++) {
    world.frame();
  }
  assert.equal(created.destroys, 1, "and never again");

  // A second video, a reallocation, then a new device generation: nothing
  // the path did not create is destroyed by the path.
  world.material.uniforms.image = makeVideo({ width: 160, height: 90 });
  world.update();
  mark = world.mark();
  world.refresh();
  foreign.push(world.foreignDestroysSince(mark).length);

  const texture = world.material._textures.image;
  world.stubs.bindTexture(TEXTURE_2D, texture._texture);
  world.stubs.texImage2D(
    TEXTURE_2D,
    0,
    RGBA,
    80,
    45,
    0,
    RGBA,
    UNSIGNED_BYTE,
    null,
  );
  mark = world.mark();
  world.refresh();
  foreign.push(world.foreignDestroysSince(mark).length);

  world.host.resourceGeneration += 1;
  mark = world.mark();
  world.refresh();
  foreign.push(world.foreignDestroysSince(mark).length);

  assert.deepEqual(
    foreign,
    [0, 0, 0, 0],
    "the primitive path destroyed a texture it did not create",
  );
  world.submitDraw();
  assertNoViolation(world, "ownership sequence");
  assertNoTextureDestroyedTwice(world, "ownership sequence");
}

test("G3 a steady video costs one createBindGroup over many frames", async () => {
  scenarioG3Steady(await getCommands());
});

test("G3 a second video rebinds once and the old view is not referenced after its texture is destroyed", async () => {
  scenarioG3SecondVideo(await getCommands());
});

test("G3 a stub reallocation rebinds the new native once", async () => {
  scenarioG3Reallocation(await getCommands());
});

test("G3 a device-generation change binds the placeholder, not the old view", async () => {
  scenarioG3DeviceGeneration(await getCommands());
});

test("G3 a destroyed Texture is never bound", async () => {
  scenarioG3DestroyedTexture(await getCommands());
});

test("G3 the primitive path destroys only what it created, and destroys that once", async () => {
  scenarioG3Ownership(await getCommands());
});

// =============================================================================
// G4 - before the video has a frame
// =============================================================================

function scenarioG4(commands) {
  const world = makeWorld(commands);
  const video = makeVideo({ readyState: 0 });
  world.material.uniforms.image = video;
  world.frame();
  assert.equal(
    world.bound(1),
    world.placeholderView,
    "before the first frame the draw binds the default texture WebGL samples",
  );
  assert.deepEqual(world.imageCalls, []);
  const placeholderCount = world.textureBindGroupCount();
  world.frame();
  assert.equal(
    world.textureBindGroupCount(),
    placeholderCount,
    "and stays put",
  );

  video.readyState = 4;
  world.frame();
  const texture = world.material._textures.image;
  assert.notEqual(texture, world.context.defaultTexture);
  assert.equal(
    world.bound(1),
    viewOf(texture),
    "the first frame with data replaces the placeholder with the video view",
  );
  assert.equal(world.textureBindGroupCount(), placeholderCount + 1);
  world.submitDraw();
  assertNoViolation(world, "first frame");
}

test("G4 a video without a frame binds the placeholder and picks the video up when it has one", async () => {
  scenarioG4(await getCommands());
});

// =============================================================================
// G5 - switching shape on one uniform follows WebGL
// =============================================================================

function scenarioG5ImageToVideo(commands) {
  const world = makeWorld(commands);
  const canvas = makeCanvas();
  world.material.uniforms.image = canvas;
  world.update();
  world.update();
  world.refresh();
  assert.equal(world.material._imageSources.image, canvas);
  const imageView = world.imageCalls[0].handle.view;
  assert.equal(world.bound(1), imageView);

  world.material.uniforms.image = makeVideo();
  world.update();
  assert.equal(
    world.material._imageSources.image,
    canvas,
    "the mirror is never cleared, so the stale image is still reachable",
  );
  world.refresh();
  const texture = world.material._textures.image;
  assert.equal(
    world.bound(1),
    viewOf(texture),
    "WebGL samples the video from the next frame, and so must WebGPU",
  );
  assert.notEqual(
    world.bound(1),
    imageView,
    "the stale image must not be drawn",
  );
  world.frame();
  assert.equal(world.bound(1), viewOf(world.material._textures.image));
  world.submitDraw();
  assertNoViolation(world, "image to video");
}

function scenarioG5VideoToImage(commands) {
  const world = makeWorld(commands);
  world.material.uniforms.image = makeVideo();
  world.frame();
  const videoTexture = world.material._textures.image;
  const videoView = viewOf(videoTexture);
  assert.equal(world.bound(1), videoView);

  // The switch frame: the image is queued, not yet adopted. WebGL keeps
  // sampling the last video frame.
  const replacement = makeCanvas(128, 8);
  world.material.uniforms.image = replacement;
  world.update();
  assert.equal(world.material._imageSources.image, undefined);
  world.refresh();
  const between = world.bound(1);
  assert.ok(
    between === videoView || between === world.placeholderView,
    "before the image is adopted WebGPU samples the last video view or the placeholder",
  );
  assert.equal(between.texture.destroyed, false);
  world.submitDraw();
  assertNoViolation(world, "before adoption");

  // The adoption frame: Material.update drains the image and destroys the
  // video Texture.
  world.update();
  assert.equal(world.material._imageSources.image, replacement);
  assert.equal(videoTexture.isDestroyed(), true);
  world.refresh();
  assert.equal(world.imageCalls.length, 1);
  assert.deepEqual(
    [
      world.imageCalls[0].source,
      world.imageCalls[0].format,
      world.imageCalls[0].flipY,
    ],
    [replacement, "rgba8unorm", true],
    "the adopted image is uploaded once, through the image path",
  );
  assert.equal(
    world.bound(1),
    world.imageCalls[0].handle.view,
    "from the adoption frame WebGPU samples the image",
  );
  world.submitDraw();
  assertNoViolation(world, "after adoption");
  const count = world.textureBindGroupCount();
  world.frame();
  world.frame();
  assert.equal(world.textureBindGroupCount(), count, "and then it stays put");
  assert.equal(world.imageCalls.length, 1);
}

function scenarioG5StaleMirrorWindow(commands) {
  // Image A adopted, then a video, then image B queued and not yet adopted:
  // the mirror still holds A through the switch window, and WebGL keeps
  // sampling the last video frame until Material.update adopts B.
  const world = makeWorld(commands);
  const imageA = makeCanvas(256, 4);
  world.material.uniforms.image = imageA;
  world.update();
  world.update();
  world.refresh();
  assert.equal(world.material._imageSources.image, imageA);
  const uploadsOfA = world.imageCalls.length;
  assert.equal(uploadsOfA, 1, "image A is uploaded once");

  world.material.uniforms.image = makeVideo();
  world.frame();
  const videoTexture = world.material._textures.image;
  const videoView = viewOf(videoTexture);
  assert.ok(videoView, "the video Texture has a GPU view on the stub");
  assert.equal(world.bound(1), videoView, "the video is sampled");

  const imageB = makeCanvas(128, 8);
  world.material.uniforms.image = imageB;
  world.update();
  assert.equal(
    world.material._imageSources.image,
    imageA,
    "image B is queued, not adopted, so the mirror still holds the stale image A",
  );
  world.refresh();
  const between = world.bound(1);
  assert.ok(
    between === videoView || between === world.placeholderView,
    "before image B is adopted WebGPU samples the last video view or the placeholder, never the stale image A",
  );
  assert.equal(
    world.imageCalls.length,
    uploadsOfA,
    "the stale image A is not uploaded again in the switch window",
  );
  world.submitDraw();
  assertNoViolation(world, "stale mirror window");

  world.update();
  assert.equal(world.material._imageSources.image, imageB);
  world.refresh();
  assert.equal(
    world.imageCalls.length,
    uploadsOfA + 1,
    "image B is uploaded once on its adoption frame",
  );
  const last = world.imageCalls[world.imageCalls.length - 1];
  assert.equal(last.source, imageB, "the new upload is image B");
  assert.equal(
    world.bound(1),
    last.handle.view,
    "from the adoption frame WebGPU samples image B",
  );
  world.submitDraw();
  assertNoViolation(world, "after image B adoption");
}

test("G5 an image replaced by a video is not drawn once the video has a Texture", async () => {
  scenarioG5ImageToVideo(await getCommands());
});

test("G5 a video replaced by an image keeps the last view until the image is adopted, then samples the image", async () => {
  scenarioG5VideoToImage(await getCommands());
});

test("G5 a queued image does not bring back a stale adopted image while the video is replaced", async () => {
  scenarioG5StaleMirrorWindow(await getCommands());
});

// =============================================================================
// G6 - image materials are unchanged
// =============================================================================

/** An image the way Material.update hands it to _imageSources. */
function adoptInto(world, image) {
  world.material._imageSources.image = image;
}

function scenarioG6CanvasAndBitmap(commands) {
  for (const make of [makeCanvas, makeBitmap]) {
    const world = makeWorld(commands);
    const image = make();
    world.material.uniforms.image = image;
    world.update();
    world.refresh();
    assert.equal(world.bound(1), world.placeholderView, "queued, not adopted");
    assert.deepEqual(world.imageCalls, []);
    const queuedCount = world.textureBindGroupCount();

    world.update();
    world.refresh();
    assert.equal(world.imageCalls.length, 1, "one upload per distinct source");
    assert.deepEqual(
      [
        world.imageCalls[0].source,
        world.imageCalls[0].format,
        world.imageCalls[0].flipY,
      ],
      [image, "rgba8unorm", true],
    );
    assert.equal(world.bound(1), world.imageCalls[0].handle.view);
    assert.equal(
      world.textureBindGroupCount(),
      queuedCount + 1,
      "one createBindGroup per source change",
    );
    for (let frame = 0; frame < 4; frame++) {
      world.frame();
    }
    assert.equal(
      world.imageCalls.length,
      1,
      "an unchanged identity is a cache hit",
    );
    assert.equal(world.textureBindGroupCount(), queuedCount + 1);
    assert.equal(world.imageCalls[0].handle.destroys, 0);
  }
}

function scenarioG6UrlImages(commands) {
  const world = makeWorld(commands);
  world.material.uniforms.image = "https://example.invalid/a.png";
  world.refresh();
  assert.equal(
    world.bound(1),
    world.placeholderView,
    "a URL image still loading binds the placeholder",
  );
  const loading = world.textureBindGroupCount();

  const first = makeBitmap(8, 8);
  adoptInto(world, first);
  world.refresh();
  assert.equal(world.imageCalls.length, 1);
  assert.equal(world.imageCalls[0].source, first);
  assert.equal(world.bound(1), world.imageCalls[0].handle.view);
  assert.equal(world.textureBindGroupCount(), loading + 1);
  world.refresh();
  world.refresh();
  assert.equal(world.imageCalls.length, 1);
  assert.equal(world.textureBindGroupCount(), loading + 1);

  const second = makeBitmap(16, 16);
  adoptInto(world, second);
  world.refresh();
  assert.equal(
    world.imageCalls.length,
    2,
    "a changed source is uploaded again",
  );
  assert.equal(world.imageCalls[1].source, second);
  assert.equal(world.bound(1), world.imageCalls[1].handle.view);
  assert.equal(world.textureBindGroupCount(), loading + 2);
  assert.equal(
    world.imageCalls[0].handle.destroys,
    1,
    "the replaced upload is destroyed, once",
  );
  assert.equal(world.imageCalls[1].handle.destroys, 0);
}

function scenarioG6WithoutVideoClass(commands) {
  const saved = globalThis.HTMLVideoElement;
  const world = makeWorld(commands);
  world.material.uniforms.image = "https://example.invalid/a.png";
  delete globalThis.HTMLVideoElement;
  try {
    assert.equal(typeof globalThis.HTMLVideoElement, "undefined");
    world.refresh();
    assert.equal(world.bound(1), world.placeholderView);
    const image = makeBitmap(8, 8);
    adoptInto(world, image);
    world.refresh();
    assert.equal(world.imageCalls.length, 1);
    assert.equal(world.imageCalls[0].source, image);
    assert.equal(world.bound(1), world.imageCalls[0].handle.view);
    world.refresh();
    assert.equal(world.imageCalls.length, 1);
  } finally {
    globalThis.HTMLVideoElement = saved;
  }
}

test("G6 canvas and ImageBitmap uniforms upload once per source and rebuild once per change", async () => {
  scenarioG6CanvasAndBitmap(await getCommands());
});

test("G6 a URL image binds the placeholder while it loads, then its upload, and rebuilds once per source change", async () => {
  scenarioG6UrlImages(await getCommands());
});

test("G6 image materials bind the same with HTMLVideoElement undefined", async () => {
  scenarioG6WithoutVideoClass(await getCommands());
});

// =============================================================================
// G8 - the other _textures-only shapes
// =============================================================================

function makeRgba8Texture(world, width = 32, height = 16) {
  return new Texture({
    context: world.context,
    source: {
      width,
      height,
      arrayBufferView: new Uint8Array(width * height * 4),
    },
  });
}

function scenarioG8CallerTexture(commands) {
  const world = makeWorld(commands);
  const supplied = makeRgba8Texture(world);
  world.material.uniforms.image = supplied;
  world.frame();
  assert.equal(world.material._textures.image, supplied);
  assert.equal(
    world.bound(1),
    viewOf(supplied),
    "a caller-supplied Texture is what WebGL samples, and so what WebGPU binds",
  );
  assert.notEqual(world.bound(1), world.placeholderView);
  assert.deepEqual(world.imageCalls, []);
  const mark = world.mark();
  world.frame();
  assert.deepEqual(world.foreignDestroysSince(mark), []);
  assert.equal(
    supplied.isDestroyed(),
    false,
    "the primitive path never destroys it",
  );
  assert.equal(world.textureBindGroupCount(), 1);
  world.submitDraw();
  assertNoViolation(world, "caller texture");
}

function scenarioG8UnfilterableTexture(commands) {
  const world = makeWorld(commands);
  const floating = new Texture({
    context: world.context,
    width: 4,
    height: 1,
    pixelDatatype: PixelDatatype.FLOAT,
    source: { width: 4, height: 1, arrayBufferView: new Float32Array(16) },
  });
  assert.equal(
    floating._texture._webgpuTexture.format,
    "rgba32float",
    "the harness produced a texture the material sampler cannot filter",
  );
  world.material.uniforms.image = floating;
  world.frame();
  assert.equal(
    world.bound(1),
    world.placeholderView,
    "an unfilterable format would fail validation, so the placeholder is bound",
  );
  world.submitDraw();
  assertNoViolation(world, "unfilterable texture");
}

function scenarioG8ElevationBand(commands) {
  const world = makeWorld(commands, {
    shaderType: "matElevBandFlat",
    material: new Material({ fabric: { type: "ElevationBand" } }),
  });
  const heights = makeRgba8Texture(world, 8, 1);
  const colors = makeRgba8Texture(world, 8, 1);
  world.material.uniforms.heights = heights;
  world.material.uniforms.colors = colors;
  world.update();
  assert.equal(world.material._textures.heights, heights);
  assert.equal(world.material._textures.colors, colors);
  world.refresh();
  assert.equal(
    world.bound(1),
    world.placeholderView,
    "heights bind as at base",
  );
  assert.equal(world.bound(2), world.placeholderView, "colors bind as at base");
  assert.deepEqual(world.imageCalls, []);

  // The image path is still the band's path.
  const heightsImage = makeCanvas(8, 1);
  const colorsImage = makeCanvas(16, 1);
  world.material._imageSources.heights = heightsImage;
  world.material._imageSources.colors = colorsImage;
  world.refresh();
  assert.deepEqual(
    world.imageCalls.map((call) => call.source),
    [heightsImage, colorsImage],
  );
  assert.equal(world.bound(1), world.imageCalls[0].handle.view);
  assert.equal(world.bound(2), world.imageCalls[1].handle.view);
}

function scenarioG8Compressed(commands) {
  // A KTX2 image is a URL or a Resource, so the uniform's value is never a
  // video or a Texture, and Material.update keeps its decoded form out of
  // _imageSources while the Texture it builds lives in _textures.
  const world = makeWorld(commands);
  world.material.uniforms.image = "https://example.invalid/a.ktx2";
  world.material._textures.image = makeRgba8Texture(world);
  world.refresh();
  assert.equal(
    world.bound(1),
    world.placeholderView,
    "a compressed image binds as at base: the placeholder",
  );
  assert.deepEqual(world.imageCalls, []);
  const count = world.textureBindGroupCount();
  world.refresh();
  assert.equal(world.textureBindGroupCount(), count);
}

function makeWaterWorld(commands) {
  return makeWorld(commands, {
    shaderType: "matWater",
    material: new Material({ fabric: { type: "Water" } }),
  });
}

function scenarioG8SecondarySlotTexture(commands) {
  // Water binds normalMap at binding 1 and specularMap at binding 2.
  const world = makeWaterWorld(commands);
  const supplied = makeRgba8Texture(world, 16, 16);
  world.material.uniforms.specularMap = supplied;
  world.frame();
  assert.equal(world.material._textures.specularMap, supplied);
  const expected = viewOf(supplied);
  assert.ok(expected, "the caller Texture has a GPU view on the stub");
  assert.equal(
    world.bound(2),
    expected,
    "a caller Texture in the secondary slot is what WebGL samples, and so what WebGPU binds at binding 2",
  );
  assert.notEqual(world.bound(2), world.placeholderView);
  assert.deepEqual(world.imageCalls, []);
  world.submitDraw();
  assertNoViolation(world, "secondary caller texture");
}

function scenarioG8SecondarySlotImageToTexture(commands) {
  const world = makeWaterWorld(commands);
  const mask = makeCanvas(32, 32);
  world.material.uniforms.specularMap = mask;
  world.update();
  world.update();
  world.refresh();
  assert.equal(world.material._imageSources.specularMap, mask);
  const upload = world.imageCalls.find((call) => call.source === mask);
  assert.ok(upload, "the secondary image is uploaded through the image path");
  assert.equal(world.bound(2), upload.handle.view);

  const supplied = makeRgba8Texture(world, 16, 16);
  world.material.uniforms.specularMap = supplied;
  world.update();
  const mark = world.mark();
  world.refresh();
  assert.equal(
    world.bound(2),
    viewOf(supplied),
    "after the switch binding 2 is the caller Texture",
  );
  assert.equal(
    upload.handle.destroys,
    1,
    "the switch destroys the secondary slot's created texture once",
  );
  assert.deepEqual(world.foreignDestroysSince(mark), []);
  world.frame();
  world.frame();
  assert.equal(upload.handle.destroys, 1, "and never again");
  assert.equal(supplied.isDestroyed(), false);
  world.submitDraw();
  assertNoViolation(world, "secondary image to texture");
  assertNoTextureDestroyedTwice(world, "secondary image to texture");
}

test("G8 a caller-supplied Texture binds the Texture WebGL samples", async () => {
  scenarioG8CallerTexture(await getCommands());
});

test("G8 a Texture in an unfilterable format binds the placeholder", async () => {
  scenarioG8UnfilterableTexture(await getCommands());
});

test("G8 the elevation band keeps the image path for both slots", async () => {
  scenarioG8ElevationBand(await getCommands());
});

test("G8 a compressed image binds as it did, because its uniform is not a video or a Texture", async () => {
  scenarioG8Compressed(await getCommands());
});

test("G8 a caller Texture in a two-slot material's secondary slot binds that Texture", async () => {
  scenarioG8SecondarySlotTexture(await getCommands());
});

test("G8 a secondary slot moving from an image to a Texture destroys its created texture once", async () => {
  scenarioG8SecondarySlotImageToTexture(await getCommands());
});

// =============================================================================
// Inertness mutants
// =============================================================================
// Each rewrites a COPY of the source so one half of the behaviour is present
// but unreachable, and requires its group to fail with an assertion (not with
// an engine crash, which would prove nothing about the assertion).

const SELECTION_LINE = "  if (uniformSamplesMaterialTextures(value)) {\n";

function companionMutant(label, rewrite) {
  return loadCommands({
    label,
    overrides: [{ basename: COMPANION_BASENAME, label, mutate: rewrite }],
  });
}

function isAssertionError(error) {
  return error instanceof assert.AssertionError;
}

async function assertGroupFails(namespace, scenarios, name) {
  for (const scenario of scenarios) {
    await assert.rejects(
      async () => scenario(namespace),
      isAssertionError,
      `${name}: ${scenario.name} still passed`,
    );
  }
}

test("M1 MUTANT - the _textures resolution made unreachable turns G1 and G4 red", async () => {
  const namespace = await companionMutant(
    "textures selection unreachable",
    (source) =>
      source.replace(
        SELECTION_LINE,
        "  if (false && uniformSamplesMaterialTextures(value)) {\n",
      ),
  );
  await assertGroupFails(
    namespace,
    [
      (ns) => scenarioG1(ns, "main"),
      (ns) => scenarioG1(ns, "depthFail"),
      (ns) => scenarioG1(ns, "polyline"),
      scenarioG1Twins,
      scenarioG4,
    ],
    "M1",
  );
});

test("M2 MUTANT - the view identity ignored turns G3 red", async () => {
  const namespace = await companionMutant("view identity ignored", (source) =>
    source.replace(
      "  return (\n    primary?.boundView === boundViewFor(choice.primary) &&",
      "  return (\n    true ||\n    primary?.boundView === boundViewFor(choice.primary) &&",
    ),
  );
  await assertGroupFails(
    namespace,
    [
      scenarioG3SecondVideo,
      scenarioG3Reallocation,
      scenarioG3DeviceGeneration,
      scenarioG3DestroyedTexture,
      scenarioG4,
    ],
    "M2",
  );
});

test("M2b MUTANT - the view identity never matching rebuilds every frame and turns the cost assertions red", async () => {
  const namespace = await companionMutant(
    "view identity never current",
    (source) =>
      source.replace(
        "  return (\n    primary?.boundView === boundViewFor(choice.primary) &&",
        "  return (\n    false &&\n    primary?.boundView === boundViewFor(choice.primary) &&",
      ),
  );
  await assertGroupFails(
    namespace,
    [scenarioG3Steady, scenarioG6CanvasAndBitmap, scenarioG6UrlImages],
    "M2b",
  );
});

test("M3 MUTANT - selecting by _imageSources presence instead of by the uniform's value turns G5 and G8 red", async () => {
  const namespace = await companionMutant(
    "selection by image source",
    (source) =>
      source.replace(SELECTION_LINE, "  if (imageSource === undefined) {\n"),
  );
  await assertGroupFails(
    namespace,
    [scenarioG5ImageToVideo, scenarioG8Compressed],
    "M3",
  );
});

test("M4 MUTANT - the image path forced through the _textures branch turns G6 red", async () => {
  const namespace = await companionMutant(
    "image path through textures",
    (source) => source.replace(SELECTION_LINE, "  if (true) {\n"),
  );
  await assertGroupFails(
    namespace,
    [scenarioG6CanvasAndBitmap, scenarioG6UrlImages, scenarioG5VideoToImage],
    "M4",
  );
});

test("M5 MUTANT - the _textures native stored where the cache destroys on replacement turns the ownership assertions red", async () => {
  const namespace = await loadCommands({
    label: "textures native in created-texture field",
    mutate: (source) =>
      source.replace(
        "    primaryView = choice.primary.view ?? undefined;\n",
        "    primaryView = choice.primary.view ?? undefined;\n" +
          "    {\n" +
          "      const stubNative = (material as any)?._textures?.[slots.primary]\n" +
          "        ?._texture?._webgpuTexture;\n" +
          "      if (stubNative) {\n" +
          "        cache[k.gpuTexturePrimary] = stubNative;\n" +
          "      }\n" +
          "    }\n",
      ),
  });
  await assertGroupFails(
    namespace,
    [scenarioG3SecondVideo, scenarioG3Reallocation, scenarioG3Ownership],
    "M5",
  );
});

test("M6 MUTANT - the unfilterable-format guard removed turns the unfilterable case red", async () => {
  const namespace = await companionMutant(
    "unfilterable guard removed",
    (source) =>
      source.replace(
        "function isUnfilterableFormat(format: unknown): boolean {\n",
        "function isUnfilterableFormat(format: unknown): boolean {\n  if (true) {\n    return false;\n  }\n",
      ),
  );
  await assertGroupFails(namespace, [scenarioG8UnfilterableTexture], "M6");
});

test("M7 MUTANT - the elevation band exclusion removed turns the band case red", async () => {
  const namespace = await companionMutant(
    "elevation band exclusion removed",
    (source) =>
      source.replace(
        '  return shaderType.includes("ElevBand");',
        '  return false && shaderType.includes("ElevBand");',
      ),
  );
  await assertGroupFails(namespace, [scenarioG8ElevationBand], "M7");
});

/** Replace an anchor that must occur exactly once, so a drifted anchor fails loudly. */
function replaceOnce(source, anchor, replacement) {
  const count = source.split(anchor).length - 1;
  if (count !== 1) {
    throw new Error(
      `mutant anchor matched ${count} times, expected 1: ${JSON.stringify(anchor)}`,
    );
  }
  return source.replace(anchor, replacement);
}

test("M8 MUTANT - the hold until adoption made unreachable turns the stale-mirror window red", async () => {
  const namespace = await companionMutant(
    "hold until adoption unreachable",
    (source) =>
      replaceOnce(
        source,
        "    state.held === undefined ||\n",
        "    true ||\n    state.held === undefined ||\n",
      ),
  );
  await assertGroupFails(namespace, [scenarioG5StaleMirrorWindow], "M8");
});

test("M9 MUTANT - the secondary slot's _textures branch made unreachable turns the secondary-slot cases red", async () => {
  const namespace = await loadCommands({
    label: "secondary textures branch unreachable",
    mutate: (source) =>
      replaceOnce(
        source,
        "  if (choice.secondary.fromTextures) {\n",
        "  if (false && choice.secondary.fromTextures) {\n",
      ),
  });
  await assertGroupFails(
    namespace,
    [scenarioG8SecondarySlotTexture, scenarioG8SecondarySlotImageToTexture],
    "M9",
  );
});
