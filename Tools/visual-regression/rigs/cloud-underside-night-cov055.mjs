// Rig record for the night sibling of `cloud-underside-noon-cov055`, the
// ground cell E-G's second instant.
//
// @purpose Rig record for the landing cell E-G at night: the cloud-underside-noon-cov055 scene (800 m under the deck at (-95, 39), coverage 0.55, density 0.8, black sky) with only the clock moved to local solar midnight, 06:20Z on the June solstice, when the sun is about 27.6 degrees below the horizon.
// @status ACTIVE
//
// ONLY THE CLOCK DIFFERS FROM THE NOON RIG, so a BEFORE/AFTER pair at this rig
// and its noon sibling separate what a change does to the lit deck from what
// it does to the unlit one. The noon rig's 18:20Z is solar noon at -95
// degrees; twelve hours away (06:20Z, the same date) is solar midnight. At
// latitude 39 on the June solstice the sun then sits at -(90 - 39 - 23.44) = -27.56 degrees, below
// astronomical twilight, so nothing in the frame is lit by the sun.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-G-night`, through
// `lib/landing-cell-stage.mjs` (the `cloud*` dials through the cloud probe
// harness, the show dials and the background on the scene).

export default Object.freeze({
  id: "cloud-underside-night-cov055",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The night sibling of cloud-underside-noon-cov055: camera 800 m above (-95, 39) under the deck, heading east and pitched 16 degrees up, at local solar midnight (06:20Z) on the June solstice; sky box, sky atmosphere and sun hidden over a black background; weather map off, coverage 0.55, density 0.8; the viewer's own render loop stopped and 90 frames rendered at the fixed clock.",
  declaredBy: "cloud-underside-noon-cov055 (clock moved by twelve hours)",
  camera: {
    lon: -95,
    lat: 39,
    height: 800,
    heading: 1.5707963267948966,
    pitch: 0.2792526803190927,
    roll: 0,
  },
  clock: "2026-06-21T06:20:00Z",
  dials: {
    cloudCoverage: 0.55,
    cloudDensity: 0.8,
    cloudWeatherMap: false,
    skyBoxShow: false,
    skyAtmosphereShow: false,
    sunShow: false,
    backgroundColor: "rgb(0,0,0)",
    useDefaultRenderLoop: false,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 90,
  },
});
