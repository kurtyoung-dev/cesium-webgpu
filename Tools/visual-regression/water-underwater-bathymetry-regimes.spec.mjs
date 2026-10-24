// water-underwater-bathymetry-regimes.spec.mjs
// @purpose Verifies shallow photic and deep pelagic/abyssal/hadal underwater optics, Snell's Window 48.6 deg TIR cone, CCD seabed substrate grading, Hermitian/TMA FFT spectrum, and 6-regime WaterQualityPreset scaling.
// @status ACTIVE
//
// Most tests are text tripwires on shader source or runs of the CPU reference models; test 16 pins the use of the Snell window mask and runs against a copy without it (water-spec-mutants.mjs). The CPU models have no renderer consumer yet, so a green result is evidence about the models, not about the pixels.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";
import {
  assertCallSiteLive,
  assertInertnessMutantTurnsRed,
  stripUses,
} from "./water-spec-mutants.mjs";

enableEngineTsResolution();

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const enginePath = (p) => path.join(root, "packages/engine/Source", p);
const importEngine = async (p) =>
  await import(pathToFileURL(enginePath(p)).href);

const {
  CARBONATE_COMPENSATION_DEPTH_M,
  JerlovWaterType,
  PelagicZone,
  SNELL_CRITICAL_ANGLE_RAD,
  SeabedSubstrateType,
  buildProceduralBathymetryTensor,
  evaluateBenthicMicroRelief,
  evaluateCase2BioOpticalIOP,
  evaluateFetchLimitedWaveSpectrum,
  evaluateSeabedSubstrateOptics,
  evaluateSnellsWindowOptics,
  evaluateUnderwaterVerticalProfile,
  evaluateWaterlineMeniscusAndWetness,
} = await importEngine("Scene/BathymetryTensorMap.ts");

const { uploadBathymetryTensorTexture } = await importEngine(
  "Renderer/WebGPU/WebGPUBathymetryTensorTexture.ts",
);

const {
  default: GlobeWater,
  OsmWaterTypeAdapter,
  WaterQualityPreset,
  WaterRegionCollection,
  WaterType,
  WaterVerticalRegime,
} = await importEngine("Scene/GlobeWater.js");

test("1. Snell's Window obeys the 48.6 deg critical cone and Total Internal Reflection outside it", () => {
  const critDeg = (SNELL_CRITICAL_ANGLE_RAD * 180.0) / Math.PI;
  assert.ok(
    Math.abs(critDeg - 48.59) < 0.05,
    `Critical angle ${critDeg.toFixed(2)} deg must match arcsin(1/1.333333) ≈ 48.59 deg`,
  );

  // Looking straight up (zenith = 0 deg, cos = 1.0): inside Snell's window
  const nadirUp = evaluateSnellsWindowOptics(1.0);
  assert.equal(nadirUp.isTotalInternalReflection, false);
  assert.ok(
    Math.abs(nadirUp.fresnelReflectance - 0.02) < 0.005,
    "Normal-incidence water-to-air Fresnel reflectance must be ~0.02",
  );
  assert.ok(nadirUp.transmittanceToSky > 0.97);

  // Just inside critical cone (46 deg -> cos ≈ 0.6946): refracted near horizon with chromatic rim
  const nearRim = evaluateSnellsWindowOptics(
    Math.cos((46.0 * Math.PI) / 180.0),
  );
  assert.equal(nearRim.isTotalInternalReflection, false);
  assert.ok(
    nearRim.chromaticRimFactor > 0.1,
    "Chromatic dispersion rim must be active near the 48.6 deg critical boundary",
  );

  // Outside critical cone (52 deg -> cos ≈ 0.6156): Total Internal Reflection (R = 1.0)
  const outsideCone = evaluateSnellsWindowOptics(
    Math.cos((52.0 * Math.PI) / 180.0),
  );
  assert.equal(outsideCone.isTotalInternalReflection, true);
  assert.equal(outsideCone.fresnelReflectance, 1.0);
  assert.equal(outsideCone.transmittanceToSky, 0.0);

  // Looking downward (cos < 0): Total Internal Reflection
  const downward = evaluateSnellsWindowOptics(-0.5);
  assert.equal(downward.isTotalInternalReflection, true);
  assert.equal(downward.fresnelReflectance, 1.0);
});

