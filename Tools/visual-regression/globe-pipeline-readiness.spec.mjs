// globe-pipeline-readiness.spec.mjs — pure-logic cover for
// `probe-globe-pipeline-readiness.mjs`.
//
// TWO KINDS OF TEST LIVE HERE, and the distinction matters when one fails.
//
//   1. SCORING TESTS. The probe's arithmetic — frame-series summarisation,
//      cross-backend comparison, non-vacuity. These are total functions over
//      data and are tested directly. A failure here is a bug in the instrument.
//
//   2. MECHANISM PINS. Assertions that the ENGINE code still has the shape the
//      probe is aimed at, read straight off the source. A failure here is NOT a
//      bug in the instrument: it means the traced path changed. If it was
//      fixed, the probe's premise is gone and the probe should be retired or
//      rewritten; if it was refactored, the pins need re-verifying. Either way
//      the probe must not be run until a human has looked.
//
// The pins are whitespace-tolerant and assert CALL SHAPES, never single-line
// literals — a reformat must never read as a mechanism change. That property is
// enforced mechanically by `lib/provenance-markers.mjs`'s `checkSourcePinWidth`,
// the fleet's shared home for this failure mode, rather than by a private
// collapse test.
//
// ── WHAT CHANGED WHEN THIS WAS EXTRACTED ONTO MAIN (2026-08-01) ────────────
// Three tests in the 2026-07-25 original are GONE, because the things they
// pinned were fixed by Batch 788 and Batch 802:
//
//   * "the engine's four legacy pipeline getters use a THREE-letter key and can
//     never hit" — Batch 788 FIXED those getters; they now resolve through a
//     semantic predicate. `globe-pipeline-key-contract.spec.mjs` §C owns the
//     defect's record and pins the four stale strings as unproducible. Keeping
//     a second copy here would assert the bug still exists.
//   * "the renderer-local variant key still has the shape the decoder expects"
//     — Batch 788 removed the inline `const cacheKey = \`${isQuantized...\``
//     template from every producer. The replacement test asserts the producer
//     routes through `buildGlobePipelineCacheKey` instead.
//   * "LOG_DEPTH is the one selectPipeline define absent from BOTH the
//     descriptor name and the vertex layout" — that absence WAS the
//     `NEW-WEBGPU-PIPELINE-KEY-LOG-DEPTH` aliasing defect. It is fixed; the test
//     is INVERTED below to pin the marker's presence.
//
// Run: node --test Tools/visual-regression/globe-pipeline-readiness.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkSourcePinWidth } from "./lib/provenance-markers.mjs";
import {
  CENTRAL_CACHE_KEY_COMPONENTS,
  MECHANISM_PINS,
  VARIANT_KEY_FIELDS,
  assertLaneNonVacuous,
  compareCoverageSeries,
  diffVariantKeys,
  parseGlobePipelineCacheKey,
  summarizeLaneFrames,
} from "./lib/globe-pipeline-readiness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const readEngine = (p) => fs.readFileSync(path.join(root, p), "utf8");

// ═══════════════════════════════════════════════════════════════════════════
// 1. MECHANISM PINS — the traced chain, four steps
// ═══════════════════════════════════════════════════════════════════════════

