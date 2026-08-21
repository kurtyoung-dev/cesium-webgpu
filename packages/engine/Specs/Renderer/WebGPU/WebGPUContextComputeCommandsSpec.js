import WebGPUComputeCommand from "../../../Source/Renderer/WebGPU/WebGPUComputeCommand.js";
import { WebGPUContext } from "../../../Source/Renderer/WebGPU/WebGPUContext.js";
import WebGPUComputeEngine from "../../../Source/Renderer/WebGPU/WebGPUComputeEngine.js";

function createHarness() {
  const order = [];
  const passes = [];
  const harness = {
    order: order,
    passes: passes,
    failNextDispatch: false,
  };

  function createComputePass() {
    const pass = {
      setPipeline: jasmine.createSpy("computePass.setPipeline"),
      setBindGroup: jasmine.createSpy("computePass.setBindGroup"),
      dispatchWorkgroups: jasmine
        .createSpy("computePass.dispatchWorkgroups")
        .and.callFake(function () {
          order.push("dispatch");
          if (harness.failNextDispatch) {
            harness.failNextDispatch = false;
            throw new Error("dispatch failed");
          }
        }),
      dispatchWorkgroupsIndirect: jasmine.createSpy(
        "computePass.dispatchWorkgroupsIndirect",
      ),
      end: jasmine.createSpy("computePass.end").and.callFake(function () {
        order.push("computePass.end");
      }),
    };
    passes.push(pass);
    return pass;
  }

  const encoder = {
    beginComputePass: jasmine
      .createSpy("frameEncoder.beginComputePass")
      .and.callFake(function () {
        order.push("beginComputePass");
        return createComputePass();
      }),
  };
  const submit = jasmine.createSpy("queue.submit");
  const createCommandEncoder = jasmine.createSpy("device.createCommandEncoder");
  const device = {
    limits: { maxComputeWorkgroupsPerDimension: 65535 },
    queue: { submit: submit },
    createCommandEncoder: createCommandEncoder,
  };
  const context = new WebGPUContext(document.createElement("canvas"), {});
  context._device = device;
  context._currentCommandEncoder = encoder;
  context._computeEngine = new WebGPUComputeEngine(device);

  harness.context = context;
  harness.encoder = encoder;
  harness.device = device;
  harness.submit = submit;
  harness.createCommandEncoder = createCommandEncoder;
  return harness;
}

function destroyHarness(harness) {
  if (!harness) {
    return;
  }
  harness.context._drainAfterCommandEncoderSubmitCallbacks(false);
  harness.context._currentCommandEncoder = null;
  harness.context._computeEngine?.destroy();
  harness.context._computeEngine = null;
  harness.context._device = null;
  harness.context.destroy();
}

