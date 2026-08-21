import WebGPUComputeCommand from "../../../Source/Renderer/WebGPU/WebGPUComputeCommand.js";
import Pass from "../../../Source/Renderer/Pass.js";

// ── Scope ───────────────────────────────────────────────────────────
//
// WebGPUComputeCommand is almost entirely device-free: the constructor
// only STORES options (no device, no GPU resource creation), the two
// static workgroup-count helpers are pure integer math, cancel() just
// invokes a stored callback, and execute() operates exclusively on the
// GPUComputePassEncoder it is HANDED — it never touches a GPUDevice or
// GPUQueue. That lets us drive execute() with a plain call-recording
// fake encoder + fake pipeline, with no live WebGPU at all.
//
// Covered (deterministic, no live GPUDevice/queue):
//   - constructor defaults + full option pass-through
//   - Pass assignment (Pass.COMPUTE) + isWebGPUComputeCommand flag
//   - static calculateWorkgroupCount (ceil division)
//   - static calculateWorkgroupCount2D (defaults 8x8 + explicit sizes)
//   - cancel() callback dispatch (present / absent)
//   - execute() debug throw when computePipeline is unset
//   - execute() pipeline + bind-group + dispatch wiring against a fake
//     encoder, including the indirect-vs-direct dispatch branch, the
//     dynamic-offsets branch, and pre/postExecute ordering
//
// Skipped (would require a real GPUDevice/queue): none — the module has
// no path that allocates GPU resources. All resources are supplied by
// the caller, so a fake encoder fully exercises execute().

// A plain object that records every method execute() may call on a
// GPUComputePassEncoder. encode()/execute() only invoke these — no GPU needed.
function makeFakeComputePass() {
  return {
    calls: [],
    setPipeline(pipeline) {
      this.calls.push(["setPipeline", pipeline]);
    },
    setBindGroup(index, bindGroup, dynamicOffsets) {
      this.calls.push(["setBindGroup", index, bindGroup, dynamicOffsets]);
    },
    dispatchWorkgroups(x, y, z) {
      this.calls.push(["dispatchWorkgroups", x, y, z]);
    },
    dispatchWorkgroupsIndirect(buffer, offset) {
      this.calls.push(["dispatchWorkgroupsIndirect", buffer, offset]);
    },
  };
}

// Throwaway stand-ins; execute() never inspects their shape.
function fakePipeline(tag) {
  return { __fakePipeline: tag };
}
function fakeBindGroup(tag) {
  return { __fakeBindGroup: tag };
}

