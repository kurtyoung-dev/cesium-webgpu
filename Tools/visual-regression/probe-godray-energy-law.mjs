#!/usr/bin/env node
/**
 * Probe: the god-ray energy law at pixels — count invariance, the washout the
 * isolated emitter removes, and proof the shaft still exists.
 * @purpose Renders one fixed scene with god rays off and on at 16/32/64/128 samples, and measures whether brightness tracks the sample count, whether the far sky is still lifted by the effect, and whether a shaft remains near the sun; judged against a named --expect before|after.
 * @status ACTIVE
 *
 * WHY THIS EXISTS. The CPU spec `godray-energy-law.spec.mjs` executes the law's
 * arithmetic out of the shipped WGSL, but it cannot execute the march LOOP (the
 * evaluator reads no loops) and it never draws a pixel. Two things therefore
 * need a browser and are the whole of this probe's job:
 *
 *   1. that the shipped `fragmentMain` loop actually feeds both accumulators
 *      from the same attenuation, which is what makes the ratio a
 *      normalisation — measurable only as "the picture does not get brighter
 *      when the sample count goes up";
 *   2. that removing the scene colour as the emitter removes the washout, in
 *      real pixels, in a real target format, after tone mapping.
 *
 * TWO EXPECTATIONS, NEITHER DEFAULTED. `--expect` is required. `before` is run
 * against a tree served from the commit BEFORE the law lands and requires the
 * defect to be visible; `after` is run against the tip and requires it gone. A
 * probe that defaulted to `after` would report the pre-fix tree as a failure of
 * the fix rather than as the reproduction it is.
 *
 * THE SCENE. `EllipsoidTerrainProvider` with imagery removed, so the globe is a
 * flat grey `baseColor` and no tile request leaves the machine; sky atmosphere
 * ON, because a bright sky is the input the old law turned into washout; the
 * sun low and ahead of a shallow oblique camera so the shaft crosses the frame
 * and the globe limb supplies the occluder that gives it structure. The clock
 * is pinned, `requestRenderMode` is off and every leg renders a fixed number of
 * frames, so the only thing that changes between legs is the config under test.
 *
 * WHAT IS MEASURED. Mean luminance over three regions of each frame:
 *   FULL     the whole canvas
 *   NEAR     a disc of radius `glowRadius` in UV around the projected sun
 *   FAR      the sky band more than 4 x `glowRadius` from the sun, above the
 *            horizon row, which is where the old law's uniform lift lived
 * and the per-leg DELTA against the god-rays-OFF frame of the same scene —
 * plus, over the NEAR disc, the fraction of pixels that are CLIPPED (any
 * channel at the ceiling, and all three at it). The clipped fraction is what
 * turns the near-sun ceiling from a guess into a measurement: under the law's
 * own glow profile the clipped area fraction of the disc is exactly the
 * overshoot of the display white point, so the first capture calibrates the
 * bar it is judged by. See `lib/godray-near-ceiling.mjs` for the derivation.
 *
 * THE FAILURE THIS LEG USED NOT TO CATCH. Until the near-sun ceiling (G6)
 * existed, a shaft that blew the sun's neighbourhood out to white passed every
 * bar in this file — the count spread is invariant whether or not the picture
 * is too bright, the FAR band the washout bar measures is where a blow-out is
 * NOT, and the two near-sun bars are floors that pass harder the brighter it
 * gets. The most likely regression this law can produce was the one the leg
 * could not fail on.
 *
 * WHAT THIS PROBE DOES NOT ESTABLISH. There is no WebGL arm, because there is
 * no WebGL god-ray path in this engine at all (see `FEATURE_INVENTORY.md`
 * section C.7). Every number here is single-backend, and none of them is a
 * parity measurement. The FAR-band absolute bar is a CALIBRATION number with no
 * measured basis yet — see the bar table below.
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 \
 *     node Tools/visual-regression/probe-godray-energy-law.mjs --expect after
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";
import {
  NEAR_CEILING_ALPHA,
  NEAR_CEILING_FRACTION,
  impliedOvershoot,
  nearCeiling,
} from "../lib/godray-near-ceiling.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const W = 1024;
const H = 768;
const OUT = "Tools/visual-regression/output/godray-energy-law";

/** Machine-safety budget. Five legs of 60 frames plus startup. */
const WATCHDOG_BUDGET_MS = 12 * 60 * 1000;

