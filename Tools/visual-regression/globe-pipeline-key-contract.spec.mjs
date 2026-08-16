// globe-pipeline-key-contract.spec.mjs — browser-free contract for the globe
// pipeline cache key: the format itself, the four repaired accessors that read
// it, and the central cache's own reporting surfaces.
// @purpose Pins the single-home globe pipeline cache-key builder/parser after the 15-month UNO_/UNMO_ producer-consumer drift; accessors + cache stats.
// @status ACTIVE
//
// WHY THIS EXISTS
// ---------------
// `WebGPUGlobeSurfaceRenderer` exposed four public accessors — `pipeline`,
// `pipelineNoNormals`, `pipelineQuantized`, `pipelineQuantizedNoNormals` —
// that looked a cached pipeline up by a hardcoded key string:
//
//     this._pipelineCache.get("UNO_28|0")?.pipeline ?? null
//
// Commit 831e2f189b (2026-04-04, "WebMercatorT shader support") inserted a
// FOURTH letter into the key — the `M`/`G` webMercatorT marker — changing every
// stored key from `UNO_28` to `UNMO_28` / `UNGO_28`. The producer moved; the
// four consumers did not. From that commit to 2026-08-01 no key of the old
// shape could ever be stored again, so all four accessors returned `null`
// unconditionally for ~15 months. Nothing caught it: they had zero callers, and
// no cache counter can report "a reader is asking for a key that cannot exist".
//
// The maintainer ruled to FIX rather than delete. The fix is structural, not a
// literal update: the key format now has ONE home
// (`WebGPUGlobeSurfacePipelineKey.ts`) that both builds and parses it, every
// producer calls the builder, and the four accessors resolve through a semantic
// predicate instead of a string. This spec is the enforcement.
//
// WHAT IT PINS
// ------------
//   A. The builder is BYTE-IDENTICAL to the eight template literals it
//      replaced. A silent key change would orphan every cached pipeline and
//      re-compile the whole globe on the frame it shipped, so this is checked
//      against verbatim copies of the pre-fix originals over a cartesian
//      product of every input axis — not against a paraphrase.
//   B. Builder and parser are exact inverses. This is what makes the two sides
//      unable to drift: a new marker added to one alone fails here.
//   C. The four stale key strings are UNPRODUCIBLE by the builder for any
//      input, and parse to `null` — the defect, pinned as a fact rather than a
//      story, so nobody "restores" the old literals.
//   D. The format has exactly one home: no engine module builds a globe
//      pipeline key inline any more.
//   E. The four repaired accessors return TRUTH on a synthetic cache seeded
//      with aliasing-adjacent keys (same `descriptor.name`, different variant
//      markers), with their criteria read out of the live renderer source
//      rather than restated here.
//   F. The listing API is honest: one row per stored entry, unparseable keys
//      surfaced as `fields: null` instead of dropped, unmaterialized entries
//      visible.
//   G. The central cache's `getStats()` arithmetic (what `CesiumDebug
//      .cacheStats()` renders) is self-consistent with its own contents, AND
//      the aliasing blind spot is pinned: identical `descriptor.name` +
//      identical key-relevant fields collapse two logical pipelines onto one
//      entry, which RAISES the hit rate. No counter in `getStats()` can reveal
//      it; `listPipelineVariants()` + `describeCacheKey()` can.
//
// Run: node --test Tools/visual-regression/globe-pipeline-key-contract.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const engineWebGPU = resolve(
  directory,
  "../../packages/engine/Source/Renderer/WebGPU",
);

enableEngineTsResolution();

const {
  buildGlobePipelineCacheKey,
  parseGlobePipelineCacheKey,
  listGlobePipelineVariants,
  findGlobePipelineVariant,
} = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUGlobeSurfacePipelineKey.ts")).href
);

const { WebGPURenderPipelineCache } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPURenderPipelineCache.ts")).href
);

// ═══════════════════════════════════════════════════════════════════════
// The pre-fix template literals, copied VERBATIM from HEAD~ (the eight
// producer sites). These are the oracle for section A. They are duplicated
// here on purpose: an oracle that imports the implementation proves nothing.
// ═══════════════════════════════════════════════════════════════════════

