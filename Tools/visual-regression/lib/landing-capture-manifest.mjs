/**
 * The capture manifest a landing run emits beside its report, so the contact sheet can show the run.
 * @purpose Pure builder from a probe-landing-cells run's page records (plus an optional base report) to a capture-seam manifest that lib/capture.mjs validates and contact-sheet.mjs reads, and the Node writer that puts capture-manifest.json and its images beside landing-cells-report.json, refusing to leave a manifest that fails validation.
 * @status ACTIVE
 *
 * WHY A PIECE, AND WHY THE CAPTURE SEAM'S SHAPE. `probe-landing-cells.mjs`
 * banks one PNG per (cell, renderer, page) and a JSON report; `contact-sheet.mjs`
 * turns a `capture-manifest.json` into a sheet a person can look at. Nothing
 * joined them, so the landing evidence had no sheet. This emits the manifest
 * and does not redesign it: the vocabulary, the cell and pair records and the
 * validators are `lib/capture.mjs`'s (`buildCaptureManifest`, `cellMetrics`,
 * `pairMetrics`, `validateManifest`), and the sheet's own validator is run
 * too, because the sheet is the reader that matters and the two disagree on
 * small points (the sheet requires every manifest renderer in every rig).
 *
 * ONE ARM PER INVOCATION. A landing invocation serves one tree. The pages it
 * ran are AFTER; the base report's pages (`--base-report`) are BEFORE. With no
 * base report every BEFORE cell is UNMEASURED ("no --base-report") and every
 * pair follows it. The manifest carries NO verdict: the pixel band and the PF
 * verdicts stay in the report, and an UNMEASURED pair says so and points there.
 *
 * ONE RIG ENTRY PER (cell, page). A variant page (E-FFT-ifft's kernels) is its
 * own entry, staged from `rigForPage` so its replay key is its own. Each entry
 * carries a cell for every renderer the run covered; a renderer the cell did
 * not run is an UNMEASURED cell saying so (the sheet requires the shape).
 *
 * THE CAPTURE USED IS THE ARM'S FIRST. Both slots read `groupArms`'s
 * `captures[0]`, the first run of the arm that took a capture, which is the
 * run-0 capture whenever run 0 took one and is the one the report's pixel
 * comparison reads, so the sheet and the band show the same two images. A run
 * that did not take a capture because it was NOT RUN is an UNMEASURED cell
 * with the stage's reason, never a missing cell.
 *
 * A BASE IMAGE IS CHECKED AGAINST THE SHA-256 THE REPORT RECORDS. A base
 * capture lives in ANOTHER output directory by an absolute path, and that file
 * can have been moved, deleted or overwritten since the base run. A missing
 * file or a different digest makes that slot an UNMEASURED cell with the
 * reason, because showing the wrong picture under BEFORE is worse than showing
 * none; a BEFORE record that carries no sha256 at all has nothing to check the
 * file against, so it is UNMEASURED too and the file is never copied unchecked.
 * An AFTER record is this invocation's own and always carries its digest
 * (`probe-landing-cells.mjs` records `shot.sha256`); one that lacks it is
 * decoded without a digest check. The BEFORE image is copied (bytes read, checked, written) beside the
 * manifest as `manifest-images/<id>/<renderer>/BEFORE.png`; the AFTER image is
 * referenced where it already is when that is inside the output directory, and
 * copied the same way when it is not.
 *
 * ORIGINS ARE NOT DEFAULTED, BUT BEFORE'S CAN BE A STATED PLACEHOLDER. The
 * capture seam's rule is that origins are "required, verbatim, never defaulted"
 * (`lib/capture.mjs` section 3), because a capture that guesses where it
 * looked is evidence of nothing. A landing invocation serves ONE tree and has
 * no BEFORE server: without `--base-report` there is no BEFORE origin to give,
 * and with a base report from before reports recorded theirs there is none to
 * read, yet the manifest validators require a non-empty string in the slot.
 * This piece therefore deviates from that rule on BEFORE alone, with a
 * placeholder that says which case it is ({@link NO_BASE_REPORT_ORIGIN} or
 * {@link UNRECORDED_ORIGIN}). Neither is ever a real origin, neither is
 * an http(s) address, and every BEFORE cell it sits behind is UNMEASURED or
 * carries a base capture whose own url names where it was fetched. AFTER's
 * origin is the caller's, verbatim, and is never defaulted.
 *
 * OLD BASE RECORDS HAVE NO `url` OR `capturedAt`. The validator requires both
 * on a MEASURED cell, and reports written before the landing probe recorded
 * them carry neither. The cell then takes a stated stand-in (the origin and the
 * rig's page, with no query string; the report's `generatedAt`) and names the
 * fields it substituted in an extra `fallbackFields` array. Neither validator
 * rejects an extra cell key and the sheet does not render it; it exists so the
 * manifest says which values are real.
 *
 * PURE BUILDER, NODE WRITER. {@link buildLandingCaptureManifest} touches no
 * filesystem and no clock: it is handed `readBytes(absolutePath)` and the
 * instant. {@link writeLandingCaptureManifest} owns the I/O (injectable, as
 * `contact-sheet.mjs` takes its dependencies) and REFUSES to write a manifest
 * that does not validate: it removes any manifest left in the directory by an
 * earlier run, so a stale one is never mistaken for this run's, and returns the
 * violations. Images are written before the manifest, so a manifest on disk
 * never names a file that is not there.
 *
 * @module Tools/visual-regression/lib/landing-capture-manifest
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  CAPTURE_RENDERERS,
  CAPTURE_SLOTS,
  CELL_STATES,
  buildCaptureManifest,
  cellMetrics,
  pairMetrics,
  validateManifest as validateCaptureManifest,
} from "./capture.mjs";
import { validateManifest as validateSheetManifest } from "./contact-sheet-page.mjs";
import { rigForPage } from "./landing-cell-table.mjs";
import { groupArms } from "./metrics/merge-landing-reports.mjs";
import { PIXEL_PAIR_TOLERANCE } from "./metrics/landing-pixel-band.mjs";
import { reportFileNameFor } from "./probe-runtime-receipts.mjs";
import { replayKeyFor } from "./rig-registry.mjs";
import { decodePng } from "../../lib/png-decode.mjs";
import { encodeRgbaPng } from "../../lib/png-rgba.mjs";

/** The manifest's file name; the contact sheet CLI is pointed at it. */
export const LANDING_MANIFEST_FILE = "capture-manifest.json";

