// water-spec-hygiene.spec.mjs — the water landing's own gates, pinned so they cannot quietly lapse.
// @purpose Pins that every water or ocean spec has exactly one runner home, that no water spec writes into the tree or asserts a wall-clock number, that the two bespoke water drivers stay out of the fleet, and that the water specs, the demo and the perf spec stay prettier- and eslint-clean; each pin runs against a mutant that must turn it red.
// @status ACTIVE
//
// The gates themselves (prettier, eslint, the probe fleet contract) are the CI-side
// authority; this spec is the local tripwire that says which of the water files broke
// one. Every check below is a pure function of text, so the mutant for each one is the
// same function over a copy of its input with the property removed, never a file edit.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const SCRIPTS = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
).scripts;
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const GALLERY = "packages/sandcastle/gallery/webgpu-global-water-weather";
// The specs the water landing adds or touches, besides every water-*.spec.mjs in the
// folder. Other ocean-* specs predate this work and are not this spec's to police.
const WATER_SPEC_NAMES = [
  "composite-water-classification",
  "global-coastline-water-classification",
  "celestial-water-sun-glint",
  "celestial-water-moonglade",
  "globe-night-ocean-sentinel",
  "globe-daynight-normal-source",
  "globe-daynight-ramp-law",
  "ocean-wave-lod",
  "ocean-fft-controls",
  "ocean-jerlov-optics",
  "ocean-meteorological-surge",
  "environmental-tensor-raster",
  "bathymetry-environmental-tensor-coupling",
  "globe-classic-ocean-default-parity",
  "globe-water-facade",
  "globe-terrain-default-variant-identity",
];
const WATER_FAMILY = [
  "water-async-pipeline-transition",
  "water-flight-surface-regimes",
  "water-orbit-atmosphere-regimes",
  "water-underwater-bathymetry-regimes",
  "water-multi-biome-perf-compile",
];
const PRETTIER_FILES = [
  ...WATER_FAMILY.map((n) => `Tools/visual-regression/${n}.spec.mjs`),
  "Tools/visual-regression/water-demo-behaviour.spec.mjs",
  "Tools/visual-regression/water-spec-hygiene.spec.mjs",
  "Tools/visual-regression/water-spec-mutants.mjs",
  `${GALLERY}/main.js`,
  `${GALLERY}/index.html`,
];

function waterSpecFiles() {
  const names = new Set(
    fs
      .readdirSync(here)
      .filter((name) => /^water-.*\.spec\.mjs$/.test(name))
      .map((name) => name.replace(/\.spec\.mjs$/, "")),
  );
  for (const name of WATER_SPEC_NAMES) {
    if (fs.existsSync(path.join(here, `${name}.spec.mjs`))) {
      names.add(name);
    }
  }
  return [...names]
    .sort()
    .map((name) => `Tools/visual-regression/${name}.spec.mjs`);
}

/** How many runner scripts name `spec`. */
function runnerHomes(scripts, spec) {
  return Object.entries(scripts).filter(([, command]) =>
    command.split(/\s+/).includes(spec),
  ).length;
}

function checkRunnerHomes(scripts, specs) {
  for (const spec of specs) {
    assert.equal(
      runnerHomes(scripts, spec),
      1,
      `${spec} must have exactly one runner home in package.json`,
    );
  }
}

function mutantFails(name, check, mutate) {
  assert.doesNotThrow(check, `${name}: the check must pass on the real input`);
  assert.throws(
    () => mutate(),
    undefined,
    `${name}: the check must go red on its mutant`,
  );
}

test("every water or ocean spec has exactly one runner home (IT-02)", () => {
  const specs = waterSpecFiles();
  assert.ok(
    specs.length >= 15,
    `expected the water spec set, got ${specs.length}`,
  );
  checkRunnerHomes(SCRIPTS, specs);
});

