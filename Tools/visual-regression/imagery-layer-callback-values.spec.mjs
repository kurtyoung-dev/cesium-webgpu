// imagery-layer-callback-values.spec.mjs
// @purpose Pins that every ImageryLayer property documented as scalar-or-callback resolves identically on both backends, executing the shared leaf over the documented contract and mutating the guard.
// @status ACTIVE
//
// THE CONTRACT, TAKEN FROM THE PUBLIC API RATHER THAN FROM ANY IMPLEMENTATION.
//
// `ImageryLayer`'s JSDoc documents EIGHT properties as `{number|Function}` —
// alpha, nightAlpha, dayAlpha, brightness, contrast, hue, saturation, gamma —
// each with the signature
//
//     function(frameState, layer, x, y, level) -> number
//
// and each described as "the alpha value to use for the tile". Two things follow
// that a reader can check without knowing how either backend packs uniforms:
//
//   1. A callback must be CALLED, with those five arguments in that order, and
//      its return value used. A Function written into a Float32Array becomes
//      NaN, and NaN in a multiplicative imagery blend erases the whole layer —
//      so the failure is silent and total rather than approximate.
//   2. The two backends must agree. The same layer over the same tile in the
//      same frame must produce the same number whether the scene is running on
//      WebGL or WebGPU; otherwise a documented API means two different things.
//
// And one thing that is not in the JSDoc but follows from where this runs: a
// user callback that throws, or hands back something that is not a finite
// number, must not be able to erase the layer either. The property's own
// default is the only safe answer.
//
// WHAT THIS SPEC DOES. Section A EXECUTES the shared leaf against that contract,
// including a recording callback that captures its own arguments — so the
// argument ORDER is read off a real call rather than asserted from the docs.
// Section B pins that both packs route through that one leaf, which is what
// makes agreement structural instead of coincidental. Section C mutates the
// guard: absence, and inertness (the leaf still called, its result thrown away).
//
// LINE ENDINGS: this repo checks out CRLF; every source read is normalised.
//
// Run: node --test Tools/visual-regression/imagery-layer-callback-values.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function read(relativePath) {
  return fs
    .readFileSync(path.join(root, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

const LEAF_PATH = "packages/engine/Source/Scene/resolveImageryLayerValue.js";
const WEBGL_PACK_PATH =
  "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js";
const WEBGPU_PACK_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts";
const WEBGPU_TYPES_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts";
const IMAGERY_LAYER_PATH = "packages/engine/Source/Scene/ImageryLayer.js";

const leafSource = read(LEAF_PATH);
const webglPack = read(WEBGL_PACK_PATH);
const webgpuPack = read(WEBGPU_PACK_PATH);
const webgpuTypes = read(WEBGPU_TYPES_PATH);
const imageryLayer = read(IMAGERY_LAYER_PATH);

const { default: resolveImageryLayerValue } = await import(
  pathToFileURL(path.join(root, LEAF_PATH)).href
);

/** The eight properties the public API documents as scalar-or-callback. */
const DOCUMENTED = Object.freeze([
  "alpha",
  "nightAlpha",
  "dayAlpha",
  "brightness",
  "contrast",
  "hue",
  "saturation",
  "gamma",
]);

// ─── A. the contract, EXECUTED ───────────────────────────────────────────────

test("A1: the documented property list is read from ImageryLayer, not hardcoded here", () => {
  // If upstream adds or renames a scalar-or-callback property, this fails and
  // the coverage below has to be revisited rather than silently going stale.
  const declared = new Set(
    (imageryLayer.match(/@property \{number\|Function\} \[(\w+)/g) ?? []).map(
      (line) => /\[(\w+)/.exec(line)[1],
    ),
  );
  assert.deepEqual(
    [...declared].sort(),
    [...DOCUMENTED].sort(),
    "the set of scalar-or-callback properties moved",
  );
});

test("A2: a scalar passes through untouched — the byte-identity guarantee", () => {
  // Every existing scene uses scalars. If this were not exact, the change would
  // be a rendering change for everybody rather than a fix for callback users.
  for (const value of [0, 0.25, 1, 2.5, -1, 1e-7, 1e7]) {
    assert.equal(
      resolveImageryLayerValue(value, 999, {}, {}, { level: 3, x: 1, y: 2 }),
      value,
    );
  }
});

test("A3: a callback is called with (frameState, layer, x, y, level), in that order", () => {
  // The order is READ OFF a real call. Asserting it from the JSDoc would only
  // restate the documentation; a transposed x/y would satisfy that and still
  // hand every tile the wrong coordinates.
  const calls = [];
  const callback = (...args) => {
    calls.push(args);
    return 0.375;
  };
  const frameState = { marker: "frame" };
  const layer = { marker: "layer" };
  const result = resolveImageryLayerValue(callback, 1.0, frameState, layer, {
    level: 7,
    x: 11,
    y: 13,
  });
  assert.equal(result, 0.375, "the callback's return value must be used");
  assert.equal(calls.length, 1, "exactly one call per resolution");
  assert.equal(calls[0].length, 5);
  assert.equal(calls[0][0], frameState);
  assert.equal(calls[0][1], layer);
  assert.equal(calls[0][2], 11, "third argument is x");
  assert.equal(calls[0][3], 13, "fourth argument is y");
  assert.equal(calls[0][4], 7, "fifth argument is level");
});

test("A4: a missing tile is passed as zeroed coordinates, not as undefined", () => {
  const calls = [];
  resolveImageryLayerValue(
    (...args) => {
      calls.push(args);
      return 1;
    },
    1.0,
    {},
    {},
    undefined,
  );
  assert.deepEqual(calls[0].slice(2), [0, 0, 0]);
});

test("A5: an unusable callback result falls back to the property default, never NaN", () => {
  // NaN is the failure this whole leaf exists to prevent, so it must not be
  // reachable from any of the ways a callback can misbehave.
  const unusable = [
    () => undefined,
    () => null,
    () => "0.5",
    () => NaN,
    () => Infinity,
    () => -Infinity,
    () => ({}),
    () => {
      throw new Error("user callback blew up");
    },
  ];
  for (const callback of unusable) {
    const value = resolveImageryLayerValue(callback, 0.8, {}, {});
    assert.equal(value, 0.8, `fallback failed for ${callback}`);
    assert.ok(Number.isFinite(value));
  }
});

test("A6: an unusable scalar falls back the same way", () => {
  for (const value of [undefined, null, NaN, Infinity, "1.0", {}, true]) {
    assert.equal(resolveImageryLayerValue(value, 0.8, {}, {}), 0.8);
  }
});

test("A7: the two backends agree for the same layer over the same tile", () => {
  // The packs differ in how they reach the tile — WebGL builds a coordinates
  // object, WebGPU passes the tile it already holds — so the agreement claim is
  // about what the CALLBACK SEES. Drive the same callback through both shapes.
  const seen = [];
  const timeOfDayFade = (frameState, layer, x, y, level) => {
    seen.push([x, y, level]);
    return (x + y + level) / 100;
  };
  const webglShape = { level: 4, x: 9, y: 6 };
  const webgpuShape = {
    level: 4,
    x: 9,
    y: 6,
    rectangle: { west: 0, south: 0, east: 1, north: 1 },
  };
  const fromWebgl = resolveImageryLayerValue(
    timeOfDayFade,
    1.0,
    {},
    {},
    webglShape,
  );
  const fromWebgpu = resolveImageryLayerValue(
    timeOfDayFade,
    1.0,
    {},
    {},
    webgpuShape,
  );
  assert.equal(fromWebgl, fromWebgpu);
  assert.equal(fromWebgl, 0.19);
  assert.deepEqual(seen[0], seen[1], "both packs must present the same tile");
});

test("A8: gamma is resolved BEFORE the reciprocal, not after", () => {
  // The one property whose packed value is not the property. Taking the
  // reciprocal of an unresolved Function is `1 / Function`, i.e. NaN — and
  // taking the reciprocal of the fallback when the callback was fine would
  // silently ignore the user's value.
  const packed =
    1.0 / resolveImageryLayerValue(() => 4.0, 1.0, {}, {}, undefined);
  assert.equal(packed, 0.25);
  assert.match(
    webglPack,
    /const gamma = resolveImageryLayerValue\(\s*imageryLayer\.gamma,[\s\S]{0,200}?\);\s*uniformMapProperties\.dayTextureOneOverGamma\[numberOfDayTextures\] =\s*1\.0 \/ gamma;/,
    "the reciprocal must be taken of the RESOLVED value",
  );
});

// ─── B. both packs route through the one leaf ────────────────────────────────

test("B1: the WebGL pack resolves all eight documented properties", () => {
  for (const property of DOCUMENTED) {
    assert.match(
      webglPack,
      new RegExp(`resolveImageryLayerValue\\(\\s*imageryLayer\\.${property},`),
      `the WebGL pack still writes ${property} raw`,
    );
  }
  assert.match(
    webglPack,
    /import resolveImageryLayerValue from "\.\/resolveImageryLayerValue\.js";/,
  );
});

test("B2: no documented property is left written raw on the WebGL pack", () => {
  // The complement of B1, and the one that catches a NEW raw write rather than
  // a missing resolution. A bare `= imageryLayer.<prop>;` assignment into a
  // uniform array is the shape the defect had.
  for (const property of DOCUMENTED) {
    assert.doesNotMatch(
      webglPack,
      new RegExp(
        `uniformMapProperties\\.\\w+\\[numberOfDayTextures\\] =\\s*imageryLayer\\.${property};`,
      ),
      `${property} is written raw into a uniform array`,
    );
  }
});

test("B3: the WebGPU pack resolves the same way, from the same module", () => {
  assert.match(webgpuPack, /resolveImageryLayerValue\(\s*layer\.dayAlpha,/);
  assert.match(webgpuPack, /resolveImageryLayerValue\(\s*layer\.nightAlpha,/);
  // And the WebGPU name is the Scene leaf, not a second implementation. Two
  // copies would agree today and drift on the first edit.
  assert.match(
    webgpuTypes,
    /export \{ default as resolveImageryLayerValue \} from "\.\.\/\.\.\/Scene\/resolveImageryLayerValue\.js";/,
    "the WebGPU export must forward to the Scene leaf",
  );
  assert.doesNotMatch(
    webgpuTypes,
    /export function resolveImageryLayerValue/,
    "a second implementation is drift waiting to happen",
  );
});

test("B4: the WebGL pack derives its defines from the RESOLVED values", () => {
  // A define derived from the raw property would be false for a callback that
  // returns 0.5, so the shader variant would omit the very term the callback
  // was written to drive. Reading back the written slot is what prevents it.
  const derivations = [
    ["dayTextureAlpha", "applyAlpha"],
    ["dayTextureNightAlpha", "applyDayNightAlpha"],
    ["dayTextureDayAlpha", "applyDayNightAlpha"],
    ["dayTextureBrightness", "applyBrightness"],
    ["dayTextureContrast", "applyContrast"],
    ["dayTextureHue", "applyHue"],
    ["dayTextureSaturation", "applySaturation"],
    ["dayTextureOneOverGamma", "applyGamma"],
  ];
  for (const [slot, flag] of derivations) {
    assert.match(
      webglPack,
      new RegExp(
        `${flag} =\\s*${flag} \\|\\|\\s*uniformMapProperties\\.${slot}\\[numberOfDayTextures\\] !==`,
      ),
      `${flag} must be derived from the packed ${slot} slot`,
    );
  }
});

test("B5: the per-tile callback arguments are built once, not per property", () => {
  // Eight properties times sixteen layers times every rendered tile, every
  // frame: an object literal at each call site is a per-frame allocation on the
  // hottest path in the renderer, for arguments that cannot vary within a tile.
  assert.match(
    webglPack,
    /const tileCoordinates = \{ level: tile\.level, x: tile\.x, y: tile\.y \};/,
  );
  assert.equal(
    (webglPack.match(/\{ level: tile\.level, x: tile\.x, y: tile\.y \}/g) ?? [])
      .length,
    1,
    "the coordinates object must be constructed exactly once per tile",
  );
  assert.equal(
    (webglPack.match(/resolveImageryLayerValue\(/g) ?? []).length,
    DOCUMENTED.length,
    "one resolution per documented property, no more and no fewer",
  );
});

// ─── C. MUTANTS ──────────────────────────────────────────────────────────────

function mutate(source, from, to) {
  assert.ok(
    source.includes(from),
    `mutation precondition failed: "${from.slice(0, 70)}..."`,
  );
  return source.replace(from, to);
}

/** The leaf's own guard, as a predicate over its source, so mutants can run. */
async function leafGuardHolds(source) {
  // Written outside the repo: a spec that mutates inside the tree can leave it
  // dirty if it throws mid-run.
  const temporary = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "leaf-mutant-")),
    "leaf.mjs",
  );
  fs.writeFileSync(temporary, source);
  try {
    const module = await import(
      `${pathToFileURL(temporary).href}?v=${Math.random()}`
    );
    const resolve = module.default;
    const throwsToDefault =
      resolve(
        () => {
          throw new Error("boom");
        },
        0.8,
        {},
        {},
      ) === 0.8;
    const nanToDefault = resolve(() => NaN, 0.8, {}, {}) === 0.8;
    const functionIsCalled = resolve(() => 0.375, 1.0, {}, {}) === 0.375;
    const scalarPassesThrough = resolve(0.25, 1.0, {}, {}) === 0.25;
    return (
      throwsToDefault && nanToDefault && functionIsCalled && scalarPassesThrough
    );
  } finally {
    fs.rmSync(path.dirname(temporary), { recursive: true, force: true });
  }
}

test("C1: the mutants are DISCRIMINATING — the real leaf passes its own guard", async () => {
  assert.equal(await leafGuardHolds(leafSource), true);
});

test("C2: ABSENCE — a leaf that does not call the callback is REJECTED", async () => {
  const mutant = mutate(
    leafSource,
    'if (typeof value === "function") {',
    "if (false) {",
  );
  assert.equal(await leafGuardHolds(mutant), false);
});

test("C3: INERTNESS — a leaf that calls the callback and discards it is REJECTED", async () => {
  // The failure a deletion mutant misses: the call still happens, so any
  // spec that only counted invocations would stay green while every layer
  // silently reverted to its default.
  const mutant = mutate(
    leafSource,
    `      return typeof resolved === "number" && isFinite(resolved)
        ? resolved
        : defaultValue;`,
    `      void resolved;
      return defaultValue;`,
  );
  assert.equal(await leafGuardHolds(mutant), false);
});

test("C4: ABSENCE — removing the throw guard is REJECTED", async () => {
  const mutant = mutate(
    leafSource,
    `    } catch {
      return defaultValue;
    }`,
    `    } catch {
      return NaN;
    }`,
  );
  assert.equal(
    await leafGuardHolds(mutant),
    false,
    "a throwing callback must not be able to write NaN into the pack",
  );
});

test("C5: ABSENCE — dropping the finite check is REJECTED", async () => {
  const mutant = mutate(
    leafSource,
    'return typeof resolved === "number" && isFinite(resolved)',
    'return typeof resolved === "number"',
  );
  assert.equal(await leafGuardHolds(mutant), false);
});

test("C6: ABSENCE — a raw write on the WebGL pack is REJECTED", async () => {
  // The defect itself, restored on one property. B1 and B2 must both catch it;
  // B1 alone would not, because a pack that resolves seven of eight still
  // matches seven patterns.
  const mutant = mutate(
    webglPack,
    `      uniformMapProperties.dayTextureNightAlpha[numberOfDayTextures] =
        resolveImageryLayerValue(
          imageryLayer.nightAlpha,
          1.0,
          frameState,
          imageryLayer,
          tileCoordinates,
        );`,
    `      uniformMapProperties.dayTextureNightAlpha[numberOfDayTextures] =
        imageryLayer.nightAlpha;`,
  );
  assert.doesNotMatch(
    mutant,
    /resolveImageryLayerValue\(\s*imageryLayer\.nightAlpha,/,
    "B1's pin must go false",
  );
  assert.match(
    mutant,
    /uniformMapProperties\.\w+\[numberOfDayTextures\] =\s*imageryLayer\.nightAlpha;/,
    "B2's pin must go false",
  );
});
