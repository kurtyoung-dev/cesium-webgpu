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
  //
  // THE DISC CENTRE IS MEASURED, NOT THE VIEWPORT'S MIDDLE. An axis-aligned
  // ellipse fitted to the ground limb (the steepest luminance rise on 720 rays)
  // of a clouds-off frame at this rig puts the centre at (1023.992, 1019.602):
  // the same to 0.002 px on two frames from two trees, 0.23 px RMS residual,
  // and a horizontal semi-axis of 999.99 px against the 1,000.000 px the
  // equatorial silhouette predicts. The vertical semi-axis is 997.26 px, so a
  // 1,000 px disc about this centre crosses the limb by up to 2.7 px at the
  // poles. A circle fitted to the outer halo instead lands 1.7 px north; the
  // limb is the edge a disc metric has to stay inside.
  //
  // THE VISIBLE PERIOD BAND is what `ringFamily` is built from: 41 px is the
  // moving-average window every band-passed orbital ring figure on record was
  // scored with, so figures taken in this band are comparable to them, and
  // 3 px is three one-pixel radial bins per cycle.
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
