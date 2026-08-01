import { collectUniqueShadowCastCommands } from "../../../Source/Renderer/WebGPU/WebGPUContext.js";

describe("Renderer/WebGPU/WebGPU shadow cast command list", function () {
  it("deduplicates commands repeated across legacy cascade lists", function () {
    const first = {};
    const spanning = {};
    const last = {};
    const passes = [
      { commandList: [first, spanning] },
      { commandList: [spanning] },
      { commandList: [spanning, last] },
    ];
    const target = [{ stale: true }];
    const seen = new Set(target);

    const result = collectUniqueShadowCastCommands(passes, target, seen);

    expect(result).toBe(target);
    expect(result).toEqual([first, spanning, last]);
    expect(seen.size).toBe(3);
    expect(passes[0].commandList).toEqual([first, spanning]);
  });

  it("reuses cleared scratch containers for an empty list", function () {
    const target = [{}];
    const seen = new Set(target);

    collectUniqueShadowCastCommands([], target, seen);

    expect(target).toEqual([]);
    expect(seen.size).toBe(0);
  });
});