test("mechanism pins: every traced step is still present in engine source", () => {
  const missing = [];
  for (const pin of MECHANISM_PINS) {
    const src = readEngine(pin.file);
    if (!pin.pattern.test(src)) {
      missing.push(`${pin.name} (${pin.file}) — ${pin.why}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    "the traced pipeline-readiness path changed shape; the probe's premise " +
      "must be re-verified before it is run again",
  );
});

test("mechanism pins are whitespace-tolerant, not line-literal", () => {
  // Each pin must still match after the source is collapsed to single spaces.
  // A pin that only matches the current formatting would fail on a reformat and
  // be read as a mechanism change — the exact false alarm this rule prevents.
  for (const pin of MECHANISM_PINS) {
    const collapsed = readEngine(pin.file).replace(/[ \t]+/g, " ");
    assert.ok(
      pin.pattern.test(collapsed),
      `pin "${pin.name}" is sensitive to horizontal whitespace`,
    );
  }
});

test("mechanism pins pass the fleet's shared wrap-safety check", () => {
  // `lib/provenance-markers.mjs` is where this rule lives for the whole fleet
  // (five recorded strikes). Routing the pins through it means a new pin written
  // with a literal space fails HERE, at authoring time, rather than as a
  // mystifying false regression after an unrelated prettier run.
  const failures = [];
  for (const pin of MECHANISM_PINS) {
    failures.push(
      ...checkSourcePinWidth({
        pattern: pin.pattern,
        sourceText: readEngine(pin.file),
        label: pin.name,
      }),
    );
  }
  assert.deepEqual(failures, []);
});

test("step 2: getPipelineSync never creates a pipeline", () => {
  const src = readEngine(
    "packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts",
  );
  // Anchor on the DECLARATION, not the first textual occurrence — the name
  // appears in a JSDoc block ~100 lines earlier, and slicing from there swept
  // in the whole of `getPipeline` and made this test meaningless.
  const decl = /getPipelineSync\s*\(\s*\n?\s*descriptor\s*:/.exec(src);
  assert.ok(decl, "getPipelineSync declaration not found");
  const start = decl.index;
  const body = src.slice(start, src.indexOf("createPipelineAsync", start));
  assert.ok(
    /this\s*\.\s*cache\s*\.\s*get\s*\(/.test(body),
    "getPipelineSync no longer performs a plain cache lookup",
  );
  assert.ok(
    !/createRenderPipeline\b/.test(body),
    "getPipelineSync gained a synchronous creation path — the traced null " +
      "return may no longer be reachable and the probe needs re-verifying",
  );
});

test("step 1: the sync createRenderPipeline fallback is gated on the ABSENCE of the central cache", () => {
  const src = readEngine(
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelines.ts",
  );
  const start = src.indexOf("export function resolveGlobePipelineEntry");
  assert.ok(start > 0, "resolveGlobePipelineEntry not found");
  const body = src.slice(start, src.indexOf("export function", start + 10));
  // The shape that makes the null return the normal case: inside
  // `if (pipelineCache) { ... return null; }`, with the synchronous
  // `createRenderPipeline` only AFTER that block.
  const nullReturnIdx = body.indexOf("return null;");
  const syncCreateIdx = body.indexOf("createRenderPipeline(");
  assert.ok(nullReturnIdx > 0, "the null return is gone");
  assert.ok(syncCreateIdx > 0, "the synchronous fallback is gone");
  assert.ok(
    nullReturnIdx < syncCreateIdx,
    "the synchronous fallback now precedes the null return — the null return " +
      "may no longer be the normal-configuration outcome",
  );
});

test("step 4: an unresolved globe pipeline still skips the tile with no counter", () => {
  const src = readEngine(
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
  );
  assert.ok(
    /if\s*\(\s*!\s*pipeline\s*\)\s*\{\s*continue\s*;\s*\}/.test(src),
    "the per-tile skip is gone",
  );
  // The probe reports selected-tile count as an UPPER BOUND on skipped tiles
  // precisely because no counter exists here. If one is ever added, the probe
  // should read it instead — and this test is where that gets noticed.
  const skipIdx = src.search(/if\s*\(\s*!\s*pipeline\s*\)\s*\{\s*continue/);
  const window = src.slice(Math.max(0, skipIdx - 400), skipIdx + 200);
  assert.ok(
    !/\+\+\s*\w*[Ss]kip|skipped\s*(\+\+|\+=)/.test(window),
    "a skip counter appears to exist now — the probe should read it directly " +
      "instead of reporting selected-tile count as an upper bound",
  );
});

test("the instrument's two entry points are reachable without an engine hook", () => {
  assert.ok(
    /public\s+_pipelineCache\s*:\s*Map\s*<\s*string\s*,\s*GlobePipelineEntry\s*>/.test(
      readEngine(
        "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
      ),
    ),
    "the renderer-local entry map is no longer public",
  );
  assert.ok(
    /public\s+_webgpuPipelineCache\s*:/.test(
      readEngine("packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts"),
    ),
    "the central pipeline cache is no longer public",
  );
});

test("the renderer-local key is built by the ONE canonical builder, never inline", () => {
  // REPLACES the original's "the key template literal still has the shape the
  // decoder expects". Batch 788 removed every inline template; the decoder this
  // lib uses is now the SAME module the producer calls, so drift between them is
  // structurally impossible rather than merely tested for.
  const src = readEngine(
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelines.ts",
  );
  assert.ok(
    /import\s*\{[^}]*buildGlobePipelineCacheKey[^}]*\}\s*from\s*"\.\/WebGPUGlobeSurfacePipelineKey\.js"/.test(
      src,
    ),
    "the globe pipeline producer no longer imports the canonical key builder",
  );
  const builderCalls = [...src.matchAll(/buildGlobePipelineCacheKey\s*\(/g)];
  assert.ok(
    builderCalls.length >= 5,
    `expected every pipeline selector to call the builder; found ${builderCalls.length}`,
  );
  // And nothing rebuilt it by hand behind the builder's back.
  assert.ok(
    !/const\s+cacheKey\s*=\s*`\$\{\s*isQuantized/.test(src),
    "an inline cache-key template is back — the format has two homes again, " +
      "which is exactly the drift Batch 788 removed",
  );
});

test("the central cache key contains no shader module and no define bits", () => {
  // This is the observation `CENTRAL_CACHE_KEY_COMPONENTS` documents. It is
  // pinned because two of the probe's design decisions depend on it: the
  // translucency positive control works only because `cullMode` and `blend` ARE
  // in the key, and the aliasing note is only meaningful because defines are NOT.
  const src = readEngine(
    "packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts",
  );
  const start = src.indexOf("private generateCacheKey(");
  assert.ok(start > 0, "generateCacheKey not found");
  const body = src.slice(
    start,
    src.indexOf("\n  }", src.indexOf("parts.join", start)),
  );
  assert.ok(
    !/\.\s*module\b/.test(body),
    "generateCacheKey now keys on the shader module — the aliasing note in " +
      "CENTRAL_CACHE_KEY_COMPONENTS is stale",
  );
  assert.ok(
    !/\bdefines\b/.test(body),
    "generateCacheKey now keys on shader defines — the aliasing note is stale",
  );
  // The components the probe's report claims are present.
  for (const marker of [
    "descriptor.name",
    "multisample?.count",
    "depthStencil?.format",
    "fragment?.targets",
    "vertex?.buffers",
  ]) {
    assert.ok(
      body.includes(marker.split("?.").join("?.")) ||
        body.includes(marker.replace("?.", ".")),
      `generateCacheKey no longer reads ${marker}`,
    );
  }
  assert.equal(CENTRAL_CACHE_KEY_COMPONENTS[0], "descriptor.name");
});

test("every selectPipeline define now rides the name or the vertex layout — LOG_DEPTH included", () => {
  // INVERTED from the original, which asserted the descriptor name carried NO
  // log marker. That absence was `NEW-WEBGPU-PIPELINE-KEY-LOG-DEPTH`: the local
  // key includes the defines hex, so a flip made a fresh LOCAL entry that then
  // resolved against an UNCHANGED CENTRAL key and got the pipeline built from
  // the other log-depth module. Fixed 2026-08-01. This test now guards the fix.
  const src = readEngine(
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelines.ts",
  );
  // GEODETIC_NORMAL rides the vertex layout; the other two ride the name.
  assert.ok(
    /imgLabel\s*=\s*host\s*\.\s*_imageryReduced\s*\?/.test(src),
    "the reduced-imagery define no longer marks the descriptor name",
  );
  assert.ok(
    /logDepthOn\s*\?\s*ShaderDefine\s*\.\s*LOG_DEPTH\s*:\s*0/.test(src),
    "the log-depth define is no longer folded into the globe define mask",
  );
  assert.ok(
    /const\s+ldLabel\s*=\s*logDepthOn\s*\?/.test(src),
    "the log-depth name marker binding is gone",
  );
  const nameLine = /name:\s*`Globe terrain \([^`]*`/.exec(src);
  assert.ok(nameLine, "the descriptor name template is gone");
  assert.ok(
    /\$\{ldLabel\}/.test(nameLine[0]),
    "the globe descriptor name no longer interpolates the log-depth marker — " +
      "the log and hyperbolic globe pipelines alias in the central cache again " +
      "(see pipeline-key-aliasing.spec.mjs)",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. key decoding — delegated to the ONE canonical parser
// ═══════════════════════════════════════════════════════════════════════════

test("the canonical parser decodes the four-letter key selectPipeline builds", () => {
  assert.deepEqual(parseGlobePipelineCacheKey("UNGO_28|0"), {
    kind: "color",
    isQuantized: false,
    hasNormals: true,
    hasWebMercatorT: false,
    isBlend: false,
    strideBytes: 28,
    useClipDistances: false,
    disableCulling: false,
    defines: 0,
  });
  assert.equal(parseGlobePipelineCacheKey("QNMO_16|0").isQuantized, true);
  assert.equal(parseGlobePipelineCacheKey("QXGO_12|0").strideBytes, 12);
});

test("the canonical parser decodes the kinds the private regex could NOT", () => {
  // THE REASON THE PRIVATE COPY WAS DELETED. The 2026-07-25 regex was
  //   /^([QU])([NX])([MG])([BO])_(\d+)((?:_CD)?)((?:_NC)?)\|([0-9a-f]+)$/
  // which matches ONLY the plain color kind. Every one of these is a real key
  // stored in the maps the probe reads, and every one of them would have been
  // reported as `unparsed` — i.e. as "selectPipeline's key format changed",
  // a false structural alarm on entirely correct keys.
  assert.equal(parseGlobePipelineCacheKey("UNGO_28_CD_PICK|4").kind, "pick");
  assert.equal(
    parseGlobePipelineCacheKey("QNMB_32_TBF|1a").kind,
    "translucentBackFace",
  );
  assert.equal(
    parseGlobePipelineCacheKey("UNGO_28_DOB|0").kind,
    "depthOnlyBackFace",
  );
  assert.equal(
    parseGlobePipelineCacheKey("UNGO_28_DOF|0").kind,
    "depthOnlyFrontFace",
  );
  const cap = parseGlobePipelineCacheKey("UNGO_28_CAP_rgba16float|20");
  assert.equal(cap.kind, "capture");
  assert.equal(cap.captureFaceFormat, "rgba16float");
  const dbg = parseGlobePipelineCacheKey("3_UNGO_28|0");
  assert.equal(dbg.kind, "debugFragment");
  assert.equal(dbg.debugFragmentMode, 3);
  assert.equal(parseGlobePipelineCacheKey("UNG_28|0").kind, "wireframe");
});

test("the canonical parser rejects malformed keys rather than guessing", () => {
  // A null decode is a finding: it means the key format changed. Silently
  // coercing would hide that.
  for (const bad of [
    "",
    "UNGO_28|",
    "ZNGO_28|0", // not a quantization letter
    "UNGO_x|0", // stride is not a number
    "UNGO_28|0extra",
    "UNGO_28|0G", // defines must be lowercase hex
    null,
    undefined,
    42,
    {},
  ]) {
    const got = parseGlobePipelineCacheKey(bad);
    assert.ok(
      got === null || got === undefined,
      `should reject ${String(bad)}, got ${JSON.stringify(got)}`,
    );
  }
});

test("VARIANT_KEY_FIELDS is derived from the decoder, so it cannot drift from it", () => {
  const decoded = parseGlobePipelineCacheKey("QNMB_32_CD|1a");
  // Every derived field name must be a real key of a real parse. (A capture or
  // debug key carries extra optional fields; the derived list is the color
  // baseline, which is what the probe's summary rows use.)
  for (const f of VARIANT_KEY_FIELDS) {
    assert.ok(f in decoded, `${f} is not produced by the canonical parser`);
  }
  assert.ok(VARIANT_KEY_FIELDS.includes("kind"));
  assert.ok(VARIANT_KEY_FIELDS.includes("defines"));
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. diffVariantKeys
// ═══════════════════════════════════════════════════════════════════════════

test("diffVariantKeys reports only genuinely new variants", () => {
  const d = diffVariantKeys(
    ["UNGO_28|0"],
    ["UNGO_28|0", "UNGO_28_NC|0", "UNGB_28|0"],
  );
  assert.deepEqual(d.added, ["UNGO_28_NC|0", "UNGB_28|0"]);
  assert.equal(d.beforeCount, 1);
  assert.equal(d.afterCount, 3);
  assert.equal(d.addedParsed.length, 2);
  assert.equal(d.addedParsed[0].disableCulling, true);
  assert.equal(d.addedParsed[1].isBlend, true);
  assert.deepEqual(d.unparsed, []);
});

test("diffVariantKeys no longer false-alarms on non-color kinds", () => {
  // Regression guard for the private-regex defect described above.
  const d = diffVariantKeys(
    [],
    [
      "UNGO_28|0",
      "UNGO_28_PICK|0",
      "QNMB_32_TBF|1a",
      "UNGO_28_CAP_rgba16float|20",
      "3_UNGO_28|0",
      "UNG_28|0",
    ],
  );
  assert.deepEqual(d.unparsed, []);
  assert.equal(d.addedParsed.length, 6);
});

test("diffVariantKeys surfaces genuinely undecodable keys instead of dropping them", () => {
  const d = diffVariantKeys([], ["UNGO_28|0", "SOMETHING ELSE!"]);
  assert.deepEqual(d.unparsed, ["SOMETHING ELSE!"]);
  assert.equal(d.addedParsed.length, 1);
});

test("diffVariantKeys tolerates missing snapshots", () => {
  const d = diffVariantKeys(undefined, undefined);
  assert.deepEqual(d.added, []);
  assert.equal(d.beforeCount, 0);
  assert.equal(d.afterCount, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. summarizeLaneFrames
// ═══════════════════════════════════════════════════════════════════════════

const frame = (notReady, coverage, t, tilesSelected = 0) => ({
  notReady,
  coverage,
  t,
  tilesSelected,
});

test("summarizeLaneFrames finds the longest skip run and its wall-clock span", () => {
  const s = summarizeLaneFrames([
    frame(0, 0.9, 0),
    frame(2, 0.4, 16, 30), // run A starts
    frame(1, 0.5, 32, 28),
    frame(0, 0.9, 48),
    frame(3, 0.2, 64, 44), // run B — longer
    frame(3, 0.2, 80, 46),
    frame(1, 0.3, 96, 40),
    frame(0, 0.9, 112),
  ]);
  assert.equal(s.frameCount, 8);
  assert.equal(s.skipFrames, 5);
  assert.equal(s.longestSkipRun, 3);
  assert.equal(s.longestSkipRunMs, 96 - 64);
  assert.equal(s.peakNotReady, 3);
  assert.equal(s.peakTilesAtRisk, 46);
  assert.equal(s.minCoverage, 0.2);
  assert.equal(s.maxCoverage, 0.9);
  assert.equal(s.finalCoverage, 0.9);
  assert.equal(s.firstSkipFrameIndex, 1);
  assert.equal(s.lastSkipFrameIndex, 6);
});

test("summarizeLaneFrames reports a clean lane as clean, not as absent data", () => {
  const s = summarizeLaneFrames([frame(0, 0.9, 0), frame(0, 0.91, 16)]);
  assert.equal(s.skipFrames, 0);
  assert.equal(s.longestSkipRun, 0);
  assert.equal(s.longestSkipRunMs, null);
  assert.equal(s.peakNotReady, 0);
  assert.equal(s.peakTilesAtRisk, 0);
  assert.equal(s.minCoverage, 0.9);
});

test("summarizeLaneFrames handles an empty or absent series without throwing", () => {
  for (const input of [[], null, undefined]) {
    const s = summarizeLaneFrames(input);
    assert.equal(s.frameCount, 0);
    assert.equal(s.minCoverage, null);
    assert.equal(s.finalCoverage, null);
    assert.equal(s.firstSkipFrameIndex, null);
  }
});

test("summarizeLaneFrames ignores non-finite coverage rather than poisoning min/max", () => {
  const s = summarizeLaneFrames([
    frame(0, null, 0),
    frame(0, 0.8, 16),
    frame(0, undefined, 32),
  ]);
  assert.equal(s.minCoverage, 0.8);
  assert.equal(s.maxCoverage, 0.8);
  // The LAST frame has no coverage, so finalCoverage must be null, not 0.8 —
  // silently carrying the previous value forward would fabricate a recovery.
  assert.equal(s.finalCoverage, null);
});

test("a run that reaches the last frame is still measured (no off-by-one truncation)", () => {
  const s = summarizeLaneFrames([
    frame(0, 0.9, 0),
    frame(1, 0.1, 16),
    frame(1, 0.1, 32),
  ]);
  assert.equal(s.longestSkipRun, 2);
  assert.equal(s.lastSkipFrameIndex, 2);
  assert.equal(s.longestSkipRunMs, 16);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. compareCoverageSeries — the lane that decides whether this matters
// ═══════════════════════════════════════════════════════════════════════════

const pair = (glCov, gpuCov) => [
  glCov.map((c, i) => frame(0, c, i * 16)),
  gpuCov.map((c, i) => frame(0, c, i * 16)),
];

test("a transient dip that recovers is the traced mechanism", () => {
  const [a, b] = pair(
    [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
    [0.9, 0.9, 0.2, 0.3, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
  );
  const c = compareCoverageSeries(a, b);
  assert.equal(c.aligned, true);
  assert.ok(Math.abs(c.worstDeficit - 0.7) < 1e-12);
  assert.equal(c.worstFrameIndex, 2);
  assert.equal(c.deficitFrames, 2);
  assert.equal(c.longestDeficitRun, 2);
  assert.equal(c.longestDeficitRunMs, 16);
  assert.equal(c.recovered, true);
  assert.equal(c.transientDivergence, true);
  assert.equal(c.persistentDivergence, false);
});

test("a deficit that never recovers is classified separately, not as the traced mechanism", () => {
  const [a, b] = pair(
    [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
    [0.9, 0.5, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4],
  );
  const c = compareCoverageSeries(a, b);
  assert.equal(c.persistentDivergence, true);
  assert.equal(c.transientDivergence, false);
  assert.equal(c.recovered, false);
});

test("no divergence reads as no divergence", () => {
  const [a, b] = pair(
    [0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
    [0.89, 0.9, 0.88, 0.9, 0.9, 0.89],
  );
  const c = compareCoverageSeries(a, b);
  assert.equal(c.transientDivergence, false);
  assert.equal(c.persistentDivergence, false);
  assert.equal(c.deficitFrames, 0);
  assert.equal(c.recovered, true);
});

test("mismatched frame counts are STRUCTURAL, never silently truncated", () => {
  // Two differently-paced runs are not the same point-by-point sequence. The
  // eclipse lanes learned this the expensive way: comparing across runs is the
  // failure mode, and quietly comparing the overlapping prefix would hide it.
  const [a] = pair([0.9, 0.9, 0.9], []);
  const [, b] = pair([], [0.9, 0.9]);
  const c = compareCoverageSeries(a, b);
  assert.equal(c.aligned, false);
  assert.match(c.reason, /frame counts differ/);
  assert.equal(c.webglFrameCount, 3);
  assert.equal(c.webgpuFrameCount, 2);
});

test("empty input is STRUCTURAL, not a clean pass", () => {
  const c = compareCoverageSeries([], []);
  assert.equal(c.aligned, false);
  assert.match(c.reason, /no frames/);
});

test("recovery is judged on the settled tail, not on a single last frame", () => {
  // One good final frame after a sustained deficit must NOT read as recovery.
  const gl = new Array(20).fill(0.9);
  const gpu = new Array(19).fill(0.3).concat([0.9]);
  const [a, b] = pair(gl, gpu);
  const c = compareCoverageSeries(a, b);
  assert.equal(c.recovered, false, "a single good frame is not a recovery");
  assert.equal(c.persistentDivergence, true);
});

test("the divergence threshold and recovery tolerance are both honoured", () => {
  const [a, b] = pair(
    [0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
    [0.9, 0.85, 0.9, 0.9, 0.9, 0.9],
  );
  // 0.05 deficit: below the default 0.1 threshold.
  assert.equal(compareCoverageSeries(a, b).deficitFrames, 0);
  // ...but detectable when the caller asks for a tighter bar.
  assert.equal(
    compareCoverageSeries(a, b, { minDivergence: 0.04 }).deficitFrames,
    1,
  );
});

test("non-finite samples are skipped without breaking the run tracker", () => {
  const a = [frame(0, 0.9, 0), frame(0, null, 16), frame(0, 0.9, 32)];
  const b = [frame(0, 0.2, 0), frame(0, null, 16), frame(0, 0.2, 32)];
  const c = compareCoverageSeries(a, b);
  assert.equal(c.aligned, true);
  // The null frame breaks the run: two isolated deficit frames, not one run of
  // three. Carrying a run across a hole would overstate the duration.
  assert.equal(c.longestDeficitRun, 1);
  assert.equal(c.deficitFrames, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. assertLaneNonVacuous — a lane must be unable to pass without arming
// ═══════════════════════════════════════════════════════════════════════════

test("a lane that requested no new variant cannot claim to have tested the mechanism", () => {
  const summary = summarizeLaneFrames([frame(0, 0.9, 0), frame(0, 0.9, 16)]);
  const diff = diffVariantKeys(["UNGO_28|0"], ["UNGO_28|0"]);
  const r = assertLaneNonVacuous(summary, diff, { requireVariantMiss: true });
  assert.equal(r.nonVacuous, false);
  assert.match(r.reasons.join(" "), /never entered the condition/);
});

test("a control that never observed an unresolved entry proves nothing", () => {
  const summary = summarizeLaneFrames([frame(0, 0.9, 0), frame(0, 0.9, 16)]);
  const r = assertLaneNonVacuous(summary, diffVariantKeys([], []), {
    requireSkipFrame: true,
  });
  assert.equal(r.nonVacuous, false);
  assert.match(r.reasons.join(" "), /arming mechanism did not fire/);
});

test("an armed lane passes the non-vacuity check", () => {
  const summary = summarizeLaneFrames([
    frame(2, 0.2, 0, 40),
    frame(0, 0.9, 16),
  ]);
  const diff = diffVariantKeys(["UNGO_28|0"], ["UNGO_28|0", "UNGB_28_NC|0"]);
  const r = assertLaneNonVacuous(summary, diff, {
    requireVariantMiss: true,
    requireSkipFrame: true,
  });
  assert.deepEqual(r.reasons, []);
  assert.equal(r.nonVacuous, true);
});

test("a lane with frames but no finite coverage is vacuous even without explicit expectations", () => {
  const summary = summarizeLaneFrames([frame(0, null, 0), frame(0, null, 16)]);
  const r = assertLaneNonVacuous(summary, diffVariantKeys([], []));
  assert.equal(r.nonVacuous, false);
  assert.match(r.reasons.join(" "), /no finite coverage samples/);
});

test("an empty lane is vacuous", () => {
  const r = assertLaneNonVacuous(
    summarizeLaneFrames([]),
    diffVariantKeys([], []),
  );
  assert.equal(r.nonVacuous, false);
  assert.match(r.reasons.join(" "), /no frames/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Probe-file conventions the fleet has paid for
// ═══════════════════════════════════════════════════════════════════════════

const probeSrc = fs.readFileSync(
  path.join(here, "probe-globe-pipeline-readiness.mjs"),
  "utf8",
);

test("every render loop in the probe yields, except the ONE labelled control", () => {
  // The whole question is what happens with a healthy event loop, so a
  // non-yielding loop anywhere else would silently answer a different question.
  // The control is allowed exactly one, and it must be labelled.
  const renderCalls = probeSrc.match(/scene\.render\(T\(\)\)/g) ?? [];
  assert.ok(renderCalls.length >= 6, "expected several render sites");
  const yields = probeSrc.match(/await\s+yieldFrame\(\)/g) ?? [];
  assert.ok(
    yields.length >= renderCalls.length - 2,
    `render sites (${renderCalls.length}) far outnumber yields (${yields.length})`,
  );
  assert.ok(
    /yieldFrame\s*=\s*\(\)\s*=>\s*new Promise\(\s*\(r\)\s*=>\s*requestAnimationFrame\(r\)\s*\)/.test(
      probeSrc,
    ),
    "yieldFrame must be a requestAnimationFrame yield",
  );
  assert.ok(
    /DELIBERATELY SYNCHRONOUS/.test(probeSrc),
    "the one non-yielding loop must be explicitly labelled as the control",
  );
});

test("the probe deletes its own artifacts before reading any", () => {
  assert.ok(
    /fs\.rmSync\([\s\S]{0,120}SHOT_PREFIX|name\.startsWith\(SHOT_PREFIX\)/.test(
      probeSrc,
    ),
    "stale PNGs must be removed before the run",
  );
  const rmIdx = probeSrc.indexOf("fs.rmSync");
  const runIdx = probeSrc.indexOf("await runBackend(browser");
  assert.ok(rmIdx > 0 && runIdx > rmIdx, "deletion must precede the run");
});

test("the probe verifies backend identity on both sides", () => {
  for (const marker of [
    "rendererType",
    "isWebGPU",
    "hasDevice",
    "backendMismatch",
  ]) {
    assert.ok(probeSrc.includes(marker), `missing backend check: ${marker}`);
  }
});

test("the probe captures the canvas element in the same task as the render", () => {
  assert.ok(
    /canvas\.toDataURL\("image\/png"\)/.test(probeSrc),
    "canvas must be read in-page, in-task",
  );
  assert.ok(
    !/page\.screenshot\(/.test(probeSrc),
    "page.screenshot captures the page after the task; use the canvas element",
  );
});

test("the probe has a watchdog, and it is unref'd", () => {
  assert.match(probeSrc, /const watchdog = setTimeout\(/);
  assert.match(probeSrc, /watchdog\.unref/);
  assert.match(probeSrc, /process\.exit\(2\)/);
});

test("the probe exits 0 / 1 / 2 for pass / gate-fail / structural", () => {
  assert.match(
    probeSrc,
    /const exitCode = structural \? 2 : anyFail \? 1 : 0/,
    "the fleet's exit-code contract",
  );
});

test("no helper used inside a page.evaluate callback is taken from module scope", () => {
  // `page.evaluate` serializes the FUNCTION, not its closure. This has broken
  // probes twice. The MEASURE callback receives `cfg` and `lanes` as arguments;
  // it must not reference the module-scope constants they came from.
  const start = probeSrc.indexOf("const MEASURE = async (");
  const end = probeSrc.indexOf("// ── Playwright driver");
  assert.ok(start > 0 && end > start, "MEASURE callback not found");
  // Comments are stripped first: the callback's own section banners legitimately
  // say "LANE"/"LANES", and matching those would be a false positive on the
  // very rule being enforced.
  const body = probeSrc
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  for (const moduleScoped of [
    "CFG",
    "LANES",
    "BASE",
    "OUT_DIR",
    "REPORT",
    "r3",
  ]) {
    assert.ok(
      !new RegExp(`\\b${moduleScoped}\\b`).test(body),
      `MEASURE references module-scope binding ${moduleScoped}, which will be ` +
        `a ReferenceError inside page.evaluate`,
    );
  }
  // And it must not import from Node either.
  assert.ok(!/\bfs\./.test(body) && !/\bpath\./.test(body));
});

test("the comment-stripping in the module-scope scan cannot mask a real violation", () => {
  // Guards the guard: a bare `CFG` on a code line must still be caught after
  // stripping. Without this, a stripper bug would silently disable the test above.
  const strip = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  assert.ok(/\bCFG\b/.test(strip("  const x = CFG.gridW;\n")));
  assert.ok(!/\bCFG\b/.test(strip("  // uses CFG here\n")));
});

test("the probe's config carries the sanity floors as derived gates, not bare constants", () => {
  // `settledCoverageFloor` is compared against the SAME lane's settled
  // baseline, and the failure must name the real cause rather than only saying
  // the instrument is unusable.
  assert.ok(probeSrc.includes("settledCoverageFloor"));
  assert.match(
    probeSrc,
    /not\s+measuring the globe/,
    "the floor's failure message must name the actual cause",
  );
  assert.ok(probeSrc.includes("minDiscCells"));
  assert.match(probeSrc, /denominator is too thin/);
});

test("the control's failure to arm is STRUCTURAL, not a pass", () => {
  const idx = probeSrc.indexOf("controlCollapsed");
  assert.ok(idx > 0);
  assert.match(
    probeSrc,
    /has not demonstrated it can detect the symptom/,
    "a control that does not collapse must invalidate the whole run",
  );
  // It must push onto structuralReasons, not set anyFail.
  const block = probeSrc.slice(idx, idx + 2600);
  assert.ok(
    /if \(!controlCollapsed \|\| !ctlNonVacuous\.nonVacuous\) \{[\s\S]{0,200}structuralReasons\.push/.test(
      block,
    ),
    "control failure must be structural",
  );
});

test("a coverage deficit must be ATTRIBUTED before it counts as this mechanism", () => {
  // The two backends run in independent page loads, so their tile streaming is
  // on independent network timelines. A lane that retargets to a fresh region
  // will show coverage differences driven purely by which side got its tiles
  // first — a race in the fixture, not a finding. The deficit only counts when
  // WebGPU actually held an unresolved pipeline entry at the worst frame.
  assert.ok(probeSrc.includes("attributableToPipelineSkip"));
  assert.match(
    probeSrc,
    /tile-streaming timing between two independent page loads/,
    "the unattributed case must name the real alternative explanation",
  );
  assert.match(
    probeSrc,
    /if \(cmp\.persistentDivergence && overlaps\)/,
    "an unattributed divergence must not be able to fail the gate",
  );
  // The overlap test must be a real window containment, not merely "any skip".
  assert.match(
    probeSrc,
    /worstIdx >= skipFirst &&\s*worstIdx <= skipLast/,
    "attribution must require the worst frame to fall inside the skip window",
  );
});

test("the cold-start lane suppresses the viewer's own render loop before the first frame", () => {
  // `page.evaluate` cannot run until long after the viewer is constructed, so
  // "fresh page" alone does not give a cold cache — the default render loop
  // would already have warmed it. The interception must be an init script
  // (which runs before page scripts) and must hook the ASSIGNMENT, not poll.
  assert.ok(
    probeSrc.includes("page.addInitScript"),
    "the render-loop suppression must run before page scripts",
  );
  assert.match(
    probeSrc,
    /Object\.defineProperty\(window, "viewer"[\s\S]{0,400}?useDefaultRenderLoop = false/,
    "the suppression must intercept the window.viewer assignment",
  );
  const initIdx = probeSrc.indexOf("page.addInitScript");
  const gotoIdx = probeSrc.indexOf("await page.goto(");
  assert.ok(
    initIdx > 0 && gotoIdx > initIdx,
    "the init script must be installed before navigation",
  );
});

test("a cold-start lane that started WARM is vacuous, not a clean result", () => {
  // The one lane whose precondition can only be observed, never arranged. If
  // the suppression lost the race, "no holes" says nothing about a cold start.
  assert.ok(probeSrc.includes("genuinelyCold"));
  assert.ok(probeSrc.includes("__probeSuppressedRenderLoop"));
  assert.match(
    probeSrc,
    /genuinelyCold !== true[\s\S]{0,300}?vacuous: true/,
    "a warm start must mark the lane vacuous",
  );
  assert.match(
    probeSrc,
    /cannot be ` \+\s*`read as evidence about cold-start behaviour/,
    "the vacuity reason must say what the lane can no longer support",
  );
  // And a vacuous lane must not contribute a parity row.
  assert.match(
    probeSrc,
    /vacuous === true[\s\S]{0,400}?skipped: true/,
    "a vacuous lane must be excluded from the parity comparison",
  );
});

test("both lazily-created instrument handles are resolved per call, not captured up front", () => {
  // The globe-surface feature renderer and the central pipeline cache are each
  // created on demand during the first render. The probe's callback runs BEFORE
  // it has rendered anything (the viewer's loop was suppressed), so a one-time
  // capture of either would be null and would silently disable every WebGPU
  // lane — reported as "instrument unavailable on WebGPU", the most misleading
  // failure this probe could produce.
  assert.ok(probeSrc.includes("const getCentralCache = () =>"));
  assert.ok(probeSrc.includes("const getLocalCache = () =>"));
  assert.ok(
    !/const centralCache = scene\.context\._webgpuPipelineCache/.test(probeSrc),
    "the central cache must not be captured once at callback start",
  );
  assert.ok(
    !/const localCache =\s*\n?\s*globeRenderer/.test(probeSrc),
    "the renderer-local cache must not be captured once at callback start",
  );
  // Availability must therefore be decided AFTER rendering, not at entry.
  const availIdx = probeSrc.indexOf("out.instrument.available = true");
  const coldIdx = probeSrc.indexOf("LANE (c): COLD START");
  assert.ok(availIdx > 0 && coldIdx > 0);
  assert.ok(
    availIdx > coldIdx,
    "instrument availability must be decided after frames have rendered",
  );
});

test("an unavailable WebGPU instrument is STRUCTURAL and says why", () => {
  assert.match(
    probeSrc,
    /this run cannot answer its question/,
    "a missing instrument must not surface as a confusing control failure",
  );
});

test("the probe names selected-tile count as an UPPER BOUND, since no skip counter exists", () => {
  assert.match(probeSrc, /UPPER BOUND|upper bound|UpperBound/);
  assert.ok(
    probeSrc.includes("webgpuPeakTilesAtRiskUpperBound"),
    "the reported field must carry the bound in its name",
  );
});
