import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { bundle } from "./lib/engine-stub-bundler.mjs";

const PROVIDER_PATH = resolve(
  "packages/engine/Source/Scene/Weather/WeatherProvider.ts",
);
const PROVIDER_SOURCE = (await readFile(PROVIDER_PATH, "utf8"))
  .split("\r\n")
  .join("\n");
const REAL_WEATHER_MODULES = [
  "WeatherTexPacker",
  "WeatherFieldGrid",
  "ProceduralWeatherMap",
  "WeatherMapSeam",
  "WeatherTypes",
  "WeatherSource",
];

async function loadProvider(mutate, label) {
  const module = await bundle({
    path: PROVIDER_PATH,
    source: PROVIDER_SOURCE,
    real: REAL_WEATHER_MODULES,
    mutate,
    label,
  });
  return module.WeatherProvider;
}

const WeatherProvider = await loadProvider();

const TEX_W = 8;
const TEX_H = 4;
const HOUR_MS = 60 * 60 * 1000;
const A_REQUEST = new Date("2024-01-15T06:00:00.000Z");
const B_REQUEST = new Date("2024-01-15T07:00:00.000Z");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function field({
  coverage,
  bounds = {
    west: -Math.PI,
    south: -Math.PI / 2,
    east: Math.PI,
    north: Math.PI / 2,
  },
  validTime,
  ww,
  visibilityKm,
  source,
}) {
  return {
    gridWidth: 2,
    gridHeight: 2,
    coverage: new Float32Array(coverage),
    bounds,
    registration: "node",
    validTime,
    representativeWw: ww,
    visibilityKm,
    source,
  };
}

const FIELD_A = field({
  coverage: [0.15, 0.25, 0.35, 0.45],
  validTime: "2024-01-15T06:25:00.000Z",
  ww: 61,
  visibilityKm: 8,
  source: "timeline:a",
});

const FIELD_B = field({
  coverage: [0.8, Number.NaN, 0.9, Number.NaN],
  bounds: {
    west: -0.7,
    south: -0.4,
    east: 0.7,
    north: 0.4,
  },
  validTime: "2024-01-15T07:40:00.000Z",
  ww: 73,
  visibilityKm: 2,
  source: "timeline:b",
});

const FIELD_B_ALIGNED_TIME = {
  ...FIELD_B,
  validTime: B_REQUEST.toISOString(),
};

function timeKey(time) {
  assert.ok(time instanceof Date, "timeline request must carry a Date");
  return time.toISOString();
}

class ImmediateTimelineSource {
  constructor(fields) {
    this.fields = fields;
    this.calls = [];
  }

  getCapabilities() {
    return { id: "timeline", label: "Timeline", supportsTime: true };
  }

  fetchField(request) {
    const key = timeKey(request.time);
    this.calls.push(key);
    const value = this.fields.get(key);
    assert.ok(value, `unexpected timeline request ${key}`);
    return Promise.resolve(value);
  }
}

class DeferredTimelineSource {
  constructor() {
    this.calls = [];
    this.pending = new Map();
  }

  getCapabilities() {
    return { id: "deferred", label: "Deferred", supportsTime: true };
  }

  fetchField(request) {
    const key = timeKey(request.time);
    this.calls.push(key);
    const result = deferred();
    this.pending.set(key, result);
    return result.promise;
  }

  resolve(time, value) {
    const key = time.toISOString();
    const result = this.pending.get(key);
    assert.ok(result, `no pending request for ${key}`);
    this.pending.delete(key);
    result.resolve(value);
  }
}

class QueueSource {
  constructor() {
    this.calls = [];
    this.pending = [];
  }

  getCapabilities() {
    return { id: "queue", label: "Queue", supportsTime: true };
  }

  fetchField(request) {
    const result = deferred();
    this.calls.push(request);
    this.pending.push(result);
    return result.promise;
  }

