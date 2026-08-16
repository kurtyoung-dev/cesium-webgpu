// model-primitive-topology.spec.mjs — browser-free contract for C11-90, the
// glTF primitive-mode → WebGPU topology realization on the model path.
// @purpose Contract for glTF mode to WebGPU topology+stripIndexFormat mapping: atomic pair, LINE_LOOP/FAN expansion on real assets, restart legality.
// @status ACTIVE
//
// WHY THIS EXISTS
// ---------------
// Before C11-90 the model path recognized two of glTF's seven draw modes.
// `topologyForPrimitiveType` mapped mode 0 (POINTS) to "point-list" and every
// other mode — LINES, LINE_LOOP, LINE_STRIP, TRIANGLE_STRIP, TRIANGLE_FAN — to
// "triangle-list". Those five did not render approximately wrong; they rendered
// a different mesh entirely from the same index list. The upstream
// `KHR_mesh_primitive_restart` merge (65a194d24e) landed concrete assets for
// four of the five, so the gap became reachable parity debt.
//
// The fix has to be atomic, because the topology axis is TWO fields:
// `topology` and `stripIndexFormat`. WebGPU derives a strip's implicit
// primitive-restart value from the strip index format, so a uint16
// `triangle-strip` pipeline and a uint32 one are NOT interchangeable. If those
// two fields could be written independently at the ~18 model and shadow
// descriptor sites, one site would eventually carry the topology without the
// format and two logical pipelines would collapse onto one cache entry — the
// Batch-788 globe-key defect in a new place, and one that RAISES the cache hit
// rate rather than lowering it. Hence one enforceable home.
//
// WHAT IT PINS
// ------------
//   A. The mapping table is EXHAUSTIVE over the seven glTF modes, its
//      topologies are legal WebGPU values, `isStrip` agrees with the topology
//      name, and the restart-capable set is read out of upstream's own
//      `getMeshPrimitives.js` rather than restated here — so the two cannot
//      drift apart.
//   B. LINE_LOOP closure, on the real upstream `primitive-restart-line-loop.glb`
//      index list: every restart-delimited run becomes segment pairs plus its
//      closing segment, and nothing else.
//   C. TRIANGLE_FAN expansion, on the real `primitive-restart-triangle-fan.glb`
//      index list: hub preserved, winding preserved, run count preserved.
//   D. Restart translation happens ONLY where `KHR_mesh_primitive_restart`
//      permits it. A uint8 LINES asset whose indices include 255 must come out
//      untouched — 255 is a real vertex there — while a uint8 LINE_STRIP must
//      have every 255 promoted to the uint16 sentinel 0xFFFF.
//   E. Key aliasing: the two real assets that differ ONLY in index width
//      (uint16 `primitive-restart-line-strip.glb` vs uint32
//      `PrimitiveRestartLineStrip.glb`) must produce DIFFERENT pipeline cache
//      keys and different shadow cast keys, and triangle-list keys must be
//      byte-identical (and type-identical) to the pre-C11-90 key.
//   F. Build and parse are exact inverses over the full input product.
//   G. PREPARATION, NOT DRAW: the realization is called exactly once in the
//      model renderer, from `ensurePrimitiveCache`, and from nowhere else.
//   H. ONE HOME: neither the model pipeline cache nor the shadow cast pipeline
//      spells `topology:` or `stripIndexFormat:` into a `primitive` block.
//   I. Feature preservation: TRIANGLES and POINTS behave exactly as before.
//
// Run: node --test Tools/visual-regression/model-primitive-topology.spec.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(directory, "../..");
const engineWebGPU = resolve(
  repoRoot,
  "packages/engine/Source/Renderer/WebGPU",
);
const engineScene = resolve(repoRoot, "packages/engine/Source/Scene");
const restartAssets = resolve(
  repoRoot,
  "Apps/SampleData/models/PrimitiveRestart",
);

enableEngineTsResolution();

const {
  MODEL_TOPOLOGY_TABLE,
  MODEL_TOPOLOGY_TRIANGLE_LIST,
  buildModelTopologyVariantKey,
  expandLineLoopToLineList,
  expandTriangleFanToTriangleList,
  getModelTopologyMapping,
  modelPrimitiveState,
  modelTopologyAxisToken,
  modelTopologyRealizationFrom,
  parseModelTopologyVariantKey,
  realizeModelPrimitiveTopology,
} = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUModelTopology.ts")).href
);

const PrimitiveType = (
  await import(
    pathToFileURL(
      resolve(repoRoot, "packages/engine/Source/Core/PrimitiveType.js"),
    ).href
  )
).default;

const readSource = (path) => readFileSync(path, "utf8");

// ─── Fixtures read from the real upstream KHR_mesh_primitive_restart assets ──

