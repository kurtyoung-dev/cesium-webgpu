import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
// CLOUD_WEATHER_MODELS_CAPTURE=<key> turns this file into a recorder: it
// generates the fixture on the main thread and writes the digests under <key>
// to CLOUD_WEATHER_MODELS_OUT instead of asserting. It touches only modules
// every revision has, so it also runs on a tree that has no weather worker.
const captureKey = process.env.CLOUD_WEATHER_MODELS_CAPTURE;
const spec = captureKey ? test.skip : test;
let serial = 0;
const importBundle = async (options) => {
  const built = await build({
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    ...options,
  });
  return import(
    "data:text/javascript;base64," +
      Buffer.from(built.outputFiles[0].text + "\n// " + serial++).toString(
        "base64",
      )
  );
};
let workerRun;
const worker = async (...args) => {
  workerRun ??= (
    await importBundle({
      stdin: {
        contents:
          'export { default as run } from "./packages/engine/Source/Workers/createCloudWeather.js";',
        resolveDir: root,
      },
      plugins: [
        {
          name: "worker-function",
          setup(b) {
            b.onResolve({ filter: /createTaskProcessorWorker\.js$/ }, () => ({
              path: "wrapper",
              namespace: "mock",
            }));
            b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
              contents: "export default f => f;",
            }));
          },
        },
      ],
    })
  ).run;
  return workerRun(...args);
};
const taskProcessorMock = {
  name: "task-processor",
  setup(b) {
    b.onResolve({ filter: /Core\/TaskProcessor\.js$/ }, () => ({
      path: "processor",
      namespace: "mock",
    }));
    b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
      contents: [
        "export default class {",
        "constructor(name, limit) { globalThis.__cloudWeatherTasks.created++; globalThis.__cloudWeatherTasks.name=name; globalThis.__cloudWeatherTasks.limit=limit; }",
        "scheduleTask(parameters) { return globalThis.__cloudWeatherTasks.run(parameters); }",
        "destroy() { globalThis.__cloudWeatherTasks.destroyed++; }",
        "}",
      ].join("\n"),
    }));
  },
};
async function fixture(t) {
  const previous = ["window", "Worker", "__cloudWeatherTasks"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]);
  const record = {
    created: 0,
    calls: [],
    destroyed: 0,
    busy: false,
    fail: false,
    delayed: false,
    pending: [],
  };
  record.run = (parameters) => {
    record.calls.push(parameters);
    if (record.fail) throw new Error("injected weather worker failure");
    if (record.busy) return undefined;
    const input = structuredClone(parameters);
    const execute = async () => {
      const transfers = [],
        value = await worker(input, transfers);
      return structuredClone(value, { transfer: transfers });
    };
    return record.delayed
      ? new Promise((resolve, reject) =>
          record.pending.push(() => execute().then(resolve, reject)),
        )
      : execute();
  };
  globalThis.window = {};
  globalThis.Worker = function () {};
  globalThis.__cloudWeatherTasks = record;
  t.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const apiExtras = [
    'export * from "./packages/engine/Source/Scene/Weather/WeatherProvider.ts";',
    'export { default as CloudWeatherState } from "./packages/engine/Source/Scene/CloudWeatherState.js";',
  ];
  const modules = [
    "SynopticWeatherSource.ts",
    "SynopticWeatherField.ts",
    "WeatherTexPacker.ts",
    "TensorCloudMaterialFlow.ts",
  ];
  const api = await importBundle({
    stdin: {
      contents: (captureKey
        ? modules.filter((m) => m !== "SynopticWeatherField.ts")
        : modules
      )
        .map(
          (m) => `export * from "./packages/engine/Source/Scene/Weather/${m}";`,
        )
        .concat(captureKey ? [] : apiExtras)
        .join("\n"),
      resolveDir: root,
    },
    plugins: [taskProcessorMock],
  });
  return { api, record };
}
const time = new Date("2026-10-19T12:00:00.000Z");
const arrays = (field) =>
  ["coverage", "type", "baseMeters", "topMeters", "densityBias"]
    .map((name) => field[name])
    .concat([
      field.environmentalTensors.atmosphericBytes,
      field.environmentalTensors.marineBytes,
    ]);

