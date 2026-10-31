/**
 * Where a landing report's frame paths are written and how a reader finds them again.
 * @purpose Path piece for probe-landing-cells.mjs and its report readers: the writer's relativizeFramePaths (every page record's capture and captureStart path made relative to the report's own directory, POSIX-separated, when the frame sits inside it), the readers' resolveFramePaths (a loaded report's page and arm frame paths resolved against THAT report's directory, an absolute path left as written) and baseFrameMissing (a base frame that is not on disk classified as the not-run reason base-frames-missing, with the path and the original error kept, instead of an ENOENT message); Node only for baseFrameMissing, pure otherwise.
 * @status ACTIVE
 *
 * WHY. A report that names its frames absolutely cannot be read once the
 * clone that wrote them is gone. The banked W3-DAYLIGHT BEFORE report named
 * `cesium-edge-w3before-20261031/...` frames, and a later `--base-report` run
 * measured no base-against-tip pixels on 8 of 8 arms although the seat's copy
 * held the same file names beside the report. The report and its frames are
 * written into one output directory, so a frame path relative to that
 * directory survives moving or copying the directory whole.
 *
 * WHICH DESIGN. The probe keeps absolute paths in memory for the invocation
 * (the tip comparison, the capture manifest and the cross-renderer comparison
 * all read the frames of the run that just wrote them) and writes the
 * relative form only into the report. Readers resolve the other way at load
 * time, so every consumer downstream of a load still sees an absolute path.
 * A frame outside the report's directory (a `--merge-reports` prior from
 * another folder) is written absolute: a relative path with a `..` segment is
 * refused by `relative-path.mjs`, and such a frame never belonged to this
 * report's folder.
 *
 * WHAT A BANKED ABSOLUTE REPORT DOES. An absolute path that exists is used as
 * written. One that does not exist is NOT rescued by looking for its basename
 * beside the report: the cell reads `base-frames-missing`, which is the
 * honest answer about a report whose frames were never banked with it.
 *
 * @module Tools/visual-regression/lib/report-frame-paths
 */

import fs from "node:fs";
import path from "node:path";

import { isRelativePosixPath } from "./relative-path.mjs";

/** The `comparison[arm].pixels.reason` for a base frame that is not on disk. */
export const BASE_FRAMES_MISSING = "base-frames-missing";

/** The `comparison[arm].pixels.verdict` of a comparison that could not run. */
export const PIXELS_NOT_RUN = "not-run";

const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);

/** The page-record fields that hold a frame record. */
const FRAME_FIELDS = Object.freeze(["capture", "captureStart"]);

/**
 * `file` as a path relative to `directory` in POSIX form, or `null` when it
 * is not inside it (or is not a string). Pure.
 *
 * @param {unknown} file A frame path as recorded in memory.
 * @param {string} directory The report's directory.
 * @returns {string|null}
 */
export function relativeFramePath(file, directory) {
  if (typeof file !== "string" || file.length === 0) {
    return null;
  }
  const relative = path
    .relative(path.resolve(directory), path.resolve(file))
    .split(path.sep)
    .join("/");
  return relative.length > 0 && isRelativePosixPath(relative) ? relative : null;
}

/**
 * A recorded frame path as an absolute path: a relative POSIX path resolves
 * against `reportDirectory`; anything else (an absolute path, or a value that
 * is not a path string) is returned as written. Pure.
 *
 * @param {unknown} recorded
 * @param {string} reportDirectory The directory of the report that held it.
 * @returns {unknown}
 */
export function resolveFramePath(recorded, reportDirectory) {
  if (typeof recorded === "string" && isRelativePosixPath(recorded)) {
    return path.resolve(reportDirectory, recorded);
  }
  return recorded;
}

function mapFrame(frame, convert) {
  if (!frame || typeof frame !== "object" || typeof frame.path !== "string") {
    return frame;
  }
  const converted = convert(frame.path);
  return converted === frame.path ? frame : { ...frame, path: converted };
}

function mapPages(pages, convert) {
  if (!Array.isArray(pages)) {
    return pages;
  }
  return pages.map((page) => {
    if (!page || typeof page !== "object") {
      return page;
    }
    let copy = page;
    for (const field of FRAME_FIELDS) {
      const mapped = mapFrame(page[field], convert);
      if (mapped !== page[field]) {
        copy = copy === page ? { ...page } : copy;
        copy[field] = mapped;
      }
    }
    return copy;
  });
}

function mapArms(arms, convert) {
  if (!arms || typeof arms !== "object") {
    return arms;
  }
  const out = {};
  for (const [key, arm] of Object.entries(arms)) {
    out[key] =
      arm && Array.isArray(arm.captures)
        ? {
            ...arm,
            captures: arm.captures.map((frame) => mapFrame(frame, convert)),
          }
        : arm;
  }
  return out;
}

/**
 * The page records as the report stores them: each frame path relative to
 * `reportDirectory` when the frame sits inside it, absolute otherwise. A copy;
 * the in-memory records keep their absolute paths. Pure.
 *
 * @param {object[]} pages Page records with absolute frame paths.
 * @param {string} reportDirectory The directory the report is written into.
 * @returns {object[]}
 */
export function relativizeFramePaths(pages, reportDirectory) {
  return mapPages(
    pages,
    (file) => relativeFramePath(file, reportDirectory) ?? file,
  );
}

/**
 * A loaded report with every frame path in its `pages` and `arms` resolved
 * against the directory of the file it was read from. A copy; a report
 * without frames comes back equal. Pure.
 *
 * @param {object} report The parsed report.
 * @param {string} reportFile The path of the file the report was read from.
 * @returns {object}
 */
export function resolveFramePaths(report, reportFile) {
  if (!report || typeof report !== "object") {
    return report;
  }
  const directory = path.dirname(path.resolve(reportFile));
  const convert = (file) => resolveFramePath(file, directory);
  const resolved = { ...report };
  if ("pages" in report) {
    resolved.pages = mapPages(report.pages, convert);
  }
  if ("arms" in report) {
    resolved.arms = mapArms(report.arms, convert);
  }
  return resolved;
}

/**
 * The not-run pixel comparison for a base frame that is not on disk, or
 * `null` when the frame is there (or the record names no path, or the read
 * fails for another reason, which the pixel diff reports as it always did).
 * Node only.
 *
 * @param {{name?: string, path?: string}|undefined} shot The base frame record.
 * @param {(file: string) => void} [accessFile] Throws when the file is absent.
 * @returns {{measured: false, verdict: "not-run", reason: "base-frames-missing",
 *   detail: {base: string|null, path: string, error: string}}|null}
 */
export function baseFrameMissing(shot, accessFile = fs.accessSync) {
  if (typeof shot?.path !== "string") {
    return null;
  }
  try {
    accessFile(shot.path);
    return null;
  } catch (error) {
    if (!MISSING_CODES.has(error?.code)) {
      return null;
    }
    return {
      measured: false,
      verdict: PIXELS_NOT_RUN,
      reason: BASE_FRAMES_MISSING,
      detail: {
        base: shot.name ?? null,
        path: shot.path,
        error: String(error.message ?? error),
      },
    };
  }
}

export default {
  BASE_FRAMES_MISSING,
  PIXELS_NOT_RUN,
  baseFrameMissing,
  relativeFramePath,
  relativizeFramePaths,
  resolveFramePath,
  resolveFramePaths,
};