/**
 * Minimal GLB reader: enough to pull one primitive's mode and its index list.
 * Reading the SHIPPED asset rather than hand-typing an index array is what
 * makes the conversion contracts evidence about production data instead of
 * evidence about the spec author's mental model.
 */
function readGlbPrimitive(fileName) {
  const bytes = readFileSync(resolve(restartAssets, fileName));
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
  const bin = bytes.subarray(20 + jsonLength + 8);
  const primitive = json.meshes[0].primitives[0];
  const accessor = json.accessors[primitive.indices];
  const view = json.bufferViews[accessor.bufferView];
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const componentType = accessor.componentType;
  const indices =
    componentType === 5125
      ? new Uint32Array(accessor.count)
      : new Uint16Array(accessor.count);
  for (let i = 0; i < accessor.count; i++) {
    indices[i] =
      componentType === 5125
        ? bin.readUInt32LE(offset + i * 4)
        : componentType === 5123
          ? bin.readUInt16LE(offset + i * 2)
          : bin.readUInt8(offset + i);
  }
  return {
    mode: primitive.mode,
    indices,
    componentBytes: componentType === 5125 ? 4 : componentType === 5123 ? 2 : 1,
  };
}

const lineLoopAsset = readGlbPrimitive("primitive-restart-line-loop.glb");
const lineStripAsset16 = readGlbPrimitive("primitive-restart-line-strip.glb");
const lineStripAsset32 = readGlbPrimitive("PrimitiveRestartLineStrip.glb");
const triangleFanAsset = readGlbPrimitive("primitive-restart-triangle-fan.glb");
const triangleStripAsset = readGlbPrimitive(
  "primitive-restart-triangle-strip.glb",
);

/** Split an index list on its restart sentinel — the spec's own reference. */
function referenceRuns(indices, restart) {
  const runs = [];
  let current = [];
  for (const index of indices) {
    if (index === restart) {
      if (current.length > 0) {
        runs.push(current);
      }
      current = [];
    } else {
      current.push(index);
    }
  }
  if (current.length > 0) {
    runs.push(current);
  }
  return runs;
}

// ─── A. The mapping table ────────────────────────────────────────────────────

const ALL_MODES = [
  ["POINTS", PrimitiveType.POINTS],
  ["LINES", PrimitiveType.LINES],
  ["LINE_LOOP", PrimitiveType.LINE_LOOP],
  ["LINE_STRIP", PrimitiveType.LINE_STRIP],
  ["TRIANGLES", PrimitiveType.TRIANGLES],
  ["TRIANGLE_STRIP", PrimitiveType.TRIANGLE_STRIP],
  ["TRIANGLE_FAN", PrimitiveType.TRIANGLE_FAN],
];

const LEGAL_TOPOLOGIES = new Set([
  "point-list",
  "line-list",
  "line-strip",
  "triangle-list",
  "triangle-strip",
]);

test("A1: the table is exhaustive over the seven glTF draw modes", () => {
  assert.equal(Object.keys(MODEL_TOPOLOGY_TABLE).length, 7);
  for (const [name, mode] of ALL_MODES) {
    const mapping = MODEL_TOPOLOGY_TABLE[mode];
    assert.ok(mapping, `${name} (mode ${mode}) has no row`);
    assert.ok(
      LEGAL_TOPOLOGIES.has(mapping.topology),
      `${name} maps to an illegal WebGPU topology ${mapping.topology}`,
    );
  }
});

test("A2: the exact mode → topology mapping, stated once", () => {
  const expected = {
    POINTS: "point-list",
    LINES: "line-list",
    // No WebGPU line-loop: realized as line-list plus the closing segment.
    LINE_LOOP: "line-list",
    LINE_STRIP: "line-strip",
    TRIANGLES: "triangle-list",
    TRIANGLE_STRIP: "triangle-strip",
    // No WebGPU triangle-fan: realized as an expanded triangle-list.
    TRIANGLE_FAN: "triangle-list",
  };
  for (const [name, mode] of ALL_MODES) {
    assert.equal(
      MODEL_TOPOLOGY_TABLE[mode].topology,
      expected[name],
      `${name} maps to the wrong topology`,
    );
  }
});

test("A3: isStrip agrees with the topology name, and only strips convert format", () => {
  for (const [name, mode] of ALL_MODES) {
    const mapping = MODEL_TOPOLOGY_TABLE[mode];
    assert.equal(
      mapping.isStrip,
      mapping.topology.endsWith("-strip"),
      `${name}: isStrip disagrees with its topology`,
    );
  }
});

test("A4: conversions are declared only where WebGPU lacks the topology", () => {
  const converting = ALL_MODES.filter(
    ([, mode]) => MODEL_TOPOLOGY_TABLE[mode].conversion !== "none",
  ).map(([name]) => name);
  assert.deepEqual(converting.sort(), ["LINE_LOOP", "TRIANGLE_FAN"]);
  assert.equal(
    MODEL_TOPOLOGY_TABLE[PrimitiveType.LINE_LOOP].conversion,
    "line-loop-close",
  );
  assert.equal(
    MODEL_TOPOLOGY_TABLE[PrimitiveType.TRIANGLE_FAN].conversion,
    "triangle-fan-expand",
  );
});

