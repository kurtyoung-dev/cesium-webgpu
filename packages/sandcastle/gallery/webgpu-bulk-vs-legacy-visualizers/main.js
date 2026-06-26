import * as Cesium from "cesium";
import Sandcastle from "Sandcastle";

const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
  shouldAnimate: true,
  baseLayerPicker: false,
  geocoder: false,
  timeline: false,
  animation: false,
});
const scene = viewer.scene;

// Spread region (a ~8° x 6° patch over the central US).
const CENTER_LON = -98.0;
const CENTER_LAT = 39.0;
const SPAN_LON = 8.0;
const SPAN_LAT = 6.0;

viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(
    CENTER_LON,
    CENTER_LAT - 1.0,
    2_400_000,
  ),
});

// A small colored dot for the billboard object type (avoids a network
// fetch so the setup timing reflects the visualizer, not image loading).
const DOT_IMAGE = (function () {
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffd60a";
  ctx.beginPath();
  ctx.arc(8, 8, 6, 0, Math.PI * 2);
  ctx.fill();
  return c.toDataURL();
})();

// ── Configuration state (driven by the toolbar menus). ──
const config = {
  type: "point", // point | billboard | label
  count: 2500, // 100 | 2500 | 20000
  dynamic: false, // false = static (constant), true = moving
  lifetimeMs: Infinity, // 1000 | 8000 | Infinity
  mode: "bulk", // bulk | legacy
};

// ── Live state for the dedicated display we measure. ──
let dataSources; // DataSourceCollection
let display; // DataSourceDisplay (with the chosen visualizersCallback)
let dataSource; // the current CustomDataSource
let baseCart = []; // precomputed base positions (reused by dynamic callbacks)
let lifetimeTimer;
let rebuildToken = 0; // guards async rebuilds against rapid menu changes
let busy = false;

// ── Metrics ──
let animTime = 0; // shared clock for the cheap dynamic callbacks
const FRAME_WINDOW = 30;
const frameTimes = [];
let setupMs = 0;
let fps = 0;
let fpsFrames = 0;
let fpsLast = performance.now();

function visualizersCallback() {
  return config.mode === "legacy"
    ? Cesium.DataSourceDisplay.legacyVisualizersCallback
    : Cesium.DataSourceDisplay.defaultVisualizersCallback;
}

// Deterministic grid of base positions over the patch.
function computeBasePositions(n) {
  baseCart = new Array(n);
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const lon =
      CENTER_LON - SPAN_LON / 2 + SPAN_LON * (c / Math.max(cols - 1, 1));
    const lat =
      CENTER_LAT - SPAN_LAT / 2 + SPAN_LAT * (r / Math.max(rows - 1, 1));
    baseCart[i] = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
  }
}

function colorFor(i) {
  return Cesium.Color.fromHsl((i % 360) / 360, 0.65, 0.55);
}

// Build the per-entity position property. Static → the constant base
// Cartesian (bulk static lane). Dynamic → a cheap CallbackProperty that
// jitters around the base (forces the per-frame fallback lane).
function positionFor(i) {
  if (!config.dynamic) {
    return baseCart[i];
  }
  const base = baseCart[i];
  const phase = i * 0.7;
  return new Cesium.CallbackProperty((time, result) => {
    const a = animTime + phase;
    return Cesium.Cartesian3.fromElements(
      base.x + Math.cos(a) * 4000.0,
      base.y + Math.sin(a) * 4000.0,
      base.z,
      result,
    );
  }, false);
}

function populate(ds) {
  const entities = ds.entities;
  entities.suspendEvents();
  const n = config.count;
  for (let i = 0; i < n; i++) {
    const entity = {
      id: `e${i}`,
      position: positionFor(i),
    };
    if (config.type === "point") {
      entity.point = {
        pixelSize: 6,
        color: colorFor(i),
      };
    } else if (config.type === "billboard") {
      entity.billboard = {
        image: DOT_IMAGE,
        scale: 0.7,
      };
    } else {
      entity.label = {
        text: "•",
        font: "18px sans-serif",
        fillColor: colorFor(i),
      };
    }
    entities.add(entity);
  }
  entities.resumeEvents();
}

