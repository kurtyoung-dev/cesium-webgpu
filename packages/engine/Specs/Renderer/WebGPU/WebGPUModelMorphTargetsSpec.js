import {
  ensureMorphTargetResources,
  packMorphTargetDeltas,
  FLOATS_PER_VERTEX_PER_TARGET,
} from "../../../Source/Renderer/WebGPU/WebGPUModelMorphTargets.js";

if (typeof globalThis.GPUBufferUsage === "undefined") {
  globalThis.GPUBufferUsage = {
    COPY_DST: 0x0008,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
  };
}

// DP-H35 — glTF morph-target NORMAL deltas on WebGPU (Batch 329). C2-4 (Batch
// 373) added TANGENT deltas. The CPU pack (packMorphTargetDeltas) writes THREE
// vec4s per vertex per target — [positionDelta, normalDelta, tangentDelta], 12
// floats — and that stride MUST stay in lockstep with the WGSL morph indexing
// (base = (t*vertexCount + vid) * 3u). A silent desync would corrupt morphed
// geometry, so this guards the layout directly (pure CPU, no GPUDevice).
describe("Renderer/WebGPU/WebGPUModelMorphTargets pack layout", function () {
  it("FLOATS_PER_VERTEX_PER_TARGET is 12 (POSITION + NORMAL + TANGENT vec4)", function () {
    expect(FLOATS_PER_VERTEX_PER_TARGET).toBe(12);
  });

  it("resets previous weights to current after a visibility-admission gap", function () {
    const device = {
      createBuffer: function (descriptor) {
        return {
          descriptor: descriptor,
          destroy: function () {},
        };
      },
      queue: {
        writeBuffer: function () {},
      },
    };
    const primCache = {};
    const geometry = {
      morphTargetCount: 1,
      vertexCount: 1,
      morphTargets: [
        {
          positionData: new Float32Array([1.0, 0.0, 0.0]),
        },
      ],
    };

    ensureMorphTargetResources(device, primCache, geometry, [0.25]);
    ensureMorphTargetResources(device, primCache, geometry, [0.75], true);

    expect(primCache._morphWeightData[0]).toBe(0.75);
    expect(primCache._morphWeightDataPrev[0]).toBe(0.75);
  });

  it("packs position@0-2 + normal@4-6 + tangent@8-10 with zero vec4 padding at 3/7/11", function () {
    const vertexCount = 2;
    const targetCount = 1;
    const morphTargets = [
      {
        positionData: new Float32Array([1, 2, 3, 4, 5, 6]),
        normalData: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
        tangentData: new Float32Array([0.01, 0.02, 0.03, 0.04, 0.05, 0.06]),
      },
    ];
    const packed = packMorphTargetDeltas(
      morphTargets,
      targetCount,
      vertexCount,
    );

    expect(packed.length).toBe(vertexCount * targetCount * 12);
    // vertex 0: pos vec4, nrm vec4, tan vec4
    expect(packed[0]).toBe(1);
    expect(packed[1]).toBe(2);
    expect(packed[2]).toBe(3);
    expect(packed[3]).toBe(0); // position vec4 padding
    expect(packed[4]).toBeCloseTo(0.1, 6);
    expect(packed[5]).toBeCloseTo(0.2, 6);
    expect(packed[6]).toBeCloseTo(0.3, 6);
    expect(packed[7]).toBe(0); // normal vec4 padding
    expect(packed[8]).toBeCloseTo(0.01, 6);
    expect(packed[9]).toBeCloseTo(0.02, 6);
    expect(packed[10]).toBeCloseTo(0.03, 6);
    expect(packed[11]).toBe(0); // tangent vec4 padding
    // vertex 1 begins one 12-float stride later
    expect(packed[12]).toBe(4);
    expect(packed[13]).toBe(5);
    expect(packed[14]).toBe(6);
    expect(packed[16]).toBeCloseTo(0.4, 6);
    expect(packed[17]).toBeCloseTo(0.5, 6);
    expect(packed[18]).toBeCloseTo(0.6, 6);
    expect(packed[20]).toBeCloseTo(0.04, 6);
    expect(packed[21]).toBeCloseTo(0.05, 6);
    expect(packed[22]).toBeCloseTo(0.06, 6);
  });

  it("leaves the NORMAL + TANGENT slots zero when a target has no NORMAL/TANGENT accessor (WebGL parity no-op)", function () {
    const morphTargets = [
      {
        positionData: new Float32Array([7, 8, 9]),
        normalData: undefined,
        tangentData: undefined,
      },
    ];
    const packed = packMorphTargetDeltas(morphTargets, 1, 1);
    expect(packed.length).toBe(12);
    expect(packed[0]).toBe(7);
    expect(packed[1]).toBe(8);
    expect(packed[2]).toBe(9);
    // normal + tangent slots stay zero -> the WGSL accumulations are no-ops
    expect(packed[4]).toBe(0);
    expect(packed[5]).toBe(0);
    expect(packed[6]).toBe(0);
    expect(packed[8]).toBe(0);
    expect(packed[9]).toBe(0);
    expect(packed[10]).toBe(0);
  });

  it("packs a NORMAL delta but leaves TANGENT zero when only TANGENT is absent", function () {
    const morphTargets = [
      {
        positionData: new Float32Array([1, 1, 1]),
        normalData: new Float32Array([0.5, 0.5, 0.5]),
        tangentData: undefined,
      },
    ];
    const packed = packMorphTargetDeltas(morphTargets, 1, 1);
    expect(packed[4]).toBeCloseTo(0.5, 6);
    expect(packed[8]).toBe(0); // tangent slot zero
    expect(packed[9]).toBe(0);
    expect(packed[10]).toBe(0);
  });

  it("lays out per-target blocks back-to-back at t*vertexCount*12", function () {
    const vertexCount = 1;
    const morphTargets = [
      { positionData: new Float32Array([1, 1, 1]) },
      { positionData: new Float32Array([2, 2, 2]) },
    ];
    const packed = packMorphTargetDeltas(morphTargets, 2, vertexCount);
    expect(packed.length).toBe(2 * 1 * 12);
    expect(packed[0]).toBe(1); // target 0 at offset 0
    expect(packed[12]).toBe(2); // target 1 at offset 1*1*12
  });

  it("skips a target whose positionData is undefined (leaves its block zero)", function () {
    const vertexCount = 1;
    const morphTargets = [
      { positionData: undefined },
      { positionData: new Float32Array([3, 3, 3]) },
    ];
    const packed = packMorphTargetDeltas(morphTargets, 2, vertexCount);
    // target 0 block (offset 0..11) stays zero; target 1 writes at offset 12
    expect(packed[0]).toBe(0);
    expect(packed[12]).toBe(3);
  });
});
