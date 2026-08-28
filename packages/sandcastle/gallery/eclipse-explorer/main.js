import * as Cesium from "cesium";
import Sandcastle from "Sandcastle";

// Sandcastle2 embeds this file as one inline module. Keep preset authority here
// rather than in a relative import, which would resolve from the template URL.
const ECLIPSE_PRESETS = Object.freeze(
  [
    {
      id: "solar-luarca-c2-2026",
      label: "Solar — Luarca, Spain (C2)",
      kind: "solar",
      target: "sun",
      location: "Luarca, Asturias, Spain",
      longitude: -6.535,
      latitude: 43.544,
      observerHeight: 35,
      utc: "2026-08-12T18:26:50Z",
      timeScale: "UTC",
      localTime: "20:26:50 CEST",
      eventStage:
        "Point-specific totality begins (C2); the Valdés municipality table gives C2 near 18:26:47 UTC and maximum near 18:27:42 UTC",
      totalityPathVerified: true,
      windowSeconds: 600,
      clockMultiplier: 20,
      context:
        "Luarca is in Asturias (not Galicia) and lies near the Spanish centreline.",
      authority:
        "Point timing supplied for this observer; Principado de Asturias/IGN path and Valdés municipal circumstances cross-check",
      authorityUrl:
        "https://actualidad.asturias.es/documents/533407/0/Eclipse%2BSolar%2B_1905_2026.pdf/7670f304-a0e8-7393-15b8-a6da6b23e924?t=1782390821461",
    },
    {
      id: "solar-reykjavik-max-2026",
      label: "Solar — Reykjavík, Iceland (maximum)",
      kind: "solar",
      target: "sun",
      location: "Reykjavík, Iceland",
      longitude: -21.9426,
      latitude: 64.1466,
      observerHeight: 25,
      utc: "2026-08-12T17:48:47.1Z",
      timeScale: "UTC",
      localTime: "17:48:47.1 GMT",
      eventStage:
        "Observer-coordinate maximum; published Reykjavík-area sites place maximum near 17:48:46–17:48:48 UTC",
      totalityPathVerified: true,
      windowSeconds: 600,
      clockMultiplier: 20,
      context: "The Sun is roughly 24.5 degrees above the western horizon.",
      authority:
        "Point timing supplied for this observer; Eclipse2026.is Reykjavík-area circumstances cross-check",
      authorityUrl:
        "https://eclipse2026.is/stories/where-to-watch-the-eclipse-in-the-reykjavik-area",
    },
    {
      id: "solar-erie-max-2024",
      label: "Solar — Erie, Pennsylvania (maximum)",
      kind: "solar",
      target: "sun",
      location: "Erie, Pennsylvania, USA",
      longitude: -80.0851,
      latitude: 42.1292,
      observerHeight: 220,
      utc: "2024-04-08T19:18:11Z",
      timeScale: "UTC",
      localTime: "15:18:11 EDT",
      eventStage: "Maximum total eclipse; totality began at about 15:16 EDT",
      totalityPathVerified: true,
      windowSeconds: 600,
      clockMultiplier: 20,
      context:
        "UTC−4 daylight time was in force; EST would be one hour earlier.",
      authority: "NASA 2024 Where & When and Erie timetable",
      authorityUrl:
        "https://science.nasa.gov/eclipses/future-eclipses/eclipse-2024/where-when/",
    },
    {
      id: "solar-torreon-max-2024",
      label: "Solar — Torreón, Mexico (maximum)",
      kind: "solar",
      target: "sun",
      location: "Torreón, Coahuila, Mexico",
      longitude: -103.4068,
      latitude: 25.5428,
      observerHeight: 1120,
      utc: "2024-04-08T18:19:41Z",
      timeScale: "UTC",
      localTime: "12:19:41 CST",
      eventStage: "Maximum total eclipse",
      totalityPathVerified: true,
      windowSeconds: 600,
      clockMultiplier: 20,
      context:
        "Torreón was a NASA telescope-feed site inside Mexico's path of totality.",
      authority:
        "Point timing supplied for this observer; NASA SVS path and Torreón telescope-feed location cross-check",
      authorityUrl: "https://svs.gsfc.nasa.gov/5219/",
    },
    {
      id: "solar-principe-eddington-1919",
      label: "Solar — Roça Sundy, Príncipe (Eddington mid-totality)",
      kind: "solar",
      target: "sun",
      location: "Roça Sundy plantation, Príncipe Island, São Tomé and Príncipe",
      longitude: 7.3842,
      latitude: 1.6694,
      observerHeight: 150,
      utc: "1919-05-29T14:15:36Z",
      timeScale: "UTC",
      localTime:
        "14:15:36 GMT (UTC+0 — expedition timings recorded in G.M.T.; Príncipe civil time = GMT)",
      eventStage:
        "Mid-totality at Roça Sundy — the published site circumstances give totality from 14:13:05 to 14:18:07 G.M.T. (302 s = 5m02s), so the preset instant is the 14:15:36 midpoint; greatest eclipse globally was 13:08:34 UT1 with a 6m51s maximum duration (EclipseWise).",
      totalityPathVerified: true,
      windowSeconds: 600,
      clockMultiplier: 20,
      context:
        "Eddington's station for the general-relativity eclipse: after a heavy morning thunderstorm (10:00–11:30, 'a remarkable occurrence at that time of year'), he photographed totality 'through cloud, much as the Moon often appears through cloud' — of 16 plates only two were usable, yielding a 1.61±0.31 arcsec deflection that confirmed Einstein over Newton.",
      authority:
        "Royal Society (Dyson, Eddington & Davidson 1920, quoted in Phil. Trans. A commentary)",
      authorityUrl: "https://pmc.ncbi.nlm.nih.gov/articles/PMC4360090/",
      contextAuthority: "Royal Observatory Greenwich",
      contextAuthorityUrl:
        "https://www.royalobservatorygreenwich.org/articles.php?article=1283",
    },
    {
      id: "solar-carbondale-max-2017",
      label: "Solar — Carbondale, USA (2017 max totality)",
      kind: "solar",
      target: "sun",
      location:
        "Saluki Stadium, Southern Illinois University, Carbondale, Illinois, USA",
      longitude: -89.2203,
      latitude: 37.7066,
      observerHeight: 125,
      utc: "2017-08-21T18:21:24Z",
      timeScale: "UTC",
      localTime: "13:21:24 CDT (UTC-5)",
      eventStage:
        "Observer maximum totality at Saluki Stadium — USNO local circumstances for 37.7066N -89.2203W h=125m: totality 18:20:04.3–18:22:45.0 UT, maximum eclipse 18:21:23.7 UT, duration of totality 2m40.7s, magnitude 1.013, Sun altitude 63.7 deg.",
      totalityPathVerified: true,
      windowSeconds: 600,
      clockMultiplier: 20,
      context:
        "First leg of the 'Eclipse Crossroads of America': Carbondale sat near the point of greatest duration of the 2017 Great American Eclipse, and the same stadium fell inside totality again on 2024 Apr 8 — two total eclipses in under seven years.",
      authority: "U.S. Naval Observatory (Astronomical Applications)",
      authorityUrl:
        "https://aa.usno.navy.mil/api/eclipses/solar/date?date=2017-08-21&coords=37.7066,-89.2203&height=125",
      contextAuthority: "Southern Illinois University Eclipse",
      contextAuthorityUrl: "https://eclipse.siu.edu/about-the-eclipse/",
    },
    {
      id: "solar-albuquerque-annular-2023",
      label: "Solar — Albuquerque, USA (annular maximum)",
      kind: "solar",
      target: "sun",
      location: "Balloon Fiesta Park, Albuquerque, New Mexico, USA",
      longitude: -106.5989,
      latitude: 35.1917,
      observerHeight: 1510,
      utc: "2023-10-14T16:36:52Z",
      timeScale: "UTC",
      localTime: "10:36:52 MDT (UTC-6)",
      eventStage:
        "Observer maximum annularity at Balloon Fiesta Park — USNO site computation: annularity 16:34:28.1–16:39:17.1 UT (duration 4m 49.0s), maximum eclipse 16:36:51.6 UT, magnitude 0.973, obscuration 89.7%.",
      totalityPathVerified: true,
      windowSeconds: 600,
      clockMultiplier: 20,
      context:
        "First annular preset: the 2023 'ring of fire' crossed Albuquerque during the International Balloon Fiesta, with the eclipse centerline passing nearly over the city and nearly five minutes of annularity above the launch field.",
      authority: "US Naval Observatory (Astronomical Applications)",
      authorityUrl:
        "https://aa.usno.navy.mil/api/eclipses/solar/date?date=2023-10-14&coords=35.1917,-106.5989&height=1510",
      contextAuthority: "NOAA NESDIS",
      contextAuthorityUrl:
        "https://www.nesdis.noaa.gov/news/watching-the-annular-eclipse-albuquerque-orbit",
    },
    {
      id: "solar-carbondale-crossroads-2024",
      label: "Solar — Carbondale, USA (2024 max totality)",
      kind: "solar",
      target: "sun",
      location:
        "Saluki Stadium, Southern Illinois University, Carbondale, Illinois, USA",
      longitude: -89.2203,
      latitude: 37.7066,
      observerHeight: 125,
      utc: "2024-04-08T19:01:14Z",
      timeScale: "UTC",
      localTime: "14:01:14 CDT (UTC-5)",
      eventStage:
        "Observer maximum totality at Saluki Stadium — USNO local circumstances for 37.7066N -89.2203W h=125m: totality 18:59:09.2–19:03:19.7 UT, maximum eclipse 19:01:13.6 UT, duration of totality 4m10.6s, magnitude 1.027, Sun altitude 56.7 deg.",
      totalityPathVerified: true,
      windowSeconds: 600,
      clockMultiplier: 20,
      context:
        "Second leg of the 'Eclipse Crossroads of America': the 2024 path's centerline ran almost directly over Carbondale, giving Saluki Stadium 4+ minutes of totality seven years after the 2017 eclipse crossed the same ground.",
      authority: "U.S. Naval Observatory (Astronomical Applications)",
      authorityUrl:
        "https://aa.usno.navy.mil/api/eclipses/solar/date?date=2024-04-08&coords=37.7066,-89.2203&height=125",
      contextAuthority: "Southern Illinois University Eclipse",
      contextAuthorityUrl: "https://eclipse.siu.edu/about-the-eclipse/",
    },
    {
      id: "solar-luxor-max-2027",
      label: "Solar — Luxor, Egypt (observer maximum)",
      kind: "solar",
      target: "sun",
      location: "Luxor, Egypt (Luxor/Karnak temple district, Nile east bank)",
      longitude: 32.64444,
      latitude: 25.69667,
      observerHeight: 89,
      utc: "2027-08-02T10:05:26Z",
      timeScale: "UTC",
      localTime: "13:05:26 EEST (UTC+3)",
      eventStage:
        "Observer maximum eclipse at Luxor at 13:05:26 EEST (10:05:26 UTC), within a totality running C2 13:02:14 to C3 13:08:36 EEST — 6m22s of totality at magnitude 1.0361 with the Sun ~82 deg high (timeanddate contact table); EclipseWise lists greatest eclipse at 10:06:37.4 UT1 with maximum central duration 6m23.24s ~60 km southeast of Luxor.",
      totalityPathVerified: true,
      windowSeconds: 600,
      clockMultiplier: 20,
      context:
        "The 2027 Aug 2 total eclipse delivers the longest land totality between 1991 and 2114, and its central line passes almost directly over Luxor — six-plus minutes of darkness above the Karnak and Luxor temples of ancient Thebes.",
      authority:
        "timeanddate contact table (via Wikipedia local-circumstances table)",
      authorityUrl:
        "https://en.wikipedia.org/wiki/Solar_eclipse_of_August_2,_2027",
      contextAuthority: "EclipseWise (Fred Espenak)",
      contextAuthorityUrl:
        "https://eclipsewise.com/solar/SEprime/2001-2100/SE2027Aug02Tprime.html",
    },
    {
      id: "lunar-fairbanks-aurora-2025",
      label: "Lunar — Fairbanks-area + aurora (2025)",
      kind: "lunar",
      target: "moon",
      location: "Fairbanks, Alaska, USA",
      longitude: -147.7164,
      latitude: 64.8378,
      observerHeight: 145,
      utc: "2025-03-14T06:58:47Z",
      timeScale: "UTC",
      localTime: "2025-03-13 22:58:47 AKDT",
      eventStage: "Greatest total lunar eclipse; NASA's catalog TD is 06:59:56",
      totalPhaseVisible: true,
      windowSeconds: 7200,
      clockMultiplier: 240,
      context:
        "A composited photographic record made near Fairbanks shows an aurora during the eclipse; this is a historical conjunction, not eclipse causation.",
      authority: "NASA GSFC lunar catalog/SVS eclipse circumstances",
      authorityUrl: "https://svs.gsfc.nasa.gov/5472/",
      contextAuthority:
        "Dan Zafra/Capture the Atlas timelapse recorded near Fairbanks",
      contextAuthorityUrl: "https://www.youtube.com/watch?v=ILbYYqC5AnM",
      spaceWeatherContext: "photographed-aurora-conjunction",
    },
    {
      id: "lunar-nairobi-longest-2018",
      label: "Lunar — Nairobi, long totality (2018)",
      kind: "lunar",
      target: "moon",
      location: "Nairobi, Kenya",
      longitude: 36.8219,
      latitude: -1.2921,
      observerHeight: 1795,
      utc: "2018-07-27T20:21:45Z",
      timeScale: "UTC",
      localTime: "23:21:45 EAT",
      eventStage:
        "Greatest eclipse; NASA's catalog TD is 20:22:54; total phase about 103 minutes",
      totalPhaseVisible: true,
      windowSeconds: 7200,
      clockMultiplier: 240,
      context: "The longest total lunar eclipse of the 21st century.",
      authority: "NASA GSFC lunar catalog and precise UT1 circumstances",
      authorityUrl:
        "https://eclipse.gsfc.nasa.gov/LEplot/LEplot2001/LE2018Jul27T.pdf",
    },
    {
      id: "lunar-tokyo-uranus-2022",
      label: "Lunar — Tokyo + Uranus occultation (2022)",
      kind: "lunar",
      target: "moon",
      location: "Tokyo, Japan",
      longitude: 139.6917,
      latitude: 35.6895,
      observerHeight: 40,
      utc: "2022-11-08T10:59:13Z",
      timeScale: "UTC",
      localTime: "19:59:13 JST",
      eventStage:
        "Greatest total lunar eclipse; NASA's catalog TD is 11:00:22 and published UT1 is 10:59:11.3",
      totalPhaseVisible: true,
      windowSeconds: 7200,
      clockMultiplier: 240,
      context: "Japan also observed the Moon occult Uranus during the eclipse.",
      authority: "NASA GSFC lunar catalog and NAOJ Tokyo circumstances",
      authorityUrl:
        "https://eco.mtk.nao.ac.jp/koyomi/yoko/2022/rekiyou225.html.en",
      contextAuthority:
        "NAOJ total lunar eclipse and Uranus occultation overview",
      contextAuthorityUrl:
        "https://www.nao.ac.jp/astro/sky/2022/11-topics02.html",
    },
    {
      id: "lunar-porto-velho-deep-partial-2026",
      label: "Lunar — Porto Velho, Brazil (greatest, zenith)",
      kind: "lunar",
      target: "moon",
      location: "Porto Velho, Rondônia, Brazil",
      longitude: -63.9004,
      latitude: -8.7612,
      observerHeight: 90,
      utc: "2026-08-28T04:12:00Z",
      timeScale: "UTC",
      localTime: "00:12:00 AMT (UTC−4)",
      eventStage:
        "Greatest deep partial eclipse; published circumstances place greatest near 04:12–04:13 UTC at umbral magnitude 0.9319 (about 96% of the disc inside the umbra), with the partial phase running 02:33–05:52 UTC",
      totalPhaseVisible: false,
      windowSeconds: 7200,
      clockMultiplier: 240,
      context:
        "The sub-lunar point at greatest sits over Rondônia, so from Porto Velho the eclipsed Moon stands within a degree of the zenith — the best-placed view on Earth. The in-engine Simon1994 ephemeris independently places greatest at 04:11 UTC with the sub-lunar point at 9.4°S 63.1°W.",
      authority: "NASA SVS deep-partial lunar eclipse circumstances",
      authorityUrl: "https://svs.gsfc.nasa.gov/5672/",
      contextAuthority: "EclipseWise prime-page circumstances cross-check",
      contextAuthorityUrl:
        "https://www.eclipsewise.com/lunar/LEprime/2001-2100/LE2026Aug28Pprime.html",
    },
    {
      id: "lunar-fortaleza-supermoon-2015",
      label: "Lunar — Fortaleza, Brazil (greatest eclipse)",
      kind: "lunar",
      target: "moon",
      location: "Fortaleza, Ceará, Brazil",
      longitude: -38.5267,
      latitude: -3.7319,
      observerHeight: 16,
      utc: "2015-09-28T02:47:09Z",
      timeScale: "UTC",
      localTime: "23:47:09 BRT (UTC-3) on Sep 27 (Ceará observes no DST)",
      eventStage:
        "Greatest eclipse (geocentric — lunar eclipse stages are identical in UT worldwide) at 02:47:09.0 UT1 / 02:48:16.8 TD on 2015 Sep 28, umbral magnitude 1.27744 (penumbral 2.23071, gamma -0.32960, Saros 137), totality 71m55s from U2 02:11:03 to U3 03:23:32 UT1.",
      totalPhaseVisible: true,
      windowSeconds: 7200,
      clockMultiplier: 240,
      context:
        "The 'supermoon eclipse': the Moon reached perigee about an hour before greatest eclipse, making this the largest totally-eclipsed Moon between 1982 and 2033. From Fortaleza the blood-red perigee Moon hung ~81-82 degrees high — nearly overhead — since the sub-lunar point at greatest (1.5N 45.3W) sat just off Brazil's north coast.",
      authority: "EclipseWise (Fred Espenak)",
      authorityUrl:
        "https://www.eclipsewise.com/lunar/LEprime/2001-2100/LE2015Sep28Tprime.html",
      contextAuthority: "EclipseWise (Fred Espenak) eclipse feature article",
      contextAuthorityUrl:
        "https://www.eclipsewise.com/lunar/LEnews/TLE2015Sep28/TLE2015Sep28.html",
    },
    {
      id: "lunar-honolulu-super-blue-blood-2018",
      label: "Lunar — Honolulu, USA (greatest eclipse)",
      kind: "lunar",
      target: "moon",
      location: "Honolulu, Oahu, Hawaii, USA",
      longitude: -157.8583,
      latitude: 21.3069,
      observerHeight: 6,
      utc: "2018-01-31T13:29:51Z",
      timeScale: "UTC",
      localTime: "03:29:51 HST (UTC-10)",
      eventStage:
        "Greatest eclipse at 13:31:00.1 TD = 13:29:51.4 UT1 (EclipseWise), umbral magnitude 1.31671 (penumbral 2.29538), totality 76m43s from U2 12:51:25 UT to U3 14:08:08 UT, Saros 124.",
      totalPhaseVisible: true,
      windowSeconds: 7200,
      clockMultiplier: 240,
      context:
        "The 'Super Blue Blood Moon' — a supermoon, blue moon, and total lunar eclipse coinciding for the first time visible from the US since 1866. Honolulu had one of the best seats on Earth: the fully eclipsed Moon stood ~51 degrees high in the pre-dawn western sky at 3:29 am HST, with the entire eclipse over before sunrise.",
      authority: "EclipseWise (Fred Espenak)",
      authorityUrl:
        "https://eclipsewise.com/lunar/LEprime/2001-2100/LE2018Jan31Tprime.html",
      contextAuthority: "EarthSky",
      contextAuthorityUrl:
        "https://earthsky.org/sky-archive/super-blue-moon-eclipse-on-january-31/",
    },
    {
      id: "lunar-nyc-super-blood-wolf-2019",
      label: "Lunar — New York City, USA (greatest eclipse)",
      kind: "lunar",
      target: "moon",
      location: "Central Park, New York City, New York, USA",
      longitude: -73.9654,
      latitude: 40.7829,
      observerHeight: 30,
      utc: "2019-01-21T05:12:16Z",
      timeScale: "UTC",
      localTime: "00:12:16 EST (UTC-5), night of Jan 20-21",
      eventStage:
        "Greatest eclipse at 05:13:27.1 TD = 05:12:16 UT per NASA GSFC (EclipseWise: 05:12:18.0 UT1), umbral magnitude 1.1953 (EclipseWise 1.19657), with totality running U2 04:41:17 UT to U3 05:43:16 UT (1h01m59s).",
      totalPhaseVisible: true,
      windowSeconds: 7200,
      clockMultiplier: 240,
      context:
        "The 'Super Blood Wolf Moon' — a total eclipse of a perigee full Moon watched by millions across the Americas; from New York the Moon hung nearly at meridian transit, about 70 degrees high, when it turned deep red at greatest eclipse just after midnight EST.",
      authority: "NASA GSFC (Fred Espenak)",
      authorityUrl:
        "https://eclipse.gsfc.nasa.gov/LEplot/LEplot2001/LE2019Jan21T.pdf",
      contextAuthority: "Space.com eclipse guide",
      contextAuthorityUrl:
        "https://www.space.com/42830-supermoon-blood-moon-total-lunar-eclipse-2019.html",
    },
    {
      id: "lunar-mauna-kea-total-2026",
      label: "Lunar — Mauna Kea, USA (greatest eclipse)",
      kind: "lunar",
      target: "moon",
      location: "Mauna Kea summit (Mauna Kea Observatories), Hawaii, USA",
      longitude: -155.4681,
      latitude: 19.8206,
      observerHeight: 4207,
      utc: "2026-03-03T11:33:40Z",
      timeScale: "UTC",
      localTime: "01:33:40 HST (UTC-10)",
      eventStage:
        "Greatest eclipse at 11:33:40 UT1 (11:34:52 TD), umbral magnitude 1.15263, totality 58m58s from U2 11:03:54 to U3 12:02:53 UT1 (EclipseWise); Saros 133, sub-lunar point 6°24.1'N 170°36.9'W.",
      totalPhaseVisible: true,
      windowSeconds: 7200,
      clockMultiplier: 240,
      context:
        "2026's other lunar eclipse — the 59-minute total 'blood moon' counterpart to the Aug 28 deep partial. The sub-lunar point at greatest eclipse is open mid-Pacific ocean, so the preset stands on Mauna Kea's 4,207 m observatory summit, where the fully eclipsed Moon hung roughly 70° high in some of Earth's best night sky at 1:33 a.m. Hawaii time.",
      authority: "EclipseWise (Fred Espenak)",
      authorityUrl:
        "https://www.eclipsewise.com/lunar/LEprime/2001-2100/LE2026Mar03Tprime.html",
      contextAuthority: "Hawai'i Public Radio",
      contextAuthorityUrl:
        "https://www.hawaiipublicradio.org/the-conversation/2026-02-27/hawaii-skies-total-lunar-eclipse-in-the-early-hours-of-march-3",
    },
  ].map(Object.freeze),
);