test("IT-02 mutants: a spec with no home, or two, turns the runner check red", () => {
  const specs = waterSpecFiles();
  const water = SCRIPTS["test-water-regimes"];
  const dropped = specs.find((s) => water.split(/\s+/).includes(s));
  assert.ok(dropped, "test-water-regimes must name at least one water spec");
  mutantFails(
    "no home",
    () => checkRunnerHomes(SCRIPTS, specs),
    () =>
      checkRunnerHomes(
        {
          ...SCRIPTS,
          "test-water-regimes": water.replace(` ${dropped}`, ""),
        },
        specs,
      ),
  );
  mutantFails(
    "two homes",
    () => checkRunnerHomes(SCRIPTS, specs),
    () =>
      checkRunnerHomes(
        {
          ...SCRIPTS,
          "test-visual-regression-node": `${SCRIPTS["test-visual-regression-node"]} ${dropped}`,
        },
        specs,
      ),
  );
});

// No water spec may write into the source tree: the chunk extraction that rewrote
// Shaders/WebGPU/Globe/chunks on every run, and the tool behind it, are out.
function checkNoTreeWrites(text, label) {
  assert.doesNotMatch(
    text,
    /modularize-globe-terrain-wgsl|extractGlobeTerrainChunks|verifyGlobeTerrainChunks|Globe\/chunks/,
    `${label} must not run the WGSL chunk extraction`,
  );
}

test("no water spec extracts or verifies GlobeTerrain chunks (IT-03)", () => {
  for (const spec of waterSpecFiles()) {
    if (spec.endsWith("water-spec-hygiene.spec.mjs")) {
      continue; // it names the forbidden calls in order to forbid them
    }
    checkNoTreeWrites(read(spec), spec);
  }
  const perf = read(
    "Tools/visual-regression/water-multi-biome-perf-compile.spec.mjs",
  );
  mutantFails(
    "chunk extraction",
    () => checkNoTreeWrites(perf, "perf spec"),
    () =>
      checkNoTreeWrites(`${perf}\nextractGlobeTerrainChunks();\n`, "perf spec"),
  );
});

// A gating spec runs in parallel with a hundred others; an absolute millisecond or
// microsecond ceiling encodes one machine's speed. Timings are reported, and the
// bounds are counts, equality or ratios.
function checkNoWallClockCeiling(text, label) {
  const ceiling =
    /\b\w*(?:Ms|UsPerCall|elapsed\w*)\s*<=?\s*\d|\bperformance\.now\(\)[^;\n]*<=?\s*\d/;
  assert.doesNotMatch(text, ceiling, `${label} asserts a wall-clock ceiling`);
}

test("the perf spec asserts no absolute wall-clock ceiling and measures 4x work (IT-04)", () => {
  const perf = read(
    "Tools/visual-regression/water-multi-biome-perf-compile.spec.mjs",
  );
  checkNoWallClockCeiling(perf, "perf spec");
  assert.match(perf, /rangeBytesFetched/);
  assert.match(
    perf,
    /bytesStreamed,\s*dirSize \+ rangeBytesFetched/,
    "the HTTP Range test must assert the bytes it fetched",
  );
  mutantFails(
    "wall-clock ceiling",
    () => checkNoWallClockCeiling(perf, "perf spec"),
    () =>
      checkNoWallClockCeiling(
        `${perf}\nassert.ok(elapsedMs < 25.0, "slow");\n`,
        "perf spec",
      ),
  );
});

// Added at the freeze: the coastline spec's Kauai test still asserted a 50 ms
// ceiling and went red under load. Every spec this landing adds or touches is
// held to the same rule as the perf spec (this spec excepted: it quotes one in
// its own mutant).
test("no water-landing spec asserts an absolute wall-clock ceiling", () => {
  const names = [...WATER_SPEC_NAMES, ...WATER_FAMILY];
  for (const name of names) {
    checkNoWallClockCeiling(
      read(`Tools/visual-regression/${name}.spec.mjs`),
      name,
    );
  }
  const coast = read(
    "Tools/visual-regression/global-coastline-water-classification.spec.mjs",
  );
  mutantFails(
    "coastline wall-clock ceiling",
    () => checkNoWallClockCeiling(coast, "coastline spec"),
    () =>
      checkNoWallClockCeiling(
        `${coast}\nassert.ok(elapsed < 250, "cold rasterization");\n`,
        "coastline spec",
      ),
  );
});

