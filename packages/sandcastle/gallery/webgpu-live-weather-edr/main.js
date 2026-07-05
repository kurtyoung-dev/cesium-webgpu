import * as Cesium from "cesium";

// Procedural clouds + the weather-ingest layer are WebGPU-only.
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
});
const scene = viewer.scene;
const globe = scene.globe;
window.viewer = viewer; // expose for console tinkering

globe.defaultCloudCollection.enableVolumetric = true;
globe.defaultCloudCollection.volumetric.cloudCoverage = 0.5; // weatherStrength 1.0 → effectiveCoverage = map R
globe.defaultCloudCollection.volumetric.cloudDensity = 0.4;
scene.skyAtmosphere.show = true;

// ── Live weather: NOAA GFS total cloud cover via OGC API-EDR ──────────
// Routed through the dev server's same-origin /proxy (CORS-safe).
const source = new Cesium.EdrWeatherSource({
  proxy: "/proxy?url=",
  // collection / parameterName default to NOAA GFS / TCDC; override here
  // once the live /collections list confirms the exact ids.
});
const provider = new Cesium.WeatherProvider(source);
globe.defaultCloudCollection.volumetric.weatherProvider = provider;

// High view over North America so a continental cloud field reads.
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-95.0, 38.0, 9.0e6),
});

// ── status panel (plain DOM) ─────────────────────────────────────────
const panel = document.getElementById("wxPanel");
const heading = document.createElement("h2");
heading.textContent = "Live Weather (EDR)";
panel.appendChild(heading);

const status = document.createElement("div");
status.className = "status";
panel.appendChild(status);

const refreshBtn = document.createElement("button");
refreshBtn.textContent = "Refresh feed";
refreshBtn.addEventListener("click", () => {
  provider.refresh();
  scene.requestRender();
});
panel.appendChild(refreshBtn);

const hint = document.createElement("div");
hint.className = "hint";
hint.textContent =
  "Pulls NOAA GFS cloud cover (OGC API-EDR / CoverageJSON) and bakes it " +
  "into the cloud deck. If the feed is blocked, the procedural map is " +
  "used and the error shows above.";
panel.appendChild(hint);

// The source's first fetch is kicked by the renderer reading the
// provider; poll the provider's state for the panel.
function renderStatus() {
  const src = provider.getSource();
  const cap = src && src.getCapabilities ? src.getCapabilities() : null;
  const label = cap ? cap.label : "feed";
  let html;
  if (provider.hasData) {
    const valid = provider.validTime ? `<br/>valid: ${provider.validTime}` : "";
    html = `<span class="ok">● LIVE</span> — ${label}${valid}`;
  } else if (provider.lastError) {
    html = `<span class="err">● feed unavailable</span><br/>${provider.lastError}<br/><span class="warn">showing procedural map</span>`;
  } else {
    html = `<span class="warn">● connecting…</span> ${label}`;
  }
  status.innerHTML = html;
}
renderStatus();
setInterval(renderStatus, 1000);
