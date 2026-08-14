#!/usr/bin/env node
// probe-celestial-gates.mjs — Campaign 12 celestial gate harness (C12-01 + C12-02).
//
// WHAT THIS IS
// ------------
// The measured, never-eyeballed gate probe for the celestial appearance work.
// It captures the star field on BOTH backends (WebGL + WebGPU) under the exact
// framing each gate needs and evaluates the second-order metrics from
// Tools/visual-regression/lib/celestial-metrics.mjs (the node --test trust
// anchor). Mean luminance is reported but is EXPLICITLY non-certifying — a
// normalized-kernel convolution (mip/bilinear/MSAA/JPEG) moves the mean by
// zero, so a mean diff cannot see any of these gates.
//
// GATE G1 (default run) — TWO LANES since the C12-G1F2 repair.
//
//   LANE A — `orbital-cubemap-parity`. The historical G1 framing: camera at
//   5.0e7 m along the sun direction, globe / sun / moon / skyAtmosphere / fog
//   OFF, bare star field over a black background, captured three ways per the
//   M6 source-split below. It measures exactly what it can see — CUBEMAP AND
//   SPRITE PARITY. It was previously LABELLED as "the only framing that reaches
//   the C11-176 failure state", which is false in two independent ways:
//     * that camera is ~43,600 km up, far above
//       `ATMOSPHERIC_COLUMN_FADE_END = 111 km` (`SkyBrightness.js`), so
//       `computeAtmosphericColumnFactor` is 0 and `frameState.skyBrightness` is
//       identically 0 — the recorded runs show `skyBrightness 0` at
//       `sunElevationDeg 90`. `AtmosphericConditions.js` states this as the
//       DESIGN ("that camera gets factor 1.0 and is byte-identical to today").
//     * `CubeMapPanorama.js` gates star modulation on
//       `frameState.skyAtmosphereVisible === true`, and this lane turns the sky
//       atmosphere off.
//   PASS requires, on the default pair:
//     M1 point-source count ratio (WebGPU/WebGL) >= 0.90
//     M2a RMS-contrast ratio in [0.85, 1.15]
//     M2b (P99.9 - P50) ratio in [0.85, 1.15]
//     M3 median chroma >= 0.85 x WebGL
//     M2e robust sky floor: |gpu - gl| <= one 8-bit code value in linear light
//   and, on EACH M6 mode, the M1 count ratio >= 0.90 (so a cubemap-only or
//   sprites-only regression cannot be masked by the other source). A mode where
//   BOTH backends census zero sources is reported STRUCTURAL, not FAIL — 0/0 is
//   an instrument that cannot see its subject.
//
//   LANE B — `in-column-star-modulation`. Camera INSIDE the atmospheric column
//   (30 km, i.e. below `ATMOSPHERIC_COLUMN_FADE_START = 60 km`) on the sunlit
//   side with the sky atmosphere ON, so `skyBrightness` saturates to 1.0 and
//   `skyAtmosphereVisible` is true — both C11-176 preconditions met. Captured
//   twice, with `enableStarBrightnessModulation` OFF then ON. The certifying
//   quantity is the modulation's OWN energy, `mean(OFF) - mean(ON)`, taken
//   within each backend and only then compared across backends: differencing
//   inside a backend cancels the sky-atmosphere shell, so a shell-parity gap
//   can neither masquerade as nor mask a star-modulation gap. The OFF/ON swing
//   doubles as the non-vacuity control — a lane whose modulation term never
//   moved a pixel is STRUCTURAL.
//
//   REACHABILITY IS ASSERTED ON THE DRIVING VARIABLE. `framingReached` tests
//   `skyBrightness > 0.5` — `probe-skybox-star-modulation.mjs`'s own predicate —
//   NOT `sunElevationDeg >= 25`. Solar elevation is a proxy that correlates with
//   sky brightness below 60 km and is fully decoupled from it above 111 km,
//   which is where the old assertion was being evaluated.
//
// M6 SOURCE-SPLIT — the true isolation toggles (determined from SkyBox.js +
// Scene.updateEnvironment, NOT guessed):
//   * `skyBox.show`      delegates to the CubeMapPanorama's show only
//     (SkyBox.js get/set show -> _panorama.show). It gates the CUBEMAP command.
//   * `skyBox.starField.show` gates the SPRITE catalogue. StarField.update
//     (StarField.js:142-149) early-returns solely on its own `.show`; the
//     starfield is driven independently in Scene.updateEnvironment
//     (Scene.js:3746-3765), NOT inside SkyBox.update. So `skyBox.show=false`
//     does NOT kill the sprites — it kills only the cubemap.
//   Therefore:
//     default      : skyBox.show=true,  starField.show=true   (cubemap+sprites)
//     cubemap-only : skyBox.show=true,  starField.show=false  (cubemap alone)
//     sprites-only : skyBox.show=false, starField.show=true   (sprites alone —
//                    the cubemap command is dropped; both backends execute the
//                    single returned star command)
//
// GATE EVIDENCE — EXPOSURE BRACKET (--bracket, C12-02).
//   An 8-bit readback cannot measure a halo to 1e-3 of peak — the halo is
//   exactly the part the 8-bit capture discards. The bracket restores ~5 decades
//   of range with no engine change:
//     * scene.highDynamicRange = true  (exposure only takes effect on the HDR
//       path — PostProcessStageCollection.exposure -> tonemap uniform), RECORDED
//       in the manifest as `hdr:true`. Bracket evidence is HDR-lane evidence,
//       distinct from the SDR G1 lanes.
//     * capture at scene.postProcessStages.exposure = 1x, 8x, 64x.
//   STITCH MATH (per pixel, per channel):
//     For a pixel, among the three exposures pick the HIGHEST factor f whose
//     captured 8-bit channel value v is UNCLIPPED (v < 250). The linear estimate
//     is  L = (v / 255) / f. Picking the highest unclipped exposure maximises the
//     signal-to-quantization ratio at that pixel; dividing by f removes the
//     exposure gain. This assumes the display transform is locally LINEAR in the
//     unclipped region (v < 250) — true to good approximation for PBR-Neutral's
//     near-identity low/mid response, and sufficient because M4 measures the
//     RELATIVE radial falloff, which the near-linear low end preserves. The
//     composite spans ~ (1/1) down to (1/255)/64 ~ 6e-5, i.e. > 4 decades, which
//     an 8-bit readback (1/255 ~ 4e-3, ~2.4 decades) cannot reach. The composite
//     is a linear-light float image fed to M4 (brightest source) and M5
//     (curated bright-star cross-match). Both are reported as DIAGNOSTIC — the
//     PSF gates G2/G4 land in W2/W4; the bracket's own PASS is that the range
//     extension is REAL (halo signal recovered below the 8-bit floor).
//
// BINDING PROBE RULES (defect class root-caused Batch 744):
//   1. Pinned clock: viewer.useDefaultRenderLoop=false; EVERY render passes the
//      pinned time — scene.render(viewer.clock.currentTime) — never bare
//      scene.render() (which renders at wall-clock NOW).
//   2. Same-task capture: the final scene.render() and the drawImage/getImageData
//      run in the SAME task with NO await between them (the WebGPU drawing buffer
//      clears once the compositor consumes a presented frame).
//   3. Bounded sun-direction settle loop before any sun-relative aiming (ICRF
//      loads async): <= 180 frames, stable when 10 consecutive deltas < 1e-9.
//   4. Unref'd force-exit watchdog + try/finally browser close.
//   5. HARD exit codes: 0 only on PASS, 1 on gate FAIL, 2 on a lane that failed
//      to RUN, 3 on STRUCTURAL (a lane that ran but could not see its subject).
//   6. Settle is a WALL-CLOCK READINESS BUDGET, not a frame count, and every
//      capture is preceded by a DISCARDED warm-up capture. See SETTLE_BUDGET_MS.
//
// ⚠ LANE A WAS RE-SCOPED FOR DR-01 ON 2026-08-07 (CO-3,
// `PROBE-CELESTIAL-GATES-PRE-DR01-STAR-THRESHOLDS`). Every Lane-A criterion used
// to be built on the M1 point-source COUNT. Batch 833 (C12-11 / DR-01) made
// `SkyBox.defaultVariant = TYCHO_T5_DIFFUSE`, whose faces census 0 resolved
// sources BY CONSTRUCTION, and the sprite catalogue's shipped exposure peaks
// below the census floor in this framing (measured: sprites-only peak code 36
// against a floor of ~code 61) — so all three modes read 0/0 and the lane went
// STRUCTURAL over a healthy scene. The census floor is NOT lowered (that would
// put candidates back inside the diffuse band's own 8-bit range and re-create
// the brightness count the census replaced). Instead, following Batch 848's
// re-scope of `probe-stars-catalog.mjs`, each mode now certifies what it owns
// after the seam — see `lib/celestial-g1-gate.mjs` and `lib/celestial-source-split.mjs`.
//
// GATE G2 (--g2) — the "white blobs" gate. Three sub-lanes per backend, and it
// must PASS IDENTICALLY ON BOTH: the PSF is shared code (`StarField.wgsl` and
// `StarFieldFS.glsl` are character-identical), so a WebGPU-only pass is a FAIL.
//
//   psf         — TELESCOPE framing (fovX 6 deg) aimed at the brightest
//                 catalogue star, sprites only, HDR exposure bracket. The star's
//                 core is SUB-PIXEL at the default 60-degree FOV (analytic core
//                 HWHM 0.47 px), which leaves M4's slope windows — anchored at
//                 multiples of r_core — with fewer than two integer radii, i.e.
//                 no measurable slope at all. Narrowing the FOV magnifies the
//                 same angular profile onto more pixels; nothing about the PSF
//                 changes, only how well it is sampled.
//   magnitude   — DEFAULT framing, same aim, single 1x HDR capture. Cross-matches
//                 the SHIPPED `BrightStarCatalog` (imported from the served
//                 source tree, so positions and magnitudes cannot drift from
//                 what the renderer drew) and measures delivered range, flux
//                 ordering and the clipped-core budget.
//   glare       — C12-27's own acceptance criterion, both halves. Camera on the
//                 SUNLIT side in both legs so `eclipseState.sunVisibleFraction`
//                 is 1 and the veil has a source: aimed AT the Sun (near field,
//                 must dim measurably) and AWAY from it (far field, every star
//                 beyond the 90-degree support, must be BYTE-IDENTICAL with the
//                 toggle on and off). An A/A control proves the byte-identity
//                 claim is falsifiable on this renderer before it is made.
//
// ⚠ THE BRACKET STITCH IS NOW LINEARIZED (same batch). The C12-02 stitch
// computed `L = (v / 255) / f` on the stated assumption that the display
// transform is locally linear. The shipped HDR chain is `exposure ->
// czm_pbrNeutralTonemapping -> czm_inverseGamma`, whose gamma step alone is
// `pow(x, 1/2.2)` and whose PBR-Neutral black offset leaves `6.25 x^2` for a
// neutral pixel below 0.08 — it SQUARES the faint end, which is exactly the halo
// a PSF gate measures. `lib/celestial-g2-gate.mjs` inverts the chain exactly.
// Consequence: the M4/M5 numbers the `--bracket` diagnostic printed before this
// batch (`ratio1e3 = 9.27` off-browser) are NOT comparable to the ones it prints
// now (the same synthetic profile linearizes to 6.35). They were DIAGNOSTIC and
// certified nothing, so nothing is invalidated — but do not diff them.
//
// EXIT CODES:
//   0 PASS  1 FAIL (a measurable criterion is out of band)
//   2 ERROR (a backend lane did not run)
//   3 STRUCTURAL (a lane ran but could not see its subject — reachability not
//     met, or the modulation term never moved a pixel, or both backends drew no
//     lit pixel in a mode). NEVER report such a lane as 0.
//
// GATE G3 (--g3) — the "asset upgrade" gate: the star-map cube faces
// themselves. Five sub-lanes per backend, and — like G2 — it must PASS
// IDENTICALLY ON BOTH. The faces are backend-neutral bytes, so the asset arms
// are identical by construction and a disagreement there is a real finding
// (different variant resolved, or different bytes served), not noise.
//
//   asset       — the SERVED cube faces of the ACTIVE variant, fetched from the
//                 URLs the ENGINE resolved (`SkyBox.createEarthSkyBox(...)`),
//                 decoded in Node, and measured for §5's criteria (1) angular
//                 sampling, (3) median chroma + the JPEG SOF chroma-subsampling
//                 fact, and (4) dust-lane structure. Criterion (4) is a RATIO
//                 against the bundled t3 faces, which are measured in the SAME
//                 run rather than read from a stored constant.
//   split       — DR-01's seam, asserted twice: on the served BYTES (the diffuse
//                 faces census ~0 resolved sources, the un-blurred reversal
//                 faces census many — the detector's positive control) and on a
//                 LIVE cubemap-only frame (so a runtime variant flip cannot hide
//                 behind innocent bytes).
//   catalogue   — the supply DR-01 moved the resolved stars onto: the shipped
//                 `BrightStarCatalog` depth and limiting magnitude, plus a live
//                 sprites-only frame that must actually resolve a star.
//   adversarial — the LEGACY t3 faces pushed through the SAME metrics, required
//                 to FAIL. A gate that cannot reject the asset it was written to
//                 replace is measuring nothing, so a clean t3 is a gate FAILURE.
//   motion      — DR-01's reversal triggers under CAMERA MOTION. Certifying only
//                 for instrument validity and cross-backend agreement; the
//                 trigger readings themselves are evidence for a maintainer
//                 ruling, per DR-01's own "decide on evidence, not impression".
//
// GATE G4 (--g4) — "Sun + Moon". Six sub-lanes per backend, and — like G2 and
// G3 — it must PASS IDENTICALLY ON BOTH. Every term it measures is resolved
// CPU-side and published on `frameState` BEFORE the backend branch
// (`SunDiscAppearance`, `SunHaloAppearance`, `MoonPhaseAppearance`), which is
// precisely why a one-backend pass is a FAIL rather than a partial pass.
//
//   policy      — C12-28's SDR leg, plus the LIVE positive control that makes
//                 it non-vacuous: the scene's DETECTED display state is forced
//                 to HDR, the shipped resolver is re-run, the flag must FLIP,
//                 and restoring the real detection must flip it back. Also
//                 fetches the served sun-bake source for the C12-19 pending
//                 arm. Takes no picture. Runs FIRST, before any capture pins
//                 the HDR flag as user-set.
//   disc        — C12-15 + C12-18. Telescope framing (fovX 2 deg), sun over
//                 black, three toggle legs: limb OFF (flat), true-size OFF
//                 (legacy), and the shipped default. `flat - limb` isolates the
//                 limb law with the screen halo CANCELLING EXACTLY; `flat -
//                 legacy` is an annulus whose two edges are the legacy and
//                 true-size discs, and whose ratio is B906's 1.4142 fix.
//   halo        — C12-18's screen-space tail, measured between 16 and 30 solar
//                 radii — past the billboard's own corner at sqrt(2)*11 =
//                 15.56 R_sun, so the bake leg is the positive control that the
//                 band is EMPTY without the post-process chain. Also reads the
//                 one-halo-source invariant (`screenHalo -> bakeHaloGain 0`)
//                 LIVE off `frameState.sunHalo`, and asserts the eclipse alpha
//                 chain's exact identity on the sunlit side.
//   earthshine  — C12-21's owed Edge acceptance. Three phase epochs solved with
//                 the moon-appearance demo's own `findTimeForPhase`; the unlit
//                 limb's `ON - OFF` delta must be present at the crescent,
//                 carry the shipped ashen tint, SCALE WITH THE LIVE RESOLVED
//                 Earth-phase complement, and go inert at full moon.
//   terminator  — C12-22's owed Edge acceptance. Softening ON vs OFF at the
//                 quarter epoch: a thin non-negative band hugging the
//                 terminator, ZERO darkened pixels (the model's own property),
//                 and a live softness equal to the solar angular radius.
//   phase       — the disc brightens with phase, and §5's full:quarter bar
//                 behind an explicit REACHABILITY gate (see
//                 `SURGE_REACHABLE_MAX_PHASE_ANGLE_DEG`).
//
// ⚠ ONE CRITERION IS A PENDING ARM. §5's `I(0.95R)/I(0) in [0.3,0.5]` cannot be
// measured as an ABSOLUTE ratio until `C12-19` removes the `clamp(...,0,1)` from
// both sun bakes — both bake sources say so in their own comments. The arm is
// neither failed nor skipped: it self-activates from two independent live
// discriminators (the served bake's clamp, and the measured peak disc radiance
// against a bound the clamped build cannot exceed), reports
// `STRUCTURAL-pending-content:C12-19` BY NAME in its own printed block, and the
// ratio is measured and reported every run so the number is on the record
// before the content lands. A DISAGREEMENT between the two discriminators is
// STRUCTURAL rather than a guess.
//
// Usage:
//   node Tools/visual-regression/probe-celestial-gates.mjs            # G1 (SDR)
//   node Tools/visual-regression/probe-celestial-gates.mjs --bracket  # C12-02 HDR bracket
//   node Tools/visual-regression/probe-celestial-gates.mjs --g2       # G2 (PSF + glare)
//   node Tools/visual-regression/probe-celestial-gates.mjs --g3       # G3 (star-map asset)
//   node Tools/visual-regression/probe-celestial-gates.mjs --g4       # G4 (sun + moon)
//   PROBE_BASE=http://localhost:8080 node ... (override server)

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import {
  m1PointSourceCensus,
  m2ContrastTail,
  m2eSkyFloor,
  m3Chroma,
  m4RadialFalloff,
  m5MagnitudeFidelity,
  spearman,
} from "./lib/celestial-metrics.mjs";
import { sha256, createSceneIdentity } from "./lib/visual-gate-policy.mjs";
import {
  EXIT_CODE,
  MODE_ROLE,
  buildG1Summary,
  evaluateCubemapParityLane,
  evaluateStarModulationLane,
  foldG1Verdict,
  ratio,
} from "./lib/celestial-g1-gate.mjs";
import {
  m3ChromaTopK,
  m7LitExtent,
  m8PixelAgreement,
} from "./lib/celestial-source-split.mjs";
import {
  CLIPPED_SEARCH_RADIUS_PX,
  CLIP_LEVEL_LINEAR,
  buildG2Summary,
  displayToLinear,
  evaluateG2Backend,
  foldG2Verdict,
  stitchBracketLinear,
} from "./lib/celestial-g2-gate.mjs";
import {
  analyzeFace,
  buildG3Summary,
  canonicalG3ActiveSourceFingerprintPayload,
  computeAssetTriggers,
  evaluateG3Backend,
  evaluateG3SourcePreflight,
  foldG3Verdict,
  foldVariant,
  G3_CERTIFICATION_RESOLUTION,
  G3_CERTIFICATION_VARIANT,
  G3_CUBE_FACE_KEYS as G3_FACE_KEYS,
  G3_CUBE_SOURCE_KEYS as G3_SOURCE_KEYS,
} from "./lib/celestial-g3-gate.mjs";
import {
  DISC_BRACKET_EXPOSURES,
  EARTHSHINE_INERTNESS_QUANTILE,
  HALO_AIM_SEARCH_RADIUS_PX,
  MOON_DISC_MASK_FRACTION,
  MOON_PHASE_TARGETS,
  MOON_UNLIT_DARK_FLOOR,
  MOON_UNLIT_MASK_FRACTION,
  TERMINATOR_DELTA_EPS,
  bracketQuantumAt,
  buildG4Summary,
  deriveDiscOnlyLimbBand,
  deriveDiscRadianceRecoveryBand,
  discDeltaCensus,
  discIntegratedBrightness,
  evaluateG4Backend,
  expectedCompositeLimbRatio,
  findRetainedImageBuffers,
  foldG4Verdict,
  measureDiscDifferential,
  measureHaloProfile,
  unlitLimbDelta,
} from "./lib/celestial-g4-gate.mjs";
import {
  BASE,
  CROP,
  OUT_DIR,
  PINNED_ISO,
  SETTLE_BUDGET_MS,
  SETTLE_MIN_FRAMES,
  SETTLE_YIELD_MS,
  VIEWPORT,
  buildManifestEntry,
  captureMode,
  getGit,
  normalizeHardwareClass,
  runBackendLanes,
  setupScene,
  stitchLeg,
  toImage,
  withPage,
  writeCapturePng,
} from "./lib/celestial-capture-harness.mjs";