// The recorded fixture: three seeds at two times on a small grid. Each case is
// generated, packed and turned into a wind field, and every output array is
// reduced to a sha256 digest.
const GRID = { width: 32, height: 17, packWidth: 64, packHeight: 33 };
const CASES = [
  { seed: "cloud-key", time: "2026-10-19T12:00:00.000Z" },
  { seed: "cloud-key", time: "2026-10-20T03:30:00.000Z" },
  { seed: 7, time: "2026-10-19T12:00:00.000Z" },
  { seed: 7, time: "2026-10-20T03:30:00.000Z" },
  { seed: "atlas", time: "2026-10-19T12:00:00.000Z" },
  { seed: "atlas", time: "2026-10-20T03:30:00.000Z" },
];
const caseKey = (c) => `${typeof c.seed}:${c.seed}@${c.time}`;
// Runs the three weather jobs the way a consumer does. `useWorkers: true` opts
// in to the shared worker for each job; otherwise no argument names a worker.
async function generate(api, c, useWorkers) {
  const when = new Date(c.time);
  const field = await new api.SynopticWeatherSource(
    c.seed,
    GRID.width,
    GRID.height,
  ).fetchField(useWorkers ? { time: when, useWorkers: true } : { time: when });
  const pack = await api.packWeatherFieldDetailedAsync(
    field,
    GRID.packWidth,
    GRID.packHeight,
    useWorkers ? { useWorkers: true } : undefined,
  );
  const flow = useWorkers
    ? await api.tensorCloudMaterialFlow(
        field.environmentalTensors,
        when.getTime(),
        () => false,
        true,
        true,
      )
    : await api.tensorCloudMaterialFlow(
        field.environmentalTensors,
        when.getTime(),
      );
  return { field, pack, flow };
}
const sha = (array) =>
  createHash("sha256")
    .update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength))
    .digest("hex");
function digests({ field, pack, flow }) {
  return {
    coverage: sha(field.coverage),
    type: sha(field.type),
    baseMeters: sha(field.baseMeters),
    densityBias: sha(field.densityBias),
    atmosphericBytes: sha(field.environmentalTensors.atmosphericBytes),
    marineBytes: sha(field.environmentalTensors.marineBytes),
    packBytes: sha(pack.bytes),
    flowDisplacement: sha(flow.displacement),
    flowVelocity: sha(flow.velocity),
  };
}
// The regional vertical data a pack publishes with the field: the cloud-top
// plane of the field and the packed vertical bounds texture.
const verticalDigests = ({ field, pack }) => ({
  topMeters: sha(field.topMeters),
  verticalBytes: sha(pack.vertical.bytes),
  minimumBase: pack.vertical.minimumBase,
  maximumTop: pack.vertical.maximumTop,
});
const models = () =>
  JSON.parse(
    fs.readFileSync(
      path.join(here, "fixtures/cloud-weather-synoptic-models.json"),
      "utf8",
    ),
  );
// The weather model the generation is expected to reproduce. The recorded
// historical model is the control: the generation must no longer reproduce it.
const MODEL = "continuous";

const capture = captureKey ? test : () => {};
capture("capture the main-thread weather digests", async (t) => {
  const { api } = await fixture(t);
  const recorded = { [captureKey]: {} };
  for (const c of CASES)
    recorded[captureKey][caseKey(c)] = digests(await generate(api, c, false));
  fs.writeFileSync(
    process.env.CLOUD_WEATHER_MODELS_OUT,
    JSON.stringify(recorded, null, 2) + "\n",
  );
});

spec(
  "one lazy bounded TaskProcessor handles cloneable synoptic,packing and geographic flow jobs",
  async (t) => {
    const { api, record } = await fixture(t);
    const source = new api.SynopticWeatherSource("cloud-key", 32, 17);
    assert.equal(record.created, 0);
    const field = await source.fetchField({ time, useWorkers: true });
    assert.equal(record.created, 1);
    assert.equal(record.name, "createCloudWeather");
    assert.equal(record.limit, 1);
    assert.equal(typeof field.environmentalTensors.sample, "function");
    const expected = await api.generateSynopticWeatherField(
      "cloud-key",
      32,
      17,
      time.getTime(),
      () => false,
      false,
    );
    arrays(field).forEach((a, i) => assert.deepEqual(a, arrays(expected)[i]));
    const packed = await api.packWeatherFieldDetailedAsync(field, 64, 33, {
      useWorkers: true,
    });
    assert.deepEqual(packed, api.packWeatherFieldDetailed(field, 64, 33));
    const flow = await api.tensorCloudMaterialFlow(
      field.environmentalTensors,
      time.getTime(),
      () => false,
      true,
      true,
    );
    const directFlow = await api.tensorCloudMaterialFlow(
      field.environmentalTensors,
      time.getTime(),
      () => false,
      false,
    );
    assert.deepEqual(flow, directFlow);
    assert.deepEqual(
      record.calls.map((p) => p.kind),
      ["synoptic", "pack", "flow"],
    );
    assert.equal(record.created, 1);
    assert.equal(field.coverage.byteLength, 32 * 17 * 4);
    assert.equal(
      field.environmentalTensors.atmosphericBytes.byteLength,
      32 * 17 * 4,
    );
  },
);

