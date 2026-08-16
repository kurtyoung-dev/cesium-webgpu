// probe-sun-hdr-radiance.mjs — the solar disc captured at TWO disc radiances,
// to settle what shape the rendered-versus-resolved radiance excess has.
// @purpose Two-radiance discriminator: is the sun-disc excess multiplicative gain or additive pedestal, from plateau ratios via enableTrueSolarRadiance.
// @status ACTIVE
//
// THE QUESTION. Offline inversion of the sun-disc captures recovers a flat disc
// brighter than the radiance the frame itself resolved onto
// `frameState.sunHalo.discRadiance`. From a SINGLE radiance the two candidate
// shapes are algebraically indistinguishable — a multiplicative gain `k*L` and
// an additive pedestal `L + c` can always be made to produce the same number.
// This probe varies the radiance and reads the plateau on both legs, where the
// two shapes make different predictions and one of them contains no fitted
// parameter at all:
//
//   plateau(L_hi) / plateau(L_lo)  =  L_hi / L_lo        MULTIPLICATIVE
//                                  =  (L_hi+c)/(L_lo+c)  ADDITIVE
//
// THE DELTA AXIS is `lighting.enableTrueSolarRadiance`: ON resolves the disc
// radiance from the scene light, OFF pins it to the SDR identity 1.0, and
// `SunHaloAppearance` scales the screen halo's amplitude by the same scalar, so
// the entire sun composite is exactly proportional to it and nothing else about
// the scene moves.
//
// ⚠ NO SCENE FLAGS ARE PINNED TO "REMOVE THE HALO", and this is the one thing
// most likely to be re-invented by a later reader. The one-halo-source
// invariant in `Scene/SunHaloAppearance.js` derives `bakeHaloGain` from
// `screenHalo`, so `sunBloom = false` or `enableScreenSpaceSunHalo = false`
// does not delete the halo — it swaps in the legacy BAKED halo, which drives
// the bake's own alpha above 1 across the whole disc, saturates it, and renders
// the disc FLAT. Every disc pixel then reads the same code and the limb law is
// erased from the capture. NO scene configuration renders a halo-free disc.
// The halo-free quantities are DIFFERENCES BETWEEN LEGS, which is what this
// probe reads, at the shipped defaults:
//
//   D1 = flat - limb     the limb law      (halo cancels: no halo uniform is a
//   D2 = flat - legacy   the disc radiance  function of either disc toggle)
//
// ⚠ THE SUN BLOOM DOES NOT CANCEL, AND IT IS NOT SMALL. `SunPostProcess` and
// its WebGPU mirror bright-pass the SCENE, blur it and ADD it back before the
// halo stage, which puts `solarBloomCentreAmplitude(discRadiance)` — 0.48 at
// radiance 1, 0.71 at radiance 2 — on the disc itself. It survives both
// differentials because the bright pass reads through a THRESHOLD and the three
// legs present it three different sources: the limb-darkened disc falls below
// it partway out, and the legacy disc ends at 1/sqrt(2) R. The first
// two-radiance run modelled disc + halo only, and its four red criteria are all
// that omission. Every reading below carries the glow explicitly, derived from
// the shipped chain in `lib/sun-radiance-delta.mjs`; there is no configuration
// that removes it, for the same reason there is none that removes the halo.
//
// WHAT IS MEASURED, per backend, per radiance leg:
//
//   1. D1 in DISPLAY CODES at x = 0 / 0.95 / 1.0 on the 1/8 exposure leg,
//      against a band DERIVED from the shipped model and this frame's own
//      resolved appearance scalars. The bright leg of the bracket is still
//      captured — it is what shows the disc is not clipped — but the
//      differential is quoted off the leg that resolves it. Codes rather than
//      linear light on purpose: the halo cancels EXACTLY in linear and only
//      approximately in codes, so the code reading is the stricter test and is
//      sensitive to the absolute radiance, which is the question here.
//   2. The D2 annulus plateau, in linear light — the disc's own radiance.
//   3. The two plateaus folded into the shape verdict above.
//
// ⚠ THE CODE CRITERIA IN (1) ARE NOT THE DISCRIMINATOR AND DO NOT PRETEND TO
// BE. Their band is set by the requirement to refuse a FLAT disc, which is far
// coarser than the code-level gap between the two radiance hypotheses. The
// report prints `d1DiscriminationPower` — the separation between the two
// predictions in units of the criterion's own tolerance — precisely so a green
// there is not misread as evidence against an excess it cannot see. (2) and (3)
// are the discriminator.
//
// PROBE CONTRACT (the fleet's, unchanged):
//   1. The clock is PINNED; the default render loop is off.
//   2. Render and readback happen in the SAME task, no await between.
//   3. Every measured capture follows a DISCARDED warm-up capture.
//   4. Both backends run the identical lane list, and the SHIPPED state is
//      captured LAST at every level — the shipped radiance leg after the SDR
//      one, the shipped disc toggles after the reference ones.
//   5. HARD exit codes: 0 PASS, 1 FAIL, 2 the harness broke, 3 STRUCTURAL (a
//      lane ran but could not see its subject — never reported as a pass).
//
// Everything about the page, the aim, the settle and the capture is the shared
// fleet harness; everything about the measurement is the shared gate libs. This
// file owns the lane list, the reduction and the report.
//
// Usage:
//   node Tools/visual-regression/probe-sun-hdr-radiance.mjs
//   PROBE_BASE=http://localhost:8080 node ...   (override server)

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { createSceneIdentity } from "./lib/visual-gate-policy.mjs";
import {
  BASE,
  OUT_DIR,
  PINNED_ISO,
  SETTLE_BUDGET_MS,
  SETTLE_MIN_FRAMES,
  VIEWPORT,
  buildManifestEntry,
  getGit,
  normalizeHardwareClass,
  runBackendLanes,
  stitchLeg,
  toImage,
  writeCapturePng,
} from "./lib/celestial-capture-harness.mjs";
import {
  DISC_BRACKET_EXPOSURES,
  EXIT_CODE,
  measureDiscDifferential,
} from "./lib/celestial-g4-gate.mjs";
import {
  EXCESS_SHAPE,
  PRE_REGISTERED_D1_CODES,
  RADIANCE_DELTA_EXPOSURE,
  RADIANCE_DELTA_LEGS,
  buildRadianceDeltaSummary,
  d1DiscriminationPower,
  deriveDiscDifferentialCodes,
  discBloomPlateauDifferential,
  discBloomSourceEdgeUncertaintyPx,
  discriminateRadianceExcess,
  evaluateRadianceDeltaBackend,
  foldRadianceDeltaVerdict,
  measureDiscDifferentialCodes,
  plateauResolution,
} from "./lib/sun-radiance-delta.mjs";

