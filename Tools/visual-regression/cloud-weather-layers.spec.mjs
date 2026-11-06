import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
async function bundled(contents, plugins = []) {
  const result = await build({
    stdin: { contents, resolveDir: root },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    plugins,
  });
  return import(
    "data:text/javascript;base64," +
      Buffer.from(result.outputFiles[0].text).toString("base64")
  );
}
const api = await bundled(
  [
    'export * from "./packages/engine/Source/Scene/Weather/WeatherTexPacker.ts";',
    'export * from "./packages/engine/Source/Scene/Weather/WeatherCloudLayers.ts";',
    'export * from "./packages/engine/Source/Scene/Weather/SynopticWeatherField.ts";',
    'export * from "./packages/engine/Source/Scene/Weather/SynopticWeatherSource.ts";',
    'export * from "./packages/engine/Source/Scene/Weather/SynopticCloudLayers.ts";',
    'export * from "./packages/engine/Source/Scene/Weather/WeatherProvider.ts";',
  ].join("\n"),
);
const worker = (
  await bundled(
    'export { default } from "./packages/engine/Source/Workers/createCloudWeather.js";',
    [
      {
        name: "worker-entry",
        setup(build) {
          build.onLoad({ filter: /createTaskProcessorWorker\.js$/ }, () => ({
            contents: "export default fn => fn;",
          }));
        },
      },
    ],
  )
).default;
const bounds = {
  west: -Math.PI,
  east: Math.PI,
  north: Math.PI / 2,
  south: -Math.PI / 2,
};
function field() {
  const count = 12,
    layers = [0, 1, 2].map((layer) => ({
      coverage: new Float32Array(count).fill([0.2, 0.6, 0.9][layer]),
      type: new Float32Array(count).fill([0, 4, 1][layer]),
      baseMeters: new Float32Array(count).fill([1000.5, 4500, 11000][layer]),
      topMeters: new Float32Array(count).fill([3000, 7000, 12500.5][layer]),
      densityBias: new Float32Array(count).fill([0.6, 0.4, 0.2][layer]),
    }));
  return {
    gridWidth: 4,
    gridHeight: 3,
    registration: "cell",
    bounds,
    layers,
    coverage: new Float32Array(count).fill(0.7),
    baseMeters: new Float32Array(count).fill(1000),
    topMeters: new Float32Array(count).fill(4000),
    noDataFill: { kind: "constant", coverage: 0.35 },
  };
}
const decode = (bytes, i = 0) => [
  (bytes[i * 4] + bytes[i * 4 + 1] * 256) * 0.5,
  (bytes[i * 4 + 2] + bytes[i * 4 + 3] * 256) * 0.5,
];

test("authored populations preserve independent coverage, genus, heights and historical input", () => {
  const input = field(),
    ordinary = api.packWeatherFieldDetailed(
      { ...input, layers: undefined },
      16,
      9,
    );
  const packed = api.packWeatherFieldDetailed(input, 16, 9);
  assert.deepEqual(packed.bytes, ordinary.bytes);
  assert.deepEqual(packed.vertical, ordinary.vertical);
  assert.equal(packed.layers.bytes.length, 16 * 9 * 36);
  assert(api.validPackedWeatherCloudLayers(packed.layers, 16, 9));
  assert(Object.isFrozen(packed.layers));
  assert(Object.isFrozen(packed.layers.bounds));
  for (let layer = 0; layer < 3; layer++) {
    const result = api.packedWeatherCloudLayerFrame(
      packed.layers,
      layer,
      16,
      9,
    );
    assert.equal(
      result.bytes[0],
      Math.round(input.layers[layer].coverage[0] * 255),
    );
    assert.equal(
      result.bytes[1],
      Math.round((input.layers[layer].type[0] / 10) * 255),
    );
    assert.deepEqual(decode(result.vertical.bytes), [
      input.layers[layer].baseMeters[0],
      input.layers[layer].topMeters[0],
    ]);
    assert.deepEqual([...result.support.slice(0, 4)], [255, 255, 0, 0]);
    assert.equal(result.bytes.buffer, packed.layers.bytes.buffer);
  }
  assert.equal(
    api.packedWeatherCloudLayerFrame(packed.layers, -1, 16, 9),
    undefined,
  );
  assert.equal(
    api.packedWeatherCloudLayerFrame(packed.layers, 3, 16, 9),
    undefined,
  );
  assert.equal(api.validPackedWeatherCloudLayers(packed.layers, 8, 9), false);
  input.layers[0].topMeters.fill(22000);
  assert.equal(
    api.packWeatherFieldDetailed(input, 16, 9).layers.bounds[0].maximumTop,
    22000,
  );
  assert.equal(ordinary.layers, undefined);
});

