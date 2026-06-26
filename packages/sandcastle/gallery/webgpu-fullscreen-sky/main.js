import * as Cesium from "cesium";

// Fullscreen sky + procedural clouds are WebGPU-only, so pin the backend.
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
});
const scene = viewer.scene;
const globe = scene.globe;
window.viewer = viewer; // expose for console tinkering

scene.skyAtmosphere.show = true;
scene.skyBox.show = true;

// Enable dynamic atmosphere lighting so the sky does a real day/night
// cycle — without it the atmosphere is a static "always lit from above"
// dome (bright at any hour) and the stars never show.
globe.enableLighting = true;
globe.dynamicAtmosphereLighting = true;
if (scene.atmosphere) {
  scene.atmosphere.dynamicLighting =
    Cesium.DynamicAtmosphereLightingType.SUNLIGHT;
}

// Start with the FULLSCREEN sky path on (the subject of this demo).
scene.skyAtmosphere._webgpuFullscreen = true;

// Near-ground oblique view over the central US so the sky fills the
// upper frame and the day/night transition reads clearly.
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-95.0, 39.0, 1800.0),
  orientation: {
    heading: Cesium.Math.toRadians(90.0),
    pitch: Cesium.Math.toRadians(10.0),
    roll: 0.0,
  },
});

function setHourUtc(hour) {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  const iso = `2026-06-21T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
  const t = Cesium.JulianDate.fromIso8601(iso);
  viewer.clock.currentTime = t.clone();
  viewer.clock.shouldAnimate = false;
  scene.requestRender();
}

// ── control panel (plain DOM so it works without the Sandcastle UI) ──
const panel = document.getElementById("skyPanel");
const heading = document.createElement("h2");
heading.textContent = "WebGPU Sky";
panel.appendChild(heading);

function addToggle(labelText, initial, onChange) {
  const row = document.createElement("div");
  row.className = "row";
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = initial;
  input.addEventListener("change", () => {
    onChange(input.checked);
    scene.requestRender();
  });
  row.appendChild(label);
  row.appendChild(input);
  panel.appendChild(row);
  return input;
}

function addSlider(labelText, min, max, step, initial, onInput) {
  const row = document.createElement("div");
  row.className = "row";
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = "range";
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = initial;
  const val = document.createElement("span");
  val.className = "val";
  val.textContent = Number(initial).toFixed(2);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    val.textContent = v.toFixed(2);
    onInput(v);
    scene.requestRender();
  });
  row.appendChild(label);
  row.appendChild(input);
  row.appendChild(val);
  panel.appendChild(row);
  return input;
}

addToggle("Fullscreen sky path", true, (on) => {
  scene.skyAtmosphere._webgpuFullscreen = on;
});
addSlider("Time of day (UTC h)", 0, 24, 0.25, 18, (h) => setHourUtc(h));
addToggle("Procedural clouds", false, (on) => {
  globe.showProceduralClouds = on;
  if (on) {
    globe.cloudCoverage = 0.45;
    globe.cloudDensity = 0.3;
  }
});

const hint = document.createElement("div");
hint.className = "hint";
hint.textContent =
  "Toggle the fullscreen vs shell sky path — they match. " +
  "Slide to ~6 (UTC) for local night: the sky darkens and the stars " +
  "show through.";
panel.appendChild(hint);

setHourUtc(18);
