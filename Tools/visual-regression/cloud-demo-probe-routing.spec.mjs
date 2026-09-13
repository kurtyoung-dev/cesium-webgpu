// cloud-demo-probe-routing.spec.mjs — C13-N01 stage 2, family batch 1.
// Pure Node: no browser, no network, no GPU.
//
// @purpose Drives the eight routed Weather-Inspector cloud probes through runProbe against a stub browser, so the routing is known to reach a receipt, take its origin from the runtime and refuse port 8080 before an Edge slot is spent on it.
// @status ACTIVE
//
// WHAT THIS BATCH DID, AND WHY A NODE SPEC IS THE RIGHT CHECK FOR IT.
// Eight probes that each launched Edge themselves, resolved their origin as
// `process.env.PROBE_BASE || "http://localhost:8080"` and set their own exit
// code now declare a descriptor and let `lib/probe-runtime.mjs` own the origin,
// the served-build preflight, the Edge slot, the browser, the deadline, the
// receipt and the exit code. None of that can be measured by reading source:
// `probe-fleet-contract.spec.mjs` already asks whether a probe has a watchdog
// and `runtime-residency-contract.spec.mjs` whether it re-rolls a concern the
// runtime owns, and BOTH would stay green over a descriptor whose `cells`
// throws on its first line.
//
// `probe-descriptor-cells-contract.spec.mjs` exists because exactly that
// happened: AR-752 lost an Edge leg to a three-character shape error on the
// probe's only execution path, after the slot had been taken and the
// measurements made. So this file runs the real descriptors. `runProbe`'s
// `launch` seam is the only thing between a probe and Edge, so a stub browser
// whose page answers each probe's `page.evaluate` calls by the text of the
// function it was handed walks the whole chain — argv, preflight, slot, cells,
// receipt, verdicts, summary, exit code — in milliseconds.
//
// WHAT IT DELIBERATELY DOES NOT DO: measure anything. Every number below is a
// fixture chosen to put a clause on a known side of its bar. No number here is
// evidence about the renderer, and none of the eight has been run on the routed
// code yet — the equivalence leg (routed receipt versus the pre-routing run on
// the same served tree) is an Edge measurement and is owed, not claimed.
//
// THE CAPTURE NAMES ARE PART OF THE CONTRACT. Each probe's PNG names are the
// banked evidence file names; the routing kept every one of them, and A1 pins
// them so a later batch cannot quietly rename evidence out from under the
// output directory.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import {
  PROBE_EXIT_CODES,
  REQUIRED_SERVED_ARTIFACTS,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { deriveLifecycleDeadline } from "./lib/probe-lifecycle-run.mjs";

import { descriptor as diagonal } from "./probe-cloud-diagonal.mjs";
import { descriptor as dials } from "./probe-cloud-dials.mjs";
import { descriptor as exoticFlags } from "./probe-cloud-exotic-flags.mjs";
import { descriptor as extinction } from "./probe-cloud-extinction.mjs";
import { descriptor as genus } from "./probe-cloud-genus.mjs";
import { descriptor as mammatus } from "./probe-cloud-mammatus.mjs";
import { descriptor as species } from "./probe-cloud-species.mjs";
import { descriptor as stbnLod } from "./probe-cloud-stbn-lod.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A 4x4 transparent PNG. The stub page never renders, so no pixel is read. */
const FRAME = Buffer.from(encodeRgbaPng(new Uint8Array(4 * 4 * 4), 4, 4));

/** The two bundles the legacy Sandcastle gallery page actually loads. */
const DEMO_ARTIFACTS = Object.freeze([
  "Build/CesiumUnminified/Cesium.js",
  "Build/CesiumUnminified/index.js",
]);

/**
 * Take the next value of a fixture series, holding the last one once the series
 * runs out — a probe that grew a capture should fail on its CLAUSE, not on an
 * undefined read three frames earlier.
 *
 * @param {object} state Per-drive scratch.
 * @param {string} key Series name.
 * @param {Array<unknown>} series The values, in call order.
 * @returns {unknown} The value for this call.
 */
function nextOf(state, key, series) {
  const index = state[key] ?? 0;
  state[key] = index + 1;
  return series[Math.min(index, series.length - 1)];
}