test("2. Underwater vertical profile spans Epipelagic, Mesopelagic, Bathypelagic, Abyssal, and Hadal zones", () => {
  const air = evaluateUnderwaterVerticalProfile(-10.0);
  assert.equal(air.pelagicZone, PelagicZone.SURFACE_AIR);
  assert.equal(air.skyDomeSuppression, 0.0);
  assert.equal(air.fftComputeActive, true);

  const shallow = evaluateUnderwaterVerticalProfile(18.0, {
    viewPitchRadians: 0.4,
  });
  assert.equal(shallow.pelagicZone, PelagicZone.EPIPELAGIC_PHOTIC);
  assert.ok(
    shallow.causticIntensity > 0.2,
    "Photic zone at 18 m must have active seafloor caustics",
  );
  assert.ok(
    shallow.downwellingSolarIrradiance.r <
      shallow.downwellingSolarIrradiance.g &&
      shallow.downwellingSolarIrradiance.g <
        shallow.downwellingSolarIrradiance.b,
    "Red must extinguish faster than green, and green faster than blue",
  );
  assert.equal(shallow.fftComputeActive, true);

  // Pitch anisotropy: looking up (+pitch) is brighter than looking down (-pitch)
  const shallowDown = evaluateUnderwaterVerticalProfile(18.0, {
    viewPitchRadians: -0.6,
  });
  assert.ok(
    shallow.inscatterColor.b > shallowDown.inscatterColor.b,
    "Upward-pitched underwater view must have brighter Gordon in-scattering than downward view",
  );

  const twilight = evaluateUnderwaterVerticalProfile(500.0);
  assert.equal(twilight.pelagicZone, PelagicZone.MESOPELAGIC_TWILIGHT);
  assert.equal(
    twilight.causticIntensity,
    0.0,
    "Zero caustics in twilight zone",
  );
  assert.equal(
    twilight.fftComputeActive,
    false,
    "FFT compute must auto-sleep below 80 m submergence",
  );
  assert.ok(
    twilight.skyDomeSuppression > 0.99,
    "Sky dome must be suppressed in mesopelagic zone",
  );
  assert.ok(
    twilight.downwellingSolarIrradiance.r < 1e-6 &&
      twilight.downwellingSolarIrradiance.b > 1e-3,
    "Mesopelagic twilight retains residual 475 nm blue light while red is extinct",
  );

  const bathy = evaluateUnderwaterVerticalProfile(2500.0);
  assert.equal(bathy.pelagicZone, PelagicZone.BATHYPELAGIC_MIDNIGHT);

  const abyssal = evaluateUnderwaterVerticalProfile(4800.0);
  assert.equal(abyssal.pelagicZone, PelagicZone.ABYSSOPELAGIC);
  assert.ok(
    abyssal.downwellingSolarIrradiance.b < 1e-6,
    "Abyssal zone must have zero solar irradiance",
  );
  assert.deepEqual(
    abyssal.submersibleSpotlightIrradiance,
    { r: 0.0, g: 0.0, b: 0.0 },
    "Default abyssal state must be strictly physical with no forced artificial spotlight",
  );

  const hadalWithRov = evaluateUnderwaterVerticalProfile(10920.0, {
    submersibleLightEnabled: true,
    submersibleLightIntensity: 1.5,
    targetRangeMeters: 8.0,
  });
  assert.equal(hadalWithRov.pelagicZone, PelagicZone.HADOPELAGIC_TRENCH);
  assert.ok(
    hadalWithRov.submersibleSpotlightIrradiance.b >
      hadalWithRov.submersibleSpotlightIrradiance.r &&
      hadalWithRov.submersibleSpotlightIrradiance.r > 0.0,
    "Opt-in ROV spotlight restores full-spectrum local illumination with Beer-Lambert attenuation",
  );
  assert.ok(
    hadalWithRov.marineSnowVisibility > 0.0,
    "Active ROV spotlight illuminates deep marine snow particulates",
  );
});

test("3. Seabed substrate optics grade across shelf, Carbonate Compensation Depth (CCD), and trench basalt", () => {
  assert.equal(CARBONATE_COMPENSATION_DEPTH_M, 4500.0);

  const reef = evaluateSeabedSubstrateOptics(
    12.0,
    SeabedSubstrateType.CORAL_REEF,
    0.05,
  );
  const aboveCcd = evaluateSeabedSubstrateOptics(
    3600.0,
    SeabedSubstrateType.ABYSSAL_SEDIMENT,
    0.05,
  );
  const belowCcd = evaluateSeabedSubstrateOptics(
    5200.0,
    SeabedSubstrateType.ABYSSAL_SEDIMENT,
    0.05,
  );
  const trenchWall = evaluateSeabedSubstrateOptics(
    8500.0,
    SeabedSubstrateType.ABYSSAL_SEDIMENT,
    0.65,
  );

  assert.equal(reef.substrateClassification, SeabedSubstrateType.CORAL_REEF);
  assert.ok(
    aboveCcd.carbonateOozeFraction > 0.8 &&
      belowCcd.carbonateOozeFraction === 0.0,
    "Carbonate ooze fraction must transition to zero below the CCD",
  );
  assert.ok(
    aboveCcd.albedo.r > belowCcd.albedo.r &&
      aboveCcd.albedo.b > belowCcd.albedo.b,
    "Pale carbonate ooze above CCD must have higher albedo than abyssal clay below CCD",
  );
  assert.equal(
    trenchWall.substrateClassification,
    SeabedSubstrateType.ROCK_BASALT,
    "Steep hadal trench walls must expose dark basaltic rock",
  );
});

test("4. GlobeTerrain.wgsl and OceanInitialSpectrum.wgsl wire underwater optics, bioluminescence, and Hermitian/TMA spectrum", () => {
  const globeWgsl = fs.readFileSync(
    enginePath("Shaders/WebGPU/Globe/GlobeTerrain.wgsl"),
    "utf8",
  );
  assert.ok(
    globeWgsl.includes("fn computePhoticSeafloorCaustics("),
    "GlobeTerrain.wgsl must define computePhoticSeafloorCaustics",
  );
  assert.ok(
    globeWgsl.includes("fn computeUnderwaterVerticalOpticsAndBenthic("),
    "GlobeTerrain.wgsl must define computeUnderwaterVerticalOpticsAndBenthic",
  );
  assert.ok(
    globeWgsl.indexOf("fn computeUnderwaterVerticalOpticsAndBenthic(") >
      globeWgsl.indexOf("fn computeEnhancedOcean("),
    "Underwater helper functions must follow computeEnhancedOcean to preserve celestial-water-globe-port slice and sentinel directive ordering",
  );
  assert.ok(
    globeWgsl.includes("nightBiolumGate") &&
      globeWgsl.includes("biolumEmission"),
    "GlobeTerrain.wgsl must wire nighttime dinoflagellate bioluminescence on surf foam",
  );

  const initSpectrumWgsl = fs.readFileSync(
    enginePath("Shaders/WebGPU/Ocean/OceanInitialSpectrum.wgsl"),
    "utf8",
  );
  assert.ok(
    initSpectrumWgsl.includes(
      "let mirrorCoord = vec2<i32>(i32((N - id.x) % N), i32((N - id.y) % N));",
    ),
    "OceanInitialSpectrum.wgsl must read mirrored frequency coordinate for Hermitian conjugate symmetry",
  );
  assert.ok(
    initSpectrumWgsl.includes("phiTma"),
    "OceanInitialSpectrum.wgsl must include TMA finite-depth wave spectrum attenuation",
  );
});