// FRAMING. The Sun's angular radius is ~0.263 deg at the pinned epoch, so a
// 2-deg horizontal field puts the disc's rendered radius at ~170 px on a
// 1280-px canvas and its diameter well inside the crop. At the default 60 deg
// the whole disc is ~5.7 px across and `x = 0.95` and `x = 1.0` land in the
// same pixel, which would make the differential unmeasurable rather than small.
const SUN_DISC_FOV_X_DEG = 2.0;

// The lane's own bracket. ONE definition, imported, so the exposures the band's
// quantization term is derived against are the exposures the capture used.
const DISC_EXPOSURES = DISC_BRACKET_EXPOSURES;

// WATCHDOG. Two radiance legs x three toggle legs x two exposures = 12 settled
// captures per backend, 24 in all, each preceded by a discarded warm-up. At the
// measured ~7 s per settled capture that is ~6 min per backend; the budget is
// 20 min so the watchdog cannot become the thing that fails the run on a cold
// machine.
const HARD_LIMIT_MS = 1200000;
const watchdog = setTimeout(() => {
  console.error(
    `[probe-sun-hdr-radiance] WATCHDOG FIRED (${HARD_LIMIT_MS / 1000}s) — forcing exit`,
  );
  process.exit(EXIT_CODE.ERROR);
}, HARD_LIMIT_MS);
if (watchdog.unref) {
  watchdog.unref();
}

