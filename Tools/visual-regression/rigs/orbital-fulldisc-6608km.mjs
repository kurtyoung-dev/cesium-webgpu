// Rig record for the C13-N22 / L5 orbital full-disc recipe camera, the one
// every banded orbital capture on record was taken at.
//
// @purpose Rig record reproducing the L5 orbital full-disc recipe exactly - nadir on the sub-solar point at a disc-fitting altitude, 2048 square, disc 2000 px across, weather map off, tier 3.
// @status ACTIVE
//
// EVERY NUMBER HERE IS READ OUT OF A BANKED MANIFEST, not restated from a
// brief. Altitude, focal length, disc radius and the deck come from
// `output/wave-end/c13v2-wave1-engine-legs-2026-09-18/L5/structural/full-res/NOWX-capture.json`;
// the camera orientation, the viewport, the settle count and the dials come
// from that receipt's own capture script (`…/L5/scripts/weather-disc-capture.mjs`,
// `TARGET_DISC_DIAMETER_PX` 2000, `VIEWPORT` 2048 square, `SETTLE_FRAMES` 60).
//
// THE ALTITUDE IS DERIVED, NOT CHOSEN. The script solves for the altitude at
// which the globe's silhouette is exactly 2,000 px across at the viewer's own
// field of view, so a capture at this rig is comparable to the banked ones
// pixel for pixel. Changing the viewport or the field of view without
// re-deriving the altitude breaks that.
//
// THE LON/LAT IS THE SUB-SOLAR POINT AT `clock`. It is recorded as a literal
// because that is what the banked capture used and a rig is a record of what
// was rendered; a reader who changes the clock has to re-derive it.
//
// THE GLOBE IS DELIBERATELY BLACKED OUT AND THE IMAGERY REMOVED, which is what
// makes the cloud field the only thing in the frame — and also what makes
// every severity figure taken at this rig a figure about a black planet. The
// sibling rig `orbital-fulldisc-6608km-imagery` is the same camera with the
// globe left alone, and it exists so that framing can be checked rather than
// assumed.

export default Object.freeze({
  id: "orbital-fulldisc-6608km",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Orbital full disc at the disc-fitting altitude of 6,608,426.573 m over the sub-solar point, 2048 square with the silhouette exactly 2,000 px across, globe blacked out and imagery removed, weather map off, tier 3 - the camera every banded orbital capture on record was taken at.",
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
    globeBaseColor: "rgb(0,0,0)",
    globeEnableLighting: false,
    globeShowWaterEffect: false,
    removeImageryLayers: true,
  },
  // The disc geometry a disc metric needs, as the capture manifest records it.
  // `focalPixels` is `height / 2 / tan(fovy / 2)` at the viewer's default 60
  // degree vertical field of view.
  disc: {
    focalPixels: 1773.6200269505305,
    discRadiusPixels: 1000,
    planetRadiusMetres: 6378137,
    nadirMetresPerPixel: 3725.953965838359,
    limbInFrame: true,
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
