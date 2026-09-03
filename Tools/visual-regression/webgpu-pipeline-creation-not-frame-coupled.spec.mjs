// webgpu-pipeline-creation-not-frame-coupled.spec.mjs — the frame-independence
// contract of the central WebGPU pipeline cache, executed against the real
// engine module. Pure Node: no browser, no GPU, no build.
//
// @purpose Drives the real central pipeline cache with a fake device to require that an in-flight pipeline creation advances, lands and publishes its wake-up without any frame being rendered and without any concurrency cap, so the frame-coupled explanations of the AEC residency stall stay ruled out.
// @status ACTIVE
//
// ── WHY THESE PROPERTIES, AND WHY NOW ───────────────────────────────────────
//
// The AEC design-model residency measurement showed the WebGPU settle window
// spending most of its wall clock inside a handful of multi-second waits with
// the pipeline cache holding several requests pending across them. Four
// frame-coupled explanations were offered for that shape before anyone read
// the cache:
//
//   * creation advances only one step per rendered frame;
//   * a resolution lands but nothing wakes the scene, so the frame that would
//     consume the pipeline is never scheduled;
//   * a cap holds concurrent creations down to a trickle;
//   * shader-module compilation is serialised behind a lock.
//
// None of them is what this module does, and the measurement is better
// explained without them. That makes these four properties load-bearing
// NEGATIVE facts: the diagnosis rests on them, so they need a guard that fails
// if a later change quietly introduces any of them. That is what this file is.
// It is not a test of a fix; it is the fence around a ruled-out region.
//
// ── HOW EACH PROPERTY IS PUT AT RISK ────────────────────────────────────────
//
// Every test drives the REAL `WebGPURenderPipelineCache` and the REAL
// `AsyncResourceMonitor` through one bundle, so they share the module graph
// they share at runtime. The device is a fake whose `createRenderPipelineAsync`
// hands back a promise the test resolves by hand — which is the only way to ask
// "did anything have to happen in between?", because a promise that resolves on
// its own answers the question before it can be posed.
//
// Nothing here renders a frame, calls `requestRender`, or advances a frame
// number. That absence IS the assertion: if creation needed a frame, these
// tests could not pass.
//
// Run: node --test Tools/visual-regression/webgpu-pipeline-creation-not-frame-coupled.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bundle } from "./lib/engine-stub-bundler.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const engineWebGPU = resolve(
  directory,
  "../../packages/engine/Source/Renderer/WebGPU",
);
const CACHE_PATH = resolve(engineWebGPU, "WebGPURenderPipelineCache.ts");
const ENTRY_PATH = resolve(
  engineWebGPU,
  "__pipeline-creation-not-frame-coupled.ts",
);
const ENTRY_SOURCE = [
  'export { WebGPURenderPipelineCache } from "./WebGPURenderPipelineCache.js";',
  'export { AsyncResourceMonitor } from "./AsyncResourceMonitor.js";',
  "",
].join("\n");

// The invalidation bus must stay REAL. Stubbed, `isDeviceLost` returns a Proxy,
// which is truthy, and the cache refuses every creation — every test would then
// fail for a reason the harness invented rather than for the reason it names.
const REAL = [
  "WebGPURenderPipelineCache",
  "AsyncResourceMonitor",
  "WebGPUDeviceInvalidationBus",
];

/**
 * Bundles the cache and the monitor through one entry.
 *
 * @param {object} [options] Optional source rewrite, as `{mutate, label}`
 *   applied to `WebGPURenderPipelineCache.ts`.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 */
async function loadEngine(options = {}) {
  return bundle({
    path: ENTRY_PATH,
    source: ENTRY_SOURCE,
    real: REAL,
    preseed: [CACHE_PATH],
    overrides: options.mutate
      ? [
          {
            basename: "WebGPURenderPipelineCache",
            mutate: options.mutate,
            label: options.label,
          },
        ]
      : [],
  });
}

/**
 * A device whose pipeline creations are settled by the test, so "did this need
 * a frame?" is answerable.
 *
 * @returns {object} The fake device and its creation log.
 */
function makeDevice() {
  const inflight = [];
  const device = {
    label: "fake",
    createRenderPipelineAsync(descriptor) {
      return new Promise((settle, fail) => {
        inflight.push({
          descriptor,
          settle: () => settle({ __pipeline: descriptor.label }),
          fail,
        });
      });
    },
    pushErrorScope() {},
    popErrorScope() {
      return Promise.resolve(null);
    },
  };
  return { device, inflight };
}