// LANE DEFINITIONS — one lane per radiance leg, identical in every other
// respect. Both the lane order and the capture order inside each lane are
// CERTIFYING-LAST: the shipped radiance position runs after the SDR one, and
// within each lane the shipped disc toggles are captured after the two
// reference legs, so the state the report certifies is measured against the
// warmest caches rather than the coldest.
//
// Every leg pins ALL FOUR appearance flags explicitly rather than inheriting
// whatever the previous leg left behind — both lanes run on ONE page, and a
// one-way pin silently hands its state to every capture after it.
const LANE_DEFS = RADIANCE_DELTA_LEGS.map((leg) => ({
  key: leg.key,
  setup: {
    aim: "sun-facing",
    skyAtmosphereOn: false,
    cameraHeightM: null,
    fovXDeg: SUN_DISC_FOV_X_DEG,
    sunOn: true,
    moonOn: false,
  },
  captures: [
    // FLAT — limb darkening off. The shipped law's coefficients make it
    // evaluate to exactly 1 everywhere in that position, i.e. the historical
    // flat disc bit-for-bit. This is the differential's reference leg.
    ...DISC_EXPOSURES.map((e) => ({
      key: `flat-${e}x`,
      mode: "sun-only",
      exposure: e,
      hdr: true,
      glareOn: false,
      toggles: {
        enableSolarLimbDarkening: false,
        enableTrueSolarDiscSize: true,
        enableScreenSpaceSunHalo: true,
        enableTrueSolarRadiance: leg.enableTrueSolarRadiance,
      },
    })),
    // LEGACY SIZE — the undersized disc, still flat, so `flat - legacy` is an
    // ANNULUS between the two disc edges. Its plateau is the disc's own
    // radiance in the lane's measured linear units, which is the quantity the
    // whole run turns on.
    ...DISC_EXPOSURES.map((e) => ({
      key: `legacy-${e}x`,
      mode: "sun-only",
      exposure: e,
      hdr: true,
      glareOn: false,
      toggles: {
        enableSolarLimbDarkening: false,
        enableTrueSolarDiscSize: false,
        enableScreenSpaceSunHalo: true,
        enableTrueSolarRadiance: leg.enableTrueSolarRadiance,
      },
    })),
    // SHIPPED DISC — captured last.
    ...DISC_EXPOSURES.map((e) => ({
      key: `limb-${e}x`,
      mode: "sun-only",
      exposure: e,
      hdr: true,
      glareOn: false,
      toggles: {
        enableSolarLimbDarkening: true,
        enableTrueSolarDiscSize: true,
        enableScreenSpaceSunHalo: true,
        enableTrueSolarRadiance: leg.enableTrueSolarRadiance,
      },
    })),
  ],
}));

/** The raw capture at one bracket exposure, or null. */
function legAtExposure(stitched, exposure) {
  const cap = (stitched?.legs ?? []).find((c) => c.exposureFactor === exposure);
  return cap ? toImage(cap) : null;
}