// MODE CAPTURE ORDER — EXPLICIT AND CERTIFYING-LAST.
//
// The previous order was `["default", "cubemap-only", "sprites-only"]`, so the
// only certifying mode was always captured against the COLDEST caches while its
// non-certifying siblings inherited warm ones. That is an ordered contamination
// whose bias runs in the direction the gate scores. The certifying mode is now
// captured LAST, after its siblings have warmed everything it shares.
const G1_MODE_CAPTURE_ORDER = ["cubemap-only", "sprites-only", "default"];
const G1_CERTIFYING_MODE = "default";
const G1_COUNT_MODES = ["cubemap-only", "sprites-only"];

// Lane B captures OFF first so the certifying difference `mean(OFF) - mean(ON)`
// is taken with ON — the state the defect lives in — measured last and warmest.
const COLUMN_MODE_CAPTURE_ORDER = ["modulation-off", "modulation-on"];

// Lane B camera height, metres. Below ATMOSPHERIC_COLUMN_FADE_START (60 km) so
// `computeAtmosphericColumnFactor` is exactly 1.0 and `skyBrightness` is
// whatever the solar geometry says — which, with the camera placed along the
// sun direction, is the saturated daylight value 1.0.
const IN_COLUMN_HEIGHT_M = 30000;

// Lane A's three modes no longer measure the same thing after DR-01 — the
// cube map owns diffuse light and the sprites own resolved stars — so each one
// declares which role it plays and the gate lib builds a different criterion set
// for it. See `MODE_ROLE` in lib/celestial-g1-gate.mjs.
const G1_MODE_ROLES = Object.freeze({
  default: MODE_ROLE.COMPOSITE,
  "cubemap-only": MODE_ROLE.DIFFUSE,
  "sprites-only": MODE_ROLE.SPRITES,
});

// G2 TELESCOPE FRAMING. The star PSF is defined in ANGLE (the quad's base
// half-angle is 0.003 rad and the C12-06 glare cap is 1 degree), so narrowing
// the FOV samples the identical profile onto more pixels. At the default 60
// deg the analytic core HWHM is 0.47 px and M4's slope windows — [2*r_core,
// 5*r_core] and [5*r_core, 15*r_core] — contain fewer than two integer radii,
// so the "two agreeing log-log slopes" criterion is UNMEASURABLE. At 6 deg the
// modelled core HWHM is 4.9 px, r_1e-3 is 35 px, and the windows carry 11 and
// 35 samples. 6 rather than 4 because the quad must stay inside the crop with
// margin (modelled quad half-extent 88.8 px against a 320 px crop half-height).
const G2_TELESCOPE_FOV_X_DEG = 6.0;
// Enough to reach past the AA window's outer edge (modelled 88.8 px) so a
// truncated profile is visible as truncation rather than as a missing crossing.
const G2_PSF_MAX_RADIUS_PX = 120;
// Faintest catalogue magnitude offered to the M5 cross-match. Stars fainter
// than the ~3.6 exposure anchor fall below the M1 census floor and simply go
// unmatched; including them costs nothing and keeps the faint end of the
// delivered range in play if the exposure ever moves.
const G2_MAGNITUDE_MAX_VMAG = 4.5;

const BRACKET = process.argv.includes("--bracket");
const G2 = process.argv.includes("--g2");
const G3 = process.argv.includes("--g3");
const G4 = process.argv.includes("--g4");

// G3 MOTION SWEEP — sub-pixel translation of the star field under a camera-only
// rotation at the PINNED clock. The clock never advances, so the stars' inertial
// directions are fixed and the ONLY thing changing is where each sprite lands
// relative to the pixel grid. That is what isolates sampling phase from every
// other reason a star could change brightness (ephemeris, extinction, day fade).
//
// The step is deliberately NOT a whole pixel and not a simple fraction: 0.37 px
// walks the sub-pixel phase around the unit square without ever repeating inside
// the sweep, so 24 frames sample 24 distinct phases and the max/min they bracket
// is a lower bound on the true swing. 24 frames because the analytic model puts
// the peak's full phase period at 1 px, so ~2.7 periods are covered.
const G3_MOTION_FRAMES = 24;
const G3_MOTION_STEP_PX = 0.37;
// Half-size of the measurement box around a target star's predicted position.
// The modelled quad half-extent at the default framing is 3.667 px, so 6 px
// contains the whole sprite with margin while staying far smaller than the
// nearest-neighbour spacing the target selection enforces.
const G3_MOTION_BOX_HALF_PX = 6;
// Faint-target magnitude window. Below `MAG_CUTOFF` (5.5) so the star is drawn
// at all, and at the faint end because DR-01's trigger is specifically about
// faint sprites ("sub-pixel sprites are the classic failure").
const G3_FAINT_VMAG_MIN = 4.5;
const G3_FAINT_VMAG_MAX = 5.4;
// A target must have no catalogue neighbour within this angle, so the box
// measures ONE star. 4x the box's own angular half-size at the default framing.
const G3_TARGET_ISOLATION_DEG = 0.35;
// Raised from 300s at the C12-G1F2 repair: the run now has two lanes, and every
// capture pays a wall-clock settle budget plus a discarded warm-up (see
// SETTLE_BUDGET_MS). The watchdog must outlast the honest worst case or it
// becomes the thing that fails the gate.
// G3 gets more again: it pays two settled captures per backend PLUS a 24-frame
// motion sweep per backend, and then decodes eighteen 2048-px JPEGs off-browser.
// G4 is the longest of the four: SEVEN settled setups and 28 settled captures
// per backend — disc (3 toggle legs x 2 exposures), halo (2 x 2), three moon
// epochs (2 x 2 each) and the terminator lane (2 x 3) — every one of them
// preceded by a discarded warm-up capture, plus a zero-capture policy lane. At
// the measured ~7 s per capture that is ~4 min per backend; the budget is 40 min
// so the watchdog cannot become the thing that fails the gate on a cold machine.
const HARD_LIMIT_MS = G4 ? 2400000 : G3 ? 1800000 : G2 ? 1200000 : 600000;
const watchdog = setTimeout(() => {
  console.error(
    `[probe-celestial-gates] WATCHDOG FIRED (${HARD_LIMIT_MS / 1000}s) — forcing exit`,
  );
  process.exit(EXIT_CODE.ERROR);
}, HARD_LIMIT_MS);
if (watchdog.unref) {
  watchdog.unref();
}

const r3 = (x) => (!Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
// NOTE: sky floors, means and stddevs are reported UNROUNDED. The M2e tolerance
// is ~3.0e-4 in linear light, so the 3-decimal rounder this report used to apply
// to `webgl_skyFloor`/`webgpu_skyFloor` printed every legitimate floor as a flat
// 0 and made the pedestal discriminator unreadable in the very report that was
// supposed to carry it.

// Stitch the 1x/8x/64x captures into a linear-light float composite.
//
// ⚠ THE STITCH MOVED (2026-08-07, CO-3). It used to be `L = (v / 255) / f` —
// the raw code divided by the exposure — which is only correct if the display
// transform is the identity. The shipped HDR chain is `exposure ->
// czm_pbrNeutralTonemapping -> czm_inverseGamma`; its gamma step is
// `pow(x, 1/2.2)` and PBR Neutral's black offset leaves `6.25 x^2` for a
// neutral pixel below 0.08, i.e. it SQUARES the halo a PSF gate is trying to
// measure. `stitchBracketLinear` inverts the chain exactly (see
// lib/celestial-g2-gate.mjs); the function is kept here as a one-line
// forwarder so both the legacy `--bracket` diagnostic and the G2 gate read the
// same composite, and so `git log -S stitchBracket` still lands on this note.
function stitchBracket(captures) {
  return stitchBracketLinear(captures);
}

async function runBackend(
  browser,
  renderer,
  { aim, hdr, modes, skyAtmosphereOn, cameraHeightM },
) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") {
      consoleErrors.push(m.text().slice(0, 200));
    }
  });
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      },
    );
    await page.waitForFunction(
      () =>
        !!(window.viewer && window.viewer.scene && window.viewer.scene.context),
      null,
      { timeout: 90000 },
    );
    await page.waitForTimeout(5000);

    const setup = await setupScene(page, {
      aim,
      skyAtmosphereOn,
      cameraHeightM,
    });
    const captures = {};
    if (hdr) {
      for (const [factor, label] of [
        [1, "1x"],
        [8, "8x"],
        [64, "64x"],
      ]) {
        captures[label] = await captureMode(page, {
          mode: "bracket",
          crop: setup.crop,
          exposure: factor,
          hdr: true,
        });
      }
    } else {
      // Order is the caller's explicit, justified sequence — see
      // G1_MODE_CAPTURE_ORDER / COLUMN_MODE_CAPTURE_ORDER.
      for (const mode of modes ?? G1_MODE_CAPTURE_ORDER) {
        captures[mode] = await captureMode(page, {
          mode,
          crop: setup.crop,
          hdr: false,
        });
      }
    }
    return {
      ok: true,
      renderer,
      setup,
      captures,
      consoleErrors: consoleErrors.slice(0, 6),
    };
  } catch (e) {
    return {
      ok: false,
      renderer,
      error: String((e && e.message) || e).slice(0, 400),
      consoleErrors: consoleErrors.slice(0, 6),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

function metricsForImage(image) {
  const m1 = m1PointSourceCensus(image);
  const m2 = m2ContrastTail(image);
  const m2e = m2eSkyFloor(image);
  const m3 = m3Chroma(image, m1.sources);
  return { m1, m2, m2e, m3 };
}

// The two G1 lanes. `cameraHeightM: null` means "use the historical orbital
// distance"; a finite value places the eye that far above the ellipsoid on the
// sun ray. `skyAtmosphereOn` decides both whether the background is black (and
// therefore whether the M2e quantization bound applies) and whether
// `frameState.skyAtmosphereVisible` — a hard precondition of the star-modulation
// term — can ever be true.
const G1_LANE_SPECS = [
  {
    key: "cubemapParity",
    id: "orbital-cubemap-parity",
    role: "cubemap + sprite parity over a black background (M6 source split)",
    modes: G1_MODE_CAPTURE_ORDER,
    countModes: G1_COUNT_MODES,
    certifyingMode: G1_CERTIFYING_MODE,
    modeRoles: G1_MODE_ROLES,
    skyAtmosphereOn: false,
    cameraHeightM: null,
  },
  {
    key: "starModulation",
    id: "in-column-star-modulation",
    role: "C11-176 star-brightness modulation, inside the atmospheric column",
    modes: COLUMN_MODE_CAPTURE_ORDER,
    countModes: [],
    certifyingMode: "modulation-on",
    skyAtmosphereOn: true,
    cameraHeightM: IN_COLUMN_HEIGHT_M,
  },
];

function comparePair(glImg, gpuImg) {
  const glM = metricsForImage(glImg);
  const gpuM = metricsForImage(gpuImg);
  // POST-DR-01 Lane-A instruments (see lib/celestial-source-split.mjs). The M1
  // counts above are RETAINED and reported — a cube map that regains resolved
  // sources has to be visible — but they census 0/0 at HEAD by construction, so
  // the parity claim now rides on lit extent, per-pixel agreement and chroma
  // over the brightest sprite pixels.
  const glLit = m7LitExtent(glImg);
  const gpuLit = m7LitExtent(gpuImg);
  const agreement = m8PixelAgreement(glImg, gpuImg);
  const glChroma = m3ChromaTopK(glImg);
  const gpuChroma = m3ChromaTopK(gpuImg);
  return {
    m1CountRatio: ratio(gpuM.m1.count, glM.m1.count),
    litPixelRatio: ratio(gpuLit.litPixels, glLit.litPixels),
    webglLitPixels: glLit.litPixels,
    webgpuLitPixels: gpuLit.litPixels,
    webglPeakLuminance: glLit.peakLuminance,
    webgpuPeakLuminance: gpuLit.peakLuminance,
    differingPixels: agreement.differingPixels,
    differingFraction: agreement.differingFraction,
    maxChannelDelta: agreement.maxChannelDelta,
    bitIdentical: agreement.bitIdentical,
    webglMedianSaturation: glChroma.medianSaturation,
    webgpuMedianSaturation: gpuChroma.medianSaturation,
    webglChromaSamples: glChroma.sampleCount,
    webgpuChromaSamples: gpuChroma.sampleCount,
    webglHueIQR: glChroma.hueIQR,
    webgpuHueIQR: gpuChroma.hueIQR,
    m2aRatio: ratio(gpuM.m2.rmsContrast, glM.m2.rmsContrast),
    m2bRatio: ratio(gpuM.m2.p999MinusP50, glM.m2.p999MinusP50),
    // RE-POINTED for DR-01: the shipped M3 samples HSV saturation at the M1
    // detections, which is an EMPTY SET on every Lane-A mode at HEAD. The
    // top-K form samples the brightest pixels instead, which is well defined
    // precisely in `sprites-only`, where the cube map is switched off and every
    // non-black pixel is sprite output. The M1-sourced value is kept as a
    // diagnostic so the supersession is visible in the report.
    m3ChromaRatio: ratio(gpuChroma.medianSaturation, glChroma.medianSaturation),
    m3ChromaRatio_M1_SOURCED_DIAGNOSTIC: ratio(
      gpuM.m3.medianSaturation,
      glM.m3.medianSaturation,
    ),
    // ATTRIBUTION FACTORS for m2aRatio = (sigma/mu)_gpu / (sigma/mu)_gl. Without
    // both of these a failing m2aRatio cannot be attributed to a mean/pedestal
    // shift versus a contrast excess — the omission that produced C12-G1F2.
    meanLumRatio: ratio(gpuM.m2.mean, glM.m2.mean),
    stddevRatio: ratio(gpuM.m2.stddev, glM.m2.stddev),
    webglMean: glM.m2.mean,
    webgpuMean: gpuM.m2.mean,
    webglStddev: glM.m2.stddev,
    webgpuStddev: gpuM.m2.stddev,
    webglM1Count: glM.m1.count,
    webgpuM1Count: gpuM.m1.count,
    webglSkyFloor: glM.m2e.skyFloor,
    webgpuSkyFloor: gpuM.m2e.skyFloor,
  };
}

async function runG1Lane(browser, git, spec, browserVersion) {
  const gl = await runBackend(browser, "webgl", {
    aim: "sunlit",
    hdr: false,
    modes: spec.modes,
    skyAtmosphereOn: spec.skyAtmosphereOn,
    cameraHeightM: spec.cameraHeightM,
  });
  const gpu = await runBackend(browser, "webgpu", {
    aim: "sunlit",
    hdr: false,
    modes: spec.modes,
    skyAtmosphereOn: spec.skyAtmosphereOn,
    cameraHeightM: spec.cameraHeightM,
  });
  if (!gl.ok || !gpu.ok) {
    return { fatal: true, gl, gpu };
  }

  const envOf = (backend) => ({
    browserClass: "msedge",
    browserVersion,
    adapterClass: normalizeHardwareClass([
      backend.setup.adapter.vendor,
      backend.setup.adapter.architecture,
      backend.setup.adapter.device,
      backend.setup.adapter.description,
    ]),
  });

  const manifest = {};
  const perMode = {};
  for (const mode of spec.modes) {
    const glImg = toImage(gl.captures[mode]);
    const gpuImg = toImage(gpu.captures[mode]);
    perMode[mode] = comparePair(glImg, gpuImg);

    for (const [renderer, backend, img] of [
      ["webgl", gl, glImg],
      ["webgpu", gpu, gpuImg],
    ]) {
      const sceneName = `celestial-g1-${spec.id}-${mode}`;
      const pngName = `${sceneName}-${renderer}.png`;
      const { png } = writeCapturePng(img, pngName);
      const sceneDescriptor = {
        name: sceneName,
        camera: {
          aim: "sunlit",
          heightM: spec.cameraHeightM,
          distance: spec.cameraHeightM === null ? 5.0e7 : null,
          pinnedIso: PINNED_ISO,
        },
        setup: "celestial-gate-g1",
        setupParams: {
          lane: spec.id,
          mode,
          globeOff: true,
          sunOff: true,
          skyAtmosphereOn: spec.skyAtmosphereOn,
          settleBudgetMs: SETTLE_BUDGET_MS,
          warmupDiscarded: true,
        },
      };
      const sceneIdentity = createSceneIdentity(sceneDescriptor, {
        baseUrl: BASE,
        settleFrames: SETTLE_MIN_FRAMES,
        viewport: VIEWPORT,
      });
      manifest[`${sceneName}:${renderer}`] = buildManifestEntry({
        scene: sceneName,
        image: pngName,
        pngBytes: png,
        renderer,
        env: envOf(backend),
        git,
        sceneIdentity,
        extra: {
          hdr: false,
          lane: spec.id,
          skyBrightness: r3(backend.captures[mode].skyBrightness),
          skyAtmosphereVisible: backend.captures[mode].skyAtmosphereVisible,
          modulationFlag: backend.captures[mode].modulationFlag,
          cameraHeightM: r3(backend.setup.cameraHeightM),
          sunElevationDeg: r3(backend.setup.sunElevationDeg),
        },
      });
    }
  }

  // skyBrightness is read from the CERTIFYING mode's own capture, not from
  // setup: the reachability claim has to describe the frame that was gated.
  const certifying = spec.certifyingMode;
  const laneInput = {
    id: spec.id,
    role: spec.role,
    skyBrightness: {
      webgl: gl.captures[certifying].skyBrightness,
      webgpu: gpu.captures[certifying].skyBrightness,
    },
    skyAtmosphereVisible: {
      webgl: gl.captures[certifying].skyAtmosphereVisible,
      webgpu: gpu.captures[certifying].skyAtmosphereVisible,
    },
    sunElevationDeg: {
      webgl: r3(gl.setup.sunElevationDeg),
      webgpu: r3(gpu.setup.sunElevationDeg),
    },
    cameraHeightM: {
      webgl: r3(gl.setup.cameraHeightM),
      webgpu: r3(gpu.setup.cameraHeightM),
    },
    countModes: spec.countModes,
    // Forwarded so the gate lib can apply the BLINDNESS rule to the certifying
    // mode as well, rather than defaulting to its own copy of the name.
    certifyingMode: spec.certifyingMode,
    // Which post-DR-01 subject each mode certifies. Absent for Lane B, whose
    // two modes are an A/B of one flag rather than a source split.
    modeRoles: spec.modeRoles ?? {},
    perMode,
  };

  return { fatal: false, laneInput, manifest, gl, gpu };
}

async function runG1(browser, git) {
  const browserVersion = browser.version();
  const lanes = {};
  const manifest = {};
  const consoleErrors = {};
  for (const spec of G1_LANE_SPECS) {
    const run = await runG1Lane(browser, git, spec, browserVersion);
    if (run.fatal) {
      return { fatal: true, gl: run.gl, gpu: run.gpu };
    }
    Object.assign(manifest, run.manifest);
    consoleErrors[`${spec.id}:webgl`] = run.gl.consoleErrors;
    consoleErrors[`${spec.id}:webgpu`] = run.gpu.consoleErrors;
    lanes[spec.key] =
      spec.key === "starModulation"
        ? evaluateStarModulationLane(run.laneInput)
        : evaluateCubemapParityLane(run.laneInput);
  }

  const folded = foldG1Verdict(lanes);
  return {
    fatal: false,
    gate: "G1",
    ...folded,
    pass: folded.exitCode === EXIT_CODE.PASS,
    // Kept at the top level for continuity with the historical report shape.
    // It now reports the STAR-MODULATION lane, i.e. the variable that actually
    // drives the defect, not the orbital lane's solar-elevation proxy.
    framingReached: lanes.starModulation?.framingReached ?? false,
    orbitalLaneFramingReached: lanes.cubemapParity?.framingReached ?? false,
    lanes,
    manifest,
    consoleErrors,
  };
}

function bracketDiagnostics(setup, composite) {
  const m1 = m1PointSourceCensus(composite, { alreadyLinear: true });
  if (m1.count === 0) {
    return { m1Count: 0, m4: null, m5: null };
  }
  // Brightest detected source for M4.
  let brightest = m1.sources[0];
  for (const s of m1.sources) {
    if (s.peak > brightest.peak) {
      brightest = s;
    }
  }
  const m4 = m4RadialFalloff(
    composite,
    { x: brightest.x, y: brightest.y },
    {
      alreadyLinear: true,
    },
  );
  const m5 = m5MagnitudeFidelity(setup.expectations, m1.sources, {
    maxDistance: 3,
  });
  return {
    m1Count: m1.count,
    brightest: { x: brightest.x, y: brightest.y, peak: brightest.peak },
    m4: {
      rCore: r3(m4.rCore),
      r1e2: r3(m4.r1e2),
      r1e3: r3(m4.r1e3),
      ratio1e3: r3(m4.ratio1e3),
      slopeInner: r3(m4.slopeInner),
      slopeOuter: r3(m4.slopeOuter),
      peak: r3(m4.peak),
    },
    m5: {
      matched: m5.matched.length,
      spearman: r3(m5.spearman),
      exponent: r3(m5.exponent),
      brightestFaintestRatio: r3(m5.brightestFaintestRatio),
    },
  };
}

async function runBracket(browser, git) {
  const gl = await runBackend(browser, "webgl", { aim: "sirius", hdr: true });
  const gpu = await runBackend(browser, "webgpu", { aim: "sirius", hdr: true });
  if (!gl.ok || !gpu.ok) {
    return { fatal: true, gl, gpu };
  }

  const browserVersion = browser.version();
  const lanes = {};
  const manifest = {};
  let structuralPass = true;
  for (const [renderer, lane] of [
    ["webgl", gl],
    ["webgpu", gpu],
  ]) {
    const caps = [
      lane.captures["1x"],
      lane.captures["8x"],
      lane.captures["64x"],
    ];
    const hdrEngaged = caps.every((c) => c.hdrEngaged === true);
    const composite = stitchBracket(caps);

    // Range-extension proof: the 64x lane must reveal signal where the 1x lane
    // read hard 0 (below the 8-bit floor), around the brightest source.
    const oneX = toImage(caps.find((c) => c.exposureFactor === 1));
    const diag = bracketDiagnostics(lane.setup, composite);
    let rangeExtended = false;
    if (diag.m1Count > 0 && diag.brightest) {
      const { x, y } = diag.brightest;
      // ring at radius ~12 px from the core, where the 8-bit 1x capture is 0.
      let oneXFloorZero = false;
      let compositeSignal = false;
      for (let a = 0; a < 8; a++) {
        const px = Math.round(x + 12 * Math.cos((a / 8) * Math.PI * 2));
        const py = Math.round(y + 12 * Math.sin((a / 8) * Math.PI * 2));
        if (px >= 0 && py >= 0 && px < oneX.width && py < oneX.height) {
          const i = (py * oneX.width + px) * 4;
          const lum8 = oneX.data[i] + oneX.data[i + 1] + oneX.data[i + 2];
          const cl =
            composite.data[i] + composite.data[i + 1] + composite.data[i + 2];
          if (lum8 === 0) {
            oneXFloorZero = true;
          }
          if (cl > 1e-4) {
            compositeSignal = true;
          }
        }
      }
      rangeExtended = oneXFloorZero && compositeSignal;
    }

    const laneOk = hdrEngaged && diag.m1Count > 0;
    if (!laneOk) {
      structuralPass = false;
    }

    // Manifest per bracket exposure step (HDR-lane evidence).
    for (const cap of caps) {
      const img = toImage(cap);
      const label = `${cap.exposureFactor}x`;
      const sceneName = `celestial-bracket-${label}`;
      const pngName = `celestial-bracket-${label}-${renderer}.png`;
      const { png } = writeCapturePng(img, pngName);
      const sceneDescriptor = {
        name: sceneName,
        camera: { aim: "sirius", distance: 5.0e7, pinnedIso: PINNED_ISO },
        setup: "celestial-gate-bracket",
        setupParams: {
          exposure: cap.exposureFactor,
          hdr: true,
          spritesOnly: true,
        },
      };
      const sceneIdentity = createSceneIdentity(sceneDescriptor, {
        baseUrl: BASE,
        settleFrames: SETTLE_MIN_FRAMES,
        viewport: VIEWPORT,
      });
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
        sceneIdentity,
        extra: {
          hdr: true,
          exposureFactor: cap.exposureFactor,
          hdrEngaged: cap.hdrEngaged,
        },
      });
    }

    lanes[renderer] = { hdrEngaged, rangeExtended, ...diag };
  }

  return {
    fatal: false,
    gate: "bracket",
    structuralPass,
    lanes,
    manifest,
    gl,
    gpu,
  };
}

