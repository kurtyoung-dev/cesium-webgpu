// aec-residency-e2.mjs — the pure half of the E-2 residency instrument.
//
// @purpose Pure trace-clock bridging, GPU-process frame-gap overlap summarisation, shader-module census arithmetic, animation-frame gap derivation and control-matrix construction for the E-2 AEC residency measurement.
// @status ACTIVE
//
// WHY THIS EXISTS. The E-1 measurement placed the settle-window wait BELOW the
// renderer's main thread: across the dominant inter-frame gaps the wall-clock
// poll kept its cadence, no animation frame was delivered and no pipeline
// creation settled. Two things that cannot stop each other stopped together,
// which puts the occupant somewhere neither the CPU sampler nor the engine's
// own counters can see. E-1's instrument cannot go there; a browser-process
// trace can.
//
// This module is everything that measurement needs which runs WITHOUT a
// browser, so the arithmetic that turns a trace into an attribution can be
// pinned by a hermetic spec instead of only by a run that costs a hundred
// seconds of Edge time to observe once.
//
// THE CLOCK IS THE WHOLE PROBLEM, AND IT IS NOT ASSUMED. A Chrome trace stamps
// events on the browser's own monotonic clock; the frame gaps are stamped on
// the page's `performance.now()`. Nothing relates the two by construction. So
// the probe drops CDP clock-sync markers at known page timestamps and
// `buildTraceClockBridge` recovers the affine relation from them — and when it
// cannot recover it, or when a second marker disagrees with the first, it
// returns `bridged: false` and every overlap summary below REFUSES to attribute
// anything. An unbridged trace produces no attribution rather than a plausible
// one.
//
// WHAT AN OVERLAP MEANS, AND WHAT IT DOES NOT. `summarizeGapTraceOverlap`
// reports, per frame gap, which GPU-process trace events covered it and for how
// long. Overlap is co-occurrence: an event that spans a gap is a candidate
// occupant, never a proven cause. The summary is deliberately a ranked list
// rather than a verdict, because naming a cause from co-occurrence is the
// inference this row has already been burned by twice.

import { median } from "./aec-residency-stall-locus.mjs";

/** Frozen thresholds every reading below is taken against. */
export const E2_THRESHOLDS = Object.freeze({
  /** Frame gaps at least this long are the windows a trace is asked about. */
  reportGapMs: 1000,
  /** Clock-sync anchors needed before a bridge is trusted. */
  minimumClockSyncAnchors: 2,
  /**
   * How far a later anchor may fall from the offset the first one implies. A
   * few milliseconds is the CDP round trip; anything approaching this bound
   * means the two stamps are not the same clock and the bridge is refused.
   */
  maxClockSyncResidualMs: 250,
  /** How many event names each gap's summary carries. */
  topEventsPerGap: 12,
});

/**
 * The trace categories this measurement asks for.
 *
 * `gpu` and `disabled-by-default-gpu.device` are the GPU process's own service
 * and device timelines — where a wait that is invisible to the renderer has to
 * live. `viz` carries frame submission and presentation, which is what stops
 * when animation frames stop arriving. `toplevel` gives every process's task
 * boundaries, so a gap covered by no named work is still distinguishable from
 * a gap the trace simply did not sample.
 */
export const E2_TRACE_CATEGORIES = Object.freeze([
  "gpu",
  "viz",
  "disabled-by-default-gpu.device",
  "toplevel",
]);

/**
 * The controls, each a SEPARATE page load timed to the same readiness gate.
 *
 * Every control differs from the baseline along exactly one dimension, and the
 * dimensions are disjoint, so a settle time that moves names which dimension
 * moved it. A post-settle ablation would answer a different question — it can
 * only show what a warmed scene costs to keep, never what a cold one cost to
 * reach — which is why each of these is its own load.
 *
 * `pageConfig` is handed straight to the shared page-module builder, so a
 * control cannot silently disagree with the scene the baseline measured.
 */