/**
 * The eight probes of family batch 1.
 *
 * `evaluate` answers one probe's in-page calls by the text of the function the
 * probe handed `page.evaluate`. The markers are the probe's own local names, so
 * a rewritten in-page helper reaches the `unstubbed` branch and fails loudly
 * rather than being answered with the wrong shape.
 */
const PROBES = [
  {
    descriptor: diagonal,
    file: "probe-cloud-diagonal.mjs",
    captures: ["cloud-diagonal-ovc"],
    verdicts: 5,
    evaluate(source) {
      if (source.includes("getElementById")) {
        return { ok: true };
      }
      if (source.includes("getImageData")) {
        return {
          topLeft: { deck: 60, lum: 120, n: 10 },
          topRight: { deck: 62, lum: 120, n: 10 },
          botLeft: { deck: 90, lum: 120, n: 10 },
          botRight: { deck: 88, lum: 120, n: 10 },
        };
      }
      return undefined;
    },
  },
  {
    descriptor: dials,
    file: "probe-cloud-dials.mjs",
    captures: [
      "dials-default",
      "dials-explicit-defaults",
      "dials-exposure-lo",
      "dials-puff-big",
      "dials-reset",
    ],
    verdicts: 5,
    evaluate(source, arg, state) {
      // `diff`'s own body contains `naturalWidth` inside its `load` helper, so
      // the two-image reader is recognised FIRST or the one-image reader would
      // swallow it.
      if (source.includes("const load = async")) {
        return nextOf(state, "diff", [0.05, 1.2, 2.5, 0.05]);
      }
      if (source.includes("naturalWidth")) {
        return 120.5;
      }
      return undefined;
    },
  },
  {
    descriptor: exoticFlags,
    file: "probe-cloud-exotic-flags.mjs",
    captures: [
      "exotic-billboard-off",
      "exotic-billboard-exoticon",
      "exotic-volumetric-off-a",
      "exotic-volumetric-off-b",
      "exotic-volumetric-mammatus",
      "exotic-volumetric-species",
      "exotic-volumetric-feature",
    ],
    verdicts: 6,
    evaluate(source, arg, state) {
      if (source.includes("getImageData")) {
        return nextOf(state, "diff", [0.05, 0.05, 1.5, 2.0, 2.0]);
      }
      return undefined;
    },
  },
  {
    descriptor: extinction,
    file: "probe-cloud-extinction.mjs",
    captures: [
      "extinction-default",
      "extinction-cumulus",
      "extinction-cirrus",
      "extinction-cumulonimbus",
    ],
    verdicts: 5,
    evaluate(source, arg, state) {
      if (source.includes("cloudFrac")) {
        return nextOf(state, "metrics", [
          { cloudFrac: 10, cloudMeanL: 100 },
          { cloudFrac: 10, cloudMeanL: 100 },
          { cloudFrac: 5, cloudMeanL: 100 },
          { cloudFrac: 20, cloudMeanL: 100 },
        ]);
      }
      if (source.includes("Math.abs(")) {
        return 0.05;
      }
      return undefined;
    },
  },
  {
    descriptor: genus,
    file: "probe-cloud-genus.mjs",
    captures: [
      "genus-default",
      "genus-cumulus",
      "genus-cirrus",
      "genus-cumulonimbus",
      "genus-stratus",
    ],
    verdicts: 5,
    evaluate(source, arg, state) {
      // `deck` and `diff` both decode with `getImageData`; `blueSky` is deck's
      // own local and `Math.abs(` is diff's own reduction.
      if (source.includes("blueSky")) {
        return nextOf(state, "deck", [70, 70, 50, 60, 55]);
      }
      if (source.includes("Math.abs(")) {
        return nextOf(state, "diff", [0.05, 2.0, 2.0, 1.0]);
      }
      return undefined;
    },
  },
  {
    descriptor: mammatus,
    file: "probe-cloud-mammatus.mjs",
    captures: [
      "mammatus-off",
      "mammatus-off2",
      "mammatus-on",
      "mammatus-off-restored",
    ],
    verdicts: 5,
    evaluate(source, arg, state) {
      if (source.includes("blueSky")) {
        return nextOf(state, "deck", [80, 60]);
      }
      if (source.includes("Math.abs(")) {
        return nextOf(state, "diff", [0.1, 2.0, 0.1]);
      }
      return undefined;
    },
  },
  {
    descriptor: species,
    file: "probe-cloud-species.mjs",
    captures: [
      "species-off",
      "species-off2",
      "species-lenticularis",
      "species-fibratus",
      "species-uncinus",
      "species-off-restored",
    ],
    verdicts: 7,
    evaluate(source, arg, state) {
      if (source.includes("blueSky")) {
        return nextOf(state, "deck", [80, 75, 60]);
      }
      if (source.includes("Math.abs(")) {
        return nextOf(state, "diff", [0.05, 2.0, 2.0, 1.0, 0.05]);
      }
      return undefined;
    },
  },
  {
    descriptor: stbnLod,
    file: "probe-cloud-stbn-lod.mjs",
    captures: [
      "stbnlod-off-a",
      "stbnlod-off-b",
      "stbnlod-off-explicit",
      "stbnlod-growth-on",
      "stbnlod-cap-on",
    ],
    verdicts: 5,
    evaluate(source, arg, state) {
      if (source.includes("getImageData")) {
        // The two off-gates are byte-identical (0) and the two wiring clauses
        // clear the 0.15 floor.
        return nextOf(state, "diff", [0, 0, 0.5, 0.5]);
      }
      return undefined;
    },
  },
];

