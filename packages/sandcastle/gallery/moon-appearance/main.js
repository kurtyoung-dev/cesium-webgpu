import * as Cesium from "cesium";
import Sandcastle from "Sandcastle";

// Cesium WebGPU fork — the Moon appearance stack (Campaign 12).
//
// `scene.moon` is the Moon rendered in EARTH's sky, not the Moon-as-globe
// app in the "Moon" sandcastle (that one sets `Ellipsoid.default =
// Ellipsoid.MOON` and loads lunar terrain tiles). Everything below drives the
// disc's own shading, and every toggle is implemented on BOTH backends in
// lockstep, so the renderer switch (and Split mode) shows parity rather than a
// feature gap:
//
//   Albedo variant     LROC colour 2K (NASA/GSFC SVS 4720, default) or the
//                      historical 256x128 map. The variant also selects the
//                      LOLA relief pairing — SMALL deliberately ships none.
//   LOLA relief        Tangent-space normal map from the LRO altimeter,
//                      perturbing the lighting normal. Visible near the
//                      TERMINATOR, where N.L is small; nearly invisible at
//                      full phase where the cosine is flat.
//   Lommel-Seeliger    Regolith reflectance in place of Lambert, so the full
//                      moon reads as a flat bright disc instead of a ball.
//   Opposition surge   Hapke shadow-hiding brightness spike within a few
//                      degrees of opposition (i.e. at full moon).
//   Earthshine         The unlit limb lit by Earth. Scaled by EARTH's
//                      illuminated fraction seen from the Moon, which is the
//                      exact complement of the Moon's phase seen from Earth —
//                      so it PEAKS at new moon and is zero at full.
//   Soft terminator    Finite-disc solar irradiance instead of max(N.L, 0).
//                      Physically real but sub-pixel at these disc sizes; what
//                      it removes is the hard binary edge.
//   Sky wash           Additive in-scattered sky radiance over the disc, so
//                      the DAYTIME moon reads pale instead of a dark cutout.
//                      Exactly zero once the sky atmosphere is not drawn.
//
// The scene halves (a camera parked on the Earth->Moon line for the disc
// close-ups, and phase-selected epochs) come from the acceptance probes
// `probe-moon-lola-relief.mjs` and `probe-moon-atmosphere-appearance.mjs`.
const viewer = new Cesium.Viewer("cesiumContainer", {
  timeline: false,
  animation: false,
  baseLayerPicker: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  geocoder: false,
  homeButton: false,
  infoBox: false,
  selectionIndicator: false,
});

const scene = viewer.scene;
const ellipsoid = Cesium.Ellipsoid.WGS84;
const lighting = scene.globe.atmosphericConditions.lighting;

// Every framing below pins the clock: the disc shading is a function of the
// Sun-Earth-Moon geometry, so a running clock would slide the phase out from
// under whichever effect is being looked at.
viewer.clock.shouldAnimate = false;
scene.moon.show = true;

// The phase search below sweeps roughly one synodic month from here.
const SEARCH_START = Cesium.JulianDate.fromIso8601("2026-07-01T00:00:00Z");
const SEARCH_DAYS = 32;

// Earth orientation data makes the fixed-frame Moon position (and therefore
// the camera the demo derives from it) accurate. Without it `Scene/Moon.js`
// falls back to the TEME approximation, and the helper below falls back the
// same way, so the camera and the rendered disc always agree.
try {
  await Cesium.Transforms.preloadIcrfFixed(
    new Cesium.TimeInterval({
      start: Cesium.JulianDate.addDays(
        SEARCH_START,
        -1,
        new Cesium.JulianDate(),
      ),
      stop: Cesium.JulianDate.addDays(
        SEARCH_START,
        SEARCH_DAYS + 1,
        new Cesium.JulianDate(),
      ),
    }),
  );
} catch (error) {
  console.log(`ICRF data unavailable; using the TEME fallback. ${error}`);
}

// ── ephemeris helpers (same calls Scene/Moon.js makes) ──────────────
const scratchRotation = new Cesium.Matrix3();

