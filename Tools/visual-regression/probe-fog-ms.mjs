#!/usr/bin/env node
// Probe: improvement-plan 4.3 — FOG-MS (Batch 440).
// @purpose Opt-in multi-octave multiple scattering in the froxel-fog in-scatter pass: parity/off/on modes; dense mist reads as a lit volume, no blowout.
// @status ACTIVE
//
// Verifies the WebGPU froxel volumetric-fog renderer's opt-in multiple-scattering
// octaves in the light-scattering (in-scatter source) pass. With
// `atmosphericConditions.volumetricFog.multiScatter` ON (and `msOctaves` > 1), the
// scattering kernel sums Frostbite-style multi-octave in-scatter (each octave scales
// contribution/extinction/phase-eccentricity by a/b/c ~ 0.5) on top of the existing
// energy-conserving SINGLE-scatter term, so a dense valley mist reads as a LIT VOLUME
// (light bleeds through the dense core) instead of a flat dark mass — without blowing
// out (energy-conserving, normalized by the contribution sum).
//
// Test modes:
//   parity — fog ENABLED, multiScatter OFF (msOctaves 1). Single capture used by the
//            coordinator for the stash byte-identical parity gate (octave 1 == the
//            existing single-scatter term).
//   off    — same dense-fog scene, multiScatter OFF (the comparison reference).
//   on     — same dense-fog scene, multiScatter ON, msOctaves 3 (the lit-volume test).
//
// Usage:
//   node Tools/visual-regression/probe-fog-ms.mjs parity [suffix]
//   node Tools/visual-regression/probe-fog-ms.mjs off
//   node Tools/visual-regression/probe-fog-ms.mjs on
//
// Outputs under Tools/visual-regression/output/.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const mode = process.argv[2] || "parity";
const suffix = process.argv[3] || "";

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
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

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
      // Sun low in the sky so the dense mist has a strong directional
      // forward-scatter component to bleed deeper through MS octaves.
      v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T16:40:00Z");

      // Proven structured-fog camera (matches probe-fog-temporal.mjs): low over
      // alpine terrain looking obliquely across the valleys so the fog forms a
      // structured band (god-rays + density pockets) with terrain showing
      // through — the structure is what makes the dense-core lit-vs-dark
      // contrast measurable.
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

      // DENSE mist — density + falloff tuned so the view ray is fully inside a
      // thick, near-OPAQUE fog band (per-froxel density near the base value → the
      // MS optical depth lands in the lift band). A LOW ambient floor keeps the
      // dense core genuinely DARK under single-scatter (the "flat dark mass"). MS
      // lifts that into a brighter, softer lit volume — energy-conserving, no
      // blowout. NOTE: a SEE-THROUGH scene (terrain visible) makes the visible
      // froxels thin → MS is a no-op there; the lit-volume effect is, by design,
      // a DENSE-fog feature, so the demonstration uses a socked-in opaque mist.
      ac.volumetricFog.enabled = true;
      ac.volumetricFog.quality = "medium";
      ac.volumetricFog.density = 0.5;
      ac.volumetricFog.falloff = 0.0022;
      ac.volumetricFog.maxDistance = 26000;
      ac.volumetricFog.ambientStrength = 0.06;
      ac.volumetricFog.fogAnisotropy = 0.5;

      // PARITY mode strips the async-resource-dependent input (scattering
      // occlusion needs the shadow map) so the OFF render is BYTE-STABLE
      // run-to-run — a sound stash-vs-restore parity gate. The off/on VISUAL
      // modes keep occlusion on for god-ray structure.
      ac.volumetricFog.enableScatteringOcclusion = mode !== "parity";

      // The feature under test.
      ac.volumetricFog.multiScatter = mode === "on";
      ac.volumetricFog.msOctaves = mode === "on" ? 3 : 1;

      // Warm up + load tiles. LONG fixed frame count (no early break) so tile
      // streaming + the froxel volume are fully settled and the render is
      // deterministic across runs for the byte-parity gate.
      for (let i = 0; i < 360; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      for (let i = 0; i < 200; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      return {
        mode,
        multiScatter: ac.volumetricFog.multiScatter,
        msOctaves: ac.volumetricFog.msOctaves,
        fogEnabled: ac.volumetricFog.enabled,
        density: ac.volumetricFog.density,
        quality: ac.volumetricFog.quality,
      };
    },
    { mode },
  );

  async function shoot(label) {
    const out = path.join(OUT_DIR, `fog-ms-${label}-webgpu.png`);
    await page.screenshot({ path: out, fullPage: false });
    outputs.push(out);
    return out;
  }

  // Capture the WebGPU CANVAS pixels (no UI chrome) for the parity gate. The
  // WebGPU swapchain canvas can't be read back via drawImage/getImageData (it
  // comes back black), so we take a Playwright ELEMENT screenshot of the canvas
  // DOM node (real composited pixels, no clock/timeline chrome) and decode it
  // back to raw RGBA in-page via createImageBitmap (the capture-and-diff.mjs
  // pattern). Returns a 32-bit FNV-1a hash of the RGBA bytes + mean luminance so
  // the coordinator can confirm exact-pixel parity across builds.
  async function canvasHash(label) {
    const canvasEl = await page.$(
      "canvas.cesium-widget-scene-canvas, .cesium-widget canvas, canvas",
    );
    const pngBuf = await canvasEl.screenshot();
    // Save the canvas-element PNG (UI-chrome-free) so a separate diff can do an
    // exact pixel comparison across builds.
    const canvasPng = path.join(OUT_DIR, `fog-ms-${label}-canvas.png`);
    fs.writeFileSync(canvasPng, pngBuf);
    outputs.push(canvasPng);
    const b64 = pngBuf.toString("base64");
    const res = await page.evaluate(async (b64in) => {
      const bin = atob(b64in);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/png" });
      const bitmap = await createImageBitmap(blob);
      const c = document.createElement("canvas");
      c.width = bitmap.width;
      c.height = bitmap.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let hash = 0x811c9dc5;
      for (let i = 0; i < data.length; i++) {
        hash ^= data[i];
        hash = (hash * 0x01000193) >>> 0;
      }
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += data[i] + data[i + 1] + data[i + 2];
      }
      const mean = sum / (data.length / 4) / 3;
      return { w: c.width, h: c.height, hash: hash >>> 0, mean };
    }, b64);
    console.log(
      `[probe-fog-ms] CANVAS-HASH ${label}: ${res.w}x${res.h} hash=${res.hash} mean=${res.mean.toFixed(3)}`,
    );
    return res;
  }

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

  let lab = mode;
  if (mode === "parity" && suffix) lab = `parity-${suffix}`;
  await shoot(lab);
  // Emit a deterministic canvas-pixel hash for the parity gate (UI-chrome-free).
  await canvasHash(lab);

  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  console.log(`[probe-fog-ms] mode=${mode} echo=${JSON.stringify(echo)}`);
  outputs.forEach((o) => console.log(`  wrote: ${o}`));
  console.log(`  errors: ${errs.length}`);
  errs.slice(0, 8).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  await run();
})();
