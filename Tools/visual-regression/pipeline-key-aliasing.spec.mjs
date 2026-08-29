// pipeline-key-aliasing.spec.mjs — browser-free durable guard for the central
// pipeline cache key's shader-identity fold, plus the per-axis name markers it
// superseded.
// @purpose Guard for the pipeline-cache shader-identity fold: executes real caches over every ShaderDefine bit; mutation group re-inflicts the aliasing.
// @status ACTIVE
//
// ★ STATUS 2026-08-06 — THE CLASS IS NOW STRUCTURALLY CLOSED
// -----------------------------------------------------------
// `NEW-WEBGPU-PIPELINE-KEY-DEFINE-AXIS-GENERAL` folded shader-MODULE IDENTITY
// into `generateCacheKey` (the trailing `sh:<vsId>.<vsEntry>/<fsId>.<fsEntry>`
// segment, plus `pl:` layout identity, `pr:` primitive state, `dz:`
// depth/stencil state and `mx:` multisample extras — every descriptor-side
// field `buildPipelineDescriptor` reads). `WebGPUShaderModuleCache` returns a
// DISTINCT `GPUShaderModule` per `(sourceId, defines, definesHi, keySalt)`, so
// folding module identity is strictly STRONGER than folding a define mask: a
// brand-new define bit, added by an author who never heard of a name marker,
// cannot alias. The STRUCTURAL group below proves that by execution, over every
// bit in the real `ShaderDefine` registry, and the MUTATION-FOLD group removes
// the fold and requires detection.
//
// Everything after the structural group is DEFENSE IN DEPTH: the Batch-803 name
// markers still exist and are still checked, because a bare `sh:41.…` tells a
// reader that two rows are separate but not WHICH variant each row is. They are
// no longer what stands between a define flip and a collision. Do not delete a
// marker; do not treat adding one as mandatory.
//
// WHY THIS EXISTS (the pre-fix world, retained because every recording below
// was made in it)
// ---------------
// `WebGPURenderPipelineCache.generateCacheKey` hashed exactly: `descriptor.name`,
// fifteen optional `variant.*` fields, `ms:<multisample.count>`,
// `df:<depthStencil.format>`, a per-target `tg:` signature and a `vx:` vertex
// buffer signature. It NEVER read `descriptor.vertex.module`,
// `descriptor.fragment.module`, `entryPoint`, or any shader-define bitmask —
// and NO in-tree caller passes a `variant`, so `descriptor.primitive` and most
// of `descriptor.depthStencil` were unhashed too.
//
// `WebGPUShaderModuleCache` keys correctly on `(sourceId, defines)`, so flipping
// LOG_DEPTH genuinely produced a DIFFERENT `GPUShaderModule` — which was then
// discarded by a pipeline key that could not see it. Correctness was therefore
// fully delegated to callers encoding every shader-affecting axis into the
// free-form `descriptor.name`. `DEFERRED_WORK.md` stated the convention:
// "distinct pipeline structure MUST produce a distinct name".
//
// This was filed once before —
// `migration_doc/audits/2026-06-11_ULTRA_REVIEW_findings.json:2630-2636` —
// marked confirmed-real, then downgraded to LOW because no collision had been
// demonstrated and defines were held to be covered "by convention". That
// reasoning was sound for the globe (whose `_logDepthWriteEnabled` master switch
// is never written outside a Spec) and FALSE for the sibling renderers, which
// gate on `isWebGPULogDepthActive = master && frameState.useLogDepth`.
// `Scene.js` clears `frameState.useLogDepth` on ANY orthographic transition, and
// those renderers carry `_pipelineLogDepth` flip guards that REBUILD the
// descriptor on that flip — the exact precondition for aliasing. Reachable from
// documented public API (`scene.morphTo2D()`,
// `camera.switchToOrthographicFrustum()`, `scene.logarithmicDepthBuffer`).
//
// Note that `CesiumDebug.cacheStats()`'s hit-rate cannot catch this class:
// aliasing IMPROVES the reported hit rate. The one counter that CAN is
// `stats.wrongModuleHits` (Batch 795) — see the WRONG-MODULE-HITS group below,
// which guards that instrument against silently disappearing.
//
// "SAFE" HAS FIVE DISTINCT MECHANISMS — ASK WHICH ONE APPLIES
// -----------------------------------------------------------
// When classifying a NEW renderer, the question is not "does it have a marker?"
// but "which of these makes it safe?". Four of the five are not a name marker:
//
//   1. A log marker in the descriptor name — `ld=` / `[ld]` / `, ld=1`.
//      (AT_RISK below.)
//   2. The WHOLE define bitmask stamped into the name —
//      `defines=0x${defines.toString(16)}`. Strictly stronger than (1): it
//      covers every define, not just LOG_DEPTH. (DEFINES_STAMP below.)
//   3. The `vx:` vertex-buffer signature already distinguishes the variants, so
//      `generateCacheKey` separates them without help from the name. This is why
//      the globe's `GEODETIC_NORMAL` needs no marker — it adds a
//      `shaderLocation: 2` attribute, so the vertex signature differs.
//   4. The module never varies on the axis at all — e.g.
//      `WebGPUGlobeSurfaceWireframe.ts` never ORs LOG_DEPTH into its defines, so
//      there is only ever one module. (EXEMPT below.)
//   5. The file never touches the central cache — it calls
//      `device.createRenderPipeline` directly and holds the pipeline locally, so
//      `generateCacheKey` is never consulted and name aliasing is structurally
//      impossible. (NO_CENTRAL_CACHE below.) Mechanism 5 was anticipated by
//      neither the original brief nor the 2026-06-11 audit, which is exactly why
//      it is asserted here rather than left as a comment.
//
// HISTORICAL — PRE-FIX PROBE RESULTS ARE INVALID (TWO POPULATIONS)
// ----------------------------------------------------------------
// The markers this spec guards landed on main 2026-08-01. Everything below
// describes recordings made BEFORE that date; it is retained because those
// recordings are still on disk and still cited. Do not conflate the two
// populations; a reader chasing one must not search the other's set.
//
// (A) MASTER-SWITCH probes. Five probes flip `context._logDepthWriteEnabled`
//     mid-session with a globe on screen: probe-logdepth-zfight,
//     probe-buffer-logdepth-zfight, probe-collections-far-camera,
//     probe-ellipsoidprim-logdepth, probe-splat-sort. Pre-fix the globe silently
//     kept its startup pipeline through BOTH legs, so their gate-OFF legs never
//     exercised the globe's off state. Each carries a RECORDING VALIDITY note in
//     its header. (probe-logdepth-globe flips at page load, before any pipeline
//     exists — unaffected.)
//
// (B) MORPH / ORTHOGRAPHIC probes — a LARGER surface, recorded as a CLASS.
//     The sibling trigger is NOT the master switch: it is
//     `frameState.useLogDepth`, which `Scene.js` clears on ANY morph or
//     orthographic transition.
//
//     RULE: any probe that performs a morph or orthographic transition while a
//     glTF model, ground primitive, or Vector3DTile classifier is on screen was,
//     before this fix, morphing into a state where those subsystems kept
//     executing the log-depth module — so its pre-fix results across that
//     transition are suspect.
//
//     SECOND POPULATION on the SAME trigger: the globe did not participate in
//     this transition at all until 2026-08-02, because it resolved the master
//     switch alone (`NEW-WEBGPU-GLOBE-USE-LOG-DEPTH`). So across a (B)
//     transition recorded before that date the globe kept writing LOG depth
//     while the siblings correctly dropped to hyperbolic — the depth attachment
//     carried BOTH encodings. Any (B) probe whose verdict depends on globe depth
//     (classification coverage, depth-plane occlusion, pickPosition over
//     terrain, enhanced-ocean depth test) is suspect on that count as well, and
//     for a different reason than the aliasing above.
//
//     27 probes use switchToOrthographicFrustum / morphTo2D / morphToColumbusView.
//     Highest-confidence candidates — UNVERIFIED, each requiring a per-file
//     content check before any claim is made about it, NOT a findings list:
//     probe-model-scene-modes, probe-model-project2d, probe-model-scene2d-idl,
//     probe-model-scene2d-stage-guard, probe-model-capture-camera-parity,
//     probe-classifier-2d-renderpass, probe-classifier-scenemode,
//     probe-vector3dtile-vctr. The rule plus a content check adjudicates any
//     specific probe's history; the 27 files were deliberately NOT stamped with
//     notes that could not be stood behind per file.
//
// WHAT THIS SPEC GUARDS
// ---------------------
// Mostly a SOURCE-TEXT spec, so it needs no GPU and runs in CI. The STRUCTURAL
// and MUTATION-FOLD groups additionally EXECUTE the real engine modules through
// `engine-ts-resolver` against stub devices. Groups:
//
//   0. STRUCTURAL — the real guarantee, proved by execution rather than by
//      enumerating markers. Every bit in the real `ShaderDefine` registry is
//      flipped through the real `WebGPUShaderModuleCache` into descriptors whose
//      names are IDENTICAL and carry no marker of any kind; the real
//      `generateCacheKey` must separate them. Also pins hit-rate preservation
//      (identical inputs ⇒ identical key) and the compute cache's `m:` fold.
//   0b. MUTATION-FOLD — the fold is programmatically removed from a copy of the
//      engine source, the copy is imported, and group 0 is re-run against it; it
//      MUST alias. Without this, group 0's clean result is unfalsifiable.
//   1. ENUMERATION-LEDGER — every file under `Renderer/WebGPU/` that compiles a
//      LOG_DEPTH-gated shader module is classified into exactly one bucket.
//      DEFENSE IN DEPTH since the fold landed: an unclassified new file is a
//      documentation gap, not a correctness hole.
//   1b. NO-CENTRAL-CACHE — the files classified "safe because they never touch
//      the central cache" are re-checked to still be true. "My analyser could
//      not reach it" is not evidence of safety; "it provably never calls the
//      cache" is, and that is what this asserts.
//   1c. MODEL-CENTRAL — `WebGPUModelPipelineCache` routes exactly ONE
//      DESCRIPTOR through the central cache (via two lookup paths, sync + async);
//      assert it still carries its `ld=` marker, and that a second descriptor has
//      not appeared behind the hand proof.
//   2. TAINT — the log-gated-module tracker actually finds a log-gated module in
//      each at-risk file, and finds at least one descriptor that uses it. Guards
//      the analysis itself against silently matching nothing.
//   3. DISTINCTNESS — for each at-risk file, every pipeline descriptor that
//      REFERENCES a log-gated module is rendered twice (log OFF vs log ON) with
//      all non-log placeholders held constant; the two names must DIFFER.
//      Descriptors that do not reference a log-gated module (compute dispatch,
//      OIT composite, …) are correctly ignored.
//   4. MUTATION — the marker is programmatically stripped from each at-risk
//      file's source and group 3 is re-run; it MUST fail. Without this the clean
//      result in group 3 would be unfalsifiable.
//   5. WRONG-MODULE-HITS — the RUNTIME companion instrument
//      (`stats.wrongModuleHits`, Batch 795) is still declared, still incremented
//      on a module mismatch, and still exported through `getStats()`. This spec
//      proves the names are distinct in SOURCE; `wrongModuleHits` is what proves
//      it at RUNTIME, and `probe-pipeline-key-aliasing.mjs` cross-checks its own
//      detector against it. If the counter is deleted or unwired, that
//      cross-check silently becomes vacuous — so it is asserted here.
//   6. GLOBE-USELOGDEPTH-REACH — the globe now flips on the SAME trigger the
//      class-(B) surface below is defined by. Until 2026-08-02 the globe
//      resolved `context._logDepthWriteEnabled` ALONE, so a morph or
//      orthographic transition moved every SIBLING onto its other module while
//      the globe stayed put: the transition reached the class but not the globe.
//      That was a second, separate defect (`NEW-WEBGPU-GLOBE-USE-LOG-DEPTH`),
//      and fixing it is what makes the globe's `, ld=1` marker load-bearing on
//      the (B) trigger rather than only on the rarely-written master switch.
//      Pinned here because the (B) rule below is stated in terms of
//      `frameState.useLogDepth`; if the globe stopped reading it, this file's
//      own description of the surface would be wrong. The full contract for
//      that fix lives in `globe-use-log-depth.spec.mjs`.

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBGPU_DIR = resolve(
  HERE,
  "../../packages/engine/Source/Renderer/WebGPU",
);

