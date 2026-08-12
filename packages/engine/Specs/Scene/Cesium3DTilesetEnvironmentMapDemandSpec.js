import Cartesian3 from "../../Source/Core/Cartesian3.js";
import SceneMode from "../../Source/Scene/SceneMode.js";
import {
  recordEnvironmentMapNoDemandForSkippedTraversal,
  updateEnvironmentMapForSelectedConsumers,
} from "../../Source/Scene/Cesium3DTileset.js";

describe("Scene/Cesium3DTileset environment-map demand", function () {
  it("records demand telemetry without ticking the manager, with and without selected consumers", function () {
    const center = new Cartesian3(1.0, 2.0, 3.0);
    const environmentMapManager = {
      position: undefined,
      update: jasmine.createSpy("update"),
    };
    const tileset = {
      _selectedTiles: [],
      _environmentMapManager: environmentMapManager,
      boundingSphere: { center },
    };
    const context = {
      recordEnvironmentMapDemand: jasmine.createSpy(
        "recordEnvironmentMapDemand",
      ),
    };
    const frameState = { context };

    updateEnvironmentMapForSelectedConsumers(tileset, frameState);

    expect(context.recordEnvironmentMapDemand).toHaveBeenCalledOnceWith(
      environmentMapManager,
      "proven-none",
      "tileset-selection",
      0,
    );
    expect(environmentMapManager.update).not.toHaveBeenCalled();
    expect(environmentMapManager.position).toBeUndefined();

    context.recordEnvironmentMapDemand.calls.reset();
    tileset._selectedTiles.push({});
    updateEnvironmentMapForSelectedConsumers(tileset, frameState, 0);

    expect(context.recordEnvironmentMapDemand).toHaveBeenCalledOnceWith(
      environmentMapManager,
      "proven-none",
      "tileset-selection",
      0,
    );

    context.recordEnvironmentMapDemand.calls.reset();
    updateEnvironmentMapForSelectedConsumers(tileset, frameState);

    expect(context.recordEnvironmentMapDemand).toHaveBeenCalledOnceWith(
      environmentMapManager,
      "demanded",
      "tileset-selection",
      1,
    );
    // The helper is observe-only: the manager's position and per-pass tick are
    // owned by updateForPass so a hidden or unselected tileset can never freeze
    // the multi-frame generation state machine mid-generation.
    expect(environmentMapManager.position).toBeUndefined();
    expect(environmentMapManager.update).not.toHaveBeenCalled();
  });

  function createSkippedTraversalFixture() {
    const environmentMapManager = {};
    const context = {
      recordEnvironmentMapDemand: jasmine.createSpy(
        "recordEnvironmentMapDemand",
      ),
    };
    return {
      tileset: {
        show: true,
        _root: {},
        _selectedTiles: [{}],
        _environmentMapManager: environmentMapManager,
      },
      frameState: {
        context,
        mode: SceneMode.SCENE3D,
      },
      context,
      environmentMapManager,
    };
  }

  function expectSkippedTraversalRecordsZero(fixture) {
    expect(
      recordEnvironmentMapNoDemandForSkippedTraversal(
        fixture.tileset,
        fixture.frameState,
      ),
    ).toBe(true);
    expect(fixture.context.recordEnvironmentMapDemand).toHaveBeenCalledOnceWith(
      fixture.environmentMapManager,
      "proven-none",
      "tileset-selection",
      0,
    );
  }

  it("records explicit zero demand when a hidden tileset skips traversal", function () {
    const fixture = createSkippedTraversalFixture();
    fixture.tileset.show = false;

    expectSkippedTraversalRecordsZero(fixture);
  });

  it("records explicit zero demand when a rootless tileset skips traversal", function () {
    const fixture = createSkippedTraversalFixture();
    fixture.tileset._root = undefined;

    expectSkippedTraversalRecordsZero(fixture);
  });

  it("records explicit zero demand while morphing skips traversal", function () {
    const fixture = createSkippedTraversalFixture();
    fixture.frameState.mode = SceneMode.MORPHING;

    expectSkippedTraversalRecordsZero(fixture);
  });

  it("leaves final demand to ordinary visible traversal", function () {
    const fixture = createSkippedTraversalFixture();

    expect(
      recordEnvironmentMapNoDemandForSkippedTraversal(
        fixture.tileset,
        fixture.frameState,
      ),
    ).toBe(false);
    expect(fixture.context.recordEnvironmentMapDemand).not.toHaveBeenCalled();
  });
});
