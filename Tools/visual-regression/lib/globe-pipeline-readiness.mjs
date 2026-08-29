// globe-pipeline-readiness.mjs — the pure logic behind
// `probe-globe-pipeline-readiness.mjs`.
// @purpose Pure scoring for the pipeline-readiness probe: snapshot summary, coverage-divergence scoring, non-vacuity; keys decoded via canonical parser.
// @status ACTIVE
//
// WHY THIS IS ITS OWN MODULE. Everything here is a total function over data:
// summarising a snapshot of the renderer's entry map, scoring a frame series for
// a coverage divergence, and deciding whether a lane was non-vacuous. None of it
// needs a browser, a GPU, or a build. Kept inside the probe's `page.evaluate`
// callbacks it would be untestable by construction — module-scope bindings do
// not cross the serialization boundary, so nothing in Node could import it and
// the only way to exercise it would be a full Playwright run against a live
// WebGPU device.
//
// The probe passes the *data* into the page and does the scoring out here.
//
// ── KEY DECODING HAS ONE HOME, AND IT IS NOT THIS FILE ─────────────────────
//
// The 2026-07-25 original carried its own `VARIANT_KEY_FIELDS` /
// `VARIANT_KEY_RE` / `parseGlobeVariantKey` — a private re-implementation of the
// renderer-local globe pipeline key grammar. Batch 788 gave that grammar a
// single home in `WebGPUGlobeSurfacePipelineKey.ts`, which both BUILDS and
// PARSES it and is round-tripped against verbatim copies of the pre-fix template
// literals by `globe-pipeline-key-contract.spec.mjs`.
//
// The private copy is therefore deleted, not merely deduplicated: it was already
// WRONG. Its regex
//   /^([QU])([NX])([MG])([BO])_(\d+)((?:_CD)?)((?:_NC)?)\|([0-9a-f]+)$/
// cannot parse the `_PICK`, `_TBF`, `_DOB`, `_DOF`, `_CAP_<format>`,
// debug-fragment (`<mode>_` prefix) or wireframe (no blend letter) kinds, all of
// which are real keys stored in the maps this probe reads. Every one of them
// would have landed in `diffVariantKeys`'s `unparsed` bucket and been reported
// as "the key format changed" — a false structural alarm on entirely correct
// keys. Importing the canonical parser fixes the decode AND the false alarm.
//
// The canonical parse also returns `kind` and a numeric `defines` (the original
// returned neither `kind` nor anything but a `definesHex` string), so the
// probe's variant reporting is strictly richer than it was.
//
// ── WHAT THE PROBE MEASURES, AND THE MECHANISM IT IS AIMED AT ──────────────
//
// On WebGPU a globe tile whose pipeline variant is not already resident in the
// central cache is NOT DRAWN AT ALL for that frame. The chain, verified in
// source at Batch 766 (`2c37a3db03`) and re-verified against main at Batch 801
// (`3fa329ef14`):
//
//   1. `WebGPUGlobeSurfacePipelines.selectPipeline` builds a renderer-local
//      cache key and hands the entry to `resolveGlobePipelineEntry`.
//   2. `resolveGlobePipelineEntry` calls `pipelineCache.getPipelineSync(...)`,
//      which is a pure `cache.get(key)` — it never creates. On a miss it marks
//      `entry.pending`, kicks off the async `getPipeline()`, and RETURNS NULL.
//      The synchronous `device.createRenderPipeline` fallback below it is
//      reachable only when `host._centralPipelineCache` is absent.
//   3. `WebGPUGlobeSurfaceRenderer` then hits `if (!pipeline) { continue; }`
//      and the tile contributes nothing to the frame.
//
// WebGL has no analogue: `ShaderProgram` compiles synchronously on first use,
// so every resident tile draws. The designed WebGPU behaviour is "draw the hole
// now, re-render when the pipeline lands" — `Scene`'s `pendingAsyncResources`
// gate forces another frame while creation is inflight, which is a
// keep-rendering-until-it-lands mechanism, not a do-not-draw-a-hole mechanism.
//
// So the open question is not whether the skip exists — it demonstrably does —
// but whether a camera move can request a variant that is NOT already cached,
// with a healthy event loop, often enough to be visible. That is a measurement,
// and these helpers are its arithmetic.

