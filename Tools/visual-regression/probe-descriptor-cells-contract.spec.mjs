// probe-descriptor-cells-contract.spec.mjs — the Node check that would have
// caught AR-752's lost Edge leg. Pure Node: no browser, no network, no GPU.
//
// @purpose Drives runProbe over the REAL polyline-TAA-velocity descriptor with a stubbed browser and page, walking cells → receipt → verdicts → summary and asserting the shapes the runtime requires, plus the runtime's own cells-must-be-an-array contract.
// @status ACTIVE
//
// THE GAP THIS CLOSES. On 2026-09-05 Éowyn's Edge job 9 leg 4 ran
// `probe-polyline-taa-velocity.mjs --runs 3` and got exit 2 on run 0, with no
// captures, no verdicts and no receipt:
//
//     polyvel: TypeError: Spread syntax requires ...iterable[Symbol.iterator]
//         at runProbe (Tools/visual-regression/lib/probe-runtime.mjs:895:15)
//
// The descriptor's `cells()` returned the run's single cell as a bare object
// where the runtime collects `cells.push(...(produced ?? []))`. The defect was
// three characters wide, it sat on the probe's ONLY execution path, and it
// survived a landing, a review and a fleet of authoring-time guards — because
// every one of those guards reads probe SOURCE and none of them EXECUTES a
// descriptor. `probe-fleet-contract.spec.mjs` asks whether a probe has a
// watchdog and closes its browser in a `finally`; `runtime-residency-contract.
// spec.mjs` asks whether a probe re-implements a concern the runtime owns.
// Both were red at HEAD for unrelated reasons (`AR-893`), and a GREEN run of
// either would still have missed this: neither one calls `cells()`.
//
// So this spec runs the real descriptor. `runProbe`'s `launch` seam is the only
// thing standing between a probe and Edge, so a stub browser whose page answers
// the probe's `page.evaluate` calls by their function source, and hands back
// PNGs this file encodes, walks the entire chain the Edge leg walks — argv →
// preflight → slot → cells → receipt → verdicts → summary → exit code — in a
// few milliseconds with no GPU. Every shape the runtime and the probe's own
// downstream helpers require is asserted on the way through.
//
// WHAT IT DELIBERATELY DOES NOT DO. It measures nothing. The pixel counts and
// velocity texels here are fixtures chosen to exercise both sides of each
// verdict, and no number in this file is evidence about the engine. `AR-752`'s
// acceptance is the Edge leg; this spec only guarantees the instrument can
// reach it.
//
// CRLF: `* text=auto` with `core.autocrlf=true` means a probe's working-tree
// source may arrive with either ending, so the mutation harness normalizes
// before matching anchors and no assertion here anchors on a bare "\n".

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import { PROBE_EXIT_CODES, runProbe } from "./lib/probe-runtime.mjs";
import { descriptor as velocityDescriptor } from "./probe-polyline-taa-velocity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = path.join(HERE, "probe-polyline-taa-velocity.mjs");
const RUNTIME_PATH = path.join(HERE, "lib", "probe-runtime.mjs");

// ---------------------------------------------------------------------------
// Fixtures: the pixels and half-floats the stubbed page hands back
// ---------------------------------------------------------------------------

const FRAME = { width: 8, height: 8 };
// Cyan on black is what `countLinePixels` looks for (g > 40, b > 40, r < g-20),
// so a fixed number of cyan texels gives the smear ratio a known numerator and
// denominator without inventing a rendering.
const LINE_PIXELS = 12;

/**
 * @param {number} litPixels How many cyan pixels the frame carries.
 * @returns {Buffer} A PNG `decodePng` accepts.
 */
function framePng(litPixels) {
  const pixels = new Uint8Array(FRAME.width * FRAME.height * 4);
  for (let i = 0; i < FRAME.width * FRAME.height; i++) {
    const lit = i < litPixels;
    pixels[i * 4] = 0;
    pixels[i * 4 + 1] = lit ? 200 : 0;
    pixels[i * 4 + 2] = lit ? 200 : 0;
    pixels[i * 4 + 3] = 255;
  }
  return Buffer.from(encodeRgbaPng(pixels, FRAME.width, FRAME.height));
}

// 0x3c00 is the half-float 1.0; 0x0000 is +0. `countNonZeroVelocityTexels`
// clears its 1e-4 floor on the first and never on the second, which is the
// measurement cell and the negative control respectively.
const MOVING_HALVES = Array.from({ length: 16 }, () => 0x3c00);
const STILL_HALVES = Array.from({ length: 16 }, () => 0x0000);

// ---------------------------------------------------------------------------
// The stub browser. `launch` is the runtime's only seam onto Edge.
// ---------------------------------------------------------------------------