test("5. GlobeWater qualityPreset and evaluateRegimeAtAltitude cover all 6 vertical regimes", () => {
  const mockScene = { primitives: { add() {}, remove() {} } };
  const mockGlobe = {
    enableEnhancedOcean: false,
    oceanCelestialReflection: false,
    oceanFoamThreshold: 0.65,
  };
  const water = new GlobeWater(mockScene, mockGlobe);

  for (const preset of [
    WaterQualityPreset.LOW,
    WaterQualityPreset.MEDIUM,
    WaterQualityPreset.HIGH,
  ]) {
    water.qualityPreset = preset;
    assert.equal(water.qualityPreset, preset);
    // A quality preset tunes the water; it does not switch the enhanced ocean on.
    assert.equal(mockGlobe.enableEnhancedOcean, false);
  }

  assert.equal(
    water.evaluateRegimeAtAltitude(400000.0).regime,
    WaterVerticalRegime.ORBIT,
  );
  assert.equal(
    water.evaluateRegimeAtAltitude(35000.0).regime,
    WaterVerticalRegime.ATMOSPHERE,
  );
  assert.equal(
    water.evaluateRegimeAtAltitude(2500.0).regime,
    WaterVerticalRegime.IN_FLIGHT,
  );
  assert.equal(
    water.evaluateRegimeAtAltitude(12.0).regime,
    WaterVerticalRegime.SEA_LEVEL,
  );
  assert.equal(
    water.evaluateRegimeAtAltitude(-25.0).regime,
    WaterVerticalRegime.SHALLOW_UNDERWATER,
  );
  const deepState = water.evaluateRegimeAtAltitude(-6500.0);
  assert.equal(deepState.regime, WaterVerticalRegime.DEEP_UNDERWATER);
  assert.equal(
    deepState.underwaterProfile.pelagicZone,
    PelagicZone.HADOPELAGIC_TRENCH,
  );
  assert.equal(
    deepState.underwaterProfile.fftComputeActive,
    false,
    "Deep underwater regime must report FFT compute auto-sleep",
  );
});

test("6. Sandcastle2 webgpu-global-water-weather showcase exposes all 6 vertical regime bookmarks, river mask, and ROV controls", () => {
  const galleryDir = path.resolve(
    root,
    "packages/sandcastle/gallery/webgpu-global-water-weather",
  );
  const mainJs = fs.readFileSync(path.join(galleryDir, "main.js"), "utf8");
  const indexHtml = fs.readFileSync(
    path.join(galleryDir, "index.html"),
    "utf8",
  );

  for (const regimeBookmark of [
    "orbit",
    "atmosphere",
    "flight",
    "seaLevel",
    "shallowUnderwater",
    "deepUnderwater",
  ]) {
    assert.ok(
      mainJs.includes(`${regimeBookmark}: {`),
      `Sandcastle2 main.js must define camera bookmark '${regimeBookmark}'`,
    );
    assert.ok(
      indexHtml.includes(`flyToLocation('${regimeBookmark}')`),
      `Sandcastle2 index.html must expose button for '${regimeBookmark}'`,
    );
  }

  assert.ok(
    mainJs.includes("globe.riverWaterMask =") &&
      mainJs.includes("globe.water.submersibleLightEnabled =") &&
      mainJs.includes("globe.water.bathymetricReliefBoost ="),
    "Sandcastle2 main.js must wire riverWaterMask, submersibleLightEnabled, and bathymetricReliefBoost",
  );
});

test("Subnautica signature visuals: split-lens waterline meniscus & 1.5s emergence wetness, prismatic RGB Snell dispersion, and <150m procedural benthic micro-relief", () => {
  // 1. Split-lens meniscus when h_cam in [-2m, +2m]
  const halfSubmergedAbove = evaluateWaterlineMeniscusAndWetness(
    0.0,
    0.0,
    0.2,
    0.85,
  );
  const halfSubmergedBelow = evaluateWaterlineMeniscusAndWetness(
    0.0,
    0.0,
    0.2,
    0.15,
  );
  const atMeniscus = evaluateWaterlineMeniscusAndWetness(0.0, 0.0, 0.2, 0.5);
  assert.equal(
    halfSubmergedAbove.isSplitLensActive,
    true,
    "Camera at 0.0m altitude must activate split-lens meniscus window [-2m, +2m]",
  );
  assert.ok(
    halfSubmergedBelow.isPixelSubmerged === true &&
      halfSubmergedAbove.isPixelSubmerged === false,
    "Bottom of lens must be submerged while top of lens remains in air",
  );
  assert.ok(
    atMeniscus.meniscusGlowIntensity > 0.8,
    `Wavy waterline crossing must emit strong refractive meniscus glow, got ${atMeniscus.meniscusGlowIntensity}`,
  );

  // 1.5s emergence wetness decay
  const freshlyEmerged = evaluateWaterlineMeniscusAndWetness(
    0.5,
    0.0,
    0.3,
    0.8,
  );
  const driedLens = evaluateWaterlineMeniscusAndWetness(0.5, 0.0, 1.8, 0.8);
  assert.ok(
    freshlyEmerged.emergenceWetnessFactor > 0.4 &&
      driedLens.emergenceWetnessFactor === 0.0,
    "Camera emergence wetness must decay smoothly to 0 over 1.5 seconds",
  );

  // 2. Prismatic RGB chromatic Snell dispersion (n_R=1.331, n_G=1.334, n_B=1.338)
  const rimAngleCos = Math.cos(SNELL_CRITICAL_ANGLE_RAD * 0.96);
  const rimSnell = evaluateSnellsWindowOptics(rimAngleCos);
  assert.ok(
    rimSnell.refractedChannelCos.b < rimSnell.refractedChannelCos.g &&
      rimSnell.refractedChannelCos.g < rimSnell.refractedChannelCos.r,
    "Blue channel (n_B=1.338) must bend more strongly near the 48.6 deg Snell rim than Green (1.334) and Red (1.331)",
  );
  assert.ok(
    rimSnell.chromaticRimFactor > 0.15,
    "Rim chromatic dispersion factor must activate near the 48.6 deg critical cone",
  );

  // 3. Procedural benthic micro-relief (<150m range, zero beyond 150m)
  const closeCoral = evaluateBenthicMicroRelief(
    12,
    18,
    SeabedSubstrateType.CORAL_REEF,
    0.15,
    0.35,
    0.65,
  );
  const closeTrench = evaluateBenthicMicroRelief(
    6500,
    25,
    SeabedSubstrateType.ROCK_BASALT,
    0.2,
    0.5,
    0.5,
  );
  const farFloor = evaluateBenthicMicroRelief(
    12,
    180,
    SeabedSubstrateType.CORAL_REEF,
    0.15,
    0.35,
    0.65,
  );
  assert.ok(
    closeCoral.distanceFade > 0.8 && closeCoral.coralVoronoiCellIntensity > 0.0,
    "Shallow tropical coral floor at 18m range must synthesize Voronoi coral micro-relief",
  );
  assert.ok(
    closeTrench.hydrothermalShimmerIntensity > 0.0 &&
      Math.hypot(closeTrench.normalENU.x, closeTrench.normalENU.y) > 0.05,
    "Deep trench floor at 25m range must synthesize pillow-basalt micro-relief and hydrothermal shimmer",
  );
  assert.equal(
    farFloor.distanceFade,
    0,
    "Benthic micro-relief must fade to 0 beyond 150m to avoid aliasing",
  );
});

