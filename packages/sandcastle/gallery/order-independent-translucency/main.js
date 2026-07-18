import * as Cesium from "cesium";
import Sandcastle from "Sandcastle";

// Order-Independent Transparency (OIT) demo.
//
// A scene of MUTUALLY-INTERSECTING translucent geometry — three intersecting
// ellipsoids (red / green / blue, alpha ~0.5) plus a translucent polygon
// slicing through them — viewed from an oblique angle where per-object
// back-to-front "sorted alpha" is provably wrong at the interpenetration lines
// and OIT visibly differs.
//
// - WebGL uses order-independent translucency by DEFAULT (weighted-blended
//   McGuire-Bavoil). Toggle it off to see sorted alpha instead — the overlap
//   regions get more saturated but the intersections resolve incorrectly.
// - The WebGPU MRT-OIT path is contained OFF by default (FAR-003). The WebGPU
//   OIT gate toggle flips CesiumDebug.webgpuOIT(). NOTE: at present the WebGPU
//   MRT-OIT accumulation path is only wired for commands carrying their WGSL
//   source (Gaussian splats), NOT standard translucent primitives, so this
//   toggle currently has no visible effect on the geometry below — the status
//   line reports requested-vs-active honestly.
//
// Switch backend with the ?renderer= query param: ?renderer=webgpu or
// ?renderer=webgl (default). The status line shows the live backend + OIT state.

const params = new URLSearchParams(window.location.search);
const renderer = params.get("renderer") === "webgpu" ? "webgpu" : "webgl";

const LON = -75.0;
const LAT = 40.0;
const H = 200.0;
const center = Cesium.Cartesian3.fromDegrees(LON, LAT, H);
const orbitPitch = Cesium.Math.toRadians(-22);
const orbitRange = 420;

let viewer;
let webglOit = true; // WebGL orderIndependentTranslucency constructor option
let orbit = true;
let orbitHeading = Cesium.Math.toRadians(35);

const statusDiv = document.createElement("div");
statusDiv.style.cssText =
  "margin-top:6px;font:12px/1.5 monospace;color:#cfe;max-width:340px;";

function buildScene(v) {
  const scene = v.scene;
  scene.globe.show = false;
  if (scene.skyBox) {
    scene.skyBox.show = false;
  }
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = false;
  }
  if (scene.sun) {
    scene.sun.show = false;
  }
  if (scene.moon) {
    scene.moon.show = false;
  }
  scene.backgroundColor = new Cesium.Color(0.02, 0.02, 0.05, 1.0);
  scene.fog.enabled = false;

  const radii = new Cesium.Cartesian3(60, 60, 60);
  const dLon = 0.00042; // ~36 m at lat 40
  const dLat = 0.00032; // ~35 m
  const shells = [
    { off: [0, dLat], color: new Cesium.Color(1.0, 0.15, 0.15, 0.5) },
    { off: [-dLon, -dLat * 0.6], color: new Cesium.Color(0.15, 1.0, 0.2, 0.5) },
    { off: [dLon, -dLat * 0.6], color: new Cesium.Color(0.2, 0.35, 1.0, 0.5) },
  ];
  for (const s of shells) {
    v.entities.add({
      position: Cesium.Cartesian3.fromDegrees(
        LON + s.off[0],
        LAT + s.off[1],
        H,
      ),
      ellipsoid: { radii, material: s.color, outline: false },
    });
  }

  const e = 0.0011;
  v.entities.add({
    polygon: {
      hierarchy: new Cesium.PolygonHierarchy([
        Cesium.Cartesian3.fromDegrees(LON - e, LAT - e, H),
        Cesium.Cartesian3.fromDegrees(LON + e, LAT - e, H),
        Cesium.Cartesian3.fromDegrees(LON + e, LAT + e, H),
        Cesium.Cartesian3.fromDegrees(LON - e, LAT + e, H),
      ]),
      material: new Cesium.Color(1.0, 0.9, 0.1, 0.4),
      perPositionHeight: true,
      outline: false,
    },
  });

  v.camera.lookAt(
    center,
    new Cesium.HeadingPitchRange(orbitHeading, orbitPitch, orbitRange),
  );
  v.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
}