import { parseGlobePipelineCacheKey } from "../../../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelineKey.ts";

export { parseGlobePipelineCacheKey };

/**
 * Field names a successful {@link parseGlobePipelineCacheKey} yields for a plain
 * color key.
 *
 * DERIVED, never hand-listed. The original hard-coded this array next to a
 * hand-written regex, so the two could disagree; computing it from an actual
 * parse makes that impossible. The `kind` field is included because the
 * canonical parser reports it and the probe's variant summary shows it.
 *
 * @type {readonly string[]}
 */
export const VARIANT_KEY_FIELDS = Object.freeze(
  Object.keys(parseGlobePipelineCacheKey("UNGO_28|0") ?? {}),
);

/**
 * Diff two variant-key snapshots taken across a transition.
 *
 * @param {string[]} before Keys resident before the transition began.
 * @param {string[]} after Keys resident after it ended.
 * @returns {{added: string[], addedParsed: object[], unparsed: string[],
 *   beforeCount: number, afterCount: number}}
 */
export function diffVariantKeys(before, after) {
  const beforeSet = new Set(Array.isArray(before) ? before : []);
  const afterArr = Array.isArray(after) ? after : [];
  const added = afterArr.filter((k) => !beforeSet.has(k));
  const addedParsed = [];
  const unparsed = [];
  for (const k of added) {
    const p = typeof k === "string" ? parseGlobePipelineCacheKey(k) : null;
    if (p === null || p === undefined) {
      unparsed.push(k);
    } else {
      addedParsed.push({ key: k, ...p });
    }
  }
  return {
    added,
    addedParsed,
    unparsed,
    beforeCount: beforeSet.size,
    afterCount: afterArr.length,
  };
}

/**
 * Score one lane's per-frame series.
 *
 * A frame is a "skip frame" when the renderer's entry map held at least one
 * entry with a null pipeline at the moment the frame was measured — that is
 * exactly the state in which `selectPipeline` returns null and the renderer
 * `continue`s past a tile. `notReady` is therefore not a proxy for the skip;
 * it is the skip's own precondition, read directly.
 *
 * @param {Array<object>} frames Per-frame records from the page.
 * @returns {{frameCount: number, skipFrames: number, longestSkipRun: number,
 *   longestSkipRunMs: number|null, peakNotReady: number, peakTilesAtRisk: number,
 *   minCoverage: number|null, maxCoverage: number|null, finalCoverage: number|null,
 *   firstSkipFrameIndex: number|null, lastSkipFrameIndex: number|null}}
 */