const legacy = {
  // WebGPUGlobeSurfacePipelines.ts selectPipeline
  color: (
    isQuantized,
    hasNormals,
    hasWebMercatorT,
    isBlend,
    strideBytes,
    useClipDistances,
    disableCulling,
    defines,
  ) => {
    const cdSuffix = useClipDistances ? "_CD" : "";
    const ncSuffix = disableCulling ? "_NC" : "";
    return `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}${isBlend ? "B" : "O"}_${strideBytes}${cdSuffix}${ncSuffix}|${defines.toString(16)}`;
  },
  // selectCapturePipeline
  capture: (
    isQuantized,
    hasNormals,
    hasWebMercatorT,
    strideBytes,
    captureFaceFormat,
    defines,
  ) =>
    `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}O_${strideBytes}_CAP_${captureFaceFormat}|${defines.toString(16)}`,
  // selectPickPipeline
  pick: (
    isQuantized,
    hasNormals,
    hasWebMercatorT,
    strideBytes,
    useClipDistances,
    defines,
  ) => {
    const cdSuffix = useClipDistances ? "_CD" : "";
    return `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}O_${strideBytes}${cdSuffix}_PICK|${defines.toString(16)}`;
  },
  // selectTranslucentBackFacePipeline
  tbf: (
    isQuantized,
    hasNormals,
    hasWebMercatorT,
    strideBytes,
    useClipDistances,
    defines,
  ) => {
    const cdSuffix = useClipDistances ? "_CD" : "";
    return `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}B_${strideBytes}${cdSuffix}_TBF|${defines.toString(16)}`;
  },
  // selectDepthOnlyBackFacePipeline
  dob: (
    isQuantized,
    hasNormals,
    hasWebMercatorT,
    strideBytes,
    useClipDistances,
    defines,
  ) => {
    const cdSuffix = useClipDistances ? "_CD" : "";
    return `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}O_${strideBytes}${cdSuffix}_DOB|${defines.toString(16)}`;
  },
  // selectDepthOnlyFrontFacePipeline
  dof: (
    isQuantized,
    hasNormals,
    hasWebMercatorT,
    strideBytes,
    useClipDistances,
    defines,
  ) => {
    const cdSuffix = useClipDistances ? "_CD" : "";
    return `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}O_${strideBytes}${cdSuffix}_DOF|${defines.toString(16)}`;
  },
  // selectDebugFragmentPipeline
  debug: (
    mode,
    isQuantized,
    hasNormals,
    hasWebMercatorT,
    isBlend,
    strideBytes,
    defines,
  ) =>
    `${mode}_${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}${isBlend ? "B" : "O"}_${strideBytes}|${defines.toString(16)}`,
  // WebGPUGlobeSurfaceWireframe.ts selectWireframePipeline
  wireframe: (isQuantized, hasNormals, hasWebMercatorT, strideBytes, defines) =>
    `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}_${strideBytes}|${defines.toString(16)}`,
};

const BOOLS = [false, true];
// Real strides observed across the encodings: quantized-minimal (12) through
// uncompressed + webMercatorT + normals + DP-H25 geodetic normals (40).
const STRIDES = [12, 16, 20, 24, 28, 32, 36, 40];
// 0 = baseline; 0x1/0x9/0x41 = representative ShaderDefine combinations;
// 0x7fffffff = the whole 31-bit registry lit.
const DEFINES = [0, 0x1, 0x9, 0x41, 0x7fffffff];
const FACE_FORMATS = ["rgba8unorm", "rgba16float"];
const DEBUG_MODES = [1, 2, 3];

