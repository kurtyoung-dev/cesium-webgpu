import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const { outputFiles } = await build({
  stdin: {
    contents: [
      'export * from "./packages/engine/Source/Scene/Weather/WeatherTexPacker.ts";',
      'export * from "./packages/engine/Source/Scene/Weather/WeatherVerticalField.ts";',
      'export * from "./packages/engine/Source/Scene/Weather/SynopticWeatherField.ts";',
      'export * from "./packages/engine/Source/Scene/Weather/WeatherProvider.ts";',
    ].join("\n"),
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const api = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].text).toString("base64")
);
const bounds = {
  west: -Math.PI,
  east: Math.PI,
  north: Math.PI / 2,
  south: -Math.PI / 2,
};
const field = () => ({
  gridWidth: 4,
  gridHeight: 3,
  registration: "cell",
  bounds,
  coverage: new Float32Array(12).fill(0.7),
  baseMeters: new Float32Array(12).fill(1000.5),
  noDataFill: { kind: "constant", coverage: 0.45 },
});
const decode = (bytes, i) => [
  (bytes[i * 4] + 256 * bytes[i * 4 + 1]) * 0.5,
  (bytes[i * 4 + 2] + 256 * bytes[i * 4 + 3]) * 0.5,
];

test("optional vertical packing preserves the complete historical weather plane", () => {
  const input = field(),
    ordinary = api.packWeatherFieldDetailed(input, 16, 9);
  assert.equal(ordinary.vertical, undefined);
  input.topMeters = new Float32Array(12).fill(5432);
  const packed = api.packWeatherFieldDetailed(input, 16, 9);
  assert.deepEqual(packed.bytes, ordinary.bytes);
  assert.ok(api.validPackedWeatherVertical(packed.vertical, 16, 9));
  assert.deepEqual(decode(packed.vertical.bytes, 72), [1000.5, 5432]);
  assert.equal(packed.vertical.minimumBase, 1000.5);
  assert.equal(packed.vertical.maximumTop, 5432);
  assert.ok(Object.isFrozen(packed.vertical));
});

test("regional gaps and invalid height pairs retain coverage and explicit missing metadata", () => {
  const input = field();
  input.bounds = {
    west: -Math.PI / 4,
    east: Math.PI / 4,
    south: -0.5,
    north: 0.5,
  };
  input.topMeters = new Float32Array(12).fill(5000);
  input.topMeters[0] = NaN;
  input.baseMeters[1] = -9999;
  input.topMeters[2] = 1000;
  input.topMeters[3] = 40000;
  input.noDataValue = -9999;
  const ordinary = api.packWeatherFieldDetailed(
    { ...input, topMeters: undefined },
    32,
    17,
  );
  const packed = api.packWeatherFieldDetailed(input, 32, 17);
  assert.deepEqual(packed.bytes, ordinary.bytes);
  assert.equal(packed.filledTexels, ordinary.filledTexels);
  assert.deepEqual(decode(packed.vertical.bytes, 0), [0, 0]);
  let known = 0,
    missing = 0;
  for (let i = 0; i < 32 * 17; i++) {
    const [base, top] = decode(packed.vertical.bytes, i);
    if (top === 0) {
      missing++;
    } else {
      known++;
      assert.ok(base >= 0 && top >= base + 1 && top <= 32767.5);
    }
  }
  assert.ok(known > 0 && missing > known);
  input.topMeters.fill(NaN);
  const absent = api.packWeatherFieldDetailed(input, 32, 17);
  assert.equal(absent.vertical, undefined);
  assert.deepEqual(absent.bytes, packed.bytes);
  input.topMeters = new Float32Array(1);
  assert.throws(
    () => api.packWeatherFieldDetailed(input, 32, 17),
    /match the weather grid/,
  );
});

