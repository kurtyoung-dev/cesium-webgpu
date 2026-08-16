// cloud-observability-counters.spec.mjs — C13-02 (cloud CPU/GPU observability
// and temporal-cost counters), the Gate-A evidence input.
// @purpose C13-02 Gate-A: cloud GPU total is a union not a sum, Sky Fill excluded, per-frame counters reset, pass counts tied to encode sites.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, no build, no adapter.
//
// WHAT THIS EXISTS TO CATCH.
//
//   - the cloud GPU total goes back to being a SUM of pass durations. C11-140
//     (Batch 903) established that summing overlapping passes double-counts
//     their intersection, and that a ratio clamped to 1 hides the double-count
//     rather than reporting it. The cloud lane is exactly where overlap is
//     plausible (shadow map / cascade atlas / half-res march are separate
//     passes a driver may reorder), so the cloud measure is the UNION, folded
//     through the same `summarizeFrameCoverage`. The A-group builds a frame
//     whose sum and union differ and demands the difference be REPORTED;
//
//   - the environment Sky Fill gets folded into the cloud union. It is the
//     pass the cloud deck FEEDS, not one it owns, and attributing a whole sky
//     bake to the cloud lane is the attribution error C11-146's settle-window
//     rule exists to prevent. It is a separate scope and A5 pins that;
//
//   - a per-frame counter stops being reset, so a culled or quiescent frame
//     reports last frame's target sizes and pass counts as current work. B1/B3
//     enumerate the record and require every per-frame field to be zeroed,
//     which means a field ADDED later without a reset entry fails here rather
//     than in a probe six batches downstream;
//
//   - the pass counts drift from the encode sites. The counts ride the ONE
//     `timedCloudPass` seam every cloud pass already routes through, and D1
//     checks the correspondence in BOTH directions: a label in the registry
//     with no encode site, and an encode site whose label is not registered,
//     both fail;
//
//   - CPU stage timing becomes default-ON. C13-02's own text requires the
//     instrumentation to be removable without changing the render result, and
//     a `performance.now()` pair straddling each stage is observable work on
//     the shipped path. C1/D6 pin the default;
//
//   - the row acquires WGSL. C13-39's negative result is binding: WGSL
//     register allocation is static, so even a runtime-gated shader counter
//     costs occupancy on the default path. Every counter here is CPU-side, the
//     sample figures are explicitly BOUNDED PROXIES, and D5 enforces that no
//     cloud shader gained an observability token.
//
// Run: node --test Tools/visual-regression/cloud-observability-counters.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const enginePath = (p) => path.join(root, "packages/engine/Source", p);

// Multi-line source anchors below are written with LF. The checkout is CRLF on
// Windows working trees, so normalize or every anchor silently misses.
const readEngine = (p) =>
  fs.readFileSync(enginePath(p), "utf8").replace(/\r\n/g, "\n");

const cloudRenderer = readEngine(
  "Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
);
const observabilitySource = readEngine(
  "Renderer/WebGPU/WebGPUCloudObservability.ts",
);
const profilerSource = readEngine("Renderer/WebGPU/WebGPUTimestampProfiler.ts");
const contextSource = readEngine("Renderer/WebGPU/WebGPUContext.ts");
const debugSource = readEngine("Scene/CesiumDebug.js");

const toDataUrl = (code) =>
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

/**
 * Transpiles one engine TS module to a data: URL. A data: module cannot
 * resolve relative specifiers, so every value import is rewritten to the
 * already-transpiled dependency's URL. (`import type` is erased by esbuild.)
 */
async function transpileEngineModule(relativePath, rewrites = {}) {
  let source = fs.readFileSync(enginePath(relativePath), "utf8");
  for (const [specifier, url] of Object.entries(rewrites)) {
    source = source.replaceAll(specifier, url);
  }
  const { code } = await transform(source, {
    loader: "ts",
    format: "esm",
    target: "es2022",
  });
  return toDataUrl(code);
}

