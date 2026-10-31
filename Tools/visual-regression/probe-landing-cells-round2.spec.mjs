// Lane TAR-ALDARION (probe-kit round 2): the landing probe's wiring of the
// pieces Batch 1628's own Edge legs showed were owed - the evolved-epoch
// readback (kit receipt finding 3), the sentinel's positive control (kit
// receipt, non-finding note), the ocean compute pass in PF-2 (kit-PF receipt
// finding 1) and the capture-seam manifest (DX-KIT-CONTACT-SHEET-MANIFEST).
// Each behaviour is asserted by running the real descriptor over the fake
// browser, and each has an inertness mutant that makes the wiring unreachable.
//
// @purpose Node spec for probe-landing-cells.mjs round-2 wiring: evolved readback, --sentinel-positive-control, the E-FFT-ifft perf-pass verdict and the capture manifest, with inertness mutants.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { validateManifest } from "./lib/capture.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import {
  LANDING_CELLS,
  OCEAN_COMPUTE_PASS_LABEL,
} from "./lib/landing-cell-table.mjs";
import { makeFakeBrowser } from "./lib/landing-fake-browser.mjs";
import {
  landingVerdicts,
  perfPassTiming,
  positiveControlCoverage,
} from "./lib/landing-verdicts.mjs";
import { OCEAN_EVOLVED_ADVANCE_SECONDS } from "./lib/ocean-displacement-readback.mjs";
import { PROBE_EXIT_CODES, runProbe } from "./lib/probe-runtime.mjs";
import { descriptor } from "./probe-landing-cells.mjs";

const PROBE_MODULE = fileURLToPath(
  new URL("./probe-landing-cells.mjs", import.meta.url),
);
const VERDICTS_MODULE = fileURLToPath(
  new URL("./lib/landing-verdicts.mjs", import.meta.url),
);
const ENGINE_OCEAN = fileURLToPath(
  new URL(
    "../../packages/engine/Source/Renderer/WebGPU/WebGPUOceanRenderer.ts",
    import.meta.url,
  ),
);

function newLog() {
  return {
    events: [],
    scripts: [],
    urls: [],
    selectors: [],
    contexts: [],
    waits: [],
    sentinelReads: [],
    readbacks: [],
    evolvedReadbacks: [],
    clockSets: [],
    controls: [],
  };
}

async function run(args, fakeOptions = {}, probe = descriptor) {
  return withLaneTmp("landing-round2-", async (dir) => {
    const out = path.join(dir, "out");
    const log = newLog();
    const code = await runProbe(probe, {
      argv: [
        "--repository-root",
        dir,
        "--output",
        out,
        "--runs",
        "1",
        "--no-serve-built",
        ...args,
      ],
      launch: async () => makeFakeBrowser(log, fakeOptions),
      preflight: async () => ({ ok: true, records: [] }),
    });
    const reportPath = path.join(out, "landing-cells-report.json");
    const report = fs.existsSync(reportPath)
      ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
      : null;
    const manifestPath = path.join(out, "capture-manifest.json");
    const manifest = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      : null;
    const refusalPath = fs.existsSync(out)
      ? fs.readdirSync(out).find((name) => name.includes("refusal"))
      : undefined;
    const refusal = refusalPath
      ? JSON.parse(fs.readFileSync(path.join(out, refusalPath), "utf8"))
      : null;
    const verdicts = report?.verdicts ?? report?.runtime?.verdicts ?? [];
    return { code, report, manifest, refusal, log, verdicts };
  });
}

const byId = (verdicts, id) => verdicts.find((v) => v.id === id);

function readback(kernel, hash, overrides = {}) {
  return {
    available: true,
    accessor: "primitive._webgpuCache.displacementTexture",
    format: "rgba16float",
    width: 4,
    height: 4,
    sampleCount: 64,
    hash,
    min: -1,
    max: 1,
    mean: 0,
    nonFinite: 0,
    nonZero: 60,
    kernel,
    frameNumber: 12,
    simulationSeconds: 0,
    computePipelinesReady: true,
    ...overrides,
  };
}

const T0 = () => ({
  displacements: [readback("stockham", "aa"), readback("pingpong", "aa")],
});

// ---------------------------------------------------------------------------
// R2-1 evolved-epoch readback (DX-KIT-FFT-IDENTITY-EVOLVED-EPOCH)
// ---------------------------------------------------------------------------

