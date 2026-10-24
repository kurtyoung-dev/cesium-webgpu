// Rig record for the water landing's teardown and device-loss cell (E-T in E11):
// the coast camera the water lane's job sheet names, with the enhanced ocean and
// the high water tier switched on so the water's GPU owners are alive.
//
// @purpose Rig record for the E11 teardown/device-loss cell: San Francisco's coast from 50 km (pitch -1.2) on the ellipsoid terrain at 16:00Z on the June solstice, with globalWaterMask, enableEnhancedOcean and waterQualityPreset HIGH on (the bathymetry tensor texture and the ocean-tier pipelines alive), a tier switch LOW then HIGH and a two-step resize ladder as the provoking steps, both renderers, 1280x720.
// @status ACTIVE
//
// WHY THIS RIG EXISTS. The plan's E-T for the water landing runs "with
// `WebGPUBathymetryTensorTexture` and the ocean-tier pipelines alive". The
// water lane's job sheet (`EDGE_LEG_WATER.md`, leg 2) names three rigs,
// `water-great-lakes`, `water-coast-50km` and `water-orbit-disc`; none of them
// exists in the tree, and none switches the enhanced ocean on. The camera,
// clock, terrain and viewport here are that sheet's `water-coast-50km` row,
// value for value; the enhanced ocean, the HIGH tier and the provoking steps
// are what makes it an E-T scene.
//
// ON A TREE WITHOUT THE WATER BATCH the water dials read back
// `applied: false` (`globalWaterMask` and `globe.water.qualityPreset` do not
// exist at a999954e2b; `enableEnhancedOcean` does), which is how the BEFORE
// arm answers. The stage reports, it does not refuse: the BEFORE arm of E-T is
// the teardown of the scene that tree can build.
//
// THE STEPS ARE DIALS, SO THEY ARE IN THE REPLAY KEY. `tierSwitch` moves
// `globe.water.qualityPreset` through its values (rebuilding the tier's
// pipelines); `resizeLadder` walks the canvas through the sizes (rebuilding the
// scene framebuffer) at `msaaSamples`. `lib/device-loss-steps.mjs` executes
// both before the teardown or the forced loss.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-T-water`.

export default Object.freeze({
  id: "water-coast-50km-enhanced-ocean",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "San Francisco's coast from 50 km (-122.45, 37.75, heading 0, pitch -1.2) on the ellipsoid terrain at 16:00Z on the June solstice, globalWaterMask, enableEnhancedOcean and the HIGH water tier on; provoking steps: tier LOW then HIGH, canvas 1024x600 then back to 1280x720 at 4x MSAA.",
  declaredBy:
    "EDGE_LEG_WATER.md water-coast-50km (camera, clock, terrain, viewport) plus the enhanced ocean",
  camera: {
    lon: -122.45,
    lat: 37.75,
    height: 50000,
    heading: 0,
    pitch: -1.2,
    roll: 0,
  },
  clock: "2026-06-21T16:00:00Z",
  dials: {
    pinClock: true,
    terrain: "ellipsoid",
    globalWaterMask: true,
    enableEnhancedOcean: true,
    waterQualityPreset: "HIGH",
    msaaSamples: 4,
    tierSwitch: { dial: "waterQualityPreset", values: ["LOW", "HIGH"] },
    resizeLadder: [
      [1024, 600],
      [1280, 720],
    ],
    settleFramesPerStep: 60,
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 120,
  },
});
