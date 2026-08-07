// collection-pass-routing.spec.mjs — browser-free guard for (a) which Pass bin
// the WebGPU collection feature renderers put their COLOR command in, and
// (b) whether their PICK command is emitted at all.
//
// ── WHY (a) EXISTS ──────────────────────────────────────────────────────────
//
// Batch 914 replaced numeric pass literals with real `Pass` enum members across
// the collection renderers under the stated rule "value-identical for
// comparisons, corrected values only for the dead pick binning". The rule was
// broken at exactly one shape, four times:
//
//     const <x>Pass = blendOpt === 0 ? 8 /* Pass.OPAQUE */ : 9; /* Pass.TRANSLUCENT */
//   → const <x>Pass = blendOpt === 0 ? Pass.OPAQUE       : Pass.TRANSLUCENT;
//
// Both inline comments were stale, and the replacement re-derived each branch
// from the COMMENT instead of from the VALUE. In this fork's enum 9 IS
// `Pass.OPAQUE` — so the FALSE branch, which is the DEFAULT branch
// (`BlendOption.OPAQUE_AND_TRANSLUCENT` is the default for point, billboard and
// label collections, and `PolylineCollection` exposes no `blendOption` at all,
// leaving `_blendOption` permanently undefined), moved from Pass.OPAQUE to
// Pass.TRANSLUCENT — a different execution site, with back-to-front sorting and
// the "actual near" frustum republication. It inverted both PointPrimitive
// controls in `probe-splat-globe-occlusion.mjs` (P3, the depth-DISABLED
// positive control, painted 0 px; check 7, the depth-ENABLED below-surface
// control, painted 2920 px through the globe).
//
// THE CONTRACT IS SET BY WebGL, NOT BY PREFERENCE. Upstream emits, for the
// default OPAQUE_AND_TRANSLUCENT, a PAIR of commands; this port collapses that
// into ONE blended draw. Upstream's own selector is
//
//     command.pass = opaqueCommand || !opaqueAndTranslucent
//       ? Pass.OPAQUE : Pass.TRANSLUCENT;
//
// (`PointPrimitiveCollection.js:827`, `BillboardCollection.js:1204`) — note the
// `!opaqueAndTranslucent` clause, which sends BlendOption.TRANSLUCENT to
// Pass.OPAQUE as well. So Pass.OPAQUE is the faithful single bin for every blend
// option, and it is also exactly what Batch 889 shipped and the occlusion probe
// certified. Blend-mode-dependent choices (render state, OIT attachment) key off
// the BLEND OPTION and must never be re-derived from the bin.
//
// The Batch-914 guard in `gsplat-harness.spec.mjs` did not catch the regression
// because it asserted the SHAPE `? Pass.OPAQUE : Pass.TRANSLUCENT` — the branch
// ORDER — rather than the ROUTING. A shape assertion cannot distinguish a
// correct mapping from its inverse. So this spec evaluates the REAL expression
// text out of the REAL source against the REAL enums and checks a truth table,
// then re-runs the same checker against mutants that reintroduce each historical
// form. A rule that only ever sees the right answer proves nothing.
//
// ── WHY (b) EXISTS ──────────────────────────────────────────────────────────
//
// Batch 914's pass fix was necessary but NOT sufficient: collection picking
// still returned null. The billboard pick builder looked its color entry up with
// the RAW defines while `pipelineEntries` is keyed by
// `pipelineKeyWithDepthFlag(defines, noDepthTest)` = `defines * 2 + flag`. The
// two agree only when `defines === 0 && !noDepthTest`, and the default 3D path
// always carries ShaderDefine.LOG_DEPTH — so the lookup always missed and the
// builder returned BEFORE pushing the pick command. Labels ride the same path.
//
// CRLF: this repo checks out with `core.autocrlf=true`; source text is
// normalized before any assertion.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const readNormalized = (relative) =>
  readFileSync(resolve(ROOT, relative), "utf8").replaceAll("\r\n", "\n");