export const E2_CONTROLS = Object.freeze({
  baseline: Object.freeze({
    name: "baseline",
    dimension: null,
    description:
      "the demo's own scene, unchanged: eight tilesets, ambient occlusion on, globe warm as shipped",
    pageConfig: Object.freeze({}),
    tilesetLimit: null,
  }),
  "no-globe-prewarm": Object.freeze({
    name: "no-globe-prewarm",
    dimension: "globe-prewarm",
    description:
      "declines the init-time globe renderer warm, which compiles the terrain WGSL for a scene created with no globe",
    pageConfig: Object.freeze({
      contextOptions: Object.freeze({ prewarmGlobeRenderer: false }),
    }),
    tilesetLimit: null,
  }),
  "ao-off": Object.freeze({
    name: "ao-off",
    dimension: "ambient-occlusion",
    description:
      "leaves the ambient occlusion stage at its default rather than enabling it",
    pageConfig: Object.freeze({ ambientOcclusion: false }),
    tilesetLimit: null,
  }),
  "one-tileset": Object.freeze({
    name: "one-tileset",
    dimension: "tileset-count",
    description:
      "loads the demo's first tileset alone instead of all eight, keeping its clipping polygon",
    pageConfig: Object.freeze({}),
    tilesetLimit: 1,
  }),
});

/** The control names, baseline first, in the order a run executes them. */
export const E2_CONTROL_ORDER = Object.freeze([
  "baseline",
  "no-globe-prewarm",
  "ao-off",
  "one-tileset",
]);

/**
 * Resolve a control name into the page configuration and tileset list a leg
 * should load.
 *
 * @param {string} name A key of {@link E2_CONTROLS}.
 * @param {ReadonlyArray<object>} tilesets The full tileset list.
 * @returns {{name: string, dimension: string|null, description: string,
 *   pageConfig: object, tilesets: object[]}} The resolved control.
 */
export function resolveControl(name, tilesets) {
  const control = E2_CONTROLS[name];
  if (control === undefined) {
    throw new TypeError(`unknown control: ${name}`);
  }
  const all = Array.isArray(tilesets) ? tilesets : [];
  return {
    name: control.name,
    dimension: control.dimension,
    description: control.description,
    pageConfig: control.pageConfig,
    tilesets:
      control.tilesetLimit === null
        ? [...all]
        : all.slice(0, control.tilesetLimit),
  };
}

/**
 * Map trace process ids to the names the trace's own metadata gives them.
 *
 * @param {ReadonlyArray<object>} traceEvents Raw trace events.
 * @returns {Map<number, string>} pid to process name.
 */
export function identifyTraceProcesses(traceEvents) {
  const names = new Map();
  for (const event of traceEvents ?? []) {
    if (event?.ph === "M" && event?.name === "process_name") {
      const name = event?.args?.name;
      if (typeof name === "string" && Number.isFinite(event.pid)) {
        names.set(event.pid, name);
      }
    }
  }
  return names;
}

/**
 * The process ids whose name matches a role.
 *
 * @param {Map<number, string>} processNames From {@link identifyTraceProcesses}.
 * @param {string} role Substring matched case-insensitively, e.g. `"gpu"`.
 * @returns {number[]} Matching pids.
 */
export function pidsForRole(processNames, role) {
  const needle = String(role).toLowerCase();
  const pids = [];
  for (const [pid, name] of processNames) {
    if (name.toLowerCase().includes(needle)) {
      pids.push(pid);
    }
  }
  return pids.sort((left, right) => left - right);
}

/**
 * Recover the affine relation between the trace clock and the page clock from
 * the clock-sync markers the probe dropped at known page timestamps.
 *
 * Both clocks tick real time, so the relation is an offset and the second
 * anchor is a CHECK on the first rather than a second unknown. A residual
 * beyond the threshold means the two stamps are not the same clock at all, and
 * the bridge is refused: a wrong offset would silently attribute a gap to
 * whatever happened somewhere else entirely.
 *
 * @param {ReadonlyArray<object>} traceEvents Raw trace events.
 * @param {ReadonlyArray<{syncId: string, pageMs: number}>} anchors The markers
 *   the probe requested, with the page timestamp of each request.
 * @param {object} [thresholds] Overrides for {@link E2_THRESHOLDS}.
 * @returns {{bridged: boolean, traceOriginMs: number|null, anchorsRequested: number,
 *   anchorsFound: number, maxResidualMs: number|null, reason: string|null}} The bridge.
 */
