#!/usr/bin/env node
/**
 * COLD-OPTICS-HQ (Batch 442) — WebGPU-only visual probe for the advanced
 * ice-crystal optics: 22 + 46 dispersed halos, upper tangent arc, and light
 * pillars. The advanced branch is opt-in (`scene.coldOpticsAdvanced`); the
 * legacy 22 halo + sun-dogs (advanced OFF) must stay byte-identical.
 *
 * Three captures on the SAME WebGPU canvas:
 *   1. cold-optics ON, advanced OFF  — the legacy frame (parity reference).
 *   2. cold-optics ON, advanced ON   — sun ~28 up, WIDE FOV so the 46 halo
 *      fits; proves TWO distinct halo radii (22 and 46) + dispersion.
 *   3. cold-optics ON, advanced ON, LOW SUN — proves vertical light pillars.
 *
 * Analysis:
 *   - radial added-brightness profile (ON-minus-legacy) for capture 2 must
 *     show TWO peaks at distinct radii whose ratio ~ 46/22 ~ 2.09;
 *   - the inner rim of each ring is redder than the outer (dispersion);
 *   - capture 3 must show a VERTICAL streak of added brightness through the
 *     sun (pillar) much taller than it is wide;
 *   - 0 WebGPU device errors.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VERDICT REPAIR (Batch 861+) — `NEW-PROBE-VACUOUS-REACHABILITY-ASSERTION` sweep
 * ─────────────────────────────────────────────────────────────────────────────
 * `twoHalos` and `pillarTall` were computed under a literal `// Verdict.`
 * banner, printed, and then NEVER GATED: the only exit was
 * `process.exit(errCount === 0 ? 0 : 1)`. The probe therefore exited 0 — a
 * citable green — with BOTH substantive claims false, as long as no device
 * error fired. That is the stronger form of the vacuity class recorded in
 * DEFERRED_WORK: not a proxy gate, a verdict with no gate at all.
 *
 * Both booleans are now `pass` conjuncts, at their ORIGINAL thresholds
 * (`radial.peaks.length >= 2`; `pillar.aspect >= 1.8 && verticalExtentPx >= 20`),
 * and the run carries a STRUCTURAL tier for the preconditions those numbers are
 * only meaningful under:
 *   - the sun must project to a screen point in each capture set (the radial and
 *     pillar analyses are both centred on it; a null centre yields NaN, not a
 *     product defect);
 *   - the sun must be above the horizon at each solved time;
 *   - `coldOpticsAdvanced` must READ BACK as driven in both legs; and
 *   - the advanced-minus-legacy difference must be non-empty — an A/B in which
 *     no pixel changed is a dead toggle, not an absent halo.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cold-optics-hq.mjs
 * Outputs: Tools/visual-regression/output/cold-optics-hq-*.png
 * Exit:
 *   0 PASS | 1 a real product FAIL | 2 watchdog or exception
 *   3 STRUCTURAL — a precondition failed, so the verdict certifies nothing
 */
import { chromium } from "playwright";
import fs from "fs";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;
const OUT = "Tools/visual-regression/output";