/** Directory beside the manifest that holds the images this piece writes. */
export const LANDING_MANIFEST_IMAGE_DIR = "manifest-images";

/**
 * The report file the runtime writes for a probe named `probeName`, asked of
 * the runtime's own `reportFileNameFor` so the name has one spelling. The
 * manifest's `receipt` names it; the probe never writes it (the
 * runtime-residency contract's own-receipt-writer scan, DX-02).
 *
 * @param {string} probeName The probe descriptor's `name`.
 * @returns {string}
 */
export function runtimeReportFileName(probeName) {
  return reportFileNameFor({ name: probeName });
}

/** What BEFORE says when the invocation had no base report. */
export const NO_BASE_REPORT_REASON = "no --base-report";

/** The BEFORE origin recorded when the invocation had no base report at all. */
export const NO_BASE_REPORT_ORIGIN = NO_BASE_REPORT_REASON;

/** The BEFORE origin recorded when a base report was given but carries no origin. */
export const UNRECORDED_ORIGIN =
  "unrecorded (the base report carries no origin)";

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

const slugOf = (text) =>
  String(text)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

const posix = (value) => String(value).split("\\").join("/");

const shortSha = (value) => String(value).slice(0, 12);

/** An ISO instant with milliseconds, or null when `value` is not a date. */
function isoOrNull(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function unmeasuredCell(reason) {
  return {
    state: CELL_STATES.UNMEASURED,
    image: null,
    reason,
    trackedBy: null,
    metrics: null,
  };
}

function unmeasuredPair(reason) {
  return {
    state: CELL_STATES.UNMEASURED,
    diffImage: null,
    mismatchPct: null,
    changedPx: null,
    bbox: null,
    tolerance: null,
    metrics: null,
    reason,
  };
}

/** The base page URL a record without a `url` stands in with. */
function fallbackUrl(origin, rig, entryId) {
  const page = typeof rig?.page === "string" ? rig.page : entryId;
  return /^https?:\/\//.test(origin)
    ? `${origin.replace(/\/+$/, "")}/${page}`
    : page;
}

/** `path` relative to the output directory as a POSIX path, or null when outside it. */
function insideOutput(outputDirectory, absolute) {
  const relative = path.relative(outputDirectory, absolute);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    posix(relative).split("/").includes("..")
  ) {
    return null;
  }
  return posix(relative);
}

