/**
 * DX-105 — the contact sheet CLI: a thin shell over `lib/contact-sheet-page.mjs`.
 * @purpose Thin CLI shell that reads a capture manifest, builds the pure contact-sheet page model, writes the self-contained sheet directory, and exits independently of any mismatch value.
 * @status ACTIVE
 *
 * Every rendering and validation decision lives in `lib/contact-sheet-page.mjs`;
 * this file only resolves CLI arguments, performs the file I/O the pure
 * functions cannot do themselves, and reports an exit code. Filesystem access
 * is dependency-injected exactly the way `capture()` (DX-104) takes its
 * `dependencies` — the default binds to real `node:fs`, and a spec supplies an
 * in-memory fake so no test here touches disk.
 *
 * @module contact-sheet
 */

import { promises as fsp } from "node:fs";
import { posix as posixPath } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  sheetModel,
  renderSheetHtml,
  sheetIndexEntry,
  deriveDateFromGeneratedAt,
  formatCalendarDate,
} from "./lib/contact-sheet-page.mjs";

/**
 * Default output root, repo-relative and POSIX — matches `.gitignore:92`.
 *
 * `--out-dir` should stay repo-relative, as this default is. The emitted
 * `sheet-index.json` records the path the sheet was WRITTEN to, and DX-106's
 * `validateContactSheetEntry` requires that field to be repo-relative POSIX
 * (it reads the page back to recompute its md5). An absolute `--out-dir`
 * therefore produces a sheet that is perfectly good to look at but whose entry
 * the wave-end gate refuses — rewrite the entry's `path` when banking it, the
 * way the banking step already does.
 */
export const DEFAULT_OUT_DIR = "Tools/visual-regression/output/contact-sheets";

/**
 * Every path this tool joins, compares or emits is POSIX-separated: a
 * manifest's image paths are POSIX by contract, the index entry's `path` is
 * rejected downstream if it carries a backslash, and `posixPath.dirname` of a
 * backslash path returns `"."` — which would silently resolve a manifest's
 * images against the working directory instead of against the manifest. A
 * caller on Windows naturally passes a backslash path, so incoming paths are
 * converted once, here, rather than trusted.
 *
 * @param {string} value A path in either separator convention.
 * @returns {string} The same path, POSIX-separated.
 */
function toPosixPath(value) {
  return String(value).split("\\").join("/");
}

/**
 * Parse `contact-sheet.mjs` CLI arguments.
 *
 * `--generated-at` and `--date` are optional: when omitted, `runContactSheet`
 * fills `generatedAt` from its injected `now()` dependency and derives `date`
 * from it — this function itself never reads a clock.
 *
 * @param {string[]} argv Arguments after the script path (no node/script entries).
 * @returns {{manifestPath: string|null, sheetId: string|null, outDir: string,
 *   generatedAt: string|null, date: string|null, argumentError: string|null}}
 */
export function parseContactSheetArgs(argv) {
  const args = {
    manifestPath: null,
    sheetId: null,
    outDir: DEFAULT_OUT_DIR,
    generatedAt: null,
    date: null,
    argumentError: null,
  };
  const list = Array.isArray(argv) ? argv : [];

  const takeValue = (flag, index) => {
    const value = list[index + 1];
    if (value === undefined || value.startsWith("--")) {
      if (!args.argumentError) {
        args.argumentError = `${flag} requires a value`;
      }
      return { value: null, nextIndex: index };
    }
    return { value, nextIndex: index + 1 };
  };

  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    switch (token) {
      case "--manifest": {
        const taken = takeValue(token, index);
        args.manifestPath = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--sheet-id": {
        const taken = takeValue(token, index);
        args.sheetId = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--out-dir": {
        const taken = takeValue(token, index);
        if (taken.value !== null) {
          args.outDir = taken.value;
        }
        index = taken.nextIndex;
        break;
      }
      case "--generated-at": {
        const taken = takeValue(token, index);
        args.generatedAt = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--date": {
        const taken = takeValue(token, index);
        args.date = taken.value;
        index = taken.nextIndex;
        break;
      }
      default: {
        if (!args.argumentError) {
          args.argumentError = `unrecognised argument: ${token}`;
        }
      }
    }
  }

  if (!args.argumentError && !args.manifestPath) {
    args.argumentError = "--manifest is required";
  }
  if (!args.argumentError && !args.sheetId) {
    args.argumentError = "--sheet-id is required";
  }
  return args;
}