enableEngineTsResolution();

const RENDER_CACHE_FILE = join(WEBGPU_DIR, "WebGPURenderPipelineCache.ts");
const COMPUTE_CACHE_FILE = join(WEBGPU_DIR, "WebGPUComputePipelineCache.ts");

const { WebGPURenderPipelineCache, webgpuObjectIdentity } = await import(
  pathToFileURL(RENDER_CACHE_FILE).href
);
const { WebGPUComputePipelineCache } = await import(
  pathToFileURL(COMPUTE_CACHE_FILE).href
);
const { WebGPUShaderModuleCache } = await import(
  pathToFileURL(join(WEBGPU_DIR, "WebGPUShaderModuleCache.ts")).href
);
const { ShaderDefine, ShaderSourceId } = await import(
  pathToFileURL(join(WEBGPU_DIR, "WebGPUShaderDefines.ts")).href
);

/**
 * Files that build render pipelines whose SHADER MODULE varies with the
 * LOG_DEPTH define. Every descriptor in these that uses such a module must
 * encode the axis in its name.
 */
const AT_RISK = [
  // Fixed by this change.
  "WebGPUGlobeSurfacePipelines.ts",
  "WebGPUEllipsoidPrimitiveRenderer.ts",
  "WebGPUGroundPrimitiveRenderer.js",
  "WebGPUVector3DTilePrimitiveRenderer.js",
  "WebGPUVector3DTilePolylinesRenderer.js",
  "WebGPUVector3DTileClampedPolylinesRenderer.js",
  // Already followed the convention; listed so a regression in them is caught.
  "WebGPUOceanRenderer.ts",
  "WebGPUCloudRenderer.ts",
  "WebGPUFlowFieldRenderer.ts",
  "WebGPUComputeInstanceRenderer.ts",
  "WebGPUGaussianSplatRenderer.ts",
  // Gates LOG_DEPTH on the PICK fleet only; its pick names carry `[ld]`.
  "WebGPUVoxelRenderer.ts",
];

/**
 * Files that encode the axis by stamping the WHOLE define bitmask into the
 * pipeline name (`defines=0x${defines.toString(16)}`). That is strictly stronger
 * than an `ld=` marker — it covers every define, not just LOG_DEPTH — so they
 * get a presence assertion rather than the per-name distinctness analysis.
 */
const DEFINES_STAMP = [
  "WebGPUBillboardRenderer.js",
  "WebGPULabelRenderer.js",
  "WebGPUPointPrimitiveRenderer.js",
  "WebGPUPolylineRenderer.js",
];

/**
 * Files that gate a shader module on LOG_DEPTH but NEVER route a descriptor
 * through the central pipeline cache: they call `device.createRenderPipeline`
 * directly and hold the resulting pipeline locally. `generateCacheKey` is never
 * consulted for them, so name-based aliasing is structurally impossible — a
 * different safety mechanism from a name marker, but a complete one.
 *
 * Their `_logDepthEnabled` flip guards exist to rebuild their OWN locally-held
 * pipeline objects, which is correct and sufficient.
 *
 * MANUAL PROOF (traced by hand 2026-07-25, re-verified against main 2026-08-01):
 * each file has zero references to `webgpuPipelineCache` / `_centralPipelineCache`
 * / `getPipeline*`, and creates its pipelines at `device.createRenderPipeline`.
 * The NO-CENTRAL-CACHE test below re-asserts that on every run, so this
 * classification cannot silently rot if one of them is later migrated onto the
 * central cache.
 */
