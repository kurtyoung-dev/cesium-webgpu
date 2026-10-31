// ocean-fft-device-harness.mjs — drives the real WebGPUOceanRenderer.ts in Node
// against a recording fake GPUDevice, so a spec can read every compute
// dispatch, bind group and texture/buffer write the renderer makes.
//
// @purpose Bundles the real WebGPUOceanRenderer.ts for Node and runs it over a recording fake GPUDevice that logs compute dispatches (pipeline, WGSL, bind-group entries, workgroups), live resources and queue writes.
// @status ACTIVE
//
// The renderer and its companions load for real; the only substitution is the
// shader modules. Every `Shaders/WebGPU/<Dir>/<Name>.js` import resolves to a
// module whose default export is the text of the sibling `<Name>.wgsl`, in an
// unbuilt tree and in a built one alike. The generated `<Name>.js` is never
// read: the build writes it from that same `.wgsl` (verbatim, or with comments
// stripped when minifying), it can be stale, and a `transform` applied to the
// `.wgsl` must reach the module the renderer compiles. Loading the generated
// file when it existed made every WGSL mutant inert on a built tree.
// `transform(absPathPosix, text)` runs on every loaded engine file (and on
// that WGSL text), so a spec can mutate one file in memory. Each
// `loadOceanRenderer` call builds a fresh module graph.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SOURCE = resolve(HERE, "../../../packages/engine/Source");

const toPosix = (path) => path.split("\\").join("/");

const RENDERER_PATH = `${toPosix(ENGINE_SOURCE)}/Renderer/WebGPU/WebGPUOceanRenderer.ts`;

let loadCounter = 0;

// The renderer reads these usage-flag globals at call time.
function installGpuGlobals() {
  globalThis.GPUBufferUsage ??= {
    MAP_READ: 0x1,
    MAP_WRITE: 0x2,
    COPY_SRC: 0x4,
    COPY_DST: 0x8,
    INDEX: 0x10,
    VERTEX: 0x20,
    UNIFORM: 0x40,
    STORAGE: 0x80,
    INDIRECT: 0x100,
    QUERY_RESOLVE: 0x200,
  };
  globalThis.GPUTextureUsage ??= {
    COPY_SRC: 0x1,
    COPY_DST: 0x2,
    TEXTURE_BINDING: 0x4,
    STORAGE_BINDING: 0x8,
    RENDER_ATTACHMENT: 0x10,
  };
  globalThis.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
}

/**
 * The `.wgsl` source a `Shaders/WebGPU/**` `.js` import is served from: the
 * sibling `<Name>.wgsl` whenever it exists, whether or not the build has
 * generated `<Name>.js` beside it. Undefined when there is no sibling.
 *
 * @param {string} resolveDir The importing file's directory.
 * @param {string} specifier The import specifier, ending in `.js`.
 * @returns {string|undefined} Absolute path of the `.wgsl` source.
 */
export function resolveShaderModuleSource(resolveDir, specifier) {
  const asJs = resolve(resolveDir, specifier);
  const asWgsl = `${asJs.slice(0, -3)}.wgsl`;
  return existsSync(asWgsl) ? asWgsl : undefined;
}

/**
 * Bundles the renderer entry with esbuild and imports it as a fresh module.
 *
 * @param {object} [options] Options.
 * @param {(path: string, text: string) => string} [options.transform] Rewrites
 *   each loaded engine file's text; the path is absolute and POSIX-separated.
 * @returns {Promise<{updateWebGPUOcean: Function, destroyWebGPUOceanResources: Function}>}
 *   The renderer's exported entry points.
 */
