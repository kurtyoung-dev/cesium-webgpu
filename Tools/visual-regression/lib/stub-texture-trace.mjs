// stub-texture-trace.mjs — record which texture-upload and texture-copy paths
// a page actually ran, at three layers, for a probe to put in its receipt.
//
// @purpose The reusable runtime instrument for a texture cell: an init script that arms the engine's debug-build stub receipt and counts the WebGPU calls that create, copy, upload, submit and destroy textures; in-page wrappers that count the scene-side texture atlas, Texture and Material calls; and the readers that bring all three back with the live state of a label atlas or a video material.
// @status ACTIVE
//
// WHY. A fix that is served and loaded can still sit on a path the scene never
// takes. A capture says whether the pixels moved; it does not say which code
// ran. This module says which code ran, so a probe can report "the path was
// reached N times and did X" beside the pixels.
//
// THE THREE LAYERS.
//   engine - `globalThis.__cesiumStubTextureTrace`. The WebGL compatibility
//            stub records its texture-upload and framebuffer-copy branches
//            there (`Renderer/WebGPU/Stubs/WebGLStubTextureTrace.ts`), inside
//            debug pragmas, and only once a page has created the object. The
//            init script creates it, so the receipt exists only in a debug
//            build (CesiumUnminified) and only under a probe.
//   gpu    - `globalThis.__gpuCallTrace`. The init script wraps the WebGPU
//            prototype methods every renderer path ends in:
//            `GPUDevice.createTexture`, `GPUCommandEncoder.copyTextureToTexture`
//            and `finish`, `GPUQueue.submit`, `copyExternalImageToTexture` and
//            `writeTexture`, and `GPUTexture.destroy`. Each texture gets a
//            serial id when created, so a copy, an upload and a destroy name
//            the same texture the same way.
//   scene  - `globalThis.__sceneTextureTrace`. `pageInstallSceneTextureTrace`
//            wraps `TextureAtlas.prototype.update`, `_resize` and
//            `_copyFromTexture`, `Texture.prototype.copyFrom` and
//            `Material.prototype.update` on the engine module the page runs.
//
// The counters keep a count per event and the first few details of each, so
// a call made every frame (a video upload) cannot grow a receipt without bound.
//
// ORDER ACROSS LAYERS. Every event of every layer takes the next number from
// one page-wide sequence (`globalThis.__stubTraceSequence`). Each kept
// detail carries its event's number as `seq`, and `lastSequence[event]` is
// the number of the event's latest occurrence, so "this destroy came after
// the tenth submit" is read from the receipt even when the sample cap has
// dropped the submit's own detail. The engine layer is numbered without an
// engine change: the init script hands the engine an object whose `counts`
// and `samples` stamp each write. The gpu layer also keeps, per texture id,
// how often it was destroyed (`destroyedById`) and, per encoder label, which
// texture ids its copies read (`copySourcesByLabel`), both unsampled.
//
// WHAT IS READ BACK. `readStubTextureTrace` returns the three layers.
// `pageReadLabelAtlasState` adds the live state of a label collection's glyph
// atlas (its texture, the native texture behind it, and the view the WebGPU
// label renderer bound), and `frameReadVideoMaterialState` the live state of
// every material whose image uniform is a video element (whether the WebGPU
// material path's image source holds it, and what texture the WebGL-shaped
// material path built from it).

import { awaitFrameImportMap } from "./frame-import-map.mjs";

/** The engine receipt's page global (mirrors `WebGLStubTextureTrace.ts`). */
export const STUB_TEXTURE_TRACE_GLOBAL = "__cesiumStubTextureTrace";
/** The page-wide event sequence every layer numbers its events from. */
export const STUB_TRACE_SEQUENCE_GLOBAL = "__stubTraceSequence";
/** The WebGPU call counters' page global. */
export const GPU_CALL_TRACE_GLOBAL = "__gpuCallTrace";
/** The scene-side counters' page global. */
export const SCENE_TEXTURE_TRACE_GLOBAL = "__sceneTextureTrace";

