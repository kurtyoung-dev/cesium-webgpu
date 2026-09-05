// probe-globe-elevation-band-material.mjs — the acceptance instrument for AR-831 (row AR-833).
//
// @purpose Measures whether `globe.material = createElevationBandMaterial(...)` renders on WebGPU without a GPU validation fault, paints bands the WebGL capture also paints, and responds to moving band1Position.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// ── WHAT IT ANSWERS ─────────────────────────────────────────────────────────
//
// The four acceptance clauses of
// `NEW-WEBGPU-GLOBE-MATERIAL-TEXTURE-UNIFORM-ELEVATIONBAND`, each as a verdict:
//
//   1. NO VALIDATION FAULT. The WebGPU device raises zero `GPUValidationError`
//      while the ElevationBand globe material is bound. Read from the device's
//      own `uncapturederror` channel, not from console text, so a message the
//      engine chose not to print cannot hide the fault. The console is read
//      too, and any line naming an invalid shader module or render pipeline is
//      reported beside the typed count.
//
//   2. THE MATERIAL IS VISIBLE. With the material bound the canvas differs from
//      the same camera's capture with `globe.material` cleared. This is the
//      clause-2 statistic: a frame whose command buffer was discarded, or one
//      where both texture uniforms resolved to the 1x1 placeholder, produces a
//      capture identical to the cleared reference. WebGL runs the same pair, so
//      the claim is "WebGPU changes the picture the way WebGL does", not
//      "WebGPU changed the picture".
//
//   3. THE BAND MOVES. Two captures at two well-separated `band1Position`
//      values differ. This is the only clause that can distinguish a genuinely
//      sampled `heights`/`colors` texture from a placeholder view: the
//      placeholder does not change when the layer stack does.
//
//   4. THE SIBLING SHAPES STAY CLEAN. The single-texture canvas fabric
//      (`globe-materials-water-mask-elevation-map`'s shape) and the composite
//      fabric (`bathymetry`'s shape) are bound in the same run and must raise
//      no validation error either. They are constructed in the harness rather
//      than loaded from Sandcastle2 on purpose: AR-D20 records the built
//      Sandcastle2 app serving two gitignored `.d.ts` files as 404, which puts
//      an entry in every demo's `errors[]` and makes a sweep result unusable as
//      evidence. The FULL-SWEEP form of clause 4 remains blocked on AR-D20;
//      what is proven here is the two material shapes.
//
// ── EXPECTED BEHAVIOUR BEFORE AND AFTER AR-831 ──────────────────────────────
//
// Before: `Invalid ShaderModule "Globe material module ElevationBand"` →
// invalid pipeline → `CommandEncoder.finish()` fails, so verdict 1 is red and
// verdicts 2 and 3 read ~0 on WebGPU. After: all four green on both backends.
// The probe therefore exits non-zero on the pre-fix engine by construction.
//
// ── MULTI-METRIC ────────────────────────────────────────────────────────────
//
// Per (renderer, material) cell the receipt carries the typed validation-error
// count and their messages, the console lines matching the two invalid-object
// patterns, settle frames and command counts, the differing fraction against
// the cleared reference, the differing fraction across the band shift, and the
// saturated-hue fraction of each capture. Noise behaviour:
//
//   gpuValidationErrors  — deterministic. Any non-zero is a finding.
//   settle frames/cmds   — network-bound (terrain), expect run-to-run spread.
//   differingFraction    — stable for a fixed camera once tiles are loaded;
//                          the residual spread is terrain LOD, so the gates are
//                          set well clear of it rather than at a tight bound.
//   bandHueFraction      — corroborating only; it cannot tell a band at the
//                          right height from a globe-wide tint, which is why no
//                          verdict is defined over it.
//
// ── PRECONDITIONS ───────────────────────────────────────────────────────────
//
//   * `npx gulp build` has run, so `/Build/CesiumUnminified/` is current.
//   * `node server.js --port 8094 --serve-built` is running. Use `localhost`,
//     not `127.0.0.1` — the dev server binds IPv6.
//   * Edge, not Firefox: Playwright's bundled Firefox has no WebGPU.
//   * An ion token is configured, or terrain fails and there are no heights for
//     the bands to sit at; the probe refuses rather than measuring an ellipsoid.
//
// Run:
//   node Tools/visual-regression/probe-globe-elevation-band-material.mjs
//   node Tools/visual-regression/probe-globe-elevation-band-material.mjs --renderer webgpu
//   node Tools/visual-regression/probe-globe-elevation-band-material.mjs --headed

