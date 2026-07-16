import {
  sortCommandsBackToFront,
  sortCommandsFrontToBack,
} from "../../../Source/Renderer/WebGPU/WebGPUSceneRenderer.js";

describe("Renderer/WebGPU/WebGPUSceneRenderer command sorting", function () {
  const scene = {
    camera: {
      positionWC: { x: 0, y: 0, z: 0 },
    },
  };

  function createCommand(name, distanceSquared) {
    return {
      name,
      boundingVolume: {
        distanceSquaredTo: function () {
          return distanceSquared;
        },
      },
    };
  }

  it("sorts the active prefix front-to-back and preserves pooled tail slots", function () {
    const far = createCommand("far", 100);
    const middle = createCommand("middle", 25);
    const near = createCommand("near", 1);
    const pooledTail = createCommand("pooled-tail", 0);
    const commands = [far, near, middle, pooledTail];

    sortCommandsFrontToBack(commands, 3, scene);

    expect(commands).toEqual([near, middle, far, pooledTail]);

    // Reuse the same backing array to exercise its retained merge scratch.
    commands[0] = middle;
    commands[1] = far;
    commands[2] = near;
    sortCommandsFrontToBack(commands, 3, scene);

    expect(commands).toEqual([near, middle, far, pooledTail]);
  });

  it("sorts the active prefix back-to-front stably and preserves pooled tail slots", function () {
    const equalA = createCommand("equal-a", 25);
    const near = createCommand("near", 1);
    const far = createCommand("far", 100);
    const equalB = createCommand("equal-b", 25);
    const pooledTail = createCommand("pooled-tail", 1000);
    const commands = [equalA, near, far, equalB, pooledTail];

    sortCommandsBackToFront(commands, 4, scene);

    expect(commands).toEqual([far, equalA, equalB, near, pooledTail]);
  });
});
