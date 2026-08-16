#!/usr/bin/env node
// C12-25 LOLA lunar normal map — browser acceptance probe (Batch 811+).
// @purpose C12-25 LOLA lunar normal-map acceptance: terminator ON/OFF relief, full-phase near-invisibility, cross-backend parity, OFF identity.
// @status ACTIVE
//
// Verifies the shipped terminator relief the way the feature is specified to
// behave, per backend (WebGL + WebGPU) and cross-backend:
//
//   Lane 1 — TERMINATOR (half phase): relief ON vs OFF must differ visibly
//     inside the disc (the whole point of a normal map is that grazing N·L
//     flips facets near the terminator). GATE: onOffDiffPct >= 0.4% of the
//     crop on both backends.
//   Lane 2 — FULL PHASE: the same toggle must be nearly invisible (N·L is
//     flat at the sub-solar disc). GATE: onOffDiffPct(full) <
//     onOffDiffPct(half), and < 3% absolute.
//   Lane 3 — PARITY: WebGL-ON vs WebGPU-ON center crops must track (the twin
//     shaders are the same expression). GATE: cross-backend diffPct < 15%
//     (same tolerance as probe-moon-sunlit).
//   Lane 4 — IDENTITY: relief OFF cross-backend diff must not exceed the ON
//     diff by more than noise — the OFF path is the pre-C12-25 look on both.
//
// The OFF captures drive `atmosphericConditions.lighting.enableLunarNormalMap
// = false`, which zeroes the strength uniform (exact identity on both
// backends) without a shader rebuild on WebGPU and with a define drop on
// WebGL.
//
// Method mirrors probe-moon-sunlit.mjs: pinned clock, camera parked on the
// Earth->moon line 20,000 km short (disc ~190 px), center crop decoded in a
// scratch page. Edge only (Playwright Firefox has no WebGPU).
//
// ─────────────────────────────────────────────────────────────────────────────
// GATE REPAIR (Batch 861+) — two of the four lanes did not enforce what this
// header documents. Read this before quoting a PASS from before that repair.
// ─────────────────────────────────────────────────────────────────────────────
//   LANE 2 carried an ABSOLUTE FLOOR that dissolved its relative comparison:
//   `fullGl.diffPct < Math.max(3.0, halfGl.diffPct) && ... && fullGl.diffPct <
//   3.0`. Since `Math.max(3.0, H) >= 3.0` for every H, the later `< 3.0`
//   conjunct implies the first one UNCONDITIONALLY — the two `Math.max` clauses
//   could not change the verdict for any (full, half) pair, so the documented
//   `onOffDiffPct(full) < onOffDiffPct(half)` was never enforced anywhere.
//   The trigger is not hypothetical: the Batch-813 acceptance run that
//   CERTIFIED C12-25 recorded half 1.30% and full 1.46% — full EXCEEDS half,
//   the documented gate is FALSE, and the probe printed GATE PASS.
//   The floor is now gone and the relative form is enforced as documented.
//   **CONSEQUENCE, stated up front: on numbers of the recorded shape this probe
//   now FAILS.** That failure is the finding — a lunar normal map that
//   perturbs the fully-lit disc more than the terminator is precisely the
//   wrong-sign / unclamped-strength class Lane 2 advertises catching, and the
//   absolute-only 3% bound cannot distinguish it from the blessed baseline.
//
//   LANE 4 was implemented as the same absolute `parityOff.diffPct < 15` as
//   Lane 3, and `parityOn` was never referenced in it, so "must not exceed the
//   ON diff by more than noise" was not implemented at all. It now enforces
//   `parityOff <= parityOn + PARITY_IDENTITY_NOISE_PCT`, and keeps the absolute
//   < 15 bound as well — nothing was widened or dropped.
//
// Usage: node Tools/visual-regression/probe-moon-lola-relief.mjs
// Exit: 0 PASS | 1 product FAIL | 2 watchdog or exception