test("8. Single-pass FFT compute chain & auto-sleep, OceanSurface submerged Snell ceiling, BathymetryTensorMap landmarks & GPU upload, and WaterRegionCollection", () => {
  // 1. Single-pass FFT compute chain + auto-sleep in WebGPUOceanRenderer.ts and OceanSurfacePrimitive.js
  const oceanRendererSrc = fs.readFileSync(
    enginePath("Renderer/WebGPU/WebGPUOceanRenderer.ts"),
    "utf8",
  );
  const oceanSurfaceSrc = fs.readFileSync(
    enginePath("Shaders/WebGPU/Ocean/OceanSurface.wgsl"),
    "utf8",
  );

  const oceanPrimitiveSrc = fs.readFileSync(
    enginePath("Scene/OceanSurfacePrimitive.js"),
    "utf8",
  );
  assert.ok(
    oceanRendererSrc.includes("Ocean FFT single-pass compute chain"),
    "WebGPUOceanRenderer.ts must execute the FFT ladder in a single compute pass",
  );
  // The sleep decision lives in one place, the primitive, against the height above
  // the sea surface; the renderer must not carry a second predicate.
  assert.ok(
    /OCEAN_SLEEP_MIN_HEIGHT_M = -80\.0;/.test(oceanPrimitiveSrc) &&
      /OCEAN_SLEEP_MAX_HEIGHT_M = 15000\.0;/.test(oceanPrimitiveSrc) &&
      /_fftComputeActive =\s*heightAboveSeaM >= OCEAN_SLEEP_MIN_HEIGHT_M &&\s*heightAboveSeaM <= OCEAN_SLEEP_MAX_HEIGHT_M;/.test(
        oceanPrimitiveSrc,
      ),
    "OceanSurfacePrimitive.update must auto-sleep the FFT ocean in Orbit (>15 km) and Deep Underwater (<-80 m)",
  );
  assert.ok(
    !oceanRendererSrc.includes("camHeight > 15000.0"),
    "WebGPUOceanRenderer.ts must not carry a second sleep predicate",
  );
  assert.ok(
    oceanSurfaceSrc.includes("patchEdgeWindow") &&
      oceanSurfaceSrc.includes("snellWindowMask") &&
      oceanSurfaceSrc.includes("rimDispersion"),
    "OceanSurface.wgsl must apply radial patch-edge feathering and render submerged 3D wave ceiling Snell's Window + RGB dispersion",
  );

  // 2. Landmark bathymetry (Bahamas, Great Barrier Reef, Mariana Trench, Amazon) & GPU texture upload
  const tensor = buildProceduralBathymetryTensor(360, 181);
  const bahamas = tensor.sample(
    (-77.5 * Math.PI) / 180.0,
    (24.5 * Math.PI) / 180.0,
  );
  const mariana = tensor.sample(
    (142.2 * Math.PI) / 180.0,
    (11.35 * Math.PI) / 180.0,
  );
  const amazon = tensor.sample(
    (-49.5 * Math.PI) / 180.0,
    (-0.5 * Math.PI) / 180.0,
  );
  assert.ok(
    bahamas.depthMeters < 50.0 &&
      bahamas.substrateType === SeabedSubstrateType.CORAL_REEF,
    `Bahamas Banks must resolve to shallow coral reef (<50m), got depth=${bahamas.depthMeters}`,
  );
  assert.ok(
    mariana.depthMeters > 8500.0 &&
      mariana.substrateType === SeabedSubstrateType.ROCK_BASALT,
    `Mariana Trench must resolve to hadal basalt trench (>8500m), got depth=${mariana.depthMeters}`,
  );
  assert.equal(
    amazon.jerlovType,
    JerlovWaterType.COASTAL_7,
    "Amazon Estuary must resolve to turbid Jerlov Coastal 7 plume",
  );

  let uploadedBytes = null;
  const mockDevice = {
    createTexture: (desc) => ({ ...desc }),
    createSampler: (desc) => ({ ...desc }),
    queue: {
      writeTexture: (_dest, data) => {
        uploadedBytes = data;
      },
    },
  };
  const gpuHandle = uploadBathymetryTensorTexture(mockDevice, tensor);
  assert.equal(gpuHandle.width, 360);
  assert.equal(gpuHandle.height, 181);
  assert.equal(uploadedBytes.byteLength, 360 * 181 * 4);

  // 3. WaterType, OsmWaterTypeAdapter, and WaterRegionCollection
  assert.equal(
    OsmWaterTypeAdapter.classifyTags({ natural: "wetland" }).waterType,
    WaterType.WETLAND,
  );
  assert.equal(
    OsmWaterTypeAdapter.classifyTags({ waterway: "river" }).waterType,
    WaterType.RIVER_LINE,
  );
  assert.equal(
    OsmWaterTypeAdapter.classifyTags({ water: "lake" }).waterType,
    WaterType.LAKE,
  );

  const regions = new WaterRegionCollection();
  regions.add({
    id: "caribbean_reef",
    west: -1.5,
    south: 0.2,
    east: -1.1,
    north: 0.5,
    waterType: WaterType.SEA,
    jerlovType: JerlovWaterType.TYPE_IA,
    waveAmplitudeScale: 0.65,
  });
  const hit = regions.evaluateAtCartographic(-1.35, 0.35);
  assert.ok(hit && hit.id === "caribbean_reef");
  assert.equal(hit.waterType, WaterType.SEA);
  assert.equal(regions.evaluateAtCartographic(0.5, 0.35), undefined);
});

