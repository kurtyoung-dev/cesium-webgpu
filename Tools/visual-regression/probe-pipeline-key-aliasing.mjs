#!/usr/bin/env node
// Probe (NEW-WEBGPU-PIPELINE-KEY-LOG-DEPTH) — runtime detector for central
// pipeline-cache key ALIASING across the LOG_DEPTH axis.
//
// THE DEFECT (historical — closed structurally 2026-08-06)
// ---------------------------------------------------------
// `WebGPURenderPipelineCache.generateCacheKey` hashed `descriptor.name`, fifteen
// optional `variant.*` fields, `ms:`, `df:`, a per-target `tg:` signature and a
// `vx:` vertex signature. It NEVER read `descriptor.vertex.module`,
// `descriptor.fragment.module`, `entryPoint`, or any define bitmask. The shader
// module cache DOES key on `(sourceId, defines)`, so flipping LOG_DEPTH built a
// genuinely different `GPUShaderModule` — which the pipeline key then discarded.
// Correctness was fully delegated to callers encoding the axis into the
// free-form `descriptor.name`.
//
// `NEW-WEBGPU-PIPELINE-KEY-DEFINE-AXIS-GENERAL` folded shader-module IDENTITY
// into the key (the trailing `sh:` segment), so the class is now structurally
// impossible rather than convention-dependent. This probe is retained as the
// RUNTIME confirmation of that on real hardware — a live cache serving real
// descriptors is a different kind of evidence than a source spec — and its
// negative control was rewritten accordingly (see below).
//
// HOW THIS PROBE WORKS
// --------------------
// TypeScript `private` is compile-time only, so both `generateCacheKey` and the
// `cache` Map survive to runtime. We wrap `getPipeline` / `getPipelineSync` and,
// for every call, recompute the key the cache itself would use and compare the
// incoming descriptor against whatever is already stored under that key. If the
// stored entry's vertex/fragment module or entry point differs from the incoming
// one, the cache is about to serve the WRONG pipeline — that is a collision, and
// it is reported with the exact key and both module labels.
//
// This is OBJECT INSPECTION, not pixel sampling, so the usual
// "never separate a pixel read from its render by a yield" rule does not apply
// here — no drawing-buffer or swap-chain texture is read.
//
// CROSS-CHECK AGAINST THE ENGINE COUNTER (`stats.wrongModuleHits`)
// ----------------------------------------------------------------
// Since Batch 795 the cache counts the same event itself:
// `WebGPURenderPipelineCache.noteWrongModuleHit` increments
// `stats.wrongModuleHits` whenever a served HIT's cached modules differ from the
// requested ones, and `getStats()` exports it. `CesiumDebug.cacheStats()`'s
// hit-rate cannot express this — it reports hits/misses/size/evicted/hitRate
// only, and ALIASING RAISES THE HIT RATE, so that metric reads a fully-aliasing
// cache as a perfectly-performing one. `wrongModuleHits` is the number that
// would have caught this defect through fifteen months of green dashboards.
//
// This probe reports BOTH its own wrapper count and the engine's delta, and
// asserts they agree in `detect` mode. They are independent implementations of
// the same predicate reading the same cache, so a DISAGREEMENT is itself a
// finding:
//   * engine > probe  — aliasing is reaching the cache through a path this
//                       probe does not wrap. The probe is under-covering.
//   * probe > engine  — the engine's own detector has been unwired or narrowed.
//                       `pipeline-key-aliasing.spec.mjs`'s WRONG-MODULE-HITS
//                       group guards that statically; this catches it live.
// In `--expect-collisions` mode they are EXPECTED to disagree — see below.
//
// NEGATIVE CONTROL (required — a clean result is meaningless without it)
// ---------------------------------------------------------------------
// `--expect-collisions` re-creates the PRE-FIX key behaviour before hashing:
//   1. it strips the log markers (`, ld=1`, `/ld=<n>`, ` [ld]`, `|ld=<n>`) from
//      `descriptor.name` — the Batch-803 mitigation; and
//   2. it replaces the vertex/fragment modules with ONE shared stand-in object,
//      which neutralises the 2026-08-06 `sh:` module-identity fold.
// Step 2 became necessary when the fold landed: stripping the name markers alone
// no longer collapses the key, because module identity separates the variants on
// its own. Without it this control would silently stop firing and the clean
// `detect` run would prove nothing — the exact failure mode the fold was built
// to end, reproduced in the instrument.
//
// The substituted module is passed ONLY to the key computation; the collision
// predicate still compares the REAL incoming descriptor against the stored
// entry, so a fired control still reports the true module labels.
//
// POLARITY NOTE — HISTORICAL. When this probe was authored (2026-07-25, worktree
// agent-a68f438fcb2e102c1) the engine was UNFIXED, so the intended order was
// "run plain `detect` first, watch it fire, then apply the fix and watch it go
// clean". The eight name markers landed on main 2026-08-01, so that baseline can
// no longer be reproduced by running `detect` — on current main `detect` is clean
// from the first run. The ONLY way to observe the firing behaviour now is
// `--expect-collisions`, which synthesises the pre-fix key inside the probe. Run
// BOTH; a lone clean `detect` proves nothing on its own.
//
// In `--expect-collisions` mode the probe's count and the engine's delta are
// EXPECTED to differ: the probe strips markers in ITS OWN key computation only,
// while the engine keeps hashing the real (marked) names and therefore correctly
// reports zero. That asymmetry is the point — it confirms the collisions the
// probe sees are synthesised by the stripping, not present in the live cache.
//
//   node Tools/visual-regression/probe-pipeline-key-aliasing.mjs
//   node Tools/visual-regression/probe-pipeline-key-aliasing.mjs --expect-collisions
//
// TRIGGERS
//   globe fleet  — `scene.context._logDepthWriteEnabled = false` / true
//   sibling fleet— `camera.switchToOrthographicFrustum()` and `scene.morphTo2D(0)`,
//                  both of which clear `frameState.useLogDepth` and drive the
//                  `_pipelineLogDepth` flip guards in the Ground / Vector3DTile /
//                  EllipsoidPrimitive renderers.
//
// Env: PROBE_BASE (default http://localhost:8134)
// Out: Tools/visual-regression/output/pipeline-key-aliasing.json

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";
const OUT_JSON = path.join(OUT_DIR, "pipeline-key-aliasing.json");
const EXPECT_COLLISIONS = process.argv.includes("--expect-collisions");