/**
 * One slot of one entry: read the recorded capture, check its digest, decode
 * it, and place it beside the manifest.
 *
 * @returns {{cell: object, image: object|null, files: object[]}}
 */
function slotCell({
  slot,
  arm,
  absentReason,
  rig,
  entryId,
  renderer,
  origin,
  generatedAt,
  outputDirectory,
  readBytes,
}) {
  if (!arm) {
    return { cell: unmeasuredCell(absentReason), image: null, files: [] };
  }
  const record = arm.captures[0];
  if (!record) {
    const reason =
      arm.notRun.length > 0
        ? `NOT RUN: ${[...new Set(arm.notRun)].join("; ")}`
        : "this page takes no capture";
    return { cell: unmeasuredCell(reason), image: null, files: [] };
  }
  if (slot === "BEFORE" && typeof record.sha256 !== "string") {
    return {
      cell: unmeasuredCell(
        `the BEFORE image ${record.path} has no sha256 in its report, so it cannot be checked against the run that recorded it`,
      ),
      image: null,
      files: [],
    };
  }
  const bytes = readBytes(record.path);
  if (bytes === null || bytes === undefined) {
    return {
      cell: unmeasuredCell(
        `the ${slot} image ${record.path} could not be read (moved or deleted since the run that recorded it)`,
      ),
      image: null,
      files: [],
    };
  }
  const digest = sha256Hex(bytes);
  if (record.sha256 !== undefined && digest !== record.sha256) {
    return {
      cell: unmeasuredCell(
        `the ${slot} image ${record.path} has sha256 ${shortSha(digest)} but its report recorded ${shortSha(record.sha256)}: the file changed after the run`,
      ),
      image: null,
      files: [],
    };
  }
  let image;
  try {
    image = decodePng(Buffer.from(bytes));
  } catch (error) {
    return {
      cell: unmeasuredCell(
        `the ${slot} image ${record.path} is not a decodable PNG: ${error?.message ?? error}`,
      ),
      image: null,
      files: [],
    };
  }

  const inPlace =
    slot === "AFTER" ? insideOutput(outputDirectory, record.path) : null;
  const imagePath =
    inPlace ??
    `${LANDING_MANIFEST_IMAGE_DIR}/${slugOf(entryId)}/${renderer}/${slot}.png`;
  const files =
    inPlace === null ? [{ path: imagePath, bytes: Buffer.from(bytes) }] : [];

  const fallbackFields = [];
  let url = record.url;
  if (typeof url !== "string" || url.length === 0) {
    url = fallbackUrl(origin, rig, entryId);
    fallbackFields.push("url");
  }
  let capturedAt = isoOrNull(record.capturedAt);
  if (capturedAt === null) {
    capturedAt = generatedAt;
    fallbackFields.push("capturedAt");
  }
  const cell = {
    state: CELL_STATES.MEASURED,
    image: imagePath,
    width: image.width,
    height: image.height,
    byteLength: bytes.byteLength,
    sha256: digest,
    url,
    capturedAt,
    metrics: cellMetrics(image, image),
  };
  if (fallbackFields.length > 0) {
    cell.fallbackFields = fallbackFields;
  }
  return { cell, image, files };
}

/** The pair of one renderer of one entry, from its two slot results. */
function pairFor({ before, after, entryId, renderer, tolerance }) {
  if (before.cell.state !== CELL_STATES.MEASURED) {
    return {
      pair: unmeasuredPair(
        `BEFORE is UNMEASURED (${before.cell.reason}); the report's comparison holds the pixel band when a base report was given`,
      ),
      files: [],
    };
  }
  if (after.cell.state !== CELL_STATES.MEASURED) {
    return {
      pair: unmeasuredPair(
        `AFTER is UNMEASURED (${after.cell.reason}); the report's comparison holds the pixel band when a base report was given`,
      ),
      files: [],
    };
  }
  if (
    before.image.width !== after.image.width ||
    before.image.height !== after.image.height
  ) {
    return {
      pair: unmeasuredPair(
        `BEFORE is ${before.image.width}x${before.image.height} and AFTER is ${after.image.width}x${after.image.height}: a pair of two sizes cannot be diffed`,
      ),
      files: [],
    };
  }
  const metrics = pairMetrics(before.image, after.image, { tolerance });
  const diffImage = `${LANDING_MANIFEST_IMAGE_DIR}/${slugOf(entryId)}/${renderer}/DIFF.png`;
  return {
    pair: {
      state: CELL_STATES.MEASURED,
      diffImage,
      mismatchPct: metrics.mismatchPct,
      changedPx: metrics.changedPx,
      bbox: metrics.bbox,
      tolerance: metrics.tolerance,
      metrics: { mssim: metrics.mssim, windows: metrics.windows },
    },
    files: [
      {
        path: diffImage,
        bytes: Buffer.from(
          encodeRgbaPng(
            metrics.diffRgba,
            before.image.width,
            before.image.height,
          ),
        ),
      },
    ],
  };
}