export async function loadOceanRenderer({
  transform = (_, text) => text,
} = {}) {
  installGpuGlobals();
  const result = await build({
    stdin: {
      contents: `export { updateWebGPUOcean, destroyWebGPUOceanResources } from ${JSON.stringify(RENDERER_PATH)};`,
      resolveDir: dirname(RENDERER_PATH),
      sourcefile: "ocean-renderer-entry.js",
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "es2022",
    logLevel: "silent",
    plugins: [
      {
        name: "ocean-harness",
        setup(pluginBuild) {
          pluginBuild.onResolve(
            { filter: /Shaders\/WebGPU\/.+\.js$/ },
            (args) => {
              const wgsl = resolveShaderModuleSource(
                args.resolveDir,
                args.path,
              );
              return wgsl === undefined ? undefined : { path: wgsl };
            },
          );
          pluginBuild.onLoad({ filter: /\.wgsl$/ }, async (args) => {
            const text = (await readFile(args.path, "utf8"))
              .split("\r\n")
              .join("\n");
            const transformed = transform(toPosix(args.path), text);
            return {
              contents: `export default ${JSON.stringify(transformed)};`,
              loader: "js",
            };
          });
          pluginBuild.onLoad({ filter: /\.(ts|js)$/ }, async (args) => {
            if (args.path.includes("node_modules")) {
              return undefined;
            }
            const text = (await readFile(args.path, "utf8"))
              .split("\r\n")
              .join("\n");
            return {
              contents: transform(toPosix(args.path), text),
              loader: args.path.endsWith(".ts") ? "ts" : "js",
            };
          });
        },
      },
    ],
  });
  // The nonce keeps identical bundles from sharing one cached module record.
  loadCounter += 1;
  const code = `${result.outputFiles[0].text}\n// load ${loadCounter}\n`;
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
  return {
    updateWebGPUOcean: mod.updateWebGPUOcean,
    destroyWebGPUOceanResources: mod.destroyWebGPUOceanResources,
  };
}

const TEXEL_CHANNELS = { rgba32float: 4, rg32float: 2, r32float: 1 };

function toBytes(data, dataOffset = 0, size) {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data, dataOffset, size);
  }
  const bytesPer = data.BYTES_PER_ELEMENT ?? 1;
  const start = data.byteOffset + dataOffset * bytesPer;
  const length =
    size === undefined
      ? data.byteLength - dataOffset * bytesPer
      : size * bytesPer;
  return new Uint8Array(data.buffer, start, length);
}

function resolveEntry(entry) {
  const out = { binding: entry.binding };
  const resource = entry.resource;
  if (resource?.kind === "view") {
    out.texture = resource.texture;
  } else if (resource?.kind === "sampler") {
    out.sampler = resource;
  } else if (resource?.buffer) {
    out.buffer = resource.buffer;
  }
  return out;
}

/**
 * A fake GPUDevice that records what the renderer asks of it.
 *
 * @param {object} [options] Options.
 * @param {boolean} [options.asyncPipelines] When false, the device omits
 *   `createComputePipelineAsync` and `createRenderPipelineAsync`. Default true.
 * @returns {{device: object, log: object}} The device and its log.
 */
