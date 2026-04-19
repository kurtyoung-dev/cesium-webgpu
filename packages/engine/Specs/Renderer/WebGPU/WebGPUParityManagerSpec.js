import { WebGPUParityManager } from "../../../Source/Renderer/WebGPU/WebGPUParityManager.js";

describe("Renderer/WebGPU/WebGPUParityManager", function () {
  it("starts at frame 0 with no slots", function () {
    const pm = new WebGPUParityManager();
    expect(pm.frameIndex).toBe(0);
    expect(pm.slotCount).toBe(0);
  });

  it("registers slots with stable ids", function () {
    const pm = new WebGPUParityManager();
    const a = pm.register("taa-history", ["A0", "A1"]);
    const b = pm.register("hiz-prev", ["B0", "B1"]);
    expect(a).toBe(0);
    expect(b).toBe(1);
    expect(pm.slotCount).toBe(2);
  });

  it("advanceFrame increments the counter by one", function () {
    const pm = new WebGPUParityManager();
    pm.advanceFrame();
    pm.advanceFrame();
    pm.advanceFrame();
    expect(pm.frameIndex).toBe(3);
  });

  it("read/write return opposite slots of the pair", function () {
    const pm = new WebGPUParityManager();
    const id = pm.register("s", ["even", "odd"]);
    // Frame 1: write to parity=1 (odd), read from parity=0 (even)
    pm.advanceFrame();
    expect(pm.write(id)).toBe("odd");
    expect(pm.read(id)).toBe("even");
    // Frame 2: flip
    pm.advanceFrame();
    expect(pm.write(id)).toBe("even");
    expect(pm.read(id)).toBe("odd");
  });

  it("different slots share the parity phase by default", function () {
    const pm = new WebGPUParityManager();
    const a = pm.register("a", ["a0", "a1"]);
    const b = pm.register("b", ["b0", "b1"]);
    pm.advanceFrame();
    expect(pm.write(a)).toBe("a1");
    expect(pm.write(b)).toBe("b1");
  });

  it("phaseOffset shifts a slot's parity independently", function () {
    const pm = new WebGPUParityManager();
    const aligned = pm.register("aligned", ["x0", "x1"]);
    const shifted = pm.register("shifted", ["y0", "y1"], 1);
    pm.advanceFrame(); // frameIndex = 1
    // aligned: write idx = 1, read idx = 0
    expect(pm.write(aligned)).toBe("x1");
    expect(pm.read(aligned)).toBe("x0");
    // shifted: (1+1)&1 = 0 write, (0+1)&1 = 1 read
    expect(pm.write(shifted)).toBe("y0");
    expect(pm.read(shifted)).toBe("y1");
  });

  it("rebind preserves the slot's current parity phase", function () {
    const pm = new WebGPUParityManager();
    const id = pm.register("t", ["old0", "old1"]);
    pm.advanceFrame(); // frameIndex = 1, write idx = 1
    expect(pm.write(id)).toBe("old1");
    pm.rebind(id, ["new0", "new1"]);
    // Parity hasn't advanced — write idx stays at 1, which is now "new1"
    expect(pm.write(id)).toBe("new1");
    expect(pm.read(id)).toBe("new0");
  });

  it("diagnostics include slot names and indices", function () {
    const pm = new WebGPUParityManager();
    pm.register("alpha", [1, 2]);
    pm.register("beta", [3, 4]);
    pm.advanceFrame();
    pm.advanceFrame();
    const diag = pm.getDiagnostics();
    expect(diag).toContain("alpha");
    expect(diag).toContain("beta");
    expect(diag).toContain("frameIndex=2");
  });
});