/** Base arms from a base report: its pages regrouped, else the arms it carries. */
function baseArmsOf(baseReport) {
  if (!baseReport) {
    return null;
  }
  if (Array.isArray(baseReport.pages)) {
    return groupArms(baseReport.pages);
  }
  return baseReport.arms ?? {};
}

/**
 * Build the manifest for one landing invocation. Pure over its inputs.
 *
 * @param {object} inputs Inputs.
 * @param {object[]} inputs.pages This run's page records (the report's `pages`).
 * @param {object|null} [inputs.baseReport] The parsed base report, or null.
 * @param {Map<string, object>|Record<string, object>} inputs.rigsById Rig records by id.
 * @param {{AFTER: string, BEFORE?: string}} inputs.origins The origin this run
 *   served; BEFORE defaults to the base report's own origin, else
 *   {@link UNRECORDED_ORIGIN} for a base report that carries none, else
 *   {@link NO_BASE_REPORT_ORIGIN} when there is no base report.
 * @param {string} inputs.generatedAt ISO-8601 instant with milliseconds.
 * @param {"enforced"|"waived"} inputs.servedBuildAssertion The assertion's state.
 * @param {string} inputs.receipt The report's file name beside the manifest.
 * @param {string} inputs.outputDirectory Where the report and manifest sit.
 * @param {(absolutePath: string) => Uint8Array|null} inputs.readBytes Reads a
 *   file, or null when it cannot be read.
 * @param {string} [inputs.captureRoot] Defaults to the output directory's name.
 * @param {number} [inputs.tolerance] Pair tolerance; the landing pixel band's.
 * @param {string} [inputs.entryLabel] How each entry's description names
 *   its cell (`<entryLabel> <cell>, page <page>.`); another probe that
 *   reuses this builder names its own kind of cell.
 * @returns {{manifest: object, files: Array<{path: string, bytes: Buffer}>,
 *   violations: string[]}} The manifest, the files that go beside it (paths
 *   relative to it), and every violation either validator reports.
 * @throws {TypeError} When a page names a rig `rigsById` does not hold.
 */
