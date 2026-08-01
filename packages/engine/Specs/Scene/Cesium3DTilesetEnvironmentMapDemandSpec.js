import Cartesian3 from "../../Source/Core/Cartesian3.js";
import { updateEnvironmentMapForSelectedConsumers } from "../../Source/Scene/Cesium3DTileset.js";

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
});