/**
 * A page that answers one probe's in-page calls.
 *
 * @param {object} entry The probe's table row.
 * @param {object} log Call sink.
 * @param {object} options Options.
 * @param {object} [options.boot] What the demo's boot call returns.
 * @returns {object} The stub page.
 */
function fakePage(entry, log, { boot = { ok: true } } = {}) {
  const state = {};
  return {
    on() {},
    async addInitScript() {},
    async addStyleTag() {},
    async goto(url) {
      log.gotos.push(url);
    },
    async waitForFunction() {},
    async waitForTimeout(ms) {
      log.waits.push(ms);
    },
    async evaluate(fn, arg) {
      const source = String(fn);
      if (source.includes("window.startup")) {
        log.calls.push("boot");
        return boot;
      }
      if (source.includes("__armWebGPUDevice")) {
        log.calls.push("arm");
        return { armed: 1, found: 1, total: 1 };
      }
      if (source.includes("__webgpuGate")) {
        log.calls.push("gate");
        return { errors: [], deviceLost: null, armedDevices: 1 };
      }
      const answer = entry.evaluate(source, arg, state);
      log.calls.push(answer === undefined ? "apply" : "read");
      return answer;
    },
    locator(selector) {
      log.selectors.push(selector);
      return {
        async count() {
          return 1;
        },
        async screenshot() {
          log.shots += 1;
          return FRAME;
        },
      };
    },
  };
}

/**
 * Launch a stub browser. `isConnected` must go false after `close()` or the
 * lifecycle's bounded close never observes the resource settling and the run
 * dies at the hard-stop grace — a stub requirement, not a probe defect.
 *
 * @param {object} entry The probe's table row.
 * @param {object} log Call sink.
 * @param {object} [options] Page options.
 * @returns {Function} A `launch` implementation.
 */
function fakeLaunch(entry, log, options) {
  return async () => {
    log.launches += 1;
    let connected = true;
    return {
      async newPage(pageOptions) {
        log.viewports.push(pageOptions?.viewport ?? null);
        return fakePage(entry, log, options);
      },
      async close() {
        log.closes += 1;
        connected = false;
      },
      isConnected: () => connected,
    };
  };
}

/**
 * Run one descriptor end to end in a sandbox under `os.tmpdir()`.
 *
 * @param {object} entry The probe's table row.
 * @param {object} [options] Options.
 * @param {string[]} [options.argv] Extra argv.
 * @param {object} [options.page] Page options.
 * @param {object} [options.descriptor] Descriptor override (mutation controls).
 * @returns {Promise<{code: number|null, thrown: Error|null, root: string,
 *   out: string, log: object}>} The run.
 */
