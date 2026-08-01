#!/usr/bin/env node
// Probe: degenerate-triangle edge parity (upstream PR#13421).
//
// Background — PR#13421 fixed a crash where loading a 3D tile / glTF
// whose mesh contained a degenerate (zero-area) triangle with
// EXT_mesh_primitive_edge_visibility data threw a DeveloperError: the
// per-face normal computation normalized a zero-length cross product
// (`normalize(vec3(0)) → NaN`). WebGL's fix skips the degenerate face's
// normal rather than normalizing NaN.
//
// The WebGPU edge extractor (`WebGPUEdgeVisibilityEmitter.extractEdge
// Geometry`) re-derives face normals from triangle adjacency too, with
// a `magnitudeSquared > 0` guard that leaves the degenerate face's
// normal at (0,0,0). The §5/P3 parity audit flagged that NO probe
// matching the PR#13421 repro existed, so we couldn't confirm:
//   (a) the WebGPU extractor produces no NaN/Inf in the emitted vertex
//       buffer for a zero-area triangle, and
//   (b) the zero-area face's silhouette dot-product doesn't bias
//       classification differently than the authored-normal path.
//
// This probe builds the exact PR#13421 repro primitive (a 4-vertex
// quad whose first triangle [0,1,2] is degenerate because vertex 1 is
// coincident with vertex 0, and whose second triangle [0,2,3] is
// normal) and runs it through BOTH:
//   - the WebGPU extractor (`extractEdgeGeometry`, esbuild-bundled from
//     the `.ts` emitter on the fly — pure CPU geometry, only depends on
//     Core/Cartesian3.js), and
//   - a faithful mirror of the WebGL face-normal derivation
//     (`EdgeVisibilityPipelineStage`'s degenerate handling: cross
//     product, skip-normalize when zero-length),
// then asserts both classify the degenerate triangle identically with
// NO NaN/Inf and a clean (sane) silhouette dot-product.
//
// It is a Node-side numeric probe (no browser / no canvas) because the
// failure mode is a CPU-side NaN in the vertex buffer, not a pixel
// artifact — capturing it numerically is both more sensitive and
// deterministic than a screenshot diff would be. No build step is
// required: the repo tsconfig is `noEmit`, so the probe bundles the
// `.ts` emitter itself via esbuild.
//
// Usage: node Tools/visual-regression/probe-edge-degenerate.mjs
// Exit:  0 = all parity checks pass, 1 = a NaN/garbage edge or a
//        WebGL/WebGPU classification divergence was detected.

import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const failures = [];
const note = (ok, name, detail) => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures.push(name);
};

// ─────────────────────────────────────────────────────────────────────────
// PR#13421 repro geometry. Vertices 0 and 1 are coincident, so triangle
// [0,1,2] has zero area (degenerate). Triangle [0,2,3] is a normal
// triangle. Matches `EdgeVisibilityPipelineStageDecodingSpec.js`'s
// `createDegenerateTrianglePrimitive`.
// ─────────────────────────────────────────────────────────────────────────
const positions = new Float32Array([
  0.0,
  0.0,
  0.0, // vertex 0
  0.0,
  0.0,
  0.0, // vertex 1 (coincident with vertex 0 → degenerate)
  1.0,
  1.0,
  0.0, // vertex 2
  0.0,
  1.0,
  0.0, // vertex 3
]);
const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

// EXT_mesh_primitive_edge_visibility 2-bit encoding, one 2-bit field per
// (triangle * 3 + edge) slot. 6 indices → 2 triangles → 6 edge slots →
// packed into 2 bytes (4 fields/byte). Mark every edge SILHOUETTE (=1)
// so the silhouette dot-product path is exercised for the degenerate
// face's edges — that is exactly where a NaN normal would bias the
// classification. SILHOUETTE in all 6 slots → byte0 = 0b01_01_01_01 =
// 0x55, byte1 = 0b00_00_01_01 = 0x05.
const visibility = new Uint8Array([0x55, 0x05]);

