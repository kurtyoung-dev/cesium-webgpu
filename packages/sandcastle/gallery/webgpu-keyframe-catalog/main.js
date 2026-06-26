import * as Cesium from "cesium";

// Backend is selectable via ?renderer= (default webgpu) so a user can
// exercise the WebGL2 CPU-kernel fallback (cpuKernel) straight from the
// demo — on WebGL2 the engine runs the family's JS kernel each frame.
const requestedRenderer =
  new URLSearchParams(window.location.search).get("renderer") || "webgpu";
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: requestedRenderer },
  shouldAnimate: true,
});
const scene = viewer.scene;

// Per-instance keyframe budget. The lane stride is 1 + 4 * MAX_KEYFRAMES
// floats; instances may carry fewer keyframes than this.
const MAX_KEYFRAMES = 8;

// The reusable keyframe-interpolation kernel family (engine artifact).
// It hands back the matched WGSL kernel, the JS cpuKernel (WebGL2
// fallback), the param stride, and a per-instance packer.
const family = Cesium.SampledPositionKernel.create({
  maxKeyframes: MAX_KEYFRAMES,
  color: new Cesium.Color(0.2, 0.9, 1.0, 1.0),
  pixelSize: 3.0,
});

// Epoch = the keyframe time origin (seconds since here). Simulation
// time follows the scene clock relative to this epoch.
const epoch = Cesium.JulianDate.now();
const SPAN_SECONDS = 3600.0; // each track spans one simulated hour

// Deterministic PRNG so the catalog is reproducible across reloads.
let seed = 0x2545f491;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Build one object's keyframe track: a great-circle-ish arc of random
// waypoints over the globe at a random altitude (a stand-in for a CZML
// `position` track or recorded telemetry — the kernel doesn't care how
// the keyframes were produced). Returns the packed lane array.
const ellipsoid = Cesium.Ellipsoid.WGS84;
const scratchCarto = new Cesium.Cartographic();
const buildTrack = () => {
  const kfCount = 4 + Math.floor(rand() * (MAX_KEYFRAMES - 4)); // 4..8
  const lon0 = (rand() * 2.0 - 1.0) * Math.PI;
  const lat0 = (rand() * 2.0 - 1.0) * (Math.PI / 3.0);
  const dLon = (rand() * 2.0 - 1.0) * 0.8;
  const dLat = (rand() * 2.0 - 1.0) * 0.4;
  const altitude = 4.0e5 + rand() * 1.2e6; // 400 km .. 1.6 Mm
  const keyframes = [];
  for (let k = 0; k < kfCount; k++) {
    const f = k / (kfCount - 1);
    // Wander a little off the straight arc so segments are visibly bent.
    const wobble = (rand() * 2.0 - 1.0) * 0.05;
    scratchCarto.longitude = lon0 + dLon * f + wobble;
    scratchCarto.latitude = lat0 + dLat * f + wobble * 0.5;
    scratchCarto.height = altitude;
    const position = ellipsoid.cartographicToCartesian(
      scratchCarto,
      new Cesium.Cartesian3(),
    );
    keyframes.push({ time: f * SPAN_SECONDS, position });
  }
  return family.packInstance(keyframes, epoch);
};

let collection;
const rebuild = (count) => {
  if (Cesium.defined(collection)) {
    scene.primitives.remove(collection);
    collection = undefined;
  }
  collection = scene.primitives.add(
    new Cesium.ComputeInstanceCollection({
      kernel: family.kernel,
      cpuKernel: family.cpuKernel, // WebGL2 fallback
      floatsPerInstance: family.floatsPerInstance,
      // Positions are GPU-resident, so the engine can't derive a
      // bounding volume — the whole catalog fits inside GEO radius.
      boundingSphere: new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, 4.4e7),
    }),
  );
  collection.epoch = epoch;
  for (let i = 0; i < count; i++) {
    collection.addInstance(buildTrack());
  }
};

// Loop the clock over the keyframe span so the catalog perpetually
// re-runs its tracks (animation never stalls past the last keyframe).
viewer.clock.startTime = Cesium.JulianDate.clone(epoch);
viewer.clock.stopTime = Cesium.JulianDate.addSeconds(
  epoch,
  SPAN_SECONDS,
  new Cesium.JulianDate(),
);
viewer.clock.currentTime = Cesium.JulianDate.clone(epoch);
viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
viewer.clock.multiplier = 60;

// Knockout view-model for the toolbar.
const viewModel = { objectCount: "5000", clockMultiplier: 60 };
Cesium.knockout.track(viewModel);
const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);
Cesium.knockout
  .getObservable(viewModel, "objectCount")
  .subscribe((value) => rebuild(parseInt(value, 10)));
Cesium.knockout
  .getObservable(viewModel, "clockMultiplier")
  .subscribe((value) => {
    viewer.clock.multiplier = parseInt(value, 10);
  });

rebuild(parseInt(viewModel.objectCount, 10));

viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(0.0, 10.0, 4.0e7),
});

window.viewer = viewer;