export function summarizeLaneFrames(frames) {
  const f = Array.isArray(frames) ? frames : [];
  let skipFrames = 0;
  let longestSkipRun = 0;
  let run = 0;
  let runStart = null;
  let longestRunStart = null;
  let longestRunEnd = null;
  let peakNotReady = 0;
  let peakTilesAtRisk = 0;
  let minCoverage = null;
  let maxCoverage = null;
  let firstSkipFrameIndex = null;
  let lastSkipFrameIndex = null;

  for (let i = 0; i < f.length; i++) {
    const rec = f[i];
    const notReady = Number.isFinite(rec?.notReady) ? rec.notReady : 0;
    if (notReady > peakNotReady) {
      peakNotReady = notReady;
    }
    if (notReady > 0) {
      skipFrames++;
      if (firstSkipFrameIndex === null) {
        firstSkipFrameIndex = i;
      }
      lastSkipFrameIndex = i;
      // Tiles at risk: every selected tile is at risk on a frame where any
      // variant is unresolved, because the renderer cannot tell us which tiles
      // asked for which variant without an engine-side counter. This is an
      // UPPER bound and is labelled as one everywhere it is reported.
      const tiles = Number.isFinite(rec?.tilesSelected) ? rec.tilesSelected : 0;
      if (tiles > peakTilesAtRisk) {
        peakTilesAtRisk = tiles;
      }
      if (run === 0) {
        runStart = i;
      }
      run++;
      if (run > longestSkipRun) {
        longestSkipRun = run;
        longestRunStart = runStart;
        longestRunEnd = i;
      }
    } else {
      run = 0;
    }
    const cov = rec?.coverage;
    if (Number.isFinite(cov)) {
      if (minCoverage === null || cov < minCoverage) {
        minCoverage = cov;
      }
      if (maxCoverage === null || cov > maxCoverage) {
        maxCoverage = cov;
      }
    }
  }

  // Wall-clock duration of the longest skip run, from the frame timestamps the
  // page recorded. Frames, not milliseconds, are the primitive here — the probe
  // drives the loop by `requestAnimationFrame`, so a frame count is exact while
  // a millisecond figure depends on how loaded the machine was.
  let longestSkipRunMs = null;
  if (longestRunStart !== null && longestRunEnd !== null) {
    const t0 = f[longestRunStart]?.t;
    const t1 = f[longestRunEnd]?.t;
    if (Number.isFinite(t0) && Number.isFinite(t1)) {
      longestSkipRunMs = t1 - t0;
    }
  }

  const last = f.length > 0 ? f[f.length - 1] : null;
  return {
    frameCount: f.length,
    skipFrames,
    longestSkipRun,
    longestSkipRunMs,
    peakNotReady,
    peakTilesAtRisk,
    minCoverage,
    maxCoverage,
    finalCoverage: Number.isFinite(last?.coverage) ? last.coverage : null,
    firstSkipFrameIndex,
    lastSkipFrameIndex,
  };
}

/**
 * The parity comparison for one lane, frame-index aligned between backends.
 *
 * Both backends are driven through the SAME scripted camera sequence with the
 * same number of `requestAnimationFrame` yields, so frame `i` is the same point
 * in the transition on both sides. That alignment is what makes a per-frame
 * coverage difference meaningful; it is asserted (equal frame counts) rather
 * than assumed, and a mismatch is STRUCTURAL — two differently-paced runs
 * cannot be compared at all, which is the same lesson the eclipse lanes learned
 * about cross-run comparison.
 *
 * The finding is confirmed when WebGPU's coverage drops materially below
 * WebGL's DURING the transition and RECOVERS after it. A permanent deficit is a
 * different bug (a real rendering divergence) and is reported separately so the
 * two are never conflated.
 *
 * @param {Array<object>} webglFrames
 * @param {Array<object>} webgpuFrames
 * @param {{minDivergence?: number, recoveryTolerance?: number}} [opts]
 * @returns {object}
 */