test("height interpolation follows cloudy support and polar filtering preserves byte carries", () => {
  const input = field();
  input.baseMeters.set([100, 20000]);
  input.topMeters = new Float32Array(12).fill(21000);
  input.topMeters[0] = 200;
  input.coverage.set([1, 0]);
  const heights = new Uint16Array(2),
    coverage = new Float32Array(1);
  api.sampleWeatherVertical(
    input,
    {
      i00: 0,
      i10: 1,
      i01: 0,
      i11: 1,
      tx: 0.5,
      ty: 0,
      v00: true,
      v10: true,
      v01: true,
      v11: true,
    },
    heights,
    coverage,
    0,
  );
  assert.deepEqual([...heights], [200, 400]);
  input.coverage.fill(0);
  api.sampleWeatherVertical(
    input,
    {
      i00: 0,
      i10: 1,
      i01: 0,
      i11: 1,
      tx: 0.5,
      ty: 0,
      v00: true,
      v10: true,
      v01: true,
      v11: true,
    },
    heights,
    coverage,
    0,
  );
  assert.deepEqual([...heights], [20100, 21200]);
  const polar = new Uint16Array(4 * 3 * 2);
  for (let i = 0; i < 12; i++) {
    polar[i * 2] = i % 2 ? 257 : 255;
    polar[i * 2 + 1] = 1000;
  }
  // Unknown samples must stay unknown, including inside the polar window.
  polar[4] = 0;
  polar[5] = 0;
  const filtered = api.finishWeatherVertical(
    polar,
    4,
    3,
    new Float32Array(12).fill(1),
  );
  assert.deepEqual(decode(filtered.bytes, 2), [0, 0]);
  for (const i of [0, 1, 3]) {
    const [base, top] = decode(filtered.bytes, i);
    assert.equal(base, 128);
    assert.equal(top, 500);
  }
});

test("seeded tops follow weather regimes and reproduce across worker/cooperative execution", async () => {
  const time = Date.parse("2026-10-19T12:00:00Z");
  const a = await api.generateSynopticWeatherField(
    "vertical",
    64,
    33,
    time,
    () => false,
    false,
  );
  const b = await api.generateSynopticWeatherField("vertical", 64, 33, time);
  assert.deepEqual(a.topMeters, b.topMeters);
  const depths = a.topMeters.map((top, i) => top - a.baseMeters[i]);
  assert.ok(Math.min(...depths) >= 500 && Math.max(...depths) > 5000);
  assert.ok(depths.every((depth) => depth < 13000));
  const later = await api.generateSynopticWeatherField(
    "vertical",
    64,
    33,
    time + 21600000,
    () => false,
    false,
  );
  assert.notDeepEqual(a.topMeters, later.topMeters);
  assert.deepEqual(
    (await api.packWeatherFieldDetailedAsync(a, 64, 33, { useWorkers: false }))
      .vertical,
    api.packWeatherFieldDetailed(a, 64, 33).vertical,
  );
});

test("provider publication owns and atomically replays vertical metadata with its weather slice", async () => {
  let fetches = 0;
  const source = {
    async fetchField(request) {
      fetches++;
      const value = field();
      value.validTime = request.time.toISOString();
      value.topMeters = new Float32Array(12).fill(
        3000 + request.time.getUTCHours() * 100,
      );
      return value;
    },
  };
  const start = new Date("2026-10-19T12:00:00Z");
  const provider = new api.WeatherProvider(source, { time: start });
  provider.useWorkers = false;
  provider.setTimeMode("scene");
  provider.tickSceneTime(start.getTime());
  const published = async () => {
    const deadline = Date.now() + 5000;
    while (true) {
      const result = provider.getPackedPublication(16, 9);
      if (result && !provider.isPreparing) {
        return result;
      }
      assert.ok(
        Date.now() < deadline,
        provider.lastError ?? "weather publication timeout",
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
  const first = await published();
  assert.ok(Object.isFrozen(first.current.vertical));
  assert.equal(first.current.vertical.maximumTop, 4200);
  assert.equal(provider.getPackStats().vertical, undefined);
  provider.tickSceneTime(start.getTime() + 3600000);
  const next = await published();
  assert.equal(next.previous, first.current);
  assert.equal(next.current.vertical.maximumTop, 4300);
  assert.equal(next.previous.vertical.maximumTop, 4200);
  const count = fetches;
  provider.tickSceneTime(start.getTime());
  const replay = await published();
  assert.equal(replay.current, first.current);
  assert.equal(fetches, count);
});