/**
 * A pipeline descriptor whose shader modules are distinct objects per name, so
 * the cache's module-identity fold gives each name its own key.
 *
 * @param {string} name Descriptor name.
 * @returns {object} A descriptor the cache accepts.
 */
function makeDescriptor(name) {
  return {
    name,
    layout: { __layout: name },
    vertex: {
      module: { __module: `${name}:vs` },
      entryPoint: "vertexMain",
      buffers: [],
    },
    fragment: {
      module: { __module: `${name}:fs` },
      entryPoint: "fragmentMain",
      targets: [{ format: "bgra8unorm" }],
    },
  };
}

/**
 * Lets already-queued microtasks run. It advances no frame and requests no
 * render — the point is that this is ALL that is needed.
 *
 * @returns {Promise<void>} Resolves after the microtask queue drains.
 */
async function settleMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const engine = await loadEngine();
const { WebGPURenderPipelineCache, AsyncResourceMonitor } = engine;

// ── A. CREATION ADVANCES WITHOUT A FRAME ────────────────────────────────────

test("A1 a request goes inflight and is counted pending with no frame rendered", async () => {
  const { device, inflight } = makeDevice();
  const cache = new WebGPURenderPipelineCache(device, "ctx-a1");

  const pending = cache.getPipeline(makeDescriptor("alpha"));
  await settleMicrotasks();

  assert.equal(inflight.length, 1, "the device was never asked to create");
  assert.equal(cache.getStats().pending, 1);
  assert.equal(cache.getStats().created, 0);
  // Keep the promise from becoming an unhandled rejection at teardown.
  inflight[0].settle();
  await pending;
});

test("A2 resolving the device promise lands the pipeline with no frame rendered", async () => {
  const { device, inflight } = makeDevice();
  const cache = new WebGPURenderPipelineCache(device, "ctx-a2");

  const request = cache.getPipeline(makeDescriptor("beta"));
  await settleMicrotasks();
  inflight[0].settle();
  const pipeline = await request;

  assert.ok(pipeline, "no pipeline came back");
  const stats = cache.getStats();
  assert.equal(stats.created, 1);
  assert.equal(stats.pending, 0);
});

test("A3 the landed pipeline is served synchronously on the next lookup", async () => {
  const { device, inflight } = makeDevice();
  const cache = new WebGPURenderPipelineCache(device, "ctx-a3");
  const descriptor = makeDescriptor("gamma");

  const request = cache.getPipeline(descriptor);
  await settleMicrotasks();
  // Before it lands, the ready gate has nothing to give.
  assert.equal(cache.getPipelineSync(descriptor), undefined);
  inflight[0].settle();
  await request;

  // After it lands, and still without a frame, the gate opens.
  assert.ok(cache.getPipelineSync(descriptor));
  assert.equal(cache.getStats().hits, 1);
});

// ── B. NO CONCURRENCY CAP ───────────────────────────────────────────────────

test("B1 twelve distinct requests are all inflight at once", async () => {
  const { device, inflight } = makeDevice();
  const cache = new WebGPURenderPipelineCache(device, "ctx-b1");

  const requests = [];
  for (let index = 0; index < 12; index++) {
    requests.push(cache.getPipeline(makeDescriptor(`variant-${index}`)));
  }
  await settleMicrotasks();

  assert.equal(
    inflight.length,
    12,
    `only ${inflight.length} of 12 reached the device — something is capping ` +
      `or queueing concurrent creations`,
  );
  assert.equal(cache.getStats().pending, 12);

  for (const entry of inflight) {
    entry.settle();
  }
  await Promise.all(requests);
  assert.equal(cache.getStats().created, 12);
  assert.equal(cache.getStats().pending, 0);
});

test("B2 a second request for the same key does not create twice", async () => {
  const { device, inflight } = makeDevice();
  const cache = new WebGPURenderPipelineCache(device, "ctx-b2");
  const descriptor = makeDescriptor("shared");

  const first = cache.getPipeline(descriptor);
  const second = cache.getPipeline(descriptor);
  await settleMicrotasks();

  assert.equal(inflight.length, 1);
  assert.equal(cache.getStats().pending, 1);
  inflight[0].settle();
  assert.equal(await first, await second);
});