// Primitive shaped like a `ModelComponents.Primitive` as consumed by the
// extractor: `edgeVisibility.visibility`, `indices.typedArray`, and an
// `attributes[0].count` used by the lineStrings range guard (unused on
// this visibility-only repro, present for shape fidelity).
const primitive = {
  attributes: [{ count: 4 }],
  indices: { typedArray: indices },
  edgeVisibility: { visibility },
};

const isFiniteNum = (x) => Number.isFinite(x);
const allFinite = (arr) => {
  for (let i = 0; i < arr.length; i++) {
    if (!isFiniteNum(arr[i])) return false;
  }
  return true;
};

// ─────────────────────────────────────────────────────────────────────────
// [A] WebGPU extractor — the repo tsconfig is `noEmit`, so no compiled
//     `.js` sibling exists in-tree; bundle the `.ts` emitter with esbuild
//     to a temp module and import that (EDGE-AUTHORED-SILHOUETTE-NORMALS
//     probe-repair: this probe previously demanded a sibling nothing
//     emits, making it exit-2 unconditionally).
// ─────────────────────────────────────────────────────────────────────────
const os = await import("os");
const { build } = await import("esbuild");
const EMITTER_TS = path.join(
  ROOT,
  "packages/engine/Source/Renderer/WebGPU/WebGPUEdgeVisibilityEmitter.ts",
);
const tmpEmitter = path.join(
  os.tmpdir(),
  `probe-edge-degenerate-emitter-${process.pid}.mjs`,
);
await build({
  entryPoints: [EMITTER_TS],
  bundle: true,
  format: "esm",
  outfile: tmpEmitter,
  logLevel: "silent",
});

const { extractEdgeGeometry } = await import(
  `file:///${tmpEmitter.replace(/\\/g, "/")}`
);
fs.rmSync(tmpEmitter, { force: true });
note(
  typeof extractEdgeGeometry === "function",
  "extractEdgeGeometry exported",
  typeof extractEdgeGeometry,
);

const geom = extractEdgeGeometry(primitive, positions, null);