test("9. Phase 8 Open-Source Realism & Water-Type Close-Range Transparency: cellular lace whitecaps, dual-orthogonal caustics, benthic visibility, submerged volume composite, and FFT translucent alpha", () => {
  const globeWgsl = fs.readFileSync(
    enginePath("Shaders/WebGPU/Globe/GlobeTerrain.wgsl"),
    "utf8",
  );
  assert.ok(
    globeWgsl.includes("cellularLace") &&
      globeWgsl.includes("orbitWashKeep") &&
      globeWgsl.includes("surfaceFresnel") &&
      globeWgsl.includes("benthicVisibility") &&
      globeWgsl.includes("waterTypeClarity"),
    "GlobeTerrain.wgsl must implement cellular lace whitecaps, orbit-wash attenuation, Schlick Fresnel, and water-type-dependent benthic transparency",
  );
  assert.ok(
    globeWgsl.includes("fn computeSubmergedVolumeComposite(") &&
      globeWgsl.includes("photicDiveGate") &&
      globeWgsl.includes("abyssalDiveGate"),
    "GlobeTerrain.wgsl must implement computeSubmergedVolumeComposite for shallow photic reef and deep abyssal ROV volume rendering",
  );

  const oceanSurfaceWgsl = fs.readFileSync(
    enginePath("Shaders/WebGPU/Ocean/OceanSurface.wgsl"),
    "utf8",
  );
  assert.ok(
    oceanSurfaceWgsl.includes("waterTypeTurbidity") &&
      oceanSurfaceWgsl.includes("surfaceAlpha") &&
      oceanSurfaceWgsl.includes("outc.color = vec4<f32>(color, surfaceAlpha);"),
    "OceanSurface.wgsl must compute water-type and Fresnel-dependent surfaceAlpha for close-range transparency",
  );

  const oceanRendererTs = fs.readFileSync(
    enginePath("Renderer/WebGPU/WebGPUOceanRenderer.ts"),
    "utf8",
  );
  assert.ok(
    oceanRendererTs.includes(
      "makeSceneFBTargets(sceneFormat, { translucent: true })",
    ),
    "WebGPUOceanRenderer.ts must enable hardware alpha blending ({ translucent: true }) on the ocean surface pipeline",
  );
});

test("10. Phase 9.A (9.1-9.3): Exact dielectric Fresnel, Snell-refracted path length, Gordon multiple-scattering equilibrium reflectance, and coastal satellite chromaticity feathering", () => {
  const globeWgsl = fs.readFileSync(
    enginePath("Shaders/WebGPU/Globe/GlobeTerrain.wgsl"),
    "utf8",
  );
  assert.ok(
    globeWgsl.includes("fn fresnelDielectric(cosI: f32, eta: f32) -> f32") &&
      globeWgsl.includes(
        "let refractedViewDir = refract(-viewDir, waterNormal, 0.75);",
      ) &&
      globeWgsl.includes(
        "let refractedPathLength = waterDepth / refractedCosView;",
      ),
    "GlobeTerrain.wgsl must compute exact unpolarized dielectric Fresnel and Snell-refracted slant path length (9.1)",
  );
  assert.ok(
    globeWgsl.includes("let gordonEquilibriumAlbedo =") &&
      globeWgsl.includes("surfAerationBoost") &&
      globeWgsl.includes("sedimentGate"),
    "GlobeTerrain.wgsl must separate absorption sigmaA and scattering sigmaS with Gordon multiple-scattering equilibrium reflectance and surf aeration/sediment coupling (9.2 & 9.3)",
  );
  assert.ok(
    globeWgsl.includes("imageryWaterGate") &&
      globeWgsl.includes("coastalEffectiveMask") &&
      globeWgsl.includes("broadForward"),
    "GlobeTerrain.wgsl must feather coastal polygons by satellite water chromaticity and include broad-lobe wave-crest SSS",
  );

  const oceanSurfaceWgsl = fs.readFileSync(
    enginePath("Shaders/WebGPU/Ocean/OceanSurface.wgsl"),
    "utf8",
  );
  assert.ok(
    oceanSurfaceWgsl.includes(
      "fn fresnelDielectric(cosI: f32, eta: f32) -> f32",
    ) &&
      oceanSurfaceWgsl.includes(
        "let broadForward = max(0.0, dot(sunDir, -viewDir) + 0.3);",
      ),
    "OceanSurface.wgsl must evaluate exact dielectric Fresnel and broad-lobe wave-crest SSS",
  );
});

