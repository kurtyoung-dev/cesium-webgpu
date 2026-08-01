import DerivedCommand from "../../Source/Scene/DerivedCommand.js";
import Scene from "../../Source/Scene/Scene.js";
import ShadowMap from "../../Source/Scene/ShadowMap.js";

describe("Scene native WebGPU derived commands", function () {
  it("does not invoke WebGL derived-command factories", function () {
    const pickFactory = spyOn(DerivedCommand, "createPickDerivedCommand");
    const metadataFactory = spyOn(
      DerivedCommand,
      "createPickMetadataDerivedCommand",
    );
    const depthFactory = spyOn(DerivedCommand, "createDepthOnlyDerivedCommand");
    const hdrFactory = spyOn(DerivedCommand, "createHdrCommand");
    const receiveFactory = spyOn(ShadowMap, "createReceiveDerivedCommand");
    const castFactory = spyOn(ShadowMap, "createCastDerivedCommand");
    const pickCommand = {};
    const derivedCommands = {
      picking: {
        pickCommand: pickCommand,
      },
    };
    const command = {
      isWebGPUDrawCommand: true,
      derivedCommands: derivedCommands,
      dirty: true,
      castShadows: true,
      receiveShadows: true,
      pickId: {},
      pickMetadataAllowed: true,
      pickOnly: false,
    };

    Scene.prototype.updateDerivedCommands.call({}, command, true);

    expect(pickFactory).not.toHaveBeenCalled();
    expect(metadataFactory).not.toHaveBeenCalled();
    expect(depthFactory).not.toHaveBeenCalled();
    expect(hdrFactory).not.toHaveBeenCalled();
    expect(receiveFactory).not.toHaveBeenCalled();
    expect(castFactory).not.toHaveBeenCalled();
    expect(command.derivedCommands).toBe(derivedCommands);
    expect(command.derivedCommands.picking.pickCommand).toBe(pickCommand);
    expect(command.dirty).toBe(true);
  });
});
