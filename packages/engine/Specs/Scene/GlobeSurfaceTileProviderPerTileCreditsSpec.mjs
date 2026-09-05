/**
 * Behaviour spec for AR-002 (finding GLOBE-7) — per-tile terrain and imagery
 * credits must reach `creditDisplay` on both backends.
 *
 * `addDrawCommandsForTile` in `Scene/GlobeSurfaceTileProviderRendering.js`
 * used to collect a tile's terrain/imagery credits AFTER the
 * `context.getFeatureRenderer(FeatureRendererKey.GLOBE_SURFACE)` early
 * return, so the WebGPU path never ran that code and per-tile Bing / ion /
 * ArcGIS / WMS attribution never reached the credit bar. The fix hoists the
 * credit collection above the branch (Scene Logic Extractor pattern).
 *
 * This drives the REAL, exported `addDrawCommandsForTile` against a
 * hand-built tile fixture — once with a feature renderer present (the
 * WebGPU path) and once without (the WebGL path) — and asserts the set of
 * credits handed to a stub `creditDisplay` is the same, and non-empty, in
 * both cases. It fails on the pre-fix shape (WebGPU recorded nothing), and
 * the inertness mutant (wrapping the hoisted call in `if (false && …)`)
 * reproduces that failure.
 *
 * WHAT IS STUBBED, AND WHY. `addDrawCommandsForTile` is a ~950-line function
 * that builds a full WebGL draw command (uniform maps, shader options,
 * projected rectangles, DrawCommand/BoundingSphere state) once past the
 * credit collection point, none of which is reachable without a real
 * WebGL/WebGPU device. Faking that unrelated state would make this spec
 * brittle against changes that have nothing to do with credits. Instead the
 * fixture provides just enough for both branches to reach (and, on the
 * WebGPU side, cleanly return from) the code that decides whether to add
 * credits — real `surfaceTile.terrainData`/`surfaceTile.imagery` shapes read
 * by the real gating logic (readiness, `imageryLayer.alpha`, night-imagery
 * retirement) — and both calls are wrapped in try/catch so that whatever the
 * function does AFTER credit collection (which this defect does not touch)
 * cannot fail the assertion. Credit objects are plain marker objects rather
 * than real `Credit` instances: `Credit.html` sanitizes through `dompurify`,
 * which needs a DOM unavailable under `node --test`, and the code under test
 * only reads `.length` / indexes the array and forwards the object to
 * `creditDisplay.addCreditToNextFrame` — it never inspects `Credit`
 * internals — so a marker object exercises the real control flow without a
 * DOM.
 *
 * `GlobeSurfaceTileProviderRendering.js` is a leaf `.js` module itself, but it
 * transitively imports `Renderer/AutomaticUniforms.js`, which imports the
 * TypeScript-only `Scene/LightTypes.ts` under its `.js` build specifier — so
 * loading it from plain Node needs the same two loader hooks
 * `PickingMostDetailedSupportSpec.mjs` established for exactly this shape
 * (non-leaf engine TypeScript reached through an otherwise-plain-JS module):
 * the shared `.js`-specifier-that-is-really-`.ts` resolver, and a stub for
 * generated `Shaders/*.js` build output absent from a clean checkout (this
 * file's own import graph does not read shader text, so an empty module is a
 * safe substitute). Copied rather than re-derived, per that file's own
 * comment on why the hooks exist.
 *
 * Run: node --test packages/engine/Specs/Scene/GlobeSurfaceTileProviderPerTileCreditsSpec.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import process from "node:process";
import test from "node:test";
import { URL, fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const RETRY_FLAG = "CESIUM_SPEC_TS_TRANSFORM_RETRY";

if (process.features.typescript !== "transform" && !process.env[RETRY_FLAG]) {
  const env = { ...process.env, [RETRY_FLAG]: "1" };
  // `node --test` marks its file children with NODE_TEST_CONTEXT; inheriting it
  // makes the re-executed process report nothing and exit 0, which would turn
  // every assertion below into a silent pass.
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", SELF],
    { stdio: "inherit", env: env },
  );
  process.exit(child.status ?? 1);
}

const EMPTY_SHADER_MODULE = "data:text/javascript,export default %22%22;";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js") &&
      typeof context.parentURL === "string" &&
      context.parentURL.startsWith("file:")
    ) {
      const target = fileURLToPath(new URL(specifier, context.parentURL));
      if (!fs.existsSync(target) && /[\\/]Shaders[\\/]/.test(target)) {
        return { url: EMPTY_SHADER_MODULE, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith(".ts") || !loaded.source) {
      return loaded;
    }
    const source = loaded.source.toString();
    const typeOnlyExports = new Set();
    const declaration =
      /^export\s+(?:declare\s+)?(?:interface|type)\s+([A-Za-z0-9_$]+)/gm;
    let match = declaration.exec(source);
    while (match !== null) {
      typeOnlyExports.add(match[1]);
      match = declaration.exec(source);
    }
    if (typeOnlyExports.size === 0) {
      return loaded;
    }
    const placeholders = [...typeOnlyExports]
      .map((name) => `export const ${name} = undefined;`)
      .join("\n");
    loaded.source = `${source}\n${placeholders}\n`;
    return loaded;
  },
});

const { enableEngineTsResolution } = await import(
  new URL(
    "../../../../Tools/visual-regression/lib/engine-ts-resolver.mjs",
    import.meta.url,
  ).href
);
enableEngineTsResolution();

const engine = (relative) =>
  import(new URL(`../../Source/${relative}`, import.meta.url).href);

const { addDrawCommandsForTile } = await engine(
  "Scene/GlobeSurfaceTileProviderRendering.js",
);
const { nightImageryTileIsRetired } = await engine(
  "Scene/GlobeNightImagery.js",
);

const terrainCredit = { marker: "terrain-credit" };
const readyImageryCredit = { marker: "imagery-credit-ready" };

/**
 * One tile's worth of terrain + imagery credit fixture, read by the real
 * `addPerTileCreditsForNextFrame` gating exactly as the WebGL day-texture
 * loop reads it:
 *   - entry 0: ready, alpha=1, not a night layer -> carries a credit
 *   - entry 1: not yet ready (`readyImagery` undefined) -> must NOT credit
 *   - entry 2: ready but alpha=0 (layer faded out) -> must NOT credit
 *
 * @returns {object} A fresh `surfaceTile`-shaped fixture.
 */