// ---------------------------------------------------------------------------
// GATE G2 — star PSF ("white blobs") + C12-27 angular solar glare.
// ---------------------------------------------------------------------------

// Lane order is deliberate: the two HDR sub-lanes run first so the glare legs,
// whose certifying claim is BYTE-IDENTITY, execute against the warmest caches
// this page will ever have. Within each lane the capture order is
// certifying-last, for the reason `G1_MODE_CAPTURE_ORDER` states.
//
// Every lane pins `glareOn` explicitly rather than inheriting whatever the
// previous lane left behind. The psf/magnitude lanes pin it TRUE because that
// is the shipped default and the gate must measure the shipped configuration;
// Sirius sits ~58 degrees from the Sun at the pinned clock, where the veil is
// 0.006 — a uniform 0.6% scale that cancels out of every ratio G2 takes.
const G2_LANE_DEFS = [
  {
    key: "psf",
    setup: {
      aim: "sirius",
      skyAtmosphereOn: false,
      cameraHeightM: null,
      fovXDeg: G2_TELESCOPE_FOV_X_DEG,
    },
    captures: [
      { key: "1x", mode: "bracket", exposure: 1, hdr: true, glareOn: true },
      { key: "8x", mode: "bracket", exposure: 8, hdr: true, glareOn: true },
      { key: "64x", mode: "bracket", exposure: 64, hdr: true, glareOn: true },
    ],
  },
  {
    key: "magnitude",
    setup: {
      aim: "sirius",
      skyAtmosphereOn: false,
      cameraHeightM: null,
      fovXDeg: null,
      catalogMaxVmag: G2_MAGNITUDE_MAX_VMAG,
    },
    captures: [
      { key: "1x", mode: "bracket", exposure: 1, hdr: true, glareOn: true },
    ],
  },
  {
    key: "glare-near",
    setup: { aim: "sun-facing", skyAtmosphereOn: false, cameraHeightM: null },
    captures: [
      { key: "off", mode: "default", hdr: false, glareOn: false },
      { key: "on", mode: "default", hdr: false, glareOn: true },
    ],
  },
  {
    key: "glare-far",
    setup: { aim: "anti-sun", skyAtmosphereOn: false, cameraHeightM: null },
    captures: [
      { key: "off", mode: "default", hdr: false, glareOn: false },
      // A/A CONTROL — the SAME state captured twice. Without it, a
      // byte-identity PASS cannot be distinguished from a renderer that happens
      // to be deterministic for reasons unrelated to the veil, and a
      // byte-identity FAIL cannot be distinguished from frame-to-frame noise.
      { key: "offAA", mode: "default", hdr: false, glareOn: false },
      { key: "on", mode: "default", hdr: false, glareOn: true },
    ],
  },
];

const G2_LANE_AIMS = Object.freeze(
  Object.fromEntries(G2_LANE_DEFS.map((d) => [d.key, d.setup.aim])),
);

// Linearize a SINGLE HDR capture through the shipped display chain.
function linearizeCapture(capture) {
  const { width, height, data } = capture;
  const f = capture.exposureFactor ?? 1;
  const out = new Float64Array(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    const lin = displayToLinear(data[i], data[i + 1], data[i + 2], f);
    out[i] = lin[0];
    out[i + 1] = lin[1];
    out[i + 2] = lin[2];
    out[i + 3] = 1;
  }
  return { data: out, width, height };
}

// Brightest pixel within `radius` of the crop centre.
//
// POSITIONAL, following Batch 848. The camera is aimed AT the star, so the
// profile's centre is the frame centre BY CONSTRUCTION — there is no need to
// discover it with a census, and good reason not to: aiming at a star puts it
// at NDC (0,0), which for an even-sized crop is a pixel CORNER, so its four
// neighbours are equal and `m1PointSourceCensus`'s STRICT local-maximum test
// drops all four (the exact trap `C12-STAR-POINT-CENSUS-LIVE-CALIBRATION`
// root-caused in the sibling detector). Taking the brightest pixel in a small
// disc around the aim point is immune to that and still asserts WHERE the
// signal is.
function brightestNearCentre(image, radius) {
  const cx = image.width / 2;
  const cy = image.height / 2;
  let best = { x: -1, y: -1, value: -Infinity, distance: Infinity };
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(image.width - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(image.height - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > radius) {
        continue;
      }
      const i = 4 * (y * image.width + x);
      const v =
        0.2126 * image.data[i] +
        0.7152 * image.data[i + 1] +
        0.0722 * image.data[i + 2];
      if (v > best.value) {
        best = { x, y, value: v, distance: d };
      }
    }
  }
  return best;
}

// PSF sub-lane measurements for one backend.
const PSF_AIM_SEARCH_RADIUS_PX = 12;
const PSF_AIM_TOLERANCE_PX = 6;

function psfMetrics(lane) {
  const caps = ["1x", "8x", "64x"].map((k) => lane.captures[k]);
  const hdrEngaged = caps.every((c) => c && c.hdrEngaged === true);
  const composite = stitchBracketLinear(caps);
  const oneX = toImage(caps[0]);
  const aim = brightestNearCentre(composite, PSF_AIM_SEARCH_RADIUS_PX);
  const aimReached = aim.value > 0 && aim.distance <= PSF_AIM_TOLERANCE_PX;

  let m4 = null;
  let subFloorPixelsRecovered = 0;
  if (aimReached) {
    m4 = m4RadialFalloff(
      composite,
      { x: aim.x, y: aim.y },
      { alreadyLinear: true, maxRadius: G2_PSF_MAX_RADIUS_PX },
    );
    // Range-extension proof: count the pixels where the 1x capture quantized to
    // hard zero on every channel while the bracket composite still carries
    // signal. Bounded to the same disc M4 measured over.
    const r = G2_PSF_MAX_RADIUS_PX;
    const x0 = Math.max(0, aim.x - r);
    const x1 = Math.min(composite.width - 1, aim.x + r);
    const y0 = Math.max(0, aim.y - r);
    const y1 = Math.min(composite.height - 1, aim.y + r);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = 4 * (y * composite.width + x);
        const raw = oneX.data[i] + oneX.data[i + 1] + oneX.data[i + 2];
        const lin =
          composite.data[i] + composite.data[i + 1] + composite.data[i + 2];
        if (raw === 0 && lin > 0) {
          subFloorPixelsRecovered++;
        }
      }
    }
  }

  return {
    hdrEngaged,
    fovXDeg: lane.setup.appliedFovXDeg,
    aim: { x: aim.x, y: aim.y, distance: r3(aim.distance), peak: aim.value },
    aimReached,
    // `sources` is what the sub-lane's structural guard reads; the aim point is
    // the subject, so "one positional source" is the honest count here.
    sources: aimReached ? 1 : 0,
    saturatedPixels: composite.saturatedPixels,
    subFloorPixelsRecovered,
    rCore: m4 ? m4.rCore : NaN,
    r1e2: m4 ? m4.r1e2 : NaN,
    r1e3: m4 ? m4.r1e3 : NaN,
    ratio1e3: m4 ? m4.ratio1e3 : NaN,
    slopeInner: m4 ? m4.slopeInner : NaN,
    slopeOuter: m4 ? m4.slopeOuter : NaN,
    peak: m4 ? m4.peak : NaN,
  };
}

// Magnitude sub-lane measurements for one backend.
function magnitudeMetrics(lane) {
  const cap = lane.captures["1x"];
  const linear = linearizeCapture(cap);
  const census = m1PointSourceCensus(linear, { alreadyLinear: true });
  const m5 = m5MagnitudeFidelity(lane.setup.expectations, census.sources, {
    maxDistance: 3,
  });

  // `min(peak_brightest, 1.0) / peak_faintest` — see the sub-lane's docstring
  // for why the numerator is clipped at the LDR white point.
  let maxPeak = -Infinity;
  let minPeak = Infinity;
  const unclippedFlux = [];
  const unclippedPeak = [];
  for (const m of m5.matched) {
    if (m.peak > maxPeak) {
      maxPeak = m.peak;
    }
    if (m.peak > 0 && m.peak < minPeak) {
      minPeak = m.peak;
    }
    if (m.peak > 0 && m.peak < CLIP_LEVEL_LINEAR) {
      unclippedFlux.push(-0.4 * m.vmag);
      unclippedPeak.push(Math.log10(m.peak));
    }
  }
  const numerator = Math.min(maxPeak, CLIP_LEVEL_LINEAR);
  const renderedRange =
    Number.isFinite(numerator) && minPeak > 0 && Number.isFinite(minPeak)
      ? numerator / minPeak
      : NaN;

  // Clipped-core budget around the brightest matched detection, in LINEAR
  // radiance against the LDR white point (NOT against 8-bit code 250 — under
  // PBR Neutral those are a factor of ~2.6 apart).
  let clippedPixels = NaN;
  let brightest = null;
  for (const s of census.sources) {
    if (!brightest || s.peak > brightest.peak) {
      brightest = s;
    }
  }
  if (brightest) {
    clippedPixels = 0;
    const r = CLIPPED_SEARCH_RADIUS_PX;
    const x0 = Math.max(0, brightest.x - r);
    const x1 = Math.min(linear.width - 1, brightest.x + r);
    const y0 = Math.max(0, brightest.y - r);
    const y1 = Math.min(linear.height - 1, brightest.y + r);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (Math.hypot(x - brightest.x, y - brightest.y) > r) {
          continue;
        }
        const i = 4 * (y * linear.width + x);
        const peak = Math.max(
          linear.data[i],
          Math.max(linear.data[i + 1], linear.data[i + 2]),
        );
        if (peak >= CLIP_LEVEL_LINEAR) {
          clippedPixels++;
        }
      }
    }
  }

  return {
    catalogSource: lane.setup.catalogSource,
    expectations: lane.setup.expectations.length,
    censused: census.count,
    matched: m5.matched.length,
    matchedUnclipped: unclippedFlux.length,
    spearman: spearman(unclippedFlux, unclippedPeak),
    spearman_ALL_MATCHED_DIAGNOSTIC: m5.spearman,
    exponent_DIAGNOSTIC: m5.exponent,
    renderedRange,
    numeratorClipped: Number.isFinite(maxPeak)
      ? maxPeak >= CLIP_LEVEL_LINEAR
      : null,
    brightestPeak: Number.isFinite(maxPeak) ? maxPeak : null,
    faintestPeak: Number.isFinite(minPeak) ? minPeak : null,
    clippedPixels,
  };
}

// SDR luminance proxy, in 8-bit code units.
//
// The glare legs capture with `highDynamicRange` OFF, where the tonemap +
// inverse-gamma stage is not in the pipeline at all, so the canvas carries
// clamp(linear) directly and a code-weighted Rec.709 sum is PROPORTIONAL to
// linear radiance. That proportionality is all these criteria need: every one
// of them is a fraction, a count or an identity.
function sdrLuma(data, i) {
  return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
}

function glareMetrics(near, far) {
  const nearOff = toImage(near.captures.off);
  const nearOn = toImage(near.captures.on);
  const farOff = toImage(far.captures.off);
  const farOffAA = toImage(far.captures.offAA);
  const farOn = toImage(far.captures.on);

  const nearAgreement = m8PixelAgreement(nearOff, nearOn);
  const farAgreement = m8PixelAgreement(farOff, farOn);
  const farAaAgreement = m8PixelAgreement(farOff, farOffAA);
  const farLit = m7LitExtent(farOff);

  let energyOff = 0;
  let energyOn = 0;
  for (let i = 0; i < nearOff.data.length; i += 4) {
    energyOff += sdrLuma(nearOff.data, i);
    energyOn += sdrLuma(nearOn.data, i);
  }

  const glareOf = (capture) => capture.solarGlare ?? null;
  return {
    onStrength: glareOf(near.captures.on)?.strength ?? null,
    offStrength: glareOf(near.captures.off)?.strength ?? null,
    onSunVisibleFraction: glareOf(near.captures.on)?.sunVisibleFraction ?? null,
    farOnStrength: glareOf(far.captures.on)?.strength ?? null,
    nearMinSeparationDeg: minSeparation(near.setup.expectations),
    farMinSeparationDeg: minSeparation(far.setup.expectations),
    nearEnergyOff: energyOff,
    nearEnergyOn: energyOn,
    nearEnergyDropFraction:
      energyOff > 0 ? (energyOff - energyOn) / energyOff : NaN,
    nearDifferingPixels: nearAgreement.differingPixels,
    nearBrightenedPixels: nearAgreement.brightenedPixels,
    nearMaxChannelDelta: nearAgreement.maxChannelDelta,
    farDifferingPixels: farAgreement.differingPixels,
    farMaxChannelDelta: farAgreement.maxChannelDelta,
    farAaDifferingPixels: farAaAgreement.differingPixels,
    farLitPixels: farLit.litPixels,
  };
}

function minSeparation(expectations) {
  let best = Infinity;
  for (const e of expectations ?? []) {
    if (Number.isFinite(e.sunSeparationDeg) && e.sunSeparationDeg < best) {
      best = e.sunSeparationDeg;
    }
  }
  return Number.isFinite(best) ? r3(best) : null;
}

