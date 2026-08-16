/**
 * Independent WebGPU allocation/upload probe.
 * @purpose Instruments raw browser WebGPU/WebGL API boundaries to detect a hidden WebGL context in explicit-WebGPU scenes and classify compat allocations.
 * @status ACTIVE
 *
 * This deliberately instruments only browser WebGPU API boundaries. It does not
 * reach into Cesium private resource maps, so it can detect whether an explicit
 * WebGPU scene also opens a WebGL context and can characterize native versus
 * compatibility-labelled allocations. Engine-owned FAR-001 counters remain the
 * authoritative logical ownership source once present.
 *
 * Usage (with the normal Node dev server already running):
 *   node Tools/visual-regression/probe-webgpu-allocation-tax.mjs
 *   node Tools/visual-regression/probe-webgpu-allocation-tax.mjs \
 *     --url http://localhost:8080/Apps/CesiumViewer/index.html \
 *     --output Tools/visual-regression/output/allocation-tax.json
 *
 * Add --strict-native to fail if any buffer labelled "GL Compatibility" is
 * created. Explicit WebGPU opening a WebGL/WebGL2 canvas always fails. Stub-
 * translated textures are reported separately; they may be the only physical
 * realization, so their label alone does not prove a duplicate GPU allocation.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const toolDirectory = dirname(fileURLToPath(import.meta.url));

function parseArguments(argv) {
  const options = {
    url: "http://localhost:8080/Apps/CesiumViewer/index.html",
    output: undefined,
    strictNative: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--strict-native") {
      options.strictNative = true;
    } else if (argument === "--url") {
      options.url = argv[++index];
    } else if (argument === "--output") {
      options.output = argv[++index];
    } else if (argument === "--help") {
      console.log(
        "Usage: node probe-webgpu-allocation-tax.mjs [--url URL] [--output FILE] [--strict-native]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function summarize(records) {
  const groups = new Map();
  for (const record of records) {
    const label = record.label || "(unlabeled)";
    const group = groups.get(label) ?? {
      label,
      owner: record.owner,
      created: 0,
      createdBytes: 0,
      live: 0,
      liveBytes: 0,
    };
    group.created++;
    group.createdBytes += record.bytes || 0;
    if (!record.destroyed) {
      group.live++;
      group.liveBytes += record.bytes || 0;
    }
    groups.set(label, group);
  }
  return [...groups.values()].sort(
    (left, right) =>
      right.liveBytes - left.liveBytes ||
      right.live - left.live ||
      left.label.localeCompare(right.label),
  );
}

function totalBytes(records) {
  return records.reduce((sum, record) => sum + (record.bytes || 0), 0);
}

function live(records) {
  return records.filter((record) => !record.destroyed);
}

function delta(after, before) {
  const newBuffers = after.buffers.slice(before.buffers.length);
  const newTextures = after.textures.slice(before.textures.length);
  const counterDelta = {};
  for (const [name, value] of Object.entries(after.counters)) {
    counterDelta[name] = value - (before.counters[name] || 0);
  }
  return {
    buffersCreated: newBuffers.length,
    bufferBytesCreated: totalBytes(newBuffers),
    texturesCreated: newTextures.length,
    textureBytesCreated: totalBytes(newTextures),
    counters: counterDelta,
    newBufferLabels: summarize(newBuffers),
    newTextureLabels: summarize(newTextures),
  };
}

const options = parseArguments(process.argv.slice(2));
const url = new URL(options.url);
const bundleBytes = await readFile(
  resolve(toolDirectory, "..", "..", "Build", "CesiumUnminified", "Cesium.js"),
);
const runtimeBundle = {
  path: "Build/CesiumUnminified/Cesium.js",
  byteLength: bundleBytes.byteLength,
  sha256: createHash("sha256").update(bundleBytes).digest("hex").toUpperCase(),
};
url.searchParams.set("renderer", "webgpu");

let browser;
let report;
try {
  browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.addInitScript(() => {
    const counters = {
      bindGroupsCreated: 0,
      shaderModulesCreated: 0,
      renderPipelinesCreated: 0,
      computePipelinesCreated: 0,
      asyncRenderPipelinesCreated: 0,
      asyncComputePipelinesCreated: 0,
      renderPassesBegun: 0,
      computePassesBegun: 0,
      commandBuffersFinished: 0,
      submits: 0,
      commandBuffersSubmitted: 0,
      writeBufferCalls: 0,
      writeBufferBytes: 0,
      writeTextureCalls: 0,
      writeTextureBytes: 0,
      copyExternalImageCalls: 0,
      encoderCopyCalls: 0,
    };
    const audit = {
      nextId: 1,
      canvasContexts: {},
      buffers: [],
      textures: [],
      counters,
      prototypePatchAvailable: false,
      prototypePatchFailures: [],
    };
    globalThis.__gpuAllocationAudit = audit;

    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      audit.canvasContexts[type] = (audit.canvasContexts[type] || 0) + 1;
      return originalGetContext.call(this, type, ...args);
    };

    function ownerFromLabel(label) {
      const normalized = String(label || "");
      return normalized.includes("GL Compatibility") ||
        normalized.startsWith("GLStub_")
        ? "compatibility"
        : "unclassified-native";
    }

    function writeBufferByteLength(data, dataOffset = 0, size) {
      const bytesPerElement = ArrayBuffer.isView(data)
        ? data.BYTES_PER_ELEMENT || 1
        : 1;
      const totalElements = ArrayBuffer.isView(data)
        ? data.byteLength / bytesPerElement
        : data?.byteLength || 0;
      const elementCount = size ?? Math.max(0, totalElements - dataOffset);
      return Math.max(0, elementCount * bytesPerElement);
    }

    function textureBytes(descriptor) {
      const size = descriptor?.size;
      const width = Array.isArray(size) ? size[0] || 1 : size?.width || 1;
      const height = Array.isArray(size) ? size[1] || 1 : size?.height || 1;
      const layers = Array.isArray(size)
        ? size[2] || 1
        : size?.depthOrArrayLayers || 1;
      const block = {
        r8unorm: [1, 1, 1],
        r16float: [1, 1, 2],
        rg8unorm: [1, 1, 2],
        rg16float: [1, 1, 4],
        rg32float: [1, 1, 8],
        rgba8unorm: [1, 1, 4],
        "rgba8unorm-srgb": [1, 1, 4],
        bgra8unorm: [1, 1, 4],
        "bgra8unorm-srgb": [1, 1, 4],
        rgba16float: [1, 1, 8],
        rgba32float: [1, 1, 16],
        depth16unorm: [1, 1, 2],
        depth24plus: [1, 1, 4],
        "depth24plus-stencil8": [1, 1, 4],
        depth32float: [1, 1, 4],
        "bc1-rgba-unorm": [4, 4, 8],
        "bc1-rgba-unorm-srgb": [4, 4, 8],
        "bc3-rgba-unorm": [4, 4, 16],
        "bc3-rgba-unorm-srgb": [4, 4, 16],
        "bc7-rgba-unorm": [4, 4, 16],
        "bc7-rgba-unorm-srgb": [4, 4, 16],
        "etc2-rgb8unorm": [4, 4, 8],
        "etc2-rgb8unorm-srgb": [4, 4, 8],
      }[descriptor?.format] || [1, 1, 4];
      const samples = descriptor?.sampleCount || 1;
      const mipLevels = descriptor?.mipLevelCount || 1;
      let bytes = 0;
      for (let level = 0; level < mipLevels; level++) {
        const levelWidth = Math.max(1, width >> level);
        const levelHeight = Math.max(1, height >> level);
        bytes +=
          Math.ceil(levelWidth / block[0]) *
          Math.ceil(levelHeight / block[1]) *
          block[2];
      }
      return bytes * layers * samples;
    }

    function patch(prototype, name, wrap) {
      if (!prototype || typeof prototype[name] !== "function") {
        audit.prototypePatchFailures.push(name);
        return false;
      }
      try {
        const original = prototype[name];
        prototype[name] = wrap(original);
        return true;
      } catch (error) {
        audit.prototypePatchFailures.push(`${name}: ${String(error)}`);
        return false;
      }
    }

    const bufferRecords = new WeakMap();
    const textureRecords = new WeakMap();
    const devicePrototype = globalThis.GPUDevice?.prototype;
    const bufferPrototype = globalThis.GPUBuffer?.prototype;
    const texturePrototype = globalThis.GPUTexture?.prototype;
    const queuePrototype = globalThis.GPUQueue?.prototype;
    const encoderPrototype = globalThis.GPUCommandEncoder?.prototype;
    if (!devicePrototype || !bufferPrototype || !texturePrototype) return;

    let essentialPatches = 0;
    essentialPatches += Number(
      patch(
        devicePrototype,
        "createBuffer",
        (original) =>
          function (descriptor) {
            const buffer = original.call(this, descriptor);
            const label = descriptor?.label || "";
            const record = {
              id: audit.nextId++,
              label,
              owner: ownerFromLabel(label),
              bytes: Number(descriptor?.size || 0),
              usage: Number(descriptor?.usage || 0),
              destroyed: false,
              stack:
                new Error().stack?.split("\n").slice(2, 7).join("\n") || "",
            };
            bufferRecords.set(buffer, record);
            audit.buffers.push(record);
            return buffer;
          },
      ),
    );
    essentialPatches += Number(
      patch(
        bufferPrototype,
        "destroy",
        (original) =>
          function () {
            const record = bufferRecords.get(this);
            if (record) record.destroyed = true;
            return original.call(this);
          },
      ),
    );
    essentialPatches += Number(
      patch(
        devicePrototype,
        "createTexture",
        (original) =>
          function (descriptor) {
            const texture = original.call(this, descriptor);
            const label = descriptor?.label || "";
            const record = {
              id: audit.nextId++,
              label,
              owner: ownerFromLabel(label),
              bytes: textureBytes(descriptor),
              format: descriptor?.format || "",
              mipLevelCount: descriptor?.mipLevelCount || 1,
              sampleCount: descriptor?.sampleCount || 1,
              destroyed: false,
              stack:
                new Error().stack?.split("\n").slice(2, 7).join("\n") || "",
            };
            textureRecords.set(texture, record);
            audit.textures.push(record);
            return texture;
          },
      ),
    );
    essentialPatches += Number(
      patch(
        texturePrototype,
        "destroy",
        (original) =>
          function () {
            const record = textureRecords.get(this);
            if (record) record.destroyed = true;
            return original.call(this);
          },
      ),
    );
    audit.prototypePatchAvailable = essentialPatches === 4;

    const countDeviceCall = (name, counter) => {
      patch(
        devicePrototype,
        name,
        (original) =>
          function (...args) {
            counters[counter]++;
            return original.apply(this, args);
          },
      );
    };
    countDeviceCall("createBindGroup", "bindGroupsCreated");
    countDeviceCall("createShaderModule", "shaderModulesCreated");
    countDeviceCall("createRenderPipeline", "renderPipelinesCreated");
    countDeviceCall("createComputePipeline", "computePipelinesCreated");
    countDeviceCall("createRenderPipelineAsync", "asyncRenderPipelinesCreated");
    countDeviceCall(
      "createComputePipelineAsync",
      "asyncComputePipelinesCreated",
    );

    patch(
      queuePrototype,
      "submit",
      (original) =>
        function (commandBuffers) {
          counters.submits++;
          counters.commandBuffersSubmitted += commandBuffers?.length || 0;
          return original.call(this, commandBuffers);
        },
    );
    patch(
      queuePrototype,
      "writeBuffer",
      (original) =>
        function (...args) {
          counters.writeBufferCalls++;
          const data = args[2];
          counters.writeBufferBytes += writeBufferByteLength(
            data,
            args[3],
            args[4],
          );
          return original.apply(this, args);
        },
    );
    patch(
      queuePrototype,
      "writeTexture",
      (original) =>
        function (...args) {
          counters.writeTextureCalls++;
          const data = args[1];
          counters.writeTextureBytes += Number(
            data?.byteLength ?? data?.length ?? 0,
          );
          return original.apply(this, args);
        },
    );
    patch(
      queuePrototype,
      "copyExternalImageToTexture",
      (original) =>
        function (...args) {
          counters.copyExternalImageCalls++;
          return original.apply(this, args);
        },
    );
    patch(
      encoderPrototype,
      "beginRenderPass",
      (original) =>
        function (...args) {
          counters.renderPassesBegun++;
          return original.apply(this, args);
        },
    );
    patch(
      encoderPrototype,
      "beginComputePass",
      (original) =>
        function (...args) {
          counters.computePassesBegun++;
          return original.apply(this, args);
        },
    );
    patch(
      encoderPrototype,
      "finish",
      (original) =>
        function (...args) {
          counters.commandBuffersFinished++;
          return original.apply(this, args);
        },
    );
    for (const name of [
      "copyBufferToBuffer",
      "copyBufferToTexture",
      "copyTextureToBuffer",
      "copyTextureToTexture",
      "resolveQuerySet",
    ]) {
      patch(
        encoderPrototype,
        name,
        (original) =>
          function (...args) {
            counters.encoderCopyCalls++;
            return original.apply(this, args);
          },
      );
    }
  });

  await page.goto(url.href, { waitUntil: "load", timeout: 30_000 });
  await page.waitForFunction(
    () => globalThis.viewer?.scene?.context?.isWebGPU === true,
    undefined,
    { timeout: 45_000 },
  );
  await page.evaluate(async () => {
    const Cesium = await import("/Build/CesiumUnminified/index.js");
    globalThis.viewer.scene.requestRenderMode = false;
    globalThis.viewer.scene.globe.imageryLayers.removeAll();
    globalThis.viewer.scene.globe.terrainProvider =
      new Cesium.EllipsoidTerrainProvider();
    globalThis.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(-109.5, 35.5, 8_000_000),
    });
  });
  await page.waitForFunction(
    () =>
      globalThis.viewer?.scene?.globe?._surface?._tilesToRender?.length > 0 &&
      globalThis.viewer?.scene?.globe?.tilesLoaded === true,
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(2_000);

  async function snapshot(name) {
    const raw = await page.evaluate((snapshotName) => {
      const audit = globalThis.__gpuAllocationAudit;
      const context = globalThis.viewer?.scene?.context;
      const surface = globalThis.viewer?.scene?.globe?._surface;
      const tiles =
        surface?._tilesToRender ||
        surface?._tileProvider?._quadtree?._tilesToRender ||
        surface?._quadtree?._tilesToRender ||
        [];
      let tilesWithLegacyVertexArray = 0;
      let visibleMeshVertexBytes = 0;
      let visibleMeshIndexBytes = 0;
      for (const tile of tiles) {
        const data = tile?.data;
        if (data?.vertexArray) tilesWithLegacyVertexArray++;
        const mesh = data?.renderedMesh || data?.mesh;
        visibleMeshVertexBytes += mesh?.vertices?.byteLength || 0;
        visibleMeshIndexBytes += mesh?.indices?.byteLength || 0;
      }
      const rendererStats = context?.getRendererStatistics?.() || {};
      const compatibilityBufferDiagnostics =
        context?._gl?.getCompatibilityBufferDiagnostics?.() || null;
      return {
        name: snapshotName,
        backend: context?.isWebGPU ? "webgpu" : "webgl",
        contextId: context?.id || context?._id || null,
        prototypePatchAvailable: audit.prototypePatchAvailable,
        prototypePatchFailures: [...audit.prototypePatchFailures],
        canvasContexts: { ...audit.canvasContexts },
        buffers: audit.buffers.map((record) => ({ ...record })),
        textures: audit.textures.map((record) => ({ ...record })),
        counters: { ...audit.counters },
        rendererStats,
        compatibilityBufferDiagnostics,
        visibleTiles: tiles.length,
        tilesWithLegacyVertexArray,
        visibleMeshVertexBytes,
        visibleMeshIndexBytes,
      };
    }, name);
    return {
      ...raw,
      bufferSummary: summarize(raw.buffers),
      textureSummary: summarize(raw.textures),
    };
  }

  const globe = await snapshot("globe-settled");

  await page.evaluate(async () => {
    const Cesium = await import("/Build/CesiumUnminified/index.js");
    globalThis.__allocationAuditPrimitive =
      globalThis.viewer.scene.primitives.add(
        new Cesium.Primitive({
          geometryInstances: new Cesium.GeometryInstance({
            geometry: new Cesium.RectangleGeometry({
              rectangle: Cesium.Rectangle.fromDegrees(
                -110.0,
                35.0,
                -109.0,
                36.0,
              ),
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                Cesium.Color.RED,
              ),
            },
          }),
          appearance: new Cesium.PerInstanceColorAppearance({ flat: true }),
          asynchronous: false,
        }),
      );
  });
  await page.waitForFunction(
    () => globalThis.__allocationAuditPrimitive?.ready === true,
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(1_000);
  const primitive = await snapshot("primitive-settled");

  await page.evaluate(async () => {
    const Cesium = await import("/Build/CesiumUnminified/index.js");
    const model = await Cesium.Model.fromGltfAsync({
      url: "/Apps/SampleData/models/CesiumMan/Cesium_Man.glb",
    });
    globalThis.__allocationAuditModel =
      globalThis.viewer.scene.primitives.add(model);
  });
  await page.waitForFunction(
    () => globalThis.__allocationAuditModel?.ready === true,
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(2_000);
  const model = await snapshot("model-settled");

  await page.evaluate(() => {
    const primitives = globalThis.viewer.scene.primitives;
    primitives.remove(globalThis.__allocationAuditModel);
    primitives.remove(globalThis.__allocationAuditPrimitive);
    globalThis.__allocationAuditModel = undefined;
    globalThis.__allocationAuditPrimitive = undefined;
  });
  await page.waitForTimeout(2_000);
  const afterRemoval = await snapshot("after-test-content-removal");

  const webglContextCalls =
    (globe.canvasContexts.webgl || 0) +
    (globe.canvasContexts.webgl2 || 0) +
    (globe.canvasContexts["experimental-webgl"] || 0);
  const compatibilityBuffers = globe.bufferSummary.filter(
    (entry) => entry.owner === "compatibility",
  );
  const compatibilityResources = {
    buffers: afterRemoval.bufferSummary.filter(
      (entry) => entry.owner === "compatibility",
    ),
    textures: afterRemoval.textureSummary.filter(
      (entry) => entry.owner === "compatibility",
    ),
  };
  const failures = [];
  if (globe.backend !== "webgpu")
    failures.push("resolved backend is not WebGPU");
  if (!globe.prototypePatchAvailable) {
    failures.push("essential WebGPU prototypes could not be instrumented");
  }
  if (webglContextCalls !== 0) {
    failures.push(`explicit WebGPU opened ${webglContextCalls} WebGL contexts`);
  }
  if (pageErrors.length)
    failures.push(`${pageErrors.length} uncaught page errors`);
  if (options.strictNative && compatibilityResources.buffers.length) {
    failures.push(
      `${compatibilityResources.buffers.length} compatibility buffer label groups were created`,
    );
  }

  report = {
    schemaVersion: 1,
    kind: "webgpu-allocation-tax",
    generatedAt: new Date().toISOString(),
    sourceUrl: url.href,
    runtimeBundle,
    browser: "msedge",
    strictNative: options.strictNative,
    result: failures.length ? "fail" : "pass",
    failures,
    pageErrors,
    consoleErrors: consoleErrors.slice(0, 25),
    globe: {
      backend: globe.backend,
      contextId: globe.contextId,
      prototypePatchAvailable: globe.prototypePatchAvailable,
      prototypePatchFailures: globe.prototypePatchFailures,
      canvasContexts: globe.canvasContexts,
      visibleTiles: globe.visibleTiles,
      tilesWithLegacyVertexArray: globe.tilesWithLegacyVertexArray,
      visibleMeshVertexBytes: globe.visibleMeshVertexBytes,
      visibleMeshIndexBytes: globe.visibleMeshIndexBytes,
      totalBuffersCreated: globe.buffers.length,
      totalBufferBytesCreated: totalBytes(globe.buffers),
      liveBuffers: live(globe.buffers).length,
      liveBufferBytes: totalBytes(live(globe.buffers)),
      totalTexturesCreated: globe.textures.length,
      totalTextureBytesCreated: totalBytes(globe.textures),
      liveTextures: live(globe.textures).length,
      liveTextureBytes: totalBytes(live(globe.textures)),
      counters: globe.counters,
      compatibilityBuffers,
      terrainBuffers: globe.bufferSummary.filter(
        (entry) =>
          entry.label.startsWith("Terrain VB") ||
          entry.label.startsWith("Terrain IB"),
      ),
      topBuffers: globe.bufferSummary.slice(0, 30),
      topTextures: globe.textureSummary.slice(0, 20),
      engineStatistics: globe.rendererStats,
      compatibilityBufferDiagnostics: globe.compatibilityBufferDiagnostics,
    },
    primitiveDelta: delta(primitive, globe),
    modelDelta: delta(model, primitive),
    removalDelta: delta(afterRemoval, model),
    compatibilityResources,
    compatibilityBufferLifecycle: {
      globe: globe.compatibilityBufferDiagnostics,
      primitive: primitive.compatibilityBufferDiagnostics,
      model: model.compatibilityBufferDiagnostics,
      afterRemoval: afterRemoval.compatibilityBufferDiagnostics,
    },
    afterRemoval: {
      liveBuffers: live(afterRemoval.buffers).length,
      liveBufferBytes: totalBytes(live(afterRemoval.buffers)),
      liveTextures: live(afterRemoval.textures).length,
      liveTextureBytes: totalBytes(live(afterRemoval.textures)),
      counters: afterRemoval.counters,
    },
    limitations: [
      "API-boundary byte totals exclude driver-private allocation.",
      "Texture byte totals are descriptor estimates.",
      "Unlabelled/native-labelled records do not prove logical ownership; use engine ownership events for that.",
      "A GLStub-labelled texture proves compatibility-shaped construction, not a duplicate physical texture; pair this report with decoded/backend realization ownership events.",
      "GPUBuffer/GPUTexture destruction records explicit destroy calls, not garbage collection.",
    ],
  };
} catch (error) {
  report = {
    schemaVersion: 1,
    kind: "webgpu-allocation-tax",
    generatedAt: new Date().toISOString(),
    sourceUrl: url.href,
    runtimeBundle,
    result: "error",
    failures: [String(error?.stack || error)],
  };
} finally {
  await browser?.close();
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (options.output) {
  const outputPath = resolve(options.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, "utf8");
  console.error(`Wrote ${outputPath}`);
}
console.log(serialized);
if (report.result !== "pass") process.exitCode = 1;