const WATCHDOG_MS = 420_000;
const watchdog = setTimeout(() => {
  console.error(`[cold-optics-hq] watchdog fired after ${WATCHDOG_MS} ms`);
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

function shotDU(buf) {
  return "data:image/png;base64," + buf.toString("base64");
}

async function shot(page, name) {
  const canvas = await page.$(".cesium-widget canvas");
  await canvas.screenshot({ path: `${OUT}/${name}.png` });
  return shotDU(fs.readFileSync(`${OUT}/${name}.png`));
}

// Pick the UTC ISO time (2026-06-21) whose sun elevation at 40N/10E is
// closest to `targetElevDeg`, using the ANALYTIC sun position (deterministic;
// independent of the render loop). `sunDirectionWC` in uniformState only
// refreshes on a real RAF frame, NOT on a synchronous s.render() inside an
// evaluate — so scanning by reading uniformState in a loop is unreliable.
async function pickSunTime(page, targetElevDeg) {
  return page.evaluate(
    async ([elevDeg]) => {
      const C = (window.Cesium =
        window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
      const camPos = C.Cartesian3.fromDegrees(10.0, 40.0, 2000.0);
      const up = C.Cartesian3.normalize(camPos, new C.Cartesian3());
      const targetDot = Math.sin(C.Math.toRadians(elevDeg));
      let best = null;
      for (let h = 3.0; h <= 20.0; h += 0.1) {
        const hh = Math.floor(h).toString().padStart(2, "0");
        const mm = Math.min(59, Math.round((h - Math.floor(h)) * 60))
          .toString()
          .padStart(2, "0");
        const iso = `2026-06-21T${hh}:${mm}:00Z`;
        const t = C.JulianDate.fromIso8601(iso);
        const sunICRF =
          C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
            t,
            new C.Cartesian3(),
          );
        const toFixed = C.Transforms.computeIcrfToFixedMatrix(
          t,
          new C.Matrix3(),
        );
        const sunFixed = toFixed
          ? C.Matrix3.multiplyByVector(toFixed, sunICRF, new C.Cartesian3())
          : sunICRF;
        const sdn = C.Cartesian3.normalize(sunFixed, new C.Cartesian3());
        const dot = C.Cartesian3.dot(sdn, up);
        if (dot <= 0) continue;
        const err = Math.abs(dot - targetDot);
        if (!best || err < best.err) best = { iso, dot, err };
      }
      return best ? best.iso : "2026-06-21T16:00:00Z";
    },
    [targetElevDeg],
  );
}

// Set the clock to a chosen ISO, then aim the camera at the sun with a chosen
// FOV. Must be called AFTER a RAF wait so sunDirectionWC reflects the clock.
async function aimAtSun(page, iso, fovDeg) {
  return page.evaluate(
    async ([clockIso, fov]) => {
      const C = (window.Cesium =
        window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
      const v = window.viewer;
      const s = v.scene;
      s.requestRenderMode = false;
      if (s.skyAtmosphere) s.skyAtmosphere.show = true;
      if (s.sun) s.sun.show = true;

      const lon = 10.0;
      const lat = 40.0;
      const camPos = C.Cartesian3.fromDegrees(lon, lat, 2000.0);
      const enu = C.Transforms.eastNorthUpToFixedFrame(camPos);
      const up = C.Cartesian3.normalize(camPos, new C.Cartesian3());

      const sunDirWC = s.context.uniformState.sunDirectionWC;
      const sunDir = C.Cartesian3.normalize(sunDirWC, new C.Cartesian3());
      const sunUpDot = C.Cartesian3.dot(sunDir, up);
      let horiz = C.Cartesian3.subtract(
        sunDir,
        C.Cartesian3.multiplyByScalar(up, sunUpDot, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      if (C.Cartesian3.magnitude(horiz) < 1e-3) {
        horiz = C.Matrix4.multiplyByPointAsVector(
          enu,
          C.Cartesian3.UNIT_X,
          new C.Cartesian3(),
        );
      }
      C.Cartesian3.normalize(horiz, horiz);

      // Aim slightly above the sun so the sun sits in the lower-middle of frame
      // — leaves room above for the 46 upper halo + tangent arc + pillar top.
      const sunElevDeg = C.Math.toDegrees(Math.asin(Math.min(1, sunUpDot)));
      const aimElevRad = C.Math.toRadians(Math.max(2.0, sunElevDeg) + 18.0);
      const dir = C.Cartesian3.add(
        C.Cartesian3.multiplyByScalar(
          horiz,
          Math.cos(aimElevRad),
          new C.Cartesian3(),
        ),
        C.Cartesian3.multiplyByScalar(
          up,
          Math.sin(aimElevRad),
          new C.Cartesian3(),
        ),
        new C.Cartesian3(),
      );
      C.Cartesian3.normalize(dir, dir);

      v.camera.setView({
        destination: camPos,
        orientation: { direction: dir, up },
      });
      if (fov) s.camera.frustum.fov = C.Math.toRadians(fov);
      s.render();

      // Project the sun to screen.
      const sunFar = C.Cartesian3.add(
        camPos,
        C.Cartesian3.multiplyByScalar(sunDir, 1.0e9, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      const win = C.SceneTransforms.worldToWindowCoordinates(
        s,
        sunFar,
        new C.Cartesian2(),
      );
      return {
        sunElevDeg: +sunElevDeg.toFixed(1),
        sunWindow: win ? [Math.round(win.x), Math.round(win.y)] : null,
        fovDeg: +C.Math.toDegrees(s.camera.frustum.fov).toFixed(1),
      };
    },
    [iso, fovDeg],
  );
}

// Radial added-brightness profile of (ON - OFF) around the sun, plus the
// red/blue lean per radius bin so dispersion can be read out.
function analyzeRadial(page, offDU, onDU, sunXY) {
  return page.evaluate(
    async ([off, on, sun]) => {
      const dec = async (du) => {
        const img = new Image();
        img.src = du;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return c.getContext("2d").getImageData(0, 0, c.width, c.height);
      };
      const A = await dec(off);
      const B = await dec(on);
      const W = A.width;
      const H = A.height;
      const cx = sun[0];
      const cy = sun[1];
      const maxR = Math.floor(Math.min(W, H) * 0.62);
      const NB = 80;
      const binW = maxR / NB;
      const added = new Float64Array(NB);
      const count = new Float64Array(NB);
      const redLean = new Float64Array(NB); // mean (dR - dB) where added>0
      const leanN = new Float64Array(NB);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const dR = B.data[i] - A.data[i];
          const dG = B.data[i + 1] - A.data[i + 1];
          const dB = B.data[i + 2] - A.data[i + 2];
          const lum = 0.2126 * dR + 0.7152 * dG + 0.0722 * dB;
          const dx = x - cx;
          const dy = y - cy;
          const r = Math.sqrt(dx * dx + dy * dy);
          if (r >= maxR) continue;
          const bin = Math.min(NB - 1, Math.floor(r / binW));
          count[bin]++;
          if (lum > 4) {
            added[bin] += lum;
            redLean[bin] += dR - dB;
            leanN[bin]++;
          }
        }
      }
      const profile = [];
      const lean = [];
      for (let i = 0; i < NB; i++) {
        profile.push(count[i] > 0 ? added[i] / count[i] : 0);
        lean.push(leanN[i] > 0 ? redLean[i] / leanN[i] : 0);
      }
      // Find local peaks in the radial profile (away from centre).
      const innerSkip = Math.floor(NB * 0.12);
      const peaks = [];
      for (let i = innerSkip + 1; i < NB - 1; i++) {
        if (
          profile[i] > 1.0 &&
          profile[i] >= profile[i - 1] &&
          profile[i] >= profile[i + 1]
        ) {
          peaks.push({
            bin: i,
            px: Math.round(i * binW),
            val: +profile[i].toFixed(2),
          });
        }
      }
      // Merge peaks that are within 3 bins (same ring).
      const merged = [];
      for (const p of peaks) {
        const last = merged[merged.length - 1];
        if (last && p.bin - last.bin <= 3) {
          if (p.val > last.val) merged[merged.length - 1] = p;
        } else {
          merged.push(p);
        }
      }
      return {
        W,
        H,
        sun: [cx, cy],
        binW: +binW.toFixed(2),
        peaks: merged.slice(0, 4),
        profile: profile.map((v) => +v.toFixed(2)),
        leanAtPeaks: merged.slice(0, 4).map((p) => ({
          px: p.px,
          // inner-bin lean (1 in) vs outer-bin lean (1 out): red should
          // dominate the inner side, blue the outer.
          innerRedLean: +(lean[Math.max(0, p.bin - 2)] ?? 0).toFixed(1),
          outerRedLean: +(lean[Math.min(NB - 1, p.bin + 2)] ?? 0).toFixed(1),
        })),
      };
    },
    [offDU, onDU, sunXY],
  );
}

// Vertical-vs-horizontal extent of added brightness through the sun column —
// proves a light pillar (tall, narrow) rather than a glow (round).
function analyzePillar(page, offDU, onDU, sunXY) {
  return page.evaluate(
    async ([off, on, sun]) => {
      const dec = async (du) => {
        const img = new Image();
        img.src = du;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return c.getContext("2d").getImageData(0, 0, c.width, c.height);
      };
      const A = await dec(off);
      const B = await dec(on);
      const W = A.width;
      const H = A.height;
      const cx = Math.round(sun[0]);
      const cy = Math.round(sun[1]);
      const lumAdd = (x, y) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return 0;
        const i = (y * W + x) * 4;
        return (
          0.2126 * (B.data[i] - A.data[i]) +
          0.7152 * (B.data[i + 1] - A.data[i + 1]) +
          0.0722 * (B.data[i + 2] - A.data[i + 2])
        );
      };
      // Compare the ADDED brightness in a narrow VERTICAL strip through the
      // sun vs a narrow HORIZONTAL strip, both starting OUTSIDE the saturated
      // sun disc (|offset| from 15..280 px). A light pillar lights the
      // vertical strip far more than the horizontal one. We avoid the disc
      // itself (white in both frames -> zero diff) by skipping the inner 15px.
      const HALF = 5; // strip half-width
      const NEAR = 15;
      const FAR = 280;
      let vSum = 0;
      let vCount = 0;
      let vReach = 0;
      for (let dy = NEAR; dy <= FAR; dy++) {
        for (const sgn of [-1, 1]) {
          let strip = 0;
          for (let dx = -HALF; dx <= HALF; dx++)
            strip += lumAdd(cx + dx, cy + sgn * dy);
          const m = strip / (2 * HALF + 1);
          if (m > 6) {
            vSum += m;
            vCount++;
            vReach = Math.max(vReach, dy);
          }
        }
      }
      let hSum = 0;
      let hCount = 0;
      for (let dx = NEAR; dx <= FAR; dx++) {
        for (const sgn of [-1, 1]) {
          let strip = 0;
          for (let dy = -HALF; dy <= HALF; dy++)
            strip += lumAdd(cx + sgn * dx, cy + dy);
          const m = strip / (2 * HALF + 1);
          if (m > 6) {
            hSum += m;
            hCount++;
          }
        }
      }
      return {
        sun: [cx, cy],
        verticalExtentPx: vReach,
        verticalBrightPx: vCount,
        horizontalBrightPx: hCount,
        // Vertical-vs-horizontal added-brightness ratio. >>1 => a pillar.
        aspect: +(vSum / Math.max(1, hSum)).toFixed(2),
      };
    },
    [offDU, onDU, sunXY],
  );
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  try {
    return await runWith(browser);
  } finally {
    await browser.close();
  }
}

async function runWith(browser) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !!(window.viewer && window.viewer.scene),
    null,
    {
      timeout: 60000,
    },
  );
  await armWebGPUDevices(page);

  // Helper: set the clock to an ISO, then wait for real RAF frames so the
  // uniformState sunDirectionWC actually reflects the new time.
  const setClock = async (iso) => {
    await page.evaluate(async (clockIso) => {
      const C = (window.Cesium =
        window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
      const v = window.viewer;
      v.scene.requestRenderMode = false;
      v.clock.currentTime = C.JulianDate.fromIso8601(clockIso);
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;
    }, iso);
    await page.waitForTimeout(1200);
  };

  // ── Capture set A: sun ~28 up, WIDE FOV (100) so the 46 halo fits. ──────
  const isoA = await pickSunTime(page, 28.0);
  await setClock(isoA);
  const setupA = await aimAtSun(page, isoA, 100.0);
  console.log("[hq] setup A (high sun, wide FOV):", JSON.stringify(setupA));
  await page
    .waitForFunction(
      () => window.viewer.scene.globe.tilesLoaded === true,
      null,
      {
        timeout: 20000,
      },
    )
    .catch(() => {});
  await page.waitForTimeout(1200);

  // Legacy (advanced OFF) — parity reference + analysis baseline.
  const dialsLegacyA = await page.evaluate(() => {
    const s = window.viewer.scene;
    s.coldOpticsEnabled = true;
    s.coldOpticsIntensity = 1.0;
    s.coldOpticsAdvanced = false;
    return {
      enabled: s.coldOpticsEnabled,
      intensity: s.coldOpticsIntensity,
      advanced: s.coldOpticsAdvanced,
    };
  });
  await page.waitForTimeout(700);
  const legacyA = await shot(page, "cold-optics-hq-legacy-webgpu");

  // Advanced ON.
  const dialsAdvA = await page.evaluate(() => {
    const s = window.viewer.scene;
    s.coldOpticsAdvanced = true;
    return { enabled: s.coldOpticsEnabled, advanced: s.coldOpticsAdvanced };
  });
  await page.waitForTimeout(700);
  const advA = await shot(page, "cold-optics-hq-advanced-webgpu");

  const radial = await analyzeRadial(page, legacyA, advA, setupA.sunWindow);
  console.log(
    "[hq] radial (advanced - legacy):",
    JSON.stringify({
      binW: radial.binW,
      peaks: radial.peaks,
      leanAtPeaks: radial.leanAtPeaks,
    }),
  );
  // Ratio of the two largest-radius peaks (expect ~46/22 ~ 2.09).
  if (radial.peaks.length >= 2) {
    const sorted = [...radial.peaks].sort((a, b) => a.px - b.px);
    const inner = sorted[0].px;
    const outer = sorted[sorted.length - 1].px;
    console.log(
      `[hq] halo radii px: inner=${inner} outer=${outer} ratio=${(outer / inner).toFixed(2)} (expect ~2.09 for 46/22)`,
    );
  }

  // ── Capture set B: LOW sun (~6 up), narrower FOV — light pillars. ───────
  const isoB = await pickSunTime(page, 6.0);
  await setClock(isoB);
  const setupB = await aimAtSun(page, isoB, 70.0);
  console.log("[hq] setup B (low sun):", JSON.stringify(setupB));
  await page.waitForTimeout(900);

  const dialsLegacyB = await page.evaluate(() => {
    const s = window.viewer.scene;
    s.coldOpticsAdvanced = false;
    return { enabled: s.coldOpticsEnabled, advanced: s.coldOpticsAdvanced };
  });
  await page.waitForTimeout(600);
  const legacyB = await shot(page, "cold-optics-hq-lowsun-legacy-webgpu");

  const dialsAdvB = await page.evaluate(() => {
    const s = window.viewer.scene;
    s.coldOpticsAdvanced = true;
    return { enabled: s.coldOpticsEnabled, advanced: s.coldOpticsAdvanced };
  });
  await page.waitForTimeout(600);
  const advB = await shot(page, "cold-optics-hq-lowsun-advanced-webgpu");

  const pillar = await analyzePillar(page, legacyB, advB, setupB.sunWindow);
  console.log(
    "[hq] pillar (advanced - legacy, low sun):",
    JSON.stringify(pillar),
  );

  const gate = await collectGateErrors(page);
  const errCount =
    gate.errors.length + (gate.deviceLost ? 1 : 0) + consoleErrors.length;
  console.log(
    `[hq] gate errors=${gate.errors.length} deviceLost=${gate.deviceLost} consoleFaults=${consoleErrors.length}`,
  );
  if (gate.errors.length)
    console.log(JSON.stringify(gate.errors.slice(0, 8), null, 2));
  if (consoleErrors.length)
    consoleErrors.slice(0, 8).forEach((e) => console.log("  console:", e));

  // ── STRUCTURAL preconditions. Each one, if unmet, makes the two verdict
  // booleans below arithmetic noise rather than statements about the optics.
  const structural = [];
  for (const [name, setup] of [
    ["A (high sun, wide FOV)", setupA],
    ["B (low sun)", setupB],
  ]) {
    if (!setup.sunWindow) {
      structural.push(
        `${name}: the sun did not project to a screen point — the radial and pillar analyses have no centre`,
      );
    }
    if (!(setup.sunElevDeg > 0)) {
      structural.push(
        `${name}: solved sun elevation ${setup.sunElevDeg} is at or below the horizon — halos and pillars cannot occur`,
      );
    }
  }
  for (const [name, dials, expected] of [
    ["A legacy", dialsLegacyA, false],
    ["A advanced", dialsAdvA, true],
    ["B legacy", dialsLegacyB, false],
    ["B advanced", dialsAdvB, true],
  ]) {
    if (dials.enabled !== true || dials.advanced !== expected) {
      structural.push(
        `${name}: cold-optics dials did not take (enabled=${dials.enabled}, advanced=${dials.advanced}, expected advanced=${expected}) — the two legs are not the configurations they are labelled`,
      );
    }
  }
  // Non-vacuity of the A/B itself: if the advanced toggle moved no pixel at all,
  // "no halos" is a dead toggle, not an absent optical feature.
  const radialAddedEnergy = radial.profile.reduce((a, b) => a + b, 0);
  if (!(radialAddedEnergy > 0)) {
    structural.push(
      "capture set A: advanced-minus-legacy added no brightness anywhere in the disc — the advanced toggle is inert, so the halo count measures nothing",
    );
  }
  if (!(pillar.verticalBrightPx + pillar.horizontalBrightPx > 0)) {
    structural.push(
      "capture set B: advanced-minus-legacy added no brightness in either strip — the advanced toggle is inert, so the pillar aspect measures nothing",
    );
  }

  // Verdict — both booleans are now GATED, at their original thresholds.
  const twoHalos = radial.peaks.length >= 2;
  const pillarTall = pillar.aspect >= 1.8 && pillar.verticalExtentPx >= 20;
  console.log("\n==== COLD-OPTICS-HQ VERDICT ====");
  console.log(`two distinct halos: ${twoHalos} (${radial.peaks.length} peaks)`);
  console.log(
    `pillar tall+narrow: ${pillarTall} (aspect ${pillar.aspect}, vExtent ${pillar.verticalExtentPx}px)`,
  );
  console.log(`device errors: ${errCount}`);
  console.log(
    `radial added-energy total: ${radialAddedEnergy.toFixed(2)} (non-vacuity)`,
  );

  if (structural.length) {
    for (const s of structural) {
      console.log(`  STRUCTURAL: ${s}`);
    }
    console.log(
      "RESULT: STRUCTURAL — acceptance INCOMPLETE. This probe certifies nothing in this state.",
    );
    return 3;
  }
  const pass = twoHalos && pillarTall && errCount === 0;
  console.log(`RESULT: ${pass ? "PASS" : "FAIL"}`);
  return pass ? 0 : 1;
}

run()
  .then((code) => {
    clearTimeout(watchdog);
    process.exit(code);
  })
  .catch((e) => {
    clearTimeout(watchdog);
    console.error(e);
    process.exit(2);
  });
