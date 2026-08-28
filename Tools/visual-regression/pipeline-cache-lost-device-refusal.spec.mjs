/**
 * @purpose Guards the render, compute and globe pipeline producers against building on a GPUDevice that is already lost, and the early failure signal that pauses speculative pre-cooking before the lost promise settles.
 * @status ACTIVE
 *
 * A lost device does not refuse work. It accepts every creation call and
 * rejects it, one per request, for as long as producers keep asking - which is
 * until recovery publishes a replacement, not until the loss is noticed. On a
 * genuine GPU-process termination that is seconds of doomed pipeline creation
 * from a scene that has no idea anything is wrong.
 *
 * These tests drive the real caches and the real globe pipeline helpers with
 * two device identities, and assert by instance which device the creation
 * calls reached. The refusal must be device-scoped: a live sibling device in
 * the same session has to keep building.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const engineWebGPU = resolve(
  directory,
  "../../packages/engine/Source/Renderer/WebGPU",
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js") &&
      typeof context.parentURL === "string" &&
      context.parentURL.startsWith("file:")
    ) {
      const asJs = new URL(specifier, context.parentURL);
      if (
        asJs.pathname.includes("/packages/engine/Source/Shaders/") &&
        !fs.existsSync(fileURLToPath(asJs))
      ) {
        return {
          url: "data:text/javascript,export default%20%22%22%3B",
          shortCircuit: true,
        };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) {
      const source = fs.readFileSync(fileURLToPath(url), "utf8");
      return {
        format: "module",
        source: ts.transpileModule(source, {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
            verbatimModuleSyntax: false,
          },
        }).outputText,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

enableEngineTsResolution();

const { clearDeviceSuspect, isDeviceSuspect, markDeviceLost } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUDeviceInvalidationBus.ts")).href
);
const { WebGPURenderPipelineCache } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPURenderPipelineCache.ts")).href
);
const { WebGPUComputePipelineCache } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUComputePipelineCache.ts")).href
);
const {
  resolveGlobePipelineEntry,
  resolveCapturePipelineEntrySync,
  selectPickPipeline,
} = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUGlobeSurfacePipelines.ts")).href
);
const { buildGlobePipelineCacheKey } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUGlobeSurfacePipelineKey.ts")).href
);

/**
 * Counts creation calls on the device object itself, so an assertion names
 * which device received the work. `failWith` makes the next creation reject,
 * which is how a dying device answers before its lost promise settles.
 */
function fakeDevice(name) {
  const device = {
    name,
    features: new Set(),
    limits: {},
    renderPipelineCalls: 0,
    computePipelineCalls: 0,
    failWith: null,
  };
  const maybeFail = () => {
    const failure = device.failWith;
    if (failure) {
      device.failWith = null;
      throw failure;
    }
  };
  device.createShaderModule = () => ({ kind: "shaderModule", device });
  device.createRenderPipelineAsync = async () => {
    device.renderPipelineCalls++;
    maybeFail();
    return { kind: "renderPipeline", device };
  };
  device.createRenderPipeline = () => {
    device.renderPipelineCalls++;
    maybeFail();
    return { kind: "renderPipeline", device };
  };
  device.createComputePipelineAsync = async () => {
    device.computePipelineCalls++;
    maybeFail();
    return { kind: "computePipeline", device };
  };
  device.lost = new Promise(() => {});
  device.destroy = () => {};
  return device;
}

function renderDescriptor(name, device) {
  const module = device.createShaderModule();
  return {
    name,
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: "bgra8unorm" }] },
  };
}

function computeDescriptor(name, device) {
  return {
    name,
    layout: "auto",
    compute: { module: device.createShaderModule(), entryPoint: "main" },
  };
}

function globeEntry(name, device) {
  return {
    descriptor: renderDescriptor(name, device),
    pipeline: null,
    pending: false,
  };
}

async function settleMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

async function expectRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the request to be declined");
}

// -- Render-pipeline cache -------------------------------------------------

test("the render cache refuses a lost device and keeps serving a live one", async () => {
  const dead = fakeDevice("render-dead");
  const live = fakeDevice("render-live");
  const deadCache = new WebGPURenderPipelineCache(dead, "ctx-dead");
  const liveCache = new WebGPURenderPipelineCache(live, "ctx-live");

  markDeviceLost(dead);

  const error = await expectRejection(
    deadCache.getPipeline(renderDescriptor("Globe terrain", dead)),
  );
  assert.match(String(error.message), /GPUDevice is lost/);
  assert.equal(
    dead.renderPipelineCalls,
    0,
    "the refusal must land before the device is touched",
  );

  await liveCache.getPipeline(renderDescriptor("Globe terrain", live));
  assert.equal(
    live.renderPipelineCalls,
    1,
    "a sibling device must not inherit the refusal",
  );
});

test("speculative warming stops on a lost device", async () => {
  const dead = fakeDevice("warm-dead");
  markDeviceLost(dead);
  const cache = new WebGPURenderPipelineCache(dead, "ctx-warm");
  cache.warm(renderDescriptor("SkyAtmosphere pipeline", dead));
  await settleMicrotasks();
  assert.equal(dead.renderPipelineCalls, 0);
});