spec(
  "the worker path and the main-thread path return equal weather, packing and wind, and the worker is called for each",
  async (t) => {
    for (const c of CASES) {
      const { api, record } = await fixture(t);
      const remote = await generate(api, c, true);
      assert.deepEqual(
        record.calls.map((p) => p.kind),
        ["synoptic", "pack", "flow"],
        caseKey(c),
      );
      assert.equal(record.created, 1);
      const calls = record.calls.length;
      const local = await generate(api, c, false);
      assert.equal(
        record.calls.length,
        calls,
        "the main-thread path must not call the worker",
      );
      arrays(remote.field).forEach((a, i) =>
        assert.deepEqual(a, arrays(local.field)[i], `${caseKey(c)} array ${i}`),
      );
      assert.deepEqual(remote.pack, local.pack, caseKey(c));
      assert.deepEqual(remote.flow, local.flow, caseKey(c));
      assert.deepEqual(digests(remote), digests(local), caseKey(c));
    }
  },
);

spec(
  "the regional vertical plane is published with the field and is identical on the worker and main-thread paths",
  async (t) => {
    for (const c of CASES) {
      const { api, record } = await fixture(t);
      const remote = await generate(api, c, true);
      const local = await generate(api, c, false);
      for (const side of [remote, local]) {
        const { field, pack } = side;
        assert.equal(field.topMeters.length, GRID.width * GRID.height);
        assert.ok(pack.vertical, `${caseKey(c)} publishes a vertical plane`);
        assert.ok(pack.vertical.bytes.some((byte) => byte !== 0));
        assert.ok(pack.vertical.maximumTop > pack.vertical.minimumBase);
        for (let i = 0; i < field.topMeters.length; i++)
          assert.ok(field.topMeters[i] > field.baseMeters[i], `cell ${i}`);
      }
      assert.deepEqual(remote.field.topMeters, local.field.topMeters);
      assert.deepEqual(remote.pack.vertical, local.pack.vertical, caseKey(c));
      assert.deepEqual(verticalDigests(remote), verticalDigests(local));
      // The pack job's wire payload carries the cloud-top plane to the worker.
      const job = record.calls.find((p) => p.kind === "pack");
      assert.deepEqual(job.field.topMeters, local.field.topMeters);
      // and hands the vertical bytes back as a transferable it owns.
      const transfers = [];
      const result = await worker(structuredClone(job), transfers);
      assert.ok(transfers.includes(result.vertical.bytes.buffer));
      assert.ok(transfers.includes(result.bytes.buffer));
    }
  },
);

spec(
  "with no opt-in none of the three weather jobs creates a worker or schedules a task",
  async (t) => {
    const { api, record } = await fixture(t);
    const source = new api.SynopticWeatherSource("no-opt-in", 16, 9);
    // Only a boolean true opts in: absent, false and non-boolean values all stay on the calling thread.
    for (const useWorkers of [undefined, false, 1, "true"]) {
      const field = await source.fetchField({ time, useWorkers });
      await api.packWeatherFieldDetailedAsync(field, 32, 17, { useWorkers });
    }
    for (const useWorkers of [undefined, false]) {
      const field = await source.fetchField({ time });
      await api.tensorCloudMaterialFlow(
        field.environmentalTensors,
        time.getTime(),
        () => false,
        true,
        useWorkers,
      );
    }
    await api.tensorCloudMaterialFlow(
      (await source.fetchField({ time })).environmentalTensors,
      time.getTime(),
    );
    assert.equal(record.created, 0);
    assert.equal(record.calls.length, 0);
    // Opting in on one job spawns the worker for that job only.
    const field = await source.fetchField({ time });
    await api.packWeatherFieldDetailedAsync(field, 32, 17, {
      useWorkers: true,
    });
    assert.deepEqual(
      record.calls.map((p) => p.kind),
      ["pack"],
    );
  },
);

spec(
  "the main-thread generation reproduces the recorded weather model byte for byte, on both paths",
  async (t) => {
    const recorded = models();
    assert.deepEqual(recorded.grid, GRID);
    assert.equal(
      Object.keys(recorded[MODEL]).length,
      CASES.length,
      "every case is recorded",
    );
    for (const c of CASES) {
      const { api } = await fixture(t);
      const expected = recorded[MODEL][caseKey(c)];
      assert.ok(expected, `${caseKey(c)} is recorded`);
      assert.deepEqual(
        digests(await generate(api, c, false)),
        expected,
        `main thread ${caseKey(c)}`,
      );
      assert.deepEqual(
        digests(await generate(api, c, true)),
        expected,
        `worker ${caseKey(c)}`,
      );
    }
  },
);

