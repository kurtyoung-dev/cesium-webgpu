// device-limits-dial.spec.mjs - the default-limits device dial, run as the page runs it.
//
// @purpose Node spec for lib/device-limits-dial.mjs: the real init source runs against a fake GPUAdapter class installed on a fake page's global, and asserts that the descriptor reaching the original requestDevice has no requiredLimits and keeps requiredFeatures and the label, that what the page asked for is recorded and the page's own descriptor left untouched, that the comparator reads equal for a device reporting the defaults and names the key for one that differs, and the page reader and summary line, with an inertness mutant for the stripping.
// @status ACTIVE
//
// The dial is a page init script, so it is run here the way a page runs it:
// its source text evaluated in a fresh `vm` context whose global carries the
// fake `GPUAdapter`. The fake adapter keeps every descriptor the original
// `requestDevice` receives, which is what the assertions read.

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  DEVICE_LIMITS_DIAL_INIT_SOURCE,
  DEVICE_LIMITS_MODE,
  WEBGPU_DEFAULT_LIMITS,
  compareDeviceLimits,
  deviceLimitsLine,
  pageReadDeviceLimits,
  readDeviceLimits,
} from "./lib/device-limits-dial.mjs";
import { importMutated } from "./lib/import-mutated.mjs";

const DIAL_MODULE = fileURLToPath(
  new URL("./lib/device-limits-dial.mjs", import.meta.url),
);

/**
 * A fake page whose global has a GPUAdapter whose requestDevice keeps what it
 * received and answers a device reporting `deviceLimits` (read through
 * prototype getters, the way a browser's GPUSupportedLimits reads).
 */
function makePage({
  source = DEVICE_LIMITS_DIAL_INIT_SOURCE,
  deviceLimits = WEBGPU_DEFAULT_LIMITS,
  viewer = true,
} = {}) {
  const context = vm.createContext({});
  vm.runInContext(
    `
    globalThis.__received = [];
    globalThis.GPUSupportedLimits = class GPUSupportedLimits {};
    for (const [key, value] of Object.entries(${JSON.stringify(deviceLimits)})) {
      Object.defineProperty(GPUSupportedLimits.prototype, key, { get() { return value; } });
    }
    globalThis.GPUAdapter = class GPUAdapter {
      async requestDevice(descriptor, ...rest) {
        globalThis.__received.push({ descriptor, rest, self: this === globalThis.__adapter });
        return { limits: new GPUSupportedLimits(), lost: null };
      }
    };
    globalThis.__adapter = new GPUAdapter();
    `,
    context,
  );
  vm.runInContext(source, context);
  if (viewer) {
    vm.runInContext(`globalThis.viewer = { scene: { context: {} } };`, context);
  }
  return {
    context,
    run(code) {
      return vm.runInContext(code, context);
    },
    /** The page requests its device the way the engine's device pool does. */
    async requestDevice(descriptorSource) {
      const result = await vm.runInContext(
        `(async () => {
           const descriptor = ${descriptorSource};
           globalThis.__pageDescriptor = descriptor;
           const device = await __adapter.requestDevice(descriptor, "extra");
           if (globalThis.viewer) { globalThis.viewer.scene.context.device = device; }
           return device;
         })()`,
        context,
      );
      return result;
    },
    async evaluate(fn, arg) {
      const f = vm.runInContext(`(${fn.toString()})`, context);
      return JSON.parse(JSON.stringify(await f(arg)));
    },
  };
}

const ASKED = `{
  label: "viewer device",
  requiredFeatures: ["timestamp-query", "float32-filterable"],
  requiredLimits: { maxBindGroups: 8, maxSampledTexturesPerShaderStage: 32 },
  defaultQueue: { label: "q" },
}`;

const received = (page) => JSON.parse(page.run("JSON.stringify(__received)"));

