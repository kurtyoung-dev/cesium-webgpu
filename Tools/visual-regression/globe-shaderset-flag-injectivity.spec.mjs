// globe-shaderset-flag-injectivity.spec.mjs — behaviour spec for UPSTREAM-SYNC-1.145-01.
//
// @purpose Pins that the WebGL globe shader key is injective: no two globe configurations that compile to different #define sets are ever served the same cached ShaderProgram.
// @status ACTIVE
//
// WHY THIS EXISTS. `GlobeSurfaceShaderSet.getShaderProgram` packs its cache key
// into `flags`: bits 0-31 by bitwise OR, and everything above bit 31 by
// arithmetic addition (`x << 32 === x << 0` in JavaScript). The 1.145 upstream
// merge collided five ways in that arithmetic tail — upstream added six vector
// flags at bits 33-38 while the fork had already taken 33-37 for its eclipse,
// night-darkness, night-lights and celestial-water features, having renumbered
// upstream's inherited `hasVectorLayer` off bit 33 to make room.
//
// Both naive resolutions of that conflict are SILENT. Nothing throws, no shader
// fails to compile, and the Jasmine suite, the node-test fleet and
// `capture-and-diff.mjs` all stay green — a wrong-but-valid cached ShaderProgram
// still renders a plausible globe. Before this spec the fork had no detector for
// that class at all: `GlobeSurfaceShaderSetSpec.js` has zero assertions on
// `flags`; `pipeline-key-aliasing.spec.mjs` is WebGPU-only, over `ShaderDefine`
// and `WebGPURenderPipelineCache`, and never reaches this key; and the three
// globe law-specs assert source text, which cannot see two variants sharing a
// cache slot.
//
// WHAT IT ASSERTS, AND IN WHAT SHAPE. The assertions are written against
// observable behaviour rather than against the bit map, so they need no edit
// when a flag is added and cannot certify the resolution they were written
// alongside:
//
//   A1  Two option combinations whose compiled #define sets differ are never
//       served the same ShaderProgram object — the aliasing bug, in both of the
//       directions the merge could have produced.
//   A2  The number of distinct served programs equals the number of distinct
//       #define sets: the key neither aliases nor over-splits.
//   A3  The cache is live — a repeated combination returns the identical object
//       and distinct programs are strictly fewer than combinations. Without A3,
//       A1 would pass vacuously against a cache that never reuses anything.
//   A4  The sweep really reaches the above-bit-31 half.
//
// The expected #define set for a combination is obtained by running that
// combination through a FRESH `GlobeSurfaceShaderSet` (a guaranteed cache miss),
// so it comes from the code under test. This spec never re-derives the bit
// assignment, the flag derivation, or the define list.
//
// C  INERTNESS MUTANTS, per CLAUDE.md Principle 10. Deleting the tail is the
//    easy mutation; instead each mutant makes ONE key term unreachable
//    (`false && …`) while leaving its `#define` push live — precisely the shape
//    of the two wrong merge resolutions. C1 kills a fork term (what `--theirs`
//    would have done), C2 an upstream term (what `--ours` would have done), and
//    both must make A1 fail. C3 is the control: the same relocation with no
//    mutation must still pass, so C1/C2 are not failing because of the harness.
//
// WHAT IS FAKED, AND WHY IT CANNOT HIDE THE DEFECT. Three things, all of them
// downstream of the key:
//   * every engine dependency outside the named allowlist, via the shared
//     `engine-stub-bundler` Proxy stub — the same mechanism the other
//     globe-pipeline specs use. `GlobeSurfaceShaderSet`, `ShaderProgram`,
//     `SceneMode`, `TerrainQuantization` and `defined` are kept REAL, so the
//     entire key computation and the entire cache lookup are the real code.
//   * `context.shaderCache`, whose fake returns a FRESH object on every call.
//     Object reuse can therefore only have come from `GlobeSurfaceShaderSet`'s
//     own `shadersByFlags` table, which is the cache under test.
//   * `baseVertexShaderSource` / `baseFragmentShaderSource`, minimal
//     `ShaderSource`-shaped sinks exposing `clone()`, `defines` and `sources`.
//     They are where the real code WRITES its defines; the spec only reads what
//     the real code put there.
//
// Runner: pure Node, no browser, no Edge leg. Sibling instrument:
// `Tools/upstream-shape-guard.spec.mjs`.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bundle } from "./lib/engine-stub-bundler.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SOURCE = resolve(HERE, "../../packages/engine/Source");
const ENGINE_SCENE = resolve(ENGINE_SOURCE, "Scene");
const SHADER_SET_PATH = resolve(ENGINE_SCENE, "GlobeSurfaceShaderSet.js");