const viewer = new Cesium.Viewer("cesiumContainer", {
  shouldAnimate: false,
  requestRenderMode: true,
  maximumRenderTimeChange: 1.0 / 30.0,
});

const scene = viewer.scene;
const globe = scene.globe;
const conditions = globe.atmosphericConditions;
const FRAME_SAMPLE_TIMEOUT_MILLISECONDS = 5000;
const SIMON1994_PROVIDER_ID = "cesium-simon1994-ecef";
const ASTRONOMY_ENGINE_PROVIDER_ID = "astronomy-engine-2.1.19-ecef";
let selectedPreset = ECLIPSE_PRESETS[0];
let viewMode = "telescope";
let performanceMode = "balanced";
let ephemerisPhase = "loading";
let ephemerisFailure;
let highPrecisionProvider;
let cancelPendingTargeting;
let targetingRequest = 0;
let targetingStatus =
  "Camera targeting: waiting for the first Scene-published frame sample.";

// The Sun changes only through ephemeris geometry, occultation, atmosphere,
// and exposure. A sinusoidal glow pulse is not a real eclipse phenomenon.
scene.sun.glowFactor = 1.0;
scene.sunBloom = true;
scene.sun.show = true;
scene.moon.show = true;
scene.skyAtmosphere.show = true;
globe.enableLighting = true;
globe.dynamicAtmosphereLighting = true;
globe.dynamicAtmosphereLightingFromSun = true;

