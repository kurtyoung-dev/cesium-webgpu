// Rig record for the landing program's orbital cell E-O: the orbital full-disc
// recipe camera with the two dials the cell adds, as the plan's "sibling rig
// if the dials cannot be set" on the base rig.
//
// @purpose Rig record for the landing cell E-O: orbital-fulldisc-6608km (nadir over the sub-solar point at the disc-fitting altitude, 2048 square, disc 2,000 px, globe blacked out, imagery removed, high tier = 96/8 steps) with a single cloud deck (cloudMultiDeck false) and 4x MSAA, the cell the 10-08 review requires to complete.
// @status ACTIVE
//
// WHY A SIBLING AND NOT AN OVERRIDE. The plan's E-O is the orbital full disc
// "with volumetric clouds on, single deck (`cloudMultiDeck false`), MSAA 4,
// 96/8 steps set as dials". The base rig carries neither the deck nor the MSAA
// count, and a probe that set them on the side would photograph a different
// scene under the base rig's name. The step counts need no dial of their own:
// `cloudVolumetricQuality: "high"` is the tier whose preset is 96 primary and
// 8 light steps (`CLOUD_TIER_PRESETS`, `WebGPUCloudTierPresets.ts:184`).
//
// EVERYTHING ELSE IS THE BASE RIG'S, VALUE FOR VALUE, including the measured
// disc block, so a disc metric reads this rig exactly as it reads the base
// one. Re-derive both together if the camera or the viewport ever moves.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-O`.

export default Object.freeze({
  id: "orbital-fulldisc-6608km-msaa4-single-deck",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Landing cell E-O: the orbital full disc at 6,608,426.573 m over the sub-solar point, 2048 square, silhouette 2,000 px across, globe blacked out and imagery removed, weather map off, high tier (96/8 steps), single cloud deck and 4x MSAA.",
  declaredBy:
    "orbital-fulldisc-6608km (plus cloudMultiDeck false, msaaSamples 4)",
  altitudeMetres: 6608426.573306667,
  camera: {
    lon: -94.52486443593966,
    lat: 23.437312983449644,
    height: 6608426.573306667,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-06-21T18:20:00Z",
  dials: {
    cloudCoverage: 0.6,
    cloudDensity: 0.8,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudWindSpeed: 0,
    cloudWeatherMap: false,
    cloudVolumetricQuality: "high",
    cloudMultiDeck: false,
    msaaSamples: 4,
    globeBaseColor: "rgb(0,0,0)",
    globeEnableLighting: false,
    globeShowWaterEffect: false,
    removeImageryLayers: true,
  },
  disc: {
    centreX: 1023.992,
    centreY: 1019.602,
    focalPixels: 1773.6200269505305,
    discRadiusPixels: 1000,
    planetRadiusMetres: 6378137,
    nadirMetresPerPixel: 3725.953965838359,
    limbInFrame: true,
    limbSemiAxesPixels: { x: 999.99, y: 997.26 },
    visiblePeriodBand: { minPx: 3, maxPx: 41 },
  },
  viewport: {
    width: 2048,
    height: 2048,
  },
  readiness: {
    kind: "settleFrames",
    frames: 60,
  },
});