export function buildTraceClockBridge(traceEvents, anchors, thresholds = {}) {
  const minimumAnchors =
    thresholds.minimumClockSyncAnchors ?? E2_THRESHOLDS.minimumClockSyncAnchors;
  const maxResidual =
    thresholds.maxClockSyncResidualMs ?? E2_THRESHOLDS.maxClockSyncResidualMs;
  const requested = Array.isArray(anchors) ? anchors : [];

  const stampBySyncId = new Map();
  for (const event of traceEvents ?? []) {
    if (event?.name !== "clock_sync") {
      continue;
    }
    const syncId = event?.args?.sync_id ?? event?.args?.syncId;
    const ts = Number(event?.ts);
    if (typeof syncId === "string" && Number.isFinite(ts)) {
      stampBySyncId.set(syncId, ts / 1000);
    }
  }

  const matched = [];
  for (const anchor of requested) {
    const traceMs = stampBySyncId.get(anchor?.syncId);
    if (traceMs !== undefined && Number.isFinite(Number(anchor?.pageMs))) {
      matched.push({ traceMs, pageMs: Number(anchor.pageMs) });
    }
  }
  matched.sort((left, right) => left.pageMs - right.pageMs);

  const base = {
    anchorsRequested: requested.length,
    anchorsFound: matched.length,
  };
  if (matched.length < minimumAnchors) {
    return {
      ...base,
      bridged: false,
      traceOriginMs: null,
      maxResidualMs: null,
      reason:
        matched.length === 0
          ? "no-clock-sync-marker-in-trace"
          : "too-few-clock-sync-anchors",
    };
  }

  const traceOriginMs = matched[0].traceMs - matched[0].pageMs;
  let worst = 0;
  for (const anchor of matched.slice(1)) {
    const residual = Math.abs(anchor.traceMs - traceOriginMs - anchor.pageMs);
    if (residual > worst) {
      worst = residual;
    }
  }
  if (worst > maxResidual) {
    return {
      ...base,
      bridged: false,
      traceOriginMs: null,
      maxResidualMs: worst,
      reason: "clock-sync-anchors-disagree",
    };
  }
  return {
    ...base,
    bridged: true,
    traceOriginMs,
    maxResidualMs: worst,
    reason: null,
  };
}

/**
 * Turn raw trace events into intervals on the PAGE clock.
 *
 * Complete events carry their own duration. Begin/end pairs are matched per
 * thread through a stack, which is the only correct pairing when they nest.
 * Every phase this cannot interpret is counted rather than dropped silently,
 * because a summary computed over a fraction of the trace must say what
 * fraction that was.
 *
 * @param {ReadonlyArray<object>} traceEvents Raw trace events.
 * @param {{traceOriginMs: number}} bridge A bridged clock relation.
 * @param {ReadonlyArray<number>|null} pids Restrict to these process ids.
 * @returns {{intervals: object[], unpairedEnds: number, unclosedBegins: number,
 *   skippedPhases: Record<string, number>}} The intervals and the coverage.
 */
