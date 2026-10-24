/**
 * PF-4, GPU memory residency from the in-page device census, and its base-
 * against-tip reading: no more than the declared allocation, and no growth
 * across a steady-state window.
 * @purpose PF-4 for the R-2026-10-22-3 performance leg: reduces lib/gpu-device-census.mjs snapshots to live texture and buffer bytes, measures growth between the snapshots that open and close a settled window, and reads base vs tip (tip live bytes <= base + the unit's declared allocation; every tip window's growth no larger than the largest base growth plus the base arm's growth spread, base growths clamped at 0 first, so one leaking repeat fails; a window with no census read makes the verdict unmeasured, never dropped).
 * @status ACTIVE
 *
 * WHAT THE BYTES ARE. The census estimates each texture from its descriptor
 * (size, format, mip chain, sample count, array layers) and takes each buffer
 * at its declared size, adds on creation and subtracts on `destroy()`. It is
 * the plan's stand-in "until 3528's `WebGPUCloudMemoryUsage` lands (W8b)": a
 * kit-side count of `createTexture` / `createBuffer` sizes. It does not see
 * driver padding, and a texture whose format it cannot size is counted under
 * `unknownSize` and left out of the bytes; both are reported, so an estimate is
 * never read as a measurement of the driver.
 *
 * THE ALLOCATION RULE. A wave brief declares how many bytes each unit is
 * allowed to add (`bands.allocationBytes`, default 0). The arm value is the
 * median, across same-build repeats, of the live bytes at the END of the
 * window; within when tip <= base + allocation. PF-4's arithmetic is additive,
 * not relative, so the repeat-spread band of PF-1/PF-2 does not apply.
 *
 * THE GROWTH RULE ("growth 0 within the repeat spread"). Each run's growth is
 * end minus start over the steady window. Every base growth is first clamped
 * at 0; within when every tip run's growth is no larger than the largest
 * clamped base growth plus the spread of the clamped base growths (max - min).
 * A scene whose base also grows is not made worse by a tip that grows by the
 * same. The clamp is the seat's ruling on Ettenmoors pass 2, N-3: a base
 * window that FREES memory (an eviction inside the window) is not noise that
 * buys the tip leak room, so base [-50 MB, 0] allows the tip 0, not 50 MB.
 * The spread is the base arm's, as PF-1/PF-2 size their band by the base arm
 * (perf-band.mjs): an allowance widened by the tip's OWN spread reduced the
 * rule to "the tip's best repeat did not grow", so a tip on which one of N
 * repeats leaked passed (Ettenmoors pass 1, D1). Now that repeat fails.
 *
 * A MISSING READ IS NOT DROPPED (pass 2, N-4; the D4 rule of startup-compile).
 * A window whose census read is missing (no run, a page without the census, a
 * snapshot without bytes) has no end bytes and no growth. It is listed in
 * `missingWindows` and its reasons, and it makes that statistic `unmeasured`
 * unless the windows that were read already read `over`: a run that failed to
 * report can never turn a leak into a pass, nor a gap into a `within`.
 *
 * @module Tools/visual-regression/lib/metrics/gpu-memory-residency
 */

import {
  PERF_VERDICTS,
  finiteValues,
  median,
  resolveBands,
  worstVerdict,
} from "./perf-band.mjs";

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const kindBytes = (kind) =>
  isFiniteNumber(kind?.liveBytes) ? kind.liveBytes : null;

/**
 * One census snapshot's residency.
 *
 * @param {unknown} snapshot A `readGpuDeviceCensus` result.
 * @returns {{installed: boolean, liveBytes: number|null,
 *   textureLiveBytes: number|null, bufferLiveBytes: number|null,
 *   liveTextures: number|null, liveBuffers: number|null,
 *   unknownSize: number}} Bytes are null when the census was not installed
 *   (a page without WebGPU), never 0.
 */
export function summarizeResidency(snapshot) {
  if (snapshot?.installed !== true) {
    return {
      installed: false,
      liveBytes: null,
      textureLiveBytes: null,
      bufferLiveBytes: null,
      liveTextures: null,
      liveBuffers: null,
      unknownSize: 0,
    };
  }
  const textureLiveBytes = kindBytes(snapshot.textures);
  const bufferLiveBytes = kindBytes(snapshot.buffers);
  const liveCount = (kind) =>
    isFiniteNumber(kind?.created) && isFiniteNumber(kind?.destroyed)
      ? kind.created - kind.destroyed - (kind.freedByDevice ?? 0)
      : null;
  return {
    installed: true,
    liveBytes:
      textureLiveBytes === null || bufferLiveBytes === null
        ? null
        : textureLiveBytes + bufferLiveBytes,
    textureLiveBytes,
    bufferLiveBytes,
    liveTextures: liveCount(snapshot.textures),
    liveBuffers: liveCount(snapshot.buffers),
    unknownSize:
      (snapshot.textures?.unknownSize ?? 0) +
      (snapshot.buffers?.unknownSize ?? 0),
  };
}

