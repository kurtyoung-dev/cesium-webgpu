#!/usr/bin/env node
/**
 * Probe: explicit `edgeVisibility.lineStrings` edge extraction
 * (NEW-EDGE-LINESTRINGS-EXPLICIT / C-R8-EDGE-LINESTRINGS).
 * @purpose Regression guard: lineStrings-only primitives emit edges (pre-B316: zero); 7 Node-side asserts incl. restart delimiting, dedup, off-gate.
 * @status ACTIVE
 *
 * REGRESSION GUARD. The named gap — "explicit lineStrings edges yield ZERO
 * WebGPU edges" — was CLOSED in Batch 316 (`cf7edec7dc`): before it, the
 * WebGPU emitter `extractEdgeGeometry` early-returned whenever the
 * per-triangle 2-bit `edgeVisibility.visibility` accessor was absent, so a
 * BENTLEY / styled-gltf-lines primitive that carries ONLY explicit
 * `lineStrings` (primitive-restart-delimited polyline index lists, no
 * `visibility` array) emitted zero WebGPU edges while WebGL's
 * `EdgeVisibilityPipelineStage.extractVisibleEdges` walked the lineStrings
 * and drew them.
 *
 * This probe pins that behavior so it can't silently regress:
 *
 *   1. THE REGRESSION — a lineStrings-ONLY primitive (no `visibility`, no
 *      triangle `indices`) produces one HARD edge per consecutive index
 *      pair. Pre-Batch-316 this returned null (ZERO edges).
 *   2. Primitive-restart delimiting — a restart value breaks the polyline;
 *      no edge straddles the restart (matches WebGL:497-500).
 *   3. Emitted lineString edges are EdgeVisibilityType.HARD (=2/255) and
 *      carry zero face normals (the VS silhouette branch skips them).
 *   4. Dedup across BOTH encodings — an edge present in the visibility path
 *      AND a lineString is emitted once (shared `seen` set, WebGL:526-528).
 *   5. Range guard — an index >= the attribute vertex count is skipped
 *      (matches WebGL:515-520).
 *   6. Per-lineString `materialColor` override rides the per-edge
 *      `edgeColor` attribute and beats the primitive-level color
 *      (WebGL:490-492).
 *   7. OFF-GATE — a primitive with NEITHER `visibility` NOR `lineStrings`
 *      returns null (byte-identical no-op; the extractor stays inert for
 *      non-edge primitives).
 *
 * Deterministic and Node-side: the emitter `.ts` is esbuild-bundled (its
 * only deps are Core/Cartesian3.js + the scene-FB helper) and
 * `extractEdgeGeometry` is exercised directly — no dev server, no GPU, no
 * asset needed (this checkout ships no lineStrings glb; the BENTLEY styled-
 * lines demo references an absent StyledLines asset). The values are mirrored
 * against WebGL `EdgeVisibilityPipelineStage.extractVisibleEdges` so any
 * future drift in either extractor trips a check here.
 *
 * Usage:
 *   node Tools/visual-regression/probe-edge-linestrings.mjs
 */
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import os from "os";
import { build } from "esbuild";

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
// Transpile the emitter (tsconfig is noEmit, so no compiled sibling exists).
// ─────────────────────────────────────────────────────────────────────────
const EMITTER_TS = path.join(
  ROOT,
  "packages/engine/Source/Renderer/WebGPU/WebGPUEdgeVisibilityEmitter.ts",
);
const tmpOut = path.join(
  os.tmpdir(),
  `probe-edge-linestrings-${process.pid}.mjs`,
);
await build({
  entryPoints: [EMITTER_TS],
  bundle: true,
  format: "esm",
  outfile: tmpOut,
  logLevel: "silent",
});
const { extractEdgeGeometry } = await import(
  `file:///${tmpOut.replace(/\\/g, "/")}`
);
note(typeof extractEdgeGeometry === "function", "extractEdgeGeometry exported");

// 19 floats / vertex. Layout: [0..2] pos, [3] edgeType, [4..6] nA,
// [7..9] nB, [10..12] otherPos, [13] edgeOffset, [14] featureId,
// [15..18] edgeColor.
const STRIDE = 19;
const HARD = 2 / 255;
// Each edge = 4 vertices; vertex 0 carries pos=A, otherPos=B.
const edgeBase = (edge) => edge * 4 * STRIDE;
const readVec = (g, edge, off) => {
  const b = edgeBase(edge) + off;
  return [g.vertices[b], g.vertices[b + 1], g.vertices[b + 2]];
};
const readF = (g, edge, off) => g.vertices[edgeBase(edge) + off];
const readColor = (g, edge) => {
  const b = edgeBase(edge) + 15;
  return [
    g.vertices[b],
    g.vertices[b + 1],
    g.vertices[b + 2],
    g.vertices[b + 3],
  ];
};
const near = (a, b) => Math.abs(a - b) < 1e-6;
const vecEq = (a, b) =>
  near(a[0], b[0]) && near(a[1], b[1]) && near(a[2], b[2]);
