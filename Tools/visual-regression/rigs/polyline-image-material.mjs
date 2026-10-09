// Polyline family rig "polyline-image-material" (probe-kit harvest, DX-108): the Image-material polyline scene probe-polyline-image-material builds in the page to read whether the texture is sampled along the line.
//
// @purpose Polyline family rig "polyline-image-material" (probe-kit harvest, DX-108): the Image-material polyline scene probe-polyline-image-material builds in the page to read whether the texture is sampled along the line.
// @status ACTIVE

export default Object.freeze({
  id: "polyline-image-material",
  tags: ["polyline"],
  page: null,
  renderers: ["webgl", "webgpu"],
  description:
    "A width-20 horizontal PolylineGeometry Primitive from 78 W to 68 W at 35 N (arcType NONE) drawn with PolylineMaterialAppearance and an Image material whose 64x8 texture is red in its left half and blue in its right half, on black with the globe and sky hidden, seen straight down from 900 km. A textured line reads red then blue along its length. No page renders this rig from its data yet; the probe builds it in the page.",
  camera: null,
  clock: null,
  dials: {
    hide: ["globe", "skyBox", "sun", "moon", "skyAtmosphere"],
    appearance: "PolylineMaterialAppearance",
    positionsDegrees: [-78, 35, -68, 35],
    width: 20,
    arcType: "NONE",
    texture: {
      width: 64,
      height: 8,
      leftHalf: [255, 0, 0],
      rightHalf: [0, 0, 255],
    },
    lookAt: {
      lon: -73,
      lat: 35,
      height: 0,
      headingDegrees: 0,
      pitchDegrees: -90,
      rangeMetres: 900000,
    },
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 150,
  },
});
