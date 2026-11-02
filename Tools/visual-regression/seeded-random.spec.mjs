// seeded-random.spec.mjs — verification spec for the one seeded PRNG shared by the weather pattern and the wind layer.
// @purpose Pins that the synoptic weather pattern and the flow-field wind layer draw exactly the values they drew before they shared one generator: the pattern's phase, pressure systems and sampled fields, and the layer's initial particle state, for a set of numeric and string seeds, against a fixture captured from the base revision's own private generators.
// @status ACTIVE
//
// The two consumers used to carry private copies of mulberry32 (the pattern
// behind an FNV-1a string hash). The shared module must reproduce both streams
// bit for bit, so a seeded sky and a seeded particle field stay reproducible
// against old captures. Behaviour is asserted on the consumers' observable
// output, with the shared generator also compared to both base generators.
//
// Normal mode reads fixtures/seeded-random-base.json and needs no .git.
// Capture mode (SEEDED_RANDOM_CAPTURE=1) rebuilds the fixture by reading the
// two base files with `git show <base>:<path>` and running their private
// generators and consumers:
//
//   SEEDED_RANDOM_CAPTURE=1 node --test Tools/visual-regression/seeded-random.spec.mjs
//
// Run: node --test Tools/visual-regression/seeded-random.spec.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { importMutated } from "./lib/import-mutated.mjs";
import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";
import { withLaneTmp } from "../lib/lane-tmp.mjs";

enableEngineTsResolution();

const BASE_REVISION = "85bcb89ff2";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const FIXTURE = path.join(here, "fixtures", "seeded-random-base.json");
const engine = (rel) => path.join(root, "packages/engine/Source", rel);
const SYNOPTIC_REL = "Scene/Weather/SynopticWeatherPattern.ts";
const SHARED_REL = "Scene/Weather/SeededRandom.ts";
const WIND_REL = "Scene/FlowFieldWindLayer.js";

const DRAWS = 128;
const PARTICLES = 32;
const TIME_MS = Date.UTC(2026, 5, 15, 12);
const LAT_LON_STEPS = 8;
const MULBERRY_SEEDS = [
  0, 1, 2, 12345, 0x7fffffff, 0x80000000, 0xffffffff, -1, -7, -2147483649,
  4294967301, 3.7,
];
const WIND_SEEDS = [0, 1, 2, 12345, 0x80000000, 0xffffffff, -1, -7, 3.7];
const WEATHER_SEEDS = [
  0,
  1,
  -1,
  0xffffffff,
  3.5,
  "weather-key",
  "different-key",
  "",
  "κόσμος",
];

const toUrl = (file) => pathToFileURL(file).href;

function draw(random, count) {
  const values = new Array(count);
  for (let i = 0; i < count; i++) {
    values[i] = random();
  }
  return values;
}

function weatherObservation(Pattern, seed) {
  const pattern = new Pattern(seed, TIME_MS);
  const samples = [];
  for (let i = 0; i < LAT_LON_STEPS; i++) {
    for (let j = 0; j < LAT_LON_STEPS; j++) {
      const lon = -Math.PI + ((i + 0.5) * 2 * Math.PI) / LAT_LON_STEPS;
      const lat = -Math.PI / 2 + ((j + 0.5) * Math.PI) / LAT_LON_STEPS;
      samples.push({ ...pattern.sample(lon, lat) });
    }
  }
  return {
    phase: pattern._phase,
    systems: JSON.parse(JSON.stringify(pattern._systems)),
    samples,
  };
}

function windObservation(Layer, seed) {
  const layer = new Layer({
    image: {},
    metadata: { width: 1, height: 1 },
    seed,
    particleCount: PARTICLES,
  });
  return Array.from(layer._initialState);
}