// Collect the set of undirected {A,B} endpoint pairs an emitted geometry
// covers, keyed by the endpoint POSITIONS (position uniquely identifies a
// vertex in these synthetic meshes).
const edgeKeySet = (g) => {
  const s = new Set();
  for (let e = 0; e < g.edgeCount; e++) {
    const a = readVec(g, e, 0)
      .map((x) => x.toFixed(3))
      .join(":");
    const b = readVec(g, e, 10)
      .map((x) => x.toFixed(3))
      .join(":");
    s.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  }
  return s;
};

// A row of 5 collinear-ish vertices used by the lineStrings-only checks.
const linePositions = new Float32Array([
  0,
  0,
  0, // 0
  1,
  0,
  0, // 1
  2,
  0,
  0, // 2
  3,
  0,
  0, // 3
  4,
  0,
  0, // 4
]);

// ─────────────────────────────────────────────────────────────────────────
// 1. THE REGRESSION — lineStrings-ONLY primitive → non-zero HARD edges.
// ─────────────────────────────────────────────────────────────────────────
{
  const primitive = {
    edgeVisibility: {
      lineStrings: [{ indices: new Uint16Array([0, 1, 2, 3, 4]) }],
    },
    attributes: [{ count: 5 }],
  };
  const g = extractEdgeGeometry(primitive, linePositions, null, null);
  note(
    g !== null && g.edgeCount === 4,
    "lineStrings-only primitive yields 4 edges (was ZERO pre-Batch-316)",
    `edgeCount=${g?.edgeCount}`,
  );
  if (g) {
    note(
      near(readF(g, 0, 3), HARD) && near(readF(g, 3, 3), HARD),
      "lineString edges are HARD type (2/255)",
      `type[0]=${readF(g, 0, 3).toFixed(5)} type[3]=${readF(g, 3, 3).toFixed(5)}`,
    );
    note(
      vecEq(readVec(g, 0, 4), [0, 0, 0]) && vecEq(readVec(g, 0, 7), [0, 0, 0]),
      "lineString edges carry zero face normals (silhouette branch inert)",
    );
    const keys = edgeKeySet(g);
    note(
      keys.has("0.000:0.000:0.000|1.000:0.000:0.000") &&
        keys.has("3.000:0.000:0.000|4.000:0.000:0.000"),
      "consecutive index pairs become edges (0-1 .. 3-4)",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Primitive-restart delimiting — restart breaks the polyline.
// ─────────────────────────────────────────────────────────────────────────
{
  const primitive = {
    edgeVisibility: {
      lineStrings: [
        {
          // 0-1-2 | restart | 3-4  → edges (0,1),(1,2),(3,4); NO (2,3).
          indices: new Uint16Array([0, 1, 2, 65535, 3, 4]),
          restartIndex: 65535,
        },
      ],
    },
    attributes: [{ count: 5 }],
  };
  const g = extractEdgeGeometry(primitive, linePositions, null, null);
  const keys = g ? edgeKeySet(g) : new Set();
  note(
    g !== null && g.edgeCount === 3,
    "primitive-restart splits the polyline (3 edges, not 4)",
    `edgeCount=${g?.edgeCount}`,
  );
  note(
    !keys.has("2.000:0.000:0.000|3.000:0.000:0.000"),
    "no edge straddles the restart index (WebGL:497-500 parity)",
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Multiple lineStrings each contribute.
// ─────────────────────────────────────────────────────────────────────────
{
  const primitive = {
    edgeVisibility: {
      lineStrings: [
        { indices: new Uint16Array([0, 1]) },
        { indices: new Uint16Array([2, 3, 4]) },
      ],
    },
    attributes: [{ count: 5 }],
  };
  const g = extractEdgeGeometry(primitive, linePositions, null, null);
  note(
    g !== null && g.edgeCount === 3,
    "multiple lineStrings each contribute edges (1 + 2 = 3)",
    `edgeCount=${g?.edgeCount}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Dedup across the visibility path AND a lineString.
// ─────────────────────────────────────────────────────────────────────────
{
  // A single triangle (0,1,2) all-HARD via visibility → edges (0,1),(1,2),
  // (2,0). A lineString re-lists edge (0,1) plus a NEW edge (2,3). The
  // duplicate (0,1) must be emitted once; total = 3 + 1 = 4.
  const positions = new Float32Array([
    0,
    0,
    0, // 0
    1,
    0,
    0, // 1
    0,
    1,
    0, // 2
    2,
    2,
    0, // 3 (lineString-only endpoint)
  ]);
  const visibility = new Uint8Array(1);
  // 3 edge slots, all HARD (=2): 0b101010 = 42.
  visibility[0] = (2 << 0) | (2 << 2) | (2 << 4);
  const primitive = {
    edgeVisibility: {
      visibility,
      lineStrings: [{ indices: new Uint16Array([0, 1, 2, 3]) }],
    },
    indices: { typedArray: new Uint16Array([0, 1, 2]) },
    attributes: [{ count: 4 }],
  };
  const g = extractEdgeGeometry(primitive, positions, null, null);
  note(
    g !== null && g.edgeCount === 4,
    "edge shared by visibility path + lineString is deduped (3 + 1 new = 4)",
    `edgeCount=${g?.edgeCount}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 5. Range guard — index >= vertexCount is skipped.
// ─────────────────────────────────────────────────────────────────────────
{
  const primitive = {
    edgeVisibility: {
      // 0-1 valid; 1-9 has an out-of-range endpoint (count=5) → skipped.
      lineStrings: [{ indices: new Uint16Array([0, 1, 9]) }],
    },
    attributes: [{ count: 5 }],
  };
  const g = extractEdgeGeometry(primitive, linePositions, null, null);
  note(
    g !== null && g.edgeCount === 1,
    "out-of-range lineString index is skipped (WebGL:515-520 parity)",
    `edgeCount=${g?.edgeCount}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 6. Per-lineString materialColor beats the primitive-level color.
// ─────────────────────────────────────────────────────────────────────────
{
  const primitive = {
    edgeVisibility: {
      materialColor: { x: 1, y: 0, z: 0, w: 1 }, // RED (primitive-level)
      lineStrings: [
        { indices: new Uint16Array([0, 1]) }, // inherits RED
        {
          indices: new Uint16Array([2, 3]),
          materialColor: { x: 0, y: 1, z: 0, w: 1 }, // GREEN override
        },
      ],
    },
    attributes: [{ count: 5 }],
  };
  const g = extractEdgeGeometry(primitive, linePositions, null, null);
  if (g && g.edgeCount === 2) {
    const c0 = readColor(g, 0);
    const c1 = readColor(g, 1);
    note(
      vecEq(c0, [1, 0, 0]) && near(c0[3], 1),
      "lineString without override inherits primitive-level color (RED)",
      `c0=[${c0.map((x) => x.toFixed(2))}]`,
    );
    note(
      vecEq(c1, [0, 1, 0]) && near(c1[3], 1),
      "per-lineString materialColor overrides the primitive-level color (GREEN)",
      `c1=[${c1.map((x) => x.toFixed(2))}]`,
    );
  } else {
    note(
      false,
      "per-lineString color primitive produced 2 edges",
      `edgeCount=${g?.edgeCount}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 7. OFF-GATE — neither encoding present → null (inert no-op).
// ─────────────────────────────────────────────────────────────────────────
{
  const g = extractEdgeGeometry(
    {
      edgeVisibility: { materialColor: { x: 1, y: 1, z: 1, w: 1 } },
      attributes: [{ count: 5 }],
    },
    linePositions,
    null,
    null,
  );
  note(g === null, "OFF-GATE: no visibility + no lineStrings → null (inert)");
  const g2 = extractEdgeGeometry({}, linePositions, null, null);
  note(g2 === null, "OFF-GATE: no edgeVisibility at all → null");
}

fs.rmSync(tmpOut, { force: true });

console.log("");
if (failures.length === 0) {
  console.log(
    "[probe-edge-linestrings] PASS — explicit edgeVisibility.lineStrings " +
      "are extracted into HARD WebGPU edges (regression closed Batch 316), " +
      "primitive-restart / dedup / range-guard / per-lineString color all " +
      "match WebGL extractVisibleEdges; off-gate inert.",
  );
  process.exit(0);
} else {
  console.log(
    `[probe-edge-linestrings] FAIL — ${failures.length} check(s): ${failures.join(", ")}`,
  );
  process.exit(1);
}
