import * as Cesium from "cesium";

// Default to WebGPU; GeoJsonPrimitive works on both backends — switching
// the renderer is a single contextOptions change.
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
});

// Mixed FeatureCollection over the continental US. Each feature carries
// a "color" property used below to colorize the buffer primitives so the
// polygon hole and both MultiPolygon parts are visually distinct.
const featureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { color: "#ff3030" },
      geometry: { type: "Point", coordinates: [-118.24, 34.05] },
    },
    {
      type: "Feature",
      properties: { color: "#ff8c00" },
      geometry: {
        type: "MultiPoint",
        coordinates: [
          [-112.07, 33.45],
          [-115.14, 36.17],
          [-111.89, 40.76],
        ],
      },
    },
    {
      type: "Feature",
      properties: { color: "#30ff30" },
      geometry: {
        type: "LineString",
        coordinates: [
          [-122.42, 37.77],
          [-104.99, 39.74],
          [-87.65, 41.85],
        ],
      },
    },
    {
      type: "Feature",
      properties: { color: "#00e5ff" },
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [-95.37, 29.76],
            [-90.07, 29.95],
          ],
          [
            [-80.19, 25.76],
            [-81.66, 30.33],
          ],
        ],
      },
    },
    {
      // Polygon WITH A HOLE — the inner ring shows the globe through it.
      type: "Feature",
      properties: { color: "#ffe000" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-100.0, 40.0],
            [-94.0, 40.0],
            [-94.0, 45.0],
            [-100.0, 45.0],
            [-100.0, 40.0],
          ],
          [
            [-98.5, 41.5],
            [-95.5, 41.5],
            [-95.5, 43.5],
            [-98.5, 43.5],
            [-98.5, 41.5],
          ],
        ],
      },
    },
    {
      // MultiPolygon — two parts; the second part also has a hole.
      type: "Feature",
      properties: { color: "#c030ff" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [-90.0, 32.0],
              [-85.0, 32.0],
              [-85.0, 36.0],
              [-90.0, 36.0],
              [-90.0, 32.0],
            ],
          ],
          [
            [
              [-83.0, 33.0],
              [-78.0, 33.0],
              [-78.0, 37.0],
              [-83.0, 37.0],
              [-83.0, 33.0],
            ],
            [
              [-81.5, 34.2],
              [-79.5, 34.2],
              [-79.5, 35.8],
              [-81.5, 35.8],
              [-81.5, 34.2],
            ],
          ],
        ],
      },
    },
  ],
};

// One call parses the GeoJSON and builds the three buffer collections,
// sized exactly from the per-feature vertex/hole/triangle counts.
const loader = Cesium.GeoJsonPrimitive.fromGeoJson(featureCollection);
viewer.scene.primitives.add(loader);

// Colorize each loaded primitive from its source feature's "color"
// property. setMaterial copies the material into the packed buffer, so a
// reusable scratch primitive per collection is enough.
function colorize(collection, PrimitiveClass, MaterialClass) {
  if (!Cesium.defined(collection)) {
    return;
  }
  const scratch = new PrimitiveClass();
  for (let i = 0; i < collection.primitiveCount; i++) {
    const prim = collection.get(i, scratch);
    const props = loader.getProperties(prim.featureId);
    const css = (props && props.color) || "#ffffff";
    prim.setMaterial(
      new MaterialClass({
        color: Cesium.Color.fromCssColorString(css),
      }),
    );
  }
}
colorize(loader.points, Cesium.BufferPoint, Cesium.BufferPointMaterial);
colorize(
  loader.polylines,
  Cesium.BufferPolyline,
  Cesium.BufferPolylineMaterial,
);
colorize(loader.polygons, Cesium.BufferPolygon, Cesium.BufferPolygonMaterial);

const viewModel = {
  backend: viewer.scene._context?.rendererType ?? "unknown",
  featureCount: loader.featureCount,
  pointCount: Cesium.defined(loader.points) ? loader.points.primitiveCount : 0,
  polylineCount: Cesium.defined(loader.polylines)
    ? loader.polylines.primitiveCount
    : 0,
  polygonCount: Cesium.defined(loader.polygons)
    ? loader.polygons.primitiveCount
    : 0,
  holeCount: Cesium.defined(loader.polygons) ? loader.polygons.holeCount : 0,
};
Cesium.knockout.track(viewModel);
const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);

viewer.scene.skyAtmosphere.show = false;
viewer.camera.flyTo({
  destination: Cesium.Cartesian3.fromDegrees(-98, 38, 6500000),
  duration: 0,
});