spec(
  "the continuous synoptic model replaces the historical one: the same seed and time no longer reproduce the historical weather",
  async (t) => {
    const recorded = models();
    const { api } = await fixture(t);
    for (const c of CASES) {
      const old = recorded.historical[caseKey(c)];
      assert.ok(old, `${caseKey(c)} has a historical record`);
      const now = digests(await generate(api, c, false));
      assert.notEqual(now.coverage, old.coverage, `coverage ${caseKey(c)}`);
      assert.notEqual(now.type, old.type, `type ${caseKey(c)}`);
      assert.notEqual(now.baseMeters, old.baseMeters, `base ${caseKey(c)}`);
      assert.notEqual(now.packBytes, old.packBytes, `pack ${caseKey(c)}`);
      assert.notDeepEqual(now, recorded.historical[caseKey(c)]);
      assert.deepEqual(now, recorded.continuous[caseKey(c)]);
    }
  },
);

spec(
  "the field names its source with the id its source reports, seed included, on the worker path and the main-thread path",
  async (t) => {
    const { api, record } = await fixture(t);
    const ids = new Map();
    for (const c of CASES) {
      const source = new api.SynopticWeatherSource(
        c.seed,
        GRID.width,
        GRID.height,
      );
      const expected = source.getCapabilities().id;
      assert.equal(expected, `procedural:synoptic:${c.seed}`);
      const when = new Date(c.time);
      const local = await source.fetchField({ time: when });
      assert.equal(
        record.calls.length,
        0,
        "the main-thread path used no worker",
      );
      const remote = await source.fetchField({ time: when, useWorkers: true });
      assert.deepEqual(
        record.calls.map((p) => p.kind),
        ["synoptic"],
        "the worker path generated the field",
      );
      record.calls.length = 0;
      assert.equal(local.source, expected, `main thread ${caseKey(c)}`);
      assert.equal(remote.source, expected, `worker ${caseKey(c)}`);
      ids.set(String(c.seed), expected);
    }
    assert.equal(
      new Set(ids.values()).size,
      ids.size,
      "two seeds never share a source id",
    );
    assert.equal(ids.size, 3);
  },
);

spec(
  "worker outputs transfer their owned arrays and retain seed/time replay exactly",
  async () => {
    const args = {
      kind: "synoptic",
      seed: "same-key",
      width: 32,
      height: 17,
      timeMs: time.getTime(),
    };
    const transfers = [],
      field = await worker(args, transfers);
    assert.equal(transfers.length, 7);
    assert.equal(new Set(transfers).size, 7);
    assert.equal(field.environmentalTensors.sample, undefined);
    const delivered = structuredClone(field, { transfer: transfers });
    assert.ok(arrays(field).every((a) => a.byteLength === 0));
    assert.ok(arrays(delivered).every((a) => a.byteLength > 0));
    const repeated = await worker(args, []);
    arrays(delivered).forEach((a, i) =>
      assert.deepEqual(a, arrays(repeated)[i]),
    );
    const later = await worker(
      { ...args, timeMs: args.timeMs + 6 * 3600000 },
      [],
    );
    assert.notDeepEqual(later.coverage, delivered.coverage);
    const other = await worker({ ...args, seed: "other-key" }, []);
    assert.notDeepEqual(other.coverage, delivered.coverage);
    await assert.rejects(worker({ kind: "unknown" }, []), /Unknown/);
  },
);

spec(
  "absent,busy or failed workers preserve the cooperative source,packer and wind fallback",
  async (t) => {
    const { api, record } = await fixture(t),
      source = new api.SynopticWeatherSource(3, 16, 9),
      request = { time, useWorkers: true };
    delete globalThis.Worker;
    const absent = await source.fetchField(request);
    assert.equal(record.created, 0);
    globalThis.Worker = function () {};
    record.busy = true;
    const busy = await source.fetchField(request);
    arrays(absent).forEach((a, i) => assert.deepEqual(a, arrays(busy)[i]));
    assert.deepEqual(
      await api.packWeatherFieldDetailedAsync(busy, 32, 17, {
        useWorkers: true,
      }),
      api.packWeatherFieldDetailed(busy, 32, 17),
    );
    assert.ok(
      await api.tensorCloudMaterialFlow(
        busy.environmentalTensors,
        time.getTime(),
        () => false,
        true,
        true,
      ),
    );
    record.busy = false;
    record.fail = true;
    const failed = await source.fetchField(request);
    arrays(absent).forEach((a, i) => assert.deepEqual(a, arrays(failed)[i]));
    assert.equal(record.destroyed, 1);
    const calls = record.calls.length;
    await source.fetchField(request);
    assert.equal(record.calls.length, calls);
  },
);

