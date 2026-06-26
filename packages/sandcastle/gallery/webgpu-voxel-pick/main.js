import * as Cesium from "cesium";

const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
  baseLayer: Cesium.ImageryLayer.fromProviderAsync(
    Cesium.TileMapServiceImageryProvider.fromUrl(
      Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII"),
    ),
  ),
  baseLayerPicker: false,
  geocoder: false,
  timeline: false,
  animation: false,
});

const { scene, camera } = viewer;
const pickResultEl = document.getElementById("pickResult");

// Procedural voxel provider — same shape as the existing "Voxel Picking"
// gallery demo so the test asset path is shared. Box volume rooted at
// the WGS84 Earth scale to give a clear pick target.
const globalTransform = Cesium.Matrix4.fromScale(
  Cesium.Cartesian3.fromElements(
    Cesium.Ellipsoid.WGS84.maximumRadius,
    Cesium.Ellipsoid.WGS84.maximumRadius,
    Cesium.Ellipsoid.WGS84.maximumRadius,
  ),
);

function ProceduralBoxProvider() {
  this.shape = Cesium.VoxelShapeType.BOX;
  this.dimensions = new Cesium.Cartesian3(4, 4, 4);
  this.minBounds = Cesium.VoxelShapeType.getMinBounds(
    Cesium.VoxelShapeType.BOX,
  ).clone();
  this.maxBounds = Cesium.VoxelShapeType.getMaxBounds(
    Cesium.VoxelShapeType.BOX,
  ).clone();
  this.names = ["color"];
  this.types = [Cesium.MetadataType.VEC4];
  this.componentTypes = [Cesium.MetadataComponentType.FLOAT32];
  this.availableLevels = 1;
  this.globalTransform = globalTransform;
}

const scratchColor = new Cesium.Color();
ProceduralBoxProvider.prototype.requestData = function (options) {
  const { tileLevel, tileX, tileY, tileZ } = options;
  if (tileLevel >= this.availableLevels) {
    return Promise.reject(
      `No tiles available beyond level ${this.availableLevels - 1}`,
    );
  }
  const dimensions = this.dimensions;
  const channelCount = Cesium.MetadataType.getComponentCount(this.types[0]);
  const voxelCount = dimensions.x * dimensions.y * dimensions.z;
  const data = new Float32Array(voxelCount * channelCount);
  const seed =
    tileZ * dimensions.y * dimensions.x + tileY * dimensions.x + tileX;
  Cesium.Math.setRandomNumberSeed(seed);
  for (let i = 0; i < voxelCount; i++) {
    const h = Cesium.Math.nextRandomNumber();
    const color = Cesium.Color.fromHsl(h, 0.85, 0.5, 1.0, scratchColor);
    const idx = i * channelCount;
    data[idx + 0] = color.red;
    data[idx + 1] = color.green;
    data[idx + 2] = color.blue;
    data[idx + 3] = 1.0;
  }
  return Promise.resolve(Cesium.VoxelContent.fromMetadataArray([data]));
};

const voxelPrimitive = new Cesium.VoxelPrimitive({
  provider: new ProceduralBoxProvider(),
});
voxelPrimitive.nearestSampling = true;
voxelPrimitive.stepSize = 0.7;
scene.primitives.add(voxelPrimitive);

camera.flyToBoundingSphere(voxelPrimitive.boundingSphere, {
  duration: 0.0,
});

const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
handler.setInputAction((movement) => {
  const picked = scene.pick(movement.position);
  if (!Cesium.defined(picked)) {
    pickResultEl.textContent = "(no primitive at cursor)";
    return;
  }

  const primitive = picked.primitive;
  const isVoxel = primitive instanceof Cesium.VoxelPrimitive;
  pickResultEl.innerHTML = [
    `<span class="label">primitive:</span> ${
      isVoxel ? "VoxelPrimitive" : primitive?.constructor?.name
    }`,
    `<span class="label">id:</span> ${picked.id ?? "(no id payload)"}`,
    isVoxel
      ? `<span class="label">match:</span> YES (Batch 53 fragmentPickMain)`
      : `<span class="label">match:</span> not the voxel`,
  ].join("<br>");
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
