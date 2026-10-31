// probe-weather-map-runs.spec.mjs - the weather-map probe's captures and manifest across --runs N. Pure Node.
// @purpose Pins that probe-weather-map keeps every run's PNGs side by side under the kit's -run<N> suffix, leaves a single run's names unchanged, records each run's own files in its report cell, and writes a capture manifest (one entry per file of every run) that both validators accept and the contact sheet renders; with inertness mutants on the suffix, the manifest call and the per-file entries.
// @status ACTIVE
//
// The descriptor runs through the real `runProbe` over a stub browser (the
// precedent is probe-weather-map-pins.spec.mjs): the page answers its page
// functions from canned records and every canvas capture is a distinct tiny
// PNG, so the files on disk are real, the digests are real and the manifest
// builder reads them. The contact sheet is the real `runContactSheet`. No
// number here is evidence about the engine.
//
//   node --test Tools/visual-regression/probe-weather-map-runs.spec.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import { runContactSheet } from "./contact-sheet.mjs";
import { validateManifest as validateSheetManifest } from "./lib/contact-sheet-page.mjs";
import { validateManifest as validateCaptureManifest } from "./lib/capture.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { runProbe } from "./lib/probe-runtime.mjs";
import * as manifestLib from "./lib/weather-map-capture-manifest.mjs";
import { descriptor as realDescriptor } from "./probe-weather-map.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const probeFile = path.join(here, "probe-weather-map.mjs");
const libFile = path.join(here, "lib/weather-map-capture-manifest.mjs");

const PIPELINE_MARKER = "function pageWaitForPendingPipelines";
const STRIP_MARKER = ".cesium-navigation-help";
const SET_VIEW_MARKER = "cloudWeatherMap = weatherOn";

const WAIT_RECORD = {
  requested: true,
  available: true,
  pendingAtStart: 0,
  pendingAtEnd: 0,
  framesWaited: 1,
  timedOut: false,
};

/** An 8 x 8 PNG filled with one grey level. */
const grey = (value) =>
  Buffer.from(encodeRgbaPng(new Uint8Array(8 * 8 * 4).fill(value), 8, 8));
const BLACK = grey(0);

/** The n-th capture of an invocation: lit, and unlike every other capture. */
const distinctShot = (n) => grey(40 + n);

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * One invocation of `probe` through the real runtime.
 *
 * @param {object} probe The descriptor under test (real or mutated).
 * @param {string} root Lane temp root.
 * @param {string[]} argv Probe flags.
 * @param {{shot?: (n: number) => Buffer}} [script] `shot(n)` is the n-th canvas
 *   capture of the whole invocation.
 */
