// webgpu-stub-texture-uploads.spec.mjs - what the WebGPU WebGL-stub texture layer
// does for a growing TextureAtlas and for a video element, driven through the
// REAL engine modules under a recording fake device. Pure Node: no browser, no
// build, no GPU.
//
//   node --test Tools/visual-regression/webgpu-stub-texture-uploads.spec.mjs
//
// @purpose Pins that a TextureAtlas that grows after the frame's encoder is gone still carries every earlier image into the larger texture before the old texture is destroyed, and that an HTMLVideoElement uploads at its frame size on every stub and helper upload path while every other source uploads at its own width and height.
// @status ACTIVE
//
// -- WHAT THIS IS ABOUT -------------------------------------------------------
//
// Atlas. `TextureAtlas._copyFromTexture` copies each earlier image from the old
// atlas texture (a framebuffer color attachment) into the larger new one with
// `gl.copyTexSubImage2D`, and `TextureAtlas` then destroys the old texture.
// `BillboardCollection` runs that growth from a `frameState.afterRender`
// callback, which on WebGPU runs after `endFrame` has dropped the frame's
// command encoder. The copy therefore has no frame encoder to be recorded in,
// and the old texture is destroyed straight afterwards. WebGL is the reference:
// there the copy happens and the earlier images are still on screen.
//
// Video. A video element that has no width or height attribute reports
// `width === 0` and `height === 0`, while its frames are `videoWidth x
// videoHeight`. WebGL's `Texture.js` sizes a video upload from the frame size
// whenever both are defined. The WebGPU paths that can receive a video are the
// stub's 6-argument `texImage2D`, its 7-argument `texSubImage2D` and
// `WebGPUImageUpload.uploadImageToTexture`.
//
// -- HOW THIS IS TESTED -------------------------------------------------------
//
// Nothing here greps source. The real `WebGLStubTexture.ts`,
// `WebGLStubFramebuffer.ts` and `WebGPUImageUpload.ts` are bundled with esbuild
// (every import kept real) and executed against one fake `GPUDevice` whose
// queue keeps a texel model:
//
//   * `writeTexture` writes bytes into the model texture at once, as the queue
//     timeline does.
//   * `copyTextureToTexture` is recorded in a fake encoder and executes only
//     when that encoder's command buffer is submitted; a submit that touches a
//     texture whose `destroy()` was already requested is recorded as a
//     violation, as WebGPU would invalidate it.
//   * `destroy()`, `submit` and every upload share ONE ordered event log.
//
// So "the earlier images are still there" is read from texel values in the new
// texture, not from a call count, and "nothing is read after destruction" is
// read from the order of the log.
//
// Most cases give the stub a state object whose `copyTextureRegion` follows
// the context's contract. That contract is itself part of the fix, so the
// "real wiring" cases build the stub the way the context does, through
// `buildWebGLCompatibilityStubFor`, on a host whose `copyTextureRegion` and
// `copyTexture` are the real `WebGPUContext.prototype` methods. A host that
// stopped forwarding the caller's encoder, or a context that ignored it, loses
// the earlier images there exactly as the unfixed stub did.
//
// Not duplicated here: the in-frame same-encoder mip ordering that
// `WebGLStubTextureRecoverySpec.js` ("encodes framebuffer-copy mips after the
// copy in the same scene encoder") already covers.
//
// The sizes of sources WITHOUT `videoWidth` (image, ImageBitmap, canvas) are a
// no-regression pin: they upload at exactly `width x height`, the size they
// uploaded at before the video fix. WebGL sizes an image from `naturalWidth` /
// `naturalHeight`; that difference is deliberately not asserted or fixed here.
//
// -- RUNNER HOME --------------------------------------------------------------
//
// `test-engine-node` (package.json; the seat owns the line).

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

import { withLaneTmp } from "../lib/lane-tmp.mjs";

const engineDir = fileURLToPath(
  new URL("../../packages/engine/Source/Renderer/WebGPU/", import.meta.url),
).replaceAll("\\", "/");

// The stub decides "external image" with instanceof, so the fakes are real
// classes of these names. Installed before the engine modules load.
class FakeHTMLVideoElement {}
class FakeHTMLImageElement {}
class FakeHTMLCanvasElement {}
class FakeImageBitmap {}
globalThis.HTMLVideoElement = FakeHTMLVideoElement;
globalThis.HTMLImageElement = FakeHTMLImageElement;
globalThis.HTMLCanvasElement = FakeHTMLCanvasElement;
globalThis.ImageBitmap = FakeImageBitmap;
globalThis.GPUTextureUsage = Object.freeze({
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
});

