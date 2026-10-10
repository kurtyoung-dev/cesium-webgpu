// stub-framebuffer-rig.mjs - the rig the WebGL-stub framebuffer specs share: the
// stub as the context builds it over a recording fake device that also models
// the readback a `readPixelsAsync` uses, WebGL's own enum values, texture and
// renderbuffer owners shaped like the engine's, and the helpers that read the
// device's recorded commands and events.
//
// @purpose The shared rig for the WebGL-stub framebuffer specs: bundles Renderbuffer.js, Texture.js, MultisampleFramebuffer.js and the shader stubs beside the wired harness, and exports the rig, the texel model and the assertions both specs use.
// @status ACTIVE
//
// ONE OWNER. Specs import from here and do not copy it; a change a second spec
// needs is a new export. It builds on `./stub-wired-harness.mjs`, which is
// imported first so the DOM-class fakes and `GPUTextureUsage` exist before any
// engine module loads.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import {
  Framebuffer,
  RGBA,
  TEXTURE_2D,
  UNSIGNED_BYTE,
  armReceipt,
  makeWiredHarness,
  pixelAt,
} from "./stub-wired-harness.mjs";
import { stubTextureTraceInit } from "./stub-texture-trace.mjs";

// The classes the harness does not export, bundled once from the real files.
const engineSource = fileURLToPath(
  new URL("../../../packages/engine/Source/", import.meta.url),
).replaceAll("\\", "/");
const classesBundle = await build({
  stdin: {
    contents: [
      `export { default as Renderbuffer } from "${engineSource}Renderer/Renderbuffer.js";`,
      `export { default as Texture } from "${engineSource}Renderer/Texture.js";`,
      `export { default as RenderbufferFormat } from "${engineSource}Renderer/RenderbufferFormat.js";`,
      `export { default as MultisampleFramebuffer } from "${engineSource}Renderer/MultisampleFramebuffer.js";`,
      `export { default as PixelFormat } from "${engineSource}Core/PixelFormat.js";`,
      `export { createShaderStubs } from "${engineSource}Renderer/WebGPU/Stubs/WebGLStubShader.ts";`,
    ].join("\n"),
    resolveDir: engineSource,
    loader: "js",
  },
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
  logLevel: "silent",
});
export const {
  Renderbuffer,
  Texture,
  RenderbufferFormat,
  MultisampleFramebuffer,
  PixelFormat,
  createShaderStubs,
} = await import(
  `data:text/javascript;base64,${Buffer.from(classesBundle.outputFiles[0].text).toString("base64")}`
);

// WebGL's own values (the WebGL 2 specification), independent of the stub.
export const GL = Object.freeze({
  FRAMEBUFFER: 0x8d40,
  READ_FRAMEBUFFER: 0x8ca8,
  DRAW_FRAMEBUFFER: 0x8ca9,
  RENDERBUFFER: 0x8d41,
  COLOR_ATTACHMENT0: 0x8ce0,
  DEPTH_ATTACHMENT: 0x8d00,
  STENCIL_ATTACHMENT: 0x8d20,
  DEPTH_STENCIL_ATTACHMENT: 0x821a,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  NEAREST: 0x2600,
  COLOR_BUFFER_BIT: 0x4000,
  DEPTH_BUFFER_BIT: 0x0100,
  STENCIL_BUFFER_BIT: 0x0400,
});
export const CUBE_MAP_FACES = [0x8515, 0x8516, 0x8517, 0x8518, 0x8519, 0x851a];
export const TEXTURE_CUBE_MAP_POSITIVE_X = 0x8515;
export const TEXTURE_CUBE_MAP_NEGATIVE_Y = 0x8518;
export const SIZE = 8;
export const COPY_USAGE = 0x01 | 0x02; // COPY_SRC | COPY_DST
export const RENDER_ATTACHMENT_USAGE = 0x10;
export const ZEROS = new Array(SIZE * SIZE * 4).fill(0);

globalThis.GPUBufferUsage ??= Object.freeze({ MAP_READ: 0x01, COPY_DST: 0x08 });
globalThis.GPUMapMode ??= Object.freeze({ READ: 0x01 });

// -- the rig -------------------------------------------------------------------

/** A texel no other (seed, x, y) shares, so a copy from the wrong place shows. */
export function texel(seed, x, y) {
  return [
    (seed * 40 + x * 5 + y) & 255,
    (x * 16 + seed) & 255,
    (y * 20 + seed) & 255,
    255,
  ];
}

export function fillTexels(native, seed) {
  for (let y = 0; y < native.height; y++) {
    for (let x = 0; x < native.width; x++) {
      native.data.set(texel(seed, x, y), (y * native.width + x) * 4);
    }
  }
}

