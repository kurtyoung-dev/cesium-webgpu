// globe-night-imagery-magnification-fade.spec.mjs
// @purpose Pins the night layer's retirement past the deepest level its pyramid contains: full strength while a tile still resolves many texels, exactly nothing once one texel would cover the tile, identical on both backends, and inert for every layer the globe did not attach.
// @status ACTIVE
//
// THE BEHAVIOUR, STATED WITHOUT REFERENCE TO ANY IMPLEMENTATION SHAPE.
//
//   The bundled night pyramid stops at a fixed deepest level. Terrain keeps
//   subdividing below it, so each terrain tile resolves fewer and fewer night
//   texels until a single texel covers the whole tile. A layer that is opaque
//   past the terminator then replaces the entire scene under it with one flat
//   colour: at street altitude the globe renders as a featureless wash instead
//   of a night-time street.
//
//   So the layer's night-side opacity is a function of how magnified it is.
//   Three properties carry it, and each fails differently:
//
//   • THE TOP END IS EXACT. Wherever the layer is at or near its own
//     resolution — every altitude the showcase is composed at — the factor must
//     be exactly 1.0, not 0.999. Anything else re-renders the orbit view.
//   • THE BOTTOM END IS EXACT, AND IS REACHED. A factor that only approaches
//     zero leaves an opaque layer opaque; the wash is still there, dimmer. It
//     must reach exactly 0.0, and it must reach it at a magnification terrain
//     actually produces.
//   • IT IS SCOPED. The fade belongs to the layer the globe attached on its own
//     behalf. An application that hand-builds a layer with the same day/night
//     pair has chosen its own resolution and its own alphas, and must keep
//     rendering exactly what it asks for at every altitude.
//
//   The aside this note used to carry — that the scoping is also what keeps a
//   globe with no night layer byte-identical to upstream — is no longer true
//   and is corrected here rather than left to age: the procedural fallback now
//   ships a darkening default, so a globe with no night layer is upstream only
//   where the application has declined the fork's night appearance outright.
//   That condition belongs to globe-night-darkness-fallback, which executes it.
//
// WHAT THIS SPEC IS FOR. It EXECUTES the law out of the shipped module, and it
// reads the magnification off the SHIPPED pyramid's own tilemapresource.xml
// rather than restating a texel count in prose, so "the wash is gone at street
// level" is checked as a number against the asset that causes it. It does not
// own the day/night ramp (globe-daynight-ramp-law), the gate that arms it
// (globe-daynight-alpha-gate), or the procedural fallback that takes the night
// side back once the layer has gone (globe-night-darkness-fallback).
//
// LINE ENDINGS: this repo checks out CRLF. Every source read is normalised to
// a bare newline first — a spec anchored on one false-greens on a CRLF
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
  resolveNightImageryFade,
  NIGHT_IMAGERY_FADE_FULL_TEXELS,
  NIGHT_IMAGERY_FADE_ZERO_TEXELS,
} from "../../packages/engine/Source/Scene/GlobeNightImagery.js";

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
const TILE_UB_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts";
const TILEMAP_PATH =
  "packages/engine/Source/Assets/Textures/BlackMarble/tilemapresource.xml";

const leaf = read(LEAF_PATH);
const globe = read(GLOBE_PATH);
const tileRendering = read(TILE_RENDERING_PATH);
const tileUb = read(TILE_UB_PATH);
const tilemap = read(TILEMAP_PATH);

// ─── the shipped pyramid, read rather than restated ──────────────────────────

/**
 * The deepest level in the bundled pyramid and its texel spacing, taken from
 * the asset's own descriptor. Rebaking deeper changes both, and this spec then
 * measures the rebaked asset instead of a stale constant.
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
 * level to the pyramid's deepest — which it does for every terrain level below
 * it, because there is nothing deeper to request.
 */
function texelsAcrossTerrainTile(terrainLevel) {
  const { unitsPerPixel } = shippedPyramid();
  return 180 / 2 ** terrainLevel / unitsPerPixel;
}

/** A tile/imagery pair as the packers see one, for the real resolver. */
function tileImageryAt(terrainLevel) {
  const { unitsPerPixel, tileSize } = shippedPyramid();
  const imageryTileWidth = unitsPerPixel * tileSize;
  const terrainTileWidth = 180 / 2 ** terrainLevel;
  const scale = terrainTileWidth / imageryTileWidth;
  return {
    textureTranslationAndScale: { x: 0, y: 0, z: scale, w: scale },
  };
}

