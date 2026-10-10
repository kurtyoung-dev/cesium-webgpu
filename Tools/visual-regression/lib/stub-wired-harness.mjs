// stub-wired-harness.mjs - the WebGL compatibility stub and the real engine
// modules it serves, run in Node over one recording fake GPUDevice, for specs
// that must see what the stub records rather than what a fake of it records.
//
// @purpose The shared harness for WebGL-stub texture and framebuffer specs: installs the DOM-class fakes and GPUTextureUsage before any engine module loads, bundles the real stub modules, Framebuffer.js and the context's stub builder with esbuild, and exports a recording fake device with a texel model, a hand-built stub state, the stub as the context builds it, and the label-atlas growth steps those specs drive.
// @status ACTIVE
//
// WHAT IT EXPORTS.
//   * `makeDevice` - a fake GPUDevice whose queue keeps a texel model:
//     `writeTexture` writes at once, `copyTextureToTexture` runs only when its
//     encoder is submitted, and a submit that touches a texture whose
//     `destroy()` was requested is a violation rather than a copy.
//   * `makeHarness` - the stub's texture and framebuffer methods over a state
//     object whose `copyTextureRegion` follows the context's contract.
//   * `makeWiredHarness` - the stub as the context builds it,
//     `buildWebGLCompatibilityStubFor` over a host whose copy methods are the
//     real `WebGPUContext.prototype` ones.
//   * `setUpAtlas`, `copyEveryImage` and `growThroughFramebufferJs` - an
//     atlas growth by hand and through the real `Framebuffer.js`.
//   * `armReceipt` / `disarmReceipt` - the engine's debug receipt.
//
// ONE OWNER. Specs import from here and do not copy it; a change a second spec
// needs is a new export, so every importer stays valid.
//
// Importing this module installs `HTMLVideoElement`, `HTMLImageElement`,
// `HTMLCanvasElement`, `ImageBitmap` and `GPUTextureUsage` on
// `globalThis`, because the engine modules read them when they load.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

import { withLaneTmp } from "../../lib/lane-tmp.mjs";

const engineDir = fileURLToPath(
  new URL("../../../packages/engine/Source/Renderer/WebGPU/", import.meta.url),
).replaceAll("\\", "/");

// The stub decides "external image" with instanceof, so the fakes are real
// classes of these names. Installed before the engine modules load.
export class FakeHTMLVideoElement {}
export class FakeHTMLImageElement {}
export class FakeHTMLCanvasElement {}
export class FakeImageBitmap {}
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
export const {
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
export const { buildWebGLCompatibilityStubFor, WebGPUContext } =
  await withLaneTmp("stub-texture-wiring-", async (directory) => {
    const file = path.join(directory, "wiring.mjs");
    writeFileSync(file, wiringBundle.outputFiles[0].text);
    return await import(pathToFileURL(file).href);
  });

export const TEXTURE_2D = 0x0de1;
export const FRAMEBUFFER = 0x8d40;
export const READ_FRAMEBUFFER = 0x8ca8;
export const COLOR_ATTACHMENT0 = 0x8ce0;
export const RGBA = 0x1908;
export const UNSIGNED_BYTE = 0x1401;

// -- the recording fake device -------------------------------------------------

export function makeDevice() {
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

export function makeHarness({ frameEncoder = null, withContext = true } = {}) {
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

export const OLD_SIZE = 8;
export const NEW_SIZE = 16;
// Three earlier images: where each sits in the old texture, where the grown
// atlas packs it, and its size. Every pixel of every image has a value no other
// pixel has, so a copy from the wrong place or to the wrong place shows.
export const IMAGES = [
  { id: 1, from: { x: 0, y: 0 }, to: { x: 8, y: 0 }, w: 2, h: 2 },
  { id: 2, from: { x: 4, y: 1 }, to: { x: 0, y: 9 }, w: 2, h: 3 },
  { id: 3, from: { x: 1, y: 5 }, to: { x: 10, y: 10 }, w: 3, h: 2 },
];

export function imagePixel(image, column, row) {
  return [image.id * 40 + column * 5 + row, 10 * column + image.id, row, 255];
}

export function imageBytes(image) {
  const bytes = new Uint8Array(image.w * image.h * 4);
  for (let row = 0; row < image.h; row++) {
    for (let column = 0; column < image.w; column++) {
      bytes.set(imagePixel(image, column, row), (row * image.w + column) * 4);
    }
  }
  return bytes;
}

export function pixelAt(texture, x, y) {
  const at = (y * texture.width + x) * 4;
  return Array.from(texture.data.subarray(at, at + 4));
}

/** Allocate OLD with the images uploaded, NEW larger and empty, and bind. */
export function setUpAtlas(harness, { bindFramebuffer = true } = {}) {
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

export function copyEveryImage(stubs) {
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

// -- the context's own wiring ---------------------------------------------------

/**
 * The stub as the context builds it: `buildWebGLCompatibilityStubFor` over a
 * host whose copy methods are the real `WebGPUContext.prototype` ones. The
 * host carries only what those methods read from `this` and the bound-state
 * slots the builder proxies.
 */
export function makeWiredHarness({
  frameEncoder = null,
  renderPass = null,
} = {}) {
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

// -- the engine's debug receipt and a growth through the real Framebuffer.js --

export function armReceipt() {
  const receipt = { counts: {}, samples: {} };
  globalThis[STUB_TEXTURE_TRACE_GLOBAL] = receipt;
  return receipt;
}

export function disarmReceipt() {
  delete globalThis[STUB_TEXTURE_TRACE_GLOBAL];
}

/**
 * Grow an atlas the way `TextureAtlas._copyFromTexture` does: wrap the old
 * texture in a real `Framebuffer`, bind the new texture to unit 0, bind the
 * framebuffer, copy every earlier image, unbind, destroy the framebuffer, then
 * destroy the old texture.
 */
export function growThroughFramebufferJs(harness) {
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
