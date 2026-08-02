import Pass from "../../../Source/Renderer/Pass.js";
import { executePickPass } from "../../../Source/Renderer/WebGPU/WebGPUSceneRendererPickPass.js";

function makeFrustum(near, far, command) {
  const commands = Array.from({ length: Pass.NUMBER_OF_PASSES }, function () {
    return [];
  });
  const indices = new Array(Pass.NUMBER_OF_PASSES).fill(0);
  if (command) {
    commands[Pass.OPAQUE].push(command);
    indices[Pass.OPAQUE] = 1;
  }
  return {
    near: near,
    far: far,
    commands: commands,
    indices: indices,
  };
}

function makeEncoder() {
  const passes = [];
  return {
    passes: passes,
    beginRenderPass: function (descriptor) {
      const pass = {
        descriptor: descriptor,
        ended: false,
        viewport: undefined,
        scissor: undefined,
        setViewport: function (...args) {
          this.viewport = args;
        },
        setScissorRect: function (...args) {
          this.scissor = args;
        },
        setPipeline: function (pipeline) {
          this.pipeline = pipeline;
        },
        draw: function (...args) {
          this.drawArgs = args;
        },
        end: function () {
          this.ended = true;
        },
      };
      passes.push(pass);
      return pass;
    },
  };
}

