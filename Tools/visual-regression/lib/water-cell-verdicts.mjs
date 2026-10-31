// water-cell-verdicts.mjs — the water landing's metrics reducer and band verdicts.
//
// @purpose Verdict piece for probe-water-cells.mjs: mismatchPct and parityNotMeasured, summarizeWaterRecords (effect area, parity and repeat percentages per cell from the captured PNGs) and waterVerdicts (the sheet's bands 2a, 2b, 2c, 2e, 2f, 2g and 1f judged on the AFTER arm against the BEFORE arm's summary), all pure but for the image loader a caller may inject.
// @status ACTIVE
//
// WHY A PIECE. The reducers and verdicts moved out of
// `probe-water-cells.mjs` when the probe passed 1,000 lines
// (DX-KIT-DECOMPOSE-RUNTIME-WATER). The probe re-exports every name it
// exported before, so its importers are unchanged. The table and bands they
// read live in `water-cell-table.mjs`; the page runners that produce the
// records they reduce stay in the probe, which owns the browser.

import { readPng } from "../../lib/png-decode.mjs";
import { diffImages } from "./image-diff.mjs";
import {
  WATER_BANDS,
  WATER_CELLS,
  WAVE_EPOCH_DIAL,
} from "./water-cell-table.mjs";

/**
 * Mismatch percent between two decoded images at a tolerance, or null when
 * they are not the same size. Pure.
 */
export function mismatchPct(a, b, tolerance) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) {
    return null;
  }
  return diffImages(a, b, { tolerance }).mismatchPct;
}

/**
 * Why a demo parity term has no value: the canvases differ in size per
 * renderer (with both sizes), or a capture is missing. Pure.
 *
 * @param {Array<{webgl: string|null, webgpu: string|null}|null>|null} afterSizes
 *   The AFTER summary's `paritySizes`, when AFTER's parity is missing.
 * @param {Array<object|null>|null} beforeSizes The same for BEFORE.
 * @param {boolean} afterMissing
 * @param {boolean} beforeMissing
 * @returns {string}
 */
export function parityNotMeasured(
  afterSizes,
  beforeSizes,
  afterMissing,
  beforeMissing,
) {
  const differing = (sizes) =>
    (sizes ?? []).find(
      (pair) => pair && pair.webgl && pair.webgpu && pair.webgl !== pair.webgpu,
    ) ?? null;
  const parts = [];
  const missing = [];
  for (const [arm, sizes, isMissing] of [
    ["AFTER", afterSizes, afterMissing],
    ["BEFORE", beforeSizes, beforeMissing],
  ]) {
    if (!isMissing) {
      continue;
    }
    const pair = differing(sizes);
    if (pair) {
      parts.push(`${arm} webgl ${pair.webgl} vs webgpu ${pair.webgpu}`);
    } else {
      missing.push(arm);
    }
  }
  const reasons = [];
  if (parts.length > 0) {
    reasons.push(`canvas size differs: ${parts.join("; ")}`);
  }
  if (missing.length > 0) {
    reasons.push(
      `no WebGL and WebGPU capture pair of one size on ${missing.join(" and ")}`,
    );
  }
  return reasons.join("; ");
}

/**
 * Per run, the WebGL and WebGPU canvas sizes of a demo cell's captures (a
 * summary's `captures`), read from the PNGs; null for a run without both, or
 * whose PNG cannot be read. Pure but for `loadImage`.
 */
function demoCaptureSizes(captures, loadImage) {
  const list = (captures ?? []).filter((c) => c.variant === "demo");
  const runs = [...new Set(list.map((c) => c.run))].sort((a, b) => a - b);
  const sizeOf = (capture) => {
    try {
      const decoded = loadImage(capture.path);
      return decoded ? `${decoded.width}x${decoded.height}` : null;
    } catch {
      return null;
    }
  };
  return runs.map((run) => {
    const gl = list.find((c) => c.run === run && c.renderer === "webgl");
    const gpu = list.find((c) => c.run === run && c.renderer === "webgpu");
    return gl && gpu ? { webgl: sizeOf(gl), webgpu: sizeOf(gpu) } : null;
  });
}