test("A. builder reproduces all eight legacy key templates byte-for-byte", () => {
  let checked = 0;
  for (const isQuantized of BOOLS) {
    for (const hasNormals of BOOLS) {
      for (const hasWebMercatorT of BOOLS) {
        for (const strideBytes of STRIDES) {
          for (const defines of DEFINES) {
            const base = {
              isQuantized,
              hasNormals,
              hasWebMercatorT,
              strideBytes,
              defines,
            };

            for (const isBlend of BOOLS) {
              for (const useClipDistances of BOOLS) {
                for (const disableCulling of BOOLS) {
                  assert.equal(
                    buildGlobePipelineCacheKey({
                      kind: "color",
                      ...base,
                      isBlend,
                      useClipDistances,
                      disableCulling,
                    }),
                    legacy.color(
                      isQuantized,
                      hasNormals,
                      hasWebMercatorT,
                      isBlend,
                      strideBytes,
                      useClipDistances,
                      disableCulling,
                      defines,
                    ),
                    "color key drifted",
                  );
                  checked++;
                }
              }
            }

            for (const useClipDistances of BOOLS) {
              assert.equal(
                buildGlobePipelineCacheKey({
                  kind: "pick",
                  ...base,
                  isBlend: false,
                  useClipDistances,
                }),
                legacy.pick(
                  isQuantized,
                  hasNormals,
                  hasWebMercatorT,
                  strideBytes,
                  useClipDistances,
                  defines,
                ),
                "pick key drifted",
              );
              assert.equal(
                buildGlobePipelineCacheKey({
                  kind: "translucentBackFace",
                  ...base,
                  isBlend: true,
                  useClipDistances,
                }),
                legacy.tbf(
                  isQuantized,
                  hasNormals,
                  hasWebMercatorT,
                  strideBytes,
                  useClipDistances,
                  defines,
                ),
                "translucent back-face key drifted",
              );
              assert.equal(
                buildGlobePipelineCacheKey({
                  kind: "depthOnlyBackFace",
                  ...base,
                  isBlend: false,
                  useClipDistances,
                }),
                legacy.dob(
                  isQuantized,
                  hasNormals,
                  hasWebMercatorT,
                  strideBytes,
                  useClipDistances,
                  defines,
                ),
                "depth-only back-face key drifted",
              );
              assert.equal(
                buildGlobePipelineCacheKey({
                  kind: "depthOnlyFrontFace",
                  ...base,
                  isBlend: false,
                  useClipDistances,
                }),
                legacy.dof(
                  isQuantized,
                  hasNormals,
                  hasWebMercatorT,
                  strideBytes,
                  useClipDistances,
                  defines,
                ),
                "depth-only front-face key drifted",
              );
              checked += 4;
            }

            for (const captureFaceFormat of FACE_FORMATS) {
              assert.equal(
                buildGlobePipelineCacheKey({
                  kind: "capture",
                  ...base,
                  isBlend: false,
                  captureFaceFormat,
                }),
                legacy.capture(
                  isQuantized,
                  hasNormals,
                  hasWebMercatorT,
                  strideBytes,
                  captureFaceFormat,
                  defines,
                ),
                "capture key drifted",
              );
              checked++;
            }

            for (const debugFragmentMode of DEBUG_MODES) {
              for (const isBlend of BOOLS) {
                assert.equal(
                  buildGlobePipelineCacheKey({
                    kind: "debugFragment",
                    ...base,
                    isBlend,
                    debugFragmentMode,
                  }),
                  legacy.debug(
                    debugFragmentMode,
                    isQuantized,
                    hasNormals,
                    hasWebMercatorT,
                    isBlend,
                    strideBytes,
                    defines,
                  ),
                  "debug-fragment key drifted",
                );
                checked++;
              }
            }

            assert.equal(
              buildGlobePipelineCacheKey({ kind: "wireframe", ...base }),
              legacy.wireframe(
                isQuantized,
                hasNormals,
                hasWebMercatorT,
                strideBytes,
                defines,
              ),
              "wireframe key drifted",
            );
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 3000, `expected a broad sweep, only checked ${checked}`);
});

test("A2. `_NC` is emitted for the color kind only", () => {
  // The pick / translucent / depth-only selectors pin cullMode themselves and
  // never emitted a no-cull marker. If the builder started honouring
  // `disableCulling` for them it would mint keys no producer had ever stored.
  for (const kind of [
    "pick",
    "translucentBackFace",
    "depthOnlyBackFace",
    "depthOnlyFrontFace",
  ]) {
    const withFlag = buildGlobePipelineCacheKey({
      kind,
      isQuantized: false,
      hasNormals: true,
      hasWebMercatorT: true,
      isBlend: kind === "translucentBackFace",
      strideBytes: 28,
      disableCulling: true,
      defines: 0,
    });
    assert.ok(!withFlag.includes("_NC"), `${kind} must not emit _NC`);
  }
  assert.ok(
    buildGlobePipelineCacheKey({
      kind: "color",
      isQuantized: false,
      hasNormals: true,
      hasWebMercatorT: true,
      isBlend: false,
      strideBytes: 28,
      disableCulling: true,
      defines: 0,
    }).includes("_NC"),
    "color must emit _NC",
  );
});

test("B. parser is the exact inverse of the builder", () => {
  const kinds = [
    "color",
    "pick",
    "translucentBackFace",
    "depthOnlyBackFace",
    "depthOnlyFrontFace",
    "capture",
    "debugFragment",
    "wireframe",
  ];
  let checked = 0;
  for (const kind of kinds) {
    for (const isQuantized of BOOLS) {
      for (const hasNormals of BOOLS) {
        for (const hasWebMercatorT of BOOLS) {
          for (const strideBytes of STRIDES) {
            for (const defines of DEFINES) {
              for (const isBlend of BOOLS) {
                for (const useClipDistances of BOOLS) {
                  for (const disableCulling of BOOLS) {
                    const spec = {
                      kind,
                      isQuantized,
                      hasNormals,
                      hasWebMercatorT,
                      isBlend,
                      strideBytes,
                      useClipDistances,
                      disableCulling,
                      defines,
                    };
                    if (kind === "capture") {
                      spec.captureFaceFormat = "rgba16float";
                    }
                    if (kind === "debugFragment") {
                      spec.debugFragmentMode = 2;
                    }

                    const key = buildGlobePipelineCacheKey(spec);
                    const fields = parseGlobePipelineCacheKey(key);
                    assert.ok(fields, `parse returned null for ${key}`);

                    assert.equal(fields.kind, kind, `kind for ${key}`);
                    assert.equal(fields.isQuantized, isQuantized, key);
                    assert.equal(fields.hasNormals, hasNormals, key);
                    assert.equal(fields.hasWebMercatorT, hasWebMercatorT, key);
                    assert.equal(fields.strideBytes, strideBytes, key);
                    assert.equal(fields.defines, defines, key);
                    if (kind === "capture") {
                      assert.equal(
                        fields.captureFaceFormat,
                        "rgba16float",
                        key,
                      );
                    }
                    if (kind === "debugFragment") {
                      assert.equal(fields.debugFragmentMode, 2, key);
                    }

                    // Rebuilding from the parsed fields must land on the same
                    // string — the property that stops the two sides drifting.
                    assert.equal(
                      buildGlobePipelineCacheKey(fields),
                      key,
                      `round trip failed for ${key}`,
                    );
                    checked++;
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 5000, `expected a broad sweep, only checked ${checked}`);
});

test("B2. a bit-31 define round-trips including its sign", () => {
  // The registry occupies bits 0-30 today, so this cannot occur yet. It is
  // pinned because `Number.toString(16)` renders a negative int32 with a
  // leading '-', and a parser that rejected that sign would start returning
  // `fields: null` for real keys the day bit 31 is claimed.
  const defines = -2147483648;
  const key = buildGlobePipelineCacheKey({
    kind: "color",
    isQuantized: false,
    hasNormals: true,
    hasWebMercatorT: true,
    isBlend: false,
    strideBytes: 28,
    defines,
  });
  assert.equal(key, "UNMO_28|-80000000");
  assert.equal(parseGlobePipelineCacheKey(key).defines, defines);
});

test("C. the four stale getter keys are unproducible and unparseable", () => {
  // THE DEFECT, pinned. These are the exact strings the four accessors asked
  // for from 2026-04-04 to 2026-08-01.
  const stale = ["UNO_28|0", "UXO_24|0", "QNO_16|0", "QXO_12|0"];

  for (const key of stale) {
    assert.equal(
      parseGlobePipelineCacheKey(key),
      null,
      `${key} must not parse — it predates the webMercatorT marker`,
    );
  }

  // Exhaustive proof that no input to the builder yields any of them: the
  // getters were not "out of date", they were unsatisfiable.
  const produced = new Set();
  const kinds = [
    "color",
    "pick",
    "translucentBackFace",
    "depthOnlyBackFace",
    "depthOnlyFrontFace",
    "wireframe",
  ];
  for (const kind of kinds) {
    for (const isQuantized of BOOLS) {
      for (const hasNormals of BOOLS) {
        for (const hasWebMercatorT of BOOLS) {
          for (const isBlend of BOOLS) {
            for (const useClipDistances of BOOLS) {
              for (const disableCulling of BOOLS) {
                for (const strideBytes of STRIDES) {
                  produced.add(
                    buildGlobePipelineCacheKey({
                      kind,
                      isQuantized,
                      hasNormals,
                      hasWebMercatorT,
                      isBlend,
                      strideBytes,
                      useClipDistances,
                      disableCulling,
                      defines: 0,
                    }),
                  );
                }
              }
            }
          }
        }
      }
    }
  }
  for (const key of stale) {
    assert.ok(
      !produced.has(key),
      `${key} is producible — the defect premise is wrong`,
    );
  }
  // Sanity: the CORRECTED forms are producible, so the sweep above is real.
  for (const key of ["UNMO_28|0", "UXMO_24|0", "QNMO_16|0", "QXMO_12|0"]) {
    assert.ok(produced.has(key), `${key} should be producible`);
  }
});

test("D. the key format has exactly one home in engine source", () => {
  // The original defect was a format that lived inside a producer's template
  // literal with nothing binding consumers to it. This asserts no engine
  // module reconstructs a globe pipeline key inline any more. If a new
  // producer is added with its own literal, this goes red on the commit that
  // adds it rather than 15 months later.
  const marker = /\?\s*"Q"\s*:\s*"U"/;
  const offenders = [];
  for (const file of readdirSync(engineWebGPU)) {
    if (!file.endsWith(".ts") && !file.endsWith(".js")) {
      continue;
    }
    if (file === "WebGPUGlobeSurfacePipelineKey.ts") {
      continue; // the one legitimate home
    }
    const source = readFileSync(resolve(engineWebGPU, file), "utf8");
    if (marker.test(source)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these modules build a globe pipeline key inline: ${offenders.join(", ")}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════
// E / F — the four repaired accessors + the listing API
// ═══════════════════════════════════════════════════════════════════════

// Same descriptor name across two DIFFERENT local keys: the aliasing-adjacent
// shape. Both are legitimate distinct local variants; they share a name, which
// is what would collapse them in the central cache.
const SHARED_NAME = "Globe terrain (uncompressed, normals, opaque)";

const P = {};
for (const id of [
  "uncompNormGeo",
  "uncompNormMerc",
  "uncompNormWideStride",
  "blend",
  "noCull",
  "clipDistances",
  "withDefines",
  "pick",
  "uncompNoNorm",
  "quantNorm",
  "quantNoNorm",
  "junk",
]) {
  P[id] = { __id: id };
}

function makeSyntheticCache() {
  // Deliberately scrambled insertion order: the accessors must be
  // order-independent, not "whichever tile loaded first".
  const entries = [
    ["UNMB_28|0", P.blend, SHARED_NAME],
    ["QXMO_12|0", P.quantNoNorm, "Globe terrain (quantized, no normals)"],
    ["UNMO_28|1", P.withDefines, SHARED_NAME],
    ["UNMO_32|0", P.uncompNormWideStride, SHARED_NAME],
    ["UNMO_28_PICK|0", P.pick, `${SHARED_NAME} pick`],
    ["UNGO_24|0", P.uncompNormGeo, SHARED_NAME],
    ["UXMO_24|0", P.uncompNoNorm, "Globe terrain (uncompressed, no normals)"],
    ["UNMO_28_NC|0", P.noCull, SHARED_NAME],
    ["QNMO_16|0", P.quantNorm, "Globe terrain (quantized, normals)"],
    ["UNMO_28|0", P.uncompNormMerc, SHARED_NAME],
    ["UNMO_28_CD|0", P.clipDistances, SHARED_NAME],
    // A key the current grammar does not understand.
    ["LEGACY_UNO_28", P.junk, "Globe terrain (legacy)"],
  ];
  const cache = new Map();
  for (const [key, pipeline, name] of entries) {
    cache.set(key, { descriptor: { name }, pipeline, pending: false });
  }
  // An entry still materializing through the central cache.
  cache.set("UNMO_36|0", {
    descriptor: { name: SHARED_NAME },
    pipeline: null,
    pending: true,
  });
  return cache;
}

// The accessors' criteria are READ OUT OF the live renderer rather than
// restated, so this spec cannot silently agree with a getter that was edited
// to mean something else.
const rendererSource = await readFile(
  resolve(engineWebGPU, "WebGPUGlobeSurfaceRenderer.ts"),
  "utf8",
);

function extractGetterCriteria(name) {
  const pattern = new RegExp(
    `get ${name}\\(\\): GPURenderPipeline \\| null \\{\\s*return findGlobePipelineVariant\\(\\s*this\\._pipelineCache,\\s*(\\{[\\s\\S]*?\\}),?\\s*\\);`,
  );
  const match = pattern.exec(rendererSource);
  assert.ok(
    match,
    `getter ${name} no longer delegates to findGlobePipelineVariant(this._pipelineCache, {...})`,
  );
  // Compiles a criteria object literal extracted from live renderer source;
  // same harness-snippet pattern as the fleet's other per-site exemptions.
  // eslint-disable-next-line no-new-func
  return new Function(`return ${match[1]};`)();
}

test("E. the four repaired accessors return truth on an aliasing-adjacent cache", () => {
  const cache = makeSyntheticCache();

  const expectations = [
    // Ties broken lexicographically: UNGO_24|0 < UNMO_28|0 < UNMO_32|0.
    ["pipeline", P.uncompNormGeo],
    ["pipelineNoNormals", P.uncompNoNorm],
    ["pipelineQuantized", P.quantNorm],
    ["pipelineQuantizedNoNormals", P.quantNoNorm],
  ];

  for (const [name, expected] of expectations) {
    const criteria = extractGetterCriteria(name);
    const actual = findGlobePipelineVariant(cache, criteria);
    assert.equal(
      actual,
      expected,
      `${name} returned ${actual?.__id ?? "null"}, expected ${expected.__id}`,
    );
  }
});

test("E2. TEETH — the pre-fix implementation returns null on that same cache", () => {
  // The old bodies were `this._pipelineCache.get("<stale>")?.pipeline ?? null`.
  // Run them verbatim against a cache that is FULL of the pipelines they were
  // supposed to find. All four must come back null, which is exactly what
  // shipped for 15 months, and is the delta this fix closes.
  const cache = makeSyntheticCache();
  for (const stale of ["UNO_28|0", "UXO_24|0", "QNO_16|0", "QXO_12|0"]) {
    assert.equal(
      cache.get(stale)?.pipeline ?? null,
      null,
      `${stale} unexpectedly resolved — the synthetic cache is not representative`,
    );
  }
});

test("E3. the accessors exclude variants they do not name", () => {
  const cache = makeSyntheticCache();
  const criteria = extractGetterCriteria("pipeline");
  const got = findGlobePipelineVariant(cache, criteria);
  for (const excluded of [
    P.blend,
    P.noCull,
    P.clipDistances,
    P.withDefines,
    P.pick,
    P.junk,
    P.quantNorm,
    P.quantNoNorm,
    P.uncompNoNorm,
  ]) {
    assert.notEqual(
      got,
      excluded,
      `pipeline must not return the ${excluded.__id} variant`,
    );
  }

  // An unmaterialized entry is never handed out, even when it matches.
  const pendingOnly = new Map([
    [
      "UNMO_28|0",
      { descriptor: { name: SHARED_NAME }, pipeline: null, pending: true },
    ],
  ]);
  assert.equal(findGlobePipelineVariant(pendingOnly, criteria), null);
});

test("E4. accessor results are independent of insertion order", () => {
  const criteria = extractGetterCriteria("pipeline");
  const forward = findGlobePipelineVariant(makeSyntheticCache(), criteria);

  const reversed = new Map([...makeSyntheticCache()].reverse());
  assert.equal(findGlobePipelineVariant(reversed, criteria), forward);
});

test("F. the listing API reports every entry, including ones it cannot parse", () => {
  const cache = makeSyntheticCache();
  const rows = listGlobePipelineVariants(cache, "pipeline");

  assert.equal(
    rows.length,
    cache.size,
    "row count must equal cache size — nothing dropped",
  );

  const unparseable = rows.filter((row) => row.fields === null);
  assert.equal(unparseable.length, 1, "expected exactly one unparseable key");
  assert.equal(unparseable[0].key, "LEGACY_UNO_28");
  assert.equal(
    unparseable[0].pipeline,
    P.junk,
    "an unparseable key must still report its pipeline, not hide the entry",
  );

  const pendingRow = rows.find((row) => row.key === "UNMO_36|0");
  assert.equal(pendingRow.materialized, false);
  assert.equal(pendingRow.pending, true);
  assert.equal(pendingRow.pipeline, null);

  const materialized = rows.find((row) => row.key === "UNMO_28|0");
  assert.equal(materialized.materialized, true);
  assert.equal(materialized.descriptorName, SHARED_NAME);
  assert.equal(materialized.cache, "pipeline");
  assert.equal(materialized.fields.kind, "color");

  // Every parsed row's key must rebuild from its own reported fields, so the
  // listing cannot describe a row as something other than what is stored.
  for (const row of rows) {
    if (row.fields) {
      assert.equal(buildGlobePipelineCacheKey(row.fields), row.key);
    }
  }

  // Kinds sharing `_pipelineCache` are reported distinctly.
  assert.equal(
    rows.find((row) => row.key === "UNMO_28_PICK|0").fields.kind,
    "pick",
  );
});

test("F2. aliasing-adjacent entries are visible as distinct rows sharing a name", () => {
  const rows = listGlobePipelineVariants(makeSyntheticCache(), "pipeline");
  const shared = rows.filter((row) => row.descriptorName === SHARED_NAME);

  assert.ok(
    shared.length > 1,
    "fixture should contain several variants under one descriptor name",
  );
  assert.equal(
    new Set(shared.map((row) => row.key)).size,
    shared.length,
    "each must be its own row — collapsing them is the aliasing failure",
  );
  // Distinct pipelines behind one name is precisely the reportable signal.
  const distinctPipelines = new Set(
    shared.filter((row) => row.pipeline).map((row) => row.pipeline),
  );
  assert.ok(distinctPipelines.size > 1);
});

// ═══════════════════════════════════════════════════════════════════════
// G — central cache reporting surfaces
// ═══════════════════════════════════════════════════════════════════════

function makeCentralCache() {
  const device = {
    createRenderPipelineAsync: async (d) => ({
      __label: d.label ?? "pipeline",
    }),
    createRenderPipeline: (d) => ({ __label: d.label ?? "pipeline" }),
  };
  return new WebGPURenderPipelineCache(device, "ctx-spec");
}

// A single shared stand-in module object. Identity — not shape — is what the
// central key folds since NEW-WEBGPU-PIPELINE-KEY-DEFINE-AXIS-GENERAL, so the
// default must be ONE object rather than a fresh literal per call; two
// descriptors that model "the same pipeline requested twice" have to carry the
// same module the way a real producer's memoized descriptor does.
const DEFAULT_STUB_MODULE = { __module: "vs-a" };

function descriptorFor(name, module) {
  return {
    name,
    vertex: {
      module: module ?? DEFAULT_STUB_MODULE,
      entryPoint: "vertexMain",
    },
    fragment: {
      module: module ?? DEFAULT_STUB_MODULE,
      entryPoint: "fragmentMain",
      targets: [{ format: "bgra8unorm" }],
    },
  };
}

test("G. cacheStats() arithmetic is consistent with the cache's own contents", async () => {
  const cache = makeCentralCache();

  await cache.getPipeline(descriptorFor("Globe terrain (A)"));
  await cache.getPipeline(descriptorFor("Globe terrain (B)"));
  await cache.getPipeline(descriptorFor("Globe terrain (A)")); // hit

  const stats = cache.getStats();
  const rows = cache.listPipelineVariants();

  // `size` is what CesiumDebug.cacheStats() prints; it must equal the number
  // of entries the cache will actually enumerate.
  assert.equal(stats.size, rows.length, "stats.size must match real contents");
  assert.equal(stats.size, 2);
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 2);
  assert.equal(
    stats.hitRate,
    stats.hits / (stats.hits + stats.misses),
    "hitRate must be hits/(hits+misses) — the value cacheStats() formats",
  );
  assert.equal(stats.created, 2);

  // Every enumerated key must be the key the cache itself would compute.
  const names = rows.map((row) => row.name).sort();
  assert.deepEqual(names, ["Globe terrain (A)", "Globe terrain (B)"]);
  for (const row of rows) {
    assert.equal(row.key, cache.describeCacheKey(descriptorFor(row.name)));
    assert.ok(row.pipeline, "an enumerated entry always has its pipeline");
  }
});

test("G2. describeCacheKey exposes the real key, and the name is its head", () => {
  const cache = makeCentralCache();
  const key = cache.describeCacheKey(descriptorFor("Globe terrain (A)"));
  assert.ok(
    key.startsWith("Globe terrain (A)"),
    `descriptor name must lead the central key, got ${key}`,
  );
  // Variant markers extend the key rather than replacing it.
  const withVariant = cache.describeCacheKey(
    descriptorFor("Globe terrain (A)"),
    {
      cullMode: "none",
    },
  );
  assert.notEqual(withVariant, key);
  assert.ok(withVariant.startsWith("Globe terrain (A)"));
});

test("G3. an unmarked name can no longer alias two shader modules", async () => {
  // REWRITTEN 2026-08-06 (`NEW-WEBGPU-PIPELINE-KEY-DEFINE-AXIS-GENERAL`). The
  // original version ASSERTED the aliasing: two logically different pipelines
  // sharing a descriptor name collapsed onto one entry, the second request
  // scored as a HIT, and `wrongModuleHits` was the only counter that could see
  // it. That premise is now false by construction — `generateCacheKey` folds
  // shader-module identity — so the test asserts the inverse. The point it made
  // about `cacheStats()` still stands and is why the counter is retained: for
  // the whole 15-month window aliasing IMPROVED every number that surface
  // printed.
  const cache = makeCentralCache();

  // ONE object per logical module, reused — a real producer memoizes its
  // module and hands the same object back on every rebuild.
  const classicModule = { __module: "classic" };
  const enhancedModule = { __module: "enhOcean" };
  const a = descriptorFor("Globe terrain (shared)", classicModule);
  const b = descriptorFor("Globe terrain (shared)", enhancedModule);

  assert.notEqual(
    cache.describeCacheKey(a),
    cache.describeCacheKey(b),
    "an unmarked name must NOT alias two different shader modules — the `sh:` " +
      "module-identity segment is what separates them",
  );

  const first = await cache.getPipeline(a);
  const second = await cache.getPipeline(b);

  assert.notEqual(
    second,
    first,
    "each module must materialize its own pipeline, marker or no marker",
  );

  const stats = cache.getStats();
  assert.equal(stats.size, 2);
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 2);
  assert.equal(
    stats.wrongModuleHits,
    0,
    "nothing aliased, so the runtime canary must stay at 0",
  );

  // Hit-rate preservation: the SAME descriptor requested again is still a hit.
  // The fold must separate genuinely-different pipelines without turning every
  // lookup into a miss.
  const third = await cache.getPipeline(
    descriptorFor("Globe terrain (shared)", classicModule),
  );
  assert.equal(third, first, "an identical re-request must still hit");
  assert.equal(cache.getStats().hits, 1);
  assert.equal(cache.getStats().size, 2);
  assert.equal(cache.getStats().wrongModuleHits, 0);

  const rows = cache.listPipelineVariants();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.name),
    ["Globe terrain (shared)", "Globe terrain (shared)"],
    "two rows under ONE name is the correct post-fold shape for a variant pair " +
      "whose producer did not spell the axis into its name",
  );
});

test("G3b. wrongModuleHits still fires when a key is made to collide", async () => {
  // The counter is expected to read 0 forever now, which makes it easy for it
  // to rot unnoticed. Poison the cache directly — store an entry under the key
  // the cache computes for `a`, but with `b`'s descriptor — so a served hit
  // genuinely carries the wrong module. This is the only remaining way to reach
  // that branch, and reaching it is what proves the instrument is still live.
  const cache = makeCentralCache();

  const a = descriptorFor("Globe terrain (poisoned)", { __module: "classic" });
  const b = descriptorFor("Globe terrain (poisoned)", { __module: "enhOcean" });

  await cache.getPipeline(b);
  const poisonedKey = cache.describeCacheKey(a);
  const bEntry = cache.cache.get(cache.describeCacheKey(b));
  cache.cache.set(poisonedKey, bEntry);

  assert.equal(cache.getStats().wrongModuleHits, 0, "precondition");
  const served = cache.getPipelineSync(a);
  assert.ok(served, "the poisoned entry must be served as a hit");
  assert.equal(
    cache.getStats().wrongModuleHits,
    1,
    "a hit whose cached module differs from the requested one must still " +
      "increment wrongModuleHits — the runtime canary for the `sh:` fold",
  );

  // Control: a legitimate same-module hit must NOT increment it.
  cache.getPipelineSync(b);
  assert.equal(
    cache.getStats().wrongModuleHits,
    1,
    "a same-module hit must not count as a wrong-module hit",
  );
});

test("G4. a name marker separates what would otherwise alias", async () => {
  // The Batch-803 fix at the eight producer sites: vary `descriptor.name` for
  // any change that affects pipeline identity but is invisible to the key
  // generator (here, the enhanced-ocean shader module).
  //
  // Retained as DEFENSE-IN-DEPTH, not as the correctness mechanism. Since
  // 2026-08-06 the `sh:` fold separates these two regardless of the name (G3);
  // the markers survive because a bare `sh:41.…` says the variants are
  // separate but not WHICH variant a `listPipelineVariants()` row is.
  const cache = makeCentralCache();

  const classic = descriptorFor("Globe terrain (shared)", {
    __module: "classic",
  });
  const enhanced = descriptorFor("Globe terrain (shared, enhOcean)", {
    __module: "enhOcean",
  });

  assert.notEqual(
    cache.describeCacheKey(classic),
    cache.describeCacheKey(enhanced),
    "the name marker must separate the two central keys",
  );

  const a = await cache.getPipeline(classic);
  const b = await cache.getPipeline(enhanced);
  assert.notEqual(a, b, "each variant gets its own pipeline");

  const stats = cache.getStats();
  assert.equal(stats.size, 2);
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 2);
  assert.equal(cache.listPipelineVariants().length, 2);
});