// The bespoke water driver and its tensor capture launched their own browser; they are
// banked (water-review/banked) and rebuilt on the probe kit in a later lane. The fleet
// allowlist is shrink-only, so neither may come back as a row.
function checkDriversGone(exists, allowlistText) {
  for (const gone of [
    "Tools/visual-regression/probe-global-water-presets.mjs",
    "Tools/visual-regression/capture-ocean-weather-tensors.mjs",
  ]) {
    assert.equal(exists(gone), false, `${gone} must stay out of the tree`);
    assert.ok(
      !allowlistText.includes(path.posix.basename(gone)),
      `${gone} must not be an allowlist row`,
    );
  }
}

test("the bespoke water drivers are gone and not allowlisted (IT-05)", () => {
  const allowlist = read(
    "Tools/visual-regression/lib/probe-fleet-contract-allowlist.mjs",
  );
  const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
  checkDriversGone(exists, allowlist);
  mutantFails(
    "driver back in the tree",
    () => checkDriversGone(exists, allowlist),
    () => checkDriversGone(() => true, allowlist),
  );
  mutantFails(
    "driver allowlisted",
    () => checkDriversGone(exists, allowlist),
    () =>
      checkDriversGone(
        exists,
        `${allowlist}\n"probe-global-water-presets.mjs",`,
      ),
  );
});

function prettierOutput(rel, text) {
  const run = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules/prettier/bin/prettier.cjs"),
      "--stdin-filepath",
      path.join(ROOT, rel),
    ],
    { input: text, encoding: "utf8", cwd: ROOT, maxBuffer: 32 * 1024 * 1024 },
  );
  assert.equal(run.status, 0, `prettier failed on ${rel}: ${run.stderr}`);
  return run.stdout;
}

function checkPrettierClean(rel, text) {
  assert.equal(
    prettierOutput(rel, text),
    text,
    `${rel} is not prettier-clean (run prettier --write on it)`,
  );
}

test("the water specs, helper and demo are prettier-clean (IT-01)", () => {
  for (const rel of PRETTIER_FILES) {
    checkPrettierClean(rel, read(rel));
  }
  const rel = "Tools/visual-regression/water-flight-surface-regimes.spec.mjs";
  mutantFails(
    "unformatted spec",
    () => checkPrettierClean(rel, read(rel)),
    () =>
      checkPrettierClean(
        rel,
        read(rel).replace('"node:assert/strict"', "'node:assert/strict'"),
      ),
  );
});

function eslintErrors(rel, text) {
  const run = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules/eslint/bin/eslint.js"),
      "--max-warnings",
      "0",
      "--stdin",
      "--stdin-filename",
      path.join(ROOT, rel),
    ],
    {
      input: text,
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env, SEATBELT_FROZEN: "1" },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

function checkEslintClean(rel, text) {
  const { status, output } = eslintErrors(rel, text);
  assert.equal(status, 0, `${rel} fails the frozen eslint gate:\n${output}`);
}

test("the demo and the perf spec pass the frozen eslint gate (IT-09)", () => {
  for (const rel of [
    `${GALLERY}/main.js`,
    "Tools/visual-regression/water-multi-biome-perf-compile.spec.mjs",
  ]) {
    checkEslintClean(rel, read(rel));
    mutantFails(
      `unused variable in ${path.posix.basename(rel)}`,
      () => checkEslintClean(rel, read(rel)),
      () => checkEslintClean(rel, `${read(rel)}\nconst unusedMutantVar = 1;\n`),
    );
  }
});