const NO_CENTRAL_CACHE = [
  "WebGPUBufferPointRenderer.ts",
  "WebGPUBufferPolygonRenderer.ts",
  "WebGPUBufferPolylineRenderer.ts",
  "WebGPUPrimitiveCommands.ts",
  // UP144-SNAP-WEBGPU-EDGES (C11-212 edge tier) — the edge emitter began
  // gating a module on LOG_DEPTH when it grew `fragmentSnapMain`. Traced by
  // hand 2026-08-02: zero central-cache references; the base/single-target
  // pipelines and the new `ensureEdgeEmitterSnapPipeline` all call
  // `device.createRenderPipeline` and hold the result on `EdgeEmitterCache`.
  // The snap descriptor's name still carries BOTH axes (`[sf=…]` + `[ld]`) so
  // a future migration onto the central cache inherits a correct name.
  "WebGPUEdgeVisibilityEmitter.ts",
];

/**
 * `WebGPUModelPipelineCache.ts` — routes exactly ONE DESCRIPTOR through the
 * central cache (the glTF COLOR pipeline) and needed a real fix.
 *
 * MANUAL PROOF (traced by hand 2026-07-25, re-verified against main 2026-08-01):
 * the name was `${raw.label}|${key}`. `raw.label` (built in
 * `buildColorPipelineDescriptor`) encodes only
 * (alphaMode, doubleSided, forceDepthWrite); `key` (`computeKey` /
 * `buildModelTopologyVariantKey` / `_metadataVariantKey`) encodes only
 * (alphaMode, doubleSided, materialDefines, topology, optional `:m34`, and —
 * for a primitive carrying a generated metadata or customShader chunk — that
 * chunk's class hashes, folded by `buildModelMetadataVariantKey`).
 * NEITHER carries LOG_DEPTH, because that bit is folded into the MODULE through
 * `effectiveDefines` from `this._logDepthEnabled` — which is not part of
 * `materialDefines`. `maybeUpdateForLogDepth` wipes `_pipelines` on a flip,
 * forcing a rebuild and a central re-lookup under the unchanged name: the
 * complete aliasing precondition. Fixed by appending `|ld=<0|1>`. Every other
 * model pipeline (pick / depth-write / velocity / classification / silhouette /
 * metadata-pick) uses the direct `createRenderPipeline` hatch and is unaffected.
 *
 * NOTE (adapted from the 2026-07-25 original): that version asserted exactly ONE
 * `central.getPipeline*` CALL. On current main there are TWO — `getPipelineSync`
 * followed by the async `getPipeline` — but both consume the SAME `centralDesc`
 * object. The invariant that actually matters is one DESCRIPTOR, not one call,
 * so the assertion below counts descriptors and requires every central call to
 * pass `centralDesc`.
 */
const MODEL_CENTRAL = "WebGPUModelPipelineCache.ts";

/**
 * The runtime companion instrument. `pipeline-key-aliasing` is a source-text
 * spec; `wrongModuleHits` is what detects the same defect on a live device, and
 * `probe-pipeline-key-aliasing.mjs` cross-checks its own wrapper against it.
 */
const PIPELINE_CACHE = "WebGPURenderPipelineCache.ts";

/**
 * Files that mention `ShaderDefine.LOG_DEPTH` but emit no render-pipeline
 * descriptor name that varies on it. Each entry carries the reason it is safe;
 * an unexplained new file forces a decision rather than silently passing.
 *
 * NOTE: on current main NONE of these actually reference `ShaderDefine.LOG_DEPTH`
 * any more, so the map is currently inert — it is retained as the classification
 * decision table for the day one of them starts to. The ENUMERATION test does not
 * require EXEMPT entries to be candidates (unlike the four positive lists), so an
 * inert entry cannot fail the suite.
 */
const EXEMPT = new Map([
  ["WebGPULogDepth.ts", "the gate + UB packer itself; builds no pipelines"],
  ["WebGPUShaderDefines.ts", "the bit registry; builds no pipelines"],
  [
    "WebGPUGlobeSurfaceRenderer.ts",
    "resolves the gate and mirrors it onto the PipelineHost; names are built in WebGPUGlobeSurfacePipelines.ts",
  ],
  [
    "WebGPUGlobeSurfaceWireframe.ts",
    "debug overlay: never ORs LOG_DEPTH into its defines, so its module never varies on the axis",
  ],
  [
    "WebGPUGlobeSurfaceShaders.ts",
    "the shader-module factory: compiles modules and names none of the pipelines that consume them; its LOG_DEPTH mention is the init-time module prewarm list, whose masks must match what WebGPUGlobeSurfacePipelines.ts later requests",
  ],
  ["cesium-js-types.d.ts", "ambient type declarations only"],
]);

// ─── lexical helpers ─────────────────────────────────────────────────────────

const LOG_FLAG = /logDepth|pickLog|_logDepthEnabled|logDepthOn|logDepthActive/;

/** True if an expression mentions LOG_DEPTH directly. */
function mentionsLogDefine(expr) {
  return /ShaderDefine\.LOG_DEPTH/.test(expr);
}

/**
 * Identifiers whose value depends on the LOG_DEPTH axis — either because their
 * initializer names `ShaderDefine.LOG_DEPTH`, or because it references another
 * such identifier. Iterated to a fixpoint so `defines -> productionModule ->
 * vertexModule` chains are captured (the globe's shape).
 */
