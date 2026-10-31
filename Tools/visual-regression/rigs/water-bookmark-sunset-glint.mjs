// Rig record for the demo bookmark "Sunset Glint" (Kauai sea level), re-clocked to a real sunset.
//
// @purpose Rig record for the Kauai sea-level sunset-glint pose (-159.505, 22.222, 14 m, heading 293 deg, pitch -10 deg) on the ellipsoid terrain with Natural Earth II imagery at 2026-06-22T04:50:00Z (sun 6.2 deg up at azimuth 292.8 deg), wave epoch pinned, globalWaterMask and enableEnhancedOcean on, both renderers (the enhanced styling is WebGPU), 1280x720, 120 settled frames.
// @status ACTIVE
//
// WHY THE DEMO CLOCK IS NOT USED. `LOCATIONS.seaLevel` in
// `packages/sandcastle/gallery/webgpu-global-water-weather/main.js` has time
// 2026-06-21T23:00:00Z, heading 310, pitch -18. At that instant the engine's own
// sun model puts the sun 84.9 deg up at the camera (local solar noon is about
// 22:38Z at lon -159.5), so there is no sunset and the specular glint point
// lies about 85 deg below the horizon, far outside the frame.
//
// DERIVATION (Node, the engine's own sun model). Sun direction:
// `Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(t)`
// rotated by `Transforms.computeIcrfToCentralBodyFixedMatrix(t)` (the pair
// `UniformStateComputations.setSunAndMoonDirections` uses without an ephemeris
// sample), then into the local frame of
// `Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(-159.505, 22.222, 14))`;
// elevation = asin(up), azimuth = atan2(east, north) clockwise from north.
//   2026-06-22T04:49:00Z  elevation 6.38 deg  azimuth 292.74 deg
//   2026-06-22T04:50:00Z  elevation 6.17 deg  azimuth 292.83 deg   <- chosen
//   2026-06-22T04:51:00Z  elevation 5.96 deg  azimuth 292.91 deg
// (04:30Z is 10.5 deg, 05:10Z is 1.9 deg: the window 3 to 8 deg is about 04:40Z
// to 05:05Z.) The chosen instant is a whole minute with the sun between 3 and 8
// deg up, and its azimuth is 17 deg from the demo heading 310.
//
// FRAME GEOMETRY. Heading is set to the sun azimuth (293 deg, rounded; the demo
// has 310) so the sun and its glint sit on the vertical centre line. Pitch is
// -10 deg (the demo has -18) so the horizon is in frame. The default
// `PerspectiveFrustum` has fov 60 deg on the wider axis, and at 1280x720 the
// engine reports fovy 35.98 deg, so the vertical half-FOV is 17.99 deg. With
// the camera at 14 m the horizon dip is about 0.12 deg (negligible). Offsets
// above the frame centre (pitch p = 10 deg, sun elevation e = 6.17 deg):
//   horizon       p            = 10.00 deg  (inside 17.99)
//   glint point   p - e        =  3.83 deg  (inside 17.99; the mirror point is
//                                            e below the horizon)
//   sun disc      p + e        = 16.17 deg  (inside 17.99, 1.8 deg to spare)
// so the horizon, the glint path and the setting sun are all in the frame. The
// camera position is the demo's. `waterSimulationEpoch` equals the clock.
// Natural Earth II imagery is local, so nothing streams ion.
//
// WHAT SHOWS. The sun glint on the sea at low sun. `enableEnhancedOcean` is
// consumed by `GlobeTerrain.wgsl`; on WebGL the glint is the classic water
// mask's specular.

export default Object.freeze({
  id: "water-bookmark-sunset-glint",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Kauai sea-level sunset-glint pose (-159.505, 22.222, 14 m, heading 293 deg, pitch -10 deg) on the ellipsoid terrain with Natural Earth II imagery at 2026-06-22T04:50:00Z, when the sun is 6.2 deg up at azimuth 292.8 deg, so the horizon, the sun glint path and the setting sun are in a 1280x720 frame; globalWaterMask and enableEnhancedOcean on.",
  declaredBy:
    "packages/sandcastle/gallery/webgpu-global-water-weather/main.js LOCATIONS.seaLevel (position only; clock, heading and pitch re-derived)",
  camera: {
    lon: -159.505,
    lat: 22.222,
    height: 14,
    heading: 5.113814708343385,
    pitch: -0.17453292519943295,
    roll: 0,
  },
  clock: "2026-06-22T04:50:00Z",
  dials: {
    pinClock: true,
    waterSimulationEpoch: "2026-06-22T04:50:00Z",
    terrain: "ellipsoid",
    imagery: "naturalEarth",
    globalWaterMask: true,
    lakeWaterMask: false,
    riverWaterMask: false,
    enableEnhancedOcean: true,
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 120,
  },
});