export function compareCoverageSeries(webglFrames, webgpuFrames, opts = {}) {
  const minDivergence = opts.minDivergence ?? 0.1;
  const recoveryTolerance = opts.recoveryTolerance ?? 0.05;
  const a = Array.isArray(webglFrames) ? webglFrames : [];
  const b = Array.isArray(webgpuFrames) ? webgpuFrames : [];

  if (a.length === 0 || b.length === 0) {
    return {
      aligned: false,
      reason: "one or both backends produced no frames",
      webglFrameCount: a.length,
      webgpuFrameCount: b.length,
    };
  }
  if (a.length !== b.length) {
    return {
      aligned: false,
      reason:
        `frame counts differ (webgl ${a.length}, webgpu ${b.length}) — the two ` +
        `runs are not the same point-by-point sequence and cannot be compared`,
      webglFrameCount: a.length,
      webgpuFrameCount: b.length,
    };
  }

  let worstDeficit = 0;
  let worstIndex = null;
  let deficitFrames = 0;
  let longestDeficitRun = 0;
  let run = 0;
  let runStartIdx = null;
  let longestRunStartIdx = null;
  let longestRunEndIdx = null;

  for (let i = 0; i < a.length; i++) {
    const ca = a[i]?.coverage;
    const cb = b[i]?.coverage;
    if (!Number.isFinite(ca) || !Number.isFinite(cb)) {
      run = 0;
      continue;
    }
    const deficit = ca - cb;
    if (deficit > worstDeficit) {
      worstDeficit = deficit;
      worstIndex = i;
    }
    if (deficit >= minDivergence) {
      deficitFrames++;
      if (run === 0) {
        runStartIdx = i;
      }
      run++;
      if (run > longestDeficitRun) {
        longestDeficitRun = run;
        longestRunStartIdx = runStartIdx;
        longestRunEndIdx = i;
      }
    } else {
      run = 0;
    }
  }

  let longestDeficitRunMs = null;
  if (longestRunStartIdx !== null && longestRunEndIdx !== null) {
    const t0 = b[longestRunStartIdx]?.t;
    const t1 = b[longestRunEndIdx]?.t;
    if (Number.isFinite(t0) && Number.isFinite(t1)) {
      longestDeficitRunMs = t1 - t0;
    }
  }

  // Recovery is judged on the settled tail, not the last single frame — one
  // frame is noise. The tail is the last 20% of the sequence (at least 3
  // frames), which is after the scripted camera motion has stopped in every
  // lane the probe defines.
  const tailLen = Math.max(3, Math.round(a.length * 0.2));
  const tailStart = Math.max(0, a.length - tailLen);
  const mean = (arr, from) => {
    let s = 0;
    let n = 0;
    for (let i = from; i < arr.length; i++) {
      if (Number.isFinite(arr[i]?.coverage)) {
        s += arr[i].coverage;
        n++;
      }
    }
    return n > 0 ? s / n : null;
  };
  const tailA = mean(a, tailStart);
  const tailB = mean(b, tailStart);
  const recovered =
    tailA !== null && tailB !== null
      ? tailA - tailB <= recoveryTolerance
      : null;

  return {
    aligned: true,
    frameCount: a.length,
    worstDeficit,
    worstFrameIndex: worstIndex,
    worstFrameWebglCoverage:
      worstIndex === null ? null : (a[worstIndex]?.coverage ?? null),
    worstFrameWebgpuCoverage:
      worstIndex === null ? null : (b[worstIndex]?.coverage ?? null),
    deficitFrames,
    longestDeficitRun,
    longestDeficitRunMs,
    tailWebglCoverage: tailA,
    tailWebgpuCoverage: tailB,
    recovered,
    // The headline: a transient dip that recovers is the traced mechanism. A
    // dip that does not recover is a DIFFERENT defect and must not be reported
    // as this one.
    transientDivergence: worstDeficit >= minDivergence && recovered === true,
    persistentDivergence: worstDeficit >= minDivergence && recovered === false,
  };
}

/**
 * Whether a lane was actually IN the condition it claims to test.
 *
 * A lane that never requested an uncached variant cannot report anything about
 * what happens when one is requested — and, critically, must not be allowed to
 * read as "no divergence found". That is the difference between "measured, and
 * the mechanism did not bite" and "never armed", and conflating them is how an
 * instrument reports a clean bill of health it never earned.
 *
 * @param {object} laneSummary Output of {@link summarizeLaneFrames}.
 * @param {object} variantDiff Output of {@link diffVariantKeys}.
 * @param {{requireVariantMiss?: boolean, requireSkipFrame?: boolean}} [expect]
 * @returns {{nonVacuous: boolean, reasons: string[]}}
 */