export function createRecordingDevice(options = {}) {
  installGpuGlobals();
  const { asyncPipelines = true } = options;
  const log = {
    frame: 0,
    dispatches: [],
    computePasses: [],
    textures: [],
    buffers: [],
    pipelines: [],
    bindGroups: [],
    submits: 0,
    liveTextures: () => log.textures.filter((t) => !t.destroyed),
    liveBuffers: () => log.buffers.filter((b) => !b.destroyed),
    beginFrame(n) {
      log.frame = n;
    },
  };

  const makeComputePipeline = (descriptor) => {
    const pipeline = {
      kind: "compute",
      label: descriptor.label,
      descriptor,
      compute: descriptor.compute,
    };
    log.pipelines.push(pipeline);
    return pipeline;
  };
  const makeRenderPipeline = (descriptor) => {
    const pipeline = { kind: "render", label: descriptor.label, descriptor };
    log.pipelines.push(pipeline);
    return pipeline;
  };

  const makeComputePass = (descriptor) => {
    log.computePasses.push({ frame: log.frame, descriptor });
    let pipeline = null;
    let bindGroup = null;
    return {
      setPipeline(p) {
        pipeline = p;
      },
      setBindGroup(index, group) {
        bindGroup = group;
      },
      dispatchWorkgroups(x, y = 1, z = 1) {
        const stage = pipeline.compute;
        log.dispatches.push({
          frame: log.frame,
          pipeline,
          entryPoint: stage.entryPoint,
          moduleLabel: stage.module.label,
          code: stage.module.code,
          bindGroup,
          entries: bindGroup.resolvedEntries,
          workgroups: [x, y, z],
        });
      },
      end() {},
    };
  };

  const makeRenderPass = () => ({
    setPipeline() {},
    setBindGroup() {},
    setVertexBuffer() {},
    setIndexBuffer() {},
    draw() {},
    drawIndexed() {},
    end() {},
  });

  const device = {
    label: "recording device",
    queue: {
      writeBuffer(buffer, bufferOffset, data, dataOffset, size) {
        buffer.bytes.set(toBytes(data, dataOffset, size), bufferOffset);
      },
      writeTexture(destination, data, layout, size) {
        const texture = destination.texture;
        const channels = TEXEL_CHANNELS[texture.format];
        if (!texture.data || !channels) {
          return;
        }
        const width = size.width ?? size[0];
        const height = size.height ?? size[1] ?? 1;
        const bytes = toBytes(data);
        const floats = new Float32Array(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
        );
        const rowFloats = (layout.bytesPerRow ?? width * channels * 4) / 4;
        const base = (layout.offset ?? 0) / 4;
        const originX = destination.origin?.x ?? 0;
        const originY = destination.origin?.y ?? 0;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const texel = (y + originY) * texture.width + x + originX;
            for (let c = 0; c < channels; c++) {
              texture.data[texel * 4 + c] =
                floats[base + y * rowFloats + x * channels + c];
            }
          }
        }
      },
      submit() {
        log.submits += 1;
      },
    },
    createTexture(descriptor) {
      const width = descriptor.size.width ?? descriptor.size[0];
      const height = descriptor.size.height ?? descriptor.size[1] ?? 1;
      const texture = {
        label: descriptor.label,
        width,
        height,
        format: descriptor.format,
        usage: descriptor.usage,
        destroyed: false,
        data: TEXEL_CHANNELS[descriptor.format]
          ? new Float32Array(width * height * 4)
          : null,
        destroy() {
          texture.destroyed = true;
        },
        createView() {
          return { kind: "view", texture };
        },
      };
      log.textures.push(texture);
      return texture;
    },
    createBuffer(descriptor) {
      const buffer = {
        label: descriptor.label,
        size: descriptor.size,
        usage: descriptor.usage,
        destroyed: false,
        bytes: new Uint8Array(descriptor.size),
        destroy() {
          buffer.destroyed = true;
        },
      };
      log.buffers.push(buffer);
      return buffer;
    },
    createSampler(descriptor) {
      return { kind: "sampler", label: descriptor?.label, descriptor };
    },
    createShaderModule(descriptor) {
      return { label: descriptor.label, code: descriptor.code };
    },
    createBindGroupLayout(descriptor) {
      return { label: descriptor?.label, descriptor };
    },
    createPipelineLayout(descriptor) {
      return { label: descriptor?.label, descriptor };
    },
    createComputePipeline: makeComputePipeline,
    createRenderPipeline: makeRenderPipeline,
    createBindGroup(descriptor) {
      const group = {
        label: descriptor.label,
        layout: descriptor.layout,
        descriptor,
        resolvedEntries: descriptor.entries.map(resolveEntry),
      };
      log.bindGroups.push(group);
      return group;
    },
    createCommandEncoder(descriptor) {
      return {
        label: descriptor?.label,
        beginComputePass: makeComputePass,
        beginRenderPass: makeRenderPass,
        finish: () => ({ label: descriptor?.label }),
      };
    },
  };
  if (asyncPipelines) {
    device.createComputePipelineAsync = (descriptor) =>
      Promise.resolve().then(() => makeComputePipeline(descriptor));
    device.createRenderPipelineAsync = (descriptor) =>
      Promise.resolve().then(() => makeRenderPipeline(descriptor));
  }
  return { device, log };
}

function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Array(16).fill(0);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const EQUATOR_RADIUS = 6378137.0;
const EPOCH_DAY_NUMBER = 2460000;