Object.assign(conditions.lighting, {
  enableSunLight: true,
  enableMoonLight: true,
  enableMoonPhase: true,
  enableEarthshine: true,
  enableEarthshinePhase: true,
  enableSoftTerminator: true,
  enableDualLightAtmosphere: true,
  enableLunarBRDF: true,
  enableOppositionSurge: true,
  enableMoonSkyWash: true,
  enableLunarNormalMap: true,
  enableEclipse: true,
  eclipseAutoExposure: false,
  enableEclipseGlobeShadow: true,
  enableSolarLimbDarkening: true,
  enableSolarGlareFalloff: true,
  enableTrueSolarDiscSize: true,
  enableScreenSpaceSunHalo: true,
  enableAngularSolarGlare: true,
  enableEclipseHorizonTwilight: true,
});
conditions.skyAtmosphere.enableStarBrightnessModulation = true;
conditions.weather.humidity = 0.35;
conditions.weather.airQuality = 1.0;
conditions.weather.cloudCover = 0.0;
conditions.clouds.enableVolumetric = false;

const directionScratch = new Cesium.Cartesian3();
const surfaceUpScratch = new Cesium.Cartesian3();
const rightScratch = new Cesium.Cartesian3();
const cameraUpScratch = new Cesium.Cartesian3();