/**
 * An init script, run in every frame before its scripts: arm the engine
 * receipt and wrap the WebGPU texture calls. Self-contained, because it is
 * serialised into the page.
 */
export function stubTextureTraceInit() {
  if (globalThis.__gpuCallTrace) {
    return;
  }
  const SAMPLES = 4;
  const sequence = (globalThis.__stubTraceSequence ??= { value: 0 });
  const next = () => (sequence.value += 1);
  // The engine writes `counts[event]` and then pushes into
  // `samples[event]` (WebGLStubTextureTrace.ts); numbering the count write
  // and stamping the push gives its details the same sequence as the rest.
  const engine = { lastSequence: {} };
  let engineSequence = 0;
  engine.counts = new Proxy(
    {},
    {
      set(target, event, value) {
        engineSequence = next();
        engine.lastSequence[event] = engineSequence;
        target[event] = value;
        return true;
      },
    },
  );
  engine.samples = new Proxy(
    {},
    {
      set(target, event, kept) {
        if (Array.isArray(kept)) {
          Object.defineProperty(kept, "push", {
            value(...details) {
              return Array.prototype.push.apply(
                this,
                details.map((detail) => ({
                  ...(detail ?? {}),
                  seq: engineSequence,
                })),
              );
            },
          });
        }
        target[event] = kept;
        return true;
      },
    },
  );
  globalThis.__cesiumStubTextureTrace = engine;
  const trace = {
    counts: {},
    samples: {},
    lastSequence: {},
    destroyedById: {},
    copySourcesByLabel: {},
  };
  globalThis.__gpuCallTrace = trace;
  const record = (event, detail = {}) => {
    const seq = next();
    trace.counts[event] = (trace.counts[event] ?? 0) + 1;
    trace.lastSequence[event] = seq;
    const kept = (trace.samples[event] ??= []);
    if (kept.length < SAMPLES) {
      kept.push({ ...(detail ?? {}), seq });
    }
    return seq;
  };
  const ids = new WeakMap();
  let nextId = 1;
  const describe = (texture) =>
    texture
      ? {
          id: ids.get(texture) ?? null,
          label: texture.label,
          width: texture.width,
          height: texture.height,
        }
      : null;
  const wrap = (prototype, name, around) => {
    const original = prototype?.[name];
    if (typeof original !== "function") {
      return;
    }
    prototype[name] = function (...args) {
      return around.call(this, original, args);
    };
  };

  wrap(globalThis.GPUDevice?.prototype, "createTexture", function (o, args) {
    const texture = o.apply(this, args);
    ids.set(texture, nextId++);
    const size = args[0]?.size;
    record(`createTexture.${args[0]?.label ?? "unlabelled"}`, {
      id: ids.get(texture),
      width: size?.width ?? size?.[0],
      height: size?.height ?? size?.[1],
    });
    return texture;
  });
  wrap(globalThis.GPUTexture?.prototype, "destroy", function (o, args) {
    const detail = describe(this);
    const seq = record(`destroy.${this.label || "unlabelled"}`, detail);
    if (detail.id !== null) {
      const entry = (trace.destroyedById[detail.id] ??= {
        label: detail.label ?? null,
        count: 0,
        firstSequence: seq,
        lastSequence: seq,
      });
      entry.count += 1;
      entry.lastSequence = seq;
    }
    return o.apply(this, args);
  });
  const finishedLabels = new WeakMap();
  wrap(
    globalThis.GPUCommandEncoder?.prototype,
    "copyTextureToTexture",
    function (o, args) {
      const [source, destination, size] = args;
      const label = this.label || "unlabelled";
      const sourceId = ids.get(source?.texture) ?? null;
      const sources = (trace.copySourcesByLabel[label] ??= {});
      sources[sourceId] = (sources[sourceId] ?? 0) + 1;
      record(`copyTextureToTexture.${label}`, {
        source: describe(source?.texture),
        sourceOrigin: source?.origin ?? null,
        destination: describe(destination?.texture),
        destinationOrigin: destination?.origin ?? null,
        size: size ?? null,
      });
      return o.apply(this, args);
    },
  );
  wrap(globalThis.GPUCommandEncoder?.prototype, "finish", function (o, args) {
    const buffer = o.apply(this, args);
    finishedLabels.set(buffer, this.label || "unlabelled");
    return buffer;
  });
  wrap(globalThis.GPUQueue?.prototype, "submit", function (o, args) {
    for (const buffer of args[0] ?? []) {
      record(`submit.${finishedLabels.get(buffer) ?? "unknown"}`);
    }
    return o.apply(this, args);
  });
  wrap(
    globalThis.GPUQueue?.prototype,
    "copyExternalImageToTexture",
    function (o, args) {
      const [source, destination, size] = args;
      const element = source?.source;
      const kind = element?.constructor?.name ?? "unknown";
      const detail = {
        destination: describe(destination?.texture),
        origin: destination?.origin ?? null,
        size: size ?? null,
      };
      if (kind === "HTMLVideoElement") {
        detail.element = {
          width: element.width,
          height: element.height,
          videoWidth: element.videoWidth,
          videoHeight: element.videoHeight,
        };
      }
      try {
        const result = o.apply(this, args);
        record(`copyExternalImageToTexture.${kind}`, detail);
        return result;
      } catch (error) {
        record(`copyExternalImageToTexture.${kind}.threw`, {
          ...detail,
          message: String(error?.message ?? error),
        });
        throw error;
      }
    },
  );
  wrap(globalThis.GPUQueue?.prototype, "writeTexture", function (o, args) {
    const [destination, , , size] = args;
    record("writeTexture", {
      destination: describe(destination?.texture),
      origin: destination?.origin ?? null,
      size: size ?? null,
    });
    return o.apply(this, args);
  });
}