export function traceIntervalsOnPageClock(traceEvents, bridge, pids = null) {
  const allow = pids === null ? null : new Set(pids);
  const intervals = [];
  const stacks = new Map();
  const skippedPhases = {};
  let unpairedEnds = 0;

  for (const event of traceEvents ?? []) {
    if (allow !== null && !allow.has(event?.pid)) {
      continue;
    }
    const ts = Number(event?.ts);
    if (!Number.isFinite(ts)) {
      continue;
    }
    const startMs = ts / 1000 - bridge.traceOriginMs;
    if (event.ph === "X") {
      const durMs = Number(event.dur ?? 0) / 1000;
      intervals.push({
        name: String(event.name ?? "(unnamed)"),
        cat: String(event.cat ?? ""),
        pid: event.pid,
        startMs,
        endMs: startMs + (Number.isFinite(durMs) ? durMs : 0),
      });
      continue;
    }
    if (event.ph === "B") {
      const key = `${event.pid}:${event.tid}`;
      const stack = stacks.get(key) ?? [];
      stack.push({
        name: String(event.name ?? "(unnamed)"),
        cat: String(event.cat ?? ""),
        pid: event.pid,
        startMs,
      });
      stacks.set(key, stack);
      continue;
    }
    if (event.ph === "E") {
      const key = `${event.pid}:${event.tid}`;
      const stack = stacks.get(key);
      const open = stack?.pop();
      if (open === undefined) {
        unpairedEnds++;
        continue;
      }
      intervals.push({ ...open, endMs: startMs });
      continue;
    }
    const phase = String(event.ph ?? "?");
    skippedPhases[phase] = (skippedPhases[phase] ?? 0) + 1;
  }

  let unclosedBegins = 0;
  for (const stack of stacks.values()) {
    unclosedBegins += stack.length;
  }
  return { intervals, unpairedEnds, unclosedBegins, skippedPhases };
}

/**
 * Rank, for each frame gap, the trace events that covered it.
 *
 * The ranking is by summed overlap, not by count: one 30-second event and
 * thirty one-second events are different findings and a count would report
 * them the same way.
 *
 * @param {object} input The trace, the gaps and the bridge.
 * @param {ReadonlyArray<object>} input.traceEvents Raw trace events.
 * @param {ReadonlyArray<{startMs: number, endMs: number, durationMs: number}>} input.gaps
 *   Frame gaps on the page clock.
 * @param {object} input.bridge From {@link buildTraceClockBridge}.
 * @param {string} [input.role] Process role to restrict to; null for all.
 * @param {object} [input.thresholds] Overrides for {@link E2_THRESHOLDS}.
 * @returns {object} The per-gap attribution, or a refusal.
 */
export function summarizeGapTraceOverlap({
  traceEvents,
  gaps,
  bridge,
  role = "gpu",
  thresholds = {},
}) {
  const topN = thresholds.topEventsPerGap ?? E2_THRESHOLDS.topEventsPerGap;
  const events = Array.isArray(traceEvents) ? traceEvents : [];
  const windows = Array.isArray(gaps) ? gaps : [];

  if (!bridge || bridge.bridged !== true) {
    return {
      attributed: false,
      reason: bridge?.reason ?? "clock-bridge-missing",
      gaps: [],
      processNames: {},
    };
  }
  const processNames = identifyTraceProcesses(events);
  const pids = role === null ? null : pidsForRole(processNames, role);
  if (pids !== null && pids.length === 0) {
    return {
      attributed: false,
      reason: `process-role-not-identified:${role}`,
      gaps: [],
      processNames: Object.fromEntries(processNames),
    };
  }

  const { intervals, unpairedEnds, unclosedBegins, skippedPhases } =
    traceIntervalsOnPageClock(events, bridge, pids);

  const rows = windows.map((gap, index) => {
    const start = Number(gap?.startMs);
    const end = Number(gap?.endMs);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return {
        gapIndex: index,
        gapMs: Number(gap?.durationMs) || 0,
        attributed: false,
        reason: "gap-bounds-unusable",
        totalOverlapMs: 0,
        overlappedEventCount: 0,
        topEvents: [],
      };
    }
    const byName = new Map();
    let total = 0;
    let count = 0;
    for (const interval of intervals) {
      const overlap =
        Math.min(interval.endMs, end) - Math.max(interval.startMs, start);
      if (!(overlap > 0)) {
        continue;
      }
      total += overlap;
      count++;
      const key = `${interval.name}\u0000${interval.cat}`;
      const row = byName.get(key) ?? {
        name: interval.name,
        cat: interval.cat,
        count: 0,
        overlapMs: 0,
      };
      row.count++;
      row.overlapMs += overlap;
      byName.set(key, row);
    }
    const topEvents = [...byName.values()]
      .sort((left, right) => right.overlapMs - left.overlapMs)
      .slice(0, topN)
      .map((row) => ({
        name: row.name,
        cat: row.cat,
        count: row.count,
        overlapMs: Math.round(row.overlapMs),
        gapCoverage: Math.min(1, row.overlapMs / (end - start)),
      }));
    return {
      gapIndex: index,
      gapMs: Math.round(end - start),
      attributed: true,
      reason: null,
      totalOverlapMs: Math.round(total),
      overlappedEventCount: count,
      topEvents,
    };
  });

  return {
    attributed: true,
    reason: null,
    role,
    pids,
    processNames: Object.fromEntries(processNames),
    coverage: { unpairedEnds, unclosedBegins, skippedPhases },
    intervalCount: intervals.length,
    gaps: rows,
  };
}