function pointCameraAtSharedSample(preset, sample) {
  const eye = Cesium.Cartesian3.fromDegrees(
    preset.longitude,
    preset.latitude,
    preset.observerHeight,
  );
  const target =
    preset.target === "moon" ? sample.moonPositionWC : sample.sunPositionWC;
  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(target, eye, directionScratch),
    directionScratch,
  );
  const surfaceUp = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
    eye,
    surfaceUpScratch,
  );
  let right = Cesium.Cartesian3.cross(direction, surfaceUp, rightScratch);
  if (Cesium.Cartesian3.magnitudeSquared(right) < 1.0e-12) {
    right = Cesium.Cartesian3.cross(
      direction,
      Cesium.Cartesian3.UNIT_Z,
      rightScratch,
    );
  }
  Cesium.Cartesian3.normalize(right, right);
  const cameraUp = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(right, direction, cameraUpScratch),
    cameraUpScratch,
  );

  viewer.camera.setView({
    destination: eye,
    orientation: { direction, up: cameraUp },
  });
  if ("fov" in viewer.camera.frustum) {
    viewer.camera.frustum.fov = Cesium.Math.toRadians(
      viewMode === "telescope" ? 6.0 : 55.0,
    );
  }
}

function requestCameraTargetFromSharedFrame(preset) {
  cancelPendingTargeting?.();
  const request = ++targetingRequest;
  const expectedProvider = scene.celestialEphemerisProvider;
  const expectedProviderId = expectedProvider.id;
  let settled = false;

  targetingStatus = `Camera targeting: waiting for a Scene-published ${expectedProviderId} sample.`;

  function finish() {
    if (settled) {
      return;
    }
    settled = true;
    removePostRender?.();
    window.clearTimeout(timeout);
    if (request === targetingRequest) {
      cancelPendingTargeting = undefined;
    }
  }

  const removePostRender = scene.postRender.addEventListener(
    (renderedScene, renderedTime) => {
      const frameState = renderedScene._frameState;
      const sample = frameState?.celestialEphemerisSample;
      if (
        request !== targetingRequest ||
        selectedPreset !== preset ||
        renderedScene.celestialEphemerisProvider !== expectedProvider ||
        !Cesium.JulianDate.equals(frameState?.time, renderedTime) ||
        sample?.providerId !== expectedProviderId
      ) {
        return;
      }

      finish();
      pointCameraAtSharedSample(preset, sample);
      targetingStatus = `Camera targeting: ${preset.target} direction accepted from the shared ${sample.providerId} frame sample.`;
      renderedScene.requestRender();
    },
  );

  const timeout = window.setTimeout(() => {
    if (request !== targetingRequest) {
      return;
    }
    finish();
    targetingStatus = `Camera targeting unavailable: no matching shared ${expectedProviderId} frame sample arrived within ${FRAME_SAMPLE_TIMEOUT_MILLISECONDS} ms; camera unchanged.`;
    scene.requestRender();
  }, FRAME_SAMPLE_TIMEOUT_MILLISECONDS);

  cancelPendingTargeting = finish;
  scene.requestRender();
}