/**
 * A page that answers the probe's `page.evaluate` calls by matching the source
 * of the function it was handed. Dispatch order matters: the scene builder's
 * page function DEFINES `__probeReadVelocity`, `__probeStep` and
 * `__probeRender`, so it has to be recognised by its dynamic import first or it
 * would be mistaken for one of the calls it installs.
 *
 * @param {{calls: string[]}} log Records what the probe asked the page to do.
 * @returns {object} The stub page.
 */
function fakePage(log) {
  let materialType = null;
  let withPolyline = false;
  return {
    on() {},
    async addInitScript() {},
    async goto() {},
    async waitForFunction() {},
    async evaluate(fn, arg) {
      const source = String(fn);
      if (source.includes("/Build/CesiumUnminified/index.js")) {
        materialType = arg.materialType;
        withPolyline = arg.withPolyline;
        log.calls.push(
          `build:${arg.renderer}:${arg.materialType}:${arg.withPolyline}`,
        );
        return { rendererType: arg.renderer };
      }
      if (source.includes("__probeReadVelocity")) {
        log.calls.push(`read:${materialType}`);
        return {
          available: true,
          halves: materialType === "Color" ? MOVING_HALVES : STILL_HALVES,
          width: 4,
          height: 2,
        };
      }
      if (source.includes("__probeRender")) {
        log.calls.push("render");
        return undefined;
      }
      if (source.includes("__armWebGPUDevice")) {
        log.calls.push("arm");
        return { armed: 1, found: 1, total: 1 };
      }
      if (source.includes("__webgpuGate")) {
        log.calls.push("gate");
        return { errors: [], deviceLost: null, armedDevices: 1 };
      }
      // A page call this stub does not model is a silent hole in the walk, so
      // it fails loudly rather than returning undefined and letting the probe
      // read a field off it.
      throw new Error(`unstubbed page.evaluate: ${source.slice(0, 120)}`);
    },
    locator() {
      return {
        first: () => ({
          async screenshot() {
            log.calls.push(`shot:${withPolyline}`);
            return framePng(withPolyline ? LINE_PIXELS : 0);
          },
        }),
      };
    },
  };
}

/**
 * @param {{calls: string[], launches: number}} log
 * @returns {Function} A `launch` implementation for `runProbe`.
 */
function fakeLaunch(log) {
  return async () => {
    log.launches += 1;
    return {
      async newPage() {
        return fakePage(log);
      },
      async close() {},
    };
  };
}

/** @returns {string} A fresh temporary directory the caller removes. */
function makeTempRoot() {
  return mkdtempSync(path.join(tmpdir(), "probe-cells-contract-"));
}

/**
 * Import a module from mutated source, resolving its relative specifiers to
 * absolute file urls first — a `data:` module cannot resolve `./` or `../`.
 *
 * @param {string} file Absolute path of the module to mutate.
 * @param {Array<[string, string]>} replacements Anchor/replacement pairs.
 * @returns {Promise<object>} The mutated module namespace.
 */
async function importMutated(file, replacements) {
  let source = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const base = pathToFileURL(file);
  source = source.replace(
    /from "(\.[^"]*)"/g,
    (_match, specifier) => `from "${new URL(specifier, base).href}"`,
  );
  for (const [anchor, replacement] of replacements) {
    const occurrences = source.split(anchor).length - 1;
    assert.equal(
      occurrences,
      1,
      `mutation anchor must occur exactly once, found ${occurrences}: ${anchor.slice(0, 80)}`,
    );
    source = source.replace(anchor, replacement);
  }
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return import(url);
}

/**
 * Runs a descriptor through `runProbe` with the stub browser.
 *
 * @param {object} descriptor The descriptor under test.
 * @param {object} [options] `{root, runs}`.
 * @returns {Promise<object>} `{code, out, log}`.
 */
async function driveProbe(descriptor, { root, runs = 3 } = {}) {
  const out = path.join(root, "out");
  const log = { calls: [], launches: 0 };
  const code = await runProbe(descriptor, {
    argv: [
      "--repository-root",
      root,
      "--output",
      out,
      "--runs",
      String(runs),
      "--no-serve-built",
    ],
    now: () => Date.UTC(2026, 8, 5, 23, 0, 0),
    launch: fakeLaunch(log),
  });
  return { code, out, log };
}

// ---------------------------------------------------------------------------
// A. The runtime's contract: `cells()` returns an array, and says so when it
//    does not.
// ---------------------------------------------------------------------------

