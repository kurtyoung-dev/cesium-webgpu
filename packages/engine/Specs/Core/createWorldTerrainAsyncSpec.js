import { createWorldTerrainAsync, CesiumTerrainProvider } from "../../index.js";
import { describeRequiresNetwork } from "../../../../Specs/networkPolicy.js";

// C11-134 — resolves against the live Ion asset endpoint; there is no local
// fixture for it. Quarantined to the online lane so the offline lane reports it
// as a truthful "requires network" skip instead of a nondeterministic timeout.
describeRequiresNetwork("Core/createWorldTerrainAsync", function () {
  it("resolves to CesiumTerrainProvider instance with default parameters", async function () {
    const provider = await createWorldTerrainAsync();
    expect(provider).toBeInstanceOf(CesiumTerrainProvider);
    expect(provider.requestVertexNormals).toBe(false);
    expect(provider.requestWaterMask).toBe(false);
  });
});