test("A5: the restart-capable set is upstream's, not a restatement", () => {
  // `getMeshPrimitives.js` is the authority: it rejects a primitive group whose
  // mode is not one of these four. Reading its switch means our table cannot
  // quietly gain or lose a restart mode relative to upstream's loader.
  const source = readSource(resolve(engineScene, "getMeshPrimitives.js"));
  const guard = source.slice(
    source.indexOf("switch (primitive.mode)"),
    source.indexOf(
      "return meshPrimitives;",
      source.indexOf("switch (primitive.mode)"),
    ),
  );
  const upstream = new Set();
  for (const [name] of ALL_MODES) {
    if (guard.includes(`WebGLConstants.${name}`)) {
      upstream.add(name);
    }
  }
  assert.deepEqual(
    [...upstream].sort(),
    ["LINE_LOOP", "LINE_STRIP", "TRIANGLE_FAN", "TRIANGLE_STRIP"],
    "upstream's restart-capable switch changed shape",
  );
  const ours = ALL_MODES.filter(
    ([, mode]) => MODEL_TOPOLOGY_TABLE[mode].restartCapable,
  ).map(([name]) => name);
  assert.deepEqual([...ours].sort(), [...upstream].sort());
});

test("A6: an unknown or absent mode falls back to TRIANGLES", () => {
  assert.equal(getModelTopologyMapping(undefined).topology, "triangle-list");
  assert.equal(getModelTopologyMapping(0x9999).topology, "triangle-list");
  // POINTS === 0 — a truthiness test here would silently reroute every point
  // cloud to triangles, so pin that 0 resolves to point-list.
  assert.equal(getModelTopologyMapping(0).topology, "point-list");
});

// ─── B. LINE_LOOP closure ────────────────────────────────────────────────────

test("B1: LINE_LOOP closes every run of the shipped line-loop asset", () => {
  assert.equal(lineLoopAsset.mode, PrimitiveType.LINE_LOOP);
  const restart = 0xffff;
  const runs = referenceRuns(lineLoopAsset.indices, restart);
  assert.ok(runs.length > 1, "fixture should exercise multiple loops");

  const out = expandLineLoopToLineList(lineLoopAsset.indices, restart);
  // Each run of n >= 3 vertices becomes n segments == 2n indices.
  const expectedLength = runs.reduce((sum, run) => sum + run.length * 2, 0);
  assert.equal(out.length, expectedLength);

  let read = 0;
  for (const run of runs) {
    for (let i = 0; i < run.length - 1; i++) {
      assert.equal(out[read++], run[i]);
      assert.equal(out[read++], run[i + 1]);
    }
    // The closing segment WebGPU has no topology for.
    assert.equal(out[read++], run[run.length - 1]);
    assert.equal(out[read++], run[0]);
  }
  assert.equal(read, out.length);
});

test("B2: LINE_LOOP degenerate runs", () => {
  const restart = 0xffff;
  // Two-vertex loop is a single segment, not a doubled-back pair.
  assert.deepEqual(
    [...expandLineLoopToLineList(new Uint16Array([7, 9]), restart)],
    [7, 9],
  );
  // One-vertex and empty runs contribute nothing.
  assert.deepEqual(
    [
      ...expandLineLoopToLineList(
        new Uint16Array([5, restart, restart, 1, 2, 3]),
        restart,
      ),
    ],
    [1, 2, 2, 3, 3, 1],
  );
  assert.equal(
    expandLineLoopToLineList(new Uint16Array([]), restart).length,
    0,
  );
});

// ─── C. TRIANGLE_FAN expansion ───────────────────────────────────────────────

test("C1: TRIANGLE_FAN expands the shipped fan asset around each hub", () => {
  assert.equal(triangleFanAsset.mode, PrimitiveType.TRIANGLE_FAN);
  const restart = 0xffff;
  const runs = referenceRuns(triangleFanAsset.indices, restart);
  assert.ok(runs.length > 1, "fixture should exercise multiple fans");

  const out = expandTriangleFanToTriangleList(
    triangleFanAsset.indices,
    restart,
  );
  const expectedLength = runs.reduce(
    (sum, run) => sum + (run.length - 2) * 3,
    0,
  );
  assert.equal(out.length, expectedLength);

  let read = 0;
  for (const run of runs) {
    const hub = run[0];
    for (let i = 1; i < run.length - 1; i++) {
      // Hub first, then the two consecutive rim vertices — the fan's winding,
      // preserved so backface culling behaves as it does on WebGL.
      assert.equal(out[read++], hub);
      assert.equal(out[read++], run[i]);
      assert.equal(out[read++], run[i + 1]);
    }
  }
  assert.equal(read, out.length);
});

