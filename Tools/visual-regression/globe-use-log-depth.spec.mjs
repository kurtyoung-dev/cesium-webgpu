// globe-use-log-depth.spec.mjs — browser-free durable guard for
// NEW-WEBGPU-GLOBE-USE-LOG-DEPTH.
// @purpose Pins that the globe resolves the shared isWebGPULogDepthActive gate so orthographic modes never mix log and hyperbolic encodings in one depth buffer.
// @status ACTIVE
//
// WHY THIS EXISTS
// ---------------
// `WebGPUGlobeSurfaceRenderer` was the ONLY WebGPU depth producer that resolved
// its log-depth state from `context._logDepthWriteEnabled` ALONE. Every sibling
// producer gates on the shared predicate
// `isWebGPULogDepthActive(context, frameState)` =
// `_logDepthWriteEnabled && frameState.useLogDepth`, and `Scene.js` clears
// `frameState.useLogDepth` for ANY orthographic frustum (2D, Columbus View, an
// explicit `camera.switchToOrthographicFrustum()`) and whenever
// `scene.logarithmicDepthBuffer` is false:
//
//     frameState.useLogDepth =
//       this._logDepthBuffer &&
//       !(this.camera.frustum instanceof OrthographicFrustum ||
//         this.camera.frustum instanceof OrthographicOffCenterFrustum);
//
// So in those modes the globe wrote csm_writeLogDepth-encoded
// `@builtin(frag_depth)` into the SAME depth attachment that the classifiers,
// the enhanced-ocean depth test, the depth plane and the pick fleet were
// reading as hyperbolic NDC z — two encodings in one buffer. The failure is not
// subtle: `WebGPUSceneRendererPickPass`'s header records the measured inverse
// (a log-depth plane over a hyperbolic fleet OVER-OCCLUDED every pick cohort
// across the globe disk, Run-1 2026-07-16), because a log producer sits at ~0.4
// where a hyperbolic one sits at ~0.999. Under a PURE orthographic frustum the
// encode additionally degenerates: clip `.w` is constant, so
// `csm_vertexLogDepth(clip, near) = (clip.w - near) + 1` is a per-draw constant
// and is NaN whenever `near > 2.0`.
//
// THREE THINGS HAVE TO BE TRUE, AND THEY ARE THREE DIFFERENT KINDS OF FACT
// -----------------------------------------------------------------------
//   1. The globe RESOLVES the same gate as its siblings — a source fact about
//      the two writers in `WebGPUGlobeSurfaceRenderer.ts` (group B), plus the
//      executed behaviour of the gate itself (group A).
//   2. The two states are DISTINCT CACHE ENTRIES — otherwise the flip is a
//      relabelling that serves the previously-compiled pipeline. Group D runs
//      the real `buildGlobePipelineCacheKey`; the CENTRAL-cache half of the
//      same claim is owned by `pipeline-key-aliasing.spec.mjs` (which this
//      spec's group D deliberately does not duplicate).
//   3. The OFF path is GENUINELY HYPERBOLIC, not merely renamed — a fact about
//      the WGSL, so group E runs the real `WebGPUShaderPreprocessor` over the
//      real `GlobeTerrain.wgsl` and asserts the OFF expansion contains no
//      `@builtin(frag_depth)` member at all.
//
// Groups B, C and E each carry a MUTATION test that re-introduces the defect
// and requires the corresponding check to FAIL. Without those, a clean result
// here is unfalsifiable — the failure mode that let the original defect sit
// behind a green suite.
//
// SCOPE OF THE BEHAVIOUR CHANGE: SCENE3D with a perspective frustum has
// `useLogDepth === true`, so `master && useLogDepth === master` and the globe's
// resolved state is unchanged there. The change is confined to the modes where
// `Scene.js` clears the flag.
//
// Run: node --test Tools/visual-regression/globe-use-log-depth.spec.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const WEBGPU_DIR = resolve(ROOT, "packages/engine/Source/Renderer/WebGPU");
const GLOBE_WGSL = resolve(
  ROOT,
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
);

