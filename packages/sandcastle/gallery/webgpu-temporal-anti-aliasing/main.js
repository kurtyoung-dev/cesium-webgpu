import * as Cesium from "cesium";

// Force WebGPU — TAA is a WebGPU-only feature today.
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
  taaEnabled: true,
  terrain: Cesium.Terrain.fromWorldTerrain(),
});

const status =
  viewer.scene._context?.rendererType === "webgpu"
    ? "WebGPU active — TAA available"
    : "WebGL active — TAA unavailable on this backend";

const viewModel = {
  taaEnabled: true,
  status,
};

Cesium.knockout.track(viewModel);
const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);

Cesium.knockout.getObservable(viewModel, "taaEnabled").subscribe((value) => {
  viewer.scene.taaEnabled = Boolean(value);
  viewer.scene.requestRender();
});

// A view that highlights aliasing on building edges + terrain
// contours where TAA's effect is most visible.
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-73.985, 40.748, 1500),
  orientation: {
    heading: Cesium.Math.toRadians(20),
    pitch: Cesium.Math.toRadians(-30),
  },
});

// Add 3D Tiles New York buildings so jagged silhouettes give
// TAA something visible to smooth.
try {
  const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(75343);
  viewer.scene.primitives.add(tileset);
} catch (e) {
  // Fall back to a simple geometry if Ion is unreachable —
  // TAA still demonstrates on terrain/imagery edges.
  console.warn("[demo] Ion tileset unavailable, falling back:", e);
}