const median = (values) => {
  const sorted = values
    .filter((v) => typeof v === "number")
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const range = (values) => {
  const numbers = values.filter((v) => typeof v === "number");
  return numbers.length === 0
    ? null
    : Math.max(...numbers) - Math.min(...numbers);
};

/**
 * The measured metrics of a run set, per cell: for a mask pair the effect
 * area per renderer and run and the ON and OFF WebGL-vs-WebGPU mismatch per
 * run; for the demo cell its captures, the repeat mismatch per renderer and
 * the WebGL-vs-WebGPU mismatch per run. Pure but for `loadImage`.
 *
 * @param {object[]} records Every page record of every run.
 * @param {{loadImage?: (file: string) => object}} [io]
 * @returns {Record<string, object>}
 */
export function summarizeWaterRecords(records, io = {}) {
  const loadImage = io.loadImage ?? readPng;
  const cache = new Map();
  const image = (capture) => {
    if (!capture?.path) {
      return null;
    }
    if (!cache.has(capture.path)) {
      cache.set(capture.path, loadImage(capture.path));
    }
    return cache.get(capture.path);
  };
  const find = (cell, variant, renderer, run) =>
    records.find(
      (r) =>
        r.cell === cell &&
        r.variant === variant &&
        r.renderer === renderer &&
        r.run === run &&
        r.notRun === null &&
        r.capture,
    );
  const runs = [...new Set(records.map((r) => r.run))].sort((a, b) => a - b);
  const summary = {};
  for (const cell of [...new Set(records.map((r) => r.cell))]) {
    const spec = WATER_CELLS[cell];
    const mine = records.filter((r) => r.cell === cell);
    const entry = {
      kind: spec.kind,
      notRun: mine
        .filter((r) => r.notRun !== null)
        .map((r) => `${r.variant}:${r.renderer}:run${r.run}: ${r.notRun}`),
      captures: mine
        .filter((r) => r.capture)
        .map((r) => ({
          variant: r.variant,
          renderer: r.renderer,
          run: r.run,
          path: r.capture.path,
          sha256: r.capture.sha256,
        })),
    };
    if (spec.kind === "mask-pair") {
      entry.waterDialsAbsent = [
        ...new Set(
          mine
            .filter((r) => r.variant === "on")
            .flatMap((r) => r.waterDialsAbsent ?? []),
        ),
      ];
      entry.effectPct = {};
      for (const renderer of ["webgl", "webgpu"]) {
        entry.effectPct[renderer] = runs.map((run) => {
          const on = find(cell, "on", renderer, run);
          const off = find(cell, "off", renderer, run);
          return on && off
            ? mismatchPct(
                image(off.capture),
                image(on.capture),
                WATER_BANDS.effectTolerance,
              )
            : null;
        });
      }
      // The effect measure's own noise: the OFF rig against itself, run 0 vs
      // run 1 on one renderer (null with a single run).
      entry.offRepeatPct = {};
      for (const renderer of ["webgl", "webgpu"]) {
        const first = find(cell, "off", renderer, runs[0]);
        const second =
          runs.length > 1 ? find(cell, "off", renderer, runs[1]) : null;
        entry.offRepeatPct[renderer] =
          first && second
            ? mismatchPct(
                image(first.capture),
                image(second.capture),
                WATER_BANDS.effectTolerance,
              )
            : null;
      }
      if (spec.waveEpochRepeat === true) {
        // 2g: the ON rig against itself, run 0 vs run 1 on one renderer, and
        // whether every ON page of those runs pinned the wave epoch.
        entry.waveEpochRepeat = {};
        const pair = runs.slice(0, 2);
        for (const renderer of ["webgl", "webgpu"]) {
          const pages = mine.filter(
            (r) =>
              r.variant === "on" &&
              r.renderer === renderer &&
              pair.includes(r.run),
          );
          if (pages.length === 0) {
            continue;
          }
          const first = find(cell, "on", renderer, pair[0]);
          const second =
            pair.length > 1 ? find(cell, "on", renderer, pair[1]) : null;
          // Each ON page that keeps 2g from being measured is named for its
          // own cause (A3-2): a page refused before it was staged has no
          // epoch readback at all; a staged page whose epoch did not apply
          // carries the readback's reason; a page whose epoch applied but
          // which was NOT RUN for another reason carries that page's reason.
          const refusedEarly = (r) =>
            r.waveEpoch === undefined && r.notRun !== null;
          const refusedBeforeStaging = pages
            .filter(refusedEarly)
            .map((r) => `run${r.run}: ${r.notRun}`);
          const notApplied = pages
            .filter((r) => !refusedEarly(r) && r.waveEpoch?.applied !== true)
            .map(
              (r) =>
                `run${r.run}: ${r.waveEpoch?.reason ?? (r.waveEpoch ? "applied: false" : "no wave-epoch readback")}`,
            );
          const pageNotRun = pages
            .filter((r) => r.waveEpoch?.applied === true && r.notRun !== null)
            .map((r) => `run${r.run}: ${r.notRun}`);
          entry.waveEpochRepeat[renderer] = {
            rig: spec.on,
            epoch: pages[0].waveEpoch?.requested ?? null,
            applied: notApplied.length === 0,
            notApplied,
            refusedBeforeStaging,
            pageNotRun,
            runsSeen: runs.length,
            capturedRuns: pages.filter((r) => r.notRun === null && r.capture)
              .length,
            repeatPct:
              first && second
                ? mismatchPct(
                    image(first.capture),
                    image(second.capture),
                    WATER_BANDS.mismatchTolerance,
                  )
                : null,
          };
        }
      }
      for (const variant of ["on", "off"]) {
        entry[`parity${variant === "on" ? "On" : "Off"}Pct`] = runs.map(
          (run) => {
            const gl = find(cell, variant, "webgl", run);
            const gpu = find(cell, variant, "webgpu", run);
            return gl && gpu
              ? mismatchPct(
                  image(gl.capture),
                  image(gpu.capture),
                  WATER_BANDS.mismatchTolerance,
                )
              : null;
          },
        );
      }
    } else {
      entry.repeatPct = {};
      for (const renderer of ["webgl", "webgpu"]) {
        const first = find(cell, "demo", renderer, runs[0]);
        const second =
          runs.length > 1 ? find(cell, "demo", renderer, runs[1]) : null;
        entry.repeatPct[renderer] =
          first && second
            ? mismatchPct(
                image(first.capture),
                image(second.capture),
                WATER_BANDS.mismatchTolerance,
              )
            : null;
      }
      entry.parityPct = runs.map((run) => {
        const gl = find(cell, "demo", "webgl", run);
        const gpu = find(cell, "demo", "webgpu", run);
        return gl && gpu
          ? mismatchPct(
              image(gl.capture),
              image(gpu.capture),
              WATER_BANDS.mismatchTolerance,
            )
          : null;
      });
      // The canvas sizes behind each parity term: two sizes have no pixel
      // diff, and the verdict names them instead of a null.
      const sizeOf = (capture) => {
        const decoded = image(capture);
        return decoded ? `${decoded.width}x${decoded.height}` : null;
      };
      entry.paritySizes = runs.map((run) => {
        const gl = find(cell, "demo", "webgl", run);
        const gpu = find(cell, "demo", "webgpu", run);
        return gl && gpu
          ? { webgl: sizeOf(gl.capture), webgpu: sizeOf(gpu.capture) }
          : null;
      });
    }
    summary[cell] = entry;
  }
  return summary;
}

/**
 * The run's verdicts. Pure but for `loadImage` (1f reads the base PNGs).
 *
 * @param {object[]} records This run set's page records.
 * @param {Record<string, object>} summary {@link summarizeWaterRecords} of them.
 * @param {Record<string, object>|null} baseSummary The BEFORE report's summary.
 * @param {{arm: string, runs?: number, loadImage?: Function}} context `runs`
 *   is the run count the arm asked for (`--runs`); without it 2g reads the
 *   number of runs in `records`.
 * @returns {Array<{id: string, pass: boolean}>}
 */
export function waterVerdicts(records, summary, baseSummary, context) {
  const loadImage = context.loadImage ?? readPng;
  const bands = WATER_BANDS;
  const verdicts = [];
  for (const record of records) {
    const id = `${record.cell}:${record.variant}:${record.renderer}:run${record.run}`;
    verdicts.push({
      id: `${id}:stage`,
      pass: record.notRun === null,
      notRun: record.notRun !== null,
      reason: record.notRun ?? undefined,
    });
    if (record.gate) {
      const faultFree =
        !record.gate.deviceLost &&
        record.gate.errorCount === 0 &&
        record.gate.pageErrorCount === 0;
      // Zero faults from a gate nobody read, or from a WebGPU page whose
      // error gate armed no device, is no measurement: the gate could not
      // have reported one. A fault that WAS measured (a page error) fails.
      const notRead = typeof record.gate.notRead === "string";
      const unarmed =
        !notRead &&
        record.renderer === "webgpu" &&
        !(record.gate.armedDevices >= 1);
      verdicts.push({
        id: `${id}:2e-no-device-fault`,
        pass: faultFree && !unarmed && !notRead,
        ...(faultFree &&
          notRead && {
            notRun: true,
            reason: `gate not read (${record.gate.notRead})`,
            ...(record.refusal && { refusal: record.refusal }),
          }),
        ...(faultFree &&
          unarmed && { notRun: true, reason: "error gate not armed" }),
        gate: record.gate,
      });
    }
  }
  for (const [cell, entry] of Object.entries(summary)) {
    const spec = WATER_CELLS[cell];
    if (context.arm === "after" && baseSummary && !baseSummary[cell]) {
      // A base report that never measured this cell cannot judge it.
      verdicts.push({
        id: `${cell}:base-absent`,
        pass: false,
        notRun: true,
      });
    }
    if (spec.kind === "mask-pair") {
      const judged =
        context.arm === "after" && entry.waterDialsAbsent.length === 0;
      if (judged && typeof spec.effectCeilingOverOffRepeatPp === "number") {
        // 2f: the effect must stay inside the OFF rig's own repeat noise.
        for (const renderer of ["webgl", "webgpu"]) {
          const value = median(entry.effectPct[renderer]);
          const ceiling =
            (entry.offRepeatPct?.[renderer] ?? 0) +
            spec.effectCeilingOverOffRepeatPp;
          verdicts.push({
            id: `${cell}:2f-effect-ceiling:${renderer}`,
            pass: value !== null && value <= ceiling,
            effectPct: value,
            offRepeatPct: entry.offRepeatPct?.[renderer] ?? null,
            ceilingPct: ceiling,
          });
        }
      }
      if (judged && typeof spec.effectFloorPct === "number") {
        const gl = median(entry.effectPct.webgl);
        const gpu = median(entry.effectPct.webgpu);
        const allowed =
          gl === null || gpu === null
            ? null
            : Math.max(
                bands.effectAgreementRelative * Math.max(gl, gpu),
                bands.effectAgreementAbsolutePp,
              );
        verdicts.push({
          id: `${cell}:2b-effect-agreement`,
          pass: allowed !== null && Math.abs(gl - gpu) <= allowed,
          webglPct: gl,
          webgpuPct: gpu,
          allowedPp: allowed,
        });
        for (const [renderer, value] of [
          ["webgl", gl],
          ["webgpu", gpu],
        ]) {
          verdicts.push({
            id: `${cell}:2c-effect-floor:${renderer}`,
            pass: value !== null && value >= spec.effectFloorPct,
            effectPct: value,
            floorPct: spec.effectFloorPct,
          });
        }
      }
      const base = baseSummary?.[cell];
      if (context.arm === "after" && base) {
        const after = median(entry.parityOnPct);
        const before = median(base.parityOnPct ?? []);
        const spread = range(entry.parityOnPct) ?? 0;
        const bound =
          before === null
            ? null
            : before +
              bands.parityAllowancePp +
              bands.parityRepeatMultiplier * spread;
        verdicts.push({
          id: `${cell}:2a-parity`,
          pass: after !== null && bound !== null && after <= bound,
          afterPct: after,
          beforePct: before,
          allowancePp: bands.parityAllowancePp,
          afterRepeatSpreadPp: spread,
          boundPct: bound,
        });
      }
    } else if (context.arm === "after" && baseSummary?.[cell]) {
      const base = baseSummary[cell];
      const firstOf = (captures, renderer) =>
        captures
          .filter((c) => c.renderer === renderer)
          .sort((a, b) => a.run - b.run)[0] ?? null;
      for (const renderer of ["webgl", "webgpu"]) {
        const tip = firstOf(entry.captures, renderer);
        const was = firstOf(base.captures ?? [], renderer);
        const spread = Math.max(
          entry.repeatPct?.[renderer] ?? 0,
          base.repeatPct?.[renderer] ?? 0,
        );
        const band = Math.max(
          bands.demoFloorPp,
          bands.demoRepeatMultiplier * spread,
        );
        const moved =
          tip && was
            ? mismatchPct(
                loadImage(was.path),
                loadImage(tip.path),
                bands.mismatchTolerance,
              )
            : null;
        verdicts.push({
          id: `${cell}:after-vs-before:${renderer}`,
          pass: moved !== null && moved <= band,
          notRun: moved === null,
          mismatchPct: moved,
          bandPp: band,
        });
      }
      const afterParity = median(entry.parityPct ?? []);
      const beforeParity = median(base.parityPct ?? []);
      const spread = Math.max(
        entry.repeatPct?.webgl ?? 0,
        entry.repeatPct?.webgpu ?? 0,
        base.repeatPct?.webgl ?? 0,
        base.repeatPct?.webgpu ?? 0,
      );
      const band = Math.max(
        bands.demoFloorPp,
        bands.demoRepeatMultiplier * spread,
      );
      if (afterParity === null || beforeParity === null) {
        // No parity on a side is no measurement: NOT RUN, with why. A base
        // report written before `paritySizes` existed gives its sizes from
        // its captures.
        const beforeSizes =
          base.paritySizes ?? demoCaptureSizes(base.captures, loadImage);
        verdicts.push({
          id: `${cell}:parity-as-before`,
          pass: false,
          notRun: true,
          reason: parityNotMeasured(
            afterParity === null ? entry.paritySizes : null,
            beforeParity === null ? beforeSizes : null,
            afterParity === null,
            beforeParity === null,
          ),
          afterPct: afterParity,
          beforePct: beforeParity,
          bandPp: band,
          sizes: {
            after: entry.paritySizes ?? null,
            before: beforeSizes ?? null,
          },
        });
      } else {
        verdicts.push({
          id: `${cell}:parity-as-before`,
          pass: Math.abs(afterParity - beforeParity) <= band,
          afterPct: afterParity,
          beforePct: beforeParity,
          bandPp: band,
        });
      }
    }
    if (context.arm === "after" && spec.waveEpochRepeat === true) {
      for (const [renderer, repeat] of Object.entries(
        entry.waveEpochRepeat ?? {},
      )) {
        const common = {
          id: `${cell}:2g-wave-epoch-repeat:${renderer}`,
          rig: repeat.rig,
          renderer,
          epoch: repeat.epoch,
          repeatPct: repeat.repeatPct,
          bandPp: bands.waveEpochRepeatPp,
        };
        // Every page-level cause is named (A3-2); the run count is the
        // reason only when no page names one.
        const causes = [];
        if (!repeat.applied) {
          causes.push(
            `${WAVE_EPOCH_DIAL} applied: false (${repeat.notApplied.join("; ")})`,
          );
        }
        if ((repeat.refusedBeforeStaging ?? []).length > 0) {
          causes.push(
            `page refused before staging (${repeat.refusedBeforeStaging.join("; ")})`,
          );
        }
        if ((repeat.pageNotRun ?? []).length > 0) {
          causes.push(`ON page NOT RUN (${repeat.pageNotRun.join("; ")})`);
        }
        const requestedRuns = Number.isInteger(context.runs)
          ? context.runs
          : (repeat.runsSeen ?? 0);
        if (causes.length > 0) {
          verdicts.push({
            ...common,
            pass: false,
            notRun: true,
            reason: causes.join("; "),
          });
        } else if (repeat.repeatPct === null) {
          verdicts.push({
            ...common,
            pass: false,
            notRun: true,
            reason:
              requestedRuns >= 2
                ? `2g needs two captured ON runs at the pinned epoch (--runs ${requestedRuns}, ${repeat.capturedRuns ?? 0} captured)`
                : `2g needs --runs 2 or more (this arm ran ${requestedRuns})`,
          });
        } else {
          verdicts.push({
            ...common,
            pass: repeat.repeatPct <= bands.waveEpochRepeatPp,
          });
        }
      }
    }
  }
  return verdicts;
}