function updateEventPanel(preset) {
  document.getElementById("eventName").textContent = preset.label;
  document.getElementById("eventTime").textContent =
    `${preset.utc} · ${preset.localTime}`;
  document.getElementById("eventFacts").textContent =
    `${preset.eventStage}. ${preset.context}`;
  document.getElementById("eventSource").textContent =
    `Authority: ${preset.authority}${preset.contextAuthority ? ` · Context: ${preset.contextAuthority}` : ""}`;
  document.getElementById("coverageNote").textContent =
    preset.kind === "solar"
      ? "Historical path/time is authoritative. The live meter below exposes the current engine ephemeris; it does not override the event time. Analytic corona, lunar-topography Baily's beads/diamond ring, and located prominences remain tracked renderer work."
      : "The Moon position and existing phase/BRDF are live. Earth-umbra copper coloring and any aurora layer are tracked follow-up work, not simulated decoration.";
}

function applyPreset(preset) {
  selectedPreset = preset;
  const eventTime = Cesium.JulianDate.fromIso8601(preset.utc);
  const start = Cesium.JulianDate.addSeconds(
    eventTime,
    -preset.windowSeconds,
    new Cesium.JulianDate(),
  );
  const stop = Cesium.JulianDate.addSeconds(
    eventTime,
    preset.windowSeconds,
    new Cesium.JulianDate(),
  );
  viewer.clock.startTime = start;
  viewer.clock.stopTime = stop;
  viewer.clock.currentTime = eventTime.clone();
  viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
  viewer.clock.multiplier = preset.clockMultiplier;
  viewer.clock.shouldAnimate = false;
  viewer.timeline.zoomTo(start, stop);
  updateEventPanel(preset);
  requestCameraTargetFromSharedFrame(preset);
}