describe("Renderer/WebGPU/WebGPUSceneRendererPickPass", function () {
  it("accumulates ID color but clears depth for every far-to-near frustum", function () {
    const commandExecutions = [];
    function makePickCommand(name) {
      return {
        pickOnly: true,
        isWebGPUDrawCommand: true,
        execute: function (renderPass) {
          commandExecutions.push({ name: name, renderPass: renderPass });
        },
      };
    }

    // Cesium stores the nearest frustum first. Pick execution reverses this
    // list so far geometry establishes ID color before nearer slices replace
    // it using their freshly-cleared, slice-local depth.
    const nearCommand = makePickCommand("near");
    const farCommand = makePickCommand("far");
    const nearTile = makePickCommand("near-tile");
    const farTile = makePickCommand("far-tile");
    const legacyWebGLPick = {
      pickOnly: true,
      execute: jasmine.createSpy("legacyWebGLPick"),
    };
    const frustumCommandsList = [
      makeFrustum(1.0, 10.0, nearCommand),
      makeFrustum(10.0, 100.0, farCommand),
    ];
    frustumCommandsList[0].commands[Pass.CESIUM_3D_TILE].push(nearTile);
    frustumCommandsList[0].indices[Pass.CESIUM_3D_TILE] = 1;
    // Standalone ClassificationPrimitive can retain a compatibility WebGL
    // pick command in the same list. Its pickOnly marker must not admit it to
    // a native WebGPU render pass.
    frustumCommandsList[0].commands[Pass.OPAQUE].push(legacyWebGLPick);
    frustumCommandsList[0].indices[Pass.OPAQUE] = 2;
    frustumCommandsList[1].commands[Pass.CESIUM_3D_TILE].push(farTile);
    frustumCommandsList[1].indices[Pass.CESIUM_3D_TILE] = 1;
    const encoder = makeEncoder();
    const savedRenderPass = {};
    const updatedFrustums = [];
    const context = {
      _device: {},
      _currentCommandEncoder: encoder,
      _currentRenderPassEncoder: savedRenderPass,
      currentRenderPassEncoder: savedRenderPass,
      uniformState: {
        updatePass: jasmine.createSpy("updatePass"),
        inverseProjection: Array.from({ length: 16 }, (_value, i) => i),
      },
      beginPickFrame: jasmine.createSpy("beginPickFrame"),
      endCurrentRenderPass: jasmine.createSpy("endCurrentRenderPass"),
      resumeDefaultRenderPass: jasmine.createSpy("resumeDefaultRenderPass"),
      withRenderPassTimestamps: function (descriptor) {
        return descriptor;
      },
    };
    const scene = {
      mode: 3,
      camera: { frustum: { near: 1.0, far: 100.0 } },
      opaqueFrustumNearOffset: 1.0,
      _view: {
        frustumCommandsList: frustumCommandsList,
      },
      frameState: {
        passes: {
          pick: true,
          pickVoxel: false,
          depth: false,
          pickMode: "default",
        },
        pickingMetadata: false,
        useLogDepth: false,
      },
      highDynamicRange: false,
    };
    const colorView = {};
    const depthView = {};
    const passState = {
      framebuffer: {
        _isWebGPUPickFBO: true,
        colorView: colorView,
        depthView: depthView,
        width: 100,
        height: 80,
        pickScissor: { x: 10, y: 55, width: 3, height: 5 },
      },
      viewport: { x: 0, y: 0, width: 100, height: 80 },
      scissorTest: {
        enabled: true,
        rectangle: { x: 10, y: 20, width: 3, height: 5 },
      },
    };
    const host = {
      _currentFrustumIndex: -1,
      _updateFrustumUniforms: function (_uniformState, near, far) {
        updatedFrustums.push([near, far]);
      },
    };

    executePickPass(host, {
      scene: scene,
      context: context,
      passState: passState,
    });

    expect(updatedFrustums).toEqual([
      [10.0, 100.0],
      [1.0, 10.0],
    ]);
    expect(encoder.passes.length).toBe(2);

    const farPass = encoder.passes[0];
    const nearPass = encoder.passes[1];
    expect(farPass.descriptor.colorAttachments[0].view).toBe(colorView);
    expect(nearPass.descriptor.colorAttachments[0].view).toBe(colorView);
    expect(farPass.descriptor.colorAttachments[0].loadOp).toBe("clear");
    expect(nearPass.descriptor.colorAttachments[0].loadOp).toBe("load");
    expect(farPass.descriptor.colorAttachments[0].storeOp).toBe("store");
    expect(nearPass.descriptor.colorAttachments[0].storeOp).toBe("store");

    for (const pass of encoder.passes) {
      expect(pass.descriptor.depthStencilAttachment.view).toBe(depthView);
      expect(pass.descriptor.depthStencilAttachment.depthLoadOp).toBe("clear");
      expect(pass.descriptor.depthStencilAttachment.depthStoreOp).toBe(
        "discard",
      );
      expect(pass.descriptor.depthStencilAttachment.stencilLoadOp).toBe(
        "clear",
      );
      expect(pass.descriptor.depthStencilAttachment.stencilStoreOp).toBe(
        "discard",
      );
      expect(pass.ended).toBe(true);
      expect(pass.viewport).toEqual([0, 0, 100, 80, 0, 1]);
      // Cesium's y=20 bottom-origin rectangle becomes WebGPU y=55.
      expect(pass.scissor).toEqual([10, 55, 3, 5]);
    }

    expect(commandExecutions.map((entry) => entry.name)).toEqual([
      "far-tile",
      "far",
      "near-tile",
      "near",
    ]);
    expect(commandExecutions[0].renderPass).toBe(farPass);
    expect(commandExecutions[2].renderPass).toBe(nearPass);
    expect(legacyWebGLPick.execute).not.toHaveBeenCalled();
    expect(context._currentRenderPassEncoder).toBeNull();
    expect(context.resumeDefaultRenderPass).not.toHaveBeenCalled();
    expect(host._currentFrustumIndex).toBe(1);
    expect(context._currentFrustumIndex).toBe(1);
    expect(context.uniformState._currentSliceIndex).toBe(1);
    expect(Array.from(context._currentFrustumInvProj)).toEqual(
      context.uniformState.inverseProjection,
    );
    expect(Array.from(context._currentFrustumNearFar)).toEqual([1.0, 10.0]);
    expect(Array.from(context.uniformState._logDepthEncodeNearFar)).toEqual([
      1.0, 100.0,
    ]);
  });

  it("erases a stale far snap payload when a nearer slice is snapless", function () {
    const events = [];
    let accumulatedPayload;
    let currentSliceCovered = false;
    const makeNativeCommand = (execute) => ({
      pickOnly: true,
      isWebGPUDrawCommand: true,
      execute: execute,
    });
    const farCommand = {
      isWebGPUDrawCommand: true,
      derivedCommands: {
        picking: {
          pickCommand: makeNativeCommand(function () {
            events.push("far-occluder");
            currentSliceCovered = true;
          }),
        },
        snapping: {
          snapCommand: makeNativeCommand(function () {
            events.push("far-payload");
            accumulatedPayload = "far-hit";
          }),
        },
      },
    };
    const nearCommand = {
      isWebGPUDrawCommand: true,
      derivedCommands: {
        picking: {
          pickCommand: makeNativeCommand(function () {
            events.push("near-occluder");
            currentSliceCovered = true;
          }),
        },
        // Deliberately no snapping slot: this nearer visible primitive is an
        // occluder, not a snap target.
      },
    };
    const frustumCommandsList = [
      makeFrustum(1.0, 10.0, nearCommand),
      makeFrustum(10.0, 100.0, farCommand),
    ];
    const encoder = makeEncoder();
    const frameState = {
      camera: { frustum: { near: 1.0, far: 100.0 } },
      passes: {
        pick: true,
        pickVoxel: false,
        snap: true,
        depth: false,
        pickMode: "default",
      },
      pickingMetadata: false,
      useLogDepth: false,
    };
    const context = {
      _device: {},
      _currentCommandEncoder: encoder,
      _currentRenderPassEncoder: null,
      uniformState: {
        updatePass: jasmine.createSpy("updatePass"),
        inverseProjection: new Float32Array(16),
      },
      beginPickFrame: jasmine.createSpy("beginPickFrame"),
      endCurrentRenderPass: jasmine.createSpy("endCurrentRenderPass"),
      withRenderPassTimestamps: function (descriptor) {
        return descriptor;
      },
    };
    const resetCalls = [];
    const scene = {
      mode: 3,
      camera: frameState.camera,
      _frameState: frameState,
      frameState: frameState,
      opaqueFrustumNearOffset: 1.0,
      _view: { frustumCommandsList: frustumCommandsList },
      highDynamicRange: false,
    };
    const passState = {
      framebuffer: {
        _isWebGPUPickFBO: true,
        _isWebGPUSnapFBO: true,
        colorView: {},
        snapColorView: {},
        depthView: {},
        width: 100,
        height: 80,
        pickScissor: { x: 10, y: 20, width: 25, height: 25 },
        resetSnapPayloadCoverage: function (renderPass) {
          resetCalls.push(renderPass);
          events.push("coverage-reset");
          if (currentSliceCovered) {
            accumulatedPayload = undefined;
          }
        },
      },
      viewport: { x: 0, y: 0, width: 100, height: 80 },
    };

    executePickPass(
      {
        _currentFrustumIndex: -1,
        _updateFrustumUniforms: function () {
          // A depth clear begins a new slice in the real render pass.
          currentSliceCovered = false;
        },
      },
      {
        scene: scene,
        context: context,
        passState: passState,
        sceneFbLoad: false,
      },
    );

    expect(events).toEqual([
      "far-occluder",
      "far-payload",
      "near-occluder",
      "coverage-reset",
    ]);
    expect(accumulatedPayload).toBeUndefined();
    expect(resetCalls).toEqual([encoder.passes[3]]);
    expect(encoder.passes.length).toBe(4);
    // Occluder color is throwaway in snap mode; its depth is stored and loaded
    // by the payload passes. The payload color itself remains stored.
    expect(encoder.passes[0].descriptor.colorAttachments[0].storeOp).toBe(
      "discard",
    );
    expect(encoder.passes[1].descriptor.colorAttachments[0].storeOp).toBe(
      "store",
    );
    expect(encoder.passes[2].descriptor.colorAttachments[0].storeOp).toBe(
      "discard",
    );
    expect(encoder.passes[3].descriptor.colorAttachments[0].storeOp).toBe(
      "store",
    );
    expect(encoder.passes[3].scissor).toEqual([10, 20, 25, 25]);
  });

  it("requires the coverage reset callback for a loaded snap payload", function () {
    const beginPickFrame = jasmine.createSpy("beginPickFrame");
    const context = {
      _device: {},
      uniformState: {},
      beginPickFrame: beginPickFrame,
    };
    const scene = {
      _view: { frustumCommandsList: [makeFrustum(1.0, 100.0)] },
    };
    const passState = {
      framebuffer: {
        _isWebGPUPickFBO: true,
        _isWebGPUSnapFBO: true,
        snapColorView: {},
      },
    };

    expect(function () {
      executePickPass(
        { _currentFrustumIndex: -1 },
        {
          scene: scene,
          context: context,
          passState: passState,
          sceneFbLoad: true,
        },
      );
    }).toThrowError(
      "A loaded WebGPU snap payload requires resetSnapPayloadCoverage.",
    );
    expect(beginPickFrame).not.toHaveBeenCalled();
  });

  it("resets only covered pixels in a loaded split segment", function () {
    const payloadByX = new Map();
    let payloadExecution = 0;
    let coveredX;
    const makeNativeCommand = (execute) => ({
      pickOnly: true,
      isWebGPUDrawCommand: true,
      execute: execute,
    });
    const command = {
      isWebGPUDrawCommand: true,
      derivedCommands: {
        picking: {
          pickCommand: makeNativeCommand(function (renderPass) {
            coveredX = renderPass.scissor[0] < 50 ? 48 : 51;
          }),
        },
        snapping: {
          snapCommand: makeNativeCommand(function () {
            payloadExecution++;
            if (payloadExecution === 1) {
              payloadByX.set(48, "first-segment-hit");
            }
          }),
        },
      },
    };
    const encoder = makeEncoder();
    const frameState = {
      camera: { frustum: { near: 1.0, far: 100.0 } },
      passes: {
        pick: true,
        pickVoxel: false,
        snap: true,
        depth: false,
        pickMode: "default",
      },
      pickingMetadata: false,
      useLogDepth: false,
    };
    const context = {
      _device: {},
      _currentCommandEncoder: encoder,
      _currentRenderPassEncoder: null,
      uniformState: {
        updatePass: jasmine.createSpy("updatePass"),
        inverseProjection: new Float32Array(16),
      },
      beginPickFrame: jasmine.createSpy("beginPickFrame"),
      endCurrentRenderPass: jasmine.createSpy("endCurrentRenderPass"),
      withRenderPassTimestamps: function (descriptor) {
        return descriptor;
      },
    };
    const scene = {
      mode: 2,
      camera: {
        position: { z: 500.0 },
        frustum: frameState.camera.frustum,
      },
      _frameState: frameState,
      frameState: frameState,
      opaqueFrustumNearOffset: 1.0,
      _view: {
        frustumCommandsList: [makeFrustum(1.0, 100.0, command)],
      },
      highDynamicRange: false,
    };
    const resetCalls = [];
    const passState = {
      framebuffer: {
        _isWebGPUPickFBO: true,
        _isWebGPUSnapFBO: true,
        colorView: {},
        snapColorView: {},
        depthView: {},
        width: 100,
        height: 80,
        pickScissor: { x: 48, y: 10, width: 5, height: 5 },
        resetSnapPayloadCoverage: function (renderPass) {
          resetCalls.push(renderPass);
          const [x, , width] = renderPass.scissor;
          if (coveredX >= x && coveredX < x + width) {
            payloadByX.delete(coveredX);
          }
        },
      },
      viewport: { x: 0, y: 0, width: 50, height: 80 },
    };
    const host = {
      _currentFrustumIndex: -1,
      _updateFrustumUniforms: function () {},
    };
    const config = {
      scene: scene,
      context: context,
      passState: passState,
      sceneFbLoad: false,
    };

    executePickPass(host, config);
    // Model stale loaded payload in the continuing segment independently of
    // the first segment's valid result. The reset must touch x=51 while its
    // dynamic scissor preserves the previously-rendered x=48 result.
    payloadByX.set(51, "stale-covered-hit");
    passState.viewport = { x: 50, y: 0, width: 50, height: 80 };
    config.sceneFbLoad = true;
    executePickPass(host, config);

    expect(payloadByX.get(48)).toBe("first-segment-hit");
    expect(payloadByX.has(51)).toBe(false);
    expect(resetCalls).toEqual([encoder.passes[3]]);
    expect(encoder.passes[0].descriptor.colorAttachments[0].storeOp).toBe(
      "discard",
    );
    expect(encoder.passes[1].descriptor.colorAttachments[0].storeOp).toBe(
      "store",
    );
    expect(encoder.passes[2].descriptor.colorAttachments[0].storeOp).toBe(
      "discard",
    );
    expect(encoder.passes[3].descriptor.colorAttachments[0].storeOp).toBe(
      "store",
    );
    expect(encoder.passes[1].scissor).toEqual([48, 10, 2, 5]);
    expect(encoder.passes[3].scissor).toEqual([50, 10, 3, 5]);
    expect(encoder.passes[3].descriptor.colorAttachments[0].loadOp).toBe(
      "load",
    );
  });

  it("packs private depth only at terrain and tile classification checkpoints", function () {
    const executions = [];
    const command = (name) => ({
      pickOnly: true,
      isWebGPUDrawCommand: true,
      execute: function (renderPass) {
        executions.push({ name: name, renderPass: renderPass });
      },
    });
    const frustum = makeFrustum(1.0, 100.0);
    for (const [pass, name] of [
      [Pass.GLOBE, "globe"],
      [Pass.TERRAIN_CLASSIFICATION, "terrain-classification"],
      [Pass.CESIUM_3D_TILE, "tile"],
      [Pass.CESIUM_3D_TILE_CLASSIFICATION, "tile-classification"],
      [Pass.OPAQUE, "opaque"],
    ]) {
      frustum.commands[pass].push(command(name));
      frustum.indices[pass] = 1;
    }
    const encoder = makeEncoder();
    const packedView = {};
    const depthTexture = {};
    const depthPacks = [];
    const frameState = {
      passes: { pick: true, pickMode: "default" },
      useLogDepth: false,
    };
    const context = {
      _device: {},
      _currentCommandEncoder: encoder,
      _currentRenderPassEncoder: null,
      _pickClassificationDepthView: {},
      uniformState: {
        updatePass: function () {},
        inverseProjection: new Float32Array(16),
      },
      beginPickFrame: function () {},
      endCurrentRenderPass: function () {},
      withRenderPassTimestamps: function (descriptor) {
        return descriptor;
      },
    };
    const scene = {
      mode: 3,
      camera: {
        positionWC: { x: 0, y: 0, z: 0 },
        frustum: { near: 1.0, far: 100.0 },
      },
      _frameState: frameState,
      frameState: frameState,
      _view: { frustumCommandsList: [frustum] },
    };
    const host = {
      _currentFrustumIndex: -1,
      _updateFrustumUniforms: function () {},
      _renderDepthPlane: jasmine.createSpy("renderDepthPlane"),
      _globeDepth: {
        executeCopyDepthToView: function (
          commandEncoder,
          destination,
          source,
          scissor,
        ) {
          depthPacks.push({ commandEncoder, destination, source, scissor });
        },
      },
    };

    executePickPass(host, {
      scene: scene,
      context: context,
      passState: {
        framebuffer: {
          _isWebGPUPickFBO: true,
          colorView: {},
          depthView: {},
          depthTexture: depthTexture,
          width: 100,
          height: 80,
          pickScissor: { x: 10, y: 20, width: 3, height: 3 },
          ensureClassificationDepth: function () {
            return { texture: {}, view: packedView };
          },
        },
        viewport: { x: 0, y: 0, width: 100, height: 80 },
      },
      clearGlobeDepth: false,
      useDepthPlane: false,
    });

    expect(depthPacks.length).toBe(2);
    expect(depthPacks[0]).toEqual({
      commandEncoder: encoder,
      destination: packedView,
      source: depthTexture,
      scissor: { x: 10, y: 20, width: 3, height: 3 },
    });
    expect(encoder.passes.length).toBe(3);
    expect(encoder.passes[0].descriptor.colorAttachments[0].loadOp).toBe(
      "clear",
    );
    expect(
      encoder.passes[0].descriptor.depthStencilAttachment.depthLoadOp,
    ).toBe("clear");
    expect(
      encoder.passes[0].descriptor.depthStencilAttachment.depthStoreOp,
    ).toBe("store");
    expect(encoder.passes[1].descriptor.colorAttachments[0].loadOp).toBe(
      "load",
    );
    expect(
      encoder.passes[1].descriptor.depthStencilAttachment.depthLoadOp,
    ).toBe("load");
    expect(
      encoder.passes[1].descriptor.depthStencilAttachment.depthStoreOp,
    ).toBe("store");
    expect(
      encoder.passes[2].descriptor.depthStencilAttachment.depthStoreOp,
    ).toBe("discard");
    expect(executions.map((entry) => entry.name)).toEqual([
      "globe",
      "terrain-classification",
      "tile",
      "tile-classification",
      "opaque",
    ]);
    expect(executions[0].renderPass).toBe(encoder.passes[0]);
    expect(executions[1].renderPass).toBe(encoder.passes[1]);
    expect(executions[3].renderPass).toBe(encoder.passes[2]);
    expect(context._pickClassificationDepthView).toBeNull();
    expect(host._renderDepthPlane).not.toHaveBeenCalled();
  });

  it("accumulates two 2D wrap viewports without clearing the first half", function () {
    const command = {
      pickOnly: true,
      isWebGPUDrawCommand: true,
      execute: jasmine.createSpy("execute"),
    };
    const encoder = makeEncoder();
    const frameState = {
      camera: { frustum: { near: 1.0, far: 100.0 } },
      passes: {
        pick: true,
        pickVoxel: false,
        depth: false,
        pickMode: "default",
      },
      pickingMetadata: false,
      useLogDepth: false,
    };
    const context = {
      _device: {},
      _currentCommandEncoder: encoder,
      _currentRenderPassEncoder: null,
      uniformState: {
        updatePass: jasmine.createSpy("updatePass"),
        inverseProjection: Array.from({ length: 16 }, (_value, i) => i),
      },
      beginPickFrame: jasmine.createSpy("beginPickFrame"),
      endCurrentRenderPass: jasmine.createSpy("endCurrentRenderPass"),
      withRenderPassTimestamps: function (descriptor) {
        return descriptor;
      },
    };
    const scene = {
      mode: 2,
      camera: {
        position: { z: 500.0 },
        frustum: frameState.camera.frustum,
      },
      _frameState: frameState,
      frameState: frameState,
      _view: { frustumCommandsList: [makeFrustum(1.0, 100.0, command)] },
    };
    const passState = {
      framebuffer: {
        _isWebGPUPickFBO: true,
        colorView: {},
        depthView: {},
        width: 100,
        height: 80,
        pickScissor: { x: 48, y: 10, width: 5, height: 5 },
      },
      viewport: { x: 0, y: 0, width: 50, height: 80 },
    };
    const host = {
      _currentFrustumIndex: -1,
      _updateFrustumUniforms: function () {},
    };
    const config = {
      scene: scene,
      context: context,
      passState: passState,
      sceneFbLoad: false,
    };

    executePickPass(host, config);
    passState.viewport = { x: 50, y: 0, width: 50, height: 80 };
    config.sceneFbLoad = true;
    executePickPass(host, config);

    expect(encoder.passes.length).toBe(2);
    expect(encoder.passes[0].descriptor.colorAttachments[0].loadOp).toBe(
      "clear",
    );
    expect(encoder.passes[1].descriptor.colorAttachments[0].loadOp).toBe(
      "load",
    );
    expect(encoder.passes[0].viewport).toEqual([0, 0, 50, 80, 0, 1]);
    expect(encoder.passes[1].viewport).toEqual([50, 0, 50, 80, 0, 1]);
    expect(encoder.passes[0].scissor).toEqual([48, 10, 2, 5]);
    expect(encoder.passes[1].scissor).toEqual([50, 10, 3, 5]);
    expect(command.execute).toHaveBeenCalledTimes(2);
    expect(scene.camera.position.z).toBe(500.0);
  });

  it("ends the active pick pass when a command throws", function () {
    const command = {
      pickOnly: true,
      isWebGPUDrawCommand: true,
      execute: function () {
        throw new Error("synthetic pick command failure");
      },
    };
    const encoder = makeEncoder();
    const context = {
      _device: {},
      _currentCommandEncoder: encoder,
      _currentRenderPassEncoder: null,
      uniformState: {
        updatePass: function () {},
        inverseProjection: new Float32Array(16),
      },
      beginPickFrame: function () {},
      endCurrentRenderPass: function () {},
      withRenderPassTimestamps: function (descriptor) {
        return descriptor;
      },
    };
    const frameState = {
      passes: { pick: true, pickMode: "default" },
      useLogDepth: false,
    };
    const scene = {
      mode: 3,
      camera: { frustum: { near: 1.0, far: 10.0 } },
      _frameState: frameState,
      frameState: frameState,
      _view: { frustumCommandsList: [makeFrustum(1.0, 10.0, command)] },
    };

    expect(function () {
      executePickPass(
        { _currentFrustumIndex: -1, _updateFrustumUniforms: function () {} },
        {
          scene: scene,
          context: context,
          passState: {
            framebuffer: {
              _isWebGPUPickFBO: true,
              colorView: {},
              depthView: {},
              width: 10,
              height: 10,
              pickScissor: { x: 0, y: 0, width: 1, height: 1 },
            },
            viewport: { x: 0, y: 0, width: 10, height: 10 },
          },
        },
      );
    }).toThrowError("synthetic pick command failure");
    expect(encoder.passes[0].ended).toBe(true);
    expect(context._currentRenderPassEncoder).toBeNull();
  });
});