function makeSurfaceTile() {
  return {
    terrainData: { credits: [terrainCredit] },
    imagery: [
      {
        readyImagery: {
          imageryLayer: { alpha: 1.0 },
          credits: [readyImageryCredit],
        },
      },
      {
        readyImagery: undefined,
      },
      {
        readyImagery: {
          imageryLayer: { alpha: 0.0 },
          credits: [{ marker: "should-never-be-recorded" }],
        },
      },
    ],
    // Truthy so the WebGL branch skips `TerrainFillMesh` construction — that
    // machinery is irrelevant to credits and is not part of this fixture.
    vertexArray: {},
    // Truthy `mesh.vertices`/`mesh.indices` so the WebGPU branch's mesh guard
    // passes and it reaches its own device check instead of the fill path.
    mesh: {
      vertices: new Float32Array(4),
      indices: new Uint16Array([0, 1, 2]),
    },
  };
}

/**
 * @param {Array<object>} sink Recorded credits are pushed here in call order.
 * @returns {object} A minimal `creditDisplay` stub.
 */
function makeCreditDisplay(sink) {
  return {
    addCreditToNextFrame(credit) {
      sink.push(credit);
    },
  };
}

/**
 * Drives `addDrawCommandsForTile` once and returns the credits recorded
 * before whatever happens next (device-absence early return on the WebGPU
 * side; an unrelated TypeError once WebGL-only state is reached, deliberately
 * not stubbed — see the file header) either returns or throws.
 *
 * @param {object} options
 * @param {boolean} options.withFeatureRenderer True selects the WebGPU branch.
 * @returns {Array<object>} Recorded credits, in call order.
 */
