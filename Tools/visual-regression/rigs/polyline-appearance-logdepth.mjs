// Polyline family rig "polyline-appearance-logdepth" (probe-kit harvest, DX-108): the globe-on, far-camera scene probe-polyline-appearance-logdepth builds in the page to read whether surface polylines rest on the log-depth globe.
//
// @purpose Polyline family rig "polyline-appearance-logdepth" (probe-kit harvest, DX-108): the globe-on, far-camera scene probe-polyline-appearance-logdepth builds in the page to read whether surface polylines rest on the log-depth globe.
// @status ACTIVE

export default Object.freeze({
  id: "polyline-appearance-logdepth",
  tags: ["polyline"],
  page: null,
  renderers: ["webgl", "webgpu"],
  description:
    "Globe ON with logarithmic depth, base colour dark grey (40, 40, 40), ground atmosphere, sky box, sun, moon and sky atmosphere off: a cyan width-10 PolylineColorAppearance line and a magenta width-14 PolylineGlow line, both geodesic at height 0 across 100 W to 80 W near 34-41 N, seen from 6,000 km at pitch -30 degrees looking at 90 W 38 N. Imagery still loads from the network. No page renders this rig from its data yet; the probe builds it in the page.",
  camera: null,
  clock: null,
  dials: {
    hide: ["skyBox", "sun", "moon", "skyAtmosphere"],
    globe: {
      show: true,
      baseColorBytes: [40, 40, 40],
      showGroundAtmosphere: false,
    },
    colorLine: {
      appearance: "PolylineColorAppearance",
      positionsDegreesHeights: [
        -100, 40, 0, -95, 38, 0, -90, 41, 0, -85, 38, 0, -80, 40, 0,
      ],
      width: 10,
      arcType: "GEODESIC",
      color: [0, 1, 1, 1],
    },
    glowLine: {
      appearance: "PolylineMaterialAppearance",
      positionsDegreesHeights: [-100, 36, 0, -90, 34, 0, -80, 36, 0],
      width: 14,
      arcType: "GEODESIC",
      material: {
        type: "PolylineGlow",
        color: [1, 0, 1, 1],
        glowPower: 0.25,
        taperPower: 1,
      },
    },
    lookAt: {
      lon: -90,
      lat: 38,
      height: 0,
      headingDegrees: 0,
      pitchDegrees: -30,
      rangeMetres: 6000000,
    },
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 140,
  },
});
