#!/usr/bin/env node
// Q13-PLAIN-HDR-GAMMA-CORE acceptance probe.
// @purpose Acceptance: plain highDynamicRange=true brightness parity WebGL vs WebGPU (sRGB decodes, no double tonemap), with SDR control legs
// @status ACTIVE
//
// Under PLAIN `scene.highDynamicRange = true` (SDR canvas — NOT the
// rgba16float HDR-canvas-output path), WebGL pushes the single `HDR` define
// which (a) sRGB-decodes globe imagery via czm_gammaCorrect, (b) sRGB-decodes
// billboard/point colors via czm_gammaCorrect, (c) SKIPS the model inline
// tonemap+gamma — leaving the final tonemap+gamma to the post-process chain.
//
// Pre-fix WebGPU gated the globe imagery decode on the HDR *canvas* only
// (never raised under plain HDR), never decoded billboard/point colors, and
// double-tonemapped models — so the globe went double-bright vs WebGL.
//
// This probe captures WebGL vs WebGPU for the same scene, once with
// highDynamicRange ON and once OFF (off = the byte-identical control).
// PASS: HDR cross-backend brightness ratio close to the SDR ratio (the fix
// makes HDR converge like SDR already does). READ THE PNGs.
//
// Usage: node Tools/visual-regression/probe-plain-hdr-gamma.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(rendererArg, hdr) {
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

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  // Configure scene: HDR flag + a fixed camera + a billboard + a point so
  // all three fixed paths (globe / billboard / point) are on screen.
  await page.evaluate(async (useHdr) => {
    const v = window.viewer;
    // window.Cesium isn't exposed on this page — reach classes via the
    // constructors of live objects.
    const Cartesian3 = v.camera.positionWC.constructor;
    const Color = v.scene.backgroundColor.constructor;
    v.scene.highDynamicRange = useHdr;
    // Fixed view over a bright imagery region (converges LOD across backends).
    v.camera.setView({
      destination: Cartesian3.fromDegrees(-95.0, 35.0, 6000000.0),
    });
    // Bright-colored billboard (uses a generated canvas so no network dep).
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 32;
    const g = c.getContext("2d");
    g.fillStyle = "rgb(220,120,40)";
    g.fillRect(0, 0, 32, 32);
    v.entities.add({
      position: Cartesian3.fromDegrees(-95.0, 35.0, 100.0),
      billboard: { image: c.toDataURL(), scale: 2.0 },
    });
    v.entities.add({
      position: Cartesian3.fromDegrees(-90.0, 35.0, 100.0),
      point: { pixelSize: 40, color: Color.fromBytes(220, 120, 40, 255) },
    });
  }, hdr);

  await page.evaluate(async () => {
    const v = window.viewer;
    for (let i = 0; i < 180; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(1500);

  const label = hdr ? "hdr" : "sdr";
  const out = path.join(
    OUT_DIR,
    `probe-plain-hdr-gamma-${label}-${rendererArg}.png`,
  );
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) {
    console.log(`  ${rendererArg}/${label}: ${errs.length} console errors`);
    errs.slice(0, 4).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  }
  return out;
}

async function diffPngs(a, b) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const result = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: img.naturalWidth,
          h: img.naturalHeight,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const a = await decode(ba);
      const b = await decode(bb);
      if (a.w !== b.w || a.h !== b.h) return { error: "size mismatch" };
      const total = a.w * a.h;
      let mismatch = 0,
        sum = 0,
        nonBg = 0,
        sumRatio = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const ra = a.data[i],
          ga = a.data[i + 1],
          ba2 = a.data[i + 2];
        const rb = b.data[i],
          gb = b.data[i + 1],
          bb2 = b.data[i + 2];
        const d = Math.abs(ra - rb) + Math.abs(ga - gb) + Math.abs(ba2 - bb2);
        sum += d;
        if (d > 30) mismatch++;
        const lumA = 0.2126 * ra + 0.7152 * ga + 0.0722 * ba2;
        const lumB = 0.2126 * rb + 0.7152 * gb + 0.0722 * bb2;
        if (lumA > 5 || lumB > 5) {
          nonBg++;
          sumRatio += (lumB + 1) / (lumA + 1); // WebGL / WebGPU
        }
      }
      return {
        mismatchPct: ((100 * mismatch) / total).toFixed(2),
        meanDelta: (sum / total).toFixed(2),
        // >1 => WebGL brighter (WebGPU darker); <1 => WebGPU brighter
        meanBrightnessRatio_WebGL_over_WebGPU: (
          sumRatio / Math.max(1, nonBg)
        ).toFixed(3),
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const hdr of [false, true]) {
    const label = hdr ? "HDR (scene.highDynamicRange=true)" : "SDR control";
    console.log(`\n[probe-plain-hdr-gamma] ${label}`);
    const gpu = await capture("webgpu", hdr);
    const gl = await capture("webgl", hdr);
    console.log(`  webgpu: ${gpu}`);
    console.log(`  webgl:  ${gl}`);
    const diff = await diffPngs(gpu, gl);
    console.log(`  diff:`, JSON.stringify(diff));
  }
  console.log("\n[probe-plain-hdr-gamma] done");
})();