function driveOnce({ withFeatureRenderer }) {
  const recorded = [];
  const surfaceTile = makeSurfaceTile();
  const tileProvider = { _clippingPolygons: undefined };
  const tile = { data: surfaceTile, level: 0, x: 0, y: 0, rectangle: {} };
  const frameState = {
    creditDisplay: makeCreditDisplay(recorded),
    context: {
      // No `limits` on purpose: the WebGL branch's very next statement after
      // credit collection reads `context.limits.maximumTextureImageUnits`, so
      // the WebGL run throws immediately once its (irrelevant) responsibility
      // begins, rather than silently walking deeper into unstubbed state.
      getFeatureRenderer: () => (withFeatureRenderer ? {} : undefined),
    },
  };

  try {
    addDrawCommandsForTile(tileProvider, tile, frameState);
  } catch {
    // Expected on the WebGL leg (see above) and tolerated on both — this
    // spec's assertion is about what got recorded, not about completing the
    // rest of an unrelated 900-line command build.
  }
  return recorded;
}

test("AR-002: WebGPU branch (feature renderer present) records the tile's terrain and imagery credits", () => {
  const recorded = driveOnce({ withFeatureRenderer: true });
  assert.deepEqual(recorded, [terrainCredit, readyImageryCredit]);
});

test("AR-002: WebGL branch (no feature renderer) records the SAME credit set", () => {
  const recorded = driveOnce({ withFeatureRenderer: false });
  assert.deepEqual(recorded, [terrainCredit, readyImageryCredit]);
});

test("AR-002: the two branches agree — the observable this row is about", () => {
  const withRenderer = driveOnce({ withFeatureRenderer: true });
  const withoutRenderer = driveOnce({ withFeatureRenderer: false });
  assert.deepEqual(
    withRenderer,
    withoutRenderer,
    "per-tile credits must not depend on which backend renders the tile",
  );
  assert.ok(withRenderer.length > 0, "the fixture must actually carry credits");
});

test("AR-002: not-ready and zero-alpha imagery entries never contribute a credit", () => {
  const recorded = driveOnce({ withFeatureRenderer: true });
  assert.ok(
    !recorded.includes(undefined),
    "a not-ready tileImagery entry must not push anything",
  );
  assert.ok(
    recorded.every((credit) => credit.marker !== "should-never-be-recorded"),
    "a zero-alpha imagery layer must not contribute its credit",
  );
});

/**
 * Independent oracle for the "WebGL count unchanged" acceptance clause. This
 * is a second, separately-written copy of the PRE-hoist shape — two loops run
 * directly against the fixture, gated the same way the removed in-body WebGL
 * code was gated — with NO call into `addDrawCommandsForTile` or
 * `addPerTileCreditsForNextFrame`. If the hoisted helper introduced a
 * dedup/skip/extra-add bug relative to what WebGL always collected, this
 * oracle and the real WebGL branch would disagree; comparing the module under
 * test only against itself (as the other tests above do) cannot catch that
 * class of defect.
 *
 * @param {object} surfaceTile
 * @returns {Array<object>} Credits in the order the removed WebGL code
 *     collected them.
 */
function legacyWebGLCredits(surfaceTile) {
  const recorded = [];
  const terrainData = surfaceTile.terrainData;
  if (terrainData && terrainData.credits) {
    for (const credit of terrainData.credits) {
      recorded.push(credit);
    }
  }
  for (const tileImagery of surfaceTile.imagery) {
    const imagery = tileImagery.readyImagery;
    if (!imagery || imagery.imageryLayer.alpha === 0.0) {
      continue;
    }
    if (nightImageryTileIsRetired(imagery.imageryLayer, tileImagery)) {
      continue;
    }
    if (imagery.credits) {
      for (const credit of imagery.credits) {
        recorded.push(credit);
      }
    }
  }
  return recorded;
}

test("AR-002: the WebGL branch's credit count is UNCHANGED by the hoist (independent oracle)", () => {
  const surfaceTile = makeSurfaceTile();
  const oracle = legacyWebGLCredits(surfaceTile);
  const actual = driveOnce({ withFeatureRenderer: false });
  assert.deepEqual(
    actual,
    oracle,
    "the hoisted helper must collect exactly what the removed in-body WebGL " +
      "loops collected — same credits, same count, same order",
  );
  assert.equal(oracle.length, 2, "the oracle itself must be non-trivial");
});