/**
 * A frame state and context the ocean renderer accepts.
 *
 * @param {object} device The recording device.
 * @param {object} [options] Options.
 * @param {number} [options.frameNumber] Frame index, stamped on the state.
 * @param {number} [options.seconds] Scene time in seconds from a fixed epoch.
 * @param {boolean} [options.useFrameEncoder] Give the context a frame command
 *   encoder, so the compute chain records into it instead of a private one.
 * @returns {object} The frame state; its `context` carries the device.
 */
export function makeOceanFrameState(
  device,
  { frameNumber = 0, seconds = 0, useFrameEncoder = false } = {},
) {
  const days = Math.floor(seconds / 86400);
  const context = {
    id: "ctx-ocean-harness",
    device,
    scenePipelineFormat: "rgba16float",
    webgpuPipelineCache: null,
    _msaaSamples: 1,
    _canvas: { width: 1920, height: 1080 },
    currentCommandEncoder: useFrameEncoder
      ? device.createCommandEncoder({ label: "frame encoder" })
      : null,
    hasActiveRenderPass: false,
    uniformState: {
      view: identity(),
      projection: perspective(Math.PI / 3, 1920 / 1080, 1, 1.0e7),
      cameraPosition: { x: EQUATOR_RADIUS + 500, y: 0, z: 0 },
      currentFrustum: { x: 1, y: 1.0e7 },
    },
    log() {},
  };
  return {
    frameNumber,
    context,
    commandList: [],
    useLogDepth: false,
    time: {
      dayNumber: EPOCH_DAY_NUMBER + days,
      secondsOfDay: seconds - days * 86400,
      timeStandard: 0,
    },
  };
}

/**
 * A primitive-like object holding the fields the renderer reads.
 *
 * @param {object} [overrides] Assigned last.
 * @returns {object} The primitive.
 */
export function makeOceanPrimitive(overrides = {}) {
  const primitive = {
    show: true,
    _enabled: true,
    _patchLength: 250.0,
    _patchExtent: 3000.0,
    _gravity: 9.81,
    _windDirX: 1.0,
    _windDirZ: 0.0,
    _windSpeed: 12.0,
    _amplitude: 1.0,
    _smallWave: 1.0,
    _dirDamp: 0.15,
    _choppiness: 1.0,
    _heightScale: 1.0,
    _foamThreshold: 0.6,
    _foamScale: 1.2,
    _foamStrength: 1.0,
    _detailScale: 1.0,
    _timeSpeed: 1.0,
    _anchor: { x: EQUATOR_RADIUS, y: 0, z: 0 },
    _east: { x: 0, y: 1, z: 0 },
    _north: { x: 0, y: 0, z: 1 },
    _up: { x: 1, y: 0, z: 0 },
    _uvOffsetX: 0,
    _uvOffsetY: 0,
    _sunDirection: { x: 0, y: 0, z: 1 },
    _invRadius: 1.0 / EQUATOR_RADIUS,
    _paramsDirty: false,
  };
  return Object.assign(primitive, overrides);
}

/**
 * Runs `frames` renderer updates, yielding a macrotask between frames so the
 * async pipelines resolve.
 *
 * @param {object} api The result of `loadOceanRenderer`.
 * @param {object} device The recording device.
 * @param {object} log The device's log.
 * @param {object} prim The primitive.
 * @param {number} frames Frame count.
 * @returns {Promise<object[][]>} `log.dispatches` grouped per frame.
 */
export async function runOceanFrames(api, device, log, prim, frames) {
  const start = log.dispatches.length;
  const firstFrame = log.frame;
  for (let i = 0; i < frames; i++) {
    log.beginFrame(firstFrame + i);
    api.updateWebGPUOcean(
      prim,
      makeOceanFrameState(device, {
        frameNumber: firstFrame + i,
        seconds: (firstFrame + i) / 60,
      }),
    );
    await new Promise((done) => setImmediate(done));
  }
  const grouped = Array.from({ length: frames }, () => []);
  for (const dispatch of log.dispatches.slice(start)) {
    grouped[dispatch.frame - firstFrame].push(dispatch);
  }
  return grouped;
}