/**
 * The tool's exit code, from the only two facts that may decide it.
 *
 * IT IS A SEPARATE FUNCTION SO THE INDEPENDENCE IS STRUCTURAL, NOT SAMPLED.
 * "The exit code never reads a mismatch" used to be asserted by sweeping
 * mismatch values and watching the code stay 0 — and a sweep is a sample, so a
 * threshold inside a band narrower than the sampling gap survived it
 * (`0.1 < worst < 0.4` survived 101 evenly spaced values). A decision computed
 * from a two-field record cannot read `mismatchPct` at all: there is nothing
 * measured in its arguments to read. The spec injects a spy in its place and
 * asserts the record it receives carries EXACTLY these two keys, which is an
 * assertion no sweep density can substitute for.
 *
 * @param {{pageWritten: boolean, ioError: string|null}} outcome What happened.
 * @returns {number} `0` when the page was written, `1` otherwise.
 */
export function decideContactSheetExit({ pageWritten, ioError }) {
  if (ioError !== null && ioError !== undefined) {
    return 1;
  }
  return pageWritten === true ? 0 : 1;
}

/**
 * Build and write one contact sheet from a capture manifest.
 *
 * THE EXIT CODE ANSWERS EXACTLY ONE QUESTION: did the sheet get written. It
 * never reads `mismatchPct`, `changedPx`, or any other measured value to
 * decide — structurally, through {@link decideContactSheetExit}, which is
 * handed `{pageWritten, ioError}` and nothing else. Sweeping the SAME
 * manifest's pair `mismatchPct` from 0 through 100 (and `null`) while holding
 * everything else fixed must not move `exitCode` by even one unit;
 * `contact-sheet.spec.mjs` asserts that sweep densely AND asserts the record
 * the decision is computed from.
 *
 * THE SHEET'S DATE IS THE LOCAL CALENDAR DATE, not the UTC slice of an
 * instant — see {@link formatCalendarDate}. `--date` overrides it outright,
 * and an explicit `--generated-at` (an instant a caller pinned, carrying no
 * timezone) still derives through {@link deriveDateFromGeneratedAt}.
 *
 * @param {string[]} argv
 * @param {{readFile?: Function, writeFile?: Function, mkdir?: Function,
 *   copyFile?: Function, clock?: Function, decideExit?: Function}}
 *   [dependencies] Injected I/O, the one clock and the exit decision; they
 *   default to real `node:fs`, a real `Date` and
 *   {@link decideContactSheetExit}. A spec supplies an in-memory fake so no
 *   test touches disk and no test reads the machine's clock.
 * @returns {Promise<{exitCode: number, writtenPaths: string[], error: string|null}>}
 */