import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const ISO_HALF = "2026-07-08T12:00:00Z"; // ~half phase — terminator bisects disc
const ISO_FULL = "2026-07-02T16:22:00Z"; // near-full (illumFrac ~0.94)
const CROP = 420;
const VIEW = { width: 1280, height: 720 };
/**
 * Lane 4's "by more than noise". The OFF path zeroes the strength uniform on
 * both backends, so the two OFF frames are the pre-C12-25 look and their
 * cross-backend diff must not be materially WORSE than the ON pair's. Measured
 * at Batch 813: parityOn 0.00%, parityOff 0.00%.
 */
const PARITY_IDENTITY_NOISE_PCT = 1.0;
/** Lane 2/3/4 absolute bounds — UNCHANGED from the pre-repair probe. */
const FULL_PHASE_MAX_PCT = 3.0;
const PARITY_MAX_PCT = 15;
const TERMINATOR_MIN_PCT = 0.4;
/** In-page image decode budget. `page.evaluate` accepts no timeout of its own. */
const DECODE_TIMEOUT_MS = 30_000;

const WATCHDOG_MS = 900_000;
const watchdog = setTimeout(() => {
  console.error(
    `[probe-moon-lola-relief] watchdog fired after ${WATCHDOG_MS} ms — 14 browser launches did not complete`,
  );
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

async function capture(renderer, iso, reliefOn, tag) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
  try {
    return await captureWith(browser, renderer, iso, reliefOn, tag);
  } finally {
    await browser.close();
  }
}

async function captureWith(browser, renderer, iso, reliefOn, tag) {
  const page = await browser.newPage({ viewport: VIEW });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const stats = await page.evaluate(
    async ({ iso, reliefOn }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const t = C.JulianDate.fromIso8601(iso);
      try {
        await C.Transforms.preloadIcrfFixed(
          new C.TimeInterval({
            start: C.JulianDate.addDays(t, -1, new C.JulianDate()),
            stop: C.JulianDate.addDays(t, 1, new C.JulianDate()),
          }),
        );
      } catch (e) {
        /* fallback transform is identical on both backends */
      }
      v.clock.currentTime = t.clone();
      v.clock.startTime = t.clone();
      v.clock.stopTime = t.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;
      for (const sel of [
        ".cesium-viewer-timelineContainer",
        ".cesium-viewer-animationContainer",
        ".cesium-viewer-bottom",
        ".cesium-viewer-toolbar",
        ".cesium-viewer-fullscreenContainer",
        ".cesium-viewer-navigationContainer",
        ".cesium-navigation-help",
        ".cesium-renderer-toggle",
      ]) {
        const el = document.querySelector(sel);
        if (el) el.style.display = "none";
      }

      const s = v.scene;
      const conditions =
        s.atmosphericConditions ?? s.globe?.atmosphericConditions;
      const lighting = conditions?.lighting;
      if (!lighting) {
        return { fatal: "no atmosphericConditions.lighting facade" };
      }
      lighting.enableLunarNormalMap = reliefOn;

      const dev = s.context?._device;
      const de = [];
      if (dev) {
        dev.onuncapturederror = (ev) =>
          de.push(String(ev?.error?.message ?? "").slice(0, 200));
      }

      for (let i = 0; i < 5; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      const moonPos = C.Matrix4.getTranslation(
        s.moon._ellipsoidPrimitive.modelMatrix,
        new C.Cartesian3(),
      );
      const dist = C.Cartesian3.magnitude(moonPos);
      const dir = C.Cartesian3.normalize(moonPos, new C.Cartesian3());
      const camPos = C.Cartesian3.multiplyByScalar(
        dir,
        dist - 2.0e7,
        new C.Cartesian3(),
      );
      let up = C.Cartesian3.cross(dir, C.Cartesian3.UNIT_Z, new C.Cartesian3());
      if (C.Cartesian3.magnitude(up) < 1e-6) {
        up = C.Cartesian3.cross(dir, C.Cartesian3.UNIT_X, up);
      }
      C.Cartesian3.normalize(up, up);
      v.camera.setView({
        destination: camPos,
        orientation: { direction: dir, up },
      });
      // Long settle: the normal map + albedo fetch and upload asynchronously.
      for (let i = 0; i < 120; i++) {
        s.requestRender();
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      return {
        deviceErrs: de,
        reliefApplied: lighting.enableLunarNormalMap === reliefOn,
      };
    },
    { iso, reliefOn },
  );

  const canvas = await page.$("canvas");
  const png = await canvas.screenshot({ type: "png" });
  if (!png || png.length === 0) {
    throw new Error(`capture ${tag}: canvas screenshot returned no bytes`);
  }
  fs.writeFileSync(`${OUT_DIR}/moon-lola-${tag}.png`, png);
  return { png, stats, errs };
}

// Decode two PNGs in a scratch page and diff their center crops.
async function diffCrops(pngA, pngB) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    return await diffCropsWith(browser, pngA, pngB);
  } finally {
    await browser.close();
  }
}

async function diffCropsWith(browser, pngA, pngB) {
  const page = await browser.newPage();
  const result = await page.evaluate(
    async ({ a, b, crop, decodeTimeoutMs }) => {
      // `page.evaluate` has no timeout of its own, so an undecodable data URL
      // with an onload-only promise hangs the whole run holding a browser. Both
      // failure paths are wired: onerror rejects, and a deadline rejects if the
      // decoder simply never calls back.
      async function load(durl) {
        return await new Promise((resolve, reject) => {
          const img = new Image();
          const timer = setTimeout(
            () =>
              reject(new Error(`image decode exceeded ${decodeTimeoutMs} ms`)),
            decodeTimeoutMs,
          );
          img.onload = () => {
            clearTimeout(timer);
            resolve(img);
          };
          img.onerror = () => {
            clearTimeout(timer);
            reject(new Error("image decode failed (onerror)"));
          };
          img.src = durl;
        });
      }
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const w = Math.min(ia.width, ib.width);
      const h = Math.min(ia.height, ib.height);
      const cx = Math.floor(w / 2);
      const cy = Math.floor(h / 2);
      const half = Math.floor(crop / 2);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(ia, 0, 0);
      const da = ctx.getImageData(cx - half, cy - half, crop, crop).data;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(ib, 0, 0);
      const db = ctx.getImageData(cx - half, cy - half, crop, crop).data;
      let diff = 0;
      let total = 0;
      for (let i = 0; i < da.length; i += 4) {
        total++;
        const d =
          Math.abs(da[i] - db[i]) +
          Math.abs(da[i + 1] - db[i + 1]) +
          Math.abs(da[i + 2] - db[i + 2]);
        if (d > 12) diff++;
      }
      return { diffPct: (100 * diff) / total };
    },
    {
      a: `data:image/png;base64,${pngA.toString("base64")}`,
      b: `data:image/png;base64,${pngB.toString("base64")}`,
      crop: CROP,
      decodeTimeoutMs: DECODE_TIMEOUT_MS,
    },
  );
  return result;
}

const runs = {};
for (const [renderer, iso, on, tag] of [
  ["webgl", ISO_HALF, true, "half-webgl-ON"],
  ["webgl", ISO_HALF, false, "half-webgl-OFF"],
  ["webgpu", ISO_HALF, true, "half-webgpu-ON"],
  ["webgpu", ISO_HALF, false, "half-webgpu-OFF"],
  ["webgl", ISO_FULL, true, "full-webgl-ON"],
  ["webgl", ISO_FULL, false, "full-webgl-OFF"],
  ["webgpu", ISO_FULL, true, "full-webgpu-ON"],
  ["webgpu", ISO_FULL, false, "full-webgpu-OFF"],
]) {
  runs[tag] = await capture(renderer, iso, on, tag);
  const s = runs[tag].stats;
  console.log(
    `${tag}: deviceErrs=${s.deviceErrs ? s.deviceErrs.length : "n/a"} consoleErrs=${runs[tag].errs.length}${s.fatal ? " FATAL: " + s.fatal : ""}`,
  );
}

const halfGl = await diffCrops(
  runs["half-webgl-ON"].png,
  runs["half-webgl-OFF"].png,
);
const halfGpu = await diffCrops(
  runs["half-webgpu-ON"].png,
  runs["half-webgpu-OFF"].png,
);
const fullGl = await diffCrops(
  runs["full-webgl-ON"].png,
  runs["full-webgl-OFF"].png,
);
const fullGpu = await diffCrops(
  runs["full-webgpu-ON"].png,
  runs["full-webgpu-OFF"].png,
);
const parityOn = await diffCrops(
  runs["half-webgl-ON"].png,
  runs["half-webgpu-ON"].png,
);
const parityOff = await diffCrops(
  runs["half-webgl-OFF"].png,
  runs["half-webgpu-OFF"].png,
);

console.log("\n=== C12-25 LOLA relief gates ===");
console.log(
  `Lane 1 terminator ON-vs-OFF: WebGL ${halfGl.diffPct.toFixed(2)}%  WebGPU ${halfGpu.diffPct.toFixed(2)}%  (need >= ${TERMINATOR_MIN_PCT} both)`,
);
console.log(
  `Lane 2 full-phase ON-vs-OFF: WebGL ${fullGl.diffPct.toFixed(2)}% (< half ${halfGl.diffPct.toFixed(2)}%)  ` +
    `WebGPU ${fullGpu.diffPct.toFixed(2)}% (< half ${halfGpu.diffPct.toFixed(2)}%)  (need < half-phase AND < ${FULL_PHASE_MAX_PCT})`,
);
console.log(
  `Lane 3 parity (half, ON):  ${parityOn.diffPct.toFixed(2)}%  (need < ${PARITY_MAX_PCT})`,
);
console.log(
  `Lane 4 identity (half, OFF): ${parityOff.diffPct.toFixed(2)}%  ` +
    `(need <= ON ${parityOn.diffPct.toFixed(2)}% + ${PARITY_IDENTITY_NOISE_PCT} noise, AND < ${PARITY_MAX_PCT})`,
);
const allErrs = Object.values(runs).flatMap((r) => [
  ...r.errs,
  ...(r.stats.deviceErrs ?? []),
]);

// Lane 2 as DOCUMENTED: strictly less visible at full phase than at the
// terminator, AND under the absolute bound. The former is the physical claim
// ("N·L is flat at the sub-solar disc"); the latter alone cannot distinguish a
// wrong-sign / unclamped normal map from the blessed baseline. No `Math.max`
// floor — a floor at or above the absolute bound erases the comparison.
const lane2Gl = fullGl.diffPct < halfGl.diffPct;
const lane2Gpu = fullGpu.diffPct < halfGpu.diffPct;
// Lane 4 as DOCUMENTED: relative to the ON pair, plus the absolute bound.
const lane4Relative =
  parityOff.diffPct <= parityOn.diffPct + PARITY_IDENTITY_NOISE_PCT;

const pass =
  halfGl.diffPct >= TERMINATOR_MIN_PCT &&
  halfGpu.diffPct >= TERMINATOR_MIN_PCT &&
  lane2Gl &&
  lane2Gpu &&
  fullGl.diffPct < FULL_PHASE_MAX_PCT &&
  fullGpu.diffPct < FULL_PHASE_MAX_PCT &&
  parityOn.diffPct < PARITY_MAX_PCT &&
  lane4Relative &&
  parityOff.diffPct < PARITY_MAX_PCT &&
  allErrs.length === 0;

if (!lane2Gl || !lane2Gpu) {
  console.log(
    `  Lane 2 RELATIVE clause FAILED (WebGL ${lane2Gl}, WebGPU ${lane2Gpu}) — the toggle moved MORE ` +
      `pixels at full phase than at the terminator. This is the clause the pre-repair ` +
      `Math.max(3.0, half) floor dissolved; the Batch-813 certifying run (half 1.30 / full 1.46) ` +
      `also violated it and printed PASS.`,
  );
}
if (!lane4Relative) {
  console.log(
    `  Lane 4 RELATIVE clause FAILED — OFF parity ${parityOff.diffPct.toFixed(2)}% exceeds ON ` +
      `${parityOn.diffPct.toFixed(2)}% by more than ${PARITY_IDENTITY_NOISE_PCT}%; the OFF path is ` +
      `supposed to be the identical pre-C12-25 look on both backends.`,
  );
}
console.log(`errors: ${allErrs.length}`);
if (allErrs.length > 0) {
  console.log(allErrs.slice(0, 6).join("\n"));
}
console.log(
  `\nGATE ${pass ? "PASS" : "FAIL"} — READ the PNGs: moon-lola-{half,full}-{webgl,webgpu}-{ON,OFF}.png`,
);
clearTimeout(watchdog);
process.exit(pass ? 0 : 1);