const WEBGPU_RENDERER_DIR = "packages/engine/Source/Renderer/WebGPU";

// ── the real enums, parsed out of the real sources ──────────────────────────

/** Execute a `const <name> = { ... };` object literal out of a source file. */
function loadEnum(relative, declaration) {
  const source = readNormalized(relative);
  const open = source.indexOf(declaration);
  assert.notEqual(open, -1, `${relative}: "${declaration}" moved`);
  const close = source.indexOf("\n};", open);
  assert.ok(close > open, `${relative}: the object literal is unbalanced`);
  const body = source.slice(open + declaration.length - 1, close + 2);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${body}`)();
}

const PASS = loadEnum(
  "packages/engine/Source/Renderer/Pass.js",
  "const Pass = {",
);
const BLEND = loadEnum(
  "packages/engine/Source/Scene/BlendOption.js",
  "const BlendOption = {",
);

test("the enum values this spec reasons about are what the fork ships", () => {
  assert.equal(PASS.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW, 8);
  assert.equal(PASS.OPAQUE, 9);
  assert.equal(PASS.TRANSLUCENT, 10);
  assert.equal(BLEND.OPAQUE, 0);
  assert.equal(BLEND.TRANSLUCENT, 1);
  assert.equal(BLEND.OPAQUE_AND_TRANSLUCENT, 2);
});

test("upstream's own pass selector still carries the `!opaqueAndTranslucent` clause this contract is derived from", () => {
  // If upstream ever drops that clause, BlendOption.TRANSLUCENT stops resolving
  // to Pass.OPAQUE in WebGL and the single-bin collapse below must be re-read.
  for (const relative of [
    "packages/engine/Source/Scene/PointPrimitiveCollection.js",
    "packages/engine/Source/Scene/BillboardCollection.js",
  ]) {
    assert.match(
      readNormalized(relative),
      /opaqueCommand \|\| !opaqueAndTranslucent\s*\n?\s*\?\s*Pass\.OPAQUE\s*\n?\s*:\s*Pass\.TRANSLUCENT;/,
      `${relative}: the WebGL pass selector this fork's collapse mirrors has changed`,
    );
  }
});

// ── the four sites ──────────────────────────────────────────────────────────

const SITES = [
  {
    file: "WebGPUPointPrimitiveRenderer.js",
    variable: "pointPass",
    // point/billboard/polyline keep blend-option-keyed choices; label does not.
    blendKeyed: true,
    // First occurrence is the COLOR command's; the pick command's own
    // `renderState:` is far below and is not blend-option dependent.
    renderStateSelector: "renderState:",
  },
  {
    file: "WebGPUBillboardRenderer.js",
    variable: "billboardPass",
    blendKeyed: true,
    renderStateSelector: "const colorRenderState =",
  },
  {
    file: "WebGPULabelRenderer.js",
    variable: "labelPass",
    blendKeyed: false,
  },
  {
    file: "WebGPUPolylineRenderer.js",
    variable: "polylinePass",
    blendKeyed: true,
    renderStateSelector: "const polylineRS =",
  },
];

/** Strip `//` comments so a prose mention cannot satisfy a code assertion. */
const codeOnly = (source) =>
  source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .filter((line) => !line.trimStart().startsWith("*"))
    .join("\n");

/** Pull the pass-selection expression text for one site out of the source. */
function extractPassExpression(source, variable) {
  const code = codeOnly(source);
  const marker = `const ${variable} =`;
  const start = code.indexOf(marker);
  assert.notEqual(start, -1, `${variable}: declaration not found`);
  const end = code.indexOf(";", start);
  assert.ok(end > start, `${variable}: declaration is unterminated`);
  return code.slice(start + marker.length, end).trim();
}

/**
 * Compile a pass-selection expression into `(blendOption) => passValue`. `Pass`
 * and `BlendOption` are bound to the REAL enums, so a wrong member name throws
 * rather than quietly producing `undefined`. `b` is the blend option; a constant
 * expression simply ignores it, which is the point.
 */