function collectTaintedIdents(src) {
  // `const|let x [: T] = <init up to end of statement>`
  const declRe =
    /\b(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*([\s\S]*?);\s*$/gm;
  const decls = [];
  let m;
  while ((m = declRe.exec(src)) !== null) {
    decls.push({ id: m[1], init: m[2] });
  }
  // Property assignments — `cache.shaderModule = moduleCache.getOrCreate(...)`.
  // Several renderers stash the module on a cache object rather than a local, and
  // their descriptors then read `module: cache.shaderModule`. Taint the PROPERTY
  // name; module references are matched on their trailing segment below. This
  // over-taints in principle (any same-named property anywhere in the file), which
  // is the safe direction — it can only widen what DISTINCTNESS checks.
  const propRe = /\b\w+\.(\w+)\s*=\s*([\s\S]*?);\s*$/gm;
  while ((m = propRe.exec(src)) !== null) {
    decls.push({ id: m[1], init: m[2] });
  }

  const tainted = new Set();
  for (let pass = 0; pass < 6; pass++) {
    let grew = false;
    for (const { id, init } of decls) {
      if (tainted.has(id)) continue;
      const byDefine = mentionsLogDefine(init);
      const byRef = [...tainted].some((t) =>
        new RegExp(`\\b${t}\\b`).test(init),
      );
      if (byDefine || byRef) {
        tainted.add(id);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return tainted;
}

/**
 * Given an index inside an object literal, return the source of the smallest
 * enclosing `{ ... }` block.
 */
function enclosingObject(src, idx) {
  let depth = 0;
  let start = -1;
  for (let i = idx; i >= 0; i--) {
    const ch = src[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function unquote(s) {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith("`") && s.endsWith("`"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Bindings of the form `const ldFlag = logDepthActive ? 1 : 0;` /
 * `const ldLabel = logDepthOn ? ", ld=1" : "";` — the values a name template
 * interpolates to encode the axis.
 */
function collectLogBindings(src) {
  const bindings = new Map();
  const re =
    /const\s+(\w+)\s*=\s*([^;?]*(?:logDepth|pickLog|ld)\w*[^;?]*)\?\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|[\w.]+)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|[\w.]+)\s*;/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const [, id, cond, onRaw, offRaw] = m;
    if (!LOG_FLAG.test(cond)) continue;
    bindings.set(id, { on: unquote(onRaw), off: unquote(offRaw) });
  }
  return bindings;
}

/**
 * Substitute `${...}` in a template. A placeholder that is itself a log ternary
 * (`logDepthActive ? 1 : 0`) or that references a log binding resolves to the
 * off/on value; every other placeholder resolves to a fixed sentinel, holding
 * all non-log axes constant.
 */
function renderTemplate(tpl, bindings, logOn) {
  let out = "";
  let i = 0;
  while (i < tpl.length) {
    const open = tpl.indexOf("${", i);
    if (open < 0) {
      out += tpl.slice(i);
      break;
    }
    out += tpl.slice(i, open);
    // Balanced scan to the matching `}` — placeholders can contain TS type
    // literals (`{ _logDepthEnabled?: boolean }`), so a `[^{}]*` match is wrong.
    let depth = 1;
    let j = open + 2;
    for (; j < tpl.length && depth > 0; j++) {
      if (tpl[j] === "{") depth++;
      else if (tpl[j] === "}") depth--;
    }
    out += resolvePlaceholder(tpl.slice(open + 2, j - 1), bindings, logOn);
    i = j;
  }
  return out;
}

/** Resolve one `${...}` expression to its log-OFF / log-ON value, or a sentinel. */
function resolvePlaceholder(expr, bindings, logOn) {
  const trimmed = expr.trim();
  const t = splitLogTernary(trimmed);
  if (t) return unquote((logOn ? t.on : t.off).trim());
  for (const [id, vals] of bindings) {
    if (new RegExp(`\\b${id}\\b`).test(trimmed)) {
      return String(logOn ? vals.on : vals.off);
    }
  }
  return "X";
}

/**
 * Split `<cond> ? <a> : <b>` when the condition mentions a log flag. Brace
 * groups are collapsed first so an optional-property `?` inside a TS type
 * literal is not mistaken for the ternary operator; the `?` and `:` must sit at
 * paren/bracket depth 0.
 */
function splitLogTernary(expr) {
  const masked = expr.replace(/\{[^{}]*\}/g, (m) => " ".repeat(m.length));
  let depth = 0;
  let q = -1;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "?" && depth === 0) {
      q = i;
      break;
    }
  }
  if (q < 0) return null;
  depth = 0;
  let colon = -1;
  for (let i = q + 1; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === ":" && depth === 0) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const cond = expr.slice(0, q);
  if (!LOG_FLAG.test(cond)) return null;
  return { on: expr.slice(q + 1, colon), off: expr.slice(colon + 1) };
}

/**
 * Every pipeline descriptor `name:` site whose enclosing object literal
 * references a log-gated module, rendered under log OFF and log ON.
 */
function extractTaintedNameVariants(src) {
  const bindings = collectLogBindings(src);
  const tainted = collectTaintedIdents(src);
  const out = [];

  const nameRe =
    /name:\s*(`[^`]*`|"(?:[^"\\]|\\.)*"|(?:host\.)?(?:_)?\w*(?:logDepth|pickLog)\w*\s*\?\s*"(?:[^"\\]|\\.)*"\s*:\s*"(?:[^"\\]|\\.)*")\s*,/g;
  let m;
  while ((m = nameRe.exec(src)) !== null) {
    const block = enclosingObject(src, m.index);
    if (!block) continue;

    // Does this descriptor use a log-gated module?
    const moduleIds = [...block.matchAll(/module:\s*([\w.]+)/g)].map(
      (x) => x[1],
    );
    const usesTainted = moduleIds.some((id) =>
      tainted.has(id.replace(/^.*\./, "")),
    );
    if (!usesTainted) continue;

    const expr = m[1];
    let off;
    let on;
    if (expr.startsWith("`")) {
      const tpl = expr.slice(1, -1);
      off = renderTemplate(tpl, bindings, false);
      on = renderTemplate(tpl, bindings, true);
    } else if (expr.startsWith('"')) {
      off = unquote(expr);
      on = off;
    } else {
      const t = /\?\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")/.exec(expr);
      on = unquote(t[1]);
      off = unquote(t[2]);
    }
    out.push({ raw: m[0].trim(), off, on });
  }
  return out;
}

function findAliasingNames(src) {
  return extractTaintedNameVariants(src).filter((v) => v.off === v.on);
}

// ─── group 0: the STRUCTURAL guarantee, proved by execution ──────────────────

/** Minimal GPUDevice stand-in — every object it hands back has its own identity. */
function makeStubDevice() {
  let renderPipelineOrdinal = 0;
  return {
    createShaderModule: ({ code, label }) => ({ __code: code, __label: label }),
    createRenderPipeline: (d) => ({
      __label: d.label ?? "pipeline",
      __descriptor: d,
      __ordinal: ++renderPipelineOrdinal,
    }),
    createRenderPipelineAsync: async (d) => ({
      __label: d.label ?? "pipeline",
      __descriptor: d,
      __ordinal: ++renderPipelineOrdinal,
    }),
    createComputePipeline: (d) => ({ __label: d.label ?? "compute" }),
    createComputePipelineAsync: async (d) => ({
      __label: d.label ?? "compute",
    }),
  };
}

/**
 * A descriptor with a DELIBERATELY MARKERLESS name and every other key-visible
 * field held constant. This is the shape a new renderer written by an author who
 * never read the marker convention produces.
 */
function markerlessDescriptor(vsModule, fsModule) {
  return {
    name: "Unmarked pipeline",
    layout: SHARED_STUB_LAYOUT,
    vertex: { module: vsModule, entryPoint: "vertexMain" },
    fragment: {
      module: fsModule ?? vsModule,
      entryPoint: "fragmentMain",
      targets: [{ format: "bgra8unorm" }],
    },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true },
    multisample: { count: 1 },
  };
}

const ALPHA_BLEND = {
  color: {
    operation: "add",
    srcFactor: "src-alpha",
    dstFactor: "one-minus-src-alpha",
  },
  alpha: {
    operation: "add",
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
  },
};

const ADDITIVE_BLEND = {
  color: { operation: "add", srcFactor: "one", dstFactor: "one" },
  alpha: { operation: "add", srcFactor: "one", dstFactor: "one" },
};

test("STRUCTURAL — exact normalized per-target blend state moves the key", async () => {
  const device = makeStubDevice();
  const cache = new WebGPURenderPipelineCache(device, "ctx-target-blend");
  const module = { __module: "shared" };
  const alpha = markerlessDescriptor(module);
  alpha.fragment.targets[0].blend = ALPHA_BLEND;
  const additive = markerlessDescriptor(module);
  additive.fragment.targets[0].blend = ADDITIVE_BLEND;

  assert.notEqual(
    cache.describeCacheKey(alpha),
    cache.describeCacheKey(additive),
    "two descriptor targets with different blend equations must not alias",
  );
  const alphaPipeline = await cache.getPipeline(alpha);
  const additivePipeline = await cache.getPipeline(additive);
  assert.notEqual(alphaPipeline, additivePipeline);
  assert.deepEqual(
    alphaPipeline.__descriptor.fragment.targets[0].blend,
    ALPHA_BLEND,
  );
  assert.deepEqual(
    additivePipeline.__descriptor.fragment.targets[0].blend,
    ADDITIVE_BLEND,
  );

  const implicitDefaults = markerlessDescriptor(module);
  implicitDefaults.fragment.targets[0].blend = { color: {}, alpha: {} };
  const explicitDefaults = markerlessDescriptor(module);
  explicitDefaults.fragment.targets[0].blend = {
    color: { operation: "add", srcFactor: "one", dstFactor: "zero" },
    alpha: { operation: "add", srcFactor: "one", dstFactor: "zero" },
  };
  assert.equal(
    cache.describeCacheKey(implicitDefaults),
    cache.describeCacheKey(explicitDefaults),
    "omitted WebGPU dictionary defaults must normalize to their explicit form",
  );

  const noBlend = markerlessDescriptor(module);
  assert.notEqual(
    cache.describeCacheKey(noBlend),
    cache.describeCacheKey(explicitDefaults),
    "blend-disabled and blend-enabled replacement targets are distinct states",
  );
});

test("STRUCTURAL — PipelineVariant blend fills bare targets while explicit targets win", async () => {
  const device = makeStubDevice();
  const cache = new WebGPURenderPipelineCache(device, "ctx-variant-blend");
  const module = { __module: "shared" };
  const descriptor = markerlessDescriptor(module);
  descriptor.fragment.targets = [
    { format: "bgra8unorm", blend: ADDITIVE_BLEND, writeMask: 0x3 },
    { format: "rgba16float" },
  ];
  const sourceTargets = structuredClone(descriptor.fragment.targets);

  const pipeline = await cache.getPipeline(descriptor, {
    blend: ALPHA_BLEND,
    colorWriteMask: 0x5,
  });
  const builtTargets = pipeline.__descriptor.fragment.targets;
  assert.deepEqual(
    builtTargets[0],
    descriptor.fragment.targets[0],
    "an explicit target blend/writeMask is the descriptor contract",
  );
  assert.deepEqual(builtTargets[1], {
    format: "rgba16float",
    blend: ALPHA_BLEND,
    writeMask: 0x5,
  });
  assert.deepEqual(
    descriptor.fragment.targets,
    sourceTargets,
    "variant application must not mutate the caller's descriptor",
  );

  const allExplicit = markerlessDescriptor(module);
  allExplicit.fragment.targets[0].blend = ADDITIVE_BLEND;
  const ignoredAlphaKey = cache.describeCacheKey(allExplicit, {
    blend: ALPHA_BLEND,
  });
  const ignoredAdditiveKey = cache.describeCacheKey(allExplicit, {
    blend: ADDITIVE_BLEND,
  });
  assert.equal(
    ignoredAlphaKey,
    ignoredAdditiveKey,
    "an ignored compatibility variant must not split an explicit target",
  );

  const sparse = markerlessDescriptor(module);
  sparse.fragment.targets = [null];
  assert.equal(
    cache.describeCacheKey(sparse, { blend: ALPHA_BLEND }),
    cache.describeCacheKey(sparse, { blend: ADDITIVE_BLEND }),
    "a null MRT slot must stay null rather than inherit variant blend state",
  );
});

test("STRUCTURAL — depthTest=false neutralizes depth but keeps the attachment", async () => {
  const device = makeStubDevice();
  const cache = new WebGPURenderPipelineCache(device, "ctx-depth-disabled");
  const module = { __module: "shared" };
  const descriptor = markerlessDescriptor(module);
  const sourceDepthStencil = structuredClone(descriptor.depthStencil);

  const depthOff = await cache.getPipeline(descriptor, { depthTest: false });
  // A descriptor that declares depthStencil renders into a pass that HAS a
  // depth attachment. Dropping the block would make the pipeline incompatible
  // with that pass, so depth is neutralized in place instead: compare `always`,
  // writes off, the descriptor's own format retained.
  assert.equal(
    depthOff.__descriptor.depthStencil.format,
    sourceDepthStencil.format,
    "depthTest=false must keep the descriptor's depth attachment format",
  );
  assert.equal(
    depthOff.__descriptor.depthStencil.depthCompare,
    "always",
    "depthTest=false must not retain the descriptor's active depth compare",
  );
  assert.equal(
    depthOff.__descriptor.depthStencil.depthWriteEnabled,
    false,
    "depthTest=false must not retain the descriptor's depth write flag",
  );
  assert.deepEqual(
    descriptor.depthStencil,
    sourceDepthStencil,
    "depth disabling must not mutate the source descriptor",
  );

  // A color-only descriptor still gets no depth state at all.
  const colorOnly = markerlessDescriptor(module);
  delete colorOnly.depthStencil;
  const colorOnlyDepthOff = await cache.getPipeline(colorOnly, {
    depthTest: false,
  });
  assert.equal(
    colorOnlyDepthOff.__descriptor.depthStencil,
    undefined,
    "depthTest=false must not synthesize depth state on a color-only pipeline",
  );

  const stencilFront = {
    compare: "equal",
    failOp: "keep",
    depthFailOp: "keep",
    passOp: "replace",
  };
  const stencilOnly = await cache.getPipeline(descriptor, {
    depthTest: false,
    depthWrite: true,
    depthCompare: "less",
    stencilFront,
  });
  assert.equal(
    stencilOnly.__descriptor.depthStencil.format,
    "depth24plus-stencil8",
  );
  assert.equal(stencilOnly.__descriptor.depthStencil.depthWriteEnabled, false);
  assert.equal(stencilOnly.__descriptor.depthStencil.depthCompare, "always");
  assert.deepEqual(
    stencilOnly.__descriptor.depthStencil.stencilFront,
    stencilFront,
  );
});

test("STRUCTURAL — modifier-only depth variants do not create an attachment", async () => {
  const device = makeStubDevice();
  const cache = new WebGPURenderPipelineCache(
    device,
    "ctx-depth-modifier-only",
  );
  const module = { __module: "shared" };
  const descriptor = markerlessDescriptor(module);
  delete descriptor.depthStencil;

  const modifierCases = [
    ["depthWrite", { depthWrite: false }],
    ["depthCompare", { depthCompare: "always" }],
    ["depthBias", { depthBias: 1 }],
    ["depthBiasSlopeScale", { depthBiasSlopeScale: 1 }],
    ["depthBiasClamp", { depthBiasClamp: 1 }],
  ];

  for (const [name, variant] of modifierCases) {
    const pipeline = await cache.getPipeline(descriptor, variant);
    assert.equal(
      pipeline.__descriptor.depthStencil,
      undefined,
      `${name} must not synthesize a depth attachment`,
    );
  }

  const explicitlyEnabled = await cache.getPipeline(descriptor, {
    depthTest: true,
    depthWrite: false,
  });
  assert.equal(
    explicitlyEnabled.__descriptor.depthStencil.format,
    "depth24plus",
  );
  assert.equal(
    explicitlyEnabled.__descriptor.depthStencil.depthWriteEnabled,
    false,
  );
  assert.equal(
    explicitlyEnabled.__descriptor.depthStencil.depthCompare,
    "less-equal",
  );
});

const SHARED_STUB_LAYOUT = { __layout: "shared" };

/** WGSL with no directives — the module cache still keys per define mask. */
const STRUCTURAL_WGSL =
  "@vertex fn vertexMain() {}\n@fragment fn fragmentMain() {}\n";

test("STRUCTURAL — a NEW define bit with NO name marker cannot alias (every ShaderDefine bit)", () => {
  const device = makeStubDevice();
  const moduleCache = new WebGPUShaderModuleCache(device);
  const cache = new WebGPURenderPipelineCache(device, "ctx-structural");

  const baseModule = moduleCache.getOrCreate(
    ShaderSourceId.GLOBE_TERRAIN ?? 1,
    STRUCTURAL_WGSL,
    0,
    "structural base",
  );
  const baseKey = cache.describeCacheKey(markerlessDescriptor(baseModule));

  const bits = Object.entries(ShaderDefine).filter(
    ([, v]) => typeof v === "number" && v !== 0,
  );
  assert.ok(
    bits.length > 10,
    `non-vacuous: expected the real ShaderDefine registry, got ${bits.length} entries`,
  );

  const collisions = [];
  for (const [name, bit] of bits) {
    const variantModule = moduleCache.getOrCreate(
      ShaderSourceId.GLOBE_TERRAIN ?? 1,
      STRUCTURAL_WGSL,
      bit,
      `structural ${name}`,
    );
    // Non-vacuity: the module cache must genuinely hand back a different
    // object, otherwise this test would be proving nothing about the key.
    assert.notEqual(
      variantModule,
      baseModule,
      `WebGPUShaderModuleCache returned the SAME module for defines=0 and ` +
        `${name}; the premise of the whole fold is that it does not`,
    );
    const variantKey = cache.describeCacheKey(
      markerlessDescriptor(variantModule),
    );
    if (variantKey === baseKey) {
      collisions.push(name);
    }
  }

  assert.deepEqual(
    collisions,
    [],
    "these ShaderDefine bits alias onto the base pipeline key even though they " +
      "select a different shader module. The `sh:` module-identity fold in " +
      "WebGPURenderPipelineCache.generateCacheKey is what prevents that; if this " +
      "fails the fold has been removed or bypassed:\n  " +
      collisions.join("\n  "),
  );
});

test("STRUCTURAL — the fold separates by MODULE, and a fragment-only flip is caught too", async () => {
  const device = makeStubDevice();
  const cache = new WebGPURenderPipelineCache(device, "ctx-frag");

  const vs = { __module: "vs" };
  const fsA = { __module: "fs-a" };
  const fsB = { __module: "fs-b" };

  assert.notEqual(
    cache.describeCacheKey(markerlessDescriptor(vs, fsA)),
    cache.describeCacheKey(markerlessDescriptor(vs, fsB)),
    "a define that only affects the FRAGMENT module must still move the key",
  );

  // Entry point is part of pipeline identity too (the globe's debug-fragment
  // variants differ only there).
  const a = markerlessDescriptor(vs, fsA);
  const b = markerlessDescriptor(vs, fsA);
  b.fragment.entryPoint = "fragmentDebugTri";
  assert.notEqual(
    cache.describeCacheKey(a),
    cache.describeCacheKey(b),
    "a fragment entryPoint change must move the key",
  );

  const first = await cache.getPipeline(markerlessDescriptor(vs, fsA));
  const second = await cache.getPipeline(markerlessDescriptor(vs, fsB));
  assert.notEqual(first, second, "each module must get its own pipeline");
  assert.equal(cache.getStats().wrongModuleHits, 0);
});

test("STRUCTURAL — hit rate is preserved: identical inputs still produce one entry", async () => {
  const device = makeStubDevice();
  const cache = new WebGPURenderPipelineCache(device, "ctx-hitrate");

  // A memoized producer hands the SAME module objects back on every rebuild.
  const vs = { __module: "vs" };
  const fs = { __module: "fs" };

  const first = await cache.getPipeline(markerlessDescriptor(vs, fs));
  for (let i = 0; i < 5; i++) {
    const again = await cache.getPipeline(markerlessDescriptor(vs, fs));
    assert.equal(again, first, "a genuinely identical request must HIT");
  }
  const stats = cache.getStats();
  assert.equal(stats.size, 1, "the fold must not multiply entries");
  assert.equal(stats.misses, 1);
  assert.equal(stats.hits, 5);
  assert.equal(stats.wrongModuleHits, 0);
});

test("STRUCTURAL — every descriptor field buildPipelineDescriptor reads moves the key", () => {
  const device = makeStubDevice();
  const cache = new WebGPURenderPipelineCache(device, "ctx-fields");
  const vs = { __module: "vs" };
  const fs = { __module: "fs" };
  const base = markerlessDescriptor(vs, fs);
  const baseKey = cache.describeCacheKey(base);

  // Each mutator returns a descriptor differing from `base` in exactly one
  // field that `buildPipelineDescriptor` forwards to `createRenderPipeline`.
  // No caller in-tree passes a `variant`, so BEFORE the fold most of these
  // were invisible to the key — `, noCull` (GLOBE-UNDERGROUND-COLOR) was a
  // hand-written stand-in for the `primitive.cullMode` row below.
  const mutations = {
    "vertex.module": (d) => (d.vertex.module = { __module: "other" }),
    "fragment.module": (d) => (d.fragment.module = { __module: "other" }),
    "vertex.entryPoint": (d) => (d.vertex.entryPoint = "vertexOther"),
    "fragment.entryPoint": (d) => (d.fragment.entryPoint = "fragmentOther"),
    layout: (d) => (d.layout = { __layout: "other" }),
    "primitive.topology": (d) => (d.primitive.topology = "line-list"),
    "primitive.cullMode": (d) => (d.primitive.cullMode = "none"),
    "primitive.frontFace": (d) => (d.primitive.frontFace = "cw"),
    "primitive.unclippedDepth": (d) => (d.primitive.unclippedDepth = true),
    "depthStencil.format": (d) => (d.depthStencil.format = "depth32float"),
    "depthStencil.depthWriteEnabled": (d) =>
      (d.depthStencil.depthWriteEnabled = false),
    "depthStencil.depthCompare": (d) =>
      (d.depthStencil.depthCompare = "always"),
    "depthStencil.depthBias": (d) => (d.depthStencil.depthBias = 4),
    "depthStencil.stencilFront": (d) =>
      (d.depthStencil.stencilFront = { compare: "equal", passOp: "keep" }),
    "depthStencil.stencilWriteMask": (d) =>
      (d.depthStencil.stencilWriteMask = 0x0f),
    "multisample.count": (d) => (d.multisample.count = 4),
    "multisample.alphaToCoverageEnabled": (d) =>
      (d.multisample.alphaToCoverageEnabled = true),
    "fragment.targets[0].format": (d) =>
      (d.fragment.targets[0].format = "rgba16float"),
    "vertex.buffers": (d) =>
      (d.vertex.buffers = [
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        },
      ]),
  };

  const unhashed = [];
  for (const [field, mutate] of Object.entries(mutations)) {
    const d = markerlessDescriptor(vs, fs);
    mutate(d);
    if (cache.describeCacheKey(d) === baseKey) {
      unhashed.push(field);
    }
  }
  assert.deepEqual(
    unhashed,
    [],
    "these descriptor fields change the resulting GPURenderPipeline but do NOT " +
      "change the cache key, so two pipelines differing only in them alias:\n  " +
      unhashed.join("\n  "),
  );
});

