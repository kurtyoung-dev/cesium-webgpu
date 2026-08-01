import { configureWebGPUGlobeShadowCommand } from "../../Source/Scene/GlobeSurfaceTileProviderRendering.js";
import ShadowMode from "../../Source/Scene/ShadowMode.js";

describe("Scene/WebGPU globe shadow adapter", function () {
  function expectFlags(shadowMode, castShadows, receiveShadows) {
    const command = {};
    configureWebGPUGlobeShadowCommand(command, shadowMode, false, {});

    expect(command.castShadows).toBe(castShadows);
    expect(command.receiveShadows).toBe(receiveShadows);
  }

  it("maps every ShadowMode exactly like the WebGL globe path", function () {
    expectFlags(ShadowMode.ENABLED, true, true);
    expectFlags(ShadowMode.CAST_ONLY, true, false);
    expectFlags(ShadowMode.RECEIVE_ONLY, false, true);
    expectFlags(ShadowMode.DISABLED, false, false);
  });

  it("suppresses both shadow roles for translucent globe commands", function () {
    const modes = [
      ShadowMode.ENABLED,
      ShadowMode.CAST_ONLY,
      ShadowMode.RECEIVE_ONLY,
      ShadowMode.DISABLED,
    ];

    for (let i = 0; i < modes.length; i++) {
      const command = {};
      configureWebGPUGlobeShadowCommand(command, modes[i], true, {});

      expect(command.castShadows).toBe(false);
      expect(command.receiveShadows).toBe(false);
    }
  });

  it("forwards the stable tile resource as the bind-group cache host", function () {
    const command = {};
    const tileResources = {};

    configureWebGPUGlobeShadowCommand(
      command,
      ShadowMode.RECEIVE_ONLY,
      false,
      tileResources,
    );

    expect(command._shadowCastBindGroupCacheHost).toBe(tileResources);
    expect(command._shadowCastTopology).toBe("triangle-list");
    expect(command._shadowCastCullMode).toBe("back");
  });

  it("forwards wireframe topology to the native shadow cast pipeline", function () {
    const command = {};

    configureWebGPUGlobeShadowCommand(
      command,
      ShadowMode.ENABLED,
      false,
      {},
      "line-list",
    );

    expect(command._shadowCastTopology).toBe("line-list");
  });

  it("forwards underground/provider-disabled culling to the shadow pipeline", function () {
    const command = {};

    configureWebGPUGlobeShadowCommand(
      command,
      ShadowMode.ENABLED,
      false,
      {},
      "triangle-list",
      false,
    );

    expect(command._shadowCastCullMode).toBe("none");
  });
});