import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";

const HARNESS_PATH =
  "/Tools/visual-regression/globe-elevation-band-material-harness.html";

/** The demo's own band1Position, and a value far enough away to move the band. */
export const BAND1_REFERENCE = 7000.0;
export const BAND1_SHIFTED = 5200.0;

/** Console text that names an invalid WebGPU object created by this path. */
export const INVALID_OBJECT_PATTERNS = Object.freeze([
  'Invalid ShaderModule "Globe material module',
  'Invalid RenderPipeline "Globe terrain',
]);

/** The sibling material shapes clause 4 names, by harness kind. */
export const SIBLING_MATERIALS = Object.freeze([
  {
    kind: "elevation-ramp",
    clause: "globe-materials-water-mask-elevation-map",
  },
  { kind: "elevation-color-contour", clause: "bathymetry" },
]);

/**
 * The probe's assertion, as a pure function so it has a node runner home and an
 * inertness leg. Every gate is a statement about the picture or about the
 * device's error channel; none is a statement about engine source text.
 *
 * @param {object} cell One (renderer, run) cell's measurements.
 * @param {object} thresholds Gate thresholds.
 * @param {number} thresholds.materialVisible Minimum differing fraction against the cleared reference.
 * @param {number} thresholds.bandMoves Minimum differing fraction across the band shift.
 * @returns {Array<object>} One verdict per acceptance clause.
 */
export function decideElevationBandVerdicts(cell, thresholds) {
  const prefix = `${cell.renderer}/run${cell.run}`;
  const invalidObjectLines = cell.consoleErrors.filter((line) =>
    INVALID_OBJECT_PATTERNS.some((pattern) => line.includes(pattern)),
  );
  const verdicts = [
    {
      id: `${prefix}/clause1-no-validation-fault`,
      claim:
        "clause 1 — binding the ElevationBand globe material raises no GPU validation error",
      gpuValidationErrors: cell.band.gpuErrors.length,
      gpuValidationMessages: cell.band.gpuErrors.map((e) => e.message),
      invalidObjectLines,
      pass: cell.band.gpuErrors.length === 0 && invalidObjectLines.length === 0,
    },
    {
      id: `${prefix}/clause2-material-visible`,
      claim:
        "clause 2 — the bound material changes the canvas against the cleared reference",
      differingFraction: cell.materialVisible.differingFraction,
      threshold: thresholds.materialVisible,
      pass:
        cell.materialVisible.differingFraction >= thresholds.materialVisible,
    },
    {
      id: `${prefix}/clause3-band-moves`,
      claim:
        "clause 3 — moving band1Position moves the band, so the Texture uniforms are genuinely sampled",
      differingFraction: cell.bandMoves.differingFraction,
      threshold: thresholds.bandMoves,
      pass: cell.bandMoves.differingFraction >= thresholds.bandMoves,
    },
  ];
  for (const sibling of cell.siblings) {
    verdicts.push({
      id: `${prefix}/clause4-${sibling.kind}`,
      claim: `clause 4 — the ${sibling.clause} material shape raises no GPU validation error`,
      gpuValidationErrors: sibling.gpuErrors.length,
      gpuValidationMessages: sibling.gpuErrors.map((e) => e.message),
      pass: sibling.gpuErrors.length === 0,
    });
  }
  return verdicts;
}

/**
 * Binds one material, settles, captures, and reports what the device said.
 *
 * @param {object} options Inputs.
 * @param {object} options.page The Playwright page.
 * @param {object} options.apply Argument for the harness `__applyMaterial`.
 * @param {string} options.name Capture name.
 * @param {string} options.outputDirectory Where captures are written.
 * @param {Array<object>} options.captures Runtime capture sink.
 * @returns {Promise<object>} The measurement.
 */
async function bindAndCapture({
  page,
  apply,
  name,
  outputDirectory,
  captures,
}) {
  await page.evaluate(() => window.__resetValidation());
  const applied = await page.evaluate((a) => window.__applyMaterial(a), apply);
  if (!applied.ok) {
    throw new ProbeRefusal("material-apply-failed", applied.error, { apply });
  }
  const settled = await page.evaluate((a) => window.__settle(a), {
    budgetMs: 60000,
    minFrames: 40,
  });
  const capture = await captureElement({
    page,
    selector: "canvas",
    index: 0,
    name,
    outputDirectory,
    captures,
  });
  const base64 = capture.buffer.toString("base64");
  const hue = await page.evaluate((b) => window.__bandHueFraction(b), base64);
  const validation = await page.evaluate(() => window.__validation());
  return {
    apply,
    applied,
    settled,
    base64,
    capture: { name, sha256: capture.sha256 },
    hue,
    gpuErrors: validation.gpuErrors,
    pageErrors: validation.pageErrors,
  };
}