test("known clear, unknown coverage and unknown height remain separate across regional boundaries", () => {
  const input = field();
  input.bounds = {
    west: -Math.PI / 3,
    east: Math.PI / 3,
    south: -0.5,
    north: 0.5,
  };
  input.layers[0].coverage.fill(0);
  input.layers[1].coverage.fill(NaN);
  input.layers[2].topMeters.fill(NaN);
  const packed = api.packWeatherFieldDetailed(input, 32, 17);
  const clear = api.packedWeatherCloudLayerFrame(packed.layers, 0, 32, 17);
  const missing = api.packedWeatherCloudLayerFrame(packed.layers, 1, 32, 17);
  const heightMissing = api.packedWeatherCloudLayerFrame(
    packed.layers,
    2,
    32,
    17,
  );
  assert.equal(missing.vertical, undefined);
  assert.equal(heightMissing.vertical, undefined);
  let clearCount = 0,
    unknownCount = 0,
    coverageWithoutHeight = 0;
  for (let i = 0; i < 32 * 17; i++) {
    assert.equal(missing.support[i * 4], 0);
    assert.equal(missing.support[i * 4 + 1], 0);
    if (clear.support[i * 4] > 0) {
      clearCount++;
      assert.equal(clear.bytes[i * 4], 0);
      assert.equal(clear.support[i * 4 + 1], 255);
      assert.equal(heightMissing.support[i * 4], 255);
      assert.equal(heightMissing.support[i * 4 + 1], 0);
      coverageWithoutHeight++;
    } else {
      unknownCount++;
      assert.equal(clear.support[i * 4 + 1], 0);
    }
  }
  assert(clearCount > 0 && unknownCount > clearCount);
  assert.equal(coverageWithoutHeight, clearCount);
  assert(api.validPackedWeatherCloudLayers(packed.layers, 32, 17));
  input.bounds = {
    west: -Math.PI / 3,
    east: Math.PI / 3,
    south: 1.1,
    north: Math.PI / 2,
  };
  const polar = api.packedWeatherCloudLayerFrame(
    api.packWeatherFieldDetailed(input, 32, 17).layers,
    0,
    32,
    17,
  );
  let observedPolar = 0;
  for (let i = 0; i < 32 * 17; i++) {
    if (polar.support[i * 4] > 0) {
      observedPolar++;
      assert.equal(polar.bytes[i * 4], 0);
    }
  }
  assert(observedPolar > 0);
  const ordinaryPolar = api.packWeatherFieldDetailed(
    { ...input, ...input.layers[0], layers: undefined },
    32,
    17,
  );
  assert(
    Array.from({ length: 32 * 17 }, (_, i) => i).some(
      (i) => polar.support[i * 4] > 0 && ordinaryPolar.bytes[i * 4] > 0,
    ),
    "the ordinary fallback filter must expose the polar clear-support defect",
  );
});

test("seam interpolation carries fractional observation support without filling missing heights", () => {
  const input = field();
  input.layers[0].coverage.fill(NaN);
  for (const i of [0, 4, 8]) input.layers[0].coverage[i] = 1;
  input.layers[0].baseMeters.fill(127.5);
  input.layers[0].topMeters.fill(256.5);
  const packed = api.packWeatherFieldDetailed(input, 32, 17);
  const low = api.packedWeatherCloudLayerFrame(packed.layers, 0, 32, 17);
  let partial = 0;
  for (let x = 0; x < 32; x++) {
    const i = 8 * 32 + x,
      support = low.support[i * 4];
    if (support > 0 && support < 255) {
      partial++;
      assert.equal(low.support[i * 4 + 1], support);
      assert.deepEqual(decode(low.vertical.bytes, i), [127.5, 256.5]);
    }
  }
  assert(partial > 0);
  assert.equal(low.support[8 * 32 * 4], low.support[(8 * 32 + 7) * 4]);
  const malformed = field();
  malformed.layers[1].topMeters = new Float32Array(1);
  assert.throws(
    () => api.packWeatherFieldDetailed(malformed, 16, 9),
    /match the weather grid/,
  );
  malformed.layers = malformed.layers.slice(0, 2);
  assert.throws(
    () => api.packWeatherFieldDetailed(malformed, 16, 9),
    /Three cloud populations/,
  );
  malformed.layers = new Array(3);
  assert.throws(
    () => api.packWeatherFieldDetailed(malformed, 16, 9),
    /Three cloud populations/,
  );
  assert.equal(
    api.validPackedWeatherCloudLayers(
      { ...packed.layers, bounds: [null, undefined, undefined] },
      32,
      17,
    ),
    false,
  );
});

