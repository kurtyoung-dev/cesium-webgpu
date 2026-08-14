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