// Reduce ONE radiance leg to scalars. Everything returned is small; the lane's
// pixel arrays are dropped by `runBackendLanes` the instant this returns, which
// is what keeps a 24-capture run's memory flat.
function reduceRadianceLeg(lane, solarModel) {
  const flat = stitchLeg(lane, "flat", DISC_EXPOSURES);
  const legacy = stitchLeg(lane, "legacy", DISC_EXPOSURES);
  const limb = stitchLeg(lane, "limb", DISC_EXPOSURES);
  if (!flat || !legacy || !limb) {
    return { hdrEngaged: false, limbLegLitPixels: 0 };
  }

  // The linear half: disc geometry, the limb differential's centroid and the
  // D2 annulus plateau. Shared with the sun gate, so the geometry this leg is
  // sampled on is the geometry that gate certifies.
  const measured = measureDiscDifferential({
    flat: flat.linear,
    limb: limb.linear,
    legacy: legacy.linear,
    model: solarModel,
    fovXDeg: lane.setup.appliedFovXDeg,
    canvasWidth: lane.setup.canvasWidth,
    ephemerisDiameterDeg: 2 * (lane.setup.expectedSolarAngularRadiusDeg ?? NaN),
    sunProjectionCropPx: lane.setup.sunProjectionCropPx ?? null,
    exposures: DISC_EXPOSURES,
  });

  // The SHIPPED leg's live appearance scalars, read in the same task as the
  // render that produced the pixels, so the derived band describes THIS frame
  // rather than an assumption about it.
  const halo = limb.lead.sunHalo ?? null;
  const cx = Number.isFinite(measured.centroid?.x)
    ? measured.centroid.x
    : flat.linear.width / 2;
  const cy = Number.isFinite(measured.centroid?.y)
    ? measured.centroid.y
    : flat.linear.height / 2;

  // The code half, off the RAW captures at the differential exposure.
  const flatCodes = legAtExposure(flat, RADIANCE_DELTA_EXPOSURE);
  const limbCodes = legAtExposure(limb, RADIANCE_DELTA_EXPOSURE);
  const codes =
    flatCodes && limbCodes
      ? measureDiscDifferentialCodes({
          flat: flatCodes,
          limb: limbCodes,
          cx,
          cy,
          discRadiusPx: measured.discRadiusPx,
        })
      : null;

  // THE SUN BLOOM'S GEOMETRY, all of it live. The blur buffer's size is a
  // function of the drawing buffer alone, and `limbPx` is the same scalar
  // `SunHaloAppearance` hands the halo stage — so the glow this derivation
  // models is built from the numbers the frame was drawn with, not from a
  // framing assumption. The Sun is aimed at, so the composite is centred on the
  // drawing buffer; `centerX/centerY` are read anyway rather than assumed.
  const bloomGeometry =
    halo?.limbPx > 0 &&
    lane.setup.canvasWidth > 0 &&
    lane.setup.canvasHeight > 0
      ? {
          viewportWidth: lane.setup.canvasWidth,
          viewportHeight: lane.setup.canvasHeight,
          limbPx: halo.limbPx,
          centerX: halo.centerX,
          centerY: halo.centerY,
        }
      : null;

  const derived = deriveDiscDifferentialCodes(solarModel, {
    discRadiance: halo?.discRadiance,
    haloAmplitude: halo?.haloAmplitude,
    haloCoreRadii: halo?.haloCoreRadii,
    // The RUN's own disc radius, so the dominant term is derived against the
    // geometry the reading was taken at rather than against a modelled one.
    discRadiusPx: measured.discRadiusPx,
    exposure: RADIANCE_DELTA_EXPOSURE,
    bloom: bloomGeometry,
  });

  // The glow the bright-pass chain adds ACROSS THE D2 PLATEAU, plus the bracket
  // its hard-edged source approximation is only known to. Both travel with the
  // leg so the discrimination subtracts a number this frame produced.
  const glowDifferential = bloomGeometry
    ? discBloomPlateauDifferential(solarModel, {
        discRadiance: halo.discRadiance,
        ...bloomGeometry,
      })
    : undefined;
  const edgeShiftPx = bloomGeometry
    ? discBloomSourceEdgeUncertaintyPx(solarModel, bloomGeometry)
    : 0;
  const glowDifferentialError = bloomGeometry
    ? Math.max(
        Math.abs(
          discBloomPlateauDifferential(solarModel, {
            discRadiance: halo.discRadiance,
            ...bloomGeometry,
            discEdgeShiftPx: -edgeShiftPx,
          }) - glowDifferential,
        ),
        Math.abs(
          discBloomPlateauDifferential(solarModel, {
            discRadiance: halo.discRadiance,
            ...bloomGeometry,
            discEdgeShiftPx: edgeShiftPx,
          }) - glowDifferential,
        ),
      )
    : undefined;

  return {
    hdrEngaged: flat.hdrEngaged && legacy.hdrEngaged && limb.hdrEngaged,
    limbLegLitPixels: measured.limbLegLitPixels,
    differentialPositivePixels: measured.differentialPositivePixels,
    aimDistancePx: measured.aimDistancePx,
    aimDistanceDeg: measured.aimDistanceDeg,
    aim: measured.aim,
    discRadiusPx: measured.discRadiusPx,
    legacyRadiusPx: measured.legacyRadiusPx,
    trueSizeRatio: measured.trueSizeRatio,
    discDiameterDeg: measured.discDiameterDeg,
    centroid: measured.centroid,
    // The D2 plateau and the instrument's own resolution at that brightness.
    ...plateauResolution({
      plateau: measured.discRadianceMeasured,
      plateauPixels: measured.discRadiancePlateauPixels,
      exposures: DISC_EXPOSURES,
    }),
    resolvedRadiance: halo?.discRadiance,
    haloAmplitude: halo?.haloAmplitude,
    haloCoreRadii: halo?.haloCoreRadii,
    limbPx: halo?.limbPx,
    bloomGeometry,
    glowDifferential,
    glowDifferentialError,
    trueRadianceRequested: limb.lead.lightingRequested ?? null,
    shippedHaloState: halo,
    codes,
    derived,
    // Retained diagnostics from the linear view, so a code-side surprise can be
    // read against the linear one without a second run.
    discOnlyRatio: measured.discOnlyRatio_I095_over_I0,
    discPeakLinear: measured.discPeakLinear,
    limbShapeMaxRelDev: measured.limbShapeMaxRelDev,
  };
}