async function runG2(browser, git) {
  const gl = await runBackendLanes(browser, "webgl", G2_LANE_DEFS);
  const gpu = await runBackendLanes(browser, "webgpu", G2_LANE_DEFS);
  if (!gl.ok || !gpu.ok) {
    return { fatal: true, gl, gpu };
  }

  const browserVersion = browser.version();
  const manifest = {};
  const backends = {};
  for (const [renderer, run] of [
    ["webgl", gl],
    ["webgpu", gpu],
  ]) {
    const measured = {
      renderer,
      psf: psfMetrics(run.lanes.psf),
      magnitude: magnitudeMetrics(run.lanes.magnitude),
      glare: glareMetrics(run.lanes["glare-near"], run.lanes["glare-far"]),
    };
    backends[renderer] = evaluateG2Backend(measured);

    for (const [laneKey, lane] of Object.entries(run.lanes)) {
      for (const [capKey, cap] of Object.entries(lane.captures)) {
        const img = toImage(cap);
        const sceneName = `celestial-g2-${laneKey}-${capKey}`;
        const pngName = `${sceneName}-${renderer}.png`;
        const { png } = writeCapturePng(img, pngName);
        const sceneDescriptor = {
          name: sceneName,
          camera: {
            aim: G2_LANE_AIMS[laneKey] ?? null,
            fovXDeg: lane.setup.appliedFovXDeg,
            distance: 5.0e7,
            pinnedIso: PINNED_ISO,
          },
          setup: "celestial-gate-g2",
          setupParams: {
            lane: laneKey,
            capture: capKey,
            hdr: cap.hdrEngaged === true,
            exposure: cap.exposureFactor,
            glareRequested: cap.glareRequested,
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
            solarGlareStrength: cap.solarGlare?.strength ?? null,
            sunVisibleFraction: cap.solarGlare?.sunVisibleFraction ?? null,
          },
        });
      }
    }
  }

  const folded = foldG2Verdict(backends);
  return {
    fatal: false,
    gate: "G2",
    ...folded,
    pass: folded.exitCode === EXIT_CODE.PASS,
    backends,
    manifest,
    consoleErrors: {
      webgl: gl.consoleErrors,
      webgpu: gpu.consoleErrors,
    },
  };
}

// ---------------------------------------------------------------------------
// GATE G3 — star-map asset upgrade (§5 criteria 1-4 + DR-01 reversal triggers).
// ---------------------------------------------------------------------------

// In-page: install the exact opt-in sky box G3 is meant to certify, report its
// resolved tier + live face URLs, and report the shipped catalogue's depth.
//
// The URLs come from `SkyBox.createEarthSkyBox(variant).sources` rather than
// from string surgery on a prefix, so the probe measures the faces the engine
// would load — if a variant descriptor's `url()` ever changes shape, this
// follows it instead of silently measuring the old path.
async function g3ReadEnvironment(page) {
  return page.evaluate(
    async ({ certificationVariant, certificationResolution }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const mod =
        await import("/packages/engine/Source/Scene/BrightStarCatalog.js");
      const { replaceOwnedResourceTransaction } =
        await import("/Tools/visual-regression/lib/owned-resource-transaction.mjs");
      const cat = mod.default;
      const scene = window.viewer.scene;

      // EXPLICIT OPT-IN. This must never change `SkyBox.defaultResolution`: G3 is
      // asking whether the recommended high-resolution asset exists and clears
      // the gate, not spending 384 MiB in every application scene. At HEAD the
      // honest policy falls back to 2048; the source sub-lane records that as
      // STRUCTURAL until a real 4096 tier is registered and bundled.
      const requestedVariant = C.SkyBox.Variant.TYCHO_T5_DIFFUSE;
      const requestedResolution = C.SkyBox.Resolution.SIZE_4096;
      if (
        requestedVariant !== certificationVariant ||
        requestedResolution !== certificationResolution
      ) {
        throw new Error("G3 certification constants disagree with the engine");
      }
      const previousSkyBox = scene.skyBox;
      const previousSkyBoxPresent = C.defined(previousSkyBox);
      const previousSkyBoxResident =
        previousSkyBox?.starCubeMap?.available === true;
      const previousEstimatedVramBytes = Number.isFinite(
        previousSkyBox?.estimatedVramBytes,
      )
        ? previousSkyBox.estimatedVramBytes
        : 0;
      const previousResolution = previousSkyBox?.resolution ?? null;
      const previousFaceSize = previousSkyBox?.faceSize ?? null;

      // No render or await is allowed between `install` and destruction of the
      // previous resource. SkyBox construction itself allocates no GPU cube;
      // this ordering makes honest peak residency max(previous,current), not
      // their sum. On installation failure the helper first restores the old
      // owner, then destroys only the new candidate; an ambiguous failed
      // rollback leaves the possibly-owned candidate alive and fails the lane.
      const replacement = replaceOwnedResourceTransaction({
        current: previousSkyBox,
        create: () =>
          C.SkyBox.createEarthSkyBox(requestedVariant, {
            resolution: requestedResolution,
            maximumCubeMapSize: scene.maximumCubeMapSize,
          }),
        install: (candidate) => {
          scene.skyBox = candidate;
          if (scene.skyBox !== candidate) {
            throw new Error("G3 sky-box installation did not take ownership");
          }
        },
        restore: (resource) => {
          scene.skyBox = resource;
          if (scene.skyBox !== resource) {
            throw new Error("G3 sky-box rollback did not restore ownership");
          }
        },
        destroy: (resource) => resource.destroy(),
      });
      const activeSkyBox = replacement.resource;
      const previousSkyBoxDestroyed = previousSkyBoxPresent
        ? previousSkyBox.isDestroyed()
        : false;
      const candidateSkyBoxDestroyed = activeSkyBox.isDestroyed();
      const previousResidentEstimatedVramBytes = previousSkyBoxResident
        ? previousEstimatedVramBytes
        : 0;
      const currentEstimatedVramBytes = activeSkyBox.estimatedVramBytes ?? null;
      const peakEstimatedVramBytes = Number.isFinite(currentEstimatedVramBytes)
        ? Math.max(
            previousResidentEstimatedVramBytes,
            currentEstimatedVramBytes,
          )
        : null;

      const variants = {};
      for (const key of Object.keys(C.SkyBox.Variant)) {
        const v = C.SkyBox.Variant[key];
        // Constructed but never updated, so no GPU resource is created; this is a
        // URL lookup through the engine's own descriptor table.
        const descriptor = C.SkyBox.createEarthSkyBox(v);
        variants[v] = { ...descriptor.sources };
        descriptor.destroy();
      }

      let minVmag = Infinity;
      let maxVmag = -Infinity;
      for (let i = 0; i < cat.count; i++) {
        const vmag = cat.data[i * cat.STRIDE + 2];
        if (vmag < minVmag) {
          minVmag = vmag;
        }
        if (vmag > maxVmag) {
          maxVmag = vmag;
        }
      }

      return {
        variants,
        defaultVariant: C.SkyBox.defaultVariant,
        defaultResolution: C.SkyBox.defaultResolution,
        requestedVariant,
        requestedResolution,
        activeVariant: scene.skyBox ? (scene.skyBox.variant ?? null) : null,
        activeResolution: scene.skyBox
          ? (scene.skyBox.resolution ?? null)
          : null,
        activeFaceSize: scene.skyBox ? (scene.skyBox.faceSize ?? null) : null,
        activeEstimatedVramBytes: scene.skyBox
          ? (scene.skyBox.estimatedVramBytes ?? null)
          : null,
        previousSkyBoxPresent,
        previousSkyBoxResident,
        previousResolution,
        previousFaceSize,
        previousEstimatedVramBytes,
        previousResidentEstimatedVramBytes,
        replacementInstalled: replacement.installed,
        previousSkyBoxDestroyed:
          replacement.previousDestroyed && previousSkyBoxDestroyed,
        candidateSkyBoxDestroyed:
          replacement.candidateDestroyed || candidateSkyBoxDestroyed,
        currentEstimatedVramBytes,
        peakEstimatedVramBytes,
        replacementHadRenderOverlap: false,
        maximumCubeMapSize: scene.maximumCubeMapSize ?? null,
        activeSources: scene.skyBox ? { ...scene.skyBox.sources } : null,
        catalogue: {
          records: cat.count,
          stride: cat.STRIDE,
          brightestVmag: minVmag,
          limitingMagnitude: maxVmag,
        },
      };
    },
    {
      certificationVariant: G3_CERTIFICATION_VARIANT,
      certificationResolution: G3_CERTIFICATION_RESOLUTION,
    },
  );
}

// In-page: the moving-camera leg.
//
// PINNED CLOCK THROUGHOUT and CAMERA-ONLY motion — the stars' inertial
// directions never change, so the only thing varying between frames is where
// each sprite lands on the pixel grid. Every frame renders with the pinned time
// and reads back in the SAME task (RULE 2), and the A/B frame-cost legs are
// INTERLEAVED (off, on, off, on, ...) as the campaign's timing doctrine
// requires — a block of OFF frames followed by a block of ON frames would
// measure thermal drift as a sprite cost.
async function g3MotionSweep(page, opts) {
  return page.evaluate(
    async ({
      frames,
      stepPx,
      boxHalf,
      faintMin,
      faintMax,
      isolationDeg,
      cropRect,
      settleBudgetMs,
      settleMinFrames,
      settleYieldMs,
    }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const mod =
        await import("/packages/engine/Source/Scene/BrightStarCatalog.js");
      const cat = mod.default;
      const viewer = window.viewer;
      const scene = viewer.scene;
      const pinnedTime = () => viewer.clock.currentTime;

      // SPRITES ONLY. The trigger is about sprite sampling; the cube map would
      // add a diffuse pedestal under every measurement box for no benefit.
      if (scene.skyBox) {
        scene.skyBox.show = false;
        if (scene.skyBox.starField) {
          scene.skyBox.starField.show = true;
        }
      }
      scene.highDynamicRange = false;
      if (scene.postProcessStages) {
        scene.postProcessStages.exposure = 1.0;
      }

      // Catalogue rows -> fixed-frame unit directions at the pinned clock, via
      // the same TEME -> pseudo-fixed transform the renderer uses.
      const temeToFixed = C.Transforms.computeTemeToPseudoFixedMatrix(
        pinnedTime(),
        new C.Matrix3(),
      );
      const dirOf = (ra, dec) => {
        const r = C.Math.toRadians(ra);
        const d = C.Math.toRadians(dec);
        const teme = new C.Cartesian3(
          Math.cos(d) * Math.cos(r),
          Math.cos(d) * Math.sin(r),
          Math.sin(d),
        );
        const out = C.Matrix3.multiplyByVector(
          temeToFixed,
          teme,
          new C.Cartesian3(),
        );
        return C.Cartesian3.normalize(out, out);
      };

      const rows = [];
      for (let i = 0; i < cat.count; i++) {
        const b = i * cat.STRIDE;
        rows.push({
          index: i,
          ra: cat.data[b],
          dec: cat.data[b + 1],
          vmag: cat.data[b + 2],
          dir: dirOf(cat.data[b], cat.data[b + 1]),
        });
      }
      const brightest = rows.reduce(
        (a, r) => (r.vmag < a.vmag ? r : a),
        rows[0],
      );

      // AIM at the brightest star, then pick the faint target from the stars
      // that share the frame with it. `setupScene` already placed the camera on
      // this star for the enclosing lane, but the aim is re-derived here so the
      // sweep is self-contained and cannot inherit a stale framing.
      const dist = 5.0e7;
      const dir0 = C.Cartesian3.clone(brightest.dir, new C.Cartesian3());
      const eye = C.Cartesian3.multiplyByScalar(
        dir0,
        -dist,
        new C.Cartesian3(),
      );
      let up0 = C.Cartesian3.UNIT_Z;
      if (Math.abs(C.Cartesian3.dot(dir0, up0)) > 0.95) {
        up0 = C.Cartesian3.UNIT_X;
      }
      const right0 = C.Cartesian3.normalize(
        C.Cartesian3.cross(dir0, up0, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      up0 = C.Cartesian3.normalize(
        C.Cartesian3.cross(right0, dir0, new C.Cartesian3()),
        new C.Cartesian3(),
      );

      const canvas = scene.canvas;
      const ox = Math.floor((canvas.width - cropRect.width) / 2);
      const oy = Math.floor((canvas.height - cropRect.height) / 2);
      const fovX = scene.camera.frustum.fov;
      const tanHalfX = Math.tan(fovX / 2);
      const tanHalfY = tanHalfX / (canvas.width / canvas.height);
      const stepRad = (stepPx * fovX) / canvas.width;

      // FAINT TARGET SELECTION. Inside the magnitude window, inside the crop
      // with margin, and ISOLATED — no catalogue neighbour within
      // `isolationDeg`, so the measurement box contains exactly one star.
      const isolationCos = Math.cos(C.Math.toRadians(isolationDeg));
      const projectWith = (dir, f, r, u) => {
        const zc = C.Cartesian3.dot(dir, f);
        if (zc <= 1e-6) {
          return null;
        }
        const xc = C.Cartesian3.dot(dir, r);
        const yc = C.Cartesian3.dot(dir, u);
        const ndcX = xc / zc / tanHalfX;
        const ndcY = yc / zc / tanHalfY;
        return {
          x: (ndcX * 0.5 + 0.5) * canvas.width - ox,
          y: (0.5 - ndcY * 0.5) * canvas.height - oy,
        };
      };
      const packVector = (v) => ({ x: v.x, y: v.y, z: v.z });
      const angleBetweenDeg = (a, b) =>
        C.Math.toDegrees(C.Cartesian3.angleBetween(a, b));
      const margin = boxHalf + 6 + Math.ceil(frames * stepPx);
      let faint = null;
      for (const r of rows) {
        if (r.vmag < faintMin || r.vmag > faintMax) {
          continue;
        }
        const p = projectWith(r.dir, dir0, right0, up0);
        if (
          !p ||
          p.x < margin ||
          p.y < margin ||
          p.x > cropRect.width - margin ||
          p.y > cropRect.height - margin
        ) {
          continue;
        }
        let isolated = true;
        for (const other of rows) {
          if (other.index === r.index) {
            continue;
          }
          if (C.Cartesian3.dot(other.dir, r.dir) > isolationCos) {
            isolated = false;
            break;
          }
        }
        if (isolated) {
          faint = r;
          break;
        }
      }

      const lumAt = (data, i) =>
        0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];

      // Box statistics around a predicted position: the local background is the
      // mean of the box's own border ring, so a diffuse pedestal (or an
      // exposure change) subtracts out of both the peak and the sum.
      const boxStats = (img, cx, cy) => {
        const x0 = Math.max(0, Math.round(cx) - boxHalf);
        const x1 = Math.min(img.width - 1, Math.round(cx) + boxHalf);
        const y0 = Math.max(0, Math.round(cy) - boxHalf);
        const y1 = Math.min(img.height - 1, Math.round(cy) + boxHalf);
        let ringSum = 0;
        let ringCount = 0;
        let peak = -Infinity;
        let total = 0;
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const v = lumAt(img.data, 4 * (y * img.width + x));
            const onBorder = x === x0 || x === x1 || y === y0 || y === y1;
            if (onBorder) {
              ringSum += v;
              ringCount++;
            }
            if (v > peak) {
              peak = v;
            }
            total += v;
          }
        }
        const bg = ringCount > 0 ? ringSum / ringCount : 0;
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        return {
          peak: peak - bg,
          sum: total - bg * area,
          background: bg,
        };
      };

      const grab = () => {
        const tmp = document.createElement("canvas");
        tmp.width = canvas.width;
        tmp.height = canvas.height;
        const ctx = tmp.getContext("2d");
        ctx.drawImage(canvas, 0, 0);
        return ctx.getImageData(ox, oy, cropRect.width, cropRect.height);
      };

      // Wall-clock readiness budget + a DISCARDED warm-up capture, exactly as
      // `captureMode` does — the sweep's first frame must not be the one paying
      // for pipeline compilation.
      const start = performance.now();
      let warmFrames = 0;
      while (
        performance.now() - start < settleBudgetMs ||
        warmFrames < settleMinFrames
      ) {
        scene.render(pinnedTime());
        warmFrames++;
        await new Promise((r) => setTimeout(r, settleYieldMs));
      }
      scene.render(pinnedTime());
      grab();

      const setFrame = (k) => {
        const q = C.Quaternion.fromAxisAngle(
          up0,
          k * stepRad,
          new C.Quaternion(),
        );
        const rot = C.Matrix3.fromQuaternion(q, new C.Matrix3());
        const dir = C.Cartesian3.normalize(
          C.Matrix3.multiplyByVector(rot, dir0, new C.Cartesian3()),
          new C.Cartesian3(),
        );
        const up = C.Cartesian3.normalize(
          C.Matrix3.multiplyByVector(rot, up0, new C.Cartesian3()),
          new C.Cartesian3(),
        );
        scene.camera.setView({
          destination: eye,
          orientation: { direction: dir, up },
        });
        const right = C.Cartesian3.normalize(
          C.Cartesian3.cross(dir, up, new C.Cartesian3()),
          new C.Cartesian3(),
        );

        // `Camera.setView` converts the requested direction/up through local
        // heading/pitch/roll and can rebuild a different WC basis. The boxes
        // below must be projected against what the renderer will actually use,
        // and the report must retain that applied basis for every frame.
        const directionWC = C.Cartesian3.clone(
          scene.camera.directionWC,
          new C.Cartesian3(),
        );
        const rightWC = C.Cartesian3.clone(
          scene.camera.rightWC,
          new C.Cartesian3(),
        );
        const upWC = C.Cartesian3.clone(scene.camera.upWC, new C.Cartesian3());
        return {
          requested: { direction: dir, right, up },
          applied: { directionWC, rightWC, upWC },
        };
      };

      const samples = [];
      let firstFrame = null;
      let lastFrame = null;
      const maxFrames = Math.min(64, Math.max(1, frames));
      for (let k = 0; k < maxFrames; k++) {
        const basis = setFrame(k);

        // A/B INTERLEAVED, off then on, inside the same sweep step.
        if (scene.skyBox && scene.skyBox.starField) {
          scene.skyBox.starField.show = false;
        }
        const t0 = performance.now();
        scene.render(pinnedTime());
        const msOff = performance.now() - t0;

        if (scene.skyBox && scene.skyBox.starField) {
          scene.skyBox.starField.show = true;
        }
        const t1 = performance.now();
        scene.render(pinnedTime());
        const msOn = performance.now() - t1;
        // RULE 2 — readback in the SAME task as the measured render.
        const img = grab();

        if (k === 0) {
          firstFrame = img;
        }
        lastFrame = img;

        const bp = projectWith(
          brightest.dir,
          basis.applied.directionWC,
          basis.applied.rightWC,
          basis.applied.upWC,
        );
        const fp = faint
          ? projectWith(
              faint.dir,
              basis.applied.directionWC,
              basis.applied.rightWC,
              basis.applied.upWC,
            )
          : null;
        const appliedMaxAbsDot = Math.max(
          Math.abs(
            C.Cartesian3.dot(basis.applied.directionWC, basis.applied.rightWC),
          ),
          Math.abs(
            C.Cartesian3.dot(basis.applied.directionWC, basis.applied.upWC),
          ),
          Math.abs(C.Cartesian3.dot(basis.applied.rightWC, basis.applied.upWC)),
        );
        samples.push({
          k,
          msOn,
          msOff,
          bright: bp ? boxStats(img, bp.x, bp.y) : null,
          brightXY: bp,
          faint: fp ? boxStats(img, fp.x, fp.y) : null,
          faintXY: fp,
          basis: {
            requestedDirection: packVector(basis.requested.direction),
            requestedRight: packVector(basis.requested.right),
            requestedUp: packVector(basis.requested.up),
            appliedDirectionWC: packVector(basis.applied.directionWC),
            appliedRightWC: packVector(basis.applied.rightWC),
            appliedUpWC: packVector(basis.applied.upWC),
            directionResidualDeg: angleBetweenDeg(
              basis.requested.direction,
              basis.applied.directionWC,
            ),
            rightResidualDeg: angleBetweenDeg(
              basis.requested.right,
              basis.applied.rightWC,
            ),
            upResidualDeg: angleBetweenDeg(
              basis.requested.up,
              basis.applied.upWC,
            ),
            appliedMaxAbsDot,
            brightProjectionBasis: "applied-WC",
            faintProjectionBasis: fp ? "applied-WC" : null,
          },
        });
        await new Promise((r) => setTimeout(r, 0));
      }

      // POSITIVE CONTROL for the sweep itself: the last frame must differ from
      // the first. A sweep whose frames are pixel-identical sampled ONE phase.
      let changedPixels = 0;
      if (firstFrame && lastFrame) {
        for (let i = 0; i < firstFrame.data.length; i += 4) {
          if (
            firstFrame.data[i] !== lastFrame.data[i] ||
            firstFrame.data[i + 1] !== lastFrame.data[i + 1] ||
            firstFrame.data[i + 2] !== lastFrame.data[i + 2]
          ) {
            changedPixels++;
          }
        }
      }

      return {
        samples,
        changedPixels,
        warmFrames,
        stepRad,
        fovXDeg: C.Math.toDegrees(fovX),
        canvas: { width: canvas.width, height: canvas.height },
        brightest: {
          index: brightest.index,
          vmag: brightest.vmag,
          ra: brightest.ra,
          dec: brightest.dec,
        },
        faint: faint
          ? {
              index: faint.index,
              vmag: faint.vmag,
              ra: faint.ra,
              dec: faint.dec,
            }
          : null,
        cropWidth: cropRect.width,
        cropHeight: cropRect.height,
      };
    },
    {
      frames: opts.frames,
      stepPx: opts.stepPx,
      boxHalf: opts.boxHalf,
      faintMin: opts.faintMin,
      faintMax: opts.faintMax,
      isolationDeg: opts.isolationDeg,
      cropRect: opts.crop,
      settleBudgetMs: SETTLE_BUDGET_MS,
      settleMinFrames: SETTLE_MIN_FRAMES,
      settleYieldMs: SETTLE_YIELD_MS,
    },
  );
}