test("C2: TRIANGLE_FAN runs shorter than a triangle emit nothing", () => {
  const restart = 0xffff;
  assert.equal(
    expandTriangleFanToTriangleList(new Uint16Array([4, 5]), restart).length,
    0,
  );
  assert.deepEqual(
    [
      ...expandTriangleFanToTriangleList(
        new Uint16Array([4, 5, restart, 1, 2, 3, 4]),
        restart,
      ),
    ],
    [1, 2, 3, 1, 3, 4],
  );
});

// ─── D. Restart translation, only where legal ───────────────────────────────

test("D1: a uint8 LINE_STRIP gets its 0xFF restarts promoted to 0xFFFF", () => {
  // What the extractor hands us: a Uint16Array upcast from uint8, so the
  // sentinel arrived as 0x00FF.
  const upcast = new Uint16Array([0, 1, 2, 0x00ff, 3, 4, 5]);
  const realization = realizeModelPrimitiveTopology({
    primitiveType: PrimitiveType.LINE_STRIP,
    indexData: upcast,
    vertexCount: 6,
    indexSourceComponentBytes: 1,
  });
  assert.equal(realization.restartTranslated, true);
  assert.deepEqual([...realization.indexData], [0, 1, 2, 0xffff, 3, 4, 5]);
  // The cached base descriptor must not have been rewritten in place.
  assert.deepEqual([...upcast], [0, 1, 2, 0x00ff, 3, 4, 5]);
});

test("D2: a uint8 LINES asset must NOT be translated — 255 is a real vertex", () => {
  const upcast = new Uint16Array([0, 1, 0x00ff, 2]);
  const realization = realizeModelPrimitiveTopology({
    primitiveType: PrimitiveType.LINES,
    indexData: upcast,
    vertexCount: 256,
    indexSourceComponentBytes: 1,
  });
  assert.equal(realization.restartTranslated, false);
  assert.deepEqual([...realization.indexData], [0, 1, 0x00ff, 2]);
  assert.equal(
    realization.indexData,
    upcast,
    "an untranslated list must pass through by reference — no allocation",
  );
  assert.equal(realization.allocatedIndexBytes, 0);
});

test("D3: uint8 TRIANGLES and POINTS are equally untouched", () => {
  for (const mode of [PrimitiveType.TRIANGLES, PrimitiveType.POINTS]) {
    const upcast = new Uint16Array([0x00ff, 1, 2]);
    const realization = realizeModelPrimitiveTopology({
      primitiveType: mode,
      indexData: upcast,
      vertexCount: 256,
      indexSourceComponentBytes: 1,
    });
    assert.equal(realization.restartTranslated, false);
    assert.equal(realization.indexData, upcast);
  }
});

test("D4: a uint16 or uint32 source is never translated, whatever the mode", () => {
  for (const bytes of [2, 4]) {
    const data =
      bytes === 4
        ? new Uint32Array([0, 1, 0x00ff, 2])
        : new Uint16Array([0, 1, 0x00ff, 2]);
    const realization = realizeModelPrimitiveTopology({
      primitiveType: PrimitiveType.LINE_STRIP,
      indexData: data,
      vertexCount: 300,
      indexSourceComponentBytes: bytes,
    });
    assert.equal(realization.restartTranslated, false);
    assert.equal(realization.indexData, data);
  }
});

test("D5: a restart-free uint8 strip allocates nothing", () => {
  const upcast = new Uint16Array([0, 1, 2, 3]);
  const realization = realizeModelPrimitiveTopology({
    primitiveType: PrimitiveType.TRIANGLE_STRIP,
    indexData: upcast,
    vertexCount: 4,
    indexSourceComponentBytes: 1,
  });
  assert.equal(realization.restartTranslated, false);
  assert.equal(realization.indexData, upcast);
  assert.equal(realization.allocatedIndexBytes, 0);
});

// ─── E/F. Pipeline key: aliasing, and build/parse inverses ──────────────────

function realizeAsset(asset) {
  return realizeModelPrimitiveTopology({
    primitiveType: asset.mode,
    indexData: asset.indices,
    vertexCount: 512,
    indexSourceComponentBytes: asset.componentBytes,
  });
}

test("E1: the two shipped line-strip assets differ only in index width — and must not alias", () => {
  const uint16 = realizeAsset(lineStripAsset16);
  const uint32 = realizeAsset(lineStripAsset32);
  assert.equal(uint16.topology, "line-strip");
  assert.equal(uint32.topology, "line-strip");
  assert.equal(uint16.stripIndexFormat, "uint16");
  assert.equal(uint32.stripIndexFormat, "uint32");

  const base = 42;
  const key16 = buildModelTopologyVariantKey(base, uint16);
  const key32 = buildModelTopologyVariantKey(base, uint32);
  assert.notEqual(
    key16,
    key32,
    "uint16 and uint32 strips collapsing onto one key is the aliasing defect",
  );
  assert.equal(key16, "42:line-strip:uint16");
  assert.equal(key32, "42:line-strip:uint32");
});

