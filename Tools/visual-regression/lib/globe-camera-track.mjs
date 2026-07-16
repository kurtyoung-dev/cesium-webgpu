export const GLOBE_CAMERA_TRACK_ID = "orbit-to-ground-global-v1";

export const GLOBE_CAMERA_TRACK_DURATION_SECONDS = 20;

/**
 * Shared orbit-to-ground camera route used by both the visual parity probe and
 * the performance campaign. Values are degrees/metres and are intentionally
 * plain serializable data so the route can be passed into Playwright pages.
 */
export const GLOBE_CAMERA_TRACK = Object.freeze(
  [
    {
      name: "orbit-globe-pacific",
      lon: -150,
      lat: 10,
      height: 18_000_000,
      heading: 0,
      pitch: -90,
      roll: 0,
    },
    {
      name: "orbit-americas",
      lon: -100,
      lat: 35,
      height: 6_000_000,
      heading: 20,
      pitch: -85,
      roll: 0,
    },
    {
      name: "descend-sierra",
      lon: -119.5,
      lat: 37.7,
      height: 900_000,
      heading: 35,
      pitch: -75,
      roll: 0,
    },
    {
      name: "descend-sf-coast",
      lon: -122.0,
      lat: 37.7,
      height: 300_000,
      heading: 55,
      pitch: -55,
      roll: 0,
    },
    {
      name: "low-oblique-sf",
      lon: -122.35,
      lat: 37.74,
      height: 60_000,
      heading: 75,
      pitch: -40,
      roll: 0,
    },
    {
      name: "city-sf",
      lon: -122.42,
      lat: 37.77,
      height: 12_000,
      heading: 90,
      pitch: -35,
      roll: 0,
    },
    {
      name: "near-ground-sf",
      lon: -122.42,
      lat: 37.78,
      height: 2_500,
      heading: 100,
      pitch: -20,
      roll: 0,
    },
    {
      name: "ground-sf",
      lon: -122.42,
      lat: 37.785,
      height: 300,
      heading: 110,
      pitch: -6,
      roll: 0,
    },
    {
      name: "orbit-himalaya",
      lon: 86.925,
      lat: 27.99,
      height: 2_500_000,
      heading: 0,
      pitch: -80,
      roll: 0,
    },
  ].map(Object.freeze),
);
