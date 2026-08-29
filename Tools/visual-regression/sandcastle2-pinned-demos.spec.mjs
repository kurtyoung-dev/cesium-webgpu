// sandcastle2-pinned-demos.spec.mjs — pure-Node coverage for the pinned-demo
// census (Q-133). No browser, no network, no GPU.
//
// @purpose Contract spec for the pinned-demo census: exact derived count against the real gallery, per-kind classification correctness, and the naive-scan defect the census fixes.
// @status ACTIVE
//
// WHAT THIS PINS. Two prior counts of "how many gallery demos pin a
// renderer" disagreed — 32 vs 30. Group A proves 30 is the number a
// comment-aware scan of the CURRENT gallery derives, and proves exactly which
// two demos a comment-blind scan wrongly counts (the historical "32" itself is
// not reproducible; the closest naive method lands on 29): two demos
// (`atmospheric-conditions`, `volumetric-effects`) only MENTION the pin
// pattern in an explanatory comment. Group B tests the classifier's three (four, counting the
// zero-occurrence safe case) shapes against small synthetic fixtures rather
// than real gallery files, so the classification logic itself is pinned
// independently of whatever the gallery happens to contain today.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PIN_KIND,
  classifyPin,
  derivePinnedDemos,
  formatPinnedDemosTable,
} from "./lib/sandcastle2-pinned-demos.mjs";
import { enumerateGalleryIds } from "./lib/sandcastle2-renderer-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GALLERY_DIR = resolve(
  HERE,
  "..",
  "..",
  "packages",
  "sandcastle",
  "gallery",
);

// --- Group A: the census against the real, current gallery ----------------

test("A1 the derived pinned-demo count is exactly 30, not 32", () => {
  const rows = derivePinnedDemos(GALLERY_DIR);
  assert.equal(
    rows.length,
    30,
    `expected 30 pinned demos, got ${rows.length}:\n${formatPinnedDemosTable(rows)}`,
  );
});

test("A2 every row is one of the three named kinds, and the kinds sum to the total", () => {
  const rows = derivePinnedDemos(GALLERY_DIR);
  const counts = {
    [PIN_KIND.ASYNC_LITERAL]: 0,
    [PIN_KIND.PARAM_DEFAULTED]: 0,
    [PIN_KIND.SYNC_PIN_THROWS]: 0,
    [PIN_KIND.SYNC_LITERAL_SAFE]: 0,
  };
  for (const row of rows) {
    assert.ok(
      Object.values(PIN_KIND).includes(row.kind),
      `${row.id}: unknown kind ${row.kind}`,
    );
    assert.ok(row.id.length > 0);
    counts[row.kind]++;
  }
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(sum, rows.length);
  // Pinned in this row from the real current gallery — a change here is a
  // real gallery change, not spec drift, and should be reviewed as one.
  assert.equal(counts[PIN_KIND.ASYNC_LITERAL], 26);
  assert.equal(counts[PIN_KIND.PARAM_DEFAULTED], 3);
  assert.equal(counts[PIN_KIND.SYNC_PIN_THROWS], 1);
  assert.equal(counts[PIN_KIND.SYNC_LITERAL_SAFE], 0);
});

