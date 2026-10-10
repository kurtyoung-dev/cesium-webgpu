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