spec(
  "source abort and cancelled pack/flow discard worker completion without detaching caller arrays",
  async (t) => {
    const { api, record } = await fixture(t);
    const field = await new api.SynopticWeatherSource(4, 16, 9).fetchField({
      time,
    });
    record.delayed = true;
    const controller = new AbortController(),
      pending = new api.SynopticWeatherSource(4, 16, 9).fetchField({
        time,
        signal: controller.signal,
        useWorkers: true,
      });
    controller.abort();
    await record.pending.shift()();
    await assert.rejects(pending, /aborted/);
    let cancelled = false;
    const packed = api.packWeatherFieldDetailedAsync(
      field,
      32,
      17,
      { useWorkers: true },
      () => cancelled,
    );
    const flow = api.tensorCloudMaterialFlow(
      field.environmentalTensors,
      time.getTime(),
      () => cancelled,
      true,
      true,
    );
    cancelled = true;
    for (const done of record.pending.splice(0)) await done();
    assert.equal(await packed, null);
    assert.equal(await flow, undefined);
    assert.ok(arrays(field).every((a) => a.byteLength > 0));
  },
);

spec(
  "packing owns its source snapshot and omits tensor callbacks from the wire payload",
  async (t) => {
    const { api, record } = await fixture(t);
    const field = await new api.SynopticWeatherSource(7, 16, 9).fetchField({
      time,
    });
    const expected = api.packWeatherFieldDetailed(field, 32, 17);
    record.delayed = true;
    const pending = api.packWeatherFieldDetailedAsync(field, 32, 17, {
      useWorkers: true,
    });
    field.coverage.fill(0);
    field.type.fill(0);
    field.baseMeters.fill(0);
    field.topMeters.fill(0);
    assert.equal(record.calls.at(-1).field.environmentalTensors, undefined);
    await record.pending.shift()();
    assert.deepEqual(await pending, expected);
  },
);

spec(
  "explicit source,packing and wind controls retain cooperative output without creating a worker",
  async (t) => {
    const { api, record } = await fixture(t);
    const source = new api.SynopticWeatherSource("controlled-key", 16, 9);
    const field = await source.fetchField({ time, useWorkers: false });
    const packed = await api.packWeatherFieldDetailedAsync(field, 32, 17, {
      useWorkers: false,
    });
    const flow = await api.tensorCloudMaterialFlow(
      field.environmentalTensors,
      time.getTime(),
      () => false,
      true,
      false,
    );
    assert.deepEqual(packed, api.packWeatherFieldDetailed(field, 32, 17));
    assert.ok(flow);
    assert.equal(record.created, 0);
    assert.equal(record.calls.length, 0);
    // An absent request flag is the same as false: the default is the calling thread.
    const defaulted = await source.fetchField({ time });
    arrays(field).forEach((a, i) => assert.deepEqual(a, arrays(defaulted)[i]));
    assert.equal(record.calls.length, 0);
    const remote = await source.fetchField({ time, useWorkers: true });
    arrays(field).forEach((a, i) => assert.deepEqual(a, arrays(remote)[i]));
    assert.deepEqual(
      record.calls.map((p) => p.kind),
      ["synoptic"],
    );
  },
);