test("E2: the same aliasing distinction reaches the shadow cast key", () => {
  // `WebGPUShadowMapRenderer.js` cannot be imported under Node's type-strip
  // mode (it pulls in a TypeScript enum), so the producer is pinned TEXTUALLY
  // and the behavior is then exercised through the same home function the
  // producer calls. Pinning the verbatim body is what stops this from being a
  // re-derivation that agrees with itself: if the producer's formula moves,
  // this assertion fails even though the arithmetic below would still pass.
  const source = readSource(
    resolve(engineWebGPU, "WebGPUShadowMapRenderer.js"),
  );
  const body = source.slice(
    source.indexOf("function getShadowCastPipelineCacheKey("),
  );
  assert.ok(
    body.includes(
      "const axis = modelTopologyAxisToken(\r\n    modelTopologyRealizationFrom(topology, stripIndexFormat),\r\n  );",
    ) ||
      body.includes(
        "const axis = modelTopologyAxisToken(\n    modelTopologyRealizationFrom(topology, stripIndexFormat),\n  );",
      ),
    "the shadow key no longer derives its topology from the shared home",
  );
  assert.ok(
    body.includes("`${layoutKey}|s${stride}|t${axis}|c${cullMode}`"),
    "the shadow key format moved",
  );

  const key = (topology, stripIndexFormat) =>
    `castLayout|s12|t${modelTopologyAxisToken(
      modelTopologyRealizationFrom(topology, stripIndexFormat),
    )}|cback`;
  assert.notEqual(
    key("triangle-strip", "uint16"),
    key("triangle-strip", "uint32"),
  );
  // And the pre-C11-90 caster key is byte-identical.
  assert.equal(
    key("triangle-list", undefined),
    "castLayout|s12|ttriangle-list|cback",
  );
});

test("E3: triangle-list keys are UNCHANGED — value and type", () => {
  const numeric = buildModelTopologyVariantKey(7, MODEL_TOPOLOGY_TRIANGLE_LIST);
  assert.equal(numeric, 7);
  assert.equal(
    typeof numeric,
    "number",
    "numeric-keyed caches must stay numeric",
  );
  const stringKey = buildModelTopologyVariantKey(
    "silhouette|3",
    MODEL_TOPOLOGY_TRIANGLE_LIST,
  );
  assert.equal(stringKey, "silhouette|3");
  // TRIANGLE_FAN realizes to triangle-list, so a fan shares triangle keys —
  // which is correct: after expansion it IS a triangle list.
  const fan = realizeAsset(triangleFanAsset);
  assert.equal(fan.topology, "triangle-list");
  assert.equal(buildModelTopologyVariantKey(7, fan), 7);
});

test("F1: build and parse are exact inverses over the whole input product", () => {
  const realizations = [
    MODEL_TOPOLOGY_TRIANGLE_LIST,
    modelTopologyRealizationFrom("point-list", undefined),
    modelTopologyRealizationFrom("line-list", undefined),
    modelTopologyRealizationFrom("line-strip", "uint16"),
    modelTopologyRealizationFrom("line-strip", "uint32"),
    modelTopologyRealizationFrom("triangle-strip", "uint16"),
    modelTopologyRealizationFrom("triangle-strip", "uint32"),
  ];
  const bases = [0, 7, 4095, "12", "silhouette|3"];
  const seen = new Set();
  for (const base of bases) {
    for (const realization of realizations) {
      const key = buildModelTopologyVariantKey(base, realization);
      seen.add(`${key}`);
      const fields = parseModelTopologyVariantKey(key);
      assert.ok(fields, `unparseable key ${key}`);
      assert.equal(fields.baseKey, `${base}`);
      assert.equal(fields.topology, realization.topology);
      assert.equal(fields.stripIndexFormat, realization.stripIndexFormat);
      assert.equal(fields.trailing, "");
    }
  }
  // No two (base, realization) pairs may share a key.
  assert.equal(seen.size, bases.length * realizations.length);
});

test("F2: parse tolerates a wrapper suffix appended after the topology segment", () => {
  // The pipeline cache appends `:m34` for the widened metadata transport AFTER
  // the topology segment. Parsing must not mistake it for part of the axis.
  const key = `${buildModelTopologyVariantKey(9, modelTopologyRealizationFrom("triangle-strip", "uint32"))}:m34`;
  const fields = parseModelTopologyVariantKey(key);
  assert.deepEqual(fields, {
    baseKey: "9",
    topology: "triangle-strip",
    stripIndexFormat: "uint32",
    trailing: "m34",
  });
});

