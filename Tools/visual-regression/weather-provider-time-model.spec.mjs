// weather-provider-time-model.spec.mjs — the weather TIME MODEL, on the real
// engine modules, with no browser.
// @purpose Promoted from the retired browser probe probe-weather-time.mjs: drives the real WeatherProvider and SyntheticWeatherSource("drift") through live, historical, projected and legacy modes and asserts the packed bytes and the version counter.
// @status ACTIVE
//
// WHY THIS IS A SPEC NOW. `probe-weather-time.mjs` launched Edge only to
// `import()` the built bundle; it never rendered, never read a pixel and never
// touched `window.viewer` (the `C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE`
// classification recorded that as a proof, not an assumption). Everything it
// asserted is provider logic over packed bytes and a version counter, which
// Node can execute directly on the engine's own TypeScript through
// `lib/engine-ts-resolver.mjs`. The probe's nine checks are the nine tests
// below, one each, with the probe's own hash, poll budget and fixed instants.
//
// WHAT IT GIVES UP, stated so nobody mistakes it for more: the probe also
// asserted the four names were EXPORTED from the built bundle. That is
// `probe-weather-ingest.mjs` gate 1's subject (`WeatherProvider`,
// `EdrWeatherSource`, `SyntheticWeatherSource`, `packWeatherField` exported),
// and it stays there; this spec asserts the time-model methods exist on the
// class it imports.

import assert from "node:assert/strict";
import test from "node:test";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();
const { WeatherProvider } =
  await import("../../packages/engine/Source/Scene/Weather/WeatherProvider.ts");
const { SyntheticWeatherSource } =
  await import("../../packages/engine/Source/Scene/Weather/SyntheticWeatherSource.ts");

// The retired probe's own constants: a 256x128 pack, one-hour slices, and
// fixed instants with no wall clock anywhere.
const W = 256;
const H = 128;
const HOUR = 3600000;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

/** The retired probe's sparse byte hash (every 137th byte). */
function hash(bytes) {
  let h = 0;
  for (let i = 0; i < bytes.length; i += 137) {
    h = (h * 31 + bytes[i]) >>> 0;
  }
  return h;
}

/**
 * The retired probe's poll: up to 60 reads 5 ms apart for the pack a fetch
 * kicked off to land. A null return is a missing slice, and every assertion
 * below that reads a hash first requires it non-null.
 */