/** Sample counts the behaviour is specified across. */
const SAMPLE_COUNTS = [16, 32, 64, 128];

/** The shipped glow radius default, in UV. */
const GLOW_RADIUS_UV = 0.1;

// A low oblique view with the sun ahead, over open ocean so the globe limb is
// the only occluder and the sky fills most of the frame.
const LON = -30.0;
const LAT = 20.0;
const ALT = 12000.0;
const ISO = "2026-06-21T21:40:00Z";

const expectArg = process.argv.indexOf("--expect");
const EXPECT = expectArg >= 0 ? process.argv[expectArg + 1] : undefined;
if (EXPECT !== "before" && EXPECT !== "after") {
  console.error(
    "probe-godray-energy-law: --expect before|after is required and has no default",
  );
  process.exit(2);
}

const SETUP = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  window.Cesium = C;
  const v = window.viewer;
  const s = v.scene;
  v.useDefaultRenderLoop = false;
  s.requestRenderMode = false;
  // No network, no imagery: a flat grey globe whose only role is to occlude.
  v.terrainProvider = new C.EllipsoidTerrainProvider();
  s.imageryLayers.removeAll();
  s.globe.baseColor = C.Color.fromBytes(90, 90, 95, 255);
  s.globe.enableLighting = true;
  s.skyBox.show = false;
  s.skyAtmosphere.show = true;
  if (s.sun) {
    s.sun.show = true;
  }
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(cfg.LON, cfg.LAT, cfg.ALT),
    orientation: {
      heading: C.Math.toRadians(270.0),
      pitch: C.Math.toRadians(-2.0),
      roll: 0.0,
    },
  });
  return { ok: true };
};

// Render one leg and return the canvas plus the sun's projected screen UV.
const RENDER_LEG = async (cfg) => {
  const C = window.Cesium;
  const v = window.viewer;
  const s = v.scene;
  const jd = C.JulianDate.fromIso8601(cfg.iso);
  v.clock.currentTime = jd;
  s.godRayEnabled = cfg.godRay === true;
  if (cfg.godRay === true) {
    s.godRayConfig = {
      density: 0.96,
      decay: 0.95,
      weight: 0.5,
      exposure: 0.15,
      sampleCount: cfg.sampleCount,
      occlusionFarCutoff: 0.99,
    };
  }
  for (let i = 0; i < 60; i += 1) {
    s.render(jd);
    await new Promise((r) => requestAnimationFrame(r));
  }
  // The sun's own screen UV, read the same way the effect's caller reads it, so
  // the NEAR/FAR regions are anchored to the actual emitter rather than to a
  // guess about where it is.
  let sunUV = null;
  try {
    const us = s.context.uniformState;
    const vp = us.viewProjection;
    const p = us.sunPositionWC;
    const cx = vp[0] * p.x + vp[4] * p.y + vp[8] * p.z + vp[12];
    const cy = vp[1] * p.x + vp[5] * p.y + vp[9] * p.z + vp[13];
    const cw = vp[3] * p.x + vp[7] * p.y + vp[11] * p.z + vp[15];
    if (cw > 0 && isFinite(cw)) {
      sunUV = [(cx / cw) * 0.5 + 0.5, -(cy / cw) * 0.5 + 0.5];
    }
  } catch {
    sunUV = null;
  }
  return { dataUrl: s.canvas.toDataURL("image/png"), sunUV };
};

