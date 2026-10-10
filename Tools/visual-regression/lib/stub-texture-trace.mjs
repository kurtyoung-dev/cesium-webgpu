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
// WHAT IS READ BACK. `readStubTextureTrace` returns the three layers.
// `pageReadLabelAtlasState` adds the live state of a label collection's glyph
// atlas (its texture, the native texture behind it, and the view the WebGPU
// label renderer bound), and `frameReadVideoMaterialState` the live state of
// every material whose image uniform is a video element (whether the WebGPU
// material path's image source holds it, and what texture the WebGL-shaped
// material path built from it).

/** The engine receipt's page global (mirrors `WebGLStubTextureTrace.ts`). */
export const STUB_TEXTURE_TRACE_GLOBAL = "__cesiumStubTextureTrace";
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
  const makeTrace = () => ({ counts: {}, samples: {} });
  globalThis.__cesiumStubTextureTrace = makeTrace();
  const trace = makeTrace();
  globalThis.__gpuCallTrace = trace;
  const record = (event, detail = {}) => {
    trace.counts[event] = (trace.counts[event] ?? 0) + 1;
    const kept = (trace.samples[event] ??= []);
    if (kept.length < SAMPLES) {
      kept.push(detail);
    }
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
    record(`destroy.${this.label || "unlabelled"}`, describe(this));
    return o.apply(this, args);
  });
  const finishedLabels = new WeakMap();
  wrap(
    globalThis.GPUCommandEncoder?.prototype,
    "copyTextureToTexture",
    function (o, args) {
      const [source, destination, size] = args;
      record(`copyTextureToTexture.${this.label || "unlabelled"}`, {
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
  const record = (event, detail = {}) => {
    trace.counts[event] = (trace.counts[event] ?? 0) + 1;
    const kept = (trace.samples[event] ??= []);
    if (kept.length < SAMPLES) {
      kept.push(detail);
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
  return { installed: trace.installed };
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
          installed: scene.installed,
        })
      : null,
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
      });
    }
  }
  return out;
}