/**
 * Combine the page's device-level compile log with the engine's own per-device
 * census.
 *
 * The two answer different halves. The engine census counts every compile that
 * went through the shader-module cache, including the ones that happened
 * during context initialization before any page code could observe them. The
 * page wrap counts every compile the device received after it was installed,
 * including the ones that bypass the cache entirely. Reported together, their
 * difference is the traffic that bypassed the cache — which is why neither is
 * reported alone.
 *
 * `null` is used wherever a reading is unavailable, never zero: "the census was
 * absent" and "nothing compiled" are opposite findings.
 *
 * TWO WINDOWS, NOT ONE. The wrap is installed once `Viewer.createAsync` has
 * resolved, and the first frame gap can open seconds after that, so a reading
 * taken from the wrap's log alone omits every compile the context init
 * performed — the globe warm's terrain WGSL among them.
 * `compilesBeforeFirstGap` and `bytesBeforeFirstGap` therefore answer for the
 * POST-WRAP window only, and `compilesBeforeFirstGapIncludingPreWrap` adds the
 * engine census taken at install to them. The combined figure is still a LOWER
 * BOUND: its pre-wrap half is cache-routed only, so a compile that both
 * preceded the wrap and bypassed the cache is in neither reading and cannot be
 * recovered here.
 *
 * @param {object} input The two sources plus the first gap's start.
 * @param {ReadonlyArray<{atMs: number, bytes: number}>} input.deviceCompiles
 *   Compiles observed by the page-side device wrap.
 * @param {object|null} input.censusAtInstall Engine census when the wrap was installed.
 * @param {object|null} input.censusFinal Engine census at the end of the window.
 * @param {number|null} input.firstGapStartMs Page time the first reported gap opened.
 * @returns {object} The census summary.
 */