function nightLayerAt() {
  const { tileSize } = shippedPyramid();
  return markNightImageryLayer({
    imageryProvider: { tileWidth: tileSize, tileHeight: tileSize },
  });
}

const EPSILON = 1e-12;

// ─── A. the law, executed ────────────────────────────────────────────────────

test("A1: at and above its own resolution the factor is EXACTLY 1.0", () => {
  // Not "close to 1": the showcase altitudes must render the same bytes they
  // rendered before the fade existed, and a 0.9999 factor is a different image.
  for (const texels of [
    NIGHT_IMAGERY_FADE_FULL_TEXELS,
    8.000001,
    16,
    64,
    256,
    1024,
    1e9,
    Infinity,
  ]) {
    assert.equal(
      nightImageryMagnificationFade(texels),
      1.0,
      `${texels} texels across a tile must not touch the layer`,
    );
  }
});

test("A2: once one texel would cover the tile the factor is EXACTLY 0.0", () => {
  // A factor that merely approaches zero leaves an opaque layer opaque, and the
  // wash survives the fix at reduced contrast.
  for (const texels of [NIGHT_IMAGERY_FADE_ZERO_TEXELS, 0.5, 0.03, 0, -1]) {
    assert.equal(
      nightImageryMagnificationFade(texels),
      0.0,
      `${texels} texels across a tile is a single flat colour`,
    );
  }
});

test("A3: in between it is monotone, bounded, and has no flat step", () => {
  let previous = -Infinity;
  let moved = 0;
  for (let i = 0; i <= 200; i++) {
    // Sample the band in log space, which is how magnification travels.
    const texels = NIGHT_IMAGERY_FADE_ZERO_TEXELS * 2 ** ((i / 200) * 3);
    const value = nightImageryMagnificationFade(texels);
    assert.ok(value >= 0 && value <= 1, "the factor must stay an alpha");
    assert.ok(
      value >= previous - EPSILON,
      "more texels must never mean less layer",
    );
    if (value > previous + EPSILON) {
      moved += 1;
    }
    previous = value;
  }
  assert.ok(
    moved > 150,
    `the band must be a ramp, not a step: it moved on ${moved} of 201 samples`,
  );
});

test("A4: an unmeasurable magnification leaves the layer alone", () => {
  // Fail-open. A NaN scale is a bug somewhere upstream, and erasing the layer
  // would turn it into a blank night side that looks like a rendering fault.
  assert.equal(nightImageryMagnificationFade(NaN), 1.0);
  assert.equal(resolveNightImageryFade(nightLayerAt(), {}), 1.0);
  assert.equal(resolveNightImageryFade(nightLayerAt(), undefined), 1.0);
});

test("A5: the band is where the magnification is, not where the altitude is", () => {
  // The factor is a function of the ratio alone, so a provider with larger
  // tiles keeps its layer for one more terrain level — which is exactly what
  // buying more source pixels should do.
  const small = { imageryProvider: { tileWidth: 256, tileHeight: 256 } };
  const large = { imageryProvider: { tileWidth: 512, tileHeight: 512 } };
  markNightImageryLayer(small);
  markNightImageryLayer(large);
  const scale = { textureTranslationAndScale: { z: 1 / 256, w: 1 / 256 } };
  assert.equal(resolveNightImageryFade(small, scale), 0.0, "1 texel: retired");
  assert.ok(
    resolveNightImageryFade(large, scale) > 0.0,
    "twice the pixels, twice the texels, still contributing",
  );
});

test("A6: the more magnified axis governs", () => {
  // A layer stretched on one axis carries no structure on it, and crediting the
  // other axis would keep a smeared layer alive over the scene.
  const layer = nightLayerAt();
  const lopsided = { textureTranslationAndScale: { z: 1, w: 1 / 1024 } };
  assert.equal(resolveNightImageryFade(layer, lopsided), 0.0);
});

// ─── B. against the SHIPPED pyramid ──────────────────────────────────────────