async function run(browser, git) {
  // The shipped photometry module, imported in NODE. It is dependency-free
  // plain ESM, so this is the real engine source rather than a transcription.
  const solarModel = (
    await import("../../packages/engine/Source/Scene/SolarDiscModel.js")
  ).default;

  const browserVersion = browser.version();
  const manifest = {};
  const backends = {};
  const sinks = { webgl: {}, webgpu: {} };

  const writeLaneCaptures = (laneKey, lane, renderer) => {
    for (const [capKey, cap] of Object.entries(lane.captures ?? {})) {
      const img = toImage(cap);
      const sceneName = `sun-hdr-radiance-${laneKey}-${capKey}`;
      const pngName = `${sceneName}-${renderer}.png`;
      const { png } = writeCapturePng(img, pngName);
      const sceneDescriptor = {
        name: sceneName,
        camera: {
          aim: "sun-facing",
          fovXDeg: lane.setup.appliedFovXDeg,
          distance: 5.0e7,
          pinnedIso: PINNED_ISO,
        },
        setup: "sun-radiance-delta",
        setupParams: {
          lane: laneKey,
          capture: capKey,
          hdr: cap.hdrEngaged === true,
          exposure: cap.exposureFactor,
          lighting: cap.lightingRequested,
          settleBudgetMs: SETTLE_BUDGET_MS,
          warmupDiscarded: true,
        },
      };
      manifest[`${sceneName}:${renderer}`] = buildManifestEntry({
        scene: sceneName,
        image: pngName,
        pngBytes: png,
        renderer,
        env: {
          browserClass: "msedge",
          browserVersion,
          adapterClass: normalizeHardwareClass([
            lane.setup.adapter.vendor,
            lane.setup.adapter.architecture,
            lane.setup.adapter.device,
            lane.setup.adapter.description,
          ]),
        },
        git,
        sceneIdentity: createSceneIdentity(sceneDescriptor, {
          baseUrl: BASE,
          settleFrames: SETTLE_MIN_FRAMES,
          viewport: VIEWPORT,
        }),
        extra: {
          lane: laneKey,
          capture: capKey,
          lighting: cap.lightingRequested,
          discRadiance: cap.sunHalo?.discRadiance ?? null,
          haloAmplitude: cap.sunHalo?.haloAmplitude ?? null,
          bakeHaloGain: cap.sunHalo?.bakeHaloGain ?? null,
        },
      });
    }
  };

  const runs = {};
  for (const renderer of ["webgl", "webgpu"]) {
    runs[renderer] = await runBackendLanes(
      browser,
      renderer,
      LANE_DEFS,
      (laneKey, lane) => {
        writeLaneCaptures(laneKey, lane, renderer);
        sinks[renderer][laneKey] = reduceRadianceLeg(lane, solarModel);
      },
    );
    if (!runs[renderer].ok) {
      // Report each backend UNDER ITS OWN NAME — handing the failing run back
      // in the other slot makes the fatal printout blame the wrong renderer.
      return { fatal: true, gl: runs.webgl ?? null, gpu: runs.webgpu ?? null };
    }
  }

  for (const renderer of ["webgl", "webgpu"]) {
    const legs = sinks[renderer];
    const keys = RADIANCE_DELTA_LEGS.map((l) => l.key);
    const excess = discriminateRadianceExcess({
      legs: keys.map((key) => ({
        key,
        resolvedRadiance: legs[key]?.resolvedRadiance,
        plateau: legs[key]?.plateau,
        plateauPixels: legs[key]?.plateauPixels,
        plateauQuantumLinear: legs[key]?.plateauQuantumLinear,
        glowDifferential: legs[key]?.glowDifferential,
        glowDifferentialError: legs[key]?.glowDifferentialError,
      })),
    });
    // How sharply the display-code criteria could have separated the two
    // hypotheses, evaluated on the SHIPPED radiance leg against the radiance
    // that leg actually recovered.
    const shipped = legs[keys[keys.length - 1]];
    const power =
      shipped?.resolvedRadiance > 0 && shipped?.plateau > 0
        ? d1DiscriminationPower(solarModel, {
            resolvedRadiance: shipped.resolvedRadiance,
            recoveredRadiance: shipped.plateau,
            haloAmplitudePerRadiance:
              shipped.haloAmplitude / shipped.resolvedRadiance,
            haloCoreRadii: shipped.haloCoreRadii,
            discRadiusPx: shipped.discRadiusPx,
            exposure: RADIANCE_DELTA_EXPOSURE,
            bloom: shipped.bloomGeometry,
          })
        : null;
    const evaluated = evaluateRadianceDeltaBackend({
      legs,
      excess,
      d1DiscriminationPower: power,
    });
    backends[renderer] = {
      ...evaluated,
      reports: {
        legs: Object.fromEntries(
          Object.entries(legs).map(([k, v]) => [
            k,
            {
              resolvedRadiance: v.resolvedRadiance,
              plateau: v.plateau,
              plateauPixels: v.plateauPixels,
              plateauQuantumLinear: v.plateauQuantumLinear,
              glowDifferential: v.glowDifferential,
              glowDifferentialError: v.glowDifferentialError,
              limbPx: v.limbPx,
              discRadiusPx: v.discRadiusPx,
              trueSizeRatio: v.trueSizeRatio,
              aimDistancePx: v.aimDistancePx,
              trueRadianceRequested: v.trueRadianceRequested,
              measuredCodes: v.codes?.samples ?? null,
              derivedCodes: v.derived?.samples ?? null,
              preRegisteredCodes: PRE_REGISTERED_D1_CODES[k] ?? null,
              discOnlyRatio: v.discOnlyRatio,
              discPeakLinear: v.discPeakLinear,
            },
          ]),
        ),
        excess,
      },
    };
  }

  const folded = foldRadianceDeltaVerdict(backends);
  return {
    fatal: false,
    lane: "sun-radiance-delta",
    ...folded,
    pass: folded.exitCode === EXIT_CODE.PASS,
    backends,
    manifest,
    consoleErrors: {
      webgl: runs.webgl.consoleErrors,
      webgpu: runs.webgpu.consoleErrors,
    },
  };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const git = getGit();
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let result;
  try {
    result = await run(browser, git);
  } finally {
    await browser.close().catch(() => {});
  }

  if (result.fatal) {
    console.error(
      "[probe-sun-hdr-radiance] ERROR — a backend lane did not run at all",
    );
    for (const lane of [result.gl, result.gpu]) {
      if (lane && !lane.ok) {
        console.error(`  ${lane.renderer}: ${lane.error}`);
        for (const e of lane.consoleErrors || []) {
          console.error(`    console: ${e}`);
        }
      }
    }
    clearTimeout(watchdog);
    process.exit(EXIT_CODE.ERROR);
  }

  const outPath = path.join(OUT_DIR, "sun-hdr-radiance.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(buildRadianceDeltaSummary(result), null, 2));

  // THE PRE-REGISTRATION, PRINTED AGAINST WHAT WAS MEASURED. Both hypotheses
  // were written down before the run; this block is where they are settled, and
  // it is printed separately from the criteria so a reader cannot mistake a
  // coarse code criterion for the discrimination.
  console.log("\nPRE-REGISTERED HYPOTHESES (settled by the plateau ratio):");
  for (const [renderer, b] of Object.entries(result.backends ?? {})) {
    const ex = b?.reports?.excess;
    if (!ex) {
      continue;
    }
    console.log(`  ${renderer}`);
    console.log(
      `    plateau (raw)               ${ex.terms?.plateauLo} / ${ex.terms?.plateauHi}`,
    );
    console.log(
      `    sun-bloom glow, subtracted  ${ex.terms?.glowLo} / ${ex.terms?.glowHi}  (modelled: ${ex.glowModelled})`,
    );
    console.log(
      `    the DISC's own plateau      ${ex.terms?.discPlateauLo} / ${ex.terms?.discPlateauHi}`,
    );
    console.log(
      `    recovered / resolved        ${JSON.stringify(ex.recoveredResidual)} against ${JSON.stringify(ex.recoveryBar)}`,
    );
    console.log(
      `    plateau ratio measured      ${ex.ratioMeasured} (+/- ${ex.tolerance})`,
    );
    console.log(
      `    MULTIPLICATIVE predicts     ${ex.ratioMultiplicative}  (parameter-free: the ratio of the two RESOLVED radiances)`,
    );
    console.log(
      `    ADDITIVE predicts           ${ex.ratioAdditive}  (c = ${ex.additiveConstant}, estimated from the shipped leg)`,
    );
    console.log(
      `    separation / instrument     ${ex.separation} / ${ex.sigmaRatio}`,
    );
    console.log(
      `    recovered per leg           ${JSON.stringify(ex.recovered)}`,
    );
    console.log(`    VERDICT                     ${ex.verdict}`);
    const power = b?.diagnostics?.d1DiscriminationPower;
    if (power) {
      console.log(
        `    display-code criteria separate the hypotheses at: ${power.samples
          .map((s) => `x=${s.x} ${s.power.toFixed(2)}x tol`)
          .join(", ")}`,
      );
      console.log(
        "    (a value below 1 means that criterion CANNOT tell the two apart — " +
          "its verdict is not evidence either way)",
      );
    }
    const skipped = b?.diagnostics?.nonCertifyingSamples ?? [];
    if (skipped.length > 0) {
      console.log(
        "    NON-CERTIFYING samples (measured, reported, not scored):",
      );
      for (const s of skipped) {
        console.log(
          `      ${s.name}: expected ${s.expected}, measured ${s.measured} — ${s.reason}`,
        );
      }
    }
  }

  // REPORTED, not gated — the same posture the rest of the fleet takes.
  for (const [renderer, errs] of Object.entries(result.consoleErrors ?? {})) {
    if (errs && errs.length > 0) {
      console.log(`console errors (${renderer}): ${errs.length}`);
      errs.slice(0, 6).forEach((e) => console.log(`  ERR: ${e}`));
    }
  }
  console.log(`\n[full report: ${outPath}]`);

  const exitCode = result.exitCode;
  const verdictLine = {
    [EXIT_CODE.PASS]: `sun-radiance-delta PASS — the disc's display codes match the band derived from the shipped model on both backends, and the radiance excess resolved to one shape (${result.backends?.webgl?.diagnostics?.excessVerdict ?? EXCESS_SHAPE.NEITHER})`,
    [EXIT_CODE.FAIL]:
      "sun-radiance-delta FAIL — see failures[] above; each entry names the backend and the predicate. A pass on ONE backend is a FAIL: every scalar this run reads is CPU-resolved in shared code before the backend branch",
    [EXIT_CODE.STRUCTURAL]:
      "sun-radiance-delta STRUCTURAL — a lane ran but could not see its subject; this is NOT a pass and NOT a defect (see structural[] above)",
  };
  console.log(verdictLine[exitCode] ?? `sun-radiance-delta exit ${exitCode}`);
  clearTimeout(watchdog);
  process.exit(exitCode);
})().catch((e) => {
  console.error("[probe-sun-hdr-radiance] FATAL", e);
  clearTimeout(watchdog);
  process.exit(EXIT_CODE.ERROR);
});
