import Pass from "../../Source/Renderer/Pass.js";
import { executeComputeCommands } from "../../Source/Scene/SceneRenderer.js";

describe("Scene/SceneRenderer compute commands", function () {
  it("updates and dispatches through the frame-local context", function () {
    const updatePass = jasmine.createSpy(
      "frameContext.uniformState.updatePass",
    );
    const dispatch = jasmine.createSpy("frameContext.executeComputeCommands");
    const sceneContextUpdatePass = jasmine.createSpy(
      "sceneContext.uniformState.updatePass",
    );
    const sceneContextDispatch = jasmine.createSpy(
      "sceneContext.executeComputeCommands",
    );
    const frameContext = {
      uniformState: { updatePass: updatePass },
      executeComputeCommands: dispatch,
    };
    const sceneContext = {
      uniformState: { updatePass: sceneContextUpdatePass },
      executeComputeCommands: sceneContextDispatch,
    };
    const commandList = [{ label: "compute" }];
    const sunComputeCommand = { label: "sun" };
    const legacyComputeEngine = { label: "legacy-engine" };
    const scene = {
      context: sceneContext,
      _context: sceneContext,
      frameState: { context: frameContext },
      _computeCommandList: commandList,
      _environmentState: { sunComputeCommand: sunComputeCommand },
      _computeEngine: legacyComputeEngine,
    };

    executeComputeCommands(scene);

    expect(updatePass).toHaveBeenCalledOnceWith(Pass.COMPUTE);
    expect(dispatch).toHaveBeenCalledOnceWith(
      commandList,
      sunComputeCommand,
      legacyComputeEngine,
    );
    expect(sceneContextUpdatePass).not.toHaveBeenCalled();
    expect(sceneContextDispatch).not.toHaveBeenCalled();
  });
});
