// pipeline-key-aliasing.spec.mjs — browser-free durable guard for the
// LOG_DEPTH axis of the central pipeline cache key.
//
// WHY THIS EXISTS
// ---------------
// `WebGPURenderPipelineCache.generateCacheKey` hashes exactly: `descriptor.name`,
// fifteen optional `variant.*` fields, `ms:<multisample.count>`,
// `df:<depthStencil.format>`, a per-target `tg:` signature and a `vx:` vertex
// buffer signature. It NEVER reads `descriptor.vertex.module`,
// `descriptor.fragment.module`, `entryPoint`, or any shader-define bitmask.
//
// `WebGPUShaderModuleCache` keys correctly on `(sourceId, defines)`, so flipping
// LOG_DEPTH genuinely produces a DIFFERENT `GPUShaderModule` — which is then
// discarded by a pipeline key that cannot see it. Correctness is therefore fully
// delegated to callers encoding every shader-affecting axis into the free-form
// `descriptor.name`. `DEFERRED_WORK.md` states the convention: "distinct
// pipeline structure MUST produce a distinct name".
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
// A SOURCE-TEXT spec, so it needs no GPU and runs in CI. Seven groups:
//
//   1. ENUMERATION — every file under `Renderer/WebGPU/` that compiles a
//      LOG_DEPTH-gated shader module is classified into exactly one bucket. A
//      newly-added renderer cannot quietly skip the convention.
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
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBGPU_DIR = resolve(
  HERE,
  "../../packages/engine/Source/Renderer/WebGPU",
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
 * (alphaMode, doubleSided, materialDefines, topology, optional `:m34`).
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

// ─── group 1: enumeration ────────────────────────────────────────────────────

test("ENUMERATION — every LOG_DEPTH-gated WebGPU file is declared at-risk or explicitly exempt", async () => {
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
      `Give every log-gated pipeline name a marker and add the file to AT_RISK, or place it in\n` +
      `DEFINES_STAMP / NO_CENTRAL_CACHE / EXEMPT with a reason:\n  ` +
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