test("R2-1: E-FFT-ifft reads each kernel again at the rig clock + the advance, restores the clock, and judges the evolved fields", async () => {
  assert.equal(
    LANDING_CELLS["E-FFT-ifft"].evolvedReadbackSeconds,
    OCEAN_EVOLVED_ADVANCE_SECONDS,
  );
  const r = await run(["--cells", "E-FFT-ifft", "--no-cell-perf"], T0());
  assert.equal(r.code, PROBE_EXIT_CODES.OK);
  assert.equal(r.log.evolvedReadbacks.length, 2, "one evolved read per kernel");
  assert.equal(r.log.evolvedReadbacks[0].includeValues, true);
  // Per page: away to the evolved instant, then back to the rig's clock.
  assert.deepEqual(r.log.clockSets, [
    "2026-06-21T16:00:30.000Z",
    "2026-06-21T16:00:00Z",
    "2026-06-21T16:00:30.000Z",
    "2026-06-21T16:00:00Z",
  ]);
  for (const page of r.report.pages) {
    assert.equal(page.displacementEvolved.available, true, page.page);
    assert.equal(page.displacementEvolved.advanceSeconds, 30);
    assert.equal("values" in page.displacementEvolved, false);
  }
  const evolved = byId(
    r.verdicts,
    "E-FFT-ifft:webgpu:run0:ifft-kernel-identity-evolved",
  );
  assert.equal(evolved?.pass, true);
  assert.equal(
    byId(r.verdicts, "E-FFT-ifft:webgpu:run0:ifft-kernel-identity")?.pass,
    true,
    "the t = 0 verdict stays beside it",
  );
});

test("R2-1: evolved fields that differ between the kernels fail; a sea that did not evolve is NOT RUN", async () => {
  const differ = await run(["--cells", "E-FFT-ifft", "--no-cell-perf"], {
    ...T0(),
    evolvedDisplacements: [
      readback("stockham", "e1", { simulationSeconds: 30 }),
      readback("pingpong", "e2", { simulationSeconds: 30 }),
    ],
  });
  const failed = byId(
    differ.verdicts,
    "E-FFT-ifft:webgpu:run0:ifft-kernel-identity-evolved",
  );
  assert.equal(failed.pass, false);
  assert.notEqual(failed.notRun, true);
  assert.notEqual(differ.code, PROBE_EXIT_CODES.OK);

  const frozen = await run(["--cells", "E-FFT-ifft", "--no-cell-perf"], {
    ...T0(),
    evolvedDisplacements: [
      readback("stockham", "aa", { simulationSeconds: 30 }),
      readback("pingpong", "aa", { simulationSeconds: 30 }),
    ],
  });
  const notRun = byId(
    frozen.verdicts,
    "E-FFT-ifft:webgpu:run0:ifft-kernel-identity-evolved",
  );
  assert.equal(notRun.pass, false);
  assert.equal(notRun.notRun, true);
});

test("R2-1 (mutant): the evolved read made unreachable loses the evolved verdict", async () => {
  const mutated = await importMutated(PROBE_MODULE, [
    [
      "if (cell.evolvedReadbackSeconds > 0) {",
      "if (false && cell.evolvedReadbackSeconds > 0) {",
    ],
  ]);
  const r = await run(
    ["--cells", "E-FFT-ifft", "--no-cell-perf"],
    T0(),
    mutated.descriptor,
  );
  assert.equal(r.log.evolvedReadbacks.length, 0);
  assert.equal(
    r.verdicts.some((v) => v.id.endsWith(":ifft-kernel-identity-evolved")),
    false,
  );
});

// ---------------------------------------------------------------------------
// R2-2 --sentinel-positive-control (DX-KIT-SENTINEL-POSITIVE-CONTROL)
// ---------------------------------------------------------------------------

test("R2-2: the switch runs the control on the first identity page of the run, last, and its verdict passes", async () => {
  const r = await run(["--cells", "E-D", "--sentinel-positive-control"]);
  assert.equal(r.code, PROBE_EXIT_CODES.OK);
  assert.equal(r.log.controls.length, 1, "one control page per run");
  const control = byId(
    r.verdicts,
    "E-D:webgl:scene:run0:onmessage-positive-control",
  );
  assert.equal(control?.pass, true);
  // The real reading of that page still passes: the control ran after it.
  assert.equal(
    byId(r.verdicts, "E-D:webgl:scene:run0:onmessage-unchanged")?.pass,
    true,
  );
  assert.equal(
    byId(r.verdicts, "E-D:webgpu:scene:run0:onmessage-positive-control"),
    undefined,
  );
  assert.equal(
    r.verdicts.some((v) => v.id.startsWith("onmessage-positive-control:run")),
    false,
  );
});

