import * as Cesium from "cesium";

// WebGPU structural-metadata pick demo (DP-H46 epic closeout).
//
// Loads a glTF with EXT_structural_metadata PROPERTY TEXTURES on the WebGPU
// backend. The model's in-shader metadata read (DP-H46 a–d) generates a WGSL
// `struct Metadata` + `initializeMetadata` per primitive; clicking the surface
// runs `scene.pickMetadata` (DP-H46e — the WebGPU producer) which renders a
// metadata-pick pass, reads back the RGBA8, and un-applies the offset/scale +
// normalization to recover the decoded value — matching WebGL byte-exact for
// normalized UINT8 scalars (here `insulation`) and in-range for the
// non-normalized UINT8 scalars (`insideTemperature`, `outsideTemperature`).
//
// Scope note: `scene.pickMetadata` resolves PROPERTY TEXTURES only on both
// backends (upstream `Scene/getMetadataProperty.js` — Cesium #12225); this
// asset is a property-texture class, so the producer fires end-to-end.

const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
  shouldAnimate: true,
  shadows: false,
  terrain: undefined,
  baseLayerPicker: false,
  geocoder: false,
  timeline: false,
  animation: false,
  infoBox: false,
  selectionIndicator: false,
});

const scene = viewer.scene;
const resultEl = document.getElementById("metaResult");

const CLASS_NAME = "buildingComponents";
const PROPERTIES = ["insideTemperature", "outsideTemperature", "insulation"];

// Place the textured plane upright at a fixed location and frame it so its
// individual metadata texels are large enough to click.
const modelPosition = Cesium.Cartesian3.fromDegrees(-75.0, 40.0, 120.0);
const hpr = new Cesium.HeadingPitchRoll(
  Cesium.Math.toRadians(180.0),
  Cesium.Math.toRadians(0.0),
  Cesium.Math.toRadians(90.0),
);
const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(
  modelPosition,
  hpr,
);
Cesium.Matrix4.multiplyByUniformScale(modelMatrix, 80.0, modelMatrix);

const model = scene.primitives.add(
  await Cesium.Model.fromGltfAsync({
    url: "../../SampleData/models/SimplePropertyTexture/SimplePropertyTexture.gltf",
    modelMatrix: modelMatrix,
  }),
);

model.readyEvent.addEventListener(() => {
  const bs = model.boundingSphere;
  viewer.camera.flyToBoundingSphere(bs, {
    duration: 1.2,
    offset: new Cesium.HeadingPitchRange(
      0.0,
      Cesium.Math.toRadians(-25.0),
      bs.radius * 4.0,
    ),
  });
});

document.getElementById("loadingOverlay")?.remove();

// On WebGPU the metadata-pick readback is one-frame-stale and converges over a
// few frames; poll until a defined value comes back (or give up after N frames).
function pickMetadataConverged(windowPosition, propertyName, maxFrames = 16) {
  return new Promise((resolve) => {
    let frames = 0;
    let last;
    function tick() {
      last = scene.pickMetadata(
        windowPosition,
        undefined,
        CLASS_NAME,
        propertyName,
      );
      frames += 1;
      if ((Cesium.defined(last) && last !== null) || frames >= maxFrames) {
        resolve(last);
        return;
      }
      requestAnimationFrame(tick);
    }
    tick();
  });
}

function fmt(value) {
  if (!Cesium.defined(value) || value === null) {
    return "(none)";
  }
  const n = typeof value === "bigint" ? Number(value) : value;
  if (typeof n === "number") {
    return Number.isInteger(n) ? String(n) : n.toFixed(4);
  }
  return String(value);
}

const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
handler.setInputAction(async (movement) => {
  const windowPosition = movement.position;

  // Bail early if the click missed the model entirely.
  const picked = scene.pick(windowPosition);
  if (!Cesium.defined(picked) || !(picked.primitive instanceof Cesium.Model)) {
    resultEl.className = "hint";
    resultEl.textContent = "(clicked off the model — try the textured plane)";
    return;
  }

  resultEl.className = "hint";
  resultEl.textContent = "reading metadata…";

  const decoded = {};
  for (const propertyName of PROPERTIES) {
    decoded[propertyName] = await pickMetadataConverged(
      windowPosition,
      propertyName,
    );
  }

  resultEl.className = "";
  resultEl.innerHTML = PROPERTIES.map(
    (p) =>
      `<span class="label">${p}:</span> <span class="val">${fmt(decoded[p])}</span>`,
  ).join("<br>");
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
