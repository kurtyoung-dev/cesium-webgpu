import * as Cesium from "cesium";
import Sandcastle from "Sandcastle";

const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
  baseLayerPicker: false,
  timeline: false,
  animation: false,
});

const ctx = viewer.scene._context;
const monitor = ctx.asyncResources;
const telemetry = ctx.asyncResourceTelemetry;
const pipelineCache = ctx.webgpuPipelineCache;

const eventLog = document.getElementById("eventLog");
function logEvent(prefix, evt) {
  const div = document.createElement("div");
  div.className = `ev-${evt.kind}`;
  const dur =
    evt.durationMs !== undefined ? ` ${evt.durationMs.toFixed(0)}ms` : "";
  div.textContent = `[${evt.kind}] ${evt.token.kind}${dur} ${evt.token.label || evt.token.key}`;
  eventLog.insertBefore(div, eventLog.firstChild);
  while (eventLog.childNodes.length > 80) {
    eventLog.removeChild(eventLog.lastChild);
  }
}

monitor.subscribe((evt) => logEvent("", evt), {
  sceneId: viewer.scene.id,
});

const KINDS = [
  "render-pipeline",
  "compute-pipeline",
  "image-decode",
  "shader-module",
  "texture-upload",
  "buffer-map",
];

const kindBody = document.querySelector("#kindTable tbody");
for (const k of KINDS) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td class="k">${k}</td><td class="v" id="kind_${k}">—</td>`;
  kindBody.appendChild(tr);
}

function refreshUi() {
  const snap = telemetry.snapshot();
  const a = snap.aggregate;
  document.getElementById("aggCurrent").textContent = a.currentInflight;
  const peakEl = document.getElementById("aggPeak");
  peakEl.textContent = a.peakInflight;
  peakEl.className = a.peakInflight > 5 ? "v hi" : "v";
  document.getElementById("aggResolved").textContent = a.resolvedCount;
  const rejEl = document.getElementById("aggRejected");
  rejEl.textContent = a.rejectedCount;
  rejEl.className = a.rejectedCount > 0 ? "v hi" : "v";
  document.getElementById("aggMean").textContent = a.meanMs.toFixed(1);
  for (const k of KINDS) {
    const s = snap.perKind[k];
    const cell = document.getElementById(`kind_${k}`);
    if (s.resolvedCount === 0) {
      cell.textContent = "—";
    } else {
      cell.textContent =
        `${s.resolvedCount} · ` +
        `${s.p50Ms.toFixed(1)} · ` +
        `${s.p95Ms.toFixed(1)} · ` +
        `${s.p99Ms.toFixed(1)}`;
    }
  }
}
viewer.scene.postRender.addEventListener(refreshUi);
refreshUi();

// Toolbar buttons.
Sandcastle.addToolbarButton("Fly to NYC", () => {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(-74.006, 40.7128, 5e6),
    duration: 2,
  });
});
Sandcastle.addToolbarButton("Fly to Tokyo", () => {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(139.6917, 35.6895, 5e6),
    duration: 2,
  });
});
Sandcastle.addToolbarButton("Toggle globe translucency", () => {
  // Forces the BLEND-variant pipeline path. The first toggle
  // triggers a fresh pipeline cook unless cache.warm() has
  // already pre-cooked it (which the globe surface does
  // automatically as of NEW-WEBGPU-PIPELINE-READY-SIGNAL Phase 4).
  const t = viewer.scene.globe.translucency;
  t.enabled = !t.enabled;
  if (t.enabled) {
    t.frontFaceAlpha = 0.5;
  }
});
Sandcastle.addToolbarButton("Warm extra variants", () => {
  if (!pipelineCache) {
    console.warn("No webgpuPipelineCache");
    return;
  }
  // Demonstrate the warm() API — call with a no-op descriptor
  // pattern. In a real consumer, you'd pass a real GPU descriptor
  // for a variant you expect to need soon. Here we just log
  // the API exists and is callable.
  console.log(
    `[demo] cache.warm() exists, stats: ${JSON.stringify(pipelineCache.getStats())}`,
  );
});
Sandcastle.addToolbarButton("Reset stats", () => {
  // No public reset; clear the visual log + reload the
  // telemetry by detaching/reattaching is destructive. For
  // demo purposes just clear the visual log.
  eventLog.innerHTML = "";
  console.log("[demo] event log cleared (telemetry counters persist)");
});