test("the descriptor reaching the original requestDevice has no requiredLimits and keeps every other field", async () => {
  const page = makePage();
  await page.requestDevice(ASKED);
  const [call] = received(page);
  assert.equal(call.self, true, "the original runs on the adapter");
  assert.deepEqual(call.rest, ["extra"], "extra arguments pass through");
  assert.equal(Object.hasOwn(call.descriptor, "requiredLimits"), false);
  assert.deepEqual(call.descriptor, {
    label: "viewer device",
    requiredFeatures: ["timestamp-query", "float32-filterable"],
    defaultQueue: { label: "q" },
  });
});

test("what the page asked for is recorded and the page's own descriptor is left untouched", async () => {
  const page = makePage();
  await page.requestDevice(ASKED);
  const [request] = JSON.parse(
    page.run("JSON.stringify(__deviceLimitsDial.requests)"),
  );
  assert.deepEqual(request, {
    requiredLimits: { maxBindGroups: 8, maxSampledTexturesPerShaderStage: 32 },
    requiredFeatures: ["timestamp-query", "float32-filterable"],
    label: "viewer device",
  });
  const own = JSON.parse(page.run("JSON.stringify(__pageDescriptor)"));
  assert.deepEqual(own.requiredLimits, {
    maxBindGroups: 8,
    maxSampledTexturesPerShaderStage: 32,
  });
});

test("a request with no descriptor, or none for limits, passes through and records null limits", async () => {
  const page = makePage();
  await page.requestDevice(`{ requiredFeatures: ["depth-clip-control"] }`);
  await page.requestDevice(`undefined`);
  const calls = received(page);
  assert.deepEqual(calls[0].descriptor, {
    requiredFeatures: ["depth-clip-control"],
  });
  assert.equal(calls[1].descriptor, undefined);
  const requests = JSON.parse(
    page.run("JSON.stringify(__deviceLimitsDial.requests)"),
  );
  assert.deepEqual(
    requests.map((r) => r.requiredLimits),
    [null, null],
  );
});

test("the comparator reads equal for a device reporting the defaults and names the key for one that differs", () => {
  const equal = compareDeviceLimits({ ...WEBGPU_DEFAULT_LIMITS });
  assert.equal(equal.equal, true);
  assert.deepEqual(equal.differing, []);
  assert.equal(equal.compared, Object.keys(WEBGPU_DEFAULT_LIMITS).length);

  const differs = compareDeviceLimits({
    ...WEBGPU_DEFAULT_LIMITS,
    maxBindGroups: 8,
  });
  assert.equal(differs.equal, false);
  assert.deepEqual(differs.differing, [
    { key: "maxBindGroups", device: 8, default: 4 },
  ]);

  const partial = compareDeviceLimits({ maxBindGroups: 4 });
  assert.equal(
    partial.equal,
    false,
    "a key the device did not report is not equal",
  );
  assert.equal(partial.differing.length, 0);
  assert.ok(partial.missing.includes("maxBufferSize"));
  assert.equal(
    compareDeviceLimits({}).equal,
    false,
    "nothing compared is not equal",
  );
});

test("the default table carries the specification's per-stage binding limits, bind groups, textures and buffers", () => {
  assert.equal(WEBGPU_DEFAULT_LIMITS.maxSampledTexturesPerShaderStage, 16);
  assert.equal(WEBGPU_DEFAULT_LIMITS.maxUniformBuffersPerShaderStage, 12);
  assert.equal(WEBGPU_DEFAULT_LIMITS.maxStorageBuffersPerShaderStage, 8);
  assert.equal(WEBGPU_DEFAULT_LIMITS.maxSamplersPerShaderStage, 16);
  assert.equal(WEBGPU_DEFAULT_LIMITS.maxStorageTexturesPerShaderStage, 4);
  assert.equal(WEBGPU_DEFAULT_LIMITS.maxBindGroups, 4);
  assert.equal(WEBGPU_DEFAULT_LIMITS.maxTextureDimension2D, 8192);
  assert.equal(WEBGPU_DEFAULT_LIMITS.maxBufferSize, 268435456);
  assert.equal(WEBGPU_DEFAULT_LIMITS.maxUniformBufferBindingSize, 65536);
  assert.equal(WEBGPU_DEFAULT_LIMITS.maxStorageBufferBindingSize, 134217728);
  assert.ok(Object.isFrozen(WEBGPU_DEFAULT_LIMITS));
});

