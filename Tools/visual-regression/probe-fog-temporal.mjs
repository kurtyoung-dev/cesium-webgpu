#!/usr/bin/env node
// Probe: improvement-plan 3.5 — FOG-TEMPORAL (Batch 435).
//
// Verifies the WebGPU froxel volumetric-fog renderer's opt-in temporal
// reprojection + blue-noise jitter accumulation. With
// `atmosphericConditions.volumetricFog.temporal` ON, the integrate pass jitters
// the slice depth by blue noise per frame, reprojects the previous frame's
// integrated 3D scattering volume via `previousViewProjection`, and exponentially
// blends (alpha ~0.05) the current march with the reprojected (neighborhood-
// clamped) history. This amortizes the volume integration across frames and lets
// the grazing-ray march cap be removed.
//
// Three test modes:
//   parity    — fog ENABLED, temporal OFF. Single capture used by the
//               coordinator for the stash byte-identical parity gate.
//   static    — temporal ON, camera HELD STILL across many frames. Fog should
//               CONVERGE to a clean, stable, LESS-NOISY result.
//   moving    — temporal ON, camera ROTATED each frame (the ghosting test).
//               Capture mid-motion + after settle. NO smear / ghost trails /
//               light-leak; blue-noise jitter must not flicker visibly.
//
// Usage:
//   node Tools/visual-regression/probe-fog-temporal.mjs parity  [suffix]
//   node Tools/visual-regression/probe-fog-temporal.mjs static
//   node Tools/visual-regression/probe-fog-temporal.mjs moving
//
// Outputs under Tools/visual-regression/output/.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const mode = process.argv[2] || "parity";
const suffix = process.argv[3] || "";

// A fog scene chosen so the fog is a thick, visibly-noisy haze band over terrain
// (so the single-frame grazing-ray-cap noise is visible, and temporal's
// convergence is measurable). Oblique camera over the Alps looking north.
async function run() {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) => messages.push({ t: "pageerror", text: e.message }));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const outputs = [];

  const echo = await page.evaluate(
    async ({ mode }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      const ac = scene.globe.atmosphericConditions;

      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T15:00:00Z");

      // Save a setView helper on window for the moving capture. Camera sits
      // low over alpine terrain looking obliquely across the valleys so the
      // fog forms a structured band (god-rays + density pockets) with terrain
      // showing through — the structure is what makes convergence/ghosting
      // measurable. A shallow band (high falloff) + occlusion + varying
      // density give the fog spatial detail rather than a flat whiteout.
      window.__setHeading = (hdgDeg) =>
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(7.6, 45.9, 2400),
          orientation: {
            heading: C.Math.toRadians(hdgDeg),
            pitch: C.Math.toRadians(-14),
            roll: 0,
          },
        });
      window.__setHeading(20);

      // Thin, structured fog: low density + steep falloff so it's a shallow
      // ground-hugging band the terrain pokes through; scattering occlusion ON
      // (god-rays = high-gradient structure that exposes ghosting under
      // motion) + varying atmosphere density (noise pockets) for spatial
      // detail. Sun mid-low so the god-rays are pronounced.
      ac.volumetricFog.enabled = true;
      ac.volumetricFog.quality = "medium";
      ac.volumetricFog.density = 0.22;
      ac.volumetricFog.falloff = 0.0022;
      ac.volumetricFog.maxDistance = 26000;
      ac.volumetricFog.ambientStrength = 0.25;
      ac.volumetricFog.enableScatteringOcclusion = true;
      ac.volumetricFog.temporal = mode !== "parity";
      if (ac.varyingAtmosphereDensity) {
        ac.varyingAtmosphereDensity.enabled = true;
        ac.varyingAtmosphereDensity.noiseScale = 1800;
        ac.varyingAtmosphereDensity.noiseStrength = 0.7;
      }
      // Sun lower in the sky for pronounced god-ray structure.
      v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T16:40:00Z");

      // Warm up + load tiles. FIXED frame count (no early break) so the
      // render is deterministic across runs for the byte-parity gate.
      for (let i = 0; i < 280; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      // Extra settle frames so tile streaming has fully quiesced.
      for (let i = 0; i < 120; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      return {
        mode,
        temporal: ac.volumetricFog.temporal,
        fogEnabled: ac.volumetricFog.enabled,
        quality: ac.volumetricFog.quality,
      };
    },
    { mode },
  );

  async function shoot(label) {
    const out = path.join(OUT_DIR, `fog-temporal-${label}-webgpu.png`);
    await page.screenshot({ path: out, fullPage: false });
    outputs.push(out);
    return out;
  }

  if (mode === "parity") {
    // Render a stable, deterministic number of additional frames so the
    // integrated volume is fully settled, then capture once.
    await page.evaluate(async () => {
      const v = window.viewer;
      for (let i = 0; i < 60; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    });
    await page.waitForTimeout(600);
    const lab = suffix ? `parity-${suffix}` : "parity";
    await shoot(lab);
  } else if (mode === "static") {
    // Hold still; let temporal accumulate over many frames → converged.
    await page.evaluate(async () => {
      const v = window.viewer;
      for (let i = 0; i < 120; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    });
    await page.waitForTimeout(800);
    await shoot("static");
  } else if (mode === "moving") {
    // Rotate the camera ~1.5 deg/frame for ~24 frames (the ghosting test).
    // Capture MID-motion, then hold still and capture after settle.
    await page.evaluate(async () => {
      const v = window.viewer;
      // settle first at heading 0
      for (let i = 0; i < 30; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    });
    // Pan to mid-motion heading, capturing during motion.
    await page.evaluate(async () => {
      const v = window.viewer;
      window.__panState = 0;
      for (let i = 0; i < 16; i++) {
        window.__panState += 1.6;
        window.__setHeading(window.__panState);
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    });
    await page.waitForTimeout(120);
    await shoot("moving-mid");
    // Continue panning a bit, then stop and settle.
    await page.evaluate(async () => {
      const v = window.viewer;
      for (let i = 0; i < 16; i++) {
        window.__panState += 1.6;
        window.__setHeading(window.__panState);
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      // stop and settle
      for (let i = 0; i < 80; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    });
    await page.waitForTimeout(700);
    await shoot("moving-settle");
  }

  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  console.log(`[probe-fog-temporal] mode=${mode} echo=${JSON.stringify(echo)}`);
  outputs.forEach((o) => console.log(`  wrote: ${o}`));
  console.log(`  errors: ${errs.length}`);
  errs.slice(0, 6).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  await run();
})();