// Mean luminance of the whole frame, of a disc around the sun, and of the sky
// band far from it. Decoding happens in the page so no image dependency is
// needed on the Node side.
function measure(page, dataUrl, sunUV, glowRadius) {
  return page.evaluate(
    async ([du, uv, r]) => {
      const img = new Image();
      img.src = du;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const cx = c.getContext("2d");
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      const acc = { full: 0, near: 0, far: 0 };
      const cnt = { full: 0, near: 0, far: 0 };
      // A pixel at the 8-bit ceiling can absorb no more added radiance, so the
      // clipped fraction of the near disc is the direct evidence for whether
      // the shaft overshoots the display white point. ANY channel clipped is
      // where the addition starts being lost; ALL three is the white plateau
      // that a blow-out looks like.
      const CLIP = 254;
      let nearSatAny = 0;
      let nearSatAll = 0;
      for (let y = 0; y < c.height; y += 1) {
        for (let x = 0; x < c.width; x += 1) {
          const i = (y * c.width + x) * 4;
          const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
          acc.full += l;
          cnt.full += 1;
          if (uv === null) {
            continue;
          }
          const du2 = (x + 0.5) / c.width - uv[0];
          const dv = (y + 0.5) / c.height - uv[1];
          const dist = Math.sqrt(
            du2 * du2 * (c.width / c.height) ** 2 + dv * dv,
          );
          if (dist <= r) {
            acc.near += l;
            cnt.near += 1;
            const hi = Math.max(d[i], d[i + 1], d[i + 2]);
            const lo = Math.min(d[i], d[i + 1], d[i + 2]);
            if (hi >= CLIP) {
              nearSatAny += 1;
            }
            if (lo >= CLIP) {
              nearSatAll += 1;
            }
          } else if (dist > 4 * r && y < c.height * 0.45) {
            // Above the horizon row for this camera pitch: sky only.
            acc.far += l;
            cnt.far += 1;
          }
        }
      }
      return {
        full: cnt.full ? +(acc.full / cnt.full).toFixed(6) : null,
        near: cnt.near ? +(acc.near / cnt.near).toFixed(6) : null,
        far: cnt.far ? +(acc.far / cnt.far).toFixed(6) : null,
        nearPixels: cnt.near,
        farPixels: cnt.far,
        nearSaturatedAny: cnt.near ? +(nearSatAny / cnt.near).toFixed(6) : null,
        nearSaturatedAll: cnt.near ? +(nearSatAll / cnt.near).toFixed(6) : null,
      };
    },
    [dataUrl, sunUV, glowRadius],
  );
}

