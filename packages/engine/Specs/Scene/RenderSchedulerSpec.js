import RenderScheduler from "../../Source/Scene/RenderScheduler.js";

describe("Scene/RenderScheduler", function () {
  it("keeps the dead bucket/sort stream disabled while assigning stable material IDs", function () {
    const scheduler = new RenderScheduler();
    const shaderProgram = { id: 17 };
    const commands = [
      { materialSortId: 0, _shaderProgram: shaderProgram },
      { materialSortId: 0, _shaderProgram: shaderProgram },
      { materialSortId: 0, _shaderProgram: { id: 23 } },
    ];

    scheduler.beginFrame();
    scheduler.assignMaterialSortIds(commands);

    expect(scheduler.enabled).toBe(false);
    expect(commands[0].materialSortId).toBeGreaterThan(0);
    expect(commands[1].materialSortId).toBe(commands[0].materialSortId);
    expect(commands[2].materialSortId).not.toBe(commands[0].materialSortId);
    expect(scheduler.stats.materialIdsAssigned).toBe(3);
    expect(scheduler.stats.commandsBinned).toBe(0);
    expect(scheduler.stats.sortCalls).toBe(0);
  });

  it("keeps the legacy scheduler force-reachable for characterization", function () {
    const scheduler = new RenderScheduler({ enabled: true });
    const command = {
      materialSortId: 0,
      _shaderProgram: { id: 31 },
      pass: 7,
    };

    scheduler.beginFrame();
    scheduler.binCommand(command, false);
    scheduler.sortAllLayers({ x: 0, y: 0, z: 0 });

    expect(scheduler.stats.commandsBinned).toBe(1);
    expect(scheduler.stats.materialIdsAssigned).toBe(1);
    expect(scheduler.stats.sortCalls).toBe(1);
  });
});
