import Pass from "../../Source/Renderer/Pass.js";
import Scene from "../../Source/Scene/Scene.js";
import { insertIntoBin } from "../../Source/Scene/View.js";
import scheduleFinalWebGLShaderProgram from "../../Source/Scene/WebGLShaderProgramScheduler.js";

describe("Scene/WebGLShaderProgramScheduler", function () {
  function createShaderCache(name = "scheduleShaderProgramCompilation") {
    return {
      scheduleShaderProgramCompilation: jasmine.createSpy(name),
    };
  }

  function createShaderProgram(shaderCache, pending = true) {
    return {
      _cachedShader: {
        cache: shaderCache,
      },
      _linkState: pending ? "linking" : "ready",
      _isLinkPending: jasmine
        .createSpy("_isLinkPending")
        .and.returnValue(pending),
    };
  }

  function createScene() {
    const shaderCache = createShaderCache();
    const context = {
      _parallelShaderCompile: {},
      shaderCache,
    };

    return {
      _alternateSceneRenderer: undefined,
      _hdr: false,
      _context: context,
      _frameState: {
        context,
        passes: {
          render: true,
          pick: false,
          pickVoxel: false,
          depth: false,
        },
        pickingMetadata: false,
        useLogDepth: false,
        shadowState: {
          lightShadowsEnabled: false,
          lastDirtyTime: undefined,
        },
      },
      debugCommandFilter: undefined,
      debugShowCommands: false,
      debugShowFrustums: false,
    };
  }

  function markDerivedCommandClean(scene, command) {
    command.dirty = false;
    command.lastDirtyTime = scene._frameState.shadowState.lastDirtyTime;
    command.derivedCommands.originalCommand = command;
  }

  function createCommand(
    scene,
    shaderProgram = createShaderProgram(scene._context.shaderCache),
  ) {
    return {
      isWebGPUDrawCommand: false,
      pass: Pass.OPAQUE,
      receiveShadows: false,
      shaderProgram,
      derivedCommands: {},
      dirty: false,
    };
  }

  it("schedules only the final log-depth, HDR, shadow-receive executable", function () {
    const scene = createScene();
    scene._frameState.useLogDepth = true;
    scene._frameState.shadowState.lightShadowsEnabled = true;
    scene._hdr = true;

    const base = createCommand(scene);
    const logDepth = createCommand(scene);
    const hdr = createCommand(scene);
    const receive = createCommand(scene);
    hdr.receiveShadows = true;
    base.derivedCommands.logDepth = { command: logDepth };
    logDepth.derivedCommands.hdr = { command: hdr };
    hdr.derivedCommands.shadows = { receiveCommand: receive };

    scheduleFinalWebGLShaderProgram(scene, base);

    expect(
      scene._context.shaderCache.scheduleShaderProgramCompilation,
    ).toHaveBeenCalledOnceWith(receive.shaderProgram);
  });

  it("schedules the base executable when no derived variant is selected", function () {
    const scene = createScene();
    const command = createCommand(scene);

    scheduleFinalWebGLShaderProgram(scene, command);

    expect(
      scene._context.shaderCache.scheduleShaderProgramCompilation,
    ).toHaveBeenCalledOnceWith(command.shaderProgram);
  });

  it("does not revisit an executable whose link is no longer pending", function () {
    const scene = createScene();
    const command = createCommand(
      scene,
      createShaderProgram(scene._context.shaderCache, false),
    );

    scheduleFinalWebGLShaderProgram(scene, command);

    expect(
      scene._context.shaderCache.scheduleShaderProgramCompilation,
    ).not.toHaveBeenCalled();
  });

  it("fast-returns a memoized ready configuration without rewalking derivatives", function () {
    const scene = createScene();
    scene._frameState.useLogDepth = true;

    const base = createCommand(scene);
    const logDepth = createCommand(
      scene,
      createShaderProgram(scene._context.shaderCache, false),
    );
    const logDepthDerivative = { command: logDepth };
    let logDepthReads = 0;
    Object.defineProperty(base.derivedCommands, "logDepth", {
      get: function () {
        ++logDepthReads;
        return logDepthDerivative;
      },
    });

    scheduleFinalWebGLShaderProgram(scene, base);
    scheduleFinalWebGLShaderProgram(scene, base);

    expect(logDepthReads).toBe(1);
    expect(logDepth.shaderProgram._isLinkPending).toHaveBeenCalledTimes(1);
  });

  it("invalidates the ready memo when base or final program identity changes", function () {
    const scene = createScene();
    scene._frameState.useLogDepth = true;

    const base = createCommand(scene);
    const firstFinal = createCommand(
      scene,
      createShaderProgram(scene._context.shaderCache, false),
    );
    base.derivedCommands.logDepth = { command: firstFinal };

    scheduleFinalWebGLShaderProgram(scene, base);
    scheduleFinalWebGLShaderProgram(scene, base);
    expect(firstFinal.shaderProgram._isLinkPending).toHaveBeenCalledTimes(1);

    const replacementFinalProgram = createShaderProgram(
      scene._context.shaderCache,
      false,
    );
    firstFinal.shaderProgram = replacementFinalProgram;
    scheduleFinalWebGLShaderProgram(scene, base);
    expect(replacementFinalProgram._isLinkPending).toHaveBeenCalledTimes(1);

    const replacementBaseProgram = createShaderProgram(
      scene._context.shaderCache,
      false,
    );
    base.shaderProgram = replacementBaseProgram;
    scheduleFinalWebGLShaderProgram(scene, base);
    expect(replacementFinalProgram._isLinkPending).toHaveBeenCalledTimes(2);
  });

  it("invalidates the ready memo when final-program selectors change", function () {
    const scene = createScene();
    const base = createCommand(
      scene,
      createShaderProgram(scene._context.shaderCache, false),
    );
    const logDepth = createCommand(
      scene,
      createShaderProgram(scene._context.shaderCache, false),
    );
    base.derivedCommands.logDepth = { command: logDepth };

    scheduleFinalWebGLShaderProgram(scene, base);
    scheduleFinalWebGLShaderProgram(scene, base);
    expect(base.shaderProgram._isLinkPending).toHaveBeenCalledTimes(1);
    expect(logDepth.shaderProgram._isLinkPending).not.toHaveBeenCalled();

    scene._frameState.useLogDepth = true;
    scheduleFinalWebGLShaderProgram(scene, base);
    expect(logDepth.shaderProgram._isLinkPending).toHaveBeenCalledTimes(1);
  });

  it("invalidates the ready memo when observed link state changes", function () {
    const scene = createScene();
    const command = createCommand(
      scene,
      createShaderProgram(scene._context.shaderCache, false),
    );
    const shaderProgram = command.shaderProgram;

    scheduleFinalWebGLShaderProgram(scene, command);
    scheduleFinalWebGLShaderProgram(scene, command);
    expect(shaderProgram._isLinkPending).toHaveBeenCalledTimes(1);

    shaderProgram._linkState = "linking";
    shaderProgram._isLinkPending.and.returnValue(true);
    scheduleFinalWebGLShaderProgram(scene, command);
    expect(shaderProgram._isLinkPending).toHaveBeenCalledTimes(2);
    expect(
      scene._context.shaderCache.scheduleShaderProgramCompilation,
    ).toHaveBeenCalledOnceWith(shaderProgram);

    shaderProgram._linkState = "ready";
    shaderProgram._isLinkPending.and.returnValue(false);
    scheduleFinalWebGLShaderProgram(scene, command);
    scheduleFinalWebGLShaderProgram(scene, command);
    expect(shaderProgram._isLinkPending).toHaveBeenCalledTimes(3);
  });

  it("invalidates the ready memo after an off-camera dirty rebuild", function () {
    const scene = createScene();
    scene._view = { oit: undefined };
    scene._frameState.shadowState.shadowsEnabled = false;
    scene._frameState.shadowState.lightShadowMaps = [];
    const command = createCommand(
      scene,
      createShaderProgram(scene._context.shaderCache, false),
    );
    command.pickOnly = true;
    command.derivedCommands.originalCommand = command;

    scheduleFinalWebGLShaderProgram(scene, command);
    scheduleFinalWebGLShaderProgram(scene, command);
    expect(command.shaderProgram._isLinkPending).toHaveBeenCalledTimes(1);

    command.dirty = true;
    Scene.prototype.updateDerivedCommands.call(scene, command);
    expect(command._webGLFinalShaderProgramBase).toBeUndefined();
    expect(command._webGLFinalShaderProgramCommand).toBeUndefined();
    expect(command._webGLFinalShaderProgram).toBeUndefined();
    expect(command._webGLFinalShaderProgramSelector).toBe(-1);
    expect(command._webGLFinalShaderProgramLinkState).toBeUndefined();
    expect(command.shaderProgram._isLinkPending).toHaveBeenCalledTimes(1);

    Scene.prototype.updateDerivedCommands.call(scene, command, true);
    expect(command.shaderProgram._isLinkPending).toHaveBeenCalledTimes(2);
  });

  it("schedules the exact final executable when the derived tree is already clean", function () {
    const scene = createScene();
    scene._frameState.useLogDepth = true;
    scene._frameState.shadowState.lightShadowsEnabled = true;
    scene._hdr = true;

    const base = createCommand(scene);
    const baseHdr = createCommand(scene);
    const logDepth = createCommand(scene);
    const hdr = createCommand(scene);
    const receive = createCommand(scene);
    hdr.receiveShadows = true;
    base.derivedCommands.logDepth = { command: logDepth };
    base.derivedCommands.hdr = { command: baseHdr };
    logDepth.derivedCommands.hdr = { command: hdr };
    hdr.derivedCommands.shadows = { receiveCommand: receive };
    markDerivedCommandClean(scene, base);

    const derivedCommands = base.derivedCommands;
    const logDepthDerivedCommands = logDepth.derivedCommands;
    const hdrDerivedCommands = hdr.derivedCommands;

    Scene.prototype.updateDerivedCommands.call(scene, base, true);

    expect(
      scene._context.shaderCache.scheduleShaderProgramCompilation,
    ).toHaveBeenCalledOnceWith(receive.shaderProgram);
    expect(base.dirty).toBe(false);
    expect(base.derivedCommands).toBe(derivedCommands);
    expect(logDepth.derivedCommands).toBe(logDepthDerivedCommands);
    expect(hdr.derivedCommands).toBe(hdrDerivedCommands);
  });

  it("keeps clean-command scheduling confined to the visible main render path", function () {
    const offCameraScene = createScene();
    const offCameraCommand = createCommand(offCameraScene);
    markDerivedCommandClean(offCameraScene, offCameraCommand);
    Scene.prototype.updateDerivedCommands.call(
      offCameraScene,
      offCameraCommand,
    );

    expect(
      offCameraScene._context.shaderCache.scheduleShaderProgramCompilation,
    ).not.toHaveBeenCalled();

    const pickScene = createScene();
    pickScene._frameState.passes.pick = true;
    const pickCommand = createCommand(pickScene);
    markDerivedCommandClean(pickScene, pickCommand);
    Scene.prototype.updateDerivedCommands.call(pickScene, pickCommand, true);

    expect(
      pickScene._context.shaderCache.scheduleShaderProgramCompilation,
    ).not.toHaveBeenCalled();

    const alternateScene = createScene();
    alternateScene._alternateSceneRenderer = {};
    const alternateCommand = createCommand(alternateScene);
    markDerivedCommandClean(alternateScene, alternateCommand);
    Scene.prototype.updateDerivedCommands.call(
      alternateScene,
      alternateCommand,
      true,
    );

    expect(
      alternateScene._context.shaderCache.scheduleShaderProgramCompilation,
    ).not.toHaveBeenCalled();
  });

  it("schedules through the final program owner instead of a foreign frame cache", function () {
    const scene = createScene();
    const frameCache = scene._frameState.context.shaderCache;
    scene._frameState.context._parallelShaderCompile = undefined;
    const ownerCache = createShaderCache(
      "ownerScheduleShaderProgramCompilation",
    );
    const command = createCommand(scene, createShaderProgram(ownerCache));

    scheduleFinalWebGLShaderProgram(scene, command);

    expect(
      ownerCache.scheduleShaderProgramCompilation,
    ).toHaveBeenCalledOnceWith(command.shaderProgram);
    expect(frameCache.scheduleShaderProgramCompilation).not.toHaveBeenCalled();
  });

  it("bypasses final WebGL scheduling while binning WebGPU commands", function () {
    const updateDerivedCommands = jasmine.createSpy("updateDerivedCommands");
    const scene = {
      _alternateSceneRenderer: undefined,
      debugShowFrustums: false,
      updateDerivedCommands: updateDerivedCommands,
    };

    function bin(command) {
      const indices = [];
      const commands = [];
      indices[command.pass] = 0;
      commands[command.pass] = [];
      const view = {
        frustumCommandsList: [
          {
            near: 0.0,
            far: 10.0,
            indices: indices,
            commands: commands,
          },
        ],
      };
      insertIntoBin(view, scene, {
        command: command,
        near: 1.0,
        far: 2.0,
      });
    }

    const webgpuCommand = {
      isWebGPUDrawCommand: true,
      pass: Pass.OPAQUE,
    };
    bin(webgpuCommand);
    expect(updateDerivedCommands.calls.mostRecent().args).toEqual([
      webgpuCommand,
    ]);

    const alternateCommand = {
      isWebGPUDrawCommand: false,
      pass: Pass.OPAQUE,
    };
    scene._alternateSceneRenderer = {};
    bin(alternateCommand);
    expect(updateDerivedCommands.calls.mostRecent().args).toEqual([
      alternateCommand,
    ]);

    const webglCommand = {
      isWebGPUDrawCommand: false,
      pass: Pass.OPAQUE,
    };
    scene._alternateSceneRenderer = undefined;
    bin(webglCommand);
    expect(updateDerivedCommands.calls.mostRecent().args).toEqual([
      webglCommand,
      true,
    ]);
  });

  it("conservatively excludes non-color and renderer-specific paths", function () {
    const excludedScenesAndCommands = [];

    const alternateRenderer = createScene();
    alternateRenderer._alternateSceneRenderer = {};
    excludedScenesAndCommands.push([
      alternateRenderer,
      createCommand(alternateRenderer),
    ]);

    const webgpu = createScene();
    const webgpuCommand = createCommand(webgpu);
    webgpuCommand.isWebGPUDrawCommand = true;
    excludedScenesAndCommands.push([webgpu, webgpuCommand]);

    for (const passName of ["render", "pick", "pickVoxel", "depth"]) {
      const scene = createScene();
      scene._frameState.passes[passName] = passName !== "render";
      excludedScenesAndCommands.push([scene, createCommand(scene)]);
    }

    const translucent = createScene();
    const translucentCommand = createCommand(translucent);
    translucentCommand.pass = Pass.TRANSLUCENT;
    excludedScenesAndCommands.push([translucent, translucentCommand]);

    for (const property of [
      "debugCommandFilter",
      "debugShowCommands",
      "debugShowFrustums",
    ]) {
      const scene = createScene();
      scene[property] = property === "debugCommandFilter" ? () => true : true;
      excludedScenesAndCommands.push([scene, createCommand(scene)]);
    }

    for (const [scene, command] of excludedScenesAndCommands) {
      scheduleFinalWebGLShaderProgram(scene, command);
      expect(
        scene._context.shaderCache.scheduleShaderProgramCompilation,
      ).not.toHaveBeenCalled();
    }
  });
});
