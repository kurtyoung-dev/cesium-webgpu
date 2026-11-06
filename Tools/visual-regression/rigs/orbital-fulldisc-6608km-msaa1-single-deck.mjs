// Rig record for the landing program's orbital cell E-O-msaa1: the E-O rig with
// the sample count at its default of one, the single-sample twin of the 4x MSAA
// orbital cell.
//
// @purpose Rig record for the landing cell E-O-msaa1: orbital-fulldisc-6608km-msaa4-single-deck value for value (nadir over the sub-solar point at the disc-fitting altitude, 2048 square, disc 2,000 px, globe blacked out, imagery removed, high tier = 96/8 steps, single cloud deck) with msaaSamples 1, so the orbital cloud frame is captured without a multisampled colour target.
// @status ACTIVE
//
// WHY A SIBLING AND NOT AN OVERRIDE. A probe that set the sample count on the
// side would photograph a different scene under the 4x rig's name. The two rigs
// are declared apart so a cell reads exactly one sample count, and a spec pins
// that they differ in the identity, the description, the declaredBy line and
// `dials.msaaSamples` alone.
//
// EVERYTHING ELSE IS THE 4x RIG'S, VALUE FOR VALUE, including the measured disc
// block, so a disc metric reads this rig exactly as it reads that one. Re-derive
// both together if the camera or the viewport ever moves.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-O-msaa1`.

export default Object.freeze({
  id: "orbital-fulldisc-6608km-msaa1-single-deck",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Landing cell E-O-msaa1: the orbital full disc at 6,608,426.573 m over the sub-solar point, 2048 square, silhouette 2,000 px across, globe blacked out and imagery removed, weather map off, high tier (96/8 steps), single cloud deck and 1x MSAA (no multisampling).",
  declaredBy: "orbital-fulldisc-6608km-msaa4-single-deck (with msaaSamples 1)",
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
    msaaSamples: 1,
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