test("F3: structurally impossible keys parse to null, never to a guess", () => {
  // A strip with no format, and a format with no strip: both are shapes the
  // builder cannot produce. Reporting null is what makes a format change
  // visible instead of silently reinterpreted.
  assert.equal(parseModelTopologyVariantKey("7:triangle-strip"), null);
  assert.equal(parseModelTopologyVariantKey("7:uint16"), null);
  assert.equal(parseModelTopologyVariantKey("7:point-list:uint16"), null);
  assert.equal(parseModelTopologyVariantKey("7:line-list:line-strip"), null);
});

test("F4: a strip realization with no index format refuses to build", () => {
  // An invalid strip pipeline is worse than a fallback: it would either fail
  // validation or, with a defaulted format, alias every other strip. The home
  // collapses it to triangle-list instead.
  assert.equal(
    modelTopologyRealizationFrom("triangle-strip", undefined),
    MODEL_TOPOLOGY_TRIANGLE_LIST,
  );
  assert.equal(
    modelTopologyRealizationFrom("line-strip", "uint8"),
    MODEL_TOPOLOGY_TRIANGLE_LIST,
  );
  assert.equal(
    modelTopologyRealizationFrom("triangle-fan", undefined),
    MODEL_TOPOLOGY_TRIANGLE_LIST,
  );
});

test("F5: the primitive state emits both fields together or neither", () => {
  assert.deepEqual(modelPrimitiveState(MODEL_TOPOLOGY_TRIANGLE_LIST, "back"), {
    topology: "triangle-list",
    cullMode: "back",
  });
  assert.deepEqual(
    modelPrimitiveState(
      modelTopologyRealizationFrom("line-list", undefined),
      "none",
    ),
    { topology: "line-list", cullMode: "none" },
  );
  assert.deepEqual(
    modelPrimitiveState(
      modelTopologyRealizationFrom("triangle-strip", "uint32"),
      "back",
    ),
    {
      topology: "triangle-strip",
      cullMode: "back",
      stripIndexFormat: "uint32",
    },
  );
  // A non-strip must never declare a strip index format — WebGPU rejects it.
  for (const topology of ["point-list", "line-list", "triangle-list"]) {
    const state = modelPrimitiveState(
      modelTopologyRealizationFrom(topology, undefined),
      "back",
    );
    assert.ok(
      !("stripIndexFormat" in state),
      `${topology} declared a strip format`,
    );
  }
});

// ─── G. Preparation, not draw ────────────────────────────────────────────────