const RENDERER = "WebGPUGlobeSurfaceRenderer.ts";
const PIPELINES = "WebGPUGlobeSurfacePipelines.ts";

const readWebGPU = (file) => readFileSync(join(WEBGPU_DIR, file), "utf8");

enableEngineTsResolution();

const { isWebGPULogDepthActive, isWebGPUPickLogDepthActive } = await import(
  pathToFileURL(join(WEBGPU_DIR, "WebGPULogDepth.ts")).href
);
const { ShaderDefine } = await import(
  pathToFileURL(join(WEBGPU_DIR, "WebGPUShaderDefines.ts")).href
);
const { preprocess } = await import(
  pathToFileURL(join(WEBGPU_DIR, "WebGPUShaderPreprocessor.ts")).href
);
const { buildGlobePipelineCacheKey, parseGlobePipelineCacheKey } = await import(
  pathToFileURL(join(WEBGPU_DIR, "WebGPUGlobeSurfacePipelineKey.ts")).href
);

// ─── lexical helpers ─────────────────────────────────────────────────────────

/**
 * Remove comments so a source scan cannot be satisfied — or defeated — by prose.
 * `//` is NOT treated as a comment opener when preceded by `:` so that a URL in
 * a string literal does not swallow the rest of its line and hide a real read.
 * Block comments are removed first; the surviving `/` characters cannot start a
 * regex literal in any position this spec looks at.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** WGSL has only line comments; the URL caveat above does not apply. */
function stripWgslComments(source) {
  return source.replace(/\/\/[^\n]*/g, "");
}

const collapse = (s) => s.replace(/\s+/g, " ").trim();

/**
 * Every `this.<field> = <expr>;` assignment in a source, as collapsed
 * expression text. Statement-terminated on the first `;`, which is safe here
 * because the expressions involved are single calls with no embedded `;`.
 */
function assignmentsTo(source, field) {
  const re = new RegExp(`this\\.${field}\\s*=\\s*([\\s\\S]*?);`, "g");
  const out = [];
  let m;
  while ((m = re.exec(source)) !== null) {
    out.push(collapse(m[1]));
  }
  return out;
}

/**
 * A VALUE read of a master switch — `x._logDepthWriteEnabled`. Deliberately
 * distinct from the TYPE occurrences (`{ _logDepthWriteEnabled?: boolean }`)
 * that the cast-heavy sibling renderers legitimately carry: those have no
 * leading dot.
 */
const RAW_SCENE_READ = /\.\s*_logDepthWriteEnabled\b/;
const RAW_PICK_READ = /\.\s*_pickLogDepthWriteEnabled\b/;

// ═══════════════════════════════════════════════════════════════════════════
// A. THE GATE — executed, not described
// ═══════════════════════════════════════════════════════════════════════════

test("GATE — isWebGPULogDepthActive is master AND useLogDepth, including the row this defect lived in", () => {
  const rows = [
    { master: false, useLogDepth: false, expected: false },
    { master: false, useLogDepth: true, expected: false },
    // ★ THE DEFECT ROW. The globe used to return TRUE here.
    { master: true, useLogDepth: false, expected: false },
    { master: true, useLogDepth: true, expected: true },
  ];
  for (const { master, useLogDepth, expected } of rows) {
    assert.equal(
      isWebGPULogDepthActive(
        { _logDepthWriteEnabled: master },
        { useLogDepth },
      ),
      expected,
      `isWebGPULogDepthActive(master=${master}, useLogDepth=${useLogDepth})`,
    );
  }
  // Non-vacuity: the two master=true rows must DIFFER, i.e. the gate genuinely
  // reads `useLogDepth`. A gate that ignored it would pass every row above if
  // the expectations were ever "corrected" to match it.
  assert.notEqual(
    isWebGPULogDepthActive(
      { _logDepthWriteEnabled: true },
      { useLogDepth: true },
    ),
    isWebGPULogDepthActive(
      { _logDepthWriteEnabled: true },
      { useLogDepth: false },
    ),
  );
});