async function drive(probe, root, argv, { shot = distinctShot } = {}) {
  const out = path.join(root, "out");
  let shots = 0;
  const page = {
    on() {},
    async goto() {},
    async waitForFunction() {},
    async close() {},
    locator() {
      return {
        count: async () => 1,
        screenshot: async () => shot(shots++),
      };
    },
    async evaluate(fn) {
      const source = String(fn);
      if (source.includes("__captureLiveness")) {
        return { gateArmed: true, deviceLost: null, frameNumber: 7 };
      }
      if (source.includes("__armWebGPUDevice")) {
        return { armed: 1, found: 1, total: 1 };
      }
      if (source.includes("__webgpuGate")) {
        return { errors: [], deviceLost: null, armedDevices: 1 };
      }
      if (source.includes(SET_VIEW_MARKER)) {
        return null;
      }
      if (source.includes(PIPELINE_MARKER)) {
        return WAIT_RECORD;
      }
      if (source.includes(STRIP_MARKER)) {
        return { removed: 3, leftovers: [] };
      }
      throw new Error(`unstubbed page.evaluate: ${source.slice(0, 120)}`);
    },
  };
  const code = await runProbe(probe, {
    argv: [
      "--repository-root",
      root,
      "--output",
      out,
      "--no-serve-built",
      ...argv,
    ],
    now: () => Date.UTC(2026, 9, 31, 12, 0, 0),
    launch: async () => {
      let connected = true;
      return {
        isConnected: () => connected,
        async newPage() {
          return page;
        },
        async close() {
          connected = false;
        },
      };
    },
  });
  return { code, out };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const report = (out) => readJson(path.join(out, "weather-map-report.json"));
const manifestOf = (out) => readJson(path.join(out, "capture-manifest.json"));
const pngsIn = (out) =>
  fs
    .readdirSync(out)
    .filter((file) => file.endsWith(".png"))
    .sort();

/** The bare capture stems one run takes: 10 locations x map off/on, then two wide views. */
const bareStems = () => {
  const { locations } = realDescriptor.receipt([], {});
  const located = ["off", "on"].flatMap((map) =>
    locations.map(([lon, lat]) => `located-${map}-lon${lon}-lat${lat}`),
  );
  return [...located, "weather-map-wide-off", "weather-map-wide-on"];
};

const suffixed = (run) => bareStems().map((stem) => `${stem}-run${run}`);

// ---------------------------------------------------------------------------
// The naming rule
// ---------------------------------------------------------------------------

test("naming: one run keeps the bare name; several runs take the kit's -run<N> suffix, 0-based", () => {
  const { weatherMapCaptureName } = manifestLib;
  assert.equal(
    weatherMapCaptureName("located-off-lon-120-lat45", { run: 0, runs: 1 }),
    "located-off-lon-120-lat45",
  );
  assert.equal(
    weatherMapCaptureName("located-off-lon-120-lat45", { run: 0, runs: 3 }),
    "located-off-lon-120-lat45-run0",
  );
  assert.equal(
    weatherMapCaptureName("located-off-lon-120-lat45", { run: 2, runs: 3 }),
    "located-off-lon-120-lat45-run2",
  );
});

test("the probe's stems are the banked names (a literal, not derived)", () => {
  const stems = bareStems();
  assert.equal(stems.length, 22);
  assert.ok(stems.includes("located-off-lon-120-lat45"));
  assert.ok(stems.includes("located-on-lon-70-lat42"));
  assert.ok(stems.includes("weather-map-wide-on"));
});

// ---------------------------------------------------------------------------
// --runs 1: unchanged names
// ---------------------------------------------------------------------------

test("--runs 1 writes the bare names, no suffix anywhere, and the manifest lists those files", async () => {
  await withLaneTmp("weather-map-runs-", async (root) => {
    const { out } = await drive(realDescriptor, root, ["--runs", "1"]);
    assert.deepEqual(
      pngsIn(out),
      bareStems()
        .map((stem) => `${stem}.png`)
        .sort(),
    );
    assert.ok(pngsIn(out).includes("located-off-lon-120-lat45.png"));
    assert.ok(pngsIn(out).every((file) => !/-run\d/.test(file)));
    const manifest = manifestOf(out);
    assert.deepEqual(
      manifest.rigs.map((rig) => rig.id).sort(),
      bareStems()
        .map((stem) => `weather-map:${stem}`)
        .sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// --runs 3: every run survives
// ---------------------------------------------------------------------------

test("--runs 3 leaves all three runs' PNGs side by side, each different from the same view of the other runs", async () => {
  await withLaneTmp("weather-map-runs-", async (root) => {
    const { out } = await drive(realDescriptor, root, ["--runs", "3"]);
    const expected = [0, 1, 2].flatMap(suffixed).map((stem) => `${stem}.png`);
    assert.deepEqual(pngsIn(out), expected.sort());
    assert.equal(pngsIn(out).length, 66);
    for (const stem of bareStems()) {
      const digests = [0, 1, 2].map((run) =>
        sha(fs.readFileSync(path.join(out, `${stem}-run${run}.png`))),
      );
      assert.equal(new Set(digests).size, 3, `${stem}: three distinct frames`);
    }
  });
});

test("--runs 3: each run's report cell names its own files, relative, with the digest of the file on disk", async () => {
  await withLaneTmp("weather-map-runs-", async (root) => {
    const { out } = await drive(realDescriptor, root, ["--runs", "3"]);
    const { runs } = report(out);
    assert.deepEqual(
      runs.map((cell) => cell.run),
      [0, 1, 2],
    );
    for (const cell of runs) {
      assert.deepEqual(
        cell.captures.map((c) => c.name),
        suffixed(cell.run),
      );
      for (const capture of cell.captures) {
        assert.equal(capture.run, cell.run);
        assert.equal(capture.file, `${capture.name}.png`);
        assert.equal(path.isAbsolute(capture.file), false);
        assert.equal(
          capture.sha256,
          sha(fs.readFileSync(path.join(out, capture.file))),
          `${capture.file}: the report's digest is the file's`,
        );
        assert.equal(capture.accepted, true);
      }
      const located = cell.captures.find(
        (c) => c.base === "located-off-lon-120-lat45",
      );
      assert.deepEqual(
        [located.kind, located.view.weatherOn, located.view.lon],
        ["located", false, -120],
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The manifest and the sheet
// ---------------------------------------------------------------------------

test("--runs 3: the manifest lists every file of every run, validates, and its images are the files", async () => {
  await withLaneTmp("weather-map-runs-", async (root) => {
    const { out } = await drive(realDescriptor, root, ["--runs", "3"]);
    const manifest = manifestOf(out);
    assert.deepEqual(validateCaptureManifest(manifest), []);
    assert.deepEqual(validateSheetManifest(manifest), []);
    assert.equal(manifest.receipt, "weather-map-report.json");
    assert.deepEqual(manifest.renderers, ["webgpu"]);
    assert.equal(manifest.rigs.length, 66);
    assert.deepEqual(
      manifest.rigs.map((rig) => rig.id).sort(),
      [0, 1, 2]
        .flatMap(suffixed)
        .map((stem) => `weather-map:${stem}`)
        .sort(),
    );
    for (const rig of manifest.rigs) {
      const after = rig.cells.webgpu.AFTER;
      assert.equal(after.state, "MEASURED");
      assert.equal(path.posix.isAbsolute(after.image), false);
      assert.equal(
        after.sha256,
        sha(fs.readFileSync(path.join(out, after.image))),
      );
      assert.equal(rig.cells.webgpu.BEFORE.state, "UNMEASURED");
    }
    // Two runs of one view are the same rig definition.
    const key = (id) => manifest.rigs.find((r) => r.id === id).replayKey;
    assert.equal(
      key("weather-map:located-off-lon-120-lat45-run0"),
      key("weather-map:located-off-lon-120-lat45-run2"),
    );
    assert.notEqual(
      key("weather-map:located-off-lon-120-lat45-run0"),
      key("weather-map:located-on-lon-120-lat45-run0"),
    );
    const receipt = report(out).captureManifest;
    assert.equal(receipt.written, true);
    assert.equal(receipt.path, "capture-manifest.json");
    assert.deepEqual(receipt.violations, []);
  });
});

test("--runs 3: the contact sheet renders an entry and an image for every file of every run", async () => {
  await withLaneTmp("weather-map-runs-", async (root) => {
    const { out } = await drive(realDescriptor, root, ["--runs", "3"]);
    const sheets = path.join(root, "sheets").split(path.sep).join("/");
    const result = await runContactSheet([
      "--manifest",
      path.join(out, "capture-manifest.json"),
      "--sheet-id",
      "weather-map-runs",
      "--out-dir",
      sheets,
      "--generated-at",
      "2026-10-31T12:00:00.000Z",
      "--date",
      "2026-10-31",
    ]);
    assert.equal(result.error, null);
    assert.equal(result.exitCode, 0);
    const sheetDir = `${sheets}/2026-10-31/weather-map-runs`;
    const html = fs.readFileSync(`${sheetDir}/index.html`, "utf8");
    const copied = fs.readdirSync(`${sheetDir}/images`);
    for (const stem of [0, 1, 2].flatMap(suffixed)) {
      assert.ok(
        html.includes(`weather-map:${stem}`),
        `the sheet has an entry for ${stem}`,
      );
    }
    // One AFTER image per file (the UNMEASURED BEFOREs have none to copy).
    assert.equal(copied.length, 66);
  });
});

test("a retried first frame: the black take keeps its file under the run suffix and is listed, unaccepted", async () => {
  await withLaneTmp("weather-map-runs-", async (root) => {
    const { out } = await drive(realDescriptor, root, ["--runs", "2"], {
      shot: (n) => (n === 0 ? BLACK : distinctShot(n)),
    });
    const first = bareStems()[0];
    const files = pngsIn(out);
    assert.ok(files.includes(`${first}-run0.png`));
    assert.ok(files.includes(`${first}-retry1-run0.png`));
    assert.ok(!files.includes(`${first}-retry1-run1.png`));
    const cell = report(out).runs[0];
    const by = Object.fromEntries(cell.captures.map((c) => [c.name, c]));
    assert.equal(by[`${first}-run0`].accepted, false);
    assert.equal(by[`${first}-retry1-run0`].accepted, true);
    assert.equal(by[`${first}-retry1-run0`].retry, 1);
    const manifest = manifestOf(out);
    assert.deepEqual(validateCaptureManifest(manifest), []);
    const ids = manifest.rigs.map((rig) => rig.id);
    assert.ok(ids.includes(`weather-map:${first}-run0`));
    assert.ok(ids.includes(`weather-map:${first}-retry1-run0`));
    // The retry take and the black take stage the same view.
    const key = (id) => manifest.rigs.find((r) => r.id === id).replayKey;
    assert.equal(
      key(`weather-map:${first}-run0`),
      key(`weather-map:${first}-retry1-run0`),
    );
  });
});

test("the writer refuses a manifest it cannot validate: nothing written, a stale manifest removed, the violations returned", async () => {
  await withLaneTmp("weather-map-runs-", async (root) => {
    const { out } = await drive(realDescriptor, root, ["--runs", "1"]);
    const file = path.join(out, "capture-manifest.json");
    assert.ok(fs.existsSync(file));
    const cells = report(out).runs;
    const warnings = [];
    const warn = console.warn;
    console.warn = (line) => warnings.push(line);
    let result;
    try {
      result = manifestLib.writeWeatherMapManifest({
        probe: "weather-map",
        cells,
        staged: { viewport: { width: 1024, height: 768 }, page: "x" },
        context: {
          options: { servedBuild: true },
          origin: "http://localhost:8094",
          outputDirectory: out,
          generatedAt: "not an instant",
        },
      });
    } finally {
      console.warn = warn;
    }
    assert.equal(result.written, false);
    assert.equal(result.path, null);
    assert.ok(result.violations.length > 0);
    assert.equal(fs.existsSync(file), false, "the stale manifest is removed");
    assert.equal(warnings.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Inertness mutants: each clause made unreachable must change the observation
// ---------------------------------------------------------------------------

test("INERTNESS: with the probe's run suffix unreachable, --runs 2 overwrites run 0 and the suffix tests see it", async () => {
  const mutated = await importMutated(probeFile, [
    ["{ run, runs: options.runs },", "{ run, runs: 1 },"],
  ]);
  await withLaneTmp("weather-map-runs-", async (root) => {
    const real = await drive(realDescriptor, path.join(root, "real"), [
      "--runs",
      "2",
    ]);
    const dead = await drive(mutated.descriptor, path.join(root, "dead"), [
      "--runs",
      "2",
    ]);
    assert.equal(pngsIn(real.out).length, 44);
    assert.ok(pngsIn(real.out).includes("located-off-lon-120-lat45-run1.png"));
    assert.equal(
      pngsIn(dead.out).length,
      22,
      "the last run overwrote the first",
    );
    assert.ok(!pngsIn(dead.out).includes("located-off-lon-120-lat45-run1.png"));
  });
});

test("INERTNESS: with the naming function's suffix unreachable, the pure rule returns the bare stem for three runs", async () => {
  const mutated = await importMutated(libFile, [
    ["return runs > 1 ?", "return false && runs > 1 ?"],
  ]);
  assert.equal(
    manifestLib.weatherMapCaptureName("x", { run: 1, runs: 3 }),
    "x-run1",
  );
  assert.equal(mutated.weatherMapCaptureName("x", { run: 1, runs: 3 }), "x");
});

test("INERTNESS: with the probe's manifest call unreachable, no manifest is written and the receipt says none", async () => {
  const mutated = await importMutated(probeFile, [
    [
      "const captureManifest = context.outputDirectory",
      "const captureManifest = false && context.outputDirectory",
    ],
  ]);
  await withLaneTmp("weather-map-runs-", async (root) => {
    const real = await drive(realDescriptor, path.join(root, "real"), [
      "--runs",
      "2",
    ]);
    const dead = await drive(mutated.descriptor, path.join(root, "dead"), [
      "--runs",
      "2",
    ]);
    assert.ok(fs.existsSync(path.join(real.out, "capture-manifest.json")));
    assert.equal(
      fs.existsSync(path.join(dead.out, "capture-manifest.json")),
      false,
    );
    assert.equal(report(dead.out).captureManifest, null);
  });
});

test("INERTNESS: with the per-file entries cut to one capture per run, the manifest no longer lists every file", async () => {
  const mutated = await importMutated(libFile, [
    [
      "(cell.captures ?? []).map((record) => ({",
      "(cell.captures ?? []).slice(0, 1).map((record) => ({",
    ],
  ]);
  const cells = [0, 1].map((run) => ({
    run,
    captures: [
      {
        name: `a-run${run}`,
        file: `a-run${run}.png`,
        sha256: "0".repeat(64),
        url: "http://x/",
        capturedAt: "2026-10-31T12:00:00.000Z",
        base: "a",
      },
      {
        name: `b-run${run}`,
        file: `b-run${run}.png`,
        sha256: "0".repeat(64),
        url: "http://x/",
        capturedAt: "2026-10-31T12:00:00.000Z",
        base: "b",
      },
    ],
  }));
  assert.equal(manifestLib.weatherMapManifestPages(cells, "/out").length, 4);
  assert.equal(mutated.weatherMapManifestPages(cells, "/out").length, 2);
});
