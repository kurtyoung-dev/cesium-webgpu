import * as Cesium from "cesium";

const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
  baseLayerPicker: false,
  geocoder: false,
  timeline: false,
  animation: false,
  // Suppress the default base layer so we can stack custom ones.
  baseLayer: false,
});

const imageryLayers = viewer.imageryLayers;
// Clear anything inherited.
imageryLayers.removeAll();

// Eight independent layers. All resolvable from local Assets/Textures
// bundled with CesiumJS or from network-accessible OSM-class providers.
// Mix of base + overlay + label + boundary stylings to mirror a real
// multi-layer config.
async function makeLayers() {
  const specs = [
    {
      name: "Natural Earth II (base)",
      alpha: 1.0,
      providerPromise: Cesium.TileMapServiceImageryProvider.fromUrl(
        Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII"),
      ),
    },
    {
      name: "OpenStreetMap (overlay)",
      alpha: 0.5,
      providerPromise: Promise.resolve(
        new Cesium.OpenStreetMapImageryProvider({
          url: "https://tile.openstreetmap.org/",
        }),
      ),
    },
    {
      name: "OSM Cyclosm (overlay)",
      alpha: 0.4,
      providerPromise: Promise.resolve(
        new Cesium.OpenStreetMapImageryProvider({
          url: "https://a.tile-cyclosm.openstreetmap.fr/cyclosm/",
        }),
      ),
    },
    {
      name: "OSM Humanitarian (overlay)",
      alpha: 0.4,
      providerPromise: Promise.resolve(
        new Cesium.OpenStreetMapImageryProvider({
          url: "https://a.tile.openstreetmap.fr/hot/",
        }),
      ),
    },
    {
      name: "OSM Transport (overlay)",
      alpha: 0.35,
      providerPromise: Promise.resolve(
        new Cesium.OpenStreetMapImageryProvider({
          url: "https://tile.openstreetmap.fr/openriverboatmap/",
        }),
      ),
    },
    {
      name: "OSM No-labels (overlay)",
      alpha: 0.35,
      providerPromise: Promise.resolve(
        new Cesium.OpenStreetMapImageryProvider({
          url: "https://tiles.stadiamaps.com/tiles/alidade_smooth/",
          fileExtension: "png",
        }),
      ),
    },
    {
      name: "Tile Coordinates (debug labels)",
      alpha: 0.6,
      providerPromise: Promise.resolve(
        new Cesium.TileCoordinatesImageryProvider(),
      ),
    },
    {
      name: "Grid (political-style boundary)",
      alpha: 0.6,
      providerPromise: Promise.resolve(new Cesium.GridImageryProvider()),
    },
  ];

  for (const spec of specs) {
    try {
      const provider = await spec.providerPromise;
      const layer = new Cesium.ImageryLayer(provider);
      layer.alpha = spec.alpha;
      layer.show = true;
      layer.name = spec.name;
      imageryLayers.add(layer);
    } catch (err) {
      console.warn(`Skipping layer "${spec.name}":`, err);
    }
  }
}

await makeLayers();

// Build the per-layer control panel. Each row gets show/alpha/hue/gamma
// bound to the layer's mutable properties. Hue is in radians (0-2π
// covers the full color wheel); gamma in the conventional 0.4-2.5 range.
const layerBody = document.getElementById("layerBody");
for (let i = 0; i < imageryLayers.length; i++) {
  const layer = imageryLayers.get(i);
  const tr = document.createElement("tr");

  const tdName = document.createElement("td");
  tdName.textContent = layer.name ?? `Layer ${i}`;
  tr.appendChild(tdName);

  const tdShow = document.createElement("td");
  const showInput = document.createElement("input");
  showInput.type = "checkbox";
  showInput.checked = !!layer.show;
  showInput.addEventListener("change", () => {
    layer.show = showInput.checked;
  });
  tdShow.appendChild(showInput);
  tr.appendChild(tdShow);

  tr.appendChild(makeRangeCell(layer, "alpha", 0.0, 1.0, 0.05));
  tr.appendChild(makeRangeCell(layer, "hue", -Math.PI, Math.PI, 0.1));
  tr.appendChild(makeRangeCell(layer, "gamma", 0.4, 2.5, 0.05));

  layerBody.appendChild(tr);
}

function makeRangeCell(layer, prop, min, max, step) {
  const td = document.createElement("td");
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  // Hue defaults to 0 for an unmodified appearance; gamma defaults to 1.
  input.value = String(layer[prop] ?? (prop === "gamma" ? 1.0 : 0.0));
  const label = document.createElement("span");
  label.textContent = ` ${Number(input.value).toFixed(2)}`;
  input.addEventListener("input", () => {
    const v = Number(input.value);
    layer[prop] = v;
    label.textContent = ` ${v.toFixed(2)}`;
  });
  td.appendChild(input);
  td.appendChild(label);
  return td;
}

// Fly to a recognisable view so the layer-mixing is obvious.
viewer.camera.flyTo({
  destination: Cesium.Cartesian3.fromDegrees(-95.0, 40.0, 8000000.0),
  duration: 0.0,
});
