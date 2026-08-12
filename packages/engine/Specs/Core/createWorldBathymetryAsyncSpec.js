import {
  createWorldBathymetryAsync,
  CesiumTerrainProvider,
} from "../../index.js";
import { describeRequiresNetwork } from "../../../../Specs/networkPolicy.js";

describeRequiresNetwork("Core/createWorldBathymetryAsync", function () {
  it("resolves to CesiumTerrainProvider instance with default parameters", async function () {
    const provider = await createWorldBathymetryAsync();
    expect(provider).toBeInstanceOf(CesiumTerrainProvider);
    expect(provider.requestVertexNormals).toBe(false);
  });
});