test("A. runProbe requires descriptor.cells to return an array", async (t) => {
  const base = {
    name: "shape-probe",
    title: "Shape probe",
    receipt: (cells) => ({ cells }),
    verdicts: () => [{ id: "v", pass: true }],
  };

  await t.test("an array of cells is collected, one push per run", async () => {
    const root = makeTempRoot();
    try {
      const { code, out } = await driveProbe(
        { ...base, cells: async ({ run }) => [{ run }] },
        { root, runs: 3 },
      );
      assert.equal(code, PROBE_EXIT_CODES.OK);
      const receipt = JSON.parse(
        readFileSync(path.join(out, "shape-probe-report.json"), "utf8"),
      );
      assert.deepEqual(
        receipt.cells,
        [{ run: 0 }, { run: 1 }, { run: 2 }],
        "three runs contribute three cells, in order",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("a run that produces nothing is still legal", async () => {
    const root = makeTempRoot();
    try {
      const { code, out } = await driveProbe(
        { ...base, cells: async () => undefined },
        { root, runs: 2 },
      );
      assert.equal(code, PROBE_EXIT_CODES.OK);
      const receipt = JSON.parse(
        readFileSync(path.join(out, "shape-probe-report.json"), "utf8"),
      );
      assert.deepEqual(receipt.cells, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("a bare object is refused by name, not by spread", async () => {
    const root = makeTempRoot();
    try {
      const { code, out } = await driveProbe(
        { ...base, cells: async () => ({ value: 1 }) },
        { root, runs: 1 },
      );
      assert.equal(code, PROBE_EXIT_CODES.ERROR);
      const incident = JSON.parse(
        readFileSync(path.join(out, "shape-probe-error.json"), "utf8"),
      );
      assert.match(
        incident.error,
        /shape-probe: descriptor\.cells must return an array of cells/,
        "the message names the probe, so the next reader is not sent to the runtime's line number",
      );
      assert.match(incident.error, /\[object Object\]/);
      assert.match(incident.error, /wrap a single cell as \[cell\]/);
      assert.ok(
        !/Symbol\(Symbol\.iterator\)|Spread syntax/.test(incident.error),
        "the guard fires before the spread, so the anonymous spread error never surfaces",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test(
    "MUTATION: an inert guard restores the anonymous spread error",
    async () => {
      const root = makeTempRoot();
      try {
        const mutated = await importMutated(RUNTIME_PATH, [
          ["!Array.isArray(produced)", "false && !Array.isArray(produced)"],
        ]);
        const out = path.join(root, "out");
        const log = { calls: [], launches: 0 };
        const code = await mutated.runProbe(
          { ...base, cells: async () => ({ value: 1 }) },
          {
            argv: [
              "--repository-root",
              root,
              "--output",
              out,
              "--no-serve-built",
            ],
            launch: fakeLaunch(log),
          },
        );
        assert.equal(code, PROBE_EXIT_CODES.ERROR);
        const incident = JSON.parse(
          readFileSync(path.join(out, "shape-probe-error.json"), "utf8"),
        );
        assert.match(
          incident.error,
          /Spread syntax|is not iterable/,
          "with the guard inert the failure is the unattributed one AR-752 hit",
        );
        assert.ok(
          !/descriptor\.cells must return an array/.test(incident.error),
          "and the named message is gone, which is what makes the guard the thing under test",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

// ---------------------------------------------------------------------------
// B. The REAL velocity descriptor, walked end to end on a stubbed browser.
//    This is the check that would have caught AR-752's lost leg.
// ---------------------------------------------------------------------------

test("B. probe-polyline-taa-velocity completes a --runs 3 walk", async (t) => {
  const root = makeTempRoot();
  let result;
  let receipt;
  try {
    result = await driveProbe(velocityDescriptor, { root, runs: 3 });

    await t.test("the run completes and exits 0", () => {
      assert.equal(
        result.code,
        PROBE_EXIT_CODES.OK,
        "a descriptor whose cells() cannot be collected never reaches a verdict",
      );
      assert.equal(result.log.launches, 3, "one browser per run");
    });

    await t.test("--runs 3 produces three cells", () => {
      receipt = JSON.parse(
        readFileSync(path.join(result.out, "polyvel-report.json"), "utf8"),
      );
      assert.ok(Array.isArray(receipt.runs), "receipt.runs is an array");
      assert.equal(receipt.runs.length, 3);
      for (const run of receipt.runs) {
        assert.equal(run.animatedColor.nonZero, MOVING_HALVES.length / 2);
        assert.equal(run.animatedDash.nonZero, 0);
        assert.equal(run.webgpuLinePixels, LINE_PIXELS);
        assert.equal(run.webglLinePixels, LINE_PIXELS);
        assert.equal(run.emptyWebgpuLinePixels, 0);
        assert.equal(run.emptyWebglLinePixels, 0);
        assert.equal(run.errors, 0);
      }
    });

    await t.test("every run walks the same five scenes", () => {
      const perRun = result.log.calls.length / 3;
      assert.equal(perRun, Math.trunc(perRun), "the runs are symmetric");
      assert.deepEqual(result.log.calls.slice(0, perRun), [
        "arm",
        "build:webgpu:Color:true",
        "render",
        "read:Color",
        "shot:true",
        "build:webgpu:PolylineDash:true",
        "render",
        "read:PolylineDash",
        "build:webgpu:Color:false",
        "render",
        "shot:false",
        "build:webgl:Color:true",
        "render",
        "shot:true",
        "build:webgl:Color:false",
        "render",
        "shot:false",
        "gate",
      ]);
    });

    await t.test("the four verdicts are published, one detail per run", () => {
      const runtime = JSON.parse(
        readFileSync(path.join(result.out, "polyvel-runtime.json"), "utf8"),
      );
      assert.deepEqual(
        runtime.verdicts.map((verdict) => verdict.id),
        [
          "velocity-emitted",
          "negative-control-dash",
          "ghost-smear-ratio",
          "gate-clean",
        ],
      );
      for (const verdict of runtime.verdicts) {
        assert.equal(verdict.pass, true, `${verdict.id} passes on fixtures`);
        assert.equal(
          verdict.detail.length,
          3,
          `${verdict.id} carries one detail per run, so a lucky run is visible`,
        );
      }
    });

    await t.test("the summary renders one table row per run", () => {
      const summary = readFileSync(
        path.join(result.out, "polyvel-summary.md"),
        "utf8",
      );
      const rows = summary
        .split(/\r?\n/)
        .filter((line) => /^\| [123] \|/.test(line));
      assert.equal(rows.length, 3);
      assert.match(rows[0], /\| 1\.000 \| 0 \|$/, "the smear ratio is printed");
    });

    await t.test("the four captures are written", () => {
      const pngs = readdirSync(result.out)
        .filter((name) => name.endsWith(".png"))
        .sort();
      assert.deepEqual(pngs, [
        "polyvel-webgl-color.png",
        "polyvel-webgl-empty.png",
        "polyvel-webgpu-color.png",
        "polyvel-webgpu-empty.png",
      ]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C. The served-build refusal still decides before a browser is claimed.
// ---------------------------------------------------------------------------

test("C. the served-build preflight refuses before any launch", async () => {
  const root = makeTempRoot();
  try {
    const out = path.join(root, "out");
    const log = { calls: [], launches: 0 };
    const code = await runProbe(velocityDescriptor, {
      argv: ["--repository-root", root, "--output", out, "--runs", "3"],
      launch: fakeLaunch(log),
      preflight: async () => ({
        ok: false,
        artifacts: [
          {
            path: "Build/CesiumUnminified/Cesium.js",
            disk: { exists: true, md5: "aaa" },
            served: { ok: true, status: 200, md5: "bbb" },
            match: false,
          },
        ],
      }),
    });
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    assert.equal(
      log.launches,
      0,
      "the identity refusal is decided before the Edge slot is spent",
    );
    const refusal = JSON.parse(
      readFileSync(path.join(out, "polyvel-refusal.json"), "utf8"),
    );
    assert.equal(refusal.outcome, "refused");
    assert.ok(
      !readdirSync(out).includes("polyvel-report.json"),
      "a run that did not measure writes no receipt",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D. MUTATION: restore the shape AR-752's leg died on and require group B's
//    walk to go red.
// ---------------------------------------------------------------------------

test("D. MUTATION: the pre-fix bare-object return turns the walk red", async () => {
  const root = makeTempRoot();
  try {
    const mutated = await importMutated(PROBE_PATH, [
      [
        `      return [
        {
          animatedColor,
          animatedDash,`,
        `      return {
          animatedColor,
          animatedDash,`,
      ],
      [
        `          gateErrorsSample: gate.errors.slice(0, 6),
        },
      ];`,
        `          gateErrorsSample: gate.errors.slice(0, 6),
      };`,
      ],
    ]);
    const { code, out } = await driveProbe(mutated.descriptor, {
      root,
      runs: 3,
    });
    assert.equal(
      code,
      PROBE_EXIT_CODES.ERROR,
      "the pre-fix return shape cannot complete a run",
    );
    assert.ok(
      !readdirSync(out).includes("polyvel-report.json"),
      "and it publishes no receipt, which is why leg 4 had nothing to read",
    );
    const incident = JSON.parse(
      readFileSync(path.join(out, "polyvel-error.json"), "utf8"),
    );
    assert.match(
      incident.error,
      /polyvel: descriptor\.cells must return an array of cells/,
    );
    assert.deepEqual(incident.verdicts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