const accountingUrl = await transpileEngineModule(
  "Renderer/WebGPU/WebGPUTimestampAccounting.ts",
);
// C13-09 — the observability snapshot publishes the attachment CONTRACT, so
// its module has to be transpiled and its specifier rewritten too. It has no
// relative imports of its own, which is why one level is enough.
const attachmentsUrl = await transpileEngineModule(
  "Renderer/WebGPU/WebGPUCloudReconstructionAttachments.ts",
);
const observabilityUrl = await transpileEngineModule(
  "Renderer/WebGPU/WebGPUCloudObservability.ts",
  {
    "./WebGPUTimestampAccounting.js": accountingUrl,
    "./WebGPUCloudReconstructionAttachments.js": attachmentsUrl,
  },
);
const observability = await import(observabilityUrl);
const {
  CLOUD_TIMED_PASS_NAMES,
  CLOUD_ENVIRONMENT_TIMED_PASS_NAMES,
  CLOUD_CPU_STAGE_NAMES,
  CLOUD_CPU_STAGE_COUNT,
  CloudCpuStage,
  CloudCpuStageAccumulator,
  createCloudFrameCounters,
  recordCloudPass,
  resetCloudFrameCounters,
  snapshotCloudObservability,
  summarizeCloudGpuCoverage,
} = observability;

const MS = 1_000_000; // nanoseconds per millisecond
const pass = (name, beginMs, endMs) => ({
  name,
  beginNs: beginMs * MS,
  endNs: endMs * MS,
});

const SHADOW_MAP = "CloudShadow map pass";
const HALF_RES = "ProceduralClouds half-res pass";
const UPSCALE = "CloudUpscale composite pass";
const SKY_FILL = "DynEnvMap Sky Fill";

// ─────────────────────────────────────────────────────────────────────────────
// A. The cloud-scoped unique-sample fold
// ─────────────────────────────────────────────────────────────────────────────

test("A1 overlapping cloud passes are counted ONCE, and the overlap is reported", () => {
  // Shadow map [0,3) and half-res march [2,5) share 1 ms of GPU time; the
  // upscale at [7,8) leaves a 2 ms gap the union must NOT claim.
  const coverage = summarizeCloudGpuCoverage([
    pass(SHADOW_MAP, 0, 3),
    pass(HALF_RES, 2, 5),
    pass(UPSCALE, 7, 8),
  ]);
  assert.equal(coverage.cloudSummedMs, 7, "the naive sum double-counts [2,3)");
  assert.equal(coverage.cloudCoveredMs, 6, "the union counts it once");
  assert.equal(coverage.cloudOverlapMs, 1);
  assert.equal(coverage.cloudSpanMs, 8, "span includes the 2 ms idle gap");
  // The whole point: the reported cloud time is the union, and it is STRICTLY
  // less than the sum a naive accumulator would have published.
  assert.ok(coverage.cloudCoveredMs < coverage.cloudSummedMs);
});

test("A2 non-cloud passes are excluded from the union but define the frame span", () => {
  const coverage = summarizeCloudGpuCoverage([
    pass("Globe pass", 0, 4),
    pass(HALF_RES, 5, 7),
    pass("PostProcess pass", 8, 10),
  ]);
  assert.equal(coverage.cloudCoveredMs, 2, "only the cloud pass is in scope");
  assert.equal(coverage.frameSpanMs, 10, "the span is the WHOLE frame");
  assert.equal(coverage.cloudFrameFraction, 0.2);
  assert.equal(coverage.matchedPassCount, 1);
});

test("A3 registered cloud passes that produced no sample are named", () => {
  const coverage = summarizeCloudGpuCoverage([pass(HALF_RES, 0, 1)]);
  assert.equal(coverage.matchedPassCount, 1);
  assert.equal(
    coverage.missingPassNames.length,
    CLOUD_TIMED_PASS_NAMES.length - 1,
  );
  assert.ok(coverage.missingPassNames.includes(SHADOW_MAP));
  assert.ok(!coverage.missingPassNames.includes(HALF_RES));
});

test("A4 a frame with no cloud passes reports zero, not a fabricated fraction", () => {
  const coverage = summarizeCloudGpuCoverage([pass("Globe pass", 0, 4)]);
  assert.equal(coverage.cloudCoveredMs, 0);
  assert.equal(coverage.cloudFrameFraction, 0);
  const empty = summarizeCloudGpuCoverage([]);
  assert.equal(empty.frameSpanMs, 0);
  assert.equal(
    empty.cloudFrameFraction,
    null,
    "a degenerate span yields null, never a divide-by-zero or a 0 that reads as measured",
  );
});