function updateStatus() {
  const scene = viewer.scene;
  const backend = scene.context.rendererType;
  let oitLine;
  if (backend === "webgpu") {
    const st =
      window.CesiumDebug && typeof window.CesiumDebug.webgpuOIT === "function"
        ? window.CesiumDebug.webgpuOIT()
        : null;
    const fb = st && st.fallbackReason ? ` (${st.fallbackReason})` : "";
    oitLine = st
      ? `WebGPU MRT-OIT gate: requested=${st.requested} active=${st.active}${fb}`
      : "WebGPU OIT gate: unavailable";
  } else {
    oitLine = `WebGL orderIndependentTranslucency: ${scene.orderIndependentTranslucency}`;
  }
  statusDiv.innerHTML = `Renderer: <b>${backend}</b> &nbsp; (switch via ?renderer=webgpu / ?renderer=webgl)<br/>${oitLine}`;
}

async function buildViewer() {
  if (viewer && !viewer.isDestroyed()) {
    viewer.destroy();
  }
  const container = document.getElementById("cesiumContainer");
  if (container) {
    container.innerHTML = "";
  }
  viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
    contextOptions: { renderer },
    orderIndependentTranslucency: webglOit,
    baseLayerPicker: false,
    geocoder: false,
    timeline: false,
    animation: false,
    shouldAnimate: false,
  });
  // Mount window.CesiumDebug bound to this viewer so the WebGPU OIT gate toggle
  // works (CesiumDebug.webgpuOIT is the sanctioned FAR-003 containment toggle).
  // Aliased to a lowercase local: CesiumDebug is an install function, not a
  // constructor (satisfies the new-cap lint).
  const installCesiumDebug = Cesium.CesiumDebug;
  if (typeof installCesiumDebug === "function") {
    installCesiumDebug(viewer);
  }
  buildScene(viewer);

  viewer.scene.preRender.addEventListener(() => {
    if (!orbit) {
      return;
    }
    orbitHeading += 0.0025;
    viewer.camera.lookAt(
      center,
      new Cesium.HeadingPitchRange(orbitHeading, orbitPitch, orbitRange),
    );
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  });

  updateStatus();
}

await buildViewer();

Sandcastle.addToggleButton("Orbit camera", orbit, (checked) => {
  orbit = checked;
  if (!checked) {
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }
});

Sandcastle.addToggleButton(
  "WebGL order-independent translucency (recreate viewer)",
  webglOit,
  async (checked) => {
    webglOit = checked;
    await buildViewer();
    if (renderer !== "webgl") {
      window.alert(
        "This is the WebGL orderIndependentTranslucency constructor option. " +
          "You are on the WebGPU backend, where translucency uses sorted alpha " +
          "and the MRT-OIT path is separately contained (FAR-003) — this toggle " +
          "has no visible effect here. Use the WebGPU OIT gate toggle instead.",
      );
    }
  },
);

Sandcastle.addToggleButton(
  "WebGPU MRT-OIT gate (CesiumDebug.webgpuOIT)",
  false,
  (checked) => {
    if (viewer.scene.context.rendererType !== "webgpu") {
      window.alert(
        "The WebGPU MRT-OIT containment gate is only available on the WebGPU " +
          "backend. Reload with ?renderer=webgpu to try it.",
      );
      updateStatus();
      return;
    }
    if (
      window.CesiumDebug &&
      typeof window.CesiumDebug.webgpuOIT === "function"
    ) {
      window.CesiumDebug.webgpuOIT(checked);
    }
    updateStatus();
  },
);

const toolbar = document.getElementById("toolbar");
if (toolbar) {
  toolbar.appendChild(statusDiv);
}
updateStatus();
