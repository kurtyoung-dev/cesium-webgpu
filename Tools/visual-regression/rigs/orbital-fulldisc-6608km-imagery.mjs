// Rig record for the orbital full-disc recipe camera WITH imagery, so the
// severity of an orbital cloud artefact can be read over a planet rather than
// over a black disc.
//
// @purpose Rig record: the L5 orbital full-disc camera with imagery on and the globe left alone, the framing control for every figure measured over a deliberately blacked-out globe.
// @status ACTIVE
//
// WHY IT EXISTS. Every orbital ring figure on record - duty cycle, dark
// fraction, band onsets, spectral slope - was measured over a globe whose base
// colour was forced to black and whose imagery layers were removed. That is
// the right isolation for measuring the cloud field and the wrong frame for
// judging how bad the artefact looks to a user, because an arc that is the
// only thing in a black frame is not the same arc over continent and ocean.
// One capture settles that, and it costs one more arm on a leg that is already
// at this camera.
//
// It is otherwise the same camera as `orbital-fulldisc-6608km`: same altitude,
// same sub-solar point, same clock, same viewport, same deck, same tier, same
// settle count, same cloud dials. The only deliberate RENDER difference is the
// four globe dials, which is what makes the pair a single-variable comparison.
//
// ITS MEASUREMENT RADIUS IS THE **POLAR** SILHOUETTE AND THE SIBLING'S IS THE
// EQUATORIAL ONE, which is not an inconsistency but what oblateness costs a
// radial metric. WGS84's silhouette at this camera is an ELLIPSE:
//
//   equatorial  tan(asin(6378137.000 / 12986563.573)) * 1773.620 = 1000.000 px
//   polar       tan(asin(6356752.314 / 12986563.573)) * 1773.620 =  995.588 px
//
// On the blacked-out sibling the globe renders black, so there is no luminance
// step at either edge and a 1,000 px domain measures cloud over space exactly
// as it measures cloud over planet. HERE THE GLOBE IS DRAWN, so the 4.41 px
// annulus between the two radii carries a hard planet/space edge - and a hard
// edge inside the measured disc is the one thing `radialBanding`'s 21-bin
// detrend cannot remove. On a synthetic clean, ring-free, textured oblate disc
// at exactly this geometry, scoring at the equatorial 1,000 px reads a
// coherence five times the RED band on a frame with no rings in it, and
// scoring at the polar radius reads GREEN. `radial-banding.spec.mjs` builds
// that adversarial disc and pins both numbers, so the figure lives in an
// executed case rather than in this comment. (Sigismond, H2, 2026-09-19, found
// before this rig had ever been used.) The rule it generalises is in
// `lib/metrics/radial-banding.mjs`'s docstring: the stated radius must sit
// inside the SMALLEST silhouette.

export default Object.freeze({
  id: "orbital-fulldisc-6608km-imagery",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The orbital full-disc recipe camera with imagery on and the globe not blacked out - the framing control for every orbital cloud figure measured over a black planet.",
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
    globeBaseColor: null,
    globeEnableLighting: true,
    globeShowWaterEffect: false,
    removeImageryLayers: false,
  },
  disc: {
    focalPixels: 1773.6200269505305,
    // The POLAR silhouette, not the equatorial one — see the header. Derived,
    // not chosen: `tan(asin(6356752.314245179 / 12986563.573306667)) * focal`.
    discRadiusPixels: 995.5884034179564,
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