// A synthetic entry: never written to disk, handed to esbuild through stdin
// with `resolveDir` set to the real Scene directory so its relative specifiers
// resolve against the real tree.
const ENTRY_PATH = resolve(
  ENGINE_SCENE,
  "__globe-shaderset-flag-injectivity.js",
);
const ENTRY_SOURCE = [
  'export { default as GlobeSurfaceShaderSet } from "./GlobeSurfaceShaderSet.js";',
  'export { default as SceneMode } from "./SceneMode.js";',
  'export { default as TerrainQuantization } from "../Core/TerrainQuantization.js";',
  "",
].join("\n");

// Kept real: the module under test, the two enums its key reads, the `defined`
// predicate its cache-hit test is written in, and `ShaderProgram` — whose
// `fromCache` is the only route from the module to the fake shader cache. A
// stubbed `ShaderProgram` would hand back a fresh Proxy per call without ever
// consulting the cache, and the spec would observe nothing.
const REAL = [
  "GlobeSurfaceShaderSet.js",
  "ShaderProgram.js",
  "SceneMode.js",
  "TerrainQuantization.js",
  "defined.js",
];

// esbuild resolves in parallel, so a stub can be materialised before the real
// file that imports the most from it has been loaded.
const PRESEED = [
  SHADER_SET_PATH,
  resolve(ENGINE_SOURCE, "Renderer/ShaderProgram.js"),
];

/**
 * Bundles the module under test, optionally through a source mutation.
 *
 * @param {Function} [mutate] Rewrite applied to `GlobeSurfaceShaderSet.js`.
 * @param {string} [label] Name used in the did-it-change assertion.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 */
function importShaderSet(mutate, label) {
  return bundle({
    path: ENTRY_PATH,
    source: ENTRY_SOURCE,
    real: REAL,
    preseed: PRESEED,
    overrides: mutate
      ? [{ basename: "GlobeSurfaceShaderSet.js", mutate, label }]
      : [],
  });
}

const LIVE = await importShaderSet();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * The caller-controlled inputs that feed the above-bit-31 half of the key. Six
 * of them reach it through `surfaceTile.vectorData`, which is how the
 * production caller supplies them, so the spec drives the real derivation of
 * the derived flags rather than setting those flags directly.
 */
const AXES = [
  "applyDayNightAlpha",
  "vectorShow",
  "vectorHasPolylines",
  "vectorHasPolygons",
  "vectorAntialias",
  "vectorHasMeterWidths",
  "vectorHasPixelWidths",
  "enableEclipseGlobeShadow",
  "applyNightDarkness",
  "applyNightLights",
  "applyCelestialWater",
];

function combinationAt(index) {
  const combo = {};
  for (let bit = 0; bit < AXES.length; bit++) {
    combo[AXES[bit]] = ((index >>> bit) & 1) === 1;
  }
  return combo;
}

/** A minimal ShaderSource-shaped sink: the real code writes, the spec reads. */
function makeShaderSource() {
  return {
    defines: [],
    sources: [],
    clone() {
      return makeShaderSource();
    },
  };
}

function makeContext() {
  const created = [];
  return {
    created,
    context: {
      id: "globe-shaderset-injectivity",
      webgl2: true,
      shaderCache: {
        getShaderProgram(options) {
          // A fresh object on every call, so any identity a test sees twice
          // proves GlobeSurfaceShaderSet served it from its own cache.
          const program = {
            specId: created.length,
            defines: [...options.fragmentShaderSource.defines].sort().join("|"),
            destroy() {
              return undefined;
            },
          };
          created.push(program);
          return program;
        },
      },
    },
  };
}