describe("Renderer/WebGPU/WebGPUComputeCommand", function () {
  describe("constructor defaults", function () {
    it("applies documented defaults when given no options", function () {
      const command = new WebGPUComputeCommand();
      expect(command.shaderSource).toBeUndefined();
      expect(command.shaderModule).toBeUndefined();
      expect(command.computePipeline).toBeUndefined();
      expect(command.entryPoint).toBe("computeMain");
      expect(command.bindGroupLayouts).toBeUndefined();
      expect(command.bindGroups).toEqual([]);
      expect(command.workgroupCountX).toBe(1);
      expect(command.workgroupCountY).toBe(1);
      expect(command.workgroupCountZ).toBe(1);
      expect(command.indirectBuffer).toBeUndefined();
      expect(command.indirectOffset).toBe(0);
      expect(command.preExecute).toBeUndefined();
      expect(command.postExecute).toBeUndefined();
      expect(command.canceled).toBeUndefined();
      expect(command.persists).toBe(false);
      expect(command.owner).toBeUndefined();
      expect(command.label).toBe("WebGPUComputeCommand");
    });

    it("defaults to an empty options object (no argument)", function () {
      expect(() => new WebGPUComputeCommand()).not.toThrow();
    });

    it("assigns the COMPUTE pass", function () {
      const command = new WebGPUComputeCommand();
      expect(command.pass).toBe(Pass.COMPUTE);
      expect(command.pass).toBe(1);
    });

    it("marks the command with isWebGPUComputeCommand", function () {
      const command = new WebGPUComputeCommand();
      expect(command.isWebGPUComputeCommand).toBe(true);
    });

    it("gives each command its own bindGroups array instance", function () {
      const a = new WebGPUComputeCommand();
      const b = new WebGPUComputeCommand();
      a.bindGroups.push(fakeBindGroup("a"));
      expect(a.bindGroups.length).toBe(1);
      expect(b.bindGroups.length).toBe(0);
    });
  });

  describe("constructor option pass-through", function () {
    it("stores every provided option", function () {
      const shaderModule = { __module: true };
      const computePipeline = fakePipeline("p");
      const bindGroupLayouts = [{ __layout: 0 }];
      const bindGroups = [{ index: 0, bindGroup: fakeBindGroup("bg") }];
      const indirectBuffer = { __buffer: true };
      const owner = { name: "OwnerThing" };
      const preExecute = function () {};
      const postExecute = function () {};
      const canceled = function () {};

      const command = new WebGPUComputeCommand({
        shaderSource: "@compute fn main() {}",
        shaderModule: shaderModule,
        computePipeline: computePipeline,
        entryPoint: "main",
        bindGroupLayouts: bindGroupLayouts,
        bindGroups: bindGroups,
        workgroupCountX: 8,
        workgroupCountY: 4,
        workgroupCountZ: 2,
        indirectBuffer: indirectBuffer,
        indirectOffset: 256,
        preExecute: preExecute,
        postExecute: postExecute,
        canceled: canceled,
        persists: true,
        owner: owner,
        label: "MyComputeCommand",
      });

      expect(command.shaderSource).toBe("@compute fn main() {}");
      expect(command.shaderModule).toBe(shaderModule);
      expect(command.computePipeline).toBe(computePipeline);
      expect(command.entryPoint).toBe("main");
      expect(command.bindGroupLayouts).toBe(bindGroupLayouts);
      expect(command.bindGroups).toBe(bindGroups);
      expect(command.workgroupCountX).toBe(8);
      expect(command.workgroupCountY).toBe(4);
      expect(command.workgroupCountZ).toBe(2);
      expect(command.indirectBuffer).toBe(indirectBuffer);
      expect(command.indirectOffset).toBe(256);
      expect(command.preExecute).toBe(preExecute);
      expect(command.postExecute).toBe(postExecute);
      expect(command.canceled).toBe(canceled);
      expect(command.persists).toBe(true);
      expect(command.owner).toBe(owner);
      expect(command.label).toBe("MyComputeCommand");
    });

    it("keeps explicit zero workgroup counts (does not coerce to 1)", function () {
      const command = new WebGPUComputeCommand({
        workgroupCountX: 0,
        workgroupCountY: 0,
        workgroupCountZ: 0,
      });
      expect(command.workgroupCountX).toBe(0);
      expect(command.workgroupCountY).toBe(0);
      expect(command.workgroupCountZ).toBe(0);
    });

    it("keeps an explicit zero indirectOffset", function () {
      const command = new WebGPUComputeCommand({ indirectOffset: 0 });
      expect(command.indirectOffset).toBe(0);
    });

    it("keeps explicit persists:false distinct from the default", function () {
      const command = new WebGPUComputeCommand({ persists: false });
      expect(command.persists).toBe(false);
    });
  });

  describe("calculateWorkgroupCount", function () {
    it("returns the exact quotient when evenly divisible", function () {
      expect(WebGPUComputeCommand.calculateWorkgroupCount(256, 64)).toBe(4);
    });

    it("rounds up a partial workgroup", function () {
      expect(WebGPUComputeCommand.calculateWorkgroupCount(257, 64)).toBe(5);
    });

    it("returns 1 for a single sub-workgroup item count", function () {
      expect(WebGPUComputeCommand.calculateWorkgroupCount(1, 64)).toBe(1);
    });

    it("returns 0 for zero items", function () {
      expect(WebGPUComputeCommand.calculateWorkgroupCount(0, 64)).toBe(0);
    });
  });

  describe("calculateWorkgroupCount2D", function () {
    it("defaults workgroup size to 8x8", function () {
      // ceil(16/8)=2, ceil(32/8)=4
      expect(WebGPUComputeCommand.calculateWorkgroupCount2D(16, 32)).toEqual({
        x: 2,
        y: 4,
      });
    });

    it("rounds each axis up independently", function () {
      // ceil(17/8)=3, ceil(9/8)=2
      expect(WebGPUComputeCommand.calculateWorkgroupCount2D(17, 9)).toEqual({
        x: 3,
        y: 2,
      });
    });

    it("honors explicit per-axis workgroup sizes", function () {
      // ceil(100/16)=7, ceil(100/4)=25
      expect(
        WebGPUComputeCommand.calculateWorkgroupCount2D(100, 100, 16, 4),
      ).toEqual({ x: 7, y: 25 });
    });

    it("returns zeros for a zero-extent image", function () {
      expect(WebGPUComputeCommand.calculateWorkgroupCount2D(0, 0)).toEqual({
        x: 0,
        y: 0,
      });
    });
  });

  describe("cancel", function () {
    it("invokes the canceled callback when set", function () {
      let called = 0;
      const command = new WebGPUComputeCommand({
        canceled: function () {
          called += 1;
        },
      });
      command.cancel();
      expect(called).toBe(1);
    });

    it("is a no-op when no canceled callback is set", function () {
      const command = new WebGPUComputeCommand();
      expect(() => command.cancel()).not.toThrow();
    });
  });

  describe("execute", function () {
    it("throws when computePipeline is not set", function () {
      const command = new WebGPUComputeCommand();
      const pass = makeFakeComputePass();
      // The debug-only precondition fires before the encoder is touched.
      expect(() => command.execute(pass)).toThrowDeveloperError();
      expect(pass.calls.length).toBe(0);
    });

    it("sets the pipeline then dispatches direct workgroup counts", function () {
      const pipeline = fakePipeline("direct");
      const command = new WebGPUComputeCommand({
        computePipeline: pipeline,
        workgroupCountX: 3,
        workgroupCountY: 5,
        workgroupCountZ: 7,
      });
      const pass = makeFakeComputePass();
      command.execute(pass);

      expect(pass.calls).toEqual([
        ["setPipeline", pipeline],
        ["dispatchWorkgroups", 3, 5, 7],
      ]);
    });

    it("sets bind groups without dynamic offsets", function () {
      const pipeline = fakePipeline("bg");
      const bg0 = fakeBindGroup("bg0");
      const bg1 = fakeBindGroup("bg1");
      const command = new WebGPUComputeCommand({
        computePipeline: pipeline,
        bindGroups: [
          { index: 0, bindGroup: bg0 },
          { index: 1, bindGroup: bg1 },
        ],
      });
      const pass = makeFakeComputePass();
      command.execute(pass);

      expect(pass.calls).toEqual([
        ["setPipeline", pipeline],
        ["setBindGroup", 0, bg0, undefined],
        ["setBindGroup", 1, bg1, undefined],
        ["dispatchWorkgroups", 1, 1, 1],
      ]);
    });

    it("passes dynamic offsets to setBindGroup when present", function () {
      const pipeline = fakePipeline("dyn");
      const bg = fakeBindGroup("bg");
      const offsets = new Uint32Array([0, 256]);
      const command = new WebGPUComputeCommand({
        computePipeline: pipeline,
        bindGroups: [{ index: 2, bindGroup: bg, dynamicOffsets: offsets }],
      });
      const pass = makeFakeComputePass();
      command.execute(pass);

      expect(pass.calls).toEqual([
        ["setPipeline", pipeline],
        ["setBindGroup", 2, bg, offsets],
        ["dispatchWorkgroups", 1, 1, 1],
      ]);
    });

    it("uses indirect dispatch when an indirectBuffer is set", function () {
      const pipeline = fakePipeline("indirect");
      const indirectBuffer = { __indirect: true };
      const command = new WebGPUComputeCommand({
        computePipeline: pipeline,
        indirectBuffer: indirectBuffer,
        indirectOffset: 128,
        // These direct counts must be ignored in favor of indirect dispatch.
        workgroupCountX: 9,
      });
      const pass = makeFakeComputePass();
      command.execute(pass);

      expect(pass.calls).toEqual([
        ["setPipeline", pipeline],
        ["dispatchWorkgroupsIndirect", indirectBuffer, 128],
      ]);
    });

    it("invokes preExecute before and postExecute after dispatch", function () {
      const order = [];
      const pipeline = fakePipeline("hooks");
      const command = new WebGPUComputeCommand({
        computePipeline: pipeline,
        preExecute: function () {
          order.push("pre");
        },
        postExecute: function () {
          order.push("post");
        },
      });
      const pass = makeFakeComputePass();
      const originalDispatch = pass.dispatchWorkgroups.bind(pass);
      pass.dispatchWorkgroups = function (x, y, z) {
        order.push("dispatch");
        originalDispatch(x, y, z);
      };
      command.execute(pass);

      expect(order).toEqual(["pre", "dispatch", "post"]);
    });

    it("does not invoke postExecute when encoding throws", function () {
      const postExecute = jasmine.createSpy("postExecute");
      const command = new WebGPUComputeCommand({
        computePipeline: fakePipeline("throwing"),
        postExecute: postExecute,
      });
      const pass = makeFakeComputePass();
      pass.setPipeline = function () {
        throw new Error("setPipeline failed");
      };

      expect(function () {
        command.execute(pass);
      }).toThrowError("setPipeline failed");
      expect(postExecute).not.toHaveBeenCalled();
    });
  });

  describe("encode", function () {
    it("throws before touching the pass when computePipeline is not set", function () {
      const command = new WebGPUComputeCommand();
      const pass = makeFakeComputePass();

      expect(function () {
        command.encode(pass);
      }).toThrowDeveloperError();
      expect(pass.calls).toEqual([]);
    });

    it("encodes without invoking lifecycle callbacks", function () {
      const preExecute = jasmine.createSpy("preExecute");
      const postExecute = jasmine.createSpy("postExecute");
      const pipeline = fakePipeline("callback-free");
      const command = new WebGPUComputeCommand({
        computePipeline: pipeline,
        workgroupCountX: 2,
        workgroupCountY: 3,
        workgroupCountZ: 4,
        preExecute: preExecute,
        postExecute: postExecute,
      });
      const pass = makeFakeComputePass();

      command.encode(pass);

      expect(pass.calls).toEqual([
        ["setPipeline", pipeline],
        ["dispatchWorkgroups", 2, 3, 4],
      ]);
      expect(preExecute).not.toHaveBeenCalled();
      expect(postExecute).not.toHaveBeenCalled();
    });
  });
});