test("readDeviceLimits reports the request, the device's limits and the comparison through a page's evaluate", async () => {
  const page = makePage();
  await page.requestDevice(ASKED);
  const read = await readDeviceLimits(page);
  assert.equal(read.mode, DEVICE_LIMITS_MODE);
  assert.equal(read.installed, true);
  assert.equal(read.device.found, true);
  assert.equal(read.requested[0].requiredLimits.maxBindGroups, 8);
  assert.equal(read.comparison.equal, true, "the fake device got the defaults");
  const line = deviceLimitsLine(read);
  assert.match(line, /the page asked for 2 limits/u);
  assert.match(line, /reports the WebGPU defaults on \d+ keys/u);
});

test("a device whose limits differ from the defaults is named in the record and the summary line", async () => {
  const page = makePage({
    deviceLimits: {
      ...WEBGPU_DEFAULT_LIMITS,
      maxSampledTexturesPerShaderStage: 24,
    },
  });
  await page.requestDevice(ASKED);
  const read = await readDeviceLimits(page);
  assert.equal(read.comparison.equal, false);
  assert.deepEqual(read.comparison.differing, [
    { key: "maxSampledTexturesPerShaderStage", device: 24, default: 16 },
  ]);
  assert.match(
    deviceLimitsLine(read),
    /differs from the WebGPU defaults: maxSampledTexturesPerShaderStage 24 \(default 16\)/u,
  );
});

test("a page with no dial installed or no device reads as such", async () => {
  const bare = makePage({ source: "" });
  await bare.requestDevice(ASKED);
  const none = await readDeviceLimits(bare);
  assert.equal(none.installed, false);
  assert.match(deviceLimitsLine(none), /dial not installed/u);

  const noViewer = makePage({ viewer: false });
  const missing = await readDeviceLimits(noViewer);
  assert.equal(missing.installed, true);
  assert.equal(missing.device.found, false);
  assert.match(deviceLimitsLine(missing), /no device found/u);
  assert.match(deviceLimitsLine(null), /not recorded/u);
});

test("a page without GPUAdapter gets installed: false, and installing twice wraps once", async () => {
  const context = vm.createContext({});
  vm.runInContext(DEVICE_LIMITS_DIAL_INIT_SOURCE, context);
  assert.equal(vm.runInContext("__deviceLimitsDial.installed", context), false);

  const page = makePage();
  vm.runInContext(DEVICE_LIMITS_DIAL_INIT_SOURCE, page.context);
  await page.requestDevice(ASKED);
  assert.equal(received(page).length, 1);
  assert.equal(
    JSON.parse(page.run("JSON.stringify(__deviceLimitsDial.requests)")).length,
    1,
  );
});

test("pageReadDeviceLimits reads only the keys it is given", async () => {
  const page = makePage();
  await page.requestDevice(ASKED);
  const raw = await page.evaluate(pageReadDeviceLimits, {
    keys: ["maxBindGroups"],
  });
  assert.deepEqual(raw.device.limits, { maxBindGroups: 4 });
});

test("inertness mutant: the stripping made unreachable lets requiredLimits through", async () => {
  const mutated = await importMutated(DIAL_MODULE, [
    [
      'if (given && "requiredLimits" in descriptor) {',
      'if (false && given && "requiredLimits" in descriptor) {',
    ],
  ]);
  const page = makePage({ source: mutated.DEVICE_LIMITS_DIAL_INIT_SOURCE });
  await page.requestDevice(ASKED);
  const [call] = received(page);
  assert.equal(Object.hasOwn(call.descriptor, "requiredLimits"), true);
});
