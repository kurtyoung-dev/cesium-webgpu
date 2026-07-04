import * as Cesium from "cesium";

// WebGPU post-process library showcase (Batch 486 + 511).
//
// Cycles the seven PostProcessStageLibrary builtins that run natively on the
// WebGPU backend via their WGSL twins: BlackAndWhite, Brightness, NightVision,
// Silhouette, EdgeDetection, LensFlare, and DepthView. Stage order matches
// WebGL: user/library stages execute AFTER tonemapping. The scene stays SDR
// (highDynamicRange off, the default) so the two backends are parity-clean.
//
// LensFlare is special-cased: WebGL's flare is a pass-through unless the
// camera is in space (altitude above ~6 500 km) with the sun on screen, so
// selecting it jumps to a fixed space view aimed just off the sun.

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

// ── model view (all effects except LensFlare) ─────────────────────────────
const modelPosition = Cesium.Cartesian3.fromDegrees(-123.0744619, 44.0503706);
const modelEntity = viewer.entities.add({
  name: "Cesium Man",
  position: modelPosition,
  model: {
    uri: "../../SampleData/models/CesiumMan/Cesium_Man.glb",
  },
});

function goModelView() {
  viewer.clock.shouldAnimate = true;
  viewer.trackedEntity = modelEntity;
}

// ── space view (LensFlare) ────────────────────────────────────────────────
// Fixed time + camera: at 08:00 UTC on Jun 21 the subsolar point is ~60E;
// from (130E, 0N, ~2 earth radii) the sun sits well on screen while the
// earth's centre stays sanely in front of the camera (the flare's isInEarth
// ghost mask degenerates for overhead views). Aim ~15 deg OFF the sun — the
// flare weight is length(sunNDC), so looking dead-on gives zero flare.
const FLARE_TIME = Cesium.JulianDate.fromIso8601("2026-06-21T08:00:00Z");

function sunPositionWC(time) {
  const sunICRF =
    Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
      time,
      new Cesium.Cartesian3(),
    );
  const icrfToFixed =
    Cesium.Transforms.computeIcrfToFixedMatrix(time, new Cesium.Matrix3()) ??
    Cesium.Transforms.computeTemeToPseudoFixedMatrix(
      time,
      new Cesium.Matrix3(),
    );
  return Cesium.Matrix3.multiplyByVector(
    icrfToFixed,
    sunICRF,
    new Cesium.Cartesian3(),
  );
}