export function buildLandingCaptureManifest({
  pages,
  baseReport = null,
  rigsById,
  origins,
  generatedAt,
  servedBuildAssertion,
  receipt,
  outputDirectory,
  readBytes,
  captureRoot,
  tolerance = PIXEL_PAIR_TOLERANCE,
  entryLabel = "Landing cell",
}) {
  const rigAt = (id) =>
    rigsById instanceof Map ? rigsById.get(id) : rigsById?.[id];
  const tipArms = groupArms(pages);
  const baseArms = baseArmsOf(baseReport);
  const afterOrigin = origins.AFTER;
  const beforeOrigin =
    origins.BEFORE ??
    baseReport?.runtime?.origin ??
    baseReport?.origin ??
    (baseReport ? UNRECORDED_ORIGIN : NO_BASE_REPORT_ORIGIN);
  const baseGeneratedAt =
    isoOrNull(baseReport?.generatedAt) ??
    isoOrNull(baseReport?.runtime?.generatedAt) ??
    generatedAt;

  const renderers = CAPTURE_RENDERERS.filter((renderer) =>
    Object.values(tipArms).some((arm) => arm.renderer === renderer),
  );

  // One entry per (cell, page), in the order the run first reached it.
  const entries = new Map();
  for (const arm of Object.values(tipArms)) {
    const key = `${arm.cell}\u0000${arm.page}`;
    if (!entries.has(key)) {
      entries.set(key, {
        cell: arm.cell,
        page: arm.page,
        rigId: arm.rig,
        arms: {},
      });
    }
    entries.get(key).arms[arm.renderer] = arm;
  }

  const files = [];
  const cells = new Map();
  const pairs = new Map();
  const summaries = [];

  for (const entry of entries.values()) {
    const id = `${entry.cell}:${entry.page}`;
    const baseRig = rigAt(entry.rigId);
    if (!baseRig) {
      throw new TypeError(
        `landing manifest: ${id} names rig ${entry.rigId}, which rigsById does not hold`,
      );
    }
    const rig = rigForPage(baseRig, entry);
    const description =
      typeof rig.description === "string" ? rig.description : "";
    summaries.push({
      id,
      replayKey: replayKeyFor(rig),
      description:
        `${entryLabel} ${entry.cell}, page ${entry.page}. ${description}`.trim(),
      viewport: { ...rig.viewport },
      renderers,
    });

    for (const renderer of renderers) {
      const tipArm = entry.arms[renderer];
      const baseArm = baseArms
        ? baseArms[`${entry.cell}|${renderer}|${entry.page}`]
        : null;
      const after = slotCell({
        slot: "AFTER",
        arm: tipArm,
        absentReason: `${entry.cell} page ${entry.page} was not run on ${renderer} in this invocation`,
        rig,
        entryId: id,
        renderer,
        origin: afterOrigin,
        generatedAt,
        outputDirectory,
        readBytes,
      });
      const beforeAbsent = baseArms
        ? `the base report has no ${entry.cell} page ${entry.page} arm on ${renderer}`
        : NO_BASE_REPORT_REASON;
      const before = slotCell({
        slot: "BEFORE",
        arm: baseArm ?? null,
        absentReason: beforeAbsent,
        rig,
        entryId: id,
        renderer,
        origin: beforeOrigin,
        generatedAt: baseGeneratedAt,
        outputDirectory,
        readBytes,
      });
      const pair = pairFor({
        before,
        after,
        entryId: id,
        renderer,
        tolerance,
      });
      cells.set(`${id}|${renderer}|AFTER`, after.cell);
      cells.set(`${id}|${renderer}|BEFORE`, before.cell);
      pairs.set(`${id}|${renderer}`, pair.pair);
      files.push(...after.files, ...before.files, ...pair.files);
    }
  }

  const manifest = buildCaptureManifest({
    descriptor: {
      captureRoot: captureRoot ?? slugOf(path.basename(outputDirectory)),
      origins: { BEFORE: beforeOrigin, AFTER: afterOrigin },
      slots: CAPTURE_SLOTS,
      renderers,
      rigs: summaries,
    },
    cells,
    pairs,
    receiptPath: receipt,
    generatedAt,
    servedBuildAssertion,
  });
  const violations = [
    ...new Set([
      ...validateCaptureManifest(manifest),
      ...validateSheetManifest(manifest),
    ]),
  ];
  return { manifest, files, violations };
}

/**
 * Build the manifest and write it beside the report. REFUSES, rather than
 * writes, a manifest that fails either validator: nothing is written, a manifest
 * left by an earlier run is removed, and the violations come back.
 *
 * @param {object} inputs As {@link buildLandingCaptureManifest}, minus
 *   `readBytes`, plus `fs`.
 * @param {{readFileSync: Function, writeFileSync: Function, mkdirSync: Function,
 *   rmSync: Function}} [inputs.fs] Injected I/O; defaults to `node:fs`.
 * @returns {{path: string|null, written: boolean, violations: string[],
 *   files: string[]}} `path` is the manifest's path when written, else null.
 */
export function writeLandingCaptureManifest({
  fs: io = fs,
  outputDirectory,
  ...inputs
}) {
  const readBytes = (absolutePath) => {
    try {
      return io.readFileSync(absolutePath);
    } catch {
      return null;
    }
  };
  const { manifest, files, violations } = buildLandingCaptureManifest({
    ...inputs,
    outputDirectory,
    readBytes,
  });
  const manifestPath = path.join(outputDirectory, LANDING_MANIFEST_FILE);
  if (violations.length > 0) {
    io.rmSync(manifestPath, { force: true });
    return { path: null, written: false, violations, files: [] };
  }
  const written = [];
  for (const file of files) {
    const target = path.join(outputDirectory, file.path);
    io.mkdirSync(path.dirname(target), { recursive: true });
    io.writeFileSync(target, file.bytes);
    written.push(file.path);
  }
  io.mkdirSync(outputDirectory, { recursive: true });
  io.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path: manifestPath, written: true, violations: [], files: written };
}