// Reads a base-revision file with `git show`, for capture mode only.
function baseSource(rel) {
  return execFileSync(
    "git",
    ["-C", root, "show", `${BASE_REVISION}:packages/engine/Source/${rel}`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ).replace(/\r\n/g, "\n");
}

async function captureFixture() {
  return await withLaneTmp("seeded-random-base-", async (dir) => {
    const synopticFile = path.join(dir, "BaseSynopticWeatherPattern.ts");
    fs.writeFileSync(
      synopticFile,
      `${baseSource(SYNOPTIC_REL)}\nexport { seededRandom as baseSeededRandom };\n`,
    );
    const windFile = path.join(dir, "BaseFlowFieldWindLayer.js");
    const windHome = toUrl(engine(WIND_REL));
    const rewritten = baseSource(WIND_REL).replace(
      /from "(\.[^"]*)"/g,
      (_m, specifier) => `from "${new URL(specifier, windHome).href}"`,
    );
    fs.writeFileSync(
      windFile,
      `${rewritten}\nexport { mulberry32 as baseMulberry32 };\n`,
    );
    const synoptic = await import(toUrl(synopticFile));
    const wind = await import(toUrl(windFile));
    return {
      baseRevision: BASE_REVISION,
      capturedFrom: [
        `packages/engine/Source/${SYNOPTIC_REL}`,
        `packages/engine/Source/${WIND_REL}`,
      ],
      timeMs: TIME_MS,
      generators: {
        mulberry32: Object.fromEntries(
          MULBERRY_SEEDS.map((seed) => [
            String(seed),
            draw(wind.baseMulberry32(seed), DRAWS),
          ]),
        ),
        seededRandom: Object.fromEntries(
          WEATHER_SEEDS.map((seed) => [
            JSON.stringify(seed),
            draw(synoptic.baseSeededRandom(seed), DRAWS),
          ]),
        ),
      },
      weather: Object.fromEntries(
        WEATHER_SEEDS.map((seed) => [
          JSON.stringify(seed),
          weatherObservation(synoptic.SynopticWeatherPattern, seed),
        ]),
      ),
      wind: Object.fromEntries(
        WIND_SEEDS.map((seed) => [
          String(seed),
          windObservation(wind.default, seed),
        ]),
      ),
    };
  });
}