test("G1: the realization runs exactly once in the renderer, inside ensurePrimitiveCache", () => {
  const path = resolve(engineWebGPU, "WebGPUModelRenderer.ts");
  const source = readSource(path);
  assert.match(
    source,
    /import \{ realizeModelPrimitiveTopology \} from "\.\/WebGPUModelTopology\.js";/,
  );
  const calls = [...source.matchAll(/realizeModelPrimitiveTopology\(/g)];
  assert.equal(calls.length, 1, "expected exactly one call site");

  const callIndex = source.indexOf("realizeModelPrimitiveTopology({");
  assert.ok(callIndex > 0, "the call site should be a direct invocation");

  // The nearest preceding top-level `function` declaration must be the
  // per-primitive preparation builder. If the call ever migrates into a
  // per-frame command builder, this fails.
  const before = source.slice(0, callIndex);
  const declarations = [...before.matchAll(/\nfunction (\w+)/g)];
  const enclosing = declarations[declarations.length - 1][1];
  assert.equal(
    enclosing,
    "ensurePrimitiveCache",
    `realization moved out of preparation into ${enclosing}`,
  );
});

test("G2: no draw-time conversion — the renderer reads the realized list, never rebuilds it", () => {
  const source = readSource(resolve(engineWebGPU, "WebGPUModelRenderer.ts"));
  // The conversion helpers are preparation-only and must not be reachable from
  // this file at all; the renderer consumes `topologyRealization.indexData`.
  assert.ok(!source.includes("expandLineLoopToLineList"));
  assert.ok(!source.includes("expandTriangleFanToTriangleList"));
  // The obsolete per-mode switch must be gone, not merely bypassed.
  assert.ok(
    !source.includes("topologyForPrimitiveType"),
    "the pre-C11-90 two-mode mapping is still present",
  );
});

// ─── H. One enforceable home ─────────────────────────────────────────────────

test("H1: the model pipeline cache never spells the topology axis inline", () => {
  const source = readSource(
    resolve(engineWebGPU, "WebGPUModelPipelineCache.ts"),
  );
  const primitiveBlocks = [...source.matchAll(/^ *primitive: (.*)$/gm)].map(
    (match) => match[1].trim(),
  );
  assert.ok(primitiveBlocks.length >= 12, "expected every pipeline descriptor");
  for (const block of primitiveBlocks) {
    assert.ok(
      // Either built by the home, or forwarded verbatim from a descriptor the
      // home already built (the central-cache and OIT descriptor adapters).
      block.startsWith("modelPrimitiveState(") ||
        block.startsWith("raw.primitive"),
      `a descriptor builds its primitive state inline: ${block}`,
    );
  }
  assert.ok(
    primitiveBlocks.filter((block) => block.startsWith("modelPrimitiveState("))
      .length >= 12,
    "every pipeline builder must route through the home",
  );
  // And no `stripIndexFormat:` object key anywhere — the home owns it.
  assert.ok(!/^\s*stripIndexFormat:/m.test(source));
});

test("H2: the shadow cast pipeline uses the same builder and the same key axis", () => {
  const source = readSource(
    resolve(engineWebGPU, "WebGPUShadowMapRenderer.js"),
  );
  const primitiveBlocks = [...source.matchAll(/^ *primitive: (.*)$/gm)].map(
    (match) => match[1].trim(),
  );
  assert.equal(primitiveBlocks.length, 1);
  assert.ok(primitiveBlocks[0].startsWith("modelPrimitiveState("));
  assert.match(source, /getShadowCastStripIndexFormat/);
  // The CSM cast pass shares the pipeline factory, so it must forward the
  // format too — otherwise CSM strips would alias where the single shadow map
  // does not.
  const csm = readSource(resolve(engineWebGPU, "WebGPUCSMCastPass.ts"));
  assert.match(csm, /getShadowCastStripIndexFormat\(cmd\)/);
});

test("H3: the model renderer carries both halves of the axis on every consumer", () => {
  const source = readSource(resolve(engineWebGPU, "WebGPUModelRenderer.ts"));
  // Shadow caster, env-capture record, and the sticky pipeline-cache state.
  assert.match(
    source,
    /_shadowCastStripIndexFormat = primCache\.stripIndexFormat/,
  );
  assert.match(source, /stripIndexFormat: primCache\.stripIndexFormat/);
  assert.match(
    source,
    /setPrimitiveTopology\(\s*primCache\?\.topology \?\? "triangle-list",\s*primCache\?\.stripIndexFormat,\s*\)/,
  );
  assert.match(
    source,
    /setPrimitiveTopology\(\s*rec\.topology \?\? "triangle-list",\s*rec\.stripIndexFormat,\s*\)/,
  );
});

test("H4: the extractor records the source index width without importing the backend", () => {
  const source = readSource(
    resolve(
      repoRoot,
      "packages/engine/Source/Scene/Model/ModelPrimitiveGeometry.js",
    ),
  );
  assert.match(source, /indexSourceComponentBytes/);
  // Scene code stays backend-agnostic: the restart DECISION lives in the
  // WebGPU home, so this file must not reach into Renderer/WebGPU.
  assert.ok(
    !source.includes("Renderer/WebGPU"),
    "scene-layer extractor must not import the WebGPU renderer",
  );
});

// ─── I. Feature preservation + the realization end to end ───────────────────

test("I1: TRIANGLES with indices is a pure passthrough", () => {
  const indices = new Uint16Array([0, 1, 2, 2, 3, 0]);
  const realization = realizeModelPrimitiveTopology({
    primitiveType: PrimitiveType.TRIANGLES,
    indexData: indices,
    vertexCount: 4,
    indexSourceComponentBytes: 2,
  });
  assert.equal(realization.topology, "triangle-list");
  assert.equal(realization.stripIndexFormat, undefined);
  assert.equal(realization.indexData, indices);
  assert.equal(realization.indexCount, 6);
  assert.equal(realization.indexFormat, "uint16");
  assert.equal(realization.allocatedIndexBytes, 0);
  assert.equal(realization.synthesizedIndices, false);
});

test("I2: non-indexed TRIANGLES keeps the historical draw() path", () => {
  const realization = realizeModelPrimitiveTopology({
    primitiveType: PrimitiveType.TRIANGLES,
    indexData: null,
    vertexCount: 300,
  });
  assert.equal(realization, MODEL_TOPOLOGY_TRIANGLE_LIST);
  assert.equal(realization.indexData, null);
  assert.equal(realization.indexCount, 0);
  assert.equal(realization.allocatedIndexBytes, 0);
});

test("I3: non-indexed POINTS still synthesizes sequential indices, same bound", () => {
  for (const [count, expected] of [
    [10, "uint16"],
    [65535, "uint16"],
    [65536, "uint32"],
  ]) {
    const realization = realizeModelPrimitiveTopology({
      primitiveType: PrimitiveType.POINTS,
      indexData: null,
      vertexCount: count,
    });
    assert.equal(realization.topology, "point-list");
    assert.equal(realization.synthesizedIndices, true);
    assert.equal(realization.indexCount, count);
    assert.equal(realization.indexFormat, expected);
    assert.equal(realization.indexData[0], 0);
    assert.equal(realization.indexData[count - 1], count - 1);
    // Synthesized indices must never collide with the restart sentinel OF
    // THEIR OWN FORMAT — otherwise the same synthesis would silently cut a
    // strip in half. `65536` is safe precisely because it widens to uint32,
    // whose sentinel is 0xFFFFFFFF.
    const sentinel = expected === "uint16" ? 0xffff : 0xffffffff;
    assert.notEqual(realization.indexData[count - 1], sentinel);
  }
});

test("I4: every non-TRIANGLES mode gets safe indices when the asset has none", () => {
  for (const [name, mode] of ALL_MODES) {
    if (mode === PrimitiveType.TRIANGLES) {
      continue;
    }
    const realization = realizeModelPrimitiveTopology({
      primitiveType: mode,
      indexData: null,
      vertexCount: 12,
    });
    assert.ok(
      realization.indexCount > 0,
      `${name} left a non-indexed primitive with no indices`,
    );
    assert.equal(realization.synthesizedIndices, true);
  }
});

test("I5: the shipped strip assets realize to native strips with the right format", () => {
  const uint16 = realizeAsset(lineStripAsset16);
  assert.equal(uint16.conversion, "none");
  assert.equal(
    uint16.indexData,
    lineStripAsset16.indices,
    "no conversion, no copy",
  );
  assert.equal(uint16.allocatedIndexBytes, 0);

  const strip = realizeAsset(triangleStripAsset);
  assert.equal(strip.topology, "triangle-strip");
  assert.equal(strip.stripIndexFormat, "uint16");
  assert.equal(strip.indexData, triangleStripAsset.indices);
});

test("I6: the shipped loop/fan assets pay exactly one preparation allocation", () => {
  const loop = realizeAsset(lineLoopAsset);
  assert.equal(loop.topology, "line-list");
  assert.equal(loop.stripIndexFormat, undefined);
  assert.notEqual(loop.indexData, lineLoopAsset.indices);
  assert.equal(loop.allocatedIndexBytes, loop.indexData.byteLength);
  assert.equal(loop.indexCount, loop.indexData.length);

  const fan = realizeAsset(triangleFanAsset);
  assert.equal(fan.topology, "triangle-list");
  assert.equal(fan.allocatedIndexBytes, fan.indexData.byteLength);
  assert.equal(fan.indexCount, fan.indexData.length);
});

test("I7: a leading restart produces no empty leading primitive", () => {
  // `PrimitiveRestartLineStrip.glb` opens with a restart value — a shape a
  // naive splitter turns into a zero-length run.
  assert.equal(lineStripAsset32.indices[0], 0xffffffff);
  const loop = expandLineLoopToLineList(lineStripAsset32.indices, 0xffffffff);
  const runs = referenceRuns(lineStripAsset32.indices, 0xffffffff);
  assert.equal(
    loop.length,
    runs.reduce((sum, run) => sum + run.length * 2, 0),
  );
  assert.equal(loop[0], runs[0][0]);
});

test("I8: the embedded upstream KHR asset realizes as a uint16 line-strip", () => {
  // Specs/Data/.../MeshPrimitiveRestartKHR.gltf — indices [0,1,2,R,3,4,R,5,6].
  const gltf = JSON.parse(
    readSource(
      resolve(
        repoRoot,
        "Specs/Data/Models/glTF-2.0/MeshPrimitiveRestartKHR/glTF-Embedded/MeshPrimitiveRestartKHR.gltf",
      ),
    ),
  );
  const primitive = gltf.meshes[0].primitives[0];
  assert.equal(primitive.mode, PrimitiveType.LINE_STRIP);
  const accessor = gltf.accessors[primitive.indices];
  assert.equal(accessor.componentType, 5123, "uint16 indices");
  const view = gltf.bufferViews[accessor.bufferView];
  const buffer = Buffer.from(gltf.buffers[0].uri.split(",")[1], "base64");
  const indices = new Uint16Array(accessor.count);
  for (let i = 0; i < accessor.count; i++) {
    indices[i] = buffer.readUInt16LE((view.byteOffset ?? 0) + i * 2);
  }
  assert.deepEqual([...indices], [0, 1, 2, 0xffff, 3, 4, 0xffff, 5, 6]);

  const realization = realizeModelPrimitiveTopology({
    primitiveType: primitive.mode,
    indexData: indices,
    vertexCount: 7,
    indexSourceComponentBytes: 2,
  });
  assert.equal(realization.topology, "line-strip");
  assert.equal(realization.stripIndexFormat, "uint16");
  // WebGPU honours the uint16 restart natively for strips — no rewriting.
  assert.equal(realization.indexData, indices);
  assert.equal(realization.allocatedIndexBytes, 0);
});