function icrfToFixed(time, result) {
  if (
    !Cesium.defined(Cesium.Transforms.computeIcrfToFixedMatrix(time, result))
  ) {
    Cesium.Transforms.computeTemeToPseudoFixedMatrix(time, result);
  }
  return result;
}

function moonPositionFixed(time, result) {
  const inertial =
    Cesium.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
      time,
      result,
    );
  return Cesium.Matrix3.multiplyByVector(
    icrfToFixed(time, scratchRotation),
    inertial,
    inertial,
  );
}

function sunPositionFixed(time, result) {
  const inertial =
    Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
      time,
      result,
    );
  return Cesium.Matrix3.multiplyByVector(
    icrfToFixed(time, scratchRotation),
    inertial,
    inertial,
  );
}

// Illuminated fraction as Scene/Moon.js computes it: 0 = new, 0.5 = quarter,
// 1 = full. It is a dot product of two unit vectors that share the same frame
// rotation, so the ICRF->fixed transform cancels and the search below can run
// entirely in the inertial frame — hundreds of samples with no rotation cost.
function illuminatedFraction(time) {
  const moon = Cesium.Cartesian3.normalize(
    Cesium.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
      time,
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  );
  const sun = Cesium.Cartesian3.normalize(
    Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
      time,
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  );
  return 0.5 * (1.0 - Cesium.Cartesian3.dot(moon, sun));
}

// Coarse sweep then a local refinement — the illuminated fraction is smooth
// and monotonic between syzygies, so this lands within a few minutes of the
// requested phase without needing a root finder.
function findTimeForPhase(targetFraction) {
  let best = SEARCH_START;
  let bestError = Number.POSITIVE_INFINITY;
  const consider = (time) => {
    const error = Math.abs(illuminatedFraction(time) - targetFraction);
    if (error < bestError) {
      bestError = error;
      best = time;
    }
  };
  for (let hours = 0; hours <= SEARCH_DAYS * 24; hours += 3) {
    consider(
      Cesium.JulianDate.addHours(SEARCH_START, hours, new Cesium.JulianDate()),
    );
  }
  const coarse = best;
  for (let minutes = -180; minutes <= 180; minutes += 10) {
    consider(
      Cesium.JulianDate.addMinutes(coarse, minutes, new Cesium.JulianDate()),
    );
  }
  return best;
}

// ── camera placement ────────────────────────────────────────────────
// Disc close-up: park on the Earth->Moon line, 20,000 km short of the Moon,
// which renders the disc a couple of hundred pixels across. Straight out of
// probe-moon-lola-relief.mjs, where that size is what makes a few degrees of
// LOLA surface tilt readable at the terminator.
const CLOSE_UP_STANDOFF_METERS = 2.0e7;

function viewDiscCloseUp(time) {
  const moonPosition = moonPositionFixed(time, new Cesium.Cartesian3());
  const distance = Cesium.Cartesian3.magnitude(moonPosition);
  const direction = Cesium.Cartesian3.normalize(
    moonPosition,
    new Cesium.Cartesian3(),
  );
  const destination = Cesium.Cartesian3.multiplyByScalar(
    direction,
    distance - CLOSE_UP_STANDOFF_METERS,
    new Cesium.Cartesian3(),
  );
  let up = Cesium.Cartesian3.cross(
    direction,
    Cesium.Cartesian3.UNIT_Z,
    new Cesium.Cartesian3(),
  );
  if (Cesium.Cartesian3.magnitude(up) < 1e-6) {
    up = Cesium.Cartesian3.cross(direction, Cesium.Cartesian3.UNIT_X, up);
  }
  Cesium.Cartesian3.normalize(up, up);
  viewer.camera.setView({ destination, orientation: { direction, up } });
}