test("cooperative packing owns every layer array and cancels before publishing partial data", async () => {
  const input = field(),
    expected = api.packWeatherFieldDetailed(input, 256, 256);
  const promise = api.packWeatherFieldDetailedAsync(input, 256, 256, {
    useWorkers: false,
  });
  for (const layer of input.layers) {
    layer.coverage.fill(0);
    layer.baseMeters.fill(0);
    layer.topMeters.fill(1);
    layer.type.fill(10);
    layer.densityBias.fill(1);
  }
  const result = await promise;
  assert.deepEqual(result.layers, expected.layers);
  let cancel = false;
  const aborted = api.packWeatherFieldDetailedAsync(
    field(),
    256,
    256,
    { useWorkers: false },
    () => cancel,
  );
  cancel = true;
  assert.equal(await aborted, null);
});

test("seeded independent populations replay seed/time and preserve full low-based towers", async () => {
  const time = Date.parse("2026-10-19T12:00:00Z");
  const ordinary = await api.generateSynopticWeatherField(
    "layers",
    64,
    33,
    time,
    () => false,
    false,
  );
  const a = await api.generateSynopticWeatherField(
    "layers",
    64,
    33,
    time,
    () => false,
    false,
    true,
  );
  const b = await api.generateSynopticWeatherField(
    "layers",
    64,
    33,
    time,
    () => false,
    true,
    true,
  );
  assert.equal(ordinary.layers, undefined);
  for (const name of [
    "coverage",
    "type",
    "baseMeters",
    "topMeters",
    "densityBias",
  ])
    assert.deepEqual(a[name], ordinary[name]);
  assert.deepEqual(a.layers, b.layers);
  assert.notDeepEqual(a.layers[0].coverage, a.layers[1].coverage);
  assert.notDeepEqual(a.layers[1].coverage, a.layers[2].coverage);
  assert.deepEqual(a.layers[0].topMeters, a.topMeters);
  assert(Math.max(...a.layers[0].topMeters) > 10000);
  assert(a.layers[1].baseMeters.every((v) => v >= 4000 && v <= 5000));
  assert(a.layers[2].baseMeters.every((v) => v >= 8500 && v <= 11000));
  const later = await api.generateSynopticWeatherField(
    "layers",
    64,
    33,
    time + 21600000,
    () => false,
    false,
    true,
  );
  const other = await api.generateSynopticWeatherField(
    "other",
    64,
    33,
    time,
    () => false,
    false,
    true,
  );
  assert.notDeepEqual(a.layers, later.layers);
  assert.notDeepEqual(a.layers, other.layers);
  const source = new api.SynopticWeatherSource("layers", 64, 33);
  assert.deepEqual(
    (
      await source.fetchField({
        time: new Date(time),
        independentCloudLayers: true,
        useWorkers: false,
      })
    ).layers,
    a.layers,
  );
});

// The recorded values of the three cloud populations: for each seed, the
// generated field's populations at fixed grid cells and over the whole grid,
// and the population function evaluated on fixed regimes.
// CLOUD_WEATHER_LAYER_VALUES_OUT=<file> records them there instead of
// asserting.
const VALUES_FIXTURE = path.join(
  here,
  "fixtures/cloud-weather-layers-values.json",
);
const VALUE_SEEDS = ["layers", "other", "front-7"];
const VALUE_ARRAYS = [
  "coverage",
  "type",
  "baseMeters",
  "topMeters",
  "densityBias",
];
const VALUE_TIME = Date.parse("2026-10-19T12:00:00Z");
const VALUE_GRID = { width: 64, height: 33, stride: 137 };
const regime = (overrides) => ({
  coverage: 0.6,
  cloudType: 3,
  baseMeters: 1200,
  topMeters: 5200,
  densityBias: 0.5,
  front: 0,
  head: 0,
  tropical: 0,
  suppression: 0,
  regional: 0,
  cellular: 0,
  latitude: 0,
  ...overrides,
});
const VALUE_REGIMES = [
  regime({}),
  regime({ front: 0.5 }),
  regime({ head: 1 }),
  regime({ head: 0.4, front: 0.3, latitude: 0.8 }),
  regime({ tropical: 0.7, latitude: 0.3 }),
  regime({ regional: 0.9, cellular: 0.5, latitude: 1.2 }),
  regime({
    front: 0.8,
    head: 0.6,
    tropical: 0.4,
    suppression: 0.8,
    regional: 0.5,
    cellular: 0.9,
    latitude: -0.6,
  }),
];
async function observedPopulations() {
  const { width, height, stride } = VALUE_GRID;
  const seeds = {};
  for (const seed of VALUE_SEEDS) {
    const field = await api.generateSynopticWeatherField(
      seed,
      width,
      height,
      VALUE_TIME,
      () => false,
      false,
      true,
    );
    const indices = [];
    for (let i = 3; i < width * height; i += stride) indices.push(i);
    seeds[seed] = {
      source: field.source,
      indices,
      populations: field.layers.map((layer) =>
        Object.fromEntries(
          VALUE_ARRAYS.map((name) => [
            name,
            {
              samples: indices.map((i) => layer[name][i]),
              sum: layer[name].reduce((total, value) => total + value, 0),
              min: Math.min(...layer[name]),
              max: Math.max(...layer[name]),
            },
          ]),
        ),
      ),
    };
  }
  return {
    description:
      "Cloud population values: per seed, the three populations of the independent-layer field at fixed cells and over the whole grid, and the population function on fixed regimes.",
    time: VALUE_TIME,
    grid: VALUE_GRID,
    seeds,
    regimes: VALUE_REGIMES.map((input) => ({
      input,
      populations: api.sampleSynopticCloudLayers(input),
    })),
  };
}
function assertRecorded(actual, expected, label) {
  if (typeof expected === "number") {
    assert.equal(typeof actual, "number", label);
    assert(
      Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)),
      `${label}: ${actual} differs from the recorded ${expected}`,
    );
  } else if (expected !== null && typeof expected === "object") {
    assert.deepEqual(Object.keys(actual), Object.keys(expected), label);
    for (const key of Object.keys(expected))
      assertRecorded(actual[key], expected[key], `${label}.${key}`);
  } else assert.equal(actual, expected, label);
}