/**
 * Wrap the scene-side texture calls on an engine module or global. Runs in the
 * page or frame; self-contained.
 *
 * @param {{moduleUrl?: string|null}} args The engine module to import: a URL,
 *   or a bare specifier the frame's import map resolves (the Sandcastle2 run
 *   frame maps `cesium`), or null to use a `Cesium` global.
 * @returns {Promise<{installed: string[]}>} The methods wrapped.
 */
export async function pageInstallSceneTextureTrace({ moduleUrl }) {
  // __sceneTextureTrace
  const C = moduleUrl ? await import(moduleUrl) : globalThis.Cesium;
  if (globalThis.__sceneTextureTrace) {
    return { installed: globalThis.__sceneTextureTrace.installed };
  }
  const SAMPLES = 4;
  const trace = { counts: {}, samples: {}, installed: [] };
  globalThis.__sceneTextureTrace = trace;
  const sequence = (globalThis.__stubTraceSequence ??= { value: 0 });
  trace.lastSequence = {};
  const record = (event, detail = {}) => {
    const seq = (sequence.value += 1);
    trace.counts[event] = (trace.counts[event] ?? 0) + 1;
    trace.lastSequence[event] = seq;
    const kept = (trace.samples[event] ??= []);
    if (kept.length < SAMPLES) {
      kept.push({ ...(detail ?? {}), seq });
    }
  };
  const backendOf = (context) =>
    context?.isWebGPU === true ? "webgpu" : "webgl";
  const size = (texture) =>
    texture ? { width: texture.width, height: texture.height } : null;
  const wrap = (owner, name, around) => {
    const prototype = owner?.prototype;
    const original = prototype?.[name];
    if (typeof original !== "function") {
      return;
    }
    prototype[name] = function (...args) {
      return around.call(this, original, args);
    };
    trace.installed.push(`${owner.name}.${name}`);
  };

  wrap(C?.TextureAtlas, "update", function (o, args) {
    const before = size(this._texture);
    const result = o.apply(this, args);
    const after = size(this._texture);
    const grew =
      before && after
        ? after.width * after.height > before.width * before.height
        : false;
    record(`TextureAtlas.update.${backendOf(args[0])}`);
    if (grew) {
      record(`TextureAtlas.update.grew.${backendOf(args[0])}`, {
        before,
        after,
      });
    }
    return result;
  });
  wrap(C?.TextureAtlas, "_resize", function (o, args) {
    const context = args[0];
    record(`TextureAtlas._resize.${backendOf(context)}`, {
      from: size(this._texture),
      images: this._rectangles?.length ?? null,
      inFrame: context?._currentCommandEncoder
        ? true
        : context?.isWebGPU === true
          ? false
          : null,
    });
    return o.apply(this, args);
  });
  wrap(C?.TextureAtlas, "_copyFromTexture", function (o, args) {
    const [context, width, height, rectangles] = args;
    const copies = (this._rectangles ?? []).filter(
      (old, index) => old && rectangles?.[index],
    ).length;
    record(`TextureAtlas._copyFromTexture.${backendOf(context)}`, {
      to: { width, height },
      copies,
    });
    return o.apply(this, args);
  });
  wrap(C?.Texture, "copyFrom", function (o, args) {
    const source = args[0]?.source;
    const kind =
      source?.arrayBufferView !== undefined
        ? "arrayBufferView"
        : (source?.constructor?.name ?? "unknown");
    record(`Texture.copyFrom.${backendOf(this._context)}.${kind}`, {
      texture: size(this),
      xOffset: args[0]?.xOffset ?? 0,
      yOffset: args[0]?.yOffset ?? 0,
    });
    return o.apply(this, args);
  });
  const videoMaterials = new Set();
  trace.videoMaterials = videoMaterials;
  wrap(C?.Material, "update", function (o, args) {
    const uniforms = this.uniforms ?? {};
    for (const key of Object.keys(uniforms)) {
      if (
        typeof HTMLVideoElement !== "undefined" &&
        uniforms[key] instanceof HTMLVideoElement
      ) {
        videoMaterials.add(this);
        record(`Material.update.video.${backendOf(args[0])}`, { uniform: key });
      }
    }
    return o.apply(this, args);
  });
  // The primitives drawing those materials, so the reader can compare the
  // view the WebGPU material path bound with the material's own texture.
  const videoPrimitives = new Set();
  trace.videoPrimitives = videoPrimitives;
  wrap(C?.Primitive, "update", function (o, args) {
    const material = this.appearance?.material;
    if (material && videoMaterials.has(material)) {
      videoPrimitives.add(this);
    }
    return o.apply(this, args);
  });
  return { installed: trace.installed };
}

