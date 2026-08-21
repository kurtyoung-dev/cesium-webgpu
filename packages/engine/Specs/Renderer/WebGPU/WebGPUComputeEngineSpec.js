import WebGPUComputeCommand from "../../../Source/Renderer/WebGPU/WebGPUComputeCommand.js";
import WebGPUComputeEngine from "../../../Source/Renderer/WebGPU/WebGPUComputeEngine.js";

function createHarness() {
  const calls = [];
  const passes = [];
  let nextPipelineId = 0;
  let nextShaderModuleId = 0;
  const harness = {
    calls: calls,
    passes: passes,
    failNextDispatch: false,
  };

  function createPass(label) {
    const pass = {
      label: label,
      end: jasmine.createSpy(`${label}.end`).and.callFake(function () {
        calls.push(["end", label]);
      }),
      setPipeline: jasmine
        .createSpy(`${label}.setPipeline`)
        .and.callFake(function (pipeline) {
          calls.push(["setPipeline", pipeline]);
        }),
      setBindGroup: jasmine.createSpy(`${label}.setBindGroup`),
      dispatchWorkgroups: jasmine
        .createSpy(`${label}.dispatchWorkgroups`)
        .and.callFake(function (x, y, z) {
          calls.push(["dispatch", x, y, z]);
          if (harness.failNextDispatch) {
            harness.failNextDispatch = false;
            throw new Error("dispatch failed");
          }
        }),
      dispatchWorkgroupsIndirect: jasmine.createSpy(
        `${label}.dispatchWorkgroupsIndirect`,
      ),
    };
    passes.push(pass);
    return pass;
  }

  function createEncoder(label) {
    const commandBuffer = { label: `${label}.commandBuffer` };
    return {
      label: label,
      beginComputePass: jasmine
        .createSpy(`${label}.beginComputePass`)
        .and.callFake(function () {
          calls.push(["beginComputePass", label]);
          return createPass(`${label}.pass${passes.length}`);
        }),
      finish: jasmine.createSpy(`${label}.finish`).and.callFake(function () {
        calls.push(["finish", label]);
        return commandBuffer;
      }),
    };
  }

  const privateEncoders = [];
  const submit = jasmine.createSpy("queue.submit").and.callFake(function () {
    calls.push(["submit"]);
  });
  const device = {
    limits: { maxComputeWorkgroupsPerDimension: 65535 },
    queue: { submit: submit },
    createCommandEncoder: jasmine
      .createSpy("device.createCommandEncoder")
      .and.callFake(function (descriptor) {
        const encoder = createEncoder(
          descriptor?.label ?? `private${privateEncoders.length}`,
        );
        privateEncoders.push(encoder);
        return encoder;
      }),
    createShaderModule: jasmine
      .createSpy("device.createShaderModule")
      .and.callFake(function (descriptor) {
        return {
          id: ++nextShaderModuleId,
          descriptor: descriptor,
        };
      }),
    createPipelineLayout: jasmine
      .createSpy("device.createPipelineLayout")
      .and.callFake(function (descriptor) {
        return { descriptor: descriptor };
      }),
    createComputePipeline: jasmine
      .createSpy("device.createComputePipeline")
      .and.callFake(function (descriptor) {
        return {
          id: ++nextPipelineId,
          descriptor: descriptor,
        };
      }),
  };

  harness.device = device;
  harness.submit = submit;
  harness.createEncoder = createEncoder;
  harness.privateEncoders = privateEncoders;
  harness.engine = new WebGPUComputeEngine(device);
  return harness;
}

