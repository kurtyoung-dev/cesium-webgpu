import Primitive from "../../../Source/Scene/Primitive.js";
import PrimitiveState from "../../../Source/Scene/PrimitiveState.js";
import SceneMode from "../../../Source/Scene/SceneMode.js";

describe("Renderer/WebGPU/Primitive device recovery", function () {
  it("rebuilds commands when the device resource generation changes at the same format", function () {
    const context = {
      renderTargetGeneration: 7,
      resourceGeneration: 3,
      getFeatureRenderer: function () {
        return {};
      },
    };
    const createCommands = jasmine
      .createSpy("createCommands")
      .and.callFake(
        function (
          _primitive,
          _appearance,
          _material,
          _translucent,
          _twoPasses,
          colorCommands,
          pickCommands,
        ) {
          colorCommands.length = 0;
          colorCommands.push({
            resourceGeneration: context.resourceGeneration,
          });
          pickCommands.length = 0;
        },
      );
    const appearance = {
      material: undefined,
      closed: false,
      isTranslucent: function () {
        return false;
      },
    };
    const primitive = new Primitive({
      appearance,
      _createCommandsFunction: createCommands,
      _updateAndQueueCommandsFunction: function () {},
    });

    // Put the primitive directly into the stable post-geometry state. This is
    // a command-lifetime test and deliberately performs no GPU/worker work.
    primitive._state = PrimitiveState.COMPLETE;
    primitive._ready = true;
    primitive._va = [{}];
    primitive._batchTable = { attributes: [] };
    primitive._batchTableOffsetsUpdated = true;

    const frameState = {
      context,
      mode: SceneMode.SCENE3D,
      scene3DOnly: true,
      passes: { render: true, pick: false },
    };

    primitive.update(frameState);
    expect(createCommands).toHaveBeenCalledTimes(1);
    expect(primitive._colorCommands[0].resourceGeneration).toBe(3);

    // Identical context generations preserve the hot-path command list.
    primitive.update(frameState);
    expect(createCommands).toHaveBeenCalledTimes(1);

    // Device recovery keeps the render-target format epoch unchanged here.
    // The independent resource epoch must still reject old-device buffers.
    context.resourceGeneration = 4;
    primitive.update(frameState);
    expect(context.renderTargetGeneration).toBe(7);
    expect(createCommands).toHaveBeenCalledTimes(2);
    expect(primitive._colorCommands[0].resourceGeneration).toBe(4);
  });
});