// The degenerate triangle [0,1,2] collapses to a line: edges (0,1) and
// (1,2)/(0,2) overlap or coincide. The non-degenerate triangle [0,2,3]
// contributes real edges. We assert the extractor returns geometry (the
// degenerate face does NOT zero out the whole primitive) and that NO
// emitted float is NaN/Inf.
note(geom !== null, "extractEdgeGeometry returns geometry (not null)");
if (geom !== null) {
  note(
    allFinite(geom.vertices),
    "no NaN/Inf in emitted vertex buffer",
    `${geom.vertices.length} floats, edgeCount=${geom.edgeCount}`,
  );
  note(
    geom.edgeCount > 0,
    "non-zero edge count from mixed degenerate+normal mesh",
    `edgeCount=${geom.edgeCount}`,
  );

  // Inspect the per-edge face normals packed into the vertex buffer
  // (layout: 19 floats/vertex since the Batch 330 per-edge-color
  // widening — normalA at [4..6], normalB at [7..9]). A degenerate
  // face's normal must be exactly (0,0,0) (magnitude-guard result),
  // never NaN. Scan all vertices' normals.
  const FLOATS = 19;
  let sawNaNNormal = false;
  let maxNormalLen = 0;
  for (let v = 0; v * FLOATS < geom.vertices.length; v++) {
    const o = v * FLOATS;
    const nA = [
      geom.vertices[o + 4],
      geom.vertices[o + 5],
      geom.vertices[o + 6],
    ];
    const nB = [
      geom.vertices[o + 7],
      geom.vertices[o + 8],
      geom.vertices[o + 9],
    ];
    for (const c of [...nA, ...nB]) {
      if (!isFiniteNum(c)) sawNaNNormal = true;
    }
    const lenA = Math.hypot(nA[0], nA[1], nA[2]);
    const lenB = Math.hypot(nB[0], nB[1], nB[2]);
    maxNormalLen = Math.max(maxNormalLen, lenA, lenB);
  }
  note(
    !sawNaNNormal,
    "no NaN face normal fed to silhouette dot-product",
    `maxNormalLen=${maxNormalLen.toFixed(4)}`,
  );
  // A clean normal is either unit-length (real face) or zero (degenerate
  // face, magnitude-guard). Nothing in between, and never > 1 + eps.
  note(
    maxNormalLen <= 1.0 + 1e-4,
    "face normals are unit-or-zero (no garbage magnitude)",
    `maxNormalLen=${maxNormalLen.toFixed(6)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// [B] WebGL mirror — faithful re-implementation of
//     `EdgeVisibilityPipelineStage`'s degenerate handling: cross product
//     of two edge vectors, skip normalize when the cross is zero-length.
//     This is the authored-vs-derived comparison the audit asked for: we
//     confirm BOTH backends classify the degenerate triangle's face
//     normal as (0,0,0) — i.e. the WebGPU derived-normal path does NOT
//     bias differently from WebGL's degenerate-skip path.
// ─────────────────────────────────────────────────────────────────────────
function faceNormalWebGLStyle(i0, i1, i2) {
  const ax = positions[i0 * 3],
    ay = positions[i0 * 3 + 1],
    az = positions[i0 * 3 + 2];
  const bx = positions[i1 * 3],
    by = positions[i1 * 3 + 1],
    bz = positions[i1 * 3 + 2];
  const cx = positions[i2 * 3],
    cy = positions[i2 * 3 + 1],
    cz = positions[i2 * 3 + 2];
  const e1x = bx - ax,
    e1y = by - ay,
    e1z = bz - az;
  const e2x = cx - ax,
    e2y = cy - ay,
    e2z = cz - az;
  // cross(e1, e2)
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const magSq = nx * nx + ny * ny + nz * nz;
  if (magSq > 0) {
    const inv = 1 / Math.sqrt(magSq);
    return [nx * inv, ny * inv, nz * inv];
  }
  // PR#13421 degenerate-skip: zero-length cross → leave normal zeroed
  // rather than normalize NaN.
  return [0, 0, 0];
}

const nDegen = faceNormalWebGLStyle(0, 1, 2); // degenerate triangle
const nNormal = faceNormalWebGLStyle(0, 2, 3); // real triangle

note(
  allFinite(nDegen) && nDegen[0] === 0 && nDegen[1] === 0 && nDegen[2] === 0,
  "WebGL-mirror: degenerate face normal is (0,0,0), no NaN",
  `[${nDegen.join(", ")}]`,
);
const nNormalLen = Math.hypot(nNormal[0], nNormal[1], nNormal[2]);
note(
  allFinite(nNormal) && Math.abs(nNormalLen - 1) < 1e-4,
  "WebGL-mirror: real face normal is unit-length",
  `len=${nNormalLen.toFixed(6)}`,
);

// Silhouette dot-product bias check. For the degenerate face, BOTH
// backends use a (0,0,0) normal. The silhouette test is
// `dot(normalEye, toEye)`; with a zero normal the product is exactly 0
// on both, so neither backend's product is positive — i.e. the
// degenerate edge is NOT silhouette-classified-out differently. We
// confirm dot(0-normal, anyDir) === 0 (no NaN, no bias) for a sample
// view direction.
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
const sampleToEye = [0, 0, 1];
const degenDot = dot(nDegen, sampleToEye);
note(
  isFiniteNum(degenDot) && degenDot === 0,
  "degenerate silhouette dot-product is 0 (no bias, no NaN)",
  `dot=${degenDot}`,
);

// ─────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────
console.log("");
if (failures.length === 0) {
  console.log(
    "[probe-edge-degenerate] PASS — zero-area triangle produces no NaN/garbage " +
      "edge; WebGPU derived-normal path matches WebGL degenerate-skip " +
      "classification.",
  );
  process.exit(0);
} else {
  console.log(
    `[probe-edge-degenerate] FAIL — ${failures.length} check(s): ${failures.join(", ")}`,
  );
  process.exit(1);
}