async function run() {
  const fs = await import("node:fs");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const checks = [];
  const receipt = { base: BASE, expect: EXPECT, legs: {}, checks };
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    const consoleErrors = attachConsoleErrorGate(page);
    await page.addInitScript(errorGateInit);
    await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
    await armWebGPUDevices(page);
    await page.evaluate(SETUP, { LON, LAT, ALT });

    const off = await page.evaluate(RENDER_LEG, {
      iso: ISO,
      godRay: false,
      sampleCount: 64,
    });
    const sunUV = off.sunUV;
    receipt.sunUV = sunUV;
    const offM = await measure(page, off.dataUrl, sunUV, GLOW_RADIUS_UV);
    receipt.legs.off = offM;
    fs.writeFileSync(
      `${OUT}/godray-off.png`,
      Buffer.from(off.dataUrl.split(",")[1], "base64"),
    );

    for (const n of SAMPLE_COUNTS) {
      const leg = await page.evaluate(RENDER_LEG, {
        iso: ISO,
        godRay: true,
        sampleCount: n,
      });
      const m = await measure(page, leg.dataUrl, sunUV, GLOW_RADIUS_UV);
      receipt.legs[`on${n}`] = m;
      fs.writeFileSync(
        `${OUT}/godray-on-${n}.png`,
        Buffer.from(leg.dataUrl.split(",")[1], "base64"),
      );
    }

    const gateErrors = await collectGateErrors(page);
    receipt.gateErrors = gateErrors;
    receipt.consoleErrors = consoleErrors;

    // ── The bars ──────────────────────────────────────────────────────────
    const deltas = SAMPLE_COUNTS.map(
      (n) => receipt.legs[`on${n}`].full - offM.full,
    );
    receipt.fullDeltas = deltas.map((d) => +d.toFixed(6));
    const lo = Math.min(...deltas);
    const hi = Math.max(...deltas);
    const spread = lo > 0 ? hi / lo : Infinity;
    receipt.countSpread = Number.isFinite(spread) ? +spread.toFixed(4) : null;

    const farDelta = receipt.legs.on64.far - offM.far;
    const nearDelta = receipt.legs.on64.near - offM.near;
    receipt.farDelta = +farDelta.toFixed(6);
    receipt.nearDelta = +nearDelta.toFixed(6);

    // Everything the near-sun ceiling is calibrated FROM, recorded on both
    // legs so a `before`/`after` pair brackets it. The ceiling is a fraction
    // of THIS capture's own headroom, so a reader can re-derive the bar, and
    // `impliedOvershoot` says by how much a failing capture missed rather than
    // only that it missed.
    const nearHeadroom = 1 - offM.near;
    receipt.nearCalibration = {
      offNear: offM.near,
      on64Near: receipt.legs.on64.near,
      nearDelta: receipt.nearDelta,
      nearHeadroom: +nearHeadroom.toFixed(6),
      offNearSaturatedAll: offM.nearSaturatedAll,
      offNearSaturatedAny: offM.nearSaturatedAny,
      on64NearSaturatedAll: receipt.legs.on64.nearSaturatedAll,
      on64NearSaturatedAny: receipt.legs.on64.nearSaturatedAny,
      newlySaturatedAll: +(
        receipt.legs.on64.nearSaturatedAll - offM.nearSaturatedAll
      ).toFixed(6),
      ceilingAlpha: NEAR_CEILING_ALPHA,
      ceilingFraction: +NEAR_CEILING_FRACTION.toFixed(6),
      ceiling: +nearCeiling(offM.near).toFixed(6),
      impliedOvershoot: +impliedOvershoot(nearDelta, offM.near).toFixed(4),
    };

    const push = (name, ok, detail) => checks.push({ name, ok, detail });

    // The probe cannot judge anything if it never found the sun, or if the
    // regions came back empty. A structural miss must not read as a pass.
    push(
      "S1 the sun projected in front of the camera and both regions have pixels",
      sunUV !== null && offM.nearPixels > 500 && offM.farPixels > 5000,
      { sunUV, nearPixels: offM.nearPixels, farPixels: offM.farPixels },
    );
    push(
      "S2 every leg rendered a distinct frame from the OFF baseline",
      deltas.every((d) => Math.abs(d) > 1e-6),
      { deltas: receipt.fullDeltas },
    );
    // The near-sun floor (G3) and the near-sun ceiling (G6) are only
    // simultaneously satisfiable while the OFF disc leaves room above it:
    // G3 needs >= 0.01 luma of lift and G6 admits at most
    // NEAR_CEILING_FRACTION x headroom. If the OFF disc is already white this
    // scene cannot judge the amplitude at all, and that is a finding about the
    // capture rather than about the law.
    push(
      "S3 the OFF near-sun disc leaves headroom for both the floor and the ceiling",
      nearHeadroom > 0.01 / NEAR_CEILING_FRACTION,
      {
        offNear: offM.near,
        nearHeadroom: receipt.nearCalibration.nearHeadroom,
        offNearSaturatedAll: offM.nearSaturatedAll,
      },
    );

    if (EXPECT === "after") {
      // G1 — brightness does not track the sample count. The chord fraction is
      // a ratio of two quadratures of the same profile, so a clear chord reads
      // 1 at every N and an occluded one differs only by the quadrature error
      // of sampling its occluder. 1.05 leaves room for that error plus target
      // rounding, and is 15x tighter than the 1.784 the old algebra predicts.
      push(
        "G1 brightness does not track the sample count (<= 1.05)",
        spread <= 1.05,
        {
          spread: receipt.countSpread,
          deltas: receipt.fullDeltas,
        },
      );
      // G2 — the far sky is no longer lifted. CALIBRATION, not acceptance,
      // until a threshold is frozen: 0.02 luma is a stated starting value with
      // no measured basis, and the first run's job is to replace it.
      push(
        "G2 CALIBRATION the far sky lift is small (<= 0.02 luma)",
        farDelta <= 0.02,
        {
          farDelta: receipt.farDelta,
        },
      );
      // G3 — the shaft still exists. Without this, "no washout" is satisfied
      // by an effect that does nothing.
      push(
        "G3 a shaft remains near the sun (>= 0.01 luma)",
        nearDelta >= 0.01,
        {
          nearDelta: receipt.nearDelta,
        },
      );
      // G4 — the contribution is radial, not uniform. This is the property the
      // old law had no way to produce once its source stopped being a
      // bright-pass.
      push(
        "G4 the contribution falls off with distance from the sun (>= 3x)",
        nearDelta >= 3 * Math.max(farDelta, 1e-6),
        { nearDelta: receipt.nearDelta, farDelta: receipt.farDelta },
      );
      // G6 — the shaft does not blow out the near-sun disc. The only CEILING
      // on near-sun amplitude in this file, and the direction the law is most
      // likely to move: the added radiance is now `gain x sunRadiance` where
      // it used to be `gain x C_sky`, so near the sun it changes by 1/C_sky
      // and a pre-tonemap sky below unity means BRIGHTER. The bar is a
      // fraction of this capture's own measured headroom, and the fraction is
      // derived from the glow profile — see `lib/godray-near-ceiling.mjs`.
      // Its one judgement is that the peak may exceed the display white point
      // by 10%, which clips at most the inner 10% of the disc area; the
      // receipt's clipped fractions are what replace that judgement with a
      // measurement on the first run.
      push(
        `G6 the shaft does not blow out the near-sun disc (<= ${NEAR_CEILING_FRACTION.toFixed(4)} x headroom)`,
        nearDelta <= nearCeiling(offM.near),
        receipt.nearCalibration,
      );
    } else {
      // The reproduction. If either of these fails, the BEFORE tree does not
      // exhibit the defect at pixels and THAT is the finding — it is reported,
      // not tuned away.
      push("R1 brightness tracks the sample count (>= 1.25)", spread >= 1.25, {
        spread: receipt.countSpread,
        deltas: receipt.fullDeltas,
      });
      push(
        "R2 the far sky is lifted by the effect (>= 0.02 luma)",
        farDelta >= 0.02,
        {
          farDelta: receipt.farDelta,
        },
      );
    }

    push(
      "G5 no WebGPU device errors and no console errors",
      gateErrors.length === 0 && consoleErrors.length === 0,
      {
        gateErrors: gateErrors.slice(0, 5),
        consoleErrors: consoleErrors.slice(0, 5),
      },
    );

    // A bar that is still written in this file but never PUSHED — the
    // `if (false && …)` shape, or a branch that stops reaching it — does not
    // fail anything. It silently shortens the list and the leg reports a
    // quieter, greener pass. So the leg asserts its own bar set by name: an
    // inert bar is a failure here, and the receipt records which one.
    const REQUIRED_CHECKS = {
      after: ["S1", "S2", "S3", "G1", "G2", "G3", "G4", "G5", "G6"],
      before: ["S1", "S2", "S3", "R1", "R2", "G5"],
    };
    const ran = new Set(checks.map((c) => c.name.split(" ")[0]));
    const missing = REQUIRED_CHECKS[EXPECT].filter((n) => !ran.has(n));
    receipt.missingChecks = missing;
    push(
      `S4 every bar the ${EXPECT} expectation defines actually ran`,
      missing.length === 0,
      { required: REQUIRED_CHECKS[EXPECT], missing },
    );

    fs.writeFileSync(
      `${OUT}/receipt-${EXPECT}.json`,
      JSON.stringify(receipt, null, 2),
    );
    for (const c of checks) {
      console.log(
        `  [${c.ok ? "PASS" : "FAIL"}] ${c.name} ${JSON.stringify(c.detail)}`,
      );
    }
    const failed = checks.filter((c) => !c.ok).length;
    console.log(
      `probe-godray-energy-law --expect ${EXPECT}: ${checks.length - failed}/${checks.length} PASS`,
    );
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
}

const watchdog = setTimeout(() => {
  console.error(
    `probe-godray-energy-law exceeded its ${WATCHDOG_BUDGET_MS}ms machine-safety budget`,
  );
  process.exit(1);
}, WATCHDOG_BUDGET_MS);
watchdog.unref?.();

run().then(
  () => clearTimeout(watchdog),
  (e) => {
    clearTimeout(watchdog);
    console.error(`probe-godray-energy-law failed: ${String(e)}`);
    process.exitCode = 1;
  },
);