test("B1: the shipped pyramid is what the numbers below are measured from", () => {
  const { order, unitsPerPixel, tileSize } = shippedPyramid();
  assert.equal(tileSize, 256, "a rebake changed the tile size");
  assert.ok(order >= 0, "the pyramid must declare a deepest level");
  // The descriptor is self-consistent: geographic level `order` at `tileSize`
  // pixels per tile has exactly this spacing.
  assert.ok(
    Math.abs(unitsPerPixel - 180 / (2 ** order * tileSize)) < 1e-9,
    "the descriptor's spacing does not match its own level and tile size",
  );
});

test("B2: every altitude the layer is composed for keeps it at full strength", () => {
  // Down to eight texels across a tile the layer still carries structure within
  // the tile, and the packers must hand the shader an untouched 1.0.
  const layer = nightLayerAt();
  for (let level = 0; level <= 7; level += 1) {
    assert.equal(
      resolveNightImageryFade(layer, tileImageryAt(level)),
      1.0,
      `terrain level ${level} (${texelsAcrossTerrainTile(level)} texels) must be untouched`,
    );
  }
});

test("B3: the defect's own altitudes get exactly nothing", () => {
  // With the level-three pyramid ratified by R-2026-08-28-8 (Batch 1244), terrain
  // level 11 is where one of the deepest level's texels first covers a
  // whole tile; every level below it is more magnified still. Street views sit
  // far down this range, which is where the wash was measured.
  const layer = nightLayerAt();
  for (let level = 11; level <= 20; level += 1) {
    assert.ok(
      texelsAcrossTerrainTile(level) <= NIGHT_IMAGERY_FADE_ZERO_TEXELS,
      `precondition: level ${level} must be at or past one texel per tile`,
    );
    assert.equal(
      resolveNightImageryFade(layer, tileImageryAt(level)),
      0.0,
      `terrain level ${level} must contribute nothing`,
    );
  }
});

test("B4: the handover is two whole levels wide, and strictly decreasing", () => {
  // Wide enough that the layer thins out instead of vanishing between one frame
  // and the next, and narrow enough that it is gone before the tiles it would
  // wash out are on screen.
  const layer = nightLayerAt();
  // The two-level band sits one level deeper on the level-three pyramid.
  const band = [9, 10].map((level) =>
    resolveNightImageryFade(layer, tileImageryAt(level)),
  );
  assert.ok(
    band[0] < 1.0 && band[0] > band[1] && band[1] > 0.0,
    `band: ${band}`,
  );
});

// ─── C. the fade is SCOPED to the layer the globe attached ───────────────────

test("C1: a layer the globe did not attach is untouched at every magnification", () => {
  // This is what keeps a globe with no night layer, and an application that
  // built its own, byte-identical to upstream.
  const foreign = { imageryProvider: { tileWidth: 256, tileHeight: 256 } };
  assert.equal(isNightImageryLayer(foreign), false);
  for (let level = 0; level <= 20; level += 1) {
    assert.equal(
      resolveNightImageryFade(foreign, tileImageryAt(level)),
      1.0,
      `an unmarked layer must not fade at terrain level ${level}`,
    );
  }
  assert.equal(isNightImageryLayer(undefined), false);
  assert.equal(isNightImageryLayer(null), false);
});

test("C2: the globe marks the layer it attaches, at the attachment site", () => {
  assert.match(
    globe,
    /const layer = ImageryLayer\.fromProviderAsync\(\s*provider,\s*NIGHT_IMAGERY_LAYER_OPTIONS,\s*\);[\s\S]{0,400}?markNightImageryLayer\(layer\);\s*globe\._nightImageryLayer = layer;/,
    "a layer that reaches the collection unmarked never fades",
  );
});