// The active bulk visualizer (if any) exposes staticCount/fallbackCount.
function laneSplit() {
  const vs = (dataSource && dataSource._visualizers) || [];
  let s = 0;
  let f = 0;
  let found = false;
  for (const v of vs) {
    if (typeof v.staticCount === "number") {
      s += v.staticCount;
      f += v.fallbackCount;
      found = true;
    }
  }
  return found ? { static: s, fallback: f } : undefined;
}

function teardown() {
  stopLifetimeTimer();
  if (display && !display.isDestroyed()) {
    display.destroy();
  }
  if (dataSources && !dataSources.isDestroyed()) {
    dataSources.destroy();
  }
  display = undefined;
  dataSources = undefined;
  dataSource = undefined;
}

// Create (or recreate) the data source + measure its setup cost. The
// setup window spans populate + add (which triggers visualizer creation:
// the bulk static-lane classification + lazy collection alloc + writes,
// or the legacy per-frame seeding) + the first update().
async function createSource(token) {
  const t0 = performance.now();
  const ds = new Cesium.CustomDataSource("perf");
  populate(ds);
  await dataSources.add(ds);
  if (token !== rebuildToken) {
    // Superseded by a newer rebuild — drop this one.
    if (!ds.isDestroyed?.()) {
      dataSources.remove(ds, true);
    }
    return;
  }
  dataSource = ds;
  display.update(viewer.clock.currentTime);
  setupMs = performance.now() - t0;
}

async function rebuild() {
  const token = ++rebuildToken;
  busy = true;
  teardown();
  computeBasePositions(config.count);
  dataSources = new Cesium.DataSourceCollection();
  display = new Cesium.DataSourceDisplay({
    scene: scene,
    dataSourceCollection: dataSources,
    visualizersCallback: visualizersCallback(),
  });
  frameTimes.length = 0;
  await createSource(token);
  if (token !== rebuildToken) {
    return;
  }
  startLifetimeTimer();
  busy = false;
}

// Lifetime: periodically destroy + recreate just the data source (the
// display + collection persist) to simulate short-lived "flash" sources.
function startLifetimeTimer() {
  if (config.lifetimeMs === Infinity) {
    return;
  }
  const token = rebuildToken;
  lifetimeTimer = setInterval(async () => {
    if (busy || token !== rebuildToken) {
      return;
    }
    busy = true;
    if (dataSource && dataSources && !dataSources.isDestroyed()) {
      dataSources.remove(dataSource, true);
      dataSource = undefined;
    }
    await createSource(token);
    busy = false;
  }, config.lifetimeMs);
}

function stopLifetimeTimer() {
  if (lifetimeTimer) {
    clearInterval(lifetimeTimer);
    lifetimeTimer = undefined;
  }
}

// ── Per-frame: drive + time the dedicated display, then refresh the HUD. ──
const metricsEl = document.getElementById("metrics");
scene.preUpdate.addEventListener(() => {
  animTime = performance.now() * 0.001;
  if (display && !display.isDestroyed() && !busy) {
    const t0 = performance.now();
    display.update(viewer.clock.currentTime);
    const dt = performance.now() - t0;
    frameTimes.push(dt);
    if (frameTimes.length > FRAME_WINDOW) {
      frameTimes.shift();
    }
  }

  fpsFrames++;
  const now = performance.now();
  if (now - fpsLast >= 500) {
    fps = Math.round((fpsFrames * 1000) / (now - fpsLast));
    fpsFrames = 0;
    fpsLast = now;
  }
  renderMetrics();
});

function avg(arr) {
  if (arr.length === 0) {
    return 0;
  }
  let s = 0;
  for (const x of arr) {
    s += x;
  }
  return s / arr.length;
}

const COUNT_LABEL = { 100: "small", 2500: "medium", 20000: "large" };
const LIFE_LABEL = {
  1000: "short (1 s)",
  8000: "medium (8 s)",
  [Infinity]: "long (∞)",
};

