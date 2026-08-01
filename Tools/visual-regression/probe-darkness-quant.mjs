#!/usr/bin/env node
// Quantitative darkness probe — samples a 32x32 grid of pixel RGB values
// from the canvas on both backends at the same camera + viewport, then
// reports per-channel mean + max + per-pixel ratio. Identifies whether
// the darkening is uniform (a constant multiplier or wrong gamma) or
// non-linear (a tonemap / opacity issue).

import { chromium } from "playwright";

const BASE = "http://localhost:8080";

const CAM =
  process.env.PROBE_VIEW === "tile-edge"
    ? { lon: -122.4, lat: 37.7, height: 500_000 }
    : { lon: 10, lat: 50, height: 4_000_000 };

async function capture(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const samples = await page.evaluate(async (cam) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(cam.lon, cam.lat, cam.height),
    });
    for (let i = 0; i < 360; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    // Wait a moment for everything to settle
    await new Promise((r) => setTimeout(r, 2000));

    // Render one final frame then read back canvas pixels via 2D context
    v.scene.render();
    const canvas = v.canvas;
    const ctx2d = document.createElement("canvas").getContext("2d");
    ctx2d.canvas.width = canvas.width;
    ctx2d.canvas.height = canvas.height;
    ctx2d.drawImage(canvas, 0, 0);
    const w = canvas.width;
    const h = canvas.height;
    const data = ctx2d.getImageData(0, 0, w, h).data;
    const samples = [];
    // 32x32 grid, central 60% to avoid UI overlay
    const N = 32;
    const x0 = Math.floor(w * 0.2);
    const y0 = Math.floor(h * 0.2);
    const dx = Math.floor((w * 0.6) / (N - 1));
    const dy = Math.floor((h * 0.6) / (N - 1));
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = x0 + i * dx;
        const y = y0 + j * dy;
        const idx = (y * w + x) * 4;
        samples.push([data[idx], data[idx + 1], data[idx + 2]]);
      }
    }
    return samples;
  }, CAM);

  await browser.close();
  return samples;
}

function meanMax(samples) {
  let mr = 0,
    mg = 0,
    mb = 0,
    xr = 0,
    xg = 0,
    xb = 0;
  for (const [r, g, b] of samples) {
    mr += r;
    mg += g;
    mb += b;
    if (r > xr) xr = r;
    if (g > xg) xg = g;
    if (b > xb) xb = b;
  }
  const n = samples.length;
  return {
    meanR: mr / n,
    meanG: mg / n,
    meanB: mb / n,
    maxR: xr,
    maxG: xg,
    maxB: xb,
  };
}

(async () => {
  console.log("[darkness-quant] capturing WebGL…");
  const webglSamples = await capture("webgl");
  console.log("[darkness-quant] capturing WebGPU…");
  const webgpuSamples = await capture("webgpu");

  const wgl = meanMax(webglSamples);
  const wgp = meanMax(webgpuSamples);
  console.log(
    "\nWebGL  mean RGB:",
    wgl.meanR.toFixed(1),
    wgl.meanG.toFixed(1),
    wgl.meanB.toFixed(1),
    " max:",
    wgl.maxR,
    wgl.maxG,
    wgl.maxB,
  );
  console.log(
    "WebGPU mean RGB:",
    wgp.meanR.toFixed(1),
    wgp.meanG.toFixed(1),
    wgp.meanB.toFixed(1),
    " max:",
    wgp.maxR,
    wgp.maxG,
    wgp.maxB,
  );
  console.log("\nRatios webgpu/webgl:");
  console.log("  meanR:", (wgp.meanR / wgl.meanR).toFixed(3));
  console.log("  meanG:", (wgp.meanG / wgl.meanG).toFixed(3));
  console.log("  meanB:", (wgp.meanB / wgl.meanB).toFixed(3));

  // Test gamma hypothesis: if ratio matches pow(x/255, gamma)/(x/255)
  // for some gamma, the darkness is a gamma-curve issue.
  let bestG = 1;
  let bestErr = Infinity;
  for (let g = 0.4; g <= 3.0; g += 0.01) {
    let err = 0;
    let count = 0;
    for (let i = 0; i < webglSamples.length; i++) {
      for (let c = 0; c < 3; c++) {
        const w = webglSamples[i][c] / 255;
        const u = webgpuSamples[i][c] / 255;
        if (w > 0.05 && w < 0.95) {
          const predicted = Math.pow(w, g);
          err += (predicted - u) * (predicted - u);
          count++;
        }
      }
    }
    err /= count;
    if (err < bestErr) {
      bestErr = err;
      bestG = g;
    }
  }
  console.log(
    `\nBest-fit single gamma exponent: ${bestG.toFixed(2)} (rmse=${Math.sqrt(bestErr).toFixed(3)})`,
  );
  console.log("  gamma ≈ 2.2 → WebGPU outputs linear values displayed as sRGB");
  console.log(
    "  gamma ≈ 1/2.2 = 0.45 → WebGPU outputs over-encoded sRGB values",
  );
  console.log(
    "  gamma ≈ 1.0 → not a gamma issue (uniform multiplier or other)",
  );
})();
