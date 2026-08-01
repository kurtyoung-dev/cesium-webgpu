#!/usr/bin/env node
/**
 * Earth pixel probe — loads CesiumViewer twice (once per renderer) at the
 * SAME camera position and reads RGB values at the same screen positions
 * to quantify any color shift between WebGL and WebGPU.
 *
 * Reports the per-channel delta at sample points (Earth center, ocean,
 * continent, sky) so we can identify whether the residual difference is
 * (a) a per-fragment shader divergence,
 * (b) a final-blit conversion,
 * (c) a scene-FB format mismatch,
 * (d) just a camera position difference.
 *
 * Usage:  node Tools/visual-regression/earth-pixel-probe.mjs
 */
import { chromium } from "playwright";

const BASE = "http://localhost:8080";
const CAMERA_LON = -75.5;
const CAMERA_LAT = 40.0;
const CAMERA_ALT = 12_000_000;

async function captureFromRenderer(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  page.on("pageerror", (e) =>
    console.error(`[${renderer}] pageerror:`, e.message),
  );
  page.on("console", (m) => {
    if (m.type() === "error")
      console.error(`[${renderer}] console.error:`, m.text());
  });

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForFunction(() => !!window.viewer, { timeout: 60_000 });

  const samples = await page.evaluate(
    async ({ lon, lat, alt }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      v.scene.globe.enableLighting = false;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, alt),
      });
      // Wait for tiles
      for (let i = 0; i < 120; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      // Sample
      const canvas = v.scene.canvas;
      const off = document.createElement("canvas");
      off.width = canvas.width;
      off.height = canvas.height;
      const ctx = off.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const points = [
        { name: "center", x: cx, y: cy },
        { name: "ocean-NE", x: cx + 80, y: cy - 60 },
        { name: "ocean-SW", x: cx - 80, y: cy + 80 },
        { name: "edge-N", x: cx, y: cy - 200 },
        { name: "edge-S", x: cx, y: cy + 200 },
        { name: "limb-E", x: cx + 250, y: cy },
        { name: "corner-NW", x: 30, y: 30 },
        { name: "corner-SE", x: canvas.width - 30, y: canvas.height - 30 },
      ];
      const out = { width: canvas.width, height: canvas.height, samples: [] };
      for (const p of points) {
        const data = ctx.getImageData(p.x, p.y, 1, 1).data;
        out.samples.push({
          name: p.name,
          x: p.x,
          y: p.y,
          r: data[0],
          g: data[1],
          b: data[2],
          a: data[3],
        });
      }
      return out;
    },
    { lon: CAMERA_LON, lat: CAMERA_LAT, alt: CAMERA_ALT },
  );

  // Also save the canvas as PNG for visual verification
  const dataUrl = await page.evaluate(() => {
    return window.viewer.scene.canvas.toDataURL("image/png");
  });
  const fs = await import("node:fs/promises");
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  await fs.writeFile(
    `Tools/visual-regression/output/probe-${renderer}.png`,
    Buffer.from(base64, "base64"),
  );

  await browser.close();
  return samples;
}

const wg = await captureFromRenderer("webgl");
const wp = await captureFromRenderer("webgpu");

console.log(
  `\n=== Earth pixel probe (camera: lon ${CAMERA_LON}, lat ${CAMERA_LAT}, alt ${CAMERA_ALT}) ===`,
);
console.log(`Canvas WebGL : ${wg.width}x${wg.height}`);
console.log(`Canvas WebGPU: ${wp.width}x${wp.height}\n`);

console.log(
  "Sample point         |  WebGL R G B    |  WebGPU R G B   |   ΔR    ΔG    ΔB",
);
console.log(
  "---------------------|-----------------|-----------------|------------------",
);
for (let i = 0; i < wg.samples.length; i++) {
  const a = wg.samples[i];
  const b = wp.samples[i];
  const dR = b.r - a.r;
  const dG = b.g - a.g;
  const dB = b.b - a.b;
  const fmt = (n) => String(n).padStart(3, " ");
  const sign = (n) => (n > 0 ? "+" : n < 0 ? "" : " ") + String(n);
  console.log(
    `${a.name.padEnd(20)} | ${fmt(a.r)} ${fmt(a.g)} ${fmt(a.b)}     | ${fmt(b.r)} ${fmt(b.g)} ${fmt(b.b)}     | ${sign(dR).padStart(5)} ${sign(dG).padStart(5)} ${sign(dB).padStart(5)}`,
  );
}