function renderMetrics() {
  const perFrame = avg(frameTimes);
  const lanes = laneSplit();
  const modeClass = config.mode === "bulk" ? "mode-bulk" : "mode-legacy";
  const laneStr = lanes
    ? `${lanes.static} static / ${lanes.fallback} dynamic`
    : "n/a (legacy: all per-frame)";
  window.__bulkLegacyMetrics = {
    mode: config.mode,
    type: config.type,
    count: config.count,
    dynamic: config.dynamic,
    lifetimeMs: config.lifetimeMs,
    perFrameMs: perFrame,
    setupMs: setupMs,
    staticLane: lanes ? lanes.static : -1,
    fallbackLane: lanes ? lanes.fallback : -1,
    fps: fps,
  };
  metricsEl.innerHTML =
    `<div class="hdr">Bulk vs Legacy Visualizers</div>` +
    `<div class="row"><span class="k">visualizer</span><span class="v ${modeClass}">${config.mode.toUpperCase()}</span></div>` +
    `<div class="row"><span class="k">object type</span><span class="v">${config.type}</span></div>` +
    `<div class="row"><span class="k">count</span><span class="v">${config.count.toLocaleString()} (${COUNT_LABEL[config.count] || "?"})</span></div>` +
    `<div class="row"><span class="k">lane</span><span class="v">${config.dynamic ? "dynamic" : "static"}</span></div>` +
    `<div class="row"><span class="k">lifetime</span><span class="v">${LIFE_LABEL[config.lifetimeMs] || "?"}</span></div>` +
    `<div class="hdr" style="margin-top:6px">measured</div>` +
    `<div class="row"><span class="k">per-frame update</span><span class="v">${perFrame.toFixed(3)} ms</span></div>` +
    `<div class="row"><span class="k">setup (last)</span><span class="v">${setupMs.toFixed(1)} ms</span></div>` +
    `<div class="row"><span class="k">bulk lanes</span><span class="v">${laneStr}</span></div>` +
    `<div class="row"><span class="k">fps</span><span class="v">${fps}</span></div>`;
}

// ── Toolbar: one menu per axis. Any change triggers a full rebuild. ──
Sandcastle.addToolbarMenu(
  [
    { text: "Object: Point", onselect: () => set("type", "point") },
    {
      text: "Object: Billboard",
      onselect: () => set("type", "billboard"),
    },
    { text: "Object: Label", onselect: () => set("type", "label") },
  ],
  "toolbar",
);

Sandcastle.addToolbarMenu(
  [
    {
      text: "Count: Medium (2,500)",
      onselect: () => set("count", 2500),
    },
    { text: "Count: Small (100)", onselect: () => set("count", 100) },
    {
      text: "Count: Large (20,000)",
      onselect: () => set("count", 20000),
    },
  ],
  "toolbar",
);

Sandcastle.addToolbarMenu(
  [
    { text: "Lane: Static", onselect: () => set("dynamic", false) },
    { text: "Lane: Dynamic", onselect: () => set("dynamic", true) },
  ],
  "toolbar",
);

Sandcastle.addToolbarMenu(
  [
    {
      text: "Lifetime: Long (never recreated)",
      onselect: () => set("lifetimeMs", Infinity),
    },
    {
      text: "Lifetime: Medium (8 s)",
      onselect: () => set("lifetimeMs", 8000),
    },
    {
      text: "Lifetime: Short (1 s)",
      onselect: () => set("lifetimeMs", 1000),
    },
  ],
  "toolbar",
);

Sandcastle.addToolbarMenu(
  [
    {
      text: "Visualizer: Bulk (default)",
      onselect: () => set("mode", "bulk"),
    },
    {
      text: "Visualizer: Legacy",
      onselect: () => set("mode", "legacy"),
    },
  ],
  "toolbar",
);

function set(key, value) {
  if (config[key] === value) {
    return;
  }
  config[key] = value;
  rebuild();
}

// Debug / probe hook (mirrors window.viewer): drive the demo + read the
// live metrics from the console or an automated probe.
window.__bulkLegacy = { config, set, rebuild };

await rebuild();
