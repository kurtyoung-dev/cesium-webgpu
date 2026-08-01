#!/usr/bin/env node
// C6-TPDF-DITHER-FINAL acceptance probe.
//
// Verifies the opt-in triangular-PDF dither added to the WebGPU tonemap
// stage (Tonemapping.wgsl / Tonemapping_f16.wgsl) reduces visible banding
// across a large smooth sky/atmosphere gradient, and is byte-identical off.
//
// Setup: WebGPU viewer, scene.highDynamicRange = true (so the tonemap stage
// is enabled and its rgba16float intermediates preserve the sub-LSB dither
// until the final 8-bit downcast). Camera sits low looking just above the
// horizon so the upper frame is a smooth atmosphere gradient.
//
// Readback: WebGPU canvas contents don't survive a live `drawImage` into a
// 2d canvas (the swapchain front-buffer isn't drawImage-able here), so we
// grab pixels the reliable way — `page.screenshot({clip})` of the sky region
// as a PNG buffer, then decode that PNG back through an <img>/2d-canvas
// (decoding a PNG works, unlike sampling the WebGPU canvas directly).
//
// Metric on a vertical strip of the decoded sky:
//   - distinctColors: unique packed-RGB values down the strip. Dither should
//     INCREASE it (flat bands become stippled).
//   - maxRun: longest run of pixel-identical rows. Dither should DECREASE it.
//
// Off-gate: OFF frame hash == OFF-after-toggle frame hash (toggling the flag
// on then off leaves no residue; strength 0 adds exactly 0).
//
// Outputs: tpdf-dither-off.png, tpdf-dither-on.png (full frame, READ THEM).

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Sky strip clip (avoids the right-hand help overlay). Pure smooth gradient.
const CLIP = { x: 150, y: 40, width: 500, height: 330 };

// Decode a base64 PNG in the page and compute the banding fingerprint over
// the center column. Returns { total, distinct, maxRun, hash }. Passed as a
// REAL function (not a string) so Playwright forwards the base64 argument.
const DECODE_FN = async (b64) => {
  // Decode via createImageBitmap(Blob) — the proven readback path from
  // capture-and-diff.mjs (Image().decode() can stall in this headless CSP).
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bitmap.width;
  c.height = bitmap.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const w = c.width;
  const h = c.height;
  const xc = w >> 1;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const d = ctx.getImageData(xc, y, 1, 1).data;
    rows.push((d[0] << 16) | (d[1] << 8) | d[2]);
  }
  const distinct = new Set(rows).size;
  let maxRun = 1;
  let run = 1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] === rows[i - 1]) {
      run++;
      if (run > maxRun) maxRun = run;
    } else run = 1;
  }
  const full = ctx.getImageData(0, 0, w, h).data;
  let hgt = 2166136261 >>> 0;
  for (let i = 0; i < full.length; i += 17) {
    hgt ^= full[i];
    hgt = Math.imul(hgt, 16777619) >>> 0;
  }
  return { total: rows.length, distinct, maxRun, hash: hgt };
};

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

  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
    {
      waitUntil: "networkidle",
    },
  );
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.scene.highDynamicRange = true; // enables the tonemap stage
    v.scene.skyAtmosphere.show = true;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-95.0, 25.0, 250.0),
      orientation: {
        heading: C.Math.toRadians(0.0),
        pitch: C.Math.toRadians(2.0),
        roll: 0.0,
      },
    });
  });

  async function settle(frames = 90) {
    await page.evaluate(async (n) => {
      const v = window.viewer;
      for (let i = 0; i < n; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    }, frames);
    await page.waitForTimeout(500);
  }

  async function setDither(on) {
    await page.evaluate((flag) => {
      window.viewer.scene.ditherEnabled = flag;
      window.viewer.scene.ditherStrength = flag ? 2.0 : undefined;
    }, on);
  }

  async function metric() {
    const buf = await page.screenshot({ clip: CLIP });
    return page.evaluate(DECODE_FN, buf.toString("base64"));
  }

  // OFF baseline
  await setDither(false);
  await settle();
  const off1 = await metric();
  await page.screenshot({ path: path.join(OUT_DIR, "tpdf-dither-off.png") });

  // ON
  await setDither(true);
  await settle();
  const on1 = await metric();
  await page.screenshot({ path: path.join(OUT_DIR, "tpdf-dither-on.png") });

  // OFF again (residue check)
  await setDither(false);
  await settle();
  const off2 = await metric();

  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  console.log("[probe-tpdf-dither] results (sky strip, HDR tonemap path)");
  console.log("  strip rows:", off1.total);
  console.log(
    "  OFF : distinctColors =",
    off1.distinct,
    " maxRun =",
    off1.maxRun,
  );
  console.log(
    "  ON  : distinctColors =",
    on1.distinct,
    " maxRun =",
    on1.maxRun,
  );
  console.log(
    "  off-gate residue: offHash =",
    off1.hash,
    " off-after-toggle =",
    off2.hash,
    off1.hash === off2.hash ? "IDENTICAL ✓" : "DIFFER ✗",
  );
  console.log("  console errors:", errs.length);
  if (errs.length)
    errs.slice(0, 8).forEach((e) => console.log("   ", e.t, e.text));

  const bandingReduced =
    on1.distinct > off1.distinct && on1.maxRun <= off1.maxRun;
  const offByteIdentical = off1.hash === off2.hash;
  console.log(
    "\n  VERDICT:",
    bandingReduced && offByteIdentical
      ? "banding REDUCED with dither AND off byte-identical ✓"
      : bandingReduced
        ? "banding reduced but off-gate residue — inspect"
        : "no clear banding reduction — inspect PNGs",
  );
  console.log("  PNGs: output/tpdf-dither-off.png , output/tpdf-dither-on.png");
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  await run();
})();
