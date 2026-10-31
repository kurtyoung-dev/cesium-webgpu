/**
 * The landing cells' within-run comparisons between pages: a cell's WebGPU
 * capture against the same run's WebGL capture, and a variant cell's
 * displacement readbacks against each other.
 * @purpose Cross-page metric for probe-landing-cells.mjs: per run, the kit's pixel diff of a crossRenderer cell's WebGL and WebGPU captures (reported, its band registered by the first capture; for a cell with variants, once per variant page, each WebGPU variant against the WebGL page of the same name), and the ocean displacement-readback identity between a readback cell's two variant pages (lib/ocean-displacement-readback.mjs), with the verdicts each yields; Node only for the pixel diff (reads the PNGs), pure otherwise.
 * @status ACTIVE
 *
 * WHY NOT `compareArms`. The base-vs-tip comparison pairs the SAME page of two
 * trees. These pair two pages of ONE run on one tree: the two renderers of a
 * cell, or the two kernels of E-FFT-ifft. Neither needs a base report.
 *
 * VARIANT CELLS PAIR BY PAGE NAME. A crossRenderer cell with `variants`
 * (E-2D-stages, E-CV-stages) runs every variant on both renderers, and each
 * WebGPU page is diffed against the WebGL page of the same name, one entry per
 * run and variant in table order, each carrying `page`. Every WebGL variant
 * page is the plain frame (the WebGL globe ignores the debug mode), so each
 * pair reads "this WebGPU term against WebGL". A cell without variants pairs
 * its one page per renderer exactly as before and its entries carry no
 * `page`.
 *
 * NO BAND IS CLAIMED. The cross-renderer diff has no pre-registered band: the
 * first capture registers it, so its verdict says only whether the diff was
 * measured (both captures present and the same size), never that a value is
 * within a bound. The kernel identity verdict is
 * `lib/ocean-displacement-readback.mjs`'s `kernelIdentityVerdict`: identical
 * hashes pass, a measured difference fails, an unmeasured pair is NOT RUN. A
 * page carrying `displacementEvolved` is judged again at its later wave time by
 * `evolvedKernelIdentityVerdict`, beside the t = 0 verdict.
 *
 * @module Tools/visual-regression/lib/metrics/landing-cross-page
 */

import { LANDING_CELLS } from "../landing-cell-table.mjs";
import {
  evolvedKernelIdentityVerdict,
  kernelIdentityVerdict,
} from "../ocean-displacement-readback.mjs";
import { pixelDiff } from "./landing-pixel-band.mjs";

const runsOf = (pages) =>
  [...new Set(pages.map((page) => page.run))].sort((a, b) => a - b);

/**
 * Per crossRenderer cell and run, the WebGPU capture against the WebGL one.
 * Node only (reads the PNGs through `diff`).
 *
 * @param {object[]} pages Page records.
 * @param {{diff?: Function}} [options] `diff` defaults to the kit's
 *   `pixelDiff` (`lib/metrics/landing-pixel-band.mjs`).
 * @returns {Array<{cell: string, run: number, page?: string, measured: boolean,
 *   reason?: string, webgl?: string, webgpu?: string, changedPx?: number,
 *   mismatchPct?: number, bbox?: object, band: string}>}
 */
export function crossRendererComparisons(pages, { diff = pixelDiff } = {}) {
  const out = [];
  const cells = [...new Set((pages ?? []).map((page) => page.cell))].filter(
    (cell) => LANDING_CELLS[cell]?.crossRenderer === true,
  );
  for (const cell of cells) {
    const ofCell = pages.filter((page) => page.cell === cell);
    const names = LANDING_CELLS[cell].variants
      ? Object.keys(LANDING_CELLS[cell].variants)
      : [null];
    for (const run of runsOf(ofCell)) {
      for (const name of names) {
        const find = (renderer) =>
          ofCell.find(
            (page) =>
              page.run === run &&
              page.renderer === renderer &&
              (name === null || page.page === name),
          );
        const webgl = find("webgl");
        const webgpu = find("webgpu");
        const entry = {
          cell,
          run,
          ...(name === null ? {} : { page: name }),
          band: "unregistered (first capture registers)",
        };
        if (!webgl?.capture || !webgpu?.capture) {
          const missing = [
            webgl?.capture ? null : `webgl (${webgl?.notRun ?? "no page"})`,
            webgpu?.capture ? null : `webgpu (${webgpu?.notRun ?? "no page"})`,
          ].filter(Boolean);
          out.push({
            ...entry,
            measured: false,
            reason: `no capture on ${missing.join(", ")}`,
          });
          continue;
        }
        const result = diff(webgl.capture, webgpu.capture);
        out.push({
          ...entry,
          webgl: webgl.capture.name,
          webgpu: webgpu.capture.name,
          ...result,
          measured: result?.measured === true,
        });
      }
    }
  }
  return out;
}