export function summarizeShaderModuleCensus({
  deviceCompiles,
  censusAtInstall,
  censusFinal,
  firstGapStartMs,
}) {
  // `Number(null)` is 0 and `Number(null)` is finite, so coercing before
  // testing turns "this reading is absent" into "this reading is zero" —
  // which is the exact confusion the null-versus-zero discipline below exists
  // to prevent. Every numeric field is therefore checked as a number first.
  const asNumber = (value) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

  const compiles = (Array.isArray(deviceCompiles) ? deviceCompiles : []).filter(
    (entry) =>
      asNumber(entry?.atMs) !== null && asNumber(entry?.bytes) !== null,
  );
  const boundaryMs = asNumber(firstGapStartMs);
  const before =
    boundaryMs === null
      ? null
      : compiles.filter((entry) => entry.atMs <= boundaryMs);
  const sumBytes = (rows) =>
    rows.reduce((total, entry) => total + entry.bytes, 0);

  const preWrapCompiles = asNumber(censusAtInstall?.modulesCreated);
  const preWrapBytes = asNumber(censusAtInstall?.wgslBytes);

  const viaCacheDuringWrap =
    censusAtInstall && censusFinal
      ? censusFinal.modulesCreated - censusAtInstall.modulesCreated
      : null;
  const viaCacheBytesDuringWrap =
    censusAtInstall && censusFinal
      ? censusFinal.wgslBytes - censusAtInstall.wgslBytes
      : null;

  return {
    wrapInstalled: compiles.length > 0 || censusAtInstall !== null,
    compilesObserved: compiles.length,
    bytesObserved: sumBytes(compiles),
    largestObservedBytes: compiles.reduce(
      (largest, entry) => Math.max(largest, entry.bytes),
      0,
    ),
    firstGapStartMs: boundaryMs,
    // POST-WRAP window only. The row's question is about everything the device
    // was handed before the first gap opened, and the wrap did not exist for
    // the first seconds of that window; the combined pair below is the reading
    // that answers it.
    compilesBeforeFirstGap: before === null ? null : before.length,
    bytesBeforeFirstGap: before === null ? null : sumBytes(before),
    // Both windows added together, and a LOWER BOUND on the row's figure: the
    // pre-wrap half is cache-routed only. Absent whenever either half is
    // absent, because a sum missing one of its terms is not a smaller reading,
    // it is a different one.
    compilesBeforeFirstGapIncludingPreWrap:
      before === null || preWrapCompiles === null
        ? null
        : before.length + preWrapCompiles,
    bytesBeforeFirstGapIncludingPreWrap:
      before === null || preWrapBytes === null
        ? null
        : sumBytes(before) + preWrapBytes,
    censusAtInstall: censusAtInstall ?? null,
    censusFinal: censusFinal ?? null,
    // Compiles the wrap saw that the cache did not account for. Clamped at
    // zero: a negative value would mean the cache compiled more than the
    // device received, which is not a reading, it is a broken pairing.
    directCompilesDuringWrap:
      viaCacheDuringWrap === null
        ? null
        : Math.max(0, compiles.length - viaCacheDuringWrap),
    directBytesDuringWrap:
      viaCacheBytesDuringWrap === null
        ? null
        : Math.max(0, sumBytes(compiles) - viaCacheBytesDuringWrap),
    viaModuleCacheDuringWrap: viaCacheDuringWrap,
    viaModuleCacheBytesDuringWrap: viaCacheBytesDuringWrap,
    // What the engine compiled before any page code could watch, which is
    // where a context-init warm lands.
    compilesBeforeWrap: preWrapCompiles,
    bytesBeforeWrap: preWrapBytes,
  };
}

/**
 * Derive gaps from the independent animation-frame log.
 *
 * The frame recorder inside the scene fires from `postRender`, so it can only
 * observe a frame the engine chose to draw. This log is a bare
 * `requestAnimationFrame` chain installed before the viewer exists, so a gap
 * here is a gap in BeginFrame DELIVERY rather than in the engine's decision to
 * render — the distinction the E-1 receipt could not make.
 *
 * @param {ReadonlyArray<{atMs: number}>|ReadonlyArray<number>} samples The log.
 * @param {object} [thresholds] Overrides for {@link E2_THRESHOLDS}.
 * @returns {{count: number, windowMs: number, gaps: object[], gapMs: number,
 *   gapFraction: number, medianDeltaMs: number}} The decomposition.
 */
export function deriveAnimationFrameGaps(samples, thresholds = {}) {
  const reportGapMs = thresholds.reportGapMs ?? E2_THRESHOLDS.reportGapMs;
  const stamps = (Array.isArray(samples) ? samples : [])
    .map((entry) => (typeof entry === "number" ? entry : Number(entry?.atMs)))
    .filter((value) => Number.isFinite(value));

  const deltas = [];
  const gaps = [];
  for (let index = 1; index < stamps.length; index++) {
    const durationMs = stamps[index] - stamps[index - 1];
    if (!(durationMs >= 0)) {
      continue;
    }
    deltas.push(durationMs);
    if (durationMs >= reportGapMs) {
      gaps.push({
        index,
        durationMs,
        startMs: stamps[index - 1],
        endMs: stamps[index],
      });
    }
  }
  gaps.sort((left, right) => right.durationMs - left.durationMs);
  const windowMs = deltas.reduce((total, value) => total + value, 0);
  const gapMs = gaps.reduce((total, gap) => total + gap.durationMs, 0);
  return {
    count: stamps.length,
    windowMs,
    gaps,
    gapMs,
    gapFraction: windowMs > 0 ? gapMs / windowMs : 0,
    medianDeltaMs: median(deltas),
  };
}