export function assertLaneNonVacuous(laneSummary, variantDiff, expect = {}) {
  const reasons = [];
  if (!laneSummary || laneSummary.frameCount === 0) {
    reasons.push("lane produced no frames");
  }
  if (
    laneSummary &&
    laneSummary.frameCount > 0 &&
    laneSummary.maxCoverage === null
  ) {
    reasons.push("lane produced no finite coverage samples");
  }
  if (expect.requireVariantMiss === true) {
    const added = variantDiff?.added?.length ?? 0;
    if (added === 0) {
      reasons.push(
        "no new pipeline variant was requested during this lane — the lane " +
          "never entered the condition it exists to test",
      );
    }
  }
  if (expect.requireSkipFrame === true) {
    if (!(laneSummary?.skipFrames > 0)) {
      reasons.push(
        "no frame observed an unresolved pipeline entry — the arming " +
          "mechanism did not fire, so this lane proves nothing",
      );
    }
  }
  return { nonVacuous: reasons.length === 0, reasons };
}

/**
 * Source-shape pins for the traced mechanism.
 *
 * These are NOT provenance markers in the build-freshness sense; they assert
 * that the CODE STILL HAS THE SHAPE THE PROBE IS AIMED AT. If someone fixes the
 * skip — adds a last-good-pipeline fallback, makes the globe path synchronous,
 * removes the `continue` — these pins fail, and that failure is the correct
 * outcome: the instrument's premise is gone and its results would be
 * meaningless.
 *
 * Every pattern is whitespace-tolerant and asserts a CALL SHAPE, never a
 * single-line literal, because a reformat must not read as a mechanism change.
 * That property is no longer self-policed: the spec runs each pattern through
 * `lib/provenance-markers.mjs`'s `checkSourcePinWidth`, which is the fleet's
 * shared home for exactly this failure mode (it landed on main after this
 * module was first written, when its own comment said the pins "should move" —
 * this is that move, scoped to the wrap-safety property; the pins themselves
 * stay here because they are domain-specific to this probe).
 *
 * ALL SEVEN RE-VERIFIED against main at Batch 801 (`3fa329ef14`) on 2026-08-01.
 * Batches 797-801 did not drift any of them.
 *
 * @type {ReadonlyArray<{file: string, name: string, pattern: RegExp, why: string}>}
 */
