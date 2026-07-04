import * as Cesium from "cesium";
import Sandcastle from "Sandcastle";

// WebGPU model appearance showcase (Batches 483-485).
//
// Drives the three model-appearance features wired for the WebGPU backend,
// each at parity with its WebGL pipeline stage and byte-identical when off:
//
//   - model.color + colorBlendMode + colorBlendAmount (Batch 484 —
//     ModelColorStageFS math in ModelPBRComplete.wgsl, MODEL_HAS_COLOR),
//   - model.silhouetteColor + silhouetteSize (Batch 485 — the WebGL stencil
//     two-pass rim, MODEL_SILHOUETTE + ModelSilhouetteStage.wgsl),
//   - model.splitDirection + scene.splitPosition (Batch 483 —
//     ModelSplitterStageFS discard, MODEL_SPLIT_ENABLED).
//
// Every control writes the public Model API only — no WebGPU-specific code.

const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
  shouldAnimate: true,
  baseLayerPicker: false,
  geocoder: false,
  timeline: false,
  animation: false,
  infoBox: false,
  selectionIndicator: false,
});
const scene = viewer.scene;
window.viewer = viewer; // expose for console tinkering

const position = Cesium.Cartesian3.fromDegrees(-123.0744619, 44.0503706, 0.0);
const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(position);
const model = scene.primitives.add(
  await Cesium.Model.fromGltfAsync({
    url: "../../SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
    modelMatrix: modelMatrix,
    scale: 4.0,
  }),
);

model.readyEvent.addEventListener(() => {
  viewer.camera.flyToBoundingSphere(model.boundingSphere, {
    duration: 1.0,
    offset: new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(35.0),
      Cesium.Math.toRadians(-18.0),
      model.boundingSphere.radius * 3.2,
    ),
  });
});

document.getElementById("loadingOverlay")?.remove();

const stateHint = document.getElementById("stateHint");
const splitLine = document.getElementById("splitLine");

function updateHint() {
  const parts = [];
  if (Cesium.defined(model.color)) {
    const mode = Object.keys(Cesium.ColorBlendMode).find(
      (k) => Cesium.ColorBlendMode[k] === model.colorBlendMode,
    );
    parts.push(`color ${mode} @ ${model.colorBlendAmount.toFixed(2)}`);
  }
  if (model.silhouetteSize > 0.0) {
    parts.push(`silhouette ${model.silhouetteSize.toFixed(1)}px`);
  }
  if (model.splitDirection !== Cesium.SplitDirection.NONE) {
    const dir =
      model.splitDirection === Cesium.SplitDirection.LEFT ? "LEFT" : "RIGHT";
    parts.push(`split ${dir} @ ${scene.splitPosition.toFixed(2)}`);
  }
  stateHint.textContent =
    parts.length > 0
      ? parts.join(" + ")
      : "(defaults — all three features off)";
}

// ── model.color / colorBlendMode / colorBlendAmount (Batch 484) ───────────
const blendAmountSlider = document.getElementById("blendAmount");
const blendAmountValue = document.getElementById("blendAmountValue");

function applyColor(color, blendMode) {
  model.color = color;
  if (Cesium.defined(blendMode)) {
    model.colorBlendMode = blendMode;
  }
  model.colorBlendAmount = Number(blendAmountSlider.value);
  updateHint();
}

Sandcastle.addToolbarMenu([
  {
    text: "Color: none (default)",
    onselect: () => applyColor(undefined),
  },
  {
    text: "Color: red HIGHLIGHT",
    onselect: () =>
      applyColor(Cesium.Color.RED, Cesium.ColorBlendMode.HIGHLIGHT),
  },
  {
    text: "Color: red REPLACE",
    onselect: () => applyColor(Cesium.Color.RED, Cesium.ColorBlendMode.REPLACE),
  },
  {
    text: "Color: red MIX",
    onselect: () => applyColor(Cesium.Color.RED, Cesium.ColorBlendMode.MIX),
  },
  {
    text: "Color: cyan MIX",
    onselect: () => applyColor(Cesium.Color.CYAN, Cesium.ColorBlendMode.MIX),
  },
]);

blendAmountSlider.addEventListener("input", () => {
  blendAmountValue.textContent = Number(blendAmountSlider.value).toFixed(2);
  if (Cesium.defined(model.color)) {
    model.colorBlendAmount = Number(blendAmountSlider.value);
    updateHint();
  }
});

// ── model.silhouetteColor / silhouetteSize (Batch 485) ────────────────────
const silhouetteSizeSlider = document.getElementById("silhouetteSize");
const silhouetteSizeValue = document.getElementById("silhouetteSizeValue");
let silhouetteOn = false;

function applySilhouette() {
  model.silhouetteSize = silhouetteOn
    ? Number(silhouetteSizeSlider.value)
    : 0.0;
  updateHint();
}

Sandcastle.addToolbarMenu([
  {
    text: "Silhouette: off (default)",
    onselect: () => {
      silhouetteOn = false;
      applySilhouette();
    },
  },
  {
    text: "Silhouette: lime",
    onselect: () => {
      silhouetteOn = true;
      model.silhouetteColor = Cesium.Color.LIME;
      applySilhouette();
    },
  },
  {
    text: "Silhouette: magenta",
    onselect: () => {
      silhouetteOn = true;
      model.silhouetteColor = Cesium.Color.MAGENTA;
      applySilhouette();
    },
  },
]);

silhouetteSizeSlider.addEventListener("input", () => {
  silhouetteSizeValue.textContent = Number(silhouetteSizeSlider.value).toFixed(
    1,
  );
  if (silhouetteOn) {
    applySilhouette();
  }
});

// ── model.splitDirection + scene.splitPosition (Batch 483) ────────────────
const splitPositionSlider = document.getElementById("splitPosition");
const splitPositionValue = document.getElementById("splitPositionValue");

function updateSplitLine() {
  const active = model.splitDirection !== Cesium.SplitDirection.NONE;
  splitLine.style.display = active ? "block" : "none";
  splitLine.style.left = `${scene.splitPosition * 100.0}%`;
}

function applySplit(direction) {
  model.splitDirection = direction;
  scene.splitPosition = Number(splitPositionSlider.value);
  updateSplitLine();
  updateHint();
}

Sandcastle.addToolbarMenu([
  {
    text: "Split: none (default)",
    onselect: () => applySplit(Cesium.SplitDirection.NONE),
  },
  {
    text: "Split: LEFT of slider",
    onselect: () => applySplit(Cesium.SplitDirection.LEFT),
  },
  {
    text: "Split: RIGHT of slider",
    onselect: () => applySplit(Cesium.SplitDirection.RIGHT),
  },
]);

splitPositionSlider.addEventListener("input", () => {
  splitPositionValue.textContent = Number(splitPositionSlider.value).toFixed(2);
  scene.splitPosition = Number(splitPositionSlider.value);
  updateSplitLine();
  updateHint();
});

updateHint();