test("B3 later requests are not blocked behind an unresolved earlier one", async () => {
  const { device, inflight } = makeDevice();
  const cache = new WebGPURenderPipelineCache(device, "ctx-b3");

  const slow = cache.getPipeline(makeDescriptor("slow"));
  await settleMicrotasks();
  const fast = cache.getPipeline(makeDescriptor("fast"));
  await settleMicrotasks();

  // Settle the SECOND one only. If creation were serialised behind a lock this
  // could not land while the first is still outstanding.
  const fastEntry = inflight.find((entry) => entry.descriptor.label === "fast");
  assert.ok(fastEntry, "the second request never reached the device");
  fastEntry.settle();
  assert.ok(await fast);
  assert.equal(cache.getStats().created, 1);
  assert.equal(
    cache.getStats().pending,
    1,
    "the first request should still be open",
  );

  inflight.find((entry) => entry.descriptor.label === "slow").settle();
  await slow;
});

// ── C. THE WAKE-UP IS PUBLISHED, AND PUBLISHED LATE ENOUGH ──────────────────

test("C1 a resolution publishes a monitor event a subscriber receives", async () => {
  const { device, inflight } = makeDevice();
  const monitor = new AsyncResourceMonitor("ctx-c1");
  const cache = new WebGPURenderPipelineCache(
    device,
    "ctx-c1",
    undefined,
    monitor,
  );

  const events = [];
  monitor.subscribe((event) => events.push(event.kind));

  const request = cache.getPipeline(makeDescriptor("woken"));
  await settleMicrotasks();
  assert.deepEqual(events, ["started"]);

  inflight[0].settle();
  await request;
  assert.deepEqual(events, ["started", "resolved"]);
});

test("C2 a subscriber that looks the pipeline up from inside the wake-up finds it", async () => {
  // This is the ordering that makes the wake-up useful rather than merely
  // emitted: a scene woken by the event renders on a later turn, but anything
  // that reads the cache from the handler itself must already see the entry.
  const { device, inflight } = makeDevice();
  const monitor = new AsyncResourceMonitor("ctx-c2");
  const cache = new WebGPURenderPipelineCache(
    device,
    "ctx-c2",
    undefined,
    monitor,
  );
  const descriptor = makeDescriptor("delta");

  let seenFromHandler;
  monitor.subscribe((event) => {
    if (event.kind === "resolved") {
      seenFromHandler = cache.getPipelineSync(descriptor);
    }
  });

  const request = cache.getPipeline(descriptor);
  await settleMicrotasks();
  inflight[0].settle();
  await request;

  assert.ok(
    seenFromHandler,
    "the resolved event fired before the cache write, so a handler that " +
      "looked the pipeline up would have missed it and re-requested",
  );
});

test("C3 a rejected creation publishes a rejection and frees its pending slot", async () => {
  const { device, inflight } = makeDevice();
  const monitor = new AsyncResourceMonitor("ctx-c3");
  const cache = new WebGPURenderPipelineCache(
    device,
    "ctx-c3",
    undefined,
    monitor,
  );

  const events = [];
  monitor.subscribe((event) => events.push(event.kind));

  const request = cache.getPipeline(makeDescriptor("doomed"));
  await settleMicrotasks();
  inflight[0].fail(new Error("validation failed"));
  await assert.rejects(request);

  assert.deepEqual(events, ["started", "rejected"]);
  assert.equal(
    cache.getStats().pending,
    0,
    "a rejection leaked a pending slot",
  );
  assert.equal(cache.getStats().created, 0);
});

// ── D. INERTNESS MUTANTS ────────────────────────────────────────────────────

test("D1 a creation budget that admits one request loses A2 and B1", async () => {
  // The shape the diagnosis ruled out, reintroduced: only the first creation
  // reaches the device, and every one after it waits on a promise that nothing
  // but a later frame could settle. The budget's state lives INSIDE the
  // mutated module, so the throttle is real engine behaviour under test rather
  // than a harness variable the engine could never have seen.
  const mutated = await loadEngine({
    label: "one-creation-budget",
    mutate: (source) =>
      source
        .replace(
          '} from "./WebGPUDeviceInvalidationBus.js";\n',
          '} from "./WebGPUDeviceInvalidationBus.js";\n\nlet admitted = 0;\n',
        )
        .replace(
          "      const pipeline =\n" +
            "        await this.device.createRenderPipelineAsync(pipelineDescriptor);\n",
          "      const pipeline =\n" +
            "        admitted++ > 0\n" +
            "          ? await new Promise<GPURenderPipeline>(() => {})\n" +
            "          : await this.device.createRenderPipelineAsync(pipelineDescriptor);\n",
        ),
  });

  const { device, inflight } = makeDevice();
  const cache = new mutated.WebGPURenderPipelineCache(device, "ctx-d1");
  const requests = [];
  for (let index = 0; index < 12; index++) {
    const request = cache.getPipeline(makeDescriptor(`v-${index}`));
    request.catch(() => {});
    requests.push(request);
  }
  await settleMicrotasks();

  assert.equal(
    inflight.length,
    1,
    "the mutant did not actually throttle, so this mutation proves nothing",
  );
  assert.equal(
    cache.getStats().pending,
    12,
    "the throttled requests should all still be outstanding",
  );

  // A2's property is gone with it: settling the one admitted creation leaves
  // eleven pipelines that no amount of microtask draining can land.
  inflight[0].settle();
  await settleMicrotasks();
  assert.equal(cache.getStats().created, 1);
  assert.equal(cache.getStats().pending, 11);
});