/**
 * Per readback cell, renderer and run, the two variant pages' displacement
 * readbacks compared. Pure. A page that also carries `displacementEvolved`
 * (`readOceanDisplacementEvolved`, a later pinned clock) adds an entry marked
 * `evolved: true` right after the t = 0 one, with the evolved verdict.
 *
 * @param {object[]} pages Page records (`record.displacement` from
 *   `readOceanDisplacement`, `record.displacementEvolved` from
 *   `readOceanDisplacementEvolved`).
 * @returns {Array<{cell: string, renderer: string, run: number,
 *   pages: string[], evolved?: true, advanceSeconds?: number|null,
 *   comparison: object, verdict: object}>}
 */
export function kernelIdentityComparisons(pages) {
  const out = [];
  const cells = [...new Set((pages ?? []).map((page) => page.cell))].filter(
    (cell) =>
      LANDING_CELLS[cell]?.readback === "ocean-displacement" &&
      LANDING_CELLS[cell]?.variants,
  );
  for (const cell of cells) {
    const [first, second] = Object.keys(LANDING_CELLS[cell].variants);
    const ofCell = pages.filter((page) => page.cell === cell);
    for (const renderer of [...new Set(ofCell.map((page) => page.renderer))]) {
      for (const run of runsOf(ofCell)) {
        const find = (name) =>
          ofCell.find(
            (page) =>
              page.run === run &&
              page.renderer === renderer &&
              page.page === name,
          );
        const a = find(first)?.displacement ?? null;
        const b = find(second)?.displacement ?? null;
        const verdict = kernelIdentityVerdict(
          `${cell}:${renderer}:run${run}`,
          a,
          b,
        );
        out.push({
          cell,
          renderer,
          run,
          pages: [first, second],
          comparison: verdict.comparison,
          verdict,
        });
        // The evolved readback (a later pinned clock) is judged beside the
        // t = 0 one, only for pages that carry it; `evolved: true` tells a
        // reader the two entries apart.
        const a1 = find(first)?.displacementEvolved ?? null;
        const b1 = find(second)?.displacementEvolved ?? null;
        if (a1 !== null || b1 !== null) {
          const advanceSeconds =
            a1?.advanceSeconds === b1?.advanceSeconds
              ? a1?.advanceSeconds
              : null;
          const evolvedVerdict = evolvedKernelIdentityVerdict(
            `${cell}:${renderer}:run${run}`,
            { a0: a, b0: b, a1, b1, advanceSeconds },
          );
          out.push({
            cell,
            renderer,
            run,
            pages: [first, second],
            evolved: true,
            advanceSeconds,
            comparison: evolvedVerdict.comparison,
            verdict: evolvedVerdict,
          });
        }
      }
    }
  }
  return out;
}

/**
 * The verdicts of the two comparisons. Pure.
 *
 * @param {{crossRenderer?: object[], kernelIdentity?: object[]}} comparisons
 * @returns {Array<{id: string, pass: boolean, notRun?: boolean}>}
 */
export function crossPageVerdicts({ crossRenderer = [], kernelIdentity = [] }) {
  const verdicts = [];
  for (const entry of crossRenderer) {
    verdicts.push({
      id: `${entry.cell}${entry.page === undefined ? "" : `:${entry.page}`}:cross-renderer:run${entry.run}:measured`,
      pass: entry.measured === true,
      ...(entry.measured === true
        ? {
            changedPx: entry.changedPx,
            mismatchPct: entry.mismatchPct,
            band: entry.band,
          }
        : { notRun: true, reason: entry.reason }),
    });
  }
  for (const entry of kernelIdentity) {
    verdicts.push(entry.verdict);
  }
  return verdicts;
}
