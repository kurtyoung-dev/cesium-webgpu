// water-capture-manifest.mjs — the capture manifest a water probe emits beside its report.
//
// @purpose Adapter from the page records of probe-water-cells, probe-fft-ocean and probe-ssr-water (and a water-cells BEFORE report) to the page records lib/landing-capture-manifest.mjs builds a capture-seam manifest from, and the writer a probe's receipt calls: capture-manifest.json and its images beside the report, the builder's refusal and a throw both returned as violations and never as a lost run.
// @status ACTIVE
//
// WHY AN ADAPTER. `contact-sheet.mjs --manifest` reads a capture-seam manifest
// and only the landing probe wrote one. The builder is
// `landing-capture-manifest.mjs`'s and is imported here, not copied: it groups
// page records by `cell|renderer|page` (`groupArms`), pairs each page's AFTER
// capture with its BEFORE capture, validates the result with both validators
// and refuses to leave a manifest that fails them. This piece only reshapes
// each water probe's own records into the `{cell, rig, renderer, page, run,
// capture, notRun}` the builder reads.
//
// WHAT BECOMES AN ENTRY. Every page that names a registered rig. The entry id
// is `<cell>:<page>`:
//   - water-cells: `<cell>:<on|off|demo>`, rig the page's own (an ON rig, its
//     OFF twin, and cell 1f's Sandcastle 2 rig), both renderers.
//   - fft-ocean: `fft-ocean:<session id>`, rig the session's LAST staged rig
//     (the enabled-then-disabled session ends on the OFF rig), WebGPU; the
//     second capture of the temporal session is its own entry,
//     `fft-ocean:iso-on-t2`, on the same rig.
//   - ssr-water: `ssr-water:<label>`, one per matrix cell, WebGPU.
// A page that did not capture is an UNMEASURED cell carrying the page's own
// NOT RUN reason (the builder's rule), never a missing cell.
//
// EVERY CAPTURE CARRIES ITS SHA-256. A capture record without one is not
// handed to the builder as a measured capture: its page becomes NOT RUN naming
// the file, so a picture that cannot be checked against the run that recorded
// it is never shown as measured.
//
// BEFORE. Only water-cells has a base concept (`--base-report`, the BEFORE
// arm's report); its `pages` are the same records and are reshaped the same
// way. fft-ocean and ssr-water compare their cells with each other inside one
// run and take no base report, so their BEFORE cells read UNMEASURED ("no
// --base-report") and the report's verdicts stay the record of the
// within-run comparisons. The manifest carries no verdict of its own.
//
// THE MANIFEST'S AFTER IS THE INVOCATION. A water-cells `--arm before` run
// writes its own manifest with its pages in the AFTER slot, as every
// invocation's pages are; the arm is in the report beside it.

import path from "node:path";

import {
  runtimeReportFileName,
  writeLandingCaptureManifestOrViolations,
} from "./landing-capture-manifest.mjs";

/** The cell name the FFT ocean probe's pages carry. */
export const FFT_OCEAN_MANIFEST_CELL = "fft-ocean";

/** The cell name the SSR water probe's pages carry. */
export const SSR_WATER_MANIFEST_CELL = "ssr-water";

const WEBGPU = "webgpu";

/** How a water entry's description names its cell (the builder's default says landing). */
export const WATER_ENTRY_LABEL = "Water probe cell";

/**
 * One page's capture as the builder reads it: an absolute path, its digest
 * and, where the probe recorded them, the url and instant. Pure.
 *
 * @param {object|null|undefined} capture A probe's capture record.
 * @returns {{capture: object|null, missing: string|null}} `missing` names the
 *   reason a record that exists could not be handed over.
 */
function manifestCapture(capture) {
  if (!capture || typeof capture.path !== "string") {
    return { capture: null, missing: null };
  }
  const file = path.resolve(capture.path);
  if (typeof capture.sha256 !== "string" || capture.sha256.length === 0) {
    return {
      capture: null,
      missing: `the capture ${file} carries no sha256, so it cannot be checked against the run that recorded it`,
    };
  }
  return {
    capture: {
      path: file,
      sha256: capture.sha256,
      ...(typeof capture.url === "string" && { url: capture.url }),
      ...(typeof capture.capturedAt === "string" && {
        capturedAt: capture.capturedAt,
      }),
    },
    missing: null,
  };
}