async function poll(provider) {
  for (let i = 0; i < 60; i++) {
    const bytes = provider.getPackedTexture(W, H);
    if (bytes) {
      return bytes;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return null;
}

/**
 * The retired probe's sequence, in its order, on one provider: live t0 ->
 * live +6h -> live +6h1m -> historical -9h -> projected +18h -> live +6h
 * (scrub back) -> and a second provider with no time mode.
 */
async function runTimeModel() {
  const source = new SyntheticWeatherSource("drift");
  const provider = new WeatherProvider(source);

  provider.setTimeMode("live");
  provider.tick(T0);
  const b0 = await poll(provider);
  const v0 = provider.version;
  provider.tick(T0 + 6 * HOUR);
  const b6 = await poll(provider);
  const v6 = provider.version;
  provider.tick(T0 + 6 * HOUR + 60000);
  const vSame = provider.version;

  provider.setTimeMode("historical");
  provider.setTime(new Date(T0 - 9 * HOUR));
  const bH = await poll(provider);

  provider.setTimeMode("projected");
  provider.setForecastOffsetHours(18);
  provider.tick(T0);
  const bP = await poll(provider);

  provider.setTimeMode("live");
  provider.tick(T0 + 6 * HOUR);
  const vBack = provider.version;
  const bBack = provider.getPackedTexture(W, H);

  const legacy = new WeatherProvider(new SyntheticWeatherSource("drift"));
  const bL = await poll(legacy);

  return {
    supportsTime: source.getCapabilities().supportsTime,
    h: {
      h0: b0 ? hash(b0) : null,
      h6: b6 ? hash(b6) : null,
      hH: bH ? hash(bH) : null,
      hP: bP ? hash(bP) : null,
      hBack: bBack ? hash(bBack) : null,
    },
    v: { v0, v6, vSame, vBack },
    cacheHitImmediate: Boolean(bBack),
    legacyMode: legacy.getTimeMode(),
    legacyHasData: Boolean(bL),
  };
}

const run = await runTimeModel();

test("the time-model API exists on the provider (setTimeMode/tick/setTime/setForecastOffsetHours)", () => {
  const provider = new WeatherProvider();
  for (const method of [
    "setTimeMode",
    "tick",
    "setTime",
    "setForecastOffsetHours",
    "getTimeMode",
    "getEffectiveTime",
  ]) {
    assert.equal(typeof provider[method], "function", method);
  }
});

test('SyntheticWeatherSource("drift") advertises supportsTime', () => {
  assert.equal(run.supportsTime, true);
});

test("a live tick six hours on advances the field", () => {
  assert.notEqual(run.h.h0, null);
  assert.notEqual(run.h.h6, null);
  assert.notEqual(run.h.h0, run.h.h6);
});

test("a sub-quantum tick (one minute, same hour slice) does not bump version", () => {
  assert.equal(run.v.vSame, run.v.v6);
});

test("historical mode resolves a distinct slice", () => {
  assert.notEqual(run.h.hH, null);
  assert.notEqual(run.h.hH, run.h.h0);
});

test("projected mode resolves a distinct slice", () => {
  assert.notEqual(run.h.hP, null);
  assert.notEqual(run.h.hP, run.h.h0);
});

test("scrubbing live back to an already-fetched slice is an immediate LRU hit", () => {
  assert.equal(run.cacheHitImmediate, true);
  assert.equal(run.h.hBack, run.h.h6);
});

test("the slice change on scrub-back bumps version", () => {
  assert.ok(run.v.vBack > run.v.v6, JSON.stringify(run.v));
});

test('a provider with no time mode keeps the legacy "latest" behaviour and still serves data', () => {
  assert.equal(run.legacyMode, null);
  assert.equal(run.legacyHasData, true);
});

test("scene weather waits for its clock, holds a coherent slice while replacing it, and replays from cache", async () => {
  const calls = [];
  const source = {
    getCapabilities: () => ({
      id: "scene-clock-fixture",
      label: "Scene clock fixture",
      supportsTime: true,
    }),
    async fetchField(request) {
      assert(request.time instanceof Date);
      const instant = request.time.getTime();
      calls.push(instant);
      const value = Math.floor((instant - T0) / HOUR) + 32;
      return {
        gridWidth: 2,
        gridHeight: 2,
        bounds: {
          west: -Math.PI,
          east: Math.PI,
          south: -Math.PI / 2,
          north: Math.PI / 2,
        },
        coverage: new Float32Array(4).fill(value / 100),
        validTime: request.time.toISOString(),
        environmentalTensors: {
          width: 2,
          height: 2,
          atmosphericBytes: new Uint8Array(16).fill(value),
          marineBytes: new Uint8Array(16).fill(value + 1),
        },
      };
    },
  };
  const provider = new WeatherProvider(source);
  let notifications = 0;
  provider.changed.addEventListener(() => {
    notifications++;
  });
  provider.setTimeMode("scene");
  assert.equal(provider.getPackedTexture(W, H), null);
  provider.tick(T0 + 100 * HOUR);
  provider.tickSceneTime(NaN);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.length, 0);
  const current = async (instant) => {
    for (let i = 0; i < 60; i++) {
      const bytes = provider.getPackedTexture(W, H);
      if (bytes && provider.validTime === new Date(instant).toISOString())
        return bytes;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("scene weather did not publish the requested time");
  };
  provider.tickSceneTime(T0);
  const first = await current(T0),
    version = provider.version;
  const tensor = provider.getEnvironmentalTensors();
  provider.tickSceneTime(T0 + 6 * HOUR);
  assert.equal(provider.getPackedTexture(W, H), first);
  assert.equal(provider.version, version);
  assert.equal(provider.getEnvironmentalTensors(), tensor);
  assert.equal(provider.validTime, new Date(T0).toISOString());
  const later = await current(T0 + 6 * HOUR);
  assert.notEqual(hash(later), hash(first));
  assert.equal(provider.getEnvironmentalTensors().atmosphericBytes[0], 38);
  provider.tickSceneTime(T0);
  assert.equal(provider.getPackedTexture(W, H), first);
  assert.equal(provider.getEnvironmentalTensors(), tensor);
  assert.equal(calls.length, 2);
  assert.equal(notifications, 3);
  provider.setTime(new Date(T0 + HOUR));
  assert.equal(
    provider.getTimeMode(),
    "historical",
    "an explicit time pins an automatically followed scene",
  );
});

test("shared cloud weather owns only its procedural provider, follows scene time and releases render listeners", async () => {
  const { default: CloudWeatherState } =
    await import("../../packages/engine/Source/Scene/CloudWeatherState.js");
  const { default: JulianDate } =
    await import("../../packages/engine/Source/Core/JulianDate.js");
  const state = new CloudWeatherState();
  const frame = {
    time: JulianDate.fromIso8601("2026-10-19T12:03:00Z"),
    afterRender: [],
  };
  const config = { cloudWeatherMap: true, cloudWeatherSeed: "shared-key" };
  state.update(config, frame);
  const first = state.provider;
  assert.equal(first.getTimeMode(), "scene");
  assert.equal(
    first.getEffectiveTime().toISOString(),
    "2026-10-19T12:00:00.000Z",
  );
  assert.equal(
    first.getSource().getCapabilities().id,
    "procedural:synoptic:shared-key",
  );
  state.update(config, frame);
  assert.equal(state.provider, first);
  first.changed.raiseEvent();
  first.changed.raiseEvent();
  assert.equal(frame.afterRender.length, 1);
  assert.equal(frame.afterRender.shift()(), true);
  first.changed.raiseEvent();
  config.cloudWeatherSeed = "another-key";
  state.update(config, frame);
  assert.notEqual(state.provider, first);
  assert.equal(first.getSource(), null);
  assert.equal(frame.afterRender.shift()(), false);
  assert.equal(first.changed.numberOfListeners, 0);
  const externalSource = {
    getCapabilities: () => ({ id: "external" }),
    fetchField() {},
  };
  const external = new WeatherProvider(externalSource);
  state.update({ cloudWeatherMap: true, weatherProvider: external }, frame);
  assert.equal(state.provider, external);
  assert.equal(external.getTimeMode(), null);
  state.destroy();
  assert.equal(external.getSource(), externalSource);
  assert.equal(external.changed.numberOfListeners, 0);
});

test("asynchronous provider publication owns tensor/coverage input and drops a cancelled pack", async () => {
  const makeField = () => ({
    gridWidth: 2,
    gridHeight: 2,
    bounds: {
      west: -Math.PI,
      east: Math.PI,
      south: -Math.PI / 2,
      north: Math.PI / 2,
    },
    coverage: new Float32Array(4).fill(0.8),
    validTime: new Date(T0).toISOString(),
    environmentalTensors: {
      width: 2,
      height: 2,
      atmosphericBytes: new Uint8Array(16).fill(32),
      marineBytes: new Uint8Array(16).fill(33),
    },
  });
  const input = makeField();
  const provider = new WeatherProvider({
    getCapabilities: () => ({ id: "owned-pack" }),
    async fetchField() {
      setTimeout(() => {
        input.coverage.fill(0);
        input.environmentalTensors.atmosphericBytes.fill(99);
      }, 0);
      return input;
    },
  });
  provider.getPackedTexture(256, 256);
  for (let i = 0; i < 100 && !provider.hasData; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert(provider.hasData);
  assert.equal(provider.getPackedTexture(256, 256)[0], 204);
  assert.equal(provider.getEnvironmentalTensors().atmosphericBytes[0], 32);
  const cancelled = new WeatherProvider({
    getCapabilities: () => ({ id: "cancel-pack" }),
    async fetchField() {
      setTimeout(() => cancelled.setSource(null), 0);
      return makeField();
    },
  });
  cancelled.getPackedTexture(256, 256);
  for (let i = 0; i < 100 && cancelled.isPreparing; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cancelled.isPreparing, false);
  assert.equal(cancelled.hasData, false);
  assert.equal(
    cancelled.version,
    1,
    "only the explicit source change may publish a version",
  );
  assert.equal(cancelled.lastError, null);
  assert.equal(cancelled.getEnvironmentalTensors(), null);
});

const { tensorCloudMaterialFlow } =
  await import("../../packages/engine/Source/Scene/Weather/TensorCloudMaterialFlow.ts");
const { sampleCloudMaterialFlow, validCloudMaterialFlow } =
  await import("../../packages/engine/Source/Scene/Weather/CloudMaterialFlow.ts");
const { CloudMaterialFlowResources } =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudMaterialFlow.ts");
const { default: JulianDate } =
  await import("../../packages/engine/Source/Core/JulianDate.js");

function windTensor() {
  const width = 64,
    height = 32;
  const atmosphericBytes = new Uint8Array(width * height * 4);
  for (let i = 0; i < atmosphericBytes.length; i += 4) {
    atmosphericBytes[i] = 213;
    atmosphericBytes[i + 1] = 128;
  }
  return {
    width,
    height,
    atmosphericBytes,
    marineBytes: new Uint8Array(atmosphericBytes.length),
  };
}

test("tensor material wind converts geographic components before interpolation and closes the dateline and poles", async () => {
  const tensor = windTensor();
  const flow = await tensorCloudMaterialFlow(tensor, T0);
  assert.ok(validCloudMaterialFlow(flow));
  assert.equal(flow.timeMs, T0);
  assert.ok(flow.displacement.every((value) => value === 0));
  for (const i of [7, 498, 1302]) {
    const lon = (((i % flow.width) + 0.5) / flow.width - 0.5) * Math.PI * 2;
    const lat =
      (0.5 - (Math.floor(i / flow.width) + 0.5) / flow.height) * Math.PI;
    const position = [
      Math.cos(lat) * Math.cos(lon),
      Math.cos(lat) * Math.sin(lon),
      Math.sin(lat),
    ];
    const offset = i * 4;
    const dot = position.reduce(
      (sum, value, axis) => sum + value * flow.velocity[offset + axis],
      0,
    );
    assert.ok(
      Math.abs(dot) < 0.000003,
      "stored velocity is an ECEF tangent delta",
    );
  }
  const sample = (lon, lat) => {
    const displacement = new Float64Array(3),
      velocity = new Float64Array(3);
    sampleCloudMaterialFlow(flow, lon, lat, displacement, velocity);
    return velocity;
  };
  assert.ok(
    Math.hypot(
      ...sample(Math.PI - 1e-9, 0.3).map(
        (v, i) => v - sample(-Math.PI + 1e-9, 0.3)[i],
      ),
    ) < 1e-6,
  );
  for (const lat of [-Math.PI / 2, Math.PI / 2]) {
    assert.deepEqual(sample(-2.1, lat), sample(1.4, lat));
    assert.ok(
      Math.hypot(
        ...sample(1.4, lat).map((v, i) => v - sample(1.4, lat * (1 - 1e-9))[i]),
      ) < 1e-5,
    );
  }
});

test("tensor material preparation yields and cancellation prevents a completed field", async () => {
  let turns = 0;
  const handle = setInterval(() => turns++, 0);
  try {
    assert.equal(
      await tensorCloudMaterialFlow(windTensor(), T0, () => turns >= 2),
      undefined,
    );
    assert.ok(turns >= 2);
    await assert.rejects(
      tensorCloudMaterialFlow({ ...windTensor(), width: 0 }, T0),
      /Invalid/,
    );
  } finally {
    clearInterval(handle);
  }
});

test("material-flow GPU resources use a shared UTC age and retain identity until a real snapshot change", async () => {
  const flow = await tensorCloudMaterialFlow(windTensor(), T0);
  const first = new CloudMaterialFlowResources(),
    other = new CloudMaterialFlowResources();
  const time = JulianDate.fromDate(new Date(T0 + 1250));
  assert.equal(first.ageSeconds(flow, time), 1.25);
  assert.equal(other.ageSeconds(flow, time), 1.25);
  assert.equal(
    first.ageSeconds(flow, JulianDate.fromDate(new Date(T0 - HOUR))),
    -900,
  );
  assert.equal(
    first.ageSeconds(flow, JulianDate.fromDate(new Date(T0 + HOUR))),
    900,
  );
  assert.equal(first.ageSeconds(undefined, time), 0);
  const uploads = [],
    buffers = [];
  globalThis.GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8 };
  const device = {
    createBuffer(descriptor) {
      const buffer = {
        descriptor,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    queue: {
      writeBuffer(buffer, offset, bytes) {
        uploads.push({ buffer, bytes: bytes.slice(0) });
      },
    },
  };
  const buffer = first.prepare(device, flow, 1);
  assert.equal(first.prepare(device, flow, 1), buffer);
  assert.equal(uploads.length, 1);
  assert.equal(first.bytes, 16 + (64 * 32 + 2) * 32);
  const packed = new Float32Array(uploads[0].bytes, 16);
  const pole = new Float64Array(3),
    velocity = new Float64Array(3);
  sampleCloudMaterialFlow(flow, 0.2, Math.PI / 2, pole, velocity);
  assert.deepEqual(
    Array.from(packed.slice(64 * 32 * 8 + 4, 64 * 32 * 8 + 7)),
    Array.from(velocity),
  );
  first.prepare(device, undefined, 1);
  assert.equal(buffer.destroyed, false);
  first.prepare(device, undefined, 2);
  assert.equal(buffer.destroyed, true);
  first.destroy();
  other.destroy();
  assert.ok(buffers.every((value) => value.destroyed));
});

test("provider flow is cloned, retained during a scene miss and restored by cache replay with its weather", async () => {
  const authored = await tensorCloudMaterialFlow(windTensor(), T0);
  let release;
  const provider = new WeatherProvider({
    fetchField(request) {
      const result = {
        gridWidth: 2,
        gridHeight: 2,
        coverage: new Float32Array(4).fill(0.7),
        bounds: {
          west: -Math.PI,
          east: Math.PI,
          south: -Math.PI / 2,
          north: Math.PI / 2,
        },
        validTime: request.time.toISOString(),
        flow: authored,
      };
      return request.time.getTime() === T0
        ? Promise.resolve(result)
        : new Promise((resolve) => {
            release = () => resolve(result);
          });
    },
  });
  provider.setTimeMode("scene");
  provider.tickSceneTime(T0);
  await poll(provider);
  const bytes = provider.getPackedTexture(W, H),
    flow = provider.getFlowField();
  assert.notEqual(flow, authored);
  assert.deepEqual(flow.velocity, authored.velocity);
  authored.velocity[0] = 123;
  assert.notEqual(flow.velocity[0], 123);
  provider.tickSceneTime(T0 + HOUR);
  assert.equal(provider.getPackedTexture(W, H), bytes);
  assert.equal(provider.getFlowField(), flow);
  release();
  for (let i = 0; i < 60 && provider.isPreparing; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.notEqual(provider.getFlowField(), flow);
  provider.tickSceneTime(T0);
  assert.equal(provider.getPackedTexture(W, H), bytes);
  assert.equal(provider.getFlowField(), flow);
});

async function waitPublication(provider, width = W, height = H, timeMs) {
  for (let i = 0; i < 100; i++) {
    const value = provider.getPackedPublication(width, height);
    if (value && (timeMs === undefined || value.current.timeMs === timeMs))
      return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("complete weather publication did not arrive");
}
function snapshotField(request, flow) {
  return {
    gridWidth: 2,
    gridHeight: 2,
    coverage: new Float32Array(4).fill(
      0.3 + ((request.time.getTime() - T0) / HOUR) * 0.1,
    ),
    bounds: {
      west: -Math.PI,
      east: Math.PI,
      south: -Math.PI / 2,
      north: Math.PI / 2,
    },
    validTime: request.time.toISOString(),
    flow,
    environmentalTensors: windTensor(),
  };
}
test("complete scene publications keep canonical UTC predecessors and stable identities across replay", async () => {
  const authored = await tensorCloudMaterialFlow(windTensor(), T0);
  let release,
    calls = 0;
  const provider = new WeatherProvider({
    fetchField(request) {
      calls++;
      const field = snapshotField(request, authored);
      return request.time.getTime() === T0 + HOUR
        ? new Promise((resolve) => {
            release = () => resolve(field);
          })
        : Promise.resolve(field);
    },
  });
  provider.useWorkers = false;
  provider.setTimeMode("scene");
  provider.tickSceneTime(T0);
  const observed = [];
  provider.changed.addEventListener(() =>
    observed.push(provider.getPackedPublication(W, H)),
  );
  const first = await waitPublication(provider, W, H, T0);
  assert(Object.isFrozen(first));
  assert(Object.isFrozen(first.current));
  assert(Object.isFrozen(first.current.packStats));
  assert.equal(first.previous, null);
  assert.equal(first.current.width, W);
  assert.equal(first.current.height, H);
  assert.equal(first.current.bytes, provider.getPackedTexture(W, H));
  assert.equal(first.current.flow, provider.getFlowField());
  assert.equal(
    first.current.environmentalTensors,
    provider.getEnvironmentalTensors(),
  );
  assert.equal(first.current.validTime, provider.validTime);
  assert.notEqual(first.current.flow, authored);
  assert.equal(first.version, provider.version);
  assert.equal(provider.getPackedPublication(W, H), first);
  provider.tickSceneTime(T0 + HOUR);
  assert.equal(
    provider.getPackedPublication(W, H),
    first,
    "a miss retains the entire old publication",
  );
  release();
  const second = await waitPublication(provider, W, H, T0 + HOUR);
  assert.equal(second.previous, first.current);
  assert.notEqual(second.current.contentVersion, first.current.contentVersion);
  assert.notEqual(second.current.bytes, first.current.bytes);
  assert.notEqual(second.current.flow, first.current.flow);
  provider.tickSceneTime(T0 + 3 * HOUR);
  const third = await waitPublication(provider, W, H, T0 + 3 * HOUR);
  assert.equal(
    third.previous,
    null,
    "a missing adjacent interval is never replaced by the last visited time",
  );
  provider.tickSceneTime(T0 + HOUR);
  const replay = provider.getPackedPublication(W, H);
  assert.equal(replay.current, second.current);
  assert.equal(
    replay.previous,
    first.current,
    "predecessor is independent of navigation order",
  );
  assert(replay.version > second.version);
  provider.tickSceneTime(T0);
  assert.equal(provider.getPackedPublication(W, H).current, first.current);
  assert.equal(provider.getPackedPublication(W, H).previous, null);
  assert.equal(calls, 3);
  assert.equal(observed.length, 5);
  assert(
    observed.every(
      (value) => value && value.current.bytes && value.current.flow,
    ),
  );
  provider.setSource(null);
  assert.equal(provider.getPackedPublication(W, H), null);
});
test("snapshot identity is independent of provider-local publication counters and source replacement", async () => {
  const source = {
    async fetchField(request) {
      return snapshotField(request);
    },
  };
  const a = new WeatherProvider(source),
    b = new WeatherProvider(source);
  for (const provider of [a, b]) {
    provider.useWorkers = false;
    provider.setTimeMode("scene");
    provider.tickSceneTime(T0);
  }
  const first = await waitPublication(a),
    other = await waitPublication(b);
  assert.equal(first.version, other.version);
  assert.notEqual(first.current.contentVersion, other.current.contentVersion);
  assert.deepEqual(first.current.bytes, other.current.bytes);
  a.setSource(source);
  assert.equal(a.getPackedPublication(W, H), null);
  const replacement = await waitPublication(a);
  assert.notEqual(
    replacement.current.contentVersion,
    first.current.contentVersion,
  );
  assert.equal(replacement.previous, null);
});
test("legacy snapshots invalidate completed and in-flight data when texture dimensions change", async () => {
  let release,
    calls = 0;
  const provider = new WeatherProvider({
    fetchField() {
      calls++;
      const field = snapshotField({ time: new Date(T0) });
      return calls === 1
        ? new Promise((resolve) => {
            release = () => resolve(field);
          })
        : Promise.resolve(field);
    },
  });
  provider.useWorkers = false;
  assert.equal(provider.getPackedPublication(16, 8), null);
  assert.equal(provider.getPackedPublication(32, 16), null);
  release();
  const resized = await waitPublication(provider, 32, 16);
  assert.equal(resized.current.width, 32);
  assert.equal(resized.current.height, 16);
  assert.equal(resized.current.bytes.length, 32 * 16 * 4);
  assert.equal(
    provider.version,
    1,
    "cancelled first dimensions cannot publish",
  );
  assert.equal(calls, 2);
  assert.equal(provider.getPackedPublication(16, 8), null);
  const smaller = await waitPublication(provider, 16, 8);
  assert.equal(smaller.current.bytes.length, 16 * 8 * 4);
  assert.notEqual(
    smaller.current.contentVersion,
    resized.current.contentVersion,
  );
  assert.equal(smaller.previous, null);
});
test("snapshot predecessor follows requested UTC intervals even when observed analysis time differs", async () => {
  const provider = new WeatherProvider({
    async fetchField(request) {
      return {
        ...snapshotField(request),
        validTime: new Date(T0 - HOUR).toISOString(),
      };
    },
  });
  provider.useWorkers = false;
  provider.setTimeMode("scene");
  provider.tickSceneTime(T0);
  const first = await waitPublication(provider, 16, 8, T0);
  provider.tickSceneTime(T0 + HOUR);
  const second = await waitPublication(provider, 16, 8, T0 + HOUR);
  assert.equal(second.previous, first.current);
  assert.equal(second.current.validTime, first.current.validTime);
  assert.equal(second.current.timeMs - first.current.timeMs, HOUR);
});

test("weather transitions use deterministic scene UTC, canonical neighbors and exact endpoints", async () => {
  const { resolveCloudWeatherTransition } =
    await import("../../packages/engine/Source/Scene/Weather/CloudWeatherTransition.ts");
  const { default: JulianDate } =
    await import("../../packages/engine/Source/Core/JulianDate.js");
  const previous = { width: 16, height: 8, timeMs: T0 },
    current = { width: 16, height: 8, timeMs: T0 + HOUR };
  const publication = { current, previous, version: 2 };
  const at = (seconds) =>
    JulianDate.fromDate(new Date(current.timeMs + seconds * 1000));
  const begin = resolveCloudWeatherTransition(publication, at(0), true);
  assert.equal(begin.previous, previous);
  assert.equal(begin.weight, 0);
  assert.equal(begin.active, true);
  const middle = resolveCloudWeatherTransition(publication, at(15), true);
  assert.equal(middle.weight, 0.5);
  assert.equal(middle.previous, previous);
  assert.deepEqual(resolveCloudWeatherTransition(publication, at(30), true), {
    previous: null,
    weight: 1,
    active: false,
  });
  assert.equal(
    resolveCloudWeatherTransition(publication, at(-1), true).active,
    false,
  );
  assert.equal(
    resolveCloudWeatherTransition(publication, at(15), false).weight,
    1,
  );
  assert.equal(
    resolveCloudWeatherTransition(
      { ...publication, previous: null },
      at(15),
      true,
    ).active,
    false,
  );
  assert.equal(
    resolveCloudWeatherTransition(
      { ...publication, previous: { ...previous, width: 8 } },
      at(15),
      true,
    ).active,
    false,
  );
  assert.equal(
    resolveCloudWeatherTransition(publication, undefined, true).active,
    false,
  );
  assert.equal(
    resolveCloudWeatherTransition(
      publication,
      { dayNumber: NaN, secondsOfDay: 0 },
      true,
    ).active,
    false,
  );
  assert.equal(
    resolveCloudWeatherTransition(publication, at(15), true, NaN).weight,
    0.5,
  );
  const short = { current: { ...current, timeMs: T0 + 2000 }, previous };
  assert.equal(
    resolveCloudWeatherTransition(
      short,
      JulianDate.fromDate(new Date(T0 + 3000)),
      true,
      30,
    ).weight,
    0.5,
  );
  assert.equal(
    resolveCloudWeatherTransition(publication, at(15), true).weight,
    middle.weight,
    "navigation cannot change the interval's blend",
  );
});

// ── A legacy fetch in flight when the time mode changes is dropped ───────────
// A provider with no time mode fetches the "latest" field. If setTime() moves
// it to historical while that fetch is pending, the late legacy field must not
// become the active slice: the caller asked for a date, and the provider has
// to serve that date's field instead.

const { stripTypeScriptTypes } = await import("node:module");
const { default: nodeFs } = await import("node:fs");
const { pathToFileURL } = await import("node:url");

const PROVIDER_FILE = new URL(
  "../../packages/engine/Source/Scene/Weather/WeatherProvider.ts",
  import.meta.url,
);

/**
 * Import WeatherProvider.ts from a mutated copy of its source. The shared
 * importMutated loader reads plain JavaScript, so this strips the types first
 * and points the relative imports back at the original engine files.
 */
async function importMutatedProvider(replacements) {
  let source = nodeFs
    .readFileSync(PROVIDER_FILE, "utf8")
    .replace(/\r\n/g, "\n");
  for (const [anchor, replacement] of replacements) {
    const count = source.split(anchor).length - 1;
    assert.equal(count, 1, "the mutation anchor must occur exactly once");
    source = source.replace(anchor, () => replacement);
  }
  const js = stripTypeScriptTypes(source).replace(
    /from "(\.[^"]*)"/g,
    (_match, specifier) => {
      const asJs = new URL(specifier, PROVIDER_FILE);
      const target =
        specifier.endsWith(".js") && !nodeFs.existsSync(asJs)
          ? new URL(specifier.slice(0, -3) + ".ts", PROVIDER_FILE)
          : asJs;
      return (
        'from "' +
        pathToFileURL(target.pathname.replace(/^\/([A-Za-z]:)/, "$1")).href +
        '"'
      );
    },
  );
  return import(
    "data:text/javascript;base64," + Buffer.from(js).toString("base64")
  );
}

const TRANSITION_FILE = new URL(
  "../../packages/engine/Source/Scene/Weather/CloudWeatherTransition.ts",
  import.meta.url,
);

/**
 * Import CloudWeatherTransition.ts from a mutated copy of its source, with its
 * relative imports pointed back at the engine files (as importMutatedProvider).
 */
async function importMutatedTransition(replacements) {
  let source = nodeFs
    .readFileSync(TRANSITION_FILE, "utf8")
    .replace(/\r\n/g, "\n");
  for (const [anchor, replacement] of replacements) {
    const count = source.split(anchor).length - 1;
    assert.equal(count, 1, "the mutation anchor must occur exactly once");
    source = source.replace(anchor, () => replacement);
  }
  const js = stripTypeScriptTypes(source).replace(
    /from "(\.[^"]*)"/g,
    (_match, specifier) => {
      const asJs = new URL(specifier, TRANSITION_FILE);
      const target =
        specifier.endsWith(".js") && !nodeFs.existsSync(asJs)
          ? new URL(specifier.slice(0, -3) + ".ts", TRANSITION_FILE)
          : asJs;
      return (
        'from "' +
        pathToFileURL(target.pathname.replace(/^\/([A-Za-z]:)/, "$1")).href +
        '"'
      );
    },
  );
  return import(
    "data:text/javascript;base64," + Buffer.from(js).toString("base64")
  );
}

// The fade length a release build uses: the dial's setter validates 1-300 s
// only under the debug pragma, so the resolver clamps it itself. Under a one
// hour publication interval a 0.25 s request fades over 1 s and a 1000 s
// request over 300 s.
async function clampedFadeWeights(resolve) {
  const { default: JulianDate } =
    await import("../../packages/engine/Source/Core/JulianDate.js");
  const previous = { width: 16, height: 8, timeMs: T0 },
    current = { width: 16, height: 8, timeMs: T0 + HOUR };
  const publication = { current, previous, version: 2 };
  const at = (seconds) =>
    JulianDate.fromDate(new Date(current.timeMs + seconds * 1000));
  return {
    shortest: resolve(publication, at(0.5), true, 0.25).weight,
    longest: resolve(publication, at(150), true, 1000).weight,
  };
}

test("the fade length is clamped to 1-300 s in every build", async () => {
  const { resolveCloudWeatherTransition } =
    await import("../../packages/engine/Source/Scene/Weather/CloudWeatherTransition.ts");
  // Half way through a 1 s fade and a 300 s fade: the smoothstep weight is 0.5.
  assert.deepEqual(await clampedFadeWeights(resolveCloudWeatherTransition), {
    shortest: 0.5,
    longest: 0.5,
  });
});

test("MUTANT: the fade length unclamped in release is detected", async () => {
  const mutated = await importMutatedTransition([
    ["? Math.max(1, Math.min(300, durationSeconds))", "? durationSeconds"],
  ]);
  const weights = await clampedFadeWeights(
    mutated.resolveCloudWeatherTransition,
  );
  assert.notDeepEqual(weights, { shortest: 0.5, longest: 0.5 });
});

const RACE_LATEST_TIME = new Date(T0).toISOString();
const RACE_HISTORICAL = new Date(T0 - 9 * HOUR);

/**
 * A source whose untimed ("latest") fetch the test resolves by hand and whose
 * dated fetches resolve at once with a distinct field.
 */
function makeRaceSource() {
  const requests = [];
  let releaseLatest;
  const field = (coverage, validTime) => ({
    gridWidth: 2,
    gridHeight: 2,
    bounds: {
      west: -Math.PI,
      east: Math.PI,
      south: -Math.PI / 2,
      north: Math.PI / 2,
    },
    coverage: new Float32Array(4).fill(coverage),
    validTime,
  });
  return {
    requests,
    release: () => releaseLatest(),
    getCapabilities: () => ({ id: "mode-race-fixture", supportsTime: true }),
    fetchField(request) {
      requests.push(request.time);
      if (request.time instanceof Date) {
        return Promise.resolve(field(0.8, request.time.toISOString()));
      }
      return new Promise((resolve) => {
        releaseLatest = () => resolve(field(0.3, RACE_LATEST_TIME));
      });
    },
  };
}

/** Drive the race on the given WeatherProvider class and report what it served. */
async function runModeRace(ProviderClass) {
  const source = makeRaceSource();
  const provider = new ProviderClass(source);
  assert.equal(provider.getPackedTexture(W, H), null);
  assert.equal(source.requests.length, 1);
  assert.equal(provider.isPreparing, true);
  provider.setTime(RACE_HISTORICAL);
  assert.equal(provider.getTimeMode(), "historical");
  const versionBefore = provider.version;
  source.release();
  for (let i = 0; i < 100 && provider.isPreparing; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(provider.isPreparing, false);
  const afterLegacy = {
    hasData: provider.hasData,
    validTime: provider.validTime,
    versionMoved: provider.version !== versionBefore,
  };
  const bytes = await poll(provider);
  assert.notEqual(bytes, null);
  return {
    afterLegacy,
    finalValidTime: provider.validTime,
    finalByte: bytes[0],
    requests: source.requests,
  };
}

test("a legacy fetch in flight when setTime() switches to historical is dropped, and the historical field is served", async () => {
  const race = await runModeRace(WeatherProvider);
  assert.deepEqual(race.afterLegacy, {
    hasData: false,
    validTime: undefined,
    versionMoved: false,
  });
  assert.equal(race.finalValidTime, RACE_HISTORICAL.toISOString());
  assert.equal(race.finalByte, 204);
  assert.equal(race.requests.length, 2);
  assert.ok(!(race.requests[0] instanceof Date));
  assert.equal(race.requests[1].getTime(), RACE_HISTORICAL.getTime());
});

test("control: with the mode-change guard made inert the late legacy field is published for a historical request", async () => {
  const { WeatherProvider: Inert } = await importMutatedProvider([
    ["this._timeMode !== mode ||", "false ||"],
  ]);
  const race = await runModeRace(Inert);
  assert.equal(race.afterLegacy.hasData, true);
  assert.equal(race.afterLegacy.validTime, RACE_LATEST_TIME);
  assert.equal(race.afterLegacy.versionMoved, true);
  assert.equal(race.finalValidTime, RACE_LATEST_TIME);
  assert.notEqual(race.finalByte, 204);
  assert.equal(race.requests.length, 1);
});