function compileRouter(expression) {
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "Pass",
    "BlendOption",
    "b",
    `return (${expression});`,
  );
  return (blendOption) => fn(PASS, BLEND, blendOption);
}

/**
 * THE CONTRACT. Every blend option routes the single collapsed color command to
 * Pass.OPAQUE — WebGL-faithful (see the header) and byte-identical to what
 * Batch 889 shipped for the two reachable options.
 *
 * The `undefined` row is load-bearing: `PolylineCollection` never defines
 * `blendOption`, so its `_blendOption` is permanently undefined.
 */
const EXPECTED_ROUTING = [
  { blendOption: BLEND.OPAQUE, pass: PASS.OPAQUE, label: "OPAQUE" },
  {
    blendOption: BLEND.TRANSLUCENT,
    pass: PASS.OPAQUE,
    label: "TRANSLUCENT",
  },
  {
    blendOption: BLEND.OPAQUE_AND_TRANSLUCENT,
    pass: PASS.OPAQUE,
    label:
      "OPAQUE_AND_TRANSLUCENT (THE DEFAULT — the Batch-914 regression row)",
  },
  { blendOption: undefined, pass: PASS.OPAQUE, label: "undefined (polyline)" },
];

/** Score a router against the contract; returns the list of violations. */
function violationsOf(router) {
  const bad = [];
  for (const row of EXPECTED_ROUTING) {
    const actual = router(row.blendOption);
    if (actual !== row.pass) {
      bad.push(`${row.label}: expected ${row.pass}, got ${actual}`);
    }
  }
  return bad;
}

// ── the product ─────────────────────────────────────────────────────────────

for (const site of SITES) {
  test(`${site.file}: ${site.variable} routes every blend option to Pass.OPAQUE`, () => {
    const source = readNormalized(`${WEBGPU_RENDERER_DIR}/${site.file}`);
    const expression = extractPassExpression(source, site.variable);
    assert.match(
      expression,
      /Pass\.[A-Z_]+/,
      `${site.file}: ${site.variable} is no longer chosen from the Pass enum (a bare number is the exact drift class that produced this bug twice)`,
    );
    assert.deepEqual(
      violationsOf(compileRouter(expression)),
      [],
      `${site.file}: ${site.variable} routing regressed. The DEFAULT row is the one Batch 914 broke — ` +
        `re-deriving the FALSE branch from its stale "/* Pass.TRANSLUCENT */" comment moved every ` +
        `default collection out of Pass.OPAQUE.`,
    );
  });
}

test("blend-mode-dependent choices key off the BLEND OPTION, never off the pass bin", () => {
  // While the render state and the OIT attachment were keyed off the pass
  // variable, correcting the routing would have silently swapped
  // `_rsOpaque`/`_rsTranslucent` and dropped the OIT attach — a second
  // regression riding along with the fix for the first.
  for (const site of SITES) {
    if (!site.blendKeyed) {
      continue;
    }
    const code = codeOnly(
      readNormalized(`${WEBGPU_RENDERER_DIR}/${site.file}`),
    );
    assert.ok(
      code.includes("=== BlendOption.OPAQUE"),
      `${site.file}: the render-state selector no longer keys off BlendOption.OPAQUE`,
    );
    assert.ok(
      code.includes("!== BlendOption.OPAQUE"),
      `${site.file}: the OIT attachment no longer keys off BlendOption.OPAQUE — ` +
        `Batch 889 attached it for TRANSLUCENT and OPAQUE_AND_TRANSLUCENT and that set must not shrink`,
    );
    assert.match(
      readNormalized(`${WEBGPU_RENDERER_DIR}/${site.file}`),
      /import BlendOption from "\.\.\/\.\.\/Scene\/BlendOption\.js";/,
      `${site.file}: the BlendOption import is gone`,
    );
    // The bin must not reappear inside the render-state selector itself.
    // (A proximity window would false-positive on the neighbouring
    // `pass: <x>Pass,` line, so extract the selector exactly.)
    const rsStart = code.indexOf(site.renderStateSelector);
    assert.notEqual(
      rsStart,
      -1,
      `${site.file}: "${site.renderStateSelector}" moved`,
    );
    const selector = code.slice(rsStart, code.indexOf(";", rsStart));
    assert.ok(
      !selector.includes(site.variable),
      `${site.file}: the render-state selector keys off ${site.variable} again — ` +
        `it must key off the blend option so pass routing and blend state stay independent:
${selector}`,
    );
    assert.match(
      selector,
      /BlendOption.OPAQUE/,
      `${site.file}: the render-state selector no longer keys off BlendOption.OPAQUE:
${selector}`,
    );
  }
});