test("A5 the environment Sky Fill is a SEPARATE scope, never folded into the cloud union", () => {
  const samples = [pass(HALF_RES, 0, 2), pass(SKY_FILL, 2, 9)];
  const clouds = summarizeCloudGpuCoverage(samples);
  const environment = summarizeCloudGpuCoverage(
    samples,
    CLOUD_ENVIRONMENT_TIMED_PASS_NAMES,
  );
  assert.equal(clouds.cloudCoveredMs, 2, "the 7 ms sky bake is not cloud time");
  assert.equal(environment.cloudCoveredMs, 7);
  assert.ok(!CLOUD_TIMED_PASS_NAMES.includes(SKY_FILL));
});

test("A6 an inverted sample (driver residue) is counted, never folded as negative time", () => {
  const coverage = summarizeCloudGpuCoverage([
    pass(HALF_RES, 5, 1),
    pass(UPSCALE, 6, 8),
  ]);
  assert.equal(coverage.invertedSampleCount, 1);
  assert.equal(coverage.cloudCoveredMs, 2);
  assert.ok(coverage.cloudCoveredMs >= 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// B. The per-frame counter record
// ─────────────────────────────────────────────────────────────────────────────

/** Per-frame fields: every one must be zero after a reset. */
const PER_FRAME_NUMERIC_FIELDS = Object.freeze([
  "marchWidth",
  "marchHeight",
  "marchPixels",
  "halfResActive",
  "resolveWidth",
  "resolveHeight",
  "resolvePixels",
  "upscalePixels",
  "maxSteps",
  "lightSteps",
  "primarySampleBudget",
  "lightSampleBudget",
  "historyAccepted",
  "historyRejected",
  "historyReset",
  "historyResetReasons",
  "attachmentWidth",
  "attachmentHeight",
  "attachmentPixels",
  "attachmentCount",
  "attachmentGeneration",
  "weatherCacheHits",
  "weatherCacheMisses",
  "weatherUploads",
  "weatherUploadBytes",
  "shadowPassCount",
  "shadowSize",
  "shadowCascadeSize",
  "shadowCascadeCount",
  "passCount",
]);

/** Fields that must SURVIVE a reset, with the reason each one does. */
const SURVIVING_FIELDS = Object.freeze({
  frames:
    "lifetime execute count — resetting it erases the only proof the lane ran",
  culledFrames: "lifetime cull count, same reason",
  weatherLiveBytes:
    "describes a RESIDENT texture, not this frame's work — zeroing it would report the texture as freed every quiescent frame",
  attachmentLiveBytes:
    "C13-09 — describes the RESIDENT reconstruction attachment set, same reason as weatherLiveBytes",
  reconstructionRequested:
    "C13-10 — describes the RESIDENT request for march-emitted reconstruction. Zeroing it every frame would make a frame that ASKED for the variant and fell back (full-resolution tier, orthographic/morph, a pipeline that could not build) indistinguishable from one where nobody asked — which is the exact evidence Gate C needs beside `reconstructionEmitted`",
});

test("B1 reset zeroes every per-frame field, in place, with no reallocation", () => {
  const counters = createCloudFrameCounters();
  const passCountsIdentity = counters.passCounts;
  for (const field of PER_FRAME_NUMERIC_FIELDS) {
    counters[field] = 4242;
  }
  counters.passCounts.fill(7);
  counters.weatherLiveBytes = 131072;

  resetCloudFrameCounters(counters);

  for (const field of PER_FRAME_NUMERIC_FIELDS) {
    assert.equal(counters[field], 0, `${field} survived the reset`);
  }
  assert.deepEqual(
    Array.from(counters.passCounts),
    new Array(CLOUD_TIMED_PASS_NAMES.length).fill(0),
  );
  assert.equal(
    counters.passCounts,
    passCountsIdentity,
    "the per-pass array must be reused, not reallocated (no per-frame allocation)",
  );
  assert.equal(
    counters.weatherLiveBytes,
    131072,
    SURVIVING_FIELDS.weatherLiveBytes,
  );
  assert.equal(counters.frames, 1, "reset bumps the lifetime execute count");
});

test("B2 the reset list COVERS the record — a new per-frame field cannot be forgotten", () => {
  // Structural: poison every numeric field, reset, and assert the ONLY
  // non-zero survivors are the ones with a recorded reason. A field added to
  // the interface without a reset entry fails right here.
  const counters = createCloudFrameCounters();
  for (const [key, value] of Object.entries(counters)) {
    if (typeof value === "number") {
      counters[key] = 99;
    }
  }
  resetCloudFrameCounters(counters);
  const survivors = Object.entries(counters)
    .filter(([, value]) => typeof value === "number" && value !== 0)
    .map(([key]) => key)
    .sort();
  assert.deepEqual(
    survivors,
    Object.keys(SURVIVING_FIELDS).sort(),
    "an unexpected field survived the per-frame reset (or a documented survivor stopped surviving)",
  );
});

test("B3 the culled path is counted as an execute AND as a cull", () => {
  const counters = createCloudFrameCounters();
  resetCloudFrameCounters(counters);
  counters.culledFrames++; // what the frustum-cull early return does
  resetCloudFrameCounters(counters);
  assert.equal(counters.frames, 2);
  assert.equal(counters.culledFrames, 1);
  assert.ok(
    counters.frames > counters.culledFrames,
    "frames must be the denominator a cull rate can be read against",
  );
});

test("B4 recordCloudPass keys by label; an unregistered label still moves the total", () => {
  const counters = createCloudFrameCounters();
  recordCloudPass(counters, SHADOW_MAP);
  recordCloudPass(counters, HALF_RES);
  recordCloudPass(counters, HALF_RES);
  recordCloudPass(counters, "Some Future Cloud Pass");
  recordCloudPass(counters, undefined);
  assert.equal(counters.passCount, 5, "the total counts every encoded pass");
  assert.equal(
    counters.passCounts[CLOUD_TIMED_PASS_NAMES.indexOf(SHADOW_MAP)],
    1,
  );
  assert.equal(
    counters.passCounts[CLOUD_TIMED_PASS_NAMES.indexOf(HALF_RES)],
    2,
  );
  assert.equal(
    counters.passCounts.reduce((a, b) => a + b, 0),
    3,
    "an unregistered pass is a visible gap between total and breakdown, not a silent omission",
  );
  // Must not throw before the cache exists.
  assert.doesNotThrow(() => recordCloudPass(undefined, SHADOW_MAP));
});

// ─────────────────────────────────────────────────────────────────────────────
// C. CPU stage timing — off by default, and provably inert when off
// ─────────────────────────────────────────────────────────────────────────────

test("C1 stage timing is OFF by default and records nothing", () => {
  const stages = new CloudCpuStageAccumulator();
  assert.equal(stages.enabled, false);
  stages.beginStage(CloudCpuStage.TOTAL);
  stages.endStage(CloudCpuStage.TOTAL);
  const snap = stages.snapshot();
  assert.equal(snap.enabled, false);
  for (const name of CLOUD_CPU_STAGE_NAMES) {
    assert.equal(
      snap.stages[name].samples,
      0,
      `${name} recorded while disabled`,
    );
  }
});

test("C2 enabling records; disabling CLEARS, so a stale run cannot read as current", () => {
  const stages = new CloudCpuStageAccumulator();
  stages.setEnabled(true);
  stages.beginStage(CloudCpuStage.PACK);
  stages.endStage(CloudCpuStage.PACK);
  stages.beginStage(CloudCpuStage.PACK);
  stages.endStage(CloudCpuStage.PACK);
  let snap = stages.snapshot();
  assert.equal(snap.enabled, true);
  assert.equal(snap.stages.pack.samples, 2);
  assert.ok(snap.stages.pack.lastMs >= 0);
  assert.ok(snap.stages.pack.maxMs >= snap.stages.pack.lastMs - 1e-9);

  stages.setEnabled(false);
  snap = stages.snapshot();
  assert.equal(snap.stages.pack.samples, 0, "disabling must clear the window");
  assert.equal(snap.stages.pack.maxMs, 0);
});

test("C3 re-entry and unmatched ends are COUNTED, not folded into a bogus duration", () => {
  const stages = new CloudCpuStageAccumulator();
  stages.setEnabled(true);
  stages.beginStage(CloudCpuStage.SHADOW);
  stages.beginStage(CloudCpuStage.SHADOW); // re-entry
  stages.endStage(CloudCpuStage.SHADOW);
  stages.endStage(CloudCpuStage.SHADOW); // unmatched
  const snap = stages.snapshot();
  assert.equal(snap.reentries, 1);
  assert.equal(snap.unmatchedEnds, 1);
  assert.equal(
    snap.stages.shadow.samples,
    1,
    "exactly one duration was folded",
  );
});

test("C4 an out-of-range slot is ignored rather than corrupting a neighbour", () => {
  const stages = new CloudCpuStageAccumulator();
  stages.setEnabled(true);
  assert.doesNotThrow(() => stages.beginStage(-1));
  assert.doesNotThrow(() => stages.endStage(CLOUD_CPU_STAGE_COUNT));
  const snap = stages.snapshot();
  assert.equal(snap.unmatchedEnds, 0);
  for (const name of CLOUD_CPU_STAGE_NAMES) {
    assert.equal(snap.stages[name].samples, 0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// C'. The published snapshot
// ─────────────────────────────────────────────────────────────────────────────

test("C5 the snapshot publishes null GPU rather than a zero-filled timing block", () => {
  const counters = createCloudFrameCounters();
  const snap = snapshotCloudObservability({
    counters,
    cpu: new CloudCpuStageAccumulator(),
    temporal: { generation: 0, resetCount: 0, acceptedFrames: 0 },
    samples: null,
  });
  assert.equal(
    snap.gpu,
    null,
    "a zeroed timing block is indistinguishable from a genuinely idle lane",
  );
  assert.equal(snap.reconstruction.acceptanceThisFrame, null);
});

test("C6 the snapshot's sample figures are BOUNDED PROXIES derived from the budgets", () => {
  const counters = createCloudFrameCounters();
  counters.marchPixels = 1000;
  counters.maxSteps = 48;
  counters.lightSteps = 4;
  counters.primarySampleBudget = counters.marchPixels * counters.maxSteps;
  counters.lightSampleBudget =
    counters.primarySampleBudget * counters.lightSteps;
  counters.historyAccepted = 1;
  const snap = snapshotCloudObservability({
    counters,
    cpu: new CloudCpuStageAccumulator(),
    temporal: { generation: 3, resetCount: 2, acceptedFrames: 97 },
    samples: [pass(HALF_RES, 0, 2), pass(SKY_FILL, 3, 4)],
  });
  assert.equal(snap.raymarch.primarySampleBudget, 48000);
  assert.equal(snap.raymarch.lightSampleBudget, 192000);
  assert.equal(snap.reconstruction.acceptanceThisFrame, 1);
  assert.equal(snap.reconstruction.lifetime.resetCount, 2);
  assert.equal(snap.gpu.clouds.cloudCoveredMs, 2);
  assert.equal(snap.gpu.environment.cloudCoveredMs, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Source ownership — with mutation checks
// ─────────────────────────────────────────────────────────────────────────────

/** Assert `re` matches `source`, and that it STOPS matching a mutated copy. */
function pinWithMutant(source, re, mutate, label) {
  assert.match(source, re, `missing: ${label}`);
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutation was a no-op for: ${label}`);
  assert.doesNotMatch(
    mutated,
    re,
    `the check for "${label}" does not actually detect its own mutant`,
  );
}

test("D1 the pass registry and the encode sites agree in BOTH directions", () => {
  // Forward: every registered label has a `timedCloudPass` encode site.
  const encodeLabels = [
    ...cloudRenderer.matchAll(
      /timedCloudPass\(context, \{\n\s*label: "([^"]+)"/g,
    ),
  ].map((m) => m[1]);
  assert.equal(
    encodeLabels.length,
    CLOUD_TIMED_PASS_NAMES.length,
    `found ${encodeLabels.length} timedCloudPass sites for ${CLOUD_TIMED_PASS_NAMES.length} registered names`,
  );
  for (const name of CLOUD_TIMED_PASS_NAMES) {
    assert.ok(
      encodeLabels.includes(name),
      `registered cloud pass "${name}" has no encode site`,
    );
  }
  // Reverse: every encode site's label is registered. This is the direction a
  // NEW pass fails on, which is the point — an unregistered pass would land in
  // `passCount` but never in the per-pass breakdown or the GPU union.
  for (const label of encodeLabels) {
    assert.ok(
      CLOUD_TIMED_PASS_NAMES.includes(label),
      `encoded cloud pass "${label}" is not in CLOUD_TIMED_PASS_NAMES`,
    );
  }
  // And the Sky Fill label the environment scope keys on is real.
  assert.equal(CLOUD_ENVIRONMENT_TIMED_PASS_NAMES.length, 1);
  assert.ok(
    readEngine(
      "Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
    ).includes(`label: "${CLOUD_ENVIRONMENT_TIMED_PASS_NAMES[0]}"`),
  );
});

test("D2 pass accounting rides the ONE timing seam, so it cannot drift from the encodes", () => {
  pinWithMutant(
    cloudRenderer,
    /recordCloudPass\(context\._cloudCache\?\.observability, descriptor\.label\);\n\s*return context\.withRenderPassTimestamps/,
    (s) =>
      s.replace(
        "  recordCloudPass(context._cloudCache?.observability, descriptor.label);\n",
        "",
      ),
    "recordCloudPass is called from timedCloudPass",
  );
});

test("D3 the per-frame counters are reset up front and the cull path is counted", () => {
  pinWithMutant(
    cloudRenderer,
    /resetCloudFrameCounters\(existingCache\.observability\);/,
    (s) =>
      s.replace(
        "resetCloudFrameCounters(existingCache.observability);",
        "/* no reset */",
      ),
    "the execute resets the counters before doing anything else",
  );
  pinWithMutant(
    cloudRenderer,
    /context\._cloudCache\.observability\.culledFrames\+\+;/,
    (s) =>
      s.replace(
        "context._cloudCache.observability.culledFrames++;",
        "/* cull uncounted */",
      ),
    "the frustum-cull early return is counted as a cull",
  );
  // The first execute has no cache yet; its counters are reset after the cache
  // is created, so `frames` counts every execute exactly once.
  assert.match(
    cloudRenderer,
    /if \(existingCache === undefined\) \{\n\s*\/\/ First execute on this context[\s\S]*?resetCloudFrameCounters\(cache\.observability\);/,
  );
});

test("D4 the cloud GPU measure is a UNION fold, not a sum of pass durations", () => {
  pinWithMutant(
    observabilitySource,
    /const cloud = summarizeFrameCoverage\(scoped\);\n\s*const whole = summarizeFrameCoverage\(samples\);/,
    (s) =>
      s.replace(
        "const cloud = summarizeFrameCoverage(scoped);",
        "const cloud = { coveredMs: scoped.reduce((a, x) => a + (x.endNs - x.beginNs) / 1e6, 0) };",
      ),
    "the cloud scope folds through summarizeFrameCoverage",
  );
  // The profiler must RETAIN the intervals the fold consumed — without that a
  // scoped consumer has only `lastMs` per pass, i.e. the sum.
  pinWithMutant(
    profilerSource,
    /this\._latestFrameSamples = samples;/,
    (s) => s.replace("this._latestFrameSamples = samples;", "/* dropped */"),
    "the profiler retains the latest frame's raw intervals",
  );
  pinWithMutant(
    profilerSource,
    /get latestFrameSamples\(\): readonly TimedPassSample\[\] \{/,
    (s) =>
      s.replace(
        "get latestFrameSamples(): readonly TimedPassSample[] {",
        "private get unreachableSamples(): readonly TimedPassSample[] {",
      ),
    "the retained intervals are exposed",
  );
  // ...and it must be cleared on reset, or a scoped consumer keeps reporting a
  // pre-reset frame as current.
  assert.match(
    profilerSource,
    /this\._latestFrameSamples = \[\];\n\s*this\._attemptedFrames = 0;/,
  );
});

test("D5 ZERO WGSL — no cloud shader gained an observability token (C13-39 binds)", () => {
  const shaderDir = path.join(
    root,
    "packages/engine/Source/Shaders/WebGPU/Environment",
  );
  const shaders = fs
    .readdirSync(shaderDir)
    .filter(
      (name) => name.toLowerCase().includes("cloud") && name.endsWith(".wgsl"),
    );
  assert.ok(shaders.length >= 2, "expected the cloud WGSL family to be found");
  const forbidden = [
    "C13-02",
    "observability",
    "atomicAdd",
    "sampleCounter",
    "primarySampleBudget",
  ];
  for (const name of shaders) {
    const text = fs.readFileSync(path.join(shaderDir, name), "utf8");
    for (const token of forbidden) {
      assert.ok(
        !text.includes(token),
        `${name} contains "${token}" — this row is 100% CPU-side by C13-39 mandate`,
      );
    }
  }
  // The observability module itself must not reach for a shader either.
  assert.ok(!observabilitySource.includes(".wgsl"));
});

test("D6 CPU stage timing defaults to OFF in the source, not just at runtime", () => {
  pinWithMutant(
    observabilitySource,
    /private _enabled = false;/,
    (s) => s.replace("private _enabled = false;", "private _enabled = true;"),
    "the accumulator starts disabled",
  );
});

test("D7 the counters reach the two documented debug surfaces", () => {
  pinWithMutant(
    contextSource,
    /stats\.volumetricClouds = snapshotCloudObservability\(\{/,
    (s) =>
      s.replace(
        "stats.volumetricClouds = snapshotCloudObservability({",
        "stats.unpublished = snapshotCloudObservability({",
      ),
    "getRendererStatistics publishes volumetricClouds",
  );
  pinWithMutant(
    debugSource,
    /cloudStats\(enableCpuTiming\) \{/,
    (s) =>
      s.replace(
        "cloudStats(enableCpuTiming) {",
        "cloudStatsRemoved(enableCpuTiming) {",
      ),
    "CesiumDebug exposes cloudStats",
  );
  // The overlap warning is the runtime canary for the A1 defect class; a
  // reader who never sees it cannot know the union mattered.
  assert.match(debugSource, /cloudOverlapMs > 0/);
});

test("D8 the raymarch record reads the SAME resolved values the uniforms are packed from", () => {
  // The counters must not re-derive the geometry — a second derivation is a
  // second chance to disagree with what the shader actually got.
  pinWithMutant(
    cloudRenderer,
    /counters\.marchWidth = halfResActive \? cache\.halfWidth : canvasW;/,
    (s) =>
      s.replace(
        "counters.marchWidth = halfResActive ? cache.halfWidth : canvasW;",
        "counters.marchWidth = canvasW;",
      ),
    "the recorded march width follows the half-res gate",
  );
  // Byte-locked to the uniform pack two lines below it.
  assert.match(
    cloudRenderer,
    /data\[offset\+\+\] = halfResActive \? cache\.halfWidth : canvasW;/,
  );
  pinWithMutant(
    cloudRenderer,
    /counters\.maxSteps = qualityResolved\.maxSteps;/,
    (s) =>
      s.replace(
        "counters.maxSteps = qualityResolved.maxSteps;",
        "counters.maxSteps = 64;",
      ),
    "the recorded step budget is the RESOLVED one",
  );
});

test("D9 the temporal verdict is recorded on the same branches as the lifetime totals", () => {
  pinWithMutant(
    cloudRenderer,
    /cache\.temporalHistoryResetCount\+\+;\n\s*counters\.historyReset = 1;/,
    (s) =>
      s.replace(
        "        cache.temporalHistoryResetCount++;\n          counters.historyReset = 1;",
        "        cache.temporalHistoryResetCount++;",
      ),
    "historyReset marks only generation-starting rejections",
  );
  assert.match(
    cloudRenderer,
    /cache\.temporalHistoryAcceptedFrames\+\+;[\s\S]{0,160}counters\.historyAccepted = 1;/,
  );
  assert.match(cloudRenderer, /counters\.historyRejected = 1;/);
});

test("D10 the weather cache accounting sits on the version comparison the upload uses", () => {
  pinWithMutant(
    cloudRenderer,
    /const wantedVersion = providerBytes !== null \? providerVersion : -1;\n\s*if \(cache\.weatherProviderVersion === wantedVersion\) \{\n\s*counters\.weatherCacheHits\+\+;/,
    (s) =>
      s.replace(
        "if (cache.weatherProviderVersion === wantedVersion) {\n    counters.weatherCacheHits++;",
        "if (true) {\n    counters.weatherCacheHits++;",
      ),
    "a hit is a frame whose resident version already matched",
  );
  assert.match(cloudRenderer, /counters\.weatherUploadBytes \+= weatherBytes;/);
  assert.match(cloudRenderer, /counters\.weatherLiveBytes = weatherBytes;/);
});