describe("Renderer/WebGPU/WebGPUContext compute commands", function () {
  let harness;

  afterEach(function () {
    destroyHarness(harness);
    harness = undefined;
  });

  it("encodes native commands on the active frame encoder and settles on submit", function () {
    harness = createHarness();
    const renderPass = {
      end: jasmine.createSpy("renderPass.end").and.callFake(function () {
        harness.order.push("renderPass.end");
      }),
    };
    harness.context._currentRenderPassEncoder = renderPass;
    harness.context._activePassTarget = "custom-framebuffer";
    const preExecute = jasmine.createSpy("preExecute");
    const postExecute = jasmine.createSpy("postExecute");
    const canceled = jasmine.createSpy("canceled");
    const command = new WebGPUComputeCommand({
      computePipeline: { label: "pipeline" },
      preExecute: preExecute,
      postExecute: postExecute,
      canceled: canceled,
    });
    const legacyCommand = {
      execute: jasmine.createSpy("legacy.execute"),
    };
    const sunCommand = {
      execute: jasmine.createSpy("sun.execute"),
    };

    harness.context.executeComputeCommands(
      [legacyCommand, command],
      sunCommand,
      {},
    );

    expect(renderPass.end).toHaveBeenCalledTimes(1);
    expect(harness.order).toEqual([
      "renderPass.end",
      "beginComputePass",
      "dispatch",
      "computePass.end",
    ]);
    expect(preExecute).toHaveBeenCalledTimes(1);
    expect(harness.passes[0].setPipeline).toHaveBeenCalledOnceWith(
      command.computePipeline,
    );
    expect(legacyCommand.execute).not.toHaveBeenCalled();
    expect(sunCommand.execute).not.toHaveBeenCalled();
    expect(harness.createCommandEncoder).not.toHaveBeenCalled();
    expect(harness.submit).not.toHaveBeenCalled();
    expect(postExecute).not.toHaveBeenCalled();
    expect(canceled).not.toHaveBeenCalled();

    harness.context._drainCommandEncoderSubmitCallbacks(harness.encoder, true);
    harness.context._drainCommandEncoderSubmitCallbacks(harness.encoder, true);
    expect(postExecute).toHaveBeenCalledTimes(1);
    expect(canceled).not.toHaveBeenCalled();
  });

  it("ends a failed pass, cancels once, and continues with the next command", function () {
    harness = createHarness();
    const failedPost = jasmine.createSpy("failed.postExecute");
    const failedCanceled = jasmine.createSpy("failed.canceled");
    const succeedingPost = jasmine.createSpy("succeeding.postExecute");
    const failed = new WebGPUComputeCommand({
      computePipeline: { label: "failed" },
      postExecute: failedPost,
      canceled: failedCanceled,
    });
    const succeeding = new WebGPUComputeCommand({
      computePipeline: { label: "succeeding" },
      postExecute: succeedingPost,
    });
    harness.failNextDispatch = true;
    spyOn(console, "warn");

    harness.context.executeComputeCommands([failed, succeeding], undefined, {});

    expect(harness.encoder.beginComputePass).toHaveBeenCalledTimes(2);
    expect(harness.passes[0].end).toHaveBeenCalledTimes(1);
    expect(harness.passes[1].end).toHaveBeenCalledTimes(1);
    expect(failedCanceled).toHaveBeenCalledTimes(1);
    expect(failedPost).not.toHaveBeenCalled();
    expect(succeedingPost).not.toHaveBeenCalled();
    expect(harness.submit).not.toHaveBeenCalled();

    harness.context._drainCommandEncoderSubmitCallbacks(harness.encoder, true);
    expect(failedCanceled).toHaveBeenCalledTimes(1);
    expect(failedPost).not.toHaveBeenCalled();
    expect(succeedingPost).toHaveBeenCalledTimes(1);
  });

  it("cancels without a private submission when no frame encoder is active", function () {
    harness = createHarness();
    harness.context._currentCommandEncoder = null;
    const canceled = jasmine.createSpy("canceled");
    const command = new WebGPUComputeCommand({
      computePipeline: { label: "pipeline" },
      canceled: canceled,
    });

    harness.context.executeComputeCommands([command], undefined, {});

    expect(canceled).toHaveBeenCalledTimes(1);
    expect(harness.createCommandEncoder).not.toHaveBeenCalled();
    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.encoder.beginComputePass).not.toHaveBeenCalled();
  });

  it("cancels once and refuses encoding after re-entrant preExecute abandonment", function () {
    harness = createHarness();
    const canceled = jasmine.createSpy("canceled");
    const postExecute = jasmine.createSpy("postExecute");
    const command = new WebGPUComputeCommand({
      computePipeline: { label: "pipeline" },
      preExecute: function () {
        harness.context._drainCommandEncoderSubmitCallbacks(
          harness.encoder,
          false,
        );
      },
      postExecute: postExecute,
      canceled: canceled,
    });
    spyOn(console, "warn");

    harness.context.executeComputeCommands([command], undefined, {});

    expect(canceled).toHaveBeenCalledTimes(1);
    expect(postExecute).not.toHaveBeenCalled();
    expect(harness.encoder.beginComputePass).not.toHaveBeenCalled();
    expect(harness.submit).not.toHaveBeenCalled();
    harness.context._drainCommandEncoderSubmitCallbacks(harness.encoder, false);
    expect(canceled).toHaveBeenCalledTimes(1);
  });
});
