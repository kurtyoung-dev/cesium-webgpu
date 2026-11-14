/**
 * The landing cells' within-run comparison of each variant page against the
 * control page of the same cell.
 * @purpose Cross-page metric for probe-landing-cells.mjs: for every cell whose table entry names a `controlPage`, per renderer and run, each other variant page against the control page of the same run - the kit's pixel diff of the two captures (tolerance 0), or for a sky-cube cell the per-face sha256 comparison of the two cube records (`compareSkyCubeRecords`) - reported against the control's own run-to-run band (the control's run 0 against its later runs), and the `:measured` verdicts those comparisons yield; a page or control with no capture (or no cube record) is NOT MEASURED naming the page and why, never a zero; Node only for the pixel diff and the face files, pure otherwise.
 * @status ACTIVE
 *
 * WHY A SEPARATE METRIC. `lib/metrics/landing-cross-page.mjs` pairs the two
 * renderers of one page name, and `compareArms` pairs the same page of two
 * trees. This pairs two pages of ONE run on one renderer: a page whose dial
 * should leave the frame unchanged (a coverage of 0) against the page with the
 * feature off (the control), which is how "no contribution" is read from a
 * frame when nothing on the page names the quantity.
 *
 * THE BAND. The control page's own run 0 against its run k is the noise the
 * comparison is read against: a page that differs from the control by no more
 * than the control differs from itself is within the band. A cell run once has
 * no band (`band: null`, `withinBand: null`); the figure is still reported.
 *
 * NO PASS OR FAIL ON THE FIGURE. The verdict says only that the comparison was
 * made. Which arm a page equals the control on is the reading of the job that
 * compares the two trees, because nothing on the page says which coverage gate
 * the served engine compiled.
 *
 * @module Tools/visual-regression/lib/metrics/landing-variant-control
 */

import {
  SKY_CUBE_COMPARE,
  compareSkyCubeRecords,
} from "../sky-cubemap-steps.mjs";
import { LANDING_CELLS } from "../landing-cell-table.mjs";
import { pixelDiff } from "./landing-pixel-band.mjs";

const numeric = (a, b) => a - b;

const unique = (values) => [...new Set(values)];

/** The faces a cube comparison found different. */
function differingFacesOf(comparison) {
  return (comparison.faces ?? [])
    .filter((face) => face.identical !== true)
    .map((face) => face.face);
}

/** The cube answer of one `compareCube` result. */
function cubeAnswer(comparison) {
  return {
    measured: comparison?.verdict !== SKY_CUBE_COMPARE.NOT_AVAILABLE,
    identical: comparison?.verdict === SKY_CUBE_COMPARE.IDENTICAL,
    differingFaces: differingFacesOf(comparison ?? {}),
    ...(comparison?.reason === undefined ? {} : { reason: comparison.reason }),
  };
}

/** What a page lacks to be compared, or null. */
function missingOf(label, page, cube) {
  if (!page) {
    return `${label} has no page record`;
  }
  if (page.notRun) {
    return `${label} was not run (${page.notRun})`;
  }
  if (cube ? !page.skyCube : !page.capture) {
    return `${label} has no ${cube ? "sky-cube record" : "capture"}`;
  }
  return null;
}

/**
 * The control page's own run-to-run band for one renderer: run 0 against each
 * later run, the pair with the largest figure. Null without a later run.
 */
function bandOf(controls, cube, { diff, compareCube }) {
  const first = controls.get(0) ?? controls.get(Math.min(...controls.keys()));
  const later = [...controls.keys()].filter((run) => run !== first?.run);
  if (!first || later.length === 0) {
    return null;
  }
  let band = null;
  for (const run of later.sort(numeric)) {
    const other = controls.get(run);
    if (missingOf("the control", other, cube) !== null) {
      continue;
    }
    if (cube) {
      const answer = cubeAnswer(compareCube(first.skyCube, other.skyCube));
      if (!answer.measured) {
        continue;
      }
      if (band === null || (band.identical && !answer.identical)) {
        band = { runs: [first.run, run], identical: answer.identical };
      }
      continue;
    }
    const result = diff(first.capture, other.capture);
    if (result?.measured !== true) {
      continue;
    }
    if (band === null || result.changedPx > band.changedPx) {
      band = { runs: [first.run, run], changedPx: result.changedPx };
    }
  }
  return band;
}