test("11. Phase 9.B (9.4-9.7): 2-phase flow-advected Voronoi lace & 3D whitewater relief, asymmetric swash uprush/backwash + meniscus bead + contact shadow, cat's-paw wind gusts & surfactant slicks, dual-focal-depth foam-shadowed caustics, and spatial underwater volumes", () => {
  const globeWgsl = fs.readFileSync(
    enginePath("Shaders/WebGPU/Globe/GlobeTerrain.wgsl"),
    "utf8",
  );
  assert.ok(
    globeWgsl.includes("flowPhase0") &&
      globeWgsl.includes("flowPhase1") &&
      globeWgsl.includes("whitewaterRelief") &&
      globeWgsl.includes("foamEdgeScatter"),
    "GlobeTerrain.wgsl must implement 2-phase flow-advected Voronoi lace, close-range 3D whitewater relief, and green-white foam edge scatter (9.4)",
  );
  assert.ok(
    globeWgsl.includes("swashUp = smoothstep(0.0, 0.40, swashCycle)") &&
      globeWgsl.includes("meniscusBead") &&
      globeWgsl.includes("wettingContactShadow"),
    "GlobeTerrain.wgsl must implement asymmetric swash uprush/backwash, bubbly meniscus bead, and 15 cm wetting contact shadow (9.5)",
  );
  assert.ok(
    globeWgsl.includes("catsPawGust") &&
      globeWgsl.includes("surfactantSlick") &&
      globeWgsl.includes("slickDamping"),
    "GlobeTerrain.wgsl must implement drifting 2-octave cat's-paw wind gusts and wind-aligned surfactant slicks (9.6)",
  );
  assert.ok(
    globeWgsl.includes("shallowFocalPlane") &&
      globeWgsl.includes("deepFocalPlane") &&
      globeWgsl.includes("dualDepthCaustics") &&
      globeWgsl.includes("foamCausticShadow"),
    "GlobeTerrain.wgsl must implement dual-focal-depth caustics and overhead foam shadowing (9.7)",
  );
  assert.ok(
    globeWgsl.includes("spatialCoord: vec2<f32>") &&
      globeWgsl.includes("baySeaLevelGate") &&
      globeWgsl.includes("inFlightImageryKeep"),
    "GlobeTerrain.wgsl must drive submerged volume rendering from smooth spatial coordinates and preserve coastal bay/reef continuity",
  );
});

test("12. Phase 10.A (10.1-10.2): Orbital & Stratospheric Water Realism — mesoscale wind-streak Cox-Munk glint, spectral Beer-Lambert shelf/reef transmittance, mesoscale swell bridge, and all-altitude coastal mask gating", () => {
  const globeWgsl = fs.readFileSync(
    enginePath("Shaders/WebGPU/Globe/GlobeTerrain.wgsl"),
    "utf8",
  );
  assert.ok(
    globeWgsl.includes("mesoStreak") &&
      globeWgsl.includes("(0.74 + 0.52 * mesoStreak)"),
    "GlobeTerrain.wgsl must modulate Cox-Munk orbital sun-glint slope variance with geocentric mesoscale wind-streak structure (10.1)",
  );
  assert.ok(
    globeWgsl.includes("allAltitudeCoastGate") &&
      globeWgsl.includes("orbitDepthFilter") &&
      globeWgsl.includes("spectralFilteredImagery") &&
      globeWgsl.includes("deepSapphireFloor") &&
      globeWgsl.includes("reefTurquoiseBoost"),
    "GlobeTerrain.wgsl must implement all-altitude coastal mask gating and spectral Beer-Lambert shelf/reef transmittance at orbital and stratospheric altitudes (10.1 & 10.2)",
  );
  assert.ok(
    globeWgsl.includes("mesoSwellWave") &&
      globeWgsl.includes("mesoWindStreak") &&
      globeWgsl.includes("mesoSurfaceMod"),
    "GlobeTerrain.wgsl must synthesize a geocentric mesoscale swell and wind-streak bridge across the stratospheric band (10.2)",
  );
});

test("13. Phase 10.B (10.3-10.4): In-Flight & Sea-Level Water Realism — depth-driven spectral glint-wash correction, shore-refracting coastal swell train, calibrated whitecap slope onset, and trochoidal wave-crest sharpness", () => {
  const globeWgsl = fs.readFileSync(
    enginePath("Shaders/WebGPU/Globe/GlobeTerrain.wgsl"),
    "utf8",
  );
  assert.ok(
    globeWgsl.includes("inFlightDepthColumn") &&
      globeWgsl.includes("inFlightVolumeScatter") &&
      globeWgsl.includes("coastalSwellTrain") &&
      globeWgsl.includes("columnFilterWeight"),
    "GlobeTerrain.wgsl must implement depth-driven spectral glint-wash correction and shore-refracting coastal swell trains in the in-flight regime (10.3)",
  );
  assert.ok(
    globeWgsl.includes("let waveSlope = length(waveNormal.xy);") &&
      globeWgsl.includes("seaLevelCrestFocus") &&
      globeWgsl.includes("trochoidSharpness"),
    "GlobeTerrain.wgsl must calibrate whitecap onset to physical wave slope magnitude and apply trochoidal wave-crest sharpening at sea level (10.4)",
  );
});

test("14. Phase 12 (12.1-12.5): Subnautica 1/2 & Tidewater Second-Pass Realism — peeling shore breakers, Langmuir windrows, crest-to-trough translucency, spindrift, 3-layer photic reef + Snell canopy + crepuscular god-rays, and dual-ROV Lumen bioluminescent abyss", () => {
  const globeWgsl = fs.readFileSync(
    enginePath("Shaders/WebGPU/Globe/GlobeTerrain.wgsl"),
    "utf8",
  );
  assert.ok(
    globeWgsl.includes("peelingBreakerShoulder") &&
      globeWgsl.includes("smoothstep(0.025, 0.14, reefTurquoiseBoost)"),
    "GlobeTerrain.wgsl must implement Tidewater peeling breaker shoulders and foreshore-aware shoreTransitionGate (12.1)",
  );
  assert.ok(
    globeWgsl.includes("langmuirWindrow") &&
      globeWgsl.includes("localEnuMeters") &&
      globeWgsl.includes("seaLevelColumnPurity") &&
      globeWgsl.includes("crestToTroughTranslucency") &&
      globeWgsl.includes("crestSpindrift"),
    "GlobeTerrain.wgsl must implement Langmuir windrow streaks, RTE localEnuMeters, seaLevelColumnPurity, crestToTroughTranslucency, and crestSpindrift (12.2)",
  );
  assert.ok(
    globeWgsl.includes("creviceAO") &&
      globeWgsl.includes("crepuscularGodRays") &&
      globeWgsl.includes("snellWindowArc") &&
      globeWgsl.includes("marineSnowParallax"),
    "GlobeTerrain.wgsl must implement 3-layer photic reef stratification with creviceAO, crepuscularGodRays, snellWindowArc, and marineSnowParallax (12.3)",
  );
  assert.ok(
    globeWgsl.includes("rovDualBeamCone") &&
      globeWgsl.includes("biolumBenthicVeins") &&
      globeWgsl.includes("lumenEmissiveBounce") &&
      globeWgsl.includes("biolumPelagicSpores") &&
      globeWgsl.includes("rovVolumetricShafts"),
    "GlobeTerrain.wgsl must implement dual-ROV volumetric headlamp cones, multi-spectral bioluminescent benthic veins, and Lumen emissive rock bounce (12.4)",
  );
  assert.ok(
    globeWgsl.includes("intertidalMudflatSheen") &&
      globeWgsl.includes("microAtollRim"),
    "GlobeTerrain.wgsl must implement intertidal mudflat thin-film specular sheen and coral micro-atoll rim highlighting (12.5)",
  );

  const oceanSurfaceWgsl = fs.readFileSync(
    enginePath("Shaders/WebGPU/Ocean/OceanSurface.wgsl"),
    "utf8",
  );
  assert.ok(
    oceanSurfaceWgsl.includes("crestToTroughTranslucency") &&
      oceanSurfaceWgsl.includes("crestSpindrift"),
    "OceanSurface.wgsl must implement crestToTroughTranslucency and crestSpindrift (12.2)",
  );
});

