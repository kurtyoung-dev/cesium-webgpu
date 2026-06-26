import * as Cesium from "cesium";

// Default to WebGPU; the BufferPointCollection works on both
// backends — switching the renderer is a single contextOptions
// change.
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
});

const POINT_COUNT = 50000;
const collection = new Cesium.BufferPointCollection({
  primitiveCountMax: POINT_COUNT,
});
viewer.scene.primitives.add(collection);

const material = new Cesium.BufferPointMaterial({
  color: Cesium.Color.fromCssColorString("#ffd700"),
});

// Distribute points across a 200km x 200km grid centered over SF
// at varying altitudes so the camera sees a 3D point cloud.
const point = new Cesium.BufferPoint();
const sideCount = Math.floor(Math.sqrt(POINT_COUNT));
const spreadDeg = 1.5; // ~165km at SF latitude
const startLon = -122.4194 - spreadDeg / 2;
const startLat = 37.7749 - spreadDeg / 2;
for (let i = 0; i < sideCount; i++) {
  for (let j = 0; j < sideCount; j++) {
    const lon = startLon + (spreadDeg * i) / sideCount;
    const lat = startLat + (spreadDeg * j) / sideCount;
    const h = 2000 + ((i * 7919 + j * 6151) % 6000);
    collection.add(
      {
        position: Cesium.Cartesian3.fromDegrees(lon, lat, h),
        material,
      },
      point,
    );
  }
}

const viewModel = {
  backend: viewer.scene._context?.rendererType ?? "unknown",
  pointCount: collection.primitiveCount,
};
Cesium.knockout.track(viewModel);
const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);

viewer.camera.flyTo({
  destination: Cesium.Cartesian3.fromDegrees(-122.4194, 37.7749, 200000),
  orientation: {
    heading: 0,
    pitch: Cesium.Math.toRadians(-60),
    roll: 0,
  },
  duration: 0,
});