function goSpaceView() {
  viewer.trackedEntity = undefined;
  viewer.clock.currentTime = FLARE_TIME.clone();
  viewer.clock.shouldAnimate = false;

  const camPos = Cesium.Cartesian3.fromDegrees(130.0, 0.0, 12756000.0);
  const sunWC = sunPositionWC(FLARE_TIME);
  const dir = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(sunWC, camPos, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  let right = Cesium.Cartesian3.cross(
    dir,
    Cesium.Cartesian3.normalize(camPos, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  if (Cesium.Cartesian3.magnitude(right) < 1e-6) {
    right = Cesium.Cartesian3.cross(dir, Cesium.Cartesian3.UNIT_Z, right);
  }
  Cesium.Cartesian3.normalize(right, right);
  const aim = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.add(
      dir,
      Cesium.Cartesian3.multiplyByScalar(right, 0.27, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  );
  const up = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(right, aim, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  viewer.camera.setView({
    destination: camPos,
    orientation: { direction: aim, up: up },
  });
}

// ── the seven library builtins ────────────────────────────────────────────
// Stage factories, not instances: PostProcessStageCollection.remove()
// destroys the stage, and both silhouette-based entries share the fixed
// composite name "czm_silhouette" so only one can be in the collection at a
// time. The active stage is created on selection and removed on deselection.
const lib = Cesium.PostProcessStageLibrary;
const stages = scene.postProcessStages;

const effects = [
  {
    name: "Black and White",
    desc: "Luminance posterized to 5 gradations.",
    create: () => {
      const stage = lib.createBlackAndWhiteStage();
      stage.uniforms.gradations = 5.0;
      return stage;
    },
  },
  {
    name: "Brightness",
    desc: "Frame scaled toward 50% brightness.",
    create: () => {
      const stage = lib.createBrightnessStage();
      stage.uniforms.brightness = 0.5;
      return stage;
    },
  },
  {
    name: "Night Vision",
    desc: "Green channel + frame-seeded animated noise.",
    create: () => lib.createNightVisionStage(),
  },
  {
    name: "Silhouette",
    desc: "Yellow depth-edge outline composited over the scene.",
    supported: () => lib.isSilhouetteSupported(scene),
    create: () => {
      const stage = lib.createSilhouetteStage();
      stage.uniforms.color = Cesium.Color.YELLOW;
      return stage;
    },
  },
  {
    name: "Edge Detection",
    desc: "Depth-Sobel edge stage composited over the scene (black edges).",
    supported: () => lib.isEdgeDetectionSupported(scene),
    create: () => {
      // Standalone edge detection outputs a MASK (rgb = color, alpha =
      // edge strength) — meaningless to display raw. Use the documented
      // pattern: an edge stage composited via createSilhouetteStage.
      // Default (black) edge color: the WGSL silhouette twin reads
      // uniforms off the top-level composite, which the array form does
      // not proxy — custom colors on inner edge stages are a known
      // WebGPU gap (see DEFERRED_WORK), so the demo stays on the
      // parity-clean default.
      return lib.createSilhouetteStage([lib.createEdgeDetectionStage()]);
    },
  },
  {
    name: "Lens Flare",
    desc: "Ghost chain + halo, sun on screen (space view).",
    view: goSpaceView,
    create: () => {
      const stage = lib.createLensFlareStage();
      stage.uniforms.intensity = 2.0;
      return stage;
    },
  },
  {
    name: "Depth View",
    desc: "Raw depth buffer as grayscale.",
    create: () => lib.createDepthViewStage(),
  },
];

const descEl = document.createElement("div");
descEl.className = "hint";

let activeStage;
function selectEffect(index) {
  if (Cesium.defined(activeStage)) {
    stages.remove(activeStage);
    activeStage = undefined;
  }
  const active = index >= 0 ? effects[index] : undefined;
  if (!Cesium.defined(active)) {
    goModelView();
    descEl.textContent =
      "No post-process stage in the collection — this frame is " +
      "byte-identical to a no-post-process frame.";
    scene.requestRender();
    return;
  }
  if (Cesium.defined(active.supported) && !active.supported()) {
    goModelView();
    descEl.textContent = `${active.name} is not supported in this browser.`;
    scene.requestRender();
    return;
  }
  activeStage = stages.add(active.create());
  if (Cesium.defined(active.view)) {
    active.view();
  } else {
    goModelView();
  }
  descEl.textContent = active.desc;
  scene.requestRender();
}

// ── control panel (plain DOM so it works without the Sandcastle UI) ───────
const panel = document.getElementById("ppPanel");
const select = document.createElement("select");
const noneOption = document.createElement("option");
noneOption.value = "-1";
noneOption.textContent = "None (off — parity baseline)";
select.appendChild(noneOption);
effects.forEach((effect, i) => {
  const option = document.createElement("option");
  option.value = String(i);
  option.textContent = effect.name;
  select.appendChild(option);
});
select.addEventListener("change", () => selectEffect(Number(select.value)));
panel.appendChild(select);

const nextButton = document.createElement("button");
nextButton.type = "button";
nextButton.textContent = "Next effect";
nextButton.addEventListener("click", () => {
  const next = Number(select.value) + 1;
  select.value = String(next >= effects.length ? -1 : next);
  selectEffect(Number(select.value));
});
panel.appendChild(nextButton);

panel.appendChild(descEl);

goModelView();
selectEffect(-1);