function applyPerformanceMode(mode) {
  performanceMode = mode;
  const dpr = Math.max(window.devicePixelRatio || 1.0, 1.0);
  if (mode === "cinematic") {
    viewer.resolutionScale = 1.0;
    globe.maximumScreenSpaceError = 2.0;
    scene.skyAtmosphere.perFragmentAtmosphere = true;
    if (scene.highDynamicRangeSupported) {
      scene.highDynamicRange = true;
    }
  } else if (mode === "performance") {
    viewer.resolutionScale = Math.min(1.0, 1.0 / dpr);
    globe.maximumScreenSpaceError = 8.0;
    scene.skyAtmosphere.perFragmentAtmosphere = false;
    scene.highDynamicRange = false;
  } else {
    viewer.resolutionScale = Math.min(1.0, 1.5 / dpr);
    globe.maximumScreenSpaceError = 4.0;
    scene.skyAtmosphere.perFragmentAtmosphere = false;
    if (scene.highDynamicRangeSupported) {
      scene.highDynamicRange = true;
    }
  }
  scene.sunBloom = true;
  scene.requestRender();
}

Sandcastle.addToolbarMenu(
  ECLIPSE_PRESETS.map((preset) => ({
    text: preset.label,
    onselect: () => applyPreset(preset),
  })),
);