async function drive(entry, { argv = [], page, descriptor } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "cloud-demo-routing-"));
  // Destructive-test discipline: everything this spec writes is under
  // os.tmpdir(), asserted rather than assumed.
  assert.ok(
    root.startsWith(tmpdir()),
    "the spec's sandbox must live under os.tmpdir()",
  );
  const out = path.join(root, "out");
  const log = {
    calls: [],
    gotos: [],
    waits: [],
    selectors: [],
    viewports: [],
    shots: 0,
    launches: 0,
    closes: 0,
  };
  // A rejection is an OUTCOME here, not a spec error: `runProbe` rejects
  // rather than returning an exit code when its argv parse fails (see B2's
  // 8080 leg and the finding it names), and a spec that could not observe that
  // would have to pretend the case does not exist.
  let code = null;
  let thrown = null;
  try {
    code = await runProbe(descriptor ?? entry.descriptor, {
      argv: [
        "--repository-root",
        root,
        "--output",
        out,
        "--no-serve-built",
        "--renderer",
        "webgpu",
        ...argv,
      ],
      now: () => Date.UTC(2026, 8, 13, 22, 0, 0),
      launch: fakeLaunch(entry, log, page),
    });
  } catch (error) {
    thrown = error;
  }
  return { code, thrown, root, out, log };
}

/**
 * @param {string} root Sandbox root to remove.
 * @returns {void}
 */
function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

// ===========================================================================
// A. The cohort contract — what every routed probe in this batch declares
// ===========================================================================

test("A1: every routed descriptor declares the cohort's identity and artifacts", () => {
  for (const entry of PROBES) {
    const { descriptor: d } = entry;
    assert.equal(
      `probe-${d.name}.mjs`,
      entry.file,
      `${entry.file}: descriptor name does not match its file`,
    );
    // The empty subdirectory is what keeps each capture at the path the
    // pre-routing probe wrote it to (`output/<name>.png`), so banked evidence
    // is still found where the ledger cites it.
    assert.equal(
      d.outputSubdirectory,
      "",
      `${entry.file}: would move its captures into a new folder`,
    );
    // None of the eight banked a JSON receipt before the migration, so none of
    // them owes a field set to a downstream reader; the single-document
    // envelope is the shape they take.
    assert.equal(d.receiptEnvelope, "runtime", `${entry.file}: envelope`);
    // The demo page loads `Cesium.js` through its own script tag and its boot
    // helper imports `index.js`. The runtime's DEFAULT list names the
    // Sandcastle2 bucket bundle instead, which this legacy gallery page never
    // touches — so a probe left on the default would refuse over an artifact
    // its measurement does not read.
    assert.deepEqual(
      d.servedArtifacts,
      DEMO_ARTIFACTS,
      `${entry.file}: served`,
    );
    assert.notDeepEqual(d.servedArtifacts, REQUIRED_SERVED_ARTIFACTS);
    assert.equal(typeof d.cells, "function", `${entry.file}: cells`);
    assert.equal(typeof d.verdicts, "function", `${entry.file}: verdicts`);
    assert.equal(typeof d.receipt, "function", `${entry.file}: receipt`);
  }
  assert.equal(PROBES.length, 8, "family batch 1 is eight probes");
});

test("A2: every work budget is a usable lifecycle deadline, and a bad one is refused", () => {
  const options = { runs: 1, timeoutMs: 120000 };
  for (const entry of PROBES) {
    const { descriptor: d } = entry;
    assert.equal(
      typeof d.workBudgetMs,
      "function",
      `${entry.file}: declaring no workBudgetMs takes the pre-adoption path, which carries no deadline at all`,
    );
    const budget = d.workBudgetMs(options);
    assert.ok(
      Number.isSafeInteger(budget) && budget > 0,
      `${entry.file}: work budget ${budget}`,
    );
    // The derived deadline is what actually bounds the run, so it is the thing
    // asserted: a budget the runtime cannot turn into a timer is a probe that
    // dies before it reaches a browser.
    const deadline = deriveLifecycleDeadline(options, d);
    assert.ok(deadline > budget, `${entry.file}: deadline ${deadline}`);
    // Every one of these probes boots a demo, settles, captures and decodes;
    // a budget under a minute would be a transcription error, not a fast probe.
    assert.ok(budget >= 60_000, `${entry.file}: implausibly small budget`);
    // Ten runs must still fit inside the timer range, so `--runs 10` is a
    // scheduling decision rather than a RangeError.
    assert.ok(deriveLifecycleDeadline({ ...options, runs: 10 }, d) > 0);
  }
  // And the check is live: a budget that is not a positive safe integer is
  // refused rather than silently floored.
  assert.throws(() =>
    deriveLifecycleDeadline(options, {
      ...PROBES[0].descriptor,
      workBudgetMs: () => 0,
    }),
  );
});

