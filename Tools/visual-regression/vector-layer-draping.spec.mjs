// vector-layer-draping.spec.mjs — C11-213 / UP144-VECTOR-LAYER-WGSL acceptance.
// @purpose Acceptance for WebGPU vector-layer draping: GLSL-derived oracle vs real storage-buffer packer/WGSL indexing, six named mutations.
// @status ACTIVE
//
// Pure Node, real modules, no browser:
//   node --test Tools/visual-regression/vector-layer-draping.spec.mjs
//
// WHAT THE ROW ASKED
// ------------------
// Upstream v1.144 (PR #13577) drapes clamped `BufferPolylineCollection`
// geometry onto terrain: `VectorPipeline` bakes a per-tile grid-indexed segment
// lookup, `VectorPipeline.packPolylineTextures` realizes it as five WebGL
// textures, and `VectorCommon.glsl::vectorPolylineRender` reads them back with
// `texelFetch` from the globe fragment shader under `#ifdef HAS_VECTOR_LAYER`.
// None of that existed on WebGPU: `GlobeTerrain.wgsl` had no vector path, and
// the bake unconditionally built WebGL `Texture` objects.
//
// WHAT SHIPPED (and why it is not a five-texture transliteration)
// ---------------------------------------------------------------
// `texelFetch` in the GLSL is not texture sampling — it is WebGL2's only way to
// random-access a buffer from a fragment shader (nearest, integer coords,
// power-of-two padding, no filtering). WebGPU has read-only storage buffers, and
// it also has a hard budget the GLSL never had: the globe pipeline layout
// charges `GLOBE_NON_IMAGERY_FRAGMENT_TEXTURES` = 12 fragment sampled textures
// besides the imagery slots, and on a default-limit adapter
// (`maxSampledTexturesPerShaderStage` = 16, the WebGPU spec floor) the reduced
// 4-slot imagery layout already lands on exactly 16. Five more sampled textures
// would take it to 21 and break the globe outright there. So the WGSL twin reads
// ONE storage buffer packed by `WebGPUVectorTileResources.packVectorTileWords`.
//
// That makes the packer the load-bearing new artifact, and this spec's core is
// an EQUIVALENCE PROOF over it:
//
//   * the ORACLE evaluates `VectorCommon.glsl`'s algorithm against the raw
//     `VectorTileData` CPU tables, including the power-of-two texel addressing
//     `vectorIndexToUv` + `texelFetch` imply. It is written from the GLSL, never
//     from the packer or the WGSL.
//   * the SUBJECT evaluates `GlobeTerrain.wgsl::vectorPolylineRender`'s index
//     arithmetic against the REAL packer's output, with every header word index
//     read out of the shader source rather than restated here.
//
// Both are run over a raster of sample points on real `packPolylineGrid` output.
// Agreement is what "the WGSL twin matches the GLSL" means operationally.
//
// MUTATIONS (each re-introduces a concrete defect and must be DETECTED)
// --------------------------------------------------------------------
//   M1  the original defect: WebGPU has no vector path at all (identity FS tail)
//   M2  the bake ignores the backend and builds WebGL textures anyway
//   M3  colour channel order flipped (BGRA) in the packed primitive record
//   M4  cell start read as `cellEnd[i]` instead of `cellEnd[i-1]` (off-by-one)
//   M5  segment→primitive indirection dropped (segment index used as material)
//   M6  a SINGULAR UV Jacobian inverted to the ZERO matrix instead of
//       abandoning the fragment (NEW-WEBGPU-VECTOR-DRAPING-HORIZONTAL-STREAKS)
//
// A mutation that the assertions still pass is a spec that proves nothing, so
// each is asserted to FAIL.
//
// WHY M6 NEEDED A NEW AXIS (and why the first five could not have caught it)
// -------------------------------------------------------------------------
// The evaluators below take `screenFromUv` PRE-INVERTED, because the GLSL takes
// it from `dFdx`/`dFdy` and a CPU evaluator cannot observe those. That put the
// INVERSION itself outside the equivalence proof — and the inversion is where
// the backends actually diverged. GLSL has an `inverse()` builtin; WGSL does
// not, so the WGSL twin hand-rolled one, and its singular-matrix fallback
// returned the ZERO matrix. Zero is not "no answer": it collapses
// `length(screenFromUv * offsetUv)` to 0, which is `< lineWidth` for the FIRST
// segment in the cell however far away that segment is.
//
// Terrain SKIRT quads make that fire on every tile. `HeightmapTessellator`
// derives a skirt vertex's u/v from the UNMOVED edge longitude/latitude, so a
// north/south skirt strip carries a bit-identical `v` (and an east/west strip a
// bit-identical `u`) — the Jacobian is EXACTLY singular, not nearly so. WebGL
// divides by that zero, compares against Inf/NaN, and drapes nothing; WebGPU
// painted the whole skirt ring of every vector-carrying tile with that tile's
// first segment colour. In the C11-213 acceptance frame that showed up as faint
// lines lying exactly on the level-6 tile-row boundaries.
//
// So this file now models the inversion on both sides (`glslScreenFromUv` /
// `wgslScreenFromUv`), pins the skirt precondition against the REAL tessellator
// (E1), and requires the zero-matrix fallback to be detected (M6).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const wgslPath = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
);
const glslCommonPath = path.join(
  root,
  "packages/engine/Source/Shaders/VectorCommon.glsl",
);
const glslGlobePath = path.join(
  root,
  "packages/engine/Source/Shaders/GlobeFS.glsl",
);
const layoutsPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceLayouts.ts",
);
const rendererPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
);
const featureRenderersPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts",
);
const vectorPipelinePath = path.join(
  root,
  "packages/engine/Source/Core/VectorPipeline.js",
);
const vectorProviderPath = path.join(
  root,
  "packages/engine/Source/Core/VectorProvider.js",
);

const wgsl = fs.readFileSync(wgslPath, "utf8");
const glslCommon = fs.readFileSync(glslCommonPath, "utf8");
const glslGlobe = fs.readFileSync(glslGlobePath, "utf8");
const layoutsTs = fs.readFileSync(layoutsPath, "utf8");
const rendererTs = fs.readFileSync(rendererPath, "utf8");
const featureRenderersTs = fs.readFileSync(featureRenderersPath, "utf8");
const vectorPipelineJs = fs.readFileSync(vectorPipelinePath, "utf8");
const vectorProviderJs = fs.readFileSync(vectorProviderPath, "utf8");

enableEngineTsResolution();

const VectorPipeline = (await import(pathToFileURL(vectorPipelinePath).href))
  .default;

const engineModule = async (relative) =>
  (
    await import(
      pathToFileURL(path.join(root, "packages/engine/Source", relative)).href
    )
  ).default;

// Real modules — E1 measures the skirt UVs the singular Jacobian comes from
// rather than restating them.
const HeightmapTessellator = await engineModule("Core/HeightmapTessellator.js");
const Rectangle = await engineModule("Core/Rectangle.js");
const Cartesian2 = await engineModule("Core/Cartesian2.js");

const {
  packVectorTileWords,
  prepareWebGPUVectorTileData,
  resolveVectorTileBuffer,
  VECTOR_TILE_HEADER_WORDS,
  VECTOR_TILE_PLACEHOLDER_BYTES,
  VECTOR_TILE_GRID_WIDTH,
  VECTOR_TILE_GRID_HEIGHT,
  VECTOR_TILE_SEGMENT_COUNT,
  VECTOR_TILE_PRIMITIVE_COUNT,
  VECTOR_TILE_CELL_END_BASE,
  VECTOR_TILE_SEGMENTS_BASE,
  VECTOR_TILE_SEGMENT_PRIMITIVE_BASE,
  VECTOR_TILE_PRIMITIVES_BASE,
} = await import(
  pathToFileURL(
    path.join(
      root,
      "packages/engine/Source/Renderer/WebGPU/WebGPUVectorTileResources.ts",
    ),
  ).href
);

// ═══════════════════════════════════════════════════════════════════════
// Header word indices, READ OUT OF THE SHADER. The packer and the shader
// are a matched pair; taking the subject evaluator's constants from the
// TS side alone would let the pair drift with the spec still green.
// ═══════════════════════════════════════════════════════════════════════

function wgslHeaderIndex(name) {
  const match = wgsl.match(new RegExp(`const ${name}: u32 = ([0-9]+)u;`));
  assert.ok(match, `GlobeTerrain.wgsl declares no ${name}`);
  return Number(match[1]);
}

const SHADER_HEADER = {
  gridWidth: wgslHeaderIndex("VECTOR_TILE_GRID_WIDTH"),
  gridHeight: wgslHeaderIndex("VECTOR_TILE_GRID_HEIGHT"),
  segmentCount: wgslHeaderIndex("VECTOR_TILE_SEGMENT_COUNT"),
  primitiveCount: wgslHeaderIndex("VECTOR_TILE_PRIMITIVE_COUNT"),
  cellEndBase: wgslHeaderIndex("VECTOR_TILE_CELL_END_BASE"),
  segmentsBase: wgslHeaderIndex("VECTOR_TILE_SEGMENTS_BASE"),
  segmentPrimitiveBase: wgslHeaderIndex("VECTOR_TILE_SEGMENT_PRIMITIVE_BASE"),
  primitivesBase: wgslHeaderIndex("VECTOR_TILE_PRIMITIVES_BASE"),
};