test("the three populations keep their recorded values for several seeds, cells and regimes", async () => {
  const observed = await observedPopulations();
  if (process.env.CLOUD_WEATHER_LAYER_VALUES_OUT) {
    fs.writeFileSync(
      process.env.CLOUD_WEATHER_LAYER_VALUES_OUT,
      JSON.stringify(observed, null, 2) + "\n",
    );
    return;
  }
  const recorded = JSON.parse(fs.readFileSync(VALUES_FIXTURE, "utf8"));
  assertRecorded(JSON.parse(JSON.stringify(observed)), recorded, "values");
});

test("actual worker handlers transfer every new array and preserve cooperative packed bytes", async () => {
  const timeMs = Date.parse("2026-10-19T12:00:00Z"),
    transfer = [];
  const generated = await worker(
    {
      kind: "synoptic",
      seed: "worker-layers",
      width: 16,
      height: 9,
      timeMs,
      independentCloudLayers: true,
    },
    transfer,
  );
  assert.equal(transfer.length, 22);
  assert.equal(new Set(transfer).size, 22);
  const moved = structuredClone(generated, { transfer });
  assert.equal(generated.layers[0].coverage.byteLength, 0);
  const expected = await api.generateSynopticWeatherField(
    "worker-layers",
    16,
    9,
    timeMs,
    () => false,
    true,
    true,
  );
  assert.deepEqual(moved.layers, expected.layers);
  const packedTransfers = [],
    input = field();
  const packed = await worker(
    { kind: "pack", field: input, width: 32, height: 17 },
    packedTransfers,
  );
  assert.equal(packedTransfers.length, 3);
  const packedMoved = structuredClone(packed, { transfer: packedTransfers });
  assert.equal(packed.layers.bytes.byteLength, 0);
  assert.deepEqual(
    packedMoved,
    await api.packWeatherFieldDetailedAsync(input, 32, 17, {
      useWorkers: false,
    }),
  );
});

test("provider publishes and replays current/prior layers atomically with owned frozen headers", async () => {
  let latest,
    fetches = 0;
  const source = {
    async fetchField(request) {
      fetches++;
      latest = field();
      latest.validTime = request.time.toISOString();
      latest.layers[1].topMeters.fill(6000 + request.time.getUTCHours() * 100);
      return latest;
    },
  };
  const start = Date.parse("2026-10-19T12:00:00Z"),
    provider = new api.WeatherProvider(source);
  provider.useWorkers = false;
  provider.setTimeMode("scene");
  provider.tickSceneTime(start);
  async function publication() {
    const deadline = Date.now() + 5000;
    while (true) {
      const value = provider.getPackedPublication(32, 17);
      if (value && !provider.isPreparing) return value;
      assert(
        Date.now() < deadline,
        provider.lastError ?? "publication timeout",
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  const first = await publication(),
    original = first.current.layers.bytes.slice();
  assert(Object.isFrozen(first.current.layers));
  assert(Object.isFrozen(first.current.layers.bounds));
  assert(first.current.layers.bounds.every(Object.isFrozen));
  latest.layers[0].coverage.fill(0);
  latest.layers[1].topMeters.fill(30000);
  assert.deepEqual(first.current.layers.bytes, original);
  assert.equal(provider.getPackStats().layers, undefined);
  provider.tickSceneTime(start + 3600000);
  const next = await publication();
  assert.equal(next.previous, first.current);
  assert.equal(next.current.layers.bounds[1].maximumTop, 7300);
  assert.equal(next.previous.layers.bounds[1].maximumTop, 7200);
  const count = fetches;
  provider.tickSceneTime(start);
  const replay = await publication();
  assert.equal(replay.current, first.current);
  assert.equal(fetches, count);
});
