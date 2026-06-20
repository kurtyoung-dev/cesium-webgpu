import Cartesian4 from "../../../Source/Core/Cartesian4.js";
import { extractEdgeGeometry } from "../../../Source/Renderer/WebGPU/WebGPUEdgeVisibilityEmitter.js";

// ─────────────────────────────────────────────────────────────────────────────
// NEW-EDGE-MATERIALCOLOR-OVERRIDE-WEBGPU (Batch 330)
//
// The WebGPU model-edge emitter now carries a PER-EDGE color in the vertex
// stream (slots 15..18 of the 19-float / 76-byte vertex) — the equivalent
// of WebGL's `a_edgeColor` vertex attribute. This spec is the CPU-side
// lockstep + semantics sentinel: it asserts the stride widened correctly and
// that the override → vertex-color → no-override priority matches WebGL's
// `EdgeVisibilityPipelineStage.createQuadEdgeGeometry`.
//
// The render-side parity (per-vertex COLOR_0 blue edges matching WebGL) is
// covered by `Tools/visual-regression/probe-edge-percolor.mjs`.
// ─────────────────────────────────────────────────────────────────────────────

const FLOATS_PER_VERTEX = 19; // pos(3)+type(1)+nA(3)+nB(3)+other(3)+offset(1)+fid(1)+color(4)
const COLOR_OFFSET = 15; // slots 15..18 = edgeColor.rgba

function distinctEdgeColors(geometry) {
  const verts = geometry.vertices;
  const vcount = verts.length / FLOATS_PER_VERTEX;
  const set = new Map();
  for (let i = 0; i < vcount; i++) {
    const o = i * FLOATS_PER_VERTEX + COLOR_OFFSET;
    const key = [verts[o], verts[o + 1], verts[o + 2], verts[o + 3]]
      .map((x) => Number(x.toFixed(3)))
      .join(",");
    set.set(key, (set.get(key) || 0) + 1);
  }
  return set;
}

// A unit quad (4 verts) → 2 triangles → 5 unique edges. All-HARD visibility.
function quadPositions() {
  return new Float32Array([
    0,
    0,
    0, // 0
    1,
    0,
    0, // 1
    1,
    1,
    0, // 2
    0,
    1,
    0, // 3
  ]);
}
function quadTriIndices() {
  // (0,1,2) (0,2,3)
  return new Uint16Array([0, 1, 2, 0, 2, 3]);
}
function allHardVisibility() {
  // 6 directed edges, 2 bits each = 12 bits = 2 bytes. HARD = 0b10.
  // byte0 covers edges 0..3, byte1 covers edges 4..5.
  return new Uint8Array([0b10101010, 0b00001010]);
}

describe("Renderer/WebGPU/WebGPUEdgeVisibilityEmitter per-edge color", function () {
  it("widens the vertex stride to 19 floats and packs a per-edge color", function () {
    const primitive = {
      edgeVisibility: {
        visibility: allHardVisibility(),
        materialColor: new Cartesian4(1.0, 0.0, 0.0, 1.0), // RED override
      },
      indices: { typedArray: quadTriIndices() },
      attributes: [{ count: 4 }],
    };

    const geometry = extractEdgeGeometry(
      primitive,
      quadPositions(),
      null,
      null,
    );
    expect(geometry).not.toBeNull();
    // vertices length must be a multiple of the widened 19-float stride.
    expect(geometry.vertices.length % FLOATS_PER_VERTEX).toBe(0);
    expect(geometry.vertices.length).toBe(
      geometry.edgeCount * 4 * FLOATS_PER_VERTEX,
    );
  });

  it("applies the primitive-level materialColor to visibility-path edges", function () {
    const primitive = {
      edgeVisibility: {
        visibility: allHardVisibility(),
        materialColor: new Cartesian4(1.0, 0.0, 0.0, 1.0), // RED
      },
      indices: { typedArray: quadTriIndices() },
      attributes: [{ count: 4 }],
    };

    const geometry = extractEdgeGeometry(
      primitive,
      quadPositions(),
      null,
      null,
    );
    const colors = distinctEdgeColors(geometry);
    // Every edge is RED — one distinct color, alpha >= 0 (override present).
    expect(colors.size).toBe(1);
    expect(colors.has("1,0,0,1")).toBe(true);
  });

  it("writes the -1 alpha no-override sentinel when no color is authored", function () {
    const primitive = {
      edgeVisibility: {
        visibility: allHardVisibility(),
        // no materialColor
      },
      indices: { typedArray: quadTriIndices() },
      attributes: [{ count: 4 }],
    };

    const geometry = extractEdgeGeometry(
      primitive,
      quadPositions(),
      null,
      null,
    );
    const colors = distinctEdgeColors(geometry);
    expect(colors.size).toBe(1);
    // a = -1 sentinel → FS falls back to the uniform surface color.
    expect(colors.has("0,0,0,-1")).toBe(true);
  });

  it("prefers a per-lineString materialColor over the primitive-level color", function () {
    // A lineString edge between verts not produced by the triangle path's
    // first dedupe, carrying its own GREEN color. The visibility-path edges
    // stay RED, the lineString edge is GREEN → two DISTINCT per-edge colors.
    const primitive = {
      edgeVisibility: {
        visibility: allHardVisibility(),
        materialColor: new Cartesian4(1.0, 0.0, 0.0, 1.0), // RED (visibility path)
        lineStrings: [
          {
            // edge (0,2) is the quad diagonal — also produced by the
            // visibility path, so it's deduped; the GREEN re-color only
            // applies to NEW edges. Use the boundary edge set: the
            // visibility path already emits (0,1),(1,2),(2,0),(2,3),(3,0).
            // There is no fresh edge on a 4-vert quad, so add a 5th vertex.
            indices: new Uint16Array([4, 0]),
            restartIndex: 65535,
            materialColor: new Cartesian4(0.0, 1.0, 0.0, 1.0), // GREEN
          },
        ],
      },
      indices: { typedArray: quadTriIndices() },
      // 5 vertices so the lineString's vertex 4 is in range.
      attributes: [{ count: 5 }],
    };
    const positions = new Float32Array([
      0,
      0,
      0, // 0
      1,
      0,
      0, // 1
      1,
      1,
      0, // 2
      0,
      1,
      0, // 3
      2,
      2,
      0, // 4 (lineString endpoint)
    ]);

    const geometry = extractEdgeGeometry(primitive, positions, null, null);
    const colors = distinctEdgeColors(geometry);
    // Two distinct per-edge colors: RED (visibility) + GREEN (lineString).
    expect(colors.has("1,0,0,1")).toBe(true);
    expect(colors.has("0,1,0,1")).toBe(true);
    expect(colors.size).toBe(2);
  });

  it("falls back to per-vertex COLOR_0 when no override is present", function () {
    // No materialColor, but a per-vertex color array (BLUE on all 4 verts).
    const vertexColors = new Float32Array([
      0,
      0,
      1,
      1, // v0 blue
      0,
      0,
      1,
      1, // v1 blue
      0,
      0,
      1,
      1, // v2 blue
      0,
      0,
      1,
      1, // v3 blue
    ]);
    const primitive = {
      edgeVisibility: {
        visibility: allHardVisibility(),
        // no materialColor → vertex color is used
      },
      indices: { typedArray: quadTriIndices() },
      attributes: [{ count: 4 }],
    };

    const geometry = extractEdgeGeometry(
      primitive,
      quadPositions(),
      null,
      vertexColors,
    );
    const colors = distinctEdgeColors(geometry);
    expect(colors.size).toBe(1);
    expect(colors.has("0,0,1,1")).toBe(true);
  });
});