// Delete stale artifacts BEFORE the run so nothing pre-dating the build is read.
fs.mkdirSync(OUT_DIR, { recursive: true });
if (fs.existsSync(OUT_JSON)) fs.unlinkSync(OUT_JSON);

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async (stripMarkers) => {
  // Helpers are defined INSIDE page.evaluate — the function is serialized, its
  // closure is not.
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  v.clock.shouldAnimate = false;

  const frame = () =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const render = async (n) => {
    for (let i = 0; i < n; i++) {
      scene.requestRender();
      await frame(); // a real frame yield, not a busy wait
    }
  };
  const label = (m) => (m ? m.label || "(unlabelled)" : "(none)");

  const ctx = scene.context;
  const cache = ctx.webgpuPipelineCache;
  if (!cache) return { fatal: "no webgpuPipelineCache on the context" };
  if (typeof cache.generateCacheKey !== "function") {
    return { fatal: "generateCacheKey is not reachable at runtime" };
  }
  if (!(cache.cache instanceof Map)) {
    return { fatal: "cache.cache is not a Map at runtime" };
  }
  // The engine-side counter this probe cross-checks against (Batch 795). Its
  // ABSENCE is fatal, not a silently-skipped comparison: without it the
  // cross-check would pass vacuously and this probe would be the only detector.
  if (typeof cache.getStats !== "function") {
    return { fatal: "cache.getStats() is not reachable at runtime" };
  }
  const statsProbe = cache.getStats();
  if (typeof statsProbe.wrongModuleHits !== "number") {
    return {
      fatal:
        "getStats().wrongModuleHits is missing — the engine-side aliasing counter " +
        "(Batch 795) is gone or unwired, so the cross-check cannot run",
    };
  }

  const collisions = [];
  const seenNames = new Set();
  let observedCalls = 0;
  let cacheHits = 0;
  let wrongModuleHits = 0;

  // NEGATIVE CONTROL — reproduce the pre-fix key by stripping the log markers
  // from the name before hashing.
  const realKey = cache.generateCacheKey.bind(cache);
  // One shared stand-in for EVERY module, so the `sh:` fold degenerates to a
  // constant and the key reverts to its pre-2026-08-06 discriminating power.
  const foldNeutralizer = { __preFixModuleStandIn: true };
  const keyOf = stripMarkers
    ? (desc, variant) => {
        const stripped = {
          ...desc,
          name: String(desc.name)
            .replace(/, ld=1/g, "")
            .replace(/\/ld=\d+/g, "")
            .replace(/ \[ld\]/g, "")
            .replace(/\|ld=\d+/g, ""),
          vertex: desc.vertex
            ? { ...desc.vertex, module: foldNeutralizer }
            : desc.vertex,
          fragment: desc.fragment
            ? { ...desc.fragment, module: foldNeutralizer }
            : desc.fragment,
        };
        // `defines`, when a producer declares it, is the other post-fix
        // discriminator on this axis — drop it too so the control reproduces
        // the pre-fix key rather than a half-folded hybrid.
        delete stripped.defines;
        delete stripped.definesHi;
        return realKey(stripped, variant);
      }
    : realKey;

  // In `--expect-collisions` mode the synthesised keys no longer exist in the
  // ENGINE's map (the engine stores real, module-folded keys), so the control
  // keeps its own shadow index of pre-fix key -> first descriptor seen under it.
  // Before the fold the stripped ON-state name collapsed onto the OFF-state's
  // REAL key and the engine map alone sufficed; that shortcut died with the
  // fold. In `detect` mode nothing changes — the engine's own map is read.
  const shadow = stripMarkers ? new Map() : null;

  const wrap = (methodName) => {
    const orig = cache[methodName];
    if (typeof orig !== "function") return;
    cache[methodName] = function (desc, variant) {
      try {
        observedCalls++;
        if (desc && desc.name) seenNames.add(String(desc.name));
        const k = keyOf(desc, variant);
        const prior = shadow ? shadow.get(k) : this.cache.get(k);
        if (prior) cacheHits++;
        else if (shadow && desc) shadow.set(k, { descriptor: desc });
        if (
          prior &&
          desc &&
          (prior.descriptor.vertex?.module !== desc.vertex?.module ||
            prior.descriptor.fragment?.module !== desc.fragment?.module ||
            prior.descriptor.vertex?.entryPoint !== desc.vertex?.entryPoint)
        ) {
          wrongModuleHits++;
          collisions.push({
            key: k,
            method: methodName,
            cachedName: prior.descriptor.name,
            incomingName: desc.name,
            cachedVertexModule: label(prior.descriptor.vertex?.module),
            incomingVertexModule: label(desc.vertex?.module),
            cachedFragmentModule: label(prior.descriptor.fragment?.module),
            incomingFragmentModule: label(desc.fragment?.module),
            cachedEntryPoint: prior.descriptor.vertex?.entryPoint,
            incomingEntryPoint: desc.vertex?.entryPoint,
          });
        }
      } catch (e) {
        collisions.push({ key: "(detector-error)", error: String(e) });
      }
      return orig.apply(this, arguments);
    };
  };
  wrap("getPipeline");
  wrap("getPipelineSync");

  // Add a GroundPrimitive so the terrain-classification lane is genuinely live
  // rather than silently unexercised.
  scene.primitives.add(
    new C.GroundPrimitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.RectangleGeometry({
          rectangle: C.Rectangle.fromDegrees(-100, 30, -90, 40),
        }),
        attributes: {
          color: C.ColorGeometryInstanceAttribute.fromColor(
            C.Color.RED.withAlpha(0.5),
          ),
        },
      }),
    }),
  );

  // Add a glTF Model so the `WebGPUModelPipelineCache` lane is live. Its COLOR
  // pipeline is the ONE model descriptor that routes through the central cache,
  // and `maybeUpdateForLogDepth` wipes `_pipelines` on the same
  // `isWebGPULogDepthActive` flip the orthographic / morph triggers drive — so
  // without a model on screen that lane would be silently unexercised.
  try {
    const model = await C.Model.fromGltfAsync({
      url: "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
      modelMatrix: C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(-95, 35, 0),
      ),
      scale: 5000,
    });
    scene.primitives.add(model);
  } catch (e) {
    // Recorded, not thrown — the coverage map below reports a zero model count
    // so a missing asset shows up as an unexercised lane rather than a silent pass.
    seenNames.add(`(model load failed: ${e})`);
  }

  scene.camera.setView({
    destination: C.Cartesian3.fromDegrees(-95, 35, 900000),
  });

  // READINESS IS A GATE, not a recorded field: do not proceed until the globe
  // has actually materialized pipelines.
  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) {
    await render(1);
    ready = cache.cache.size > 0 && scene.globe.tilesLoaded;
  }
  if (!ready) return { fatal: "readiness gate never satisfied" };
  await render(20);

  // Engine counter baseline is taken AFTER warm-up so the delta covers exactly
  // the trigger phases, matching what the probe's own wrapper counts there.
  const engineWrongBefore = cache.getStats().wrongModuleHits;
  const probeWrongBefore = wrongModuleHits;

  const callsAfterWarmup = observedCalls;
  const phases = [];
  const runPhase = async (name, fn, frames) => {
    const before = observedCalls;
    await fn();
    await render(frames);
    phases.push({ name, pipelineCalls: observedCalls - before });
  };

  // ── globe fleet: the master switch ──
  await runPhase(
    "globe: _logDepthWriteEnabled = false",
    () => {
      ctx._logDepthWriteEnabled = false;
    },
    25,
  );
  await runPhase(
    "globe: _logDepthWriteEnabled = true",
    () => {
      ctx._logDepthWriteEnabled = true;
    },
    25,
  );

  // ── sibling fleet: orthographic clears frameState.useLogDepth ──
  await runPhase(
    "camera.switchToOrthographicFrustum()",
    () => scene.camera.switchToOrthographicFrustum(),
    25,
  );
  await runPhase(
    "camera.switchToPerspectiveFrustum()",
    () => scene.camera.switchToPerspectiveFrustum(),
    25,
  );
  await runPhase("scene.morphTo2D(0)", () => scene.morphTo2D(0), 30);
  await runPhase("scene.morphTo3D(0)", () => scene.morphTo3D(0), 30);

  const engineStats = cache.getStats();

  return {
    collisions,
    observedCalls,
    callsAfterWarmup,
    triggerCalls: observedCalls - callsAfterWarmup,
    cacheSize: cache.cache.size,
    cacheHits,
    wrongModuleHits,
    // Cross-check inputs: both counts scoped to the trigger phases only.
    probeWrongDelta: wrongModuleHits - probeWrongBefore,
    engineWrongDelta: engineStats.wrongModuleHits - engineWrongBefore,
    engineWrongTotal: engineStats.wrongModuleHits,
    engineStats,
    phases,
    // Coverage: which renderers were actually exercised. Reported, not asserted,
    // so a lane that never ran is visible instead of silently "passing".
    coverage: {
      globe: [...seenNames].filter((n) => n.startsWith("Globe terrain")).length,
      groundPrimitive: [...seenNames].filter((n) =>
        n.startsWith("GroundPrimitive"),
      ).length,
      vector3DTile: [...seenNames].filter((n) => n.startsWith("Vector3DTile"))
        .length,
      ellipsoidPrimitive: [...seenNames].filter((n) =>
        n.startsWith("EllipsoidPrimitive"),
      ).length,
      // `Model PBR [...]|<key>|ld=<n>` — the one model descriptor on the
      // central cache.
      modelPBR: [...seenNames].filter((n) => n.startsWith("Model PBR")).length,
      gaussianSplat: [...seenNames].filter((n) => n.startsWith("GaussianSplat"))
        .length,
      total: seenNames.size,
    },
    sampleNames: [...seenNames].slice(0, 40),
  };
}, EXPECT_COLLISIONS);

