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
