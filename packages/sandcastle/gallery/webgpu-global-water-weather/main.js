import * as Cesium from "cesium";

// Initialize Viewer with WebGPU backend
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
  timeline: false,
  animation: false,
  baseLayerPicker: true,
});

window.viewer = viewer;
const scene = viewer.scene;
const globe = scene.globe;

// Engine defaults captured once, so a slider moving back to its preset restores them
// instead of compounding on the last value written.
const FOAM_THRESHOLD_DEFAULT = globe.oceanFoamThreshold;
const OCEAN_DARKENING_DEFAULT = globe.oceanDarkening;

// Camera location presets: 6 vertical regimes plus the global water subtype sites.
// The page counts them and builds the altitude labels from this table.
const LOCATIONS = {
  // --- 6 Vertical Regimes (Orbit -> Hadal Trench) ---
  orbit: {
    subtype: "REGIME_ORBIT",
    destination: Cesium.Cartesian3.fromDegrees(-77.5, 24.5, 450000),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-72),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T16:30:00Z"),
  },
  atmosphere: {
    subtype: "REGIME_ATMOSPHERE",
    destination: Cesium.Cartesian3.fromDegrees(-49.6, 0.15, 42000),
    orientation: {
      heading: Cesium.Math.toRadians(125),
      pitch: Cesium.Math.toRadians(-42),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T14:00:00Z"),
  },
  flight: {
    subtype: "REGIME_FLIGHT",
    destination: Cesium.Cartesian3.fromDegrees(-159.505, 22.252, 2200),
    orientation: {
      heading: Cesium.Math.toRadians(185),
      pitch: Cesium.Math.toRadians(-28),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T22:00:00Z"),
  },
  seaLevel: {
    subtype: "REGIME_SEA_LEVEL",
    destination: Cesium.Cartesian3.fromDegrees(-159.505, 22.222, 14),
    orientation: {
      heading: Cesium.Math.toRadians(310),
      pitch: Cesium.Math.toRadians(-18),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T23:00:00Z"),
  },
  shallowUnderwater: {
    subtype: "REGIME_PHOTIC_REEF",
    destination: Cesium.Cartesian3.fromDegrees(-77.5, 24.5, 18),
    orientation: {
      heading: Cesium.Math.toRadians(20),
      pitch: Cesium.Math.toRadians(-20),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T16:30:00Z"),
    diveDepth: 18,
  },
  deepUnderwater: {
    subtype: "REGIME_ABYSSAL_TRENCH",
    destination: Cesium.Cartesian3.fromDegrees(142.2, 11.35, 28),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-22),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T02:00:00Z"),
    diveDepth: 4800,
  },

  // --- Subtype 1: Open Ocean & Coral Lagoons (WaterType.OCEAN) ---
  kauai: {
    subtype: "OCEAN",
    destination: Cesium.Cartesian3.fromDegrees(-159.505, 22.252, 2200),
    orientation: {
      heading: Cesium.Math.toRadians(185),
      pitch: Cesium.Math.toRadians(-28),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T22:00:00Z"),
  },
  bahamas: {
    subtype: "OCEAN",
    destination: Cesium.Cartesian3.fromDegrees(-77.66, 24.45, 6500),
    orientation: {
      heading: Cesium.Math.toRadians(265),
      pitch: Cesium.Math.toRadians(-34),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T16:00:00Z"),
  },
  atlantic: {
    subtype: "OCEAN",
    destination: Cesium.Cartesian3.fromDegrees(-65.0, 32.0, 8000),
    orientation: {
      heading: Cesium.Math.toRadians(45),
      pitch: Cesium.Math.toRadians(-28),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T15:00:00Z"),
  },
  greatBarrierReef: {
    subtype: "OCEAN",
    destination: Cesium.Cartesian3.fromDegrees(147.7, -18.28, 3400),
    orientation: {
      heading: Cesium.Math.toRadians(215),
      pitch: Cesium.Math.toRadians(-28),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T03:00:00Z"),
  },
  boraBoraLagoon: {
    subtype: "OCEAN",
    destination: Cesium.Cartesian3.fromDegrees(-151.74, -16.5, 2400),
    orientation: {
      heading: Cesium.Math.toRadians(140),
      pitch: Cesium.Math.toRadians(-27),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T21:30:00Z"),
  },
  maldivesAtoll: {
    subtype: "OCEAN",
    destination: Cesium.Cartesian3.fromDegrees(73.51, 4.18, 2800),
    orientation: {
      heading: Cesium.Math.toRadians(310),
      pitch: Cesium.Math.toRadians(-28),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T08:00:00Z"),
  },
  marianaChallenger: {
    subtype: "OCEAN",
    destination: Cesium.Cartesian3.fromDegrees(142.2, 11.35, 5200),
    orientation: {
      heading: Cesium.Math.toRadians(35),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T03:30:00Z"),
  },
  drakePassageGale: {
    subtype: "OCEAN",
    destination: Cesium.Cartesian3.fromDegrees(-65.5, -58.5, 4200),
    orientation: {
      heading: Cesium.Math.toRadians(95),
      pitch: Cesium.Math.toRadians(-26),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-12-21T16:00:00Z"),
  },
  vancouverIslandFjord: {
    subtype: "OCEAN",
    destination: Cesium.Cartesian3.fromDegrees(-125.905, 49.152, 2200),
    orientation: {
      heading: Cesium.Math.toRadians(320),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T20:00:00Z"),
  },
  norwayGeirangerfjord: {
    subtype: "OCEAN",
    destination: Cesium.Cartesian3.fromDegrees(7.095, 62.105, 1950),
    orientation: {
      heading: Cesium.Math.toRadians(265),
      pitch: Cesium.Math.toRadians(-26),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T12:30:00Z"),
  },
  rajaAmpatLagoon: {
    subtype: "OCEAN",
    destination: Cesium.Cartesian3.fromDegrees(130.28, -0.56, 1350),
    orientation: {
      heading: Cesium.Math.toRadians(315),
      pitch: Cesium.Math.toRadians(-28),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T03:30:00Z"),
  },
  milfordSoundFjord: {
    subtype: "OCEAN",
    destination: Cesium.Cartesian3.fromDegrees(167.89, -44.64, 1850),
    orientation: {
      heading: Cesium.Math.toRadians(310),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-12-21T02:00:00Z"),
  },

  // --- Subtype 2: Arctic & Antarctic Polar Sea Ice (Polar Pack Ice, Pancake Floes & Glacial Fjords) ---
  polar: {
    subtype: "POLAR_SEA_ICE",
    polar: true,
    destination: Cesium.Cartesian3.fromDegrees(-45.0, -72.0, 2000),
    orientation: {
      heading: Cesium.Math.toRadians(180),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-12-21T15:00:00Z"),
  },
  arcticSvalbard: {
    subtype: "POLAR_SEA_ICE",
    polar: true,
    destination: Cesium.Cartesian3.fromDegrees(15.38, 78.23, 1450),
    orientation: {
      heading: Cesium.Math.toRadians(340),
      pitch: Cesium.Math.toRadians(-18),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T12:00:00Z"),
  },
  arcticIlulissat: {
    subtype: "POLAR_SEA_ICE",
    polar: true,
    destination: Cesium.Cartesian3.fromDegrees(-51.08, 69.21, 1450),
    orientation: {
      heading: Cesium.Math.toRadians(295),
      pitch: Cesium.Math.toRadians(-18),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T15:30:00Z"),
  },
  arcticBaffin: {
    subtype: "POLAR_SEA_ICE",
    polar: true,
    destination: Cesium.Cartesian3.fromDegrees(-77.95, 72.7, 2100),
    orientation: {
      heading: Cesium.Math.toRadians(45),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T17:00:00Z"),
  },
  antarcticPeninsula: {
    subtype: "POLAR_SEA_ICE",
    polar: true,
    destination: Cesium.Cartesian3.fromDegrees(-64.05, -64.77, 1900),
    orientation: {
      heading: Cesium.Math.toRadians(195),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-12-21T16:30:00Z"),
  },

  // --- Subtype 3: Inland & Marginal Seas (WaterType.SEA) ---
  caspianInlandSea: {
    subtype: "SEA",
    destination: Cesium.Cartesian3.fromDegrees(50.36, 40.32, 2200),
    orientation: {
      heading: Cesium.Math.toRadians(285),
      pitch: Cesium.Math.toRadians(-26),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T09:00:00Z"),
  },
  caspianVolgaDelta: {
    subtype: "SEA",
    destination: Cesium.Cartesian3.fromDegrees(47.95, 45.68, 2200),
    orientation: {
      heading: Cesium.Math.toRadians(165),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T09:30:00Z"),
  },
  mediterraneanSantorini: {
    subtype: "SEA",
    destination: Cesium.Cartesian3.fromDegrees(25.42, 36.4, 2100),
    orientation: {
      heading: Cesium.Math.toRadians(285),
      pitch: Cesium.Math.toRadians(-26),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T11:00:00Z"),
  },
  redSeaCoral: {
    subtype: "SEA",
    destination: Cesium.Cartesian3.fromDegrees(34.02, 27.22, 2300),
    orientation: {
      heading: Cesium.Math.toRadians(145),
      pitch: Cesium.Math.toRadians(-26),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T10:00:00Z"),
  },
  blackSeaCrimea: {
    subtype: "SEA",
    destination: Cesium.Cartesian3.fromDegrees(34.15, 44.42, 2500),
    orientation: {
      heading: Cesium.Math.toRadians(195),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T10:30:00Z"),
  },
  balticArchipelago: {
    subtype: "SEA",
    destination: Cesium.Cartesian3.fromDegrees(19.95, 60.15, 2200),
    orientation: {
      heading: Cesium.Math.toRadians(225),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T11:30:00Z"),
  },
  haLongBayKarst: {
    subtype: "SEA",
    destination: Cesium.Cartesian3.fromDegrees(107.085, 20.845, 1650),
    orientation: {
      heading: Cesium.Math.toRadians(135),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T04:30:00Z"),
  },

  // --- Subtype 4: Swamps & Cypress Bayous (WaterType.SWAMP) ---
  evergladesSwamp: {
    subtype: "SWAMP",
    destination: Cesium.Cartesian3.fromDegrees(-80.78, 26.92, 920),
    orientation: {
      heading: Cesium.Math.toRadians(255),
      pitch: Cesium.Math.toRadians(-22),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T15:30:00Z"),
  },
  atchafalayaBayou: {
    subtype: "SWAMP",
    destination: Cesium.Cartesian3.fromDegrees(-91.45, 29.88, 900),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T16:30:00Z"),
  },
  sundarbansMangrove: {
    subtype: "SWAMP",
    destination: Cesium.Cartesian3.fromDegrees(89.18, 21.95, 1350),
    orientation: {
      heading: Cesium.Math.toRadians(185),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T06:30:00Z"),
  },
  okavangoDelta: {
    subtype: "SWAMP",
    destination: Cesium.Cartesian3.fromDegrees(22.92, -19.28, 1350),
    orientation: {
      heading: Cesium.Math.toRadians(140),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T10:30:00Z"),
  },

  // --- Subtype 5: Freshwater Marshes & Reed Wetlands (WaterType.WETLAND) ---
  danubeWetland: {
    subtype: "WETLAND",
    destination: Cesium.Cartesian3.fromDegrees(29.55, 45.15, 1250),
    orientation: {
      heading: Cesium.Math.toRadians(110),
      pitch: Cesium.Math.toRadians(-23),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T10:30:00Z"),
  },
  pantanalWetland: {
    subtype: "WETLAND",
    destination: Cesium.Cartesian3.fromDegrees(-57.45, -17.85, 1300),
    orientation: {
      heading: Cesium.Math.toRadians(145),
      pitch: Cesium.Math.toRadians(-23),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T14:30:00Z"),
  },
  camargueWetland: {
    subtype: "WETLAND",
    destination: Cesium.Cartesian3.fromDegrees(4.55, 43.48, 1250),
    orientation: {
      heading: Cesium.Math.toRadians(175),
      pitch: Cesium.Math.toRadians(-23),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T12:00:00Z"),
  },
  lencoisMaranhenses: {
    subtype: "WETLAND",
    destination: Cesium.Cartesian3.fromDegrees(-43.12, -2.48, 1250),
    orientation: {
      heading: Cesium.Math.toRadians(285),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T14:00:00Z"),
  },

  // --- Subtype 6: Tannin Blackwater Rivers (WaterType.BLACKWATER_RIVER) ---
  rioNegroBlackwater: {
    subtype: "BLACKWATER_RIVER",
    destination: Cesium.Cartesian3.fromDegrees(-60.047, -3.135, 1200),
    orientation: {
      heading: Cesium.Math.toRadians(180),
      pitch: Cesium.Math.toRadians(-32),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T14:30:00Z"),
  },
  orinocoAtabapoBlackwater: {
    subtype: "BLACKWATER_RIVER",
    destination: Cesium.Cartesian3.fromDegrees(-67.68, 3.95, 1400),
    orientation: {
      heading: Cesium.Math.toRadians(35),
      pitch: Cesium.Math.toRadians(-23),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T15:00:00Z"),
  },

  // --- Subtype 7: Ancient Tectonic Rift Lakes (WaterType.ANCIENT_RIFT_LAKE) ---
  baikalRift: {
    subtype: "ANCIENT_RIFT_LAKE",
    destination: Cesium.Cartesian3.fromDegrees(106.875, 53.028, 1450),
    orientation: {
      heading: Cesium.Math.toRadians(18),
      pitch: Cesium.Math.toRadians(-23),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T06:00:00Z"),
  },
  tanganyikaRift: {
    subtype: "ANCIENT_RIFT_LAKE",
    destination: Cesium.Cartesian3.fromDegrees(29.35, -5.9, 1850),
    orientation: {
      heading: Cesium.Math.toRadians(285),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T10:30:00Z"),
  },
  malawiRift: {
    subtype: "ANCIENT_RIFT_LAKE",
    destination: Cesium.Cartesian3.fromDegrees(34.28, -11.65, 1650),
    orientation: {
      heading: Cesium.Math.toRadians(115),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T10:00:00Z"),
  },
  issykKulRift: {
    subtype: "ANCIENT_RIFT_LAKE",
    destination: Cesium.Cartesian3.fromDegrees(77.25, 42.62, 2400),
    orientation: {
      heading: Cesium.Math.toRadians(175),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T07:30:00Z"),
  },

  // --- Subtype 8: Deep Glacial Rock-Flour & Alpine Lakes (WaterType.DEEP_GLACIAL_LAKE) ---
  rockiesGlacial: {
    subtype: "DEEP_GLACIAL_LAKE",
    destination: Cesium.Cartesian3.fromDegrees(-116.825, 49.525, 1950),
    orientation: {
      heading: Cesium.Math.toRadians(350),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T19:00:00Z"),
  },
  patagoniaGlacial: {
    subtype: "DEEP_GLACIAL_LAKE",
    destination: Cesium.Cartesian3.fromDegrees(-72.85, -50.25, 1750),
    orientation: {
      heading: Cesium.Math.toRadians(265),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-12-21T16:30:00Z"),
  },
  pukakiGlacial: {
    subtype: "DEEP_GLACIAL_LAKE",
    destination: Cesium.Cartesian3.fromDegrees(170.16, -44.12, 1650),
    orientation: {
      heading: Cesium.Math.toRadians(355),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-12-21T02:30:00Z"),
  },
  tahoeAlpine: {
    subtype: "DEEP_GLACIAL_LAKE",
    destination: Cesium.Cartesian3.fromDegrees(-120.08, 39.08, 2650),
    orientation: {
      heading: Cesium.Math.toRadians(75),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T19:30:00Z"),
  },
  lakeComoItaly: {
    subtype: "DEEP_GLACIAL_LAKE",
    destination: Cesium.Cartesian3.fromDegrees(9.262, 46.002, 1650),
    orientation: {
      heading: Cesium.Math.toRadians(195),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T11:30:00Z"),
  },
  plitviceTravertine: {
    subtype: "DEEP_GLACIAL_LAKE",
    destination: Cesium.Cartesian3.fromDegrees(15.616, 44.882, 1050),
    orientation: {
      heading: Cesium.Math.toRadians(320),
      pitch: Cesium.Math.toRadians(-32),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T11:00:00Z"),
  },

  // --- Subtype 9: Hypersaline Brine Basins (WaterType.HYPERSALINE_LAKE) ---
  deadSeaBrine: {
    subtype: "HYPERSALINE_LAKE",
    destination: Cesium.Cartesian3.fromDegrees(35.402, 31.515, 1650),
    orientation: {
      heading: Cesium.Math.toRadians(355),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T10:30:00Z"),
  },
  greatSaltLakeBrine: {
    subtype: "HYPERSALINE_LAKE",
    destination: Cesium.Cartesian3.fromDegrees(-112.22, 40.95, 2200),
    orientation: {
      heading: Cesium.Math.toRadians(315),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T19:00:00Z"),
  },
  urmiaBrine: {
    subtype: "HYPERSALINE_LAKE",
    destination: Cesium.Cartesian3.fromDegrees(45.35, 37.65, 2100),
    orientation: {
      heading: Cesium.Math.toRadians(135),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T09:30:00Z"),
  },
  balkhashBrine: {
    subtype: "HYPERSALINE_LAKE",
    destination: Cesium.Cartesian3.fromDegrees(74.85, 46.15, 1650),
    orientation: {
      heading: Cesium.Math.toRadians(15),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T08:00:00Z"),
  },
  sharkBayAustralia: {
    subtype: "HYPERSALINE_LAKE",
    destination: Cesium.Cartesian3.fromDegrees(113.82, -25.92, 1850),
    orientation: {
      heading: Cesium.Math.toRadians(315),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-12-21T04:30:00Z"),
  },

  // --- Subtype 10: Continental Freshwater Lakes (WaterType.LAKE) ---
  superiorFreshLake: {
    subtype: "LAKE",
    destination: Cesium.Cartesian3.fromDegrees(-90.65, 46.92, 1650),
    orientation: {
      heading: Cesium.Math.toRadians(45),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T17:30:00Z"),
  },
  victoriaFreshLake: {
    subtype: "LAKE",
    destination: Cesium.Cartesian3.fromDegrees(32.48, 0.02, 2100),
    orientation: {
      heading: Cesium.Math.toRadians(145),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T10:30:00Z"),
  },
  titicacaFreshLake: {
    subtype: "LAKE",
    destination: Cesium.Cartesian3.fromDegrees(-69.18, -16.15, 4750),
    orientation: {
      heading: Cesium.Math.toRadians(315),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T15:30:00Z"),
  },
  genevaFreshLake: {
    subtype: "LAKE",
    destination: Cesium.Cartesian3.fromDegrees(6.55, 46.42, 1450),
    orientation: {
      heading: Cesium.Math.toRadians(195),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T12:00:00Z"),
  },
  lakeGeorgeNY: {
    subtype: "LAKE",
    destination: Cesium.Cartesian3.fromDegrees(-73.625, 43.565, 1450),
    orientation: {
      heading: Cesium.Math.toRadians(25),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T16:00:00Z"),
  },
  lakePlacidNY: {
    subtype: "LAKE",
    destination: Cesium.Cartesian3.fromDegrees(-73.982, 44.298, 1450),
    orientation: {
      heading: Cesium.Math.toRadians(205),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T16:00:00Z"),
  },
  tonleSapBasin: {
    subtype: "LAKE",
    destination: Cesium.Cartesian3.fromDegrees(104.05, 12.88, 1650),
    orientation: {
      heading: Cesium.Math.toRadians(135),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T05:30:00Z"),
  },

  // --- Subtype 11: Wide River Channels & Braided Reaches (WaterType.RIVER_AREA) ---
  amazonManausRiver: {
    subtype: "RIVER_AREA",
    destination: Cesium.Cartesian3.fromDegrees(-59.95, -3.17, 1350),
    orientation: {
      heading: Cesium.Math.toRadians(80),
      pitch: Cesium.Math.toRadians(-28),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T14:30:00Z"),
  },
  paranaRiver: {
    subtype: "RIVER_AREA",
    destination: Cesium.Cartesian3.fromDegrees(-60.62, -32.95, 1450),
    orientation: {
      heading: Cesium.Math.toRadians(155),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T15:00:00Z"),
  },
  congoRiver: {
    subtype: "RIVER_AREA",
    destination: Cesium.Cartesian3.fromDegrees(15.3, -4.3, 1450),
    orientation: {
      heading: Cesium.Math.toRadians(245),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T11:30:00Z"),
  },
  ohioMississippiConfluence: {
    subtype: "RIVER_AREA",
    destination: Cesium.Cartesian3.fromDegrees(-89.138, 36.968, 1450),
    orientation: {
      heading: Cesium.Math.toRadians(335),
      pitch: Cesium.Math.toRadians(-32),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T17:00:00Z"),
  },
  pittsburghThreeRivers: {
    subtype: "RIVER_AREA",
    destination: Cesium.Cartesian3.fromDegrees(-80.025, 40.448, 3400),
    orientation: {
      heading: Cesium.Math.toRadians(115),
      pitch: Cesium.Math.toRadians(-34),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T16:30:00Z"),
  },
  yangtzeThreeGorges: {
    subtype: "RIVER_AREA",
    destination: Cesium.Cartesian3.fromDegrees(110.82, 30.98, 1650),
    orientation: {
      heading: Cesium.Math.toRadians(105),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T04:30:00Z"),
  },

  // --- Subtype 12: Strahler Centerline River Corridors (WaterType.RIVER_LINE) ---
  mississippiRiver: {
    subtype: "RIVER_LINE",
    destination: Cesium.Cartesian3.fromDegrees(-90.059, 29.948, 1050),
    orientation: {
      heading: Cesium.Math.toRadians(180),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T16:30:00Z"),
  },
  nileRiver: {
    subtype: "RIVER_LINE",
    destination: Cesium.Cartesian3.fromDegrees(31.23, 30.05, 1350),
    orientation: {
      heading: Cesium.Math.toRadians(5),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T10:30:00Z"),
  },
  mekongRiver: {
    subtype: "RIVER_LINE",
    destination: Cesium.Cartesian3.fromDegrees(104.94, 11.56, 1350),
    orientation: {
      heading: Cesium.Math.toRadians(165),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T06:00:00Z"),
  },

  // --- Subtype 13: Macro-Tidal Bays & Turbid Estuaries (WaterType.ESTUARY) ---
  surge: {
    subtype: "ESTUARY",
    destination: Cesium.Cartesian3.fromDegrees(-1.535, 48.685, 3200),
    orientation: {
      heading: Cesium.Math.toRadians(160),
      pitch: Cesium.Math.toRadians(-24),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T12:00:00Z"),
  },
  amazonMouthEstuary: {
    subtype: "ESTUARY",
    destination: Cesium.Cartesian3.fromDegrees(-49.6, 0.15, 3400),
    orientation: {
      heading: Cesium.Math.toRadians(125),
      pitch: Cesium.Math.toRadians(-26),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T14:00:00Z"),
  },
  gangesEstuary: {
    subtype: "ESTUARY",
    destination: Cesium.Cartesian3.fromDegrees(90.65, 22.35, 2800),
    orientation: {
      heading: Cesium.Math.toRadians(185),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T06:30:00Z"),
  },
  chesapeakeEstuary: {
    subtype: "ESTUARY",
    destination: Cesium.Cartesian3.fromDegrees(-76.32, 37.0, 2600),
    orientation: {
      heading: Cesium.Math.toRadians(35),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T15:30:00Z"),
  },
  miamiIntracoastal: {
    subtype: "ESTUARY",
    destination: Cesium.Cartesian3.fromDegrees(-80.145, 25.825, 1450),
    orientation: {
      heading: Cesium.Math.toRadians(185),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T15:30:00Z"),
  },
  sanibelCaloosahatchee: {
    subtype: "ESTUARY",
    destination: Cesium.Cartesian3.fromDegrees(-82.035, 26.475, 1950),
    orientation: {
      heading: Cesium.Math.toRadians(305),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T15:30:00Z"),
  },
  tampaBayEstuary: {
    subtype: "ESTUARY",
    destination: Cesium.Cartesian3.fromDegrees(-82.655, 27.625, 2200),
    orientation: {
      heading: Cesium.Math.toRadians(45),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T15:30:00Z"),
  },
  sanFranciscoBay: {
    subtype: "ESTUARY",
    destination: Cesium.Cartesian3.fromDegrees(-122.465, 37.82, 2200),
    orientation: {
      heading: Cesium.Math.toRadians(80),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T19:30:00Z"),
  },
  veniceLagoonCanals: {
    subtype: "ESTUARY",
    destination: Cesium.Cartesian3.fromDegrees(12.332, 45.438, 1350),
    orientation: {
      heading: Cesium.Math.toRadians(115),
      pitch: Cesium.Math.toRadians(-26),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T11:00:00Z"),
  },
  bayOfFundyTides: {
    subtype: "ESTUARY",
    destination: Cesium.Cartesian3.fromDegrees(-64.35, 45.32, 2200),
    orientation: {
      heading: Cesium.Math.toRadians(75),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T15:00:00Z"),
  },
  waddenSeaTidalFlats: {
    subtype: "ESTUARY",
    destination: Cesium.Cartesian3.fromDegrees(8.42, 54.88, 2200),
    orientation: {
      heading: Cesium.Math.toRadians(355),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T11:30:00Z"),
  },
  riaFormosaLagoon: {
    subtype: "ESTUARY",
    destination: Cesium.Cartesian3.fromDegrees(-7.86, 36.99, 1650),
    orientation: {
      heading: Cesium.Math.toRadians(295),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T12:30:00Z"),
  },
  keralaBackwaters: {
    subtype: "ESTUARY",
    destination: Cesium.Cartesian3.fromDegrees(76.38, 9.62, 1650),
    orientation: {
      heading: Cesium.Math.toRadians(345),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
    time: Cesium.JulianDate.fromIso8601("2026-06-21T07:00:00Z"),
  },
};

// Quality presets: Low, Medium, High
const PRESETS = {
  low: {
    name: "Low",
    description:
      "Low: Global vector coastline & river masks, fast illumination, 1.0x equilibrium tides, gentle breeze, zero storm surge, minimal particle workload. Optimized for maximum FPS.",
    oceanEnabled: true,
    riverMaskEnabled: true,
    enhancedOcean: false,
    celestialGlint: false,
    tideExaggeration: 1.0,
    windSpeed: 4.0,
    mslp: 1013.25,
    jerlovType: 2,
    depth: 50,
    bathymetricReliefBoost: 1.0,
    submersibleLightEnabled: false,
    submersibleLightIntensity: 1.0,
    weatherEnabled: true,
    temperature: 20,
    precipIntensity: 0.2,
  },
  medium: {
    name: "Medium",
    description:
      "Medium: Global vector coastline & river masks, multi-octave ocean waves, Cox-Munk glint, Jerlov ocean darkening, surf swash, 2.0x tides. Balanced 60 FPS fidelity.",
    oceanEnabled: true,
    riverMaskEnabled: true,
    enhancedOcean: true,
    celestialGlint: true,
    tideExaggeration: 2.0,
    windSpeed: 8.5,
    mslp: 1013.25,
    jerlovType: 2,
    depth: 30,
    bathymetricReliefBoost: 1.35,
    submersibleLightEnabled: false,
    submersibleLightIntensity: 1.0,
    weatherEnabled: true,
    temperature: 15,
    precipIntensity: 0.5,
  },
  high: {
    name: "High",
    description:
      "High: Full 6-regime hydrosphere, chromatic photic caustics, Snell's Window, 5.0x dynamic tide shoreline displacement, barometric surge (+0.53m), maximum realism.",
    oceanEnabled: true,
    riverMaskEnabled: true,
    enhancedOcean: true,
    celestialGlint: true,
    tideExaggeration: 5.0,
    windSpeed: 21.0,
    mslp: 960.0,
    jerlovType: 2,
    depth: 15,
    bathymetricReliefBoost: 1.75,
    submersibleLightEnabled: false,
    submersibleLightIntensity: 1.2,
    weatherEnabled: true,
    temperature: 22,
    precipIntensity: 0.25,
  },
};

// Labels and counts come from LOCATIONS so the page cannot drift from the data. The
// two underwater regimes keep the camera above the surface and simulate depth through
// globe.water.diveDepthMeters, so their label says "simulated depth".
function describeLocationHeight(loc) {
  if (loc.diveDepth > 0) {
    return `simulated depth ${formatMeters(loc.diveDepth)}`;
  }
  const carto = Cesium.Cartographic.fromCartesian(loc.destination);
  return formatMeters(carto ? carto.height : 0);
}

function formatMeters(meters) {
  return Math.abs(meters) >= 1000
    ? `${(meters / 1000).toFixed(1)} km`
    : `${Math.round(meters)} m`;
}

function refreshLocationLabels() {
  document.querySelectorAll("[data-loc]").forEach((el) => {
    const loc = LOCATIONS[el.dataset.loc];
    if (loc) {
      el.textContent = `${el.dataset.name} (${describeLocationHeight(loc)})`;
    }
  });
  const siteCount = document.getElementById("siteCount");
  if (siteCount) {
    siteCount.textContent = String(Object.keys(LOCATIONS).length);
  }
}

window.currentTier = "medium";
const state = {
  ...PRESETS.medium,
  simulatedDiveDepth: 0,
  disableWaterCollision: true,
  nearSurfaceTransparency: 0.78,
};

// Beaufort scale names
const BEAUFORT_NAMES = [
  "Calm",
  "Light Air",
  "Light Breeze",
  "Gentle Breeze",
  "Moderate Breeze",
  "Fresh Breeze",
  "Strong Breeze",
  "High Wind",
  "Gale",
  "Strong Gale",
  "Storm",
  "Violent Storm",
  "Hurricane",
];

function getBeaufortNumber(windMps) {
  const b = Math.pow(windMps / 0.836, 2.0 / 3.0);
  return Math.min(12, Math.max(0, Math.round(b)));
}

// UI Elements
const dom = {
  btnLow: document.getElementById("btnLow"),
  btnMedium: document.getElementById("btnMedium"),
  btnHigh: document.getElementById("btnHigh"),
  presetDesc: document.getElementById("presetDescription"),
  regimeReadout: document.getElementById("regimeReadout"),
  oceanEnabled: document.getElementById("oceanEnabled"),
  riverMaskEnabled: document.getElementById("riverMaskEnabled"),
  enhancedOcean: document.getElementById("enhancedOcean"),
  celestialGlint: document.getElementById("celestialGlint"),
  tideExaggeration: document.getElementById("tideExaggeration"),
  tideReadout: document.getElementById("tideReadout"),
  windSpeed: document.getElementById("windSpeed"),
  windSpeedReadout: document.getElementById("windSpeedReadout"),
  mslp: document.getElementById("mslp"),
  mslpReadout: document.getElementById("mslpReadout"),
  surgeReadout: document.getElementById("surgeReadout"),
  disableWaterCollision: document.getElementById("disableWaterCollision"),
  nearSurfaceTransparency: document.getElementById("nearSurfaceTransparency"),
  nearSurfaceTransReadout: document.getElementById("nearSurfaceTransReadout"),
  jerlovType: document.getElementById("jerlovType"),
  bathymetryDepth: document.getElementById("bathymetryDepth"),
  depthReadout: document.getElementById("depthReadout"),
  bathymetricReliefBoost: document.getElementById("bathymetricReliefBoost"),
  reliefBoostReadout: document.getElementById("reliefBoostReadout"),
  submersibleLightEnabled: document.getElementById("submersibleLightEnabled"),
  submersibleLightIntensity: document.getElementById(
    "submersibleLightIntensity",
  ),
  rovIntensityReadout: document.getElementById("rovIntensityReadout"),
  weatherEnabled: document.getElementById("weatherEnabled"),
  temperature: document.getElementById("temperature"),
  tempReadout: document.getElementById("tempReadout"),
  precipIntensity: document.getElementById("precipIntensity"),
  intensityReadout: document.getElementById("intensityReadout"),
  precipPhaseReadout: document.getElementById("precipPhaseReadout"),
};

function updateRegimeReadout() {
  if (!dom.regimeReadout) {
    return;
  }
  const carto = viewer.camera.positionCartographic;
  const rawH = carto ? carto.height : 2500;
  const liveDiveDepth = Math.max(
    state.simulatedDiveDepth || 0,
    globe.water?.diveDepthMeters || 0,
  );
  const h = liveDiveDepth > 0 && rawH < 100 ? -liveDiveDepth : rawH;
  let regimeName = "in_flight";
  if (
    globe.water &&
    typeof globe.water.evaluateRegimeAtAltitude === "function"
  ) {
    const evalState = globe.water.evaluateRegimeAtAltitude(h);
    regimeName =
      typeof evalState === "string"
        ? evalState
        : evalState?.underwaterProfile && h < 0
          ? `${evalState.regime} / ${evalState.underwaterProfile.pelagicZone}`
          : (evalState?.regime ?? "in_flight");
  }
  const altStr =
    Math.abs(h) >= 1000 ? `${(h / 1000).toFixed(1)} km` : `${Math.round(h)} m`;
  dom.regimeReadout.textContent = `${regimeName} (${altStr})`;
}

function updateUiFromState() {
  dom.oceanEnabled.checked = state.oceanEnabled;
  if (dom.riverMaskEnabled) {
    dom.riverMaskEnabled.checked = state.riverMaskEnabled ?? true;
  }
  if (dom.enhancedOcean) {
    dom.enhancedOcean.checked = state.enhancedOcean;
  }
  dom.celestialGlint.checked = state.celestialGlint;
  if (dom.tideExaggeration) {
    dom.tideExaggeration.value = state.tideExaggeration ?? 1.0;
    dom.tideReadout.textContent = `${(state.tideExaggeration ?? 1.0).toFixed(1)}x`;
  }
  dom.windSpeed.value = state.windSpeed;
  dom.mslp.value = state.mslp;
  if (dom.disableWaterCollision) {
    dom.disableWaterCollision.checked = Boolean(
      state.disableWaterCollision ?? true,
    );
  }
  if (dom.nearSurfaceTransparency) {
    const trans = state.nearSurfaceTransparency ?? 0.78;
    dom.nearSurfaceTransparency.value = trans;
    if (dom.nearSurfaceTransReadout) {
      dom.nearSurfaceTransReadout.textContent = `${Math.round(trans * 100)}%`;
    }
  }
  dom.jerlovType.value = String(state.jerlovType);
  dom.bathymetryDepth.value = state.depth;
  if (dom.bathymetricReliefBoost) {
    const boost = state.bathymetricReliefBoost ?? 1.35;
    dom.bathymetricReliefBoost.value = boost;
    if (dom.reliefBoostReadout) {
      dom.reliefBoostReadout.textContent = `${boost.toFixed(2)}x`;
    }
  }
  if (dom.submersibleLightEnabled) {
    dom.submersibleLightEnabled.checked = Boolean(
      state.submersibleLightEnabled,
    );
  }
  if (dom.submersibleLightIntensity) {
    const intensity = state.submersibleLightIntensity ?? 1.0;
    dom.submersibleLightIntensity.value = intensity;
    if (dom.rovIntensityReadout) {
      dom.rovIntensityReadout.textContent = intensity.toFixed(1);
    }
  }
  dom.weatherEnabled.checked = state.weatherEnabled;
  dom.temperature.value = state.temperature;
  dom.precipIntensity.value = state.precipIntensity;

  // Readouts
  const bNum = getBeaufortNumber(state.windSpeed);
  dom.windSpeedReadout.textContent = `${state.windSpeed.toFixed(1)} m/s (B${bNum} ${BEAUFORT_NAMES[bNum]})`;
  dom.mslpReadout.textContent = `${Math.round(state.mslp)} hPa`;

  const surgeM = (1013.25 - state.mslp) * 0.01;
  const sign = surgeM >= 0 ? "+" : "";
  dom.surgeReadout.textContent = `${sign}${surgeM.toFixed(2)} m`;
  dom.surgeReadout.style.color = surgeM > 0.3 ? "#ff7b72" : "#4ec9b0";

  dom.depthReadout.textContent = `${state.depth} m`;
  dom.tempReadout.textContent = `${state.temperature} °C`;
  dom.intensityReadout.textContent = state.precipIntensity.toFixed(2);

  const isSnow = state.temperature <= 0;
  dom.precipPhaseReadout.textContent = isSnow ? "Snow (Subzero)" : "Rain";
  dom.precipPhaseReadout.style.color = isSnow ? "#79c0ff" : "#dcdcaa";
  updateRegimeReadout();
}

function applySettingsToEngine() {
  // 1. Ocean & Hydrosphere settings
  const tierKey = window.currentTier || "medium";
  const tierBase = PRESETS[tierKey] || PRESETS.medium;
  if (globe.water) {
    globe.water.qualityPreset = tierKey;
    globe.water.disableWaterCollision = Boolean(
      state.disableWaterCollision ?? true,
    );
    globe.water.nearSurfaceTransparency = state.nearSurfaceTransparency ?? 0.78;
    globe.water.submersibleLightEnabled = Boolean(
      state.submersibleLightEnabled,
    );
    globe.water.submersibleLightIntensity =
      state.submersibleLightIntensity ?? 1.0;
    globe.water.bathymetricReliefBoost =
      state.bathymetricReliefBoost ?? tierBase.bathymetricReliefBoost ?? 1.35;
    const windDelta =
      (state.windSpeed ?? tierBase.windSpeed) - tierBase.windSpeed;
    globe.oceanFoamThreshold =
      Math.abs(windDelta) > 0.05
        ? Cesium.Math.clamp(
            FOAM_THRESHOLD_DEFAULT - windDelta * 0.008,
            0.32,
            0.82,
          )
        : FOAM_THRESHOLD_DEFAULT;
    if (globe.water.ocean) {
      const ocean = globe.water.ocean;
      ocean.enabled = false;
      ocean.tideEnabled = true;
      ocean.tideExaggeration = state.tideExaggeration ?? 1.0;
      ocean.meanSeaLevelPressure = state.mslp;
      ocean.windSpeed = state.windSpeed;
      ocean.applyBathymetryTensor({
        depthMeters: state.depth,
        jerlovType: state.jerlovType,
      });
    }
  }

  // 2. Global natural water mask, lake & river network & enhanced shader on the terrain
  globe.globalWaterMask = true;
  globe.lakeWaterMask = true;
  globe.riverWaterMask = state.riverMaskEnabled ?? true;
  globe.showWaterEffect = state.oceanEnabled;
  globe.enableEnhancedOcean = state.enhancedOcean;
  globe.oceanCelestialReflection = state.celestialGlint;
  globe.dynamicAtmosphereLighting = true;
  globe.dynamicAtmosphereLightingFromSun = true;
  if (typeof state.jerlovType === "number") {
    globe.oceanDarkening =
      state.jerlovType === 2
        ? OCEAN_DARKENING_DEFAULT
        : Cesium.Math.clamp(0.15 + (state.jerlovType - 2) * 0.04, 0.06, 0.45);
  }

  // 3. Weather, Volumetric Clouds & Cloud Shadow settings
  const isSubmerged =
    state.simulatedDiveDepth > 0 || state.currentLocKey === "seaLevel";
  scene.enableWeather = state.weatherEnabled && !isSubmerged;
  if (state.weatherEnabled && !isSubmerged) {
    scene.weatherIntensity = state.precipIntensity;
    scene.weatherWindSpeed = state.windSpeed;
    scene.weatherType = state.temperature <= 0 ? 1 : 0; // 0 = Rain, 1 = Snow
  }
  const clouds = globe.defaultCloudCollection;
  if (clouds) {
    const enableCloudShadows =
      Boolean(state.cloudShadowsEnabled) && state.simulatedDiveDepth <= 0;
    clouds.enableVolumetric = enableCloudShadows;
    if (clouds.volumetric) {
      clouds.volumetric.cloudCastShadows = enableCloudShadows;
      clouds.volumetric.cloudShadowCascades = enableCloudShadows;
      if (enableCloudShadows) {
        clouds.volumetric.cloudCoverage = state.cloudCoverage ?? 0.58;
        clouds.volumetric.cloudDensity = state.cloudDensity ?? 0.85;
        clouds.volumetric.cloudShadowStrength =
          state.cloudShadowStrength ?? 0.95;
        clouds.volumetric.cloudLayerBottom = state.cloudLayerBottom ?? 1200.0;
        clouds.volumetric.cloudLayerTop = state.cloudLayerTop ?? 3200.0;
      }
    }
  }

  updateUiFromState();
  scene.requestRender();
}

window.setLocalSolarHour = function (localHour, locKey) {
  const activeKey = locKey || state.currentLocKey || "seaLevel";
  const loc = LOCATIONS[activeKey];
  let lonDeg = -159.505;
  if (loc && loc.destination) {
    const carto = Cesium.Cartographic.fromCartesian(loc.destination);
    if (carto) {
      lonDeg = Cesium.Math.toDegrees(carto.longitude);
    }
  }
  const solarOffsetHours = -lonDeg / 15.0;
  const baseDateMs = Date.parse("2026-06-29T00:00:00Z"); // Full Moon date (2026-06-29)
  const utcHours = (((localHour + solarOffsetHours) % 24) + 24) % 24;
  viewer.clock.currentTime = Cesium.JulianDate.fromDate(
    new Date(baseDateMs + utcHours * 3600 * 1000),
  );
  const sliderEl = document.getElementById("solarTimeSlider");
  const readoutEl = document.getElementById("solarTimeReadout");
  if (sliderEl) {
    sliderEl.value = String(localHour.toFixed(2));
  }
  if (readoutEl) {
    const hh = Math.floor(((localHour % 24) + 24) % 24);
    const mm = Math.floor(((((localHour % 24) + 24) % 24) - hh) * 60);
    readoutEl.textContent = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  scene.requestRender();
};

window.setLightingScenario = function (mode, locKey) {
  const activeKey = locKey || state.currentLocKey || "seaLevel";
  const loc = LOCATIONS[activeKey];
  let latDeg = 22.22;
  if (loc && loc.destination) {
    const carto = Cesium.Cartographic.fromCartesian(loc.destination);
    if (carto) {
      latDeg = Cesium.Math.toDegrees(carto.latitude);
    }
  }
  // Solve exact local solar hour for any target solar elevation angle at the active latitude
  // on 2026-06-29 (solar declination delta = +23.22 deg, Full Moon date).
  const deg2rad = Math.PI / 180.0;
  const phi = Math.max(-62.0, Math.min(62.0, latDeg)) * deg2rad;
  const delta = 23.22 * deg2rad;
  const solveHourForAltitude = (altDeg, isMorningEast) => {
    const sinAlt = Math.sin(altDeg * deg2rad);
    const denom = Math.max(Math.cos(phi) * Math.cos(delta), 1.0e-4);
    const cosH = Math.max(
      -0.995,
      Math.min(0.995, (sinAlt - Math.sin(phi) * Math.sin(delta)) / denom),
    );
    const hourAngleHours = (Math.acos(cosH) * 180.0) / (Math.PI * 15.0);
    return isMorningEast ? 12.0 - hourAngleHours : 12.0 + hourAngleHours;
  };

  // A scenario owns the glint it needs; leaving moon_night must not leave it on.
  state.celestialGlint = PRESETS[window.currentTier || "medium"].celestialGlint;
  state.cloudShadowsEnabled = false;
  globe.enableLighting = false;
  let targetLocalHour = 12.0;

  if (mode === "dawn") {
    targetLocalHour = solveHourForAltitude(-2.0, true);
  } else if (mode === "sunrise") {
    targetLocalHour = solveHourForAltitude(2.6, true);
  } else if (mode === "morning") {
    targetLocalHour = solveHourForAltitude(28.0, true);
  } else if (mode === "noon" || mode === "sun_midday") {
    targetLocalHour = 12.05;
  } else if (mode === "afternoon") {
    targetLocalHour = solveHourForAltitude(32.0, false);
  } else if (mode === "golden_hour" || mode === "sun_golden_hour") {
    targetLocalHour = solveHourForAltitude(7.5, false);
  } else if (mode === "sunset") {
    targetLocalHour = solveHourForAltitude(1.5, false);
  } else if (mode === "blue_hour" || mode === "dusk") {
    targetLocalHour = solveHourForAltitude(-2.2, false);
  } else if (mode === "moon_night") {
    targetLocalHour = 23.75;
    state.celestialGlint = true;
  } else if (mode === "cloud_shadows") {
    targetLocalHour = 13.1;
    state.cloudShadowsEnabled = true;
    state.cloudCoverage = 0.58;
    state.cloudDensity = 0.85;
    state.cloudShadowStrength = 0.95;
  }

  window.setLocalSolarHour(targetLocalHour, activeKey);
  const cloudCb = document.getElementById("cloudShadowsCheckbox");
  if (cloudCb) {
    cloudCb.checked = Boolean(state.cloudShadowsEnabled);
  }
  applySettingsToEngine();
};

window.selectPreset = function (tier) {
  window.currentTier = tier;
  Object.assign(state, PRESETS[tier]);

  dom.btnLow.classList.toggle("active", tier === "low");
  dom.btnMedium.classList.toggle("active", tier === "medium");
  dom.btnHigh.classList.toggle("active", tier === "high");
  dom.presetDesc.textContent = PRESETS[tier].description;

  applySettingsToEngine();
};

window.WATER_LOCATIONS = LOCATIONS;

window.flyToLocation = function (locKey) {
  const loc = LOCATIONS[locKey];
  if (loc) {
    state.currentLocKey = locKey;
    state.simulatedDiveDepth = loc.diveDepth ?? 0;
    if (globe.water) {
      globe.water.diveDepthMeters = loc.diveDepth ?? 0;
    }
    if (loc.polar || locKey === "polar") {
      state.temperature = -12;
      state.weatherEnabled = true;
    } else if (state.temperature < 0) {
      state.temperature = PRESETS[window.currentTier || "medium"].temperature;
    }
    const locSelect = document.getElementById("biomeLocationSelect");
    if (locSelect && locSelect.value !== locKey) {
      locSelect.value = locKey;
    }
    applySettingsToEngine();
    if (loc.time) {
      viewer.clock.currentTime = loc.time;
    }
    viewer.camera.flyTo({
      destination: loc.destination,
      orientation: loc.orientation,
      duration: 2.0,
      complete: updateRegimeReadout,
    });
  }
};

scene.camera.changed.addEventListener(updateRegimeReadout);

// Event Listeners for UI
dom.oceanEnabled.addEventListener("change", (e) => {
  state.oceanEnabled = e.target.checked;
  applySettingsToEngine();
});

if (dom.riverMaskEnabled) {
  dom.riverMaskEnabled.addEventListener("change", (e) => {
    state.riverMaskEnabled = e.target.checked;
    applySettingsToEngine();
  });
}

if (dom.enhancedOcean) {
  dom.enhancedOcean.addEventListener("change", (e) => {
    state.enhancedOcean = e.target.checked;
    applySettingsToEngine();
  });
}

dom.celestialGlint.addEventListener("change", (e) => {
  state.celestialGlint = e.target.checked;
  applySettingsToEngine();
});

if (dom.tideExaggeration) {
  dom.tideExaggeration.addEventListener("input", (e) => {
    state.tideExaggeration = parseFloat(e.target.value);
    applySettingsToEngine();
  });
}

dom.windSpeed.addEventListener("input", (e) => {
  state.windSpeed = parseFloat(e.target.value);
  applySettingsToEngine();
});

dom.mslp.addEventListener("input", (e) => {
  state.mslp = parseFloat(e.target.value);
  applySettingsToEngine();
});

if (dom.disableWaterCollision) {
  dom.disableWaterCollision.addEventListener("change", (e) => {
    state.disableWaterCollision = Boolean(e.target.checked);
    applySettingsToEngine();
  });
}

if (dom.nearSurfaceTransparency) {
  dom.nearSurfaceTransparency.addEventListener("input", (e) => {
    state.nearSurfaceTransparency = parseFloat(e.target.value);
    applySettingsToEngine();
  });
}

dom.jerlovType.addEventListener("change", (e) => {
  state.jerlovType = parseInt(e.target.value, 10);
  applySettingsToEngine();
});

dom.bathymetryDepth.addEventListener("input", (e) => {
  state.depth = parseFloat(e.target.value);
  applySettingsToEngine();
});

if (dom.bathymetricReliefBoost) {
  dom.bathymetricReliefBoost.addEventListener("input", (e) => {
    state.bathymetricReliefBoost = parseFloat(e.target.value);
    applySettingsToEngine();
  });
}

if (dom.submersibleLightEnabled) {
  dom.submersibleLightEnabled.addEventListener("change", (e) => {
    state.submersibleLightEnabled = e.target.checked;
    applySettingsToEngine();
  });
}

if (dom.submersibleLightIntensity) {
  dom.submersibleLightIntensity.addEventListener("input", (e) => {
    state.submersibleLightIntensity = parseFloat(e.target.value);
    applySettingsToEngine();
  });
}

dom.weatherEnabled.addEventListener("change", (e) => {
  state.weatherEnabled = e.target.checked;
  applySettingsToEngine();
});

dom.temperature.addEventListener("input", (e) => {
  state.temperature = parseFloat(e.target.value);
  applySettingsToEngine();
});

dom.precipIntensity.addEventListener("input", (e) => {
  state.precipIntensity = parseFloat(e.target.value);
  applySettingsToEngine();
});

const solarTimeSliderEl = document.getElementById("solarTimeSlider");
if (solarTimeSliderEl) {
  solarTimeSliderEl.addEventListener("input", (e) => {
    const localHour = parseFloat(e.target.value);
    window.setLocalSolarHour(localHour);
  });
}

const cloudShadowsCbEl = document.getElementById("cloudShadowsCheckbox");
if (cloudShadowsCbEl) {
  cloudShadowsCbEl.addEventListener("change", (e) => {
    state.cloudShadowsEnabled = Boolean(e.target.checked);
    if (state.cloudShadowsEnabled) {
      state.cloudCoverage = 0.58;
      state.cloudDensity = 0.85;
      state.cloudShadowStrength = 0.95;
    }
    applySettingsToEngine();
  });
}

// Initial View: Kauai Shoreline
if (LOCATIONS.kauai.time) {
  viewer.clock.currentTime = LOCATIONS.kauai.time;
}
viewer.camera.setView(LOCATIONS.kauai);

refreshLocationLabels();

// Start on Medium preset
window.selectPreset("medium");