/** Give the fake device the buffers and texture-to-buffer copies a `readPixelsAsync` uses. */
export function addReadback(device) {
  device.buffers = [];
  const createCommandEncoder = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = (descriptor) => {
    const encoder = createCommandEncoder(descriptor);
    encoder.bufferCopies = [];
    encoder.copyTextureToBuffer = (source, destination, size) =>
      encoder.bufferCopies.push({ source, destination, size });
    return encoder;
  };
  const submit = device.queue.submit.bind(device.queue);
  device.queue.submit = (commandBuffers) => {
    for (const commandBuffer of commandBuffers) {
      for (const { source, destination, size } of commandBuffer.encoder
        .bufferCopies ?? []) {
        if (source.texture.destroyed) {
          device.violations.push({ readback: true });
          continue;
        }
        for (let row = 0; row < size.height; row++) {
          const from =
            ((source.origin.y + row) * source.texture.width + source.origin.x) *
            4;
          destination.buffer.data.set(
            source.texture.data.subarray(from, from + size.width * 4),
            row * destination.bytesPerRow,
          );
        }
      }
    }
    submit(commandBuffers);
  };
  device.createBuffer = ({ size, usage }) => {
    const buffer = {
      size,
      usage,
      data: new Uint8Array(size),
      destroyed: false,
      async mapAsync() {},
      getMappedRange() {
        return buffer.data.buffer;
      },
      unmap() {},
      destroy() {
        buffer.destroyed = true;
      },
    };
    device.buffers.push(buffer);
    return buffer;
  };
}

/** The stub as the context builds it, with the context object `Framebuffer.js` reads. */
export function rig() {
  const harness = makeWiredHarness();
  addReadback(harness.device);
  const context = {
    _gl: harness.stubs,
    limits: {
      maximumColorAttachments: 4,
      maximumRenderbufferSize: 4096,
      maximumTextureSize: 4096,
    },
    webgl2: true,
    _currentFramebuffer: 1,
  };
  return {
    ...harness,
    context,
    receipt: armReceipt(),
    // The harness reports a count that grows; a spread would freeze it.
    get currentTextureRequests() {
      return harness.currentTextureRequests;
    },
  };
}

// The WebGPU prototype methods the probe's trace wraps, by class.
const TRACED_GPU_METHODS = Object.freeze({
  GPUDevice: ["createTexture"],
  GPUQueue: ["submit", "writeTexture", "copyExternalImageToTexture"],
  GPUCommandEncoder: ["copyTextureToTexture", "finish"],
  GPUTexture: ["destroy"],
});
const TRACE_GLOBALS = [
  ...Object.keys(TRACED_GPU_METHODS),
  "__gpuCallTrace",
  "__stubTraceSequence",
  "__cesiumStubTextureTrace",
];

/**
 * The rig with the probe's own trace (`stubTextureTraceInit`) armed over it,
 * as a page has it: the fake device, its queue, the encoders and the textures
 * it makes from now on are instances of classes installed as `GPUDevice`,
 * `GPUQueue`, `GPUCommandEncoder` and `GPUTexture`, whose prototype
 * methods the init script wraps. Call `release()` when done: it removes the
 * classes and the trace globals.
 */
export function tracedRig() {
  const saved = new Map(
    TRACE_GLOBALS.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const impls = new WeakMap();
  const classes = {};
  for (const [name, methods] of Object.entries(TRACED_GPU_METHODS)) {
    const Class = { [name]: class {} }[name];
    for (const method of methods) {
      Class.prototype[method] = function (...args) {
        return impls.get(this)[method].apply(this, args);
      };
    }
    classes[name] = Class;
    globalThis[name] = Class;
  }
  // Move an object's own methods behind its class's prototype, so a wrapper
  // installed on the prototype sees every call.
  const adopt = (object, name, results = {}) => {
    const own = {};
    for (const method of TRACED_GPU_METHODS[name]) {
      const original = object[method];
      if (typeof original !== "function") {
        continue;
      }
      const after = results[method];
      own[method] = after
        ? function (...args) {
            return after(original.apply(this, args));
          }
        : original;
      delete object[method];
    }
    impls.set(object, own);
    Object.setPrototypeOf(object, classes[name].prototype);
    return object;
  };
  // After rig(): its armReceipt() would replace the init script's
  // sequenced engine receipt.
  const r = rig();
  delete globalThis.__gpuCallTrace;
  delete globalThis.__stubTraceSequence;
  stubTextureTraceInit();
  const { device } = r;
  const createCommandEncoder = device.createCommandEncoder;
  device.createCommandEncoder = (descriptor) =>
    adopt(createCommandEncoder(descriptor), "GPUCommandEncoder");
  adopt(device.queue, "GPUQueue");
  adopt(device, "GPUDevice", {
    createTexture: (texture) => adopt(texture, "GPUTexture"),
  });
  return {
    ...r,
    // The init script replaced the rig's receipt with the sequenced one.
    receipt: globalThis.__cesiumStubTextureTrace,
    get gpu() {
      return JSON.parse(JSON.stringify(globalThis.__gpuCallTrace));
    },
    get engine() {
      return JSON.parse(JSON.stringify(globalThis.__cesiumStubTextureTrace));
    },
    get currentTextureRequests() {
      return r.currentTextureRequests;
    },
    release() {
      for (const [name, descriptor] of saved) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          delete globalThis[name];
        }
      }
    },
  };
}