/**
 * Install the scene-side wrappers in a page or frame once it can import
 * `moduleUrl`: for a bare specifier (the Sandcastle2 run frame maps
 * `cesium`), wait until the document has parsed its import map, then run
 * `pageInstallSceneTextureTrace` there. Runs in Node.
 *
 * The opener returns the run frame as soon as it exists, which can be before
 * its head is parsed; an import evaluated then fails to resolve the specifier.
 * Every cell that installs the trace in a frame goes through this.
 *
 * @param {{evaluate: Function, waitForFunction: Function}} frame A Playwright
 *   page or frame.
 * @param {{moduleUrl?: string|null, timeoutMs: number}} options The engine
 *   module, as for `pageInstallSceneTextureTrace`, and how long to wait for
 *   the import map.
 * @returns {Promise<{installed: string[], importMap: object}>} The methods
 *   wrapped, and whether and how long the import map was waited for.
 * @throws {import("./probe-refusal.mjs").ProbeRefusal}
 *   `frame-import-map-missing` when the import map does not appear in time.
 */
export async function installSceneTextureTraceInFrame(
  frame,
  { moduleUrl, timeoutMs },
) {
  const importMap = moduleUrl
    ? await awaitFrameImportMap(frame, { specifier: moduleUrl, timeoutMs })
    : { waited: false, elapsedMs: 0 };
  const installed = await frame.evaluate(pageInstallSceneTextureTrace, {
    moduleUrl,
  });
  return { ...installed, importMap };
}