async function published(provider) {
  const deadline = Date.now() + 5000;
  let bytes;
  while (!(bytes = provider.getPackedTexture(32, 17))) {
    assert.ok(
      Date.now() < deadline,
      provider.lastError ?? "Weather publication timed out",
    );
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return bytes;
}

spec(
  "provider policy defaults to the calling thread; changes affect new work while completed slices and in-flight execution stay coherent",
  async (t) => {
    const { api, record } = await fixture(t);
    const provider = new api.WeatherProvider(
      new api.SynopticWeatherSource(9, 16, 9),
      { time },
    );
    assert.equal(provider.useWorkers, false);
    const local = await published(provider),
      localFlow = provider.getFlowField();
    assert.equal(record.created, 0);
    assert.equal(record.calls.length, 0);
    const version = provider.version;
    provider.useWorkers = 1;
    assert.equal(provider.useWorkers, false, "only true turns the policy on");
    provider.useWorkers = true;
    assert.equal(provider.useWorkers, true);
    assert.equal(provider.getPackedTexture(32, 17), local);
    assert.equal(provider.version, version);
    assert.equal(record.calls.length, 0);
    provider.refresh();
    const remote = await published(provider);
    assert.deepEqual(remote, local);
    assert.deepEqual(provider.getFlowField(), localFlow);
    assert.deepEqual(
      record.calls.map((p) => p.kind),
      ["synoptic", "pack", "flow"],
    );
    record.delayed = true;
    provider.refresh();
    provider.getPackedTexture(32, 17);
    provider.useWorkers = false;
    const deadline = Date.now() + 5000;
    while (provider.isPreparing) {
      assert.ok(
        Date.now() < deadline,
        "Captured worker request did not finish",
      );
      for (const finish of record.pending.splice(0)) await finish();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(record.calls.length, 6);
    assert.deepEqual(await published(provider), local);
    record.delayed = false;
    provider.refresh();
    assert.deepEqual(await published(provider), local);
    assert.equal(record.calls.length, 6);
    assert.equal(provider.useWorkers, false);
  },
);

spec(
  "shared scene policy controls its owned procedural provider and preserves external provider policy",
  async (t) => {
    const { api, record } = await fixture(t),
      state = new api.CloudWeatherState();
    t.after(() => state.destroy());
    const frame = {
      time: { dayNumber: 2461333, secondsOfDay: 43200 },
      afterRender: [],
    };
    // A configuration that does not name the dial leaves the owned provider on the calling thread.
    state.update({ cloudWeatherMap: true, cloudWeatherSeed: "shared" }, frame);
    const owned = state.provider;
    assert.equal(owned.useWorkers, false);
    state.update(
      {
        cloudWeatherMap: true,
        cloudWeatherSeed: "shared",
        cloudWeatherWorkers: false,
      },
      frame,
    );
    assert.equal(owned.useWorkers, false);
    state.update(
      {
        cloudWeatherMap: true,
        cloudWeatherSeed: "shared",
        cloudWeatherWorkers: true,
      },
      frame,
    );
    assert.equal(state.provider, owned);
    assert.equal(owned.useWorkers, true);
    assert.equal(record.created, 0);
    const external = { useWorkers: false };
    state.update(
      { weatherProvider: external, cloudWeatherWorkers: true },
      frame,
    );
    assert.equal(state.provider, external);
    assert.equal(external.useWorkers, false);
  },
);

// The real CloudCollection, bundled for Node. The generated shader modules are
// not part of a source tree, so any that is missing is stubbed; nothing here
// reaches them. The frame's context decides whether a cloud feature renderer
// exists.
let collectionSource;
async function collectionApi() {
  collectionSource ??= (
    await build({
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      stdin: {
        contents: [
          'export { default as CloudCollection } from "./packages/engine/Source/Scene/CloudCollection.js";',
          'export { default as FeatureRendererKey } from "./packages/engine/Source/Renderer/FeatureRendererKey.js";',
        ].join("\n"),
        resolveDir: root,
      },
      plugins: [
        taskProcessorMock,
        {
          name: "generated-shaders",
          setup(b) {
            b.onResolve({ filter: /\/Shaders\/.*\.js$/ }, (args) =>
              fs.existsSync(path.resolve(args.resolveDir, args.path))
                ? undefined
                : { path: args.path, namespace: "stub" },
            );
            b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
              contents: "export default {};",
            }));
          },
        },
      ],
    })
  ).outputFiles[0].text;
  return import(
    "data:text/javascript;base64," +
      Buffer.from(collectionSource + "\n// " + serial++).toString("base64")
  );
}
// Ticks a volumetric collection for two frames on a context that does or does
// not carry the cloud feature renderer, and reports what it published.
// `constructorOption` hands the dial to the CloudVolumetrics constructor
// (through the collection's `volumetric` options) instead of its setter.
async function tickCollection(
  t,
  { renderer, workers, constructorOption = false },
) {
  const { record } = await fixture(t);
  const { CloudCollection, FeatureRendererKey } = await collectionApi();
  const requests = [];
  const featureRenderer = { update() {} };
  const context = {
    getFeatureRenderer: (key) =>
      renderer && key === FeatureRendererKey.CLOUD_COLLECTION
        ? featureRenderer
        : undefined,
    requestVolumetricClouds: (config) => requests.push(config),
  };
  const collection = new CloudCollection({
    enableVolumetric: true,
    volumetric: constructorOption
      ? {
          cloudWeatherMap: true,
          ...(workers === undefined ? {} : { cloudWeatherWorkers: workers }),
        }
      : undefined,
  });
  t.after(() => collection._weatherState?.destroy());
  if (!constructorOption) {
    collection.volumetric.cloudWeatherMap = true;
    if (workers !== undefined)
      collection.volumetric.cloudWeatherWorkers = workers;
  }
  for (let frame = 0; frame < 2; frame++) {
    const frameState = {
      context,
      time: { dayNumber: 2461333, secondsOfDay: 43200 + frame },
      afterRender: [],
    };
    // `update` is the only caller that publishes; a context without a
    // renderer is exercised through the weather tick it shares with the globe.
    if (renderer) collection.update(frameState);
    else collection._updateWeather(frameState);
  }
  return { record, collection, requests };
}