/**
 * Build the control comparison.
 *
 * A control that never reached readiness has no time to compare, and its delta
 * is `null` rather than the deadline it expired at: the deadline is a property
 * of the probe's arguments, not of the scene, and reporting it as a settle time
 * would let a longer deadline look like a slower control.
 *
 * @param {ReadonlyArray<object>} rows One row per control leg.
 * @returns {{comparable: boolean, reason: string|null, baselineMs: number|null,
 *   rows: object[]}} The matrix.
 */
export function buildControlMatrix(rows) {
  const legs = (Array.isArray(rows) ? rows : []).map((row) => ({
    control: row?.control ?? "(unnamed)",
    dimension: E2_CONTROLS[row?.control]?.dimension ?? null,
    backend: row?.backend ?? null,
    reached: row?.reached === true,
    readyMs: Number.isFinite(Number(row?.readyMs)) ? Number(row.readyMs) : null,
    settleWindowMs: Number.isFinite(Number(row?.settleWindowMs))
      ? Number(row.settleWindowMs)
      : null,
  }));
  const baseline = legs.find((leg) => leg.control === "baseline");
  const baselineMs = baseline && baseline.reached ? baseline.readyMs : null;
  const comparable = Number.isFinite(baselineMs);

  return {
    comparable,
    reason: comparable
      ? null
      : baseline === undefined
        ? "no-baseline-leg"
        : "baseline-never-reached-readiness",
    baselineMs: comparable ? baselineMs : null,
    rows: legs.map((leg) => ({
      ...leg,
      deltaMs:
        comparable && leg.reached && leg.readyMs !== null
          ? leg.readyMs - baselineMs
          : null,
      ratio:
        comparable && leg.reached && leg.readyMs !== null && baselineMs > 0
          ? leg.readyMs / baselineMs
          : null,
    })),
  };
}

/**
 * Assemble the receipt this probe writes.
 *
 * @param {object} input Run inputs and per-leg results.
 * @returns {object} The receipt.
 */
export function buildE2Receipt({
  startedAt,
  origin,
  entry,
  entryContext,
  reverse,
  preflight,
  traceCategories,
  legs,
  controlMatrix,
  stallLocus,
}) {
  return {
    probe: "aec-residency-e2",
    row: "Q-143 / DM-09",
    startedAt,
    origin,
    entry,
    entryContext: entryContext ?? null,
    runOrder: reverse ? ["webgpu", "webgl"] : ["webgl", "webgpu"],
    reverse: reverse === true,
    thresholds: E2_THRESHOLDS,
    traceCategories: traceCategories ?? E2_TRACE_CATEGORIES,
    preflight,
    legs,
    controlMatrix,
    stallLocus: stallLocus ?? null,
  };
}

function markdownEscape(value) {
  return String(value ?? "")
    .split("|")
    .join("\\|");
}

/**
 * Render the receipt as the Markdown summary an executor pastes into a report.
 *
 * @param {object} receipt A receipt from {@link buildE2Receipt}.
 * @returns {string} Markdown.
 */
