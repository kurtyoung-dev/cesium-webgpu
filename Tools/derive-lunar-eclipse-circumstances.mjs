// derive-lunar-eclipse-circumstances.mjs
//
// @purpose Derives lunar-eclipse contact times, umbral/penumbral magnitudes and the best-view sub-lunar point from the engine Simon1994 ephemeris; source of the eclipse-explorer lunar preset data and the VW-L golden fixtures.
// @status ACTIVE
//
// Compute circumstances of the 2026-08-28 lunar eclipse from the engine's own
// Simon1994 ephemeris (inertial frame; Earth rotation only needed for the
// sub-lunar point, done via GMST). Cross-checked against published catalogs
// separately.
import JulianDate from "../packages/engine/Source/Core/JulianDate.js";
import Simon1994PlanetaryPositions from "../packages/engine/Source/Core/Simon1994PlanetaryPositions.js";
import Cartesian3 from "../packages/engine/Source/Core/Cartesian3.js";

const R_SUN = 696000.0; // km
const R_EARTH = 6378.137; // km equatorial; Danjon enlargement applied below
const R_MOON = 1737.4; // km
const DANJON = 1.0 + 1.0 / 85.0; // NASA's Danjon shadow enlargement

function circumstancesAt(jd) {
  const sun =
    Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
      jd,
      new Cartesian3(),
    );
  const moon =
    Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
      jd,
      new Cartesian3(),
    );
  const ds = Cartesian3.magnitude(sun) / 1000.0; // km
  const dm = Cartesian3.magnitude(moon) / 1000.0;
  const sunDir = Cartesian3.normalize(sun, new Cartesian3());
  const moonDir = Cartesian3.normalize(moon, new Cartesian3());
  const antiSun = Cartesian3.negate(sunDir, new Cartesian3());
  const cosTheta = Cartesian3.dot(moonDir, antiSun);
  const theta = Math.acos(Math.min(1, Math.max(-1, cosTheta)));
  const s = dm * Math.sin(theta); // moon-center distance from shadow axis at moon plane
  const d = dm * cosTheta; // along-axis distance
  const rE = R_EARTH * DANJON;
  const rUmbra = rE - (d * (R_SUN - rE)) / ds;
  const rPenumbra = rE + (d * (R_SUN + rE)) / ds;
  const umbralMag = (rUmbra + R_MOON - s) / (2 * R_MOON);
  const penumbralMag = (rPenumbra + R_MOON - s) / (2 * R_MOON);
  return { umbralMag, penumbralMag, moon, dm };
}

// GMST (IAU 1982-ish, adequate for sub-lunar longitude to << 0.1 deg)
function gmstDegrees(jd) {
  const jdUt = jd.dayNumber + jd.secondsOfDay / 86400.0; // engine JD is TAI-based; UT1-TAI ~ -37s -> 0.0015 deg, ignorable
  const t = (jdUt - 2451545.0) / 36525.0;
  let gmst =
    280.46061837 +
    360.98564736629 * (jdUt - 2451545.0) +
    0.000387933 * t * t -
    (t * t * t) / 38710000.0;
  gmst %= 360.0;
  if (gmst < 0) gmst += 360.0;
  return gmst;
}

function subLunarPoint(jd, moon) {
  const m = Cartesian3.normalize(moon, new Cartesian3());
  const dec = Math.asin(m.z) * (180 / Math.PI);
  const ra = Math.atan2(m.y, m.x) * (180 / Math.PI);
  let lon = ra - gmstDegrees(jd);
  lon = ((lon + 540) % 360) - 180;
  return { lat: dec, lon };
}

const startIso = process.argv[2] ?? "2026-08-27T22:00:00Z";
const scanHours = Number(process.argv[3] ?? 10);
const start = JulianDate.fromIso8601(startIso);
const samples = [];
for (let minute = 0; minute <= scanHours * 60; minute++) {
  const jd = JulianDate.addMinutes(start, minute, new JulianDate());
  const c = circumstancesAt(jd);
  samples.push({ minute, jd, ...c });
}

let greatest = samples[0];
for (const s of samples) if (s.umbralMag > greatest.umbralMag) greatest = s;

function crossing(magKey, threshold, rising) {
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1][magKey] - threshold;
    const b = samples[i][magKey] - threshold;
    if (rising ? a < 0 && b >= 0 : a >= 0 && b < 0) {
      const f = -a / (b - a);
      const jd = JulianDate.addSeconds(
        samples[i - 1].jd,
        f * 60,
        new JulianDate(),
      );
      return JulianDate.toIso8601(jd, 0);
    }
  }
  return "none";
}

console.log("P1 penumbral begin :", crossing("penumbralMag", 0, true));
console.log("U1 umbral begin    :", crossing("umbralMag", 0, true));
console.log("U2 total begin     :", crossing("umbralMag", 1, true));
console.log(
  "GREATEST           :",
  JulianDate.toIso8601(greatest.jd, 0),
  " umbralMag =",
  greatest.umbralMag.toFixed(4),
  " penumbralMag =",
  greatest.penumbralMag.toFixed(4),
);
console.log("U3 total end       :", crossing("umbralMag", 1, false));
console.log("U4 umbral end      :", crossing("umbralMag", 0, false));
console.log("P4 penumbral end   :", crossing("penumbralMag", 0, false));

const sub = subLunarPoint(greatest.jd, greatest.moon);
console.log(
  "Sub-lunar point at greatest: lat",
  sub.lat.toFixed(2),
  "lon",
  sub.lon.toFixed(2),
  " moon distance km",
  greatest.dm.toFixed(0),
);

// Moon altitude at candidate observer sites at greatest eclipse
const sites = [
  ["Porto Velho, Brazil", -8.7612, -63.9004],
  ["Manaus, Brazil", -3.119, -60.0217],
  ["La Paz, Bolivia", -16.4897, -68.1193],
  ["Cusco, Peru", -13.5319, -71.9675],
  ["Rio de Janeiro, Brazil", -22.9068, -43.1729],
  ["Bogota, Colombia", 4.711, -74.0721],
  ["Mexico City, Mexico", 19.4326, -99.1332],
  ["Miami, USA", 25.7617, -80.1918],
  ["New York, USA", 40.7128, -74.006],
  ["Madrid, Spain", 40.4168, -3.7038],
  ["Lisbon, Portugal", 38.7223, -9.1393],
  ["Reykjavik, Iceland", 64.1466, -21.9426],
];
const d2r = Math.PI / 180;
for (const [name, lat, lon] of sites) {
  // altitude of Moon = 90 - angular distance from sub-lunar point (small parallax correction applied)
  const cosDist =
    Math.sin(lat * d2r) * Math.sin(sub.lat * d2r) +
    Math.cos(lat * d2r) *
      Math.cos(sub.lat * d2r) *
      Math.cos((lon - sub.lon) * d2r);
  const geocAlt = 90 - Math.acos(Math.min(1, Math.max(-1, cosDist))) / d2r;
  // horizontal parallax ~ asin(R_earth/dm): topocentric altitude is lower by ~parallax*cos(alt)
  const parallax = Math.asin(6378.137 / greatest.dm) / d2r;
  const topoAlt = geocAlt - parallax * Math.cos(geocAlt * d2r);
  console.log(
    name.padEnd(24),
    "moon altitude at greatest:",
    topoAlt.toFixed(1),
    "deg",
  );
}
