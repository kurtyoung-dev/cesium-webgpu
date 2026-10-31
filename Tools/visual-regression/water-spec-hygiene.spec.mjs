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
import { loadRunnerScripts } from "./lib/runner-homes.mjs";
import { WATER_SPEC_HYGIENE_ALLOWLIST } from "./lib/water-spec-hygiene-allowlist.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
// package.json is seat-owned, so a lane that homes a new water spec declares the home in
// its RUNNERS_<LANE>.txt; RUNNER_HOMES_FILE applies it here exactly as the seat will at
// landing (lib/runner-homes.mjs), and without it this reads package.json as it stands.
const SCRIPTS = loadRunnerScripts({ root: ROOT }).scripts;
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const GALLERY = "packages/sandcastle/gallery/webgpu-global-water-weather";
// Every spec whose file name starts with one of these is a water or ocean spec, so a new
// one is scanned without anyone remembering to list it. A prefix is here only because
// every spec under it is about the sea, its tide or its optics; eclipse-globe-* is not
// (those specs are about the umbra on the globe), nor is globe-* as a whole.
const WATER_SPEC_PREFIXES = [
  "water-",
  "ocean-",
  "globe-ocean-",
  "globe-water-",
  "celestial-water-",
  "composite-water-",
  "tidal-",
  "bathymetry-",
  "probe-water-",
];
// Water specs scanned by name: the ones whose names carry none of the prefixes above,
// and some that also match one. Other specs that mention the sea in passing are not this
// spec's to police.
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
// The files the prettier pin covers besides every scanned spec.
const PRETTIER_EXTRA_FILES = [
  "Tools/visual-regression/water-spec-mutants.mjs",
  "Tools/visual-regression/lib/water-spec-hygiene-allowlist.mjs",
  `${GALLERY}/main.js`,
  `${GALLERY}/index.html`,
];