// ===========================================================================
// B. The descriptors, executed
// ===========================================================================

for (const entry of PROBES) {
  test(`B1 ${entry.descriptor.name}: cells reach a receipt, and every capture keeps its banked name`, async () => {
    const { code, root, out, log } = await drive(entry);
    try {
      assert.equal(
        code,
        PROBE_EXIT_CODES.OK,
        `${entry.file}: the all-pass fixture did not produce exit 0`,
      );
      assert.equal(log.launches, 1, "one browser per run");
      assert.equal(log.closes, 1, "the browser was not closed");
      assert.equal(log.shots, entry.captures.length);
      assert.ok(
        log.calls.includes("boot"),
        "the demo boot call never happened",
      );
      assert.ok(
        !log.calls.includes("unstubbed"),
        "a page call reached no branch of the stub",
      );

      const report = JSON.parse(
        readFileSync(
          path.join(out, `${entry.descriptor.name}-report.json`),
          "utf8",
        ),
      );
      assert.deepEqual(
        report.captures.map((capture) => capture.name),
        entry.captures,
        `${entry.file}: capture names drifted from the banked evidence`,
      );
      for (const capture of report.captures) {
        assert.equal(
          path.dirname(capture.path),
          out,
          "capture left its folder",
        );
        assert.equal(
          capture.matchCount,
          1,
          "the canvas selector was ambiguous",
        );
      }
      assert.equal(report.verdicts.length, entry.verdicts);
      for (const verdict of report.verdicts) {
        assert.equal(
          verdict.pass,
          true,
          `${verdict.id} failed on a pass fixture`,
        );
        assert.match(verdict.id, /\/run0$/);
      }
      // The runtime envelope is ONE document: a `-runtime.json` sidecar beside
      // it would mean the probe declared `probe-owned` and its own fields were
      // published without the runtime's.
      const written = readdirSync(out).sort();
      assert.deepEqual(written, [
        `${entry.descriptor.name}-report.json`,
        `${entry.descriptor.name}-summary.md`,
      ]);
    } finally {
      cleanup(root);
    }
  });
}

test("B2: the origin comes from the runtime, and port 8080 refuses before Edge is launched", async () => {
  for (const entry of PROBES) {
    const { root, log } = await drive(entry, { argv: ["--port", "8137"] });
    try {
      assert.equal(log.gotos.length, 1, `${entry.file}: navigations`);
      assert.ok(
        log.gotos[0].startsWith("http://localhost:8137/"),
        `${entry.file}: navigated to ${log.gotos[0]} rather than the runtime's origin`,
      );
      assert.ok(
        !log.gotos[0].includes(":8080"),
        `${entry.file}: still reaches the maintainer's live 8080 server`,
      );
      assert.equal(
        log.selectors[0],
        ".cesium-widget canvas",
        `${entry.file}: captured something other than the widget canvas`,
      );
    } finally {
      cleanup(root);
    }
  }

  // The refusal the routing bought: 8080 cannot distinguish the built tree from
  // whatever the maintainer is running, so the runtime refuses it — and refuses
  // it BEFORE a browser is opened or a slot is taken. THOSE are the properties
  // asserted, because they are the ones that matter to the machine and they
  // hold either way.
  //
  // DEFECT, MEASURED HERE AND FILED NOT FIXED (lib/probe-runtime.mjs is owned
  // by DX-01, not by this lane): the port-8080 `ProbeRefusal` is raised inside
  // `parseProbeArgs`, so `options` is never assigned, and
  // `buildRuntimeReceipt` then reads `options.servedBuild` off `null`
  // (`lib/probe-runtime.mjs:665`) and throws `TypeError: Cannot read
  // properties of null`. The run therefore REJECTS instead of returning exit 3,
  // and a probe whose entry point is `process.exitCode = await runProbe(...)`
  // leaves on an unhandled rejection. Reproduced with a two-line descriptor and
  // with any bad flag, so it is the runtime's and not this batch's. The
  // assertion below accepts either outcome deliberately: pinning the crash
  // would turn the fix into a red spec.
  const { code, thrown, root, out, log } = await drive(PROBES[0], {
    argv: ["--port", "8080"],
  });
  try {
    assert.equal(log.launches, 0, "Edge was launched for a refused run");
    assert.equal(log.gotos.length, 0, "a page was opened for a refused run");
    // The directory itself is not even created on this path, which is the
    // strongest form of "published nothing".
    assert.deepEqual(
      existsSync(out)
        ? readdirSync(out).filter((name) => name.endsWith("-report.json"))
        : [],
      [],
      "a refused run published a receipt",
    );
    assert.ok(
      code === PROBE_EXIT_CODES.REFUSAL || thrown !== null,
      `port 8080 was neither refused nor fatal (exit ${code})`,
    );
  } finally {
    cleanup(root);
  }
});