Sandcastle.addToolbarMenu([
  {
    text: "View: telescope (6°)",
    onselect: () => {
      viewMode = "telescope";
      requestCameraTargetFromSharedFrame(selectedPreset);
    },
  },
  {
    text: "View: landscape (55°)",
    onselect: () => {
      viewMode = "landscape";
      requestCameraTargetFromSharedFrame(selectedPreset);
    },
  },
]);

Sandcastle.addToolbarMenu([
  {
    text: "Quality: balanced",
    onselect: () => applyPerformanceMode("balanced"),
  },
  {
    text: "Quality: cinematic",
    onselect: () => applyPerformanceMode("cinematic"),
  },
  {
    text: "Quality: performance",
    onselect: () => applyPerformanceMode("performance"),
  },
]);

Sandcastle.addToolbarButton("Play contact window", () => {
  viewer.clock.currentTime = viewer.clock.startTime.clone();
  viewer.clock.shouldAnimate = true;
  scene.requestRender();
});

Sandcastle.addToolbarButton("Pause at event", () => {
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(selectedPreset.utc);
  requestCameraTargetFromSharedFrame(selectedPreset);
});

Sandcastle.addToggleButton("Human-eye adaptation", true, (checked) => {
  conditions.lighting.eclipseAutoExposure = !checked;
  scene.requestRender();
});

