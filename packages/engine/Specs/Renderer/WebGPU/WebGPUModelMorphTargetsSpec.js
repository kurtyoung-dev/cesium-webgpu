import {
  packMorphTargetDeltas,
  FLOATS_PER_VERTEX_PER_TARGET,
} from "../../../Source/Renderer/WebGPU/WebGPUModelMorphTargets.js";

// DP-H35 — glTF morph-target NORMAL deltas on WebGPU (Batch 329). The CPU pack
// (packMorphTargetDeltas) writes TWO vec4s per vertex per target —
// [positionDelta, normalDelta], 8 floats — and that stride MUST stay in lockstep
// with the WGSL morph indexing (base = (t*vertexCount + vid) * 2u). A silent
// desync would corrupt morphed geometry, so this guards the layout directly
// (pure CPU, no GPUDevice). Added by Batch 339 (AUDIT-P2-MORPH-PACK-SPEC) — the
// 2026-06-20 audit flagged the pack layout had no unit test.
describe("Renderer/WebGPU/WebGPUModelMorphTargets pack layout", function () {
  it("FLOATS_PER_VERTEX_PER_TARGET is 8 (POSITION vec4 + NORMAL vec4)", function () {
    expect(FLOATS_PER_VERTEX_PER_TARGET).toBe(8);
  });

  it("packs position@0-2 + normal@4-6 with zero vec4 padding at 3/7", function () {
    const vertexCount = 2;
    const targetCount = 1;
    const morphTargets = [
      {
        positionData: new Float32Array([1, 2, 3, 4, 5, 6]),
        normalData: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
      },
    ];
    const packed = packMorphTargetDeltas(
      morphTargets,
      targetCount,
      vertexCount,
    );

    expect(packed.length).toBe(vertexCount * targetCount * 8);
    // vertex 0: pos vec4 then nrm vec4
    expect(packed[0]).toBe(1);
    expect(packed[1]).toBe(2);
    expect(packed[2]).toBe(3);
    expect(packed[3]).toBe(0); // position vec4 padding
    expect(packed[4]).toBeCloseTo(0.1, 6);
    expect(packed[5]).toBeCloseTo(0.2, 6);
    expect(packed[6]).toBeCloseTo(0.3, 6);
    expect(packed[7]).toBe(0); // normal vec4 padding
    // vertex 1 begins one 8-float stride later
    expect(packed[8]).toBe(4);
    expect(packed[9]).toBe(5);
    expect(packed[10]).toBe(6);
    expect(packed[12]).toBeCloseTo(0.4, 6);
    expect(packed[13]).toBeCloseTo(0.5, 6);
    expect(packed[14]).toBeCloseTo(0.6, 6);
  });

  it("leaves the NORMAL slot zero when a target has no NORMAL accessor (WebGL parity no-op)", function () {
    const morphTargets = [
      {
        positionData: new Float32Array([7, 8, 9]),
        normalData: undefined,
      },
    ];
    const packed = packMorphTargetDeltas(morphTargets, 1, 1);
    expect(packed.length).toBe(8);
    expect(packed[0]).toBe(7);
    expect(packed[1]).toBe(8);
    expect(packed[2]).toBe(9);
    // normal slot stays zero -> the WGSL normal accumulation is a no-op
    expect(packed[4]).toBe(0);
    expect(packed[5]).toBe(0);
    expect(packed[6]).toBe(0);
  });

  it("lays out per-target blocks back-to-back at t*vertexCount*8", function () {
    const vertexCount = 1;
    const morphTargets = [
      { positionData: new Float32Array([1, 1, 1]), normalData: undefined },
      { positionData: new Float32Array([2, 2, 2]), normalData: undefined },
    ];
    const packed = packMorphTargetDeltas(morphTargets, 2, vertexCount);
    expect(packed.length).toBe(2 * 1 * 8);
    expect(packed[0]).toBe(1); // target 0 at offset 0
    expect(packed[8]).toBe(2); // target 1 at offset 1*1*8
  });

  it("skips a target whose positionData is undefined (leaves its block zero)", function () {
    const vertexCount = 1;
    const morphTargets = [
      { positionData: undefined, normalData: undefined },
      { positionData: new Float32Array([3, 3, 3]), normalData: undefined },
    ];
    const packed = packMorphTargetDeltas(morphTargets, 2, vertexCount);
    // target 0 block (offset 0..7) stays zero; target 1 writes at offset 8
    expect(packed[0]).toBe(0);
    expect(packed[8]).toBe(3);
  });
});