test("STRUCTURAL — the optional producer-declared define mask also moves the key", () => {
  const device = makeStubDevice();
  const cache = new WebGPURenderPipelineCache(device, "ctx-dfn");
  const vs = { __module: "vs" };

  const plain = markerlessDescriptor(vs);
  const declared = markerlessDescriptor(vs);
  declared.defines = ShaderDefine.LOG_DEPTH;

  // Omitting the field must leave the key exactly as it was — the belt is
  // optional, so producers that never adopt it are unaffected.
  assert.equal(
    cache.describeCacheKey(plain),
    cache.describeCacheKey(markerlessDescriptor(vs)),
    "an omitted `defines` must not perturb the key",
  );
  assert.notEqual(
    cache.describeCacheKey(plain),
    cache.describeCacheKey(declared),
    "a declared `defines` mask must participate in the key",
  );

  const hi = markerlessDescriptor(vs);
  hi.definesHi = 1;
  assert.notEqual(
    cache.describeCacheKey(declared),
    cache.describeCacheKey(hi),
    "the hi word must participate too",
  );
});

test("STRUCTURAL — webgpuObjectIdentity is stable, distinct, and 0 for absent", () => {
  const a = {};
  const b = {};
  assert.equal(webgpuObjectIdentity(a), webgpuObjectIdentity(a), "stable");
  assert.notEqual(webgpuObjectIdentity(a), webgpuObjectIdentity(b), "distinct");
  assert.equal(webgpuObjectIdentity(undefined), 0);
  assert.equal(webgpuObjectIdentity(null), 0);
  assert.ok(
    webgpuObjectIdentity(a) > 0,
    "real objects must never collide with the absent sentinel",
  );
});