Sandcastle.addToggleButton("Volumetric clouds (WebGPU)", false, (checked) => {
  conditions.clouds.enableVolumetric = checked;
  conditions.weather.cloudCover = checked ? 0.35 : 0.0;
  scene.requestRender();
});

function sampleProviderLabel(sample) {
  if (sample?.providerId === ASTRONOMY_ENGINE_PROVIDER_ID) {
    return "Astronomy Engine 2.1.19";
  }
  if (sample?.providerId === SIMON1994_PROVIDER_ID) {
    return "default Simon 1994";
  }
  return sample?.providerId ?? "no published sample yet";
}

function failureSummary(error) {
  if (typeof error?.message === "string" && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

async function enableHighPrecisionEphemeris() {
  const Provider = Cesium.AstronomyEngineEphemerisProvider;
  if (typeof Provider?.create !== "function") {
    ephemerisPhase = "fallback";
    ephemerisFailure =
      "the AstronomyEngineEphemerisProvider export is absent from this build";
    scene.requestRender();
    return;
  }

  let provider;
  try {
    provider = await Provider.create();
  } catch (error) {
    ephemerisPhase = "fallback";
    ephemerisFailure = failureSummary(error);
    scene.requestRender();
    return;
  }

  highPrecisionProvider = provider;
  try {
    // Scene accepts only a ready synchronous provider. The setter promotes it
    // atomically on the next logical frame; no View can see a mixed provider.
    scene.celestialEphemerisProvider = provider;
  } catch (error) {
    ephemerisPhase =
      scene.celestialEphemerisProvider === provider
        ? "configured-error"
        : "fallback";
    ephemerisFailure = failureSummary(error);
    scene.requestRender();
    return;
  }

  ephemerisPhase = "switching";
  requestCameraTargetFromSharedFrame(selectedPreset);
}

let lastStatus = "";
let lastEphemerisStatus = "";
let lastTargetingStatus = "";
scene.postRender.addEventListener(() => {
  const frameState = scene._frameState;
  const state = frameState?.eclipseState;
  const sample = frameState?.celestialEphemerisSample;
  let status;
  if (selectedPreset.kind === "solar" && state?.valid === true) {
    status = `Engine preview: ${(state.moonObscuration * 100).toFixed(3)}% obscuration · magnitude ${state.eclipseMagnitude.toFixed(4)} · ${performanceMode}`;
  } else if (selectedPreset.spaceWeatherContext) {
    status = `Moon ephemeris view · ${selectedPreset.spaceWeatherContext} recorded · aurora renderer currently unavailable · ${performanceMode}`;
  } else {
    status = `Moon ephemeris view · lunar Earth-shadow renderer currently unavailable · ${performanceMode}`;
  }
  if (status !== lastStatus) {
    document.getElementById("engineStatus").textContent = status;
    lastStatus = status;
  }

  if (
    ephemerisPhase === "switching" &&
    scene.celestialEphemerisProvider === highPrecisionProvider &&
    sample?.providerId === highPrecisionProvider.id
  ) {
    ephemerisPhase = "active";
  }

  const sampleLabel = sampleProviderLabel(sample);
  let ephemerisStatus;
  if (ephemerisPhase === "loading") {
    ephemerisStatus = `Ephemeris: loading opt-in Astronomy Engine 2.1.19 · current shared frame: ${sampleLabel}.`;
  } else if (ephemerisPhase === "switching") {
    ephemerisStatus = `Ephemeris: Astronomy Engine is ready and awaiting next-frame promotion · current shared frame: ${sampleLabel}.`;
  } else if (ephemerisPhase === "active") {
    ephemerisStatus = `Ephemeris: Astronomy Engine 2.1.19 is active · current shared frame: ${sampleLabel}.`;
  } else if (ephemerisPhase === "configured-error") {
    ephemerisStatus = `Ephemeris: high precision was configured but setup reporting failed (${ephemerisFailure}) · current shared frame: ${sampleLabel}.`;
  } else {
    ephemerisStatus = `Ephemeris: high precision unavailable (${ephemerisFailure}); default Simon 1994 remains active · current shared frame: ${sampleLabel}.`;
  }
  if (ephemerisStatus !== lastEphemerisStatus) {
    document.getElementById("ephemerisStatus").textContent = ephemerisStatus;
    lastEphemerisStatus = ephemerisStatus;
  }
  if (targetingStatus !== lastTargetingStatus) {
    document.getElementById("targetingStatus").textContent = targetingStatus;
    lastTargetingStatus = targetingStatus;
  }
});

applyPerformanceMode("balanced");
applyPreset(ECLIPSE_PRESETS[0]);
enableHighPrecisionEphemeris();