if (process.env.SEEDED_RANDOM_CAPTURE === "1") {
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(
    FIXTURE,
    `${JSON.stringify(await captureFixture(), null, 1)}\n`,
  );
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

const shared = await import(toUrl(engine(SHARED_REL)));
const { SynopticWeatherPattern } = await import(toUrl(engine(SYNOPTIC_REL)));
const FlowFieldWindLayer = (await import(toUrl(engine(WIND_REL)))).default;

// Names of the fixture entries a build of each consumer or generator no
// longer reproduces.
function generatorMismatches(mod) {
  const bad = [];
  for (const seed of MULBERRY_SEEDS) {
    const got = draw(mod.mulberry32(seed), DRAWS);
    assert.equal(got.length, DRAWS);
    if (
      JSON.stringify(got) !==
      JSON.stringify(fixture.generators.mulberry32[seed])
    ) {
      bad.push(`mulberry32(${seed})`);
    }
  }
  for (const seed of WEATHER_SEEDS) {
    const key = JSON.stringify(seed);
    const got = draw(mod.seededRandom(seed), DRAWS);
    if (
      JSON.stringify(got) !==
      JSON.stringify(fixture.generators.seededRandom[key])
    ) {
      bad.push(`seededRandom(${key})`);
    }
  }
  return bad;
}

function weatherMismatches(Pattern) {
  return WEATHER_SEEDS.filter(
    (seed) =>
      JSON.stringify(weatherObservation(Pattern, seed)) !==
      JSON.stringify(fixture.weather[JSON.stringify(seed)]),
  ).map((seed) => `weather(${JSON.stringify(seed)})`);
}

function windMismatches(Layer) {
  return WIND_SEEDS.filter(
    (seed) =>
      JSON.stringify(windObservation(Layer, seed)) !==
      JSON.stringify(fixture.wind[String(seed)]),
  ).map((seed) => `wind(${seed})`);
}

// Copies the pattern and the shared generator into a scratch directory with
// the given replacements applied, then loads the pattern from there.
async function mutatedPattern(patternEdits, sharedEdits) {
  return await withLaneTmp("seeded-random-mutant-", async (dir) => {
    const apply = (rel, edits) => {
      let source = fs.readFileSync(engine(rel), "utf8").replace(/\r\n/g, "\n");
      for (const [anchor, replacement] of edits) {
        assert.equal(
          source.split(anchor).length - 1,
          1,
          `anchor must occur once: ${anchor}`,
        );
        source = source.replace(anchor, () => replacement);
      }
      fs.writeFileSync(path.join(dir, path.basename(rel)), source);
    };
    apply(SYNOPTIC_REL, patternEdits);
    apply(SHARED_REL, sharedEdits);
    const mod = await import(
      toUrl(path.join(dir, "SynopticWeatherPattern.ts"))
    );
    return weatherMismatches(mod.SynopticWeatherPattern);
  });
}

// Loads the wind layer with its replacements applied. The shared module's
// specifier is pointed at the real TypeScript file, or at `sharedHref`.
async function mutatedWindMismatches(edits, sharedHref) {
  const jsSpecifier = toUrl(engine("Scene/Weather/SeededRandom.js"));
  const mod = await importMutated(engine(WIND_REL), [
    [
      `from "${jsSpecifier}"`,
      `from "${sharedHref ?? toUrl(engine(SHARED_REL))}"`,
    ],
    ...edits,
  ]);
  return windMismatches(mod.default);
}

const MUTATED_CONSTANT = ["0x6d2b79f5", "0x6d2b79f7"];
const withMutatedShared = async (fn) =>
  await withLaneTmp("seeded-random-shared-", async (dir) => {
    const source = fs
      .readFileSync(engine(SHARED_REL), "utf8")
      .replace(/\r\n/g, "\n");
    assert.equal(source.split(MUTATED_CONSTANT[0]).length - 1, 1);
    const file = path.join(dir, "SeededRandom.ts");
    fs.writeFileSync(
      file,
      source.replace(MUTATED_CONSTANT[0], MUTATED_CONSTANT[1]),
    );
    return await fn(file);
  });

test("fixture is captured from the base revision and covers the seed set", () => {
  assert.equal(fixture.baseRevision, BASE_REVISION);
  assert.ok(DRAWS >= 64);
  for (const seed of MULBERRY_SEEDS) {
    assert.equal(fixture.generators.mulberry32[seed].length, DRAWS);
  }
  for (const seed of WEATHER_SEEDS) {
    assert.equal(
      fixture.generators.seededRandom[JSON.stringify(seed)].length,
      DRAWS,
    );
  }
  for (const seed of [0, 1, 0xffffffff, -1, "weather-key"]) {
    assert.ok(fixture.weather[JSON.stringify(seed)], `weather seed ${seed}`);
  }
  for (const seed of WIND_SEEDS) {
    assert.equal(fixture.wind[String(seed)].length, PARTICLES * 4);
  }
});

test("the shared generators reproduce both base private generators", () => {
  assert.deepEqual(generatorMismatches(shared), []);
});

test("the synoptic pattern draws the values it drew at the base revision", () => {
  assert.deepEqual(weatherMismatches(SynopticWeatherPattern), []);
});

test("the wind layer's initial particle state is the state it had at the base revision", () => {
  assert.deepEqual(windMismatches(FlowFieldWindLayer), []);
});

test("different seeds still give different streams", () => {
  assert.notDeepEqual(
    fixture.wind["1"],
    fixture.wind["2"],
    "wind fixture must distinguish seeds",
  );
  assert.notDeepEqual(
    fixture.weather[JSON.stringify("weather-key")].samples,
    fixture.weather[JSON.stringify("different-key")].samples,
  );
});

test("inertness: a changed generator constant turns the generator, weather and wind checks red", async () => {
  await withMutatedShared(async (file) => {
    const mutatedShared = await import(toUrl(file));
    assert.notDeepEqual(generatorMismatches(mutatedShared), []);
    assert.notDeepEqual(await mutatedPattern([], [MUTATED_CONSTANT]), []);
    assert.notDeepEqual(await mutatedWindMismatches([], toUrl(file)), []);
  });
});

test("inertness: a mutant-free control through the same loaders stays green", async () => {
  assert.deepEqual(await mutatedPattern([], []), []);
  assert.deepEqual(await mutatedWindMismatches([]), []);
});

test("inertness: routing a consumer to a different seed turns it red", async () => {
  assert.notDeepEqual(
    await mutatedPattern(
      [
        [
          "const random = seededRandom(seed);",
          'const random = seededRandom(String(seed) + "!");',
        ],
      ],
      [],
    ),
    [],
  );
  assert.notDeepEqual(
    await mutatedWindMismatches([
      ["mulberry32(this._seed >>> 0)", "mulberry32((this._seed >>> 0) + 1)"],
    ]),
    [],
  );
});