test("A3 a comment-blind scan wrongly counts exactly the two comment-only mentions (proves the fix, not the historical number)", () => {
  // The naive scan the earlier packet's count almost certainly used: match
  // the literal pattern directly against RAW source, no comment-stripping.
  const naiveLiteralPattern = /renderer\s*:\s*(["'])(webgpu|webgl)\1/;
  const ids = enumerateGalleryIds(GALLERY_DIR);
  const naiveMatches = ids.filter((id) =>
    naiveLiteralPattern.test(
      readFileSync(join(GALLERY_DIR, id, "main.js"), "utf8"),
    ),
  );

  // This literal-only naive scan also MISSES the 3 param-defaulted demos (no
  // quoted literal at the renderer: site), so it is not simply "32 = 30 + 2":
  // it both over-counts the 2 comment-only demos and under-counts the 3
  // param-defaulted ones. 30 (real) - 3 (param-defaulted, missed) + 2
  // (comment-only, over-counted) = 29... but the two comment-only demos'
  // COMMENT TEXT itself contains a literal match, so they land in
  // naiveMatches too: 26 async-literal + 1 sync-pin-throws + 2 comment-only
  // = 29. The historical "32" is not reproduced by this exact naive scan —
  // documented here as the closest reconstructable naive method, and the
  // two comment-only ids it wrongly counts are confirmed below regardless.
  const derivedIds = new Set(derivePinnedDemos(GALLERY_DIR).map((r) => r.id));
  const wronglyIncluded = naiveMatches.filter((id) => !derivedIds.has(id));
  assert.deepEqual(
    wronglyIncluded.sort(),
    ["atmospheric-conditions", "volumetric-effects"],
    "the naive literal scan must over-count exactly these two comment-only demos",
  );

  for (const id of wronglyIncluded) {
    const source = readFileSync(join(GALLERY_DIR, id, "main.js"), "utf8");
    assert.match(
      source,
      /\/\/.*contextOptions:\s*\{\s*renderer:/,
      `${id} must document the pin pattern only in a comment`,
    );
    // And the real construction call in that same file must NOT pass renderer.
    assert.equal(
      classifyPin(source),
      null,
      `${id} does not actually construct with a pinned renderer`,
    );
  }
});

test("A4 sync-pin-throws is a real, load-bearing defect this census surfaces (webgpu-depth-of-field)", () => {
  const rows = derivePinnedDemos(GALLERY_DIR);
  const depthOfField = rows.find((r) => r.id === "webgpu-depth-of-field");
  assert.ok(depthOfField, "webgpu-depth-of-field must appear in the census");
  assert.equal(depthOfField.kind, PIN_KIND.SYNC_PIN_THROWS);
  assert.equal(depthOfField.literal, "webgpu");
});

// --- Group B: classifyPin against synthetic fixtures -----------------------

test("B1 async-literal: Viewer.createAsync with a literal renderer", () => {
  const source = `
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
});`;
  assert.deepEqual(classifyPin(source), {
    kind: PIN_KIND.ASYNC_LITERAL,
    literal: "webgpu",
  });
});

test("B2 async-literal: bare (unqualified) CesiumWidget.createAsync also counts", () => {
  const source = `
const widget = await CesiumWidget.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgl" },
});`;
  assert.deepEqual(classifyPin(source), {
    kind: PIN_KIND.ASYNC_LITERAL,
    literal: "webgl",
  });
});

test("B3 sync-pin-throws: new Cesium.Viewer with a non-webgl literal renderer", () => {
  const source = `
const viewer = new Cesium.Viewer("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
});`;
  assert.deepEqual(classifyPin(source), {
    kind: PIN_KIND.SYNC_PIN_THROWS,
    literal: "webgpu",
  });
});

test("B4 sync-literal-safe: new Cesium.Viewer with an explicit webgl literal does not throw", () => {
  const source = `
const viewer = new Cesium.Viewer("cesiumContainer", {
  contextOptions: { renderer: "webgl" },
});`;
  assert.deepEqual(classifyPin(source), {
    kind: PIN_KIND.SYNC_LITERAL_SAFE,
    literal: "webgl",
  });
});

test("B5 param-defaulted: URL-param default resolves the literal", () => {
  const source = `
const requestedRenderer =
  new URLSearchParams(window.location.search).get("renderer") || "webgpu";
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: requestedRenderer },
});`;
  assert.deepEqual(classifyPin(source), {
    kind: PIN_KIND.PARAM_DEFAULTED,
    literal: "webgpu",
  });
});

test("B6 param-defaulted: unresolved default reports null rather than guessing", () => {
  const source = `
const requestedRenderer = someOtherFunction();
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: requestedRenderer },
});`;
  assert.deepEqual(classifyPin(source), {
    kind: PIN_KIND.PARAM_DEFAULTED,
    literal: null,
  });
});

test("B7 no pin: a demo with no contextOptions.renderer at all returns null", () => {
  const source = `
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  terrain: Cesium.Terrain.fromWorldTerrain(),
});`;
  assert.equal(classifyPin(source), null);
});

test("B8 comment-only mention is not a pin (the exact atmospheric-conditions/volumetric-effects shape)", () => {
  const source = `
// To force a backend, pass
// \`contextOptions: { renderer: "webgpu" }\` here.
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  terrain: Cesium.Terrain.fromWorldTerrain(),
});`;
  assert.equal(classifyPin(source), null);
});

test("B9 MUTANT: a comment-blind classifier misclassifies B8's fixture as pinned", () => {
  // Reproduces the exact defect Q-133 fixes: match the literal pattern
  // straight against raw source. Proves the assertion in B8 can fail, i.e.
  // that comment-stripping is load-bearing for the classifier, not just for
  // the no-viewer derivation this module reuses it from.
  const source = `
// To force a backend, pass
// \`contextOptions: { renderer: "webgpu" }\` here.
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  terrain: Cesium.Terrain.fromWorldTerrain(),
});`;
  const naivePattern =
    /contextOptions\s*:\s*\{[^{}]*?\brenderer\s*:\s*(["'`])(webgpu|webgl)\1/;
  assert.equal(
    naivePattern.test(source),
    true,
    "the comment-blind pattern must still match (the bug)",
  );
  assert.equal(
    classifyPin(source),
    null,
    "the real (comment-aware) classifier must not (the fix)",
  );
});

test("B10 sync detection is scoped to the NEAREST preceding construction, not any 'new' anywhere earlier", () => {
  // Guards against a cruder implementation that just checks whether the
  // string "new " appears anywhere in the file before the renderer: site.
  const source = `
const helper = new URLSearchParams(window.location.search);
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
});`;
  assert.deepEqual(classifyPin(source), {
    kind: PIN_KIND.ASYNC_LITERAL,
    literal: "webgpu",
  });
});

// --- Group C: table formatting ---------------------------------------------

test("C1 formatPinnedDemosTable includes a totals footer that matches row count and per-kind counts", () => {
  const rows = [
    { id: "a", kind: PIN_KIND.ASYNC_LITERAL, literal: "webgpu" },
    { id: "b", kind: PIN_KIND.SYNC_PIN_THROWS, literal: "webgpu" },
  ];
  const table = formatPinnedDemosTable(rows);
  assert.match(table, /total pinned: 2/);
  assert.match(table, /async-literal=1/);
  assert.match(table, /sync-pin-throws=1/);
});