export function buildE2MarkdownSummary(receipt) {
  const lines = [
    "# E-2 — where the AEC residency settle window is waiting (Q-143 / DM-09)",
    "",
    `Origin: \`${markdownEscape(receipt.origin)}\``,
    `Entry: \`${markdownEscape(receipt.entry)}\``,
    `Trace categories: ${markdownEscape((receipt.traceCategories ?? []).join(", "))}`,
    "",
    "| Leg | Backend | Ready | Settle ms | Frame gaps >=1s | rAF gaps >=1s | Trace bridged |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const leg of receipt.legs ?? []) {
    lines.push(
      `| ${markdownEscape(leg.control)} | ${markdownEscape(leg.backend)} | ` +
        `${leg.readiness?.reached === true ? "yes" : "NO"} | ` +
        `${leg.settleWindowMs ?? "n/a"} | ` +
        `${leg.frameGaps?.gaps?.length ?? "n/a"} | ` +
        `${leg.animationFrameGaps?.gaps?.length ?? "n/a"} | ` +
        `${leg.traceOverlap?.attributed === true ? "yes" : (leg.traceOverlap?.reason ?? "not traced")} |`,
    );
  }

  lines.push("", "## Control matrix", "");
  const matrix = receipt.controlMatrix;
  if (!matrix || matrix.comparable !== true) {
    lines.push(`Not comparable: \`${markdownEscape(matrix?.reason)}\`.`);
  } else {
    lines.push(
      "| Control | Dimension | Ready ms | Delta vs baseline |",
      "| --- | --- | --- | --- |",
    );
    for (const row of matrix.rows) {
      lines.push(
        `| ${markdownEscape(row.control)} | ${markdownEscape(row.dimension ?? "-")} | ` +
          `${row.readyMs ?? "never"} | ${row.deltaMs === null ? "n/a" : row.deltaMs} |`,
      );
    }
  }

  lines.push("", "## Occupants of each frame gap", "");
  for (const leg of receipt.legs ?? []) {
    const overlap = leg.traceOverlap;
    if (!overlap) {
      continue;
    }
    lines.push(
      `### ${markdownEscape(leg.control)} / ${markdownEscape(leg.backend)}`,
      "",
    );
    if (overlap.attributed !== true) {
      lines.push(
        `No attribution: \`${markdownEscape(overlap.reason)}\`. The trace was captured but not related to the page clock, so nothing here is attributed.`,
        "",
      );
      continue;
    }
    for (const gap of overlap.gaps) {
      lines.push(
        `Gap ${gap.gapIndex} — ${(gap.gapMs / 1000).toFixed(1)} s`,
        "",
      );
      if (gap.topEvents.length === 0) {
        lines.push("No traced GPU-process event overlapped this gap.", "");
        continue;
      }
      lines.push(
        "| Event | Category | Count | Overlap ms | Gap coverage |",
        "| --- | --- | --- | --- | --- |",
      );
      for (const row of gap.topEvents) {
        lines.push(
          `| ${markdownEscape(row.name)} | ${markdownEscape(row.cat)} | ${row.count} | ` +
            `${row.overlapMs} | ${(row.gapCoverage * 100).toFixed(1)}% |`,
        );
      }
      lines.push("");
    }
  }

  lines.push("", "## Shader-module census", "");
  // Every column names its own window. "Before first gap (post-wrap)" is not
  // the row's deliverable on its own — the wrap does not exist until the
  // viewer resolves — so the combined column beside it is the one to read, and
  // it says on the table that it is a lower bound.
  lines.push(
    "| Leg | Pre-wrap (cache only) | Observed post-wrap | Bytes post-wrap | " +
      "Before first gap (post-wrap) | Bytes before first gap (post-wrap) | " +
      "Bytes before first gap (incl. pre-wrap, lower bound) | Bypassed the cache |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const leg of receipt.legs ?? []) {
    const census = leg.shaderModules;
    if (!census) {
      continue;
    }
    lines.push(
      `| ${markdownEscape(leg.control)}/${markdownEscape(leg.backend)} | ` +
        `${census.compilesBeforeWrap ?? "n/a"} | ${census.compilesObserved} | ` +
        `${census.bytesObserved} | ${census.compilesBeforeFirstGap ?? "n/a"} | ` +
        `${census.bytesBeforeFirstGap ?? "n/a"} | ` +
        `${census.bytesBeforeFirstGapIncludingPreWrap ?? "n/a"} | ` +
        `${census.directCompilesDuringWrap ?? "n/a"} |`,
    );
  }
  lines.push(
    "",
    "The pre-wrap column counts only compiles routed through the engine's " +
      "shader-module cache, so both it and the combined column are lower " +
      "bounds on what the device was handed before the first gap opened.",
    "",
  );
  return `${lines.join("\n")}\n`;
}
