#!/usr/bin/env node
// C4-PLAIN-HDR-GAMMA-TAILS acceptance probe (Q7).
//
// Three residual tails after B511/B544 plain-HDR gamma work:
//  (a) exposure -> WGSL tonemap uniform sync: scene.postProcessStages.exposure
//      drives WebGL's tonemap `exposure` uniform but was never synced to the
//      WebGPU tonemap stage (stuck at 1.0).
//  (b) non-default tonemap operators (Reinhard / ACES / Filmic /
//      ModifiedReinhard) diverge from the czm_* GLSL references; only
//      PBR-Neutral is exact.
//  (c) per-instance entity color divergence: an orange box entity renders a
//      different color on WebGPU vs WebGL (SDR + HDR).
//
// For each case we capture WebGL vs WebGPU and compare. READ THE PNGs.
// Usage: node Tools/visual-regression/probe-plain-hdr-tonemap.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Sample a small box of pixels centred at (cx,cy), return mean rgb.
function meanRegion(data, w, cx, cy, r) {
  let R = 0,
    G = 0,
    B = 0,
    n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const i = (y * w + x) * 4;
      R += data[i];
      G += data[i + 1];
      B += data[i + 2];
      n++;
    }
  }
  return [R / n, G / n, B / n];
}

async function capture(rendererArg, cfg) {
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
    viewport: { width: 1024, height: 768 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) => messages.push({ t: "pageerror", text: e.message }));

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  const sample = await page.evaluate(async (cfg) => {
    const v = window.viewer;
    const Cartesian3 = v.camera.positionWC.constructor;
    // Reach Color via a live object's constructor.
    const Color = v.scene.backgroundColor.constructor;

    v.scene.highDynamicRange = cfg.hdr;
    if (cfg.tonemapper) {
      // Tonemapper enum values are strings; PostProcessStageCollection has
      // a `tonemapper` setter that accepts the Tonemapper enum. Values equal
      // the enum names, so pass the string directly.
      v.scene.postProcessStages.tonemapper = cfg.tonemapper;
    }
    if (typeof cfg.exposure === "number") {
      v.scene.postProcessStages.exposure = cfg.exposure;
    }

    v.scene.globe.show = false;
    v.scene.skyBox.show = false;
    v.scene.skyAtmosphere.show = false;
    v.scene.backgroundColor = Color.BLACK;

    // Orange box entity — per-instance color path (PerInstanceColorAppearance).
    v.entities.add({
      position: Cartesian3.fromDegrees(0.0, 0.0, 0.0),
      box: {
        dimensions: new Cartesian3(1.5e6, 1.5e6, 1.5e6),
        material: Color.ORANGE, // rgb(255,165,0)
      },
    });
    // (c) premise test — a SECOND box with a distinct color. If the WebGPU
    // per-instance path collapses a multi-entity batch to one color, the
    // orange box would render with the blue box's color (or vice-versa).
    v.entities.add({
      position: Cartesian3.fromDegrees(60.0, 0.0, 0.0),
      box: {
        dimensions: new Cartesian3(1.5e6, 1.5e6, 1.5e6),
        material: Color.CORNFLOWERBLUE, // rgb(100,149,237)
      },
    });
    v.camera.setView({
      destination: Cartesian3.fromDegrees(30.0, 0.0, 2.4e7),
    });

    // Render a stable number of frames.
    for (let i = 0; i < 120; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Read pixels at each box center. The camera is centred at lon 30 with
    // the orange box on the left (lon 0) and blue box on the right (lon 60).
    const canvas = v.scene.canvas;
    v.scene.render();
    const rc = document.createElement("canvas");
    rc.width = canvas.width;
    rc.height = canvas.height;
    const ctx = rc.getContext("2d");
    ctx.drawImage(canvas, 0, 0);
    const cy = Math.floor(canvas.height / 2);
    const cx = Math.floor(canvas.width / 2);
    // Sample the two box centers (orange ≈0.388w, blue ≈0.610w at this view).
    const orangePx = ctx.getImageData(
      Math.floor(canvas.width * 0.388),
      cy,
      1,
      1,
    ).data;
    const bluePx = ctx.getImageData(
      Math.floor(canvas.width * 0.61),
      cy,
      1,
      1,
    ).data;
    const px = ctx.getImageData(cx, cy, 1, 1).data;
    const centerPixel = [px[0], px[1], px[2], px[3]];
    return {
      centerPixel,
      orangeBox: [orangePx[0], orangePx[1], orangePx[2], orangePx[3]],
      blueBox: [bluePx[0], bluePx[1], bluePx[2], bluePx[3]],
      w: canvas.width,
      h: canvas.height,
    };
  }, cfg);

  const out = path.join(
    OUT_DIR,
    `probe-plain-hdr-tonemap-${cfg.tag}-${rendererArg}.png`,
  );
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) {
    console.log(`  ${rendererArg}/${cfg.tag}: ${errs.length} console errors`);
    errs.slice(0, 3).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  }
  return { out, sample };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const cases = [
    // (c) per-instance color — SDR + HDR
    { tag: "box-sdr", hdr: false },
    { tag: "box-hdr", hdr: true },
    // (b) per-operator, HDR on
    { tag: "op-reinhard", hdr: true, tonemapper: "REINHARD" },
    { tag: "op-aces", hdr: true, tonemapper: "ACES" },
    { tag: "op-filmic", hdr: true, tonemapper: "FILMIC" },
    { tag: "op-modreinhard", hdr: true, tonemapper: "MODIFIED_REINHARD" },
    { tag: "op-pbrneutral", hdr: true, tonemapper: "PBR_NEUTRAL" },
    // (a) exposure sync — HDR on, PBR neutral, exposure bumped
    { tag: "exposure-2x", hdr: true, tonemapper: "PBR_NEUTRAL", exposure: 2.0 },
    { tag: "exposure-half", hdr: true, tonemapper: "PBR_NEUTRAL", exposure: 0.5 },
  ];

  for (const cfg of cases) {
    const gpu = await capture("webgpu", cfg);
    const gl = await capture("webgl", cfg);
    // The orange box is the per-instance primitive that flows through the
    // (HDR) tonemapper, so its cross-backend delta is the operator/exposure
    // parity metric. The blue box additionally proves per-instance color (c).
    const ob = (s) => (s.sample?.orangeBox || []).slice(0, 3).map(Math.round);
    const bb = (s) => (s.sample?.blueBox || []).slice(0, 3).map(Math.round);
    const gpo = ob(gpu),
      glo = ob(gl);
    const d =
      Math.abs((gpo[0] || 0) - (glo[0] || 0)) +
      Math.abs((gpo[1] || 0) - (glo[1] || 0)) +
      Math.abs((gpo[2] || 0) - (glo[2] || 0));
    console.log(
      `[${cfg.tag}] orangeBox webgpu=${JSON.stringify(gpo)} webgl=${JSON.stringify(glo)}  |rgbΔ|=${d}`,
    );
    if (cfg.tag === "box-sdr" || cfg.tag === "box-hdr") {
      console.log(
        `           blueBox   webgpu=${JSON.stringify(bb(gpu))} webgl=${JSON.stringify(bb(gl))} (per-instance color c)`,
      );
    }
  }
  console.log("\n[probe-plain-hdr-tonemap] done. PNGs in", OUT_DIR);
})();