/**
 * Read the three layers back. Runs in the page or frame; self-contained.
 *
 * @returns {{engine: object|null, gpu: object|null, scene: object|null}}
 */
export function pageReadStubTextureTrace() {
  // __readStubTextureTrace
  const plain = (value) => (value ? JSON.parse(JSON.stringify(value)) : null);
  const scene = globalThis.__sceneTextureTrace;
  return {
    engine: plain(globalThis.__cesiumStubTextureTrace),
    gpu: plain(globalThis.__gpuCallTrace),
    scene: scene
      ? plain({
          counts: scene.counts,
          samples: scene.samples,
          lastSequence: scene.lastSequence ?? null,
          installed: scene.installed,
        })
      : null,
  };
}

/**
 * When the texture an encoder label's copies read was destroyed, against that
 * label's submits, from a gpu-layer receipt (`readStubTextureTrace(...).gpu`).
 * Pure; runs in Node.
 *
 * It answers "was the source destroyed once, and only after every copy that
 * read it was submitted" from the unsampled counters: the per-label source
 * tally, the per-id destroy count and the last submit's sequence number.
 *
 * @param {object|null} gpu The gpu layer of a receipt.
 * @param {string} label The copies' encoder label.
 * @returns {object} The source ids, the one source (or null when there is not
 *   exactly one), its destroy count and first destroy's sequence, the submit
 *   count and the last submit's sequence, and `destroyedAfterLastSubmit`
 *   (null when either sequence is missing).
 */
export function copySourceDestroyOrder(gpu, label) {
  const sources = gpu?.copySourcesByLabel?.[label] ?? {};
  const ids = Object.keys(sources).filter((id) => id !== "null");
  const sourceId = ids.length === 1 ? Number(ids[0]) : null;
  const destroyed =
    sourceId === null ? null : (gpu?.destroyedById?.[sourceId] ?? null);
  const submits = gpu?.counts?.[`submit.${label}`] ?? 0;
  const lastSubmitSequence = gpu?.lastSequence?.[`submit.${label}`] ?? null;
  const destroySequence = destroyed?.firstSequence ?? null;
  return {
    label,
    sources,
    sourceId,
    destroyCount: destroyed?.count ?? 0,
    destroyLabel: destroyed?.label ?? null,
    destroySequence,
    submits,
    lastSubmitSequence,
    destroyedAfterLastSubmit:
      destroySequence === null || lastSubmitSequence === null
        ? null
        : destroySequence > lastSubmitSequence,
  };
}

/**
 * The live state of the first label collection's glyph atlas on the page's
 * viewer, and whether the WebGPU label renderer bound its current native
 * texture. Runs in the page; self-contained.
 *
 * @returns {object|null} The atlas texture, its native texture and the bound
 *   view's identity, or null when the scene has no label collection.
 */
export function pageReadLabelAtlasState() {
  // __readLabelAtlasState
  const primitives = globalThis.viewer?.scene?.primitives;
  let labels = null;
  for (let i = 0; i < (primitives?.length ?? 0); i++) {
    const primitive = primitives.get(i);
    if (primitive?._glyphBillboardCollection) {
      labels = primitive;
      break;
    }
  }
  if (!labels) {
    return null;
  }
  const atlas = labels._glyphBillboardCollection._textureAtlas;
  const texture = atlas?.texture;
  const native = texture?._texture?._webgpuTexture ?? null;
  const cache = labels._webgpuLabelCache ?? null;
  return {
    atlasTexture: texture
      ? { width: texture.width, height: texture.height }
      : null,
    native: native
      ? {
          label: native.texture?.label ?? null,
          width: native.width,
          height: native.height,
          format: native.format,
        }
      : null,
    labelRenderer: cache
      ? {
          atlasSourceTag: cache.atlasSourceTag ?? null,
          boundViewIsCurrentNative:
            !!native && cache.atlasTextureView === native.view,
        }
      : null,
  };
}