test("R2-2: without the switch no control runs; a dead sentinel fails the control", async () => {
  const off = await run(["--cells", "E-D"]);
  assert.equal(off.log.controls.length, 0);
  assert.equal(
    off.verdicts.some((v) => v.id.endsWith(":onmessage-positive-control")),
    false,
  );
  const dead = await run(["--cells", "E-D", "--sentinel-positive-control"], {
    controlRecord: {
      installed: true,
      before: null,
      after: null,
      changed: false,
      assignments: 0,
      stacks: [],
    },
  });
  assert.equal(
    byId(dead.verdicts, "E-D:webgl:scene:run0:onmessage-positive-control")
      ?.pass,
    false,
  );
  assert.notEqual(dead.code, PROBE_EXIT_CODES.OK);
});

test("R2-2: the switch without an identity cell is refused before the first page", async () => {
  const r = await run(["--cells", "E-O", "--sentinel-positive-control"]);
  assert.notEqual(r.code, PROBE_EXIT_CODES.OK);
  assert.equal(r.log.contexts.length, 0, "no page was opened");
  assert.match(
    JSON.stringify(r.refusal ?? r.report ?? {}),
    /sentinel-control-no-identity-cell/,
  );
});

test("R2-2 (mutants): the control page never chosen, and the control verdict made unreachable, each lose the check", async () => {
  const neverChosen = await importMutated(PROBE_MODULE, [
    [
      "positiveControl: index === controlIndex,",
      "positiveControl: false && index === controlIndex,",
    ],
  ]);
  const r = await run(
    ["--cells", "E-D", "--sentinel-positive-control"],
    {},
    neverChosen.descriptor,
  );
  assert.equal(r.log.controls.length, 0);
  // The coverage verdict catches the lost control: NOT RUN, so the run fails.
  const coverage = byId(r.verdicts, "onmessage-positive-control:run0");
  assert.equal(coverage?.notRun, true);
  assert.notEqual(r.code, PROBE_EXIT_CODES.OK);

  const record = {
    run: 0,
    cell: "E-D",
    renderer: "webgl",
    page: "scene",
    notRun: null,
    onmessageControl: {
      installed: true,
      changed: false,
      after: null,
      assignments: 0,
    },
  };
  const real = landingVerdicts([record], null);
  assert.equal(
    real.find((v) => v.id.endsWith(":onmessage-positive-control"))?.pass,
    false,
  );
  const mutated = await importMutated(VERDICTS_MODULE, [
    [
      "if (record.onmessageControl !== undefined) {",
      "if (false && record.onmessageControl !== undefined) {",
    ],
  ]);
  assert.equal(
    mutated
      .landingVerdicts([record], null)
      .some((v) => v.id.endsWith(":onmessage-positive-control")),
    false,
  );
  // Coverage: real flags a run without a control; the mutant does not.
  assert.equal(positiveControlCoverage([{ run: 0 }], true).length, 1);
  assert.equal(positiveControlCoverage([{ run: 0 }], false).length, 0);
  const noCoverage = await importMutated(VERDICTS_MODULE, [
    ["if (enabled !== true) {", "if (true || enabled !== true) {"],
  ]);
  assert.equal(
    noCoverage.positiveControlCoverage([{ run: 0 }], true).length,
    0,
  );
});

// ---------------------------------------------------------------------------
// R2-3 the ocean compute pass in PF-2 (DX-OCEAN-COMPUTE-PASS-TIMESTAMP)
// ---------------------------------------------------------------------------

test("R2-3: the cell's pass label is the engine's ocean compute-pass label", () => {
  assert.equal(LANDING_CELLS["E-FFT-ifft"].perfPass, OCEAN_COMPUTE_PASS_LABEL);
  const source = fs.readFileSync(ENGINE_OCEAN, "utf8");
  const declared = source.match(
    /OCEAN_COMPUTE_PASS_DESCRIPTOR[^=]*=\s*Object\.freeze\(\{\s*label:\s*"([^"]+)"/,
  );
  assert.ok(declared, "the engine declares the ocean pass descriptor");
  assert.equal(declared[1], OCEAN_COMPUTE_PASS_LABEL);
});

