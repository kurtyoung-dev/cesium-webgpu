// Rig record for probe-clustered-matsweep.mjs: a row of seven lit material boxes under one clustered point light.
//
// @purpose Rig record for probe-clustered-matsweep.mjs's scene: seven 30 m boxes, one per non-textured built-in material type, in a row over Pittsburgh with the globe hidden and one bright point light, clustered lighting on.
// @status ACTIVE
//
// Box `i` sits `(i - 3) * spacingMetres` east of the centre in the probe's own
// approximation, `lon + offset / lonDivisor` degrees. The pose is
// `viewBoundingSphere` about a 220 m sphere at the centre (`dials.view`), so
// `camera` is null and the probe applies it. The light sits
// `lightDistanceMetres` from the centre on the camera side. Every value is the
// probe's own pre-harvest constant; the probe now reads them from here.

export default Object.freeze({
  id: "clustered-matsweep-row",
  tags: ["clustered"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Seven 30 m lit boxes in a row over Pittsburgh, one per non-textured built-in material (Color, Checkerboard, Grid, Stripe, Dot, Fade, RimLighting), globe hidden, framed from 2.2 radii of a 220 m sphere at 25 degrees down, with one bright white point light 120 m in front and clustered lighting on.",
  camera: null,
  clock: null,
  dials: {
    centre: { lon: -79.9959, lat: 40.4406, height: 150 },
    materials: [
      "Color",
      "Checkerboard",
      "Grid",
      "Stripe",
      "Dot",
      "Fade",
      "RimLighting",
    ],
    boxDimensionsMetres: [30, 30, 30],
    spacingMetres: 60,
    lonDivisor: 90000,
    boundingSphereRadiusMetres: 220,
    view: { headingDegrees: 0, pitchDegrees: -25, rangeInRadii: 2.2 },
    light: {
      colorName: "WHITE",
      lightDistanceMetres: 120,
      intensity: 20000,
      range: 5000,
    },
    onFrames: 90,
  },
  viewport: { width: 800, height: 600 },
  readiness: { kind: "settleFrames", frames: 90 },
});