  resolve(index, value) {
    assert.ok(this.pending[index], `no pending request ${index}`);
    this.pending[index].resolve(value);
  }
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function load(provider) {
  const initial = provider.getPackedTexture(TEX_W, TEX_H);
  if (initial !== null) {
    return initial;
  }
  await flushPromises();
  const packed = provider.getPackedTexture(TEX_W, TEX_H);
  assert.ok(
    packed instanceof Uint8Array,
    "provider did not publish packed bytes",
  );
  return packed;
}

function metadata(provider) {
  return {
    presentWeather: provider.getPresentWeather(),
    validTime: provider.validTime,
    packStats: provider.getPackStats(),
  };
}

function assertMetadata(actual, expected, label) {
  assert.deepEqual(
    actual.presentWeather,
    expected.presentWeather,
    `${label} present weather`,
  );
  assert.equal(actual.validTime, expected.validTime, `${label} valid time`);
  assert.deepEqual(actual.packStats, expected.packStats, `${label} pack stats`);
}

async function buildReplayTimeline(Provider = WeatherProvider) {
  const source = new ImmediateTimelineSource(
    new Map([
      [A_REQUEST.toISOString(), FIELD_A],
      [B_REQUEST.toISOString(), FIELD_B],
    ]),
  );
  const provider = new Provider(source);
  provider.setQuantizeHours(1);
  provider.setTime(A_REQUEST);
  const bytesA = Uint8Array.from(await load(provider));
  const metadataA = metadata(provider);
  assert.deepEqual(metadataA.presentWeather, { ww: 61, visibilityKm: 8 });
  assert.equal(metadataA.validTime, FIELD_A.validTime);
  assert.equal(metadataA.packStats.observedTexels, TEX_W * TEX_H);
  assert.equal(metadataA.packStats.filledTexels, 0);
  assert.equal(metadataA.packStats.global, true);

  provider.setTime(B_REQUEST);
  const bytesB = Uint8Array.from(await load(provider));
  const metadataB = metadata(provider);
  assert.notDeepEqual(bytesB, bytesA);
  assert.deepEqual(metadataB.presentWeather, { ww: 73, visibilityKm: 2 });
  assert.equal(metadataB.validTime, FIELD_B.validTime);
  assert.ok(metadataB.packStats.observedTexels > 0);
  assert.ok(metadataB.packStats.filledTexels > 0);
  assert.notDeepEqual(metadataB.packStats, metadataA.packStats);

  return { source, provider, bytesA, bytesB, metadataA, metadataB };
}

async function assertReplayCoherence(Provider = WeatherProvider) {
  const timeline = await buildReplayTimeline(Provider);
  const versionBeforeReplay = timeline.provider.version;

  timeline.provider.setTime(A_REQUEST);
  const replayed = timeline.provider.getPackedTexture(TEX_W, TEX_H);

  assert.deepEqual(
    replayed,
    timeline.bytesA,
    "A bytes were not restored from cache",
  );
  assert.notDeepEqual(replayed, timeline.bytesB, "replay retained B bytes");
  assertMetadata(metadata(timeline.provider), timeline.metadataA, "cached A");
  assert.equal(timeline.provider.version, versionBeforeReplay + 1);
  assert.equal(timeline.source.calls.length, 2, "cached A was refetched");
}

async function assertNoDataFillReplayCoherence(Provider = WeatherProvider) {
  const source = new ImmediateTimelineSource(
    new Map([[B_REQUEST.toISOString(), FIELD_B]]),
  );
  const provider = new Provider(source);
  provider.setQuantizeHours(1);
  provider.setTime(B_REQUEST);
  await load(provider);

  provider.setNoDataFill({
    kind: "constant",
    coverage: 0.05,
    type: 2,
    baseMeters: 900,
    densityBias: 0.1,
  });
  const replacementBytes = await load(provider);
  const replacementMetadata = metadata(provider);
  const replacementVersion = provider.version;
  const requestCount = source.calls.length;
  assert.equal(replacementMetadata.packStats.fillKind, "constant");

  provider.setTime(new Date(B_REQUEST.getTime() + HOUR_MS / 2));
  assert.strictEqual(
    provider.getPackedTexture(TEX_W, TEX_H),
    replacementBytes,
    "setNoDataFill replacement was not cached under its effective time key",
  );
  assertMetadata(
    metadata(provider),
    replacementMetadata,
    "same-hour fill replay",
  );
  assert.equal(provider.version, replacementVersion);
  assert.equal(source.calls.length, requestCount);
}

async function assertInFlightResizeCoherence(Provider = WeatherProvider) {
  const source = new QueueSource();
  const provider = new Provider(source);
  provider.setQuantizeHours(1);
  provider.setTime(A_REQUEST);
  provider.getPackedTexture(TEX_W, TEX_H);
  source.resolve(0, FIELD_A);
  await flushPromises();
  assert.ok(provider.getPackedTexture(TEX_W, TEX_H) instanceof Uint8Array);

  provider.setTime(B_REQUEST);
  assert.equal(provider.getPackedTexture(TEX_W, TEX_H), null);
  assert.equal(source.calls.length, 2);
  const versionBeforeResize = provider.version;

  assert.equal(provider.getPackedTexture(TEX_W * 2, TEX_H * 2), null);
  assert.equal(source.calls.length, 2, "resize duplicated the pending request");
  source.resolve(1, FIELD_B_ALIGNED_TIME);
  await flushPromises();

  assert.equal(provider.hasData, false, "stale-size response became active");
  assert.equal(provider.validTime, undefined);
  assert.equal(provider.getPresentWeather(), null);
  assert.equal(provider.getPackStats(), null);
  assert.equal(provider.version, versionBeforeResize);

  assert.equal(provider.getPackedTexture(TEX_W * 2, TEX_H * 2), null);
  assert.equal(source.calls.length, 3, "resized request was not started");
  source.resolve(2, FIELD_B_ALIGNED_TIME);
  await flushPromises();
  const resized = provider.getPackedTexture(TEX_W * 2, TEX_H * 2);
  assert.ok(resized instanceof Uint8Array);
  assert.equal(resized.length, TEX_W * 2 * (TEX_H * 2) * 4);
  assert.equal(provider.validTime, FIELD_B_ALIGNED_TIME.validTime);
}

test("cached slice replay restores bytes and all field metadata atomically", async () => {
  await assertReplayCoherence();
});

test("same active slice neither refetches nor bumps the version", async () => {
  const timeline = await buildReplayTimeline();
  timeline.provider.setTime(A_REQUEST);
  const replayVersion = timeline.provider.version;
  const replayCalls = timeline.source.calls.length;
  const replayBytes = timeline.provider.getPackedTexture(TEX_W, TEX_H);

  timeline.provider.setTime(new Date(A_REQUEST.getTime() + HOUR_MS / 2));
  const sameBytes = timeline.provider.getPackedTexture(TEX_W, TEX_H);

  assert.strictEqual(
    sameBytes,
    replayBytes,
    "same slice replaced its cached byte array",
  );
  assert.equal(timeline.provider.version, replayVersion);
  assert.equal(timeline.source.calls.length, replayCalls);
});

test("setNoDataFill caches its replacement under the effective timed key", async () => {
  await assertNoDataFillReplayCoherence();
});

test("same-size calls preserve and reuse an in-flight request", async () => {
  const source = new QueueSource();
  const provider = new WeatherProvider(source);
  provider.setQuantizeHours(1);
  provider.setTime(A_REQUEST);

  assert.equal(provider.getPackedTexture(TEX_W, TEX_H), null);
  assert.equal(provider.getPackedTexture(TEX_W, TEX_H), null);
  assert.equal(source.calls.length, 1);
  source.resolve(0, FIELD_A);
  await flushPromises();
  assert.ok(provider.getPackedTexture(TEX_W, TEX_H) instanceof Uint8Array);
  assert.equal(source.calls.length, 1);
});

test("a texture resize invalidates an incompatible in-flight response", async () => {
  await assertInFlightResizeCoherence();
});

test("a late inactive response is cached without changing active metadata", async () => {
  const expectedSource = new ImmediateTimelineSource(
    new Map([[A_REQUEST.toISOString(), FIELD_A]]),
  );
  const expectedProvider = new WeatherProvider(expectedSource);
  expectedProvider.setQuantizeHours(1);
  expectedProvider.setTime(A_REQUEST);
  const expectedBytesA = Uint8Array.from(await load(expectedProvider));
  const expectedMetadataA = metadata(expectedProvider);

  const source = new DeferredTimelineSource();
  const provider = new WeatherProvider(source);
  provider.setQuantizeHours(1);

  provider.setTime(B_REQUEST);
  provider.getPackedTexture(TEX_W, TEX_H);
  source.resolve(B_REQUEST, FIELD_B_ALIGNED_TIME);
  await flushPromises();
  const bytesB = Uint8Array.from(await load(provider));
  const metadataB = metadata(provider);

  provider.setTime(A_REQUEST);
  provider.getPackedTexture(TEX_W, TEX_H);
  provider.setTime(B_REQUEST);
  assert.deepEqual(provider.getPackedTexture(TEX_W, TEX_H), bytesB);
  assertMetadata(metadata(provider), metadataB, "B before late A");

  source.resolve(A_REQUEST, FIELD_A);
  await flushPromises();
  assert.deepEqual(provider.getPackedTexture(TEX_W, TEX_H), bytesB);
  assertMetadata(metadata(provider), metadataB, "B after late A");

  provider.setTime(A_REQUEST);
  assert.deepEqual(
    provider.getPackedTexture(TEX_W, TEX_H),
    expectedBytesA,
    "late A response was not retained in cache",
  );
  assertMetadata(metadata(provider), expectedMetadataA, "cached late A");
  assert.equal(source.calls.length, 2, "late A was not retained in cache");
});

for (const operation of ["setSource", "setRequest", "refresh"]) {
  test(`${operation} invalidates an in-flight result`, async () => {
    const oldSource = new QueueSource();
    const replacementSource = new QueueSource();
    const provider = new WeatherProvider(oldSource);
    provider.getPackedTexture(TEX_W, TEX_H);
    assert.equal(oldSource.calls.length, 1);

    if (operation === "setSource") {
      provider.setSource(replacementSource);
    } else if (operation === "setRequest") {
      provider.setRequest({
        time: "latest",
        bounds: { west: -1, south: -0.5, east: 1, north: 0.5 },
      });
    } else {
      provider.refresh();
    }

    oldSource.resolve(0, FIELD_A);
    await flushPromises();
    assert.equal(provider.hasData, false, "invalidated result became active");
    assert.equal(provider.getPresentWeather(), null);
    assert.equal(provider.getPackStats(), null);

    provider.getPackedTexture(TEX_W, TEX_H);
    const activeSource =
      operation === "setSource" ? replacementSource : oldSource;
    assert.equal(activeSource.calls.length, operation === "setSource" ? 1 : 2);
    activeSource.resolve(operation === "setSource" ? 0 : 1, FIELD_B);
    await flushPromises();
    assert.ok(provider.getPackedTexture(TEX_W, TEX_H) instanceof Uint8Array);
    assert.equal(provider.validTime, FIELD_B.validTime);
    assert.deepEqual(provider.getPresentWeather(), { ww: 73, visibilityKm: 2 });
  });
}

for (const operation of ["setSource", "setRequest", "refresh"]) {
  test(`${operation} clears an active slice and preserves the replacement request`, async () => {
    const source = new QueueSource();
    const replacementSource = new QueueSource();
    const provider = new WeatherProvider(source);
    provider.getPackedTexture(TEX_W, TEX_H);
    source.resolve(0, FIELD_A);
    await flushPromises();
    assert.ok(provider.getPackedTexture(TEX_W, TEX_H) instanceof Uint8Array);
    assertMetadata(
      metadata(provider),
      {
        presentWeather: { ww: 61, visibilityKm: 8 },
        validTime: FIELD_A.validTime,
        packStats: provider.getPackStats(),
      },
      "active A before invalidation",
    );
    const versionBefore = provider.version;
    const originalRequest = source.calls[0];
    const replacementBounds = {
      west: -1,
      south: -0.5,
      east: 1,
      north: 0.5,
    };

    if (operation === "setSource") {
      provider.setSource(replacementSource);
    } else if (operation === "setRequest") {
      provider.setRequest({ time: "latest", bounds: replacementBounds });
    } else {
      provider.refresh();
    }

    assert.equal(provider.hasData, false);
    assert.equal(provider.validTime, undefined);
    assert.equal(provider.getPresentWeather(), null);
    assert.equal(provider.getPackStats(), null);
    assert.equal(provider.version, versionBefore + 1);

    provider.getPackedTexture(TEX_W, TEX_H);
    const activeSource = operation === "setSource" ? replacementSource : source;
    const request = activeSource.calls.at(-1);
    if (operation === "setRequest") {
      assert.deepEqual(request.bounds, replacementBounds);
    } else if (operation === "refresh") {
      assert.deepEqual(request, originalRequest);
    }
    activeSource.resolve(operation === "setSource" ? 0 : 1, FIELD_B);
    await flushPromises();
    assert.ok(provider.getPackedTexture(TEX_W, TEX_H) instanceof Uint8Array);
    assert.equal(provider.validTime, FIELD_B.validTime);
  });
}

for (const operation of ["setSource", "setRequest", "refresh"]) {
  test(`${operation} caches its replacement timed slice under the effective key`, async () => {
    const makeSource = () =>
      new ImmediateTimelineSource(
        new Map([[A_REQUEST.toISOString(), FIELD_A]]),
      );
    const source = makeSource();
    const replacementSource = makeSource();
    const provider = new WeatherProvider(source);
    provider.setQuantizeHours(1);
    provider.setTime(A_REQUEST);
    await load(provider);

    if (operation === "setSource") {
      provider.setSource(replacementSource);
    } else if (operation === "setRequest") {
      provider.setRequest({
        time: "latest",
        bounds: { west: -1, south: -0.5, east: 1, north: 0.5 },
      });
    } else {
      provider.refresh();
    }

    const replacementBytes = await load(provider);
    const replacementMetadata = metadata(provider);
    const replacementVersion = provider.version;
    const requestCount = source.calls.length + replacementSource.calls.length;

    provider.setTime(new Date(A_REQUEST.getTime() + HOUR_MS / 2));
    assert.strictEqual(
      provider.getPackedTexture(TEX_W, TEX_H),
      replacementBytes,
      `${operation} replacement was not cached under its effective time key`,
    );
    assertMetadata(
      metadata(provider),
      replacementMetadata,
      `${operation} same-hour replay`,
    );
    assert.equal(provider.version, replacementVersion);
    assert.equal(
      source.calls.length + replacementSource.calls.length,
      requestCount,
    );
  });
}

test("metadata-blind production mutant is rejected by the replay oracle", async () => {
  const MutantProvider = await loadProvider((source) => {
    const fixedAnchor = "      this._activateSlice(cached, time);";
    if (source.includes(fixedAnchor)) {
      return source.replace(fixedAnchor, "      this._packed = cached.bytes;");
    }
    return source.replace(
      "      this._packed = cached;\n" +
        "      this._validTime = time instanceof Date ? time.toISOString() : undefined;",
      "      this._packed = cached;",
    );
  }, "metadata-blind cached-slice activation");

  await assert.rejects(assertReplayCoherence(MutantProvider), /cached A/);
});

test("setNoDataFill refresh mutant is rejected by the timed replay oracle", async () => {
  const MutantProvider = await loadProvider((source) => {
    const fixedAnchor =
      "    this._version++;\n" +
      "    this._refreshSlice();\n" +
      "  }\n\n" +
      "  /** The active no-data fill override";
    assert.ok(source.includes(fixedAnchor), "setNoDataFill fix anchor missing");
    return source.replace(
      fixedAnchor,
      "    this._version++;\n" +
        "  }\n\n" +
        "  /** The active no-data fill override",
    );
  }, "setNoDataFill effective-key refresh removed");

  await assert.rejects(
    assertNoDataFillReplayCoherence(MutantProvider),
    /effective time key/,
  );
});

test("texture resize invalidation mutant is rejected by the in-flight oracle", async () => {
  const MutantProvider = await loadProvider((source) => {
    const fixedAnchor =
      "      this._cacheH = texH;\n" +
      "      this._invalidation++;\n" +
      "      this._refreshSlice();";
    assert.ok(
      source.includes(fixedAnchor),
      "texture-resize fix anchor missing",
    );
    return source.replace(
      fixedAnchor,
      "      this._cacheH = texH;\n" + "      this._refreshSlice();",
    );
  }, "texture-resize request invalidation removed");

  await assert.rejects(
    assertInFlightResizeCoherence(MutantProvider),
    /stale-size response became active/,
  );
});