/**
 * The live state of every material whose image uniform is a video element,
 * as `pageInstallSceneTextureTrace` collected them. Runs in the page or frame;
 * self-contained.
 *
 * `boundViewIsCurrentNative` follows the label atlas reader's rule: whether
 * the view the WebGPU material path bound for the uniform's slot (the slot
 * state the primitive texture cache keeps as `_matPrimaryTextures`) is the
 * current view of the native texture behind `_textures[uniform]`. It is null
 * when no primitive drawing the material carries a WebGPU texture cache (the
 * WebGL renderer), and `boundView` reads "unavailable" when a cache carries no
 * slot state (a tree without that state).
 *
 * @returns {Array<object>} One entry per video uniform.
 */
export function frameReadVideoMaterialState() {
  // __readVideoMaterialState
  const materials = globalThis.__sceneTextureTrace?.videoMaterials;
  const out = [];
  for (const material of materials ?? []) {
    for (const [key, value] of Object.entries(material.uniforms ?? {})) {
      if (!(value instanceof HTMLVideoElement)) {
        continue;
      }
      const texture = material._textures?.[key];
      const native = texture?._texture?._webgpuTexture ?? null;
      const bound = [];
      for (const primitive of globalThis.__sceneTextureTrace?.videoPrimitives ??
        []) {
        const cache =
          primitive.appearance?.material === material
            ? primitive._webgpuCache
            : undefined;
        if (!cache) {
          continue;
        }
        const state = cache._matPrimaryTextures;
        bound.push(
          state === undefined
            ? "unavailable"
            : state.boundView === undefined
              ? "image-path"
              : state.boundView === null
                ? "placeholder"
                : native && state.boundView === native.view
                  ? "current-native"
                  : "other-view",
        );
      }
      out.push({
        uniform: key,
        materialType: material.type ?? null,
        imageSourceIsVideo: material._imageSources?.[key] === value,
        imageSourceKind:
          material._imageSources?.[key]?.constructor?.name ?? null,
        texture: texture
          ? {
              width: texture.width,
              height: texture.height,
              isDefaultTexture:
                texture === material._defaultTexture ||
                texture?._isDefaultTexture === true,
            }
          : null,
        native: native
          ? {
              label: native.texture?.label ?? null,
              width: native.width,
              height: native.height,
            }
          : null,
        boundView: bound,
        boundViewIsCurrentNative:
          bound.length === 0 || bound.includes("unavailable")
            ? null
            : bound.every((each) => each === "current-native"),
      });
    }
  }
  return out;
}

/** The framebuffer census counters' page global. */
export const FRAMEBUFFER_CENSUS_TRACE_GLOBAL = "__framebufferCensusTrace";

/**
 * Count every `Framebuffer.js` constructed, destroyed or blitted after this
 * runs, attributed to its consumer: the first caller outside `Framebuffer`,
 * `FramebufferManager` and `MultisampleFramebuffer`, read from the call
 * stack. Runs in the page or frame; self-contained.
 *
 * A construction is a `_bind` whose stack holds `new Framebuffer` directly
 * (the constructor binds before it attaches), so the counter needs no hook in
 * the constructor itself. Framebuffers built before the page ran this are not
 * counted here; the engine receipt counts their attachments from the start.
 *
 * @param {{moduleUrl?: string|null}} args The engine module to import, as for
 *   `pageInstallSceneTextureTrace`.
 * @returns {Promise<{installed: string[]}>} The methods wrapped.
 */