await browser.close();

const report = {
  mode: EXPECT_COLLISIONS ? "negative-control" : "detect",
  base: BASE,
  when: new Date().toISOString(),
  consoleErrors: errors,
  ...out,
};
fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));

// ─── verdict ─────────────────────────────────────────────────────────────────
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  console.error(`  report: ${OUT_JSON}`);
  process.exit(1);
};

if (out.fatal) fail(out.fatal);

console.log(`mode              : ${report.mode}`);
console.log(
  `pipeline calls    : ${out.observedCalls} (during triggers: ${out.triggerCalls})`,
);
console.log(`cache size        : ${out.cacheSize}`);
console.log(`coverage          : ${JSON.stringify(out.coverage)}`);
console.log(`cache hits        : ${out.cacheHits}`);
console.log(
  `probe wrongModule : ${out.wrongModuleHits}   (delta over triggers: ${out.probeWrongDelta})`,
);
console.log(
  `engine wrongModule: ${out.engineWrongTotal}   (delta over triggers: ${out.engineWrongDelta})   <- getStats(), Batch 795`,
);
if (out.engineStats) {
  console.log(
    `engine hitRate    : ${out.engineStats.hitRate}   (misleading here — aliasing RAISES it)`,
  );
}
console.log(`collisions        : ${out.collisions.length}`);
for (const c of out.collisions.slice(0, 20)) {
  console.log(
    `  [${c.key}]\n    cached  : ${c.cachedName} vs=${c.cachedVertexModule} fs=${c.cachedFragmentModule} ep=${c.cachedEntryPoint}` +
      `\n    incoming: ${c.incomingName} vs=${c.incomingVertexModule} fs=${c.incomingFragmentModule} ep=${c.incomingEntryPoint}`,
  );
}