/**
 * One backend's whole measurement, in its own browser context.
 *
 * @param {object} options Inputs.
 * @param {object} options.browser The Playwright browser.
 * @param {string} options.harness Absolute harness url for this run's origin.
 * @param {string} options.renderer The backend.
 * @param {number} options.run The repeat index.
 * @param {string} options.outputDirectory Where captures are written.
 * @param {Array<object>} options.captures Runtime capture sink.
 * @returns {Promise<object>} The cell.
 */
async function runCell({
  browser,
  harness,
  renderer,
  run,
  outputDirectory,
  captures,
}) {
  const context = await browser.newContext({
    viewport: { width: 1024, height: 640 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleErrors.push(`[${message.type()}] ${message.text()}`);
    }
  });
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));

  try {
    await page.goto(harness, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => window.Cesium !== undefined, null, {
      timeout: 60000,
    });

    const built = await page.evaluate((a) => window.__build(a), {
      renderer,
      terrain: true,
    });
    if (!built.ok) {
      throw new ProbeRefusal(
        "harness-build-failed",
        `build failed for ${renderer}: ${built.error}`,
        { renderer, error: built.error },
      );
    }
    if (!built.hasCreateElevationBandMaterial) {
      throw new ProbeRefusal(
        "factory-absent",
        "the served bundle does not export createElevationBandMaterial — rebuild before running this probe",
        { renderer },
      );
    }
    if (!built.terrainReady) {
      throw new ProbeRefusal(
        "terrain-not-resolved",
        "terrain did not resolve — the bands would have no heights to sit at",
        { renderer },
      );
    }
    if (renderer === "webgpu" && !built.deviceErrorSink) {
      throw new ProbeRefusal(
        "device-error-sink-absent",
        "no GPUDevice was reachable to attach an uncapturederror listener, so clause 1 could not be measured",
        { renderer },
      );
    }

    await page.evaluate(() => window.__stripWidgets());
    await page.evaluate(() => window.__setDemoView());

    // Reference: the same camera with no globe material at all.
    const cleared = await bindAndCapture({
      page,
      apply: { kind: "none" },
      name: `${renderer}-run${run}-cleared`,
      outputDirectory,
      captures,
    });
    const band = await bindAndCapture({
      page,
      apply: { kind: "elevation-band", band1Position: BAND1_REFERENCE },
      name: `${renderer}-run${run}-band-${BAND1_REFERENCE}`,
      outputDirectory,
      captures,
    });
    const shifted = await bindAndCapture({
      page,
      apply: { kind: "elevation-band", band1Position: BAND1_SHIFTED },
      name: `${renderer}-run${run}-band-${BAND1_SHIFTED}`,
      outputDirectory,
      captures,
    });

    const materialVisible = await page.evaluate(
      (a) => window.__differingFraction(a),
      { a: cleared.base64, b: band.base64 },
    );
    const bandMoves = await page.evaluate(
      (a) => window.__differingFraction(a),
      { a: band.base64, b: shifted.base64 },
    );

    const siblings = [];
    for (const sibling of SIBLING_MATERIALS) {
      const measured = await bindAndCapture({
        page,
        apply: { kind: sibling.kind },
        name: `${renderer}-run${run}-${sibling.kind}`,
        outputDirectory,
        captures,
      });
      siblings.push({
        kind: sibling.kind,
        clause: sibling.clause,
        settled: measured.settled,
        capture: measured.capture,
        hue: measured.hue,
        gpuErrors: measured.gpuErrors,
      });
    }

    process.stdout.write(
      `${renderer}/run${run}: gpuErrors(band)=${band.gpuErrors.length} ` +
        `materialVisible=${materialVisible.differingFraction} ` +
        `bandMoves=${bandMoves.differingFraction} ` +
        `bandHue=${band.hue.bandHueFraction} ` +
        `frames=${band.settled.frames} cmds=${band.settled.commands}\n`,
    );

    return {
      renderer,
      run,
      built,
      cleared: strip(cleared),
      band: strip(band),
      shifted: strip(shifted),
      materialVisible,
      bandMoves,
      siblings,
      consoleErrors,
      pageErrors,
    };
  } finally {
    await context.close();
  }
}