test("Pass slot 8 is dispatched ONLY by the 3D-Tile classification chain, so it was never a home for a collection color command", () => {
  // Batch 889's `blendOption === OPAQUE` branch used the literal 8. That branch
  // was indefensible independently of the default-row regression: slot 8 is
  // `CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW`, dispatched only from inside the
  // 3D-Tile classification chain, and by NOTHING in a scene without it.
  for (const file of [
    "WebGPUSceneRenderer.ts",
    "WebGPUSceneRendererFrustumLoop.ts",
    "WebGPUSceneRendererTranslucentPass.ts",
    "WebGPUSceneRendererGlobePass.ts",
    "WebGPUSceneRendererPickPass.ts",
  ]) {
    const code = codeOnly(readNormalized(`${WEBGPU_RENDERER_DIR}/${file}`));
    assert.ok(
      !code.includes("CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW"),
      `${file} now dispatches the IGNORE_SHOW slot — the premise that collection commands must not land there has changed and must be re-read`,
    );
  }
  assert.match(
    codeOnly(
      readNormalized(
        `${WEBGPU_RENDERER_DIR}/WebGPUSceneRenderer3DTilePasses.ts`,
      ),
    ),
    /Pass\.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW/,
    "the 3D-Tile classification chain no longer references the IGNORE_SHOW slot; this spec's framing needs re-reading",
  );
});

// ── (b) the pick command must actually be emitted ───────────────────────────