test("a non-validation rejection pauses warming; a validation rejection does not", async () => {
  const device = fakeDevice("suspect-render");
  clearDeviceSuspect(device);
  const cache = new WebGPURenderPipelineCache(device, "ctx-suspect");

  // A dying GPU process answers a creation call with something other than a
  // validation error, well before `device.lost` settles.
  device.failWith = Object.assign(
    new Error("A valid external Instance reference no longer exists"),
    { reason: "internal" },
  );
  await expectRejection(cache.getPipeline(renderDescriptor("Globe A", device)));
  assert.equal(isDeviceSuspect(device), true);

  const afterFirstFailure = device.renderPipelineCalls;
  cache.warm(renderDescriptor("Globe B", device));
  await settleMicrotasks();
  assert.equal(
    device.renderPipelineCalls,
    afterFirstFailure,
    "warming must wait while the device is under suspicion",
  );

  // A completed creation is the only evidence that withdraws suspicion.
  await cache.getPipeline(renderDescriptor("Globe C", device));
  assert.equal(isDeviceSuspect(device), false);
  cache.warm(renderDescriptor("Globe D", device));
  await settleMicrotasks();
  assert.equal(
    device.renderPipelineCalls,
    afterFirstFailure + 2,
    "warming resumes once the device answers",
  );

  // A broken shader must not be read as a broken device.
  clearDeviceSuspect(device);
  device.failWith = Object.assign(new Error("shader is wrong"), {
    reason: "validation",
  });
  await expectRejection(cache.getPipeline(renderDescriptor("Globe E", device)));
  assert.equal(
    isDeviceSuspect(device),
    false,
    "a validation failure describes the work, not the device",
  );
});

// -- Compute-pipeline cache ------------------------------------------------

test("the compute cache refuses a lost device and keeps serving a live one", async () => {
  const dead = fakeDevice("compute-dead");
  const live = fakeDevice("compute-live");
  markDeviceLost(dead);

  const deadCache = new WebGPUComputePipelineCache(dead, "ctx-dead");
  const error = await expectRejection(
    deadCache.getPipeline(computeDescriptor("atmosphereLUT", dead)),
  );
  assert.match(String(error.message), /GPUDevice is lost/);
  assert.equal(dead.computePipelineCalls, 0);

  const liveCache = new WebGPUComputePipelineCache(live, "ctx-live");
  await liveCache.getPipeline(computeDescriptor("atmosphereLUT", live));
  assert.equal(live.computePipelineCalls, 1);
});

test("the compute cache raises the same early failure signal", async () => {
  const device = fakeDevice("suspect-compute");
  clearDeviceSuspect(device);
  const cache = new WebGPUComputePipelineCache(device, "ctx-suspect-compute");
  device.failWith = Object.assign(new Error("instance gone"), {
    reason: "internal",
  });
  await expectRejection(cache.getPipeline(computeDescriptor("cull", device)));
  assert.equal(isDeviceSuspect(device), true);
  clearDeviceSuspect(device);
});

// -- Globe helpers that bypass the central cache ---------------------------

test("the globe direct-create fallback declines a lost device", () => {
  const dead = fakeDevice("globe-dead");
  const live = fakeDevice("globe-live");
  markDeviceLost(dead);

  const deadHost = { _device: dead, _centralPipelineCache: null };
  const deadEntry = globeEntry("Globe terrain (fallback)", dead);
  assert.equal(resolveGlobePipelineEntry(deadHost, deadEntry), null);
  assert.equal(
    deadEntry.pending,
    false,
    "a declined entry must not stay pending",
  );
  assert.equal(dead.renderPipelineCalls, 0);

  const liveHost = { _device: live, _centralPipelineCache: null };
  const liveEntry = globeEntry("Globe terrain (fallback)", live);
  assert.notEqual(resolveGlobePipelineEntry(liveHost, liveEntry), null);
  assert.equal(live.renderPipelineCalls, 1);
});

test("the capture pipeline declines a lost device the way it declines an absent one", () => {
  const dead = fakeDevice("capture-dead");
  const live = fakeDevice("capture-live");
  markDeviceLost(dead);

  assert.equal(
    resolveCapturePipelineEntrySync(
      { _device: dead, _centralPipelineCache: null },
      globeEntry("Globe terrain capture", dead),
    ),
    null,
  );
  assert.equal(dead.renderPipelineCalls, 0);

  assert.notEqual(
    resolveCapturePipelineEntrySync(
      { _device: live, _centralPipelineCache: null },
      globeEntry("Globe terrain capture", live),
    ),
    null,
  );
  assert.equal(live.renderPipelineCalls, 1);
});

test("the globe pick pipeline declines a lost device", () => {
  const dead = fakeDevice("pick-dead");
  const live = fakeDevice("pick-live");
  markDeviceLost(dead);

  // Seeding the entry the selector would otherwise derive keeps this test on
  // the creation guard rather than on the descriptor factory, which needs the
  // whole shader-factory surface and is pinned by its own suite.
  const key = buildGlobePipelineCacheKey({
    kind: "pick",
    isQuantized: false,
    hasNormals: false,
    hasWebMercatorT: false,
    isBlend: false,
    strideBytes: 28,
    useClipDistances: false,
    defines: 0,
  });
  const hostFor = (device) => ({
    _device: device,
    _pipelineCache: new Map([[key, globeEntry("Globe terrain pick", device)]]),
  });

  const deadHost = hostFor(dead);
  assert.equal(
    selectPickPipeline(deadHost, false, false, false, 28),
    null,
    "a lost device yields no pick pipeline",
  );
  assert.equal(dead.renderPipelineCalls, 0);

  const liveHost = hostFor(live);
  assert.notEqual(selectPickPipeline(liveHost, false, false, false, 28), null);
  assert.equal(live.renderPipelineCalls, 1);
});