export const MECHANISM_PINS = Object.freeze([
  {
    file: "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelines.ts",
    name: "resolveGlobePipelineEntry consults the cache synchronously",
    pattern:
      /pipelineCache\s*\.\s*getPipelineSync\s*\(\s*entry\s*\.\s*descriptor\s*\)/,
    why: "step 2 of the traced chain — a pure lookup that never creates",
  },
  {
    file: "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelines.ts",
    name: "the miss path marks pending and kicks off async creation",
    pattern:
      /entry\s*\.\s*pending\s*=\s*true\s*;[\s\S]{0,200}?pipelineCache[\s\S]{0,80}?\.\s*getPipeline\s*\(\s*entry\s*\.\s*descriptor\s*\)/,
    why: "step 1 — the async kick-off that precedes the null return",
  },
  {
    file: "packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts",
    name: "getPipelineSync is a pure cache lookup",
    pattern:
      /getPipelineSync\s*\([\s\S]{0,220}?\)\s*:\s*GPURenderPipeline\s*\|\s*undefined\s*\{[\s\S]{0,400}?this\s*\.\s*cache\s*\.\s*get\s*\(\s*key\s*\)/,
    why: "step 2 — confirms there is no creation fallback inside the lookup",
  },
  {
    file: "packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts",
    name: "creation is async-only",
    pattern: /this\s*\.\s*device\s*\.\s*createRenderPipelineAsync\s*\(/,
    why: "step 3 — the only creation path the globe entry can reach",
  },
  {
    file: "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
    name: "an unresolved pipeline skips the tile",
    // The skip now records the pass it dropped before continuing, so the
    // pattern admits the counter between the brace and the `continue`. The
    // step it pins is unchanged: an unresolved pipeline still draws nothing
    // this frame.
    pattern: /if\s*\(\s*!\s*pipeline\s*\)\s*\{[^}]*continue\s*;\s*\}/,
    why: "step 4 — the tile draws nothing this frame",
  },
  {
    file: "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
    name: "the renderer-local entry map is reachable without an engine hook",
    pattern:
      /public\s+_pipelineCache\s*:\s*Map\s*<\s*string\s*,\s*GlobePipelineEntry\s*>/,
    why: "the probe reads this map from the page; a visibility change breaks it",
  },
  {
    file: "packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts",
    name: "the central pipeline cache is reachable without an engine hook",
    pattern: /public\s+_webgpuPipelineCache\s*:/,
    why: "lanes (c) and (d) clear this to arm a cold cache legitimately",
  },
]);

/**
 * Components the CENTRAL pipeline cache key is built from, in
 * `WebGPURenderPipelineCache.generateCacheKey`. Recorded here so the probe's
 * report can state the real list rather than a remembered one, and so the spec
 * can pin the two absences below.
 *
 * ★ THE SHADER MODULE **IS** IN THIS KEY, since 2026-08-06
 * (`NEW-WEBGPU-PIPELINE-KEY-DEFINE-AXIS-GENERAL`). The trailing
 * `sh:<vsId>.<vsEntry>/<fsId>.<fsEntry>` segment carries the identity of the
 * `GPUShaderModule` objects themselves. `WebGPUShaderModuleCache` returns a
 * distinct module per `(sourceId, defines, definesHi, keySalt)`, so folding
 * module identity is strictly stronger than folding a define mask: a define
 * that rides NEITHER the descriptor name NOR the vertex layout can no longer
 * alias. The same change added `pl:` (pipeline-layout identity), `pr:`
 * (primitive state), `dz:` (depth/stencil state beyond the format) and `mx:`
 * (multisample mask + alpha-to-coverage), closing every descriptor-side field
 * that `buildPipelineDescriptor` reads.
 *
 * ★ HISTORY, twice over, because this note has now said three different things.
 * (1) Before 2026-08-01 it claimed defines were covered "by convention"; they
 * were not. `LOG_DEPTH` rode neither the name nor the vertex layout, so the
 * renderer-LOCAL key (which does include the defines hex) created a fresh local
 * entry on a log-depth flip that then resolved against an UNCHANGED central key
 * and was handed back the pipeline built for the OTHER log-depth state — that is
 * `NEW-WEBGPU-PIPELINE-KEY-LOG-DEPTH`, confirmed live and mitigated by adding
 * `${ldLabel}` to the globe descriptor name plus seven sibling sites.
 * (2) Batch 803's markers were per-axis mitigations, so the rule "every new
 * define must be hand-checked" survived them. (3) The module fold retires that
 * rule: the markers remain as defense-in-depth and as readable provenance, but
 * correctness no longer depends on an author remembering one.
 * `pipeline-key-aliasing.spec.mjs` is the durable guard; `stats.wrongModuleHits`
 * is the runtime canary and is now expected to be permanently 0.
 *
 * @type {readonly string[]}
 */
export const CENTRAL_CACHE_KEY_COMPONENTS = Object.freeze([
  "descriptor.name",
  "variant.depthTest/depthWrite/depthCompare",
  "variant.cullMode/frontFace/topology",
  "variant.blend/stencilFront/stencilBack",
  "variant.stencilReadMask/stencilWriteMask/colorWriteMask",
  "variant.depthBias/depthBiasSlopeScale/depthBiasClamp",
  "descriptor.multisample.count",
  "descriptor.depthStencil.format",
  "descriptor.fragment.targets[] format+writeMask+hasBlend",
  "descriptor.vertex.buffers[] arrayStride+stepMode+attributes",
  "descriptor.layout identity",
  "descriptor.primitive topology/cullMode/frontFace/stripIndexFormat/unclippedDepth",
  "descriptor.depthStencil depthWriteEnabled/depthCompare/bias/stencil ops+masks",
  "descriptor.multisample mask+alphaToCoverageEnabled",
  "descriptor.vertex.module + fragment.module identity + entryPoints",
  "descriptor.defines/definesHi (optional, when the producer declares them)",
]);
