// globe-night-imagery-magnification-fade.spec.mjs
// @purpose Executes the night layer's magnification fade out of all three shipped copies - the JavaScript leaf, the WGSL globe shader and the GLSL one - holds them equal, pins both endpoints exactly, and proves the weight is continuous across a terrain LOD seam rather than stepping at it.
// @status ACTIVE
//
// THE BEHAVIOUR, STATED WITHOUT REFERENCE TO ANY IMPLEMENTATION SHAPE.
//
//   The bundled night pyramid stops at a fixed deepest level. Descending past
//   it spreads one of its texels across more and more of the screen, until the
//   layer is no longer an image of anything: a layer that is opaque past the
//   terminator then replaces the scene under it with a flat wash.
//
//   So the layer's night-side opacity is a function of how magnified it is on
//   screen. Four properties carry that, and each fails differently:
//
//   • THE NEAR END IS EXACT. Wherever the layer is at or near its own
//     resolution - every altitude the showcase is composed at - the weight must
//     be exactly 1.0, not 0.999. Anything else re-renders the orbit view.
//   • THE FAR END IS EXACT, AND IS REACHED. A weight that only approaches zero
//     leaves an opaque layer opaque; the wash is still there, dimmer.
//   • IT IS CONTINUOUS ACROSS A TERRAIN SEAM. Two adjacent terrain tiles one
//     level apart carry the SAME magnification - the finer tile holds half the
//     texels and is half the size on screen - so they must resolve the same
//     weight. A quantity that counts texels across a tile instead reports two
//     values a factor of two apart, and the seam between the tiles becomes a
//     hard band. That band is the defect this measure exists to remove, and it
//     is why the weight is a screen footprint evaluated per fragment rather
//     than a texel count resolved per tile.
//   • IT IS SCOPED. The fade belongs to the layer the globe attached on its own
//     behalf. An application that hand-builds a layer with the same day/night
//     pair has chosen its own resolution and its own alphas, and must keep
//     rendering exactly what it asks for at every altitude.
//
// WHAT THIS SPEC IS FOR. It EXECUTES the law out of all three shipped copies -
// the JavaScript the packers call, the WGSL the WebGPU globe compiles and the
// GLSL the WebGL globe compiles - and holds every number they produce equal.
// It reads the magnification off the SHIPPED pyramid's own tilemapresource.xml
// and off the banked altitude sweep rather than restating either in prose, so
// "the wash is gone where it was measured" is checked as a number against the
// asset and the capture that produced it. It does not own the day/night ramp
// (globe-daynight-ramp-law), the gate that arms it (globe-daynight-alpha-gate),
// or the procedural fallback that takes the night side back once the layer has
// gone (globe-night-darkness-fallback).
//
// WHAT MOVED, AND WHY. The measure used to be texels across a terrain tile,
// with a band from eight texels down to one. Two banked findings retired it:
// the same texel count - sixteen, terrain level seven - read as a legible light
// map at one altitude and as an illegible wash at another, which a per-tile
// texel count cannot distinguish because it is blind to how large the tile is
// on screen; and an altitude where two terrain levels straddled the band
// rendered hard-edged bands, because the two levels resolved different weights
// for one magnification. Both are properties of the measure rather than of its
// thresholds, so the measure is now texels per screen pixel and the thresholds
// are stated in it. Section D holds the new thresholds against the banked sweep
// the old ones were found wanting by.
//
// LINE ENDINGS: this repo checks out CRLF. Every source read is normalised to
// a bare newline first - a spec anchored on one false-greens on a CRLF
// checkout.
//
// Run: node --test Tools/visual-regression/globe-night-imagery-magnification-fade.spec.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  markNightImageryLayer,
  isNightImageryLayer,
  nightImageryMagnificationFade,
  nightImageryTileIsRetired,
  resolveNightImageryFadeTilePixels,
  NIGHT_IMAGERY_FADE_FULL_TEXELS_PER_PIXEL,
  NIGHT_IMAGERY_FADE_ZERO_TEXELS_PER_PIXEL,
  NIGHT_IMAGERY_FADE_BAND_OCTAVES,
  NIGHT_IMAGERY_RETIRE_TEXELS_ACROSS_TILE,
} from "../../packages/engine/Source/Scene/GlobeNightImagery.js";
import {
  compileFunction,
  readConstants,
  stripComments,
} from "./lib/wgsl-mini-eval.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function read(relativePath) {
  return fs
    .readFileSync(path.join(root, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

const LEAF_PATH = "packages/engine/Source/Scene/GlobeNightImagery.js";
const GLOBE_PATH = "packages/engine/Source/Scene/Globe.js";
const TILE_RENDERING_PATH =
  "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js";
const SHADER_SET_PATH = "packages/engine/Source/Scene/GlobeSurfaceShaderSet.js";
const TILE_UB_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts";
const WGSL_PATH =
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl";
const GLSL_PATH = "packages/engine/Source/Shaders/GlobeFS.glsl";
const TILEMAP_PATH =
  "packages/engine/Source/Assets/Textures/BlackMarble/tilemapresource.xml";

const leaf = read(LEAF_PATH);
const globe = read(GLOBE_PATH);
const tileRendering = read(TILE_RENDERING_PATH);
const shaderSet = read(SHADER_SET_PATH);
const tileUb = read(TILE_UB_PATH);
const wgslSource = read(WGSL_PATH);
const glslSource = read(GLSL_PATH);
const tilemap = read(TILEMAP_PATH);

const EPSILON = 1e-12;
/** The tolerance the three copies are held equal to. */
const DIALECT_TOLERANCE = 1e-6;

// ─── the three shipped copies, compiled ──────────────────────────────────────

/** A 2-vector in the evaluator's shape. */
function v2(x, y) {
  return { x, y, z: 0 };
}

/** Compile the WGSL copy straight out of the shader the WebGPU globe uses. */
function wgslLawFrom(source) {
  const src = stripComments(source);
  const constants = readConstants(src);
  const functions = {};
  const globals = { ...constants, __functions: functions };
  for (const name of [
    "nightImageryMagnificationFade",
    "nightImageryFadeWeight",
  ]) {
    functions[name] = compileFunction(src, name, globals);
  }
  return { constants, functions };
}

/**
 * Extract one function's parameter names and body from GLSL by brace matching.
 * The WGSL evaluator's extractor keys on `fn NAME(`, which GLSL does not write.
 *
 * @param {string} src Shader source with comments already stripped.
 * @param {string} name The function name.
 * @returns {{params: string[], body: string}} Parameters and body text.
 */
function extractGlslFunction(src, name) {
  const re = new RegExp(`\\b[A-Za-z0-9_]+\\s+${name}\\s*\\(`);
  const at = src.search(re);
  assert.ok(at >= 0, `GLSL function ${name} not found`);
  const open = src.indexOf("(", at);
  let depth = 0;
  let i = open;
  for (; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const params = src
    .slice(open + 1, i)
    .split(",")
    .map((p) => p.trim().split(/\s+/).pop())
    .filter((p) => p.length > 0);
  const brace = src.indexOf("{", i);
  depth = 0;
  let j = brace;
  for (; j < src.length; j += 1) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return { params, body: src.slice(brace + 1, j) };
}

/**
 * Compile the GLSL copy straight out of the shader the WebGL globe uses.
 *
 * The dialect transform is mechanical and narrow: a leading declaration type
 * before an assigned identifier becomes a binding keyword, and nothing else
 * changes - same operands, same calls, same order. It fails closed: anything
 * the evaluator cannot read throws rather than being quietly skipped.
 *
 * Only the scalar law is executable. `nightImageryFadeWeight` differentiates in
 * place on this backend, which is not arithmetic the evaluator can run; section
 * C holds it equal to the WGSL twin as text instead.
 *
 * @param {string} source GLSL source.
 * @returns {{constants: object, functions: object}} The constants and callables.
 */
function glslLawFrom(source) {
  const src = stripComments(source);
  const constants = {};
  const re = /^const\s+float\s+(NIGHT_IMAGERY_[A-Z0-9_]+)\s*=\s*([^;]+);/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const [numerator, denominator] = m[2].split("/").map((x) => Number(x));
    constants[m[1]] = Number.isFinite(denominator)
      ? numerator / denominator
      : numerator;
  }
  const functions = {};
  const globals = { ...constants, __functions: functions };
  const name = "nightImageryMagnificationFade";
  const { params, body } = extractGlslFunction(src, name);
  const evaluable = body.replace(
    /\b(?:float|vec2|vec3|vec4)\s+(?=[A-Za-z_][A-Za-z0-9_]*\s*=)/g,
    "let ",
  );
  functions[name] = compileFunction(
    `fn ${name}(${params.join(", ")}) -> f32 {${evaluable}}`,
    name,
    globals,
  );
  return { constants, functions };
}

const WGSL = wgslLawFrom(wgslSource);
const GLSL = glslLawFrom(glslSource);

/** The three copies, as one callable each. */
const COPIES = [
  ["JavaScript", nightImageryMagnificationFade],
  ["WGSL", WGSL.functions.nightImageryMagnificationFade],
  ["GLSL", GLSL.functions.nightImageryMagnificationFade],
];

/**
 * Reduce a shader function body to a language-neutral token stream, so the two
 * dialects can be held equal where one of them cannot be executed. The only
 * substitutions are the declaration keyword and the derivative: WGSL must take
 * its derivatives at fragment entry while control flow is still uniform and
 * receives them as parameters, where GLSL may differentiate in place.
 *
 * @param {string} text The function body.
 * @param {"wgsl"|"glsl"} dialect Which syntax to strip.
 * @returns {string} The canonical form.
 */
function canonicalise(text, dialect) {
  let t = text.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  if (dialect === "wgsl") {
    t = t
      .replace(/\b(?:let|var)\s+/g, "")
      .replace(/\s*:\s*(?:f32|vec2<f32>|vec3<f32>|vec4<f32>)\b/g, "");
  } else {
    t = t
      .replace(/\bdFdx\(rawTileTextureCoordinates\)/g, "rawTileUV_dx")
      .replace(/\bdFdy\(rawTileTextureCoordinates\)/g, "rawTileUV_dy")
      .replace(/\b(?:float|vec2|vec3|vec4)\s+(?=[A-Za-z_][A-Za-z0-9_]*)/g, "");
  }
  return t
    .replace(/\s+/g, " ")
    .replace(/\s*([(),;{}[\]*/+\-<>=!&|.])\s*/g, "$1")
    .trim();
}

/** The WGSL body of one function, read the same way the GLSL one is. */
function wgslBody(source, name) {
  return extractGlslFunction(
    stripComments(source).replace(/\bfn\s+/g, "float "),
    name,
  ).body;
}

// ─── the shipped pyramid and the banked sweep, read rather than restated ─────

/**
 * The deepest level in the bundled pyramid and its texel spacing, taken from
 * the asset's own descriptor. Rebaking deeper changes both, and this spec then
 * measures the rebaked asset instead of a stale constant.
 *
 * @returns {{unitsPerPixel: number, order: number, tileSize: number}} The asset.
 */
function shippedPyramid() {
  const sets = [
    ...tilemap.matchAll(/units-per-pixel="([0-9.]+)"\s+order="(\d+)"/g),
  ].map((m) => ({ unitsPerPixel: Number(m[1]), order: Number(m[2]) }));
  assert.ok(sets.length > 0, "the pyramid descriptor listed no tile sets");
  const deepest = sets.reduce((a, b) => (b.order > a.order ? b : a));
  const tileSize = Number(/<TileFormat width="(\d+)"/.exec(tilemap)?.[1]);
  assert.ok(tileSize > 0, "the pyramid descriptor listed no tile size");
  return { ...deepest, tileSize };
}

/**
 * How many of the deepest level's texels span one geographic terrain tile.
 *
 * Geographic level 0 is two 180-degree tiles and each level halves, so this is
 * the magnification the imagery system produces once it has clamped the imagery
 * level to the pyramid's deepest - which it does for every terrain level below
 * it, because there is nothing deeper to request.
 *
 * @param {number} terrainLevel The terrain tile's level.
 * @returns {number} Texels across that tile.
 */
function texelsAcrossTerrainTile(terrainLevel) {
  const { unitsPerPixel } = shippedPyramid();
  return 180 / 2 ** terrainLevel / unitsPerPixel;
}

/**
 * A tile/imagery pair as the packers see one, for the real resolvers.
 *
 * @param {number} terrainLevel The terrain tile's level.
 * @returns {object} A tileImagery-shaped object.
 */
function tileImageryAt(terrainLevel) {
  const { unitsPerPixel, tileSize } = shippedPyramid();
  const imageryTileWidth = unitsPerPixel * tileSize;
  const terrainTileWidth = 180 / 2 ** terrainLevel;
  const scale = terrainTileWidth / imageryTileWidth;
  return {
    textureTranslationAndScale: { x: 0, y: 0, z: scale, w: scale },
  };
}

/**
 * A marked night layer over the shipped pyramid.
 *
 * @returns {object} An ImageryLayer-shaped object.
 */
function nightLayerAt() {
  const { tileSize } = shippedPyramid();
  return markNightImageryLayer({
    imageryProvider: { tileWidth: tileSize, tileHeight: tileSize },
  });
}

/**
 * The banked level-three altitude sweep: midnight over Philadelphia, nadir,
 * 1280x720, default frustum - the capture the old thresholds were measured
 * against and found wanting. `texels` and `delta` are measured; `reading` is
 * the recorded eye-read of the paired on/off frames.
 *
 * Evidence: Tools/visual-regression/output/edge-tranche3b-2026-08-28/
 * (onset-table.json, webgl-alt*-on.png beside webgl-alt*-off.png).
 */
const BANKED_SWEEP = [
  { km: 25000, level: 1, texels: 256, delta: -27.17, reading: "legible" },
  { km: 1000, level: 6, texels: 32, delta: -17.38, reading: "legible" },
  { km: 500, level: 7, texels: 16, delta: -4.78, reading: "legible" },
  { km: 340, level: 7, texels: 16, delta: 14.16, reading: "illegible" },
  { km: 170, level: 8, texels: 8, delta: 85.32, reading: "illegible" },
  { km: 85, level: 9, texels: 4, delta: 93.95, reading: "illegible" },
];

/** Capture parameters the sweep was taken with. */
const SWEEP = Object.freeze({
  viewportWidth: 1280,
  horizontalFieldOfView: Math.PI / 3,
  ellipsoidRadius: 6378137.0,
});

/**
 * Screen pixels one imagery texel spans, at one row of the banked sweep.
 *
 * Re-derived rather than transcribed: metres per screen pixel comes from the
 * altitude and the frustum the capture pinned, the terrain tile's ground height
 * from its recorded level under the geographic tiling scheme, and the texel
 * count across that tile is the sweep's own measurement. The latitude axis
 * governs at nadir, because a geographic tile is square in degrees while a
 * degree of longitude is shorter than a degree of latitude away from the
 * equator, so it is the more magnified of the two.
 *
 * @param {{km: number, level: number, texels: number}} row One sweep row.
 * @returns {number} Screen pixels per imagery texel.
 */
function screenPixelsPerTexel(row) {
  const metresPerPixel =
    (2 * row.km * 1000 * Math.tan(SWEEP.horizontalFieldOfView / 2)) /
    SWEEP.viewportWidth;
  const tileGroundHeight =
    ((180 / 2 ** row.level) * Math.PI * SWEEP.ellipsoidRadius) / 180;
  return tileGroundHeight / metresPerPixel / row.texels;
}

// ─── A. the law, executed out of all three copies ────────────────────────────

test("A1: at and above its own resolution the weight is EXACTLY 1.0", () => {
  // Not "close to 1": the showcase altitudes must render the same bytes they
  // rendered before the fade existed, and a 0.9999 weight is a different image.
  for (const [name, law] of COPIES) {
    for (const texelsPerPixel of [
      NIGHT_IMAGERY_FADE_FULL_TEXELS_PER_PIXEL,
      0.0625000001,
      0.125,
      0.5,
      1,
      64,
      1e9,
      Infinity,
    ]) {
      assert.equal(
        law(texelsPerPixel),
        1.0,
        `${name}: ${texelsPerPixel} texels per pixel must not touch the layer`,
      );
    }
  }
});

test("A2: past the far knee the weight is EXACTLY 0.0", () => {
  // A weight that merely approaches zero leaves an opaque layer opaque, and the
  // wash survives the fix at reduced contrast.
  for (const [name, law] of COPIES) {
    for (const texelsPerPixel of [
      NIGHT_IMAGERY_FADE_ZERO_TEXELS_PER_PIXEL,
      0.015624,
      0.004,
      1e-9,
    ]) {
      assert.equal(
        law(texelsPerPixel),
        0.0,
        `${name}: ${texelsPerPixel} texels per pixel is a flat wash`,
      );
    }
  }
});

test("A3: in between it is monotone, bounded, and has no flat step", () => {
  for (const [name, law] of COPIES) {
    let previous = -Infinity;
    let moved = 0;
    for (let i = 0; i <= 200; i++) {
      // Sample the band in log space, which is how magnification travels.
      const texelsPerPixel =
        NIGHT_IMAGERY_FADE_ZERO_TEXELS_PER_PIXEL *
        2 ** ((i / 200) * NIGHT_IMAGERY_FADE_BAND_OCTAVES);
      const value = law(texelsPerPixel);
      assert.ok(
        value >= 0 && value <= 1,
        `${name}: the weight must be an alpha`,
      );
      assert.ok(
        value >= previous - EPSILON,
        `${name}: less magnification must never mean less layer`,
      );
      if (value > previous + EPSILON) {
        moved += 1;
      }
      previous = value;
    }
    assert.ok(
      moved > 150,
      `${name}: the band must be a ramp, not a step: it moved on ${moved} of 201 samples`,
    );
  }
});

test("A4: an unmeasurable footprint leaves the layer alone", () => {
  // Fail-open. A zero footprint is what a degenerate screen-space derivative
  // produces, and erasing the layer there would draw a dark hairline through
  // the frame; a NaN is a bug somewhere upstream, and erasing the layer would
  // turn it into a blank night side that looks like a rendering fault.
  for (const [name, law] of COPIES) {
    assert.equal(law(0), 1.0, `${name}: a zero footprint`);
    assert.equal(law(NaN), 1.0, `${name}: a NaN footprint`);
    assert.equal(law(-1), 1.0, `${name}: a negative footprint`);
  }
});

test("A5: the three copies agree everywhere, to 1e-6", () => {
  // The whole point of executing all three: a constant that drifts in one
  // dialect makes the two backends disappear the layer at different altitudes.
  const [, js] = COPIES[0];
  for (let i = -40; i <= 40; i += 1) {
    const texelsPerPixel =
      NIGHT_IMAGERY_FADE_ZERO_TEXELS_PER_PIXEL * 2 ** (i / 8);
    const reference = js(texelsPerPixel);
    for (const [name, law] of COPIES.slice(1)) {
      assert.ok(
        Math.abs(law(texelsPerPixel) - reference) < DIALECT_TOLERANCE,
        `${name} disagrees at ${texelsPerPixel}: ${law(texelsPerPixel)} vs ${reference}`,
      );
    }
  }
});

test("A6: the three copies carry the same constants", () => {
  const wanted = {
    NIGHT_IMAGERY_FADE_FULL_TEXELS_PER_PIXEL,
    NIGHT_IMAGERY_FADE_ZERO_TEXELS_PER_PIXEL,
    NIGHT_IMAGERY_FADE_BAND_OCTAVES,
  };
  for (const [name, constants] of [
    ["WGSL", WGSL.constants],
    ["GLSL", GLSL.constants],
  ]) {
    for (const [key, value] of Object.entries(wanted)) {
      assert.equal(constants[key], value, `${name} ${key}`);
    }
  }
  // The band width is derived from the pair, not chosen beside it, so moving a
  // knee cannot leave the ramp reaching its endpoint early or late.
  assert.equal(
    NIGHT_IMAGERY_FADE_BAND_OCTAVES,
    Math.log2(
      NIGHT_IMAGERY_FADE_FULL_TEXELS_PER_PIXEL /
        NIGHT_IMAGERY_FADE_ZERO_TEXELS_PER_PIXEL,
    ),
  );
});

// ─── B. the weight is continuous across a terrain LOD seam ───────────────────

/**
 * One side of a synthetic seam: a terrain tile at `level`, carrying the deepest
 * pyramid level's texels, rendered at a size on screen that follows from the
 * level alone.
 *
 * A tile one level finer covers half the ground and is therefore half the size
 * on screen at the same distance, so both sides of a real seam are built from
 * one `groundPixelsAtLevelZero` figure and the level.
 *
 * @param {number} level The terrain level.
 * @param {number} groundPixelsAtLevelZero Screen pixels a level-zero tile spans.
 * @returns {object} The derivative pair, scale, and tile size for the weight.
 */
function seamSide(level, groundPixelsAtLevelZero) {
  const { tileSize } = shippedPyramid();
  const scale = tileImageryAt(level).textureTranslationAndScale.z;
  const screenPixels = groundPixelsAtLevelZero / 2 ** level;
  const derivative = 1 / screenPixels;
  return {
    scale: v2(scale, scale),
    dx: v2(derivative, 0),
    dy: v2(0, derivative),
    tilePixels: tileSize,
    screenPixels,
  };
}

test("B1: two tiles a level apart resolve the SAME weight at a seam", () => {
  // The defect this measure exists to remove. Terrain levels ten and eleven
  // straddled the old band at one altitude and rendered hard-edged bands; the
  // magnification is identical on both sides, so the weight must be too.
  const weight = WGSL.functions.nightImageryFadeWeight;
  // Sweep the seam across the whole band and past both ends, so the property is
  // checked where the weight is moving rather than only where it is pinned.
  for (let i = 0; i <= 60; i += 1) {
    const groundPixels = 2 ** (8 + (i / 60) * 12);
    for (const level of [7, 8, 9, 10, 11]) {
      const coarse = seamSide(level, groundPixels);
      const fine = seamSide(level + 1, groundPixels);
      const a = weight(coarse.dx, coarse.dy, coarse.scale, coarse.tilePixels);
      const b = weight(fine.dx, fine.dy, fine.scale, fine.tilePixels);
      assert.ok(
        Math.abs(a - b) < DIALECT_TOLERANCE,
        `levels ${level}/${level + 1} at ${groundPixels} ground pixels: ${a} vs ${b}`,
      );
    }
  }
});

test("B2: the seam is not trivially continuous — the band is crossed", () => {
  // Without this, the test above would pass on a weight pinned at any constant.
  const weight = WGSL.functions.nightImageryFadeWeight;
  const seen = new Set();
  for (let i = 0; i <= 60; i += 1) {
    const groundPixels = 2 ** (8 + (i / 60) * 12);
    const side = seamSide(9, groundPixels);
    const w = weight(side.dx, side.dy, side.scale, side.tilePixels);
    seen.add(w === 0 ? "zero" : w === 1 ? "one" : "partial");
  }
  assert.deepEqual(
    [...seen].sort(),
    ["one", "partial", "zero"],
    "the sweep must pass through both endpoints and the ramp between them",
  );
});

test("B3: the weight follows the tile's size on screen at a fixed level", () => {
  // The property a texel count per tile cannot express, and the reason the
  // banked sweep read one terrain level as legible at one altitude and
  // illegible at another. A tile at a fixed level carries a fixed number of
  // texels, so growing it on screen spreads each of them over more pixels: more
  // magnified, less layer.
  const weight = WGSL.functions.nightImageryFadeWeight;
  let previous = Infinity;
  for (let i = 0; i <= 40; i += 1) {
    const side = seamSide(8, 2 ** (10 + (i / 40) * 10));
    const w = weight(side.dx, side.dy, side.scale, side.tilePixels);
    assert.ok(w <= previous + EPSILON, "more screen per tile, less layer");
    previous = w;
  }
  const compact = seamSide(8, 2 ** 11);
  const spread = seamSide(8, 2 ** 17);
  assert.ok(
    weight(spread.dx, spread.dy, spread.scale, spread.tilePixels) <
      weight(compact.dx, compact.dy, compact.scale, compact.tilePixels),
    "a tile spread over more screen is more magnified, and must fade more",
  );
});

test("B4: a layer that does not fade is left at exactly 1.0", () => {
  // The zero tile size is the sentinel every non-night layer packs. The weight
  // takes an early return on it, which keeps two square roots and a logarithm
  // off every layer of every globe that has no night imagery; the assertion is
  // that the branch and the arithmetic agree, so the shortcut can never become
  // a second answer.
  const weight = WGSL.functions.nightImageryFadeWeight;
  for (const groundPixels of [2 ** 8, 2 ** 14, 2 ** 20]) {
    const side = seamSide(12, groundPixels);
    assert.equal(weight(side.dx, side.dy, side.scale, 0), 1.0);
    // The arithmetic the branch skips, evaluated: a zero tile size makes the
    // footprint zero, and the law answers a footprint that is not positive with
    // full strength. Same number, so the early return is a cost saving and not
    // a behaviour.
    assert.equal(nightImageryMagnificationFade(0), 1.0);
  }
});

// ─── C. the two dialects hold the same weight function ───────────────────────

test("C1: the GLSL and WGSL magnification laws are the same arithmetic", () => {
  const name = "nightImageryMagnificationFade";
  assert.equal(
    canonicalise(
      extractGlslFunction(stripComments(glslSource), name).body,
      "glsl",
    ),
    canonicalise(wgslBody(wgslSource, name), "wgsl"),
    "the GLSL law has drifted from the WGSL one",
  );
});

test("C2: the GLSL and WGSL fade weights are the same arithmetic", () => {
  // This half is not executable on the WebGL side - it differentiates in place,
  // which is not arithmetic - so it is held equal as text with exactly two
  // documented substitutions: the declaration keyword, and the derivative that
  // WGSL must hoist to fragment entry and receive as a parameter.
  const name = "nightImageryFadeWeight";
  assert.equal(
    canonicalise(
      extractGlslFunction(stripComments(glslSource), name).body,
      "glsl",
    ),
    canonicalise(wgslBody(wgslSource, name), "wgsl"),
    "the GLSL weight has drifted from the WGSL one",
  );
});

test("C3: both dialects differentiate the RAW tile UV, not the clamped one", () => {
  // The seam clamp can collapse both lanes of an edge quad onto the same value.
  // A zero footprint reads as unmeasurable and returns the layer at full
  // strength, which draws a bright hairline around every tile in the band.
  assert.match(
    shaderSet,
    /u_dayTextureUseWebMercatorT\[\$\{i\}\] \? v_textureCoordinates\.xz : v_textureCoordinates\.xy/,
    "the WebGL call site must pass the unclamped varying",
  );
  assert.match(
    wgslSource,
    /let rawGeoUV_dx = vectorUV_dx;/,
    "the WebGPU hoist must reuse the raw Jacobian",
  );
  assert.match(
    wgslSource,
    /let rawWebMercUV_dx = vec2<f32>\(vectorUV_dx\.x, dpdx\(input\.v_textureCoordinates\.z\)\);/,
  );
});

// ─── D. the thresholds, against the banked sweep that measured them ──────────

test("D1: the shipped pyramid is what the numbers below are measured from", () => {
  const { order, unitsPerPixel, tileSize } = shippedPyramid();
  assert.equal(tileSize, 256, "a rebake changed the tile size");
  assert.ok(order >= 0, "the pyramid must declare a deepest level");
  assert.ok(
    Math.abs(unitsPerPixel - 180 / (2 ** order * tileSize)) < 1e-9,
    "the descriptor's spacing does not match its own level and tile size",
  );
});

test("D2: the banked sweep's texel counts are the shipped pyramid's", () => {
  // The rows are only evidence for this asset. A rebake that moves the texel
  // counts must fail here rather than silently recalibrate the knees.
  //
  // Only the rows the pyramid clamps: above its deepest level the imagery
  // system serves the terrain level itself at one texel per terrain texel,
  // which is what the sweep's 25,000 km row records and what the clamped
  // arithmetic below does not describe.
  const { order } = shippedPyramid();
  const clamped = BANKED_SWEEP.filter((r) => r.level >= order);
  assert.ok(clamped.length >= 4, "the sweep must still exercise the clamp");
  for (const row of clamped) {
    assert.ok(
      Math.abs(texelsAcrossTerrainTile(row.level) - row.texels) < 1e-9,
      `level ${row.level}: banked ${row.texels}, shipped ${texelsAcrossTerrainTile(row.level)}`,
    );
  }
});

test("D3: every altitude the banked sweep read as legible keeps the layer", () => {
  // Read off the paired frames: at 500 km and above the layer is a recognizable
  // light map, and the on-vs-off luma delta is a DARKENING, which is the layer
  // doing its job. The weight must not retire it there.
  for (const row of BANKED_SWEEP.filter((r) => r.reading === "legible")) {
    const weight = nightImageryMagnificationFade(1 / screenPixelsPerTexel(row));
    assert.ok(
      weight > 0.85,
      `${row.km} km (${screenPixelsPerTexel(row).toFixed(1)} px/texel) must keep the layer, got ${weight}`,
    );
    assert.ok(row.delta < 0, `precondition: ${row.km} km darkened`);
  }
  // The altitudes furthest inside that range keep it untouched.
  for (const row of BANKED_SWEEP.filter((r) => r.km >= 1000)) {
    assert.equal(
      nightImageryMagnificationFade(1 / screenPixelsPerTexel(row)),
      1.0,
      `${row.km} km must be byte-for-byte what it renders today`,
    );
  }
});

test("D4: the illegible band the sweep measured is retired", () => {
  // 170 km was the worst frame in the sweep - a near-featureless smear over a
  // scene that is sharp with the layer off, at a +85 luma delta while the old
  // measure still held the layer at full strength. It and everything more
  // magnified must be gone.
  for (const row of BANKED_SWEEP.filter((r) => r.km <= 170)) {
    const weight = nightImageryMagnificationFade(1 / screenPixelsPerTexel(row));
    assert.ok(
      weight < 0.01,
      `${row.km} km (${screenPixelsPerTexel(row).toFixed(1)} px/texel) must be retired, got ${weight}`,
    );
    assert.ok(row.delta > 0, `precondition: ${row.km} km brightened`);
  }
  // 340 km read as an illegible wash too, and is the shallowest altitude that
  // did. It sits inside the ramp rather than past it, so the layer thins out
  // there instead of vanishing between one frame and the next.
  const row340 = BANKED_SWEEP.find((r) => r.km === 340);
  const weight340 = nightImageryMagnificationFade(
    1 / screenPixelsPerTexel(row340),
  );
  assert.ok(
    weight340 > 0.2 && weight340 < 0.7,
    `340 km must be mid-ramp, got ${weight340}`,
  );
});

test("D5: the sweep's two same-level rows are what moved the measure", () => {
  // 500 km and 340 km are BOTH terrain level seven at sixteen texels across the
  // tile - identical under the old measure, and read as legible and illegible
  // respectively. Any measure that resolves them equally cannot separate them,
  // which is the finding, executed.
  const legible = BANKED_SWEEP.find((r) => r.km === 500);
  const illegible = BANKED_SWEEP.find((r) => r.km === 340);
  assert.equal(legible.level, illegible.level);
  assert.equal(legible.texels, illegible.texels);
  assert.ok(
    screenPixelsPerTexel(illegible) > 1.4 * screenPixelsPerTexel(legible),
    "the screen footprint must separate what the texel count could not",
  );
  assert.ok(
    nightImageryMagnificationFade(1 / screenPixelsPerTexel(legible)) >
      nightImageryMagnificationFade(1 / screenPixelsPerTexel(illegible)) + 0.25,
    "and the weight must follow it",
  );
});

test("D6: the banded altitude's two levels are one magnification", () => {
  // 42 km rendered hard-edged bands: terrain level ten at two texels and level
  // eleven at one, side by side, resolving 0.259 and 0.000 under a per-tile
  // texel count. Their screen footprints are equal, so the new measure gives
  // them one weight - and at that magnification it is zero on both.
  const ten = { km: 42, level: 10, texels: 2 };
  const eleven = { km: 42, level: 11, texels: 1 };
  assert.ok(
    Math.abs(screenPixelsPerTexel(ten) - screenPixelsPerTexel(eleven)) < 1e-6,
    `${screenPixelsPerTexel(ten)} vs ${screenPixelsPerTexel(eleven)}`,
  );
  for (const row of [ten, eleven]) {
    assert.equal(
      nightImageryMagnificationFade(1 / screenPixelsPerTexel(row)),
      0.0,
    );
  }
});

// ─── E. the per-tile retirement is a bound, not the fade ─────────────────────

test("E1: the retirement bound is inside the retired region by a wide margin", () => {
  // The CPU drops a layer from a tile so it takes no texture slot. That drop is
  // a step, so it must only ever fire where the per-fragment weight is already
  // zero on every fragment of the tile - otherwise it is the very seam the
  // weight exists to remove, moved one level down.
  //
  // A fragment's footprint is the tile's texel count over the tile's size on
  // screen. At the bound the count is one texel, so the footprint is past the
  // far knee for any tile at least sixty-four pixels across - the reciprocal of
  // the far knee - and terrain selection holds a rendered tile at hundreds.
  const weight = WGSL.functions.nightImageryFadeWeight;
  const { tileSize } = shippedPyramid();
  const scale = NIGHT_IMAGERY_RETIRE_TEXELS_ACROSS_TILE / tileSize;
  assert.equal(
    1 / NIGHT_IMAGERY_FADE_ZERO_TEXELS_PER_PIXEL,
    64,
    "the margin below is stated against this reciprocal",
  );
  for (const screenPixels of [64, 128, 260, 512, 4096]) {
    const derivative = 1 / screenPixels;
    assert.equal(
      weight(v2(derivative, 0), v2(0, derivative), v2(scale, scale), tileSize),
      0.0,
      `a retired tile ${screenPixels} px across still carried weight`,
    );
  }
});

test("E2: the bound retires the altitudes the sweep measured as absent", () => {
  const layer = nightLayerAt();
  for (let level = 11; level <= 20; level += 1) {
    assert.equal(
      nightImageryTileIsRetired(layer, tileImageryAt(level)),
      true,
      `terrain level ${level} (${texelsAcrossTerrainTile(level)} texels) must take no slot`,
    );
  }
  // And keeps every level the sweep still had the layer on screen at.
  for (let level = 0; level <= 10; level += 1) {
    assert.equal(
      nightImageryTileIsRetired(layer, tileImageryAt(level)),
      false,
      `terrain level ${level} must still be packed`,
    );
  }
});

test("E3: an unmeasurable tile keeps the layer", () => {
  const layer = nightLayerAt();
  assert.equal(nightImageryTileIsRetired(layer, {}), false);
  assert.equal(nightImageryTileIsRetired(layer, undefined), false);
  assert.equal(
    nightImageryTileIsRetired(layer, {
      textureTranslationAndScale: { z: NaN, w: NaN },
    }),
    false,
  );
});

test("E4: the more magnified axis governs the bound", () => {
  // A layer stretched on one axis carries no structure on it, and crediting the
  // other axis would keep a smeared layer alive over the scene.
  const layer = nightLayerAt();
  assert.equal(
    nightImageryTileIsRetired(layer, {
      textureTranslationAndScale: { z: 1, w: 1 / 1024 },
    }),
    true,
  );
});

// ─── F. the fade is SCOPED to the layer the globe attached ───────────────────

test("F1: a layer the globe did not attach never fades and is never retired", () => {
  const foreign = { imageryProvider: { tileWidth: 256, tileHeight: 256 } };
  assert.equal(isNightImageryLayer(foreign), false);
  assert.equal(resolveNightImageryFadeTilePixels(foreign), 0.0);
  for (let level = 0; level <= 20; level += 1) {
    assert.equal(
      nightImageryTileIsRetired(foreign, tileImageryAt(level)),
      false,
      `an unmarked layer must not be retired at terrain level ${level}`,
    );
  }
  assert.equal(isNightImageryLayer(undefined), false);
  assert.equal(resolveNightImageryFadeTilePixels(undefined), 0.0);
});

test("F2: the marked layer reports its own provider's tile size", () => {
  // The band is where the magnification is, not where the altitude is: a
  // provider with larger tiles keeps its layer for one more level, which is
  // exactly what buying more source pixels should do.
  const small = markNightImageryLayer({
    imageryProvider: { tileWidth: 256, tileHeight: 256 },
  });
  const large = markNightImageryLayer({
    imageryProvider: { tileWidth: 512, tileHeight: 512 },
  });
  assert.equal(resolveNightImageryFadeTilePixels(small), 256);
  assert.equal(resolveNightImageryFadeTilePixels(large), 512);
  const weight = WGSL.functions.nightImageryFadeWeight;
  // Placed so the 256-pixel provider lands mid-band; past the far knee both
  // answers are zero and the comparison would be vacuous.
  const screenPixels = 300;
  const midBand = NIGHT_IMAGERY_FADE_ZERO_TEXELS_PER_PIXEL * 2;
  const scaleValue = (midBand * screenPixels) / 256;
  const scale = v2(scaleValue, scaleValue);
  const dx = v2(1 / screenPixels, 0);
  const dy = v2(0, 1 / screenPixels);
  assert.ok(
    weight(dx, dy, scale, 256) > 0 && weight(dx, dy, scale, 256) < 1,
    "precondition: the smaller provider is inside the band",
  );
  assert.ok(
    weight(dx, dy, scale, 512) > weight(dx, dy, scale, 256),
    "twice the pixels, twice the texels, more layer",
  );
});

test("F3: a provider that reports no tile size falls back rather than vanishing", () => {
  const layer = markNightImageryLayer({ imageryProvider: {} });
  assert.equal(resolveNightImageryFadeTilePixels(layer), 256);
});

test("F4: the globe marks the layer it attaches, at the attachment site", () => {
  assert.match(
    globe,
    /const layer = ImageryLayer\.fromProviderAsync\(\s*provider,\s*NIGHT_IMAGERY_LAYER_OPTIONS,\s*\);[\s\S]{0,400}?markNightImageryLayer\(layer\);\s*globe\._nightImageryLayer = layer;/,
    "a layer that reaches the collection unmarked never fades",
  );
});

test("F5: the marker is not carried by the frozen layer options", () => {
  assert.doesNotMatch(
    leaf,
    /NIGHT_IMAGERY_LAYER_OPTIONS = Object\.freeze\(\{[^}]*_isGlobeNightImagery/,
  );
});

// ─── G. both packers feed it, from one law ───────────────────────────────────

test("G1: WebGL sends the tile size and retires the tile by the shared bound", () => {
  assert.match(
    tileRendering,
    /if \(nightImageryTileIsRetired\(imageryLayer, tileImagery\)\) \{\s*continue;\s*\}/,
    "a retired layer must take no texture slot",
  );
  assert.match(
    tileRendering,
    /uniformMapProperties\.dayTextureNightFadeTilePixels\[numberOfDayTextures\] =\s*resolveNightImageryFadeTilePixels\(imageryLayer\);/,
  );
  assert.match(
    tileRendering,
    /u_dayTextureNightFadeTilePixels: function \(\) \{\s*return this\.properties\.dayTextureNightFadeTilePixels;\s*\},/,
    "the slot must reach a uniform the shader declares",
  );
  assert.match(
    glslSource,
    /uniform float u_dayTextureNightFadeTilePixels\[TEXTURE_UNITS\];/,
  );
});

test("G2: WebGPU sends the same number in the per-layer slot", () => {
  assert.match(
    tileUb,
    /if \(nightImageryTileIsRetired\(imagery\.imageryLayer, tileImagery\)\) \{\s*continue;\s*\}/,
  );
  assert.match(
    tileUb,
    /data\[baseOffset \+ 23\] = resolveNightImageryFadeTilePixels\(layer\);/,
  );
  assert.match(wgslSource, /\n {2}nightFadeTilePixels: f32,\n\};/);
});

test("G3: neither packer folds a weight into the night alpha any more", () => {
  // The weight is per fragment now. A packer that still folded one in would
  // apply it twice, and would reintroduce the per-tile step it folded.
  for (const [name, source] of [
    ["WebGL", tileRendering],
    ["WebGPU", tileUb],
  ]) {
    assert.doesNotMatch(
      source,
      /NightAlpha\[numberOfDayTextures\] \*=|data\[dnFloatBase \+ 1\] \*=/,
      `${name} must pack the night alpha unfaded`,
    );
    assert.doesNotMatch(
      source,
      /NIGHT_IMAGERY_FADE_(FULL|ZERO)_TEXELS_PER_PIXEL/,
      `${name} must read the law, not a second copy of its thresholds`,
    );
  }
});

test("G4: the day alpha is NOT faded", () => {
  // The fade is a night-side property. Touching the day alpha would change a
  // layer that is already invisible in daylight, for no reason, and would make
  // the day/night gate's condition depend on altitude.
  assert.match(
    wgslSource,
    /let dayNightAlphaValue = mix\(effectiveNightAlpha, dayNightAlpha\.x, dayFade\);/,
  );
  assert.match(
    glslSource,
    /textureAlpha \*= mix\(textureDayAlpha, effectiveNightAlpha, nightBlend\);/,
  );
});

/**
 * The weight the composite applies comes from the fragment's own footprint, on
 * both backends, and every unrolled WGSL slot feeds it the raw Jacobian.
 *
 * This is the seam between the law and the pixels. Everything else in section G
 * would stay green with a weight pinned at one: the constants would still be
 * shared, the blend would still read `effectiveNightAlpha`, the emission would
 * still carry a factor - and the layer would never fade.
 *
 * @param {string} wgsl The WGSL globe shader.
 * @param {string} shaderSetSource The generated WebGL call site.
 * @param {string} glsl The GLSL globe shader.
 * @returns {boolean} Whether the weight is resolved per fragment on both.
 */
function weightIsWired(wgsl, shaderSetSource, glsl) {
  return (
    /let nightFade = nightImageryFadeWeight\(rawTileUV_dx, rawTileUV_dy, layer\.translationAndScale\.zw, layer\.nightFadeTilePixels\);/.test(
      wgsl,
    ) &&
    (
      wgsl.match(
        /let rawUV_dx = selectLayerUVDerivative\(rawGeoUV_dx, rawWebMercUV_dx, useWMT\);/g,
      ) ?? []
    ).length === 16 &&
    (wgsl.match(/applyImageryLayer\([^)]*, rawUV_dx, rawUV_dy\);/g) ?? [])
      .length === 16 &&
    /g_nightImageryFade = nightImageryFadeWeight\(\s*rawTileTextureCoordinates,\s*textureCoordinateTranslationAndScale\.zw,\s*nightFadeTilePixels\);/.test(
      glsl,
    ) &&
    /u_dayTextureUseWebMercatorT\[\$\{i\}\] \? v_textureCoordinates\.xz : v_textureCoordinates\.xy/.test(
      shaderSetSource,
    )
  );
}

test("G6: the weight the composite applies is the fragment's own footprint", () => {
  assert.equal(weightIsWired(wgslSource, shaderSet, glslSource), true);
});

test("G7: INERTNESS — a weight pinned at one in either shader is REJECTED", () => {
  // The mutant every other pin in this file survives: the call replaced by the
  // constant it returns at the near knee. Nothing else changes shape, and the
  // layer never fades at any altitude.
  const wgslPinned = mutate(
    wgslSource,
    "let nightFade = nightImageryFadeWeight(rawTileUV_dx, rawTileUV_dy, layer.translationAndScale.zw, layer.nightFadeTilePixels);",
    "let nightFade = 1.0;",
  );
  assert.equal(weightIsWired(wgslPinned, shaderSet, glslSource), false);
  const glslPinned = mutate(
    glslSource,
    "    g_nightImageryFade = nightImageryFadeWeight(\n        rawTileTextureCoordinates,\n        textureCoordinateTranslationAndScale.zw,\n        nightFadeTilePixels);",
    "    g_nightImageryFade = 1.0;",
  );
  assert.equal(weightIsWired(wgslSource, shaderSet, glslPinned), false);
  // ...and one unrolled slot left on the clamped Jacobian is the same failure
  // with fifteen slots still correct: that slot's layer would fade at a
  // different rate from its neighbours, which is the seam again.
  const oneSlotStale = wgslSource.replace(
    "let rawUV_dx = selectLayerUVDerivative(rawGeoUV_dx, rawWebMercUV_dx, useWMT);",
    "let rawUV_dx = uv_dx;",
  );
  assert.notEqual(oneSlotStale, wgslSource);
  assert.equal(weightIsWired(oneSlotStale, shaderSet, glslSource), false);
});

test("G5: the emission thins out with the layer rather than snapping off", () => {
  // The gate reads the layer's configured pair, so what makes a layer city
  // lights does not depend on the camera; the weight scales the emission.
  for (const [name, source, term] of [
    [
      "WGSL",
      wgslSource,
      /let emission = layerColor \* lum \* nightBlend \* nightIntensity \* isNightLayer \* magnificationFade;/,
    ],
    [
      "GLSL",
      glslSource,
      /vec3 emission = layerColor \* lum \* nightBlend \* nightIntensity \* isNightLayer \* magnificationFade;/,
    ],
  ]) {
    assert.match(source, term, `${name} emission`);
  }
  assert.match(
    wgslSource,
    /applyNightLightsEmission\(color, r\.adjustedColor, nightBlend, dna\.y, dna\.x, r\.nightFade\);/,
  );
  assert.match(
    shaderSet,
    /applyNightLightsEmission\(color\.rgb, g_nightLightsLayerColor, nightBlend, u_dayTextureNightAlpha\[\$\{i\}\], u_dayTextureDayAlpha\[\$\{i\}\], g_nightImageryFade\)/,
  );
});

// ─── H. MUTANTS — absence, inertness, and the wrong measure ──────────────────

/** All mutation is IN MEMORY. No file is written, so a throw leaves no mess. */
function mutate(source, from, to) {
  assert.ok(
    source.includes(from),
    `mutation precondition failed: "${from.slice(0, 70)}..." not present`,
  );
  return source.replace(from, to);
}

const leafAbsolute = path.join(root, LEAF_PATH);
let mutantSerial = 0;

/**
 * Import a mutated COPY of the leaf, written beside the original so the
 * module's own relative imports still resolve, and removed again in a
 * `finally`. The original file is never opened for writing.
 *
 * @param {string} source The mutated module text.
 * @param {Function} assertion Receives the imported mutant.
 * @returns {Promise<void>} Resolves once the copy is removed.
 */
async function withMutantLeaf(source, assertion) {
  mutantSerial += 1;
  const mutantPath = path.join(
    path.dirname(leafAbsolute),
    `GlobeNightImageryMagnificationFadeMutant${process.pid}_${mutantSerial}.js`,
  );
  fs.writeFileSync(mutantPath, source);
  try {
    await assertion(await import(pathToFileURL(mutantPath).href));
  } finally {
    fs.rmSync(mutantPath, { force: true });
    assert.equal(
      fs.existsSync(mutantPath),
      false,
      "the mutant copy was not removed",
    );
  }
}

/** The predicates under test, as functions of a law so mutants can run them. */
function lawRetiresTheWash(law) {
  return (
    law(1 / 256) === 0.0 &&
    law(1 / 8) === 1.0 &&
    law(1 / 32) > 0.0 &&
    law(1 / 32) < 1.0
  );
}

function weightIsSeamContinuous(weight) {
  // Every level pair, not one: a measure keyed on the wrong quantity steps
  // where ITS band falls, which is not where this one's does.
  for (let level = 4; level <= 12; level += 1) {
    for (let i = 0; i <= 40; i += 1) {
      const groundPixels = 2 ** (8 + (i / 40) * 12);
      const coarse = seamSide(level, groundPixels);
      const fine = seamSide(level + 1, groundPixels);
      if (
        Math.abs(
          weight(coarse.dx, coarse.dy, coarse.scale, coarse.tilePixels) -
            weight(fine.dx, fine.dy, fine.scale, fine.tilePixels),
        ) >= DIALECT_TOLERANCE
      ) {
        return false;
      }
    }
  }
  return true;
}

test("H1: INERTNESS — a weight pinned at full strength is REJECTED", async () => {
  await withMutantLeaf(
    mutate(
      leaf,
      "export function nightImageryMagnificationFade(texelsPerPixel) {",
      "export function nightImageryMagnificationFade(texelsPerPixel) {\n  return 1.0;",
    ),
    (mutant) => {
      assert.equal(
        lawRetiresTheWash(mutant.nightImageryMagnificationFade),
        false,
      );
    },
  );
});

test("H2: WRONG DIRECTION — a ramp that rises with magnification is REJECTED", async () => {
  await withMutantLeaf(
    mutate(
      leaf,
      "  const weight = t * t * (3.0 - 2.0 * t);",
      "  const weight = 1.0 - t * t * (3.0 - 2.0 * t);",
    ),
    (mutant) => {
      const law = mutant.nightImageryMagnificationFade;
      assert.ok(
        law(1 / 32) > law(1 / 24),
        "precondition: the inverted ramp is the wrong way round",
      );
      let previous = -Infinity;
      let reversed = false;
      for (let i = 0; i <= 40; i++) {
        const value = law(
          NIGHT_IMAGERY_FADE_ZERO_TEXELS_PER_PIXEL * 2 ** ((i / 40) * 2),
        );
        if (value < previous - EPSILON) {
          reversed = true;
        }
        previous = value;
      }
      assert.equal(reversed, true, "the inverted ramp must be caught");
    },
  );
});

test("H3: THE OLD MEASURE — a per-tile texel count is REJECTED at the seam", () => {
  // The defect itself, as a mutant: a weight that reads how many texels span
  // the tile instead of how many screen pixels one texel spans. It is monotone,
  // bounded, exact at both ends and scoped - every property the endpoint checks
  // look at - and it steps at every terrain LOD seam.
  const perTile = mutate(
    wgslSource,
    "  let footprintX = length(rawTileUV_dx * texelScale);\n  let footprintY = length(rawTileUV_dy * texelScale);",
    "  let footprintX = texelScale.x / 512.0;\n  let footprintY = texelScale.y / 512.0;",
  );
  const mutant = wgslLawFrom(perTile).functions;
  assert.equal(
    lawRetiresTheWash(mutant.nightImageryMagnificationFade),
    true,
    "precondition: the law itself is untouched, so the endpoint checks still pass",
  );
  assert.equal(
    weightIsSeamContinuous(mutant.nightImageryFadeWeight),
    false,
    "a per-tile texel count must be caught by the seam",
  );
  assert.equal(
    weightIsSeamContinuous(WGSL.functions.nightImageryFadeWeight),
    true,
    "and the real weight must survive it",
  );
});

test("H4: INERTNESS — a weight function that ignores the footprint is REJECTED", () => {
  const pinned = mutate(
    wgslSource,
    "  return nightImageryMagnificationFade(min(footprintX, footprintY));",
    "  return nightImageryMagnificationFade(0.0);",
  );
  const weight = wgslLawFrom(pinned).functions.nightImageryFadeWeight;
  const side = seamSide(12, 2 ** 20);
  assert.equal(
    weight(side.dx, side.dy, side.scale, side.tilePixels),
    1.0,
    "precondition: the mutant never fades",
  );
  assert.equal(
    WGSL.functions.nightImageryFadeWeight(
      side.dx,
      side.dy,
      side.scale,
      side.tilePixels,
    ),
    0.0,
  );
});

test("H5: INERTNESS — a scope check that says yes to everything is REJECTED", async () => {
  await withMutantLeaf(
    mutate(
      leaf,
      "export function resolveNightImageryFadeTilePixels(layer) {\n  if (!isNightImageryLayer(layer)) {",
      "export function resolveNightImageryFadeTilePixels(layer) {\n  if (false) {",
    ),
    (mutant) => {
      const foreign = { imageryProvider: { tileWidth: 256, tileHeight: 256 } };
      assert.equal(
        mutant.resolveNightImageryFadeTilePixels(foreign),
        256,
        "precondition: the mutant would fade a layer the globe never attached",
      );
      assert.equal(resolveNightImageryFadeTilePixels(foreign), 0.0);
    },
  );
});

test("H6: INERTNESS — a retirement that can never fire is REJECTED", () => {
  const webgl = mutate(
    tileRendering,
    "      if (nightImageryTileIsRetired(imageryLayer, tileImagery)) {",
    "      if (false && nightImageryTileIsRetired(imageryLayer, tileImagery)) {",
  );
  assert.doesNotMatch(
    webgl,
    /if \(nightImageryTileIsRetired\(imageryLayer, tileImagery\)\) \{\s*continue;\s*\}/,
  );
  const webgpu = mutate(
    tileUb,
    "    if (nightImageryTileIsRetired(imagery.imageryLayer, tileImagery)) {",
    "    if (false && nightImageryTileIsRetired(imagery.imageryLayer, tileImagery)) {",
  );
  assert.doesNotMatch(
    webgpu,
    /if \(nightImageryTileIsRetired\(imagery\.imageryLayer, tileImagery\)\) \{\s*continue;\s*\}/,
  );
});

test("H7: ABSENCE — a packer that drops the tile size is REJECTED", () => {
  const webgl = mutate(
    tileRendering,
    "      uniformMapProperties.dayTextureNightFadeTilePixels[numberOfDayTextures] =\n        resolveNightImageryFadeTilePixels(imageryLayer);",
    "",
  );
  assert.doesNotMatch(
    webgl,
    /dayTextureNightFadeTilePixels\[numberOfDayTextures\] =/,
  );
  const webgpu = mutate(
    tileUb,
    "    data[baseOffset + 23] = resolveNightImageryFadeTilePixels(layer);",
    "    data[baseOffset + 23] = 0;",
  );
  assert.doesNotMatch(
    webgpu,
    /data\[baseOffset \+ 23\] = resolveNightImageryFadeTilePixels\(layer\);/,
  );
});

test("H8: the mutants are DISCRIMINATING — the real sources pass every predicate", () => {
  for (const [name, law] of COPIES) {
    assert.equal(lawRetiresTheWash(law), true, name);
  }
  assert.equal(
    weightIsSeamContinuous(WGSL.functions.nightImageryFadeWeight),
    true,
  );
  assert.match(
    tileRendering,
    /if \(nightImageryTileIsRetired\(imageryLayer, tileImagery\)\) \{\s*continue;\s*\}/,
  );
  assert.match(
    tileUb,
    /data\[baseOffset \+ 23\] = resolveNightImageryFadeTilePixels\(layer\);/,
  );
});

test("H9: no source file was written — the mutants were separate copies", () => {
  for (const [relativePath, original] of [
    [LEAF_PATH, leaf],
    [GLOBE_PATH, globe],
    [TILE_RENDERING_PATH, tileRendering],
    [SHADER_SET_PATH, shaderSet],
    [TILE_UB_PATH, tileUb],
    [WGSL_PATH, wgslSource],
    [GLSL_PATH, glslSource],
    [TILEMAP_PATH, tilemap],
  ]) {
    assert.equal(
      sha256(read(relativePath)),
      sha256(original),
      `${relativePath} changed under the spec`,
    );
  }
});