test("D2 a resolve published before the cache write loses C2", async () => {
  const mutated = await loadEngine({
    label: "resolve-before-cache-write",
    mutate: (source) =>
      source.replace(
        "      this.cache.set(key, {\n" +
          "        pipeline,\n" +
          "        descriptor,\n" +
          "        variant: variant || {},\n" +
          "        created: now,\n" +
          "        lastAccessed: now,\n" +
          "      });\n" +
          "      this.evictIfNeeded();\n" +
          "\n" +
          "      this.stats.created++;\n",
        "      if (monitorToken) {\n" +
          "        this.monitor!.resolve(monitorToken);\n" +
          "      }\n" +
          "      this.cache.set(key, {\n" +
          "        pipeline,\n" +
          "        descriptor,\n" +
          "        variant: variant || {},\n" +
          "        created: now,\n" +
          "        lastAccessed: now,\n" +
          "      });\n" +
          "      this.evictIfNeeded();\n" +
          "\n" +
          "      this.stats.created++;\n",
      ),
  });

  const { device, inflight } = makeDevice();
  const monitor = new mutated.AsyncResourceMonitor("ctx-d2");
  const cache = new mutated.WebGPURenderPipelineCache(
    device,
    "ctx-d2",
    undefined,
    monitor,
  );
  const descriptor = makeDescriptor("epsilon");

  let seenFromHandler;
  let handled = 0;
  monitor.subscribe((event) => {
    if (event.kind === "resolved" && handled++ === 0) {
      seenFromHandler = cache.getPipelineSync(descriptor);
    }
  });

  const request = cache.getPipeline(descriptor);
  await settleMicrotasks();
  inflight[0].settle();
  await request;

  assert.equal(handled, 1, "the mutant never published a resolve at all");
  assert.equal(
    seenFromHandler,
    undefined,
    "the resolve still lands after the cache write, so C2 cannot detect the " +
      "ordering it exists to pin",
  );
});

test("D3 a pending counter that never decrements loses C3", async () => {
  const mutated = await loadEngine({
    label: "pending-leak-on-rejection",
    mutate: (source) =>
      source.replace(
        "    } finally {\n" +
          "      this.pendingPipelines.delete(key);\n" +
          "      this.stats.pending--;\n" +
          "    }\n",
        "    } finally {\n" +
          "      this.pendingPipelines.delete(key);\n" +
          "    }\n",
      ),
  });

  const { device, inflight } = makeDevice();
  const cache = new mutated.WebGPURenderPipelineCache(device, "ctx-d3");
  const request = cache.getPipeline(makeDescriptor("leaky"));
  await settleMicrotasks();
  inflight[0].fail(new Error("validation failed"));
  await assert.rejects(request);

  assert.equal(
    cache.getStats().pending,
    1,
    "the mutant did not leak, so C3's pending assertion proves nothing",
  );
});

// ── E. THE SOURCE THE MUTANTS ANCHOR TO IS THE SOURCE UNDER TEST ────────────

test("E1 the mutation anchors exist exactly once in the cache source", async () => {
  const source = (await readFile(CACHE_PATH, "utf8")).split("\r\n").join("\n");
  const anchors = [
    '} from "./WebGPUDeviceInvalidationBus.js";\n',
    "      const pipeline =\n" +
      "        await this.device.createRenderPipelineAsync(pipelineDescriptor);\n",
    "    } finally {\n" +
      "      this.pendingPipelines.delete(key);\n" +
      "      this.stats.pending--;\n" +
      "    }\n",
    "      this.cache.set(key, {\n" +
      "        pipeline,\n" +
      "        descriptor,\n" +
      "        variant: variant || {},\n" +
      "        created: now,\n" +
      "        lastAccessed: now,\n" +
      "      });\n" +
      "      this.evictIfNeeded();\n" +
      "\n" +
      "      this.stats.created++;\n",
  ];
  for (const anchor of anchors) {
    assert.equal(
      source.split(anchor).length - 1,
      1,
      `anchor is not unique in ${CACHE_PATH}:\n${anchor}`,
    );
  }
});