spec(
  "a cloud collection without a cloud feature renderer creates no weather state and no worker, even with the worker dial on",
  async (t) => {
    const { record, collection } = await tickCollection(t, {
      renderer: false,
      workers: true,
    });
    assert.equal(collection.volumetric.cloudWeatherWorkers, true);
    assert.equal(collection._weatherState, undefined);
    assert.equal(
      collection._resolveVolumetricConfig().weatherProvider,
      undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(record.created, 0);
    assert.equal(record.calls.length, 0);
  },
);

spec(
  "a cloud collection with a cloud feature renderer owns a provider whose policy follows the dial and publishes the same weather either way",
  async (t) => {
    const off = await tickCollection(t, { renderer: true });
    assert.equal(off.collection.volumetric.cloudWeatherWorkers, false);
    assert.equal(off.requests.length, 2);
    const offProvider = off.requests[1].weatherProvider;
    assert.ok(offProvider, "the owned provider is published");
    assert.equal(offProvider.useWorkers, false);
    const offBytes = await published(offProvider);
    assert.equal(off.record.created, 0, "the default dial creates no worker");
    assert.equal(off.record.calls.length, 0);

    const on = await tickCollection(t, { renderer: true, workers: true });
    assert.equal(on.requests.length, 2);
    const onProvider = on.requests[1].weatherProvider;
    assert.ok(onProvider);
    assert.equal(onProvider.useWorkers, true);
    assert.equal(on.requests[0].weatherProvider, onProvider);
    const onBytes = await published(onProvider);
    assert.deepEqual(onBytes, offBytes);
    const offVertical = offProvider.getPackedPublication(32, 17).current
      .vertical;
    assert.ok(offVertical, "the published weather carries a vertical plane");
    assert.deepEqual(
      onProvider.getPackedPublication(32, 17).current.vertical,
      offVertical,
    );
    assert.equal(on.record.created, 1);
    assert.deepEqual([...new Set(on.record.calls.map((p) => p.kind))].sort(), [
      "flow",
      "pack",
      "synoptic",
    ]);

    const explicitOff = await tickCollection(t, {
      renderer: true,
      workers: false,
    });
    const explicitProvider = explicitOff.requests[1].weatherProvider;
    assert.equal(explicitProvider.useWorkers, false);
    assert.deepEqual(await published(explicitProvider), offBytes);
    assert.equal(explicitOff.record.created, 0);
  },
);

let cloudPatternsModule;
const cloudPatterns = async () =>
  (cloudPatternsModule ??= await importBundle({
    stdin: {
      contents: [
        'export * from "./packages/engine/Source/Scene/Weather/SynopticCloudStructure.ts";',
        'export * from "./packages/engine/Source/Scene/Weather/SynopticWeatherPattern.ts";',
      ].join("\n"),
      resolveDir: root,
    },
  }));

spec(
  "geographic cloud structure is seeded, continuous at seams and poles, and evolves smoothly in UTC",
  async () => {
    const patterns = await cloudPatterns();
    const days = (time.getTime() - 946728000000) / 86400000;
    const a = new patterns.SynopticCloudStructure(1.2, days);
    const replay = new patterns.SynopticCloudStructure(1.2, days);
    const other = new patterns.SynopticCloudStructure(2.4, days);
    const next = new patterns.SynopticCloudStructure(1.2, days + 1 / 86400);
    const later = new patterns.SynopticCloudStructure(1.2, days + 0.25);
    let near = 0,
      remote = 0,
      changed = 0,
      seeded = 0;
    for (let i = 0; i < 64; i++) {
      const longitude = -Math.PI + (i * Math.PI) / 32,
        latitude = Math.sin(i) * 1.2;
      const value = a.sample(longitude, latitude);
      assert.deepEqual(replay.sample(longitude, latitude), value);
      for (const key of ["regional", "cellular"]) {
        assert.ok(value[key] >= 0 && value[key] <= 1);
        near += Math.abs(
          value[key] - a.sample(longitude + 1e-4, latitude)[key],
        );
        remote += Math.abs(
          value[key] - a.sample(longitude + 0.3, latitude)[key],
        );
        changed += Math.abs(
          value[key] - later.sample(longitude, latitude)[key],
        );
        seeded += Math.abs(value[key] - other.sample(longitude, latitude)[key]);
        assert.ok(
          Math.abs(value[key] - next.sample(longitude, latitude)[key]) < 0.005,
        );
        assert.ok(
          Math.abs(
            a.sample(-Math.PI, latitude)[key] -
              a.sample(Math.PI, latitude)[key],
          ) < 1e-10,
        );
        for (const pole of [-Math.PI / 2, Math.PI / 2])
          assert.equal(a.sample(longitude, pole)[key], a.sample(0, pole)[key]);
      }
    }
    assert.ok(
      near < remote * 0.05,
      "nearby locations must share structure rather than independent dots",
    );
    assert.ok(remote > 1 && changed > 0.1 && seeded > 1);
  },
);

spec(
  "synoptic cloud bases and profiles cross weather regimes without categorical geographic jumps",
  async () => {
    const patterns = await cloudPatterns();
    const pattern = new patterns.SynopticWeatherPattern(
      "cloud-synoptic-3474",
      time.getTime(),
    );
    let best = null;
    for (const latitude of [-1, -0.7, -0.3, 0, 0.3, 0.7, 1]) {
      for (let i = 0; i < 128; i++) {
        const left = -Math.PI + (i * Math.PI) / 64,
          right = left + Math.PI / 64;
        const a = pattern.sample(left, latitude),
          b = pattern.sample(right, latitude);
        const delta = Math.abs(a.cloudType - b.cloudType);
        if (!best || delta > best.delta)
          best = { left, right, latitude, a, b, delta };
      }
    }
    assert.ok(
      best.delta > 0.1,
      "exercise an actual weather-profile transition",
    );
    const target = (best.a.cloudType + best.b.cloudType) * 0.5;
    const rising = best.b.cloudType > best.a.cloudType;
    let { left, right } = best;
    const { latitude } = best;
    for (let i = 0; i < 40; i++) {
      const middle = (left + right) * 0.5;
      if (pattern.sample(middle, latitude).cloudType < target === rising)
        left = middle;
      else right = middle;
    }
    const a = pattern.sample(left, latitude),
      b = pattern.sample(right, latitude);
    assert.ok(Math.abs(a.cloudType - b.cloudType) < 1e-6);
    assert.ok(Math.abs(a.baseMeters - b.baseMeters) < 1e-3);
  },
);

spec(
  "pressure-system support approaches its geographic culling boundary continuously",
  async () => {
    const patterns = await cloudPatterns();
    const pattern = new patterns.SynopticWeatherPattern(
      "cloud-synoptic-3474",
      time.getTime(),
    );
    for (const system of pattern._systems) {
      for (let i = 0; i < 8; i++) {
        const bearing = (i * Math.PI) / 4;
        const point = (distance) => {
          const latitude = Math.asin(
            system.sinLatitude * Math.cos(distance) +
              system.cosLatitude * Math.sin(distance) * Math.cos(bearing),
          );
          const longitude =
            system.longitude +
            Math.atan2(
              Math.sin(bearing) * Math.sin(distance) * system.cosLatitude,
              Math.cos(distance) - system.sinLatitude * Math.sin(latitude),
            );
          return pattern.sample(longitude, latitude);
        };
        const a = point(Math.PI / 3 - 1e-8),
          b = point(Math.PI / 3 + 1e-8);
        for (const key of [
          "coverage",
          "cloudType",
          "pressureHpa",
          "windU",
          "windV",
        ])
          assert.ok(
            Math.abs(a[key] - b[key]) < 1e-4,
            key + " must not jump at the system support edge",
          );
        assert.ok(Math.abs(a.baseMeters - b.baseMeters) < 0.01);
      }
    }
  },
);

spec(
  "the CloudVolumetrics constructor option reaches the owned provider the way the setter does",
  async (t) => {
    const viaOption = await tickCollection(t, {
      renderer: true,
      workers: true,
      constructorOption: true,
    });
    assert.equal(viaOption.collection.volumetric.cloudWeatherWorkers, true);
    const provider = viaOption.requests[1].weatherProvider;
    assert.ok(provider, "the owned provider is published");
    assert.equal(provider.useWorkers, true);
    assert.equal(viaOption.requests[0].weatherProvider, provider);
    const optionBytes = await published(provider);
    assert.equal(viaOption.record.created, 1, "the worker is used");
    assert.deepEqual(
      [...new Set(viaOption.record.calls.map((p) => p.kind))].sort(),
      ["flow", "pack", "synoptic"],
    );

    const absent = await tickCollection(t, {
      renderer: true,
      constructorOption: true,
    });
    assert.equal(absent.collection.volumetric.cloudWeatherWorkers, false);
    const absentProvider = absent.requests[1].weatherProvider;
    assert.equal(absentProvider.useWorkers, false);
    const absentBytes = await published(absentProvider);
    assert.equal(absent.record.created, 0);
    assert.equal(absent.record.calls.length, 0);

    const explicitOff = await tickCollection(t, {
      renderer: true,
      workers: false,
      constructorOption: true,
    });
    assert.equal(explicitOff.requests[1].weatherProvider.useWorkers, false);
    assert.equal(explicitOff.record.created, 0);
    assert.deepEqual(optionBytes, absentBytes);
  },
);