export async function pageInstallFramebufferCensusTrace({ moduleUrl }) {
  // __framebufferCensusTrace
  const C = moduleUrl ? await import(moduleUrl) : globalThis.Cesium;
  if (globalThis.__framebufferCensusTrace) {
    return { installed: globalThis.__framebufferCensusTrace.installed };
  }
  const SAMPLES = 4;
  const trace = { counts: {}, samples: {}, installed: [] };
  globalThis.__framebufferCensusTrace = trace;
  const sequence = (globalThis.__stubTraceSequence ??= { value: 0 });
  trace.lastSequence = {};
  const record = (event, detail = {}) => {
    const seq = (sequence.value += 1);
    trace.counts[event] = (trace.counts[event] ?? 0) + 1;
    trace.lastSequence[event] = seq;
    const kept = (trace.samples[event] ??= []);
    if (kept.length < SAMPLES) {
      kept.push({ ...(detail ?? {}), seq });
    }
  };
  const WRAPPERS =
    /^(?:new )?(?:Framebuffer|FramebufferManager|MultisampleFramebuffer)\b/;
  const callers = () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 40;
    const lines = String(new Error().stack ?? "")
      .split("\n")
      .slice(1);
    Error.stackTraceLimit = limit;
    return lines.map((line) => {
      const match = /^\s*at (?:async )?((?:new )?[^\s(]+)/.exec(line);
      const name = match?.[1] ?? "?";
      return name.includes("/") ? "anonymous" : name;
    });
  };
  // The counter's own frames are `callers`, the wrapper and the function
  // it calls around the original; V8 names the last two `<computed>` and
  // `<anonymous>`.
  const consumerOf = (names) =>
    names.find(
      (name) =>
        name !== "?" &&
        name !== "callers" &&
        !name.includes("<computed>") &&
        !name.includes("<anonymous>") &&
        !WRAPPERS.test(name),
    ) ?? "unknown";
  const wrap = (owner, name, around) => {
    const prototype = owner?.prototype;
    const original = prototype?.[name];
    if (typeof original !== "function") {
      return;
    }
    prototype[name] = function (...args) {
      return around.call(this, original, args);
    };
    trace.installed.push(`${owner.name}.${name}`);
  };
  wrap(C?.Framebuffer, "_bind", function (o, args) {
    const names = callers();
    const at = names.indexOf("new Framebuffer");
    if (at >= 0) {
      const after = names.slice(at + 1);
      record(`Framebuffer.construct.${consumerOf(after)}`, {
        immediate: after[0] ?? null,
      });
    }
    return o.apply(this, args);
  });
  wrap(C?.Framebuffer, "destroy", function (o, args) {
    const names = callers();
    record(`Framebuffer.destroy.${consumerOf(names)}`, {
      destroyAttachments: this.destroyAttachments === true,
      colorTextures: this._colorTextures?.length ?? 0,
      colorRenderbuffers: this._colorRenderbuffers?.length ?? 0,
    });
    return o.apply(this, args);
  });
  wrap(C?.MultisampleFramebuffer, "blitFramebuffers", function (o, args) {
    const names = callers();
    record(`MultisampleFramebuffer.blitFramebuffers.${consumerOf(names)}`, {
      blitStencil: args[1] === true,
    });
    return o.apply(this, args);
  });
  wrap(C?.Texture, "copyFromFramebuffer", function (o, args) {
    const names = callers();
    record(`Texture.copyFromFramebuffer.${consumerOf(names)}`);
    return o.apply(this, args);
  });
  return { installed: trace.installed };
}

/**
 * Read the framebuffer census counters back. Runs in the page or frame;
 * self-contained.
 *
 * @returns {object|null} The counts and samples, or null when not installed.
 */
export function pageReadFramebufferCensusTrace() {
  // __readFramebufferCensusTrace
  const trace = globalThis.__framebufferCensusTrace;
  return trace
    ? JSON.parse(
        JSON.stringify({
          counts: trace.counts,
          samples: trace.samples,
          lastSequence: trace.lastSequence ?? null,
          installed: trace.installed,
        }),
      )
    : null;
}