// `prefixes` and `names` are parameters so a mutant can ask what a narrower rule scans.
function waterSpecFiles({
  prefixes = WATER_SPEC_PREFIXES,
  names: listed = WATER_SPEC_NAMES,
} = {}) {
  const names = new Set(
    fs
      .readdirSync(here)
      .filter(
        (name) =>
          name.endsWith(".spec.mjs") &&
          prefixes.some((prefix) => name.startsWith(prefix)),
      )
      .map((name) => name.replace(/\.spec\.mjs$/, "")),
  );
  for (const name of listed) {
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

// The per-spec checks, by the id the allowlist files its exemptions under. Each one
// throws on a spec that fails it; the bodies are the pure checks defined below.
const CHECKS = {
  "IT-01": (rel) => checkPrettierClean(rel, read(rel)),
  "IT-02": (rel) => checkRunnerHomes(SCRIPTS, [rel]),
  "IT-03": (rel) => checkNoTreeWrites(read(rel), rel),
  "WALL-CLOCK": (rel) => checkNoWallClockCeiling(read(rel), rel),
};

const isAllowlisted = (id, rel, allowlist = WATER_SPEC_HYGIENE_ALLOWLIST) =>
  Object.hasOwn(allowlist[id] ?? {}, path.posix.basename(rel));

function failsCheck(id, rel) {
  try {
    CHECKS[id](rel);
    return false;
  } catch {
    return true;
  }
}

/** Run check `id` over every spec not allowlisted for it. */
function checkScanned(id, specs, allowlist = WATER_SPEC_HYGIENE_ALLOWLIST) {
  for (const rel of specs) {
    if (!isAllowlisted(id, rel, allowlist)) {
      CHECKS[id](rel);
    }
  }
}

// The allowlist is shrink-only: a row names a scanned spec that still fails the check
// it is filed under, with a one-line reason. A repaired row turns this red until deleted.
function checkAllowlistShrinkOnly(allowlist, scanned) {
  for (const [id, entries] of Object.entries(allowlist)) {
    assert.ok(Object.hasOwn(CHECKS, id), `unknown check id ${id}`);
    for (const [name, reason] of Object.entries(entries)) {
      const rel = `Tools/visual-regression/${name}`;
      assert.ok(
        fs.existsSync(path.join(ROOT, rel)),
        `${id}: ${name} no longer exists; delete its allowlist row`,
      );
      assert.ok(
        scanned.includes(rel),
        `${id}: ${name} is not a scanned water spec; delete its allowlist row`,
      );
      assert.ok(
        typeof reason === "string" &&
          reason.trim() !== "" &&
          !/[\r\n]/.test(reason),
        `${id}: ${name} needs a non-empty one-line reason`,
      );
      assert.ok(
        failsCheck(id, rel),
        `${id}: ${name} passes now; delete its allowlist row`,
      );
    }
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
    specs.length >= 30,
    `expected the water spec set, got ${specs.length}`,
  );
  checkScanned("IT-02", specs);
});

test("IT-02 mutants: a spec with no home, or two, turns the runner check red", () => {
  // The mutants run over the specs that are homed, so they do not go red for a home a
  // lane has yet to land; the test above is the one that names a spec still homeless.
  const specs = waterSpecFiles().filter((s) => runnerHomes(SCRIPTS, s) === 1);
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
  checkScanned("IT-03", waterSpecFiles());
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
// ceiling and went red under load. Every scanned water spec is held to the same
// rule as the perf spec (this spec excepted: it quotes one in its own mutant, and
// the allowlist says so).
test("no water-landing spec asserts an absolute wall-clock ceiling", () => {
  checkScanned("WALL-CLOCK", waterSpecFiles());
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
  checkScanned("IT-01", waterSpecFiles());
  for (const rel of PRETTIER_EXTRA_FILES) {
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

// The scan is the thing every other pin leans on, so it is pinned too: the old rule
// (every water-*.spec.mjs plus the named list) missed the ocean-*, tidal-, celestial-water-
// and globe-ocean- specs, and a prefix dropped from the list must turn this red.
const SCANNED_BY_PREFIX_ONLY = [
  "ocean-datum",
  "ocean-per-frame-scratch",
  "ocean-simulation-clock",
  "ocean-tide-datum",
  "tidal-harmonics",
  "globe-ocean-wave-clock",
  "celestial-water-globe-port",
  "probe-water-cells",
].map((name) => `Tools/visual-regression/${name}.spec.mjs`);

function checkScanCovers(scanned, required) {
  for (const rel of required) {
    assert.ok(scanned.includes(rel), `${rel} must be a scanned water spec`);
  }
}

function checkNoDeadPrefix(prefixes) {
  for (const prefix of prefixes) {
    assert.ok(
      fs
        .readdirSync(here)
        .some((name) => name.endsWith(".spec.mjs") && name.startsWith(prefix)),
      `prefix ${prefix} matches no spec; delete it`,
    );
  }
}

test("the scan covers the prefix-only water specs the old rule missed (scan mutant)", () => {
  const scanned = waterSpecFiles();
  const legacy = waterSpecFiles({ prefixes: ["water-"] });
  const added = scanned.filter((rel) => !legacy.includes(rel));
  assert.ok(added.length > 0, "the widened scan must add specs to the old one");
  checkScanCovers(scanned, SCANNED_BY_PREFIX_ONLY);
  checkNoDeadPrefix(WATER_SPEC_PREFIXES);
  mutantFails(
    "the old water- only rule",
    () => checkScanCovers(scanned, SCANNED_BY_PREFIX_ONLY),
    () => checkScanCovers(legacy, SCANNED_BY_PREFIX_ONLY),
  );
  mutantFails(
    "one prefix dropped",
    () => checkScanCovers(scanned, SCANNED_BY_PREFIX_ONLY),
    () =>
      checkScanCovers(
        waterSpecFiles({
          prefixes: WATER_SPEC_PREFIXES.filter((p) => p !== "ocean-"),
        }),
        SCANNED_BY_PREFIX_ONLY,
      ),
  );
  mutantFails(
    "a prefix that matches nothing",
    () => checkNoDeadPrefix(WATER_SPEC_PREFIXES),
    () => checkNoDeadPrefix([...WATER_SPEC_PREFIXES, "no-such-water-prefix-"]),
  );
});

test("the hygiene allowlist is shrink-only: every row exists, still fails its check, and says why", () => {
  const scanned = waterSpecFiles();
  checkAllowlistShrinkOnly(WATER_SPEC_HYGIENE_ALLOWLIST, scanned);
  // A homed spec passes IT-02 and a clean spec passes the others, so a row for either
  // is a repaired row the ratchet must refuse.
  const mutate = (allowlist) => () =>
    checkAllowlistShrinkOnly(allowlist, scanned);
  mutantFails(
    "a repaired row (the spec now passes its check)",
    () => checkAllowlistShrinkOnly(WATER_SPEC_HYGIENE_ALLOWLIST, scanned),
    mutate({
      ...WATER_SPEC_HYGIENE_ALLOWLIST,
      "IT-02": {
        ...WATER_SPEC_HYGIENE_ALLOWLIST["IT-02"],
        "water-mask-assets.spec.mjs": "homed, so this row is stale",
      },
    }),
  );
  mutantFails(
    "a row for a spec that is gone",
    () => checkAllowlistShrinkOnly(WATER_SPEC_HYGIENE_ALLOWLIST, scanned),
    mutate({
      ...WATER_SPEC_HYGIENE_ALLOWLIST,
      "IT-03": {
        ...WATER_SPEC_HYGIENE_ALLOWLIST["IT-03"],
        "water-no-such-spec.spec.mjs": "deleted long ago",
      },
    }),
  );
  mutantFails(
    "an empty reason",
    () => checkAllowlistShrinkOnly(WATER_SPEC_HYGIENE_ALLOWLIST, scanned),
    mutate({
      ...WATER_SPEC_HYGIENE_ALLOWLIST,
      "WALL-CLOCK": { "water-spec-hygiene.spec.mjs": "  " },
    }),
  );
  mutantFails(
    "a multi-line reason",
    () => checkAllowlistShrinkOnly(WATER_SPEC_HYGIENE_ALLOWLIST, scanned),
    mutate({
      ...WATER_SPEC_HYGIENE_ALLOWLIST,
      "WALL-CLOCK": { "water-spec-hygiene.spec.mjs": "one\ntwo" },
    }),
  );
  mutantFails(
    "an unknown check id",
    () => checkAllowlistShrinkOnly(WATER_SPEC_HYGIENE_ALLOWLIST, scanned),
    mutate({ ...WATER_SPEC_HYGIENE_ALLOWLIST, "IT-99": {} }),
  );
});

test("an allowlisted spec is exempt from its check only (allowlist mutant)", () => {
  // Without the allowlist the hygiene spec itself fails IT-03, so the exemption is live.
  assert.throws(() => checkScanned("IT-03", waterSpecFiles(), {}));
  assert.doesNotThrow(() => checkScanned("IT-03", waterSpecFiles()));
});