// Ground observer: rotate the sub-lunar point away from the Moon by
// (90 - elevation) degrees, either toward or away from the Sun. Toward the Sun
// puts the Sun high and gives a bright daytime sky; away from it drops the Sun
// below the horizon and gives a night sky. Parallax is ignored on purpose —
// Earth's radius is 1.7% of the lunar distance, so the geocentric direction is
// within a degree of the topocentric one.
function viewFromGround(time, targetElevationDeg, towardSun) {
  const moonPosition = moonPositionFixed(time, new Cesium.Cartesian3());
  const sunPosition = sunPositionFixed(time, new Cesium.Cartesian3());
  const moonDirection = Cesium.Cartesian3.normalize(
    moonPosition,
    new Cesium.Cartesian3(),
  );
  const sunDirection = Cesium.Cartesian3.normalize(
    sunPosition,
    new Cesium.Cartesian3(),
  );

  let axis = Cesium.Cartesian3.cross(
    moonDirection,
    sunDirection,
    new Cesium.Cartesian3(),
  );
  if (Cesium.Cartesian3.magnitude(axis) < 1e-8) {
    // Exact syzygy — any perpendicular axis will do.
    axis = Cesium.Cartesian3.cross(
      moonDirection,
      Cesium.Cartesian3.UNIT_Z,
      axis,
    );
  }
  Cesium.Cartesian3.normalize(axis, axis);

  // Rotating about normalize(moon x sun) by a positive angle carries the Moon
  // direction toward the Sun direction.
  const angle =
    Cesium.Math.toRadians(90.0 - targetElevationDeg) * (towardSun ? 1.0 : -1.0);
  const rotation = Cesium.Matrix3.fromQuaternion(
    Cesium.Quaternion.fromAxisAngle(axis, angle, new Cesium.Quaternion()),
    new Cesium.Matrix3(),
  );
  const observerDirection = Cesium.Matrix3.multiplyByVector(
    rotation,
    moonDirection,
    new Cesium.Cartesian3(),
  );

  const onSurface = ellipsoid.scaleToGeodeticSurface(
    Cesium.Cartesian3.multiplyByScalar(
      observerDirection,
      ellipsoid.maximumRadius,
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  );
  const carto = ellipsoid.cartesianToCartographic(
    onSurface,
    new Cesium.Cartographic(),
  );
  const destination = Cesium.Cartesian3.fromRadians(
    carto.longitude,
    carto.latitude,
    2000.0,
  );

  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(
      moonPosition,
      destination,
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  );
  // Local up, orthogonalized against the view direction so the horizon is level.
  const up = ellipsoid.geodeticSurfaceNormal(
    destination,
    new Cesium.Cartesian3(),
  );
  Cesium.Cartesian3.subtract(
    up,
    Cesium.Cartesian3.multiplyByScalar(
      direction,
      Cesium.Cartesian3.dot(up, direction),
      new Cesium.Cartesian3(),
    ),
    up,
  );
  Cesium.Cartesian3.normalize(up, up);
  viewer.camera.setView({ destination, orientation: { direction, up } });
}

// Elevation of a body above the observer's local horizon, in degrees.
function elevationDegrees(observer, bodyPosition) {
  const up = ellipsoid.geodeticSurfaceNormal(observer, new Cesium.Cartesian3());
  const toBody = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(bodyPosition, observer, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  return Cesium.Math.toDegrees(
    Math.asin(Cesium.Math.clamp(Cesium.Cartesian3.dot(up, toBody), -1.0, 1.0)),
  );
}

// ── framings ────────────────────────────────────────────────────────
const FRAMINGS = [
  {
    text: "Terminator close-up (half phase)",
    phase: 0.5,
    ground: false,
    note: "LOLA relief is loudest here: N.L is grazing, so a few degrees of surface tilt flips a facet between lit and unlit.",
  },
  {
    text: "Full moon (opposition surge)",
    phase: 0.98,
    ground: false,
    note: "Lommel-Seeliger flattens the disc and the opposition surge spikes its brightness. Earthshine is ~0 here by construction.",
  },
  {
    text: "Thin crescent (earthshine)",
    phase: 0.12,
    ground: false,
    note: "The old moon in the new moon's arms: Earth is nearly full as seen from the Moon, so the unlit limb is at its brightest.",
  },
  {
    text: "Daytime moon (sky wash)",
    phase: 0.35,
    ground: true,
    elevation: 45.0,
    towardSun: true,
    note: "Sun high, moon high, sky bright. Without the wash the disc renders as a dark cutout in a blue sky.",
  },
  {
    text: "Moonrise at the horizon",
    phase: 0.98,
    ground: true,
    elevation: 4.0,
    towardSun: false,
    note: "A long slant path through the atmosphere: the disc dims and reddens against a twilight sky.",
  },
];

const info = document.getElementById("moonInfo");
let currentFraming = FRAMINGS[0];
let currentVariant = Cesium.Moon.defaultVariant;

function describe(framing, time) {
  const fraction = illuminatedFraction(time);
  const lines = [
    framing.text,
    `UTC              ${Cesium.JulianDate.toIso8601(time, 0)}`,
    `illuminated      ${(100.0 * fraction).toFixed(1)}%`,
    `earthshine scale ${(100.0 * (1.0 - fraction)).toFixed(1)}% of maximum`,
    `albedo variant   ${currentVariant}`,
  ];
  if (currentVariant === Cesium.Moon.Variant.SMALL) {
    lines.push("LOLA relief      unavailable on this variant");
  }
  if (framing.ground) {
    const observer = viewer.camera.positionWC;
    lines.push(
      `moon elevation   ${elevationDegrees(
        observer,
        moonPositionFixed(time, new Cesium.Cartesian3()),
      ).toFixed(1)} deg`,
      `sun elevation    ${elevationDegrees(
        observer,
        sunPositionFixed(time, new Cesium.Cartesian3()),
      ).toFixed(1)} deg`,
    );
  }
  lines.push("", framing.note);
  info.textContent = lines.join("\n");
}

function applyFraming(framing) {
  currentFraming = framing;
  const time = findTimeForPhase(framing.phase);
  viewer.clock.currentTime = time.clone();
  viewer.clock.startTime = time.clone();
  viewer.clock.stopTime = time.clone();
  viewer.clock.multiplier = 0;

  if (framing.ground) {
    viewFromGround(time, framing.elevation, framing.towardSun);
  } else {
    viewDiscCloseUp(time);
  }
  describe(framing, time);
  scene.requestRender();
}

function refresh() {
  applyFraming(currentFraming);
}

Sandcastle.addToolbarMenu(
  FRAMINGS.map((framing) => ({
    text: framing.text,
    value: framing.text,
    onselect: () => applyFraming(framing),
  })),
);

Sandcastle.addToolbarMenu([
  {
    text: "Albedo: LROC colour 2K",
    value: Cesium.Moon.Variant.LROC_COLOR_2K,
    onselect: () => setVariant(Cesium.Moon.Variant.LROC_COLOR_2K),
  },
  {
    text: "Albedo: small (legacy, no relief)",
    value: Cesium.Moon.Variant.SMALL,
    onselect: () => setVariant(Cesium.Moon.Variant.SMALL),
  },
]);

function setVariant(variant) {
  if (variant === currentVariant) {
    return;
  }
  currentVariant = variant;
  const previous = scene.moon;
  scene.moon = new Cesium.Moon({ variant: variant });
  if (Cesium.defined(previous) && !previous.isDestroyed()) {
    previous.destroy();
  }
  refresh();
}

const TOGGLES = [
  ["LOLA relief", "enableLunarNormalMap"],
  ["Lommel-Seeliger", "enableLunarBRDF"],
  ["Opposition surge", "enableOppositionSurge"],
  ["Earthshine", "enableEarthshine"],
  ["Earthshine phase", "enableEarthshinePhase"],
  ["Soft terminator", "enableSoftTerminator"],
  ["Sky wash", "enableMoonSkyWash"],
];

for (const [label, property] of TOGGLES) {
  Sandcastle.addToggleButton(label, lighting[property], (checked) => {
    lighting[property] = checked;
    scene.requestRender();
  });
}

applyFraming(FRAMINGS[0]);