/**
 * Per cell with a `controlPage`, renderer and run, each other variant page
 * against the control page. Node only (reads the PNGs and the face files).
 *
 * @param {object[]} pages Page records.
 * @param {{diff?: Function, compareCube?: Function}} [options] `diff` defaults
 *   to the kit's `pixelDiff`, `compareCube` to `compareSkyCubeRecords`.
 * @returns {Array<{cell: string, renderer: string, run: number, page: string,
 *   control: string, kind: "pixels"|"sky-cube", measured: boolean,
 *   reason?: string, changedPx?: number, mismatchPct?: number, bbox?: object,
 *   cube?: {identical: boolean, differingFaces: number[]},
 *   band: object|null, equalToControl: boolean|null,
 *   withinBand: boolean|null}>}
 */
export function variantControlComparisons(
  pages,
  { diff = pixelDiff, compareCube = compareSkyCubeRecords } = {},
) {
  const out = [];
  const records = pages ?? [];
  const cells = unique(records.map((page) => page.cell)).filter(
    (cell) =>
      typeof LANDING_CELLS[cell]?.controlPage === "string" &&
      LANDING_CELLS[cell]?.variants !== undefined,
  );
  for (const cell of cells) {
    const table = LANDING_CELLS[cell];
    const control = table.controlPage;
    const ofCell = records.filter((page) => page.cell === cell);
    const cube = table.kind === "sky-cube";
    for (const renderer of unique(ofCell.map((page) => page.renderer))) {
      const ofRenderer = ofCell.filter((page) => page.renderer === renderer);
      const controls = new Map(
        ofRenderer
          .filter((page) => page.page === control)
          .map((page) => [page.run, page]),
      );
      const band = bandOf(controls, cube, { diff, compareCube });
      const runs = unique(ofRenderer.map((page) => page.run)).sort(numeric);
      for (const run of runs) {
        for (const name of Object.keys(table.variants)) {
          if (name === control) {
            continue;
          }
          const page = ofRenderer.find(
            (record) => record.run === run && record.page === name,
          );
          if (!page) {
            continue;
          }
          const entry = {
            cell,
            renderer,
            run,
            page: name,
            control,
            kind: cube ? "sky-cube" : "pixels",
          };
          const reference = controls.get(run);
          const reason =
            missingOf(`page ${name}`, page, cube) ??
            missingOf(`control page ${control}`, reference, cube);
          if (reason !== null) {
            out.push({
              ...entry,
              measured: false,
              reason,
              band: null,
              equalToControl: null,
              withinBand: null,
            });
            continue;
          }
          if (cube) {
            const answer = cubeAnswer(
              compareCube(reference.skyCube, page.skyCube),
            );
            if (!answer.measured) {
              out.push({
                ...entry,
                measured: false,
                reason: answer.reason,
                band: null,
                equalToControl: null,
                withinBand: null,
              });
              continue;
            }
            out.push({
              ...entry,
              measured: true,
              cube: {
                identical: answer.identical,
                differingFaces: answer.differingFaces,
              },
              band,
              equalToControl: answer.identical,
              withinBand: null,
            });
            continue;
          }
          const result = diff(reference.capture, page.capture);
          if (result?.measured !== true) {
            out.push({
              ...entry,
              measured: false,
              reason: result?.reason ?? "the pixel diff answered nothing",
              band,
              equalToControl: null,
              withinBand: null,
            });
            continue;
          }
          out.push({
            ...entry,
            measured: true,
            changedPx: result.changedPx,
            mismatchPct: result.mismatchPct,
            bbox: result.bbox,
            band,
            equalToControl: result.changedPx === 0,
            withinBand:
              band === null ? null : result.changedPx <= band.changedPx,
          });
        }
      }
    }
  }
  return out;
}

/**
 * The verdicts of the comparisons: one per entry, `:measured`, passing when
 * the comparison was made. A measured entry that differs from its control
 * still passes and carries the figure; an unmeasured one is NOT RUN with its
 * reason. Pure.
 *
 * @param {object[]} entries {@link variantControlComparisons}' answer.
 * @returns {Array<{id: string, pass: boolean, notRun?: boolean}>}
 */
export function variantControlVerdicts(entries) {
  return (entries ?? []).map((entry) => {
    const id = `${entry.cell}:${entry.page}:vs-${entry.control}:${entry.renderer}:run${entry.run}:measured`;
    if (entry.measured !== true) {
      return { id, pass: false, notRun: true, reason: entry.reason };
    }
    return {
      id,
      pass: true,
      kind: entry.kind,
      ...(entry.cube === undefined
        ? { changedPx: entry.changedPx, mismatchPct: entry.mismatchPct }
        : { cube: entry.cube }),
      band: entry.band,
      equalToControl: entry.equalToControl,
      withinBand: entry.withinBand,
    };
  });
}