test("STRUCTURAL — the COMPUTE cache folds its module too", async () => {
  const device = makeStubDevice();
  const moduleCache = new WebGPUShaderModuleCache(device);
  const cache = new WebGPUComputePipelineCache(device, "ctx-compute");
  const layout = { __layout: "compute" };

  const modA = moduleCache.getOrCreate(1, STRUCTURAL_WGSL, 0, "compute A");
  const modB = moduleCache.getOrCreate(
    1,
    STRUCTURAL_WGSL,
    ShaderDefine.LOG_DEPTH,
    "compute B",
  );
  assert.notEqual(modA, modB, "premise: distinct defines ⇒ distinct module");

  const descFor = (module) => ({
    name: "Unmarked compute",
    layout,
    compute: { module, entryPoint: "main" },
  });

  const first = await cache.getPipeline(descFor(modA));
  const second = await cache.getPipeline(descFor(modB));
  assert.notEqual(
    first,
    second,
    "the compute cache served one pipeline for two different modules under an " +
      "unmarked name — its `m:` module-identity segment is missing",
  );
  const again = await cache.getPipeline(descFor(modA));
  assert.equal(again, first, "an identical compute request must still HIT");
});

// ─── group 0b: MUTATION-FOLD — remove the fold, require detection ────────────

/**
 * Load a MUTATED copy of an engine module. The copy goes to a temp directory,
 * so nothing under `packages/` is touched; relative specifiers are rewritten to
 * absolute file URLs because the copy no longer sits next to its siblings.
 */