test("C3: the marker is not carried by the frozen layer options", () => {
  // The options object is public-shaped and frozen; the marker is an internal
  // property of the constructed layer, so an application passing the same
  // options to its own layer does not silently acquire the fade.
  assert.doesNotMatch(
    leaf,
    /NIGHT_IMAGERY_LAYER_OPTIONS = Object\.freeze\(\{[^}]*_isGlobeNightImagery/,
  );
});

// ─── D. both packers consume it, from one law ────────────────────────────────

test("D1: WebGL multiplies the resolved night alpha by the factor", () => {
  assert.match(
    tileRendering,
    /const nightImageryFade = resolveNightImageryFade\(\s*imageryLayer,\s*tileImagery,\s*\);/,
  );
  assert.match(
    tileRendering,
    /uniformMapProperties\.dayTextureNightAlpha\[numberOfDayTextures\] \*=\s*nightImageryFade;/,
    "the factor must reach the slot the shader blends, not a local",
  );
  assert.match(
    tileRendering,
    /if \(nightImageryFade === 0\.0\) \{\s*continue;\s*\}/,
    "a fully retired layer must take no texture slot, so the tile packs " +
      "exactly as it would with no night layer attached",
  );
});

test("D2: WebGPU multiplies the same slot by the same factor", () => {
  assert.match(
    tileUb,
    /const nightImageryFade = resolveNightImageryFade\(\s*imagery\.imageryLayer,\s*tileImagery,\s*\);/,
  );
  assert.match(tileUb, /data\[dnFloatBase \+ 1\] \*= nightImageryFade;/);
  assert.match(tileUb, /if \(nightImageryFade === 0\.0\) \{\s*continue;\s*\}/);
});

test("D3: neither backend restates the law", () => {
  // One import each. A second copy of the thresholds is how the two backends
  // start disagreeing about which altitude the layer disappears at.
  assert.match(
    tileRendering,
    /import \{ resolveNightImageryFade \} from "\.\/GlobeNightImagery\.js";/,
  );
  assert.match(
    tileUb,
    /import \{ resolveNightImageryFade \} from "\.\.\/\.\.\/Scene\/GlobeNightImagery\.js";/,
  );
  for (const [name, source] of [
    ["WebGL", tileRendering],
    ["WebGPU", tileUb],
  ]) {
    assert.doesNotMatch(
      source,
      /NIGHT_IMAGERY_FADE_(FULL|ZERO)_TEXELS/,
      `${name} must read the law, not a second copy of its thresholds`,
    );
  }
});

test("D4: the day alpha is NOT faded", () => {
  // The fade is a night-side property. Touching the day alpha would change a
  // layer that is already invisible in daylight, for no reason, and would make
  // the day/night gate's condition depend on altitude.
  assert.doesNotMatch(
    tileRendering,
    /dayTextureDayAlpha\[numberOfDayTextures\][^\n]*nightImageryFade/,
  );
  assert.doesNotMatch(tileUb, /data\[dnFloatBase \+ 0\][^\n]*nightImageryFade/);
});

// ─── E. MUTANTS — absence, inertness, and the wrong direction ────────────────

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
 * `finally`.
 *
 * The original file is never opened for writing, so a spec running beside this
 * one cannot observe a half-mutated module and a throw in an assertion cannot
 * leave the tree dirty. Nothing is stubbed: the mutant imports the same
 * `defined` the real module does.
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

/** The real module, in the shape the mutant predicates read. */
const realModule = {
  nightImageryMagnificationFade,
  resolveNightImageryFade,
  markNightImageryLayer,
};

/** The predicates under test, as functions of a module so mutants can run them. */
function fadeRetiresTheLayer(mod) {
  return (
    mod.nightImageryMagnificationFade(0.03) === 0.0 &&
    mod.nightImageryMagnificationFade(1024) === 1.0 &&
    mod.nightImageryMagnificationFade(4) > 0.0 &&
    mod.nightImageryMagnificationFade(4) < 1.0
  );
}
function webglConsumesTheFade(source) {
  return (
    /dayTextureNightAlpha\[numberOfDayTextures\] \*=\s*nightImageryFade;/.test(
      source,
    ) && /if \(nightImageryFade === 0\.0\) \{\s*continue;\s*\}/.test(source)
  );
}
function webgpuConsumesTheFade(source) {
  return (
    /data\[dnFloatBase \+ 1\] \*= nightImageryFade;/.test(source) &&
    /if \(nightImageryFade === 0\.0\) \{\s*continue;\s*\}/.test(source)
  );
}

test("E1: INERTNESS — a factor pinned at full strength is REJECTED", async () => {
  // Every symbol present, both packers multiplying, and the wash untouched.
  await withMutantLeaf(
    mutate(
      leaf,
      "export function nightImageryMagnificationFade(texelsAcrossTile) {",
      "export function nightImageryMagnificationFade(texelsAcrossTile) {\n  return 1.0;",
    ),
    (mutant) => {
      assert.equal(fadeRetiresTheLayer(mutant), false);
    },
  );
});

test("E2: WRONG DIRECTION — a factor that rises with magnification is REJECTED", async () => {
  // The plausible typo, and the one a deletion mutant cannot see: the layer
  // survives at orbit and at street, but the two ends are swapped, so the
  // showcase loses its city lights and the street keeps its wash.
  await withMutantLeaf(
    mutate(
      leaf,
      "  return t * t * (3.0 - 2.0 * t);",
      "  return 1.0 - t * t * (3.0 - 2.0 * t);",
    ),
    (mutant) => {
      const fade = mutant.nightImageryMagnificationFade;
      assert.ok(
        fade(2) > fade(4),
        "precondition: the inverted ramp is the wrong way round",
      );
      assert.equal(
        fadeRetiresTheLayer(mutant),
        true,
        "precondition: the endpoints alone do not catch it",
      );
      // So the endpoints are not the check; monotonicity is.
      let previous = -Infinity;
      let reversed = false;
      for (let i = 0; i <= 40; i++) {
        const value = fade(2 ** ((i / 40) * 3));
        if (value < previous - EPSILON) {
          reversed = true;
        }
        previous = value;
      }
      assert.equal(
        reversed,
        true,
        "the inverted ramp must be caught as a reversal",
      );
    },
  );
});

test("E3: INERTNESS — a scope check that says yes to everything is REJECTED", async () => {
  await withMutantLeaf(
    mutate(leaf, "  if (!isNightImageryLayer(layer)) {", "  if (false) {"),
    (mutant) => {
      const foreign = { imageryProvider: { tileWidth: 256, tileHeight: 256 } };
      assert.equal(
        mutant.resolveNightImageryFade(foreign, tileImageryAt(15)),
        0.0,
        "precondition: the mutant fades a layer the globe never attached",
      );
      assert.notEqual(
        resolveNightImageryFade(foreign, tileImageryAt(15)),
        0.0,
        "the real module must leave it alone",
      );
    },
  );
});

test("E4: INERTNESS — a scope check that says no to everything is REJECTED", async () => {
  await withMutantLeaf(
    mutate(leaf, "  if (!isNightImageryLayer(layer)) {", "  if (true) {"),
    (mutant) => {
      assert.equal(
        mutant.resolveNightImageryFade(nightLayerAt(), tileImageryAt(15)),
        1.0,
        "precondition: the mutant never fades anything",
      );
      assert.equal(
        resolveNightImageryFade(nightLayerAt(), tileImageryAt(15)),
        0.0,
      );
    },
  );
});

test("E5: ABSENCE — a packer that drops the multiply is REJECTED", () => {
  const webgl = mutate(
    tileRendering,
    "      uniformMapProperties.dayTextureNightAlpha[numberOfDayTextures] *=\n        nightImageryFade;",
    "",
  );
  assert.equal(webglConsumesTheFade(webgl), false);
  const webgpu = mutate(
    tileUb,
    "    data[dnFloatBase + 1] *= nightImageryFade;",
    "",
  );
  assert.equal(webgpuConsumesTheFade(webgpu), false);
});

test("E6: INERTNESS — a skip that can never fire is REJECTED", () => {
  // The retired layer would still take a texture slot and still raise the
  // day/night flag, which suppresses the procedural fallback that is supposed
  // to take the night side back — so the street would be legible but unlit.
  const webgl = mutate(
    tileRendering,
    "      if (nightImageryFade === 0.0) {",
    "      if (false && nightImageryFade === 0.0) {",
  );
  assert.equal(webglConsumesTheFade(webgl), false);
  const webgpu = mutate(
    tileUb,
    "    if (nightImageryFade === 0.0) {",
    "    if (false && nightImageryFade === 0.0) {",
  );
  assert.equal(webgpuConsumesTheFade(webgpu), false);
});

test("E7: the mutants are DISCRIMINATING — the real sources pass every predicate", () => {
  assert.equal(fadeRetiresTheLayer(realModule), true);
  assert.equal(webglConsumesTheFade(tileRendering), true);
  assert.equal(webgpuConsumesTheFade(tileUb), true);
});

test("E8: no source file was written — the mutants were separate copies", () => {
  for (const [relativePath, original] of [
    [LEAF_PATH, leaf],
    [GLOBE_PATH, globe],
    [TILE_RENDERING_PATH, tileRendering],
    [TILE_UB_PATH, tileUb],
    [TILEMAP_PATH, tilemap],
  ]) {
    assert.equal(
      sha256(read(relativePath)),
      sha256(original),
      `${relativePath} changed under the spec`,
    );
  }
});