test("GATE — isWebGPUPickLogDepthActive reads the SEPARATE pick switch and the same useLogDepth", () => {
  assert.equal(
    isWebGPUPickLogDepthActive(
      { _pickLogDepthWriteEnabled: true },
      { useLogDepth: false },
    ),
    false,
    "the pick fleet must drop to hyperbolic when useLogDepth is cleared — the " +
      "pick mini-frame owns ONE shared depth attachment (INV-2)",
  );
  assert.equal(
    isWebGPUPickLogDepthActive(
      { _pickLogDepthWriteEnabled: true },
      { useLogDepth: true },
    ),
    true,
  );
  // The two switches are independent: the scene switch must not drive the pick
  // gate, or the globe pick would follow the wrong master.
  assert.equal(
    isWebGPUPickLogDepthActive(
      { _logDepthWriteEnabled: true, _pickLogDepthWriteEnabled: false },
      { useLogDepth: true },
    ),
    false,
  );
});

test("GATE — a missing frameState or context reads as OFF, never as ON", () => {
  // The globe resolves the gate from `frameState.context`; an early frame with
  // an absent half must not silently select the log module.
  assert.equal(isWebGPULogDepthActive(undefined, { useLogDepth: true }), false);
  assert.equal(
    isWebGPULogDepthActive({ _logDepthWriteEnabled: true }, undefined),
    false,
  );
  assert.equal(isWebGPULogDepthActive(null, null), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// B. THE TWO GLOBE WRITERS
// ═══════════════════════════════════════════════════════════════════════════

test("WRITERS — the globe has exactly two _logDepthEnabled writers and they resolve IDENTICALLY", () => {
  const src = stripComments(readWebGPU(RENDERER));
  const writers = assignmentsTo(src, "_logDepthEnabled");
  assert.equal(
    writers.length,
    2,
    "expected exactly two writers — the on-screen `createTileCommands` path and " +
      "the env-capture path. A third writer, or a removed one, changes which " +
      "expression decides the frame's globe encoding.",
  );
  assert.equal(
    writers[0],
    writers[1],
    "the on-screen and env-capture writers resolve the globe's log-depth state " +
      "DIFFERENTLY. Whichever runs first this frame decides the encoding, so " +
      "the capture cube and the on-screen frame would disagree and the shared " +
      "pipeline/module set would thrash between them every frame.",
  );
  assert.match(
    writers[0],
    /^isWebGPULogDepthActive\s*\(/,
    "the globe no longer resolves the SHARED gate — it is once again the only " +
      "WebGPU depth producer deciding its encoding by a different rule than " +
      "the consumers of its depth buffer",
  );
  assert.match(
    writers[0],
    /\bframeState\b/,
    "the gate call does not pass `frameState`, so `useLogDepth` cannot reach it",
  );
});

test("WRITERS — the globe PICK state resolves the pick-fleet gate", () => {
  const src = stripComments(readWebGPU(RENDERER));
  const writers = assignmentsTo(src, "_pickLogDepthEnabled");
  assert.equal(writers.length, 1, "expected exactly one pick-state writer");
  assert.match(
    writers[0],
    /^isWebGPUPickLogDepthActive\s*\(/,
    "the globe pick must gate on the SEPARATE pick-fleet predicate — the scene " +
      "gate would put the globe on a different master than the rest of the fleet",
  );
  assert.match(writers[0], /\bframeState\b/);
});

test("WRITERS — the globe reads NEITHER master switch raw", () => {
  const src = stripComments(readWebGPU(RENDERER));
  assert.ok(
    !RAW_SCENE_READ.test(src),
    `${RENDERER} reads \`._logDepthWriteEnabled\` directly again. That is the ` +
      `defect: the master switch alone ignores \`frameState.useLogDepth\`, which ` +
      `Scene.js clears for 2D / Columbus View / any orthographic frustum.`,
  );
  assert.ok(
    !RAW_PICK_READ.test(src),
    `${RENDERER} reads \`._pickLogDepthWriteEnabled\` directly again — the shared ` +
      `pick FBO would carry mixed encodings in 2D / CV.`,
  );
});

test("MUTATION — restoring the raw master-switch read makes the WRITERS checks FAIL", () => {
  // Without this, "no raw read" and "both writers identical" could both be
  // passing because the analysis matches nothing.
  const clean = stripComments(readWebGPU(RENDERER));
  assert.ok(
    !RAW_SCENE_READ.test(clean),
    "precondition: the file must be clean",
  );

  // Re-introduce the historical expression at the FIRST writer only, which is
  // exactly the shape the defect had (and the shape a partial revert produces).
  const mutated = clean.replace(
    /this\._logDepthEnabled\s*=\s*isWebGPULogDepthActive\s*\(\s*frameState\.context\s*,\s*frameState\s*,?\s*\)\s*;/,
    "this._logDepthEnabled = (frameState.context as unknown as " +
      "{ _logDepthWriteEnabled?: boolean })._logDepthWriteEnabled ?? false;",
  );
  assert.notEqual(
    mutated,
    clean,
    "the mutation matched nothing — the writer's spelling changed, so these " +
      "tests are unfalsifiable until this mutation is re-aimed",
  );

  assert.ok(
    RAW_SCENE_READ.test(mutated),
    "the raw-read detector cannot see the reverted expression",
  );
  const writers = assignmentsTo(mutated, "_logDepthEnabled");
  assert.equal(writers.length, 2);
  assert.notEqual(
    writers[0],
    writers[1],
    "the identical-writers check cannot see a one-sided revert",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// C. FLEET — the globe was the LAST raw reader; pin that it stays that way
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The only two files allowed a VALUE read of a master switch.
 *   - `WebGPULogDepth.ts` IS the gate.
 *   - `WebGPUContext.ts` declares the switches and exposes one through an
 *     accessor.
 * Everything else must go through the gate.
 */
const RAW_READ_ALLOWED = new Set(["WebGPULogDepth.ts", "WebGPUContext.ts"]);

test("FLEET — no WebGPU renderer resolves log depth from a master switch alone", () => {
  const offenders = [];
  for (const file of readdirSync(WEBGPU_DIR)) {
    if (!/\.(ts|js)$/.test(file) || RAW_READ_ALLOWED.has(file)) {
      continue;
    }
    const src = stripComments(readWebGPU(file));
    if (RAW_SCENE_READ.test(src) || RAW_PICK_READ.test(src)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these files read a log-depth master switch as a value instead of calling " +
      "isWebGPULogDepthActive / isWebGPUPickLogDepthActive, so they ignore " +
      "`frameState.useLogDepth` and will disagree with every other producer " +
      "sharing the depth attachment in 2D / Columbus View / orthographic",
  );
});

test("FLEET — the allow-list is not covering for a gate that stopped reading the switch", () => {
  // If `WebGPULogDepth.ts` ever stopped reading the switches, the FLEET test
  // above would pass for the wrong reason (nothing reads them anywhere).
  const gate = stripComments(readWebGPU("WebGPULogDepth.ts"));
  assert.ok(
    RAW_SCENE_READ.test(gate),
    "the gate no longer reads the scene switch",
  );
  assert.ok(
    RAW_PICK_READ.test(gate),
    "the gate no longer reads the pick switch",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// D. DISTINCT KEYS — the flip must be a cache MISS, not a relabelling
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The define mask `selectPipeline` builds, twinned here. The twin is only
 * legitimate while the source still has this shape, which the next test pins.
 */
function globeColorDefines({
  hasGeodeticSurfaceNormals,
  logDepthOn,
  imageryReduced,
}) {
  return (
    (hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0) |
    (logDepthOn ? ShaderDefine.LOG_DEPTH : 0) |
    (imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0)
  );
}

test("KEYS — the twinned define mask matches the shape selectPipeline actually builds", () => {
  const src = readWebGPU(PIPELINES);
  assert.match(
    src,
    /host\s*\.\s*_logDepthEnabled\s*\?\s*ShaderDefine\s*\.\s*LOG_DEPTH\s*:\s*0/,
    "selectPipeline no longer folds `host._logDepthEnabled` into the define " +
      "mask, so the twin below no longer models it",
  );
  assert.match(
    src,
    /=\s*host\s*\.\s*_pickLogDepthEnabled\s*\?\?/,
    "selectPickPipeline no longer resolves its LOG_DEPTH state from the " +
      "pick-state mirror, so the globe pick would follow the scene switch",
  );
});

test("KEYS — the two useLogDepth states produce DISTINCT renderer-local keys", () => {
  const context = { _logDepthWriteEnabled: true };
  const perspective3D = { useLogDepth: true };
  const orthographic2D = { useLogDepth: false };

  const keyFor = (frameState) =>
    buildGlobePipelineCacheKey({
      kind: "color",
      isQuantized: true,
      hasNormals: true,
      hasWebMercatorT: true,
      isBlend: false,
      strideBytes: 32,
      useClipDistances: false,
      disableCulling: false,
      defines: globeColorDefines({
        hasGeodeticSurfaceNormals: false,
        logDepthOn: isWebGPULogDepthActive(context, frameState),
        imageryReduced: false,
      }),
    });

  const perspectiveKey = keyFor(perspective3D);
  const orthographicKey = keyFor(orthographic2D);

  assert.notEqual(
    perspectiveKey,
    orthographicKey,
    "the globe's renderer-local pipeline key is IDENTICAL in SCENE3D and in a " +
      "2D/orthographic frame, so the log→hyperbolic transition would reuse the " +
      "cached log-depth pipeline",
  );

  // The keys must differ ONLY in the defines tail, and only by the LOG_DEPTH
  // bit — a difference anywhere else would mean the twin is modelling
  // something other than this axis.
  const [perspectiveHead, perspectiveDefines] = perspectiveKey.split("|");
  const [orthographicHead, orthographicDefines] = orthographicKey.split("|");
  assert.equal(perspectiveHead, orthographicHead);
  assert.equal(
    (Number.parseInt(perspectiveDefines, 16) ^
      Number.parseInt(orthographicDefines, 16)) >>>
      0,
    ShaderDefine.LOG_DEPTH >>> 0,
    "the two keys differ by something other than exactly the LOG_DEPTH bit",
  );

  // Both must still be legal keys — a distinctness win bought by emitting an
  // unparseable key would break every diagnostic reader.
  for (const key of [perspectiveKey, orthographicKey]) {
    const fields = parseGlobePipelineCacheKey(key);
    assert.ok(fields, `key ${key} no longer parses`);
    assert.equal(fields.kind, "color");
  }
});

test("KEYS — the same distinctness holds for the env-CAPTURE variant", () => {
  // The capture writer resolves the same gate, so its key must move with it.
  const context = { _logDepthWriteEnabled: true };
  const keyFor = (frameState) =>
    buildGlobePipelineCacheKey({
      kind: "capture",
      isQuantized: false,
      hasNormals: true,
      hasWebMercatorT: false,
      isBlend: false,
      strideBytes: 28,
      captureFaceFormat: "rgba16float",
      defines:
        globeColorDefines({
          hasGeodeticSurfaceNormals: false,
          logDepthOn: isWebGPULogDepthActive(context, frameState),
          imageryReduced: false,
        }) | ShaderDefine.CAPTURE_MODE,
    });
  assert.notEqual(
    keyFor({ useLogDepth: true }),
    keyFor({ useLogDepth: false }),
    "the capture pipeline key does not move with the gate",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// E. WGSL — the OFF path is genuinely hyperbolic, run through the real
//    preprocessor rather than asserted about the source text
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tokens that exist ONLY to produce or carry log-encoded depth. If any survives
 * into the LOG_DEPTH-off expansion, the "off" globe is not writing the
 * rasterizer's hyperbolic NDC z.
 */
const LOG_ONLY_TOKENS = [
  "frag_depth",
  "csm_vertexLogDepth",
  "csm_writeLogDepth",
  "csm_updatePositionDepth",
  "g_fragLogDepth",
  "v_logDepth",
];

/** Structural anchors that must survive BOTH expansions. */
const STRUCTURAL_ANCHORS = [
  "struct FragOutput",
  "fn makeFragOutput",
  "fn fragmentMain",
  "@location(0) color",
];

const expand = (source, on) =>
  stripWgslComments(preprocess(source, on ? ShaderDefine.LOG_DEPTH : 0, 0));

test("WGSL — the LOG_DEPTH-off expansion of GlobeTerrain contains no log-depth machinery at all", () => {
  const wgsl = readFileSync(GLOBE_WGSL, "utf8");
  const off = expand(wgsl, false);
  const survivors = LOG_ONLY_TOKENS.filter((t) => off.includes(t));
  assert.deepEqual(
    survivors,
    [],
    "these log-depth tokens survive into the LOG_DEPTH-off globe shader. The " +
      "off path must be the historical hyperbolic path — no `@builtin(frag_depth)` " +
      "member, no clip-z clamp, no interpolated depthFromNearPlusOne — not a " +
      "relabelled log path.",
  );
});

test("WGSL — the LOG_DEPTH-on expansion really does carry all of it (the off result is not vacuous)", () => {
  const wgsl = readFileSync(GLOBE_WGSL, "utf8");
  const on = expand(wgsl, true);
  const missing = LOG_ONLY_TOKENS.filter((t) => !on.includes(t));
  assert.deepEqual(
    missing,
    [],
    "the LOG_DEPTH-on expansion is missing log-depth machinery, so the off " +
      "expansion proves nothing — the tokens may simply be gone from the file",
  );
});

test("WGSL — both expansions are still a complete globe shader", () => {
  const wgsl = readFileSync(GLOBE_WGSL, "utf8");
  for (const on of [false, true]) {
    const out = expand(wgsl, on);
    for (const anchor of STRUCTURAL_ANCHORS) {
      assert.ok(
        out.includes(anchor),
        `LOG_DEPTH=${on ? 1 : 0}: the expansion lost \`${anchor}\` — the ifdef ` +
          `structure is unbalanced, not merely toggled`,
      );
    }
    assert.ok(
      !/\/\/>>(ifdef|else|endif)\b/.test(out),
      `LOG_DEPTH=${on ? 1 : 0}: a directive survived preprocessing`,
    );
  }
});

test("MUTATION — unguarding the frag_depth member makes the WGSL off-path check FAIL", () => {
  const wgsl = readFileSync(GLOBE_WGSL, "utf8");
  assert.ok(
    !expand(wgsl, false).includes("frag_depth"),
    "precondition: the unmutated off expansion must be clean",
  );

  // Delete the ifdef guard around FragOutput's depth member — the single edit
  // that silently makes every globe pipeline write frag_depth.
  const mutated = wgsl.replace(
    /\/\/>>ifdef LOG_DEPTH\s*\r?\n(\s*@builtin\(frag_depth\)[^\n]*)\r?\n\s*\/\/>>endif/,
    "$1",
  );
  assert.notEqual(
    mutated,
    wgsl,
    "the mutation matched nothing — the FragOutput depth member's guard changed " +
      "spelling, so the off-path check is unfalsifiable until this is re-aimed",
  );
  assert.ok(
    expand(mutated, false).includes("frag_depth"),
    "removing the guard did NOT put frag_depth into the off expansion — the " +
      "off-path check cannot detect an unguarded depth write",
  );
});