// Non-vacuity: the triggers must have driven real pipeline lookups, otherwise a
// zero-collision result says nothing.
if (out.triggerCalls <= 0) {
  fail(
    "VACUOUS: the trigger phases produced zero getPipeline/getPipelineSync calls",
  );
}
if (out.coverage.globe === 0) {
  fail("VACUOUS: no globe pipelines were observed");
}

if (EXPECT_COLLISIONS) {
  if (out.collisions.length === 0) {
    fail(
      "negative control did NOT fire — with the log markers stripped from the key the\n" +
        "  detector must observe aliasing. The detector is broken, so a clean run in\n" +
        "  normal mode proves nothing.",
    );
  }
  // The engine keeps hashing the REAL (marked) names, so it must NOT see these
  // synthesised collisions. If it does, the markers are not actually reaching
  // the live descriptors and `detect` mode is lying.
  if (out.engineWrongDelta !== 0) {
    fail(
      `negative control: engine wrongModuleHits moved by ${out.engineWrongDelta}, expected 0.\n` +
        "  The stripping happens only inside this probe's key computation, so the engine\n" +
        "  should see none of it. A nonzero delta means real aliasing is present on main.",
    );
  }
  console.log(
    "\nPASS: negative control fired (probe detector works) and the engine counter\n" +
      "      correctly stayed at 0 — the collisions are synthesised, not live.",
  );
} else {
  if (out.collisions.length > 0) {
    fail(`${out.collisions.length} pipeline-key collision(s) — see above`);
  }
  // CROSS-CHECK — two independent detectors over the same cache must agree.
  if (out.engineWrongDelta !== out.probeWrongDelta) {
    fail(
      `cross-check DISAGREEMENT: probe counted ${out.probeWrongDelta} wrong-module hit(s) over\n` +
        `  the trigger phases, engine getStats() counted ${out.engineWrongDelta}.\n` +
        "  engine > probe: aliasing is reaching the cache through a path this probe does not\n" +
        "                  wrap — the probe is under-covering.\n" +
        "  probe > engine: the engine's noteWrongModuleHit has been unwired or narrowed.",
    );
  }
  if (out.engineWrongTotal > 0) {
    fail(
      `engine getStats().wrongModuleHits = ${out.engineWrongTotal} over the whole session ` +
        "(including warm-up) — the central cache served at least one pipeline built from a " +
        "different shader module than the caller asked for.",
    );
  }
  if (errors.length > 0) {
    fail(
      `${errors.length} console error(s): ${errors.slice(0, 5).join(" | ")}`,
    );
  }
  console.log(
    "\nPASS: no pipeline-key aliasing observed across the LOG_DEPTH axis " +
      "(probe detector and engine counter agree at 0).",
  );
}