export async function runContactSheet(argv, dependencies = {}) {
  const {
    readFile = (filePath) => fsp.readFile(filePath, "utf8"),
    writeFile = (filePath, data) => fsp.writeFile(filePath, data),
    mkdir = (dirPath) => fsp.mkdir(dirPath, { recursive: true }),
    copyFile = (from, to) => fsp.copyFile(from, to),
    clock = () => new Date(),
    decideExit = decideContactSheetExit,
  } = dependencies;

  // ONE call site for the exit code, and the only record it is ever handed.
  const finish = (pageWritten, ioError, writtenPaths = []) => ({
    exitCode: decideExit({ pageWritten, ioError }),
    writtenPaths,
    error: ioError,
  });

  const args = parseContactSheetArgs(argv);
  if (args.argumentError) {
    return finish(false, args.argumentError);
  }

  let manifestText;
  try {
    manifestText = await readFile(args.manifestPath);
  } catch (error) {
    return finish(false, `could not read manifest: ${error?.message ?? error}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    return finish(
      false,
      `manifest is not valid JSON: ${error?.message ?? error}`,
    );
  }

  const manifestDir = posixPath.dirname(toPosixPath(args.manifestPath));
  const outDir = toPosixPath(args.outDir);
  const reading = clock();
  const generatedAt = args.generatedAt ?? reading.toISOString();
  const date =
    args.date ??
    (args.generatedAt === null
      ? formatCalendarDate(reading)
      : deriveDateFromGeneratedAt(generatedAt));

  let model;
  try {
    model = sheetModel(manifest, { sheetId: args.sheetId, generatedAt, date });
  } catch (error) {
    return finish(false, error?.message ?? String(error));
  }

  const sheetDir = `${outDir}/${model.date}/${model.sheetId}`;
  const writtenPaths = [];
  let pageWritten = false;

  // EVERY I/O FAILURE IS THIS FUNCTION'S OWN RESULT, NOT AN UNHANDLED
  // REJECTION. A missing image, a read-only output root or a destination the
  // mkdir loop did not cover surfaced as a rejected promise with a stack
  // instead of the documented `{exitCode: 1, error}` — a caller that checks
  // the exit code saw the process die a different way. The exit code stays
  // independent of every measured value either way: it answers "was the sheet
  // written", and "no, because the copy failed" is still not a mismatch.
  try {
    const directoriesNeeded = new Set([sheetDir, `${sheetDir}/images`]);
    for (const { to } of model.imageCopies) {
      directoriesNeeded.add(posixPath.dirname(`${sheetDir}/${to}`));
    }
    for (const dir of [...directoriesNeeded].sort()) {
      await mkdir(dir);
    }

    for (const { from, to } of model.imageCopies) {
      const destination = `${sheetDir}/${to}`;
      await copyFile(`${manifestDir}/${from}`, destination);
      writtenPaths.push(destination);
    }

    const manifestCopyPath = `${sheetDir}/capture-manifest.json`;
    await writeFile(manifestCopyPath, manifestText);
    writtenPaths.push(manifestCopyPath);

    if (typeof manifest.receipt === "string" && manifest.receipt.length > 0) {
      const receiptDestination = `${sheetDir}/${manifest.receipt}`;
      await copyFile(`${manifestDir}/${manifest.receipt}`, receiptDestination);
      writtenPaths.push(receiptDestination);
    }

    const html = renderSheetHtml(model);
    const indexPath = `${sheetDir}/index.html`;
    await writeFile(indexPath, html);
    writtenPaths.push(indexPath);
    pageWritten = true;

    const md5 = createHash("md5").update(html, "utf8").digest("hex");
    const entry = sheetIndexEntry(model, { html, path: indexPath, md5 });
    const indexJsonPath = `${sheetDir}/sheet-index.json`;
    await writeFile(indexJsonPath, `${JSON.stringify(entry, null, 2)}\n`);
    writtenPaths.push(indexJsonPath);
  } catch (error) {
    // `pageWritten` deliberately stays whatever it was: a run that wrote the
    // page and then failed to write its index has not produced a usable sheet,
    // and the error is what carries the code to 1 either way.
    return finish(
      pageWritten,
      `could not write the sheet: ${error?.message ?? error}`,
      writtenPaths,
    );
  }

  return finish(pageWritten, null, writtenPaths);
}

async function main() {
  let result;
  try {
    result = await runContactSheet(process.argv.slice(2));
  } catch (error) {
    // Defence in depth for anything `runContactSheet` cannot foresee: the
    // tool reports and exits 1 rather than printing a rejection trace.
    result = {
      exitCode: decideContactSheetExit({
        pageWritten: false,
        ioError: error?.message ?? String(error),
      }),
      writtenPaths: [],
      error: error?.message ?? error,
    };
  }
  if (result.error) {
    console.error(`contact-sheet: ${result.error}`);
  }
  process.exit(result.exitCode);
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