describe("Renderer/WebGPU/WebGPUComputeEngine", function () {
  it("runs preExecute once before pipeline resolution", function () {
    const harness = createHarness();
    const preExecute = jasmine
      .createSpy("preExecute")
      .and.callFake(function () {
        harness.calls.push(["pre"]);
        command.shaderSource = "@compute @workgroup_size(1) fn prepared() {}";
        command.entryPoint = "prepared";
      });
    const command = new WebGPUComputeCommand({
      preExecute: preExecute,
      postExecute: function () {
        harness.calls.push(["post"]);
      },
      label: "prepare-order",
    });

    expect(harness.engine.execute(command)).toBe(true);

    expect(preExecute).toHaveBeenCalledTimes(1);
    expect(harness.device.createComputePipeline).toHaveBeenCalledTimes(1);
    expect(
      harness.device.createComputePipeline.calls.mostRecent().args[0].compute
        .entryPoint,
    ).toBe("prepared");
    expect(harness.calls).toEqual([
      ["pre"],
      ["beginComputePass", "ComputeEncoder_prepare-order"],
      ["setPipeline", command.computePipeline],
      ["dispatch", 1, 1, 1],
      ["end", "ComputeEncoder_prepare-order.pass0"],
      ["finish", "ComputeEncoder_prepare-order"],
      ["submit"],
      ["post"],
    ]);
  });

  it("records on a borrowed encoder without creating or submitting one", function () {
    const harness = createHarness();
    const encoder = harness.createEncoder("borrowed");
    const preExecute = jasmine.createSpy("preExecute");
    const postExecute = jasmine.createSpy("postExecute");
    const command = new WebGPUComputeCommand({
      computePipeline: { label: "pipeline" },
      preExecute: preExecute,
      postExecute: postExecute,
    });

    expect(harness.engine.executeOnEncoder(encoder, command)).toBe(true);

    expect(preExecute).toHaveBeenCalledTimes(1);
    expect(encoder.beginComputePass).toHaveBeenCalledTimes(1);
    expect(harness.device.createCommandEncoder).not.toHaveBeenCalled();
    expect(harness.submit).not.toHaveBeenCalled();
    expect(postExecute).not.toHaveBeenCalled();
    expect(harness.passes[0].end).toHaveBeenCalledTimes(1);
  });

  it("ends a failed borrowed pass and can encode the following command", function () {
    const harness = createHarness();
    const encoder = harness.createEncoder("borrowed");
    const canceled = jasmine.createSpy("canceled");
    const failed = new WebGPUComputeCommand({
      computePipeline: { label: "failed" },
      canceled: canceled,
    });
    const succeeding = new WebGPUComputeCommand({
      computePipeline: { label: "succeeding" },
    });
    harness.failNextDispatch = true;
    spyOn(console, "warn");

    const encoded = harness.engine.executeOnEncoder(encoder, failed);
    if (!encoded) {
      failed.cancel();
    }

    expect(encoded).toBe(false);
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(harness.passes[0].end).toHaveBeenCalledTimes(1);
    expect(harness.engine.executeOnEncoder(encoder, succeeding)).toBe(true);
    expect(encoder.beginComputePass).toHaveBeenCalledTimes(2);
    expect(harness.passes[1].end).toHaveBeenCalledTimes(1);
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it("refuses borrowed encoding when ownership is lost during preExecute", function () {
    const harness = createHarness();
    const encoder = harness.createEncoder("borrowed");
    let encoderActive = true;
    const command = new WebGPUComputeCommand({
      computePipeline: { label: "pipeline" },
      preExecute: function () {
        encoderActive = false;
      },
    });
    spyOn(console, "warn");

    expect(
      harness.engine.executeOnEncoder(encoder, command, function () {
        return encoderActive;
      }),
    ).toBe(false);
    expect(encoder.beginComputePass).not.toHaveBeenCalled();
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it("keys source pipelines by entry point and layout identity", function () {
    const harness = createHarness();
    const encoder = harness.createEncoder("borrowed");
    const source =
      "@compute @workgroup_size(1) fn a() {} @compute @workgroup_size(1) fn b() {}";
    const layoutA = { label: "layout-a" };
    const layoutB = { label: "layout-b" };
    const first = new WebGPUComputeCommand({
      shaderSource: source,
      entryPoint: "a",
      bindGroupLayouts: [layoutA],
    });
    const identical = new WebGPUComputeCommand({
      shaderSource: source,
      entryPoint: "a",
      bindGroupLayouts: [layoutA],
    });
    const differentEntry = new WebGPUComputeCommand({
      shaderSource: source,
      entryPoint: "b",
      bindGroupLayouts: [layoutA],
    });
    const differentLayout = new WebGPUComputeCommand({
      shaderSource: source,
      entryPoint: "a",
      bindGroupLayouts: [layoutB],
    });

    expect(harness.engine.executeOnEncoder(encoder, first)).toBe(true);
    expect(harness.engine.executeOnEncoder(encoder, identical)).toBe(true);
    expect(harness.engine.executeOnEncoder(encoder, differentEntry)).toBe(true);
    expect(harness.engine.executeOnEncoder(encoder, differentLayout)).toBe(
      true,
    );

    expect(identical.computePipeline).toBe(first.computePipeline);
    expect(differentEntry.computePipeline).not.toBe(first.computePipeline);
    expect(differentLayout.computePipeline).not.toBe(first.computePipeline);
    expect(harness.device.createComputePipeline).toHaveBeenCalledTimes(3);
    expect(harness.engine.pipelineCacheSize).toBe(3);
  });

  it("re-resolves generated semantics across engines on one pooled device", function () {
    const harness = createHarness();
    const encoder = harness.createEncoder("borrowed");
    const secondEngine = new WebGPUComputeEngine(harness.device);
    let executionCount = 0;
    const command = new WebGPUComputeCommand({
      shaderSource:
        "@compute @workgroup_size(1) fn a() {} @compute @workgroup_size(1) fn b() {}",
      entryPoint: "a",
      preExecute: function () {
        executionCount++;
        if (executionCount === 2) {
          command.entryPoint = "b";
        }
      },
    });

    expect(harness.engine.executeOnEncoder(encoder, command)).toBe(true);
    const firstPipeline = command.computePipeline;
    expect(secondEngine.executeOnEncoder(encoder, command)).toBe(true);

    expect(command.computePipeline).not.toBe(firstPipeline);
    expect(harness.device.createComputePipeline).toHaveBeenCalledTimes(2);
    expect(
      harness.device.createComputePipeline.calls.mostRecent().args[0].compute
        .entryPoint,
    ).toBe("b");
  });

  it("fails closed when a command is reused on another device", function () {
    const firstHarness = createHarness();
    const secondHarness = createHarness();
    const firstEncoder = firstHarness.createEncoder("first-device");
    const secondEncoder = secondHarness.createEncoder("second-device");
    const command = new WebGPUComputeCommand({
      computePipeline: { label: "device-local-pipeline" },
    });

    expect(firstHarness.engine.executeOnEncoder(firstEncoder, command)).toBe(
      true,
    );
    spyOn(console, "warn");
    expect(secondHarness.engine.executeOnEncoder(secondEncoder, command)).toBe(
      false,
    );
    expect(secondEncoder.beginComputePass).not.toHaveBeenCalled();
    expect(secondHarness.submit).not.toHaveBeenCalled();
  });

  it("uses an explicit device stamp to reject a foreign pipeline on first use", function () {
    const ownerHarness = createHarness();
    const foreignHarness = createHarness();
    const foreignEncoder = foreignHarness.createEncoder("foreign-device");
    const canceled = jasmine.createSpy("canceled");
    const command = new WebGPUComputeCommand({
      device: ownerHarness.device,
      computePipeline: { label: "owner-device-pipeline" },
      canceled: canceled,
    });
    spyOn(console, "warn");

    const encoded = foreignHarness.engine.executeOnEncoder(
      foreignEncoder,
      command,
    );
    if (!encoded) {
      command.cancel();
    }

    expect(encoded).toBe(false);
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(foreignEncoder.beginComputePass).not.toHaveBeenCalled();
    expect(foreignHarness.submit).not.toHaveBeenCalled();
  });

  it("keeps a standalone postExecute error observable after submission", function () {
    const harness = createHarness();
    const canceled = jasmine.createSpy("canceled");
    const command = new WebGPUComputeCommand({
      computePipeline: { label: "pipeline" },
      postExecute: function () {
        throw new Error("post failed");
      },
      canceled: canceled,
    });
    spyOn(console, "warn");

    expect(harness.engine.execute(command)).toBe(false);
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(canceled).not.toHaveBeenCalled();
  });

  it("settles every batch post callback once before reporting a callback error", function () {
    const harness = createHarness();
    const firstPost = jasmine
      .createSpy("firstPost")
      .and.throwError("post failed");
    const secondPost = jasmine.createSpy("secondPost");
    const firstCanceled = jasmine.createSpy("firstCanceled");
    const secondCanceled = jasmine.createSpy("secondCanceled");
    const first = new WebGPUComputeCommand({
      computePipeline: { label: "first" },
      postExecute: firstPost,
      canceled: firstCanceled,
    });
    const second = new WebGPUComputeCommand({
      computePipeline: { label: "second" },
      postExecute: secondPost,
      canceled: secondCanceled,
    });
    spyOn(console, "warn");

    expect(harness.engine.executeMultiple([first, second])).toBe(false);
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(firstPost).toHaveBeenCalledTimes(1);
    expect(secondPost).toHaveBeenCalledTimes(1);
    expect(firstCanceled).not.toHaveBeenCalled();
    expect(secondCanceled).not.toHaveBeenCalled();
  });
});