test("the billboard pick builder looks its color entry up with the SAME key the color path stores under", () => {
  const base = readNormalized(
    `${WEBGPU_RENDERER_DIR}/WebGPUCollectionRendererBase.ts`,
  );
  // The key function is `defines * 2 + flag`, so a raw-defines lookup collides
  // with the stored key only at defines === 0.
  assert.match(
    base,
    /return \(defines >>> 0\) \* 2 \+ \(noDepthTest \? 1 : 0\);/,
    "pipelineKeyWithDepthFlag changed shape — re-derive the mismatch argument below",
  );

  const code = codeOnly(
    readNormalized(`${WEBGPU_RENDERER_DIR}/WebGPUBillboardRenderer.js`),
  );
  const storeKeyed = /pipelineEntries\.set\(\s*pipelineKey\s*,/.test(code);
  assert.ok(
    storeKeyed,
    "billboard color entries are no longer stored under `pipelineKey`",
  );
  assert.ok(
    !/pipelineEntries\.get\(colorDefines\)/.test(code),
    "WebGPUBillboardRenderer: the pick builder reads `pipelineEntries.get(colorDefines)` again. " +
      "Entries are stored under `pipelineKeyWithDepthFlag(defines, noDepthTest)`; the raw defines " +
      "match only when defines === 0, and the default 3D path always carries LOG_DEPTH — so this " +
      "lookup misses every frame and the builder returns BEFORE pushing the pick command. " +
      "That is why collection picking stayed null after Batch 914 fixed the pass binning.",
  );
  assert.match(
    code,
    /pipelineEntries\.get\(\s*pipelineKeyWithDepthFlag\(/,
    "WebGPUBillboardRenderer: the pick builder's color-entry lookup no longer goes through pipelineKeyWithDepthFlag",
  );
});

test("MUTANT is caught — the raw-defines billboard pick lookup misses for every non-zero defines set", () => {
  // Executable proof of the mechanism, independent of the source text above.
  const keyOf = (defines, noDepthTest) =>
    (defines >>> 0) * 2 + (noDepthTest ? 1 : 0);
  const store = new Map();
  const LOG_DEPTH = 1 << 3;
  store.set(keyOf(LOG_DEPTH, false), "color entry");
  assert.equal(
    store.get(LOG_DEPTH),
    undefined,
    "the raw-defines lookup must miss — if it hits, the mismatch argument is wrong",
  );
  assert.equal(store.get(keyOf(LOG_DEPTH, false)), "color entry");
  // The one case where the bug hides:
  const zeroStore = new Map();
  zeroStore.set(keyOf(0, false), "color entry");
  assert.equal(
    zeroStore.get(0),
    "color entry",
    "at defines === 0 the raw lookup coincides — which is why this survived review",
  );
});

// ── mutants: the routing checker must FAIL on each historical form ──────────

const MUTANTS = [
  {
    name: "Batch 914 (the shipped regression): `b === 0 ? Pass.OPAQUE : Pass.TRANSLUCENT`",
    expression: "b === 0 ? Pass.OPAQUE : Pass.TRANSLUCENT",
    mustViolate: ["TRANSLUCENT", "OPAQUE_AND_TRANSLUCENT", "undefined"],
  },
  {
    name: "Batch 889 (the literals it replaced): `b === 0 ? 8 : 9`",
    expression: "b === 0 ? 8 : 9",
    // The reachable rows were ACCIDENTALLY correct (9 === Pass.OPAQUE); only the
    // OPAQUE row pointed at the classification slot.
    mustViolate: ["OPAQUE"],
  },
  {
    name: "everything translucent",
    expression: "Pass.TRANSLUCENT",
    mustViolate: [
      "OPAQUE",
      "TRANSLUCENT",
      "OPAQUE_AND_TRANSLUCENT",
      "undefined",
    ],
  },
  {
    name: "the first cut of this very fix (routes BlendOption.TRANSLUCENT away from WebGL's bin)",
    expression:
      "b === BlendOption.TRANSLUCENT ? Pass.TRANSLUCENT : Pass.OPAQUE",
    mustViolate: ["TRANSLUCENT"],
  },
];

for (const mutant of MUTANTS) {
  test(`MUTANT is caught — ${mutant.name}`, () => {
    const bad = violationsOf(compileRouter(mutant.expression));
    assert.notDeepEqual(
      bad,
      [],
      `the routing checker accepted a known-wrong router (${mutant.name}) — the contract is vacuous`,
    );
    for (const label of mutant.mustViolate) {
      assert.ok(
        bad.some((entry) => entry.startsWith(label)),
        `${mutant.name}: expected the "${label}" row to be flagged, got:\n${bad.join("\n")}`,
      );
    }
  });
}

test("the shipped router and the Batch-914 router actually disagree on the default row", () => {
  // The single arithmetic statement this whole batch rests on. If these two
  // agree, the regression story is wrong and the fix is a no-op.
  const shipped = compileRouter(
    extractPassExpression(
      readNormalized(`${WEBGPU_RENDERER_DIR}/WebGPUPointPrimitiveRenderer.js`),
      "pointPass",
    ),
  );
  const b914 = compileRouter("b === 0 ? Pass.OPAQUE : Pass.TRANSLUCENT");
  assert.equal(shipped(BLEND.OPAQUE_AND_TRANSLUCENT), PASS.OPAQUE);
  assert.equal(b914(BLEND.OPAQUE_AND_TRANSLUCENT), PASS.TRANSLUCENT);
});
