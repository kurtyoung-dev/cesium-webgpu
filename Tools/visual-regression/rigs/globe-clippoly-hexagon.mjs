// Rig record for probe-globe-clippoly-geodetic.mjs's "globe-clippoly-hexagon" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-clippoly-geodetic.mjs's "globe-clippoly-hexagon" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-clippoly-hexagon",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "A hexagonal globe clipping polygon centred on 105 W, 45 N (semi-axes 2.4 by 1.7 degrees) over a solid sandy-brown globe with no imagery, sky, sun, moon or ground atmosphere, seen straight down from 1,000 km; the hole shows the black background.",
  camera: {
    lon: -105,
    lat: 45,
    height: 1000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: null,
  dials: {
    baseColor: "SANDYBROWN",
    imageryLayers: 0,
    clippingPolygon: {
      centre: [-105, 45],
      semiAxesDegrees: [2.4, 1.7],
      vertices: 6,
    },
  },
  viewport: {
    width: 800,
    height: 600,
  },
  readiness: {
    kind: "settleFrames",
    frames: 240,
  },
});