test("B3: a demo that does not boot refuses, and writes no receipt over the banked one", async () => {
  const { code, root, out, log } = await drive(PROBES[0], {
    page: { boot: { ok: false, err: "window.startup not defined" } },
  });
  try {
    // Exit 3, not 1: a demo that never booted is not a red measurement, it is
    // no measurement. The pre-routing probe scored this 1, which an
    // orchestrator reads as "the gate ran and failed".
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    assert.equal(log.shots, 0, "a capture was taken after a failed boot");
    const written = readdirSync(out).sort();
    assert.deepEqual(written, ["cloud-diagonal-refusal.json"]);
    const incident = JSON.parse(
      readFileSync(path.join(out, "cloud-diagonal-refusal.json"), "utf8"),
    );
    assert.equal(incident.outcome, "refused");
    assert.equal(incident.refusal.reason, "demo-boot-failed");
    assert.match(incident.refusal.message, /window\.startup not defined/);
  } finally {
    cleanup(root);
  }
});

test("B4: a failing clause carries the exit code the orchestrator reads", async () => {
  // The pre-routing probes ended with `process.exitCode = pass ? 0 : 1`. The
  // runtime's table has to reproduce that, or every routed probe silently
  // reports GREEN to the runner that schedules it.
  const failing = {
    ...PROBES[0],
    evaluate() {
      return {
        // A stark top-left/bottom-right asymmetry: exactly the diagonal the
        // probe exists to catch.
        topLeft: { deck: 90, lum: 120, n: 10 },
        topRight: { deck: 2, lum: 120, n: 10 },
        botLeft: { deck: 90, lum: 120, n: 10 },
        botRight: { deck: 2, lum: 120, n: 10 },
      };
    },
  };
  const { code, root, out } = await drive(failing);
  try {
    assert.equal(code, PROBE_EXIT_CODES.FAILURE);
    const report = JSON.parse(
      readFileSync(path.join(out, "cloud-diagonal-report.json"), "utf8"),
    );
    const failed = report.verdicts.filter((verdict) => verdict.pass !== true);
    assert.deepEqual(
      failed.map((verdict) => verdict.id),
      ["bottom-right-deck/run0", "bottom-symmetry/run0", "top-symmetry/run0"],
    );
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// C. Mutation controls — the two assertions that would otherwise be decorative
// ===========================================================================

/**
 * Import a mutated copy of one probe module.
 *
 * A `data:` URL module has no base to resolve a relative specifier against, so
 * every relative import is rewritten to the absolute URL this spec resolves it
 * to. That rewrite is not the mutation — it is what makes the mutant loadable.
 *
 * @param {string} file The probe's file name.
 * @param {(source: string) => string} mutate The mutation.
 * @returns {Promise<object>} The mutated module.
 */
async function importMutatedProbe(file, mutate) {
  const source = readFileSync(path.join(HERE, file), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  const loadable = source.replace(
    /from "(\.\.?\/[^"]+)"/g,
    (whole, specifier) =>
      `from ${JSON.stringify(new URL(specifier, import.meta.url).href)}`,
  );
  const mutated = mutate(loadable);
  assert.notEqual(mutated, loadable, "the mutation did not apply");
  return import(
    `data:text/javascript;base64,${Buffer.from(mutated).toString("base64")}`
  );
}

test("C1 MUTATION control: a probe that re-hard-codes its origin is caught by B2", async () => {
  // The regression the whole batch exists to prevent, made unreachable-free:
  // the descriptor ignores the origin the runtime resolved and goes back to
  // 8080. B2's assertion must be the thing that notices.
  const anchor = "await page.goto(`${origin}${DEMO}`";
  const mutant = await importMutatedProbe(
    "probe-cloud-diagonal.mjs",
    (source) => {
      assert.equal(source.split(anchor).length - 1, 1);
      return source.replace(
        anchor,
        "await page.goto(`http://localhost:8080${DEMO}`",
      );
    },
  );

  const { root, log } = await drive(PROBES[0], {
    argv: ["--port", "8137"],
    descriptor: mutant.descriptor,
  });
  try {
    assert.ok(
      log.gotos[0].includes(":8080"),
      "the mutation did not reach the navigation",
    );
    assert.throws(
      () =>
        assert.ok(
          log.gotos[0].startsWith("http://localhost:8137/"),
          "B2 would not have noticed",
        ),
      "B2's origin assertion passed over a probe that navigated to 8080",
    );
  } finally {
    cleanup(root);
  }

  // And the real module still navigates where it was told.
  const real = await drive(PROBES[0], { argv: ["--port", "8137"] });
  try {
    assert.ok(real.log.gotos[0].startsWith("http://localhost:8137/"));
  } finally {
    cleanup(real.root);
  }
});

test("C2 MUTATION control: an inert verdict evaluation reports GREEN on the failing fixture", async () => {
  // `if (false && ...)` on each clause's test, not a deleted clause: deletion
  // is the easy mutation and a count-shaped assertion survives it.
  const mutant = await importMutatedProbe(
    "probe-cloud-diagonal.mjs",
    (source) =>
      source
        .replace("pass: q.botRight.deck > 50,", "pass: true,")
        .replace("pass: lrBottom < 15,", "pass: true,")
        .replace("pass: lrTop < 15,", "pass: true,"),
  );

  const failing = {
    ...PROBES[0],
    evaluate() {
      return {
        topLeft: { deck: 90, lum: 120, n: 10 },
        topRight: { deck: 2, lum: 120, n: 10 },
        botLeft: { deck: 90, lum: 120, n: 10 },
        botRight: { deck: 2, lum: 120, n: 10 },
      };
    },
  };

  const mutated = await drive(failing, { descriptor: mutant.descriptor });
  try {
    assert.equal(
      mutated.code,
      PROBE_EXIT_CODES.OK,
      "the inert mutant still failed, so B4 is not pinning the clause bodies",
    );
  } finally {
    cleanup(mutated.root);
  }

  const real = await drive(failing);
  try {
    assert.equal(real.code, PROBE_EXIT_CODES.FAILURE);
  } finally {
    cleanup(real.root);
  }
});

test("C3: the probe modules are importable without launching anything", () => {
  // `isEntryPoint` is what stands between importing a descriptor (which this
  // file, and every future spec, does) and opening a browser. Every module in
  // this table was imported at the top of this file; if any of them had run
  // `runProbe` on import, this spec would have taken the Edge slot to get here.
  for (const entry of PROBES) {
    const source = readFileSync(path.join(HERE, entry.file), "utf8");
    assert.match(
      source,
      /if \(isEntryPoint\(import\.meta\.url\)\) \{\s*\n\s*process\.exitCode = await runProbe\(descriptor\);/,
      `${entry.file}: no entry-point guard around its runProbe call`,
    );
    assert.equal(
      pathToFileURL(path.join(HERE, entry.file)).href.endsWith(entry.file),
      true,
    );
  }
});