function pageRecord({ cell, rig, renderer, page, run, capture, notRun }) {
  const shot = manifestCapture(capture);
  const reason = notRun || shot.missing;
  return {
    cell,
    rig,
    renderer,
    page,
    run: run ?? 0,
    ...(shot.capture && !reason && { capture: shot.capture }),
    ...(reason && { notRun: reason }),
  };
}

/**
 * The pages of a water-cells run (or of its BEFORE report). Pure.
 *
 * @param {object[]} records probe-water-cells' page records.
 * @returns {object[]}
 */
export function waterCellsManifestPages(records) {
  return (records ?? []).map((record) =>
    pageRecord({
      cell: record.cell,
      rig: record.rig,
      renderer: record.renderer,
      page: record.variant,
      run: record.run,
      capture: record.capture,
      notRun: record.notRun,
    }),
  );
}

/**
 * A water-cells BEFORE report in the shape the builder reads as its base: its
 * pages reshaped, its instant and origin kept. Pure.
 *
 * @param {object|null} report The parsed BEFORE report, or null.
 * @returns {object|null}
 */
export function waterCellsBaseReport(report) {
  if (!report) {
    return null;
  }
  return {
    generatedAt: report.generatedAt,
    ...(typeof report.origin === "string" && { origin: report.origin }),
    pages: waterCellsManifestPages(report.pages),
  };
}

/**
 * The pages of an FFT ocean run: one per session capture, and one more for the
 * temporal session's second capture. Pure.
 *
 * @param {object[]} sessions probe-fft-ocean's session records.
 * @returns {object[]}
 */
export function fftOceanManifestPages(sessions) {
  const pages = [];
  for (const session of sessions ?? []) {
    const rig = session.rigs?.[session.rigs.length - 1];
    const base = {
      cell: FFT_OCEAN_MANIFEST_CELL,
      rig,
      renderer: WEBGPU,
      run: session.run,
    };
    pages.push(
      pageRecord({ ...base, page: session.id, capture: session.capture }),
    );
    if (session.temporalCapture) {
      pages.push(
        pageRecord({
          ...base,
          page: `${session.id}-t2`,
          capture: session.temporalCapture,
        }),
      );
    }
  }
  return pages;
}

/**
 * The pages of an SSR water run: one per matrix cell. Pure.
 *
 * @param {object[]} cells probe-ssr-water's cell records.
 * @returns {object[]}
 */
export function ssrWaterManifestPages(cells) {
  return (cells ?? []).map((cell) =>
    pageRecord({
      cell: SSR_WATER_MANIFEST_CELL,
      rig: cell.rig,
      renderer: WEBGPU,
      page: cell.label,
      run: cell.run,
      capture: cell.capture,
    }),
  );
}

/**
 * Write the probe's manifest beside its report. A manifest the validators
 * refuse is not written and a throw from the builder (a page whose rig is not
 * registered) writes none either; in both cases a stale one is removed and the
 * answer is returned as violations, so the receipt can say why and the run is kept. Warns once on
 * stderr when nothing was written.
 *
 * @param {object} inputs Inputs.
 * @param {string} inputs.probe The probe descriptor's `name`.
 * @param {object[]} inputs.pages {@link waterCellsManifestPages} and kin.
 * @param {object|null} [inputs.baseReport] {@link waterCellsBaseReport}'s answer.
 * @param {Map<string, object>|null} inputs.rigsById The rigs the run staged.
 * @param {{options?: object, origin: string, outputDirectory: string,
 *   generatedAt: string}} inputs.context The runtime's receipt context.
 * @param {object} [inputs.fs] Injected I/O, as the builder's writer takes it.
 * @returns {{path: string|null, written: boolean, violations: string[],
 *   files: string[]}}
 */
export function writeWaterProbeManifest({
  probe,
  pages,
  baseReport = null,
  rigsById,
  context,
  fs,
}) {
  // The landing piece's throw-safe writer: a builder throw comes back as
  // violations and removes the stale manifest an earlier run left.
  const result = writeLandingCaptureManifestOrViolations({
    ...(fs && { fs }),
    pages,
    baseReport,
    rigsById: rigsById ?? new Map(),
    origins: { AFTER: context.origin },
    generatedAt: context.generatedAt,
    servedBuildAssertion:
      context.options?.servedBuild === false ? "waived" : "enforced",
    receipt: runtimeReportFileName(probe),
    outputDirectory: context.outputDirectory,
    entryLabel: WATER_ENTRY_LABEL,
  });
  if (!result.written) {
    console.warn(
      `[probe-${probe}] capture manifest refused: ${result.violations.slice(0, 3).join("; ")}`,
    );
  }
  return result;
}