function makeOptions(combo, context, SceneMode, TerrainQuantization) {
  return {
    frameState: { mode: SceneMode.SCENE3D, context },
    surfaceTile: {
      renderedMesh: {
        encoding: {
          quantization: TerrainQuantization.NONE,
          getAttributeLocations() {
            return { position3DAndHeight: 0 };
          },
        },
      },
      vectorData: combo.vectorShow
        ? {
            show: true,
            hasPolylines: combo.vectorHasPolylines,
            hasPolygons: combo.vectorHasPolygons,
            hasMeterWidths: combo.vectorHasMeterWidths,
            hasPixelWidths: combo.vectorHasPixelWidths,
          }
        : undefined,
      clippedByBoundaries: false,
    },
    numberOfDayTextures: 1,
    applyBrightness: false,
    applyContrast: false,
    applyHue: false,
    applySaturation: false,
    applyGamma: false,
    applyAlpha: false,
    applyDayNightAlpha: combo.applyDayNightAlpha,
    applyNightDarkness: combo.applyNightDarkness,
    applyNightLights: combo.applyNightLights,
    applyCelestialWater: combo.applyCelestialWater,
    applySplit: false,
    hasWaterMask: false,
    showReflectiveOcean: false,
    showOceanWaves: false,
    enableLighting: false,
    dynamicAtmosphereLighting: false,
    dynamicAtmosphereLightingFromSun: false,
    showGroundAtmosphere: false,
    perFragmentGroundAtmosphere: false,
    hasVertexNormals: false,
    useWebMercatorProjection: false,
    enableFog: false,
    enableClippingPlanes: false,
    clippingPlanes: undefined,
    enableClippingPolygons: false,
    clippingPolygons: undefined,
    clippedByBoundaries: false,
    hasImageryLayerCutout: false,
    colorCorrect: false,
    highlightFillTile: false,
    colorToAlpha: false,
    hasGeodeticSurfaceNormals: false,
    hasExaggeration: false,
    showUndergroundColor: false,
    translucent: false,
    vectorAntialias: combo.vectorAntialias,
    enableEclipseGlobeShadow: combo.enableEclipseGlobeShadow,
    baseColorCorrect: false,
    fogCompanionEnabled: false,
    groundAtmosphereCompanionEnabled: false,
    _skipFogCompanionPrewarm: true,
    _skipGroundAtmosphereCompanionPrewarm: true,
  };
}

function newShaderSet(namespace) {
  const set = new namespace.GlobeSurfaceShaderSet();
  set.baseVertexShaderSource = makeShaderSource();
  set.baseFragmentShaderSource = makeShaderSource();
  set.material = undefined;
  return set;
}

/**
 * Runs every combination twice: once against a fresh set, which always misses
 * and so reports the #define set that combination really compiles to, and once
 * against one shared set, which is where an aliasing key shows itself.
 *
 * @param {Record<string, unknown>} namespace A bundled module namespace.
 * @returns {object} The sweep result.
 */
function sweep(namespace) {
  const { SceneMode, TerrainQuantization } = namespace;
  const total = 1 << AXES.length;
  const shared = makeContext();
  const sharedSet = newShaderSet(namespace);
  const expected = new Array(total);
  const served = new Array(total);

  for (let i = 0; i < total; i++) {
    const combo = combinationAt(i);

    const probe = makeContext();
    newShaderSet(namespace).getShaderProgram(
      makeOptions(combo, probe.context, SceneMode, TerrainQuantization),
    );
    assert.equal(
      probe.created.length,
      1,
      `combination ${i} did not compile exactly one program on a fresh set`,
    );
    expected[i] = probe.created[0].defines;

    served[i] = sharedSet.getShaderProgram(
      makeOptions(combo, shared.context, SceneMode, TerrainQuantization),
    );
  }

  return { total, expected, served, sharedSet, shared, namespace };
}

/** Maps each served program to the set of #define signatures it was served for. */
function definesByProgram(result) {
  const map = new Map();
  for (let i = 0; i < result.total; i++) {
    const seen = map.get(result.served[i]) ?? new Set();
    seen.add(result.expected[i]);
    map.set(result.served[i], seen);
  }
  return map;
}

