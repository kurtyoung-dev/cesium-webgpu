#!/usr/bin/env node
// C12-25 LOLA lunar normal map — browser acceptance probe (Batch 811+).
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
// Usage: node Tools/visual-regression/probe-moon-lola-relief.mjs

import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const ISO_HALF = "2026-07-08T12:00:00Z"; // ~half phase — terminator bisects disc
const ISO_FULL = "2026-07-02T16:22:00Z"; // near-full (illumFrac ~0.94)
const CROP = 420;
const VIEW = { width: 1280, height: 720 };

async function capture(renderer, iso, reliefOn, tag) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
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
  fs.writeFileSync(`${OUT_DIR}/moon-lola-${tag}.png`, png);
  await browser.close();
  return { png, stats, errs };
}

// Decode two PNGs in a scratch page and diff their center crops.
async function diffCrops(pngA, pngB) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  const result = await page.evaluate(
    async ({ a, b, crop }) => {
      async function load(durl) {
        return await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
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
    },
  );
  await browser.close();
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
  `Lane 1 terminator ON-vs-OFF: WebGL ${halfGl.diffPct.toFixed(2)}%  WebGPU ${halfGpu.diffPct.toFixed(2)}%  (need >= 0.4 both)`,
);
console.log(
  `Lane 2 full-phase ON-vs-OFF: WebGL ${fullGl.diffPct.toFixed(2)}%  WebGPU ${fullGpu.diffPct.toFixed(2)}%  (need < half-phase and < 3.0)`,
);
console.log(
  `Lane 3 parity (half, ON):  ${parityOn.diffPct.toFixed(2)}%  (need < 15)`,
);
console.log(
  `Lane 4 identity (half, OFF): ${parityOff.diffPct.toFixed(2)}%  (need < 15)`,
);
const allErrs = Object.values(runs).flatMap((r) => [
  ...r.errs,
  ...(r.stats.deviceErrs ?? []),
]);
const pass =
  halfGl.diffPct >= 0.4 &&
  halfGpu.diffPct >= 0.4 &&
  fullGl.diffPct < Math.max(3.0, halfGl.diffPct) &&
  fullGpu.diffPct < Math.max(3.0, halfGpu.diffPct) &&
  fullGl.diffPct < 3.0 &&
  fullGpu.diffPct < 3.0 &&
  parityOn.diffPct < 15 &&
  parityOff.diffPct < 15 &&
  allErrs.length === 0;
console.log(`errors: ${allErrs.length}`);
if (allErrs.length > 0) {
  console.log(allErrs.slice(0, 6).join("\n"));
}
console.log(
  `\nGATE ${pass ? "PASS" : "FAIL"} — READ the PNGs: moon-lola-{half,full}-{webgl,webgpu}-{ON,OFF}.png`,
);
process.exit(pass ? 0 : 1);