async function importMutated(sourceFile, mutate, label) {
  const original = await readFile(sourceFile, "utf8");
  const mutated = mutate(original);
  assert.notEqual(
    mutated,
    original,
    `the ${label} mutation did not change ${sourceFile} — its target text has ` +
      `moved, so this MUTATION test would pass vacuously and the STRUCTURAL ` +
      `result above would be unfalsifiable`,
  );
  const rewritten = mutated.replace(
    /from\s+"\.\/([\w.]+)\.js"/g,
    (_m, name) =>
      `from "${pathToFileURL(join(WEBGPU_DIR, `${name}.ts`)).href}"`,
  );
  const dir = await mkdtemp(join(tmpdir(), "cesium-pipeline-key-"));
  const file = join(dir, "Mutant.ts");
  await writeFile(file, rewritten, "utf8");
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("MUTATION-FOLD — dropping the module ids from `sh:` makes the define axis alias again", async () => {
  const mutant = await importMutated(
    RENDER_CACHE_FILE,
    (src) =>
      src
        .replace("webgpuObjectIdentity(vertex?.module)", "0")
        .replace("webgpuObjectIdentity(fragment?.module)", "0"),
    "sh: module-id removal",
  );

  const device = makeStubDevice();
  const cache = new mutant.WebGPURenderPipelineCache(device, "ctx-mutant");
  const a = markerlessDescriptor({ __module: "classic" });
  const b = markerlessDescriptor({ __module: "enhOcean" });

  assert.equal(
    cache.describeCacheKey(a),
    cache.describeCacheKey(b),
    "with the module ids removed the two keys MUST collide — if they do not, " +
      "the STRUCTURAL group is not actually testing the fold",
  );
});

test("MUTATION-FOLD — neutering webgpuObjectIdentity collapses module AND layout identity", async () => {
  const mutant = await importMutated(
    RENDER_CACHE_FILE,
    (src) =>
      src.replace(
        "  let id = gpuObjectIdentity.get(obj);",
        "  return 1;\n  let id = gpuObjectIdentity.get(obj);",
      ),
    "identity neutering",
  );

  const device = makeStubDevice();
  const cache = new mutant.WebGPURenderPipelineCache(device, "ctx-mutant2");
  assert.equal(
    cache.describeCacheKey(markerlessDescriptor({ __module: "a" })),
    cache.describeCacheKey(markerlessDescriptor({ __module: "b" })),
    "a constant identity function must reintroduce module aliasing",
  );
  const layoutA = markerlessDescriptor({ __module: "a" });
  const layoutB = markerlessDescriptor({ __module: "a" });
  layoutB.layout = { __layout: "other" };
  assert.equal(
    cache.describeCacheKey(layoutA),
    cache.describeCacheKey(layoutB),
    "…and layout aliasing, which the `pl:` segment otherwise closes",
  );
});

test("MUTATION-FOLD — dropping the compute cache's `m:` segment makes it alias again", async () => {
  const mutant = await importMutated(
    COMPUTE_CACHE_FILE,
    (src) => src.replace("|m:${moduleId}", ""),
    "compute m: removal",
  );

  const device = makeStubDevice();
  const cache = new mutant.WebGPUComputePipelineCache(device, "ctx-mutant3");
  const layout = { __layout: "compute" };
  const descFor = (module) => ({
    name: "Unmarked compute",
    layout,
    compute: { module, entryPoint: "main" },
  });

  const first = await cache.getPipeline(descFor({ __module: "a" }));
  const second = await cache.getPipeline(descFor({ __module: "b" }));
  assert.equal(
    first,
    second,
    "without `m:` the compute cache MUST serve one pipeline for two modules — " +
      "if it does not, the compute STRUCTURAL test proves nothing",
  );
});

// ─── group 1: enumeration ────────────────────────────────────────────────────

test("ENUMERATION-LEDGER — every LOG_DEPTH-gated WebGPU file is declared at-risk or explicitly exempt", async () => {
  const entries = await readdir(WEBGPU_DIR);
  const candidates = [];
  for (const f of entries) {
    if (!/\.(ts|js)$/.test(f)) continue;
    const src = await readFile(join(WEBGPU_DIR, f), "utf8");
    if (src.includes("ShaderDefine.LOG_DEPTH")) candidates.push(f);
  }

  assert.ok(
    candidates.length > 0,
    "non-vacuous: expected to find LOG_DEPTH-gated files",
  );

  const undeclared = candidates.filter(
    (f) =>
      !AT_RISK.includes(f) &&
      !DEFINES_STAMP.includes(f) &&
      !NO_CENTRAL_CACHE.includes(f) &&
      f !== MODEL_CENTRAL &&
      !EXEMPT.has(f),
  );
  assert.deepEqual(
    undeclared,
    [],
    `These files compile a LOG_DEPTH-gated shader module but are not declared anywhere.\n` +
      `NOTE — since NEW-WEBGPU-PIPELINE-KEY-DEFINE-AXIS-GENERAL this is a LEDGER gap, not a\n` +
      `correctness hole: the central key folds shader-module identity, so an unmarked file\n` +
      `cannot alias (see the STRUCTURAL group). Classify it anyway so the marker surface\n` +
      `stays legible — add it to AT_RISK with a marker, or to\n` +
      `DEFINES_STAMP / NO_CENTRAL_CACHE / EXEMPT with a one-line reason:\n  ` +
      undeclared.join("\n  "),
  );

  for (const f of [
    ...AT_RISK,
    ...DEFINES_STAMP,
    ...NO_CENTRAL_CACHE,
    MODEL_CENTRAL,
  ]) {
    assert.ok(
      candidates.includes(f),
      `${f} is declared here but no longer references ShaderDefine.LOG_DEPTH — remove the entry or fix the reference.`,
    );
  }
});

// ─── group 1b: the no-central-cache classification, re-asserted ──────────────

for (const file of NO_CENTRAL_CACHE) {
  test(`NO-CENTRAL-CACHE — ${file} still bypasses the central pipeline cache`, async () => {
    const src = await readFile(join(WEBGPU_DIR, file), "utf8");
    assert.ok(
      /device\.createRenderPipeline/.test(src),
      `non-vacuous: ${file} no longer creates pipelines directly, so this classification is meaningless`,
    );
    const centralRefs = [
      ...src.matchAll(
        /webgpuPipelineCache|_centralPipelineCache|getPipelineSync|\bgetPipeline\(/g,
      ),
    ].map((m) => m[0]);
    assert.deepEqual(
      centralRefs,
      [],
      `${file} now routes through the central pipeline cache (${centralRefs.join(", ")}).\n` +
        `Its shader module varies with LOG_DEPTH, so every descriptor it hands to the cache\n` +
        `MUST carry a log marker in its name. Add the markers and move it to AT_RISK.`,
    );
  });
}

// ─── group 1c: the one model descriptor that DOES use the central cache ──────

test(`MODEL-CENTRAL — ${MODEL_CENTRAL}'s central descriptor name encodes the LOG_DEPTH axis`, async () => {
  const src = await readFile(join(WEBGPU_DIR, MODEL_CENTRAL), "utf8");

  // ONE descriptor, however many lookup paths consume it. Main uses two
  // (`getPipelineSync` then async `getPipeline`) against the same `centralDesc`.
  // If a call appears that passes something else, this hand-traced proof no
  // longer covers the file and must be redone.
  const centralCalls = [...src.matchAll(/central\.getPipeline\w*\(([^)]*)\)/g)];
  assert.ok(
    centralCalls.length > 0,
    `non-vacuous: ${MODEL_CENTRAL} no longer calls the central cache at all`,
  );
  const badArgs = centralCalls
    .map((m) => m[1].trim())
    .filter((a) => a !== "centralDesc");
  assert.deepEqual(
    badArgs,
    [],
    `${MODEL_CENTRAL} hands a descriptor other than \`centralDesc\` to the central cache\n` +
      `(${badArgs.join(", ")}). The manual proof in this spec's header covered only the COLOR\n` +
      `pipeline — re-trace the new one and give its descriptor name a log marker.`,
  );

  const descriptorLiterals = [...src.matchAll(/const\s+centralDesc\s*:/g)]
    .length;
  assert.equal(
    descriptorLiterals,
    1,
    `${MODEL_CENTRAL} declares ${descriptorLiterals} \`centralDesc\` descriptors (was 1).`,
  );

  const marked = [...src.matchAll(/name:\s*`[^`]*\bld=\$\{[^`]*`/g)].length;
  assert.ok(
    marked >= 1,
    `${MODEL_CENTRAL}: the central descriptor name no longer carries an \`ld=\` marker.\n` +
      `Neither \`raw.label\` nor \`key\` encodes LOG_DEPTH (see this spec's header), and\n` +
      `\`maybeUpdateForLogDepth\` wipes \`_pipelines\` on a flip — so without the marker the\n` +
      `rebuilt descriptor aliases onto the pipeline built from the previous module.`,
  );
});

for (const file of DEFINES_STAMP) {
  test(`DEFINES-STAMP — ${file} stamps the whole define bitmask into its pipeline names`, async () => {
    const src = await readFile(join(WEBGPU_DIR, file), "utf8");
    const stamps = [...src.matchAll(/name:\s*`[^`]*defines=0x\$\{[^`]*`/g)]
      .length;
    const names = [...src.matchAll(/name:\s*`[^`]*`/g)].length;
    assert.ok(names > 0, `non-vacuous: no name templates found in ${file}`);
    assert.equal(
      stamps,
      names,
      `${file}: ${names - stamps} of ${names} pipeline name templates omit the ` +
        `\`defines=0x\${defines.toString(16)}\` stamp, so those pipelines do not encode ` +
        `the LOG_DEPTH axis (nor any other define) into the central cache key.`,
    );
  });
}

// ─── group 2: taint-analysis non-vacuity ─────────────────────────────────────

for (const file of AT_RISK) {
  test(`TAINT — ${file} exposes at least one descriptor using a log-gated module`, async () => {
    const src = await readFile(join(WEBGPU_DIR, file), "utf8");
    assert.ok(
      collectTaintedIdents(src).size > 0,
      `no log-gated identifier found in ${file}; the taint tracker matched nothing, so ` +
        `the DISTINCTNESS test would pass vacuously.`,
    );
    assert.ok(
      extractTaintedNameVariants(src).length > 0,
      `no pipeline descriptor in ${file} was seen to reference a log-gated module; ` +
        `the DISTINCTNESS test would pass vacuously.`,
    );
  });
}

// ─── group 3: distinctness ───────────────────────────────────────────────────

for (const file of AT_RISK) {
  test(`DISTINCTNESS — ${file} emits a distinct pipeline name for every LOG_DEPTH state`, async () => {
    const src = await readFile(join(WEBGPU_DIR, file), "utf8");
    const offenders = findAliasingNames(src);
    assert.deepEqual(
      offenders.map((v) => v.off),
      [],
      `${file}: these descriptors use a LOG_DEPTH-gated shader module but their names are\n` +
        `IDENTICAL with the define on and off, so the central pipeline cache will serve\n` +
        `whichever pipeline materialized first for BOTH modules:\n  ` +
        offenders.map((v) => v.raw).join("\n  "),
    );
  });
}

// ─── group 4: mutation (proves group 3 has teeth) ────────────────────────────

/** Remove the log marker the way a careless edit would. */
function stripLogMarker(src) {
  return (
    src
      // `ld=${ldFlag}` and `ld=${logDepthActive ? 1 : 0}` in bracketed suffixes
      .replace(/ld=\$\{[^{}]*\}/g, "ld=")
      // `${ldLabel}` in the globe's concatenated name
      .replace(/\$\{ldLabel\}/g, "")
      // a `name: <logFlag> ? "A" : "B"` ternary -> the off constant
      .replace(
        /name:\s*(?:host\.)?(?:_)?\w*(?:logDepth|pickLog)\w*\s*\?\s*"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,/g,
        'name: "$2",',
      )
  );
}

for (const file of AT_RISK) {
  test(`MUTATION — stripping the log marker from ${file} makes the distinctness check FAIL`, async () => {
    const src = await readFile(join(WEBGPU_DIR, file), "utf8");
    assert.deepEqual(
      findAliasingNames(src).map((v) => v.off),
      [],
      "precondition: the unmutated file must be clean",
    );

    const mutated = stripLogMarker(src);
    assert.notEqual(
      mutated,
      src,
      `the mutation did not change ${file} — stripLogMarker does not know this file's marker ` +
        `spelling, so the MUTATION test would pass vacuously and DISTINCTNESS is unfalsifiable.`,
    );

    assert.ok(
      findAliasingNames(mutated).length > 0,
      `removing the log marker from ${file} did NOT produce a colliding name — ` +
        `the distinctness check cannot detect a regression in this file.`,
    );
  });
}

// ─── group 6: the globe reaches the class-(B) trigger ────────────────────────

test("GLOBE-USELOGDEPTH-REACH — the globe flips on `frameState.useLogDepth`, the trigger class (B) is defined by", async () => {
  const src = await readFile(
    join(WEBGPU_DIR, "WebGPUGlobeSurfaceRenderer.ts"),
    "utf8",
  );
  // Comments are stripped so the header prose above cannot satisfy the check.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  assert.ok(
    !/\.\s*_logDepthWriteEnabled\b/.test(code),
    "WebGPUGlobeSurfaceRenderer.ts resolves the log-depth master switch " +
      "directly again. The class-(B) surface described in this file's header is " +
      "defined by `frameState.useLogDepth`; with a raw master-switch read the " +
      "globe does not move on that trigger, so a morph/orthographic transition " +
      "leaves the globe on LOG depth while every sibling drops to hyperbolic — " +
      "mixed encodings in one attachment. See globe-use-log-depth.spec.mjs.",
  );
  assert.ok(
    /this\._logDepthEnabled\s*=\s*isWebGPULogDepthActive\s*\(/.test(code),
    "the globe no longer resolves the shared `isWebGPULogDepthActive` gate",
  );
  assert.ok(
    /this\._pickLogDepthEnabled\s*=\s*isWebGPUPickLogDepthActive\s*\(/.test(
      code,
    ),
    "the globe pick no longer resolves the shared `isWebGPUPickLogDepthActive` gate",
  );
});

// ─── group 5: the runtime companion instrument ───────────────────────────────

test(`WRONG-MODULE-HITS — ${PIPELINE_CACHE} still carries the runtime aliasing counter`, async () => {
  const src = await readFile(join(WEBGPU_DIR, PIPELINE_CACHE), "utf8");

  // Post-fold the counter is expected to read 0 FOREVER, which is exactly when
  // an unused instrument gets deleted as dead code. It is not dead: it is the
  // runtime canary that the `sh:` fold is still reaching the key. Assert the
  // fold and the counter together so neither can be removed on the other's
  // authority.
  assert.ok(
    /parts\.push\(\s*`sh:/.test(src) &&
      /webgpuObjectIdentity\(vertex\?\.module\)/.test(src),
    `${PIPELINE_CACHE}: the \`sh:\` shader-identity fold is gone. That fold — not the ` +
      `per-axis name markers — is what makes define aliasing structurally impossible. ` +
      `See the STRUCTURAL group at the top of this file.`,
  );

  assert.ok(
    /wrongModuleHits\s*:\s*number/.test(src),
    `${PIPELINE_CACHE}: \`wrongModuleHits\` is no longer declared on the stats type. ` +
      `It is the ONLY counter that can detect this defect at runtime — hit rate moves the ` +
      `WRONG WAY under aliasing (a collision is served as a hit).`,
  );

  assert.ok(
    /this\.stats\.wrongModuleHits\+\+/.test(src),
    `${PIPELINE_CACHE}: nothing increments \`wrongModuleHits\` any more, so the counter ` +
      `is permanently 0 and probe-pipeline-key-aliasing.mjs's cross-check is vacuous.`,
  );

  assert.ok(
    /wrongModuleHits:\s*this\.stats\.wrongModuleHits/.test(src),
    `${PIPELINE_CACHE}: \`getStats()\` no longer exports \`wrongModuleHits\`, so the probe ` +
      `cannot read it.`,
  );

  // The increment must be guarded by an actual module comparison — a counter
  // that increments unconditionally, or never, is not an instrument.
  assert.ok(
    /cached\.descriptor\.vertex\?\.module\s*!==\s*requested\.vertex\?\.module/.test(
      src,
    ) &&
      /cached\.descriptor\.fragment\?\.module\s*!==\s*requested\.fragment\?\.module/.test(
        src,
      ),
    `${PIPELINE_CACHE}: the \`wrongModuleHits\` increment is no longer gated on a ` +
      `vertex/fragment MODULE comparison. Whatever it counts now, it is not aliasing.`,
  );
});