function passCost(names) {
  return {
    enabled: true,
    frameAvgMs: 38,
    frameCount: 68,
    passes: Object.fromEntries(
      names.map((name, i) => [name, { avgMs: 0.5 + i, lastMs: 0.5 }]),
    ),
  };
}

test("R2-3: E-FFT-ifft's PF-2 window must list the ocean pass: present passes, absent fails, no profiler is reported and not judged", async () => {
  const listed = await run(["--cells", "E-FFT-ifft"], {
    ...T0(),
    passCost: passCost([OCEAN_COMPUTE_PASS_LABEL, "Scene Framebuffer"]),
  });
  for (const page of ["stockham", "pingpong"]) {
    const v = byId(
      listed.verdicts,
      `E-FFT-ifft:webgpu:${page}:run0:perf-pass-timed`,
    );
    assert.equal(v?.pass, true, page);
    assert.equal(v.avgMs, 0.5);
  }
  assert.equal(listed.report.perfPassTimings.length, 2);
  assert.equal(listed.report.perfPassTimings[0].timed, true);

  const missing = await run(["--cells", "E-FFT-ifft"], {
    ...T0(),
    passCost: passCost(["Scene Framebuffer"]),
  });
  assert.equal(
    byId(missing.verdicts, "E-FFT-ifft:webgpu:stockham:run0:perf-pass-timed")
      ?.pass,
    false,
  );

  const none = await run(["--cells", "E-FFT-ifft"], T0());
  assert.equal(
    none.verdicts.some((v) => v.id.endsWith(":perf-pass-timed")),
    false,
  );
  assert.equal(none.report.perfPassTimings[0].available, false);

  const skipped = await run(["--cells", "E-FFT-ifft", "--no-cell-perf"], T0());
  assert.deepEqual(skipped.report.perfPassTimings, []);
});

test("R2-3 (mutant): the perf-pass verdict made unreachable lets a missing pass through", async () => {
  const record = {
    run: 0,
    cell: "E-FFT-ifft",
    renderer: "webgpu",
    page: "stockham",
    notRun: null,
    gate: { deviceLost: null },
    perf: { passCost: passCost(["Scene Framebuffer"]) },
  };
  assert.equal(perfPassTiming(record).timed, false);
  const real = landingVerdicts([record], null);
  assert.equal(
    real.find((v) => v.id.endsWith(":perf-pass-timed"))?.pass,
    false,
  );
  const mutated = await importMutated(VERDICTS_MODULE, [
    [
      "if (timed?.available === true) {",
      "if (false && timed?.available === true) {",
    ],
  ]);
  assert.equal(
    mutated
      .landingVerdicts([record], null)
      .some((v) => v.id.endsWith(":perf-pass-timed")),
    false,
  );
});

// ---------------------------------------------------------------------------
// R2-4 the capture-seam manifest (DX-KIT-CONTACT-SHEET-MANIFEST)
// ---------------------------------------------------------------------------

test("R2-4: a landing run writes a valid capture manifest beside its report, and the captures record url and capturedAt", async () => {
  const r = await run(["--cells", "E-D"]);
  assert.equal(r.code, PROBE_EXIT_CODES.OK);
  assert.ok(r.manifest, "capture-manifest.json written");
  assert.deepEqual(validateManifest(r.manifest), []);
  assert.equal(r.report.captureManifest.written, true);
  assert.deepEqual(r.report.captureManifest.violations, []);
  const [entry] = r.manifest.rigs;
  assert.equal(entry.cells.webgl.AFTER.state, "MEASURED");
  assert.equal(entry.cells.webgl.BEFORE.state, "UNMEASURED");
  for (const page of r.report.pages) {
    assert.match(page.capture.url, /^http/);
    assert.match(page.capture.capturedAt, /^\d{4}-\d\d-\d\dT/);
  }
});

test("R2-4 (mutant): the manifest writer made unreachable writes no manifest", async () => {
  const mutated = await importMutated(PROBE_MODULE, [
    ["? landingManifestOrError({", "? false && landingManifestOrError({"],
  ]);
  const r = await run(["--cells", "E-D"], {}, mutated.descriptor);
  assert.equal(r.manifest, null);
});