// One bundle over the real modules, every import kept real: the stub module
// uses TypeScript parameter properties, which Node's strip-only mode refuses,
// so the modules are compiled by esbuild rather than imported directly.
const bundled = await build({
  stdin: {
    contents: [
      `export * from "${engineDir}Stubs/WebGLStubTexture.ts";`,
      `export { createFramebufferStubs } from "${engineDir}Stubs/WebGLStubFramebuffer.ts";`,
      `export { WebGPUImageUpload } from "${engineDir}WebGPUImageUpload.ts";`,
      `export { STUB_TEXTURE_TRACE_GLOBAL } from "${engineDir}Stubs/WebGLStubTextureTrace.ts";`,
      `export { default as Framebuffer } from "${engineDir}../Framebuffer.js";`,
    ].join("\n"),
    resolveDir: engineDir,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
  logLevel: "silent",
});
const {
  createTextureStubs,
  WebGLStubTextureRegistry,
  createFramebufferStubs,
  WebGPUImageUpload,
  STUB_TEXTURE_TRACE_GLOBAL,
  Framebuffer,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

// The context's own wiring: the stub builder the context calls, and the
// context class whose copy methods the "real wiring" cases run. A separate
// bundle because the context module is large and only those cases need it.
// It is imported from a file in a lane temp directory rather than a `data:`
// URL: an error thrown inside it carries one stack frame per call, and a
// frame that names an 11 MB `data:` URL makes a red run's report unreadable.
const wiringBundle = await build({
  stdin: {
    contents: [
      `export { buildWebGLCompatibilityStubFor } from "${engineDir}WebGPUContextWebGLStubInit.ts";`,
      `export { WebGPUContext } from "${engineDir}WebGPUContext.ts";`,
    ].join("\n"),
    resolveDir: engineDir,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
  logLevel: "silent",
});
const { buildWebGLCompatibilityStubFor, WebGPUContext } = await withLaneTmp(
  "stub-texture-wiring-",
  async (directory) => {
    const file = path.join(directory, "wiring.mjs");
    writeFileSync(file, wiringBundle.outputFiles[0].text);
    return await import(pathToFileURL(file).href);
  },
);

const TEXTURE_2D = 0x0de1;
const FRAMEBUFFER = 0x8d40;
const READ_FRAMEBUFFER = 0x8ca8;
const COLOR_ATTACHMENT0 = 0x8ce0;
const RGBA = 0x1908;
const UNSIGNED_BYTE = 0x1401;

// -- the recording fake device -------------------------------------------------

function makeDevice() {
  const events = [];
  const textures = [];
  const violations = [];
  const encodersCreated = [];

  function makeModelTexture(descriptor) {
    const width = descriptor.size.width;
    const height = descriptor.size.height;
    // The fields `WebGPUContext.copyTexture` validates a copy against.
    const texture = {
      descriptor,
      width,
      height,
      depthOrArrayLayers: descriptor.size.depthOrArrayLayers ?? 1,
      format: descriptor.format,
      usage: descriptor.usage ?? 0,
      sampleCount: descriptor.sampleCount ?? 1,
      dimension: descriptor.dimension ?? "2d",
      data: new Uint8Array(width * height * 4),
      destroyed: false,
      createView() {
        return { texture };
      },
      destroy() {
        texture.destroyed = true;
        events.push({ kind: "destroy", texture });
      },
    };
    return texture;
  }

  function makeEncoder(label) {
    const encoder = {
      label,
      copies: [],
      finished: false,
      copyTextureToTexture(source, destination, size) {
        encoder.copies.push({
          source: source.texture,
          sourceOrigin: { x: source.origin.x, y: source.origin.y },
          destination: destination.texture,
          destinationOrigin: {
            x: destination.origin.x,
            y: destination.origin.y,
          },
          size: { width: size.width, height: size.height },
        });
      },
      finish() {
        encoder.finished = true;
        return { encoder };
      },
    };
    return encoder;
  }

  function execute(copy) {
    const { source, destination, sourceOrigin, destinationOrigin, size } = copy;
    for (let row = 0; row < size.height; row++) {
      for (let column = 0; column < size.width; column++) {
        const from =
          ((sourceOrigin.y + row) * source.width + sourceOrigin.x + column) * 4;
        const to =
          ((destinationOrigin.y + row) * destination.width +
            destinationOrigin.x +
            column) *
          4;
        destination.data.set(source.data.subarray(from, from + 4), to);
      }
    }
  }

  const device = {
    events,
    textures,
    violations,
    encodersCreated,
    features: new Set(),
    createTexture(descriptor) {
      const texture = makeModelTexture(descriptor);
      textures.push(texture);
      return texture;
    },
    createSampler(descriptor) {
      return { descriptor };
    },
    createCommandEncoder(descriptor) {
      const encoder = makeEncoder(descriptor?.label);
      encodersCreated.push(encoder);
      return encoder;
    },
    queue: {
      writeTexture(destination, data, layout, size) {
        const texture = destination.texture;
        const bytes = new Uint8Array(
          data.buffer,
          data.byteOffset,
          data.byteLength,
        );
        const ox = destination.origin?.x ?? 0;
        const oy = destination.origin?.y ?? 0;
        for (let row = 0; row < size.height; row++) {
          const from = row * layout.bytesPerRow;
          const to = ((oy + row) * texture.width + ox) * 4;
          texture.data.set(bytes.subarray(from, from + size.width * 4), to);
        }
        events.push({ kind: "write", texture });
      },
      copyExternalImageToTexture(source, destination, size) {
        events.push({
          kind: "external",
          source: source.source,
          texture: destination.texture,
          origin: destination.origin,
          size: { width: size.width, height: size.height },
        });
      },
      submit(commandBuffers) {
        const submitted = [];
        for (const commandBuffer of commandBuffers) {
          for (const copy of commandBuffer.encoder.copies) {
            if (copy.source.destroyed || copy.destination.destroyed) {
              violations.push(copy);
              continue;
            }
            execute(copy);
            submitted.push(copy);
          }
        }
        events.push({ kind: "submit", copies: submitted });
      },
    },
  };
  return device;
}

function makeHarness({ frameEncoder = null, withContext = true } = {}) {
  const device = makeDevice();
  const usage = [];
  let currentTextureRequests = 0;
  const canvasTexture = device.createTexture({
    size: { width: 4, height: 4 },
  });
  const state = {
    device,
    resourceGeneration: 0,
    context: withContext
      ? {
          getCurrentTexture() {
            currentTextureRequests++;
            return canvasTexture;
          },
        }
      : null,
    currentCommandEncoder: frameEncoder,
    currentRenderPassEncoder: null,
    activeTextureUnit: 0,
    textureBindings: new Map(),
    textureRegistry: new WebGLStubTextureRegistry(),
    framebuffers: new Map(),
    boundFramebuffer: null,
    boundReadFramebuffer: null,
    boundDrawFramebuffer: null,
    pixelStore: {
      unpackFlipY: false,
      unpackPremultiplyAlpha: false,
      unpackAlignment: 4,
    },
    mipmapGenerator: null,
    enqueueMipGeneration() {
      return true;
    },
    encodeMipGenerationInCurrentEncoder() {
      return true;
    },
    cancelMipGeneration() {},
    // The context's contract: record into the caller's encoder when one is
    // passed, otherwise into the current frame encoder, and report false when
    // there is neither.
    copyTextureRegion(source, destination, sx, sy, dx, dy, w, h, encoder) {
      const target = encoder ?? state.currentCommandEncoder;
      if (!target) {
        return false;
      }
      target.copyTextureToTexture(
        { texture: source, origin: { x: sx, y: sy, z: 0 } },
        { texture: destination, origin: { x: dx, y: dy, z: 0 } },
        { width: w, height: h, depthOrArrayLayers: 1 },
      );
      return true;
    },
  };
  const logUsage = (method, reason) => usage.push({ method, reason });
  return {
    device,
    state,
    usage,
    stubs: {
      ...createTextureStubs(state, logUsage),
      ...createFramebufferStubs(state, logUsage),
    },
    canvasTexture,
    get currentTextureRequests() {
      return currentTextureRequests;
    },
  };
}

// -- the atlas scenario ---------------------------------------------------------

const OLD_SIZE = 8;
const NEW_SIZE = 16;
// Three earlier images: where each sits in the old texture, where the grown
// atlas packs it, and its size. Every pixel of every image has a value no other
// pixel has, so a copy from the wrong place or to the wrong place shows.
const IMAGES = [
  { id: 1, from: { x: 0, y: 0 }, to: { x: 8, y: 0 }, w: 2, h: 2 },
  { id: 2, from: { x: 4, y: 1 }, to: { x: 0, y: 9 }, w: 2, h: 3 },
  { id: 3, from: { x: 1, y: 5 }, to: { x: 10, y: 10 }, w: 3, h: 2 },
];

function imagePixel(image, column, row) {
  return [image.id * 40 + column * 5 + row, 10 * column + image.id, row, 255];
}

function imageBytes(image) {
  const bytes = new Uint8Array(image.w * image.h * 4);
  for (let row = 0; row < image.h; row++) {
    for (let column = 0; column < image.w; column++) {
      bytes.set(imagePixel(image, column, row), (row * image.w + column) * 4);
    }
  }
  return bytes;
}

function pixelAt(texture, x, y) {
  const at = (y * texture.width + x) * 4;
  return Array.from(texture.data.subarray(at, at + 4));
}

/** Allocate OLD with the images uploaded, NEW larger and empty, and bind. */
function setUpAtlas(harness, { bindFramebuffer = true } = {}) {
  const { stubs } = harness;
  const oldWrapper = stubs.createTexture();
  stubs.bindTexture(TEXTURE_2D, oldWrapper);
  stubs.texImage2D(
    TEXTURE_2D,
    0,
    RGBA,
    OLD_SIZE,
    OLD_SIZE,
    0,
    RGBA,
    UNSIGNED_BYTE,
    null,
  );
  for (const image of IMAGES) {
    stubs.texSubImage2D(
      TEXTURE_2D,
      0,
      image.from.x,
      image.from.y,
      image.w,
      image.h,
      RGBA,
      UNSIGNED_BYTE,
      imageBytes(image),
    );
  }
  const oldTexture = oldWrapper._texture;

  const newWrapper = stubs.createTexture();
  stubs.bindTexture(TEXTURE_2D, newWrapper);
  stubs.texImage2D(
    TEXTURE_2D,
    0,
    RGBA,
    NEW_SIZE,
    NEW_SIZE,
    0,
    RGBA,
    UNSIGNED_BYTE,
    null,
  );
  const newTexture = newWrapper._texture;

  let framebuffer = null;
  if (bindFramebuffer) {
    framebuffer = stubs.createFramebuffer();
    stubs.bindFramebuffer(FRAMEBUFFER, framebuffer);
    stubs.framebufferTexture2D(
      FRAMEBUFFER,
      COLOR_ATTACHMENT0,
      TEXTURE_2D,
      oldWrapper,
      0,
    );
  }
  return { oldWrapper, oldTexture, newWrapper, newTexture, framebuffer };
}

function copyEveryImage(stubs) {
  for (const image of IMAGES) {
    stubs.copyTexSubImage2D(
      TEXTURE_2D,
      0,
      image.to.x,
      image.to.y,
      image.from.x,
      image.from.y,
      image.w,
      image.h,
    );
  }
}

function sameCopy(copy, source, destination, image) {
  return (
    copy.source === source &&
    copy.destination === destination &&
    copy.sourceOrigin.x === image.from.x &&
    copy.sourceOrigin.y === image.from.y &&
    copy.destinationOrigin.x === image.to.x &&
    copy.destinationOrigin.y === image.to.y &&
    copy.size.width === image.w &&
    copy.size.height === image.h
  );
}

function assertImagesCarried(newTexture) {
  for (const image of IMAGES) {
    for (let row = 0; row < image.h; row++) {
      for (let column = 0; column < image.w; column++) {
        assert.deepEqual(
          pixelAt(newTexture, image.to.x + column, image.to.y + row),
          imagePixel(image, column, row),
          `image ${image.id} texel (${column},${row}) is at its new rectangle`,
        );
      }
    }
  }
  // Texels outside every new rectangle were never written.
  assert.deepEqual(pixelAt(newTexture, 15, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixelAt(newTexture, 0, 0), [0, 0, 0, 0]);
}

describe("a TextureAtlas that grows after the frame's encoder is gone", () => {
  it("carries every earlier image into the new texture before the old one is destroyed", () => {
    const harness = makeHarness({ frameEncoder: null });
    const { device, stubs } = harness;
    const { oldWrapper, oldTexture, newTexture } = setUpAtlas(harness);
    assert.ok(oldTexture && newTexture, "both textures are allocated");

    copyEveryImage(stubs);
    stubs.deleteTexture(oldWrapper);

    const destroyAt = device.events.findIndex(
      (event) => event.kind === "destroy" && event.texture === oldTexture,
    );
    assert.ok(destroyAt >= 0, "the old texture's destruction was requested");
    assert.ok(oldTexture.destroyed);

    // Each requested copy reached the queue exactly once, from the old texture
    // to the new one with the requested origins and size, before the destroy.
    for (const image of IMAGES) {
      const submitIndexes = device.events
        .map((event, index) => ({ event, index }))
        .filter(
          ({ event }) =>
            event.kind === "submit" &&
            event.copies.some((copy) =>
              sameCopy(copy, oldTexture, newTexture, image),
            ),
        )
        .map(({ index }) => index);
      assert.equal(
        submitIndexes.length,
        1,
        `image ${image.id} is copied and submitted exactly once`,
      );
      assert.ok(
        submitIndexes[0] < destroyAt,
        `image ${image.id} reaches the queue before the old texture's destroy`,
      );
    }
    const submittedFromOld = device.events
      .filter((event) => event.kind === "submit")
      .flatMap((event) => event.copies)
      .filter((copy) => copy.source === oldTexture);
    assert.equal(submittedFromOld.length, IMAGES.length);

    // Nothing is read from the old texture once its destroy was requested.
    const afterDestroy = device.events
      .slice(destroyAt + 1)
      .filter((event) => event.kind === "submit")
      .flatMap((event) => event.copies)
      .filter((copy) => copy.source === oldTexture);
    assert.equal(afterDestroy.length, 0);
    assert.equal(
      device.violations.length,
      0,
      "no submit touched a dead texture",
    );

    // What the viewer would see: every earlier image at its new rectangle.
    assertImagesCarried(newTexture);
  });

  it("does the same when the framebuffer is torn down before the old texture", () => {
    // TextureAtlas deletes its framebuffer before it destroys the old texture;
    // the stub's deleteFramebuffer releases the attachment's GPU texture.
    const harness = makeHarness({ frameEncoder: null });
    const { device, stubs } = harness;
    const { oldWrapper, oldTexture, newTexture, framebuffer } =
      setUpAtlas(harness);

    copyEveryImage(stubs);
    stubs.bindFramebuffer(FRAMEBUFFER, null);
    stubs.deleteFramebuffer(framebuffer);
    stubs.deleteTexture(oldWrapper);

    assert.equal(
      device.violations.length,
      0,
      "no submit touched a dead texture",
    );
    assertImagesCarried(newTexture);
    const firstDestroy = device.events.findIndex(
      (event) => event.kind === "destroy" && event.texture === oldTexture,
    );
    const lastSubmit = device.events.findLastIndex(
      (event) => event.kind === "submit",
    );
    assert.ok(lastSubmit < firstDestroy);
  });

  it("copies from the bound framebuffer's attachment, never the canvas, outside a frame", () => {
    const harness = makeHarness({ frameEncoder: null });
    const { device, stubs } = harness;
    const { oldTexture, newTexture } = setUpAtlas(harness);

    copyEveryImage(stubs);

    const copies = device.events
      .filter((event) => event.kind === "submit")
      .flatMap((event) => event.copies);
    assert.equal(copies.length, IMAGES.length);
    for (const copy of copies) {
      assert.equal(copy.source, oldTexture);
      assert.notEqual(copy.source, harness.canvasTexture);
      assert.equal(copy.destination, newTexture);
    }
    assert.equal(
      harness.currentTextureRequests,
      0,
      "the canvas was not asked for",
    );
  });

  it("applies the same rules to copyTexImage2D, which lands at (0, 0)", () => {
    const harness = makeHarness({ frameEncoder: null });
    const { device, stubs } = harness;
    const { oldWrapper, oldTexture, newTexture } = setUpAtlas(harness);
    const image = IMAGES[1];

    stubs.copyTexImage2D(
      TEXTURE_2D,
      0,
      RGBA,
      image.from.x,
      image.from.y,
      image.w,
      image.h,
      0,
    );
    stubs.deleteTexture(oldWrapper);

    const destroyAt = device.events.findIndex(
      (event) => event.kind === "destroy" && event.texture === oldTexture,
    );
    const submitAt = device.events.findIndex(
      (event) =>
        event.kind === "submit" &&
        event.copies.some((copy) =>
          sameCopy(copy, oldTexture, newTexture, {
            ...image,
            to: { x: 0, y: 0 },
          }),
        ),
    );
    assert.ok(submitAt >= 0, "the copy was submitted to (0, 0)");
    assert.ok(submitAt < destroyAt, "and before the old texture's destroy");
    for (let row = 0; row < image.h; row++) {
      for (let column = 0; column < image.w; column++) {
        assert.deepEqual(
          pixelAt(newTexture, column, row),
          imagePixel(image, column, row),
        );
      }
    }
    assert.equal(device.violations.length, 0);
    assert.equal(harness.currentTextureRequests, 0);
  });

  it("copies nothing and submits nothing when only the default framebuffer is bound", () => {
    const harness = makeHarness({ frameEncoder: null });
    const { device, stubs } = harness;
    setUpAtlas(harness, { bindFramebuffer: false });
    stubs.bindFramebuffer(FRAMEBUFFER, null);
    assert.equal(harness.state.boundReadFramebuffer, null);

    copyEveryImage(stubs);
    stubs.copyTexImage2D(TEXTURE_2D, 0, RGBA, 0, 0, 2, 2, 0);

    const submits = device.events.filter((event) => event.kind === "submit");
    assert.equal(submits.length, 0, "nothing was submitted");
    assert.equal(
      device.encodersCreated.flatMap((encoder) => encoder.copies).length,
      0,
      "nothing was recorded",
    );
    assert.equal(
      harness.currentTextureRequests,
      0,
      "the canvas was not asked for",
    );
  });
});

describe("a TextureAtlas that grows inside the frame", () => {
  it("records the copies in the frame's encoder and submits nothing itself", () => {
    const harness = makeHarness({ frameEncoder: null });
    const frame = harness.device.createCommandEncoder({ label: "frame" });
    const { device, stubs } = harness;
    const { oldTexture, newTexture } = setUpAtlas(harness);
    harness.state.currentCommandEncoder = frame;
    device.encodersCreated.length = 0;

    copyEveryImage(stubs);

    assert.equal(frame.copies.length, IMAGES.length);
    IMAGES.forEach((image, index) => {
      assert.ok(
        sameCopy(frame.copies[index], oldTexture, newTexture, image),
        `image ${image.id} is recorded in the frame encoder from the framebuffer attachment`,
      );
    });
    assert.equal(
      device.encodersCreated.length,
      0,
      "no private encoder was created",
    );
    assert.equal(
      device.events.filter((event) => event.kind === "submit").length,
      0,
      "nothing was submitted by the stub",
    );
    assert.equal(
      harness.currentTextureRequests,
      0,
      "a bound framebuffer is never the canvas",
    );

    // The frame submits its encoder later; the earlier images are then present.
    device.queue.submit([frame.finish()]);
    assert.equal(device.violations.length, 0);
    assertImagesCarried(newTexture);
  });
});

describe("which framebuffer an off-frame copy reads", () => {
  it("reads the READ_FRAMEBUFFER binding when it differs from the draw binding", () => {
    const harness = makeHarness({ frameEncoder: null });
    const { device, stubs } = harness;
    const { oldTexture, newWrapper, newTexture, framebuffer } =
      setUpAtlas(harness);

    // A second framebuffer, bound for drawing, whose attachment holds other
    // texels everywhere an image is read from.
    const decoyWrapper = stubs.createTexture();
    stubs.bindTexture(TEXTURE_2D, decoyWrapper);
    stubs.texImage2D(
      TEXTURE_2D,
      0,
      RGBA,
      OLD_SIZE,
      OLD_SIZE,
      0,
      RGBA,
      UNSIGNED_BYTE,
      new Uint8Array(OLD_SIZE * OLD_SIZE * 4).fill(7),
    );
    const decoyFramebuffer = stubs.createFramebuffer();
    stubs.bindFramebuffer(FRAMEBUFFER, decoyFramebuffer);
    stubs.framebufferTexture2D(
      FRAMEBUFFER,
      COLOR_ATTACHMENT0,
      TEXTURE_2D,
      decoyWrapper,
      0,
    );
    stubs.bindFramebuffer(READ_FRAMEBUFFER, framebuffer);
    assert.equal(harness.state.boundFramebuffer, decoyFramebuffer);
    assert.equal(harness.state.boundReadFramebuffer, framebuffer);
    stubs.bindTexture(TEXTURE_2D, newWrapper);

    copyEveryImage(stubs);

    const copies = device.events
      .filter((event) => event.kind === "submit")
      .flatMap((event) => event.copies);
    assert.equal(copies.length, IMAGES.length);
    for (const copy of copies) {
      assert.equal(copy.source, oldTexture, "the read binding's attachment");
    }
    assertImagesCarried(newTexture);
  });
});

// -- the context's own wiring ---------------------------------------------------

/**
 * The stub as the context builds it: `buildWebGLCompatibilityStubFor` over a
 * host whose copy methods are the real `WebGPUContext.prototype` ones. The
 * host carries only what those methods read from `this` and the bound-state
 * slots the builder proxies.
 */
function makeWiredHarness({ frameEncoder = null, renderPass = null } = {}) {
  const device = makeDevice();
  let currentTextureRequests = 0;
  const canvasTexture = device.createTexture({
    size: { width: 4, height: 4 },
  });
  const host = {
    _isDeviceUnavailable: false,
    _currentCommandEncoder: frameEncoder,
    _currentRenderPassEncoder: renderPass,
    copyTextureRegion: WebGPUContext.prototype.copyTextureRegion,
    copyTexture: WebGPUContext.prototype.copyTexture,
    _device: device,
    resourceGeneration: 0,
    _context: {
      getCurrentTexture() {
        currentTextureRequests++;
        return canvasTexture;
      },
    },
    _activeTextureUnit: 0,
    _textureBindings: new Map(),
    _boundFramebuffer: null,
    _boundReadFramebuffer: null,
    _boundDrawFramebuffer: null,
    _framebuffers: new Map(),
    enqueueTextureMipGeneration() {
      return true;
    },
    encodeTextureMipGenerationInCurrentEncoder() {
      return true;
    },
    cancelTextureMipGeneration() {},
  };
  return {
    device,
    host,
    stubs: buildWebGLCompatibilityStubFor(host),
    get currentTextureRequests() {
      return currentTextureRequests;
    },
  };
}

function submitsCarrying(device, source, destination, image) {
  return device.events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event.kind === "submit" &&
        event.copies.some((copy) => sameCopy(copy, source, destination, image)),
    )
    .map(({ index }) => index);
}

describe("through the context's own wiring", () => {
  it("an off-frame growth carries every earlier image into the new texture before the old one is destroyed", () => {
    const harness = makeWiredHarness({ frameEncoder: null });
    const { device, stubs } = harness;
    const { oldWrapper, oldTexture, newTexture } = setUpAtlas(harness);

    copyEveryImage(stubs);
    stubs.deleteTexture(oldWrapper);

    const destroyAt = device.events.findIndex(
      (event) => event.kind === "destroy" && event.texture === oldTexture,
    );
    assert.ok(destroyAt >= 0, "the old texture's destruction was requested");
    for (const image of IMAGES) {
      const submits = submitsCarrying(device, oldTexture, newTexture, image);
      assert.equal(submits.length, 1, `image ${image.id} is submitted once`);
      assert.ok(
        submits[0] < destroyAt,
        `image ${image.id} reaches the queue before the old texture's destroy`,
      );
    }
    assert.equal(
      device.violations.length,
      0,
      "no submit touched a dead texture",
    );
    assert.equal(harness.currentTextureRequests, 0);
    assertImagesCarried(newTexture);
  });

  it("inside a frame, records the copies in the frame encoder and submits nothing itself", () => {
    const harness = makeWiredHarness({ frameEncoder: null });
    const { device, host, stubs } = harness;
    const { oldTexture, newTexture } = setUpAtlas(harness);
    const frame = device.createCommandEncoder({ label: "frame" });
    host._currentCommandEncoder = frame;

    copyEveryImage(stubs);

    assert.equal(frame.copies.length, IMAGES.length);
    IMAGES.forEach((image, index) => {
      assert.ok(sameCopy(frame.copies[index], oldTexture, newTexture, image));
    });
    assert.equal(
      device.events.filter((event) => event.kind === "submit").length,
      0,
    );
    device.queue.submit([frame.finish()]);
    assert.equal(device.violations.length, 0);
    assertImagesCarried(newTexture);
  });

  it("inside a frame with a render pass open, records nothing anywhere", () => {
    const harness = makeWiredHarness({ frameEncoder: null });
    const { device, host, stubs } = harness;
    setUpAtlas(harness);
    const frame = device.createCommandEncoder({ label: "frame" });
    host._currentCommandEncoder = frame;
    host._currentRenderPassEncoder = { label: "open pass" };

    copyEveryImage(stubs);

    assert.equal(frame.copies.length, 0, "the open pass refuses the frame");
    assert.equal(
      device.encodersCreated.flatMap((encoder) => encoder.copies).length,
      0,
      "and no other encoder took the copy",
    );
    assert.equal(
      device.events.filter((event) => event.kind === "submit").length,
      0,
    );
  });

  it("WebGPUContext.copyTextureRegion records in a caller's encoder, and an open pass refuses only the frame encoder", () => {
    const device = makeDevice();
    const usage = GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    const source = device.createTexture({
      size: { width: 8, height: 8 },
      format: "rgba8unorm",
      usage,
    });
    const destination = device.createTexture({
      size: { width: 16, height: 16 },
      format: "rgba8unorm",
      usage,
    });
    const frame = device.createCommandEncoder({ label: "frame" });
    const caller = device.createCommandEncoder({ label: "caller" });
    const context = (currentEncoder, openPass) => ({
      _isDeviceUnavailable: false,
      _currentCommandEncoder: currentEncoder,
      _currentRenderPassEncoder: openPass,
      copyTexture: WebGPUContext.prototype.copyTexture,
    });
    const copyRegion = (self, encoder) =>
      WebGPUContext.prototype.copyTextureRegion.call(
        self,
        source,
        destination,
        1,
        2,
        8,
        3,
        2,
        2,
        encoder,
      );

    // No frame encoder: the caller's encoder records the copy.
    assert.equal(copyRegion(context(null, null), caller), true);
    assert.equal(caller.copies.length, 1);
    const [first] = caller.copies;
    assert.equal(first.source, source);
    assert.equal(first.destination, destination);
    assert.deepEqual(first.sourceOrigin, { x: 1, y: 2 });
    assert.deepEqual(first.destinationOrigin, { x: 8, y: 3 });
    assert.deepEqual(first.size, { width: 2, height: 2 });

    // A frame encoder with a render pass open: refused, nothing recorded.
    const openPass = context(frame, { label: "open pass" });
    assert.equal(copyRegion(openPass, undefined), false);
    assert.equal(frame.copies.length, 0);

    // The open pass is on the frame encoder, not on the caller's.
    assert.equal(copyRegion(openPass, caller), true);
    assert.equal(caller.copies.length, 2);
    assert.equal(frame.copies.length, 0);

    // No caller encoder and no open pass: the frame encoder records it.
    assert.equal(copyRegion(context(frame, null), undefined), true);
    assert.equal(frame.copies.length, 1);
    assert.equal(caller.copies.length, 2);
  });
});

// -- the video scenario ---------------------------------------------------------

function makeVideo({ width, height, videoWidth, videoHeight }) {
  return Object.assign(new FakeHTMLVideoElement(), {
    width,
    height,
    videoWidth,
    videoHeight,
  });
}

function externalUploads(device) {
  return device.events.filter((event) => event.kind === "external");
}

function lastTextureSize(device) {
  const { size } = device.textures[device.textures.length - 1].descriptor;
  return { width: size.width, height: size.height };
}

const VIDEO_CASES = [
  {
    name: "a video with no width or height attribute",
    video: { width: 0, height: 0, videoWidth: 640, videoHeight: 360 },
  },
  {
    name: "a video whose width attribute is smaller than its frame",
    video: { width: 320, height: 180, videoWidth: 640, videoHeight: 360 },
  },
];

describe("a video element uploads at its frame size", () => {
  for (const { name, video } of VIDEO_CASES) {
    it(`texImage2D (6 arguments) allocates and copies ${name} at 640 x 360`, () => {
      const harness = makeHarness();
      const { device, stubs } = harness;
      stubs.bindTexture(TEXTURE_2D, stubs.createTexture());

      stubs.texImage2D(
        TEXTURE_2D,
        0,
        RGBA,
        RGBA,
        UNSIGNED_BYTE,
        makeVideo(video),
      );

      assert.deepEqual(lastTextureSize(device), { width: 640, height: 360 });
      const uploads = externalUploads(device);
      assert.equal(uploads.length, 1);
      assert.deepEqual(uploads[0].size, { width: 640, height: 360 });
    });

    it(`texSubImage2D (7 arguments) copies ${name} at 640 x 360`, () => {
      const harness = makeHarness();
      const { device, stubs } = harness;
      stubs.bindTexture(TEXTURE_2D, stubs.createTexture());
      stubs.texImage2D(
        TEXTURE_2D,
        0,
        RGBA,
        1280,
        720,
        0,
        RGBA,
        UNSIGNED_BYTE,
        null,
      );

      stubs.texSubImage2D(
        TEXTURE_2D,
        0,
        0,
        0,
        RGBA,
        UNSIGNED_BYTE,
        makeVideo(video),
      );

      const uploads = externalUploads(device);
      assert.equal(uploads.length, 1);
      assert.deepEqual(uploads[0].size, { width: 640, height: 360 });
    });

    it(`uploadImageToTexture sizes ${name} at 640 x 360`, async () => {
      const device = makeDevice();
      const destination = device.createTexture({
        size: { width: 1280, height: 720 },
      });

      const size = await WebGPUImageUpload.uploadImageToTexture(
        device,
        makeVideo(video),
        destination,
        { respectEXIF: false },
      );

      assert.deepEqual(size, { width: 640, height: 360 });
      const uploads = externalUploads(device);
      assert.equal(uploads.length, 1);
      assert.deepEqual(uploads[0].size, { width: 640, height: 360 });
    });
  }
});

// Sources with no `videoWidth` upload at exactly their `width x height`. This is
// a no-regression pin, not a parity claim: WebGL sizes an image from
// `naturalWidth` / `naturalHeight`.
const PLAIN_SOURCES = [
  {
    name: "an HTMLImageElement whose naturalWidth differs from its width",
    make: () =>
      Object.assign(new FakeHTMLImageElement(), {
        width: 100,
        height: 50,
        naturalWidth: 200,
        naturalHeight: 100,
      }),
    size: { width: 100, height: 50 },
  },
  {
    name: "an ImageBitmap",
    make: () => Object.assign(new FakeImageBitmap(), { width: 64, height: 32 }),
    size: { width: 64, height: 32 },
  },
  {
    name: "a canvas",
    make: () =>
      Object.assign(new FakeHTMLCanvasElement(), { width: 48, height: 24 }),
    size: { width: 48, height: 24 },
  },
];

describe("every source without videoWidth uploads at exactly its width and height", () => {
  for (const { name, make, size } of PLAIN_SOURCES) {
    it(`texImage2D (6 arguments) uploads ${name} at ${size.width} x ${size.height}`, () => {
      const harness = makeHarness();
      const { device, stubs } = harness;
      stubs.bindTexture(TEXTURE_2D, stubs.createTexture());

      stubs.texImage2D(TEXTURE_2D, 0, RGBA, RGBA, UNSIGNED_BYTE, make());

      assert.deepEqual(lastTextureSize(device), size);
      const uploads = externalUploads(device);
      assert.equal(uploads.length, 1);
      assert.deepEqual(uploads[0].size, size);
    });

    it(`texSubImage2D (7 arguments) uploads ${name} at ${size.width} x ${size.height}`, () => {
      const harness = makeHarness();
      const { device, stubs } = harness;
      stubs.bindTexture(TEXTURE_2D, stubs.createTexture());
      stubs.texImage2D(
        TEXTURE_2D,
        0,
        RGBA,
        512,
        512,
        0,
        RGBA,
        UNSIGNED_BYTE,
        null,
      );

      stubs.texSubImage2D(TEXTURE_2D, 0, 0, 0, RGBA, UNSIGNED_BYTE, make());

      const uploads = externalUploads(device);
      assert.equal(uploads.length, 1);
      assert.deepEqual(uploads[0].size, size);
    });

    it(`uploadImageToTexture uploads ${name} at ${size.width} x ${size.height}`, async () => {
      const device = makeDevice();
      const destination = device.createTexture({
        size: { width: 512, height: 512 },
      });

      const result = await WebGPUImageUpload.uploadImageToTexture(
        device,
        make(),
        destination,
        { respectEXIF: false },
      );

      assert.deepEqual(result, size);
      const uploads = externalUploads(device);
      assert.equal(uploads.length, 1);
      assert.deepEqual(uploads[0].size, size);
    });
  }
});

// -- round 3: the attachment Framebuffer.js names through the stub ------------
//
// The cases above attach the old atlas texture with the literal WebGL enum.
// The engine does not: `Framebuffer.js` attaches at `gl.COLOR_ATTACHMENT0 + i`,
// read from whatever object the context hands it as `_gl`. On WebGPU that is
// the compatibility stub `buildWebGLCompatibilityStubFor` builds, and an Edge
// run of the instrumented probe showed every off-frame copy of a real label
// atlas growth leaving with no source to read. These cases drive the REAL
// `Framebuffer.js` on that stub, so they see the attachment the engine
// actually records, and they read the stub's debug receipt
// (`WebGLStubTextureTrace.ts`) the way the probe does.

function armReceipt() {
  const receipt = { counts: {}, samples: {} };
  globalThis[STUB_TEXTURE_TRACE_GLOBAL] = receipt;
  return receipt;
}

function disarmReceipt() {
  delete globalThis[STUB_TEXTURE_TRACE_GLOBAL];
}

/**
 * Grow an atlas the way `TextureAtlas._copyFromTexture` does: wrap the old
 * texture in a real `Framebuffer`, bind the new texture to unit 0, bind the
 * framebuffer, copy every earlier image, unbind, destroy the framebuffer, then
 * destroy the old texture.
 */
function growThroughFramebufferJs(harness) {
  const { stubs } = harness;
  const textures = setUpAtlas(harness, { bindFramebuffer: false });
  const framebuffer = new Framebuffer({
    context: { _gl: stubs, limits: { maximumColorAttachments: 4 } },
    colorTextures: [
      {
        _texture: textures.oldWrapper,
        _target: TEXTURE_2D,
        pixelFormat: RGBA,
        pixelDatatype: UNSIGNED_BYTE,
      },
    ],
    destroyAttachments: false,
  });
  const recordedAttachment = framebuffer._framebuffer._colorAttachment;
  stubs.activeTexture(stubs.TEXTURE0);
  stubs.bindTexture(TEXTURE_2D, textures.newWrapper);
  framebuffer._bind();
  copyEveryImage(stubs);
  stubs.bindTexture(TEXTURE_2D, null);
  framebuffer._unBind();
  framebuffer.destroy();
  stubs.deleteTexture(textures.oldWrapper);
  return { ...textures, recordedAttachment };
}

function submittedCopies(device) {
  return device.events
    .filter((event) => event.kind === "submit")
    .flatMap((event) => event.copies);
}

describe("an atlas growth attached through the real Framebuffer.js on the context's stub", () => {
  it("records no color attachment, because the stub names no COLOR_ATTACHMENT0 (the state that hides the earlier images; owned outside this lane, so this case flips when the stub names it)", () => {
    const harness = makeWiredHarness({ frameEncoder: null });
    const { recordedAttachment } = growThroughFramebufferJs(harness);
    assert.equal(
      recordedAttachment,
      null,
      "Framebuffer.js attached at an enum the stub's framebufferTexture2D does not recognise",
    );
  });

  it("so an off-frame growth copies none of the earlier images, and the receipt names the missing source", () => {
    const receipt = armReceipt();
    try {
      const harness = makeWiredHarness({ frameEncoder: null });
      const { device } = harness;
      const { newTexture } = growThroughFramebufferJs(harness);

      assert.equal(submittedCopies(device).length, 0, "no copy was submitted");
      for (const image of IMAGES) {
        assert.deepEqual(
          pixelAt(newTexture, image.to.x, image.to.y),
          [0, 0, 0, 0],
          `image ${image.id} is missing from its new rectangle`,
        );
      }
      assert.equal(receipt.counts["copyTexSubImage2D.enter"], IMAGES.length);
      assert.equal(receipt.counts["copyTexSubImage2D.noSource"], IMAGES.length);
      assert.equal(
        receipt.counts["copyTexSubImage2D.offFrame.submitted"],
        undefined,
      );
      assert.deepEqual(receipt.samples["copyTexSubImage2D.noSource"][0], {
        inFrame: false,
        hasReadFramebuffer: true,
      });
    } finally {
      disarmReceipt();
    }
  });

  it("given the enum the stub's framebufferTexture2D recognises, the same growth carries every earlier image before the old texture is destroyed", () => {
    const receipt = armReceipt();
    try {
      const harness = makeWiredHarness({ frameEncoder: null });
      const { device, stubs } = harness;
      // The counterfactual the Edge run applied to the live stub object.
      stubs.COLOR_ATTACHMENT0 = COLOR_ATTACHMENT0;
      const { oldTexture, newTexture, recordedAttachment } =
        growThroughFramebufferJs(harness);

      assert.notEqual(recordedAttachment, null);
      const destroyAt = device.events.findIndex(
        (event) => event.kind === "destroy" && event.texture === oldTexture,
      );
      assert.ok(destroyAt >= 0, "the old texture's destruction was requested");
      for (const image of IMAGES) {
        const submits = submitsCarrying(device, oldTexture, newTexture, image);
        assert.equal(submits.length, 1, `image ${image.id} is submitted once`);
        assert.ok(submits[0] < destroyAt);
      }
      assert.equal(device.violations.length, 0);
      assertImagesCarried(newTexture);
      assert.equal(
        receipt.counts["copyTexSubImage2D.offFrame.submitted"],
        IMAGES.length,
      );
      assert.equal(receipt.counts["copyTexSubImage2D.noSource"], undefined);
    } finally {
      disarmReceipt();
    }
  });
});

describe("the stub's debug receipt", () => {
  it("records nothing and creates no global while no page has armed it", () => {
    disarmReceipt();
    const harness = makeWiredHarness({ frameEncoder: null });
    harness.stubs.COLOR_ATTACHMENT0 = COLOR_ATTACHMENT0;
    growThroughFramebufferJs(harness);
    assert.equal(STUB_TEXTURE_TRACE_GLOBAL in globalThis, false);
  });

  it("records a video upload at its frame size beside the element's attribute size", () => {
    const receipt = armReceipt();
    try {
      const harness = makeHarness();
      const { stubs } = harness;
      stubs.bindTexture(TEXTURE_2D, stubs.createTexture());
      stubs.texImage2D(
        TEXTURE_2D,
        0,
        RGBA,
        RGBA,
        UNSIGNED_BYTE,
        makeVideo(VIDEO_CASES[0].video),
      );
      assert.equal(receipt.counts["texImage2D.video"], 1);
      assert.deepEqual(receipt.samples["texImage2D.video"][0], {
        width: 640,
        height: 360,
        elementWidth: 0,
        elementHeight: 0,
      });
      assert.equal(receipt.counts["texImage2D.external"], 1);
      assert.equal(receipt.counts["texImage2D.zeroSize"], undefined);
    } finally {
      disarmReceipt();
    }
  });
});
