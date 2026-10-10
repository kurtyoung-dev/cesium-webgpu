// Polyline family rig "polyline-nearclip": a PolylineCollection line that passes beneath and behind the camera, a BufferPolyline that passes above and behind it, a BufferPolyline that turns back on itself, and two straight BufferPolylines of three and five points, built from these dials by lib/polyline-rig-scene.mjs and captured by probe-polyline-appearance-primitive with --rigs polyline-nearclip.
//
// @purpose Polyline family rig "polyline-nearclip": a PolylineCollection line that passes beneath and behind the camera, a BufferPolyline that passes above and behind it, a BufferPolyline that turns back on itself, and two straight BufferPolylines of three and five points, built from these dials by lib/polyline-rig-scene.mjs and captured by probe-polyline-appearance-primitive with --rigs polyline-nearclip.
// @status ACTIVE

export default Object.freeze({
  id: "polyline-nearclip",
  tags: ["polyline"],
  page: null,
  renderers: ["webgl", "webgpu"],
  description:
    "The camera 1,000 m above 75 W 40 N looking due north and level, on black with the globe and sky hidden. A red width-8 PolylineCollection line runs along the meridian 5 m below the eye from about 200 m behind the camera to about 2 km ahead of it, so its one segment crosses the near plane; WebGL clips it there and draws a ribbon from the bottom edge to the horizon. A blue width-8 BufferPolyline mirrors it 5 m above the eye over the same span, so its segment crosses the near plane too and WebGL draws it from the top edge to the horizon, where it passes over the middle of the green ribbon. A green width-10 BufferPolyline about 3 km ahead and 200 m above the eye runs west to east and straight back (three points, a 180-degree turn at the east end), about 300 px wide on screen. Two straight width-10 BufferPolylines 3 km ahead run west to east in the lower right of the frame, clear of every other ribbon: a yellow one of three evenly spaced points 200 m below the eye and a magenta one of five 300 m below it, each from about 300 m to about 1,480 m east of the meridian (about 600 px to 950 px across). The green ribbon is the hairpin cell; the red and blue ribbons are the collection and buffer near-plane cells; the yellow and magenta ribbons are the straight-line coverage cell, whose interior vertices sit at texCoord 0.25, 0.5 and 0.75. Built from these dials by lib/polyline-rig-scene.mjs; no page renders it from its data alone.",
  camera: {
    lon: -75,
    lat: 40,
    height: 1000,
    heading: 0,
    pitch: 0,
    roll: 0,
  },
  clock: null,
  dials: {
    hide: ["globe", "skyBox", "sun", "moon", "skyAtmosphere"],
    polylines: [
      {
        name: "near-plane",
        collection: "PolylineCollection",
        positionsDegreesHeights: [-75, 39.998199, 995, -75, 40.018012, 995],
        width: 8,
        material: { type: "Color", color: [1, 0, 0, 1] },
      },
      {
        name: "hairpin",
        collection: "BufferPolylineCollection",
        positionsDegreesHeights: [
          -75.005855, 40.027019, 1200, -74.994145, 40.027019, 1200, -75.005855,
          40.027019, 1200,
        ],
        width: 10,
        material: { type: "Color", color: [0, 1, 0, 1] },
      },
      {
        name: "near-plane-buffer",
        collection: "BufferPolylineCollection",
        positionsDegreesHeights: [-75, 39.998199, 1005, -75, 40.018012, 1005],
        width: 8,
        material: { type: "Color", color: [0, 0, 1, 1] },
      },
      {
        name: "straight-3",
        collection: "BufferPolylineCollection",
        positionsDegreesHeights: [
          -74.996485, 40.027019, 800, -74.989574, 40.027019, 800, -74.982662,
          40.027019, 800,
        ],
        width: 10,
        material: { type: "Color", color: [1, 1, 0, 1] },
      },
      {
        name: "straight-5",
        collection: "BufferPolylineCollection",
        positionsDegreesHeights: [
          -74.996485, 40.027019, 700, -74.99303, 40.027019, 700, -74.989574,
          40.027019, 700, -74.986118, 40.027019, 700, -74.982662, 40.027019,
          700,
        ],
        width: 10,
        material: { type: "Color", color: [1, 0, 1, 1] },
      },
    ],
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 120,
  },
});