test("15. Phase 13 (13.1-13.6): Multi-Biome Planetary Hydrosphere Realism — Case-2 CDOM/Chl-a/SPM Bio-Optics, Fetch-Limited JONSWAP & 2-Phase River Flow, Swamp Duckweed & Iridescence, Rift/Glacial/Hypersaline Lakes, and Horizon-Cone Reflection", () => {
  // 13.1: Case-2 Bio-Optical IOP Model (CDOM + Chl-a + Mineral SPM + Brine Eta)
  const swampOptics = evaluateCase2BioOpticalIOP({
    cdomConcentration: 1.4,
    chlorophyllConcentration: 1.2,
    mineralSpmConcentration: 0.18,
    stagnantMarginFactor: 0.85,
  });
  assert.ok(
    swampOptics.sigmaA.b > swampOptics.sigmaA.g * 2.5 &&
      swampOptics.sigmaA.b > swampOptics.sigmaA.r * 2.5 &&
      swampOptics.gordonSubsurfaceAlbedo.r >
        swampOptics.gordonSubsurfaceAlbedo.b,
    "CDOM humic tannin absorption must extinguish blue far more strongly than green/red and shift Gordon albedo toward warm amber-brown",
  );
  assert.ok(
    swampOptics.duckweedMatCoverage > 0.35 &&
      swampOptics.biogenicIridescenceStrength > 0.4,
    "Swamp/wetland IOP must activate duckweed mat coverage and biogenic thin-film iridescence",
  );

  const glacialOptics = evaluateCase2BioOpticalIOP({
    cdomConcentration: 0.02,
    chlorophyllConcentration: 0.04,
    mineralSpmConcentration: 1.25,
    glacialRockFlourFraction: 1.0,
  });
  assert.ok(
    glacialOptics.sigmaBb.g > 0.14 &&
      glacialOptics.sigmaBb.b > 0.14 &&
      glacialOptics.gordonSubsurfaceAlbedo.g >
        glacialOptics.gordonSubsurfaceAlbedo.r,
    "Glacial rock-flour SPM must produce high cyan-turquoise backscattering albedo",
  );

  const hypersalineOptics = evaluateCase2BioOpticalIOP({
    cdomConcentration: 0.08,
    chlorophyllConcentration: 0.05,
    mineralSpmConcentration: 0.35,
    salinityPermil: 290.0,
  });
  assert.ok(
    hypersalineOptics.refractiveIndex > 1.35 &&
      hypersalineOptics.haliteSaltCrustFactor > 0.85,
    `Hypersaline brine must elevate index of refraction above 1.35 (got ${hypersalineOptics.refractiveIndex}) and activate halite salt-crust rim`,
  );

  // 13.2: Fetch-Limited JONSWAP Wave Spectrum & 2-Phase Anisotropic River Flow Advection
  const swampWave = evaluateFetchLimitedWaveSpectrum({
    fetchMeters: 90.0,
    windSpeedMetersPerSecond: 6.0,
    vegetationCanopyDamping: 0.85,
  });
  const lakeWave = evaluateFetchLimitedWaveSpectrum({
    fetchMeters: 4500.0,
    windSpeedMetersPerSecond: 8.5,
  });
  const oceanWave = evaluateFetchLimitedWaveSpectrum({
    fetchMeters: 500000.0,
    windSpeedMetersPerSecond: 12.0,
  });
  const riverFlow = evaluateFetchLimitedWaveSpectrum({
    fetchMeters: 320.0,
    windSpeedMetersPerSecond: 4.0,
    waterDepthMeters: 1.4,
    flowSpeedMetersPerSecond: 2.4,
    riverBedSlope: 0.025,
    timeSeconds: 1.25,
  });

  assert.equal(
    swampWave.octaveWeights.swell150m,
    0.0,
    "Short-fetch swamp (90 m) must suppress 150 m ocean swell to zero",
  );
  assert.ok(
    swampWave.glassMirrorCalmFactor > 0.75,
    "Sheltered canopy-damped swamp must exhibit high glass-mirror calm factor",
  );
  assert.ok(
    lakeWave.octaveWeights.swell150m === 0.0 &&
      lakeWave.octaveWeights.windWave15m > 0.45 &&
      oceanWave.octaveWeights.swell150m === 1.0,
    "Inland lake (4.5 km fetch) must retain 15 m wind chop while suppressing 150 m open-ocean swell",
  );
  assert.ok(
    riverFlow.anisotropicFlowAdvection.riffleChevronIntensity > 0.25 &&
      Math.abs(
        riverFlow.anisotropicFlowAdvection.phaseBlendWeight0 +
          riverFlow.anisotropicFlowAdvection.phaseBlendWeight1 -
          1.0,
      ) < 1e-6,
    "River flow advection must synthesize V-chevron riffles and unit-sum 2-phase sawtooth weights",
  );

  // Extended WaterType, OsmWaterTypeAdapter, and GlobeWater.evaluateBiomeOptics
  assert.equal(
    OsmWaterTypeAdapter.classifyTags({ wetland: "swamp" }).waterType,
    WaterType.SWAMP,
  );
  assert.equal(
    OsmWaterTypeAdapter.classifyTags({ water: "glacial_lake" }).waterType,
    WaterType.DEEP_GLACIAL_LAKE,
  );
  assert.equal(
    OsmWaterTypeAdapter.classifyTags({ water: "rift_lake" }).waterType,
    WaterType.ANCIENT_RIFT_LAKE,
  );
  assert.equal(
    OsmWaterTypeAdapter.classifyTags({ water: "salt_lake" }).waterType,
    WaterType.HYPERSALINE_LAKE,
  );
  assert.equal(
    OsmWaterTypeAdapter.classifyTags({ water: "blackwater" }).waterType,
    WaterType.BLACKWATER_RIVER,
  );
  assert.equal(
    OsmWaterTypeAdapter.classifyTags({ water: "estuary" }).waterType,
    WaterType.ESTUARY,
  );

  const mockScene = { primitives: { add() {}, remove() {} } };
  const mockGlobe = {};
  const water = new GlobeWater(mockScene, mockGlobe);
  const baikalBiome = water.evaluateBiomeOptics(WaterType.ANCIENT_RIFT_LAKE);
  assert.equal(baikalBiome.waterType, WaterType.ANCIENT_RIFT_LAKE);
  assert.ok(baikalBiome.waveSpectrum.octaveWeights.chop50m > 0.8);

  // Landmarks in BathymetryTensorMap (Lake Baikal, Dead Sea, Glacial Lake, Everglades)
  const tensor = buildProceduralBathymetryTensor(360, 181);
  const baikal = tensor.sample(
    (108.0 * Math.PI) / 180.0,
    (53.5 * Math.PI) / 180.0,
  );
  const glacial = tensor.sample(
    (-116.2 * Math.PI) / 180.0,
    (51.4 * Math.PI) / 180.0,
  );
  const everglades = tensor.sample(
    (-80.8 * Math.PI) / 180.0,
    (25.6 * Math.PI) / 180.0,
  );
  assert.ok(
    baikal.depthMeters > 1000.0 && baikal.jerlovType === JerlovWaterType.TYPE_I,
    `Lake Baikal landmark must resolve to >1000 m depth and Jerlov Type I clarity, got depth=${baikal.depthMeters}`,
  );
  assert.equal(
    glacial.jerlovType,
    JerlovWaterType.COASTAL_5,
    "Canadian Rockies glacial lake landmark must resolve to Jerlov Coastal 5 rock-flour scattering",
  );
  assert.equal(
    everglades.jerlovType,
    JerlovWaterType.COASTAL_9,
    "Florida Everglades swamp landmark must resolve to Jerlov Coastal 9 CDOM/peat",
  );

  // 13.3-13.6: WGSL shader symbols and Sandcastle2 multi-biome bookmarks
  const globeWgsl = fs.readFileSync(
    enginePath("Shaders/WebGPU/Globe/GlobeTerrain.wgsl"),
    "utf8",
  );
  assert.ok(
    globeWgsl.includes("fn evaluateMultiBiomeHydroOptics(") &&
      globeWgsl.includes("riftGrabenDropoff") &&
      globeWgsl.includes("cdomTanninAbsorption") &&
      globeWgsl.includes("glacialRockFlourGlow") &&
      globeWgsl.includes("fetchWaveAttenuation") &&
      globeWgsl.includes("riverFlowAdvection") &&
      globeWgsl.includes("swampDuckweedMat") &&
      globeWgsl.includes("biogenicIridescence") &&
      globeWgsl.includes("haliteSaltCrustRim") &&
      globeWgsl.includes("riftMethaneIce") &&
      globeWgsl.includes("localHorizonReflection"),
    "GlobeTerrain.wgsl must wire all Phase 13 multi-biome hydro-optical, fetch-wave, swamp, rift/glacial/hypersaline, and local horizon-cone reflection features",
  );

  const oceanSurfaceWgsl = fs.readFileSync(
    enginePath("Shaders/WebGPU/Ocean/OceanSurface.wgsl"),
    "utf8",
  );
  assert.ok(
    oceanSurfaceWgsl.includes("horizonConeGate") &&
      oceanSurfaceWgsl.includes("localHorizonReflection"),
    "OceanSurface.wgsl must wire local terrain/cliff horizon-cone sky occlusion reflection (13.5)",
  );

  const galleryDir = path.resolve(
    root,
    "packages/sandcastle/gallery/webgpu-global-water-weather",
  );
  const mainJs = fs.readFileSync(path.join(galleryDir, "main.js"), "utf8");
  const indexHtml = fs.readFileSync(
    path.join(galleryDir, "index.html"),
    "utf8",
  );
  for (const biomeBookmark of [
    "baikalRift",
    "evergladesSwamp",
    "rockiesGlacial",
    "deadSeaBrine",
  ]) {
    assert.ok(
      mainJs.includes(`${biomeBookmark}: {`) &&
        indexHtml.includes(`flyToLocation('${biomeBookmark}')`),
      `Sandcastle2 showcase must expose multi-biome bookmark '${biomeBookmark}'`,
    );
  }
});

// Test 8 pins the Snell ceiling by name, and a name keeps matching after its uses are
// deleted. This pins the use and runs against a copy without it.
test("16. inertness: the submerged Snell window mask is read by the ocean surface shader, and the check goes red when it is not", () => {
  const oceanSurfaceSrc = fs.readFileSync(
    enginePath("Shaders/WebGPU/Ocean/OceanSurface.wgsl"),
    "utf8",
  );
  assertInertnessMutantTurnsRed(
    "Snell window mask",
    oceanSurfaceSrc,
    (text) => stripUses(text, "snellWindowMask", "1.0"),
    (text) => assertCallSiteLive(text, "snellWindowMask", "Snell window mask"),
  );
});