// ═══════════════════════════════════════════════════════════════════════
// ORACLE — VectorCommon.glsl, transcribed from the GLSL only.
// ═══════════════════════════════════════════════════════════════════════

// Duplicated from `VectorPipeline._nextPowerOfTwoSize` on purpose: the width /
// colour textures the GLSL reads are sized by it, so the oracle needs the same
// padding rule without importing the module it is checking.
function nextPowerOfTwoSize(count) {
  const pow2 = (n) => {
    let v = 1;
    while (v < n) v *= 2;
    return v;
  };
  const width = pow2(Math.max(1, Math.ceil(Math.sqrt(count))));
  const height = pow2(Math.max(1, Math.ceil(count / width)));
  return [width, height];
}

function concatBytes(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// GLSL `vectorIndexToUv` + `texelFetch` on a row-major arrayBufferView:
// (u, v) = (index % W, index / W), and the fetched texel is row v, column u —
// i.e. linear texel `v * W + u`. Kept explicit so a change to either half of
// that identity shows up here.
function texelIndex(index, textureWidth) {
  const v = Math.floor(index / textureWidth);
  const u = index - v * textureWidth;
  return v * textureWidth + u;
}

function glslOffsetToLine(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const abLengthSquared = abx * abx + aby * aby;
  if (abLengthSquared < 1.0e-8) {
    return [px - ax, py - ay];
  }
  const t = Math.min(
    1,
    Math.max(0, ((px - ax) * abx + (py - ay) * aby) / abLengthSquared),
  );
  return [px - (ax + t * abx), py - (ay + t * aby)];
}

function alphaComposite(vectorColor, base) {
  const a = vectorColor[3];
  return [
    vectorColor[0] * a + base[0] * (1 - a),
    vectorColor[1] * a + base[1] * (1 - a),
    vectorColor[2] * a + base[2] * (1 - a),
    vectorColor[3] * 1 + base[3] * (1 - a),
  ];
}

function applyScreenFromUv(screenFromUv, offset) {
  // Column-major 2x2 (both languages): m = [c0 | c1].
  return [
    screenFromUv[0][0] * offset[0] + screenFromUv[1][0] * offset[1],
    screenFromUv[0][1] * offset[0] + screenFromUv[1][1] * offset[1],
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// The Jacobian INVERSION — the step the equivalence proof used to skip.
// Both thresholds are read out of the shaders, not restated, because the
// two must stay the same number for the backends to agree by construction.
// ═══════════════════════════════════════════════════════════════════════

function shaderSingularEpsilon(source, expression, label) {
  const match = source.match(
    new RegExp(`abs\\(${expression}\\)\\s*<\\s*([0-9.]+e-?[0-9]+)`),
  );
  assert.ok(match, `${label} declares no singular-Jacobian threshold`);
  return Number(match[1]);
}

const WGSL_SINGULAR_EPSILON = shaderSingularEpsilon(
  wgsl,
  "uvJacobianDet",
  "GlobeTerrain.wgsl",
);
const GLSL_SINGULAR_EPSILON = shaderSingularEpsilon(
  glslCommon,
  "uvJacobianDet",
  "VectorCommon.glsl",
);

/**
 * The CONDITION-NUMBER ceiling (`NEW-WEBGL-VECTOR-DRAPING-RESIDUAL-EXTENT`).
 * Read out of each shader for the same reason the epsilon is: the two backends
 * only agree by construction if they abandon the fragment at the same number.
 */
function shaderConditionCeiling(source, label) {
  const match = source.match(
    /VECTOR_UV_JACOBIAN_MAX_CONDITION[^=]*=\s*([0-9.]+e-?[0-9]+)/,
  );
  assert.ok(match, `${label} declares no VECTOR_UV_JACOBIAN_MAX_CONDITION`);
  return Number(match[1]);
}

const WGSL_CONDITION_CEILING = shaderConditionCeiling(
  wgsl,
  "GlobeTerrain.wgsl",
);
const GLSL_CONDITION_CEILING = shaderConditionCeiling(
  glslCommon,
  "VectorCommon.glsl",
);

/**
 * Whether the shader's abandon test ACTUALLY applies the ceiling. Declaring the
 * constant is not the same as using it, and a model that assumed the guard
 * exists would keep this file green while the shipped shader painted skirts
 * again. Behaviour follows the source rather than the other way round.
 */
const CONDITION_GUARD_EXPRESSION =
  /uvJacobianNormSquared\s*>\s*VECTOR_UV_JACOBIAN_MAX_CONDITION\s*\*\s*abs\(uvJacobianDet\)/;
const WGSL_HAS_CONDITION_GUARD = CONDITION_GUARD_EXPRESSION.test(wgsl);
const GLSL_HAS_CONDITION_GUARD = CONDITION_GUARD_EXPRESSION.test(glslCommon);

function determinant2x2(c0, c1) {
  return c0[0] * c1[1] - c1[0] * c0[1];
}

function inverse2x2(c0, c1, det) {
  const invDet = 1 / det;
  return [
    [c1[1] * invDet, -c0[1] * invDet],
    [-c1[0] * invDet, c0[0] * invDet],
  ];
}

function normSquared2x2(c0, c1) {
  return c0[0] * c0[0] + c0[1] * c0[1] + c1[0] * c1[0] + c1[1] * c1[1];
}

/**
 * `‖M‖_F² / |det|` is exactly `κ + 1/κ` for a 2x2, so this IS the condition
 * number, read without a square root and without any dependence on the
 * matrix's overall scale. Both shaders compute it verbatim.
 */
function conditionRatio(c0, c1) {
  const det = Math.abs(determinant2x2(c0, c1));
  return det === 0 ? Number.POSITIVE_INFINITY : normSquared2x2(c0, c1) / det;
}

/**
 * The two-term abandon test both shaders now run before inverting.
 * `mutate.absoluteSingularEpsilonOnly` drops the condition term, restoring the
 * Batch-834 guard that only ever caught an EXACTLY zero determinant — the
 * defect `NEW-WEBGL-VECTOR-DRAPING-RESIDUAL-EXTENT` was filed against.
 */
function jacobianIsUnusable(uvDx, uvDy, epsilon, ceiling, hasGuard, mutate) {
  if (Math.abs(determinant2x2(uvDx, uvDy)) < epsilon) {
    return true;
  }
  if (mutate.absoluteSingularEpsilonOnly || !hasGuard) {
    return false;
  }
  return conditionRatio(uvDx, uvDy) > ceiling;
}

/**
 * `VectorCommon.glsl`'s inverse UV Jacobian. `null` means "this fragment can
 * have no pixel-space distance, so nothing is ever in range" — which is what
 * the GLSL produces both before the explicit guard (Inf/NaN from `inverse()`,
 * every comparison false) and after it (an early return).
 */
function glslScreenFromUv(uvDx, uvDy, mutate = {}) {
  if (
    jacobianIsUnusable(
      uvDx,
      uvDy,
      GLSL_SINGULAR_EPSILON,
      GLSL_CONDITION_CEILING,
      GLSL_HAS_CONDITION_GUARD,
      mutate,
    )
  ) {
    return null;
  }
  return inverse2x2(uvDx, uvDy, determinant2x2(uvDx, uvDy));
}

/**
 * `GlobeTerrain.wgsl::vectorPolylineRender`'s inverse UV Jacobian.
 * `mutate.singularJacobianZeroMatrix` restores the Batch-827 fallback that
 * returned the ZERO matrix instead of abandoning the fragment.
 */
function wgslScreenFromUv(uvDx, uvDy, mutate = {}) {
  if (
    jacobianIsUnusable(
      uvDx,
      uvDy,
      WGSL_SINGULAR_EPSILON,
      WGSL_CONDITION_CEILING,
      WGSL_HAS_CONDITION_GUARD,
      mutate,
    )
  ) {
    return mutate.singularJacobianZeroMatrix
      ? [
          [0, 0],
          [0, 0],
        ]
      : null;
  }
  return inverse2x2(uvDx, uvDy, determinant2x2(uvDx, uvDy));
}

/**
 * `VectorCommon.glsl::vectorPolylineRender` over the raw VectorTileData.
 * `screenFromUv` is supplied pre-inverted; the GLSL takes it from dFdx/dFdy,
 * which a CPU evaluator cannot observe.
 */
function glslVectorPolylineRender(data, uv, screenFromUv, baseColor) {
  const grid = data.polylineGridCellIndices;
  const gridWidth = grid[0];
  const gridHeight = grid[1];
  const cellX = Math.min(
    gridWidth - 1,
    Math.max(0, Math.trunc(uv[0] * gridWidth)),
  );
  const cellY = Math.min(
    gridHeight - 1,
    Math.max(0, Math.trunc(uv[1] * gridHeight)),
  );
  const cellIndex = cellX + cellY * gridWidth;

  const indexEnd = grid[cellIndex + 2];
  const indexStart = cellIndex === 0 ? 0 : grid[cellIndex + 1];

  const segmentTextureWidth = data.polylineSegmentTextureWidth;
  const [primitiveTextureWidth] = nextPowerOfTwoSize(data.primitiveCount);
  const widthBytes = concatBytes(data.widths);
  const colorBytes = concatBytes(data.colors);

  let result = baseColor;
  for (let i = indexStart; i < indexEnd; i++) {
    const st = texelIndex(i, segmentTextureWidth);
    const ax = data.polylineSegmentTexels[st * 4];
    const ay = data.polylineSegmentTexels[st * 4 + 1];
    const bx = data.polylineSegmentTexels[st * 4 + 2];
    const by = data.polylineSegmentTexels[st * 4 + 3];

    const primitiveIndex = data.polylineSegmentPrimitiveIndicesTexels[st];
    const pt = texelIndex(primitiveIndex, primitiveTextureWidth);
    // r8unorm read × 255 == the raw byte.
    const lineWidth = widthBytes[pt];

    const offset = glslOffsetToLine(uv[0], uv[1], ax, ay, bx, by);
    const screen = applyScreenFromUv(screenFromUv, offset);
    if (Math.hypot(screen[0], screen[1]) < lineWidth) {
      result = alphaComposite(
        [
          colorBytes[pt * 4] / 255,
          colorBytes[pt * 4 + 1] / 255,
          colorBytes[pt * 4 + 2] / 255,
          colorBytes[pt * 4 + 3] / 255,
        ],
        result,
      );
      break;
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// SUBJECT — GlobeTerrain.wgsl::vectorPolylineRender over the packed words.
// `mutate` lets a test re-introduce a specific defect in the reader.
// ═══════════════════════════════════════════════════════════════════════

function wgslVectorPolylineRender(
  words,
  uv,
  screenFromUv,
  baseColor,
  mutate = {},
) {
  if (words === null) {
    return baseColor;
  }
  const floats = new Float32Array(words.buffer, words.byteOffset, words.length);

  const gridWidth = words[SHADER_HEADER.gridWidth];
  const gridHeight = words[SHADER_HEADER.gridHeight];
  if (gridWidth === 0 || gridHeight === 0) {
    return baseColor;
  }
  const segmentCount = words[SHADER_HEADER.segmentCount];
  const primitiveCount = words[SHADER_HEADER.primitiveCount];
  if (segmentCount === 0 || primitiveCount === 0) {
    return baseColor;
  }
  const cellEndBase = words[SHADER_HEADER.cellEndBase];
  const segmentsBase = words[SHADER_HEADER.segmentsBase];
  const segmentPrimitiveBase = words[SHADER_HEADER.segmentPrimitiveBase];
  const primitivesBase = words[SHADER_HEADER.primitivesBase];

  const cellX = Math.min(
    gridWidth - 1,
    Math.max(0, Math.trunc(uv[0] * gridWidth)),
  );
  const cellY = Math.min(
    gridHeight - 1,
    Math.max(0, Math.trunc(uv[1] * gridHeight)),
  );
  const cellIndex = cellX + cellY * gridWidth;

  let indexEnd = words[cellEndBase + cellIndex];
  let indexStart = 0;
  if (cellIndex !== 0) {
    indexStart = mutate.cellStartOffByOne
      ? words[cellEndBase + cellIndex]
      : words[cellEndBase + cellIndex - 1];
  }
  indexEnd = Math.min(indexEnd, segmentCount);
  indexStart = Math.min(indexStart, indexEnd);

  let result = baseColor;
  for (let i = indexStart; i < indexEnd; i++) {
    const s = segmentsBase + i * 4;
    const ax = floats[s];
    const ay = floats[s + 1];
    const bx = floats[s + 2];
    const by = floats[s + 3];

    const primitiveIndex = mutate.dropIndirection
      ? Math.min(i, primitiveCount - 1)
      : Math.min(words[segmentPrimitiveBase + i], primitiveCount - 1);
    const p = primitivesBase + primitiveIndex * 2;
    const lineWidth = floats[p];

    const offset = glslOffsetToLine(uv[0], uv[1], ax, ay, bx, by);
    const screen = applyScreenFromUv(screenFromUv, offset);
    if (Math.hypot(screen[0], screen[1]) < lineWidth) {
      const packed = words[p + 1] >>> 0;
      // unpack4x8unorm: low byte first.
      result = alphaComposite(
        [
          (packed & 0xff) / 255,
          ((packed >>> 8) & 0xff) / 255,
          ((packed >>> 16) & 0xff) / 255,
          ((packed >>> 24) & 0xff) / 255,
        ],
        result,
      );
      break;
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// Fixture — a real bake through `VectorPipeline.packPolylineGrid`.
// ═══════════════════════════════════════════════════════════════════════

function buildBakedTile() {
  // Enough segments (>16) that `packPolylineGrid` builds a MULTI-CELL grid;
  // a 1x1 grid would make the cell-offset arithmetic vacuous.
  const polylineSegments = [];
  const polylineSegmentPrimitiveIndices = [];
  for (let i = 0; i < 40; i++) {
    const t = i / 40;
    // Alternating near-horizontal and near-vertical strokes across the tile.
    if (i % 2 === 0) {
      polylineSegments.push([0.02, t, 0.98, t + 0.01]);
    } else {
      polylineSegments.push([t, 0.02, t + 0.01, 0.98]);
    }
    polylineSegmentPrimitiveIndices.push(i % 3);
  }

  const result = {
    show: true,
    polylineSegments,
    polylineSegmentPrimitiveIndices,
    primitiveCount: 3,
    // Distinct widths AND asymmetric colours: a channel-order or an
    // indirection defect has to change the answer.
    widths: [new Uint8Array([3, 9, 21])],
    colors: [
      new Uint8Array([255, 32, 8, 255, 16, 200, 64, 128, 4, 8, 250, 200]),
    ],
  };
  VectorPipeline.packPolylineGrid(result);
  return result;
}

// A representative anisotropic Jacobian inverse: uv→pixels is not uniform in
// x and y, which is exactly the case the `screenFromUv` matrix exists for.
const SCREEN_FROM_UV = [
  [900, 0],
  [-120, 640],
];

// The FORWARD Jacobians the shaders actually receive (`dpdx`/`dpdy` of the tile
// UV), for the tests that exercise the inversion instead of assuming it.
//
// A tile interior: uv→pixels is anisotropic but invertible.
const INTERIOR_JACOBIAN = {
  uvDx: [1 / 900, 0],
  uvDy: [1 / 640 / 7.5, 1 / 640],
};
// A NORTH/SOUTH terrain skirt quad: `v` is bit-identical at all four corners
// (E1 proves this against the real tessellator), so both of its derivatives are
// exactly 0 and the determinant is exactly 0 — not merely small.
const SKIRT_JACOBIAN_NS = {
  uvDx: [1 / 310, 0],
  uvDy: [1 / 9000, 0],
};
// An EAST/WEST skirt quad: the constant axis is `u` instead.
const SKIRT_JACOBIAN_WE = {
  uvDx: [0, 1 / 9000],
  uvDy: [0, 1 / 310],
};

// ── The SAME skirts as the shader actually receives them
// (`NEW-WEBGL-VECTOR-DRAPING-RESIDUAL-EXTENT`).
//
// The two above are the skirt's exact algebra. The shader never sees that: it
// sees `dFdx`/`dpdy` of a PERSPECTIVE-INTERPOLATED varying, and interpolating a
// bit-identical attribute still divides by the interpolated 1/w, so the
// recovered constant axis carries an ulp-scale residue instead of landing on
// the edge value. At nadir the skirt is edge-on, its screen footprint collapses
// to a fraction of a row, and that collapse both amplifies the residue and
// inflates the varying axis' derivatives.
//
// Scaled to the C11-213 acceptance frame: a level-6 tile 320.6 px wide gives a
// true `du/dx` of 1/320.6 = 3.12e-3, and the numbers below inflate it ~9x —
// which is what it takes to report the 139-px-distant fragment measured at
// (710, 259) as inside a 16 px line.
const SKIRT_JACOBIAN_NS_SLIVER = {
  uvDx: [0.028, 3.0e-7],
  uvDy: [0.011, -1.1e-7],
};
const SKIRT_JACOBIAN_WE_SLIVER = {
  uvDx: [3.0e-7, 0.028],
  uvDy: [-1.1e-7, 0.011],
};
// The true uv-per-pixel of that frame's level-6 tile, for the tests that need
// to state how far off the corrupted metric is.
const ACCEPTANCE_FRAME_TRUE_UV_PER_PIXEL = 1 / 320.6;

function sampleRaster() {
  const points = [];
  for (let iy = 0; iy < 24; iy++) {
    for (let ix = 0; ix < 24; ix++) {
      points.push([(ix + 0.5) / 24, (iy + 0.5) / 24]);
    }
  }
  return points;
}

const BASE = [0.25, 0.5, 0.75, 1.0];

function compareBackends(baked, words, options = {}) {
  const differences = [];
  for (const uv of sampleRaster()) {
    const expected = glslVectorPolylineRender(baked, uv, SCREEN_FROM_UV, BASE);
    const actual = options.identity
      ? BASE
      : wgslVectorPolylineRender(
          options.words ?? words,
          uv,
          SCREEN_FROM_UV,
          BASE,
          options.mutate ?? {},
        );
    for (let c = 0; c < 4; c++) {
      if (Math.abs(expected[c] - actual[c]) > 1e-6) {
        differences.push({ uv, channel: c, expected, actual });
        break;
      }
    }
  }
  return differences;
}

/**
 * Same comparison, but the `screenFromUv` matrix is INVERTED by each backend's
 * own model from a shared forward Jacobian — so a divergence in the inversion
 * (M6) is inside the proof instead of outside it. A `null` matrix means the
 * fragment is left untouched, which is the whole point on a skirt quad.
 */
function compareBackendsFromJacobian(baked, words, jacobian, mutate = {}) {
  const { uvDx, uvDy } = jacobian;
  // The GLSL model sees the mutation too: `absoluteSingularEpsilonOnly` is a
  // defect in BOTH shaders, so a leg that only mutated WebGPU would score it as
  // a cross-backend disagreement and miss the point.
  const glslMatrix = glslScreenFromUv(uvDx, uvDy, mutate);
  const wgslMatrix = wgslScreenFromUv(uvDx, uvDy, mutate);
  const differences = [];
  let painted = 0;
  for (const uv of sampleRaster()) {
    const expected =
      glslMatrix === null
        ? BASE
        : glslVectorPolylineRender(baked, uv, glslMatrix, BASE);
    const actual =
      wgslMatrix === null
        ? BASE
        : wgslVectorPolylineRender(words, uv, wgslMatrix, BASE);
    if (actual.some((v, i) => Math.abs(v - BASE[i]) > 1e-6)) {
      painted++;
    }
    for (let c = 0; c < 4; c++) {
      if (Math.abs(expected[c] - actual[c]) > 1e-6) {
        differences.push({ uv, channel: c, expected, actual });
        break;
      }
    }
  }
  return { differences, painted, samples: sampleRaster().length };
}

// ═══════════════════════════════════════════════════════════════════════
// A. Packing contract
// ═══════════════════════════════════════════════════════════════════════

test("A1 — the TS header constants and the WGSL header constants agree", () => {
  assert.equal(VECTOR_TILE_GRID_WIDTH, SHADER_HEADER.gridWidth);
  assert.equal(VECTOR_TILE_GRID_HEIGHT, SHADER_HEADER.gridHeight);
  assert.equal(VECTOR_TILE_SEGMENT_COUNT, SHADER_HEADER.segmentCount);
  assert.equal(VECTOR_TILE_PRIMITIVE_COUNT, SHADER_HEADER.primitiveCount);
  assert.equal(VECTOR_TILE_CELL_END_BASE, SHADER_HEADER.cellEndBase);
  assert.equal(VECTOR_TILE_SEGMENTS_BASE, SHADER_HEADER.segmentsBase);
  assert.equal(
    VECTOR_TILE_SEGMENT_PRIMITIVE_BASE,
    SHADER_HEADER.segmentPrimitiveBase,
  );
  assert.equal(VECTOR_TILE_PRIMITIVES_BASE, SHADER_HEADER.primitivesBase);
  // Eight header words, and the placeholder is exactly that many.
  assert.equal(VECTOR_TILE_HEADER_WORDS, 8);
  assert.equal(VECTOR_TILE_PLACEHOLDER_BYTES, 32);
});

test("A2 — every run the header points at is inside the packed array", () => {
  const baked = buildBakedTile();
  const words = packVectorTileWords(baked);
  assert.ok(words instanceof Uint32Array);

  const gridWidth = words[VECTOR_TILE_GRID_WIDTH];
  const gridHeight = words[VECTOR_TILE_GRID_HEIGHT];
  const segmentCount = words[VECTOR_TILE_SEGMENT_COUNT];
  const primitiveCount = words[VECTOR_TILE_PRIMITIVE_COUNT];

  assert.ok(gridWidth > 1, "fixture must produce a multi-cell grid");
  assert.equal(gridWidth, baked.polylineGridCellIndices[0]);
  assert.equal(gridHeight, baked.polylineGridCellIndices[1]);
  assert.equal(primitiveCount, baked.primitiveCount);
  assert.equal(
    segmentCount,
    baked.polylineGridCellIndices[gridWidth * gridHeight + 1],
    "segmentCount must be the grid's final cell-end offset",
  );

  assert.equal(words[VECTOR_TILE_CELL_END_BASE], VECTOR_TILE_HEADER_WORDS);
  assert.equal(
    words[VECTOR_TILE_SEGMENTS_BASE],
    VECTOR_TILE_HEADER_WORDS + gridWidth * gridHeight,
  );
  assert.equal(
    words[VECTOR_TILE_SEGMENT_PRIMITIVE_BASE],
    words[VECTOR_TILE_SEGMENTS_BASE] + segmentCount * 4,
  );
  assert.equal(
    words[VECTOR_TILE_PRIMITIVES_BASE],
    words[VECTOR_TILE_SEGMENT_PRIMITIVE_BASE] + segmentCount,
  );
  assert.equal(
    words.length,
    words[VECTOR_TILE_PRIMITIVES_BASE] + primitiveCount * 2,
  );

  // Cell end offsets are monotone and never exceed segmentCount — the loop
  // bound the shader clamps against.
  let previous = 0;
  const cellEndBase = words[VECTOR_TILE_CELL_END_BASE];
  for (let i = 0; i < gridWidth * gridHeight; i++) {
    const end = words[cellEndBase + i];
    assert.ok(end >= previous, `cell ${i} end went backwards`);
    assert.ok(end <= segmentCount, `cell ${i} end past the segment run`);
    previous = end;
  }
  // Every segment→primitive entry addresses a real primitive record.
  for (let i = 0; i < segmentCount; i++) {
    const index = words[words[VECTOR_TILE_SEGMENT_PRIMITIVE_BASE] + i];
    assert.ok(index < primitiveCount, `segment ${i} indexes past primitives`);
  }
});

test("A3 — degenerate bakes pack to null so the shader gets the placeholder", () => {
  assert.equal(packVectorTileWords(undefined), null);
  assert.equal(packVectorTileWords({}), null);
  assert.equal(
    packVectorTileWords({
      polylineGridCellIndices: new Uint32Array([0, 0]),
      polylineSegmentTexels: new Float32Array(4),
      polylineSegmentPrimitiveIndicesTexels: new Float32Array(1),
      primitiveCount: 1,
      widths: [new Uint8Array([1])],
      colors: [new Uint8Array([1, 2, 3, 4])],
    }),
    null,
    "a zero-sized grid must not produce a buffer",
  );
  assert.equal(
    packVectorTileWords({
      polylineGridCellIndices: new Uint32Array([1, 1, 0]),
      polylineSegmentTexels: new Float32Array(4),
      polylineSegmentPrimitiveIndicesTexels: new Float32Array(1),
      primitiveCount: 1,
      widths: [new Uint8Array([1])],
      colors: [new Uint8Array([1, 2, 3, 4])],
    }),
    null,
    "zero packed segments must not produce a buffer",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// B. WebGL ↔ WebGPU equivalence, and the mutations that must break it
// ═══════════════════════════════════════════════════════════════════════

test("B1 — WGSL reader over the packed buffer matches the GLSL reader over the raw tables", () => {
  const baked = buildBakedTile();
  const words = packVectorTileWords(baked);
  const differences = compareBackends(baked, words);
  assert.equal(
    differences.length,
    0,
    `backends disagreed at ${differences.length} sample(s); first: ${JSON.stringify(differences[0])}`,
  );
});

test("B2 — the fixture actually exercises the line-hit path (the comparison is not vacuous)", () => {
  const baked = buildBakedTile();
  const words = packVectorTileWords(baked);
  let hits = 0;
  const seenColors = new Set();
  for (const uv of sampleRaster()) {
    const out = wgslVectorPolylineRender(words, uv, SCREEN_FROM_UV, BASE);
    if (out.some((v, i) => Math.abs(v - BASE[i]) > 1e-6)) {
      hits++;
      seenColors.add(out.map((v) => v.toFixed(4)).join(","));
    }
  }
  assert.ok(hits > 20, `only ${hits} of 576 samples hit a line`);
  assert.ok(
    seenColors.size >= 2,
    "fixture must exercise more than one primitive's material",
  );
});

test("M1 — re-introducing the original defect (no WebGPU vector path) is DETECTED", () => {
  const baked = buildBakedTile();
  const words = packVectorTileWords(baked);
  const differences = compareBackends(baked, words, { identity: true });
  assert.ok(
    differences.length > 0,
    "a WebGPU globe that never composites vector polylines must NOT compare equal to WebGL",
  );
});

test("M3 — a BGRA colour packing is DETECTED", () => {
  const baked = buildBakedTile();
  const words = packVectorTileWords(baked);
  const mutated = Uint32Array.from(words);
  const primitivesBase = mutated[VECTOR_TILE_PRIMITIVES_BASE];
  const primitiveCount = mutated[VECTOR_TILE_PRIMITIVE_COUNT];
  for (let i = 0; i < primitiveCount; i++) {
    const p = primitivesBase + i * 2 + 1;
    const packed = mutated[p] >>> 0;
    const r = packed & 0xff;
    const g = (packed >>> 8) & 0xff;
    const b = (packed >>> 16) & 0xff;
    const a = (packed >>> 24) & 0xff;
    mutated[p] = (b | (g << 8) | (r << 16) | (a << 24)) >>> 0;
  }
  const differences = compareBackends(baked, words, { words: mutated });
  assert.ok(
    differences.length > 0,
    "channel-order drift between packer and unpack4x8unorm must be caught",
  );
});

test("M4 — reading the cell start as cellEnd[i] instead of cellEnd[i-1] is DETECTED", () => {
  const baked = buildBakedTile();
  const words = packVectorTileWords(baked);
  const differences = compareBackends(baked, words, {
    mutate: { cellStartOffByOne: true },
  });
  assert.ok(
    differences.length > 0,
    "the grid cell [start, end) window must be load-bearing",
  );
});

test("M5 — dropping the segment→primitive indirection is DETECTED", () => {
  const baked = buildBakedTile();
  const words = packVectorTileWords(baked);
  const differences = compareBackends(baked, words, {
    mutate: { dropIndirection: true },
  });
  assert.ok(
    differences.length > 0,
    "a segment must resolve its material through the packed primitive index",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// E. The UV Jacobian INVERSION — NEW-WEBGPU-VECTOR-DRAPING-HORIZONTAL-STREAKS
// ═══════════════════════════════════════════════════════════════════════

test("E1 — terrain skirt strips carry a bit-identical UV axis, so their Jacobian is EXACTLY singular", () => {
  // Real tessellator, real skirts. This is the physical precondition the whole
  // defect rests on: if a skirt vertex ever got its own u/v, the determinant
  // would be merely small rather than zero and no threshold would fire.
  const width = 5;
  const height = 5;
  const baked = HeightmapTessellator.computeVertices({
    heightmap: new Float32Array(width * height),
    width,
    height,
    skirtHeight: 1000.0,
    // A real level-6 geographic tile from the C11-213 acceptance frame.
    nativeRectangle: new Rectangle(-106.875, 36.5625, -104.0625, 39.375),
    isGeographic: true,
  });
  const encoding = baked.encoding;
  const vertexCount = baked.vertices.length / encoding.stride;
  const uvAt = (index) =>
    encoding.decodeTextureCoordinates(baked.vertices, index, new Cartesian2());

  const gridVertexCount = width * height;
  assert.equal(
    vertexCount,
    gridVertexCount + width * 2 + height * 2,
    "fixture must actually have skirts",
  );

  // Skirt run order, per HeightmapTessellator: west, south, east, north.
  const runs = [
    { name: "west", start: gridVertexCount, count: height, axis: "x" },
    { name: "south", start: gridVertexCount + height, count: width, axis: "y" },
    {
      name: "east",
      start: gridVertexCount + height + width,
      count: height,
      axis: "x",
    },
    {
      name: "north",
      start: gridVertexCount + height + width + height,
      count: width,
      axis: "y",
    },
  ];
  // The grid edge each skirt run hangs from, in grid-vertex indices.
  const edges = {
    west: Array.from({ length: height }, (_, r) => r * width),
    south: Array.from({ length: width }, (_, c) => (height - 1) * width + c),
    east: Array.from({ length: height }, (_, r) => r * width + width - 1),
    north: Array.from({ length: width }, (_, c) => c),
  };

  for (const run of runs) {
    const values = [];
    for (let i = 0; i < run.count; i++) {
      values.push(uvAt(run.start + i)[run.axis]);
    }
    for (const index of edges[run.name]) {
      values.push(uvAt(index)[run.axis]);
    }
    // One distinct value across the skirt run AND the grid edge it hangs from,
    // compared with `===` so a rounding difference would fail. Every vertex of
    // every quad in the strip therefore shares this component, so all UV
    // differences within the strip are parallel and ANY screen-space Jacobian
    // built from them — whichever two triangles the index buffer makes, at
    // whatever camera — is rank 1 with an exactly zero determinant.
    const distinct = new Set(values);
    assert.equal(
      distinct.size,
      1,
      `${run.name} skirt + edge must share ONE ${run.axis} value bit-for-bit, saw ${[...distinct].join(", ")}`,
    );
    // The other component must actually vary, or the strip would be a point and
    // the singularity would be trivial rather than the real geometry.
    const otherAxis = run.axis === "x" ? "y" : "x";
    const spread = new Set(
      Array.from(
        { length: run.count },
        (_, i) => uvAt(run.start + i)[otherAxis],
      ),
    );
    assert.ok(
      spread.size > 1,
      `${run.name} skirt must span a range of ${otherAxis}`,
    );
  }
});

test("E2 — on a skirt Jacobian BOTH backends leave every fragment untouched", () => {
  const baked = buildBakedTile();
  const words = packVectorTileWords(baked);

  // Control: the same fixture, same samples, an INVERTIBLE Jacobian. If this
  // did not paint, E2 would be proving nothing.
  const interior = compareBackendsFromJacobian(baked, words, INTERIOR_JACOBIAN);
  assert.equal(interior.differences.length, 0, "interior legs must agree");
  assert.ok(
    interior.painted > 20,
    `control must drape something; painted ${interior.painted}`,
  );

  for (const [name, jacobian] of [
    ["north/south", SKIRT_JACOBIAN_NS],
    ["east/west", SKIRT_JACOBIAN_WE],
  ]) {
    assert.equal(
      glslScreenFromUv(jacobian.uvDx, jacobian.uvDy),
      null,
      `${name} skirt must have no GLSL screen-space metric`,
    );
    assert.equal(
      wgslScreenFromUv(jacobian.uvDx, jacobian.uvDy),
      null,
      `${name} skirt must have no WGSL screen-space metric`,
    );
    const skirt = compareBackendsFromJacobian(baked, words, jacobian);
    assert.equal(skirt.differences.length, 0, `${name} skirt legs disagreed`);
    assert.equal(
      skirt.painted,
      0,
      `${name} skirt painted ${skirt.painted} of ${skirt.samples} fragments; a skirt must drape NOTHING`,
    );
  }
});

test("M6 — inverting a singular Jacobian to the ZERO matrix is DETECTED", () => {
  const baked = buildBakedTile();
  const words = packVectorTileWords(baked);
  for (const [name, jacobian] of [
    ["north/south", SKIRT_JACOBIAN_NS],
    ["east/west", SKIRT_JACOBIAN_WE],
  ]) {
    const mutated = compareBackendsFromJacobian(baked, words, jacobian, {
      singularJacobianZeroMatrix: true,
    });
    assert.ok(
      mutated.differences.length > 0,
      `a zero-matrix inverse on a ${name} skirt must NOT compare equal to WebGL`,
    );
    // Not a few stray pixels: a zero screen metric makes the distance test 0 <
    // lineWidth for the first segment in EVERY cell that holds one, which is
    // what turned the skirt ring into a full-width streak in the probe frame.
    assert.ok(
      mutated.painted > mutated.samples * 0.5,
      `the defect must paint most of the skirt; painted ${mutated.painted} of ${mutated.samples}`,
    );
  }
});

test("E4 — an edge-on skirt is rejected even though its determinant is NOT zero", () => {
  // NEW-WEBGL-VECTOR-DRAPING-RESIDUAL-EXTENT. This is the case the Batch-834
  // guard could not see, and the reason it moved WebGL's numbers by exactly
  // zero pixels: the determinant is ~1e-9, twelve orders of magnitude above the
  // 1e-20 floor, so the fragment sailed through and got inverted.
  const baked = buildBakedTile();
  const words = packVectorTileWords(baked);

  for (const [name, jacobian] of [
    ["north/south", SKIRT_JACOBIAN_NS_SLIVER],
    ["east/west", SKIRT_JACOBIAN_WE_SLIVER],
  ]) {
    const det = Math.abs(determinant2x2(jacobian.uvDx, jacobian.uvDy));
    assert.ok(
      det > GLSL_SINGULAR_EPSILON * 1e6,
      `${name} sliver must be far above the exactly-singular floor to be the case under test; |det| = ${det}`,
    );
    assert.ok(
      conditionRatio(jacobian.uvDx, jacobian.uvDy) > GLSL_CONDITION_CEILING,
      `${name} sliver must be over the condition ceiling`,
    );

    // WHY it paints without the guard: the inverted matrix under-reports the
    // pixel distance of a purely-u offset by a large factor, so a segment far
    // outside the line's width still tests as inside it.
    const corrupted = inverse2x2(
      jacobian.uvDx,
      jacobian.uvDy,
      determinant2x2(jacobian.uvDx, jacobian.uvDy),
    );
    const offset = name === "north/south" ? [0.05, 0] : [0, 0.05];
    const reported = Math.hypot(...applyScreenFromUv(corrupted, offset));
    const truePixels = 0.05 / ACCEPTANCE_FRAME_TRUE_UV_PER_PIXEL;
    assert.ok(
      reported < truePixels / 4,
      `${name} sliver must badly UNDER-report distance for the defect to exist; reported ${reported.toFixed(1)} px vs true ${truePixels.toFixed(1)} px`,
    );

    assert.equal(
      glslScreenFromUv(jacobian.uvDx, jacobian.uvDy),
      null,
      `${name} sliver must have no GLSL screen-space metric`,
    );
    assert.equal(
      wgslScreenFromUv(jacobian.uvDx, jacobian.uvDy),
      null,
      `${name} sliver must have no WGSL screen-space metric`,
    );

    const skirt = compareBackendsFromJacobian(baked, words, jacobian);
    assert.equal(skirt.differences.length, 0, `${name} sliver legs disagreed`);
    assert.equal(
      skirt.painted,
      0,
      `${name} sliver painted ${skirt.painted} of ${skirt.samples} fragments; a skirt must drape NOTHING`,
    );
  }
});

test("M7 — restoring the exactly-zero-determinant-only guard is DETECTED", () => {
  // The mutation is the Batch-834 shader verbatim: keep the 1e-20 floor, drop
  // the condition term. It must bring the false positives back on BOTH
  // backends — this is not a WebGPU-only defect, which is why the mutation is
  // applied to the GLSL model too.
  const baked = buildBakedTile();
  const words = packVectorTileWords(baked);
  for (const [name, jacobian] of [
    ["north/south", SKIRT_JACOBIAN_NS_SLIVER],
    ["east/west", SKIRT_JACOBIAN_WE_SLIVER],
  ]) {
    const mutated = compareBackendsFromJacobian(baked, words, jacobian, {
      absoluteSingularEpsilonOnly: true,
    });
    assert.ok(
      mutated.painted > 0,
      `the ${name} sliver must drape again once the condition term is dropped, or this spec would pass with the defect present`,
    );
    // The exactly-singular skirts must STILL be caught by the surviving
    // 1e-20 floor, or the mutation would be proving the wrong thing.
    for (const exact of [SKIRT_JACOBIAN_NS, SKIRT_JACOBIAN_WE]) {
      assert.equal(
        glslScreenFromUv(exact.uvDx, exact.uvDy, {
          absoluteSingularEpsilonOnly: true,
        }),
        null,
        "the exactly-zero determinant must stay caught by the epsilon floor",
      );
    }
  }
});

test("E5 — the condition ceiling leaves real foreshortening alone", () => {
  // The guard must not be one-sided. A pixels→uv map that is a rotation times
  // an anisotropic scale is exactly what a grazing camera produces, and the
  // whole reason `screenFromUv` exists; rejecting it would silently delete the
  // drape at the far end of gate D's oblique view instead of fixing anything.
  // Worst case is a 45° rotation, where κ + 1/κ peaks for a given anisotropy.
  const worst = { ratio: 0, angleDeg: 0, condition: 0 };
  for (let ratio = 1; ratio <= 100; ratio++) {
    for (let angleDeg = 0; angleDeg <= 90; angleDeg += 5) {
      const a = (angleDeg * Math.PI) / 180;
      const k = 1 / ratio;
      // columns of diag(1, k) * R(a), scaled to a plausible uv-per-pixel.
      const s = 1 / 320.6;
      const c0 = [s * Math.cos(a), s * k * Math.sin(a)];
      const c1 = [-s * Math.sin(a), s * k * Math.cos(a)];
      const condition = conditionRatio(c0, c1);
      if (condition > worst.condition) {
        Object.assign(worst, { ratio, angleDeg, condition });
      }
      assert.ok(
        condition <= GLSL_CONDITION_CEILING,
        `${ratio}:1 foreshortening at ${angleDeg}° must still drape; condition ${condition.toFixed(1)} exceeded the ceiling ${GLSL_CONDITION_CEILING}`,
      );
    }
  }
  // Pin the headroom so a future tightening of the ceiling has to argue with a
  // number rather than silently eat the grazing case.
  assert.ok(
    worst.condition * 5 < GLSL_CONDITION_CEILING,
    `worst legitimate condition ${worst.condition.toFixed(1)} (${worst.ratio}:1 at ${worst.angleDeg}°) leaves under 5x headroom below the ceiling ${GLSL_CONDITION_CEILING}`,
  );
});

test("E3 — neither shader inverts a singular Jacobian, and both use the same threshold", () => {
  assert.equal(
    WGSL_SINGULAR_EPSILON,
    GLSL_SINGULAR_EPSILON,
    "the two backends must abandon the fragment at the same determinant",
  );
  assert.equal(
    WGSL_CONDITION_CEILING,
    GLSL_CONDITION_CEILING,
    "the two backends must abandon the fragment at the same condition number",
  );

  const wgslStart = wgsl.indexOf("fn vectorInverse2x2(");
  assert.ok(wgslStart > 0);
  const wgslRest = wgsl.slice(wgslStart);
  const wgslBody = wgslRest.slice(0, wgslRest.indexOf("\nfn ", 1));
  assert.ok(
    !/return\s+mat2x2<f32>\(\s*vec2<f32>\(0\.0,\s*0\.0\),\s*vec2<f32>\(0\.0,\s*0\.0\),?\s*\)/.test(
      wgslBody,
    ),
    "vectorInverse2x2 must not answer a singular matrix with the zero matrix — that is a distance of 0, i.e. an unconditional hit",
  );

  // The abandon has to be in the RENDER function, before any distance test.
  const renderStart = wgsl.indexOf("fn vectorPolylineRender(");
  const renderRest = wgsl.slice(renderStart);
  const renderBody = renderRest.slice(0, renderRest.indexOf("\nfn ", 1));
  const guard = renderBody.indexOf("abs(uvJacobianDet) < ");
  const distanceTest = renderBody.indexOf("length(screenFromUv * offsetUv)");
  assert.ok(guard > 0, "the WGSL render function must test the determinant");
  assert.ok(distanceTest > guard, "the guard must precede the distance test");
  assert.match(
    renderBody.slice(guard, distanceTest),
    /return baseColor;/,
    "a singular Jacobian must return the untouched base colour",
  );

  // GLSL relied on `inverse()` being undefined for a singular matrix. It is
  // explicit now, so the two backends agree by construction rather than by
  // driver behaviour.
  const glslGuard = glslCommon.indexOf("abs(uvJacobianDet) < ");
  const glslInverse = glslCommon.indexOf("inverse(uvJacobian)");
  const glslDistance = glslCommon.indexOf("length(screenFromUv * offsetUv)");
  assert.ok(glslGuard > 0 && glslInverse > glslGuard);
  assert.ok(glslDistance > glslInverse);
  assert.match(
    glslCommon.slice(glslGuard, glslInverse),
    /return baseColor;/,
    "VectorCommon.glsl must abandon the fragment rather than call inverse() on a singular matrix",
  );

  // The condition term has to sit in the SAME abandon, ahead of the inversion —
  // NEW-WEBGL-VECTOR-DRAPING-RESIDUAL-EXTENT is the case where the determinant
  // term alone passes and the matrix is inverted anyway.
  assert.match(
    renderBody.slice(guard, distanceTest),
    /uvJacobianNormSquared\s*>\s*VECTOR_UV_JACOBIAN_MAX_CONDITION\s*\*\s*abs\(uvJacobianDet\)/,
    "GlobeTerrain.wgsl must also abandon a badly conditioned Jacobian, not only an exactly singular one",
  );
  assert.match(
    glslCommon.slice(glslGuard, glslInverse),
    /uvJacobianNormSquared\s*>\s*VECTOR_UV_JACOBIAN_MAX_CONDITION\s*\*\s*abs\(uvJacobianDet\)/,
    "VectorCommon.glsl must also abandon a badly conditioned Jacobian, not only an exactly singular one",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// C. Bake routing — the real VectorPipeline, and the mutation that skips it
// ═══════════════════════════════════════════════════════════════════════

function fakeWebGPUContext(calls) {
  return {
    getFeatureRenderer(key) {
      return {
        prepareVectorTileData(context, data) {
          calls.push({ key, context, data });
          data.rendererResources = {
            destroyed: false,
            destroy() {
              this.destroyed = true;
            },
          };
          return true;
        },
      };
    },
  };
}

// A WebGL context registers no GLOBE_SURFACE renderer. This double models that
// AND has no `_gl`, so falling through to the WebGL `Texture` path throws —
// which is exactly the observable we want ("the texture path was entered").
function fakeWebGLContext() {
  return {
    getFeatureRenderer() {
      return undefined;
    },
  };
}

test("C0 — VectorProvider offers one complete CPU bake before any WebGL realization", () => {
  for (const call of [
    "packPolylineGrid(result)",
    "packPolygonGrid(result)",
    "packPrimitiveTextures(context, result)",
    "packPolylineTextures(context, result)",
    "packPolygonTextures(context, result)",
  ]) {
    assert.equal(
      vectorProviderJs.split(call).length - 1,
      1,
      `${call} must occur exactly once in VectorProvider`,
    );
  }

  const polylineGrid = vectorProviderJs.indexOf("packPolylineGrid(result)");
  const polygonGrid = vectorProviderJs.indexOf("packPolygonGrid(result)");
  const claim = vectorProviderJs.indexOf(
    "packPrimitiveTextures(context, result)",
  );
  const polylineTextures = vectorProviderJs.indexOf(
    "packPolylineTextures(context, result)",
  );
  const polygonTextures = vectorProviderJs.indexOf(
    "packPolygonTextures(context, result)",
  );
  assert.ok(polylineGrid < claim && polygonGrid < claim);
  assert.ok(claim < polylineTextures && claim < polygonTextures);
  assert.match(
    vectorProviderJs,
    /if \(VectorPipeline\.packPrimitiveTextures\(context, result\)\) \{\s*return result;\s*\}/,
    "a backend claim must return before either WebGL texture family is constructed",
  );
});

test("C1 — one backend claim suppresses every WebGL texture family", () => {
  const baked = buildBakedTile();
  baked.polygonRings = [
    new Float64Array([0.2, 0.2, 0.8, 0.2, 0.8, 0.8, 0.2, 0.8]),
  ];
  baked.polygonRingPrimitiveIndices = [2];
  VectorPipeline.packPolygonGrid(baked);
  const calls = [];
  const context = fakeWebGPUContext(calls);
  const claimed = VectorPipeline.packPrimitiveTextures(context, baked);

  assert.equal(claimed, true);
  assert.equal(
    calls.length,
    1,
    "the backend must receive the bake exactly once",
  );
  assert.equal(calls[0].context, context);
  assert.equal(calls[0].data, baked);
  assert.ok(
    baked.polylineGridCellIndices && baked.polygonGridCellIndices,
    "both CPU lookup families must be complete before the backend claim",
  );
  assert.ok(baked.rendererResources, "backend resources must be installed");
  for (const slot of [
    "polylineSegmentTexture",
    "widthTexture",
    "colorTexture",
    "polylineSegmentPrimitiveIndicesTexture",
    "polylineGridCellIndicesTexture",
    "polygonEdgeTexture",
    "polygonEdgePrimitiveIndicesTexture",
    "polygonGridCellIndicesTexture",
  ]) {
    assert.equal(
      baked[slot],
      undefined,
      `${slot} must stay unallocated on a backend-claimed bake`,
    );
  }
});

test("C2 — with no backend renderer the WebGL shared and polyline texture paths still run", () => {
  assert.throws(
    () =>
      VectorPipeline.packPrimitiveTextures(
        fakeWebGLContext(),
        buildBakedTile(),
      ),
    "the WebGL shared primitive textures must be reached when no feature renderer claims the bake",
  );
  assert.throws(
    () =>
      VectorPipeline.packPolylineTextures(fakeWebGLContext(), buildBakedTile()),
    "the WebGL polyline texture family must remain reachable",
  );
});

test("M2 — a bake that ignores the backend is DETECTED", () => {
  // The pre-fix `packPolylineTextures`: straight to `new Texture(...)`.
  const baked = buildBakedTile();
  const calls = [];
  let threw = false;
  try {
    // Reproduce the fallback by handing the ownership arbiter a context whose
    // feature renderer DECLINES, and assert it reaches WebGL allocation.
    VectorPipeline.packPrimitiveTextures(
      {
        getFeatureRenderer(key) {
          calls.push(key);
          return { prepareVectorTileData: () => false };
        },
      },
      baked,
    );
  } catch {
    threw = true;
  }
  assert.equal(calls.length, 1);
  assert.ok(
    threw,
    "declining the bake must fall through to the WebGL texture path, proving the WebGPU branch is what suppresses it",
  );
  assert.equal(baked.rendererResources, undefined);
});

test("C3 — freeResources releases backend resources and clears the slot", () => {
  const baked = buildBakedTile();
  const calls = [];
  VectorPipeline.packPrimitiveTextures(fakeWebGPUContext(calls), baked);
  const resources = baked.rendererResources;
  VectorPipeline.freeResources(baked);
  assert.equal(resources.destroyed, true);
  assert.equal(baked.rendererResources, undefined);
});

test("C4 — resolveVectorTileBuffer refuses another device's buffer and destroyed buffers", () => {
  const deviceA = { id: "A" };
  const deviceB = { id: "B" };
  const placeholder = { id: "placeholder" };
  const realBuffer = { id: "real" };

  assert.equal(
    resolveVectorTileBuffer(deviceA, undefined, placeholder),
    placeholder,
  );
  assert.equal(
    resolveVectorTileBuffer(
      deviceA,
      { rendererResources: { device: deviceB, buffer: realBuffer } },
      placeholder,
    ),
    placeholder,
    "a buffer realized on another device must never be bound (multi-context)",
  );
  assert.equal(
    resolveVectorTileBuffer(
      deviceA,
      { rendererResources: { device: deviceA, buffer: null } },
      placeholder,
    ),
    placeholder,
    "a destroyed buffer must fall back to the placeholder",
  );
  assert.equal(
    resolveVectorTileBuffer(
      deviceA,
      { rendererResources: { device: deviceA, buffer: realBuffer } },
      placeholder,
    ),
    realBuffer,
  );
});

test("C5 — cached CPU bakes realize once per exact device generation", () => {
  const previousUsage = globalThis.GPUBufferUsage;
  globalThis.GPUBufferUsage = { STORAGE: 1, COPY_DST: 2 };
  try {
    const baked = buildBakedTile();
    const retainedGrid = baked.polylineGridCellIndices;
    const retainedSegments = baked.polylineSegmentTexels;
    const events = [];
    const makeDevice = (id) => ({
      id,
      createBuffer(descriptor) {
        const buffer = {
          id: `${id}-${events.length}`,
          destroyed: false,
          destroy() {
            this.destroyed = true;
            events.push({ type: "destroy", device: id, buffer: this });
          },
        };
        events.push({ type: "create", device: id, descriptor, buffer });
        return buffer;
      },
      queue: {
        writeBuffer(buffer, offset, words) {
          events.push({
            type: "write",
            device: id,
            buffer,
            offset,
            byteLength: words.byteLength,
          });
        },
      },
    });

    const deviceA = makeDevice("A");
    const deviceB = makeDevice("B");
    let featureLookups = 0;
    let backendClaims = 0;
    const context = {
      device: deviceA,
      resourceGeneration: 1,
      getFeatureRenderer() {
        featureLookups++;
        return {
          prepareVectorTileData(activeContext, data) {
            backendClaims++;
            return prepareWebGPUVectorTileData(activeContext, data);
          },
        };
      },
    };

    assert.equal(VectorPipeline.prepareRendererResources(context, baked), true);
    const generation1 = baked.rendererResources;
    assert.equal(VectorPipeline.prepareRendererResources(context, baked), true);
    assert.equal(baked.rendererResources, generation1);
    assert.equal(featureLookups, 1, "same tuple must bypass the registry");
    assert.equal(backendClaims, 1, "same tuple must not be claimed twice");

    context.resourceGeneration = 2;
    assert.equal(VectorPipeline.prepareRendererResources(context, baked), true);
    const generation2 = baked.rendererResources;
    assert.notEqual(generation2, generation1);
    assert.equal(generation1.buffer, null, "old generation must be destroyed");
    assert.equal(generation2.resourceGeneration, 2);

    context.device = deviceB;
    assert.equal(VectorPipeline.prepareRendererResources(context, baked), true);
    const deviceBResources = baked.rendererResources;
    assert.equal(
      generation2.buffer,
      null,
      "old device buffer must be destroyed",
    );
    assert.equal(deviceBResources.device, deviceB);
    assert.equal(VectorPipeline.prepareRendererResources(context, baked), true);
    assert.equal(featureLookups, 3);
    assert.equal(backendClaims, 3, "one claim is allowed for each exact tuple");
    assert.equal(events.filter((event) => event.type === "create").length, 3);
    assert.equal(events.filter((event) => event.type === "write").length, 3);

    assert.equal(baked.polylineGridCellIndices, retainedGrid);
    assert.equal(baked.polylineSegmentTexels, retainedSegments);
    assert.match(
      vectorProviderJs,
      /if \(!intersectRectangles[\s\S]{0,1200}?VectorPipeline\.prepareRendererResources\(context, currentData\);[\s\S]{0,80}?return currentData;/,
      "device reconciliation must happen during cached tile preparation",
    );
    assert.doesNotMatch(
      rendererTs,
      /prepareWebGPUVectorTileData\(/,
      "the draw/bind-group path must only resolve already-realized buffers",
    );
    VectorPipeline.freeResources(baked);
  } finally {
    if (previousUsage === undefined) {
      delete globalThis.GPUBufferUsage;
    } else {
      globalThis.GPUBufferUsage = previousUsage;
    }
  }
});

test("C6 — unchanged WebGL tiles negative-cache one exact context tuple", () => {
  const baked = buildBakedTile();
  let featureLookups = 0;
  const webglContext = {
    resourceGeneration: 0,
    getFeatureRenderer() {
      featureLookups++;
      return undefined;
    },
  };

  assert.equal(
    VectorPipeline.prepareRendererResources(webglContext, baked),
    false,
  );
  assert.equal(featureLookups, 1);

  for (let frame = 0; frame < 100; frame++) {
    assert.equal(
      VectorPipeline.prepareRendererResources(webglContext, baked),
      false,
    );
  }
  assert.equal(
    featureLookups,
    1,
    "the same WebGL tuple must bypass the feature-renderer registry",
  );

  webglContext.resourceGeneration = 1;
  assert.equal(
    VectorPipeline.prepareRendererResources(webglContext, baked),
    false,
  );
  assert.equal(
    featureLookups,
    2,
    "a new native-resource generation must receive one fresh probe",
  );

  let secondContextLookups = 0;
  const secondWebglContext = {
    resourceGeneration: 1,
    getFeatureRenderer() {
      secondContextLookups++;
      return undefined;
    },
  };
  assert.equal(
    VectorPipeline.prepareRendererResources(secondWebglContext, baked),
    false,
  );
  assert.equal(secondContextLookups, 1);
  assert.equal(
    VectorPipeline.prepareRendererResources(secondWebglContext, baked),
    false,
  );
  assert.equal(secondContextLookups, 1);

  VectorPipeline.freeResources(baked);
  assert.equal(baked.rendererResourceMissContext, undefined);
  assert.equal(baked.rendererResourceMissGeneration, undefined);
});

// ═══════════════════════════════════════════════════════════════════════
// D. Source contracts — lockstep and the WGSL rules that forced the shape
// ═══════════════════════════════════════════════════════════════════════

test("D1 — both twins carry a vector path", () => {
  assert.match(glslCommon, /vec4 vectorPolylineRender\(/);
  assert.match(glslGlobe, /#ifdef HAS_VECTOR_LAYER/);
  assert.match(glslGlobe, /vectorPolylineRender\(v_textureCoordinates\.xy/);
  assert.match(wgsl, /fn vectorPolylineRender\(/);
  assert.match(wgsl, /fn vectorOffsetToLine\(/);
});

test("D2 — the WGSL lookup is one read-only storage buffer at group 2 binding 11", () => {
  assert.match(
    wgsl,
    /@group\(2\) @binding\(11\) var<storage, read> vectorTileData: array<u32>;/,
    "the vector lookup must be a read-only storage buffer, not sampled textures",
  );
  assert.match(
    layoutsTs,
    /storageBuffer\(11, Stage\.FRAGMENT, \{ readOnly: true \}\)/,
    "the group-2 layout must declare binding 11 to match the WGSL",
  );
  assert.match(
    rendererTs,
    /\{ binding: 11, resource: \{ buffer: vectorBuffer \} \}/,
    "the group-2 bind group must supply binding 11 on every draw",
  );
  // The sampled-texture budget is untouched — five extra sampled textures
  // would break default-limit adapters, which is why this is a buffer.
  const typesTs = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts",
    ),
    "utf8",
  );
  assert.match(
    typesTs,
    /export const GLOBE_NON_IMAGERY_FRAGMENT_TEXTURES = 12;/,
    "adding sampled textures for the vector layer would overflow the reduced layout",
  );
});

test("D3 — derivatives are hoisted to fragment entry, never taken under the storage-buffer gate", () => {
  const start = wgsl.indexOf("fn vectorPolylineRender(");
  assert.ok(start > 0);
  // Body extends to the next top-level `fn ` declaration.
  const rest = wgsl.slice(start);
  const end = rest.indexOf("\nfn ", 1);
  const body = end > 0 ? rest.slice(0, end) : rest;
  assert.ok(
    !/\bdpdx\(|\bdpdy\(|\bfwidth\(/.test(body),
    "a derivative builtin inside the vector function would be a WGSL uniformity error (storage reads are non-uniform)",
  );
  assert.match(
    wgsl,
    /let vectorUV_dx = dpdx\(input\.v_textureCoordinates\.xy\);/,
    "the Jacobian must be taken at fragment entry, on the RAW (unclamped) tile UV like GlobeFS does",
  );
  assert.match(
    wgsl,
    /let vectorUV_dy = dpdy\(input\.v_textureCoordinates\.xy\);/,
  );
});

test("D4 — the composite runs after the underground tint and before the translucency ramp", () => {
  // Anchored on the three statements themselves, not on the comments above
  // them: `undergroundControl` / `localizedTranslucencyRectangle` are each read
  // exactly once, inside their own composite block.
  const undergroundWgsl = wgsl.indexOf(
    "let distanceFromEllipsoid = camera.undergroundControl.y;",
  );
  const vectorWgsl = wgsl.indexOf(
    "let vectorComposited = vectorPolylineRender(",
  );
  const translucencyWgsl = wgsl.indexOf(
    "let tRect = tile.localizedTranslucencyRectangle;",
  );
  assert.ok(undergroundWgsl > 0 && vectorWgsl > 0 && translucencyWgsl > 0);
  assert.ok(
    undergroundWgsl < vectorWgsl && vectorWgsl < translucencyWgsl,
    "WGSL ordering must mirror GlobeFS: UNDERGROUND_COLOR, HAS_VECTOR_LAYER, TRANSLUCENT",
  );

  // `lastIndexOf`: GlobeFS declares UNDERGROUND_COLOR / TRANSLUCENT blocks in
  // its uniform + forward-declaration prologue too; the ordering that matters
  // is the one in the composite tail of `main()`.
  const undergroundGlsl = glslGlobe.lastIndexOf("#ifdef UNDERGROUND_COLOR");
  const vectorGlsl = glslGlobe.lastIndexOf("#ifdef HAS_VECTOR_LAYER");
  const translucentGlsl = glslGlobe.lastIndexOf("#ifdef TRANSLUCENT");
  assert.ok(undergroundGlsl > 0 && vectorGlsl > 0 && translucentGlsl > 0);
  assert.ok(
    undergroundGlsl < vectorGlsl && vectorGlsl < translucentGlsl,
    "the GLSL ordering this mirrors must not have moved",
  );
});

test("D5 — the bake routes through the feature-renderer registry, not an isWebGPU test", () => {
  assert.match(
    vectorPipelineJs,
    /featureRenderer\.prepareVectorTileData\(context, result\)/,
  );
  assert.ok(
    !/isWebGPU|Renderer\/WebGPU\//.test(vectorPipelineJs),
    "Core/VectorPipeline.js must not branch on the backend or import Renderer/WebGPU (Principle 2)",
  );
  assert.match(
    featureRenderersTs,
    /prepareVectorTileData: prepareWebGPUVectorTileData,/,
    "the WebGPU GLOBE_SURFACE descriptor must expose the bake hook",
  );
});

test("D6 — the shader's per-fragment loop is bounded by the header's own segment count", () => {
  assert.match(
    wgsl,
    /indexEnd = min\(indexEnd, segmentCount\);/,
    "an unbounded per-fragment loop from a corrupt offset must be impossible",
  );
  assert.match(wgsl, /indexStart = min\(indexStart, indexEnd\);/);
});

test("D7 — GlobeTerrain.wgsl still passes naga validation with the vector path", async () => {
  const nagaDirectory = path.join(
    root,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  // naga enforces WGSL's uniformity rules, so this is what proves the hoisted
  // derivatives are actually legal rather than merely plausible.
  assert.doesNotThrow(() => naga.validate_wgsl(expandDefines(wgsl, [])));
  assert.doesNotThrow(() =>
    naga.validate_wgsl(expandDefines(wgsl, ["GLOBE_IMAGERY_REDUCED"])),
  );
});

// `//>>ifdef` expansion for a given define set — the `//>>else` branch is the
// historical path, matching `WebGPUShaderPreprocessor`'s zero-mask contract.
function expandDefines(source, defines) {
  const active = new Set(defines);
  const out = [];
  const stack = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//>>ifdef")) {
      const flag = trimmed.split(/\s+/)[1];
      stack.push({ emitting: active.has(flag) });
      continue;
    }
    if (trimmed.startsWith("//>>else")) {
      const top = stack[stack.length - 1];
      top.emitting = !top.emitting;
      continue;
    }
    if (trimmed.startsWith("//>>endif")) {
      stack.pop();
      continue;
    }
    if (stack.every((frame) => frame.emitting)) {
      out.push(line);
    }
  }
  return out.join("\n");
}