/**
 * Drops the base64 capture bytes from a measurement before it enters the
 * receipt — the PNGs are already banked beside it by the runtime.
 *
 * @param {object} measurement One `bindAndCapture` result.
 * @returns {object} The receipt-safe measurement.
 */
function strip(measurement) {
  // Deliberate rest-destructuring omit, not a dropped consumer: every reader of
  // the capture bytes runs BEFORE this — `bindAndCapture` derives `hue` from
  // them, and `runCell` feeds the three ElevationBand captures to
  // `__differingFraction` for clauses 2 and 3 — while the PNGs themselves are
  // banked by the runtime and identified in the receipt by `capture.sha256`.
  // Keeping ~1 MB of base64 per capture in the JSON would bloat the receipt
  // without adding evidence.
  const { base64: _base64, ...rest } = measurement;
  return rest;
}

/**
 * The console report.
 *
 * @param {object} receipt The probe receipt.
 * @returns {void}
 */
function printReport(receipt) {
  console.log("\n── ElevationBand globe material ──");
  for (const verdict of receipt.verdicts) {
    const detail =
      verdict.differingFraction !== undefined
        ? `differingFraction=${verdict.differingFraction} threshold=${verdict.threshold}`
        : `gpuValidationErrors=${verdict.gpuValidationErrors}`;
    console.log(`${verdict.pass ? "PASS" : "FAIL"} ${verdict.id} ${detail}`);
    for (const message of verdict.gpuValidationMessages ?? []) {
      console.log(`      ${message}`);
    }
    for (const line of verdict.invalidObjectLines ?? []) {
      console.log(`      ${line}`);
    }
  }
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "globe-elevation-band-material",
  title: "Globe ElevationBand material — AR-831 acceptance (AR-833)",
  outputSubdirectory: "globe-elevation-band-material",
  receiptEnvelope: "probe-owned",
  args: {
    extraOptions: [
      {
        // A fraction. The band stack tints a large part of the terrain, so the
        // material-visible floor sits well above terrain-LOD noise.
        flag: "--material-visible-floor",
        key: "materialVisibleFloor",
        kind: "non-negative-number",
        default: 0.02,
      },
      {
        // Moving one of three bands by 1800 m repaints a narrower area than the
        // material as a whole, so this floor is lower — but still far above the
        // zero a placeholder view produces.
        flag: "--band-moves-floor",
        key: "bandMovesFloor",
        kind: "non-negative-number",
        default: 0.002,
      },
    ],
  },
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    const harness = `${origin}${HARNESS_PATH}`;
    const produced = [];
    for (const renderer of options.renderers) {
      produced.push(
        await runCell({
          browser,
          harness,
          renderer,
          run,
          outputDirectory,
          captures,
        }),
      );
    }
    return produced;
  },
  verdicts(cells, { options }) {
    const thresholds = {
      materialVisible: options.materialVisibleFloor,
      bandMoves: options.bandMovesFloor,
    };
    return cells.flatMap((cell) =>
      decideElevationBandVerdicts(cell, thresholds),
    );
  },
  receipt(cells, context) {
    const receipt = {
      generatedAt: context.generatedAt,
      harness: `${context.origin}${HARNESS_PATH}`,
      runs: context.options?.runs ?? null,
      band1Reference: BAND1_REFERENCE,
      band1Shifted: BAND1_SHIFTED,
      thresholds: {
        materialVisible: context.options?.materialVisibleFloor ?? null,
        bandMoves: context.options?.bandMovesFloor ?? null,
      },
      cellOrder: cells.map((c) => `${c.renderer}/run${c.run}`),
      verdicts: context.verdicts,
      cells,
    };
    if (cells.length > 0) {
      printReport(receipt);
    }
    return receipt;
  },
  summary(receipt) {
    const passed = receipt.verdicts.filter((v) => v.pass === true).length;
    return [
      "# Globe ElevationBand material",
      "",
      `Generated: ${receipt.generatedAt}`,
      "",
      `Harness: \`${receipt.harness}\``,
      "",
      `Verdicts: ${passed}/${receipt.verdicts.length} passed.`,
      "",
      "Clause 4's full-Sandcastle2-sweep form remains blocked on AR-D20; the",
      "two sibling material shapes are proven here instead.",
      "",
    ].join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