function collisions(result) {
  const found = [];
  for (const [program, defineSets] of definesByProgram(result)) {
    if (defineSets.size > 1) {
      found.push({ program: program.specId, variants: [...defineSets] });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// A — injectivity of the live key
// ---------------------------------------------------------------------------

const LIVE_SWEEP = sweep(LIVE);

test("A1 — no two configurations with different #define sets share a ShaderProgram", () => {
  const found = collisions(LIVE_SWEEP);
  assert.deepEqual(
    found,
    [],
    `globe shader-key aliasing: ${found.length} cached ShaderProgram(s) were served for more than one #define set`,
  );
});

test("A2 — distinct served programs == distinct #define sets (no aliasing, no over-splitting)", () => {
  assert.equal(
    new Set(LIVE_SWEEP.served).size,
    new Set(LIVE_SWEEP.expected).size,
    "the shader key must partition the configuration space exactly as the #define sets do",
  );
});

test("A3 — the cache is live, so A1 is not vacuous", () => {
  const distinct = new Set(LIVE_SWEEP.served).size;
  assert.ok(
    distinct < LIVE_SWEEP.total,
    `all ${LIVE_SWEEP.total} combinations got their own program — the cache reuses nothing, so A1 would pass against any key`,
  );

  const again = LIVE_SWEEP.sharedSet.getShaderProgram(
    makeOptions(
      combinationAt(0),
      LIVE_SWEEP.shared.context,
      LIVE.SceneMode,
      LIVE.TerrainQuantization,
    ),
  );
  assert.equal(
    again,
    LIVE_SWEEP.served[0],
    "a repeated configuration was not served from the cache",
  );
});

test("A4 — the sweep really exercises the above-bit-31 half", () => {
  const withEclipse = new Set();
  const withoutEclipse = new Set();
  for (let i = 0; i < LIVE_SWEEP.total; i++) {
    (combinationAt(i).enableEclipseGlobeShadow
      ? withEclipse
      : withoutEclipse
    ).add(LIVE_SWEEP.expected[i]);
  }
  assert.ok(
    withEclipse.size > 0 && withoutEclipse.size > 0,
    "both eclipse states must appear in the sweep",
  );
  for (const signature of withEclipse) {
    assert.ok(
      signature.includes("ENABLE_ECLIPSE_GLOBE_SHADOW"),
      "the eclipse axis must reach a #define",
    );
  }
  const anyVector = [...LIVE_SWEEP.expected].some((s) =>
    s.includes("HAS_VECTOR_POLYLINES"),
  );
  assert.ok(anyVector, "the vector-polyline axis must reach a #define");
});

// ---------------------------------------------------------------------------
// C — inertness mutants
// ---------------------------------------------------------------------------

/**
 * Makes one key term unreachable without touching its `#define` push, which is
 * exactly what taking one side of the 1.145 conflict wholesale would have done.
 *
 * @param {string} term The flag name whose key contribution goes dead.
 * @returns {Function} The rewrite.
 */
function deadKeyTerm(term) {
  return (source) => source.replace(`(${term} ? 0x`, `(false && ${term} ? 0x`);
}

test("C1 — MUTANT: a FORK term dropped from the key (what --theirs would do) makes A1 fail", async () => {
  const mutant = await importShaderSet(
    deadKeyTerm("enableEclipseGlobeShadow"),
    "dead fork key term",
  );
  assert.ok(
    collisions(sweep(mutant)).length > 0,
    "A1 survived a key that no longer distinguishes ENABLE_ECLIPSE_GLOBE_SHADOW — the spec is certifying its own fixture, not the key",
  );
});

test("C2 — MUTANT: an UPSTREAM term dropped from the key (what --ours would do) makes A1 fail", async () => {
  const mutant = await importShaderSet(
    deadKeyTerm("hasVectorPolylines"),
    "dead upstream key term",
  );
  assert.ok(
    collisions(sweep(mutant)).length > 0,
    "A1 survived a key that no longer distinguishes HAS_VECTOR_POLYLINES — the spec is certifying its own fixture, not the key",
  );
});

test("C3 — CONTROL: an unmutated re-bundle still passes A1", async () => {
  const control = await importShaderSet();
  assert.deepEqual(
    collisions(sweep(control)),
    [],
    "the re-bundle reports a collision on unmutated source, so C1 and C2 prove nothing",
  );
});