/** A `Texture`-shaped owner over a stub texture whose native is allocated and filled with `seed`'s texels. */
export function ownedTexture(r, seed, { size = SIZE } = {}) {
  const { stubs } = r;
  const wrapper = stubs.createTexture();
  stubs.bindTexture(TEXTURE_2D, wrapper);
  stubs.texImage2D(
    TEXTURE_2D,
    0,
    RGBA,
    size,
    size,
    0,
    RGBA,
    UNSIGNED_BYTE,
    null,
  );
  stubs.bindTexture(TEXTURE_2D, null);
  const native = wrapper._texture;
  if (seed !== null) {
    fillTexels(native, seed);
  }
  const owner = {
    _texture: wrapper,
    _target: TEXTURE_2D,
    pixelFormat: RGBA,
    pixelDatatype: UNSIGNED_BYTE,
    destroyCalls: 0,
    destroy() {
      owner.destroyCalls++;
      stubs.deleteTexture(wrapper);
    },
  };
  return { owner, wrapper, native };
}

/** A real `Texture.js` on the stub, its native filled with `seed`'s texels; it is destroyed only by its own `destroy()`. */
export function engineTexture(r, seed, { size = SIZE } = {}) {
  const owner = new Texture({ context: r.context, width: size, height: size });
  const wrapper = owner._texture;
  const native = wrapper._texture;
  if (seed !== null) {
    fillTexels(native, seed);
  }
  return { owner, wrapper, native };
}

export function renderbuffer(r, format, { samples = 1 } = {}) {
  const buffer = new Renderbuffer({
    context: r.context,
    format,
    width: SIZE,
    height: SIZE,
    numSamples: samples,
  });
  return { buffer, native: buffer._getRenderbuffer()._texture };
}

export function framebuffer(r, options) {
  return new Framebuffer({ context: r.context, ...options });
}

/** A bare stub framebuffer with a raw wrapper attached, for what the classes cannot express. */
export function attachRaw(
  r,
  wrapper,
  { textarget = TEXTURE_2D, level = 0 } = {},
) {
  const { stubs } = r;
  const fbo = stubs.createFramebuffer();
  stubs.bindFramebuffer(stubs.FRAMEBUFFER, fbo);
  stubs.framebufferTexture2D(
    stubs.FRAMEBUFFER,
    stubs.COLOR_ATTACHMENT0,
    textarget,
    wrapper,
    level,
  );
  stubs.bindFramebuffer(stubs.FRAMEBUFFER, null);
  return fbo;
}

/** An attachment over a native the stub did not make: any format, usage and sample count. */
export function rawAttachment(
  r,
  { format = "rgba8unorm", usage = COPY_USAGE, sampleCount = 1, seed = 7 } = {},
) {
  const native = r.device.createTexture({
    size: { width: SIZE, height: SIZE },
    format,
    usage,
    sampleCount,
  });
  fillTexels(native, seed);
  return { wrapper: { _webgpuTexture: { texture: native } }, native };
}

/** The destination: a bound, empty RGBA8 texture. Create every other texture before it. */
export function destination(r) {
  const d = ownedTexture(r, null);
  r.stubs.bindTexture(TEXTURE_2D, d.wrapper);
  return d;
}

export function startFrame(r) {
  const encoder = r.device.createCommandEncoder({ label: "frame" });
  r.host._currentCommandEncoder = encoder;
  return encoder;
}

export const commandCount = (device) =>
  device.encodersCreated.reduce((n, e) => n + e.copies.length, 0);
export const submitCount = (device) =>
  device.events.filter((e) => e.kind === "submit").length;
export const destroysOf = (device, native) =>
  device.events.filter((e) => e.kind === "destroy" && e.texture === native)
    .length;
export const snapshot = (texture) => Array.from(texture.data);
export const liveTextures = (r) =>
  r.stubs.getCompatibilityTextureDiagnostics().liveTextureCount;

export function assertRegion(native, from, dx, dy, w, h, seed) {
  for (let row = 0; row < h; row++) {
    for (let column = 0; column < w; column++) {
      assert.deepEqual(
        pixelAt(native, dx + column, dy + row),
        texel(seed, from.x + column, from.y + row),
        `texel (${dx + column}, ${dy + row})`,
      );
    }
  }
}