/**
 * Growth across a window: end minus start, in total and by kind.
 *
 * @param {unknown} start The snapshot that opens the window.
 * @param {unknown} end The snapshot that closes it.
 * @returns {{growthBytes: number|null, textureGrowthBytes: number|null,
 *   bufferGrowthBytes: number|null, start: object, end: object}}
 */
export function residencyGrowth(start, end) {
  const a = summarizeResidency(start);
  const b = summarizeResidency(end);
  const delta = (x, y) => (x === null || y === null ? null : y - x);
  return {
    growthBytes: delta(a.liveBytes, b.liveBytes),
    textureGrowthBytes: delta(a.textureLiveBytes, b.textureLiveBytes),
    bufferGrowthBytes: delta(a.bufferLiveBytes, b.bufferLiveBytes),
    start: a,
    end: b,
  };
}

/**
 * PF-4, base arm against tip arm.
 *
 * @param {object} input
 * @param {Array<{start: unknown, end: unknown}>} input.baseRuns One window per
 *   base repeat.
 * @param {Array<{start: unknown, end: unknown}>} input.tipRuns One per tip
 *   repeat.
 * @param {object} [input.bands] Pre-registered band overrides; PF-4 reads
 *   `allocationBytes`.
 * @returns {{metric: "PF-4", verdict: string, residency: object,
 *   growth: object, runs: {base: object[], tip: object[]}}}
 */
export function residencyVerdict({ baseRuns, tipRuns, bands }) {
  const resolved = resolveBands(bands);
  const windows = (runs) =>
    (Array.isArray(runs) ? runs : []).map((run) =>
      residencyGrowth(run?.start, run?.end),
    );
  const base = windows(baseRuns);
  const tip = windows(tipRuns);
  // N-4: a window with no census read is named, never filtered away.
  const unread = (pick) => [
    ...base.flatMap((run, index) =>
      pick(run) === null ? [`base window ${index}`] : [],
    ),
    ...tip.flatMap((run, index) =>
      pick(run) === null ? [`tip window ${index}`] : [],
    ),
  ];
  const markUnread = (record, labels) => {
    record.missingWindows = labels;
    if (labels.length > 0 && record.verdict !== PERF_VERDICTS.OVER) {
      record.verdict = PERF_VERDICTS.UNMEASURED;
    }
    for (const label of labels) {
      record.reasons.push(`${label} has no census read of ${record.statistic}`);
    }
  };

  const baseLive = median(base.map((run) => run.end.liveBytes));
  const tipLive = median(tip.map((run) => run.end.liveBytes));
  const residency = {
    metric: "PF-4",
    statistic: "liveBytes",
    verdict: PERF_VERDICTS.UNMEASURED,
    base: baseLive,
    tip: tipLive,
    allocationBytes: resolved.allocationBytes,
    limit: null,
    reasons: [],
  };
  if (baseLive === null || tipLive === null) {
    residency.reasons.push(
      "no installed census at the end of a window on one of the arms",
    );
  } else {
    residency.limit = baseLive + resolved.allocationBytes;
    residency.verdict =
      tipLive <= residency.limit ? PERF_VERDICTS.WITHIN : PERF_VERDICTS.OVER;
    if (residency.verdict === PERF_VERDICTS.OVER) {
      residency.reasons.push(
        `tip ${tipLive} B exceeds base ${baseLive} B + declared ${resolved.allocationBytes} B`,
      );
    }
  }
  markUnread(
    residency,
    unread((run) => run.end.liveBytes),
  );

  const baseGrowths = finiteValues(base.map((run) => run.growthBytes));
  const tipGrowths = finiteValues(tip.map((run) => run.growthBytes));
  const growth = {
    metric: "PF-4",
    statistic: "growthBytes",
    verdict: PERF_VERDICTS.UNMEASURED,
    base: baseGrowths,
    tip: tipGrowths,
    allowance: null,
    reasons: [],
  };
  if (baseGrowths.length === 0 || tipGrowths.length === 0) {
    growth.reasons.push("no measured window on one of the arms");
  } else {
    // N-3 (seat ruling): clamp before the largest AND the spread.
    const clampedBase = baseGrowths.map((value) => (value < 0 ? 0 : value));
    const baseSpread = Math.max(...clampedBase) - Math.min(...clampedBase);
    growth.baseClamped = clampedBase;
    growth.baseSpread = baseSpread;
    growth.allowance = Math.max(...clampedBase) + baseSpread;
    const worst = Math.max(...tipGrowths);
    growth.verdict =
      worst <= growth.allowance ? PERF_VERDICTS.WITHIN : PERF_VERDICTS.OVER;
    if (growth.verdict === PERF_VERDICTS.OVER) {
      growth.reasons.push(
        `a tip window grew ${worst} B, over the allowance ${growth.allowance} B`,
      );
    }
  }
  markUnread(
    growth,
    unread((run) => run.growthBytes),
  );

  return {
    metric: "PF-4",
    verdict: worstVerdict([residency, growth]),
    residency,
    growth,
    runs: { base, tip },
  };
}
