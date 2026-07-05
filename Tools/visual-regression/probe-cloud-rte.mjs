#!/usr/bin/env node
/**
 * CLOUD-RTE probe (Batch 445 — item 4.12 CLOUD-RTE). WebGPU-only.
 *
 * Verifies the opt-in camera-relative high-precision cloud march
 * (`globe.defaultCloudCollection.volumetric.cloudHighPrecision`). The flag folds CLOUD_QF_HIGH_PRECISION (bit 12)
 * into qualityFlags; the WGSL then does shell intersection + sample-altitude in
 * camera-relative RTE space (high/low camera split) instead of the world-space
 * closest-point f32 form.
 *
 * The precision win in pure f32 is marginal ("~1m wobble currently unobserved"
 * per the plan), so the deliverable is the ARCHITECTURE + opt-in + default-off
 * parity — NOT a dramatic visual change. SUCCESS = the flag-ON render looks
 * ESSENTIALLY IDENTICAL to flag-OFF (no artifact, no shift). A precision path
 * must not change the nominal look.
 *
 * Captures (both WebGPU, same camera/time/coverage, default cinematic full-res
 * tier so the diff is deterministic):
 *   - OFF: clouds on, cloudHighPrecision unset (default)  → output/probe-cloud-rte-off.png
 *   - ON:  clouds on, cloudHighPrecision = true           → output/probe-cloud-rte-on.png
 * Then computes a pixel diff (sum-abs > 16). Expected: ~0% (essentially identical).
 *
 * Capture via Playwright page.screenshot() of the canvas (reliable WebGPU
 * readback).
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-rte.mjs
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;
const OUT_DIR = "Tools/visual-regression/output";

// Camera looking out across a cloud field with the sun up so the lit/shadow
// gradient is non-trivial (same framing precedent as the multi-deck probes).
const CAMERA = { lon: -100.0, lat: 36.0, height: 9000, heading: 40, pitch: -8 };
const TIME_ISO = "2026-06-21T17:00:00Z";

async function settleAndShoot(page, highPrecision, file) {
  // Configure the cloud scene + the high-precision flag, then settle.
  const state = await page.evaluate(
    async ({ camera, timeIso, highPrecision }) => {
      const v = window.viewer,
        s = v.scene,
        g = s.globe;
      const C = await import("/Build/CesiumUnminified/index.js");
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601(timeIso);
      s.skyAtmosphere.show = true;
      s.globe.show = true;
      s.globe.enableLighting = true;
      // Clouds ON at the DEFAULT (cinematic, full-res) tier; multiDeck OFF so the
      // single-shell march path is exercised (the one the RTE branch refines).
      g.defaultCloudCollection.enableVolumetric = true;
      g.defaultCloudCollection.volumetric.cloudVolumetricQuality = "high"; // cinematic → renderResScale=1, no temporal
      g.defaultCloudCollection.volumetric.cloudCoverage = 0.55;
      if ("cloudMultiDeck" in g) g.defaultCloudCollection.volumetric.cloudMultiDeck = false;
      // The opt-in flag under test.
      g.defaultCloudCollection.volumetric.cloudHighPrecision = highPrecision === true;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(
          camera.lon,
          camera.lat,
          camera.height,
        ),
        orientation: {
          heading: C.Math.toRadians(camera.heading),
          pitch: C.Math.toRadians(camera.pitch),
          roll: 0.0,
        },
      });
      let loadedStreak = 0;
      for (let i = 0; i < 1200; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (g.tilesLoaded === true) {
          loadedStreak++;
          if (loadedStreak > 60) break;
        } else {
          loadedStreak = 0;
        }
      }
      for (let i = 0; i < 60; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      return {
        showProceduralClouds: g.defaultCloudCollection.enableVolumetric,
        cloudHighPrecision: g.defaultCloudCollection.volumetric.cloudHighPrecision,
        cloudVolumetricQuality: g.defaultCloudCollection.volumetric.cloudVolumetricQuality,
      };
    },
    { camera: CAMERA, timeIso: TIME_ISO, highPrecision },
  );
  const canvas = await page.$("#cesiumContainer canvas, canvas");
  const out = path.join(OUT_DIR, file);
  await canvas.screenshot({ path: out });
  return { state, out };
}

// Diff two PNGs: count diff pixels (sum-abs > 16) via a headless canvas decode.
async function diffPngs(page, fileA, fileB) {
  const bA = fs.readFileSync(fileA).toString("base64");
  const bB = fs.readFileSync(fileB).toString("base64");
  return await page.evaluate(
    async ({ bA, bB }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return {
          w: c.width,
          h: c.height,
          data: ctx.getImageData(0, 0, c.width, c.height).data,
        };
      };
      const a = await decode(bA);
      const b = await decode(bB);
      if (a.w !== b.w || a.h !== b.h) {
        return { error: "size mismatch" };
      }
      let diff = 0;
      let maxd = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const d =
          Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]);
        if (d > maxd) maxd = d;
        if (d > 16) diff++;
      }
      const total = a.w * a.h;
      return {
        total,
        diffPx: diff,
        diffPct: ((100 * diff) / total).toFixed(3),
        maxChannelSum: maxd,
      };
    },
    { bA, bB },
  );
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto(URL, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForFunction(() => !!(window.viewer && window.viewer.scene), {
    timeout: 90_000,
  });

  // OFF (default) then ON.
  const off = await settleAndShoot(page, false, "probe-cloud-rte-off.png");
  const on = await settleAndShoot(page, true, "probe-cloud-rte-on.png");

  const diff = await diffPngs(page, off.out, on.out);

  console.log(JSON.stringify({ off: off.state, on: on.state, diff }, null, 1));

  const newErrs = errs.filter(
    (e) => !/AtmosphereLUT|default layout|favicon/.test(e),
  );

  console.log("\n=== ANALYSIS ===");
  const checks = [
    [
      `OFF: clouds on, highPrecision off (${off.state.showProceduralClouds} / ${off.state.cloudHighPrecision})`,
      off.state.showProceduralClouds === true &&
        off.state.cloudHighPrecision === false,
    ],
    [
      `ON: clouds on, highPrecision on (${on.state.showProceduralClouds} / ${on.state.cloudHighPrecision})`,
      on.state.showProceduralClouds === true &&
        on.state.cloudHighPrecision === true,
    ],
    [
      `OFF vs ON essentially identical (diff ${diff.diffPx}px / ${diff.diffPct}%, maxChannelSum=${diff.maxChannelSum})`,
      !diff.error && Number(diff.diffPct) < 0.5,
    ],
    [`no new console errors`, newErrs.length === 0],
  ];
  let pass = true;
  for (const [n, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
    if (!ok) pass = false;
  }
  if (newErrs.length) {
    console.log("\n  console errors:");
    newErrs.slice(0, 6).forEach((e) => console.log(`    ${e}`));
  }
  console.log(`\nPNGs: ${off.out}, ${on.out}`);
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  await browser.close();
  process.exitCode = pass ? 0 : 1;
})();