// Reduce the sweep's per-frame samples to the ratios the motion sub-lane binds.
//
// The min is FLOORED AT ONE 8-BIT CODE. A background-subtracted signal below one
// code is indistinguishable from absent, so dividing by it would report an
// arbitrary number instead of a swing; flooring makes the ratio a LOWER BOUND on
// the true swing, which is the conservative direction for a trigger that fires
// when the ratio is large.
function g3MotionMetrics(sweep) {
  const ONE_CODE = 1.0;
  const series = (pick) =>
    (sweep.samples ?? []).map(pick).filter((v) => Number.isFinite(v));
  const swing = (values) => {
    if (values.length < 2) {
      return { min: null, max: null, ratio: NaN };
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    return { min, max, ratio: max / Math.max(ONE_CODE, min) };
  };
  const faintPeak = swing(series((s) => s.faint?.peak));
  const faintSum = swing(series((s) => s.faint?.sum));
  const brightSum = swing(series((s) => s.bright?.sum));
  const median = (xs) => {
    if (xs.length === 0) {
      return NaN;
    }
    const s = xs.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const msOn = median(series((s) => s.msOn));
  const msOff = median(series((s) => s.msOff));
  const basisSamples = (sweep.samples ?? [])
    .filter((s) => s?.basis)
    .map((s) => ({ k: s.k, ...s.basis }));
  const maxBasisResidual = (key) => {
    const values = basisSamples
      .map((s) => s[key])
      .filter((v) => Number.isFinite(v));
    return values.length > 0 ? Math.max(...values) : null;
  };
  return {
    frames: (sweep.samples ?? []).length,
    changedPixels: sweep.changedPixels ?? 0,
    faintFound: faintPeak.max !== null && faintPeak.max > ONE_CODE,
    brightFound: brightSum.max !== null && brightSum.max > ONE_CODE,
    faintPeakRatio: faintPeak.ratio,
    faintPeakMin: faintPeak.min,
    faintPeakMax: faintPeak.max,
    faintSumRatio: faintSum.ratio,
    brightSumRatio: brightSum.ratio,
    // DIAGNOSTIC ONLY — an interleaved A/B wall-clock delta, reported so the
    // C12-09 "frame cost of a deeper catalogue" question has a number, NOT
    // bound by any criterion. A wall-clock CPU delta on one machine is not a
    // GPU cost measurement.
    spriteFrameCostMsDiagnostic:
      Number.isFinite(msOn) && Number.isFinite(msOff) ? msOn - msOff : null,
    medianMsOn: msOn,
    medianMsOff: msOff,
    target: sweep.faint ?? null,
    control: sweep.brightest ?? null,
    stepRad: sweep.stepRad ?? null,
    fovXDeg: sweep.fovXDeg ?? null,
    basisEvidence: {
      coordinateSpace: "WC",
      projectionBasis: "post-Camera.setView",
      samples: basisSamples,
      maxRequestedAppliedResidualDeg: {
        direction: maxBasisResidual("directionResidualDeg"),
        right: maxBasisResidual("rightResidualDeg"),
        up: maxBasisResidual("upResidualDeg"),
      },
      maxAppliedAbsDot: maxBasisResidual("appliedMaxAbsDot"),
    },
  };
}

// Fetch + decode the six faces of one variant from the URLs the ENGINE
// resolved. The bytes are hashed BEFORE decode so the fingerprint covers what
// the server sent, not what an image library reconstructed.
// The per-face decode cache is keyed by the hash of the served bytes. The second
// backend still FETCHES + HASHES its exact URLs; identical bytes reuse the pure
// analysis record, while a differing digest is decoded rather than accidentally
// inheriting the first backend's measurements.
async function g3FetchVariant(sharp, sources, { decodeCache, workload }) {
  const faces = {};
  const fingerprintRecords = [];
  const sourceProof = {};
  for (const faceKey of G3_FACE_KEYS) {
    const sourceKey = G3_SOURCE_KEYS[faceKey];
    const url = sources?.[sourceKey];
    if (typeof url !== "string") {
      sourceProof[faceKey] = { sourceKey, url: null, sha256: null, bytes: 0 };
      fingerprintRecords.push({
        faceKey,
        sourceKey,
        url: null,
        sha256: null,
        decodedWidth: null,
        decodedHeight: null,
      });
      continue;
    }
    workload.fetchAttempts++;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`G3 asset fetch failed: ${url} -> ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = sha256(Buffer.from(bytes));
    sourceProof[faceKey] = {
      sourceKey,
      url,
      sha256: digest,
      bytes: bytes.length,
    };
    let analyzed = decodeCache.get(digest);
    if (!analyzed) {
      workload.decodeAttempts++;
      const { data, info } = await sharp(Buffer.from(bytes))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      analyzed = analyzeFace({
        data,
        width: info.width,
        height: info.height,
        stride: info.channels,
        bytes,
      });
      decodeCache.set(digest, analyzed);
    }
    sourceProof[faceKey].decodedWidth = analyzed.width;
    sourceProof[faceKey].decodedHeight = analyzed.height;
    fingerprintRecords.push({
      faceKey,
      sourceKey,
      url,
      sha256: digest,
      decodedWidth: analyzed.width,
      decodedHeight: analyzed.height,
    });
    faces[faceKey] = {
      ...analyzed,
      url,
      bytes: bytes.length,
      sha256: digest,
    };
  }
  return {
    variant: foldVariant(faces),
    fingerprintRecords,
    sourceProof,
  };
}

function g3BuildActiveSourceProof(environment, fetched) {
  const base = g3BuildEnvironmentSourceProof(environment);
  const activeSources = environment.activeSources ?? {};
  const faceProof = fetched.sourceProof ?? {};
  const fetchedSourceCount = G3_FACE_KEYS.filter(
    (faceKey) => typeof faceProof[faceKey]?.url === "string",
  ).length;
  const fetchedSourcesMatchEnvironmentActiveSources = G3_FACE_KEYS.every(
    (faceKey) => {
      const sourceKey = G3_SOURCE_KEYS[faceKey];
      return faceProof[faceKey]?.url === activeSources[sourceKey];
    },
  );
  const proof = {
    ...base,
    fetchedSourceCount,
    decodedFaceCount: fetched.variant?.faceCount ?? 0,
    decodedFaceSizeMin: fetched.variant?.faceSizeMin ?? null,
    fetchedSourcesMatchEnvironmentActiveSources,
    fingerprintSha256: null,
    faces: Object.fromEntries(
      G3_FACE_KEYS.map((faceKey) => [
        faceKey,
        { ...base.faces[faceKey], ...faceProof[faceKey] },
      ]),
    ),
  };
  // Producer-side computation uses the fetch loop's retained order. The pure
  // evaluator reconstructs the records from `proof.faces` in canonical cube
  // order and hashes the same versioned payload independently.
  proof.fingerprintSha256 = sha256(
    canonicalG3ActiveSourceFingerprintPayload({
      resolvedVariant: proof.resolvedVariant,
      resolvedResolution: proof.resolvedResolution,
      resolvedFaceSize: proof.resolvedFaceSize,
      records: fetched.fingerprintRecords,
    }),
  );
  return proof;
}

function g3BuildEnvironmentSourceProof(environment) {
  const activeSources = environment?.activeSources ?? {};
  const faces = Object.fromEntries(
    G3_FACE_KEYS.map((faceKey) => {
      const sourceKey = G3_SOURCE_KEYS[faceKey];
      const url = activeSources[sourceKey];
      return [
        faceKey,
        {
          sourceKey,
          url: typeof url === "string" ? url : null,
          sha256: null,
          bytes: 0,
          decodedWidth: null,
          decodedHeight: null,
        },
      ];
    }),
  );
  return {
    requestedVariant: environment?.requestedVariant ?? null,
    requestedResolution: environment?.requestedResolution ?? null,
    defaultResolution: environment?.defaultResolution ?? null,
    maximumCubeMapSize: environment?.maximumCubeMapSize ?? null,
    resolvedVariant: environment?.activeVariant ?? null,
    resolvedResolution: environment?.activeResolution ?? null,
    resolvedFaceSize: environment?.activeFaceSize ?? null,
    resolvedEstimatedVramBytes: environment?.activeEstimatedVramBytes ?? null,
    previousSkyBoxPresent: environment?.previousSkyBoxPresent ?? null,
    previousSkyBoxResident: environment?.previousSkyBoxResident ?? null,
    previousResolution: environment?.previousResolution ?? null,
    previousFaceSize: environment?.previousFaceSize ?? null,
    previousEstimatedVramBytes: environment?.previousEstimatedVramBytes ?? null,
    previousResidentEstimatedVramBytes:
      environment?.previousResidentEstimatedVramBytes ?? null,
    replacementInstalled: environment?.replacementInstalled ?? null,
    previousSkyBoxDestroyed: environment?.previousSkyBoxDestroyed ?? null,
    candidateSkyBoxDestroyed: environment?.candidateSkyBoxDestroyed ?? null,
    replacementHadRenderOverlap:
      environment?.replacementHadRenderOverlap ?? null,
    currentEstimatedVramBytes: environment?.currentEstimatedVramBytes ?? null,
    peakEstimatedVramBytes: environment?.peakEstimatedVramBytes ?? null,
    activeSourceCount: G3_FACE_KEYS.filter(
      (faceKey) => typeof faces[faceKey].url === "string",
    ).length,
    fetchedSourceCount: 0,
    decodedFaceCount: 0,
    decodedFaceSizeMin: null,
    fetchedSourcesMatchEnvironmentActiveSources: false,
    fingerprintSha256: null,
    activeSources: { ...activeSources },
    faces,
  };
}

function g3PreflightEnvironment(environment) {
  const sourceProof = g3BuildEnvironmentSourceProof(environment);
  const evaluated = evaluateG3SourcePreflight(sourceProof);
  return {
    pass: evaluated.pass,
    reasons: evaluated.structural,
    sourceProof,
  };
}

// POSITIVE CONTROL for the chroma detector.
//
// Median chroma reads 0.000 on every bundled tier, and that is ALSO what a
// broken chroma metric reads. This pushes a synthetic swatch of KNOWN HSV
// saturation through the same `analyzeFace` path; if it does not come back, the
// asset's 0.000 is the instrument and the criterion certifies nothing. The
// swatch is built here rather than fetched so the control cannot itself be a
// casualty of whatever broke the assets.
function g3ChromaControl() {
  const size = 64;
  const data = new Uint8ClampedArray(size * size * 4);
  // Saturation = (max - min) / max = (200 - 100) / 200 = 0.5 exactly.
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200;
    data[i + 1] = 100;
    data[i + 2] = 100;
    data[i + 3] = 255;
  }
  const record = analyzeFace({ data, width: size, height: size, stride: 4 });
  return { medianSaturation: record.medianChroma, expected: 0.5 };
}

const G3_LANE_DEFS = [
  {
    key: "split",
    setup: {
      aim: "sirius",
      skyAtmosphereOn: false,
      cameraHeightM: null,
      fovXDeg: null,
    },
    // Cubemap first, sprites last: the sprites-only frame feeds BOTH the
    // catalogue arm's live census and the motion lane that follows it on the
    // same page, so it is the one that must be measured warmest.
    captures: [
      { key: "cubemap-only", mode: "cubemap-only", hdr: false },
      { key: "sprites-only", mode: "sprites-only", hdr: false },
    ],
  },
];

function g3EmptyProductWorkload() {
  return {
    productPhaseAttempts: 0,
    setupAttempts: 0,
    captureAttempts: 0,
    motionAttempts: 0,
    fetchAttempts: 0,
    decodeAttempts: 0,
  };
}

async function runG3BackendPreflight(browser, renderer) {
  return withPage(browser, renderer, async (page) => {
    const environment = await g3ReadEnvironment(page);
    const preflight = g3PreflightEnvironment(environment);
    return {
      phase: "preflight",
      environment,
      preflight,
      workload: g3EmptyProductWorkload(),
    };
  });
}

async function runG3BackendProduct(browser, renderer) {
  return withPage(browser, renderer, async (page) => {
    const workload = g3EmptyProductWorkload();
    workload.productPhaseAttempts++;
    const environment = await g3ReadEnvironment(page);
    const preflight = g3PreflightEnvironment(environment);
    if (!preflight.pass) {
      // A second check binds the product page actually captured. The global
      // orchestration has already proven both backends before entering either
      // product phase; this catches only a runtime capability/source drift.
      return {
        phase: "product",
        environment,
        preflight,
        workload,
        lanes: null,
        sweep: null,
      };
    }
    const lanes = {};
    for (const def of G3_LANE_DEFS) {
      workload.setupAttempts++;
      const setup = await setupScene(page, def.setup);
      const captures = {};
      for (const cap of def.captures) {
        workload.captureAttempts++;
        captures[cap.key] = await captureMode(page, {
          mode: cap.mode,
          crop: setup.crop,
          hdr: cap.hdr === true,
        });
      }
      lanes[def.key] = { setup, captures };
    }
    workload.motionAttempts++;
    const sweep = await g3MotionSweep(page, {
      frames: G3_MOTION_FRAMES,
      stepPx: G3_MOTION_STEP_PX,
      boxHalf: G3_MOTION_BOX_HALF_PX,
      faintMin: G3_FAINT_VMAG_MIN,
      faintMax: G3_FAINT_VMAG_MAX,
      isolationDeg: G3_TARGET_ISOLATION_DEG,
      crop: lanes.split.setup.crop,
    });
    return {
      phase: "product",
      environment,
      preflight,
      workload,
      lanes,
      sweep,
    };
  });
}

function g3StructuralResult(gl, gpu, phase) {
  const backends = {};
  for (const [renderer, run] of [
    ["webgl", gl],
    ["webgpu", gpu],
  ]) {
    backends[renderer] = evaluateG3Backend({
      renderer,
      asset: { sourceProof: run.preflight.sourceProof },
    });
    backends[renderer].measured = {
      orchestrationPhase: phase,
      preflight: {
        pass: run.preflight.pass,
        reasons: run.preflight.reasons,
      },
      workload: run.workload,
      sourceProof: run.preflight.sourceProof,
    };
  }
  const folded = foldG3Verdict(backends);
  return {
    fatal: false,
    gate: "G3",
    ...folded,
    pass: false,
    backends,
    manifest: {},
    orchestration: { phase, sharpImportAttempts: 0 },
    consoleErrors: {
      webgl: gl.consoleErrors,
      webgpu: gpu.consoleErrors,
    },
  };
}

async function runG3(browser, git) {
  // GLOBAL BARRIER: both backend/device/source preflights must finish before
  // either product page is even opened. In particular, mixed 4096 capability
  // cannot spend setup/capture/motion work on the capable backend and then
  // discover that the two-backend gate was structurally unreachable.
  const [glPreflight, gpuPreflight] = await Promise.all([
    runG3BackendPreflight(browser, "webgl"),
    runG3BackendPreflight(browser, "webgpu"),
  ]);
  if (!glPreflight.ok || !gpuPreflight.ok) {
    return { fatal: true, gl: glPreflight, gpu: gpuPreflight };
  }
  if (!glPreflight.preflight.pass || !gpuPreflight.preflight.pass) {
    return g3StructuralResult(glPreflight, gpuPreflight, "global-preflight");
  }

  const gl = await runG3BackendProduct(browser, "webgl");
  const gpu = await runG3BackendProduct(browser, "webgpu");
  if (!gl.ok || !gpu.ok) {
    return { fatal: true, gl, gpu };
  }
  if (!gl.preflight.pass || !gpu.preflight.pass) {
    return g3StructuralResult(gl, gpu, "product-revalidation");
  }

  const orchestration = { phase: "product", sharpImportAttempts: 0 };
  let sharp;
  try {
    orchestration.sharpImportAttempts++;
    sharp = (await import("sharp")).default;
  } catch (e) {
    console.error(
      "[probe-celestial-gates] G3 needs `sharp` (a declared repo dependency, " +
        "used by Tools/skybox-bake) to decode the served cube faces off-browser: " +
        String((e && e.message) || e),
    );
    return { fatal: true, gl, gpu, orchestration };
  }

  // The faces are backend-neutral bytes. Fetch + hash the exact resolved source
  // set per backend; byte-identical faces share decoded analysis through the
  // digest cache, while a differing digest is decoded independently.
  const variantKeys = ["TYCHO_T3", "TYCHO_T5", G3_CERTIFICATION_VARIANT];
  const decoded = {};
  const activeSourceProofs = {};
  const fingerprints = {};
  const decodeCache = new Map();
  for (const [renderer, run] of [
    ["webgl", gl],
    ["webgpu", gpu],
  ]) {
    decoded[renderer] = {};
    for (const key of variantKeys) {
      // The active certification candidate is NEVER reconstructed from the
      // default-resolution variant table. It is fetched from the live sky box's
      // exact sources after the explicit 4096 request has resolved.
      const isActiveCandidate = key === G3_CERTIFICATION_VARIANT;
      const sources = isActiveCandidate
        ? run.environment.activeSources
        : run.environment.variants[key];
      const fetched = await g3FetchVariant(sharp, sources, {
        decodeCache,
        workload: run.workload,
      });
      decoded[renderer][key] = fetched.variant;
      if (isActiveCandidate) {
        activeSourceProofs[renderer] = g3BuildActiveSourceProof(
          run.environment,
          fetched,
        );
      }
    }
    // One aggregate identity only: the exact active six-face source proof.
    // Baseline/reversal assets remain measured, but cannot redefine the
    // certification subject's cross-backend fingerprint.
    fingerprints[renderer] =
      activeSourceProofs[renderer]?.fingerprintSha256 ?? null;
  }

  const chromaControl = g3ChromaControl();
  const browserVersion = browser.version();
  const manifest = {};
  const backends = {};

  for (const [renderer, run] of [
    ["webgl", gl],
    ["webgpu", gpu],
  ]) {
    const activeVariant =
      run.environment.activeVariant ?? run.environment.defaultVariant;
    const active = decoded[renderer][G3_CERTIFICATION_VARIANT] ?? null;
    const t3 = decoded[renderer].TYCHO_T3 ?? null;
    const unblurred = decoded[renderer].TYCHO_T5 ?? null;

    const cubemapImage = toImage(run.lanes.split.captures["cubemap-only"]);
    const spritesImage = toImage(run.lanes.split.captures["sprites-only"]);
    const cubemapCensus = m1PointSourceCensus(cubemapImage);
    const spritesCensus = m1PointSourceCensus(spritesImage);
    const cubemapExtent = m7LitExtent(cubemapImage);
    const spritesExtent = m7LitExtent(spritesImage);
    const motion = g3MotionMetrics(run.sweep);

    const measured = {
      renderer,
      asset: {
        active,
        t3,
        unblurred,
        activeVariant,
        sourceProof: activeSourceProofs[renderer],
        chromaControl,
        fingerprint: fingerprints[renderer],
      },
      split: {
        diffuseMaxFaceSources: active ? active.maxFaceSources : NaN,
        unblurredMinFaceSources: unblurred
          ? Math.min(
              ...Object.values(unblurred.faces).map((f) => f.sources ?? 0),
            )
          : NaN,
        liveResolvedSources: cubemapCensus.count,
        liveLitPixels: cubemapExtent.litPixels,
      },
      catalogue: {
        records: run.environment.catalogue.records,
        limitingMagnitude: run.environment.catalogue.limitingMagnitude,
        liveResolvedSources: spritesCensus.count,
        liveLitPixels: spritesExtent.litPixels,
      },
      adversarial: { t3 },
      motion,
      triggers: computeAssetTriggers({
        active,
        unblurred,
        t3,
        catalogueRecords: run.environment.catalogue.records,
      }),
    };
    backends[renderer] = evaluateG3Backend(measured);
    backends[renderer].measured = {
      preflight: {
        pass: run.preflight.pass,
        reasons: run.preflight.reasons,
      },
      workload: run.workload,
      sourceProof: activeSourceProofs[renderer],
      liveCubemap: {
        resolvedSources: cubemapCensus.count,
        litPixels: cubemapExtent.litPixels,
        peakLuminance: cubemapExtent.peakLuminance,
      },
      liveSprites: {
        resolvedSources: spritesCensus.count,
        litPixels: spritesExtent.litPixels,
        peakLuminance: spritesExtent.peakLuminance,
      },
      catalogue: run.environment.catalogue,
      motion,
      variants: Object.fromEntries(
        variantKeys.map((k) => [
          k,
          decoded[renderer][k]
            ? {
                faceSize: decoded[renderer][k].faceSize,
                arcminPerPixel: decoded[renderer][k].arcminPerPixel,
                totalSources: decoded[renderer][k].totalSources,
                sourcesPerSteradian: decoded[renderer][k].sourcesPerSteradian,
                medianDustLaneIQR: decoded[renderer][k].medianDustLaneIQR,
                medianGranularityIQR: decoded[renderer][k].medianGranularityIQR,
                medianBandStdDev: decoded[renderer][k].medianBandStdDev,
                medianChroma: decoded[renderer][k].medianChroma,
                subsampling: decoded[renderer][k].subsampling,
              }
            : null,
        ]),
      ),
    };

    for (const [capKey, cap] of Object.entries(run.lanes.split.captures)) {
      const img = toImage(cap);
      const sceneName = `celestial-g3-split-${capKey}`;
      const pngName = `${sceneName}-${renderer}.png`;
      const { png } = writeCapturePng(img, pngName);
      const sceneDescriptor = {
        name: sceneName,
        camera: {
          aim: "sirius",
          fovXDeg: run.lanes.split.setup.appliedFovXDeg,
          distance: 5.0e7,
          pinnedIso: PINNED_ISO,
        },
        setup: "celestial-gate-g3",
        setupParams: {
          capture: capKey,
          activeVariant,
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
            run.lanes.split.setup.adapter.vendor,
            run.lanes.split.setup.adapter.architecture,
            run.lanes.split.setup.adapter.device,
            run.lanes.split.setup.adapter.description,
          ]),
        },
        git,
        sceneIdentity: createSceneIdentity(sceneDescriptor, {
          baseUrl: BASE,
          settleFrames: SETTLE_MIN_FRAMES,
          viewport: VIEWPORT,
        }),
        extra: {
          capture: capKey,
          activeVariant,
          assetFingerprint: fingerprints[renderer],
        },
      });
    }
  }

  const folded = foldG3Verdict(backends);
  return {
    fatal: false,
    gate: "G3",
    ...folded,
    pass: folded.exitCode === EXIT_CODE.PASS,
    backends,
    manifest,
    orchestration,
    consoleErrors: {
      webgl: gl.consoleErrors,
      webgpu: gpu.consoleErrors,
    },
  };
}

// ---------------------------------------------------------------------------
// GATE G4 — Sun (disc size, limb darkening, screen-space halo, SDR policy) +
// Moon (earthshine, soft terminator, phase). Six sub-lanes per backend, and —
// like G2 and G3 — it must PASS IDENTICALLY ON BOTH.
// ---------------------------------------------------------------------------
//
// FRAMING ARITHMETIC, so the two field-of-view overrides read as derivations
// rather than dials:
//
//   SUN DISC (fovX 2 deg). The Sun's angular RADIUS is ~0.263 deg at the pinned
//   epoch, so the disc's rendered radius is ~170 px on a 1280-px canvas and its
//   diameter (~341 px) fits inside the 640-px crop with 40% of a radius to
//   spare — which is what the "the differential vanishes outside the disc"
//   criterion needs. At the default 60 deg the same disc is 5.7 px across and
//   `x = 0.95` and `x = 1.0` land in the same pixel.
//
//   SUN HALO (default fovX). Here the disc must be SMALL: the halo is measured
//   between 16 and 30 solar radii — past the billboard's own corner at
//   sqrt(2) * 11 = 15.56 R_sun, so nothing baked can reach it — and 30 R_sun is
//   168 px at the default framing against a 320-px crop half-height. At the
//   disc lane's 2 deg the same band would be 5,100 px out.
//
//   MOON (fovX 22 deg, standoff 2.0e7 m). The standoff is
//   `probe-moon-lola-relief.mjs`'s, unchanged. The FOV is what the C12-22 band
//   needs: near the terminator `N.L ~ d / R`, so the softening band
//   `|N.L| < w = 4.649e-3` is `2 w R` PIXELS wide — 1.0 px at the default
//   framing (unmeasurable) against 2.7 px at 22 deg, where the disc is 578 px
//   across and still inside the 640-px crop. Nothing about the moon is resized;
//   this magnifies the same disc onto more pixels, exactly as G2's telescope
//   framing does for the star PSF.

const G4_SUN_DISC_FOV_X_DEG = 2.0;
const G4_MOON_FOV_X_DEG = 22.0;
const G4_MOON_STANDOFF_M = 2.0e7;

// Phase-epoch search grid — the moon-appearance demo's own
// (`packages/sandcastle/gallery/moon-appearance/main.js`), reused rather than
// re-invented so this lane pins the SAME instants the demo shows.
const G4_MOON_SEARCH_START_ISO = "2026-07-01T00:00:00Z";
const G4_MOON_SEARCH_DAYS = 32;

// EXPOSURE BRACKETS. Two steps each, chosen for the dynamic range the lane
// actually spans rather than copied from G2's 1x/8x/64x:
//   sun disc — 1x and 1/8x, because the disc plus the 0.75-amplitude screen
//     halo can exceed the LDR white point and the HIGH end is what needs
//     headroom;
//   sun halo — 1x and 8x, because the tail at 30 R_sun is ~0.015 in linear
//     light and the FAINT end is what needs the gain;
//   moon    — 1x and 8x for the same reason (earthshine is ~0.05, the
//     terminator softening ~1e-3).
// ONE definition, in the lib, because `deriveDiscOnlyLimbBand`'s quantization
// term has to be derived against the exposures the capture actually used.
const G4_DISC_EXPOSURES = DISC_BRACKET_EXPOSURES;
const G4_HALO_EXPOSURES = [1, 8];
const G4_MOON_EXPOSURES = [1, 8];
// The terminator lane gets a third, deeper step. The C12-22 softening peaks at
// `w/4 = 1.16e-3` in mu0 units — modelled at 2.2e-4 in linear radiance once the
// lunar albedo is folded in — which is only ~6 code values at 8x. 64x puts the
// same signal at ~46 codes, so the band census is not living on the
// quantization floor of its own bracket.
const G4_TERMINATOR_EXPOSURES = [1, 8, 64];

// --------------------------------------------------------------------------
// In-page: the C12-28 SDR-display leg, its live positive control, and the
// C12-19 pending-arm discriminator. Takes no picture.
// --------------------------------------------------------------------------
async function setupPolicyProbe(page) {
  return page.evaluate(
    async ({ cropRect, bakeSourceUrl }) => {
      await import("/Build/CesiumUnminified/index.js");
      const viewer = window.viewer;
      const scene = viewer.scene;

      const detected = scene._hdrDisplayIsHdr;
      const observed = {
        displayIsHdr: detected === true,
        displayDetectionResolved: typeof detected === "boolean",
        hdrSupported: scene.highDynamicRangeSupported === true,
        policy: scene.hdrDisplayPolicy,
        sceneHdrOn: scene.highDynamicRange === true,
        canvasOutputOn: scene.useHDRCanvasOutput === true,
        sceneHdrUserSet: scene._hdrUserSet === true,
        canvasOutputUserSet: scene._useHDRCanvasOutputUserSet === true,
      };

      // POSITIVE CONTROL. The SDR readings above pass identically with the
      // whole of C12-28 reverted, so on their own they certify nothing. Forcing
      // the DETECTED display state to HDR and re-running the shipped resolver
      // is what makes the SDR result a decision rather than an absence: the
      // flag must flip ON, and then flip BACK when the real detection is
      // restored. `_applyHdrDisplayDefault` saves and restores the user-set
      // flags itself, so the control cannot leave the scene pinned.
      let controlRan = false;
      let controlSceneHdrOn = null;
      let restoredSceneHdrOn = null;
      let restoredSceneHdrUserSet = null;
      if (typeof scene._applyHdrDisplayDefault === "function") {
        scene._hdrDisplayIsHdr = true;
        scene._applyHdrDisplayDefault();
        controlSceneHdrOn = scene.highDynamicRange === true;
        scene._hdrDisplayIsHdr = detected;
        scene._applyHdrDisplayDefault();
        restoredSceneHdrOn = scene.highDynamicRange === true;
        restoredSceneHdrUserSet = scene._hdrUserSet === true;
        controlRan = true;
      }

      // C12-19 DISCRIMINATOR — the served bake source. `C12-19` is defined as
      // "remove the clamp(...,0,1) in both bakes", so the presence of the GLSL
      // bake's final clamp is the most direct statement available of whether
      // that content exists at this commit. Read over HTTP from the same served
      // source tree the G2 magnitude lane imports `BrightStarCatalog` from.
      let bakeClampPresent = null;
      let bakeSourceBytes = null;
      try {
        const res = await fetch(bakeSourceUrl);
        if (res.ok) {
          const text = await res.text();
          bakeSourceBytes = text.length;
          bakeClampPresent = /out_FragColor\s*=\s*clamp\s*\(\s*color/.test(
            text,
          );
        }
      } catch {
        bakeClampPresent = null;
      }

      return {
        rendererType: scene.context.rendererType,
        crop: {
          x: 0,
          y: 0,
          width: cropRect.width,
          height: cropRect.height,
        },
        expectations: [],
        adapter: {
          vendor: null,
          architecture: null,
          device: null,
          description: null,
        },
        policyReadings: {
          ...observed,
          controlRan,
          controlSceneHdrOn,
          restoredSceneHdrOn,
          restoredSceneHdrUserSet,
        },
        bakeClampPresent,
        bakeSourceBytes,
      };
    },
    {
      cropRect: CROP,
      bakeSourceUrl: "/packages/engine/Source/Shaders/SunTextureFS.glsl",
    },
  );
}

// --------------------------------------------------------------------------
// In-page: solve one lunar phase epoch, park on the Earth->Moon line, settle,
// and report the moon's screen geometry plus the LIVE resolved appearance
// scalars. Runs entirely at the resolved (and thereafter pinned) clock.
// --------------------------------------------------------------------------
async function setupMoonScene(
  page,
  { phaseKey, phaseTarget, fovXDeg, standoffM },
) {
  return page.evaluate(
    async ({
      key,
      target,
      crop,
      fovX,
      standoff,
      searchStartIso,
      searchDays,
      settleBudgetMs,
      settleMinFrames,
      settleYieldMs,
    }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const viewer = window.viewer;
      const scene = viewer.scene;

      // RULE 1 — kill the default loop; every render below passes the clock.
      viewer.clock.shouldAnimate = false;
      viewer.useDefaultRenderLoop = false;
      scene.requestRenderMode = false;

      // Moon over black: no globe, no sun billboard, no sky, no star field. The
      // earthshine and terminator measurements are absolute radiances over the
      // disc, so any additional emitter in frame is a pedestal on both legs of
      // an A/B whose whole point is that everything else cancels.
      scene.backgroundColor = C.Color.BLACK;
      if (scene.globe) {
        scene.globe.show = false;
      }
      if (scene.sun) {
        scene.sun.show = false;
      }
      if (scene.moon) {
        scene.moon.show = true;
      }
      if (scene.skyAtmosphere) {
        scene.skyAtmosphere.show = false;
      }
      if (scene.fog) {
        scene.fog.enabled = false;
      }
      if (scene.skyBox) {
        scene.skyBox.show = false;
        if (scene.skyBox.starField) {
          scene.skyBox.starField.show = false;
        }
      }

      let appliedFovXDeg = null;
      const frustum = scene.camera?.frustum;
      if (frustum && typeof frustum.fov === "number") {
        if (typeof window.__probeOriginalFovRad !== "number") {
          window.__probeOriginalFovRad = frustum.fov;
        }
        frustum.fov = Number.isFinite(fovX)
          ? C.Math.toRadians(fovX)
          : window.__probeOriginalFovRad;
        appliedFovXDeg = C.Math.toDegrees(frustum.fov);
      }

      // ── PHASE SEARCH ──────────────────────────────────────────────────────
      // Transcribed from `packages/sandcastle/gallery/moon-appearance/main.js`
      // (`illuminatedFraction` + `findTimeForPhase`), inlined here because a
      // `page.evaluate` body cannot close over module scope. Deterministic: a
      // fixed 3-hour coarse grid over a fixed 32-day window, then a fixed
      // 10-minute refinement, so the resolved instant is reproducible and is
      // recorded in the manifest.
      //
      // It runs entirely in the INERTIAL frame: the illuminated fraction is a
      // dot product of two unit vectors that share the same frame rotation, so
      // the ICRF->fixed transform cancels and hundreds of samples cost no
      // rotation at all (and, usefully, do not depend on ICRF data having
      // loaded yet).
      const illuminatedFraction = (t) => {
        const moon = C.Cartesian3.normalize(
          C.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
            t,
            new C.Cartesian3(),
          ),
          new C.Cartesian3(),
        );
        const sun = C.Cartesian3.normalize(
          C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
            t,
            new C.Cartesian3(),
          ),
          new C.Cartesian3(),
        );
        return 0.5 * (1.0 - C.Cartesian3.dot(moon, sun));
      };
      const searchStart = C.JulianDate.fromIso8601(searchStartIso);
      let best = searchStart;
      let bestError = Number.POSITIVE_INFINITY;
      const consider = (t) => {
        const error = Math.abs(illuminatedFraction(t) - target);
        if (error < bestError) {
          bestError = error;
          best = t;
        }
      };
      for (let hours = 0; hours <= searchDays * 24; hours += 3) {
        consider(C.JulianDate.addHours(searchStart, hours, new C.JulianDate()));
      }
      const coarse = best;
      for (let minutes = -180; minutes <= 180; minutes += 10) {
        consider(C.JulianDate.addMinutes(coarse, minutes, new C.JulianDate()));
      }
      const resolved = best;
      const solvedFraction = illuminatedFraction(resolved);
      viewer.clock.currentTime = resolved;
      const pinnedTime = () => viewer.clock.currentTime;

      // RULE 3 — bounded settle. Also what gives the ICRF data a chance to
      // load, which the camera placement below needs (the phase search did not).
      let prev = null;
      let stableRun = 0;
      for (let i = 0; i < 180 && stableRun < 10; i++) {
        scene.render(pinnedTime());
        const cur = C.Cartesian3.clone(
          scene.context.uniformState.sunDirectionWC,
        );
        if (prev && C.Cartesian3.distance(cur, prev) < 1e-9) {
          stableRun++;
        } else {
          stableRun = 0;
        }
        prev = cur;
        await new Promise((r) => requestAnimationFrame(r));
      }

      // ── CAMERA: the demo's `viewDiscCloseUp` ─────────────────────────────
      const moonInertial =
        C.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
          pinnedTime(),
          new C.Cartesian3(),
        );
      const rotation = new C.Matrix3();
      if (
        !C.defined(
          C.Transforms.computeIcrfToFixedMatrix(pinnedTime(), rotation),
        )
      ) {
        C.Transforms.computeTemeToPseudoFixedMatrix(pinnedTime(), rotation);
      }
      const moonFixed = C.Matrix3.multiplyByVector(
        rotation,
        moonInertial,
        new C.Cartesian3(),
      );
      const moonDistance = C.Cartesian3.magnitude(moonFixed);
      const direction = C.Cartesian3.normalize(moonFixed, new C.Cartesian3());
      const destination = C.Cartesian3.multiplyByScalar(
        direction,
        moonDistance - standoff,
        new C.Cartesian3(),
      );
      let up = C.Cartesian3.cross(
        direction,
        C.Cartesian3.UNIT_Z,
        new C.Cartesian3(),
      );
      if (C.Cartesian3.magnitude(up) < 1.0e-6) {
        up = C.Cartesian3.cross(direction, C.Cartesian3.UNIT_X, up);
      }
      C.Cartesian3.normalize(up, up);

      // SAME AIM REPAIR AS `setupScene`, and for the same reason
      // (`G4-FIRSTRUN-FIX-1`): the camera sits ON the Earth->Moon ray and looks
      // along it, so `Camera.setView`'s ENU heading/pitch/roll round trip is in
      // its gimbal-lock branch and substitutes the UP vector's azimuth. The
      // offline reproduction predicts 4.98 / 7.85 / 10.37 px of miss at the
      // crescent / quarter / full epochs against Batch 941's measured 4.91 /
      // 7.92 / 10.33 — the MOON half survived only because
      // `MOON_AIM_TOLERANCE_PX` (16) is wider than the defect at fovX 22,
      // NOT because the moon lanes were aimed. Nothing about the moon
      // criteria or their bounds changes here; the camera now points where the
      // lane asked it to.
      const angleBetweenDeg = (a, b) =>
        (Math.acos(Math.max(-1, Math.min(1, C.Cartesian3.dot(a, b)))) * 180) /
        Math.PI;
      scene.camera.setView({ destination, orientation: { direction, up } });
      const hprRoundTripDirection = C.Cartesian3.clone(
        scene.camera.directionWC,
        new C.Cartesian3(),
      );
      const hprRoundTripResidualDeg = angleBetweenDeg(
        direction,
        hprRoundTripDirection,
      );
      C.Cartesian3.clone(direction, scene.camera.direction);
      C.Cartesian3.clone(up, scene.camera.up);
      C.Cartesian3.normalize(
        C.Cartesian3.cross(direction, up, scene.camera.right),
        scene.camera.right,
      );
      const appliedResidualDeg = angleBetweenDeg(
        direction,
        scene.camera.directionWC,
      );
      const aimEllipsoid = scene.ellipsoid ?? C.Ellipsoid.WGS84;
      const aimNormal = aimEllipsoid.geodeticSurfaceNormal(
        destination,
        new C.Cartesian3(),
      );
      const aimDiagnostics = {
        aimMode: `moon-${key}`,
        requestedDirection: {
          x: direction.x,
          y: direction.y,
          z: direction.z,
        },
        hprRoundTripDirection: {
          x: hprRoundTripDirection.x,
          y: hprRoundTripDirection.y,
          z: hprRoundTripDirection.z,
        },
        hprRoundTripResidualDeg,
        appliedResidualDeg,
        localVerticalSeparationDeg: C.defined(aimNormal)
          ? angleBetweenDeg(direction, aimNormal)
          : null,
      };

      // Wall-clock readiness budget (see SETTLE_BUDGET_MS in the Node half).
      const settleStart = performance.now();
      let settleFrameCount = 0;
      while (
        performance.now() - settleStart < settleBudgetMs ||
        settleFrameCount < settleMinFrames
      ) {
        scene.render(pinnedTime());
        settleFrameCount++;
        await new Promise((r) => setTimeout(r, settleYieldMs));
      }

      // Adapter provenance (C12-03 substrate), same resolution order as
      // `setupScene`.
      let adapter = {
        vendor: null,
        architecture: null,
        device: null,
        description: null,
      };
      const ctx = scene.context;
      const gpuAdapter = ctx.adapter ?? ctx._adapter;
      if (gpuAdapter && gpuAdapter.info) {
        const info = gpuAdapter.info;
        adapter = {
          vendor: info.vendor ?? null,
          architecture: info.architecture ?? null,
          device: info.device ?? null,
          description: info.description ?? null,
        };
      } else {
        try {
          const gl = ctx._gl || ctx._originalGLContext || ctx.gl;
          if (gl) {
            const ext = gl.getExtension("WEBGL_debug_renderer_info");
            if (ext) {
              adapter.description = gl.getParameter(
                ext.UNMASKED_RENDERER_WEBGL,
              );
              adapter.vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
            }
          }
        } catch {
          // leave adapter unknown
        }
      }

      const canvas = scene.canvas;
      const cw = Math.min(crop.width, canvas.width);
      const ch = Math.min(crop.height, canvas.height);
      const ox = Math.floor((canvas.width - cw) / 2);
      const oy = Math.floor((canvas.height - ch) / 2);

      // MOON SCREEN GEOMETRY. `cartesianToCanvasCoordinates` works in CSS
      // pixels while the crop is in drawing-buffer pixels; the ratio is 1 in
      // headless Edge but is measured rather than assumed, and recorded.
      const bufferScale =
        canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1;
      const centreWin = scene.cartesianToCanvasCoordinates(
        moonFixed,
        new C.Cartesian2(),
      );
      const right = C.Cartesian3.normalize(
        C.Cartesian3.cross(
          scene.camera.directionWC,
          scene.camera.upWC,
          new C.Cartesian3(),
        ),
        new C.Cartesian3(),
      );
      const edgePoint = C.Cartesian3.add(
        moonFixed,
        C.Cartesian3.multiplyByScalar(
          right,
          C.Math.LUNAR_RADIUS,
          new C.Cartesian3(),
        ),
        new C.Cartesian3(),
      );
      const edgeWin = scene.cartesianToCanvasCoordinates(
        edgePoint,
        new C.Cartesian2(),
      );
      const moonLimbPx =
        Math.hypot(edgeWin.x - centreWin.x, edgeWin.y - centreWin.y) *
        bufferScale;
      const moonCentre = {
        x: centreWin.x * bufferScale - ox,
        y: centreWin.y * bufferScale - oy,
      };
      const moonAimDistancePx = Math.hypot(
        moonCentre.x - cw / 2,
        moonCentre.y - ch / 2,
      );

      // PHASE ANGLE, measured on the real geometry rather than inferred from
      // the elongation identity: the angle AT THE MOON between the Sun and the
      // camera. This is what `computeLunarOppositionSurge` consumes, and it is
      // what decides whether §5's full:quarter bar is reachable at this epoch.
      const sunPositionWC = scene.context.uniformState.sunPositionWC;
      const camPositionWC = scene.camera.positionWC;
      let phaseAngleDeg = null;
      if (sunPositionWC && camPositionWC) {
        const toSun = C.Cartesian3.normalize(
          C.Cartesian3.subtract(sunPositionWC, moonFixed, new C.Cartesian3()),
          new C.Cartesian3(),
        );
        const toCam = C.Cartesian3.normalize(
          C.Cartesian3.subtract(camPositionWC, moonFixed, new C.Cartesian3()),
          new C.Cartesian3(),
        );
        phaseAngleDeg =
          (Math.acos(
            Math.max(-1, Math.min(1, C.Cartesian3.dot(toSun, toCam))),
          ) *
            180) /
          Math.PI;
      }

      const fs = scene.frameState;
      return {
        rendererType: scene.context.rendererType,
        phaseKey: key,
        phaseTarget: target,
        resolvedIso: C.JulianDate.toIso8601(resolved),
        solvedFraction,
        phaseFraction: fs?.moonPhaseFraction ?? null,
        phaseAngleDeg,
        earthshinePhaseScale: fs?.moonEarthshinePhaseScale ?? null,
        terminatorSoftness: fs?.moonTerminatorSoftness ?? null,
        moonDistanceM: moonDistance,
        cameraToMoonM: standoff,
        moonCentre,
        moonLimbPx,
        moonAimDistancePx,
        aimDiagnostics,
        bufferScale,
        appliedFovXDeg,
        settleFrameCount,
        settleElapsedMs: performance.now() - settleStart,
        adapter,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        crop: { x: ox, y: oy, width: cw, height: ch },
        expectations: [],
      };
    },
    {
      key: phaseKey,
      target: phaseTarget,
      crop: CROP,
      fovX: Number.isFinite(fovXDeg) ? fovXDeg : null,
      standoff: standoffM,
      searchStartIso: G4_MOON_SEARCH_START_ISO,
      searchDays: G4_MOON_SEARCH_DAYS,
      settleBudgetMs: SETTLE_BUDGET_MS,
      settleMinFrames: SETTLE_MIN_FRAMES,
      settleYieldMs: SETTLE_YIELD_MS,
    },
  );
}

// G4 LANE DEFINITIONS.
//
// ORDER IS LOAD-BEARING TWICE OVER. `policy` runs FIRST because its positive
// control drives `Scene#highDynamicRange` through the public setter, and every
// capture lane after it sets that flag explicitly per capture — running it last
// would read a flag the captures had already pinned as user-set. Within every
// other lane the SHIPPED-DEFAULT leg is captured LAST, so the certifying state
// is measured against the warmest caches, for the reason
// `G1_MODE_CAPTURE_ORDER` states.
const G4_LANE_DEFS = [
  {
    key: "policy",
    setupFn: setupPolicyProbe,
    setup: {},
    captures: [],
  },
  {
    key: "disc",
    setup: {
      aim: "sun-facing",
      skyAtmosphereOn: false,
      cameraHeightM: null,
      fovXDeg: G4_SUN_DISC_FOV_X_DEG,
      sunOn: true,
      moonOn: false,
    },
    captures: [
      // FLAT — limb darkening off. `(a0,a1,a2) = (1,0,0)` makes the law
      // evaluate to exactly 1 everywhere, i.e. the historical flat `step()`
      // disc, bit-for-bit. This is the reference leg of the differential.
      ...G4_DISC_EXPOSURES.map((e) => ({
        key: `flat-${e}x`,
        mode: "sun-only",
        exposure: e,
        hdr: true,
        glareOn: false,
        toggles: {
          enableSolarLimbDarkening: false,
          enableTrueSolarDiscSize: true,
          enableScreenSpaceSunHalo: true,
        },
      })),
      // LEGACY SIZE — the pre-C12-18 undersized disc, still flat, so
      // `flat - legacy` is an ANNULUS whose inner edge is the legacy disc and
      // whose outer edge is the true-size one. Their ratio is the B906 fix.
      ...G4_DISC_EXPOSURES.map((e) => ({
        key: `legacy-${e}x`,
        mode: "sun-only",
        exposure: e,
        hdr: true,
        glareOn: false,
        toggles: {
          enableSolarLimbDarkening: false,
          enableTrueSolarDiscSize: false,
          enableScreenSpaceSunHalo: true,
        },
      })),
      // SHIPPED DEFAULT — captured last.
      ...G4_DISC_EXPOSURES.map((e) => ({
        key: `limb-${e}x`,
        mode: "sun-only",
        exposure: e,
        hdr: true,
        glareOn: false,
        toggles: {
          enableSolarLimbDarkening: true,
          enableTrueSolarDiscSize: true,
          enableScreenSpaceSunHalo: true,
        },
      })),
    ],
  },
  {
    key: "halo",
    setup: {
      aim: "sun-facing",
      skyAtmosphereOn: false,
      cameraHeightM: null,
      fovXDeg: null,
      sunOn: true,
      moonOn: false,
    },
    captures: [
      // BAKE — the historical baked halo. Its billboard cannot reach past
      // 15.56 R_sun, so the 16-30 R_sun band is the positive control that the
      // band is empty without the post-process chain.
      ...G4_HALO_EXPOSURES.map((e) => ({
        key: `bake-${e}x`,
        mode: "sun-only",
        exposure: e,
        hdr: true,
        glareOn: false,
        toggles: { enableScreenSpaceSunHalo: false },
      })),
      // SHIPPED DEFAULT — captured last.
      ...G4_HALO_EXPOSURES.map((e) => ({
        key: `screen-${e}x`,
        mode: "sun-only",
        exposure: e,
        hdr: true,
        glareOn: false,
        toggles: { enableScreenSpaceSunHalo: true },
      })),
    ],
  },
  ...["crescent", "quarter", "full"].map((phaseKey) => ({
    key: `moon-${phaseKey}`,
    setupFn: setupMoonScene,
    setup: {
      phaseKey,
      phaseTarget: MOON_PHASE_TARGETS[phaseKey],
      fovXDeg: G4_MOON_FOV_X_DEG,
      standoffM: G4_MOON_STANDOFF_M,
    },
    captures: [
      ...G4_MOON_EXPOSURES.map((e) => ({
        key: `esOff-${e}x`,
        mode: "moon-only",
        exposure: e,
        hdr: true,
        toggles: { enableEarthshine: false, enableSoftTerminator: true },
      })),
      // SHIPPED DEFAULT (ruling R5 flipped `enableEarthshine` ON) — last.
      ...G4_MOON_EXPOSURES.map((e) => ({
        key: `esOn-${e}x`,
        mode: "moon-only",
        exposure: e,
        hdr: true,
        toggles: { enableEarthshine: true, enableSoftTerminator: true },
      })),
    ],
  })),
  {
    key: "moon-terminator",
    setupFn: setupMoonScene,
    setup: {
      phaseKey: "quarter",
      phaseTarget: MOON_PHASE_TARGETS.quarter,
      fovXDeg: G4_MOON_FOV_X_DEG,
      standoffM: G4_MOON_STANDOFF_M,
    },
    captures: [
      // HARD EDGE — `terminatorSoftness = 0` selects `max(N.L, 0)` bit-for-bit.
      ...G4_TERMINATOR_EXPOSURES.map((e) => ({
        key: `softOff-${e}x`,
        mode: "moon-only",
        exposure: e,
        hdr: true,
        toggles: { enableSoftTerminator: false, enableEarthshine: true },
      })),
      // SHIPPED DEFAULT — last.
      ...G4_TERMINATOR_EXPOSURES.map((e) => ({
        key: `softOn-${e}x`,
        mode: "moon-only",
        exposure: e,
        hdr: true,
        toggles: { enableSoftTerminator: true, enableEarthshine: true },
      })),
    ],
  },
];

// Disc sub-lane measurements for one backend. The MEASUREMENT itself lives in
// `lib/celestial-g4-gate.mjs` (`measureDiscDifferential`) so
// `celestial-g4-gate.spec.mjs` exercises the code the gate actually runs, over
// synthetic frames whose answer is known in closed form. This wrapper owns only
// the stitching and the live state.
function discMetrics(lane, solarModel) {
  const flat = stitchLeg(lane, "flat", G4_DISC_EXPOSURES);
  const legacy = stitchLeg(lane, "legacy", G4_DISC_EXPOSURES);
  const limb = stitchLeg(lane, "limb", G4_DISC_EXPOSURES);
  if (!flat || !legacy || !limb) {
    return { hdrEngaged: false, aimDistancePx: NaN };
  }
  const measured = measureDiscDifferential({
    flat: flat.linear,
    limb: limb.linear,
    legacy: legacy.linear,
    model: solarModel,
    fovXDeg: lane.setup.appliedFovXDeg,
    canvasWidth: lane.setup.canvasWidth,
    ephemerisDiameterDeg: 2 * (lane.setup.expectedSolarAngularRadiusDeg ?? NaN),
    sunProjectionCropPx: lane.setup.sunProjectionCropPx ?? null,
  });
  return {
    ...measured,
    hdrEngaged: flat.hdrEngaged && legacy.hdrEngaged && limb.hdrEngaged,
    aimSetup: lane.setup.aimDiagnostics ?? null,
    fovXDeg: lane.setup.appliedFovXDeg,
    // The DRAWING BUFFER, not the crop. The sun bloom's blur buffer is sized
    // from it, so the glow the radiance-recovery band models has to be built
    // against the buffer the frame was actually drawn into.
    canvasWidth: lane.setup.canvasWidth,
    canvasHeight: lane.setup.canvasHeight,
    lightingFlats: flat.lead.lightingRequested,
    lightingLimb: limb.lead.lightingRequested,
    lightingLegacy: legacy.lead.lightingRequested,
    discEdgeFlat: flat.lead.sunHalo?.discEdge ?? null,
    discEdgeLegacy: legacy.lead.sunHalo?.discEdge ?? null,
    // The SHIPPED leg's live appearance scalars, on the lane the absolute limb
    // ratio is actually measured on. `expectedCompositeLimbRatio` reads these
    // so the predicted confound describes THIS frame rather than a neighbouring
    // lane's (`G4-FIRSTRUN-FIX-4`).
    shippedHaloState: limb.lead.sunHalo ?? null,
  };
}

// Halo sub-lane measurements for one backend. Same split: `measureHaloProfile`
// is the lib's, the live `frameState.sunHalo` readings are this wrapper's.
function haloMetrics(lane, solarModel) {
  const bake = stitchLeg(lane, "bake", G4_HALO_EXPOSURES);
  const screen = stitchLeg(lane, "screen", G4_HALO_EXPOSURES);
  if (!bake || !screen) {
    return { hdrEngaged: false, aimDistancePx: NaN };
  }
  const measured = measureHaloProfile({
    screen: screen.linear,
    bake: bake.linear,
    limbPx: screen.lead.sunHalo?.limbPx ?? NaN,
    model: solarModel,
    // NOT `PSF_AIM_SEARCH_RADIUS_PX` (12) any more. Batch 941 reported
    // `aimDistancePx = 11.7686` against that radius — the search hit its own
    // wall, so the number was a FLOOR and the structural note could not say how
    // far off the aim was. See `HALO_AIM_SEARCH_RADIUS_PX`: the certifying
    // bound is unchanged at 6 px; only the range over which a miss can be
    // REPORTED grows.
    aimSearchRadiusPx: HALO_AIM_SEARCH_RADIUS_PX,
    fovXDeg: lane.setup.appliedFovXDeg,
    canvasWidth: lane.setup.canvasWidth,
    sunProjectionCropPx: lane.setup.sunProjectionCropPx ?? null,
  });
  return {
    ...measured,
    hdrEngaged: bake.hdrEngaged && screen.hdrEngaged,
    aimSetup: lane.setup.aimDiagnostics ?? null,
    screenLeg: screen.lead.sunHalo,
    bakeLeg: bake.lead.sunHalo,
    sunVisibleFraction: screen.lead.eclipseSunVisibleFraction,
    sunEclipseAlpha: screen.lead.sunEclipseAlpha,
  };
}

// Earthshine + phase measurements for ONE epoch lane.
//
// ⚠ SPLIT PER LANE (`G4-FIRSTRUN-FIX-5`). The three epochs used to be reduced
// together, which meant all three lanes' captures had to be alive at once — and
// since the reduction ran after BOTH backends had finished capturing, so did
// all 56. Nothing here needs a second epoch: the only cross-epoch quantities
// are ratios of SCALARS, assembled by `assembleMoonPhase` once the arrays are
// long gone.
function moonEpochLaneMetrics(lane, key) {
  const s = lane.setup;
  const epoch = {
    resolvedIso: s.resolvedIso,
    phaseTarget: s.phaseTarget,
    solvedFraction: s.solvedFraction,
    phaseFraction: s.phaseFraction,
    phaseAngleDeg: s.phaseAngleDeg,
    earthshinePhaseScale: s.earthshinePhaseScale,
    terminatorSoftness: s.terminatorSoftness,
    moonLimbPx: s.moonLimbPx,
    moonAimDistancePx: s.moonAimDistancePx,
    aimSetup: s.aimDiagnostics ?? null,
    appliedFovXDeg: s.appliedFovXDeg,
  };
  const off = stitchLeg(lane, "esOff", G4_MOON_EXPOSURES);
  const on = stitchLeg(lane, "esOn", G4_MOON_EXPOSURES);
  if (!off || !on) {
    epoch.integratedBrightness = NaN;
    return {
      epoch,
      earthshine: { maskPixels: 0, changedPixels: 0, medianDelta: NaN },
    };
  }
  // THE FULL EPOCH IS CENSUSED OVER THE WHOLE DISC, not the unlit mask: at
  // full moon there is no unlit limb in view, so the mask is empty and its
  // median is NaN. See `EARTHSHINE_INERTNESS_FACTOR`.
  let earthshine;
  if (key === "full") {
    earthshine = discDeltaCensus(on.linear, off.linear, {
      cx: s.moonCentre.x,
      cy: s.moonCentre.y,
      radius: s.moonLimbPx * MOON_DISC_MASK_FRACTION,
      eps: TERMINATOR_DELTA_EPS,
      // THE CERTIFYING STATISTIC (`G4-FOLLOWUP-EARTHSHINE-EXPOSURE`). The peak
      // of a ~247,000-pixel delta reads one code step of readback noise by
      // construction; the rank reads zero while noise stays under 5% of the
      // disc. `peakDelta` is still reported below, as the diagnostic it now is.
      quantile: EARTHSHINE_INERTNESS_QUANTILE,
    });
    // THE INSTRUMENT'S OWN RESOLUTION AT THE PIXEL THAT PRODUCED THE LARGEST
    // OBSERVED DELTA (`G4-FIRSTRUN-FIX-3`, now the RESOLVABILITY precondition —
    // see EARTHSHINE_INERTNESS_MIN_MUTANT_CODES). Taken here, while the raw
    // bracket is still in hand, because the evaluator cannot recover it from a
    // stitched composite: the display chain's inverse is violently non-linear
    // near the top, so one 8-bit code is worth 3.8e-3 of linear luminance at
    // code 128 and 3.3e-1 at code 250.
    earthshine.peakQuantumLinear = bracketQuantumAt(
      on.legs,
      earthshine.peakIndex,
    );
  } else {
    earthshine = unlitLimbDelta(on.linear, off.linear, {
      cx: s.moonCentre.x,
      cy: s.moonCentre.y,
      radius: s.moonLimbPx,
      innerFraction: MOON_UNLIT_MASK_FRACTION,
      darkFloor: MOON_UNLIT_DARK_FLOOR,
      changedEps: TERMINATOR_DELTA_EPS,
    });
  }
  // Disc-integrated brightness is taken on the SHIPPED leg (earthshine ON),
  // because that is the configuration the product renders.
  epoch.integratedBrightness = discIntegratedBrightness(on.linear, {
    cx: s.moonCentre.x,
    cy: s.moonCentre.y,
    radius: s.moonLimbPx * MOON_DISC_MASK_FRACTION,
  }).integrated;
  epoch.hdrEngaged = on.hdrEngaged && off.hdrEngaged;
  epoch.enableEarthshine = on.lead.enableEarthshine;
  return { epoch, earthshine };
}

// Combine the three per-epoch SCALAR reductions into the phase sub-lane input.
function assembleMoonPhase(epochs, surge) {
  const fullPhaseAngleDeg = epochs.full.phaseAngleDeg;
  return {
    epochs,
    fullPhaseAngleDeg,
    fullSurgeMultiplier: Number.isFinite(fullPhaseAngleDeg)
      ? surge((fullPhaseAngleDeg * Math.PI) / 180)
      : null,
    fullQuarterRatio:
      epochs.full.integratedBrightness / epochs.quarter.integratedBrightness,
    quarterCrescentRatio:
      epochs.quarter.integratedBrightness /
      epochs.crescent.integratedBrightness,
  };
}

// Soft-terminator measurements for one backend.
function terminatorMetrics(lane) {
  const off = stitchLeg(lane, "softOff", G4_TERMINATOR_EXPOSURES);
  const on = stitchLeg(lane, "softOn", G4_TERMINATOR_EXPOSURES);
  const s = lane.setup;
  if (!off || !on) {
    return { discPixels: 0, softnessOff: null, softnessOn: null };
  }
  const census = discDeltaCensus(on.linear, off.linear, {
    cx: s.moonCentre.x,
    cy: s.moonCentre.y,
    radius: s.moonLimbPx * MOON_DISC_MASK_FRACTION,
    eps: TERMINATOR_DELTA_EPS,
  });
  return {
    ...census,
    aimDistancePx: s.moonAimDistancePx,
    moonLimbPx: s.moonLimbPx,
    resolvedIso: s.resolvedIso,
    phaseFraction: s.phaseFraction,
    softnessOff: off.lead.moonTerminatorSoftness,
    softnessOn: on.lead.moonTerminatorSoftness,
    // Modelled band width, carried so a red count can be read against the
    // geometry that produced it rather than against the bound alone.
    modelledBandWidthPx_DIAGNOSTIC: r3(
      2 * (on.lead.moonTerminatorSoftness ?? 0) * s.moonLimbPx,
    ),
  };
}

async function runG4(browser, git) {
  // The shipped photometry modules, imported in NODE. Both are dependency-free
  // plain ESM, so this is the real engine source rather than a transcription —
  // the same posture the G2 magnitude lane takes when it imports
  // `BrightStarCatalog` in-page.
  const solarModel = (
    await import("../../packages/engine/Source/Scene/SolarDiscModel.js")
  ).default;
  const surge = (
    await import("../../packages/engine/Source/Scene/computeLunarOppositionSurge.js")
  ).default;

  const browserVersion = browser.version();
  const manifest = {};
  const backends = {};

  // Write one lane's PNGs + manifest entries. Called from inside
  // `runBackendLanes` so the pixels are written and dropped as the run goes,
  // rather than 56 captures being held to the end (`G4-FIRSTRUN-FIX-5`).
  const writeLaneCaptures = (laneKey, lane, renderer) => {
    for (const [capKey, cap] of Object.entries(lane.captures ?? {})) {
      const img = toImage(cap);
      const sceneName = `celestial-g4-${laneKey}-${capKey}`;
      const pngName = `${sceneName}-${renderer}.png`;
      const { png } = writeCapturePng(img, pngName);
      const sceneDescriptor = {
        name: sceneName,
        camera: {
          aim: lane.setup.phaseKey ?? "sun-facing",
          fovXDeg: lane.setup.appliedFovXDeg,
          distance: lane.setup.cameraToMoonM ?? 5.0e7,
          pinnedIso: lane.setup.resolvedIso ?? PINNED_ISO,
        },
        setup: "celestial-gate-g4",
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
          resolvedIso: lane.setup.resolvedIso ?? PINNED_ISO,
          moonPhaseFraction: cap.moonPhaseFraction ?? null,
          bakeHaloGain: cap.sunHalo?.bakeHaloGain ?? null,
        },
      });
    }
  };

  // Reduce ONE lane to scalars. Everything this returns is small; the lane's
  // pixel arrays are dropped by `runBackendLanes` the instant this returns.
  const reduceLane = (laneKey, lane, sink) => {
    if (laneKey === "policy") {
      sink.policy = lane.setup.policyReadings;
      sink.bakeClampPresent = lane.setup.bakeClampPresent;
      return;
    }
    if (laneKey === "disc") {
      sink.disc = discMetrics(lane, solarModel);
      return;
    }
    if (laneKey === "halo") {
      sink.halo = haloMetrics(lane, solarModel);
      return;
    }
    if (laneKey === "moon-terminator") {
      sink.terminator = terminatorMetrics(lane);
      return;
    }
    if (laneKey.startsWith("moon-")) {
      const key = laneKey.slice("moon-".length);
      const reduced = moonEpochLaneMetrics(lane, key);
      sink.epochs[key] = reduced.epoch;
      sink.earthshine[key] = reduced.earthshine;
    }
  };

  const sinks = {
    webgl: { epochs: {}, earthshine: {} },
    webgpu: { epochs: {}, earthshine: {} },
  };
  const runs = {};
  for (const renderer of ["webgl", "webgpu"]) {
    runs[renderer] = await runBackendLanes(
      browser,
      renderer,
      G4_LANE_DEFS,
      (laneKey, lane) => {
        writeLaneCaptures(laneKey, lane, renderer);
        reduceLane(laneKey, lane, sinks[renderer]);
      },
    );
    if (!runs[renderer].ok) {
      // Report each backend UNDER ITS OWN NAME. Handing the failing run back in
      // the `gpu` slot regardless of which backend it was makes the fatal
      // printout name the wrong renderer — caught the first time this path was
      // exercised.
      return { fatal: true, gl: runs.webgl ?? null, gpu: runs.webgpu ?? null };
    }
  }

  for (const renderer of ["webgl", "webgpu"]) {
    const s = sinks[renderer];
    const disc = s.disc;
    const measured = {
      renderer,
      disc,
      halo: s.halo,
      policy: s.policy,
      earthshine: {
        enableEarthshine: s.epochs.crescent.enableEarthshine,
        aimDistancePx: s.epochs.crescent.moonAimDistancePx,
        scaleCrescent: s.epochs.crescent.earthshinePhaseScale,
        scaleQuarter: s.epochs.quarter.earthshinePhaseScale,
        scaleFull: s.epochs.full.earthshinePhaseScale,
        crescent: s.earthshine.crescent,
        quarter: s.earthshine.quarter,
        full: s.earthshine.full,
      },
      terminator: s.terminator,
      phase: assembleMoonPhase(s.epochs, surge),
      limbAbsolute: {
        bakeClampPresent: s.bakeClampPresent,
        discPeakLinear: disc.discPeakLinear,
        ratioI095overI0: disc.ratioI095overI0_DIAGNOSTIC,
        // R-2 — the CERTIFYING reading. Halo-free by construction (see the
        // disc-only block in `measureDiscDifferential`), radiance-invariant,
        // and read against a band derived from the SHIPPED model and THIS
        // frame's resolved appearance scalars rather than a fixed literal.
        discOnlyRatio: disc.discOnlyRatio_I095_over_I0,
        discRadianceMeasured: disc.discRadianceMeasured,
        discRadianceResolved: disc?.shippedHaloState?.discRadiance,
        // The plateau's EXPECTATION. It is not the resolved radiance: the sun
        // bloom is still glowing over this annulus on the flat leg and has
        // stopped on the legacy one, so the plateau carries `L + glow`. Every
        // input is the frame's own — the drawing buffer the blur buffer is
        // sized from, the limb the engine drew, and the disc radius the
        // measurement binned at.
        radianceRecovery: deriveDiscRadianceRecoveryBand(solarModel, {
          discRadiance: disc?.shippedHaloState?.discRadiance,
          limbPx: disc?.shippedHaloState?.limbPx,
          centerX: disc?.shippedHaloState?.centerX,
          centerY: disc?.shippedHaloState?.centerY,
          discRadiusPx: disc.discRadiusPx,
          viewportWidth: disc.canvasWidth,
          viewportHeight: disc.canvasHeight,
          plateauPixels: disc.discRadiancePlateauPixels,
          exposures: G4_DISC_EXPOSURES,
        }),
        derivedBand: deriveDiscOnlyLimbBand(solarModel, {
          discRadiance: disc?.shippedHaloState?.discRadiance,
          haloAmplitude: disc?.shippedHaloState?.haloAmplitude,
          haloCoreRadii: disc?.shippedHaloState?.haloCoreRadii,
          // The RUN's own disc radius, so the dominant (radial-binning) term
          // is derived against the geometry the reading was taken at rather
          // than against the lane's modelled 170 px.
          discRadiusPx: disc.discRadiusPx,
          exposures: G4_DISC_EXPOSURES,
        }),
        // The named halo-over-disc confound, computed from the SHIPPED laws
        // against the LIVE-resolved appearance scalars (`G4-FIRSTRUN-FIX-4`).
        // Reported whatever the arm's state, so the maintainer decision has the
        // arithmetic rather than an assertion. NO LONGER CERTIFYING (R-2).
        expectedComposite: expectedCompositeLimbRatio(solarModel, {
          discRadiance: disc?.shippedHaloState?.discRadiance,
          haloAmplitude: disc?.shippedHaloState?.haloAmplitude,
          haloCoreRadii: disc?.shippedHaloState?.haloCoreRadii,
        }),
      },
    };
    backends[renderer] = evaluateG4Backend(measured);
  }

  // PERMANENT SENTINEL (`G4-FIRSTRUN-FIX-5`). A report is scalars; a pixel
  // buffer that reaches it is both a 20 MB retention and a 100 MB JSON file.
  const retained = findRetainedImageBuffers(backends);
  if (retained.length > 0) {
    console.error(
      `[celestial-g4] REPORT RETAINS IMAGE BUFFERS at: ${retained.join(", ")}`,
    );
  }

  const gl = runs.webgl;
  const gpu = runs.webgpu;
  const folded = foldG4Verdict(backends);
  return {
    fatal: false,
    gate: "G4",
    ...folded,
    pass: folded.exitCode === EXIT_CODE.PASS,
    backends,
    manifest,
    consoleErrors: {
      webgl: gl.consoleErrors,
      webgpu: gpu.consoleErrors,
    },
  };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const git = getGit();
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let result;
  let exitCode;
  try {
    result = G4
      ? await runG4(browser, git)
      : G3
        ? await runG3(browser, git)
        : G2
          ? await runG2(browser, git)
          : BRACKET
            ? await runBracket(browser, git)
            : await runG1(browser, git);
  } finally {
    await browser.close().catch(() => {});
  }

  if (result.fatal) {
    console.error(
      "[probe-celestial-gates] ERROR — a backend lane did not run at all",
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

  const outName = G4
    ? "celestial-g4.json"
    : G3
      ? "celestial-g3.json"
      : G2
        ? "celestial-g2.json"
        : BRACKET
          ? "celestial-bracket.json"
          : "celestial-g1.json";
  const outPath = path.join(OUT_DIR, outName);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  if (G4) {
    console.log(JSON.stringify(buildG4Summary(result), null, 2));
    // PENDING ARMS are printed SEPARATELY and labelled, for the same reason G3
    // separates its reversal triggers: a reader skimming the criteria list must
    // not mistake "the content this criterion binds does not exist yet" for
    // either a pass or a defect. An arm that is silently absent from this block
    // is an arm that ACTIVATED and is certifying in `criteria` above.
    const arms = Object.entries(result.pendingArms ?? {});
    console.log("\nPENDING ARMS (bound, NOT certifying at this commit):");
    if (arms.length === 0) {
      console.log("  (none — every G4 criterion is certifying at this commit)");
    }
    for (const [name, arm] of arms) {
      console.log(`  ${name}`);
      console.log(`    state:   ${arm.state}`);
      console.log(`    pending: ${arm.pending ?? "n/a"}`);
      console.log(`    measured: ${JSON.stringify(arm.measured)}`);
      console.log(`    why:     ${arm.reason}`);
    }
    // REPORTED, not gated — same posture as G1/G2/G3.
    for (const [renderer, errs] of Object.entries(result.consoleErrors ?? {})) {
      if (errs && errs.length > 0) {
        console.log(`console errors (${renderer}): ${errs.length}`);
        errs.slice(0, 6).forEach((e) => console.log(`  ERR: ${e}`));
      }
    }
    console.log(`\n[full report: ${outPath}]`);
    exitCode = result.exitCode;
    const verdictLine = {
      [EXIT_CODE.PASS]:
        "G4 PASS — the solar disc's size and limb law, the C12-18 screen halo, the C12-28 SDR policy, and the C12-21/C12-22 moon terms all certify, IDENTICALLY on both backends",
      [EXIT_CODE.FAIL]:
        "G4 FAIL — see failures[] above; each entry names the backend and the predicate. A pass on ONE backend is a FAIL for this gate (every term is CPU-resolved before the backend branch, campaign principle 5)",
      [EXIT_CODE.STRUCTURAL]:
        "G4 STRUCTURAL — a sub-lane ran but could not see its subject; this is NOT a pass and NOT a defect (see structural[] above)",
    };
    console.log(verdictLine[exitCode] ?? `G4 exit ${exitCode}`);
  } else if (G3) {
    console.log(JSON.stringify(buildG3Summary(result), null, 2));
    // The reversal-trigger block is printed SEPARATELY and labelled, because it
    // is evidence for a maintainer ruling rather than part of the verdict. A
    // reader who skims the criteria list must not mistake a fired trigger for a
    // gate failure, or an unfired one for a gate pass.
    console.log("\nDR-01 REVERSAL TRIGGERS (measured; NON-CERTIFYING):");
    for (const [renderer, b] of Object.entries(result.backends ?? {})) {
      for (const [key, t] of Object.entries(b?.triggers ?? {})) {
        console.log(
          `  ${renderer}:${key} measured=${t.measured} bound=${t.bound} ` +
            `[${t.boundKind}] triggered=${t.triggered}`,
        );
      }
    }
    // REPORTED, not gated — same posture as G1/G2.
    for (const [renderer, errs] of Object.entries(result.consoleErrors ?? {})) {
      if (errs && errs.length > 0) {
        console.log(`console errors (${renderer}): ${errs.length}`);
        errs.slice(0, 6).forEach((e) => console.log(`  ERR: ${e}`));
      }
    }
    console.log(`\n[full report: ${outPath}]`);
    exitCode = result.exitCode;
    const verdictLine = {
      [EXIT_CODE.PASS]:
        "G3 PASS — the shipped star-map asset certifies on every ratified criterion, IDENTICALLY on both backends",
      [EXIT_CODE.FAIL]:
        "G3 FAIL — see failures[] above; each entry names the backend and the predicate. Bars marked RATIFIED are NOT to be moved to clear a red: they are §5's own numbers",
      [EXIT_CODE.STRUCTURAL]:
        "G3 STRUCTURAL — a sub-lane ran but could not see its subject; this is NOT a pass and NOT a defect (see structural[] above)",
    };
    console.log(verdictLine[exitCode] ?? `G3 exit ${exitCode}`);
  } else if (G2) {
    console.log(JSON.stringify(buildG2Summary(result), null, 2));
    // REPORTED, not gated — same posture as G1. A console error during a gate
    // run is worth reading even when every criterion passed, and a gate that
    // silently swallowed one would be the next instrument defect.
    for (const [renderer, errs] of Object.entries(result.consoleErrors ?? {})) {
      if (errs && errs.length > 0) {
        console.log(`console errors (${renderer}): ${errs.length}`);
        errs.slice(0, 6).forEach((e) => console.log(`  ERR: ${e}`));
      }
    }
    console.log(`\n[full report: ${outPath}]`);
    exitCode = result.exitCode;
    const verdictLine = {
      [EXIT_CODE.PASS]:
        "G2 PASS — the PSF, the delivered magnitude range and the C12-27 angular glare all certify, IDENTICALLY on both backends",
      [EXIT_CODE.FAIL]:
        "G2 FAIL — see failures[] above; each entry names the backend and the predicate. A pass on ONE backend is a FAIL for this gate (shared code, campaign principle 5)",
      [EXIT_CODE.STRUCTURAL]:
        "G2 STRUCTURAL — a sub-lane ran but could not see its subject; this is NOT a pass and NOT a defect (see structural[] above)",
    };
    console.log(verdictLine[exitCode] ?? `G2 exit ${exitCode}`);
  } else if (BRACKET) {
    const summary = {
      gate: "bracket (C12-02 evidence, HDR lane)",
      structuralPass: result.structuralPass,
      lanes: Object.fromEntries(
        Object.entries(result.lanes).map(([k, v]) => [
          k,
          {
            hdrEngaged: v.hdrEngaged,
            rangeExtended: v.rangeExtended,
            m1Count: v.m1Count,
            m4_ratio1e3_DIAGNOSTIC: v.m4 ? v.m4.ratio1e3 : null,
            m5_spearman_DIAGNOSTIC: v.m5 ? v.m5.spearman : null,
            m5_matched: v.m5 ? v.m5.matched : null,
          },
        ]),
      ),
    };
    console.log(JSON.stringify(summary, null, 2));
    console.log(`\n[full report: ${outPath}]`);
    exitCode = result.structuralPass ? 0 : 1;
    console.log(
      exitCode === 0
        ? "bracket PASS — HDR engaged, sources detected, range extended on both backends"
        : "bracket FAIL — HDR not engaged and/or no source detected on a backend",
    );
  } else {
    console.log(JSON.stringify(buildG1Summary(result), null, 2));
    console.log(`\n[full report: ${outPath}]`);
    exitCode = result.exitCode;
    const verdictLine = {
      [EXIT_CODE.PASS]:
        "G1 PASS — cubemap/sprite parity holds AND the in-column star-modulation lane reached its failure state at parity",
      [EXIT_CODE.FAIL]: "G1 FAIL — see failures/lanes above",
      [EXIT_CODE.STRUCTURAL]:
        "G1 STRUCTURAL — a lane ran but could not see its subject; this is NOT a pass and NOT a defect (see structural[] above)",
    };
    console.log(verdictLine[exitCode] ?? `G1 exit ${exitCode}`);
  }

  clearTimeout(watchdog);
  process.exit(exitCode);
})().catch((e) => {
  console.error("[probe-celestial-gates] FATAL", e);
  clearTimeout(watchdog);
  process.exit(EXIT_CODE.ERROR);
});
